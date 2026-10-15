import { createHash } from "node:crypto";
import type {
	CredentialForExecution,
	ProviderCredentialConnector,
	ProviderExecutor,
} from "@agent-infra/connection-core";
import { SaxesParser } from "saxes";
import {
	type JenkinsDeploymentProfile,
	type JenkinsGatewayTokenProvider,
	jenkinsCiProfile,
	jenkinsReleaseProfile,
	JenkinsAdapter as LegacyAdapter,
	createJenkinsConnectionCatalog as legacyCatalog,
} from "./jenkins.ts";
import { jenkinsV9ExecutorDigest } from "./jenkins-v9-integrity.ts";

export type {
	JenkinsDeploymentProfile,
	JenkinsGatewayTokenProvider,
} from "./jenkins.ts";
export { jenkinsCiProfile, jenkinsReleaseProfile };

type ObjectInput = Record<string, unknown>;
const maxBytes = 256 * 1024;
const job = { type: "string", minLength: 1, maxLength: 512 };
const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
const definition = {
	oneOf: [
		{
			type: "object",
			additionalProperties: false,
			required: ["kind", "script"],
			properties: {
				kind: { const: "inline" },
				script: { type: "string", minLength: 1, maxLength: 131072 },
				sandbox: { const: true },
			},
		},
		{
			type: "object",
			additionalProperties: false,
			required: ["kind", "url", "branch", "scriptPath"],
			properties: {
				kind: { const: "git" },
				url: { type: "string", minLength: 1, maxLength: 2048 },
				branch: { type: "string", minLength: 1, maxLength: 256 },
				scriptPath: { type: "string", minLength: 1, maxLength: 512 },
				credentialsId: { type: "string", maxLength: 256 },
				lightweight: { type: "boolean" },
			},
		},
	],
};
const specs = [
	{
		name: "list_folder_jobs",
		effect: "READ",
		description:
			"列出根目录或已有 Folder 内的 Jobs 与类型，最多 100 项；offset 从 0 开始。",
		properties: {
			folderFullName: job,
			offset: { type: "integer", minimum: 0, maximum: 1000000 },
		},
		required: [],
	},
	{
		name: "get_pipeline_config",
		effect: "READ",
		description:
			"读取普通 Pipeline 的有界结构化配置和 SHA-256；脚本可能包含敏感业务内容，不返回原始 XML。",
		properties: { jobFullName: job },
		required: ["jobFullName"],
	},
	{
		name: "get_build_parameters",
		effect: "READ",
		description:
			"发现 Job 构建参数类型及安全默认值，不返回密码/未知类型默认值。",
		properties: { jobFullName: job },
		required: ["jobFullName"],
	},
	{
		name: "create_pipeline",
		effect: "WRITE",
		description:
			"在根目录或已有 Folder 创建 sandbox inline/Git Pipeline，不覆盖同名 Job、不自动构建；响应未知时先核验，禁止盲重试。",
		properties: {
			jobFullName: job,
			definition,
			description: { type: "string", maxLength: 4096 },
		},
		required: ["jobFullName", "definition"],
	},
	{
		name: "update_pipeline",
		effect: "WRITE",
		description:
			"按配置 SHA-256 预检更新 Pipeline 定义，保留其他配置；Jenkins 无原子 CAS，请避免并发编辑；不自动构建。",
		properties: {
			jobFullName: job,
			expectedConfigSha256: hash,
			definition,
			description: { type: "string", maxLength: 4096 },
		},
		required: ["jobFullName", "expectedConfigSha256", "definition"],
	},
	...["enable_pipeline", "disable_pipeline"].map((name) => ({
		name,
		effect: "WRITE",
		description: `${name === "enable_pipeline" ? "启用" : "禁用"}普通 Pipeline，要求配置摘要预检；不停止已有 Build、不自动构建。`,
		properties: { jobFullName: job, expectedConfigSha256: hash },
		required: ["jobFullName", "expectedConfigSha256"],
	})),
	{
		name: "cancel_queue_item",
		effect: "WRITE",
		description:
			"核对 Queue item 所属 Job 后取消排队；已开始运行须查询 Build，不能视为已停止。",
		properties: {
			jobFullName: job,
			queueItemId: { type: "integer", minimum: 1 },
		},
		required: ["jobFullName", "queueItemId"],
	},
] as const;

