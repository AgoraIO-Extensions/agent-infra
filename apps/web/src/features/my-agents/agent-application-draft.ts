import type {
	AgentApplicationCreateRequestV2Writable,
	AgentApplicationProjectionV2,
	AgentApplicationUpdateRequestV2Writable,
} from "../../pilot/generated-v2/types.gen.js";

export type AgentApplicationSourceKind =
	| "standard"
	| "custom-platform-adapter"
	| "custom-self-managed"
	| "custom-multi-service";

export type AgentApplicationEnvironmentDraft = {
	name: string;
	value: string;
};

export type AgentApplicationModelDraft = {
	endpointId: string;
	modelId: string;
	optionId: string;
	reasoningLevels: string;
};

export type AgentApplicationFormDraft = {
	coOwnerIds: string;
	configureModels: boolean;
	defaultRelayKey?: string;
	defaultModelOptionId: string;
	defaultReasoningLevel: string;
	description: string;
	environment: readonly AgentApplicationEnvironmentDraft[];
	identityResponsibility: "platform-managed" | "self-managed";
	imageReference: string;
	/** Inline multi-service resource YAML. Optional for legacy single-image drafts. */
	manifest?: string;
	models: readonly AgentApplicationModelDraft[];
	name: string;
	organizationAvailabilityIds: string;
	secrets: readonly AgentApplicationEnvironmentDraft[];
	source?: AgentApplicationCreateRequestV2Writable["source"];
	sourceKind: AgentApplicationSourceKind;
	templateId: string;
	templateRevision?: string;
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
	if ("manifest" in source) return "custom-multi-service";
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
	requiresTemplateReadiness?: boolean;
	requiresDefaultRelayKey?: boolean;
	/** @deprecated Kept for callers compiled against the pre-keyless draft. */
	requiresReplacementCredential?: boolean;
	staleModel: boolean;
	staleModelIndexes?: readonly number[];
	staleTemplate: boolean;
	standardChoicesBlocked: boolean;
	/** 所选模板不可申请的原因（与模板就绪列表同一套文案），作为「标准模板」的字段错误（#3328 N10-2-01）。 */
	templateUnavailableMessage?: string;
	/** 修改申请不能更换模板：模板已移除或不可申请时的字段错误，优先于其余模板错误（#3328）。 */
	lockedTemplateMessage?: string;
	/** 创建申请时部署里没有一个模板可申请：未选模板时的字段错误，代替「请选择标准模板。」（#3364 N12-02）。 */
	noApplicableTemplateMessage?: string;
	/**
	 * 部署选项读取失败、模型目录读不到：模型选择器都禁用，不对它们列「请选择…」「至少…」，由「标准模板」
	 * 字段错误与部署状态说明原因（#3389 N13-10）。只在标准模板选择同时被拦下时生效，提交仍不会发出。
	 */
	modelChoicesUnavailable?: boolean;
};

/**
 * 「标准模板」的字段错误。提交时校验与提交被拦下后按当前状态实时改写共用同一套规则，部署选项重读后
 * 字段错误与顶部提示、就绪列表同源（#3364 N12-01）。来源不是标准模板时没有这项错误。
 */
export function templateFieldError(
	draft: Pick<
		AgentApplicationFormDraft,
		"sourceKind" | "templateId" | "templateRevision"
	>,
	context: Pick<
		AgentApplicationValidationContext,
		| "configurationMessage"
		| "lockedTemplateMessage"
		| "noApplicableTemplateMessage"
		| "requiresTemplateReadiness"
		| "staleTemplate"
		| "standardChoicesBlocked"
		| "templateUnavailableMessage"
	>,
): string | undefined {
	if (draft.sourceKind !== "standard") return undefined;
	if (context.lockedTemplateMessage) return context.lockedTemplateMessage;
	// 部署整体不可用时说明部署；只是所选模板不可申请时沿用就绪原因，不笼统写「部署选项暂不可用」
	// （#3328 N10-2-01）。未选模板时提示选择；没有一个模板可申请时同「部署没有标准模板」说明没有可申请
	// 的模板，不引导一个无法完成的选择（#3364 N12-02）。
	if (context.standardChoicesBlocked)
		return (
			context.configurationMessage ??
			(draft.templateId
				? (context.templateUnavailableMessage ?? "部署选项暂不可用。")
				: (context.noApplicableTemplateMessage ?? "请选择标准模板。"))
		);
	if (context.staleTemplate) return "该模板已移除，请重新选择。";
	if (context.requiresTemplateReadiness && !draft.templateRevision)
		return "模板验证状态已过期，请刷新后重试。";
	if (!draft.templateId) return "请选择标准模板。";
	return undefined;
}

