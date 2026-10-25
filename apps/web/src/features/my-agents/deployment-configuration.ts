import type {
	Client,
	RequestResult,
} from "../../pilot/generated-v2/client/index.js";
import { getDeploymentConfigurationV2 } from "../../pilot/generated-v2/sdk.gen.js";
import type {
	DeploymentConfigurationProjectionV2,
	GetDeploymentConfigurationV2Errors,
	GetDeploymentConfigurationV2Responses,
} from "../../pilot/generated-v2/types.gen.js";

export type DeploymentConfigurationState =
	| {
			kind: "ready";
			configuration: DeploymentConfigurationProjectionV2;
	  }
	| {
			kind: "unavailable";
			retryable: boolean;
	  };

export function isRetryableDeploymentConfigurationError(
	error: unknown,
): boolean {
	return (
		error instanceof Error &&
		(!("retryable" in error) || error.retryable === true)
	);
}

function unavailable(error: { retryable?: boolean } | undefined) {
	return {
		kind: "unavailable" as const,
		retryable: error?.retryable !== false,
	};
}

export const unavailableDeploymentConfiguration: DeploymentConfigurationProjectionV2 =
	{
		modelCatalog: {
			endpoints: [],
			revision: null,
			status: "unavailable",
		},
		schemaVersion: 2,
		status: "unavailable",
		templates: [],
	};

export function projectDeploymentConfiguration(
	state: DeploymentConfigurationState | undefined,
	error: unknown,
	isError: boolean,
) {
	return {
		configuration:
			!isError && state?.kind === "ready"
				? state.configuration
				: unavailableDeploymentConfiguration,
		retryable: isError
			? isRetryableDeploymentConfigurationError(error)
			: state?.kind === "ready"
				? state.configuration.status !== "unavailable" &&
					state.configuration.modelCatalog.status !== "unavailable"
				: state?.kind === "unavailable" && state.retryable,
	};
}

/**
 * 部署选项可用于提交标准模板申请：部署配置与模型目录的 status 都是 populated（不是读取失败 unavailable、
 * 过期 stale 或 empty）。否则申请页顶部的部署状态说明「部署选项需要刷新后才能提交标准模板申请。」（或请
 * 联系管理员），创建与修改标准模板申请都按它拦下、不发请求（#3389 N13-09）。status 为 populated 而模板为空
 * 时不在这里判断：创建申请按「部署没有标准模板」、修改申请按「已移除模板」拦下，下一步是联系管理员或新建
 * 申请，不显示部署状态说明。
 */
export function deploymentConfigurationUsable(
	configuration: DeploymentConfigurationProjectionV2,
) {
	return (
		configuration.status === "populated" &&
		configuration.modelCatalog.status === "populated"
	);
}

export async function loadDeploymentConfiguration(
	client?: Client,
): Promise<DeploymentConfigurationState> {
	const result: Awaited<
		RequestResult<
			GetDeploymentConfigurationV2Responses,
			GetDeploymentConfigurationV2Errors,
			false
		>
	> = await getDeploymentConfigurationV2({
		client,
		responseStyle: "fields",
		throwOnError: false,
	});
	if (!result.data) return unavailable(result.error);
	return { kind: "ready", configuration: result.data };
}

/**
 * 模板就绪原因（PRD §4、§16「未就绪项展示原因」）：就绪列表、所选模板提示与「标准模板」字段错误共用。
 * 验证过期（验证证据与当前登记不符或超出有效期）刷新后仍是过期，要等平台重新验证，只说明原因、不引导
 * 刷新；只有这次没能读到验证结果时刷新即可确认（#3351 N11-01）。
 */
export const templateReadinessMessages = {
	ready: "可申请",
	unregistered: "尚未登记，请联系平台管理员。",
	unverified: "尚未完成真实运行与模型验证。",
	failed: "验证失败，暂不可申请。",
	disabled: "模板已停用。",
	stale: "模板验证已过期，需等待平台重新验证。",
	unavailable: "暂时无法读取验证结果，请刷新后重试。",
} as const;

/**
 * 部署选项读取失败（部署配置不可用）时就绪列表每一项的原因：读不到就绪状态，不按「尚未登记」说明；下一步
 * 与同页的部署状态说明一致——可重试时重新加载部署选项，不可重试时联系管理员（PRD §4、§16「未就绪项展示
 * 原因」，#3389 N13-08）。
 */
export function unreadableTemplateReadinessMessage(retryable: boolean) {
	return retryable
		? "暂时无法读取就绪状态，请重新加载部署选项。"
		: "暂时无法读取就绪状态，请联系管理员。";
}

/**
 * 部署尚未登记任何标准模板时，就绪列表仍列出 M1 首发的四个模板并说明原因（PRD §4、§16
 * 「未就绪项显示原因」）；显示名按 PRD 模板名，不外露模板 ID（#3291 N9-2-01）。部署选项读取失败时同样
 * 列出这四项（原因见 unreadableTemplateReadinessMessage），已选模板的下拉也按这里的显示名显示（#3389 N13-08）。
 */
const fallbackStandardTemplates = [
	{ templateId: "codex", displayName: "Codex" },
	{ templateId: "claude", displayName: "Claude" },
	{ templateId: "opencode", displayName: "OpenCode" },
	{ templateId: "pi", displayName: "Pi" },
] as const;

export function applicationTemplateChoices(
	configuration: DeploymentConfigurationProjectionV2,
) {
	return configuration.templates.length > 0
		? configuration.templates
		: fallbackStandardTemplates.map(({ templateId, displayName }) => ({
				templateId,
				displayName,
				connectionEnabled: false,
				allowedEnvironmentKeys: [],
				allowedSecretKeys: [],
				readiness: { state: "unregistered" as const, revision: null },
			}));
}
