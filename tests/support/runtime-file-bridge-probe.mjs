/**
 * #3230：在被检 Runtime 镜像内执行的 FileBridge origin 资格探针。
 *
 * 只使用镜像自带的正常入口 `/app/start-runtime-host.sh`、镜像内的生产配置读取与
 * FileBridge factory；不加载源码 checkout。Platform API 文件交换与模型都是本容器 loopback
 * 上的隔离 fixture：模型 fixture 只用于让原生 Turn 结束并给出 `sandbox:` 引用，不是业务
 * 模型验收；FileBridge fixture 按正式合同逐项核对 origin、认证、路径与请求形状。
 *
 * 环境装配与生产一致：
 * - 会话 Sandbox `runtime` 容器（apps/platform-worker/src/session-workload-adapter.ts
 *   `runtimeEnvironment`）：WORKER_ID、按 Sandbox 派生的传输 token，以及按分配派生的
 *   文件交换 token（packages/platform-core/src/session-sandbox-credential.ts）。
 * - Agent Workload `agent` 容器（apps/platform-worker/src/workload-runtime-auth.ts）：
 *   READINESS_BINDING，文件交换 token 与 runtime-auth service token 取同一 Secret 值。
 * origin 采用部署推导的集群内 Service DNS 形式 `http://agent-infra-api.<namespace>.svc:3000`，
 * 由探针启动参数中的 `--add-host` 解析到本容器 loopback；容器没有网络。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	createHash,
	createHmac,
	generateKeyPairSync,
	randomBytes,
	randomUUID,
	sign,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

import { probeStep as runProbeStep } from "./runtime-probe-diagnostics.mjs";

/** Runtime Driver 由 Worker 的模板绑定选择：codex、claude、opencode→acp、pi。 */
export const fileBridgeProbeDrivers = Object.freeze([
	"codex",
	"claude",
	"acp",
	"pi",
]);
export const fileBridgeProbeServicePort = 3000;
/**
 * 必需检查，顺序固定。Codex 会话 Sandbox 另有初始化与 executor 容器（同一镜像）；探针
 * 证明 executor 拒绝 FileBridge 输入，属于非消费者。
 */
export function fileBridgeProbeRequiredChecks(driver) {
	return [
		"file-exchange-startup-rejections",
		...(driver === "codex"
			? ["session-executor-rejects-file-bridge-input"]
			: []),
		"session-sandbox-origin-startup",
		"session-sandbox-attachment-read",
		"session-sandbox-result-write",
		"session-sandbox-derived-token-only",
		"agent-workload-origin-startup",
		"agent-workload-attachment-round-trip",
		"exchange-rejection-fails-closed",
		"exchange-redirect-not-followed",
		"content-redirect-not-followed",
		"content-size-mismatch-rejected",
		"content-digest-mismatch-rejected",
		"file-exchange-credentials-redacted",
	];
}

/** Worker 为 Codex 选择的隔离：会话 Sandbox 用 session executor，Agent Workload 用容器边界。 */
export function fileBridgeProbeIsolation(driver) {
	return driver === "codex"
		? {
				sessionSandbox: "session-executor",
				agentWorkload: "container-boundary",
			}
		: { sessionSandbox: "driver-default", agentWorkload: "driver-default" };
}

const runtimePort = 3003;
const trapPort = 3001;
const namespacePattern = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const digestPattern = /^sha256:(?!0{64}$)[a-f0-9]{64}$/;
const grantKeyId = "file-bridge-probe-key";
const grantIssuer = "synthetic-platform";
const workerId = "synthetic-worker";
const agentId = "synthetic-file-agent";
const principalId = "synthetic-file-owner";
const sandboxId = "synthetic-sandbox-1";
const attachmentName = "probe-input.csv";

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const randomHex = (bytes) => randomBytes(bytes).toString("hex");

export function fileBridgeProbeOrigin(namespace) {
	if (typeof namespace !== "string" || !namespacePattern.test(namespace))
		throw new Error("File bridge probe namespace is invalid");
	return `http://agent-infra-api.${namespace}.svc:${fileBridgeProbeServicePort}`;
}

/**
 * 与生产派生一致：传输 token 见 `sessionSandboxServiceTokenV1`，文件交换 token 见
 * `sessionSandboxFileExchangeTokenV1`。两者用途不同，部署 token 不进入 Sandbox。
 */
export function sessionSandboxProbeTokens({
	deploymentServiceToken,
	namespace,
	sandbox = sandboxId,
	generation = 1,
	resourceFence = 1,
}) {
	return {
		transport: createHmac("sha256", deploymentServiceToken)
			.update(`session-sandbox-v1\0${namespace}\0${sandbox}`)
			.digest("base64url"),
		fileExchange: createHmac("sha256", deploymentServiceToken)
			.update(
				`session-sandbox-file-exchange-v1\0${namespace}\0${sandbox}\0${generation}\0${resourceFence}`,
			)
			.digest("base64url"),
	};
}

/** Worker 投影的 V4 keyless 配置：模型凭据只随单次执行经私有字段送达。 */
export function fileBridgeProbeModelConfiguration(driver, modelOrigin) {
	const codex = driver === "codex";
	return {
		schemaVersion: 4,
		configVersion: "file-bridge-probe-v4",
		defaultModelOptionId: "file-bridge-probe",
		defaultReasoningLevel: codex ? "medium" : "high",
		modelOptions: [
			{
				modelOptionId: "file-bridge-probe",
				endpoint: codex ? `${modelOrigin}/v1` : modelOrigin,
				model: codex ? "synthetic-relay-model" : "claude-opus-5",
				reasoningLevels: [codex ? "medium" : "high"],
				protocol: codex ? "openai-responses-v1" : "anthropic-messages-v1",
				authentication: "bearer",
			},
		],
	};
}

