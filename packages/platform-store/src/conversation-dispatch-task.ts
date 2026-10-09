import { createHash, randomUUID } from "node:crypto";
import {
	type AgentManagementStateV1,
	type ConversationDispatchExecutionStatusV1,
	decideConversationStopConfirmationTimeoutV1,
	decideConversationTaskWaitingV1,
	isTaskApiChannelV1,
	isTaskApplicationAuthorizationCurrentV1,
	isTaskAuthorizationCurrentV1,
	PersonalApiCredentialErrorV1,
	parseTaskAuthorizationBoundaryV1,
	planTaskSystemControlV1,
	publicTaskStatusEventV1,
	resolveCurrentPersonalApiUserV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import {
	readCurrentTaskApiUseGrantV1,
	readCurrentTaskApplicationV1,
} from "./application-task-authorization.js";
import {
	type DispatchState,
	executionPrincipalProjection,
	requireSafeCounter,
	StaleDispatchLease,
	type Transaction,
} from "./conversation-dispatch-common.js";
import { bindingMatches } from "./conversation-dispatch-sql.js";
import { exactPayload } from "./conversation-dispatch-validation.js";
import { persistTaskControl } from "./task-control-record.js";

/** Governance rows precede Agent/outbox locks; no credential participates in accepted work. */
export async function lockWaitingTaskAuthority(
	transaction: Transaction,
	itemId: string,
) {
	await transaction`lock table platform.platform_user_disables in share mode`;
	await transaction`
		select a.id from platform.platform_applications a
		join platform.conversation_executions e on e.principal_type = 'application' and e.actor_id = a.id
		join platform.outbox_items o on o.payload->>'executionId' = e.execution_id and o.scope_id = e.conversation_id
		where o.id = ${itemId} and o.scope_type = 'conversation' and e.status = 'waiting'
		for share of a
	`;
	await transaction`
		select g.principal_id from platform.agent_principal_grants g
		join platform.conversation_executions e on g.principal_type = e.principal_type and g.principal_id = e.actor_id and g.agent_id = e.agent_id
		join platform.outbox_items o on o.payload->>'executionId' = e.execution_id and o.scope_id = e.conversation_id
		where o.id = ${itemId} and o.scope_type = 'conversation' and e.status = 'waiting' and g.grant_type = 'use'
		for share of g
	`;
}

/** Recheck before availability/capacity waits and again before first Runtime preparation. */
export async function revalidateWaitingTask(
	transaction: Transaction,
	state: DispatchState,
	workerId: string,
	userDirectory: TaskUserDirectoryV1 | undefined,
): Promise<boolean> {
	const [record] = await transaction<
		{ id: string; boundary: unknown; revoked_at: Date | null }[]
	>`select id, boundary, revoked_at from platform.task_authorization_records
		where execution_id = ${state.execution.execution_id} for update`;
	if (!record) throw new StaleDispatchLease();
	const boundary = parseTaskAuthorizationBoundaryV1(record.boundary);
	const plan = planTaskSystemControlV1({
		reason: "authorization_revoked",
		workerId,
		boundary,
		execution: {
			executionId: state.execution.execution_id,
			conversationId: state.execution.conversation_id,
			sessionGeneration: requireSafeCounter(
				state.execution.session_generation,
				1,
			),
			actorId: state.execution.actor_id,
			principal: executionPrincipalProjection(state.execution),
			agentId: state.execution.agent_id,
			channelId: state.execution.channel_id,
			authorizationRevision: state.execution.authorization_revision,
			status: state.execution.status,
		},
	});
	let revoked = record.revoked_at !== null;
	if (!revoked) {
		const [management] = await transaction<{ agent: AgentManagementStateV1 }[]>`
			select jsonb_build_object(
				'schemaVersion', 1, 'applicationId', a.id, 'agentId', a.agent_id,
				'applicantId', a.applicant_id, 'status', a.status, 'revision', a.management_revision,
				'approvalRevision', a.approval_revision, 'decisionReason', a.decision_reason,
				'serviceAvailability', a.service_availability, 'desiredState', a.desired_state,
				'workloadRevision', a.workload_revision, 'fence', a.fence, 'failureCode', a.failure_code,
				'ownerIds', (select coalesce(jsonb_agg(owner_id order by owner_id), '[]'::jsonb) from platform.agent_owners where agent_id = a.agent_id),
				'availability', (select coalesce(jsonb_agg(case when target_type = 'user'
					then jsonb_build_object('kind', 'user', 'userId', target_id)
					else jsonb_build_object('kind', 'organization', 'organizationId', target_id) end order by target_type, target_id), '[]'::jsonb)
					from platform.agent_availability where agent_id = a.agent_id)
			) as agent from platform.agent_applications a where a.agent_id = ${boundary.agentId}
		`;
		const agent = management?.agent;
		if (boundary.principal.kind === "application") {
			const application = await readCurrentTaskApplicationV1(transaction, {
				applicationId: boundary.principal.id,
				agentId: boundary.agentId,
			});
			revoked =
				!application ||
				!agent ||
				!isTaskApplicationAuthorizationCurrentV1({
					boundary,
					application,
					agent,
				});
		} else {
			const disabled =
				await transaction`select user_id from platform.platform_user_disables where user_id = ${boundary.principal.id}`;
			const useGrant = await readCurrentTaskApiUseGrantV1(transaction, {
				principal: boundary.principal,
				agentId: boundary.agentId,
			});
			revoked =
				disabled.length !== 0 ||
				(isTaskApiChannelV1(boundary.channelId, boundary.principal) &&
					(!useGrant ||
						useGrant.revoked ||
						boundary.accessSources.length !== 1 ||
						boundary.accessSources[0]?.kind !== "api-use" ||
						boundary.accessSources[0].useGrantRevision !==
							useGrant.authorizationRevision));
			if (!revoked) {
				try {
					const user = await resolveCurrentPersonalApiUserV1(
						userDirectory,
						boundary.principal.id,
					);
					revoked =
						!agent ||
						!isTaskAuthorizationCurrentV1({ boundary, user, agent, useGrant });
				} catch (error) {
					if (!(error instanceof PersonalApiCredentialErrorV1)) throw error;
					const [clock] = await transaction<{ now: Date }[]>`
						select clock_timestamp() as now
					`;
					if (
						state.execution.status === "waiting" &&
						state.execution.task_wait_deadline &&
						clock &&
						state.execution.task_wait_deadline <= clock.now
					)
						return true;
					if (error.code !== "forbidden") throw error;
					revoked = true;
				}
			}
		}
	}
	if (!revoked) return true;
	if (plan.ensureStop || !state.outbox.request_id)
		throw new StaleDispatchLease();
	await persistTaskControl(transaction, {
		plan,
		authorizationRecordId: record.id,
		agentId: boundary.agentId,
		traceId: state.outbox.trace_id,
		requestId: state.outbox.request_id,
	});
	await finishWaitingTask(
		transaction,
		state,
		"cancelled",
		"AUTHORIZATION_REVOKED",
		workerId,
	);
	return false;
}

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
		sandboxReady: state.conversation.sandbox_ready,
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
		(boundary.principal.kind !== state.execution.principal_type ||
			boundary.principal.id !== state.execution.actor_id ||
			boundary.agentId !== state.execution.agent_id ||
			boundary.channelId !== state.execution.channel_id)
	)
		throw new StaleDispatchLease();
	const event = publicTaskStatusEventV1({
		isTask:
			state.execution.task_wait_order !== null ||
			(boundary !== undefined &&
				isTaskApiChannelV1(state.execution.channel_id, boundary.principal)),
		status,
		reason,
	});
	if (!event) return;
	const [execution] = await transaction<{ sequence: string }[]>`
		update platform.conversation_executions
		set last_event_sequence = last_event_sequence + 1
		where execution_id = ${state.execution.execution_id}
		returning last_event_sequence::text as sequence
	`;
	const [conversation] = await transaction<{ cursor: string }[]>`
		update platform.conversations set last_conversation_cursor = last_conversation_cursor + 1,
			updated_at = greatest(updated_at, clock_timestamp()) where id = ${state.conversation.id}
		returning last_conversation_cursor::text as cursor
	`;
	if (!execution || !conversation) throw new StaleDispatchLease();
	const eventId = randomUUID();
	await transaction`
		insert into platform.conversation_events
			(event_id, conversation_id, execution_id, adapter_event_key, sequence,
			 conversation_cursor, event_type, event_payload, event_digest, source, runtime_cursor, occurred_at)
		values (${eventId}, ${state.conversation.id}, ${state.execution.execution_id},
			${`platform:${eventId}`}, ${execution.sequence}, ${conversation.cursor},
			'task.status', ${transaction.json({ ...event })},
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

/** Observe a durable stop deadline under the same locks as cancellation and terminal transitions. */
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
	>`select confirmation_deadline, confirmation_timed_out_at,
			clock_timestamp() as observed_at
		from platform.conversation_stops
		where execution_id = ${state.execution.execution_id}
		for update`;
	if (!stop) return;
	const decision = decideConversationStopConfirmationTimeoutV1({
		executionStatus: state.execution.status,
		confirmationDeadline: stop.confirmation_deadline.getTime(),
		observedAt: stop.observed_at.getTime(),
		alreadyTimedOut: stop.confirmation_timed_out_at !== null,
	});
	if (!decision) return;
	const rows = await transaction<{ execution_id: string }[]>`
		update platform.conversation_stops
		set confirmation_timed_out_at = clock_timestamp(), updated_at = clock_timestamp()
		where execution_id = ${state.execution.execution_id}
			and confirmation_timed_out_at is null
			and confirmation_deadline <= clock_timestamp()
		returning execution_id
	`;
	if (rows.length === 0) return;
	const executions = await transaction<{ execution_id: string }[]>`
		update platform.conversation_executions
		set status = 'unknown', updated_at = clock_timestamp()
		where execution_id = ${state.execution.execution_id}
			and status in ('processing', 'unknown')
		returning execution_id
	`;
	if (executions.length !== 1) throw new StaleDispatchLease();
	state.execution.status = decision.status;
	await recordTaskStatus(
		transaction,
		state,
		decision.status,
		workerId,
		decision.reason,
	);
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
		!bindingMatches(
			state.outbox,
			payload,
			state.conversation,
			state.execution,
			"waiting-settlement",
		)
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
	const messages = await transaction<{ message_id: string }[]>`
		update platform.conversation_messages
		set status = 'failed', failure_code = ${reason},
			updated_at = clock_timestamp()
		where message_id = ${payload.messageId}
			and conversation_id = ${state.conversation.id}
			and execution_id = ${state.execution.execution_id}
			and status = 'submitted'
		returning message_id
	`;
	if (messages.length !== 1) throw new StaleDispatchLease();
	await recordTaskStatus(transaction, state, status, workerId, reason);
	state.execution.status = status;
}
