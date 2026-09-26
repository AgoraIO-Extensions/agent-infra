import type {
	ConversationDispatchClaimV1,
	ConversationDispatchStateTransitionV1,
	ConversationGenerationIsolationV1,
} from "@agent-infra/platform-core";
import {
	type Client,
	type ConversationPayload,
	type ConversationRow,
	type DispatchState,
	databaseOperation,
	type ExecutionRow,
	type GenerationTombstoneRow,
	type MessageRow,
	type OutboxRow,
	StaleDispatchLease,
	type StopRow,
	safeCounter,
	type Transaction,
	validText,
} from "./conversation-dispatch-common.js";
import {
	exactPayload,
	operation,
	terminal,
} from "./conversation-dispatch-validation.js";

export async function readGenerationIsolation(
	transaction: Transaction,
	conversationId: string,
	generation: number,
) {
	const [row] = await transaction<GenerationTombstoneRow[]>`
    select * from platform.conversation_generation_tombstones
    where conversation_id = ${conversationId} and session_generation = ${generation} and status = 'pending'
  `;
	if (!row) return undefined;
	if (
		row.operation_id !== `generation:${conversationId}:${generation}` ||
		!row.control_record_id ||
		row.original_principal?.kind !== "user" ||
		!row.original_principal.id ||
		!row.host_session_ref
	)
		throw new TypeError("Stored generation isolation is invalid");
	return row;
}

export function isolationProjection(
	row: GenerationTombstoneRow,
): ConversationGenerationIsolationV1 {
	return {
		operationId: row.operation_id,
		controlRecordId: row.control_record_id,
		originalPrincipal: row.original_principal,
	};
}

export async function lockOutbox(
	transaction: Transaction,
	itemId: string,
): Promise<OutboxRow | undefined> {
	const rows = await transaction<OutboxRow[]>`
		select id, scope_type, scope_id, operation, payload, status, attempt_count,
			available_at, available_at <= clock_timestamp() as available_now,
			available_at = 'infinity'::timestamptz as waiting_available,
			lease_owner, lease_expires_at, delivery_fence::text,
			trace_id, request_id, clock_timestamp() as decision_at
		from platform.outbox_items where id = ${itemId} for update
	`;
	return rows[0];
}

export async function lockConversation(
	transaction: Transaction,
	conversationId: string,
): Promise<ConversationRow | undefined> {
	const rows = await transaction<ConversationRow[]>`
		select id, agent_id, actor_id, channel_id, status, session_generation::text,
			host_session_ref, authorization_revision
		from platform.conversations where id = ${conversationId} for update
	`;
	return rows[0];
}

export async function lockExecution(
	transaction: Transaction,
	conversationId: string,
	executionId: string,
): Promise<ExecutionRow | undefined> {
	const rows = await transaction<ExecutionRow[]>`
		select execution_id, conversation_id, agent_id, actor_id, channel_id, turn_id,
			status, session_generation::text, delivery_fence::text,
			authorization_revision, last_runtime_cursor,
			model_configuration_revision::text, model_option_id, reasoning_level,
			task_wait_order::text, task_wait_deadline
		from platform.conversation_executions
		where execution_id = ${executionId} and conversation_id = ${conversationId}
		for update
	`;
	return rows[0];
}

export async function readMessage(
	transaction: Transaction,
	conversationId: string,
	messageId: string,
): Promise<MessageRow | undefined> {
	const rows = await transaction<MessageRow[]>`
		select message_id, conversation_id, actor_id, role, text, execution_id, status
		from platform.conversation_messages
		where message_id = ${messageId} and conversation_id = ${conversationId}
	`;
	return rows[0];
}

export async function readStop(
	transaction: Transaction,
	executionId: string,
): Promise<StopRow | undefined> {
	const rows = await transaction<StopRow[]>`
		select execution_id, stop_request_id, status
		from platform.conversation_stops where execution_id = ${executionId}
	`;
	return rows[0];
}

