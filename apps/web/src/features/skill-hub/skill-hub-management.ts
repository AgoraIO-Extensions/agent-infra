import {
	SkillHubAgentBindingStatusResponseV1Schema,
	SkillHubProjectPageV1Schema,
	SkillHubPublicationResponseV1Schema,
} from "@agent-infra/contracts/pilot";
import type {
	Client,
	RequestResult,
} from "../../pilot/generated-v2/client/index.js";
import {
	bindSkillHubAgentVersionV1,
	createSkillHubProjectV1,
	importSkillHubVersionV1,
	listSkillHubProjectsV1,
	publishSkillHubVersionV1,
	readSkillHubAgentBindingsV1,
	reviewSkillHubVersionV1,
	revokeSkillHubVersionV1,
	updateSkillHubProjectV1,
} from "../../pilot/generated-v2/sdk.gen.js";
import type {
	BindSkillHubAgentVersionV1Errors,
	BindSkillHubAgentVersionV1Responses,
	CreateSkillHubProjectV1Errors,
	CreateSkillHubProjectV1Responses,
	ImportSkillHubVersionV1Errors,
	ImportSkillHubVersionV1Responses,
	ListSkillHubProjectsV1Errors,
	ListSkillHubProjectsV1Responses,
	PublishSkillHubVersionV1Data,
	PublishSkillHubVersionV1Errors,
	PublishSkillHubVersionV1Responses,
	ReadSkillHubAgentBindingsV1Errors,
	ReadSkillHubAgentBindingsV1Responses,
	ReviewSkillHubVersionV1Errors,
	ReviewSkillHubVersionV1Responses,
	RevokeSkillHubVersionV1Errors,
	RevokeSkillHubVersionV1Responses,
	SkillHubAgentBindingCommandV1,
	SkillHubProjectCreateV1,
	SkillHubProjectPageV1,
	SkillHubProviderImportRequestV1,
	SkillHubReviewRequestV1,
	UpdateSkillHubProjectV1Errors,
	UpdateSkillHubProjectV1Responses,
} from "../../pilot/generated-v2/types.gen.js";

export type SkillHubManagementRequestError = Error & {
	code?: string;
	retryable: boolean;
	status?: number;
};

function requestError(
	message: string,
	result: {
		error?: { code?: string; retryable?: boolean };
		response?: Response;
	},
): SkillHubManagementRequestError {
	const error = new Error(message) as SkillHubManagementRequestError;
	error.code = result.error?.code;
	error.retryable = result.error?.retryable !== false;
	error.status = result.response?.status;
	return error;
}

function requireData<T>(
	message: string,
	result: {
		data?: T;
		error?: { code?: string; retryable?: boolean };
		response?: Response;
	},
): T {
	if (result.data !== undefined) return result.data;
	throw requestError(message, result);
}

export async function listSkillHubProjects(
	client?: Client,
): Promise<SkillHubProjectPageV1> {
	const result: Awaited<
		RequestResult<
			ListSkillHubProjectsV1Responses,
			ListSkillHubProjectsV1Errors,
			false
		>
	> = await listSkillHubProjectsV1({
		client,
		responseStyle: "fields",
		throwOnError: false,
	});
	const data = requireData("项目列表暂时无法读取。", result);
	const parsed = SkillHubProjectPageV1Schema.safeParse(data);
	if (!parsed.success) throw requestError("项目列表响应无效。", result);
	return parsed.data;
}

export async function createSkillHubProject(
	body: SkillHubProjectCreateV1,
	idempotencyKey: string,
	client?: Client,
) {
	const result: Awaited<
		RequestResult<
			CreateSkillHubProjectV1Responses,
			CreateSkillHubProjectV1Errors,
			false
		>
	> = await createSkillHubProjectV1({
		client,
		body,
		headers: { "Idempotency-Key": idempotencyKey },
		responseStyle: "fields",
		throwOnError: false,
	});
	return requireData("项目创建失败。", result);
}

export async function updateSkillHubProject(
	projectId: string,
	body: Parameters<typeof updateSkillHubProjectV1>[0]["body"],
	idempotencyKey: string,
	client?: Client,
) {
	const result: Awaited<
		RequestResult<
			UpdateSkillHubProjectV1Responses,
			UpdateSkillHubProjectV1Errors,
			false
		>
	> = await updateSkillHubProjectV1({
		client,
		path: { projectId },
		body,
		headers: { "Idempotency-Key": idempotencyKey },
		responseStyle: "fields",
		throwOnError: false,
	});
	return requireData("项目更新失败。", result);
}

