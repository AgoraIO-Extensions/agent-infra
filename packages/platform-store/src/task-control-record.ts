import { randomUUID } from "node:crypto";
import type { planTaskSystemControlV1 } from "@agent-infra/platform-core";
import type { Transaction } from "./conversation-dispatch-common.js";

/** The caller holds the original Execution and authorization record locks. */
export async function persistTaskControl(
	transaction: Transaction,
	input: {
		readonly plan: ReturnType<typeof planTaskSystemControlV1>;
		readonly authorizationRecordId: string;
		readonly agentId: string;
		readonly traceId: string;
		readonly requestId: string;
	},
): Promise<{ controlRecordId: string }> {
	const { plan } = input;
	const [existing] = await transaction<{ id: string }[]>`
		select id from platform.task_control_records
		where execution_id = ${plan.binding.executionId} and reason = ${plan.audit.reason}
	`;
	if (existing) return { controlRecordId: existing.id };
	const controlRecordId = randomUUID();
	if (plan.revokeAuthorization)
		await transaction`
			update platform.task_authorization_records set revoked_at = coalesce(revoked_at, now())
			where id = ${input.authorizationRecordId}
		`;
	await transaction`
		insert into platform.task_control_records (id, execution_id, authorization_record_id, reason)
		values (${controlRecordId}, ${plan.binding.executionId}, ${input.authorizationRecordId}, ${plan.audit.reason})
	`;
	await transaction`
		insert into platform.audit_events (id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, details)
		values (${randomUUID()}, ${input.traceId}, 'system', ${plan.workerId}, ${plan.audit.action}, 'execution', ${plan.binding.executionId}, 'succeeded', ${input.requestId}, ${input.agentId}, ${transaction.json({ workerId: plan.workerId, originalPrincipal: plan.audit.originalPrincipal, controlRecordId, authorizationRecordId: input.authorizationRecordId, reason: plan.audit.reason })})
	`;
	return { controlRecordId };
}
