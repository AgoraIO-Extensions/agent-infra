import {
	SkillHubAgentBindingStatusResponseV1Schema,
	SkillHubAgentCurrentVersionV1Schema,
	SkillHubInstallationResponseV1Schema,
	SkillHubProjectContentSaveResponseV1Schema,
	SkillHubProjectContentV1Schema,
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
	installSkillHubVersionV1,
	listSkillHubProjectsV1,
	publishSkillHubProjectVersionV1,
	publishSkillHubVersionV1,
	readSkillHubAgentBindingsV1,
	readSkillHubAgentCurrentVersionV1,
	readSkillHubProjectContentV1,
	reviewSkillHubVersionV1,
	revokeSkillHubVersionV1,
	saveSkillHubProjectContentV1,
	uninstallSkillHubInstallationV1,
	updateSkillHubProjectV1,
} from "../../pilot/generated-v2/sdk.gen.js";
import type {
	BindSkillHubAgentVersionV1Errors,
	BindSkillHubAgentVersionV1Responses,
	CreateSkillHubProjectV1Errors,
	CreateSkillHubProjectV1Responses,
	ImportSkillHubVersionV1Errors,
	ImportSkillHubVersionV1Responses,
	InstallSkillHubVersionV1Errors,
	InstallSkillHubVersionV1Responses,
	ListSkillHubProjectsV1Errors,
	ListSkillHubProjectsV1Responses,
	PublishSkillHubProjectVersionV1Errors,
	PublishSkillHubProjectVersionV1Responses,
	PublishSkillHubVersionV1Data,
	PublishSkillHubVersionV1Errors,
	PublishSkillHubVersionV1Responses,
	ReadSkillHubAgentBindingsV1Errors,
	ReadSkillHubAgentBindingsV1Responses,
	ReadSkillHubAgentCurrentVersionV1Errors,
	ReadSkillHubAgentCurrentVersionV1Responses,
	ReadSkillHubProjectContentV1Errors,
	ReadSkillHubProjectContentV1Responses,
	ReviewSkillHubVersionV1Errors,
	ReviewSkillHubVersionV1Responses,
	RevokeSkillHubVersionV1Errors,
	RevokeSkillHubVersionV1Responses,
	SaveSkillHubProjectContentV1Errors,
	SaveSkillHubProjectContentV1Responses,
	SkillHubAgentBindingCommandV1,
	SkillHubInstallationCommandV1,
	SkillHubProjectContentUpdateV1,
	SkillHubProjectContentV1,
	SkillHubProjectCreateV1,
	SkillHubProjectPageV1,
	SkillHubProjectPublicationRequestV1,
	SkillHubProviderImportRequestV1,
	SkillHubReviewRequestV1,
	UninstallSkillHubInstallationV1Errors,
	UninstallSkillHubInstallationV1Responses,
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

/** 本人项目的当前内容（网页编辑草稿）；只有项目 Owner 能读。 */
export async function readSkillHubProjectContent(
	projectId: string,
	client?: Client,
): Promise<SkillHubProjectContentV1> {
	const result: Awaited<
		RequestResult<
			ReadSkillHubProjectContentV1Responses,
			ReadSkillHubProjectContentV1Errors,
			false
		>
	> = await readSkillHubProjectContentV1({
		client,
		path: { projectId },
		responseStyle: "fields",
		throwOnError: false,
	});
	const data = requireData("项目内容暂时无法读取。", result);
	const parsed = SkillHubProjectContentV1Schema.safeParse(data);
	if (!parsed.success || parsed.data.projectId !== projectId)
		throw requestError("项目内容响应无效。", {
			...result,
			error: { retryable: false },
		});
	return parsed.data;
}

/** 以读取到的修订号整体保存项目内容；修订已变化时服务端返回 409。 */
export async function saveSkillHubProjectContent(
	projectId: string,
	body: SkillHubProjectContentUpdateV1,
	idempotencyKey: string,
	client?: Client,
) {
	const result: Awaited<
		RequestResult<
			SaveSkillHubProjectContentV1Responses,
			SaveSkillHubProjectContentV1Errors,
			false
		>
	> = await saveSkillHubProjectContentV1({
		client,
		path: { projectId },
		body,
		headers: { "Idempotency-Key": idempotencyKey },
		responseStyle: "fields",
		throwOnError: false,
	});
	const data = requireData("项目内容保存失败。", result);
	const parsed = SkillHubProjectContentSaveResponseV1Schema.safeParse(data);
	if (!parsed.success || parsed.data.projectId !== projectId)
		throw requestError("保存响应无效。", {
			...result,
			error: { retryable: false },
		});
	return parsed.data;
}

/** 网页发布：只提交内容修订、版本号与发布范围，包、摘要与签名都由服务端生成。 */
export async function publishSkillHubProjectVersion(
	projectId: string,
	body: SkillHubProjectPublicationRequestV1,
	idempotencyKey: string,
	client?: Client,
) {
	const result: Awaited<
		RequestResult<
			PublishSkillHubProjectVersionV1Responses,
			PublishSkillHubProjectVersionV1Errors,
			false
		>
	> = await publishSkillHubProjectVersionV1({
		client,
		path: { projectId },
		body,
		headers: { "Idempotency-Key": idempotencyKey },
		responseStyle: "fields",
		throwOnError: false,
	});
	const data = requireData("版本发布失败。", result);
	const parsed = SkillHubPublicationResponseV1Schema.safeParse(data);
	if (!parsed.success || parsed.data.version.skillId !== projectId)
		throw requestError("发布响应无效。", {
			...result,
			error: { retryable: false },
		});
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

/**
 * 把固定版本加入当前用户的库。主体由调用方传入当前会话的 userId，
 * 服务端仍会核对主体就是本人；409 表示服务端判定已安装。
 */
export async function installSkillHubVersion(
	body: SkillHubInstallationCommandV1,
	idempotencyKey: string,
	client?: Client,
) {
	const result: Awaited<
		RequestResult<
			InstallSkillHubVersionV1Responses,
			InstallSkillHubVersionV1Errors,
			false
		>
	> = await installSkillHubVersionV1({
		client,
		body,
		headers: { "Idempotency-Key": idempotencyKey },
		responseStyle: "fields",
		throwOnError: false,
	});
	const data = requireData("加入我的库失败。", result);
	const parsed = SkillHubInstallationResponseV1Schema.safeParse(data);
	if (!parsed.success || parsed.data.installation.state !== "installed")
		throw requestError("安装响应无效。", {
			...result,
			error: { retryable: false },
		});
	return parsed.data;
}

/** 把本人安装从我的库移出；安装记录 ID 只来自服务端详情投影。 */
export async function uninstallSkillHubInstallation(
	installationId: string,
	idempotencyKey: string,
	client?: Client,
) {
	const result: Awaited<
		RequestResult<
			UninstallSkillHubInstallationV1Responses,
			UninstallSkillHubInstallationV1Errors,
			false
		>
	> = await uninstallSkillHubInstallationV1({
		client,
		path: { installationId },
		headers: { "Idempotency-Key": idempotencyKey },
		responseStyle: "fields",
		throwOnError: false,
	});
	const data = requireData("移出我的库失败。", result);
	const parsed = SkillHubInstallationResponseV1Schema.safeParse(data);
	if (!parsed.success || parsed.data.installation.state !== "uninstalled")
		throw requestError("移出响应无效。", {
			...result,
			error: { retryable: false },
		});
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

/**
 * 当前 Agent Version（#2903）：只对当前 Owner 返回；绑定读写路径使用这里的值，不让用户手填。
 */
export async function readSkillHubAgentCurrentVersion(
	agentId: string,
	client?: Client,
) {
	const result: Awaited<
		RequestResult<
			ReadSkillHubAgentCurrentVersionV1Responses,
			ReadSkillHubAgentCurrentVersionV1Errors,
			false
		>
	> = await readSkillHubAgentCurrentVersionV1({
		client,
		path: { agentId },
		responseStyle: "fields",
		throwOnError: false,
	});
	const data = requireData("当前 Agent 版本暂时无法读取。", result);
	const parsed = SkillHubAgentCurrentVersionV1Schema.safeParse(data);
	if (!parsed.success || parsed.data.agentId !== agentId)
		throw requestError("当前 Agent 版本响应无效。", result);
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
