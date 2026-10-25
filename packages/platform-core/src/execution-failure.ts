/**
 * #3377：渠道无关的用户可见失败分类（工程 Spec §16.1.1、PRD 10.5）。与 Contract
 * `ExecutionFailureCategoryV1` 的取值一一对应；Web 与企微都读取这里的分类与说明。
 */
export type ExecutionFailureCategoryV1 =
	| "model_unavailable"
	| "agent_updating"
	| "session_preparation_failed"
	| "attachment_unreadable"
	| "authorization_revoked"
	| "relay_key_unavailable"
	| "queue_timeout"
	| "conversation_unavailable"
	| "internal_error";

export const executionFailureCategoriesV1: readonly ExecutionFailureCategoryV1[] =
	[
		"model_unavailable",
		"agent_updating",
		"session_preparation_failed",
		"attachment_unreadable",
		"authorization_revoked",
		"relay_key_unavailable",
		"queue_timeout",
		"conversation_unavailable",
		"internal_error",
	];

/**
 * 码到分类的完整对照。只收录已持久的受限码：Runtime `protocolCode`、Platform 任务原因、
 * Dispatch 失败码与 Relay Key 码。每个码只属于一个分类；新增码先在这里确定分类再发布。
 * 明确归入内部错误的码也列出，表示已经确认过，而不是漏掉。
 */
const exactCodes: Readonly<Record<string, ExecutionFailureCategoryV1>> = {
	// 模型服务繁忙或超时：限流、超时、上游暂时故障、流中断。
	PROVIDER_RATE_LIMITED: "model_unavailable",
	MODEL_STREAM_IDLE_TIMEOUT: "model_unavailable",
	RUNTIME_MODEL_ACCESS_CAPACITY: "model_unavailable",
	RUNTIME_MODEL_DRAIN_FAILED: "model_unavailable",
	RUNTIME_MODEL_STREAM_INVALID: "model_unavailable",
	// Agent 正在更新：正在应用新的 Runtime 修订，或 Workload 启动、更新中。
	AGENT_UNAVAILABLE: "agent_updating",
	AGENT_UPDATING: "agent_updating",
	AGENT_STARTING: "agent_updating",
	// 会话准备失败：Session Sandbox 准备、Driver 物化或启动失败（#3373 的未提交重提用尽）。
	RUNTIME_SESSION_PREPARATION_FAILED: "session_preparation_failed",
	RUNTIME_DRIVER_INVALID: "session_preparation_failed",
	RUNTIME_DRIVER_RECOVERY_FAILED: "session_preparation_failed",
	RUNTIME_STARTUP_FAILED: "session_preparation_failed",
	RUNTIME_ACP_HANDSHAKE_TIMEOUT: "session_preparation_failed",
	RUNTIME_ACP_HANDSHAKE_INTERRUPTED: "session_preparation_failed",
	RUNTIME_CODEX_UNAVAILABLE: "session_preparation_failed",
	RUNTIME_NATIVE_SESSION_UNAVAILABLE: "session_preparation_failed",
	RUNTIME_WORKLOAD_UNAVAILABLE: "session_preparation_failed",
	// 权限已失效。
	AUTHORIZATION_REVOKED: "authorization_revoked",
	AUTHORIZATION_DENIED: "authorization_revoked",
	RUNTIME_AUTHORIZATION_DENIED: "authorization_revoked",
	// 个人 Relay Key 不可用（§10.7）。
	RELAY_KEY_UNAVAILABLE: "relay_key_unavailable",
	RELAY_KEY_AUTHENTICATION_FAILED: "relay_key_unavailable",
	RELAY_KEY_METADATA_INVALID: "relay_key_unavailable",
	RELAY_KEY_VALIDATION_FAILED: "relay_key_unavailable",
	SAVED_RELAY_KEY_UNAVAILABLE: "relay_key_unavailable",
	SAVED_RELAY_KEY_BINDING_INVALID: "relay_key_unavailable",
	// 排队超时。
	TASK_WAIT_TIMEOUT: "queue_timeout",
	// 会话不可用：原生会话被受理不明的 Turn 阻塞，或 Runtime Session 恢复失败。
	CONVERSATION_UNAVAILABLE: "conversation_unavailable",
	RUNTIME_SESSION_BLOCKED: "conversation_unavailable",
	RUNTIME_SESSION_RECOVERY_FAILED: "conversation_unavailable",
	RUNTIME_SESSION_RECOVERY_BLOCKED: "conversation_unavailable",
	RUNTIME_SESSION_QUARANTINED: "conversation_unavailable",
	// #3373：结果不明的恢复用尽墙钟预算，平台无法确认结果。
	RUNTIME_RECOVERY_TIMEOUT: "internal_error",
	RUNTIME_INTERNAL_ERROR: "internal_error",
};
/** 按前缀归类的码族：文件交换与附件读取，个人模型凭证。 */
const codePrefixes: readonly (readonly [string, ExecutionFailureCategoryV1])[] =
	[
		["RUNTIME_FILE_INPUT_", "attachment_unreadable"],
		["RUNTIME_FILE_BRIDGE_", "attachment_unreadable"],
		["RUNTIME_FILE_EXCHANGE_", "attachment_unreadable"],
		["RUNTIME_MODEL_CREDENTIAL_", "relay_key_unavailable"],
	];
