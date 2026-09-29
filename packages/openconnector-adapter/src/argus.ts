import type {
	CredentialForExecution,
	GitHubOAuthAuthorization,
	GitHubOAuthIdentity,
	GitHubOAuthProvider,
	ProviderCredentialConnector,
	ProviderExecutor,
} from "@agent-infra/connection-core";
import { argusExecutorDigest } from "./argus-integrity.ts";

const origin = "https://da.la3d.agoralab.co";
const basePath = "/argus-service/api/v1";
const providerId = "argus";
const providerReleaseId = "argus-connection-v1";
const maxBytes = 256 * 1024;
const maxTimeRange = 7 * 24 * 60 * 60;

const integer = (minimum: number, maximum = Number.MAX_SAFE_INTEGER) => ({
	type: "integer",
	minimum,
	maximum,
});
const string = { type: "string", minLength: 1, maxLength: 256 };
const list = (items: object, maxItems = 100) => ({
	type: "array",
	items,
	minItems: 1,
	maxItems,
});
const actionSpecs = [
	{
		name: "search_calls",
		description: "按时间范围搜索 Argus 通话，最多返回 50 条。",
		properties: {
			fromTs: integer(1),
			toTs: integer(1),
			size: integer(1, 50),
			from: integer(0, 10000),
			vid: integer(1),
			channelName: string,
			uids: string,
			sids: string,
		},
		required: ["fromTs", "toTs"],
	},
	{
		name: "get_call_detail",
		description: "获取一条 Argus 通话详情。",
		properties: { callId: string },
		required: ["callId"],
	},
	{
		name: "get_call_users",
		description: "获取通话用户、设备与进出时间。",
		properties: {
			callId: string,
			fromTs: integer(1),
			toTs: integer(1),
			additionalUids: list(integer(0), 50),
		},
		required: ["callId", "fromTs", "toTs"],
	},
	{
		name: "get_user_sessions",
		description: "分页获取通话用户会话。",
		properties: {
			callId: string,
			fromTs: integer(1),
			toTs: integer(1),
			page: integer(1, 10000),
			size: integer(1, 50),
			uids: list(string, 50),
			did: string,
			minDuration: integer(0),
			maxDuration: integer(0),
			os: integer(0),
			speaker: { type: "boolean" },
			quitState: integer(0),
			ctypes: list(integer(0), 50),
			vers: list(string, 50),
		},
		required: ["callId", "fromTs", "toTs"],
	},
	{
		name: "get_counter_meta",
		description: "分页读取 Argus counter 元数据，每页最多 50 项。",
		properties: { offset: integer(0, 5000), limit: integer(1, 50) },
		required: [],
	},
	{
		name: "get_counter_series",
		description: "读取指定 SID 与 peer 的 counter 时序。",
		properties: {
			callId: string,
			sids: list(string, 20),
			counterIds: list(integer(0), 30),
			peerUids: list(integer(0), 20),
			fromTs: integer(1),
			toTs: integer(1),
		},
		required: ["callId", "sids", "counterIds", "peerUids", "fromTs", "toTs"],
	},
	{
		name: "get_event_list",
		description: "读取指定 SID 的通话事件；HTTP POST 仅承载查询参数。",
		properties: {
			callId: string,
			sids: list(string, 20),
			eventIds: list(integer(1), 30),
			fromTs: integer(1),
			toTs: integer(1),
		},
		required: ["callId", "sids", "fromTs", "toTs"],
	},
	{
		name: "get_voqa_series",
		description: "读取 speaker/listener 间的 VoQA 质量时序。",
		properties: {
			callId: string,
			cid: integer(0),
			spkUid: integer(0),
			spkSids: string,
			lsnSids: string,
			voqaTypes: list(
				{ type: "string", enum: ["p2s", "p2sv", "s2l", "s2lv", "s2s", "s2sv"] },
				6,
			),
			voqaMetrics: list(
				{
					type: "string",
					enum: [
						"delay",
						"jitter100",
						"jitter95",
						"jitter90",
						"lost_ratio",
						"lost_ratio2",
						"lost_ratio3",
					],
				},
				7,
			),
			fromTs: integer(1),
			toTs: integer(1),
		},
		required: [
			"callId",
			"cid",
			"spkUid",
			"spkSids",
			"lsnSids",
			"fromTs",
			"toTs",
		],
	},
] as const;

