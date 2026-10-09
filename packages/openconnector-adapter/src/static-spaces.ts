import { createHash } from "node:crypto";
import type {
	ActionDefinition,
	ProviderCredentialConnector,
	ProviderExecutor,
} from "@agent-infra/connection-core";
import { type Schema, Validator } from "@cfworker/json-schema";
import { staticSpacesExecutorDigest } from "./static-spaces-integrity.ts";
import { capabilityVerificationMatrix } from "./test-project.ts";

const providerId = "static-spaces";
const providerReleaseId = "static-spaces-connection-v1";
const credentialScope = "static-spaces.personal-api-token";
const maxBytes = 2 * 1024 * 1024;
const maxArchiveBytes = 1024 * 1024;
const maxStringLength = 1024 * 1024;
export const staticSpacesOrigins = {
	api: "https://publish-static-spaces.sh3.agoralab.co",
	identity: "https://auth-static-spaces.sh3.agoralab.co",
} as const;
const stringSchema = { type: "string", minLength: 1, maxLength: 1024 };
const pathSchema = { ...stringSchema, maxLength: 512 };
const targetProperties = {
	kind: { type: "string", enum: ["user", "shared", "public"] },
	slug: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,62}$" },
};
const fileSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		relative_path: pathSchema,
		content: { type: "string", maxLength: maxStringLength },
		content_base64: { type: "string", maxLength: maxStringLength },
	},
	required: ["relative_path"],
	oneOf: [{ required: ["content"] }, { required: ["content_base64"] }],
};

const specs = [
	{
		name: "get_current_user",
		description: "读取所选个人 Authentik Token 的 StaticSpaces 账号。",
		effect: "READ",
		path: "/api/v3/core/users/me/",
		properties: {},
		required: [],
	},
	{
		name: "list_files",
		description: "列出显式指定空间中当前账号可读的文件及原始下载、评审链接。",
		effect: "READ",
		path: "/v1/files",
		properties: { ...targetProperties, prefix: pathSchema },
		required: ["kind"],
	},
	{
		name: "download_file",
		description:
			"下载显式指定空间的单个文件，最多 2 MiB，以 Base64、size 和 SHA-256 返回原始字节。",
		effect: "READ",
		path: "/v1/download-file",
		properties: { ...targetProperties, path: pathSchema },
		required: ["kind", "path"],
	},
	{
		name: "get_markdown_review",
		description:
			"读取 Markdown 原文、当前评审评论和上游 raw_url/review_url；不发表评论。",
		effect: "READ",
		path: "/v1/markdown-review",
		properties: { ...targetProperties, path: pathSchema },
		required: ["kind", "path"],
	},
	{
		name: "publish_space",
		description:
			"发布显式指定的完整空间及文件；首次创建会同时初始化 ACL、组和 shared 门户卡片。public 允许所有登录用户读取。部分失败或响应丢失结果待确认，不自动重试。",
		effect: "WRITE",
		path: "/v1/publish-space",
		properties: {
			...targetProperties,
			overwrite: { type: "boolean" },
			files: { type: "array", minItems: 1, maxItems: 100, items: fileSchema },
		},
		required: ["kind", "files"],
	},
	{
		name: "upload_html",
		description:
			"向已初始化的显式空间上传 HTML，默认不覆盖；首次空间发布使用 publish_space。public 允许所有登录用户读取。",
		effect: "WRITE",
		path: "/v1/upload-html",
		properties: {
			...targetProperties,
			relative_path: pathSchema,
			html: { type: "string", maxLength: maxStringLength },
			overwrite: { type: "boolean" },
		},
		required: ["kind", "relative_path", "html"],
	},
	{
		name: "upload_static_package",
		description:
			"向已初始化的显式空间上传不超过 1 MiB 的 zip/tgz/tar.gz 归档；上游校验归档路径与文件类型，默认不覆盖。public 允许所有登录用户读取。",
		effect: "WRITE",
		path: "/v1/upload-static-package",
		properties: {
			...targetProperties,
			archive_format: { type: "string", enum: ["zip", "tgz", "tar.gz"] },
			archive_base64: { type: "string", minLength: 1, maxLength: 1398104 },
			overwrite: { type: "boolean" },
		},
		required: ["kind", "archive_format", "archive_base64"],
	},
] as const;

