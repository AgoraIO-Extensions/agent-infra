import type {
	CredentialForExecution,
	ProviderCredentialConnector,
	ProviderExecutor,
} from "@agent-infra/connection-core";

import { datalegoExecutorDigest } from "./datalego-integrity.ts";

const apiOrigin = "https://datalego.agoralab.co";
const refreshOrigin = "https://grafana.bj2.agoralab.co";
const credentialScope = "datalego.query";
const maxResponseBytes = 5 * 1024 * 1024;
const providerId = "datalego";
const providerReleaseId = "datalego-connection-v2";
const requestTimeoutMs = 120_000;

export const datalegoConnectionCatalog = {
	actions: [
		{
			description: "获取当前 DataLego 个人用户。",
			effect: "READ" as const,
			id: "datalego.get_current_user@v2",
			inputSchema: emptySchema(),
			name: "datalego.get_current_user",
			requiredScopes: [credentialScope],
		},
		{
			description: "提交一个有界的 DataLego SQL 查询任务。",
			effect: "WRITE" as const,
			id: "datalego.submit_query@v2",
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
			id: "datalego.get_query_status@v2",
			inputSchema: jobSchema(),
			name: "datalego.get_query_status",
			requiredScopes: [credentialScope],
		},
		{
			description: "取消一个 DataLego 查询任务。",
			effect: "WRITE" as const,
			id: "datalego.cancel_query@v2",
			inputSchema: jobSchema(),
			name: "datalego.cancel_query",
			requiredScopes: [credentialScope],
		},
	],
	authProfile: {
		credential: "personal-hci-session",
		header: "accessToken",
		refresh: "HCIAuthToken sliding session",
	},
	deploymentProfile: {
		apiOrigin,
		deployment: "company-managed",
		identity: "GET /api/userInfo with HCIAuthToken cookie",
		product: "DataLego",
		refreshOrigin,
	},
	executorDigest: datalegoExecutorDigest,
	provider: providerId,
	providerReleaseId,
	sourceCommit: "connection-native",
} as const;