async function failPendingSupplements(
	transaction: Transaction,
	conversationId: string,
	executionId: string,
	sessionGeneration: number,
) {
	const [result] = await transaction<
		{ outbox_count: number; message_count: number }[]
	>`
		with failed_outboxes as (
			update platform.outbox_items
			set status = 'failed', lease_owner = null, lease_expires_at = null,
				updated_at = clock_timestamp()
			where scope_type = 'conversation' and scope_id = ${conversationId}
				and operation = 'conversation.turn.supplement.v1'
				and status in ('pending', 'processing', 'retry_scheduled')
				and payload->>'conversationId' = ${conversationId}
				and payload->>'executionId' = ${executionId}
				and payload->>'sessionGeneration' = ${String(sessionGeneration)}
			returning payload->>'messageId' as message_id
		), failed_messages as (
			update platform.conversation_messages as message
			set status = 'failed', failure_code = 'ORIGINAL_RESPONSE_NOT_STARTED',
				updated_at = clock_timestamp()
			from failed_outboxes
			where message.message_id = failed_outboxes.message_id
				and message.conversation_id = ${conversationId}
				and message.execution_id = ${executionId}
				and message.status = 'submitted'
			returning message.message_id
		)
		select (select count(*)::int from failed_outboxes) as outbox_count,
			(select count(*)::int from failed_messages) as message_count
	`;
	if (!result || result.outbox_count !== result.message_count) {
		throw new StaleDispatchLease();
	}
}

export async function cancelStoppedTurn(
	transaction: Transaction,
	outbox: OutboxRow,
	conversation: ConversationRow,
	execution: ExecutionRow,
	stop: StopRow,
	payload: ConversationPayload,
) {
	const stopOutbox = await lockOutbox(
		transaction,
		`conversation:stop:${stop.stop_request_id}`,
	);
	const stopPayload = stopOutbox
		? exactPayload(stopOutbox.payload, "conversation.turn.stop.v1")
		: undefined;
	if (
		!stopOutbox ||
		!stopPayload ||
		stopOutbox.operation !== "conversation.turn.stop.v1" ||
		(stopOutbox.status !== "pending" &&
			stopOutbox.status !== "processing" &&
			stopOutbox.status !== "retry_scheduled") ||
		stopPayload.stopRequestId !== stop.stop_request_id ||
		!bindingMatches(stopOutbox, stopPayload, conversation, execution)
	) {
		throw new StaleDispatchLease();
	}
	const cancelled = await transaction<{ execution_id: string }[]>`
		update platform.conversation_executions
		set status = 'cancelled', updated_at = clock_timestamp()
		where execution_id = ${execution.execution_id}
			and conversation_id = ${conversation.id}
			and status = ${execution.status}
			and delivery_fence = ${execution.delivery_fence}
		returning execution_id
	`;
	const readied = await transaction<{ id: string }[]>`
		update platform.conversations
		set status = case when status = 'active'
			and not exists (select 1 from platform.conversation_executions e
				where e.conversation_id = ${conversation.id} and e.status in ('submitted', 'processing', 'unknown'))
			and not exists (select 1 from platform.conversation_stops s
				join platform.conversation_executions e on e.execution_id = s.execution_id
				where e.conversation_id = ${conversation.id} and s.execution_id <> ${execution.execution_id} and s.status = 'submitted')
			and not exists (select 1 from platform.conversation_generation_tombstones t
				where t.conversation_id = ${conversation.id} and t.status = 'pending')
			then 'ready'::platform.conversation_status else status end, updated_at = clock_timestamp()
		where id = ${conversation.id}
			and session_generation = ${payload.sessionGeneration}
			and authorization_revision = ${conversation.authorization_revision}
		returning id
	`;
	const completedTurn = await transaction<{ id: string }[]>`
		update platform.outbox_items
		set status = 'succeeded', lease_owner = null, lease_expires_at = null,
			updated_at = clock_timestamp()
		where id = ${outbox.id} and status = ${outbox.status}
			and delivery_fence = ${outbox.delivery_fence}
		returning id
	`;
	const completedStop = await transaction<{ id: string }[]>`
		update platform.outbox_items
		set status = 'succeeded', lease_owner = null, lease_expires_at = null,
			updated_at = clock_timestamp()
		where id = ${stopOutbox.id} and status = ${stopOutbox.status}
			and delivery_fence = ${stopOutbox.delivery_fence}
		returning id
	`;
	const completedStopRequest = await transaction<{ execution_id: string }[]>`
		update platform.conversation_stops
		set status = 'completed', updated_at = clock_timestamp()
		where execution_id = ${execution.execution_id}
			and stop_request_id = ${stop.stop_request_id}
			and status = 'submitted'
		returning execution_id
	`;
	await failPendingSupplements(
		transaction,
		conversation.id,
		execution.execution_id,
		payload.sessionGeneration,
	);
	if (
		cancelled.length !== 1 ||
		readied.length !== 1 ||
		completedTurn.length !== 1 ||
		completedStop.length !== 1 ||
		completedStopRequest.length !== 1
	) {
		throw new StaleDispatchLease();
	}
}