// Project approved response fields, then apply the pinned JSON Schema before persistence.
const text = { type: "string", minLength: 1, maxLength: 8192 } satisfies Schema;
const hash = { type: "string", pattern: "^[a-f0-9]{64}$" } satisfies Schema;
const number = { type: "integer", minimum: 0 } satisfies Schema;
const nullableText = {
	type: ["string", "null"],
	maxLength: 128,
} satisfies Schema;
const object = (
	properties: Record<string, Schema>,
	required = Object.keys(properties),
): Schema => ({
	type: "object",
	additionalProperties: false,
	properties,
	required,
});
const array = (items: Schema): Schema => ({
	type: "array",
	maxItems: 10000,
	items,
});
const scopeFields: Record<string, Schema> = {
	space: text,
	kind: { enum: ["user", "shared", "public"] },
	slug: text,
	path_prefix: text,
	url_prefix: text,
};
const fileFields: Record<string, Schema> = {
	path: text,
	url: text,
	size: number,
	sha256: hash,
	updated_at: text,
	raw_url: text,
	review_url: text,
	subscription_url: text,
};
const fileReceipt = object({ ...scopeFields, ...fileFields }, [
	"kind",
	"slug",
	"path",
	"url",
	"size",
	"sha256",
]);
const groupReceipt = object({
	created: { type: "boolean" },
	group: object(
		{
			pk: { type: ["string", "integer"] },
			name: text,
			is_superuser: { const: false },
		},
		["pk", "name", "is_superuser"],
	),
});
const membership = object({
	username: text,
	group: text,
	member: { type: "boolean" },
});
const verification = object(
	{
		username: text,
		path: text,
		allowed: { type: "boolean" },
		status: { type: "integer", minimum: 100, maximum: 599 },
		matched_rule: { type: ["string", "integer", "null"] },
	},
	["username", "path", "allowed", "status"],
);
const acl = object(
	{
		id: { type: ["integer", "string"] },
		prefix: text,
		groups: {
			type: ["string", "array"],
			items: text,
			maxLength: 8192,
			maxItems: 100,
		},
		enabled: { enum: [true, false, 0, 1] },
		created_at: text,
	},
	["prefix", "groups", "enabled"],
);
const application = object({
	created: { type: "boolean" },
	application: object(
		{
			pk: { type: ["string", "integer"] },
			name: text,
			slug: text,
			launch_url: text,
		},
		["pk", "slug", "launch_url"],
	),
	binding: object(
		{
			pk: { type: ["string", "integer"] },
			target: { type: ["string", "integer"] },
			group: { type: ["string", "integer"] },
			enabled: { type: "boolean" },
			negate: { type: "boolean" },
		},
		["target", "group", "enabled", "negate"],
	),
});
const reviewUrls = {
	type: "object",
	additionalProperties: text,
} satisfies Schema;
const comment = object({
	id: text,
	author_email: text,
	body: { type: "string", maxLength: 10000 },
	created_at: text,
	edited_at: nullableText,
	deleted_at: nullableText,
	can_edit: { type: "boolean" },
	can_delete: { type: "boolean" },
});
const anchor = {
	...object(
		{
			type: { enum: ["document", "selection"] },
			document_sha256: hash,
			strategy: { const: "source-lines" },
			start_line: { type: "integer", minimum: 1 },
			end_line: { type: "integer", minimum: 1 },
			block_index: number,
			block_type: {
				enum: [
					"heading",
					"paragraph",
					"list-item",
					"table-cell",
					"blockquote",
					"code",
				],
			},
			block_sha256: hash,
			start_offset: number,
			end_offset: number,
			quote: { type: "string", minLength: 1, maxLength: 4000 },
			prefix: { type: "string", maxLength: 128 },
			suffix: { type: "string", maxLength: 128 },
		},
		["type", "document_sha256"],
	),
	oneOf: [
		{ properties: { type: { const: "document" } } },
		{
			properties: { type: { const: "selection" } },
			required: ["quote"],
			anyOf: [
				{ required: ["strategy", "start_line", "end_line"] },
				{
					required: [
						"block_index",
						"block_type",
						"block_sha256",
						"start_offset",
						"end_offset",
						"prefix",
						"suffix",
					],
				},
			],
		},
	],
} satisfies Schema;
const outputSchemas: Record<(typeof specs)[number]["name"], Schema> = {
	get_current_user: object({
		id: { type: "string", pattern: "^[1-9][0-9]*$" },
		username: text,
	}),
	list_files: object(
		{
			...scopeFields,
			files: array(object(fileFields, ["path", "url", "size", "updated_at"])),
		},
		["kind", "slug", "files"],
	),
	download_file: object({
		contentBase64: { type: "string", maxLength: 2796204 },
		size: { ...number, maximum: maxBytes },
		sha256: hash,
		mimeType: text,
	}),
	get_markdown_review: object({
		document: object(
			{
				kind: { enum: ["user", "shared", "public"] },
				slug: text,
				username: text,
				path: text,
				content: { type: "string", maxLength: maxBytes },
				size: number,
				sha256: hash,
				raw_url: text,
				review_url: text,
			},
			["kind", "path", "content", "size", "sha256", "raw_url", "review_url"],
		),
		comments: object({
			etag: text,
			updated_at: nullableText,
			thread_count: number,
			threads: array(object({ id: text, anchor, comments: array(comment) })),
		}),
	}),
	publish_space: object(
		{
			...scopeFields,
			files_written: array(fileReceipt),
			acl,
			group: groupReceipt,
			groups: object(
				{ owners: groupReceipt, managers: groupReceipt, viewers: groupReceipt },
				["owners", "managers"],
			),
			application,
			memberships: array(membership),
			verification: array(verification),
			review_urls: reviewUrls,
		},
		[
			"kind",
			"slug",
			"path_prefix",
			"url_prefix",
			"files_written",
			"acl",
			"memberships",
			"verification",
			"review_urls",
		],
	),
	upload_html: fileReceipt,
	upload_static_package: object(
		{
			...scopeFields,
			files_written: array(text),
			archive_sha256: hash,
			review_urls: reviewUrls,
		},
		["kind", "slug", "files_written", "archive_sha256", "review_urls"],
	),
};
const outputValidators = new Map(
	Object.entries(outputSchemas).map(([name, schema]) => [
		name,
		new Validator(schema, "2020-12", false),
	]),
);

