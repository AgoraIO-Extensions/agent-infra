import type {
	CredentialForExecution,
	ProviderCredentialConnector,
	ProviderExecutor,
} from "@agent-infra/connection-core";
import { manhattanExecutorDigest } from "./manhattan-integrity.ts";

const apiOrigin = "https://manhattan-api.agoralab.co";
const refreshOrigin = "https://grafana.bj2.agoralab.co";
const maxResponseBytes = 64 * 1024;
const providerId = "manhattan";
const providerReleaseId = "manhattan-connection-v2";
const readScope = "manhattan.sdk.read";

export const manhattanConnectionCatalog = {
	actions: [
		{
			description: "获取当前通过 HCI OAuth 鉴权的 Manhattan 用户。",
			effect: "READ" as const,
			id: "manhattan.get_current_user@v2",
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
			id: "manhattan.list_sdk_dumps@v2",
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
			id: "manhattan.get_sdk_dump@v2",
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
			id: "manhattan.list_symbols@v2",
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
		personalCredential: "hci-session-cookie",
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
		const credential = parseCredential(encodedCredential);
		const result = await this.request(
			"/api/connection/whoami",
			credential,
			undefined,
			true,
		);
		const identity = result.data;
		const email =
			typeof identity.email === "string"
				? identity.email.trim().toLowerCase()
				: "";
		if (!email || email !== credential.email)
			throw invalidCredential("Manhattan identity is incomplete");
		return {
			accessToken: JSON.stringify({
				email,
				sessionToken: result.sessionToken,
			}),
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
		const credential = parseCredential(input.credential.accessToken);
		if (input.action === "manhattan.get_current_user")
			return (await this.request("/api/connection/whoami", credential)).data;
		if (input.action === "manhattan.list_sdk_dumps")
			return (
				await this.request("/api/connection/sdk/dumps", credential, input.input)
			).data;
		if (input.action === "manhattan.get_sdk_dump")
			return (
				await this.request(
					"/api/connection/sdk/dumps/detail",
					credential,
					input.input,
				)
			).data;
		if (input.action === "manhattan.list_symbols") {
			const query = new URLSearchParams();
			for (const [key, value] of Object.entries(input.input))
				if (value !== undefined) query.set(key, String(value));
			return (
				await this.request(
					`/api/connection/sdk/symbols${query.size ? `?${query}` : ""}`,
					credential,
				)
			).data;
		}
		throw providerError(`Unsupported Manhattan action: ${input.action}`);
	}

	private async request(
		path: string,
		credential: ManhattanCredential,
		body?: Record<string, unknown>,
		allowRefresh = false,
	) {
		let sessionToken = credential.sessionToken;
		let response: Response | undefined;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			response = await this.fetcher(new URL(path, apiOrigin), {
				...(body ? { body: JSON.stringify(body), method: "POST" } : {}),
				headers: {
					accept: "application/json",
					apiKey: this.gatewayApiKey,
					authorization: `Bearer ${parseSession(sessionToken)}`,
					...(body ? { "content-type": "application/json" } : {}),
				},
				redirect: "manual",
			});
			if (response.status !== 401 || attempt > 0 || !allowRefresh) break;
			sessionToken = await this.refreshSession(sessionToken);
		}
		if (!response || response.status === 401 || response.status === 403)
			throw invalidCredential("Manhattan credential was rejected");
		if (response.status >= 300 && response.status < 400)
			throw invalidCredential("Manhattan gateway credential was rejected");
		if (!response.ok)
			throw providerError(
				`Manhattan request failed with HTTP ${response.status}`,
			);
		const text = await boundedResponseText(response);
		try {
			return {
				data: JSON.parse(text) as Record<string, unknown>,
				sessionToken,
			};
		} catch {
			throw providerError("Manhattan returned invalid JSON");
		}
	}

	private async refreshSession(sessionToken: string) {
		const response = await this.fetcher(new URL("/", refreshOrigin), {
			headers: { cookie: `HCIAuthToken=${sessionToken}` },
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
		});
		const refreshed = response.headers
			.get("set-cookie")
			?.match(/HCIAuthToken=([^;]+)/)?.[1];
		if (!response.ok || !refreshed) {
			throw invalidCredential(
				"Manhattan company session requires reconnection",
			);
		}
		parseSession(refreshed);
		return refreshed;
	}
}

type ManhattanCredential = { email: string; sessionToken: string };

function parseCredential(encoded: string): ManhattanCredential {
	try {
		const value = JSON.parse(encoded) as Record<string, unknown>;
		const email =
			typeof value.email === "string" ? value.email.trim().toLowerCase() : "";
		const sessionToken =
			typeof value.sessionToken === "string" ? value.sessionToken : "";
		if (!email || !sessionToken) throw new Error();
		parseSession(sessionToken);
		return { email, sessionToken };
	} catch {
		throw invalidCredential("Manhattan company session is invalid");
	}
}

function parseSession(token: string) {
	try {
		const payload = token.split(".")[1];
		if (!payload) throw new Error();
		const value = JSON.parse(
			Buffer.from(payload, "base64url").toString("utf8"),
		) as Record<string, unknown>;
		const accessToken =
			typeof value.access_token === "string" ? value.access_token : "";
		if (!accessToken) throw new Error();
		return accessToken;
	} catch {
		throw invalidCredential("Manhattan company session is invalid");
	}
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
