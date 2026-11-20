import { cjkSpaced } from "@/lib/cjk-spacing";
import type {
	AgentAvailabilityProjectionV1,
	AgentConfigurationUpdateRequestV2Writable,
	AgentConfigurationUpdateRequestV5Writable,
	AgentProjectionV2,
} from "../../pilot/generated-v2/types.gen.js";

export type AgentConfigurationModelDraft = {
	endpointId: string;
	modelId: string;
	optionId: string;
	reasoningLevels: string;
};

/** 环境变量是普通值：可回显、可修改，整页保存时按整表提交（PRD §5.5）。 */
export type AgentConfigurationEnvironmentDraft = {
	name: string;
	value: string;
};

/**
 * 整页草稿。Secret 不在草稿里：替换 Secret 走只写弹窗的独立请求，明文不进入页面状态
 * （O-10、NI-02、NI-71）。
 */
export type AgentConfigurationDraft = {
	channels?: AgentConfigurationUpdateRequestV2Writable["channels"];
	coOwnerIds: string;
	defaultModelOptionId: string;
	defaultReasoningLevel: string;
	environment: readonly AgentConfigurationEnvironmentDraft[];
	models: readonly AgentConfigurationModelDraft[];
	organizationAvailabilityIds: string;
	/**
	 * 独立应用条目（Spec §9.2.2），由 Owner 读到的完整可用范围填入。只有用户真的改了
	 * 应用条目才以 V5 整表回传，并带上那次读取的管理修订；未改时保存走 V2，只替换人员
	 * 条目，服务端原样保留应用条目，陈旧的读取不会删掉并发加入的应用（#4308）。
	 */
	applicationAvailabilityIds?: string;
	/** 填入 `applicationAvailabilityIds` 时读到的应用 ID，用于判断是否真的编辑过。 */
	applicationAvailabilityBaseline?: readonly string[];
	/** 同一次读取的 Agent 管理修订；V5 保存以它做 CAS，已变则冲突。 */
	applicationAvailabilityRevision?: number;
	replaceModels: boolean;
	workspaceSnapshots: readonly { snapshotId: string; name: string }[];
	userAvailabilityIds: string;
};

