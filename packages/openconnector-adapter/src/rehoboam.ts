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
const providerReleaseId = "rehoboam-connection-v9";
export const rehoboamLegacyProviderReleaseIds = [
	"rehoboam-connection-v8",
	"rehoboam-connection-v4",
	"rehoboam-connection-v5",
	"rehoboam-connection-v6",
	"rehoboam-connection-v7",
] as const;

const releaseIdSchema = { minLength: 1, type: "string" } as const;
const cardIdSchema = { minLength: 1, type: "string" } as const;
const requestIdSchema = { minLength: 1, type: "string" } as const;

const familyIdSchema = {
	minLength: 1,
	maxLength: 128,
	type: "string",
} as const;
const objectSchema = { type: "object", maxProperties: 100 } as const;
const taskProperties = {
	familyId: familyIdSchema,
	memberId: familyIdSchema,
	taskId: familyIdSchema,
};
const taskOptions = {
	params: objectSchema,
	upstreamResults: objectSchema,
	composedUpstreams: objectSchema,
	selectedCardIds: { type: "array", maxItems: 32, items: familyIdSchema },
	selectionReason: { type: "string", maxLength: 4000 },
	approvalExecutionModes: objectSchema,
	batchItems: { type: "array", maxItems: 32, items: objectSchema },
};
function familyAction(
	name: string,
	description: string,
	effect: "READ" | "WRITE",
	properties: Record<string, unknown>,
	required: string[],
) {
	return {
		name: `rehoboam.${name}`,
		id: `rehoboam.${name}@v9`,
		description,
		effect,
		requiredScopes: [effect === "READ" ? releaseReadScope : releaseWriteScope],
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				...properties,
				...(effect === "WRITE" ? { idempotencyKey: familyIdSchema } : {}),
			},
			required: [
				...required,
				...(effect === "WRITE" ? ["idempotencyKey"] : []),
			],
		},
	};
}
const releaseFamilyActions = [
	familyAction(
		"preview_release_family_notice",
		"预览当前提测/交付节点的内容、Jira 与收件人，不发送通知。",
		"READ",
		{
			...taskProperties,
			kind: { type: "string", enum: ["test", "release"] },
			content: { type: "string", minLength: 1, maxLength: 20000 },
			jiraTransitionSubmission: objectSchema,
		},
		["familyId", "memberId", "taskId", "kind", "content"],
	),
	familyAction(
		"submit_release_family_notice",
		"确认同一内容与收件人后复用版本提测/发布服务；结果不确定时禁止盲目重试。",
		"WRITE",
		{
			...taskProperties,
			kind: { type: "string", enum: ["test", "release"] },
			content: { type: "string", minLength: 1, maxLength: 20000 },
			jiraTransitionSubmission: objectSchema,
			expectedRevision: { type: "integer", minimum: 0 },
			templateSignature: familyIdSchema,
			noticeFingerprint: familyIdSchema,
		},
		[
			"familyId",
			"memberId",
			"taskId",
			"kind",
			"content",
			"expectedRevision",
			"templateSignature",
			"noticeFingerprint",
		],
	),
	familyAction(
		"get_release_family_upstream_results",
		"分页/分段读取当前任务允许的上游结果，含 profile、平台与结果 hash；不查询任意 Job。",
		"READ",
		{
			...taskProperties,
			cardId: familyIdSchema,
			sourceCardId: familyIdSchema,
			resultIndex: { type: "integer", minimum: 0 },
			page: { type: "integer", minimum: 1 },
			offset: { type: "integer", minimum: 0 },
		},
		["familyId", "memberId", "taskId", "cardId"],
	),
	familyAction(
		"list_release_family_templates",
		"发现可用发布套件、平台模板及 Native 分析来源。",
		"READ",
		{ suite: familyIdSchema, page: { type: "integer", minimum: 1 } },
		[],
	),
	familyAction(
		"get_release_family_timeline",
		"分页读取发布族最近200条操作记录，不包含完整任务快照。",
		"READ",
		{
			familyId: familyIdSchema,
			page: { type: "integer", minimum: 1, maximum: 20 },
		},
		["familyId"],
	),
	familyAction(
		"preview_release_family_pr",
		"按当前成员仓库、分支与权限只读核验 PR 合并证据。",
		"READ",
		{ ...taskProperties, prUrl: { type: "string", maxLength: 2048 } },
		["familyId", "memberId", "taskId", "prUrl"],
	),
	familyAction(
		"confirm_release_family_pr",
		"重新核验 PR 后记录证据并推进任务；不合并 PR、不运行 Job。",
		"WRITE",
		{
			...taskProperties,
			prUrl: { type: "string", maxLength: 2048 },
			expectedRevision: { type: "integer", minimum: 0 },
			templateSignature: familyIdSchema,
		},
		[
			"familyId",
			"memberId",
			"taskId",
			"prUrl",
			"expectedRevision",
			"templateSignature",
		],
	),
	familyAction(
		"list_release_families",
		"分页查询发布族，可按标题、版本、Jira、归档状态筛选。",
		"READ",
		{
			page: { type: "integer", minimum: 1 },
			pageSize: { type: "integer", enum: [10, 20, 50] },
			title: { type: "string" },
			version: { type: "string" },
			jiraId: { type: "string" },
			status: { type: "string", enum: ["active", "archived"] },
		},
		[],
	),
	familyAction(
		"get_release_family",
		"读取发布族成员、当前任务和模板规则；Job/审批详情使用成员版本工具。",
		"READ",
		{ familyId: familyIdSchema },
		["familyId"],
	),
	familyAction(
		"preview_release_family",
		"保存发布族创建/追加草案并返回预览和确认凭据；不创建版本、不运行 Job。",
		"WRITE",
		{
			members: {
				type: "array",
				minItems: 1,
				maxItems: 6,
				items: {
					type: "object",
					additionalProperties: false,
					required: ["framework"],
					properties: {
						framework: {
							type: "string",
							enum: [
								"native",
								"iris",
								"electron",
								"react-native",
								"flutter",
								"unity",
							],
						},
						releaseId: familyIdSchema,
						newRelease: {
							type: "object",
							additionalProperties: false,
							required: ["title", "version", "baseBranch", "targetBranch"],
							properties: {
								title: { type: "string" },
								version: { type: "string" },
								baseVersion: { type: "string" },
								baseBranch: { type: "string" },
								targetBranch: { type: "string" },
								notifications: {
									type: "object",
									additionalProperties: false,
									properties: {
										requestUser: { type: "string", maxLength: 256 },
										ccEmailList: {
											type: "array",
											maxItems: 100,
											items: { type: "string", maxLength: 256 },
										},
										otherEmailList: {
											type: "array",
											maxItems: 100,
											items: { type: "string", maxLength: 256 },
										},
									},
								},
							},
						},
					},
				},
			},
			suite: familyIdSchema,
			jiraId: familyIdSchema,
			apiStatus: { type: "string", enum: ["changed", "unchanged", "unknown"] },
			note: { type: "string", minLength: 1, maxLength: 4000 },
			familyId: familyIdSchema,
			familyRevision: { type: "integer", minimum: 0 },
			replacesMemberId: familyIdSchema,
		},
		["members", "suite", "jiraId", "apiStatus", "note"],
	),
	familyAction(
		"confirm_release_family",
		"用户确认预览后准备幂等创建/追加操作；不运行 Job。",
		"WRITE",
		{
			draftId: familyIdSchema,
			draftRevision: { type: "integer", minimum: 0 },
			confirmationToken: { type: "string", minLength: 1 },
		},
		["draftId", "draftRevision", "confirmationToken"],
	),
	familyAction(
		"get_release_family_operation",
		"读取本人发布族创建/追加操作及成员回执。",
		"READ",
		{ operationId: familyIdSchema },
		["operationId"],
	),
	familyAction(
		"preview_release_family_plans",
		"只读预览缺失成员执行计划及当前模板签名。",
		"READ",
		{ familyId: familyIdSchema },
		["familyId"],
	),
	familyAction(
		"initialize_release_family_plans",
		"确认当前签名后初始化缺失成员流程，不运行 Job。",
		"WRITE",
		{
			familyId: familyIdSchema,
			expectedRevision: { type: "integer", minimum: 0 },
			templateSignatures: objectSchema,
		},
		["familyId", "expectedRevision", "templateSignatures"],
	),
	familyAction(
		"preview_release_family_task",
		"只读预览任务 Job、上游组合、参数缺失和当前执行权限。",
		"READ",
		{ ...taskProperties, ...taskOptions },
		["familyId", "memberId", "taskId"],
	),
	familyAction(
		"start_release_family_task",
		"确认最新任务预览后按逐 Job 实际权限运行或提交审批。",
		"WRITE",
		{
			...taskProperties,
			...taskOptions,
			expectedRevision: { type: "integer", minimum: 0 },
			templateSignature: familyIdSchema,
			executionActions: objectSchema,
		},
		[
			"familyId",
			"memberId",
			"taskId",
			"expectedRevision",
			"templateSignature",
			"executionActions",
		],
	),
	familyAction(
		"record_release_family_task",
		"手动推进、跳过或记录外部完成；复用负责人、依据和系统证据规则。",
		"WRITE",
		{
			...taskProperties,
			expectedRevision: { type: "integer", minimum: 0 },
			templateSignature: familyIdSchema,
			disposition: {
				type: "string",
				enum: ["advanced", "skipped", "external_completed", "not_applicable"],
			},
			note: { type: "string", maxLength: 4000 },
		},
		[
			"familyId",
			"memberId",
			"taskId",
			"expectedRevision",
			"templateSignature",
			"disposition",
		],
	),
	familyAction(
		"preview_restore_release_family_task",
		"只读预览恢复任务的影响范围。",
		"READ",
		taskProperties,
		["familyId", "memberId", "taskId"],
	),
	familyAction(
		"restore_release_family_task",
		"确认当前 revision 和模板签名后恢复任务，不运行 Job。",
		"WRITE",
		{
			...taskProperties,
			expectedRevision: { type: "integer", minimum: 0 },
			templateSignature: familyIdSchema,
		},
		["familyId", "memberId", "taskId", "expectedRevision", "templateSignature"],
	),
];