export function bindingMatches(
	outbox: OutboxRow,
	payload: ConversationPayload,
	conversation: ConversationRow,
	execution: ExecutionRow,
) {
	const generation = safeCounter(conversation.session_generation, 1);
	const executionGeneration = safeCounter(execution.session_generation, 1);
	const executionModelRevision =
		execution.model_configuration_revision === null
			? null
			: safeCounter(execution.model_configuration_revision, 1);
	const selectedOperation = operation(outbox.operation);
	const executionSelectionValid =
		executionModelRevision !== undefined &&
		new Set([
			executionModelRevision === null,
			execution.model_option_id === null,
			execution.reasoning_level === null,
		]).size === 1 &&
		(execution.model_option_id === null ||
			validText(execution.model_option_id)) &&
		(execution.reasoning_level === null ||
			validText(execution.reasoning_level));
	return (
		outbox.scope_type === "conversation" &&
		outbox.scope_id === payload.conversationId &&
		outbox.operation === selectedOperation &&
		conversation.id === payload.conversationId &&
		execution.execution_id === payload.executionId &&
		execution.conversation_id === conversation.id &&
		conversation.agent_id === execution.agent_id &&
		conversation.actor_id === execution.actor_id &&
		conversation.channel_id === execution.channel_id &&
		(payload.metadataRecovery !== undefined ||
			execution.task_wait_order !== null ||
			conversation.authorization_revision ===
				execution.authorization_revision) &&
		generation === payload.sessionGeneration &&
		executionGeneration === payload.sessionGeneration &&
		(payload.metadataRecovery !== undefined ||
			execution.status === "waiting" ||
			conversation.status !== "unavailable") &&
		validText(outbox.trace_id) &&
		validText(outbox.request_id) &&
		executionSelectionValid &&
		(selectedOperation === "conversation.turn.stop.v1" ||
			(payload.modelConfigurationRevision === executionModelRevision &&
				payload.modelOptionId === execution.model_option_id &&
				payload.reasoningLevel === execution.reasoning_level))
	);
}

function claimMatchesState(
	claim: ConversationDispatchClaimV1,
	state: DispatchState,
) {
	const payload = exactPayload(state.outbox.payload, claim.operation);
	if (
		!payload ||
		JSON.stringify(payload.metadataRecovery) !==
			JSON.stringify(claim.metadataRecovery) ||
		(claim.metadataRecovery &&
			(!terminal(state.execution.status) ||
				!state.execution.last_runtime_cursor))
	)
		return false;
	const outboxFence = safeCounter(state.outbox.delivery_fence, 1);
	const generation = safeCounter(state.conversation.session_generation, 1);
	const executionGeneration = safeCounter(
		state.execution.session_generation,
		1,
	);
	const executionFence = safeCounter(state.execution.delivery_fence);
	const modelConfigurationRevision =
		state.execution.model_configuration_revision === null
			? null
			: safeCounter(state.execution.model_configuration_revision, 1);
	return (
		state.outbox.status === "processing" &&
		(state.execution.task_wait_order === null
			? claim.taskWaitOrder === undefined
			: safeCounter(state.execution.task_wait_order, 1) ===
				claim.taskWaitOrder) &&
		state.outbox.lease_owner === claim.leaseOwner &&
		state.outbox.lease_expires_at !== null &&
		state.outbox.lease_expires_at.getTime() >
			state.outbox.decision_at.getTime() &&
		outboxFence === claim.deliveryFence &&
		state.outbox.operation === claim.operation &&
		state.outbox.scope_type === "conversation" &&
		state.outbox.scope_id === claim.conversationId &&
		state.conversation.id === claim.conversationId &&
		state.conversation.agent_id === claim.agentId &&
		state.conversation.actor_id === claim.actorId &&
		state.conversation.channel_id === claim.channelId &&
		(claim.metadataRecovery !== undefined ||
			state.execution.task_wait_order !== null ||
			state.conversation.authorization_revision ===
				claim.authorizationRevision) &&
		state.execution.execution_id === claim.executionId &&
		state.execution.conversation_id === claim.conversationId &&
		state.execution.agent_id === claim.agentId &&
		state.execution.actor_id === claim.actorId &&
		state.execution.channel_id === claim.channelId &&
		state.execution.turn_id === claim.turnId &&
		state.execution.authorization_revision === claim.authorizationRevision &&
		generation === claim.sessionGeneration &&
		executionGeneration === claim.sessionGeneration &&
		executionFence === claim.executionDeliveryFence &&
		modelConfigurationRevision === claim.modelConfigurationRevision &&
		state.execution.model_option_id === claim.modelOptionId &&
		state.execution.reasoning_level === claim.reasoningLevel
	);
}

