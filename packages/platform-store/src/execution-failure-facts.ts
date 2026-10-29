import type { ExecutionFailureFactsV1 } from "@agent-infra/platform-core";
import type postgres from "./observed-postgres.js";

type Database = ReturnType<typeof postgres> | postgres.TransactionSql;

/**
 * #3377：失败执行已持久的受限原因（工程 Spec §16.1.1），供 Core 归入用户可见分类。只读码，
 * 不读错误正文：
 *
 * - `task.status` failed 的受限原因；
 * - Dispatch 以 failed 关闭 Turn outbox 时写入 `persisted_events` 的 `errorCode`；
 * - Runtime error 事件（`conversation.error`）中最近的码；
 * - 最近一次失败的模型调用 `failureCode`。
 *
 * 片段假定 `platform.conversation_executions` 的别名为 `e`，只在执行失败时读取。
 */
export function executionFailureFactsSql(
	database: Database,
	boundToExecutionSequence = false,
) {
	return database`
		case when e.status = 'failed' then (
			select t.event_payload ->> 'reason'
			from platform.conversation_events t
			where t.execution_id = e.execution_id ${boundToExecutionSequence ? database`and t.sequence<=e.last_event_sequence` : database``}
				and t.event_type = 'task.status'
				and t.event_payload ->> 'status' = 'failed'
			order by t.sequence desc
			limit 1
		) end as failure_task_reason,
		case when e.status = 'failed' then (
			select p.payload ->> 'errorCode'
			from platform.outbox_items o
			join platform.persisted_events p
				on p.stream_id = 'outbox:' || o.id
				and p.event_type = 'outbox.failed'
			where o.scope_type = 'conversation'
				and o.scope_id = e.conversation_id
				and o.payload ->> 'executionId' = e.execution_id
				and o.operation in (
					'conversation.turn.submit.v1',
					'conversation.turn.regenerate.v1'
				)
			order by p.occurred_at desc, p.sequence desc
			limit 1
		) end as failure_dispatch_code,
		case when e.status = 'failed' then (
			select t.event_payload ->> 'code'
			from platform.conversation_events t
			where t.execution_id = e.execution_id ${boundToExecutionSequence ? database`and t.sequence<=e.last_event_sequence` : database``}
				and t.event_type = 'conversation.error'
			order by t.sequence desc
			limit 1
		) end as failure_runtime_code,
		case when e.status = 'failed' then (
			select t.event_payload -> 'fact' ->> 'failureCode'
			from platform.conversation_events t
			where t.execution_id = e.execution_id ${boundToExecutionSequence ? database`and t.sequence<=e.last_event_sequence` : database``}
				and t.event_type = 'execution.operation'
				and t.event_payload -> 'fact' ->> 'kind' = 'model'
				and t.event_payload -> 'fact' ->> 'phase' = 'failed'
			order by t.sequence desc
			limit 1
		) end as failure_model_code`;
}

export interface ExecutionFailureFactRowV1 {
	readonly failure_task_reason: string | null;
	readonly failure_dispatch_code: string | null;
	readonly failure_runtime_code: string | null;
	readonly failure_model_code: string | null;
}

/** 受限码只接受有界的符号文本；其他值按没有该原因处理（Core 会归入内部错误）。 */
function code(value: unknown): string | null {
	return typeof value === "string" &&
		/^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(value)
		? value
		: null;
}

export function executionFailureFactsV1(
	row: ExecutionFailureFactRowV1,
): Omit<ExecutionFailureFactsV1, "conversationUnavailable"> {
	return {
		taskReason: code(row.failure_task_reason),
		dispatchCode: code(row.failure_dispatch_code),
		runtimeCode: code(row.failure_runtime_code),
		modelFailureCode: code(row.failure_model_code),
	};
}