function project(value: unknown, schema: Schema): unknown {
	if (Array.isArray(value) && schema.items && !Array.isArray(schema.items))
		return value.map((item) => project(item, schema.items as Schema));
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const fields = value as Record<string, unknown>;
		if (schema.properties)
			return Object.fromEntries(
				Object.entries(schema.properties)
					.filter(([name]) => Object.hasOwn(fields, name))
					.map(([name, child]) => [
						name,
						typeof child === "object"
							? project(fields[name], child)
							: fields[name],
					]),
			);
		if (
			schema.additionalProperties &&
			typeof schema.additionalProperties === "object"
		)
			return Object.fromEntries(
				Object.entries(fields).map(([name, child]) => [
					name,
					project(child, schema.additionalProperties as Schema),
				]),
			);
	}
	return value;
}

function validatedOutput(
	name: (typeof specs)[number]["name"],
	value: Record<string, unknown>,
) {
	if ("error" in value)
		throw new Error("StaticSpaces returned an invalid Action result");
	const result = project(value, outputSchemas[name]);
	if (!outputValidators.get(name)?.validate(result).valid)
		throw new Error("StaticSpaces returned an invalid Action result");
	return result as Record<string, unknown>;
}

export const staticSpacesConnectionCatalog = {
	actions: specs.map((spec): ActionDefinition & { outputSchema: Schema } => ({
		name: `${providerId}.${spec.name}`,
		id: `${providerId}.${spec.name}@v1`,
		description: spec.description,
		effect: spec.effect,
		outputSchema: outputSchemas[spec.name],
		requiredScopes: [credentialScope],
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: spec.properties,
			required: [...spec.required],
			...(spec.name === "get_current_user"
				? {}
				: {
						oneOf: [
							{
								properties: { kind: { const: "user" } },
								not: { required: ["slug"] },
							},
							{
								properties: { kind: { enum: ["shared", "public"] } },
								required: ["slug"],
							},
						],
					}),
		},
	})),
	authProfile: {
		credential: "personal-authentik-api-token",
		header: "Authorization",
		scheme: "Bearer",
	},
	deploymentProfile: {
		apiOrigin: staticSpacesOrigins.api,
		identityOrigin: staticSpacesOrigins.identity,
		identity:
			"GET /api/v3/core/users/me/ stable pk and username; non-superuser",
		deployment: "company-managed",
		product: "StaticSpaces",
	},
	executorDigest: staticSpacesExecutorDigest,
	provider: providerId,
	providerReleaseId,
	sourceCommit: "4b9afc47750ae2a8e73f01345745dbe3262d9e1e",
} as const;

