import type {
	CredentialForExecution,
	ProviderCredentialConnector,
	ProviderExecutor,
} from "@agent-infra/connection-core";
import { type Schema, Validator } from "@cfworker/json-schema";
import {
	RehoboamV12Adapter,
	rehoboamV12ConnectionCatalog,
	rehoboamV12LegacyProviderReleaseIds,
} from "./rehoboam-v12.ts";
import { rehoboamV13ExecutorDigest } from "./rehoboam-v13-integrity.ts";

const origin = rehoboamV12ConnectionCatalog.deploymentProfile.apiOrigin;
const prefix = "/api/v1/channel-publishing";
const system = { type: "string", const: "channel_publishing" };
const channel = {
	type: "string",
	enum: ["cdn", "maven", "cocoapods", "swiftpm", "npm"],
};
const taskId = { type: "string", pattern: "^[0-9a-f]{24}$" };
const text = { type: "string", minLength: 1, maxLength: 128 };
const key = {
	type: "string",
	minLength: 1,
	maxLength: 128,
	pattern: "^[!-~]+$",
};

function action(
	name: string,
	description: string,
	effect: "READ" | "WRITE",
	scope: "read" | "write" | "approve",
	properties: Record<string, unknown>,
	required: string[],
) {
	return {
		name: `rehoboam.${name}`,
		id: `rehoboam.${name}@v13`,
		description: `渠道发布 / Publishing（channel_publishing）；不属于 Pipeline Center。${description} 渠道发布不依赖版本记录，版本号只是参数；版本流程必须定位存在的版本记录及其任务，或先创建。未明确关联关系时，先 READ list_releases 查询完整版本号，再 get_release/list_release_pipelines 定位真实任务；问是否使用具体已有版本任务，还是独立渠道申请。未找到时询问独立申请还是先建版本，不自动回退；权限/超时/不完整查询不能称为版本不存在。不要让用户仅选择陌生系统名称，也不要仅凭有包链接或是否完整流程判断。`,
		effect,
		requiredScopes: [`rehoboam.publishing.${scope}`],
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				...properties,
				...(effect === "WRITE"
					? { releaseSystem: system, idempotencyKey: key }
					: {}),
			},
			required: [
				...required,
				...(effect === "WRITE" ? ["releaseSystem", "idempotencyKey"] : []),
			],
		},
	};
}

export const channelPublishingActions = [
	action(
		"list_channel_publish_requests",
		"查询本人申请或当前有权审批的任务；可按渠道、状态、版本、任务 ID 和本人申请筛选，返回分页及审批/运行状态。",
		"READ",
		"read",
		{
			channel,
			status: {
				type: "string",
				enum: [
					"NEW",
					"WAITING_IN_APPROVEMENT",
					"APPROVED",
					"REJECTED",
					"CANCELLED",
					"WAITING_IN_PROCESS",
					"RUNNING",
					"SUCCESS",
					"FAILURE",
					"ABORTED",
				],
			},
			version: text,
			requestKey: key,
			taskId,
			mine: { type: "boolean" },
			approvable: { type: "boolean" },
			offset: { type: "integer", minimum: 0, maximum: 10000 },
			limit: { type: "integer", minimum: 1, maximum: 20 },
		},
		[],
	),
	action(
		"get_channel_publish_request",
		"读取申请参数、申请人、审批意见/身份/时间及 Job/产物，超时或重复审批后用此查询最终状态。",
		"READ",
		"read",
		{ taskId },
		["taskId"],
	),
	action(
		"get_channel_publish_options",
		"读取 Rehoboam 当前 params_schema（字段、类型、必填、默认值和条件约束）、schema_revision 与表单选项。参数定义由 Rehoboam 拥有，填写申请前必须查询，不使用旧的固定参数列表。",
		"READ",
		"read",
		{ channel },
		["channel"],
	),
	action(
		"create_channel_publish_request",
		"申请 CDN/Maven/CocoaPods/SwiftPM/NPM 发布。先查询 get_channel_publish_options，按当前 params_schema 填写 params，并提供查询所得的 schemaRevision；执行时重新读取并校验服务端 schema，定义变化需重新预览。CDN 每文件独立调用、使用独立幂等键，并报告部分成功。沿用原审批规则，当前审批人本人申请可能直接获批并由原调度器继续发版；needNotification 控制发布结果订阅。",
		"WRITE",
		"write",
		{
			channel,
			schemaRevision: { type: "string", pattern: "^[0-9a-f]{64}$" },
			params: {
				type: "object",
				maxProperties: 100,
				additionalProperties: true,
			},
			needNotification: { type: "boolean" },
		},
		["channel", "params", "schemaRevision"],
	),
	action(
		"approve_channel_publish_request",
		"批准明确的待审批任务并通知申请人，后续由原调度器发版。必须具备当前审批资格及独立 publishing:approve PAT scope；只操作本系统。",
		"WRITE",
		"approve",
		{ taskId, comment: { type: "string", maxLength: 2000 } },
		["taskId"],
	),
	action(
		"reject_channel_publish_request",
		"驳回明确的待审批任务并通知申请人，不启动发布。必须具备当前审批资格及独立 publishing:approve PAT scope。",
		"WRITE",
		"approve",
		{ taskId, comment: { type: "string", maxLength: 2000 } },
		["taskId"],
	),
] as const;

