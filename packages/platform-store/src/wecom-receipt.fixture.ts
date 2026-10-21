import { createHash } from "node:crypto";
import type postgres from "postgres";

/**
 * Store 测试夹具：把企微回执对应的执行记为 completed，并追加 Runtime 已排空落库的终态
 * `execution.status` 事件（序号与会话游标接在已有事件之后）。投递只在该事件落库后认领（#3076）。
 */
export async function completeWecomExecutionFixture(
	client: postgres.Sql,
	executionId: string | null,
) {
	if (!executionId) throw new Error("Expected execution");
	await client`update platform.conversation_executions set status='completed'
		where execution_id=${executionId}`;
	const key = `terminal-${executionId}`;
	await client`insert into platform.conversation_events
		(event_id,conversation_id,execution_id,adapter_event_key,sequence,
		 conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,occurred_at,source)
		select ${key}, e.conversation_id, e.execution_id, ${key},
			coalesce((select max(sequence) from platform.conversation_events where execution_id=e.execution_id),0)+1,
			coalesce((select max(conversation_cursor) from platform.conversation_events where conversation_id=e.conversation_id),0)+1,
			'execution.status', ${client.json({ type: "execution.status", status: "completed" })},
			${createHash("sha256").update(key).digest("hex")}, ${`runtime-${key}`}, now(), 'runtime'
		from platform.conversation_executions e where e.execution_id=${executionId}`;
}