function splitValues(value: string) {
	return value
		.split(/[\n,]/)
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

/** 从 Owner 读到的完整可用范围取出应用条目及其读取修订；范围属于别的 Agent 时不取。 */
export function applicationScopeDraft(
	agent: Pick<AgentProjectionV2, "agentId">,
	scope: AgentAvailabilityProjectionV1 | undefined,
): Pick<
	AgentConfigurationDraft,
	| "applicationAvailabilityIds"
	| "applicationAvailabilityBaseline"
	| "applicationAvailabilityRevision"
> {
	if (scope?.agentId !== agent.agentId) return {};
	const ids = scope.availability.flatMap((target) =>
		target.kind === "application" ? [target.applicationId] : [],
	);
	return {
		applicationAvailabilityIds: ids.join("\n"),
		applicationAvailabilityBaseline: ids,
		applicationAvailabilityRevision: scope.managementRevision,
	};
}

export function configurationDraftFromAgent(
	agent: AgentProjectionV2,
	scope?: AgentAvailabilityProjectionV1,
): AgentConfigurationDraft {
	return {
		...applicationScopeDraft(agent, scope),
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
		workspaceSnapshots:
			agent.source.kind === "custom"
				? (agent.source.workspaceSnapshots ?? [])
				: [],
		environment: agent.configuration.environment.map((entry) => ({
			name: entry.name,
			value: entry.value,
		})),
	};
}

/** 与服务端一致：环境变量按名称排序后整表比较。 */
function environmentKey(
	entries: readonly AgentConfigurationEnvironmentDraft[],
) {
	return JSON.stringify(
		entries
			.map((entry) => [entry.name.trim(), entry.value] as const)
			.toSorted(([left], [right]) =>
				left < right ? -1 : left > right ? 1 : 0,
			),
	);
}

/** 草稿中的环境变量是否与当前配置不同；未改动时请求不带 `environment`。 */
export function agentConfigurationEnvironmentChanged(
	agent: AgentProjectionV2,
	draft: Pick<AgentConfigurationDraft, "environment">,
) {
	return (
		environmentKey(draft.environment) !==
		environmentKey(agent.configuration.environment)
	);
}

export type AgentConfigurationRequest =
	| AgentConfigurationUpdateRequestV2Writable
	| AgentConfigurationUpdateRequestV5Writable;

export function buildAgentConfigurationRequest(
	draft: AgentConfigurationDraft,
	agent: AgentProjectionV2,
): AgentConfigurationRequest {
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
	const environment = agentConfigurationEnvironmentChanged(agent, draft)
		? draft.environment.map((entry) => ({
				name: entry.name.trim(),
				value: entry.value,
			}))
		: undefined;

	const people = [
		...splitValues(draft.userAvailabilityIds).map((userId) => ({
			kind: "user" as const,
			userId,
		})),
		...splitValues(draft.organizationAvailabilityIds).map((organizationId) => ({
			kind: "organization" as const,
			organizationId,
		})),
	];
	const revision = draft.applicationAvailabilityRevision;
	return {
		...(!agentConfigurationApplicationsChanged(draft) || revision === undefined
			? { schemaVersion: 2 as const, availability: people }
			: {
					schemaVersion: 5 as const,
					availability: [
						...people,
						...[
							...new Set(applicationIds(draft.applicationAvailabilityIds)),
						].map((applicationId) => ({
							kind: "application" as const,
							applicationId,
						})),
					],
					expectedManagementRevision: revision,
				}),
		coOwnerIds: splitValues(draft.coOwnerIds),
		...(modelConfiguration === undefined ? {} : { modelConfiguration }),
		...(environment === undefined ? {} : { environment }),
		...(draft.channels === undefined ? {} : { channels: draft.channels }),
		...(agent.source.kind === "custom" &&
		JSON.stringify(draft.workspaceSnapshots) !==
			JSON.stringify(agent.source.workspaceSnapshots ?? [])
			? {
					source: {
						...agent.source,
						workspaceSnapshots: [...draft.workspaceSnapshots],
					},
				}
			: {}),
	};
}

function applicationIds(value: string | undefined) {
	return value === undefined ? [] : splitValues(value);
}

/** 草稿里的独立应用条目是否相对填入时读到的条目被编辑过。 */
export function agentConfigurationApplicationsChanged(
	draft: Pick<
		AgentConfigurationDraft,
		"applicationAvailabilityIds" | "applicationAvailabilityBaseline"
	>,
): boolean {
	if (
		draft.applicationAvailabilityIds === undefined ||
		draft.applicationAvailabilityBaseline === undefined
	)
		return false;
	return (
		sortedJson(applicationIds(draft.applicationAvailabilityIds)) !==
		sortedJson(draft.applicationAvailabilityBaseline)
	);
}

/** 按集合比较：服务端对 Owner 与范围去重后再比较，重复的 ID 不算改动。 */
function sortedJson(values: readonly string[]) {
	return JSON.stringify([...new Set(values)].sort());
}

/**
 * 草稿相对已加载的配置是否真有改动（#2560）。服务端把「没有任何变更」的保存拒绝成 409，
 * 页面再提示「权限或 Agent 状态已变化，请刷新页面」是误导，所以没有改动时不应发出保存请求。
 * 比较方式与服务端一致：Owner、可使用范围、模型选项都按集合比较，与顺序无关；环境变量按
 * 名称排序后整表比较；渠道变更一律算改动。
 */
export function agentConfigurationDraftChanged(
	agent: AgentProjectionV2,
	draft: AgentConfigurationDraft,
): boolean {
	if (agentConfigurationApplicationsChanged(draft)) return true;
	const baseline = buildAgentConfigurationRequest(
		configurationDraftFromAgent(agent),
		agent,
	);
	const request = buildAgentConfigurationRequest(draft, agent);
	if (request.channels !== undefined || request.environment !== undefined)
		return true;
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
					: target.kind === "organization"
						? `organization:${target.organizationId}`
						: `application:${target.applicationId}`,
			),
		);
	if (targets(request) !== targets(baseline)) return true;
	if (
		JSON.stringify(request.source ?? null) !==
		JSON.stringify(baseline.source ?? null)
	)
		return true;
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

/** 与服务端 `environmentNamePattern` 一致。 */
export const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * 环境变量名与 Secret 名的前端校验，返回字段错误文案；合法时返回 undefined。
 * `allowedNames` 存在时（标准模板）只允许模板开放的键，页面上名称是下拉，未选时说「请选择」；
 * 自由输入时说「请输入」（#3268 N8-2-11）。
 */
export function configurationKeyError(
	name: string,
	{
		allowedNames,
		kind,
	}: { allowedNames?: readonly string[]; kind: "environment" | "secret" },
): string | undefined {
	const trimmed = name.trim();
	const label = kind === "environment" ? "环境变量名" : "Secret 名称";
	// 「Secret 名称」以拉丁字母开头：与前面的中文之间补空格（「请输入 Secret 名称。」）。
	if (!trimmed)
		return allowedNames
			? cjkSpaced`请选择${label}。`
			: cjkSpaced`请输入${label}。`;
	if (trimmed.startsWith("AGENT_INFRA_"))
		return cjkSpaced`${label}不能以 AGENT_INFRA_ 开头。`;
	if (!environmentNamePattern.test(trimmed))
		return cjkSpaced`${label}只能包含字母、数字和下划线，且不能以数字开头。`;
	if (allowedNames && !allowedNames.includes(trimmed))
		return cjkSpaced`当前模板不允许这个${label}。`;
	return undefined;
}
