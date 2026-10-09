import { createHash } from "node:crypto";
import type {
	ActionDefinition,
	ProviderCredentialConnector,
	ProviderExecutor,
} from "@agent-infra/connection-core";
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

export const staticSpacesConnectionCatalog = {
	actions: specs.map(
		(spec): ActionDefinition => ({
			name: `${providerId}.${spec.name}`,
			id: `${providerId}.${spec.name}@v1`,
			description: spec.description,
			effect: spec.effect,
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
		}),
	),
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
		if (spec.name === "get_current_user") return identity;
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
		const bytes = await boundedBytes(response);
		if (bytes.includes(Buffer.from(input.credential.accessToken)))
			throw new Error("StaticSpaces response contains credential material");
		if (spec.name === "download_file") {
			return {
				contentBase64: bytes.toString("base64"),
				size: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				mimeType:
					response.headers.get("content-type")?.split(";")[0] ??
					"application/octet-stream",
			};
		}
		const result = jsonObject(bytes, input.credential.accessToken);
		validateResult(spec.name, result, payload);
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
) {
	const record = (value: unknown): value is Record<string, unknown> =>
		Boolean(value) && typeof value === "object" && !Array.isArray(value);
	const file = (value: unknown) =>
		record(value) &&
		typeof value.path === "string" &&
		typeof value.url === "string" &&
		Number.isSafeInteger(value.size) &&
		Number(value.size) >= 0;
	const writtenFile = (value: unknown) =>
		file(value) &&
		record(value) &&
		typeof value.sha256 === "string" &&
		/^[a-f0-9]{64}$/.test(value.sha256);
	let valid = !("error" in result);
	if (name === "get_markdown_review") {
		valid &&=
			record(result.document) &&
			typeof result.document.content === "string" &&
			result.document.path === payload.path &&
			typeof result.document.sha256 === "string" &&
			/^[a-f0-9]{64}$/.test(result.document.sha256) &&
			Number.isSafeInteger(result.document.size) &&
			typeof result.document.raw_url === "string" &&
			typeof result.document.review_url === "string" &&
			record(result.comments) &&
			Array.isArray(result.comments.threads);
	} else {
		valid &&=
			result.kind === payload.kind &&
			result.slug ===
				(payload.kind === "user" ? payload.username : payload.slug);
		if (name === "list_files")
			valid &&= Array.isArray(result.files) && result.files.every(file);
		if (name === "upload_html") valid &&= writtenFile(result);
		if (name === "upload_static_package")
			valid &&=
				Array.isArray(result.files_written) &&
				result.files_written.length > 0 &&
				result.files_written.every((path) => typeof path === "string") &&
				typeof result.archive_sha256 === "string" &&
				/^[a-f0-9]{64}$/.test(result.archive_sha256);
		if (name === "publish_space")
			valid &&=
				Array.isArray(result.files_written) &&
				Array.isArray(payload.files) &&
				result.files_written.length === payload.files.length &&
				result.files_written.every(writtenFile) &&
				record(result.acl) &&
				record(result.group ?? result.groups) &&
				Array.isArray(result.memberships) &&
				Array.isArray(result.verification);
	}
	if (!valid) throw new Error("StaticSpaces returned an invalid Action result");
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
