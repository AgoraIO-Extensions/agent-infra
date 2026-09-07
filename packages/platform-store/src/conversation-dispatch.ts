import { Buffer } from "node:buffer";

import type {
	ConversationDispatchClaimDecisionV1,
	ConversationDispatchClaimV1,
	ConversationDispatchExecutionStatusV1,
	ConversationDispatchOperationV1,
	ConversationDispatchStateTransitionV1,
	ConversationDispatchStorePortV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";

import { platformDatabaseUrlFromEnvironment } from "./migrate.ts";
import { matchesPostgresErrorCode } from "./postgres-error.ts";

type Client = ReturnType<typeof postgres>;
type Transaction = postgres.TransactionSql;

interface OutboxRow {
	id: string;
	scope_type: string;
	scope_id: string;
	operation: string;
	payload: unknown;
	status: "pending" | "processing" | "retry_scheduled" | "succeeded" | "failed";
	attempt_count: number;
	available_at: Date;
	lease_owner: string | null;
	lease_expires_at: Date | null;
	delivery_fence: string | number;
	trace_id: string;
	request_id: string | null;
	decision_at: Date;
}

interface ConversationRow {
	id: string;
	agent_id: string;
	actor_id: string;
	channel_id: string;
	status: "ready" | "active" | "unavailable";
	session_generation: string | number;
	host_session_ref: string | null;
	authorization_revision: string;
}

interface ExecutionRow {
	execution_id: string;
	conversation_id: string;
	agent_id: string;
	actor_id: string;
	channel_id: string;
	turn_id: string;
	status: ConversationDispatchExecutionStatusV1;
	session_generation: string | number;
	delivery_fence: string | number;
	authorization_revision: string;
	last_runtime_cursor: string | null;
	model_configuration_revision: string | number | null;
	model_option_id: string | null;
	reasoning_level: string | null;
}

interface MessageRow {
	message_id: string;
	conversation_id: string;
	actor_id: string;
	role: string;
	text: string;
	execution_id: string;
	status: string;
}

interface StopRow {
	execution_id: string;
	stop_request_id: string;
	status: "submitted" | "completed";
}

interface DispatchState {
	outbox: OutboxRow;
	conversation: ConversationRow;
	execution: ExecutionRow;
}

interface ConversationPayload {
	schemaVersion: 1;
	conversationId: string;
	executionId: string;
	messageId: string | null;
	turnId: string | null;
	sessionGeneration: number;
	stopRequestId: string | null;
	modelConfigurationRevision: number | null;
	modelOptionId: string | null;
	reasoningLevel: string | null;
}

export interface PostgresConversationDispatchOptionsV1 {
	readonly databaseUrl: string;
}

export class ConversationDispatchStoreError extends Error {
	readonly code = "CONVERSATION_DISPATCH_STORE_ERROR";
	readonly retryable: boolean;

	constructor(retryable: boolean) {
		super("Conversation dispatch store is unavailable");
		this.name = "ConversationDispatchStoreError";
		this.retryable = retryable;
	}
}

class StaleDispatchLease extends Error {}

const operations = new Set<ConversationDispatchOperationV1>([
	"conversation.turn.submit.v1",
	"conversation.turn.regenerate.v1",
	"conversation.turn.supplement.v1",
	"conversation.turn.stop.v1",
]);
const retryableDatabaseCodes = new Set([
	"CONNECT_TIMEOUT",
	"CONNECTION_CLOSED",
	"CONNECTION_DESTROYED",
	"CONNECTION_ENDED",
	"EAI_AGAIN",
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTDOWN",
	"EHOSTUNREACH",
	"ENETDOWN",
	"ENETUNREACH",
	"EPIPE",
	"ETIMEDOUT",
	"55P03",
	"57P01",
	"57P02",
	"57P03",
]);
const symbolicCode = /^[A-Z][A-Z0-9_]{0,63}$/;
const maximumSafeCounter = 9_007_199_254_740_991;

function retryableDatabaseError(error: unknown) {
	return matchesPostgresErrorCode(
		error,
		(code) =>
			retryableDatabaseCodes.has(code) ||
			code.startsWith("08") ||
			code.startsWith("40") ||
			code.startsWith("53"),
	);
}

async function databaseOperation<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof StaleDispatchLease) throw error;
		throw new ConversationDispatchStoreError(retryableDatabaseError(error));
	}
}

