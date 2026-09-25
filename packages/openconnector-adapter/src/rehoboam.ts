import type {
	CredentialForExecution,
	ProviderCredentialConnector,
	ProviderExecutor,
} from "@agent-infra/connection-core";
import { rehoboamExecutorDigest } from "./rehoboam-integrity.ts";

const apiOrigin = "https://justinia.gz3.agoralab.co";
const metadataScope = "rehoboam.metadata.read";
const releaseReadScope = "rehoboam.release.read";
const releaseWriteScope = "rehoboam.release.write";
const maxResponseBytes = 64 * 1024;
const providerId = "rehoboam";
const providerReleaseId = "rehoboam-connection-v6";

const releaseIdSchema = { minLength: 1, type: "string" } as const;
const cardIdSchema = { minLength: 1, type: "string" } as const;
const requestIdSchema = { minLength: 1, type: "string" } as const;

export const rehoboamConnectionCatalog = {
	actions: [
		{
			description: "获取当前通过 Rehoboam 个人 Token 鉴权的用户。",
			effect: "READ" as const,
			id: "rehoboam.get_current_user@v6",
			inputSchema: {
				additionalProperties: false,
				properties: {},
				required: [],
				type: "object",
			},
			name: "rehoboam.get_current_user",
			requiredScopes: [metadataScope],
		},
		{
			description: "分页查询 Rehoboam 版本列表。",
			effect: "READ" as const,
			id: "rehoboam.list_releases@v3",
			inputSchema: {
				additionalProperties: false,
				properties: {
					page: { minimum: 1, type: "integer" },
					pageSize: { maximum: 100, minimum: 1, type: "integer" },
					status: { type: "string" },
					title: { type: "string" },
					version: { type: "string" },
					jiraId: { type: "string" },
				},
				required: [],
				type: "object",
			},
			name: "rehoboam.list_releases",
			requiredScopes: [releaseReadScope],
		},
		{
			description: "获取一个 Rehoboam 版本的受限详情。",
			effect: "READ" as const,
			id: "rehoboam.get_release@v3",
			inputSchema: {
				additionalProperties: false,
				properties: { releaseId: releaseIdSchema },
				required: ["releaseId"],
				type: "object",
			},
			name: "rehoboam.get_release",
			requiredScopes: [releaseReadScope],
		},
		{
			description: "列出指定版本拥有的流水线。",
			effect: "READ" as const,
			id: "rehoboam.list_release_pipelines@v3",
			inputSchema: {
				additionalProperties: false,
				properties: { releaseId: releaseIdSchema },
				required: ["releaseId"],
				type: "object",
			},
			name: "rehoboam.list_release_pipelines",
			requiredScopes: [releaseReadScope],
		},
		{
			description: "获取指定版本中的一条流水线。",
			effect: "READ" as const,
			id: "rehoboam.get_release_pipeline@v3",
			inputSchema: {
				additionalProperties: false,
				properties: { releaseId: releaseIdSchema, cardId: cardIdSchema },
				required: ["releaseId", "cardId"],
				type: "object",
			},
			name: "rehoboam.get_release_pipeline",
			requiredScopes: [releaseReadScope],
		},
		{
			description: "预检版本流水线运行；服务端决定直跑或审批申请。",
			effect: "READ" as const,
			id: "rehoboam.prepare_release_pipeline_run@v3",
			inputSchema: {
				additionalProperties: false,
				properties: {
					releaseId: releaseIdSchema,
					cardId: cardIdSchema,
					params: { type: "object" },
				},
				required: ["releaseId", "cardId"],
				type: "object",
			},
			name: "rehoboam.prepare_release_pipeline_run",
			requiredScopes: [releaseReadScope],
		},
		{
			description: "运行版本流水线；管理员直跑，其他用户创建审批申请。",
			effect: "WRITE" as const,
			id: "rehoboam.execute_release_pipeline@v3",
			inputSchema: {
				additionalProperties: false,
				properties: {
					releaseId: releaseIdSchema,
					cardId: cardIdSchema,
					params: { type: "object" },
				},
				required: ["releaseId", "cardId"],
				type: "object",
			},
			name: "rehoboam.execute_release_pipeline",
			requiredScopes: [releaseWriteScope],
		},
		{
			description: "分页列出指定版本的流水线执行申请。",
			effect: "READ" as const,
			id: "rehoboam.list_execution_requests@v3",
			inputSchema: {
				additionalProperties: false,
				properties: {
					releaseId: releaseIdSchema,
					page: { minimum: 1, type: "integer" },
					pageSize: { maximum: 100, minimum: 1, type: "integer" },
					approvalStatus: { type: "string" },
				},
				required: ["releaseId"],
				type: "object",
			},
			name: "rehoboam.list_execution_requests",
			requiredScopes: [releaseReadScope],
		},
		{
			description: "获取一个流水线执行申请及当前用户能力。",
			effect: "READ" as const,
			id: "rehoboam.get_execution_request@v3",
			inputSchema: {
				additionalProperties: false,
				properties: { requestId: requestIdSchema },
				required: ["requestId"],
				type: "object",
			},
			name: "rehoboam.get_execution_request",
			requiredScopes: [releaseReadScope],
		},
		{
			description: "批准流水线执行申请。",
			effect: "WRITE" as const,
			id: "rehoboam.approve_execution_request@v3",
			inputSchema: {
				additionalProperties: false,
				properties: { releaseId: releaseIdSchema, requestId: requestIdSchema },
				required: ["releaseId", "requestId"],
				type: "object",
			},
			name: "rehoboam.approve_execution_request",
			requiredScopes: [releaseWriteScope],
		},
		{
			description: "撤回自己的流水线执行申请。",
			effect: "WRITE" as const,
			id: "rehoboam.withdraw_execution_request@v3",
			inputSchema: {
				additionalProperties: false,
				properties: { releaseId: releaseIdSchema, requestId: requestIdSchema },
				required: ["releaseId", "requestId"],
				type: "object",
			},
			name: "rehoboam.withdraw_execution_request",
			requiredScopes: [releaseWriteScope],
		},
		{
			description: "拒绝流水线执行申请，必须提供原因。",
			effect: "WRITE" as const,
			id: "rehoboam.reject_execution_request@v3",
			inputSchema: {
				additionalProperties: false,
				properties: {
					releaseId: releaseIdSchema,
					requestId: requestIdSchema,
					reason: { minLength: 1, type: "string" },
				},
				required: ["releaseId", "requestId", "reason"],
				type: "object",
			},
			name: "rehoboam.reject_execution_request",
			requiredScopes: [releaseWriteScope],
		},
		{
			description: "列出指定版本流水线的运行记录。",
			effect: "READ" as const,
			id: "rehoboam.list_release_pipeline_runs@v3",
			inputSchema: {
				additionalProperties: false,
				properties: {
					releaseId: releaseIdSchema,
					cardId: cardIdSchema,
					page: { minimum: 1, type: "integer" },
					pageSize: { maximum: 20, minimum: 1, type: "integer" },
				},
				required: ["releaseId"],
				type: "object",
			},
			name: "rehoboam.list_release_pipeline_runs",
			requiredScopes: [releaseReadScope],
		},
		{
			description: "获取指定版本中的一次流水线运行结果。",
			effect: "READ" as const,
			id: "rehoboam.get_release_pipeline_run@v3",
			inputSchema: {
				additionalProperties: false,
				properties: {
					releaseId: releaseIdSchema,
					jobId: { minLength: 1, type: "string" },
				},
				required: ["releaseId", "jobId"],
				type: "object",
			},
			name: "rehoboam.get_release_pipeline_run",
			requiredScopes: [releaseReadScope],
		},
	],
	authProfile: {
		gatewayHeader: "apiKey",
		personalCredential: "bearer-token",
	},
	deploymentProfile: {
		apiOrigin,
		deployment: "company-managed",
		identity: "GET /api/connection/whoami",
		product: "Rehoboam",
	},
	executorDigest: rehoboamExecutorDigest,
	provider: providerId,
	providerReleaseId,
	sourceCommit: "connection-native",
} as const;