export async function importSkillHubVersion(
	body: SkillHubProviderImportRequestV1,
	idempotencyKey: string,
	client?: Client,
) {
	const result: Awaited<
		RequestResult<
			ImportSkillHubVersionV1Responses,
			ImportSkillHubVersionV1Errors,
			false
		>
	> = await importSkillHubVersionV1({
		client,
		body,
		headers: { "Idempotency-Key": idempotencyKey },
		responseStyle: "fields",
		throwOnError: false,
	});
	const data = requireData("Skill 导入失败。", result);
	const parsed = SkillHubPublicationResponseV1Schema.safeParse(data);
	if (!parsed.success) throw requestError("导入响应无效。", result);
	return parsed.data;
}

export async function publishSkillHubVersion(
	body: PublishSkillHubVersionV1Data["body"],
	idempotencyKey: string,
	client?: Client,
) {
	const result: Awaited<
		RequestResult<
			PublishSkillHubVersionV1Responses,
			PublishSkillHubVersionV1Errors,
			false
		>
	> = await publishSkillHubVersionV1({
		client,
		body,
		headers: { "Idempotency-Key": idempotencyKey },
		responseStyle: "fields",
		throwOnError: false,
	});
	const data = requireData("版本发布失败。", result);
	const parsed = SkillHubPublicationResponseV1Schema.safeParse(data);
	if (!parsed.success) throw requestError("发布响应无效。", result);
	return parsed.data;
}

export async function reviewSkillHubVersion(
	skillVersionId: string,
	body: SkillHubReviewRequestV1,
	idempotencyKey: string,
	client?: Client,
) {
	const result: Awaited<
		RequestResult<
			ReviewSkillHubVersionV1Responses,
			ReviewSkillHubVersionV1Errors,
			false
		>
	> = await reviewSkillHubVersionV1({
		client,
		path: { skillVersionId },
		body,
		headers: { "Idempotency-Key": idempotencyKey },
		responseStyle: "fields",
		throwOnError: false,
	});
	const data = requireData("审核操作失败。", result);
	const parsed = SkillHubPublicationResponseV1Schema.safeParse(data);
	if (!parsed.success) throw requestError("审核响应无效。", result);
	return parsed.data;
}

export async function revokeSkillHubVersion(
	skillVersionId: string,
	idempotencyKey: string,
	client?: Client,
) {
	const result: Awaited<
		RequestResult<
			RevokeSkillHubVersionV1Responses,
			RevokeSkillHubVersionV1Errors,
			false
		>
	> = await revokeSkillHubVersionV1({
		client,
		path: { skillVersionId },
		headers: { "Idempotency-Key": idempotencyKey },
		responseStyle: "fields",
		throwOnError: false,
	});
	const data = requireData("撤销版本失败。", result);
	const parsed = SkillHubPublicationResponseV1Schema.safeParse(data);
	if (!parsed.success) throw requestError("撤销响应无效。", result);
	return parsed.data;
}

export async function readSkillHubAgentBindings(
	agentId: string,
	agentVersion: string,
	client?: Client,
) {
	const result: Awaited<
		RequestResult<
			ReadSkillHubAgentBindingsV1Responses,
			ReadSkillHubAgentBindingsV1Errors,
			false
		>
	> = await readSkillHubAgentBindingsV1({
		client,
		path: { agentId, agentVersion },
		responseStyle: "fields",
		throwOnError: false,
	});
	const data = requireData("Agent Skill 状态暂时无法读取。", result);
	const parsed = SkillHubAgentBindingStatusResponseV1Schema.safeParse(data);
	if (!parsed.success) throw requestError("Agent Skill 状态响应无效。", result);
	return parsed.data;
}

export async function bindSkillHubAgentVersion(
	agentId: string,
	agentVersion: string,
	body: SkillHubAgentBindingCommandV1,
	idempotencyKey: string,
	client?: Client,
) {
	const result: Awaited<
		RequestResult<
			BindSkillHubAgentVersionV1Responses,
			BindSkillHubAgentVersionV1Errors,
			false
		>
	> = await bindSkillHubAgentVersionV1({
		client,
		path: { agentId, agentVersion },
		body,
		headers: { "Idempotency-Key": idempotencyKey },
		responseStyle: "fields",
		throwOnError: false,
	});
	return requireData("Agent Skill 配置失败。", result);
}