/** 生产 Pod env 的同名同值装配；`base` 是镜像自身的环境（Pod 继承镜像 ENV）。 */
export function fileBridgeProbeEnvironment({
	assembly,
	driver,
	base = {},
	namespace,
	deploymentServiceToken,
	grantPublicKey,
	modelConfiguration,
	dataDirectory,
	imageDigest,
	fileExchange,
	sessionExecutor,
}) {
	if (!fileBridgeProbeDrivers.includes(driver))
		throw new Error("File bridge probe driver is invalid");
	const origin = fileBridgeProbeOrigin(namespace);
	const common = {
		AGENT_INFRA_RUNTIME_AGENT_ID: agentId,
		AGENT_INFRA_RUNTIME_DATA_DIR: dataDirectory,
		PORT: String(runtimePort),
		AGENT_INFRA_RUNTIME_GRANT_KEY_ID: grantKeyId,
		AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY: grantPublicKey,
		AGENT_INFRA_RUNTIME_GRANT_ISSUER: grantIssuer,
		AGENT_INFRA_RUNTIME_MODEL_CONFIG: JSON.stringify(modelConfiguration),
		AGENT_INFRA_RUNTIME_DRIVER: driver,
	};
	const exchange = (token) =>
		fileExchange === false
			? {}
			: {
					AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN: origin,
					AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN: token,
				};
	const inherited = Object.fromEntries(
		Object.entries(base).filter(
			([name]) =>
				// 镜像固定的 Skill 安装声明随镜像 ENV 继承；其他平台输入只能由 Worker 注入。
				!name.startsWith("AGENT_INFRA_") ||
				name === "AGENT_INFRA_RUNTIME_INSTALLED_SKILL",
		),
	);
	if (assembly === "session-sandbox") {
		const tokens = sessionSandboxProbeTokens({
			deploymentServiceToken,
			namespace,
		});
		return {
			environment: {
				...inherited,
				...common,
				AGENT_INFRA_RUNTIME_WORKER_ID: workerId,
				AGENT_INFRA_RUNTIME_SERVICE_TOKEN: tokens.transport,
				...exchange(tokens.fileExchange),
				// session-workload-adapter.ts: the Codex Session executor binding is
				// attested with this Sandbox's transport token.
				...(sessionExecutor
					? {
							AGENT_INFRA_RUNTIME_ISOLATION_MODE: "session-executor",
							[sessionExecutor.bindingEnvironmentName]: JSON.stringify(
								sessionExecutor.binding,
							),
							[sessionExecutor.attestationEnvironmentName]:
								sessionExecutor.attest(tokens.transport),
							AGENT_INFRA_RUNTIME_POD_UID: sessionExecutor.podUid,
							AGENT_INFRA_RUNTIME_POD_NAME: sessionExecutor.binding.podName,
							AGENT_INFRA_RUNTIME_NAMESPACE: sessionExecutor.binding.namespace,
						}
					: {}),
			},
			transportToken: tokens.transport,
			fileExchangeToken: tokens.fileExchange,
			origin,
		};
	}
	if (assembly === "agent-workload") {
		if (!digestPattern.test(imageDigest ?? ""))
			throw new Error("File bridge probe image digest is invalid");
		return {
			environment: {
				...inherited,
				...common,
				AGENT_INFRA_RUNTIME_READINESS_BINDING: JSON.stringify({
					workerId,
					agentId,
					workloadRevision: 1,
					fence: 1,
					imageDigest,
				}),
				AGENT_INFRA_RUNTIME_SERVICE_TOKEN: deploymentServiceToken,
				...exchange(deploymentServiceToken),
				// workload-runtime-auth.ts codexContainerBoundaryEnvironmentV1.
				...(driver === "codex"
					? {
							AGENT_INFRA_RUNTIME_ISOLATION_MODE: "container-boundary",
							AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_ENABLED: "worker-v1",
							AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_SCOPE: agentId,
							AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_ATTESTATION: createHmac(
								"sha256",
								deploymentServiceToken,
							)
								.update(`agent-infra-container-boundary-v1\0${agentId}`)
								.digest("base64url"),
						}
					: {}),
			},
			transportToken: deploymentServiceToken,
			fileExchangeToken: deploymentServiceToken,
			origin,
		};
	}
	throw new Error("File bridge probe assembly is invalid");
}

/**
 * 正式 origin/token 规则的启动期负例（RuntimeHost `readRuntimeFileExchangeOptions` 与
 * Worker `isFileExchangeOriginV1` 共用）。每一项都必须在联系任何 origin 之前拒绝启动。
 */
export function fileExchangeStartupRejections(namespace, token) {
	const host = `agent-infra-api.${namespace}.svc`;
	const origin = fileBridgeProbeOrigin(namespace);
	const originOnly = (value) => ({
		AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN: value,
		AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN: token,
	});
	return [
		[
			"origin-without-token",
			{ AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN: origin },
		],
		[
			"token-without-origin",
			{ AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN: token },
		],
		["origin-with-path", originOnly(`${origin}/files`)],
		["origin-with-trailing-slash", originOnly(`${origin}/`)],
		[
			"origin-with-credentials",
			originOnly(`http://probe:probe@${host}:${fileBridgeProbeServicePort}`),
		],
		["origin-with-query", originOnly(`${origin}?probe=1`)],
		["origin-with-fragment", originOnly(`${origin}#probe`)],
		[
			"cleartext-ipv4-origin",
			originOnly(`http://127.0.0.1:${fileBridgeProbeServicePort}`),
		],
		[
			"cleartext-ipv6-origin",
			originOnly(`http://[::1]:${fileBridgeProbeServicePort}`),
		],
		[
			"non-http-origin",
			originOnly(`ftp://${host}:${fileBridgeProbeServicePort}`),
		],
		["explicit-default-port-origin", originOnly(`http://${host}:80`)],
		[
			"uppercase-host-origin",
			originOnly(
				`http://Agent-Infra-API.${namespace}.svc:${fileBridgeProbeServicePort}`,
			),
		],
		[
			"short-token",
			{
				AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN: origin,
				AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN: "s".repeat(31),
			},
		],
		[
			"token-with-space",
			{
				AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN: origin,
				AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN: `${"s".repeat(32)} probe`,
			},
		],
	];
}

function exactKeys(value, keys) {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).sort().join(",") === [...keys].sort().join(",")
	);
}

function compactToken() {
	return [16, 48, 64]
		.map((size) => randomBytes(size).toString("base64url"))
		.join(".");
}

/**
 * Platform API 文件交换与执行数据面的隔离 fixture。它不复用被检镜像的合同代码：
 * 路径、认证头、请求形状与 Platform API `file-routes.ts` / contracts `files.ts` 对齐，
 * 任一偏差都记为违规并按 Platform 的方式返回 404。
 */