export class RehoboamAdapter
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

	async validateCredential(accessToken: string) {
		const identity = await this.getCurrentUser(accessToken);
		const providerScopes = Array.isArray(identity.scopes)
			? identity.scopes
			: [];
		const grantedScopes = [metadataScope];
		if (
			providerScopes.includes("release:read") ||
			providerScopes.includes("release:write")
		)
			grantedScopes.push(releaseReadScope);
		if (providerScopes.includes("release:write"))
			grantedScopes.push(releaseWriteScope);
		return {
			accessToken,
			displayName: identity.username,
			externalAccount: identity.user_id,
			grantedScopes,
			providerId,
			providerReleaseId,
		};
	}

	async execute(input: {
		action: string;
		credential: CredentialForExecution;
		input: Record<string, unknown>;
	}) {
		const token = input.credential.accessToken;
		if (!token) throw invalidCredential("Rehoboam token is required");
		if (input.action === "rehoboam.get_current_user")
			return this.getCurrentUser(token);
		return this.executeReleaseAction(input.action, input.input, token);
	}

	private executeReleaseAction(
		action: string,
		input: Record<string, unknown>,
		token: string,
	) {
		const authHeaders = { authorization: `Bearer ${token}` };
		if (action === "rehoboam.list_releases")
			return this.requestJson(
				withQuery("/mcp/v1/releases", {
					jira_id: input.jiraId,
					page: input.page,
					page_size: input.pageSize,
					status: input.status,
					title: input.title,
					version: input.version,
				}),
				{ headers: authHeaders },
			);
		if (action === "rehoboam.get_execution_request")
			return this.requestJson(
				`/mcp/v1/execution-requests/${encodeURIComponent(requiredString(input, "requestId"))}`,
				{ headers: authHeaders },
			);
		const releaseId = requiredString(input, "releaseId");
		const encodedRelease = encodeURIComponent(releaseId);
		const body = (value: Record<string, unknown>) => ({
			body: JSON.stringify(value),
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			method: "POST",
		});
		if (action === "rehoboam.get_release")
			return this.requestJson(
				`/mcp/v1/releases/${encodedRelease}/connection-summary`,
				{
					headers: authHeaders,
				},
			);
		if (action === "rehoboam.list_release_pipelines")
			return this.requestJson(`/mcp/v1/releases/${encodedRelease}/pipelines`, {
				headers: authHeaders,
			});
		if (action === "rehoboam.get_release_pipeline")
			return this.requestJson(
				`/mcp/v1/releases/${encodedRelease}/pipelines/${encodeURIComponent(requiredString(input, "cardId"))}`,
				{ headers: authHeaders },
			);
		if (
			action === "rehoboam.prepare_release_pipeline_run" ||
			action === "rehoboam.execute_release_pipeline"
		)
			return this.requestJson(
				`/mcp/v1/releases/${encodedRelease}/pipeline-runs${action.includes("prepare") ? "/preview" : ""}`,
				body({
					card_id: requiredString(input, "cardId"),
					params: input.params ?? {},
				}),
			);
		if (action === "rehoboam.list_execution_requests")
			return this.requestJson(
				withQuery(`/mcp/v1/releases/${encodedRelease}/execution-requests`, {
					approval_status: input.approvalStatus,
					page: input.page,
					page_size: input.pageSize,
				}),
				{ headers: authHeaders },
			);
		if (action === "rehoboam.list_release_pipeline_runs")
			return this.requestJson(
				withQuery(`/mcp/v1/releases/${encodedRelease}/pipeline-runs`, {
					card_id: input.cardId,
					page: input.page,
					page_size: input.pageSize,
				}),
				{ headers: authHeaders },
			);
		if (action === "rehoboam.get_release_pipeline_run")
			return this.requestJson(
				`/mcp/v1/releases/${encodedRelease}/pipeline-runs/${encodeURIComponent(requiredString(input, "jobId"))}`,
				{ headers: authHeaders },
			);
		const requestId = encodeURIComponent(requiredString(input, "requestId"));
		for (const verb of ["approve", "reject", "withdraw"] as const)
			if (action === `rehoboam.${verb}_execution_request`)
				return this.requestJson(
					`/mcp/v1/execution-requests/${requestId}/${verb}`,
					body({
						release_id: releaseId,
						...(verb === "reject"
							? { reject_reason: requiredString(input, "reason") }
							: {}),
					}),
				);
		throw providerError(`Unsupported Rehoboam action: ${action}`);
	}

	private async getCurrentUser(accessToken: string) {
		if (!accessToken) throw invalidCredential("Rehoboam token is required");
		const data = await this.requestJson("/api/connection/whoami", {
			headers: { authorization: `Bearer ${accessToken}` },
		});
		const userId = typeof data.user_id === "string" ? data.user_id : "";
		const username = typeof data.username === "string" ? data.username : "";
		const role = typeof data.role === "string" ? data.role : null;
		if (!userId || !username) {
			throw invalidCredential("Rehoboam identity is incomplete");
		}
		const scopes = Array.isArray(data.scopes)
			? data.scopes.filter(
					(scope): scope is string => typeof scope === "string",
				)
			: [];
		return { role, scopes, user_id: userId, username };
	}

	private async requestJson(path: string, init: RequestInit) {
		const response = await this.fetcher(new URL(path, apiOrigin), {
			...init,
			headers: {
				accept: "application/json",
				apiKey: this.gatewayApiKey,
				...init.headers,
			},
			redirect: "manual",
		});
		if (response.status === 401 || response.status === 403) {
			throw invalidCredential("Rehoboam credential was rejected");
		}
		if (response.status >= 300 && response.status < 400) {
			throw invalidCredential("Rehoboam gateway credential was rejected");
		}
		if (!response.ok) {
			throw providerError(
				`Rehoboam request failed with HTTP ${response.status}`,
			);
		}
		const text = await response.text();
		if (Buffer.byteLength(text) > maxResponseBytes) {
			throw providerError("Rehoboam response is too large");
		}
		let envelope: unknown;
		try {
			envelope = JSON.parse(text);
		} catch {
			throw providerError("Rehoboam returned invalid JSON");
		}
		const data =
			envelope && typeof envelope === "object" && "data" in envelope
				? (envelope.data as Record<string, unknown>)
				: undefined;
		if (!data) throw providerError("Rehoboam response is missing data");
		return data;
	}
}

function requiredString(input: Record<string, unknown>, field: string) {
	const value = input[field];
	if (typeof value !== "string" || !value)
		throw providerError(`${field} is required`);
	return value;
}

function withQuery(path: string, values: Record<string, unknown>) {
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(values))
		if (value !== undefined && value !== "") query.set(key, String(value));
	const suffix = query.toString();
	return suffix ? `${path}?${suffix}` : path;
}

function invalidCredential(message: string) {
	return Object.assign(new Error(message), { providerCredentialInvalid: true });
}

function providerError(message: string) {
	return Object.assign(new Error(message), { providerFailure: true });
}
