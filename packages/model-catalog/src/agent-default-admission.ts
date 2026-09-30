import {
	type RuntimeModelConfigurationV4,
	RuntimeModelConfigurationV4Schema,
} from "@agent-infra/contracts/runtime";
import { z } from "zod";
import {
	ModelCatalogSnapshotV1Schema,
	ModelConfigurationErrorV1,
	modelIdentifier,
	modelOperationV1,
	reasoningLevel,
} from "./catalog.js";
import type { StandardTemplateModelBindingV1 } from "./projection.js";

const requestSchema = z.strictObject({
	catalogRevision: modelIdentifier,
	configVersion: modelIdentifier,
	defaultOptionId: modelIdentifier,
	defaultReasoningLevel: reasoningLevel,
	options: z
		.array(
			z.strictObject({
				optionId: modelIdentifier,
				endpointId: modelIdentifier,
				modelId: modelIdentifier,
				reasoningLevels: z.array(reasoningLevel).min(1).max(32),
			}),
		)
		.min(1)
		.max(128),
});

export type AgentDefaultModelRequestV1 = z.input<typeof requestSchema>;

/** The deployment binds listVisibleModelIds to the exact submitted Key version and fixed Relay profile. */
export interface AgentDefaultModelAdmissionPortsV1 {
	loadCatalog(signal: AbortSignal): Promise<unknown>;
	listVisibleModelIds(signal: AbortSignal): Promise<readonly string[]>;
}

/** Admits a keyless V4 configuration against one current catalog and Key visibility. */
export async function admitAgentDefaultModelsV1(input: {
	readonly requested: AgentDefaultModelRequestV1;
	readonly admittedSource: {
		readonly kind: "standard";
		readonly templateId: string;
		readonly imageDigest: string;
	};
	readonly template: StandardTemplateModelBindingV1;
	/** Deployment-owned Relay route; it must never come from the request body. */
	readonly relayEndpointId: string;
	readonly relayBaseUrl: string;
	readonly ports: AgentDefaultModelAdmissionPortsV1;
	readonly signal: AbortSignal;
}): Promise<{
	readonly catalogRevision: string;
	readonly runtime: RuntimeModelConfigurationV4;
}> {
	let requested: z.infer<typeof requestSchema>;
	try {
		requested = requestSchema.parse(input.requested);
	} catch {
		throw new ModelConfigurationErrorV1();
	}
	const [rawCatalog, rawVisibleModels] = await Promise.all([
		modelOperationV1(input.signal, () => input.ports.loadCatalog(input.signal)),
		modelOperationV1(input.signal, () =>
			input.ports.listVisibleModelIds(input.signal),
		),
	]);
	try {
		input.signal.throwIfAborted();
		const catalog = ModelCatalogSnapshotV1Schema.parse(rawCatalog);
		const visibleModels = z
			.array(modelIdentifier)
			.max(1024)
			.parse(rawVisibleModels);
		if (
			input.template.templateId !== input.admittedSource.templateId ||
			input.template.imageDigest !== input.admittedSource.imageDigest ||
			catalog.revision !== requested.catalogRevision ||
			catalog.validUntil <= Date.now() ||
			!modelIdentifier.safeParse(input.relayEndpointId).success ||
			!input.relayBaseUrl ||
			!visibleModels.length
		)
			throw new ModelConfigurationErrorV1();
		const visible = new Set(visibleModels);
		const modelOptions = requested.options.map((option) => {
			const endpoint = catalog.endpoints.find(
				(candidate) => candidate.endpointId === option.endpointId,
			);
			if (
				!endpoint?.available ||
				endpoint.endpointId !== input.relayEndpointId ||
				endpoint.baseUrl !== input.relayBaseUrl ||
				endpoint.protocol !== input.template.protocol ||
				!visible.has(option.modelId) ||
				(endpoint.allowedModels !== null &&
					!endpoint.allowedModels.includes(option.modelId)) ||
				option.reasoningLevels.some(
					(level) => !endpoint.capabilities.reasoningLevels.includes(level),
				)
			)
				throw new ModelConfigurationErrorV1();
			return {
				modelOptionId: option.optionId,
				endpoint: endpoint.baseUrl,
				model: option.modelId,
				reasoningLevels: option.reasoningLevels,
				protocol: endpoint.protocol,
				authentication: endpoint.authentication ?? "bearer",
			};
		});
		const runtime = RuntimeModelConfigurationV4Schema.parse({
			schemaVersion: 4,
			configVersion: requested.configVersion,
			defaultModelOptionId: requested.defaultOptionId,
			defaultReasoningLevel: requested.defaultReasoningLevel,
			modelOptions,
		});
		input.signal.throwIfAborted();
		return { catalogRevision: catalog.revision, runtime };
	} catch {
		throw new ModelConfigurationErrorV1(input.signal.aborted);
	}
}
