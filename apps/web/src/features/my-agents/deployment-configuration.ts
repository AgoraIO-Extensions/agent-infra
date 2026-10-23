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

export const templateReadinessMessages = {
	ready: "可申请",
	unregistered: "尚未登记，请联系平台管理员。",
	unverified: "尚未完成真实运行与模型验证。",
	failed: "验证失败，暂不可申请。",
	disabled: "模板已停用。",
	stale: "模板或验证已过期，请刷新后重试。",
	unavailable: "暂时无法读取验证结果，请刷新后重试。",
} as const;

/**
 * 部署尚未登记任何标准模板时，就绪列表仍列出 M1 首发的四个模板并说明原因（PRD §4、§16
 * 「未就绪项显示原因」）；显示名按 PRD 模板名，不外露模板 ID（#3291 N9-2-01）。
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