export function createJenkinsConnectionCatalog(
	profile: JenkinsDeploymentProfile,
) {
	const old = legacyCatalog(profile);
	return {
		...old,
		providerReleaseId: `${profile.providerId}-connection-v9`,
		executorDigest: jenkinsV9ExecutorDigest,
		actions: [
			...old.actions.map((action) => ({
				...action,
				id: action.id.replace(/@v8$/, "@v9"),
			})),
			...specs.map((action) => ({
				name: `${profile.providerId}.${action.name}`,
				id: `${profile.providerId}.${action.name}@v9`,
				effect: action.effect as "READ" | "WRITE",
				description: action.description,
				requiredScopes: ["jenkins.read"],
				inputSchema: {
					type: "object",
					additionalProperties: false,
					properties: action.properties,
					required: [...action.required],
				},
			})),
		],
	};
}

export class JenkinsAdapter
	implements ProviderCredentialConnector, ProviderExecutor
{
	readonly providerId: string;
	readonly providerReleaseId: string;
	private readonly legacy: LegacyAdapter;
	private readonly profile: JenkinsDeploymentProfile;
	private readonly fetcher: typeof fetch;
	private readonly gateway?: JenkinsGatewayTokenProvider;
	constructor(
		profile: JenkinsDeploymentProfile,
		fetcher: typeof fetch,
		gateway?: JenkinsGatewayTokenProvider,
	) {
		this.profile = profile;
		this.fetcher = fetcher;
		this.gateway = gateway;
		this.providerId = profile.providerId;
		this.providerReleaseId = `${profile.providerId}-connection-v9`;
		this.legacy = new LegacyAdapter(profile, fetcher, gateway);
	}
	async validateCredential(encoded: string) {
		return {
			...(await this.legacy.validateCredential(encoded)),
			providerReleaseId: this.providerReleaseId,
		};
	}
	async execute(input: {
		action: string;
		credential: CredentialForExecution;
		input: ObjectInput;
	}): Promise<ObjectInput> {
		const action = input.action.replace(`${this.providerId}.`, "");
		const args = input.input;
		if (!specs.some((spec) => spec.name === action)) {
			if (action === "get_current_user") {
				const { accessToken: _, ...identity } = await this.validateCredential(
					input.credential.accessToken,
				);
				return identity;
			}
			return this.legacy.execute(input);
		}
		if (action === "list_folder_jobs") {
			const path =
				args.folderFullName === undefined
					? ""
					: jobPath(text(args.folderFullName, 512));
			const offset = args.offset ?? 0;
			if (
				!Number.isSafeInteger(offset) ||
				Number(offset) < 0 ||
				Number(offset) > 1000000
			)
				throw failure("offset is invalid");
			const value = await this.json(
				input.credential,
				`${path}/api/json?tree=_class,jobs[name,fullName,_class]{${offset},${Number(offset) + 101}}`,
			);
			if (path && value._class !== "com.cloudbees.hudson.plugins.folder.Folder")
				throw failure("Target is not an ordinary Folder");
			if (!Array.isArray(value.jobs)) throw failure("Job list is missing");
			const jobs = value.jobs;
			return {
				jobs: jobs.slice(0, 100),
				offset,
				nextOffset: Number(offset) + Math.min(jobs.length, 100),
				moreData: jobs.length > 100,
			};
		}
		const name = text(args.jobFullName, 512);
		const path = jobPath(name);
		if (action === "get_build_parameters") {
			const data = await this.json(
				input.credential,
				`${path}/api/json?tree=property[parameterDefinitions[name,type,description,choices,defaultParameterValue[value]]]`,
			);
			return { jobFullName: name, parameters: parameterProjection(data) };
		}
		if (action === "cancel_queue_item") {
			const id = args.queueItemId;
			if (!Number.isSafeInteger(id) || Number(id) < 1)
				throw failure("queueItemId is invalid");
			const item = await this.json(
				input.credential,
				`/queue/item/${id}/api/json`,
			);
			const task = item.task as ObjectInput | undefined;
			// Jenkins task.name is only the leaf name; verify its canonical URL as well.
			const expected = new URL(`${path}/`, this.profile.apiOrigin);
			const actual =
				typeof task?.url === "string"
					? new URL(task.url, this.profile.apiOrigin)
					: undefined;
			if (
				!actual ||
				!this.isDeploymentOrigin(actual.origin) ||
				actual.pathname !== expected.pathname ||
				actual.search ||
				actual.hash
			)
				throw failure("Queue item does not belong to the requested Job");
			if (item.executable || item.cancelled)
				throw failure("Queue item is no longer waiting");
			await this.request(
				input.credential,
				`/queue/cancelItem?id=${id}`,
				"POST",
			);
			return {
				accepted: true,
				jobFullName: name,
				queueItemId: id,
				verifyAction: `${this.providerId}.get_queue_item`,
			};
		}
		if (action === "create_pipeline") {
			const node = makeDefinition(args.definition);
			const parent = path.slice(0, path.lastIndexOf("/job/"));
			if (parent) {
				const folder = await this.json(
					input.credential,
					`${parent}/api/json?tree=_class`,
				);
				if (folder._class !== "com.cloudbees.hudson.plugins.folder.Folder")
					throw failure("Parent must be an existing Folder");
			}
			const root: XmlNode = {
				name: "flow-definition",
				attrs: { plugin: "workflow-job" },
				children: [
					element(
						"description",
						args.description === undefined
							? ""
							: text(args.description, 4096, true),
					),
					element("keepDependencies", "false"),
					element("properties"),
					node,
					element("triggers"),
					element("disabled", "false"),
				],
			};
			await this.request(
				input.credential,
				`${parent}/createItem?name=${encodeURIComponent(name.split("/").at(-1) ?? "")}`,
				"POST",
				xml(root),
			);
			return {
				accepted: true,
				jobFullName: name,
				verifyAction: `${this.providerId}.get_pipeline_config`,
			};
		}
		const raw = await this.request(input.credential, `${path}/config.xml`);
		const root = parseXml(raw);
		if (root.name !== "flow-definition")
			throw failure("Only ordinary Pipeline Jobs are supported");
		const currentDefinition = projectDefinition(root);
		const digest = createHash("sha256").update(raw).digest("hex");
		if (action === "get_pipeline_config")
			return {
				jobFullName: name,
				configSha256: digest,
				description: children(root, "description").length
					? content(child(root, "description"))
					: "",
				disabled: content(child(root, "disabled")) === "true",
				definition: currentDefinition,
			};
		if (
			typeof args.expectedConfigSha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(args.expectedConfigSha256) ||
			args.expectedConfigSha256 !== digest
		)
			throw failure("Pipeline configuration changed; read and preview again", {
				providerStatus: 409,
			});
		if (action === "update_pipeline") {
			replace(root, "definition", makeDefinition(args.definition));
			if (args.description !== undefined) {
				const description = element(
					"description",
					text(args.description, 4096, true),
				);
				if (children(root, "description").length)
					replace(root, "description", description);
				else root.children.unshift(description);
			}
			await this.request(
				input.credential,
				`${path}/config.xml`,
				"POST",
				xml(root),
			);
		} else {
			await this.request(
				input.credential,
				`${path}/${action === "enable_pipeline" ? "enable" : "disable"}`,
				"POST",
			);
		}
		return {
			accepted: true,
			jobFullName: name,
			previousConfigSha256: digest,
			atomicCompareAndSwap: false,
			verifyAction: `${this.providerId}.get_pipeline_config`,
		};
	}
	private isDeploymentOrigin(origin: string) {
		const aliases =
			this.profile.providerId === "jenkins-ci"
				? [this.profile.apiOrigin, "https://jenkins-ci.agoralab.co"]
				: [this.profile.apiOrigin, "http://10.80.1.129:8080"];
		return aliases.includes(origin);
	}
	private async json(
		credential: CredentialForExecution,
		path: string,
	): Promise<ObjectInput> {
		const raw = await this.request(credential, path);
		try {
			const result = JSON.parse(raw);
			if (!result || typeof result !== "object" || Array.isArray(result))
				throw new Error();
			return result;
		} catch {
			throw failure("Invalid JSON response");
		}
	}
	private async request(
		credential: CredentialForExecution,
		path: string,
		method = "GET",
		body?: string,
	): Promise<string> {
		let parsed: { username?: unknown; apiToken?: unknown };
		try {
			parsed = JSON.parse(credential.accessToken);
		} catch {
			throw failure("Invalid credential", { providerCredentialInvalid: true });
		}
		if (
			typeof parsed?.username !== "string" ||
			!parsed.username ||
			typeof parsed.apiToken !== "string" ||
			!parsed.apiToken
		)
			throw failure("Invalid credential", { providerCredentialInvalid: true });
		const accessToken = await this.gateway?.getAccessToken();
		if (body !== undefined && Buffer.byteLength(body) > maxBytes)
			throw failure("Configuration exceeds 256 KiB");
		for (let attempt = 0; ; attempt++) {
			let submitted = false;
			let receivedResponse = false;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 30000);
			try {
				submitted = true;
				const response = await this.fetcher(
					new URL(path, this.profile.apiOrigin),
					{
						method,
						body,
						redirect: "manual",
						signal: controller.signal,
						headers: {
							authorization: `Basic ${Buffer.from(`${parsed.username}:${parsed.apiToken}`).toString("base64")}`,
							...(accessToken ? { accessToken } : {}),
							...(body === undefined
								? {}
								: { "content-type": "application/xml; charset=utf-8" }),
						},
					},
				);
				receivedResponse = true;
				if (response.status === 401)
					throw failure("Credential was rejected", {
						providerCredentialInvalid: true,
					});
				if (method === "POST" && response.status >= 500)
					throw failure("Write result is unknown", {
						providerStatus: response.status,
						submissionUncertain: true,
					});
				// Only fixed same-origin redirect destinations are accepted as Jenkins write receipts; never follow.
				const location = response.headers.get("location");
				if (method === "POST" && response.status === 302 && location) {
					const source = new URL(path, this.profile.apiOrigin);
					const target = new URL(location, source);
					const expectedPath = source.pathname.endsWith("/createItem")
						? `${source.pathname.slice(0, -11)}/job/${encodeURIComponent(source.searchParams.get("name") ?? "")}/`
						: source.pathname === "/queue/cancelItem"
							? "/queue/"
							: `${source.pathname.slice(0, source.pathname.lastIndexOf("/") + 1)}`;
					if (
						this.isDeploymentOrigin(target.origin) &&
						!/login|securityRealm/i.test(target.pathname) &&
						(target.pathname === expectedPath ||
							(source.pathname === "/queue/cancelItem" &&
								target.pathname === "/")) &&
						!target.search &&
						!target.hash
					)
						return "";
				}
				if (!response.ok)
					throw failure("Request rejected", {
						providerStatus: response.status,
					});
				if (method === "POST") {
					await response.body?.cancel();
					return "";
				}
				if (Number(response.headers.get("content-length")) > maxBytes) {
					await response.body?.cancel();
					throw failure("Response exceeds 256 KiB");
				}
				const reader = response.body?.getReader();
				if (!reader) return "";
				const chunks: Uint8Array[] = [];
				let size = 0;
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.byteLength;
					if (size > maxBytes) {
						await reader.cancel();
						throw failure("Response exceeds 256 KiB");
					}
					chunks.push(value);
				}
				return new TextDecoder("utf-8", {
					fatal: true,
					ignoreBOM: true,
				}).decode(Buffer.concat(chunks));
			} catch (error) {
				if (error instanceof Error && error.message.startsWith("Jenkins v9:"))
					throw error;
				if (
					method === "GET" &&
					!receivedResponse &&
					attempt === 0 &&
					error instanceof Error &&
					(error.name === "AbortError" || error instanceof TypeError)
				)
					continue;
				throw failure(
					method === "POST"
						? "Write response was lost; verify before retry"
						: "Read transport failed",
					{
						...(method === "POST" && submitted
							? { submissionUncertain: true }
							: { providerUnavailable: true }),
					},
				);
			} finally {
				clearTimeout(timer);
			}
		}
	}
}