export function createFileBridgeFixture({
	hostHeader,
	trapOrigin,
	now = Date.now,
}) {
	const counts = {
		exchangeRead: 0,
		exchangeResult: 0,
		contentRead: 0,
		contentWrite: 0,
		complete: 0,
		violations: 0,
		unexpected: 0,
		total: 0,
	};
	const violations = [];
	const secrets = new Set();
	let scenario;
	const violation = (reason) => {
		counts.violations++;
		violations.push(reason);
	};
	const timestamps = () => ({
		createdAt: new Date(now()).toISOString(),
		accessExpiresAt: new Date(now() + 15 * 60_000).toISOString(),
		fileExpiresAt: new Date(now() + 24 * 60 * 60_000).toISOString(),
	});
	function projection(file, status) {
		const time = timestamps();
		return {
			schemaVersion: 1,
			fileId: file.fileId,
			kind: file.kind,
			descriptor: file.descriptor,
			status,
			createdAt: time.createdAt,
			expiresAt: time.fileExpiresAt,
		};
	}
	function issueAccess(file, operation) {
		const grant = compactToken();
		const accessId = `access-${randomHex(12)}`;
		secrets.add(grant);
		scenario.accesses.set(accessId, { file, operation, grant });
		const time = timestamps();
		return {
			schemaVersion: 1,
			accessId,
			file: projection(file, file.kind === "result" ? "pending" : "available"),
			path: `/api/v1/conversations/${encodeURIComponent(scenario.conversationId)}/files/${encodeURIComponent(file.fileId)}/content`,
			grant: { schemaVersion: 1, format: "compact-jws", token: grant },
			expiresAt: time.accessExpiresAt,
		};
	}
	function deny(response, status = 404) {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				schemaVersion: 1,
				code: "RESOURCE_UNAVAILABLE",
				message: "Resource unavailable",
				retryable: false,
			}),
		);
	}
	function authenticated(request) {
		const expectedHost =
			typeof hostHeader === "function" ? hostHeader() : hostHeader;
		if (request.headers.host !== expectedHost) violation("host");
		if (request.headers.authorization !== `Bearer ${scenario.token}`) {
			violation("service-credential");
			return false;
		}
		return true;
	}
	function grantFor(request, operation) {
		const token = request.headers["x-platform-file-grant"];
		for (const [accessId, access] of scenario.accesses)
			if (access.grant === token && access.operation === operation)
				return { accessId, ...access };
		violation("file-grant");
		return undefined;
	}
	function validDescriptor(value) {
		return (
			exactKeys(value, ["mediaType", "name", "sha256", "sizeBytes"]) &&
			typeof value.name === "string" &&
			/^[^\p{Cc}/\\]{1,255}$/u.test(value.name) &&
			typeof value.mediaType === "string" &&
			/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value.mediaType) &&
			Number.isSafeInteger(value.sizeBytes) &&
			value.sizeBytes >= 0 &&
			typeof value.sha256 === "string" &&
			/^[a-f0-9]{64}$/.test(value.sha256)
		);
	}
	async function exchange(request, response) {
		if (
			request.method !== "POST" ||
			!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "")
		) {
			violation("exchange-request");
			return deny(response);
		}
		if (!authenticated(request)) return deny(response);
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		let body;
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			violation("exchange-json");
			return deny(response);
		}
		const key = request.headers["idempotency-key"];
		const read =
			body?.operation === "read" &&
			exactKeys(body, [
				"executionGrant",
				"fileId",
				"idempotencyKey",
				"operation",
				"schemaVersion",
			]);
		const result =
			body?.operation === "result" &&
			(exactKeys(body, [
				"descriptor",
				"executionGrant",
				"idempotencyKey",
				"operation",
				"schemaVersion",
			]) ||
				exactKeys(body, [
					"descriptor",
					"executionGrant",
					"idempotencyKey",
					"operation",
					"schemaVersion",
					"workspaceReference",
				]));
		if (
			(!read && !result) ||
			body.schemaVersion !== 2 ||
			typeof key !== "string" ||
			key !== body.idempotencyKey ||
			!/^[A-Za-z0-9._~-]{1,128}$/.test(key) ||
			!exactKeys(body.executionGrant, ["format", "schemaVersion", "token"]) ||
			body.executionGrant.schemaVersion !== 4 ||
			body.executionGrant.format !== "runtime-execution-jws" ||
			// 交换只接受本次执行原始签名的 V4 Grant，不接受自报身份。
			body.executionGrant.token !== scenario.grantToken
		) {
			violation("exchange-shape");
			return deny(response);
		}
		if (read) {
			counts.exchangeRead++;
			if (body.fileId !== scenario.input.fileId) {
				violation("exchange-file");
				return deny(response);
			}
			if (scenario.mode === "exchange-rejected") return deny(response);
			if (scenario.mode === "exchange-redirect") {
				response.writeHead(307, {
					location: `${trapOrigin}/internal/v1/files/runtime-exchange`,
				});
				return response.end();
			}
			const file = {
				fileId: scenario.input.fileId,
				kind: "attachment",
				descriptor: scenario.input.descriptor,
			};
			response.writeHead(200, { "content-type": "application/json" });
			return response.end(JSON.stringify(issueAccess(file, "read")));
		}
		counts.exchangeResult++;
		if (
			!validDescriptor(body.descriptor) ||
			body.descriptor.sizeBytes !== scenario.input.bytes.length ||
			body.descriptor.sha256 !== scenario.input.descriptor.sha256 ||
			body.workspaceReference !== scenario.workspaceReference
		) {
			violation("exchange-result-descriptor");
			return deny(response);
		}
		scenario.result ??= {
			fileId: `result-${randomHex(12)}`,
			kind: "result",
			descriptor: body.descriptor,
			uploadedSha256: undefined,
		};
		response.writeHead(200, { "content-type": "application/json" });
		return response.end(JSON.stringify(issueAccess(scenario.result, "write")));
	}
	async function content(request, response, fileId, action) {
		if (!authenticated(request)) return deny(response);
		if (action === "complete") {
			const access = grantFor(request, "write");
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			let body;
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				body = undefined;
			}
			if (
				request.method !== "POST" ||
				!access ||
				access.file.fileId !== fileId ||
				!exactKeys(body, ["accessId", "schemaVersion"]) ||
				body.schemaVersion !== 1 ||
				body.accessId !== access.accessId ||
				scenario.result?.uploadedSha256 !== scenario.input.descriptor.sha256
			) {
				violation("complete");
				return deny(response);
			}
			counts.complete++;
			response.writeHead(200, { "content-type": "application/json" });
			return response.end(
				JSON.stringify(projection(scenario.result, "available")),
			);
		}
		if (request.method === "GET") {
			const access = grantFor(request, "read");
			if (!access || access.file.fileId !== fileId) {
				violation("content-read");
				return deny(response);
			}
			counts.contentRead++;
			if (scenario.mode === "content-redirect") {
				response.writeHead(302, { location: `${trapOrigin}/content` });
				return response.end();
			}
			let bytes = scenario.input.bytes;
			if (scenario.mode === "content-oversize")
				bytes = Buffer.concat([bytes, Buffer.from("x")]);
			if (scenario.mode === "content-digest") {
				bytes = Buffer.from(bytes);
				bytes[0] ^= 0xff;
			}
			response.writeHead(200, {
				"content-type": scenario.input.descriptor.mediaType,
				"content-length": String(bytes.length),
			});
			return response.end(bytes);
		}
		if (request.method === "PUT") {
			const access = grantFor(request, "write");
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			const bytes = Buffer.concat(chunks);
			if (
				!access ||
				access.file.fileId !== fileId ||
				request.headers["content-type"] !==
					scenario.result?.descriptor.mediaType ||
				request.headers["content-length"] !==
					String(scenario.result?.descriptor.sizeBytes) ||
				bytes.length !== scenario.result.descriptor.sizeBytes ||
				sha256Hex(bytes) !== scenario.result.descriptor.sha256
			) {
				violation("content-write");
				return deny(response);
			}
			counts.contentWrite++;
			scenario.result.uploadedSha256 = sha256Hex(bytes);
			response.writeHead(204);
			return response.end();
		}
		violation("content-method");
		return deny(response);
	}
	const server = createServer(async (request, response) => {
		counts.total++;
		try {
			if (!scenario) {
				counts.unexpected++;
				return deny(response);
			}
			const url = new URL(request.url ?? "/", "http://fixture.invalid");
			if (url.search) {
				violation("query");
				return deny(response);
			}
			if (url.pathname === "/internal/v1/files/runtime-exchange")
				return await exchange(request, response);
			const match =
				/^\/api\/v1\/conversations\/([^/]+)\/files\/([^/]+)\/(content|complete)$/.exec(
					url.pathname,
				);
			if (match && decodeURIComponent(match[1]) === scenario.conversationId)
				return await content(
					request,
					response,
					decodeURIComponent(match[2]),
					match[3],
				);
			counts.unexpected++;
			return deny(response);
		} catch {
			violation("fixture-error");
			if (!response.headersSent) deny(response, 500);
			else response.destroy();
		}
	});
	return {
		server,
		counts,
		violations,
		secrets,
		begin(next) {
			for (const value of [next.token, next.grantToken]) secrets.add(value);
			scenario = { ...next, accesses: new Map(), result: undefined };
			return scenario;
		},
		get scenario() {
			return scenario;
		},
		snapshot() {
			return { ...counts };
		},
	};
}