export async function ownedState(
	transaction: Transaction,
	claim: ConversationDispatchClaimV1,
	allowStopChange = false,
): Promise<DispatchState | undefined> {
	await transaction`select id from platform.agents where id = ${claim.agentId} for share`;
	const outbox = await lockOutbox(transaction, claim.itemId);
	if (!outbox) return undefined;
	const conversation = await lockConversation(
		transaction,
		claim.conversationId,
	);
	const execution = await lockExecution(
		transaction,
		claim.conversationId,
		claim.executionId,
	);
	if (!conversation || !execution) return undefined;
	const state = { outbox, conversation, execution };
	if (!claimMatchesState(claim, state)) return undefined;
	const stop = await readStop(transaction, claim.executionId);
	return allowStopChange ||
		claim.metadataRecovery !== undefined ||
		(stop?.status === "submitted") === claim.stopPending
		? state
		: undefined;
}

function transitionAllowed(
	state: DispatchState,
	transition: ConversationDispatchStateTransitionV1,
) {
	// Only prepareRuntimeDispatch can reserve new Agent capacity. A later event
	// or retry must never turn an occupied execution back into unreserved waiting.
	if (
		(["waiting", "submitted"].includes(state.execution.status) &&
			(transition.executionStatus === "unknown" ||
				transition.executionStatus === "processing")) ||
		(state.execution.status !== "submitted" &&
			transition.executionStatus === "submitted") ||
		(state.execution.status !== "waiting" &&
			transition.executionStatus === "waiting")
	)
		return false;
	if (
		terminal(state.execution.status) &&
		transition.executionStatus !== undefined &&
		transition.executionStatus !== state.execution.status
	) {
		return false;
	}
	if (
		state.conversation.status === "unavailable" &&
		transition.conversationStatus !== undefined &&
		transition.conversationStatus !== "unavailable"
	) {
		return false;
	}
	return true;
}

export async function applyTransition(
	transaction: Transaction,
	state: DispatchState,
	claim: ConversationDispatchClaimV1,
	transition: ConversationDispatchStateTransitionV1,
) {
	if (!transitionAllowed(state, transition)) throw new StaleDispatchLease();
	if (transition.executionStatus !== undefined) {
		const rows = await transaction<{ execution_id: string }[]>`
			update platform.conversation_executions
			set status = ${transition.executionStatus}, updated_at = clock_timestamp()
			where execution_id = ${claim.executionId}
				and conversation_id = ${claim.conversationId}
				and session_generation = ${claim.sessionGeneration}
				and delivery_fence = ${claim.executionDeliveryFence}
				and status = ${state.execution.status}
			returning execution_id
		`;
		if (rows.length !== 1) throw new StaleDispatchLease();
		state.execution.status = transition.executionStatus;
	}
	if (transition.conversationStatus !== undefined) {
		const rows = await transaction<{ id: string }[]>`
			update platform.conversations
			set status = ${transition.conversationStatus}, updated_at = clock_timestamp()
			where id = ${claim.conversationId}
				and session_generation = ${claim.sessionGeneration}
				and authorization_revision = ${state.conversation.authorization_revision}
				and status = ${state.conversation.status}
			returning id
		`;
		if (rows.length !== 1) throw new StaleDispatchLease();
		state.conversation.status = transition.conversationStatus;
	}
}