function failure(message: string, metadata: ObjectInput = {}) {
	return Object.assign(new Error(`Jenkins v9: ${message}`), metadata);
}
function validXmlText(value: string) {
	return [...value].every((char) => {
		const cp = char.codePointAt(0) ?? 0;
		return (
			cp === 9 ||
			cp === 10 ||
			cp === 13 ||
			(cp >= 32 && cp <= 0xd7ff) ||
			(cp >= 0xe000 && cp <= 0xfffd) ||
			cp >= 0x10000
		);
	});
}
function text(value: unknown, limit: number, empty = false): string {
	if (
		typeof value !== "string" ||
		(!empty && !value.trim()) ||
		value.length > limit ||
		!validXmlText(value)
	)
		throw failure("Invalid text input");
	return value;
}
function jobPath(name: string) {
	const parts = name.split("/");
	if (
		parts.some(
			(part) =>
				!part ||
				part.trim() !== part ||
				/[\\%?#]/.test(part) ||
				[...part].some((char) => char.charCodeAt(0) < 32) ||
				part === "." ||
				part === "..",
		)
	)
		throw failure("Invalid Job path");
	return parts.map((part) => `/job/${encodeURIComponent(part)}`).join("");
}

type XmlNode = {
	name: string;
	attrs: Record<string, string>;
	children: (XmlNode | string)[];
};
function element(name: string, value?: string): XmlNode {
	return { name, attrs: {}, children: value === undefined ? [] : [value] };
}
function children(node: XmlNode, name: string) {
	return node.children.filter(
		(item): item is XmlNode => typeof item !== "string" && item.name === name,
	);
}
function child(node: XmlNode, name: string): XmlNode {
	const found = children(node, name);
	if (found.length !== 1) throw failure(`Missing or ambiguous ${name}`);
	return found[0] as XmlNode;
}
function content(node: XmlNode): string {
	if (node.children.some((item) => typeof item !== "string"))
		throw failure("Unexpected nested value");
	return node.children.join("");
}
function replace(node: XmlNode, name: string, value: XmlNode) {
	const old = child(node, name);
	node.children[node.children.indexOf(old)] = value;
}
function escapeXml(value: string) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;")
		.replace(/\r/g, "&#13;");
}
function xml(node: XmlNode): string {
	return `<${node.name}${Object.entries(node.attrs)
		.map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
		.join(
			"",
		)}>${node.children.map((item) => (typeof item === "string" ? escapeXml(item) : xml(item))).join("")}</${node.name}>`;
}
function parseXml(raw: string): XmlNode {
	if (Buffer.byteLength(raw) > maxBytes)
		throw failure("Configuration exceeds 256 KiB");
	const parser = new SaxesParser({ xmlns: false });
	const stack: XmlNode[] = [];
	let root: XmlNode | undefined;
	let count = 0;
	parser.on("doctype", () => {
		throw failure("DTD is forbidden");
	});
	parser.on("processinginstruction", () => {
		throw failure("Processing instructions are forbidden");
	});
	parser.on("error", () => {
		throw failure("Invalid XML configuration");
	});
	parser.on("opentag", (tag) => {
		if (++count > 10000 || stack.length >= 64)
			throw failure("XML complexity limit exceeded");
		const node: XmlNode = {
			name: tag.name,
			attrs: tag.attributes,
			children: [],
		};
		if (stack.length) stack.at(-1)?.children.push(node);
		else root = node;
		stack.push(node);
	});
	const append = (value: string) => {
		stack.at(-1)?.children.push(value);
	};
	parser.on("text", append);
	parser.on("cdata", append);
	parser.on("closetag", () => {
		stack.pop();
	});
	parser.write(raw).close();
	if (!root) throw failure("Empty XML configuration");
	return root;
}
function makeDefinition(value: unknown): XmlNode {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw failure("Definition is required");
	const data = value as ObjectInput;
	const node = element("definition");
	const allowed =
		data.kind === "inline"
			? ["kind", "script", "sandbox"]
			: ["kind", "url", "branch", "scriptPath", "credentialsId", "lightweight"];
	if (Object.keys(data).some((key) => !allowed.includes(key)))
		throw failure("Unsupported definition field");
	if (data.kind === "inline") {
		if (data.sandbox !== undefined && data.sandbox !== true)
			throw failure("Sandbox must remain enabled");
		node.attrs = {
			class: "org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition",
			plugin: "workflow-cps",
		};
		node.children = [
			element("script", text(data.script, 131072)),
			element("sandbox", "true"),
		];
		return node;
	}
	if (data.kind !== "git") throw failure("Unsupported Pipeline definition");
	const url = text(data.url, 2048);
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw failure("Git URL must use HTTPS or SSH");
	}
	if (
		!["https:", "ssh:"].includes(parsed.protocol) ||
		parsed.password ||
		(parsed.protocol === "https:" && parsed.username) ||
		parsed.search ||
		parsed.hash ||
		!parsed.hostname
	)
		throw failure("Git URL must not contain credentials/query/fragment");
	const scriptPath = text(data.scriptPath, 512);
	if (
		scriptPath.startsWith("/") ||
		scriptPath
			.split("/")
			.some(
				(part) =>
					!part ||
					part === "." ||
					part === ".." ||
					/[\\%]/.test(part) ||
					[...part].some((char) => char.charCodeAt(0) < 32),
			)
	)
		throw failure("Invalid Jenkinsfile path");
	if (data.lightweight !== undefined && typeof data.lightweight !== "boolean")
		throw failure("Invalid lightweight value");
	node.attrs = {
		class: "org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition",
		plugin: "workflow-cps",
	};
	const scm = element("scm");
	scm.attrs = { class: "hudson.plugins.git.GitSCM", plugin: "git" };
	const remote = element("hudson.plugins.git.UserRemoteConfig");
	remote.children = [
		element("url", url),
		element(
			"credentialsId",
			data.credentialsId === undefined
				? ""
				: text(data.credentialsId, 256, true),
		),
	];
	const remotes = element("userRemoteConfigs");
	remotes.children = [remote];
	const branch = element("hudson.plugins.git.BranchSpec");
	branch.children = [element("name", text(data.branch, 256))];
	const branches = element("branches");
	branches.children = [branch];
	scm.children = [
		element("configVersion", "2"),
		remotes,
		branches,
		element("doGenerateSubmoduleConfigurations", "false"),
		element("submoduleCfg"),
		element("extensions"),
	];
	node.children = [
		scm,
		element("scriptPath", scriptPath),
		element("lightweight", data.lightweight === false ? "false" : "true"),
	];
	return node;
}
function projectDefinition(root: XmlNode): ObjectInput {
	const node = child(root, "definition");
	if (
		node.attrs.class === "org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition"
	) {
		if (content(child(node, "sandbox")) !== "true")
			throw failure("Unsandboxed Pipeline is not supported");
		return {
			kind: "inline",
			script: content(child(node, "script")),
			sandbox: true,
		};
	}
	if (
		node.attrs.class !==
		"org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition"
	)
		throw failure("Unsupported Pipeline definition");
	const scm = child(node, "scm");
	if (scm.attrs.class !== "hudson.plugins.git.GitSCM")
		throw failure("Only Git SCM is supported");
	const remotes = children(
		child(scm, "userRemoteConfigs"),
		"hudson.plugins.git.UserRemoteConfig",
	);
	const branches = children(
		child(scm, "branches"),
		"hudson.plugins.git.BranchSpec",
	);
	if (remotes.length !== 1 || branches.length !== 1)
		throw failure("Multiple remotes/branches are not supported");
	const remote = remotes[0] as XmlNode;
	const branch = branches[0] as XmlNode;
	const result = {
		kind: "git",
		url: content(child(remote, "url")),
		credentialsId: children(remote, "credentialsId").length
			? content(child(remote, "credentialsId"))
			: "",
		branch: content(child(branch, "name")),
		scriptPath: content(child(node, "scriptPath")),
		lightweight: content(child(node, "lightweight")) === "true",
	};
	makeDefinition(result);
	return result;
}
function parameterProjection(data: ObjectInput) {
	const properties = Array.isArray(data.property) ? data.property : [];
	const result: ObjectInput[] = [];
	for (const property of properties) {
		const definitions = property?.parameterDefinitions;
		if (!Array.isArray(definitions)) continue;
		for (const item of definitions) {
			if (result.length >= 100) throw failure("Too many parameter definitions");
			const type = text(item.type, 256);
			const safe = [
				"StringParameterDefinition",
				"TextParameterDefinition",
				"BooleanParameterDefinition",
				"ChoiceParameterDefinition",
			].includes(type);
			const value = item.defaultParameterValue?.value;
			result.push({
				name: text(item.name, 256),
				type,
				...(safe && ["string", "boolean", "number"].includes(typeof value)
					? { defaultValue: value }
					: {}),
				...(type === "ChoiceParameterDefinition" && Array.isArray(item.choices)
					? {
							choices: item.choices
								.slice(0, 100)
								.map((choice: unknown) => text(choice, 4096, true)),
						}
					: {}),
			});
		}
	}
	return result;
}

export const jenkinsCiConnectionCatalog =
	createJenkinsConnectionCatalog(jenkinsCiProfile);
export const jenkinsReleaseConnectionCatalog = createJenkinsConnectionCatalog(
	jenkinsReleaseProfile,
);
