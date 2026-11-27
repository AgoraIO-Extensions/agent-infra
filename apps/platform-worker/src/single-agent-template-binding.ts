import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { validateImageRegistryAdmissionResultV1 } from "@agent-infra/contracts/workload";
import type { ImageRegistryAdapterV1 } from "@agent-infra/image-registry";
import {
	parseAdoptedTemplateValidationV2,
	type StandardTemplateModelBindingV1,
	standardTemplateDefinitionsV1,
	standardTemplateReadinessV1,
	type TemplateValidationContextV1,
	templateValidationContextV1Schema,
} from "@agent-infra/model-catalog";
import {
	createTemplatePublicationServiceTransportV1,
	parseStandardTemplateReleaseTargetV1,
	type StandardTemplateReleaseTargetV1,
	type TemplatePublicationServiceKeyV1,
} from "@agent-infra/platform-core";

/** Candidate adoption from the deployment-owned single-Agent release. */
export interface WorkerSingleAgentTemplateReleaseInputV1 {
	readonly target: StandardTemplateReleaseTargetV1;
	readonly catalogBinding: StandardTemplateModelBindingV1;
	readonly validationContext: TemplateValidationContextV1;
	readonly configurationRevision: string;
	readonly modelId: string;
	readonly validation: unknown;
}

export interface WorkerSingleAgentTemplateReleaseV1
	extends WorkerSingleAgentTemplateReleaseInputV1 {
	/** Read independently from the catalog template receipt mounted by Helm on this Worker. */
	readonly installedContext: TemplateValidationContextV1;
}

/** Read the current catalog receipt at its canonical role mount, even if the candidate names a different source commit. */
export async function readInstalledWorkerTemplateReleaseV1(
	scope: WorkerSingleAgentTemplateReleaseInputV1 | undefined,
	catalog: readonly StandardTemplateModelBindingV1[],
	namespace: string,
	readRecord: (path: string) => Promise<string> = (path) =>
		readFile(path, "utf8"),
): Promise<WorkerSingleAgentTemplateReleaseV1 | undefined> {
	if (!scope) return undefined;
	try {
		const target = parseStandardTemplateReleaseTargetV1(scope.target);
		const template = standardTemplateDefinitionsV1.find(
			(entry) => entry.templateId === target.templateId,
		);
		if (!template) return undefined;
		const binding = catalog.find(
			(entry) =>
				entry.templateId === template.templateId &&
				entry.imageDigest === target.expectedImageDigest,
		);
		if (!binding || binding.driver !== template.driver) return undefined;
		const value = JSON.parse(
			await readRecord(
				"/app/deployment/template-validation-" + template.templateId + ".json",
			),
		);
		const context = templateValidationContextV1Schema.parse(
			value?.adoption?.target,
		);
		if (context.namespace !== namespace) return undefined;
		const now = Date.now();
		const record = parseAdoptedTemplateValidationV2(value, context, now);
		const readiness = standardTemplateReadinessV1({
			templateId: target.templateId,
			imageDigest: target.expectedImageDigest,
			binding,
			configurationRevision: record.candidate.configurationRevision,
			validationContext: context,
			validation: record,
			now,
		});
		if (readiness.state !== "ready") return undefined;
		return { ...structuredClone(scope), installedContext: context };
	} catch {
		return undefined;
	}
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
		const installed = templateValidationContextV1Schema.parse(
			scope.installedContext,
		);
		const expected = {
			...installed,
			sourceCommit: scope.validationContext.sourceCommit,
		};
		if (
			installed.namespace !== source.policy.namespace ||
			!isDeepStrictEqual(scope.validationContext, expected)
		)
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

export interface WorkerSingleAgentReadinessTransportV1 {
	readonly origin: string;
	readonly currentKey: () => Promise<TemplatePublicationServiceKeyV1>;
}

/** Only the installed Worker can attest to its own adoption and Registry decision. */
export async function confirmInstalledAgentCandidateV1(
	input: WorkerTemplateBindingSourceV1 & {
		readonly registry: ImageRegistryAdapterV1;
		readonly registrySubjectRef: string;
		readonly admissionPolicyRef: string;
		readonly imageRepository: string;
	},
	transport: WorkerSingleAgentReadinessTransportV1,
	signal: AbortSignal,
	send?: typeof fetch,
) {
	const scope = input.singleAgentTemplateRelease;
	if (!scope) throw new Error("WORKER_TEMPLATE_PUBLICATION_UNAVAILABLE");
	const target = parseStandardTemplateReleaseTargetV1(scope.target);
	const binding = workerTemplateBindingsForAgentV1(input, target.agentId).find(
		(entry) =>
			entry.templateId === target.templateId &&
			entry.imageDigest === target.targetImageDigest,
	);
	const origin = new URL(transport.origin);
	if (
		!binding ||
		origin.protocol !== "https:" ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.username ||
		origin.password ||
		origin.hash
	)
		throw new Error("WORKER_TEMPLATE_PUBLICATION_UNAVAILABLE");
	const request = {
		schemaVersion: 1 as const,
		agentId: target.agentId,
		requestId: randomUUID(),
		traceId: randomUUID(),
		subjectRef: input.registrySubjectRef,
		admissionPolicyRef: input.admissionPolicyRef,
		usage: "standard-template" as const,
		imageReference: `${binding.imageRepository ?? input.imageRepository}@${target.targetImageDigest}`,
	};
	const admission = validateImageRegistryAdmissionResultV1(
		request,
		await input.registry.admit(request, { signal }),
	);
	if (
		admission.status !== "admitted" ||
		admission.immutableDigest !== target.targetImageDigest ||
		admission.runtimeManifest.interactionMode !== "platform-adapter"
	)
		throw new Error("WORKER_TEMPLATE_PUBLICATION_UNAVAILABLE");
	const currentKey = async () => {
		const key = await transport.currentKey();
		if (
			key.publicationId !== target.releaseId ||
			key.deploymentRef !== scope.installedContext.installationId
		)
			throw new Error("WORKER_TEMPLATE_PUBLICATION_UNAVAILABLE");
		return key;
	};
	const signed = createTemplatePublicationServiceTransportV1({
		currentKey,
		fetch: send,
	});
	const response = await signed.request(
		new Request(
			new URL(
				`/internal/ops/standard-template-releases/${target.releaseId}/agent-worker-ready`,
				origin,
			),
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					schemaVersion: 1,
					target,
					validation: scope.validation,
				}),
				redirect: "error",
				signal,
			},
		),
	);
	if (response.status !== 204)
		throw new Error("WORKER_TEMPLATE_PUBLICATION_UNAVAILABLE");
}
