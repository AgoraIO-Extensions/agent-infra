import { isDeepStrictEqual } from "node:util";
import {
	parseTaskApiAuditInputV1,
	TaskApiAuditError,
	type TaskApiAuditPlanV1,
} from "@agent-infra/platform-core";
import type postgres from "postgres";

function auditRow(plan: TaskApiAuditPlanV1) {
	const target = plan.target;
	return {
		id: plan.auditId,
		traceId: plan.traceId,
		requestId: plan.requestId,
		actorType: plan.principal.kind,
		actorId: plan.principal.kind === "unknown" ? "unknown" : plan.principal.id,
		action: plan.action,
		targetType: target.kind,
		targetId:
			target.kind === "unknown"
				? "unknown"
				: target.kind === "agent"
					? target.agentId
					: target.kind === "conversation"
						? target.conversationId
						: target.executionId,
		agentId: target.kind === "unknown" ? null : target.agentId,
		outcome: plan.result,
		occurredAt: plan.occurredAt,
		details: {
			schemaVersion: 1,
			operation: plan.operation,
			phase: plan.phase,
			reason: plan.reason,
			target: plan.target,
			...(plan.subscriptionId === undefined
				? {}
				: { subscriptionId: plan.subscriptionId }),
		},
	};
}
export async function requireAudit(
	transaction: postgres.TransactionSql,
	plan: TaskApiAuditPlanV1,
): Promise<void> {
	const row = auditRow(plan);
	const [existing] = await transaction<ReturnType<typeof auditRow>[]>`
		select id, trace_id as "traceId", request_id as "requestId", actor_type as "actorType", actor_id as "actorId",
			action, target_type as "targetType", target_id as "targetId", agent_id as "agentId", outcome,
			occurred_at as "occurredAt", details from platform.audit_events where id=${row.id}
	`;
	if (!existing) throw new TaskApiAuditError("unavailable");
	const { occurredAt: _existingTime, ...existingPayload } = existing;
	const { occurredAt: _newTime, ...newPayload } = row;
	if (!isDeepStrictEqual(existingPayload, newPayload))
		throw new TaskApiAuditError("unavailable");
}
export async function writeAudit(
	transaction: postgres.TransactionSql,
	plan: TaskApiAuditPlanV1,
): Promise<void> {
	const row = auditRow(plan);
	const inserted = await transaction`
		insert into platform.audit_events (id,trace_id,request_id,actor_type,actor_id,action,target_type,target_id,agent_id,outcome,occurred_at,details)
		values (${row.id},${row.traceId},${row.requestId},${row.actorType},${row.actorId},${row.action},${row.targetType},${row.targetId},${row.agentId},${row.outcome},${row.occurredAt},${transaction.json(row.details as never)})
		on conflict (id) do nothing returning id
	`;
	if (inserted.length === 0) await requireAudit(transaction, plan);
}
export async function writeTaskApiAuditV1(
	transaction: postgres.TransactionSql,
	plan: TaskApiAuditPlanV1,
): Promise<void> {
	const { action, ...input } = plan;
	const parsed = parseTaskApiAuditInputV1(input);
	if (parsed.phase !== "access" || action !== "task.api.access")
		throw new TaskApiAuditError("invalid_input");
	await writeAudit(transaction, { ...parsed, action });
}