export const rehoboamV13LegacyProviderReleaseIds = [
	"rehoboam-connection-v12",
	...rehoboamV12LegacyProviderReleaseIds,
] as const;
export const rehoboamV13ConnectionCatalog = {
	...rehoboamV12ConnectionCatalog,
	providerReleaseId: "rehoboam-connection-v13",
	sourceCommit: "connection-rehoboam-v13",
	executorDigest: rehoboamV13ExecutorDigest,
	actions: [
		...rehoboamV12ConnectionCatalog.actions.map((old) => ({
			...old,
			id: old.id.replace(/@v12$/, "@v13"),
			description:
				old.name === "rehoboam.get_current_user"
					? old.description
					: `流水线发布 / Pipeline Center（pipeline_center）及其管理能力；不是 Publishing 渠道发布申请。${old.description}`,
		})),
		...channelPublishingActions,
	],
} as const;

function failure(message: string, details: Record<string, unknown> = {}) {
	return Object.assign(new Error(message), { providerError: true, ...details });
}

export class RehoboamV13Adapter
	implements ProviderCredentialConnector, ProviderExecutor
{
	readonly providerId = "rehoboam";
	readonly providerReleaseId = "rehoboam-connection-v13";
	private readonly previous: RehoboamV12Adapter;
	private readonly fetcher: typeof fetch;
	private readonly gatewayApiKey: string;
	constructor(fetcher: typeof fetch, gatewayApiKey: string) {
		this.fetcher = fetcher;
		this.gatewayApiKey = gatewayApiKey;
		this.previous = new RehoboamV12Adapter(fetcher, gatewayApiKey);
	}
	async validateCredential(accessToken: string) {
		const envelope = await this.request(
			"/api/connection/whoami",
			accessToken,
			{ method: "GET" },
			false,
		);
		const identity = envelope.data as Record<string, unknown> | undefined;
		if (
			typeof identity?.user_id !== "string" ||
			!identity.user_id ||
			typeof identity.username !== "string" ||
			!identity.username
		)
			throw failure("Rehoboam identity is incomplete", {
				providerCredentialInvalid: true,
			});
		const scopes = Array.isArray(identity.scopes) ? identity.scopes : [];
		const grantedScopes = ["rehoboam.metadata.read"];
		for (const resource of ["release", "publishing"]) {
			if (
				scopes.includes(`${resource}:read`) ||
				scopes.includes(`${resource}:write`) ||
				(resource === "publishing" && scopes.includes("publishing:approve"))
			)
				grantedScopes.push(`rehoboam.${resource}.read`);
			if (scopes.includes(`${resource}:write`))
				grantedScopes.push(`rehoboam.${resource}.write`);
		}
		if (scopes.includes("publishing:approve"))
			grantedScopes.push("rehoboam.publishing.approve");
		return {
			accessToken,
			displayName: identity.username,
			externalAccount: identity.user_id,
			grantedScopes,
			providerId: this.providerId,
			providerReleaseId: this.providerReleaseId,
		};
	}
	async execute(input: {
		action: string;
		credential: CredentialForExecution;
		input: Record<string, unknown>;
	}) {
		const found = channelPublishingActions.find(
			(item) => item.name === input.action,
		);
		if (!found) return this.previous.execute(input);
		if (
			!new Validator(found.inputSchema as Schema, "2020-12", false).validate(
				input.input,
			).valid
		)
			throw failure("Invalid channel publishing input", {
				providerStatus: 400,
				providerSubmissionOutcome: "rejected",
			});
		const data = input.input;
		let schemaRevision: string | undefined;
		if (found.name === "rehoboam.create_channel_publish_request") {
			try {
				const options = await this.request(
					`${prefix}/options/${data.channel}`,
					input.credential.accessToken,
					{ method: "GET" },
					false,
				);
				const schema = options.params_schema;
				if (
					options.release_system !== "channel_publishing" ||
					options.channel !== data.channel ||
					!schema ||
					typeof schema !== "object" ||
					Array.isArray(schema) ||
					!("type" in schema) ||
					schema.type !== "object" ||
					!("additionalProperties" in schema) ||
					schema.additionalProperties !== false ||
					typeof options.schema_revision !== "string" ||
					!/^[0-9a-f]{64}$/.test(options.schema_revision)
				) {
					throw new Error("Invalid parameter schema");
				}
				if (options.schema_revision !== data.schemaRevision)
					throw failure("Parameter schema changed after discovery", {
						providerStatus: 409,
						providerCode: "PARAMETER_SCHEMA_CHANGED",
					});
				if (
					!new Validator(schema as Schema, "2020-12", false).validate(
						data.params,
					).valid
				)
					throw new Error("Parameters do not match current schema");
				schemaRevision = options.schema_revision;
			} catch (error) {
				throw failure(
					"Rehoboam parameter schema could not be loaded or parameters were rejected; no request was submitted",
					{
						providerSubmissionOutcome: "rejected",
						providerStatus:
							error && typeof error === "object" && "providerStatus" in error
								? error.providerStatus
								: 400,
						providerCode:
							error && typeof error === "object" && "providerCode" in error
								? error.providerCode
								: undefined,
					},
				);
			}
		}
		let path: string;
		let init: RequestInit = { method: "GET" };
		const write = found.effect === "WRITE";
		if (found.name === "rehoboam.get_channel_publish_options")
			path = `${prefix}/options/${data.channel}`;
		else if (found.name === "rehoboam.list_channel_publish_requests") {
			const query = new URLSearchParams();
			for (const [name, value] of Object.entries(data))
				query.set(
					name === "taskId"
						? "task_id"
						: name === "requestKey"
							? "request_key"
							: name,
					String(value),
				);
			path = `${prefix}/requests?${query}`;
		} else if (found.name === "rehoboam.get_channel_publish_request")
			path = `${prefix}/requests/${data.taskId}`;
		else {
			path =
				found.name === "rehoboam.create_channel_publish_request"
					? `${prefix}/requests`
					: `${prefix}/requests/${data.taskId}/approval`;
			const body =
				found.name === "rehoboam.create_channel_publish_request"
					? {
							release_system: data.releaseSystem,
							channel: data.channel,
							params: data.params,
							need_notification: data.needNotification ?? true,
							schema_revision: schemaRevision,
						}
					: {
							release_system: data.releaseSystem,
							decision:
								found.name === "rehoboam.approve_channel_publish_request"
									? "APPROVED"
									: "REJECTED",
							comment: data.comment ?? "",
						};
			init = {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"Idempotency-Key": String(data.idempotencyKey),
				},
				body: JSON.stringify(body),
			};
			if (Buffer.byteLength(String(init.body)) > 32768)
				throw failure("Channel publishing input is too large", {
					providerStatus: 400,
					providerSubmissionOutcome: "rejected",
				});
		}
		const result = await this.request(
			path,
			input.credential.accessToken,
			init,
			write,
		);
		if (result.release_system !== "channel_publishing")
			throw failure("Channel publishing response has the wrong system", {
				...(write ? { submissionUncertain: true } : {}),
			});
		return result;
	}
	private async request(
		path: string,
		token: string,
		init: RequestInit,
		write: boolean,
	): Promise<Record<string, unknown>> {
		if (!token)
			throw failure("Rehoboam token is required", {
				providerCredentialInvalid: true,
				providerStatus: 401,
				providerSubmissionOutcome: "rejected",
			});
		let response: Response;
		try {
			response = await this.fetcher(new URL(path, origin), {
				...init,
				redirect: "manual",
				headers: {
					accept: "application/json",
					apiKey: this.gatewayApiKey,
					authorization: `Bearer ${token}`,
					...init.headers,
				},
			});
		} catch {
			throw failure(
				"Rehoboam transport failed; query the task before retrying",
				{ ...(write ? { submissionUncertain: true } : {}) },
			);
		}
		if (response.status >= 300 && response.status < 400)
			throw failure("Rehoboam gateway rejected the request", {
				providerStatus: 401,
				providerSubmissionOutcome: "rejected",
			});
		let envelope: Record<string, unknown>;
		try {
			const raw = await response.text();
			if (Buffer.byteLength(raw) > 65536) throw new Error("size");
			envelope = JSON.parse(raw);
			if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
				throw new Error("shape");
		} catch {
			throw failure("Rehoboam returned an invalid or oversized response", {
				providerStatus: response.status,
				...(write ? { submissionUncertain: true } : {}),
			});
		}
		if (!response.ok) {
			const code =
				envelope.error &&
				typeof envelope.error === "object" &&
				"code" in envelope.error
					? envelope.error.code
					: undefined;
			throw failure("Rehoboam channel publishing request failed", {
				providerStatus: response.status,
				providerCode: typeof code === "string" ? code : undefined,
				...(response.status < 500
					? { providerSubmissionOutcome: "rejected" }
					: write
						? { submissionUncertain: true }
						: {}),
			});
		}
		return envelope;
	}
}