// HLD G-02/13.4: add reviewed real-account evidence before this release is published.
// No deployment flag or unit fixture can grant publication readiness.
export const staticSpacesVerificationMatrix = capabilityVerificationMatrix(
	staticSpacesConnectionCatalog,
	[],
);

export class StaticSpacesAdapter
	implements ProviderCredentialConnector, ProviderExecutor
{
	readonly providerId = providerId;
	readonly providerReleaseId = providerReleaseId;
	private readonly fetcher: typeof fetch;
	constructor(fetcher: typeof fetch) {
		this.fetcher = fetcher;
	}

	async validateCredential(accessToken: string) {
		const identity = await this.identity(accessToken);
		return {
			accessToken,
			displayName: identity.username,
			externalAccount: identity.id,
			grantedScopes: [credentialScope],
			providerId,
			providerReleaseId,
		};
	}

	async execute(
		input: Parameters<ProviderExecutor["execute"]>[0],
	): Promise<Record<string, unknown>> {
		const spec = specs.find(
			(item) => input.action === `${providerId}.${item.name}`,
		);
		if (
			!spec ||
			input.providerId !== providerId ||
			input.providerReleaseId !== providerReleaseId ||
			input.actionVersionId !== `${input.action}@v1`
		) {
			throw invalidInput();
		}
		const payload = this.payload(spec, input.input);
		const identity = await this.identity(input.credential.accessToken);
		if (spec.name === "get_current_user")
			return validatedOutput(spec.name, identity);
		if (payload.kind === "user") payload.username = identity.username;
		const url = new URL(spec.path, staticSpacesOrigins.api);
		if (spec.effect === "READ") {
			for (const [key, value] of Object.entries(payload))
				url.searchParams.set(key, String(value));
		}
		const response = await this.request(
			url,
			input.credential.accessToken,
			spec.effect === "WRITE" ? payload : undefined,
		);
		requireResponseType(response, spec.name === "download_file");
		const bytes = await boundedBytes(response);
		if (bytes.includes(Buffer.from(input.credential.accessToken)))
			throw new Error("StaticSpaces response contains credential material");
		if (spec.name === "download_file") {
			return validatedOutput(spec.name, {
				contentBase64: bytes.toString("base64"),
				size: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				mimeType:
					response.headers.get("content-type")?.split(";")[0] ??
					"application/octet-stream",
			});
		}
		const result = validatedOutput(
			spec.name,
			jsonObject(bytes, input.credential.accessToken),
		);
		validateResult(spec.name, result, payload, identity.username);
		return result;
	}

	private payload(
		spec: (typeof specs)[number],
		input: Record<string, unknown>,
	) {
		if (
			!input ||
			typeof input !== "object" ||
			Array.isArray(input) ||
			Object.keys(input).some((key) => !Object.hasOwn(spec.properties, key)) ||
			spec.required.some((key) => !(key in input))
		)
			throw invalidInput();
		const payload = { ...input };
		if (spec.name === "get_current_user") return payload;
		if (
			typeof input.kind !== "string" ||
			!["user", "shared", "public"].includes(input.kind) ||
			(input.kind === "user"
				? "slug" in input
				: typeof input.slug !== "string" ||
					!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(input.slug))
		)
			throw invalidInput();
		if ("overwrite" in input && typeof input.overwrite !== "boolean")
			throw invalidInput();
		for (const field of ["path", "relative_path", "prefix"]) {
			if (field in input) safePath(input[field], field === "prefix");
		}
		if (
			spec.name === "get_markdown_review" &&
			!/\.(md|markdown)$/i.test(String(input.path))
		)
			throw invalidInput();
		if (spec.name === "upload_html") {
			if (
				!/\.html?$/i.test(String(input.relative_path)) ||
				typeof input.html !== "string" ||
				input.html.length > maxStringLength
			)
				throw invalidInput();
		}
		if (spec.name === "upload_static_package") {
			if (
				!input.archive_base64 ||
				!["zip", "tgz", "tar.gz"].includes(String(input.archive_format))
			)
				throw invalidInput();
			base64Bytes(input.archive_base64, maxArchiveBytes);
		}
		if (spec.name === "publish_space") {
			if (
				!Array.isArray(input.files) ||
				input.files.length < 1 ||
				input.files.length > 100
			)
				throw invalidInput();
			const paths = new Set<string>();
			for (const file of input.files) {
				if (
					!file ||
					typeof file !== "object" ||
					Array.isArray(file) ||
					Object.keys(file).some(
						(key) =>
							!["relative_path", "content", "content_base64"].includes(key),
					) ||
					"content" in file === "content_base64" in file
				)
					throw invalidInput();
				safePath(file.relative_path);
				if (paths.has(file.relative_path)) throw invalidInput();
				paths.add(file.relative_path);
				if ("content" in file) {
					if (
						typeof file.content !== "string" ||
						file.content.length > maxStringLength
					)
						throw invalidInput();
				} else base64Bytes(file.content_base64, maxArchiveBytes);
			}
		}
		if (Buffer.byteLength(JSON.stringify(payload)) > maxBytes)
			throw invalidInput();
		if (spec.effect === "WRITE" && !("overwrite" in payload))
			payload.overwrite = false;
		return payload;
	}

	private async identity(accessToken: string) {
		if (!accessToken || accessToken.length > 8192 || /[\r\n]/.test(accessToken))
			throw invalidCredential();
		let response: Response;
		try {
			response = await this.request(
				new URL("/api/v3/core/users/me/", staticSpacesOrigins.identity),
				accessToken,
			);
		} catch (error) {
			// Match Publish API principal_from_bearer: Authentik me 401/403 means an invalid token.
			// Content API 403 still means denied space permissions, not invalid credentials.
			if (
				error &&
				typeof error === "object" &&
				"providerStatus" in error &&
				error.providerStatus === 403
			)
				throw invalidCredential();
			throw error;
		}
		requireResponseType(response);
		const envelope = jsonObject(await boundedBytes(response), accessToken);
		const user = (envelope.user ?? envelope) as Record<string, unknown>;
		if (
			!user ||
			typeof user !== "object" ||
			user.is_superuser !== false ||
			!(
				(typeof user.pk === "string" && /^[1-9]\d*$/.test(user.pk)) ||
				(Number.isSafeInteger(user.pk) && Number(user.pk) > 0)
			) ||
			typeof user.username !== "string" ||
			!/^[A-Za-z0-9@][A-Za-z0-9._@+-]{0,254}$/.test(user.username) ||
			user.is_active !== true
		)
			throw invalidCredential();
		return { id: String(user.pk), username: user.username };
	}

	private async request(
		url: URL,
		accessToken: string,
		payload?: Record<string, unknown>,
	) {
		const body = payload ? JSON.stringify(payload) : undefined;
		if (body && Buffer.byteLength(body) > maxBytes) throw invalidInput();
		let response: Response;
		try {
			response = await this.fetcher(url, {
				method: payload ? "POST" : "GET",
				headers: {
					accept: "application/json",
					"accept-encoding": "identity",
					authorization: `Bearer ${accessToken}`,
					...(payload ? { "content-type": "application/json" } : {}),
				},
				body,
				redirect: "manual",
				signal: AbortSignal.timeout(30_000),
			});
		} catch {
			throw Object.assign(new Error("StaticSpaces transport failed"), {
				providerUnavailable: true,
				submissionUncertain: Boolean(payload),
			});
		}
		if (!response.ok) {
			// Publish can modify several resources before reporting even a 4xx error.
			// Preserve unknown outcomes rather than treating a partial write as rejected.
			await response.body?.cancel();
			throw Object.assign(new Error("StaticSpaces request rejected"), {
				providerStatus: response.status,
				providerCredentialInvalid: response.status === 401,
				...(response.status === 401 || response.status === 403
					? { providerCode: "authorization_failed" }
					: {}),
				submissionUncertain: Boolean(payload),
			});
		}
		return response;
	}
}