function sse(value) {
	return `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
}

function responsesEvents(sequence, text) {
	const item = {
		type: "message",
		id: `file-bridge-message-${sequence}`,
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	return [
		{
			type: "response.created",
			response: {
				id: `file-bridge-response-${sequence}`,
				status: "in_progress",
				output: [],
			},
		},
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...item, status: "in_progress", content: [] },
		},
		{
			type: "response.output_text.delta",
			item_id: item.id,
			output_index: 0,
			content_index: 0,
			delta: text,
		},
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: {
				id: `file-bridge-response-${sequence}`,
				status: "completed",
				output: [item],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		},
	];
}

function messagesEvents(sequence, model, text) {
	return [
		{
			type: "message_start",
			message: {
				id: `msg_file_bridge_${sequence}`,
				type: "message",
				role: "assistant",
				model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 2 },
		},
		{ type: "message_stop" },
	];
}

/**
 * 隔离的本地模型替身：只校验执行私有字段送达的 relay key，回答固定文本。正向 Turn 的
 * 回答以 `sandbox:` 引用平台刚物化的附件路径，从而驱动生产的结果发布路径。
 */
export function createModelFixture() {
	const state = {
		requests: 0,
		authenticated: 0,
		manifestSeen: 0,
		unexpected: 0,
		turn: undefined,
	};
	const server = createServer(async (request, response) => {
		state.requests++;
		try {
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			let bytes = Buffer.concat(chunks);
			if (request.headers["content-encoding"] === "gzip")
				bytes = gunzipSync(bytes);
			if (request.headers["content-encoding"] === "zstd")
				bytes = zstdDecompressSync(bytes);
			const turn = state.turn;
			const path = request.url ?? "";
			if (
				!turn ||
				request.method !== "POST" ||
				request.headers.authorization !== `Bearer ${turn.relayKey}`
			) {
				state.unexpected++;
				response.writeHead(401, { "content-type": "application/json" });
				return response.end('{"error":{"message":"unauthorized"}}');
			}
			state.authenticated++;
			turn.requests++;
			const text = bytes.toString("utf8");
			if (turn.workspaceReference && text.includes(turn.workspaceReference))
				state.manifestSeen++;
			const answer = turn.workspaceReference
				? `File bridge probe result: [probe-result](sandbox:${turn.workspaceReference})`
				: "File bridge probe answer.";
			if (/\/v1\/messages\/count_tokens(?:\?|$)/.test(path)) {
				response.writeHead(200, { "content-type": "application/json" });
				return response.end('{"input_tokens":10}');
			}
			if (/\/v1\/messages(?:\?|$)/.test(path)) {
				const body = JSON.parse(text);
				response.writeHead(200, { "content-type": "text/event-stream" });
				for (const event of messagesEvents(state.requests, body.model, answer))
					response.write(sse(event));
				return response.end();
			}
			if (/\/v1\/responses$/.test(path)) {
				response.writeHead(200, { "content-type": "text/event-stream" });
				for (const event of responsesEvents(state.requests, answer))
					response.write(sse(event));
				return response.end();
			}
			state.unexpected++;
			response.writeHead(404, { "content-type": "application/json" });
			return response.end('{"error":{"message":"not found"}}');
		} catch {
			state.unexpected++;
			if (!response.headersSent) response.writeHead(500);
			response.end();
		}
	});
	return { server, state };
}

function listen(server, port, host = "127.0.0.1") {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve(server.address().port);
		});
	});
}

function close(server) {
	return new Promise((resolve) => {
		server.closeAllConnections?.();
		server.close(() => resolve());
	});
}

function base64url(value) {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signJws(claims, privateKey) {
	const input = `${base64url({ alg: "EdDSA", kid: grantKeyId, typ: "runtime-execution+jws" })}.${base64url(claims)}`;
	return `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
}

/** V4 业务提交（Worker `createWorkerRuntimeHostClientV4` 的线格式）。 */
export async function signedSubmitTurnV4({
	contracts,
	privateKey,
	binding,
	attachments,
	selection,
	relayKey,
	now = Date.now(),
}) {
	const request = {
		schemaVersion: 4,
		requestId: `request-${randomHex(12)}`,
		traceId: `trace-${binding.executionId}`,
		principal: { kind: "user", id: principalId },
		executionSource: "web",
		channelId: "web",
		agentId,
		conversationId: binding.conversationId,
		executionId: binding.executionId,
		turnId: binding.turnId,
		sessionGeneration: 1,
		hostSessionRef: null,
		operation: {
			kind: "execution",
			id: binding.executionId,
			deliveryFence: 1,
			executionDeliveryFence: 1,
		},
		keyBinding: {
			purpose: "personal",
			subjectId: principalId,
			ciphertextRef: "synthetic-relay-ciphertext",
			version: 1,
		},
		input: { text: "Synthetic file bridge probe input.", attachments },
		selection,
		grant: {
			schemaVersion: 4,
			format: "runtime-execution-jws",
			token: "e30.e30.e30",
		},
	};
	const requestDigest = sha256Hex(
		contracts.runtimeRequestSigningPayloadV4(request),
	);
	const claims = contracts.RuntimeBusinessGrantClaimsV4Schema.parse({
		schemaVersion: 4,
		issuer: grantIssuer,
		audience: "runtime_host",
		workerId,
		issuedAt: now,
		expiresAt: now + contracts.RuntimeExecutionGrantMaximumLifetimeMsV4,
		grantId: `grant-${randomHex(12)}`,
		principal: request.principal,
		agentId,
		channelId: request.channelId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: 1,
		traceId: request.traceId,
		hostSessionRef: null,
		operation: request.operation,
		requestDigest,
		purpose: "business",
		authorizationRecordId: `authorization-${request.executionId}`,
		allowedCommands: ["turn.submit"],
		attachments: attachments.map((attachmentId) => ({
			attachmentId,
			operations: ["read"],
		})),
		executionSource: request.executionSource,
		relayKeyBinding: request.keyBinding,
	});
	request.grant = {
		schemaVersion: 4,
		format: "runtime-execution-jws",
		token: signJws(claims, privateKey),
	};
	const transport = contracts.RuntimeSubmitTurnTransportV4Schema.parse({
		businessRequest: request,
		privateKeyField: {
			schemaVersion: 1,
			context: {
				requestId: request.requestId,
				grantId: claims.grantId,
				requestDigest,
				traceId: request.traceId,
				principal: request.principal,
				executionSource: request.executionSource,
				channelId: request.channelId,
				agentId,
				conversationId: request.conversationId,
				executionId: request.executionId,
				turnId: request.turnId,
				sessionGeneration: 1,
				hostSessionRef: null,
				operation: request.operation,
				keyBinding: request.keyBinding,
			},
			keyDelivery: { relayKey },
		},
	});
	return { transport, request, grantToken: request.grant.token };
}