function validText(value: unknown, maximum = 1024): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.includes("\0") &&
		String.prototype.isWellFormed.call(value) &&
		Buffer.byteLength(value, "utf8") <= maximum
	);
}

function safeCounter(value: unknown, minimum = 0): number | undefined {
	const normalized = typeof value === "string" ? Number(value) : value;
	return typeof normalized === "number" &&
		Number.isSafeInteger(normalized) &&
		normalized >= minimum &&
		normalized <= maximumSafeCounter
		? normalized
		: undefined;
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function exactPayload(
	value: unknown,
	operation: ConversationDispatchOperationV1,
): ConversationPayload | undefined {
	const input = plainObject(value);
	if (!input) return undefined;
	const isStop = operation === "conversation.turn.stop.v1";
	const selectionKeys = [
		"modelConfigurationRevision",
		"modelOptionId",
		"reasoningLevel",
	] as const;
	const hasSelection = selectionKeys.every((key) => Object.hasOwn(input, key));
	if (
		!isStop &&
		selectionKeys.some((key) => Object.hasOwn(input, key)) !== hasSelection
	) {
		return undefined;
	}
	const expected = new Set(
		isStop
			? [
					"schemaVersion",
					"conversationId",
					"executionId",
					"sessionGeneration",
					"stopRequestId",
				]
			: [
					"schemaVersion",
					"conversationId",
					"executionId",
					"messageId",
					"turnId",
					"sessionGeneration",
					...(hasSelection ? selectionKeys : []),
				],
	);
	if (
		Object.keys(input).length !== expected.size ||
		Object.keys(input).some((key) => !expected.has(key)) ||
		input.schemaVersion !== 1 ||
		!validText(input.conversationId) ||
		!validText(input.executionId) ||
		(isStop
			? !validText(input.stopRequestId)
			: !validText(input.messageId) || !validText(input.turnId))
	) {
		return undefined;
	}
	const sessionGeneration = safeCounter(input.sessionGeneration, 1);
	if (sessionGeneration === undefined) return undefined;
	const modelConfigurationRevision =
		isStop || !hasSelection
			? null
			: input.modelConfigurationRevision === null
				? null
				: safeCounter(input.modelConfigurationRevision, 1);
	const modelOptionId = isStop || !hasSelection ? null : input.modelOptionId;
	const reasoningLevel = isStop || !hasSelection ? null : input.reasoningLevel;
	if (
		modelConfigurationRevision === undefined ||
		new Set([
			modelConfigurationRevision === null,
			modelOptionId === null,
			reasoningLevel === null,
		]).size !== 1 ||
		(modelOptionId !== null && !validText(modelOptionId)) ||
		(reasoningLevel !== null && !validText(reasoningLevel))
	) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		conversationId: input.conversationId,
		executionId: input.executionId,
		messageId: isStop ? null : (input.messageId as string),
		turnId: isStop ? null : (input.turnId as string),
		sessionGeneration,
		stopRequestId: isStop ? (input.stopRequestId as string) : null,
		modelConfigurationRevision,
		modelOptionId: modelOptionId as string | null,
		reasoningLevel: reasoningLevel as string | null,
	};
}

function operation(
	value: unknown,
): ConversationDispatchOperationV1 | undefined {
	return typeof value === "string" &&
		operations.has(value as ConversationDispatchOperationV1)
		? (value as ConversationDispatchOperationV1)
		: undefined;
}

function terminal(status: ConversationDispatchExecutionStatusV1) {
	return (
		status === "completed" || status === "failed" || status === "cancelled"
	);
}

function isTurn(operation: ConversationDispatchOperationV1) {
	return (
		operation === "conversation.turn.submit.v1" ||
		operation === "conversation.turn.regenerate.v1"
	);
}

function requireCommand(input: {
	readonly schemaVersion: 1;
	readonly itemId: string;
	readonly workerId: string;
	readonly leaseDurationMs: number;
}) {
	if (
		!input ||
		typeof input !== "object" ||
		Object.keys(input).some(
			(key) =>
				!["schemaVersion", "itemId", "workerId", "leaseDurationMs"].includes(
					key,
				),
		) ||
		input.schemaVersion !== 1 ||
		!validText(input.itemId) ||
		!validText(input.workerId) ||
		!Number.isSafeInteger(input.leaseDurationMs) ||
		input.leaseDurationMs < 1 ||
		input.leaseDurationMs > 300_000
	) {
		throw new TypeError("Conversation dispatch claim is invalid");
	}
}

