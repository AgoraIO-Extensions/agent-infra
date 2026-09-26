import { createHash, randomUUID } from "node:crypto";
import {
	type ConversationDispatchExecutionStatusV1,
	decideConversationStopConfirmationTimeoutV1,
	decideConversationTaskWaitingV1,
	parseTaskAuthorizationBoundaryV1,
} from "@agent-infra/platform-core";
import {
	type DispatchState,
	requireSafeCounter,
	StaleDispatchLease,
	type Transaction,
} from "./conversation-dispatch-common.js";
import { bindingMatches } from "./conversation-dispatch-sql.js";
import { exactPayload } from "./conversation-dispatch-validation.js";

export async function waitingDecision(
	transaction: Transaction,
	state: DispatchState,
	agent:
		| {
				status: string | null;
				desired_state: string | null;
				service_availability: string | null;
		  }
		| undefined,
	isolationPending: boolean,
) {
	const [snapshot] = await transaction<
		{ decision_at: Date; occupied: boolean; earlier_waiting: boolean }[]
	>`
		select clock_timestamp() as decision_at,
			exists (select 1 from platform.conversation_executions e
				where e.conversation_id = ${state.conversation.id}
					and e.execution_id <> ${state.execution.execution_id}
					and (e.status in ('submitted', 'processing', 'unknown')
						or exists (select 1 from platform.conversation_stops s
							where s.execution_id = e.execution_id and s.status = 'submitted'))) as occupied,
			exists (select 1 from platform.conversation_executions e
				where e.conversation_id = ${state.conversation.id} and e.status = 'waiting'
					and e.task_wait_order < ${requireSafeCounter(state.execution.task_wait_order, 1)}) as earlier_waiting
	`;
	if (!snapshot || !state.execution.task_wait_deadline)
		throw new StaleDispatchLease();
	return decideConversationTaskWaitingV1({
		nowMs: snapshot.decision_at.getTime(),
		deadlineMs: state.execution.task_wait_deadline.getTime(),
		agent: agent
			? {
					status: agent.status,
					desiredState: agent.desired_state,
					serviceAvailability: agent.service_availability,
				}
			: null,
		conversationAvailable: state.conversation.status !== "unavailable",
		isolationPending,
		occupied: snapshot.occupied,
		earlierWaiting: snapshot.earlier_waiting,
	});
}

/** The caller holds the original outbox, Conversation and Execution locks. */
export async function recordTaskStatus(
	transaction: Transaction,
	state: DispatchState,
	status: ConversationDispatchExecutionStatusV1,
	workerId: string,
	reason?: string,
) {
	if (
		state.execution.task_wait_order === null &&
		reason !== "STOP_CONFIRMATION_TIMEOUT"
	)
		return;
	const [execution] = await transaction<{ sequence: string }[]>`
		update platform.conversation_executions
		set last_event_sequence = last_event_sequence + 1
		where execution_id = ${state.execution.execution_id}
		returning last_event_sequence::text as sequence
	`;
	const [conversation] = await transaction<{ cursor: string }[]>`
		update platform.conversations set last_conversation_cursor = last_conversation_cursor + 1,
			updated_at = clock_timestamp() where id = ${state.conversation.id}
		returning last_conversation_cursor::text as cursor
	`;
	if (!execution || !conversation) throw new StaleDispatchLease();
	const eventId = randomUUID();
	const event = {
		type: "task.status",
		status,
		...(reason === "STOP_CONFIRMATION_TIMEOUT" ? { reason } : {}),
	};
	const [authorization] = await transaction<{ boundary: unknown }[]>`
		select boundary from platform.task_authorization_records where execution_id = ${state.execution.execution_id}
	`;
	const boundary = authorization
		? parseTaskAuthorizationBoundaryV1(authorization.boundary)
		: undefined;
	if (!boundary && state.execution.task_wait_order !== null)
		throw new StaleDispatchLease();
	if (
		boundary &&
		(boundary.principal.id !== state.execution.actor_id ||
			boundary.agentId !== state.execution.agent_id ||
			boundary.channelId !== state.execution.channel_id)
	)
		throw new StaleDispatchLease();
	await transaction`
		insert into platform.conversation_events
			(event_id, conversation_id, execution_id, adapter_event_key, sequence,
			 conversation_cursor, event_type, event_payload, event_digest, source, runtime_cursor, occurred_at)
		values (${eventId}, ${state.conversation.id}, ${state.execution.execution_id},
			${`platform:${eventId}`}, ${execution.sequence}, ${conversation.cursor},
			'task.status', ${transaction.json(event)},
			${createHash("sha256").update(JSON.stringify(event)).digest("hex")}, 'platform', null, clock_timestamp())
	`;
	await transaction`
		insert into platform.conversation_audit_events
			(id, conversation_id, execution_id, agent_id, actor_id, action, trace_id, request_id, occurred_at)
		values (${randomUUID()}, ${state.conversation.id}, ${state.execution.execution_id},
			${state.execution.agent_id}, ${state.execution.actor_id}, 'conversation.task.status',
			${state.outbox.trace_id}, ${state.outbox.request_id}, clock_timestamp())
	`;
	await transaction`
		insert into platform.audit_events
			(id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, details)
		values (${randomUUID()}, ${state.outbox.trace_id}, 'system', ${workerId}, 'task.status.changed',
			'execution', ${state.execution.execution_id}, 'succeeded', ${state.outbox.request_id},
			${state.execution.agent_id}, ${transaction.json({
				status,
				eventId,
				...(boundary
					? {
							originalPrincipal: {
								kind: boundary.principal.kind,
								id: boundary.principal.id,
							},
						}
					: {
							originalExecution: {
								actorId: state.execution.actor_id,
								channelId: state.execution.channel_id,
							},
						}),
				...(reason ? { reason } : {}),
			})})
	`;
}

