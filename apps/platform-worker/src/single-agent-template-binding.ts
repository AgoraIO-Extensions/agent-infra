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
import type { PostgresAgentConfigurationQueryV1 } from "@agent-infra/platform-store";

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
		if (
			![target.expectedImageDigest, target.targetImageDigest].includes(
				scope.catalogBinding.imageDigest,
			)
		)
			return undefined;
		const binding = catalog.find(
			(entry) =>
				entry.templateId === template.templateId &&
				entry.imageDigest === scope.catalogBinding.imageDigest,
		);
		if (
			!binding ||
			binding.driver !== template.driver ||
			!isDeepStrictEqual(binding, scope.catalogBinding)
		)
			return undefined;
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
			imageDigest: binding.imageDigest,
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

/** At process startup recheck issued registrations against this Worker's own current catalog and installation mount. */
export async function recoverWorkerTemplateReleasesV1(
	query: Pick<
		PostgresAgentConfigurationQueryV1,
		"readCommittedTemplateReleases"
	>,
	catalog: readonly StandardTemplateModelBindingV1[],
	namespace: string,
	readRecord?: (path: string) => Promise<string>,
) {
	const result = new Map<string, WorkerSingleAgentTemplateReleaseV1>();
	const records = await query.readCommittedTemplateReleases({ namespace });
	for (const record of records) {
		const recovered = await readInstalledWorkerTemplateReleaseV1(
			record,
			catalog,
			namespace,
			readRecord,
		);
		if (recovered) result.set(recovered.target.agentId, recovered);
	}
	return result;
}

export interface WorkerTemplateBindingSourceV1 {
	readonly policy: { readonly namespace: string };
	readonly templateModelBindings?: readonly StandardTemplateModelBindingV1[];
	readonly singleAgentTemplateRelease?: WorkerSingleAgentTemplateReleaseV1;
	readonly committedTemplateReleases?: ReadonlyMap<
		string,
		WorkerSingleAgentTemplateReleaseV1
	>;
}

/** A scoped adoption can contribute one binding only to the Agent named by its deployment. */
function verifiedScopedBinding(
	source: WorkerTemplateBindingSourceV1,
	agentId: string,
	scope = source.singleAgentTemplateRelease,
) {
	const catalog = source.templateModelBindings ?? [];
	if (!scope || scope.target?.agentId !== agentId) return undefined;
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
			return undefined;
		if (
			![target.expectedImageDigest, target.targetImageDigest].includes(
				scope.catalogBinding.imageDigest,
			)
		)
			return undefined;
		const base = catalog.find(
			(binding) =>
				binding.templateId === target.templateId &&
				binding.imageDigest === scope.catalogBinding.imageDigest,
		);
		if (!base || !isDeepStrictEqual(base, scope.catalogBinding))
			return undefined;
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
			return undefined;
		const existing = catalog.find(
			(entry) =>
				entry.templateId === target.templateId &&
				entry.imageDigest === target.targetImageDigest,
		);
		return existing && !isDeepStrictEqual(existing, binding)
			? undefined
			: binding;
	} catch {
		return undefined;
	}
}

export function workerTemplateBindingsForAgentV1(
	source: WorkerTemplateBindingSourceV1,
	agentId: string,
) {
	const catalog = source.templateModelBindings ?? [];
	let bindings = catalog;
	for (const scope of [
		source.committedTemplateReleases?.get(agentId),
		source.singleAgentTemplateRelease,
	]) {
		if (!scope) continue;
		const binding = verifiedScopedBinding(source, agentId, scope);
		if (
			binding &&
			!bindings.some(
				(entry) =>
					entry.templateId === binding.templateId &&
					entry.imageDigest === binding.imageDigest,
			)
		)
			bindings = [...bindings, binding];
	}
	return bindings;
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
	const binding = verifiedScopedBinding(input, target.agentId);
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
	let ready = false;
	try {
		const admission = validateImageRegistryAdmissionResultV1(
			request,
			await input.registry.admit(request, { signal }),
		);
		ready =
			admission.status === "admitted" &&
			admission.immutableDigest === target.targetImageDigest &&
			admission.runtimeManifest.interactionMode === "platform-adapter";
	} catch {
		// Withdraw the previous positive decision when this policy can no longer confirm the image.
	}
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
					ready,
					target,
					validation: scope.validation,
				}),
				redirect: "error",
				signal,
			},
		),
	);
	if (response.status !== 204 || !ready)
		throw new Error("WORKER_TEMPLATE_PUBLICATION_UNAVAILABLE");
	return response.headers.get("x-template-release-committed") === "true";
}