export const argusConnectionCatalog = {
	actions: actionSpecs.map((action) => ({
		description: action.description,
		effect: "READ" as const,
		id: `argus.${action.name}@v1`,
		inputSchema: {
			additionalProperties: false,
			type: "object",
			properties: action.properties,
			required: [...action.required],
		},
		name: `argus.${action.name}`,
		requiredScopes: ["argus.read"],
	})),
	authProfile: { type: "oauth2", tokenTransport: "bearer" },
	deploymentProfile: {
		apiOrigin: origin,
		deployment: "company-managed",
		product: "Argus",
		identity: "GET /api/userInfo plus Argus read probe",
	},
	executorDigest: argusExecutorDigest,
	provider: providerId,
	providerReleaseId,
	sourceCommit: "606f111c2cf7dce903f34c86c44fba4f3ef41062",
} as const;

function failure(message: string, invalid = false): Error {
	return Object.assign(new Error(message), {
		...(invalid
			? { providerCredentialInvalid: true }
			: { providerFailure: true }),
	});
}

async function boundedJson(
	response: Response,
	limit = maxBytes,
): Promise<Record<string, unknown> | unknown[]> {
	if (
		!response.headers
			.get("content-type")
			?.toLowerCase()
			.includes("application/json")
	)
		throw failure("Argus returned non-JSON content");
	const length = Number(response.headers.get("content-length") ?? 0);
	if (length > limit) throw failure("Argus response is too large");
	if (!response.body) throw failure("Argus response is empty");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			throw failure("Argus response is too large");
		}
		chunks.push(value);
	}
	try {
		const parsed: unknown = JSON.parse(
			new TextDecoder().decode(Buffer.concat(chunks)),
		);
		if (!parsed || typeof parsed !== "object") throw new Error("Invalid shape");
		return parsed as Record<string, unknown> | unknown[];
	} catch {
		throw failure("Argus returned invalid JSON");
	}
}

function number(
	input: Record<string, unknown>,
	key: string,
	minimum = 0,
	maximum = Number.MAX_SAFE_INTEGER,
): number {
	const value = input[key];
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < minimum ||
		value > maximum
	)
		throw failure(`Argus ${key} is invalid`);
	return value;
}

function callPath(input: Record<string, unknown>) {
	const id = input.callId;
	if (typeof id !== "string" || !id || id.length > 256)
		throw failure("Argus callId is invalid");
	return `${basePath}/call-sessions/${encodeURIComponent(id)}`;
}

function timeRange(input: Record<string, unknown>) {
	const from = number(input, "fromTs", 1);
	const to = number(input, "toTs", 1);
	if (to < from || to - from > maxTimeRange)
		throw failure("Argus time range is invalid");
}

function query(input: Record<string, unknown>, keys: readonly string[]) {
	const params = new URLSearchParams();
	for (const key of keys) {
		const value = input[key];
		if (Array.isArray(value))
			for (const item of value) params.append(key, String(item));
		else if (value !== undefined) params.set(key, String(value));
	}
	return params;
}