function requireResponseType(response: Response, binary = false) {
	const encoding = response.headers.get("content-encoding");
	const type = response.headers.get("content-type") ?? "";
	const mime = type.split(";")[0]?.trim() ?? "";
	const charset = type.match(/charset\s*=\s*"?([^";\s]+)/i)?.[1];
	if (
		(encoding && encoding.toLowerCase() !== "identity") ||
		!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mime) ||
		(!binary &&
			(!/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/i.test(mime) ||
				(charset && !/^utf-?8$/i.test(charset))))
	) {
		void response.body?.cancel().catch(() => {});
		throw new Error("StaticSpaces response type or encoding is invalid");
	}
}

function safePath(value: unknown, prefix = false) {
	if (
		typeof value !== "string" ||
		value.length > 512 ||
		!value ||
		value.includes("\\") ||
		[...value].some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		) ||
		value
			.split("/")
			.some(
				(part) =>
					!part || part === "." || part === ".." || part === "__staticspaces",
			)
	)
		throw invalidInput();
	if (
		!prefix &&
		!/\.(html?|css|js|json|txt|md|markdown|pdf|csv|xml|ya?ml|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|eot|mp3|wav|ogg|mp4|webm)$/i.test(
			value,
		)
	)
		throw invalidInput();
}

function base64Bytes(value: unknown, limit: number) {
	if (
		typeof value !== "string" ||
		value.length > Math.ceil(limit / 3) * 4 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(value)
	)
		throw invalidInput();
	const bytes = Buffer.from(value, "base64");
	if (bytes.length > limit || bytes.toString("base64") !== value)
		throw invalidInput();
	return bytes;
}