export async function finishWaitingTask(
	transaction: Transaction,
	state: DispatchState,
	status: "failed" | "cancelled",
	reason: string,
	workerId: string,
) {
	const payload = exactPayload(
		state.outbox.payload,
		"conversation.turn.submit.v1",
	);
	if (
		!payload ||
		state.outbox.operation !== "conversation.turn.submit.v1" ||
		!bindingMatches(state.outbox, payload, state.conversation, state.execution)
	)
		throw new StaleDispatchLease();
	const rows = await transaction<{ execution_id: string }[]>`
		update platform.conversation_executions set status = ${status}, updated_at = clock_timestamp()
		where execution_id = ${state.execution.execution_id} and status = 'waiting'
			and delivery_fence = ${state.execution.delivery_fence}
		returning execution_id
	`;
	if (rows.length !== 1) throw new StaleDispatchLease();
	const outboxes = await transaction<{ id: string }[]>`
		update platform.outbox_items set status = 'failed',
			lease_owner = null, lease_expires_at = null, updated_at = clock_timestamp()
		where id = ${state.outbox.id} and delivery_fence = ${state.outbox.delivery_fence}
		returning id
	`;
	if (outboxes.length !== 1) throw new StaleDispatchLease();
	await recordTaskStatus(transaction, state, status, workerId, reason);
	state.execution.status = status;
}

/** Observe a durable deadline under the same locks as cancellation and terminal transitions. */
export async function observeStopConfirmationTimeout(
	transaction: Transaction,
	state: DispatchState,
	workerId: string,
) {
	const [stop] = await transaction<
		{
			confirmation_deadline: Date;
			confirmation_timed_out_at: Date | null;
			observed_at: Date;
		}[]
	>`select confirmation_deadline, confirmation_timed_out_at, clock_timestamp() as observed_at
		from platform.conversation_stops where execution_id = ${state.execution.execution_id}`;
	if (!stop) return;
	const decision = decideConversationStopConfirmationTimeoutV1({
		executionStatus: state.execution.status,
		confirmationDeadline: stop.confirmation_deadline.getTime(),
		observedAt: stop.observed_at.getTime(),
		alreadyTimedOut: stop.confirmation_timed_out_at !== null,
	});
	if (!decision) return;
	const rows = await transaction<{ execution_id: string }[]>`
		update platform.conversation_stops set confirmation_timed_out_at = clock_timestamp(), updated_at = clock_timestamp()
		where execution_id = ${state.execution.execution_id}
			and confirmation_timed_out_at is null and confirmation_deadline <= clock_timestamp()
		returning execution_id
	`;
	if (rows.length === 0) return;
	await transaction`update platform.conversation_executions set status = ${decision.status}, updated_at = clock_timestamp()
		where execution_id = ${state.execution.execution_id}`;
	state.execution.status = decision.status;
	await recordTaskStatus(
		transaction,
		state,
		decision.status,
		workerId,
		decision.reason,
	);
}
