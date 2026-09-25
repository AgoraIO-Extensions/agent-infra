import type {
	CredentialForExecution,
	ProviderCredentialConnector,
	ProviderExecutor,
} from "@agent-infra/connection-core";
import { manhattanExecutorDigest } from "./manhattan-integrity.ts";

const apiOrigin = "https://manhattan-api.agoralab.co";
const maxResponseBytes = 64 * 1024;
const providerId = "manhattan";
const providerReleaseId = "manhattan-connection-v3";
const readScope = "manhattan.sdk.read";

export const manhattanConnectionCatalog = {
	actions: [
		{
			description: "获取当前通过 HCI OAuth 鉴权的 Manhattan 用户。",
			effect: "READ" as const,
			id: "manhattan.get_current_user@v3",
			inputSchema: {
				additionalProperties: false,
				properties: {},
				required: [],
				type: "object",
			},
			name: "manhattan.get_current_user",
			requiredScopes: [readScope],
		},
		{
			description: "查询 Manhattan SDK dump 历史。",
			effect: "READ" as const,
			id: "manhattan.list_sdk_dumps@v3",
			inputSchema: {
				additionalProperties: false,
				properties: {
					architecture: { minimum: 0, type: "integer" },
					buildNumber: { minimum: 0, type: "integer" },
					current: { minimum: 0, type: "integer" },
					id: { minimum: 1, type: "integer" },
					name: { type: "string" },
					pageSize: { maximum: 100, minimum: 1, type: "integer" },
					platform: { minimum: 0, type: "integer" },
					status: { minimum: 0, type: "integer" },
				},
				required: [],
				type: "object",
			},
			name: "manhattan.list_sdk_dumps",
			requiredScopes: [readScope],
		},
		{
			description: "获取一条 Manhattan SDK dump 详情。",
			effect: "READ" as const,
			id: "manhattan.get_sdk_dump@v3",
			inputSchema: {
				additionalProperties: false,
				properties: { id: { minimum: 1, type: "integer" } },
				required: ["id"],
				type: "object",
			},
			name: "manhattan.get_sdk_dump",
			requiredScopes: [readScope],
		},
		{
			description: "分页查询 Manhattan Symbol。",
			effect: "READ" as const,
			id: "manhattan.list_symbols@v3",
			inputSchema: {
				additionalProperties: false,
				properties: {
					buildNumber: { minimum: 0, type: "integer" },
					current: { minimum: 0, type: "integer" },
					pageSize: { maximum: 100, minimum: 1, type: "integer" },
				},
				required: [],
				type: "object",
			},
			name: "manhattan.list_symbols",
			requiredScopes: [readScope],
		},
	],
	authProfile: {
		gatewayHeader: "apiKey",
		personalCredential: "login-exchanged-bearer-token",
	},
	deploymentProfile: {
		apiOrigin,
		deployment: "company-managed",
		identity: "GET /api/connection/whoami",
		product: "Manhattan",
	},
	executorDigest: manhattanExecutorDigest,
	provider: providerId,
	providerReleaseId,
	sourceCommit: "connection-native",
} as const;

export class ManhattanAdapter
	implements ProviderCredentialConnector, ProviderExecutor
{
	readonly providerId = providerId;
	readonly providerReleaseId = providerReleaseId;
	private readonly fetcher: typeof fetch;
	private readonly gatewayApiKey: string;

	constructor(fetcher: typeof fetch, gatewayApiKey: string) {
		this.fetcher = fetcher;
		this.gatewayApiKey = gatewayApiKey;
	}

	async validateCredential(encodedCredential: string) {
		const { password, username } = parseLoginCredential(encodedCredential);
		const accessToken = await this.login(username, password);
		const identity = await this.request("/api/connection/whoami", accessToken);
		const email =
			typeof identity.email === "string"
				? identity.email.trim().toLowerCase()
				: "";
		if (!email) throw invalidCredential("Manhattan identity is incomplete");
		return {
			accessToken,
			displayName:
				typeof identity.displayName === "string" ? identity.displayName : email,
			externalAccount: email,
			grantedScopes: [readScope],
			providerId,
			providerReleaseId,
		};
	}

	async execute(input: {
		action: string;
		credential: CredentialForExecution;
		input: Record<string, unknown>;
	}) {
		const accessToken = input.credential.accessToken;
		if (!accessToken) throw invalidCredential("Manhattan token is required");
		if (input.action === "manhattan.get_current_user")
			return this.request("/api/connection/whoami", accessToken);
		if (input.action === "manhattan.list_sdk_dumps")
			return this.request(
				"/api/connection/sdk/dumps",
				accessToken,
				input.input,
			);
		if (input.action === "manhattan.get_sdk_dump")
			return this.request(
				"/api/connection/sdk/dumps/detail",
				accessToken,
				input.input,
			);
		if (input.action === "manhattan.list_symbols") {
			const query = new URLSearchParams();
			for (const [key, value] of Object.entries(input.input))
				if (value !== undefined) query.set(key, String(value));
			return this.request(
				`/api/connection/sdk/symbols${query.size ? `?${query}` : ""}`,
				accessToken,
			);
		}
		throw providerError(`Unsupported Manhattan action: ${input.action}`);
	}

	private async request(
		path: string,
		accessToken: string,
		body?: Record<string, unknown>,
	) {
		const response = await this.fetcher(new URL(path, apiOrigin), {
			...(body ? { body: JSON.stringify(body), method: "POST" } : {}),
			headers: {
				accept: "application/json",
				apiKey: this.gatewayApiKey,
				authorization: `Bearer ${accessToken}`,
				...(body ? { "content-type": "application/json" } : {}),
			},
			redirect: "manual",
		});
		if (response.status === 401 || response.status === 403)
			throw invalidCredential("Manhattan credential was rejected");
		if (response.status >= 300 && response.status < 400)
			throw invalidCredential("Manhattan gateway credential was rejected");
		if (!response.ok)
			throw providerError(
				`Manhattan request failed with HTTP ${response.status}`,
			);
		const text = await boundedResponseText(response);
		try {
			return JSON.parse(text) as Record<string, unknown>;
		} catch {
			throw providerError("Manhattan returned invalid JSON");
		}
	}

	private async login(username: string, password: string) {
		const data = await this.request("/api/connection/login", "", {
			password,
			username,
		});
		const payload =
			data.data && typeof data.data === "object"
				? (data.data as Record<string, unknown>)
				: data;
		const token = typeof payload.token === "string" ? payload.token : "";
		if (!token)
			throw invalidCredential("Manhattan login did not return a token");
		return token;
	}
}

function parseLoginCredential(encoded: string) {
	try {
		const value = JSON.parse(encoded) as Record<string, unknown>;
		const username =
			typeof value.username === "string" ? value.username.trim() : "";
		const password = typeof value.password === "string" ? value.password : "";
		if (username && password) return { password, username };
	} catch {}
	throw invalidCredential("Manhattan username and password are required");
}

async function boundedResponseText(response: Response) {
	const declaredLength = Number(response.headers.get("content-length") ?? 0);
	if (declaredLength > maxResponseBytes)
		throw providerError("Manhattan response is too large");
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxResponseBytes) {
			await reader.cancel();
			throw providerError("Manhattan response is too large");
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function invalidCredential(message: string) {
	return Object.assign(new Error(message), { providerCredentialInvalid: true });
}

function providerError(message: string) {
	return Object.assign(new Error(message), { providerFailure: true });
}