export class DataLegoAdapter
	implements ProviderCredentialConnector, ProviderExecutor
{
	readonly providerId = providerId;
	readonly providerReleaseId = providerReleaseId;
	private readonly fetcher: typeof fetch;

	constructor(fetcher: typeof fetch) {
		this.fetcher = fetcher;
	}

	async validateCredential(sessionToken: string) {
		const identity = await this.requestIdentity(sessionToken);
		return {
			accessToken: sessionToken,
			displayName: identity.name || identity.email,
			externalAccount: identity.email,
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
		const sessionToken = input.credential.accessToken;
		switch (input.action) {
			case "datalego.get_current_user":
				return this.requestIdentity(sessionToken);
			case "datalego.submit_query": {
				const auth = parseSession(sessionToken);
				return this.requestWithRefresh(sessionToken, (accessToken) => ({
					init: {
						body: JSON.stringify({
							download: Boolean(input.input.download),
							engine: enumValue(input.input, "engine", ["doris", "hive"]),
							panelId: 0,
							queue: optionalString(input.input, "queue") ?? "share",
							sql: boundedString(input.input, "sql", 200_000),
						}),
						headers: { "content-type": "application/json", accessToken },
						method: "POST",
					},
					path: `/api/v1/datainsight/job/trigger?creator=${encodeURIComponent(auth.email)}`,
				}));
			}
			case "datalego.get_query_status":
				return this.requestWithRefresh(sessionToken, (accessToken) => ({
					init: { headers: { accessToken }, method: "GET" },
					path: `/api/v1/datainsight/jobs/${encodeURIComponent(jobId(input.input))}/status`,
				}));
			case "datalego.cancel_query":
				return this.requestWithRefresh(sessionToken, (accessToken) => ({
					init: { headers: { accessToken }, method: "PUT" },
					path: `/api/v1/datainsight/jobs/${encodeURIComponent(jobId(input.input))}/cancel`,
				}));
			default:
				throw providerError(`Unsupported DataLego action: ${input.action}`);
		}
	}

	private async requestIdentity(sessionToken: string) {
		let activeSession = sessionToken;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const identity = parseSession(activeSession);
			const response = await this.send(
				"/api/v1/datainsight/jobs/__connection_credential_probe__/status",
				{
					headers: { accessToken: identity.accessToken },
					method: "GET",
				},
			);
			if (attempt === 0 && (await expiredAccessToken(response))) {
				activeSession = await this.refreshSession(activeSession);
				continue;
			}
			const text = await response.text();
			if (
				response.status === 400 &&
				text.toLowerCase().includes("record not found")
			) {
				return { email: identity.email, name: identity.name };
			}
			if (response.status === 401 || response.status === 403) {
				throw invalidCredential("DataLego personal session was rejected");
			}
			throw providerError(
				`DataLego credential proof failed with HTTP ${response.status}`,
			);
		}
		throw invalidCredential("DataLego personal session requires reconnection");
	}

	private async requestWithRefresh(
		sessionToken: string,
		build: (accessToken: string) => { init: RequestInit; path: string },
	) {
		let activeSession = sessionToken;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const request = build(parseSession(activeSession).accessToken);
			const response = await this.send(request.path, request.init);
			if (attempt === 0 && (await expiredAccessToken(response))) {
				activeSession = await this.refreshSession(activeSession);
				continue;
			}
			return this.responseJson(response);
		}
		throw providerError("DataLego request failed after credential refresh");
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
			throw invalidCredential("DataLego session requires reconnection");
		}
		parseSession(refreshed);
		return refreshed;
	}

	private async send(path: string, init: RequestInit) {
		try {
			return await this.fetcher(new URL(path, apiOrigin), {
				...init,
				redirect: "manual",
				signal: AbortSignal.timeout(requestTimeoutMs),
			});
		} catch (error) {
			if (
				error instanceof Error &&
				["AbortError", "TimeoutError", "TypeError"].includes(error.name)
			) {
				throw providerError("DataLego request transport failed");
			}
			throw error;
		}
	}

	private async responseJson(response: Response) {
		if (response.status >= 300 && response.status < 400) {
			throw invalidCredential("DataLego request redirected to authentication");
		}
		const declared = Number(response.headers.get("content-length"));
		if (declared > maxResponseBytes)
			throw providerError("DataLego response is too large");
		const text = await response.text();
		if (Buffer.byteLength(text) > maxResponseBytes)
			throw providerError("DataLego response is too large");
		if (!response.ok)
			throw providerError(
				`DataLego request failed with HTTP ${response.status}`,
			);
		try {
			return JSON.parse(text) as Record<string, unknown>;
		} catch {
			throw providerError("DataLego returned invalid JSON");
		}
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
		const user =
			value.user && typeof value.user === "object"
				? (value.user as Record<string, unknown>)
				: {};
		const email = typeof user.email === "string" ? user.email : "";
		const name =
			typeof user.name === "string"
				? user.name
				: typeof user.displayName === "string"
					? user.displayName
					: "";
		if (!accessToken || !email) throw new Error();
		return { accessToken, email, name };
	} catch {
		throw invalidCredential("DataLego HCI session is invalid");
	}
}

async function expiredAccessToken(response: Response) {
	if (response.status !== 401) return false;
	const text = await response
		.clone()
		.text()
		.catch(() => "");
	return text.toLowerCase().includes("access token has expired");
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
		throw providerError(`DataLego ${name} is invalid`);
	return value;
}

function optionalString(input: Record<string, unknown>, name: string) {
	const value = input[name];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim() || value.length > 64)
		throw providerError(`DataLego ${name} is invalid`);
	return value.trim();
}

function enumValue(
	input: Record<string, unknown>,
	name: string,
	values: string[],
) {
	const value = input[name];
	if (typeof value !== "string" || !values.includes(value))
		throw providerError(`DataLego ${name} is invalid`);
	return value;
}

function jobId(input: Record<string, unknown>) {
	return boundedString(input, "jobId", 256);
}

function invalidCredential(message: string) {
	return Object.assign(new Error(message), { providerCredentialInvalid: true });
}

function providerError(message: string) {
	return Object.assign(new Error(message), { providerFailure: true });
}
