import { isDeepStrictEqual } from "node:util";
import {
	parseAdoptedTemplateValidationV2,
	type StandardTemplateModelBindingV1,
	standardTemplateReadinessV1,
	type TemplateValidationContextV1,
} from "@agent-infra/model-catalog";
import {
	parseStandardTemplateReleaseTargetV1,
	type StandardTemplateReleaseTargetV1,
} from "@agent-infra/platform-core";

/** The immutable Worker-side adoption stays available to reconcile a committed revision. */
export interface WorkerSingleAgentTemplateReleaseV1 {
	readonly target: StandardTemplateReleaseTargetV1;
	readonly catalogBinding: StandardTemplateModelBindingV1;
	readonly validationContext: TemplateValidationContextV1;
	readonly configurationRevision: string;
	readonly modelId: string;
	readonly validation: unknown;
}

export interface WorkerTemplateBindingSourceV1 {
	readonly policy: { readonly namespace: string };
	readonly templateModelBindings?: readonly StandardTemplateModelBindingV1[];
	readonly singleAgentTemplateRelease?: WorkerSingleAgentTemplateReleaseV1;
}

/** A scoped adoption can contribute one binding only to the Agent named by its deployment. */
export function workerTemplateBindingsForAgentV1(
	source: WorkerTemplateBindingSourceV1,
	agentId: string,
) {
	const catalog = source.templateModelBindings ?? [];
	const scope = source.singleAgentTemplateRelease;
	if (!scope || scope.target?.agentId !== agentId) return catalog;
	try {
		const target = parseStandardTemplateReleaseTargetV1(scope.target);
		if (scope.validationContext.namespace !== source.policy.namespace)
			return catalog;
		const base = catalog.find(
			(binding) =>
				binding.templateId === target.templateId &&
				binding.imageDigest === target.expectedImageDigest,
		);
		if (
			!base ||
			!isDeepStrictEqual(base, scope.catalogBinding) ||
			catalog.some(
				(binding) =>
					binding.templateId === target.templateId &&
					binding.imageDigest === target.targetImageDigest,
			)
		)
			return catalog;
		const now = Date.now();
		const record = parseAdoptedTemplateValidationV2(
			scope.validation,
			scope.validationContext,
			now,
		);
		const binding = { ...base, imageDigest: target.targetImageDigest };
		const readiness = standardTemplateReadinessV1({
			templateId: target.templateId,
			imageDigest: target.targetImageDigest,
			binding,
			configurationRevision: scope.configurationRevision,
			validationContext: scope.validationContext,
			validation: record,
			now,
		});
		if (
			readiness.state !== "ready" ||
			record.candidate.modelId !== scope.modelId
		)
			return catalog;
		return [...catalog, binding];
	} catch {
		return catalog;
	}
}