async function insertAttemptEvent(
	transaction: Transaction,
	state: DispatchState,
	status: "retry_scheduled" | "succeeded" | "failed",
	errorCode?: string,
) {
	await transaction`
		insert into platform.persisted_events
			(event_id, stream_id, sequence, stream_cursor, event_type, payload,
			 trace_id, occurred_at)
		values
			(${`outbox:${state.outbox.id}:${state.outbox.delivery_fence}`},
			 ${`outbox:${state.outbox.id}`}, ${state.outbox.delivery_fence},
			 ${state.outbox.delivery_fence}, ${`outbox.${status}`},
			 jsonb_strip_nulls(jsonb_build_object(
				'attemptCount', ${state.outbox.attempt_count}::int,
				'deliveryFence', ${String(state.outbox.delivery_fence)}::text,
				'errorCode', ${errorCode ?? null}::text
			 )), ${state.outbox.trace_id}, clock_timestamp())
	`;
}

export async function closeOutbox(
	transaction: Transaction,
	state: DispatchState,
	claim: ConversationDispatchClaimV1,
	status: "succeeded" | "failed",
	errorCode?: string,
) {
	const rows = await transaction<{ id: string }[]>`
		update platform.outbox_items
		set status = ${status}, lease_owner = null, lease_expires_at = null,
			updated_at = clock_timestamp()
		where id = ${claim.itemId} and status = 'processing'
			and lease_owner = ${claim.leaseOwner}
			and delivery_fence = ${claim.deliveryFence}
			and lease_expires_at > clock_timestamp()
		returning id
	`;
	if (rows.length !== 1) throw new StaleDispatchLease();
	await insertAttemptEvent(transaction, state, status, errorCode);
}

export async function retryOutbox(
	transaction: Transaction,
	state: DispatchState,
	claim: ConversationDispatchClaimV1,
	retryDelayMs: number,
	errorCode: string,
) {
	const rows = await transaction<{ id: string }[]>`
		update platform.outbox_items
		set status = 'retry_scheduled',
			available_at = clock_timestamp() +
				(${retryDelayMs}::bigint * interval '1 millisecond'),
			lease_owner = null, lease_expires_at = null, updated_at = clock_timestamp()
		where id = ${claim.itemId} and status = 'processing'
			and lease_owner = ${claim.leaseOwner}
			and delivery_fence = ${claim.deliveryFence}
			and lease_expires_at > clock_timestamp()
		returning id
	`;
	if (rows.length !== 1) throw new StaleDispatchLease();
	await insertAttemptEvent(transaction, state, "retry_scheduled", errorCode);
}

export async function renewLease(
	transaction: Transaction,
	claim: ConversationDispatchClaimV1,
	leaseDurationMs: number,
) {
	const rows = await transaction<{ id: string }[]>`
		update platform.outbox_items
		set lease_expires_at = greatest(
			lease_expires_at,
			clock_timestamp() +
				(${leaseDurationMs}::bigint * interval '1 millisecond')
		), updated_at = clock_timestamp()
		where id = ${claim.itemId} and status = 'processing'
			and lease_owner = ${claim.leaseOwner}
			and delivery_fence = ${claim.deliveryFence}
			and lease_expires_at > clock_timestamp()
		returning id
	`;
	if (rows.length !== 1) throw new StaleDispatchLease();
}

export async function transactionResult(
	client: Client,
	work: (transaction: Transaction) => Promise<void>,
) {
	try {
		await databaseOperation(() =>
			client.begin(async (transaction) => {
				await transaction`select set_config('lock_timeout', '5s', true)`;
				await work(transaction);
			}),
		);
		return true;
	} catch (error) {
		if (error instanceof StaleDispatchLease) return false;
		throw error;
	}
}
