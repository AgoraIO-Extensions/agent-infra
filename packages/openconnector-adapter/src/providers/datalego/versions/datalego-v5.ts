import type {
	CredentialForExecution,
	GitHubOAuthAuthorization,
	GitHubOAuthIdentity,
	GitHubOAuthProvider,
	ProviderCredentialConnector,
	ProviderExecutor,
} from "@agent-infra/connection-core";
import { datalegoV5ExecutorDigest } from "./datalego-v5-integrity.ts";

const providerId = "datalego";
const providerReleaseId = "datalego-connection-v5";
const credentialScope = "datalego.query";
const apiOrigin = "https://datalego.agoralab.co";
const userInfoUrl = "https://oauth.agoralab.co/api/v2/userInfo";
const tokenUrl = "https://oauth.agoralab.co/oauth/token";
const proofPath =
	"/api/v1/datainsight/jobs/__connection_credential_probe__/status";
const maxResponseBytes = 64 * 1024;

export const datalegoV5ConnectionCatalog = {
	actions: [
		{
			description: "获取当前 DataLego 个人用户。",
			effect: "READ" as const,
			id: "datalego.get_current_user@v5",
			inputSchema: emptySchema(),
			name: "datalego.get_current_user",
			requiredScopes: [credentialScope],
		},
		{
			description: "提交一个有界的 DataLego SQL 查询任务。",
			effect: "WRITE" as const,
			id: "datalego.submit_query@v5",
			inputSchema: {
				additionalProperties: false,
				properties: {
					download: { type: "boolean" },
					engine: { enum: ["doris", "hive"], type: "string" },
					queue: { maxLength: 64, minLength: 1, type: "string" },
					sql: { maxLength: 200_000, minLength: 1, type: "string" },
				},
				required: ["sql", "engine"],
				type: "object",
			},
			name: "datalego.submit_query",
			requiredScopes: [credentialScope],
		},
		{
			description: "获取 DataLego 查询任务状态和结果。",
			effect: "READ" as const,
			id: "datalego.get_query_status@v5",
			inputSchema: jobSchema(),
			name: "datalego.get_query_status",
			requiredScopes: [credentialScope],
		},
		{
			description: "取消一个 DataLego 查询任务。",
			effect: "WRITE" as const,
			id: "datalego.cancel_query@v5",
			inputSchema: jobSchema(),
			name: "datalego.cancel_query",
			requiredScopes: [credentialScope],
		},
	],
	authProfile: {
		credential: "authorization-code-access-token",
		header: "accessToken",
		refresh: "oauth-refresh-token",
	},
	deploymentProfile: {
		apiOrigin,
		deployment: "company-managed",
		identity: userInfoUrl,
		proof: proofPath,
		product: "DataLego",
	},
	executorDigest: datalegoV5ExecutorDigest,
	provider: providerId,
	providerReleaseId,
	sourceCommit: "connection-native",
} as const;