/** V4 事件读取（Worker 持久化消费者）：V2 业务 Grant 携带 eventAccess。 */
export async function signedEventReadV4({
	contracts,
	privateKey,
	submitted,
	hostSessionRef,
	afterCursor,
	now = Date.now(),
}) {
	const original = submitted.request;
	const request = {
		schemaVersion: 4,
		requestId: `request-${randomHex(12)}`,
		traceId: original.traceId,
		principal: original.principal,
		executionSource: original.executionSource,
		channelId: original.channelId,
		agentId,
		conversationId: original.conversationId,
		executionId: original.executionId,
		turnId: original.turnId,
		sessionGeneration: 1,
		hostSessionRef,
		operation: original.operation,
		grant: {
			schemaVersion: 2,
			format: "runtime-execution-jws",
			token: "e30.e30.e30",
		},
		keyBinding: original.keyBinding,
		consumer: "platform_worker_persistence",
		afterCursor,
	};
	const requestDigest = await contracts.runtimeEventRequestDigestV4(request);
	const claims = contracts.RuntimeExecutionGrantClaimsV2Schema.parse({
		schemaVersion: 2,
		issuer: grantIssuer,
		audience: "runtime_host",
		issuedAt: now,
		expiresAt: now + contracts.RuntimeExecutionGrantMaximumLifetimeMsV2,
		grantId: `grant-${randomHex(12)}`,
		workerId,
		principal: original.principal,
		agentId,
		channelId: original.channelId,
		conversationId: original.conversationId,
		executionId: original.executionId,
		turnId: original.turnId,
		sessionGeneration: 1,
		traceId: original.traceId,
		hostSessionRef,
		operation: original.operation,
		requestDigest,
		eventAccess: {
			command: "events.persist",
			consumer: "platform_worker_persistence",
			afterCursor,
		},
		purpose: "business",
		authorizationRecordId: `authorization-${original.executionId}`,
		allowedCommands: ["events.persist"],
		attachments: [],
	});
	request.grant = {
		schemaVersion: 2,
		format: "runtime-execution-jws",
		token: signJws(claims, privateKey),
	};
	return contracts.RuntimeEventReadRequestV4Schema.parse(request);
}

/** Session executor gateway and native backend (codex-session-executor-binding.ts). */
export const sessionExecutorPorts = Object.freeze([8068, 8070]);

/** Linux 进程表。pid 与启动时间一起标识进程，pid 被复用时不会误判。 */
function processTable() {
	const table = new Map();
	for (const name of readdirSync("/proc")) {
		if (!/^[0-9]+$/.test(name)) continue;
		let stat;
		try {
			stat = readFileSync(`/proc/${name}/stat`, "utf8");
		} catch {
			continue; // The process exited while the table was read.
		}
		// The command name may contain spaces and ")"; the fields follow the last ")".
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		table.set(Number(name), {
			state: fields[0],
			ppid: Number(fields[1]),
			pgrp: Number(fields[2]),
			start: fields[19],
		});
	}
	return table;
}

function portRefused(port) {
	return new Promise((resolve) => {
		const socket = connect({ host: "127.0.0.1", port });
		const done = (refused) => {
			socket.destroy();
			resolve(refused);
		};
		socket.setTimeout(1000, () => done(false));
		socket.once("connect", () => done(false));
		socket.once("error", (error) => done(error.code === "ECONNREFUSED"));
	});
}

/**
 * 探针阶段入口的进程生命周期。阶段结束必须证明真正终止：入口进程及其全部后代都已退出，
 * 入口的 stdio 已关闭，阶段服务端口拒绝连接。原生 Runtime 运行在自己的进程组中，入口进程组
 * 的负 PID 覆盖不到它们，所以后代按 /proc 父子关系在阶段运行期间持续登记。
 * - 正常路径只发送 SIGTERM，保留 tini、Host 与 runner 自己的清理，然后核对实际终止。
 * - 超时后有界地强制清理全部登记进程并确认退出，但该阶段仍然失败。
 * - 任一阶段未被证明终止，之后的阶段不再启动。
 */