async function boundedBytes(response: Response) {
	if (Number(response.headers.get("content-length")) > maxBytes) {
		await response.body?.cancel();
		throw new Error("StaticSpaces response is too large");
	}
	const reader = response.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (reader) {
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > maxBytes)
					throw new Error("StaticSpaces response is too large");
				chunks.push(value);
			}
		} catch {
			await reader.cancel().catch(() => {});
			throw new Error(
				"StaticSpaces response could not be read within its limit",
			);
		} finally {
			reader.releaseLock();
		}
	}
	return Buffer.concat(chunks);
}

function jsonObject(
	bytes: Buffer,
	accessToken: string,
): Record<string, unknown> {
	// Do not forward an upstream credential echo, even in a successful JSON body.
	if (bytes.includes(Buffer.from(accessToken)))
		throw new Error("StaticSpaces response contains credential material");
	try {
		const value: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		);
		if (
			value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			!JSON.stringify(value).includes(accessToken)
		)
			return value as Record<string, unknown>;
	} catch {}
	throw new Error("StaticSpaces returned invalid JSON");
}

function validateResult(
	name: string,
	result: Record<string, unknown>,
	payload: Record<string, unknown>,
	username: string,
) {
	if (name === "get_markdown_review") {
		const document = result.document as Record<string, unknown>;
		if (
			document.path !== payload.path ||
			document.kind !== payload.kind ||
			(payload.kind === "user"
				? document.username !== payload.username
				: document.slug !== payload.slug)
		)
			throw new Error("StaticSpaces document target does not match");
	} else if (
		result.kind !== payload.kind ||
		result.slug !== (payload.kind === "user" ? payload.username : payload.slug)
	)
		throw new Error("StaticSpaces space target does not match");
	if (name === "publish_space") validatePublication(result, payload, username);
}