export class ArgusAdapter
	implements ProviderCredentialConnector, ProviderExecutor
{
	readonly providerId = providerId;
	readonly providerReleaseId = providerReleaseId;
	private readonly fetcher: typeof fetch;
	constructor(fetcher: typeof fetch) {
		this.fetcher = fetcher;
	}

	async validateCredential(accessToken: string) {
		if (!accessToken) throw failure("Argus token is required", true);
		const response = await this.fetcher(
			"https://oauth.agoralab.co/api/userInfo",
			{
				headers: {
					accept: "application/json",
					authorization: `Bearer ${accessToken}`,
				},
				redirect: "manual",
			},
		);
		if (!response.ok) throw failure("Argus OAuth identity was rejected", true);
		const profile = await boundedJson(response, 16 * 1024);
		const rawEmail = !Array.isArray(profile)
			? (profile.email ?? profile.Email)
			: undefined;
		const email =
			typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
		if (!email || !/^[^@\s]+@[^@\s]+$/.test(email))
			throw failure("Argus OAuth identity is incomplete", true);
		const probe = await this.fetcher(
			`${origin}${basePath}/metric-configs/counter-meta`,
			{
				headers: {
					accept: "application/json",
					authorization: `Bearer ${accessToken}`,
				},
				redirect: "manual",
			},
		);
		if (
			!probe.ok ||
			!probe.headers.get("content-type")?.includes("application/json")
		)
			throw failure("Argus access was rejected", true);
		await probe.body?.cancel();
		return {
			accessToken,
			displayName: email,
			externalAccount: email,
			grantedScopes: ["argus.read"],
			providerId,
			providerReleaseId,
		};
	}

	async execute(input: {
		action: string;
		credential: CredentialForExecution;
		input: Record<string, unknown>;
	}) {
		const args = input.input;
		const name = input.action.replace(/^argus\./, "");
		if (
			!actionSpecs.some((action) => action.name === name) ||
			input.action !== `argus.${name}`
		)
			throw failure("Unsupported Argus action");
		if (name !== "get_call_detail" && name !== "get_counter_meta")
			timeRange(args);
		let path: string;
		let body: Record<string, unknown> | undefined;
		switch (name) {
			case "search_calls": {
				const params = query(args, [
					"fromTs",
					"toTs",
					"vid",
					"channelName",
					"uids",
					"sids",
				]);
				params.set(
					"from",
					String(args.from === undefined ? 0 : number(args, "from", 0, 10000)),
				);
				params.set(
					"size",
					String(args.size === undefined ? 20 : number(args, "size", 1, 50)),
				);
				path = `${basePath}/call-sessions?${params}`;
				break;
			}
			case "get_call_detail":
				path = `${callPath(args)}?source=normal`;
				break;
			case "get_call_users": {
				const params = query(args, ["fromTs", "toTs"]);
				params.set("callStartTs", String(args.fromTs));
				params.set("callEndTs", String(args.toTs));
				if (Array.isArray(args.additionalUids))
					params.set("additionalUidStr", args.additionalUids.join(","));
				path = `${callPath(args)}/users?${params}`;
				break;
			}
			case "get_user_sessions": {
				const params = query(args, [
					"fromTs",
					"toTs",
					"uids",
					"did",
					"minDuration",
					"maxDuration",
					"os",
					"speaker",
					"quitState",
					"ctypes",
					"vers",
				]);
				params.set(
					"page",
					String(args.page === undefined ? 1 : number(args, "page", 1, 10000)),
				);
				params.set(
					"size",
					String(args.size === undefined ? 20 : number(args, "size", 1, 50)),
				);
				path = `${callPath(args)}/user-sessions?${params}`;
				break;
			}
			case "get_counter_meta":
				path = `${basePath}/metric-configs/counter-meta`;
				break;
			case "get_counter_series": {
				const peers = Array.isArray(args.peerUids) ? args.peerUids : [];
				body = {
					sids: args.sids,
					counterIds: args.counterIds,
					peerUids: [...new Set([...peers, 0, 666666])],
					fromTs: args.fromTs,
					toTs: args.toTs,
				};
				path = `${callPath(args)}/counters`;
				break;
			}
			case "get_event_list":
				body = {
					sids: args.sids,
					eventIds: args.eventIds,
					fromTs: args.fromTs,
					toTs: args.toTs,
				};
				path = `${callPath(args)}/events`;
				break;
			case "get_voqa_series": {
				const params = query(args, [
					"cid",
					"spkUid",
					"spkSids",
					"lsnSids",
					"fromTs",
					"toTs",
				]);
				if (Array.isArray(args.voqaTypes))
					params.set("voqaTypes", args.voqaTypes.join(","));
				if (Array.isArray(args.voqaMetrics))
					params.set("voqaMetrics", args.voqaMetrics.join(","));
				path = `${callPath(args)}/voqas?${params}`;
				break;
			}
			default:
				throw failure("Unsupported Argus action");
		}
		const response = await this.fetcher(`${origin}${path}`, {
			method: body ? "POST" : "GET",
			...(body ? { body: JSON.stringify(body) } : {}),
			headers: {
				accept: "application/json",
				authorization: `Bearer ${input.credential.accessToken}`,
				...(body ? { "content-type": "application/json" } : {}),
			},
			redirect: "manual",
		});
		if (
			response.status === 401 ||
			response.status === 403 ||
			(response.status >= 300 && response.status < 400)
		)
			throw failure("Argus authorization was rejected", true);
		if (!response.ok)
			throw failure(`Argus request failed with HTTP ${response.status}`);
		const result = await boundedJson(
			response,
			name === "get_counter_meta" ? 2 * 1024 * 1024 : maxBytes,
		);
		if (name === "get_counter_meta") {
			if (!Array.isArray(result))
				throw failure("Argus counter metadata is invalid");
			const offset =
				args.offset === undefined ? 0 : number(args, "offset", 0, 5000);
			const limit =
				args.limit === undefined ? 20 : number(args, "limit", 1, 50);
			const page = result.slice(offset, offset + limit);
			if (Buffer.byteLength(JSON.stringify(page)) > maxBytes)
				throw failure("Argus counter metadata page is too large");
			return {
				items: page,
				total: result.length,
				hasMore: offset + limit < result.length,
				nextOffset: offset + limit < result.length ? offset + limit : null,
			};
		}
		return Array.isArray(result) ? { items: result } : result;
	}
}