export function createProbeProcesses({
	command = "/bin/sh",
	entry = "/app/start-runtime-host.sh",
	cwd = "/app",
	sampleMs = 200,
} = {}) {
	const outputs = [];
	const running = new Set();
	let unproven;
	const living = (phase, table = processTable()) =>
		[...phase.tree].flatMap(([pid, start]) => {
			const current = table.get(pid);
			return current?.start === start &&
				current.state !== "Z" &&
				current.state !== "X"
				? [{ pid, pgrp: current.pgrp }]
				: [];
		});
	// Every child of a living tracked process joins the tree, wherever its
	// process group or session is; an orphan stays tracked after reparenting.
	function observe(phase) {
		const table = processTable();
		const children = new Map();
		for (const [pid, { ppid }] of table)
			children.set(ppid, [...(children.get(ppid) ?? []), pid]);
		const queue = living(phase, table).map(({ pid }) => pid);
		while (queue.length > 0)
			for (const pid of children.get(queue.pop()) ?? [])
				if (phase.tree.get(pid) !== table.get(pid).start) {
					phase.tree.set(pid, table.get(pid).start);
					queue.push(pid);
				}
		return table;
	}
	function force(phase) {
		const own = processTable().get(process.pid)?.pgrp;
		const kill = (target) => {
			try {
				process.kill(target, "SIGKILL");
			} catch {
				// Already gone.
			}
		};
		const groups = new Set([phase.child.pid]);
		for (const { pid, pgrp } of living(phase)) {
			if (pid > 1 && pid !== process.pid) kill(pid);
			groups.add(pgrp);
		}
		for (const group of groups)
			if (group > 1 && group !== own && group !== process.pid) kill(-group);
	}
	function spawnEntry(args, environment) {
		if (unproven) throw unproven;
		// Its own process group: forced cleanup also reaches the entry's direct
		// children, and leftover stdio cannot hang the probe.
		const child = spawn(command, [entry, ...args], {
			cwd,
			env: environment,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const record = { output: "" };
		outputs.push(record);
		for (const stream of [child.stdout, child.stderr])
			stream.on("data", (chunk) => {
				record.output += chunk.toString("utf8");
			});
		const phase = { child, record, closed: false, code: undefined };
		phase.tree = new Map([[child.pid, processTable().get(child.pid)?.start]]);
		// "close" follows the exit and the end of every holder of the entry's stdio.
		child.once("close", (code) => {
			phase.closed = true;
			phase.code = code;
		});
		phase.sampler = setInterval(() => observe(phase), sampleMs);
		phase.sampler.unref();
		running.add(phase);
		return phase;
	}
	/**
	 * Ends a phase: with `signal` it stops the entry, otherwise the entry must
	 * exit by itself. Resolves with the entry's exit code only after the proof;
	 * a timeout never passes.
	 */
	async function settle(
		phase,
		{ name, signal, ports = [], graceMs = 15_000, forceMs = 5_000 },
	) {
		observe(phase);
		if (signal) phase.child.kill(signal);
		const terminal = async (ms) => {
			const deadline = Date.now() + ms;
			for (;;) {
				observe(phase);
				if (phase.closed && living(phase).length === 0) return true;
				if (Date.now() >= deadline) return false;
				await delay(50);
			}
		};
		let failure;
		if (!(await terminal(graceMs))) {
			force(phase);
			failure = (await terminal(forceMs))
				? `did not terminate within ${graceMs} ms; forced cleanup confirmed`
				: "termination could not be confirmed after forced cleanup";
		} else
			for (const port of ports)
				if (!(await portRefused(port)))
					failure ??= `port ${port} still accepts connections`;
		if (!failure) {
			clearInterval(phase.sampler);
			running.delete(phase);
			return phase.code;
		}
		const error = new Error(`${name} ${failure}`);
		unproven ??= error;
		throw error;
	}
	function killAll() {
		for (const phase of running) {
			clearInterval(phase.sampler);
			force(phase);
		}
	}
	return { outputs, spawn: spawnEntry, settle, killAll };
}

export async function runFileBridgeOriginProbe({
	driver,
	namespace,
	imageReference,
	contracts,
	runtime,
	baseEnvironment = process.env,
	diagnostics = {},
	step = runProbeStep,
	/** 仅供本地诊断：失败时收到合成凭据下的原始 Host 输出；正式入口不传。 */
	onFailureOutput,
}) {
	if (!fileBridgeProbeDrivers.includes(driver))
		throw new Error("File bridge probe driver is invalid");
	const imageDigest = /^[a-z0-9][a-z0-9.:/-]*@(sha256:[a-f0-9]{64})$/.exec(
		imageReference ?? "",
	)?.[1];
	if (!imageDigest || !digestPattern.test(imageDigest))
		throw new Error("File bridge probe image reference is invalid");
	const origin = fileBridgeProbeOrigin(namespace);
	const hostHeader = new URL(origin).host;
	const isolation = fileBridgeProbeIsolation(driver);
	const checks = [];
	const processes = createProbeProcesses();
	const { outputs } = processes;
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const grantPublicKey = publicKey.export({ type: "spki", format: "pem" });
	const deploymentServiceToken = `synthetic-deployment-${randomHex(24)}`;
	const relayKey = `synthetic-relay-${randomHex(24)}`;
	const trapHits = { count: 0 };
	const trap = createServer((request, response) => {
		trapHits.count++;
		request.resume();
		response.writeHead(200, { "content-type": "text/plain" });
		response.end("trap");
	});
	const trapOrigin = `http://127.0.0.1:${trapPort}`;
	const fixture = createFileBridgeFixture({ hostHeader, trapOrigin });
	const model = createModelFixture();
	const probeStep = (name, operation) =>
		step(name, operation, () => ({
			...diagnostics.current,
			modelRequests: model.state.requests,
			fileBridgeRequests: fixture.counts.total,
		}));
	const check = (name, condition) => {
		assert.ok(condition, name);
		checks.push(name);
	};
	try {
		await probeStep("file-bridge-origin-resolution", async () => {
			// The isolated container resolves the formal Service DNS name only through
			// the probe's own host entry; nothing outside the container is reachable.
			const resolved = await lookup(new URL(origin).hostname, { family: 4 });
			assert.equal(resolved.address, "127.0.0.1");
			await listen(fixture.server, fileBridgeProbeServicePort);
			await listen(trap, trapPort);
		});
		const modelPort = await listen(model.server, 0);
		const modelConfiguration = fileBridgeProbeModelConfiguration(
			driver,
			`http://127.0.0.1:${modelPort}`,
		);
		const selection = {
			schemaVersion: 1,
			modelOptionId: modelConfiguration.defaultModelOptionId,
			reasoningLevel: modelConfiguration.defaultReasoningLevel,
		};
		// A Session Sandbox serves exactly one Conversation; the Codex executor
		// binding is derived from it with the image's own production helper.
		const sessionConversationId = "conversation-session";
		const sessionExecutor =
			isolation.sessionSandbox === "session-executor"
				? (() => {
						const binding = runtime.createCodexSessionExecutorBindingV1({
							namespace,
							podName: `sandbox-${sandboxId}`,
							agentId,
							conversationId: sessionConversationId,
							sessionGeneration: 1,
							sandboxId,
							resourceFence: 1,
							imageDigest: imageReference,
						});
						return {
							binding,
							podUid: randomUUID(),
							bindingEnvironmentName:
								runtime.CODEX_SESSION_EXECUTOR_BINDING_ENV,
							attestationEnvironmentName:
								runtime.CODEX_SESSION_EXECUTOR_ATTESTATION_ENV,
							attest: (token) =>
								runtime.codexSessionExecutorAttestationV1(binding, token),
						};
					})()
				: undefined;
		const dataDirectories = {
			"session-sandbox": "/workspace/runtime",
			"agent-workload": "/var/lib/agent-runtime/runtime",
		};
		const assemble = (assembly, overrides = {}) =>
			fileBridgeProbeEnvironment({
				assembly,
				driver,
				base: baseEnvironment,
				namespace,
				deploymentServiceToken,
				grantPublicKey,
				modelConfiguration,
				dataDirectory: dataDirectories[assembly],
				imageDigest,
				sessionExecutor,
				...overrides,
			});
		// The executor containers inherit the image ENV and receive only their
		// binding (and Pod UID); session-workload-adapter.ts / codex-session-executor.ts.
		const executorEnvironment = (extra) => ({
			...Object.fromEntries(
				Object.entries(baseEnvironment).filter(
					([name]) =>
						!name.startsWith("AGENT_INFRA_") ||
						name === "AGENT_INFRA_RUNTIME_INSTALLED_SKILL" ||
						name === "AGENT_INFRA_RUNTIME_DATA_DIR",
				),
			),
			[sessionExecutor.bindingEnvironmentName]: JSON.stringify(
				sessionExecutor.binding,
			),
			...extra,
		});
		function spawnEntry(args, environment) {
			return processes.spawn(args, environment);
		}

		async function launch(environment, rejection) {
			const phase = spawnEntry([], environment);
			const { child, record } = phase;
			const deadline = Date.now() + (rejection ? 30_000 : 120_000);
			const jsonLines = () =>
				record.output
					.split(/\r?\n/)
					.filter(Boolean)
					.flatMap((line) => {
						try {
							return [JSON.parse(line)];
						} catch {
							return [];
						}
					});
			while (Date.now() < deadline) {
				assert.ok(record.output.length < 1_048_576);
				const lines = jsonLines();
				if (child.exitCode !== null || child.signalCode !== null) {
					assert.ok(rejection, "runtime exited before ready");
					// The rejected Host and every descendant are gone before the next
					// launch, and nothing serves its port.
					const code = await processes.settle(phase, {
						name: "rejected runtime",
						ports: [runtimePort],
					});
					assert.notEqual(code, 0);
					const failure = jsonLines().find(
						(line) => line?.service === "agent-runtime-host" && line.code,
					);
					diagnostics.current = { startupCode: failure?.code };
					assert.equal(failure?.code, rejection);
					return record;
				}
				const ready = lines.find((line) => line?.status === "ready");
				if (ready) {
					assert.ok(!rejection, "runtime accepted an invalid configuration");
					assert.equal(ready.configVersion, modelConfiguration.configVersion);
					return {
						record,
						async stop() {
							const code = await processes.settle(phase, {
								name: "runtime",
								signal: "SIGTERM",
								ports: [runtimePort],
							});
							// 0 is a graceful Host close; 143 is the SIGTERM status some
							// native runtimes return after the Host already confirmed every
							// result. Both are recorded in the evidence, never hidden.
							assert.ok(code === 0 || code === 143);
							return code;
						},
					};
				}
				await delay(50);
			}
			throw new Error("runtime launch timed out");
		}

		async function host(path, body, token) {
			const response = await fetch(
				`http://127.0.0.1:${runtimePort}/internal/runtime/${path}`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
					redirect: "error",
					signal: AbortSignal.timeout(90_000),
				},
			);
			const text = await response.text();
			outputs.push({ output: text });
			let json;
			try {
				json = JSON.parse(text);
			} catch {
				json = undefined;
			}
			diagnostics.current = {
				httpStatus: response.status,
				...(typeof json?.code === "string" ? { responseCode: json.code } : {}),
			};
			return { status: response.status, json };
		}

		async function readUntilTerminal(submitted, hostSessionRef, token, ms) {
			const events = [];
			let afterCursor = null;
			const deadline = Date.now() + ms;
			while (Date.now() < deadline) {
				const page = await host(
					"v4/events/read",
					await signedEventReadV4({
						contracts,
						privateKey,
						submitted,
						hostSessionRef,
						afterCursor,
					}),
					token,
				);
				assert.equal(page.status, 200);
				const replay = contracts.RuntimeEventReplayResponseV4Schema.parse(
					page.json,
				);
				for (const event of replay.events) {
					assert.equal(event.executionId, submitted.request.executionId);
					events.push(event);
					afterCursor = event.cursor;
				}
				const terminal = events.find((event) => event.type === "completed");
				if (terminal) return { events, terminal };
				await delay(replay.events.length ? 0 : 200);
			}
			return { events, terminal: undefined };
		}

		async function fileTurn(name, assembly, mode, conversationId) {
			const binding = {
				conversationId: conversationId ?? `conversation-${name}`,
				executionId: `execution-${name}`,
				turnId: `turn-${name}`,
			};
			const fileId = `file-${name}-${randomHex(8)}`;
			const bytes = Buffer.from(
				`marker,value\n${name},${randomHex(16)}\n`,
				"utf8",
			);
			const descriptor = {
				name: attachmentName,
				mediaType: "text/csv",
				sizeBytes: bytes.length,
				sha256: sha256Hex(bytes),
			};
			const workspaceReference = `.agent-infra/attachments/${sha256Hex(fileId).slice(0, 16)}/${attachmentName}`;
			const submitted = await signedSubmitTurnV4({
				contracts,
				privateKey,
				binding,
				attachments: [fileId],
				selection,
				relayKey,
			});
			const before = fixture.snapshot();
			const modelBefore = model.state.requests;
			const trapBefore = trapHits.count;
			fixture.begin({
				mode,
				token: assembly.fileExchangeToken,
				conversationId: binding.conversationId,
				grantToken: submitted.grantToken,
				input: { fileId, descriptor, bytes },
				workspaceReference,
			});
			model.state.turn = {
				relayKey,
				workspaceReference: mode === "ok" ? workspaceReference : undefined,
				requests: 0,
			};
			const accepted = await host(
				"v4/turns",
				submitted.transport,
				assembly.transportToken,
			);
			const result = accepted.json?.result;
			let outcome = { events: [], terminal: undefined };
			if (accepted.status === 200 && result?.outcome === "accepted")
				outcome = await readUntilTerminal(
					submitted,
					accepted.json.hostSessionRef,
					assembly.transportToken,
					mode === "ok" ? 120_000 : 30_000,
				);
			diagnostics.current = {
				httpStatus: accepted.status,
				resultStatus: outcome.terminal?.payload?.status,
			};
			const after = fixture.snapshot();
			return {
				accepted,
				result,
				outcome,
				delta: Object.fromEntries(
					Object.keys(after).map((key) => [key, after[key] - before[key]]),
				),
				modelRequests: model.state.requests - modelBefore,
				trapHits: trapHits.count - trapBefore,
				workspaceReference,
				descriptor,
				resultFileId: fixture.scenario.result?.fileId,
			};
		}

		function assertRoundTrip(turn) {
			assert.equal(turn.accepted.status, 200);
			assert.equal(turn.result?.outcome, "accepted");
			assert.equal(turn.outcome.terminal?.payload?.status, "completed");
			const files = turn.outcome.events.filter(
				(event) => event.type === "file",
			);
			assert.equal(files.length, 1);
			assert.deepEqual(files[0].payload, {
				fileId: turn.resultFileId,
				name: turn.descriptor.name,
				mimeType: files[0].payload.mimeType,
				sizeBytes: turn.descriptor.sizeBytes,
				workspaceReference: turn.workspaceReference,
			});
			assert.ok(turn.modelRequests >= 1);
			assert.equal(turn.trapHits, 0);
			assert.equal(turn.delta.violations, 0);
			assert.equal(turn.delta.unexpected, 0);
			assert.deepEqual(
				[
					turn.delta.exchangeRead,
					turn.delta.contentRead,
					turn.delta.exchangeResult,
					turn.delta.contentWrite,
					turn.delta.complete,
				],
				[1, 1, 1, 1, 1],
			);
		}

		function assertFailedClosed(turn, expected) {
			// The input never reached the native Turn: no model request, no result
			// publication and no completed Turn.
			assert.equal(turn.modelRequests, 0);
			assert.equal(turn.trapHits, 0);
			assert.equal(turn.delta.violations, 0);
			assert.equal(turn.delta.unexpected, 0);
			assert.equal(turn.delta.exchangeResult, 0);
			assert.equal(turn.delta.contentWrite, 0);
			assert.equal(turn.delta.complete, 0);
			assert.notEqual(turn.outcome.terminal?.payload?.status, "completed");
			if (turn.accepted.status === 200 && turn.result?.outcome === "accepted")
				assert.ok(turn.outcome.terminal, "rejected input left the Turn open");
			assert.ok(turn.delta.exchangeRead >= 1);
			if (expected.contentRead === 0) assert.equal(turn.delta.contentRead, 0);
			else assert.ok(turn.delta.contentRead >= expected.contentRead);
		}

		const rejectionToken = sessionSandboxProbeTokens({
			deploymentServiceToken,
			namespace,
		}).fileExchange;
		for (const [name, patch] of fileExchangeStartupRejections(
			namespace,
			rejectionToken,
		)) {
			await probeStep("file-bridge-startup-rejection", async () => {
				const { environment } = assemble("session-sandbox", {
					fileExchange: false,
				});
				const before = fixture.counts.total;
				const record = await launch(
					{ ...environment, ...patch },
					"RUNTIME_CONFIGURATION_INVALID",
				);
				assert.equal(fixture.counts.total, before, name);
				for (const value of Object.values(patch))
					assert.ok(!record.output.includes(value), name);
			});
		}
		checks.push("file-exchange-startup-rejections");

		const session = assemble("session-sandbox");
		assert.notEqual(session.fileExchangeToken, session.transportToken);
		assert.notEqual(session.fileExchangeToken, deploymentServiceToken);
		fixture.secrets.add(session.transportToken);
		fixture.secrets.add(session.fileExchangeToken);
		fixture.secrets.add(deploymentServiceToken);
		fixture.secrets.add(relayKey);
		let executor;
		if (sessionExecutor) {
			await probeStep("file-bridge-session-executor", async () => {
				// Same image, same entry: the trusted init container prepares the
				// workspace, then the executor starts with only its binding and Pod UID.
				const init = spawnEntry(
					["--session-executor", "init"],
					executorEnvironment({}),
				);
				// The init container exits by itself; its whole tree must be gone.
				assert.equal(
					await processes.settle(init, {
						name: "session workspace init",
						graceMs: 30_000,
					}),
					0,
				);
				const before = fixture.counts.total;
				const rejected = spawnEntry(
					["--session-executor", "run"],
					executorEnvironment({
						AGENT_INFRA_RUNTIME_POD_UID: sessionExecutor.podUid,
						AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN: origin,
						AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN:
							session.fileExchangeToken,
					}),
				);
				const code = await processes.settle(rejected, {
					name: "rejected session executor",
					graceMs: 30_000,
					ports: sessionExecutorPorts,
				});
				assert.ok(Number.isInteger(code) && code !== 0);
				assert.ok(
					rejected.record.output.includes("CODEX_EXECUTOR_STARTUP_FAILED"),
				);
				assert.equal(fixture.counts.total, before);
				executor = spawnEntry(
					["--session-executor", "run"],
					executorEnvironment({
						AGENT_INFRA_RUNTIME_POD_UID: sessionExecutor.podUid,
					}),
				);
				const deadline = Date.now() + 60_000;
				for (;;) {
					assert.equal(executor.child.exitCode, null);
					try {
						const status = await fetch("http://127.0.0.1:8068/status", {
							redirect: "error",
							signal: AbortSignal.timeout(1000),
						});
						const value = await status.json();
						if (
							status.ok &&
							value?.ready === true &&
							value.podUid === sessionExecutor.podUid
						)
							break;
					} catch {
						// The executor binds its gateway after the native exec server.
					}
					assert.ok(Date.now() < deadline, "session executor did not start");
					await delay(200);
				}
			});
			checks.push("session-executor-rejects-file-bridge-input");
		}
		let hostProcess = await probeStep("file-bridge-session-startup", () =>
			launch(session.environment),
		);
		check("session-sandbox-origin-startup", fixture.counts.total === 0);
		const positive = await probeStep("file-bridge-session-round-trip", () =>
			fileTurn("session-positive", session, "ok", sessionConversationId),
		);
		await probeStep("file-bridge-session-round-trip", () =>
			assertRoundTrip(positive),
		);
		check(
			"session-sandbox-attachment-read",
			positive.delta.exchangeRead === 1 &&
				positive.delta.contentRead === 1 &&
				model.state.manifestSeen >= 1,
		);
		check(
			"session-sandbox-result-write",
			positive.delta.contentWrite === 1 && positive.delta.complete === 1,
		);
		// The fixture compares the exact derived value; the transport token, the
		// deployment token or another Sandbox's value would have been a violation.
		check(
			"session-sandbox-derived-token-only",
			fixture.violations.length === 0,
		);
		const sessionStop = await probeStep("file-bridge-session-stop", () =>
			hostProcess.stop(),
		);
		// The Agent Workload phase starts only after the whole Session Sandbox,
		// including the executor and its native backend, is proven gone.
		if (executor)
			await probeStep("file-bridge-session-stop", () =>
				processes.settle(executor, {
					name: "session executor",
					signal: "SIGTERM",
					ports: sessionExecutorPorts,
				}),
			);

		// An Agent Workload serves many Conversations; each rejected input uses
		// its own Conversation, so one failure cannot mask the next.
		const workload = assemble("agent-workload");
		hostProcess = await probeStep("file-bridge-agent-startup", () =>
			launch(workload.environment),
		);
		check("agent-workload-origin-startup", true);
		const agentTurn = await probeStep("file-bridge-agent-round-trip", () =>
			fileTurn("agent-positive", workload, "ok"),
		);
		await probeStep("file-bridge-agent-round-trip", () =>
			assertRoundTrip(agentTurn),
		);
		check("agent-workload-attachment-round-trip", true);
		for (const [mode, name, expected] of [
			["exchange-rejected", "exchange-rejection-fails-closed", 0],
			["exchange-redirect", "exchange-redirect-not-followed", 0],
			["content-redirect", "content-redirect-not-followed", 1],
			["content-oversize", "content-size-mismatch-rejected", 1],
			["content-digest", "content-digest-mismatch-rejected", 1],
		]) {
			const turn = await probeStep(`file-bridge-${mode}`, () =>
				fileTurn(`agent-${mode}`, workload, mode),
			);
			await probeStep(`file-bridge-${mode}`, () =>
				assertFailedClosed(turn, { contentRead: expected }),
			);
			check(name, true);
		}
		const agentStop = await probeStep("file-bridge-agent-stop", () =>
			hostProcess.stop(),
		);

		await probeStep("file-bridge-redaction", () => {
			for (const record of outputs)
				for (const secret of fixture.secrets)
					assert.ok(!record.output.includes(secret));
			for (const record of outputs)
				assert.ok(!record.output.includes(hostHeader));
			assert.equal(model.state.unexpected, 0);
			assert.equal(fixture.counts.unexpected, 0);
		});
		check("file-exchange-credentials-redacted", true);
		assert.deepEqual(checks, fileBridgeProbeRequiredChecks(driver));
		return {
			schemaVersion: 1,
			status: "passed",
			capability: "file-bridge-origin",
			driver,
			origin,
			assemblies: ["session-sandbox", "agent-workload"],
			isolation,
			checks,
			exchange: {
				reads: fixture.counts.exchangeRead,
				contentReads: fixture.counts.contentRead,
				results: fixture.counts.exchangeResult,
				contentWrites: fixture.counts.contentWrite,
				completes: fixture.counts.complete,
				violations: fixture.counts.violations,
			},
			localModelRequests: model.state.requests,
			externalModelRequests: 0,
			stopExitCodes: { sessionSandbox: sessionStop, agentWorkload: agentStop },
		};
	} catch (error) {
		onFailureOutput?.(
			outputs.map((record) => record.output),
			{ fixture: fixture.snapshot(), violations: [...fixture.violations] },
			{ ...model.state, turn: undefined },
		);
		throw error;
	} finally {
		processes.killAll();
		await Promise.all([fixture.server, trap, model.server].map(close));
	}
}