function requireClaim(claim: ConversationDispatchClaimV1) {
	if (
		!claim ||
		typeof claim !== "object" ||
		claim.schemaVersion !== 1 ||
		![claim.itemId, claim.leaseOwner].every((value) => validText(value)) ||
		!Number.isSafeInteger(claim.deliveryFence) ||
		claim.deliveryFence < 1
	) {
		throw new TypeError("Conversation dispatch lease is invalid");
	}
}

function requireLeaseDuration(value: number) {
	if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
		throw new TypeError("Conversation dispatch lease duration is invalid");
	}
}

function requireTransition(transition: ConversationDispatchStateTransitionV1) {
	if (!transition || typeof transition !== "object") {
		throw new TypeError("Conversation dispatch transition is invalid");
	}
	if (
		transition.executionStatus !== undefined &&
		![
			"submitted",
			"processing",
			"unknown",
			"completed",
			"failed",
			"cancelled",
		].includes(transition.executionStatus)
	) {
		throw new TypeError("Conversation dispatch transition is invalid");
	}
	if (
		transition.conversationStatus !== undefined &&
		!["ready", "active", "unavailable"].includes(transition.conversationStatus)
	) {
		throw new TypeError("Conversation dispatch transition is invalid");
	}
}

async function lockOutbox(
	transaction: Transaction,
	itemId: string,
): Promise<OutboxRow | undefined> {
	const rows = await transaction<OutboxRow[]>`
		select id, scope_type, scope_id, operation, payload, status, attempt_count,
			available_at, lease_owner, lease_expires_at, delivery_fence::text,
			trace_id, request_id, clock_timestamp() as decision_at
		from platform.outbox_items where id = ${itemId} for update
	`;
	return rows[0];
}