export class ArgusOAuthAdapter implements GitHubOAuthProvider {
	private readonly identity: ArgusAdapter;
	private readonly fetcher: typeof fetch;
	private readonly clientId: string;
	private readonly clientSecret: string;
	constructor(
		identity: ArgusAdapter,
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
		const url = new URL("https://oauth.agoralab.co/oauth/authorize");
		url.searchParams.set("response_type", "code");
		url.searchParams.set("client_id", this.clientId);
		url.searchParams.set("redirect_uri", input.redirectUri);
		url.searchParams.set("state", input.state);
		url.searchParams.set("scope", "email");
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
			throw failure("Argus OAuth did not return refresh token");
		return this.profile(
			token.access_token,
			token.refresh_token,
			token.expires_in,
		);
	}
	async refresh(refreshToken: string): Promise<GitHubOAuthIdentity> {
		const token = await this.token({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		});
		return this.profile(
			token.access_token,
			token.refresh_token ?? refreshToken,
			token.expires_in,
		);
	}
	private async token(fields: Record<string, string>) {
		const response = await this.fetcher(
			"https://oauth.agoralab.co/oauth/token",
			{
				method: "POST",
				body: new URLSearchParams(fields),
				headers: {
					accept: "application/json",
					authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
					"content-type": "application/x-www-form-urlencoded",
				},
				redirect: "manual",
			},
		);
		if (!response.ok) {
			if (response.status === 400) throw new Error("invalid_grant");
			throw failure(`Argus OAuth failed with HTTP ${response.status}`);
		}
		const data = await boundedJson(response, 16 * 1024);
		if (
			Array.isArray(data) ||
			typeof data.access_token !== "string" ||
			!data.access_token ||
			typeof data.expires_in !== "number" ||
			data.expires_in <= 0 ||
			!Number.isFinite(data.expires_in) ||
			(data.refresh_token !== undefined &&
				typeof data.refresh_token !== "string")
		)
			throw failure("Argus OAuth returned incomplete token data");
		return data as {
			access_token: string;
			refresh_token?: string;
			expires_in: number;
		};
	}
	private async profile(
		accessToken: string,
		refreshToken: string,
		expiresIn: number,
	): Promise<GitHubOAuthIdentity> {
		return {
			...(await this.identity.validateCredential(accessToken)),
			refreshToken,
			expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
		};
	}
}
