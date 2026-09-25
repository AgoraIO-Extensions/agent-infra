import type {
	AgentApplicationCreateRequestV2Writable,
	AgentApplicationProjectionV2,
	AgentApplicationUpdateRequestV2Writable,
} from "../../pilot/generated-v2/types.gen.js";

export type AgentApplicationSourceKind =
	| "standard"
	| "custom-platform-adapter"
	| "custom-self-managed";

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
	source?: AgentApplicationCreateRequestV2Writable["source"];
	sourceKind: AgentApplicationSourceKind;
	templateId: string;
	userAvailabilityIds: string;
};

export function splitValues(value: string) {
	return value
		.split(/[\n,]/)
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

export function sourceKindFor(
	source: AgentApplicationProjectionV2["source"] | undefined,
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

export type AgentApplicationFieldErrors = Record<string, string>;

export type AgentApplicationValidationContext = {
	configurationMessage?: string;
	defaultModelReasoningLevels?: readonly string[];
	allowedEnvironmentKeys?: readonly string[];
	allowedSecretKeys?: readonly string[];
	modelConfigurationVisible: boolean;
	requiresReplacementCredential: boolean;
	staleModel: boolean;
	staleModelIndexes?: readonly number[];
	staleTemplate: boolean;
	standardChoicesBlocked: boolean;
};

export function validateAgentApplicationDraft(
	draft: AgentApplicationFormDraft,
	context: AgentApplicationValidationContext,
): AgentApplicationFieldErrors {
	const errors: AgentApplicationFieldErrors = {};
	if (!draft.name.trim()) errors.name = "请输入 Agent 名称。";
	if (!draft.description.trim()) errors.description = "请输入用途说明。";
	if (draft.sourceKind === "standard") {
		if (!draft.templateId) errors.templateId = "请选择标准模板。";
		if (context.staleTemplate) errors.templateId = "该模板已移除，请重新选择。";
		if (context.standardChoicesBlocked)
			errors.templateId = context.configurationMessage ?? "部署选项暂不可用。";
	} else if (!draft.imageReference.trim()) {
		errors.imageReference = "请输入镜像地址。";
	}
	const validateIdentifierList = (
		value: string,
		label: string,
		key: string,
	) => {
		const values = splitValues(value);
		if (values.some((item) => /\s/.test(item)))
			errors[key] = `${label}格式不正确，请每行填写一个 ID。`;
		if (new Set(values).size !== values.length)
			errors[key] = `${label}不能重复。`;
	};
	validateIdentifierList(draft.coOwnerIds, "共同 Owner 用户 ID", "coOwnerIds");
	validateIdentifierList(
		draft.userAvailabilityIds,
		"可使用的用户 ID",
		"userAvailabilityIds",
	);
	validateIdentifierList(
		draft.organizationAvailabilityIds,
		"可使用的组织 ID",
		"organizationAvailabilityIds",
	);
	const validateRows = (
		rows: readonly AgentApplicationEnvironmentDraft[],
		prefix: "environment" | "secret",
		allowedNames?: readonly string[],
	) => {
		const allowed = allowedNames ? new Set(allowedNames) : undefined;
		const nameCounts = new Map<string, number>();
		for (const row of rows) {
			const name = row.name.trim();
			if (name) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
		}
		rows.forEach((row, index) => {
			const name = row.name.trim();
			if (name && allowed && !allowed.has(name))
				errors[`${prefix}.${index}.name`] =
					"该名称已不再允许使用，请重新选择。";
			if (name && nameCounts.get(name) !== 1)
				errors[`${prefix}.${index}.name`] = "名称不能重复。";
		});
		rows.forEach((row, index) => {
			if (!row.name.trim())
				errors[`${prefix}.${index}.name`] = "请选择或填写名称。";
			if (!row.value) errors[`${prefix}.${index}.value`] = "请输入值。";
		});
	};
	validateRows(
		draft.environment,
		"environment",
		draft.sourceKind === "standard"
			? context.allowedEnvironmentKeys
			: undefined,
	);
	validateRows(
		draft.secrets,
		"secret",
		draft.sourceKind === "standard" ? context.allowedSecretKeys : undefined,
	);
	if (context.modelConfigurationVisible) {
		if (draft.models.length === 0)
			errors.defaultModelOptionId = "至少添加一个模型选项。";
		draft.models.forEach((model, index) => {
			if (!model.endpointId)
				errors[`model.${index}.endpointId`] = "请选择模型端点。";
			if (!model.modelId) errors[`model.${index}.modelId`] = "请选择模型。";
			if (!model.reasoningLevels.trim())
				errors[`model.${index}.reasoningLevels`] = "至少选择一个推理档位。";
			if (context.requiresReplacementCredential && !model.credentialValue)
				errors[`model.${index}.credentialValue`] = "请输入模型凭证。";
			if (
				context.staleModelIndexes?.includes(index) ||
				(context.staleModelIndexes === undefined && context.staleModel)
			)
				errors[`model.${index}.modelId`] = "模型选项已移除，请重新选择。";
		});
		const optionIndexes = new Map<string, number[]>();
		draft.models.forEach((model, index) => {
			const keys = [
				...(model.optionId ? [`id:${model.optionId}`] : []),
				...(model.endpointId && model.modelId
					? [`pair:${JSON.stringify([model.endpointId, model.modelId])}`]
					: []),
			];
			for (const key of keys) {
				const indexes = optionIndexes.get(key) ?? [];
				indexes.push(index);
				optionIndexes.set(key, indexes);
			}
		});
		for (const indexes of optionIndexes.values()) {
			if (indexes.length < 2) continue;
			for (const index of indexes)
				errors[`model.${index}.modelId`] = "模型选项不能重复。";
		}
		if (
			!draft.defaultModelOptionId ||
			draft.models.filter(
				(model) => model.optionId === draft.defaultModelOptionId,
			).length !== 1
		)
			errors.defaultModelOptionId = "请选择默认模型。";
		if (!draft.defaultReasoningLevel)
			errors.defaultReasoningLevel = "请选择默认推理档位。";
		else if (
			!context.defaultModelReasoningLevels?.includes(
				draft.defaultReasoningLevel,
			)
		)
			errors.defaultReasoningLevel = "默认推理档位不属于所选模型。";
	}
	return errors;
}

function requestBody(
	mode: "create" | "update",
	draft: AgentApplicationFormDraft,
) {
	const source: AgentApplicationCreateRequestV2Writable["source"] =
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
		schemaVersion: 2 as const,
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
): AgentApplicationCreateRequestV2Writable;
export function buildAgentApplicationRequest(
	mode: "update",
	draft: AgentApplicationFormDraft,
): AgentApplicationUpdateRequestV2Writable;
export function buildAgentApplicationRequest(
	mode: "create" | "update",
	draft: AgentApplicationFormDraft,
) {
	const body = requestBody(mode, draft);
	const secrets = secretValues(draft);
	if (mode === "create") return { ...body, secrets };

	return { ...body, ...(secrets.length === 0 ? {} : { secrets }) };
}
