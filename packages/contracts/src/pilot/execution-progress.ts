import { z } from "zod";

/**
 * #3377：渠道无关的用户可见失败分类（工程 Spec §16.1.1、PRD 10.5）。码到分类的映射与说明文案
 * 由 Platform Core 统一维护；这里固定分类集合，Web 与企微读取同一个分类结果。
 *
 * - model_unavailable：模型服务繁忙或超时，可以稍后重试；
 * - agent_updating：Agent 正在更新或启动；
 * - session_preparation_failed：会话准备失败；
 * - attachment_unreadable：附件读取失败；
 * - authorization_revoked：使用该 Agent 的权限已失效；
 * - relay_key_unavailable：个人 Relay Key 不可用；
 * - queue_timeout：排队超过等待时限；
 * - conversation_unavailable：当前会话不可用，需要新建会话；
 * - internal_error：其他未分类的错误，附追踪编号。
 */
export const ExecutionFailureCategoryV1Schema = z.enum([
	"model_unavailable",
	"agent_updating",
	"session_preparation_failed",
	"attachment_unreadable",
	"authorization_revoked",
	"relay_key_unavailable",
	"queue_timeout",
	"conversation_unavailable",
	"internal_error",
]);
export type ExecutionFailureCategoryV1 = z.infer<
	typeof ExecutionFailureCategoryV1Schema
>;

/** 失败回答的分类与 Core 给出的用户说明；不含错误码、内部异常或供应商错误正文。 */
export const ExecutionFailureProjectionV1Schema = z.strictObject({
	category: ExecutionFailureCategoryV1Schema,
	message: z.string().min(1).max(512),
});
export type ExecutionFailureProjectionV1 = z.infer<
	typeof ExecutionFailureProjectionV1Schema
>;

/**
 * #3377：回复处理期间的阶段（PRD 11.2、工程 Spec §14.2.4）。Web 与企微都按
 * {@link executionProgressPhaseV1} 从同一组已持久事实推导，只反映实际发生的处理过程。
 * 排队位次由排队实现（#3376）另行给出，不属于这里的事实。
 */
export type ExecutionProgressPhaseV1 =
	| { readonly kind: "queued" }
	| { readonly kind: "preparing" }
	| { readonly kind: "running" }
	| { readonly kind: "tool"; readonly toolId: string }
	| { readonly kind: "model_retry" };

/** 推导阶段只需要事件类型与 payload；Web 时间线事件与 Store 读出的持久事件都满足。 */
export interface ExecutionProgressEventV1 {
	readonly type: string;
	readonly payload: unknown;
}

// Runtime 已登记的浏览器工具的中性动作描述，与 Web 浏览器卡一致；其余工具显示 toolId。
const browserToolNames: Readonly<Record<string, string>> = {
	browser_navigate: "打开页面",
	browser_observe: "读取页面",
	browser_interact: "操作页面",
};

/** 阶段行中工具的展示名：只含工具名称，不含参数或结果（工程 Spec §14.2.4）。 */
export function executionToolDisplayNameV1(toolId: string): string {
	return Object.hasOwn(browserToolNames, toolId)
		? (browserToolNames[toolId] ?? toolId)
		: toolId;
}

function field(payload: unknown, key: string): unknown {
	return payload && typeof payload === "object" && !Array.isArray(payload)
		? (payload as Record<string, unknown>)[key]
		: undefined;
}
function label(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256;
}

/**
 * 按事件顺序推导同一个 Execution 当前的阶段；`events` 只含该 Execution 的事件。
 *
 * - 最近的 `execution.status` 或 `task.status` 决定基础阶段：waiting 为排队中，submitted 为
 *   准备会话，processing 为执行中；终态与待核实不显示阶段。没有状态事件时用调用方给出的
 *   已持久状态 `persistedStatus`。
 * - 执行中时，最近更新且仍在进行（intent、started）的调用决定更具体的阶段：工具调用显示其
 *   `toolId`；同一模型调用出现第二个及以后的尝试时为模型重试。结束、失败或结果待核实的调用
 *   不再算作进行中，不按时间推测。
 * - 无法识别的事实一律忽略，不据此猜测阶段。
 */
export function executionProgressPhaseV1(
	events: readonly ExecutionProgressEventV1[],
	persistedStatus?: string,
): ExecutionProgressPhaseV1 | null {
	let status = persistedStatus;
	const operations = new Map<
		string,
		{
			attempts: Set<string>;
			kind: "model" | "tool";
			toolId: string | null;
			active: boolean;
			order: number;
		}
	>();
	let order = 0;
	for (const event of events) {
		if (event.type === "execution.status" || event.type === "task.status") {
			const value = field(event.payload, "status");
			if (typeof value === "string") status = value;
			continue;
		}
		if (event.type !== "execution.operation") continue;
		const kind = field(event.payload, "kind");
		const operationRef = field(event.payload, "operationRef");
		const attemptRef = field(event.payload, "attemptRef");
		const phase = field(event.payload, "phase");
		const toolId = field(event.payload, "toolId");
		if (
			(kind !== "model" && kind !== "tool") ||
			!label(operationRef) ||
			!label(attemptRef) ||
			typeof phase !== "string" ||
			(kind === "tool" && !label(toolId))
		)
			continue;
		const key = JSON.stringify([kind, operationRef]);
		const known = operations.get(key);
		const attempts = known?.attempts ?? new Set<string>();
		attempts.add(attemptRef);
		operations.set(key, {
			attempts,
			kind,
			toolId: kind === "tool" ? (toolId as string) : null,
			active: phase === "intent" || phase === "started",
			order: ++order,
		});
	}
	switch (status) {
		case "waiting":
			return { kind: "queued" };
		case "submitted":
			return { kind: "preparing" };
		case "processing":
			break;
		default:
			return null;
	}
	const current = [...operations.values()]
		.filter((item) => item.active)
		.sort((left, right) => right.order - left.order)[0];
	if (current?.kind === "tool" && current.toolId)
		return { kind: "tool", toolId: current.toolId };
	if (current?.kind === "model" && current.attempts.size > 1)
		return { kind: "model_retry" };
	return { kind: "running" };
}
