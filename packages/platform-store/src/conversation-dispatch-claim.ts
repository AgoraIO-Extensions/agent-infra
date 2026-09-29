import type {
	ConversationDispatchClaimDecisionV1,
	ConversationDispatchClaimV1,
} from "@agent-infra/platform-core";
import {
	maximumSafeCounter,
	requireSafeCounter,
	StaleDispatchLease,
	safeCounter,
	type Transaction,
} from "./conversation-dispatch-common.js";
import {
	bindingMatches,
	cancelStoppedTurn,
	isolationProjection,
	lockConversation,
	lockExecution,
	lockOutbox,
	readGenerationIsolation,
	readMessage,
	readStop,
} from "./conversation-dispatch-sql.js";
import {
	exactPayload,
	isTurn,
	operation,
	terminal,
} from "./conversation-dispatch-validation.js";

export async function claimWork(
	transaction: Transaction,
	input: {
		readonly schemaVersion: 1;
		readonly itemId: string;
		readonly workerId: string;
		readonly leaseDurationMs: number;
	},
): Promise<ConversationDispatchClaimDecisionV1> {
	const outbox = await lockOutbox(transaction, input.itemId);
	if (outbox?.scope_type !== "conversation") return { outcome: "stale" };
	const conversation = await lockConversation(transaction, outbox.scope_id);
	if (!conversation) return { outcome: "stale" };
	const isolation = await readGenerationIsolation(
		transaction,
		conversation.id,
		requireSafeCounter(conversation.session_generation, 1),
	);
	const isolationWork = isolation?.item_id === input.itemId;
	if (!isolationWork && outbox.status === "succeeded")
		return { outcome: "succeeded" };
	if (!isolationWork && outbox.status === "failed")
		return { outcome: "failed" };
	const decisionAt = outbox.decision_at.getTime();
	if (
		(outbox.status === "processing" &&
			(outbox.lease_expires_at?.getTime() ?? Number.POSITIVE_INFINITY) >
				decisionAt) ||
		(outbox.status !== "processing" &&
			outbox.available_at.getTime() > decisionAt)
	) {
		return { outcome: "busy" };
	}
	const selectedOperation = operation(outbox.operation);
	if (!selectedOperation) return { outcome: "stale" };
	const payload = exactPayload(outbox.payload, selectedOperation);
	if (!payload) return { outcome: "stale" };
	const execution = await lockExecution(
		transaction,
		payload.conversationId,
		payload.executionId,
	);
	if (
		!conversation ||
		!execution ||
		!bindingMatches(outbox, payload, conversation, execution)
	) {
		return { outcome: "stale" };
	}
	if (
		isolation &&
		!isolationWork &&
		selectedOperation !== "conversation.turn.stop.v1" &&
		!payload.metadataRecovery
	)
		return { outcome: "busy" };
	if (
		isolationWork &&
		(isolation?.execution_id !== execution.execution_id ||
			isolation.original_principal.id !== execution.actor_id)
	)
		return { outcome: "stale" };
	if (
		payload.metadataRecovery &&
		(!isTurn(selectedOperation) ||
			!terminal(execution.status) ||
			!execution.last_runtime_cursor ||
			!conversation.host_session_ref ||
			(isolation && isolation.original_principal.id !== execution.actor_id))
	)
		return { outcome: "stale" };
	const message = payload.messageId
		? await readMessage(transaction, payload.conversationId, payload.messageId)
		: undefined;
	const stop = await readStop(transaction, payload.executionId);
	if (
		(payload.messageId !== null) !== (message !== undefined) ||
		(message &&
			(message.actor_id !== execution.actor_id ||
				message.role !== "user" ||
				message.status !== "submitted" ||
				(selectedOperation !== "conversation.turn.regenerate.v1" &&
					message.execution_id !== execution.execution_id))) ||
		(selectedOperation === "conversation.turn.stop.v1" && !stop) ||
		(payload.stopRequestId !== null &&
			stop &&
			(stop.execution_id !== execution.execution_id ||
				stop.stop_request_id !== payload.stopRequestId))
	) {
		return { outcome: "stale" };
	}
	if (
		isTurn(selectedOperation) &&
		execution.status === "submitted" &&
		stop?.status === "submitted"
	) {
		await cancelStoppedTurn(
			transaction,
			outbox,
			conversation,
			execution,
			stop,
			payload,
		);
		return { outcome: "succeeded" };
	}
	const previousFence = safeCounter(outbox.delivery_fence);
	const executionFence = safeCounter(execution.delivery_fence);
	if (
		previousFence === undefined ||
		executionFence === undefined ||
		previousFence >= maximumSafeCounter ||
		(isolationWork && executionFence > previousFence) ||
		(isTurn(selectedOperation) &&
			!isolationWork &&
			(terminal(execution.status)
				? executionFence > previousFence
				: executionFence !== previousFence))
	) {
		return { outcome: "stale" };
	}
	const nextFence = previousFence + 1;
	const claimedRows = await transaction<{ id: string }[]>`
		update platform.outbox_items
		set status = 'processing', attempt_count = attempt_count + 1,
			lease_owner = ${input.workerId},
			lease_expires_at = clock_timestamp() +
				(${input.leaseDurationMs}::bigint * interval '1 millisecond'),
			delivery_fence = ${nextFence}, updated_at = clock_timestamp()
		where id = ${outbox.id} and delivery_fence = ${previousFence}
		returning id
	`;
	if (claimedRows.length !== 1) throw new StaleDispatchLease();
	let currentExecutionFence = executionFence;
	const currentExecutionStatus = execution.status;
	if (
		isTurn(selectedOperation) &&
		(!terminal(execution.status) || isolationWork)
	) {
		const updated = await transaction<{ execution_id: string }[]>`
			update platform.conversation_executions
			set delivery_fence = ${nextFence}, updated_at = clock_timestamp()
			where execution_id = ${execution.execution_id}
				and conversation_id = ${conversation.id}
				and session_generation = ${payload.sessionGeneration}
				and delivery_fence = ${executionFence}
				and status = ${execution.status}
			returning execution_id
		`;
		if (updated.length !== 1) throw new StaleDispatchLease();
		currentExecutionFence = nextFence;
	}
	const [terminalEvent] =
		terminal(execution.status) && execution.last_runtime_cursor
			? await transaction<{ seen: boolean }[]>`
			select exists (
				select 1 from platform.conversation_events
				where conversation_id = ${conversation.id} and execution_id = ${execution.execution_id}
					and source = 'runtime' and event_type = 'execution.status'
					and event_payload->>'status' = ${execution.status} and runtime_cursor is not null
			) as seen
		`
			: [];
	const inputFiles = message
		? await transaction<{ file_id: string }[]>`
        select file_id from platform.files
        where conversation_id = ${conversation.id}
          and record->>'messageId' = ${payload.messageId}
          and record->>'kind' = 'attachment' and record->>'status' = 'available'
        order by file_id
    `
		: [];
	const claim: ConversationDispatchClaimV1 = {
		schemaVersion: 1,
		itemId: outbox.id,
		leaseOwner: input.workerId,
		operation: selectedOperation,
		requestId: outbox.request_id as string,
		traceId: outbox.trace_id,
		agentId: execution.agent_id,
		actorId: execution.actor_id,
		channelId: execution.channel_id,
		conversationId: conversation.id,
		executionId: execution.execution_id,
		turnId: execution.turn_id,
		messageId: payload.messageId,
		stopRequestId: payload.stopRequestId,
		sessionGeneration: payload.sessionGeneration,
		deliveryFence: nextFence,
		executionDeliveryFence: currentExecutionFence,
		authorizationRevision: execution.authorization_revision,
		modelConfigurationRevision:
			execution.model_configuration_revision === null
				? null
				: Number(execution.model_configuration_revision),
		modelOptionId: execution.model_option_id,
		reasoningLevel: execution.reasoning_level,
		hostSessionRef: conversation.host_session_ref,
		runtimeCursor: execution.last_runtime_cursor,
		...(terminalEvent?.seen ? { runtimeTerminalEventSeen: true as const } : {}),
		...(payload.metadataRecovery
			? { metadataRecovery: payload.metadataRecovery }
			: {}),
		input: message
			? {
					text: message.text,
					attachments: inputFiles.map((file) => file.file_id),
				}
			: null,
		executionStatus: currentExecutionStatus,
		stopPending: stop?.status === "submitted",
		...(isolationWork && isolation
			? { generationIsolation: isolationProjection(isolation) }
			: {}),
	};
	return { outcome: "claimed", claim };
}