async function lockConversation(
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

async function lockExecution(
	transaction: Transaction,
	conversationId: string,
	executionId: string,
): Promise<ExecutionRow | undefined> {
	const rows = await transaction<ExecutionRow[]>`
		select execution_id, conversation_id, agent_id, actor_id, channel_id, turn_id,
			status, session_generation::text, delivery_fence::text,
			authorization_revision, last_runtime_cursor,
			model_configuration_revision::text, model_option_id, reasoning_level
		from platform.conversation_executions
		where execution_id = ${executionId} and conversation_id = ${conversationId}
		for update
	`;
	return rows[0];
}

async function readMessage(
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

async function readStop(
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

async function cancelStoppedTurn(
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
		set status = 'ready', updated_at = clock_timestamp()
		where id = ${conversation.id}
			and session_generation = ${payload.sessionGeneration}
			and authorization_revision = ${execution.authorization_revision}
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

function bindingMatches(
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
		conversation.authorization_revision === execution.authorization_revision &&
		generation === payload.sessionGeneration &&
		executionGeneration === payload.sessionGeneration &&
		conversation.status !== "unavailable" &&
		validText(outbox.trace_id) &&
		validText(outbox.request_id) &&
		executionSelectionValid &&
		(selectedOperation === "conversation.turn.stop.v1" ||
			(payload.modelConfigurationRevision === executionModelRevision &&
				payload.modelOptionId === execution.model_option_id &&
				payload.reasoningLevel === execution.reasoning_level))
	);
}

async function claimWork(
	transaction: Transaction,
	input: {
		readonly schemaVersion: 1;
		readonly itemId: string;
		readonly workerId: string;
		readonly leaseDurationMs: number;
	},
): Promise<ConversationDispatchClaimDecisionV1> {
	const outbox = await lockOutbox(transaction, input.itemId);
	if (!outbox) return { outcome: "stale" };
	if (outbox.status === "succeeded") return { outcome: "succeeded" };
	if (outbox.status === "failed") return { outcome: "failed" };
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
	const conversation = await lockConversation(
		transaction,
		payload.conversationId,
	);
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
		(isTurn(selectedOperation) && executionFence !== previousFence)
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
	if (isTurn(selectedOperation) && !terminal(execution.status)) {
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
		input: message ? { text: message.text, attachments: [] } : null,
		executionStatus: currentExecutionStatus,
		stopPending: stop?.status === "submitted",
	};
	return { outcome: "claimed", claim };
}

function claimMatchesState(
	claim: ConversationDispatchClaimV1,
	state: DispatchState,
) {
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
		state.conversation.authorization_revision === claim.authorizationRevision &&
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

async function ownedState(
	transaction: Transaction,
	claim: ConversationDispatchClaimV1,
): Promise<DispatchState | undefined> {
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
	return (stop?.status === "submitted") === claim.stopPending
		? state
		: undefined;
}

function transitionAllowed(
	state: DispatchState,
	transition: ConversationDispatchStateTransitionV1,
) {
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

async function applyTransition(
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
				and authorization_revision = ${claim.authorizationRevision}
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

async function closeOutbox(
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

async function retryOutbox(
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

async function renewLease(
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

async function transactionResult(
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

export class PostgresConversationDispatchStoreV1
	implements ConversationDispatchStorePortV1
{
	readonly #client: Client;

	constructor(options: PostgresConversationDispatchOptionsV1) {
		if (!options || typeof options !== "object") {
			throw new TypeError("Conversation dispatch Store options are invalid");
		}
		this.#client = postgres(
			platformDatabaseUrlFromEnvironment({
				PLATFORM_DATABASE_URL: options.databaseUrl,
			}),
		);
	}

	async claim(input: {
		readonly schemaVersion: 1;
		readonly itemId: string;
		readonly workerId: string;
		readonly leaseDurationMs: number;
	}): Promise<ConversationDispatchClaimDecisionV1> {
		requireCommand(input);
		try {
			return await databaseOperation(() =>
				this.#client.begin(async (transaction) => {
					await transaction`select set_config('lock_timeout', '5s', true)`;
					return claimWork(transaction, input);
				}),
			);
		} catch (error) {
			if (error instanceof StaleDispatchLease) return { outcome: "stale" };
			throw error;
		}
	}

	async renew(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly leaseDurationMs: number;
	}): Promise<boolean> {
		requireClaim(input.claim);
		requireLeaseDuration(input.leaseDurationMs);
		return transactionResult(this.#client, async (transaction) => {
			const state = await ownedState(transaction, input.claim);
			if (!state) throw new StaleDispatchLease();
			await renewLease(transaction, input.claim, input.leaseDurationMs);
		});
	}

	async prepareRuntimeDispatch(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly leaseDurationMs: number;
	}): Promise<boolean> {
		requireClaim(input.claim);
		requireLeaseDuration(input.leaseDurationMs);
		return transactionResult(this.#client, async (transaction) => {
			const state = await ownedState(transaction, input.claim);
			if (!state) throw new StaleDispatchLease();
			if (
				isTurn(input.claim.operation) &&
				input.claim.executionStatus === "submitted"
			) {
				const rows = await transaction<{ execution_id: string }[]>`
					update platform.conversation_executions
					set status = 'unknown', updated_at = clock_timestamp()
					where execution_id = ${input.claim.executionId}
						and conversation_id = ${input.claim.conversationId}
						and session_generation = ${input.claim.sessionGeneration}
						and delivery_fence = ${input.claim.executionDeliveryFence}
						and status = 'submitted'
					returning execution_id
				`;
				if (rows.length !== 1) throw new StaleDispatchLease();
			}
			await renewLease(transaction, input.claim, input.leaseDurationMs);
		});
	}

	async cancelUnaccepted(input: {
		readonly claim: ConversationDispatchClaimV1;
	}): Promise<boolean> {
		requireClaim(input.claim);
		return transactionResult(this.#client, async (transaction) => {
			const state = await ownedState(transaction, input.claim);
			const payload = state
				? exactPayload(state.outbox.payload, input.claim.operation)
				: undefined;
			const stop = state
				? await readStop(transaction, input.claim.executionId)
				: undefined;
			if (
				!state ||
				!payload ||
				!isTurn(input.claim.operation) ||
				state.execution.status !== "unknown" ||
				stop?.status !== "submitted"
			) {
				throw new StaleDispatchLease();
			}
			await cancelStoppedTurn(
				transaction,
				state.outbox,
				state.conversation,
				state.execution,
				stop,
				payload,
			);
		});
	}

	async recordRuntimeResponse(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly hostSessionRef: string;
		readonly transition: ConversationDispatchStateTransitionV1;
	}): Promise<boolean> {
		requireClaim(input.claim);
		requireTransition(input.transition);
		if (!validText(input.hostSessionRef)) {
			throw new TypeError("RuntimeHost Session reference is invalid");
		}
		return transactionResult(this.#client, async (transaction) => {
			const state = await ownedState(transaction, input.claim);
			if (
				!state ||
				(state.conversation.host_session_ref !== null &&
					state.conversation.host_session_ref !== input.hostSessionRef)
			) {
				throw new StaleDispatchLease();
			}
			await applyTransition(transaction, state, input.claim, input.transition);
			const rows = await transaction<{ id: string }[]>`
				update platform.conversations
				set host_session_ref = ${input.hostSessionRef}, updated_at = clock_timestamp()
				where id = ${input.claim.conversationId}
					and session_generation = ${input.claim.sessionGeneration}
					and authorization_revision = ${input.claim.authorizationRevision}
					and (host_session_ref is null or host_session_ref = ${input.hostSessionRef})
				returning id
			`;
			if (rows.length !== 1) throw new StaleDispatchLease();
		});
	}

	async finish(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly status: "succeeded" | "failed";
		readonly transition: ConversationDispatchStateTransitionV1;
		readonly errorCode?: string;
	}): Promise<boolean> {
		requireClaim(input.claim);
		requireTransition(input.transition);
		if (
			(input.status === "failed") !== (input.errorCode !== undefined) ||
			(input.errorCode !== undefined && !symbolicCode.test(input.errorCode))
		) {
			throw new TypeError("Conversation dispatch outcome is invalid");
		}
		return transactionResult(this.#client, async (transaction) => {
			const state = await ownedState(transaction, input.claim);
			if (!state) throw new StaleDispatchLease();
			await applyTransition(transaction, state, input.claim, input.transition);
			if (
				input.claim.operation === "conversation.turn.supplement.v1" &&
				input.status === "failed"
			) {
				const failureCode =
					input.errorCode === "AUTHORIZATION_REVOKED" ||
					input.errorCode === "ORIGINAL_RESPONSE_NOT_STARTED" ||
					input.errorCode === "ORIGINAL_RESPONSE_ALREADY_FINISHED"
						? input.errorCode
						: "EXECUTION_FAILED";
				const messages = await transaction<{ message_id: string }[]>`
					update platform.conversation_messages
					set status = 'failed', failure_code = ${failureCode},
						updated_at = clock_timestamp()
					where message_id = ${input.claim.messageId}
						and conversation_id = ${input.claim.conversationId}
						and execution_id = ${input.claim.executionId}
						and status = 'submitted'
					returning message_id
				`;
				if (messages.length !== 1) throw new StaleDispatchLease();
			}
			if (
				input.claim.operation === "conversation.turn.stop.v1" &&
				input.status === "succeeded"
			) {
				const rows = await transaction<{ execution_id: string }[]>`
					update platform.conversation_stops
					set status = 'completed', updated_at = clock_timestamp()
					where execution_id = ${input.claim.executionId}
						and stop_request_id = ${input.claim.stopRequestId}
					returning execution_id
				`;
				if (rows.length !== 1) throw new StaleDispatchLease();
			}
			await closeOutbox(
				transaction,
				state,
				input.claim,
				input.status,
				input.errorCode,
			);
		});
	}

	async retry(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly retryDelayMs: number;
		readonly errorCode: string;
		readonly transition: ConversationDispatchStateTransitionV1;
	}): Promise<boolean> {
		requireClaim(input.claim);
		requireTransition(input.transition);
		if (
			!Number.isSafeInteger(input.retryDelayMs) ||
			input.retryDelayMs < 0 ||
			input.retryDelayMs > 86_400_000 ||
			!symbolicCode.test(input.errorCode)
		) {
			throw new TypeError("Conversation dispatch retry is invalid");
		}
		return transactionResult(this.#client, async (transaction) => {
			const state = await ownedState(transaction, input.claim);
			if (!state) throw new StaleDispatchLease();
			await applyTransition(transaction, state, input.claim, input.transition);
			await retryOutbox(
				transaction,
				state,
				input.claim,
				input.retryDelayMs,
				input.errorCode,
			);
		});
	}

	async close(): Promise<void> {
		await databaseOperation(() => this.#client.end());
	}
}

export function openPostgresConversationDispatchStoreV1(
	options: PostgresConversationDispatchOptionsV1,
) {
	return new PostgresConversationDispatchStoreV1(options);
}
