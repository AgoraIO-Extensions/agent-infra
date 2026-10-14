/**
 * 部署配置错误的安全诊断（#2382）。
 *
 * 启动失败时默认只输出一行通用信息，避免把部署私有材料写进日志。这里只允许
 * 携带固定的原因码和格式受限的模板 ID，让部署者能定位到具体模板，而不暴露
 * 任何配置值。诊断用全局 Symbol 标记，跨构建产物分块也能识别。
 */
const diagnosticKey = Symbol.for(
	"agent-infra.platform-api.deployment-diagnostic.v1",
);

export const deploymentDiagnosticReasonsV1 = [
	"codex_model_profiles_missing",
	"codex_model_profiles_invalid",
	"codex_model_profiles_unexpected",
] as const;

export type DeploymentDiagnosticReasonV1 =
	(typeof deploymentDiagnosticReasonsV1)[number];

export interface DeploymentDiagnosticV1 {
	readonly reason: DeploymentDiagnosticReasonV1;
	readonly templateId?: string;
}

const templateIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validDiagnostic(value: unknown): DeploymentDiagnosticV1 | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { reason, templateId } = value as Record<string, unknown>;
	if (
		typeof reason !== "string" ||
		!(deploymentDiagnosticReasonsV1 as readonly string[]).includes(reason)
	)
		return undefined;
	return {
		reason: reason as DeploymentDiagnosticReasonV1,
		// 不符合格式的模板 ID 不输出，只保留原因码。
		...(typeof templateId === "string" && templateIdPattern.test(templateId)
			? { templateId }
			: {}),
	};
}

/** 给错误附加已校验的诊断；无效诊断不附加。 */
export function withDeploymentDiagnosticV1<T extends Error>(
	error: T,
	diagnostic: DeploymentDiagnosticV1,
): T {
	const valid = validDiagnostic(diagnostic);
	if (valid)
		Object.defineProperty(error, diagnosticKey, {
			value: Object.freeze(valid),
			enumerable: false,
		});
	return error;
}

/** 读取错误上的诊断；每次读取都重新校验，不信任任意对象。 */
export function deploymentDiagnosticV1(
	error: unknown,
): DeploymentDiagnosticV1 | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	return validDiagnostic((error as Record<symbol, unknown>)[diagnosticKey]);
}

/** Platform API 启动失败时写入日志的单行信息。 */
export function platformApiStartupFailureMessageV1(error: unknown): string {
	if (
		error instanceof Error &&
		error.message === "PLATFORM_API_DEPLOYMENT_MODULE is required"
	)
		return error.message;
	const diagnostic = deploymentDiagnosticV1(error);
	if (!diagnostic) return "Platform API failed to start";
	return `Platform API failed to start: ${diagnostic.reason}${
		diagnostic.templateId ? ` (template ${diagnostic.templateId})` : ""
	}; see deploy/platform-api/README.md`;
}
