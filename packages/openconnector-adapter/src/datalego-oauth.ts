import type {
	CredentialForExecution,
	GitHubOAuthAuthorization,
	GitHubOAuthIdentity,
	GitHubOAuthProvider,
	ProviderCredentialConnector,
	ProviderExecutor,
} from "@agent-infra/connection-core";
import { datalegoOAuthExecutorDigest } from "./datalego-oauth-integrity.ts";

const providerId = "datalego-oauth-pilot";
const providerReleaseId = "datalego-oauth-pilot-connection-v1";
const readScope = "datalego.identity.read";
const apiOrigin = "https://datalego.agoralab.co";
const userInfoUrl = "https://oauth.agoralab.co/api/v2/userInfo";
const tokenUrl = "https://oauth.agoralab.co/oauth/token";
const proofPath =
	"/api/v1/datainsight/jobs/__connection_credential_probe__/status";
const maxResponseBytes = 64 * 1024;

export const datalegoOAuthConnectionCatalog = {
	actions: [
		{
			description: "验证 DataLego OAuth 个人身份与只读访问。",
			effect: "READ" as const,
			id: "datalego-oauth-pilot.get_current_user@v1",
			inputSchema: {
				additionalProperties: false,
				properties: {},
				required: [],
				type: "object",
			},
			name: "datalego-oauth-pilot.get_current_user",
			requiredScopes: [readScope],
		},
	],
	authProfile: {
		credential: "authorization-code-access-token",
		header: "accessToken",
		refresh: "oauth-refresh-token",
	},
	deploymentProfile: {
		apiOrigin,
		deployment: "company-managed-supervised-pilot",
		identity: userInfoUrl,
		proof: proofPath,
		product: "DataLego OAuth Pilot",
	},
	executorDigest: datalegoOAuthExecutorDigest,
	provider: providerId,
	providerReleaseId,
	sourceCommit: "connection-native",
} as const;

export class DataLegoOAuthAdapter
	implements GitHubOAuthProvider, ProviderCredentialConnector, ProviderExecutor
{
	readonly providerId = providerId;
	readonly providerReleaseId = providerReleaseId;
	private readonly fetcher: typeof fetch;
	private readonly config: {
		clientId: string;
		clientSecret: string;
		redirectUri: string;
	};

	constructor(
		fetcher: typeof fetch,
		config: {
			clientId: string;
			clientSecret: string;
			redirectUri: string;
		},
	) {
		this.fetcher = fetcher;
		this.config = config;
	}

	getAuthorizationUrl(
		input: GitHubOAuthAuthorization & { redirectUri: string },
	) {
		this.requireRedirect(input.redirectUri);
		const url = new URL("https://oauth.agoralab.co/oauth/authorize");
		url.searchParams.set("response_type", "code");
		url.searchParams.set("client_id", this.config.clientId);
		url.searchParams.set("redirect_uri", this.config.redirectUri);
		url.searchParams.set("state", input.state);
		return url.toString();
	}

	async exchangeCode(input: {
		code: string;
		codeVerifier: string;
		redirectUri: string;
	}): Promise<GitHubOAuthIdentity> {
		this.requireRedirect(input.redirectUri);
		const token = await this.token({
			code: input.code,
			grant_type: "authorization_code",
			redirect_uri: this.config.redirectUri,
		});
		if (!token.refresh_token) throw failure("OAuth refresh token is missing");
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

	async validateCredential(accessToken: string) {
		if (!accessToken) throw invalidCredential();
		const userResponse = await this.send(userInfoUrl, {
			headers: { authorization: `Bearer ${accessToken}` },
		});
		if (userResponse.status === 401 || userResponse.status === 403)
			throw invalidCredential();
		if (!userResponse.ok) throw failure("OAuth identity lookup failed");
		const user = await responseJson(userResponse);
		const email =
			typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
		if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email))
			throw failure("OAuth identity is incomplete");
		const proof = await this.send(new URL(proofPath, apiOrigin), {
			headers: { accessToken },
		});
		const body = await responseText(proof);
		if (proof.status === 401 || proof.status === 403) throw invalidCredential();
		if (
			proof.status !== 400 ||
			!body.toLowerCase().includes("record not found")
		)
			throw failure("DataLego OAuth access proof failed");
		return {
			accessToken,
			displayName: email,
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
		if (input.action !== "datalego-oauth-pilot.get_current_user")
			throw failure("Unsupported DataLego OAuth pilot action");
		const identity = await this.validateCredential(
			input.credential.accessToken,
		);
		return { email: identity.externalAccount };
	}

	private requireRedirect(redirectUri: string) {
		if (redirectUri !== this.config.redirectUri)
			throw failure("OAuth redirect URI does not match registered client");
	}

	private async profile(token: {
		access_token: string;
		expires_in: number;
		refresh_token: string;
	}): Promise<GitHubOAuthIdentity> {
		const identity = await this.validateCredential(token.access_token);
		return {
			...identity,
			expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
			refreshToken: token.refresh_token,
		};
	}

	private async token(fields: Record<string, string>) {
		const response = await this.send(tokenUrl, {
			body: new URLSearchParams(fields),
			headers: {
				authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`,
				"content-type": "application/x-www-form-urlencoded",
			},
			method: "POST",
		});
		const text = await responseText(response);
		if (!response.ok) {
			if (response.status === 400 && /invalid[_ ]grant/i.test(text))
				throw new Error("invalid_grant");
			throw failure("OAuth token exchange failed");
		}
		const token = parseJson(text);
		if (
			typeof token.access_token !== "string" ||
			!token.access_token ||
			token.token_type?.toString().toLowerCase() !== "bearer" ||
			(token.refresh_token !== undefined &&
				(typeof token.refresh_token !== "string" || !token.refresh_token)) ||
			typeof token.expires_in !== "number" ||
			!Number.isSafeInteger(token.expires_in) ||
			token.expires_in <= 0 ||
			token.expires_in > 604800
		)
			throw failure("OAuth token response is incomplete");
		return token as {
			access_token: string;
			expires_in: number;
			refresh_token?: string;
		};
	}

	private async send(url: string | URL, init: RequestInit) {
		try {
			const response = await this.fetcher(url, {
				...init,
				redirect: "manual",
				signal: AbortSignal.timeout(30_000),
			});
			if (response.status >= 300 && response.status < 400)
				throw invalidCredential();
			return response;
		} catch (error) {
			if (
				(error as { providerCredentialInvalid?: boolean })
					?.providerCredentialInvalid
			)
				throw error;
			throw failure("DataLego OAuth request failed");
		}
	}
}

async function responseText(response: Response) {
	if (Number(response.headers.get("content-length")) > maxResponseBytes)
		throw failure("DataLego OAuth response is too large");
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
			throw failure("DataLego OAuth response is too large");
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function responseJson(response: Response) {
	return parseJson(await responseText(response));
}

function parseJson(text: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(text);
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error();
		return value as Record<string, unknown>;
	} catch {
		throw failure("DataLego OAuth returned invalid JSON");
	}
}

function invalidCredential() {
	return Object.assign(new Error("DataLego OAuth authorization was rejected"), {
		providerCredentialInvalid: true,
	});
}

function failure(message: string) {
	return Object.assign(new Error(message), { providerFailure: true });
}
