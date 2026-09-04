import type {
	AgentApplicationCreateRequestV1Writable,
	AgentApplicationProjectionV1,
	AgentApplicationUpdateRequestV1Writable,
} from "../../pilot/generated/types.gen.js";

export type AgentApplicationSourceKind =
	| "standard"
	| "custom-platform-adapter"
	| "custom-self-managed";

export type AgentApplicationActionDraft = {
	actionId: string;
	actionVersion: string;
	providerId: string;
};

export type AgentApplicationEnvironmentDraft = {
	name: string;
	value: string;
};

export type AgentApplicationModelDraft = {
	credentialValue: string;
	endpointId: string;
	modelId: string;
	optionId: string;
	reasoningLevels: string;
};

export type AgentApplicationFormDraft = {
	actions: readonly AgentApplicationActionDraft[];
	coOwnerIds: string;
	configureModels: boolean;
	defaultModelOptionId: string;
	defaultReasoningLevel: string;
	description: string;
	environment: readonly AgentApplicationEnvironmentDraft[];
	identityResponsibility: "platform-managed" | "self-managed";
	imageReference: string;
	models: readonly AgentApplicationModelDraft[];
	name: string;
	organizationAvailabilityIds: string;
	secrets: readonly AgentApplicationEnvironmentDraft[];
	source?: AgentApplicationCreateRequestV1Writable["source"];
	sourceKind: AgentApplicationSourceKind;
	templateId: string;
	userAvailabilityIds: string;
};

function splitValues(value: string) {
	return value
		.split(/[\n,]/)
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

export function sourceKindFor(
	source: AgentApplicationProjectionV1["source"] | undefined,
): AgentApplicationSourceKind {
	if (!source || source.kind === "standard") return "standard";
	return source.interactionMode === "platform-adapter"
		? "custom-platform-adapter"
		: "custom-self-managed";
}

export function showsModelConfiguration(
	mode: "create" | "update",
	sourceKind: AgentApplicationSourceKind,
	configureModels: boolean,
) {
	return sourceKind === "standard" && (mode === "create" || configureModels);
}

function requestBody(
	mode: "create" | "update",
	draft: AgentApplicationFormDraft,
) {
	const source: AgentApplicationCreateRequestV1Writable["source"] =
		draft.source ??
		(draft.sourceKind === "standard"
			? { kind: "standard", templateId: draft.templateId.trim() }
			: draft.sourceKind === "custom-platform-adapter"
				? {
						kind: "custom",
						imageReference: draft.imageReference.trim(),
						interactionMode: "platform-adapter",
					}
				: {
						kind: "custom",
						imageReference: draft.imageReference.trim(),
						interactionMode: "self-managed",
						identityResponsibility: draft.identityResponsibility,
					});
	const modelConfiguration = showsModelConfiguration(
		mode,
		draft.sourceKind,
		draft.configureModels,
	)
		? {
				options: draft.models.map((model) => ({
					optionId: model.optionId.trim(),
					endpointId: model.endpointId.trim(),
					modelId: model.modelId.trim(),
					reasoningLevels: splitValues(model.reasoningLevels),
					...(model.credentialValue.length > 0
						? { credentialValue: model.credentialValue }
						: {}),
				})),
				defaultOptionId: draft.defaultModelOptionId.trim(),
				defaultReasoningLevel: draft.defaultReasoningLevel.trim(),
			}
		: undefined;

	return {
		schemaVersion: 1 as const,
		name: draft.name.trim(),
		description: draft.description.trim(),
		source,
		coOwnerIds: splitValues(draft.coOwnerIds),
		availability: [
			...splitValues(draft.userAvailabilityIds).map((userId) => ({
				kind: "user" as const,
				userId,
			})),
			...splitValues(draft.organizationAvailabilityIds).map(
				(organizationId) => ({
					kind: "organization" as const,
					organizationId,
				}),
			),
		],
		actions: draft.actions.map((action) => ({
			providerId: action.providerId.trim(),
			actionId: action.actionId.trim(),
			actionVersion: action.actionVersion.trim(),
		})),
		environment: draft.environment.map((value) => ({
			name: value.name.trim(),
			value: value.value,
		})),
		...(modelConfiguration === undefined ? {} : { modelConfiguration }),
	};
}

function secretValues(draft: AgentApplicationFormDraft) {
	return draft.secrets.map((secret) => ({
		name: secret.name.trim(),
		value: secret.value,
	}));
}

export function buildAgentApplicationRequest(
	mode: "create",
	draft: AgentApplicationFormDraft,
): AgentApplicationCreateRequestV1Writable;
export function buildAgentApplicationRequest(
	mode: "update",
	draft: AgentApplicationFormDraft,
): AgentApplicationUpdateRequestV1Writable;
export function buildAgentApplicationRequest(
	mode: "create" | "update",
	draft: AgentApplicationFormDraft,
) {
	const body = requestBody(mode, draft);
	const secrets = secretValues(draft);
	if (mode === "create") return { ...body, secrets };

	return { ...body, ...(secrets.length === 0 ? {} : { secrets }) };
}