/** 模型调用事实的 `failureCode`（RuntimeOperationFailureV2）。 */
const modelFailureCodes: Readonly<Record<string, ExecutionFailureCategoryV1>> =
	{
		dependency_unavailable: "model_unavailable",
		response_incomplete: "model_unavailable",
		interrupted: "model_unavailable",
		authorization_denied: "authorization_revoked",
		authorization_unavailable: "internal_error",
		request_rejected: "internal_error",
		operation_failed: "internal_error",
		persistence_unavailable: "internal_error",
		recovery_unconfirmed: "internal_error",
	};

/** 已确认归类的码返回其分类；没有收录的码返回 null，由调用方继续看下一个来源。 */
export function executionFailureCategoryForCodeV1(
	code: string,
): ExecutionFailureCategoryV1 | null {
	if (Object.hasOwn(exactCodes, code)) return exactCodes[code] ?? null;
	for (const [prefix, category] of codePrefixes)
		if (code.startsWith(prefix) && code.length > prefix.length) return category;
	return null;
}

/** 一次失败已持久的受限原因；只取码，不取错误正文、供应商消息或日志。 */
export interface ExecutionFailureFactsV1 {
	/** Platform `task.status` failed 事件的受限原因。 */
	readonly taskReason?: string | null;
	/** 所属 Conversation 已不可用（status=unavailable 或代次隔离中）。 */
	readonly conversationUnavailable?: boolean;
	/** Dispatch 以 failed 关闭 Turn outbox 时记录的码（Runtime protocolCode 或 Platform 码）。 */
	readonly dispatchCode?: string | null;
	/** Runtime error 事件（`conversation.error`）中最近的码。 */
	readonly runtimeCode?: string | null;
	/** 最近一次失败的模型调用 `failureCode`。 */
	readonly modelFailureCode?: string | null;
}

/**
 * 按来源的确定程度依次取第一个已归类的原因：任务原因、会话已不可用、Dispatch 失败码、
 * Runtime error 码、模型调用 failureCode。都没有已归类的码时为内部错误。
 */
export function classifyExecutionFailureV1(
	facts: ExecutionFailureFactsV1,
): ExecutionFailureCategoryV1 {
	const byCode = (code: string | null | undefined) =>
		typeof code === "string" && code.length > 0
			? executionFailureCategoryForCodeV1(code)
			: null;
	const task = byCode(facts.taskReason);
	if (task) return task;
	if (facts.conversationUnavailable) return "conversation_unavailable";
	const code = byCode(facts.dispatchCode) ?? byCode(facts.runtimeCode);
	if (code) return code;
	const model =
		typeof facts.modelFailureCode === "string" &&
		Object.hasOwn(modelFailureCodes, facts.modelFailureCode)
			? modelFailureCodes[facts.modelFailureCode]
			: undefined;
	return model ?? "internal_error";
}

const messages: Readonly<Record<ExecutionFailureCategoryV1, string>> = {
	model_unavailable: "模型服务暂时繁忙或超时，请稍后重试",
	agent_updating: "Agent 正在更新，请在更新完成后重试",
	session_preparation_failed: "会话准备失败，请重试，仍失败时新建会话",
	attachment_unreadable: "附件无法读取，请重新发送附件",
	authorization_revoked:
		"当前没有使用该 Agent 的权限，请联系 Agent Owner 或管理员",
	relay_key_unavailable: "个人 Relay Key 不可用，请到个人设置处理",
	queue_timeout: "排队超过等待时限，本条消息未处理，请稍后重新发送",
	conversation_unavailable: "当前会话不可用，请新建会话",
	internal_error: "平台内部错误",
};

/**
 * 分类对应的用户说明与建议（工程 Spec §16.1.1）。内部错误附追踪编号便于反馈；
 * 说明不含错误码、内部异常、SQL、Pod 名称、Token、凭证或供应商错误正文。
 */
export function executionFailureMessageV1(
	category: ExecutionFailureCategoryV1,
	traceId?: string | null,
): string {
	if (category === "internal_error")
		return traceId
			? `平台内部错误，反馈时请提供追踪编号 ${traceId}`
			: "平台内部错误，请稍后重试";
	return messages[category];
}
