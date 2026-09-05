import type {
	AgentConfigurationUpdateRequestV1Writable,
	AgentProjectionV1,
} from "../../pilot/generated/types.gen.js";

export type AgentConfigurationActionDraft = {
	actionId: string;
	actionVersion: string;
	providerId: string;
};

export type AgentConfigurationModelDraft = {
	credentialValue: string;
	endpointId: string;
	modelId: string;
	optionId: string;
	reasoningLevels: string;
};

export type AgentConfigurationSecretDraft = {
	name: string;
	value: string;
};

export type AgentConfigurationDraft = {
	actions: readonly AgentConfigurationActionDraft[];
	coOwnerIds: string;
	defaultModelOptionId: string;
	defaultReasoningLevel: string;
	models: readonly AgentConfigurationModelDraft[];
	organizationAvailabilityIds: string;
	replaceModels: boolean;
	secrets: readonly AgentConfigurationSecretDraft[];
	userAvailabilityIds: string;
};

function splitValues(value: string) {
	return value
		.split(/[\n,]/)
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

export function configurationDraftFromAgent(
	agent: AgentProjectionV1,
): AgentConfigurationDraft {
	return {
		coOwnerIds: agent.configuration.owners
			.map((owner) => owner.userId)
			.join("\n"),
		userAvailabilityIds: agent.configuration.availability
			.filter((target) => target.kind === "user")
			.map((target) => target.userId)
			.join("\n"),
		organizationAvailabilityIds: agent.configuration.availability
			.filter((target) => target.kind === "organization")
			.map((target) => target.organizationId)
			.join("\n"),
		actions: agent.configuration.actions.map((action) => ({ ...action })),
		replaceModels: false,
		models: [],
		defaultModelOptionId: "",
		defaultReasoningLevel: "",
		secrets: [],
	};
}

export function buildAgentConfigurationRequest(
	draft: AgentConfigurationDraft,
): AgentConfigurationUpdateRequestV1Writable {
	const modelConfiguration = draft.replaceModels
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
	const secrets = draft.secrets.map((secret) => ({
		name: secret.name.trim(),
		value: secret.value,
	}));

	return {
		schemaVersion: 1,
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
		...(modelConfiguration === undefined ? {} : { modelConfiguration }),
		...(secrets.length === 0 ? {} : { secrets }),
	};
}
