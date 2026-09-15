import type {
	AgentConfigurationUpdateRequestV2Writable,
	AgentProjectionV2,
} from "../../pilot/generated-v2/types.gen.js";

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
	channels?: AgentConfigurationUpdateRequestV2Writable["channels"];
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
	agent: AgentProjectionV2,
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
		replaceModels: false,
		models: [],
		defaultModelOptionId: "",
		defaultReasoningLevel: "",
		secrets: [],
	};
}

export function buildAgentConfigurationRequest(
	draft: AgentConfigurationDraft,
): AgentConfigurationUpdateRequestV2Writable {
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
		schemaVersion: 2,
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
		...(modelConfiguration === undefined ? {} : { modelConfiguration }),
		...(secrets.length === 0 ? {} : { secrets }),
		...(draft.channels?.length ? { channels: draft.channels } : {}),
	};
}
