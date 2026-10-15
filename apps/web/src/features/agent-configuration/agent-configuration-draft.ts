import type {
	AgentConfigurationUpdateRequestV2Writable,
	AgentProjectionV2,
} from "../../pilot/generated-v2/types.gen.js";

export type AgentConfigurationModelDraft = {
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
		...(draft.channels === undefined ? {} : { channels: draft.channels }),
	};
}

function sortedJson(values: readonly string[]) {
	return JSON.stringify([...values].sort());
}

/**
 * 草稿相对已加载的配置是否真有改动（#2560）。服务端把「没有任何变更」的保存拒绝成 409，
 * 页面再提示「权限或 Agent 状态已变化，请刷新页面」是误导，所以没有改动时不应发出保存请求。
 * 比较方式与服务端一致：Owner、可使用范围、模型选项都按集合比较，与顺序无关；填写了
 * Secret 或渠道变更一律算改动。
 */
export function agentConfigurationDraftChanged(
	agent: AgentProjectionV2,
	draft: AgentConfigurationDraft,
): boolean {
	const baseline = buildAgentConfigurationRequest(
		configurationDraftFromAgent(agent),
	);
	const request = buildAgentConfigurationRequest(draft);
	if (request.secrets?.length || request.channels !== undefined) return true;
	if (
		sortedJson(request.coOwnerIds ?? []) !==
		sortedJson(baseline.coOwnerIds ?? [])
	)
		return true;
	const targets = (value: typeof request) =>
		sortedJson(
			(value.availability ?? []).map((target) =>
				target.kind === "user"
					? `user:${target.userId}`
					: `organization:${target.organizationId}`,
			),
		);
	if (targets(request) !== targets(baseline)) return true;
	const next = request.modelConfiguration;
	if (next === undefined) return false;
	const current = agent.configuration;
	if (
		next.defaultOptionId !== (current.defaultModelOptionId ?? "") ||
		next.defaultReasoningLevel !== (current.defaultReasoningLevel ?? "")
	)
		return true;
	// 当前投影里没有 endpointId；optionId 已经包含端点，所以按 optionId、模型和档位集合比较。
	const option = (value: {
		readonly optionId: string;
		readonly modelId: string;
		readonly reasoningLevels: readonly string[];
	}) =>
		`${value.optionId}|${value.modelId}|${sortedJson(value.reasoningLevels)}`;
	return (
		sortedJson(next.options.map(option)) !==
		sortedJson(current.modelOptions.map(option))
	);
}
