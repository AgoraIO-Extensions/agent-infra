import type {
	CredentialForExecution,
	GitHubOAuthAuthorization,
	GitHubOAuthIdentity,
	GitHubOAuthProvider,
	ProviderCredentialConnector,
	ProviderExecutor,
} from "@agent-infra/connection-core";
import { manhattanExecutorDigest } from "./manhattan-integrity.ts";

const apiOrigin = "https://manhattan-api.agoralab.co";
const maxResponseBytes = 64 * 1024;
const providerId = "manhattan";
const providerReleaseId = "manhattan-connection-v4";
const readScope = "manhattan.sdk.read";

export const manhattanConnectionCatalog = {
	actions: [
		{
			description: "获取当前通过 HCI OAuth 鉴权的 Manhattan 用户。",
			effect: "READ" as const,
			id: "manhattan.get_current_user@v4",
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
			id: "manhattan.list_sdk_dumps@v4",
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
			id: "manhattan.get_sdk_dump@v4",
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
			id: "manhattan.list_symbols@v4",
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
		personalCredential: "authorization-code-bearer-token",
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
		const identity = await this.request(
			"/api/connection/whoami",
			encodedCredential,
		);
		const email =
			typeof identity.email === "string"
				? identity.email.trim().toLowerCase()
				: "";
		if (!email) throw invalidCredential("Manhattan identity is incomplete");
		return {
			accessToken: encodedCredential,
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
		if (response.status === 401)
			throw invalidCredential("Manhattan credential was rejected");
		if (response.status === 403)
			throw Object.assign(new Error("Manhattan account is not authorized"), {
				providerAuthorizationDenied: true,
			});
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
}

export class ManhattanOAuthAdapter implements GitHubOAuthProvider {
	private readonly identity: ManhattanAdapter;
	private readonly fetcher: typeof fetch;
	private readonly clientId: string;
	private readonly clientSecret: string;

	constructor(
		identity: ManhattanAdapter,
		fetcher: typeof fetch,
		clientId: string,
		clientSecret: string,
	) {
		this.identity = identity;
		this.fetcher = fetcher;
		this.clientId = clientId;
		this.clientSecret = clientSecret;
	}

	getAuthorizationUrl(
		input: GitHubOAuthAuthorization & { redirectUri: string },
	) {
		// The legacy HCI confidential-client endpoint uses client authentication, not PKCE.
		const url = new URL("https://oauth.agoralab.co/oauth/authorize");
		url.searchParams.set("response_type", "code");
		url.searchParams.set("client_id", this.clientId);
		url.searchParams.set("redirect_uri", input.redirectUri);
		url.searchParams.set("state", input.state);
		return url.toString();
	}

	async exchangeCode(input: {
		code: string;
		codeVerifier: string;
		redirectUri: string;
	}): Promise<GitHubOAuthIdentity> {
		const token = await this.token({
			grant_type: "authorization_code",
			code: input.code,
			redirect_uri: input.redirectUri,
		});
		if (!token.refresh_token)
			throw providerError("Manhattan OAuth did not return a refresh token");
		return this.profile({ ...token, refresh_token: token.refresh_token });
	}

	async refresh(refreshToken: string): Promise<GitHubOAuthIdentity> {
		const token = await this.token({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		});
		return this.profile({
			...token,
			refresh_token: token.refresh_token ?? refreshToken,
		});
	}

	private async token(fields: Record<string, string>) {
		const response = await this.fetcher(
			"https://oauth.agoralab.co/oauth/token",
			{
				body: new URLSearchParams(fields),
				headers: {
					accept: "application/json",
					authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
					"content-type": "application/x-www-form-urlencoded",
				},
				method: "POST",
				redirect: "manual",
			},
		);
		const text = await boundedResponseText(response);
		if (!response.ok) {
			if (response.status === 400 && /invalid[_ ]grant/i.test(text))
				throw new Error("invalid_grant");
			throw providerError(
				`Manhattan OAuth failed with HTTP ${response.status}`,
			);
		}
		let token: Record<string, unknown>;
		try {
			token = JSON.parse(text) as Record<string, unknown>;
		} catch {
			throw providerError("Manhattan OAuth returned invalid JSON");
		}
		if (
			typeof token.access_token !== "string" ||
			!token.access_token ||
			(token.refresh_token !== undefined &&
				(typeof token.refresh_token !== "string" || !token.refresh_token)) ||
			typeof token.expires_in !== "number" ||
			!Number.isFinite(token.expires_in) ||
			token.expires_in <= 0
		)
			throw providerError("Manhattan OAuth returned incomplete token data");
		return token as {
			access_token: string;
			expires_in: number;
			refresh_token?: string;
		};
	}

	private async profile(token: {
		access_token: string;
		expires_in: number;
		refresh_token: string;
	}): Promise<GitHubOAuthIdentity> {
		const user = await this.identity.validateCredential(token.access_token);
		return {
			...user,
			expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
			refreshToken: token.refresh_token,
		};
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