function validatePublication(
	result: Record<string, unknown>,
	payload: Record<string, unknown>,
	username: string,
) {
	const slug = String(
		payload.kind === "user" ? payload.username : payload.slug,
	);
	const kind = String(payload.kind);
	const prefix = `/spaces/${kind === "user" ? "users" : kind}/${slug}/`;
	const receipts = result.files_written as Array<Record<string, unknown>>;
	const groups = (
		kind === "user" ? { viewers: result.group } : result.groups
	) as Record<
		string,
		{ created: boolean; group: { pk: string | number; name: string } }
	>;
	const roles =
		kind === "user"
			? ["viewers"]
			: kind === "shared"
				? ["owners", "managers", "viewers"]
				: ["owners", "managers"];
	const groupNames = roles.map(
		(role) =>
			`static-spaces-${kind === "user" ? "users" : kind}-${slug}-${role}`,
	);
	const aclResult = result.acl as Record<string, unknown>;
	const aclGroups =
		typeof aclResult.groups === "string"
			? aclResult.groups
					.split(",")
					.map((value) => value.trim())
					.filter(Boolean)
			: (aclResult.groups as string[]);
	const expectedAclGroups =
		kind === "public" ? [] : [groupNames[groupNames.length - 1]];
	let valid =
		result.path_prefix === prefix &&
		matchesUrl(result.url_prefix, prefix) &&
		aclResult.prefix === prefix &&
		(aclResult.enabled === true || aclResult.enabled === 1) &&
		JSON.stringify(aclGroups) === JSON.stringify(expectedAclGroups) &&
		roles.every(
			(role, index) => groups?.[role]?.group.name === groupNames[index],
		);
	const files = payload.files as Array<Record<string, unknown>>;
	const byPath = new Map(receipts.map((file) => [file.path, file]));
	valid &&= byPath.size === files.length;
	for (const file of files) {
		const path = prefix + String(file.relative_path);
		const receipt = byPath.get(path);
		const bytes =
			typeof file.content === "string"
				? Buffer.from(file.content)
				: base64Bytes(file.content_base64, maxArchiveBytes);
		valid &&=
			Boolean(receipt) &&
			receipt?.size === bytes.length &&
			receipt?.sha256 === createHash("sha256").update(bytes).digest("hex") &&
			matchesUrl(receipt?.url, path);
		if (/\.(md|markdown)$/i.test(String(file.relative_path)))
			valid &&=
				matchesUrl(receipt?.raw_url, path) &&
				matchesUrl(receipt?.review_url, path, true) &&
				(result.review_urls as Record<string, unknown>)?.[
					String(file.relative_path)
				] === receipt?.review_url;
	}
	if (kind === "shared") {
		const appReceipt = result.application as
			| {
					application?: Record<string, unknown>;
					binding?: Record<string, unknown>;
			  }
			| undefined;
		let normalized =
			slug.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "space";
		if (normalized !== slug)
			normalized += `-${createHash("sha256").update(slug).digest("hex").slice(0, 8)}`;
		valid &&=
			Boolean(appReceipt) &&
			appReceipt?.application?.slug === `static-spaces-shared-${normalized}` &&
			matchesUrl(appReceipt?.application?.launch_url, prefix) &&
			appReceipt?.binding?.enabled === true &&
			appReceipt?.binding?.negate === false &&
			String(appReceipt?.binding?.target) ===
				String(appReceipt?.application?.pk) &&
			String(appReceipt?.binding?.group) === String(groups.viewers?.group.pk);
	}
	const memberships = result.memberships as Array<Record<string, unknown>>;
	const checks = result.verification as Array<Record<string, unknown>>;
	const existingManagedUpdate =
		kind !== "user" &&
		memberships.length === 0 &&
		roles.every((role) => groups?.[role]?.created === false);
	valid &&= checks.every(
		(check) =>
			check.allowed === true &&
			check.status === 200 &&
			check.path === prefix &&
			check.username === username,
	);
	if (!existingManagedUpdate) {
		valid &&=
			groupNames.every((group) =>
				memberships.some(
					(member) =>
						member.username === username &&
						member.group === group &&
						member.member === true,
				),
			) && checks.some((check) => check.username === username);
	}
	if (!valid)
		throw new Error("StaticSpaces complete publication could not be verified");
}

function matchesUrl(value: unknown, path: string, review = false) {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return (
			url.origin === "https://static-spaces.sh3.agoralab.co" &&
			!url.username &&
			!url.password &&
			!url.hash &&
			decodeURIComponent(url.pathname) === path &&
			(review
				? url.searchParams.get("view") === "review"
				: !url.searchParams.has("view"))
		);
	} catch {
		return false;
	}
}

function invalidInput() {
	return Object.assign(new Error("StaticSpaces input is invalid"), {
		providerCode: "invalid_input",
		providerStatus: 400,
	});
}
function invalidCredential() {
	return Object.assign(
		new Error("StaticSpaces requires an active personal Authentik API Token"),
		{
			providerCredentialInvalid: true,
			providerCode: "authorization_failed",
			providerStatus: 401,
		},
	);
}
