import { useMemo } from "react";
import type { DeploymentTemplateProjectionV2 } from "../pilot/generated-v2/types.gen.js";
import { useDeploymentConfiguration } from "./my-agents/use-deployment-configuration.js";

/** 读不到模板显示名（部署配置未返回、读取失败或模板已移除）时的中性文案。 */
export const templateFallbackName = "标准模板";

/** 按 templateId 查部署配置登记的显示名；查不到返回 undefined。原始 templateId 不进入页面。 */
export type TemplateNameLookup = (templateId: string) => string | undefined;

export function templateNameLookup(
	templates:
		| readonly Pick<
				DeploymentTemplateProjectionV2,
				"templateId" | "displayName"
		  >[]
		| undefined,
): TemplateNameLookup {
	return (templateId) =>
		templates
			?.find((template) => template.templateId === templateId)
			?.displayName.trim() || undefined;
}

/** 只写模板名的位置（例如「Codex」）；读不到时为「标准模板」。 */
export function templateDisplayName(
	templateId: string,
	lookup?: TemplateNameLookup,
) {
	return lookup?.(templateId) ?? templateFallbackName;
}

/** 「标准模板 · {显示名}」；读不到显示名时只写「标准模板」。 */
export function standardTemplateLabel(
	templateId: string,
	lookup?: TemplateNameLookup,
) {
	const name = lookup?.(templateId);
	return name ? `${templateFallbackName} · ${name}` : templateFallbackName;
}

/**
 * 页面读取部署配置里的模板显示名（F-02）。与申请表单共用同一个部署配置读取；读取中或
 * 失败时所有模板都回落为「标准模板」。
 */
export function useTemplateNameLookup(): TemplateNameLookup {
	const deployment = useDeploymentConfiguration();
	const templates =
		deployment.data?.kind === "ready"
			? deployment.data.configuration.templates
			: undefined;
	return useMemo(() => templateNameLookup(templates), [templates]);
}