export function validateAgentApplicationDraft(
	draft: AgentApplicationFormDraft,
	context: AgentApplicationValidationContext,
): AgentApplicationFieldErrors {
	const errors: AgentApplicationFieldErrors = {};
	if (!draft.name.trim()) errors.name = "请输入 Agent 名称。";
	if (!draft.description.trim()) errors.description = "请输入用途说明。";
	if (draft.sourceKind === "standard") {
		const templateError = templateFieldError(draft, context);
		if (templateError) errors.templateId = templateError;
	} else if (draft.sourceKind === "custom-multi-service") {
		if (!draft.manifest?.trim()) errors.manifest = "请上传或粘贴多服务 YAML。";
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
			errors[key] = `${label}格式不正确，请选择有效目录成员。`;
		if (new Set(values).size !== values.length)
			errors[key] = `${label}不能重复。`;
	};
	validateIdentifierList(draft.coOwnerIds, "共同 Owner 用户", "coOwnerIds");
	validateIdentifierList(
		draft.userAvailabilityIds,
		"可使用的用户",
		"userAvailabilityIds",
	);
	validateIdentifierList(
		draft.organizationAvailabilityIds,
		"可使用的组织",
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
			if (!row.value.trim()) errors[`${prefix}.${index}.value`] = "请输入值。";
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
	if (
		context.modelConfigurationVisible &&
		!(context.modelChoicesUnavailable && context.standardChoicesBlocked)
	) {
		if (
			context.requiresDefaultRelayKey &&
			!context.standardChoicesBlocked &&
			!draft.defaultRelayKey?.trim()
		)
			errors.defaultRelayKey = "请输入 Agent 默认 Relay Key。";
		if (draft.models.length === 0)
			errors.defaultModelOptionId = "至少添加一个模型选项。";
		draft.models.forEach((model, index) => {
			if (!model.endpointId)
				errors[`model.${index}.endpointId`] = "请选择模型端点。";
			if (!model.modelId) errors[`model.${index}.modelId`] = "请选择模型。";
			if (!model.reasoningLevels.trim())
				errors[`model.${index}.reasoningLevels`] = "至少选择一个推理档位。";
			if (
				model.modelId &&
				(context.staleModelIndexes?.includes(index) ||
					(context.staleModelIndexes === undefined && context.staleModel))
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

/** 由默认 Relay Key 管理模型的申请重新提交：Key、检查时看到的版本和选定的模型集合。 */
export type AgentApplicationKeyReplacement = {
	readonly defaultRelayKey: string;
	readonly expectedConfigurationRevision: number;
	readonly expectedKeyVersion: number | null;
	readonly modelConfiguration: AgentApplicationUpdateRequestV2Writable["modelConfiguration"];
};

function requestBody(
	mode: "create" | "update",
	draft: AgentApplicationFormDraft,
	replacement?: AgentApplicationKeyReplacement,
) {
	const source: AgentApplicationCreateRequestV2Writable["source"] =
		(draft.source?.kind === "custom" && "manifest" in draft.source
			? {
					kind: draft.source.kind,
					interactionMode: draft.source.interactionMode,
					identityResponsibility: draft.source.identityResponsibility,
					manifest: draft.source.manifest,
				}
			: draft.source) ??
		(draft.sourceKind === "standard"
			? {
					kind: "standard",
					templateId: draft.templateId.trim(),
					...(draft.templateRevision
						? { templateRevision: draft.templateRevision }
						: {}),
				}
			: draft.sourceKind === "custom-platform-adapter"
				? {
						kind: "custom",
						imageReference: draft.imageReference.trim(),
						interactionMode: "platform-adapter",
					}
				: draft.sourceKind === "custom-multi-service"
					? {
							kind: "custom",
							interactionMode: "self-managed",
							identityResponsibility: "self-managed",
							manifest: draft.manifest?.trim() ?? "",
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
		...(mode === "create" && draft.defaultRelayKey?.trim()
			? { defaultRelayKey: draft.defaultRelayKey.trim() }
			: {}),
		// 已由默认 Key 管理模型的申请：更换模型集合必须重新提交 Key，模型只能来自该 Key
		// 的候选，并带上检查时看到的版本（#2421）。
		...(mode === "update" && replacement
			? {
					defaultRelayKey: replacement.defaultRelayKey,
					expectedConfigurationRevision:
						replacement.expectedConfigurationRevision,
					expectedKeyVersion: replacement.expectedKeyVersion,
					modelConfiguration: replacement.modelConfiguration,
				}
			: modelConfiguration === undefined
				? {}
				: { modelConfiguration }),
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
	replacement?: AgentApplicationKeyReplacement,
): AgentApplicationUpdateRequestV2Writable;
export function buildAgentApplicationRequest(
	mode: "create" | "update",
	draft: AgentApplicationFormDraft,
	replacement?: AgentApplicationKeyReplacement,
) {
	const body = requestBody(mode, draft, replacement);
	const secrets = secretValues(draft);
	if (mode === "create") return { ...body, secrets };

	return { ...body, ...(secrets.length === 0 ? {} : { secrets }) };
}