export const rehoboamConnectionCatalog = {
	actions: [
		...releaseFamilyActions,
		{
			description: "获取当前通过 Rehoboam 个人 Token 鉴权的用户。",
			effect: "READ" as const,
			id: "rehoboam.get_current_user@v9",
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
			id: "rehoboam.list_releases@v9",
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
			id: "rehoboam.get_release@v9",
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
			description:
				"按字符游标读取指定版本最新的发布结果；时间戳必须与版本详情一致。",
			effect: "READ" as const,
			id: "rehoboam.get_release_result@v9",
			inputSchema: {
				additionalProperties: false,
				properties: {
					releaseId: releaseIdSchema,
					releaseInfoTime: { minimum: 0, type: "integer" },
					offset: { minimum: 0, type: "integer" },
				},
				required: ["releaseId", "releaseInfoTime"],
				type: "object",
			},
			name: "rehoboam.get_release_result",
			requiredScopes: [releaseReadScope],
		},
		{
			description: "列出指定版本拥有的流水线。",
			effect: "READ" as const,
			id: "rehoboam.list_release_pipelines@v9",
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
			id: "rehoboam.get_release_pipeline@v9",
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
			id: "rehoboam.prepare_release_pipeline_run@v9",
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
			id: "rehoboam.execute_release_pipeline@v9",
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
			id: "rehoboam.list_execution_requests@v9",
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
			id: "rehoboam.get_execution_request@v9",
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
			id: "rehoboam.approve_execution_request@v9",
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
			id: "rehoboam.withdraw_execution_request@v9",
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
			id: "rehoboam.reject_execution_request@v9",
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
			id: "rehoboam.list_release_pipeline_runs@v9",
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
			id: "rehoboam.get_release_pipeline_run@v9",
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
		if (releaseFamilyActions.some((action) => action.name === input.action))
			return this.executeFamilyAction(input.action, input.input, token);
		return this.executeReleaseAction(input.action, input.input, token);
	}

	private executeFamilyAction(
		action: string,
		input: Record<string, unknown>,
		token: string,
	) {
		const prefix = "/mcp/v1/release-families";
		const name = action.slice("rehoboam.".length);
		const post = (path: string, body: Record<string, unknown>) =>
			this.requestJson(prefix + path, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			});
		const get = (path: string) =>
			this.requestJson(prefix + path, {
				headers: { authorization: `Bearer ${token}` },
			});
		if (name === "list_release_family_templates")
			return get(
				withQuery("/templates", { suite: input.suite, page: input.page }),
			);
		if (name === "get_release_family_timeline")
			return get(
				withQuery(
					`/${encodeURIComponent(requiredString(input, "familyId"))}/timeline`,
					{ page: input.page },
				),
			);
		if (name === "list_release_families")
			return get(
				withQuery("", {
					page: input.page,
					page_size: input.pageSize,
					title: input.title,
					version: input.version,
					jira_id: input.jiraId,
					status: input.status,
				}),
			);
		if (name === "get_release_family_operation")
			return get(
				`/operations/${encodeURIComponent(requiredString(input, "operationId"))}`,
			);
		if (name === "preview_release_family") {
			const members = input.members as Array<Record<string, unknown>>;
			return post("/preview", {
				members: members.map((member) => {
					const creation = member.newRelease as
						| Record<string, unknown>
						| undefined;
					const notifications = creation?.notifications as
						| Record<string, unknown>
						| undefined;
					return {
						framework: member.framework,
						...(member.releaseId ? { release_id: member.releaseId } : {}),
						...(creation
							? {
									new_release: {
										title: creation.title,
										version: creation.version,
										base_version: creation.baseVersion,
										base_branch: creation.baseBranch,
										target_branch: creation.targetBranch,
										...(notifications
											? {
													notifications: {
														request_user: notifications.requestUser,
														cc_email_list: notifications.ccEmailList,
														other_email_list: notifications.otherEmailList,
													},
												}
											: {}),
									},
								}
							: {}),
					};
				}),
				suite: input.suite,
				jira_id: input.jiraId,
				api_status: input.apiStatus,
				note: input.note,
				family_id: input.familyId,
				family_revision: input.familyRevision,
				replaces_member_id: input.replacesMemberId,
			});
		}
		if (name === "confirm_release_family")
			return post("/confirm", {
				draft_id: input.draftId,
				draft_revision: input.draftRevision,
				confirmation_token: input.confirmationToken,
			});
		const family = `/${encodeURIComponent(requiredString(input, "familyId"))}`;
		if (name === "get_release_family") return get(family);
		if (name === "preview_release_family_plans")
			return post(`${family}/plans/preview`, {});
		if (name === "initialize_release_family_plans")
			return post(`${family}/plans`, {
				expected_revision: input.expectedRevision,
				template_signatures: input.templateSignatures,
			});
		const task = `${family}/members/${encodeURIComponent(requiredString(input, "memberId"))}/tasks/${encodeURIComponent(requiredString(input, "taskId"))}`;
		if (name === "get_release_family_upstream_results")
			return get(
				withQuery(`${task}/upstream-results`, {
					card_id: requiredString(input, "cardId"),
					source_card_id: input.sourceCardId,
					result_index: input.resultIndex,
					page: input.page,
					offset: input.offset,
				}),
			);
		const bodies = {
			preview_release_family_notice: {
				path: "/notice-preview",
				body: {
					kind: input.kind,
					content: input.content,
					jira_transition_submission: input.jiraTransitionSubmission,
				},
			},
			submit_release_family_notice: {
				path: "/notice",
				body: {
					kind: input.kind,
					content: input.content,
					jira_transition_submission: input.jiraTransitionSubmission,
					expected_revision: input.expectedRevision,
					template_signature: input.templateSignature,
					notice_fingerprint: input.noticeFingerprint,
				},
			},
			preview_release_family_pr: {
				path: "/pr-preview",
				body: { pr_url: input.prUrl },
			},
			confirm_release_family_pr: {
				path: "/pr-confirm",
				body: {
					pr_url: input.prUrl,
					expected_revision: input.expectedRevision,
					template_signature: input.templateSignature,
				},
			},
			preview_release_family_task: {
				path: "/preview",
				body: {
					params: input.params,
					upstream_results: input.upstreamResults,
					composed_upstreams: input.composedUpstreams,
					selected_card_ids: input.selectedCardIds,
					selection_reason: input.selectionReason,
					approval_execution_modes: input.approvalExecutionModes,
					batch_items: input.batchItems,
				},
			},
			start_release_family_task: {
				path: "/start",
				body: {
					params: input.params,
					upstream_results: input.upstreamResults,
					composed_upstreams: input.composedUpstreams,
					selected_card_ids: input.selectedCardIds,
					selection_reason: input.selectionReason,
					approval_execution_modes: input.approvalExecutionModes,
					batch_items: input.batchItems,
					expected_revision: input.expectedRevision,
					template_signature: input.templateSignature,
					execution_actions: input.executionActions,
				},
			},
			record_release_family_task: {
				path: "/record",
				body: {
					expected_revision: input.expectedRevision,
					template_signature: input.templateSignature,
					disposition: input.disposition,
					note: input.note,
				},
			},
			preview_restore_release_family_task: {
				path: "/restore-preview",
				body: {},
			},
			restore_release_family_task: {
				path: "/restore",
				body: {
					expected_revision: input.expectedRevision,
					template_signature: input.templateSignature,
				},
			},
		};
		const operation = bodies[name as keyof typeof bodies];
		if (!operation)
			throw providerError(`Unsupported Rehoboam family action: ${action}`);
		return post(task + operation.path, operation.body);
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
		if (action === "rehoboam.get_release_result") {
			const time = input.releaseInfoTime;
			const offset = input.offset ?? 0;
			if (
				!Number.isSafeInteger(time) ||
				Number(time) < 0 ||
				!Number.isSafeInteger(offset) ||
				Number(offset) < 0
			)
				throw providerError("Invalid release result cursor");
			return this.requestJson(
				withQuery(
					`/mcp/v1/releases/${encodedRelease}/connection-release-result`,
					{
						time,
						offset,
					},
				),
				{ headers: authHeaders },
			);
		}
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
		if (response.status >= 300 && response.status < 400) {
			throw invalidCredential("Rehoboam gateway credential was rejected");
		}
		const text = await response.text();
		if (Buffer.byteLength(text) > maxResponseBytes) {
			throw providerError("Rehoboam response is too large", {
				providerStatus: response.status,
			});
		}
		const envelope = parseEnvelope(text);
		const provider = envelopeError(envelope);
		if (
			response.status === 401 ||
			(response.status === 403 &&
				!["authorization_failed", "FORBIDDEN", "MCP_ACCESS_DISABLED"].includes(
					provider.code || "",
				))
		) {
			throw invalidCredential("Rehoboam credential was rejected");
		}
		if (!response.ok) {
			throw providerError(
				provider.message ??
					`Rehoboam request failed with HTTP ${response.status}`,
				{
					providerCode: provider.code,
					providerDetails: provider.details,
					providerMessage: provider.message,
					providerRetryable: provider.retryable,
					providerStatus: response.status,
					providerSubmissionOutcome: provider.submissionOutcome,
					...(provider.submissionOutcome === "accepted" ||
					provider.submissionOutcome === "uncertain"
						? { submissionUncertain: true }
						: {}),
				},
			);
		}
		if (envelope === undefined)
			throw providerError("Rehoboam returned invalid JSON", {
				providerStatus: response.status,
			});
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

function parseEnvelope(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function envelopeError(envelope: unknown) {
	const error =
		envelope && typeof envelope === "object" && "error" in envelope
			? (envelope.error as Record<string, unknown> | null)
			: null;
	return {
		code: typeof error?.code === "string" ? error.code : undefined,
		details:
			error?.details && typeof error.details === "object"
				? error.details
				: undefined,
		message: typeof error?.message === "string" ? error.message : undefined,
		retryable:
			typeof error?.retryable === "boolean" ? error.retryable : undefined,
		submissionOutcome:
			error?.submission_outcome === "accepted" ||
			error?.submission_outcome === "rejected" ||
			error?.submission_outcome === "uncertain"
				? error.submission_outcome
				: undefined,
	};
}

function providerError(message: string, details: Record<string, unknown> = {}) {
	return Object.assign(new Error(message), {
		providerFailure: true,
		...details,
	});
}