export class DataLegoV5Adapter
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
		if (proof.status === 401 || proof.status === 403) throw invalidCredential();
		if (proof.status !== 400)
			throw failure("DataLego OAuth access proof failed");
		const body = await responseJson(proof);
		if (body.message !== "record not found")
			throw failure("DataLego OAuth access proof failed");
		return {
			accessToken,
			displayName: email,
			externalAccount: email,
			grantedScopes: [credentialScope],
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
		if (!accessToken) throw invalidCredential();
		switch (input.action) {
			case "datalego.get_current_user":
				return {
					email: (await this.validateCredential(accessToken)).externalAccount,
				};
			case "datalego.submit_query": {
				const sql = boundedString(input.input, "sql", 200_000);
				const engine = enumValue(input.input, "engine", ["doris", "hive"]);
				const queue = optionalString(input.input, "queue") ?? "share";
				const identity = await this.validateCredential(accessToken);
				return this.businessRequest(
					`/api/v1/datainsight/job/trigger?creator=${encodeURIComponent(identity.externalAccount)}`,
					{
						method: "POST",
						headers: { accessToken, "content-type": "application/json" },
						body: JSON.stringify({
							sql,
							engine,
							queue,
							panelId: 0,
							download: Boolean(input.input.download),
						}),
					},
				);
			}
			case "datalego.get_query_status":
				return this.businessRequest(
					`/api/v1/datainsight/jobs/${jobPathSegment(input.input)}/status`,
					{ method: "GET", headers: { accessToken } },
				);
			case "datalego.cancel_query": {
				const jobId = jobPathSegment(input.input);
				let status: Record<string, unknown>;
				try {
					status = await this.businessRequest(
						`/api/v1/datainsight/jobs/${jobId}/status`,
						{ method: "GET", headers: { accessToken } },
					);
					if (
						![
							"pending",
							"waiting",
							"running",
							"success",
							"error",
							"cancel",
							"forbid",
						].includes(String(status.status))
					)
						throw failure("DataLego returned an unknown query state");
				} catch (error) {
					throw Object.assign(
						failure(
							"DataLego query status could not be verified; cancellation was not submitted",
						),
						{
							providerCode: "cancel_not_submitted",
							providerMessage:
								"Query status could not be verified; cancellation was not submitted",
							providerSubmissionOutcome: "rejected",
							...(typeof error === "object" &&
							error !== null &&
							"providerCredentialInvalid" in error
								? { providerCredentialInvalid: true }
								: {}),
						},
					);
				}
				if (
					["success", "error", "cancel", "forbid"].includes(
						String(status.status),
					)
				) {
					return {
						jobId: input.input.jobId,
						status: status.status,
						cancellation: { applied: false, reason: "already_finished" },
					};
				}
				return this.businessRequest(
					`/api/v1/datainsight/jobs/${jobId}/cancel`,
					{ method: "PUT", headers: { accessToken } },
					true,
				);
			}
			default:
				throw failure("Unsupported DataLego action");
		}
	}

	private async businessRequest(
		path: string,
		init: RequestInit,
		allowEmpty = false,
	) {
		const response = await this.send(new URL(path, apiOrigin), init, 120_000);
		if (!response.ok)
			throw Object.assign(
				failure(`DataLego request failed with HTTP ${response.status}`),
				{
					providerStatus: response.status,
					// HTTP status alone does not prove a mutation was rejected before effect.
					submissionUncertain: init.method !== "GET",
					...(response.status === 401 || response.status === 403
						? { providerCredentialInvalid: true }
						: {}),
				},
			);
		const text = await responseText(response, 5 * 1024 * 1024);
		if (allowEmpty && !text.trim())
			return { cancellation: { requested: true } };
		const result = parseJson(text);
		if (allowEmpty && result.status !== "cancel")
			throw Object.assign(
				failure("DataLego returned an unknown cancellation response"),
				{
					providerStatus: response.status,
					submissionUncertain: true,
				},
			);
		return result;
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

	private async send(url: string | URL, init: RequestInit, timeoutMs = 30_000) {
		try {
			const response = await this.fetcher(url, {
				...init,
				redirect: "manual",
				signal: AbortSignal.timeout(timeoutMs),
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

async function responseText(response: Response, limit = maxResponseBytes) {
	if (Number(response.headers.get("content-length")) > limit)
		throw failure("DataLego OAuth response is too large");
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
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

function emptySchema() {
	return {
		additionalProperties: false,
		properties: {},
		required: [],
		type: "object",
	} as const;
}

function jobSchema() {
	return {
		additionalProperties: false,
		properties: { jobId: { maxLength: 256, minLength: 1, type: "string" } },
		required: ["jobId"],
		type: "object",
	} as const;
}

function boundedString(
	input: Record<string, unknown>,
	name: string,
	maxLength: number,
) {
	const value = typeof input[name] === "string" ? input[name].trim() : "";
	if (!value || value.length > maxLength)
		throw failure(`DataLego ${name} is invalid`);
	return value;
}

function jobPathSegment(input: Record<string, unknown>) {
	const id = boundedString(input, "jobId", 256);
	if (id === "." || id === "..") throw failure("DataLego jobId is invalid");
	return encodeURIComponent(id);
}

function optionalString(input: Record<string, unknown>, name: string) {
	const value = input[name];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim() || value.length > 64)
		throw failure(`DataLego ${name} is invalid`);
	return value.trim();
}

function enumValue(
	input: Record<string, unknown>,
	name: string,
	values: string[],
) {
	const value = input[name];
	if (typeof value !== "string" || !values.includes(value))
		throw failure(`DataLego ${name} is invalid`);
	return value;
}
