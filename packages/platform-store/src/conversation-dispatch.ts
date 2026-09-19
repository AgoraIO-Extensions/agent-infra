import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";

import {
	type ConversationDispatchClaimDecisionV1,
	type ConversationDispatchClaimV1,
	type ConversationDispatchExecutionStatusV1,
	type ConversationDispatchOperationV1,
	type ConversationDispatchStateTransitionV1,
	type ConversationDispatchStorePortV1,
	type ConversationGenerationIsolationV1,
	type ConversationMetadataRecoveryV1,
	decideConversationDispatchCapacityV1,
	decideConversationDispatchRetryTransitionV1,
	parseConversationMetadataRecoveryV1,
	parseTaskAuthorizationBoundaryV1,
	planConversationGenerationConfirmationV1,
	planConversationGenerationIsolationV1,
	planTaskSystemControlV1,
	type WorkloadReconciliationStateV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { platformDatabaseUrlFromEnvironment } from "./migrate.ts";
import { matchesPostgresErrorCode } from "./postgres-error.ts";
import { readLegacyControlRecoveryInTransaction } from "./task-authorization-migration.ts";
import { decodePersistedWorkloadStateV1 } from "./workload-reconciliation.ts";

type Client = ReturnType<typeof postgres>;
type Transaction = postgres.TransactionSql;

interface GenerationTombstoneRow {
	operation_id: string;
	conversation_id: string;
	session_generation: string | number;
	execution_id: string;
	item_id: string;
	control_record_id: string;
	control_source_id: string;
	original_principal: { kind: "user"; id: string };
	host_session_ref: string;
	status: "pending" | "confirmed";
}
async function readGenerationIsolation(
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
function isolationProjection(
	row: GenerationTombstoneRow,
): ConversationGenerationIsolationV1 {
	return {
		operationId: row.operation_id,
		controlRecordId: row.control_record_id,
		originalPrincipal: row.original_principal,
	};
}

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
	metadataRecovery?: ConversationMetadataRecoveryV1;
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
class DispatchCapacityUnavailable extends Error {
	constructor(readonly outcome: "capacity_wait" | "capacity_unavailable") {
		super(outcome);
	}
}

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
		if (
			error instanceof StaleDispatchLease ||
			error instanceof DispatchCapacityUnavailable
		)
			throw error;
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

function requireSafeCounter(value: unknown, minimum = 0): number {
	const counter = safeCounter(value, minimum);
	if (counter === undefined) throw new TypeError("Stored counter is invalid");
	return counter;
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
	let metadataRecovery: ConversationMetadataRecoveryV1 | undefined;
	if (Object.hasOwn(input, "metadataRecovery")) {
		if (!isTurn(operation)) return undefined;
		try {
			metadataRecovery = parseConversationMetadataRecoveryV1(
				input.metadataRecovery,
			);
		} catch {
			return undefined;
		}
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
					...(metadataRecovery ? ["metadataRecovery"] : []),
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
		...(metadataRecovery ? { metadataRecovery } : {}),
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
	if (claim?.metadataRecovery !== undefined) {
		parseConversationMetadataRecoveryV1(claim.metadataRecovery);
		if (
			!isTurn(claim.operation) ||
			!terminal(claim.executionStatus) ||
			!claim.hostSessionRef ||
			!claim.runtimeCursor
		)
			throw new TypeError("Invalid metadata recovery claim");
	}
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
		(payload.metadataRecovery !== undefined ||
			conversation.authorization_revision ===
				execution.authorization_revision) &&
		generation === payload.sessionGeneration &&
		executionGeneration === payload.sessionGeneration &&
		(payload.metadataRecovery !== undefined ||
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
	if (!outbox || outbox.scope_type !== "conversation")
		return { outcome: "stale" };
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

async function ownedState(
	transaction: Transaction,
	claim: ConversationDispatchClaimV1,
	allowStopChange = false,
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
		(state.execution.status === "submitted" &&
			(transition.executionStatus === "unknown" ||
				transition.executionStatus === "processing")) ||
		(state.execution.status !== "submitted" &&
			transition.executionStatus === "submitted")
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

	/** Recheck the live lease and derive recovery metadata from the original accepted task. */
	async readRuntimeState(input: {
		readonly claim: ConversationDispatchClaimV1;
	}) {
		requireClaim(input.claim);
		const claim = input.claim;
		return databaseOperation(() =>
			this.#client.begin(async (transaction) => {
				await transaction`select set_config('lock_timeout', '5s', true)`;
				const state = await ownedState(transaction, claim, true);
				if (!state) return null;
				const payload = exactPayload(state.outbox.payload, claim.operation);
				if (!payload) return null;
				const stop = await readStop(transaction, claim.executionId);
				const base = {
					agentId: state.execution.agent_id,
					conversationId: state.execution.conversation_id,
					executionId: state.execution.execution_id,
					turnId: state.execution.turn_id,
					sessionGeneration: safeCounter(state.execution.session_generation),
				};
				const origins = await transaction<OutboxRow[]>`
				select * from platform.outbox_items where scope_type = 'conversation'
				and scope_id = ${claim.conversationId}
				and id in (${`conversation:turn:${claim.executionId}`}, ${`conversation:regenerate:${claim.executionId}`})
				and operation in ('conversation.turn.submit.v1', 'conversation.turn.regenerate.v1')
			`;
				const [origin] = origins;
				if (
					origins.length !== 1 ||
					!origin ||
					(isTurn(claim.operation) && origin.id !== state.outbox.id)
				)
					return null;
				const originOperation = operation(origin.operation);
				if (!originOperation || !isTurn(originOperation)) return null;
				const originalPayload = exactPayload(origin.payload, originOperation);
				if (
					!originalPayload?.messageId ||
					originalPayload.executionId !== claim.executionId ||
					originalPayload.conversationId !== claim.conversationId ||
					originalPayload.turnId !== claim.turnId ||
					originalPayload.sessionGeneration !== claim.sessionGeneration ||
					originalPayload.modelOptionId !== state.execution.model_option_id ||
					originalPayload.reasoningLevel !== state.execution.reasoning_level
				)
					return null;
				const message = await readMessage(
					transaction,
					claim.conversationId,
					originalPayload.messageId,
				);
				if (
					!message ||
					message.actor_id !== state.execution.actor_id ||
					message.role !== "user"
				)
					return null;
				const inputFiles = await transaction<{ file_id: string }[]>`
					select file_id from platform.files
					where conversation_id = ${claim.conversationId}
						and record->>'messageId' = ${originalPayload.messageId}
						and record->>'kind' = 'attachment'
						and record->>'status' = 'available'
					order by file_id
				`;
				const original = {
					...base,
					kind: "submit-turn",
					input: {
						text: message.text,
						attachments: inputFiles.map((file) => file.file_id),
					},
					...(state.execution.model_option_id && state.execution.reasoning_level
						? {
								selection: {
									schemaVersion: 1,
									modelOptionId: state.execution.model_option_id,
									reasoningLevel: state.execution.reasoning_level,
								},
							}
						: {}),
				};
				// Preserve the published Host operation digest, including its base64url
				// encoding; it is independent of the V2 Grant's hex request signature.
				function canonical(value: unknown): unknown {
					if (Array.isArray(value)) return value.map(canonical);
					if (!value || typeof value !== "object") return value;
					return Object.fromEntries(
						Object.entries(value)
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([key, entry]) => [key, canonical(entry)]),
					);
				}
				const isolation = await readGenerationIsolation(
					transaction,
					claim.conversationId,
					claim.sessionGeneration,
				);
				if (
					isolation &&
					((isolation.execution_id !== claim.executionId &&
						!claim.metadataRecovery) ||
						isolation.original_principal.id !== claim.actorId)
				)
					return null;
				return {
					hostSessionRef: state.conversation.host_session_ref,
					...(isolation
						? { generationIsolation: isolationProjection(isolation) }
						: {}),
					runtimeCursor: state.execution.last_runtime_cursor,
					...(payload.metadataRecovery
						? { metadataRecovery: payload.metadataRecovery }
						: {}),
					originalOperationDigest: createHash("sha256")
						.update(JSON.stringify(canonical(original)))
						.digest("base64url"),
					executionStatus: state.execution.status,
					stopPending: stop?.status === "submitted",
				};
			}),
		);
	}

	/** Discovery grants no lease; claim rechecks eligibility under database locks. */
	async findDispatchable(input: {
		readonly limit: number;
		readonly afterItemId?: string;
	}): Promise<
		readonly {
			readonly itemId: string;
			readonly operation: ConversationDispatchOperationV1;
		}[]
	> {
		if (
			!Number.isSafeInteger(input.limit) ||
			input.limit < 1 ||
			input.limit > 256 ||
			(input.afterItemId !== undefined && !validText(input.afterItemId))
		) {
			throw new TypeError("Conversation dispatch discovery is invalid");
		}
		return databaseOperation(async () => {
			const rows = await this.#client<
				{ id: string; operation: ConversationDispatchOperationV1 }[]
			>`
				select id, operation from platform.outbox_items
				where scope_type = 'conversation'
					and operation in (
						'conversation.turn.submit.v1', 'conversation.turn.regenerate.v1',
						'conversation.turn.supplement.v1', 'conversation.turn.stop.v1'
					)
					and (
						(status in ('pending', 'retry_scheduled') and available_at <= clock_timestamp())
						or (status = 'processing' and lease_expires_at <= clock_timestamp())
            or (status in ('succeeded', 'failed') and exists (
              select 1 from platform.conversation_generation_tombstones t where t.item_id = outbox_items.id and t.status = 'pending'
            ))
					)
				order by
					case when ${input.afterItemId ?? null}::text is null
						or id > ${input.afterItemId ?? null} then 0 else 1 end,
					id
				limit ${input.limit}
			`;
			return rows.map((row) => ({ itemId: row.id, operation: row.operation }));
		});
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

	async beginGenerationIsolation(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly failureCode: "RUNTIME_SESSION_RECOVERY_FAILED";
		readonly hostSessionRef: string;
	}): Promise<boolean> {
		requireClaim(input.claim);
		return transactionResult(this.#client, async (transaction) => {
			const claim = input.claim;
			const state = await ownedState(transaction, claim, true);
			if (!state) throw new StaleDispatchLease();
			if (
				!validText(input.hostSessionRef) ||
				(state.conversation.host_session_ref !== null &&
					state.conversation.host_session_ref !== input.hostSessionRef)
			)
				throw new StaleDispatchLease();
			const existing = await readGenerationIsolation(
				transaction,
				claim.conversationId,
				claim.sessionGeneration,
			);
			if (existing) {
				if (
					existing.item_id !== claim.itemId ||
					existing.execution_id !== claim.executionId
				)
					throw new StaleDispatchLease();
				return;
			}
			const [authorization] = await transaction<
				{ id: string; boundary: unknown }[]
			>`
        select id, boundary from platform.task_authorization_records where execution_id = ${claim.executionId} for update
      `;
			let originalPrincipal: { kind: "user"; id: string };
			let controlSourceId: string;
			let authorizationRecordId: string;
			if (authorization) {
				const boundary = parseTaskAuthorizationBoundaryV1(
					authorization.boundary,
				);
				planTaskSystemControlV1({
					reason: "generation_isolation",
					workerId: claim.leaseOwner,
					boundary,
					execution: {
						actorId: claim.actorId,
						agentId: claim.agentId,
						channelId: claim.channelId,
						authorizationRevision: claim.authorizationRevision,
						status: state.execution.status,
					},
				});
				originalPrincipal = { kind: "user", id: boundary.principal.id };
				controlSourceId = authorization.id;
				authorizationRecordId = authorization.id;
			} else {
				const historical = await readLegacyControlRecoveryInTransaction(
					transaction,
					claim.executionId,
				);
				if (
					historical?.originalPrincipal.kind !== "user" ||
					historical.originalPrincipal.id !== claim.actorId ||
					historical.conversationId !== claim.conversationId ||
					historical.sessionGeneration !== claim.sessionGeneration ||
					historical.hostSessionRef !== input.hostSessionRef
				)
					throw new StaleDispatchLease();
				// A generation isolation control must be bound to a persisted
				// authorization record. Legacy evidence without that record cannot
				// satisfy the integrity foreign key and therefore fails closed.
				throw new StaleDispatchLease();
			}
			const plan = planConversationGenerationIsolationV1({
				claim: { ...claim, hostSessionRef: input.hostSessionRef },
				originalPrincipal,
				controlSourceId,
				failureCode: input.failureCode,
			});
			const controlRecordId = randomUUID();
			await transaction`
        insert into platform.task_control_records (id, execution_id, authorization_record_id, reason)
        values (${controlRecordId}, ${claim.executionId}, ${authorizationRecordId}, 'generation_isolation')
      `;
			await transaction`
        insert into platform.conversation_generation_tombstones
          (operation_id, conversation_id, session_generation, execution_id, item_id, control_record_id, control_source_id, original_principal, host_session_ref, failure_code)
        values (${plan.operationId}, ${claim.conversationId}, ${claim.sessionGeneration}, ${claim.executionId}, ${claim.itemId}, ${controlRecordId},
          ${plan.controlSourceId}, ${transaction.json(plan.originalPrincipal)}, ${input.hostSessionRef}, ${plan.failureCode})
      `;
			await transaction`
				insert into platform.audit_events (id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, details)
				values (${randomUUID()}, ${claim.traceId}, 'system', ${claim.leaseOwner}, ${plan.auditAction}, 'conversation', ${claim.conversationId}, 'succeeded',
					${claim.requestId}, ${claim.agentId}, ${transaction.json({
						originalPrincipal: plan.originalPrincipal,
						controlSourceId,
						authorizationRecordId,
						controlRecordId,
						operationId: plan.operationId,
						reason: plan.reason,
						failureCode: plan.failureCode,
						executionId: claim.executionId,
						sessionGeneration: claim.sessionGeneration,
					})})
      `;
			await transaction`update platform.conversations set host_session_ref = ${input.hostSessionRef}, updated_at = clock_timestamp() where id = ${claim.conversationId}`;
		});
	}

	async confirmGenerationIsolation(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly operationId: string;
		readonly hostSessionRef: string;
	}): Promise<boolean> {
		requireClaim(input.claim);
		return transactionResult(this.#client, async (transaction) => {
			const claim = input.claim;
			const state = await ownedState(transaction, claim, true);
			if (!state) throw new StaleDispatchLease();
			const isolation = await readGenerationIsolation(
				transaction,
				claim.conversationId,
				claim.sessionGeneration,
			);
			if (
				!isolation ||
				isolation.operation_id !== input.operationId ||
				isolation.item_id !== claim.itemId ||
				isolation.execution_id !== claim.executionId ||
				isolation.original_principal.id !== claim.actorId ||
				isolation.host_session_ref !== input.hostSessionRef ||
				state.conversation.host_session_ref !== input.hostSessionRef ||
				claim.generationIsolation?.controlRecordId !==
					isolation.control_record_id
			)
				throw new StaleDispatchLease();
			const [pendingMetadata] =
				await transaction`select 1 from platform.outbox_items where scope_type = 'conversation' and scope_id = ${claim.conversationId}
				and id <> ${claim.itemId} and payload->>'sessionGeneration' = ${String(claim.sessionGeneration)} and payload ? 'metadataRecovery'
				and status in ('pending', 'retry_scheduled', 'processing') limit 1`;
			if (pendingMetadata) throw new StaleDispatchLease();
			const plan = planConversationGenerationConfirmationV1({
				...claim,
				executionStatus: state.execution.status,
			});
			const failed = await transaction<{ execution_id: string }[]>`
        update platform.conversation_executions set status = 'failed', updated_at = clock_timestamp()
        where conversation_id = ${claim.conversationId} and session_generation = ${claim.sessionGeneration}
          and status::text = any(${plan.executionStatusesToFail}) returning execution_id
      `;
			await transaction`
        update platform.outbox_items set status = 'failed', lease_owner = null, lease_expires_at = null, updated_at = clock_timestamp()
        where scope_type = 'conversation' and scope_id = ${claim.conversationId} and id <> ${claim.itemId}
          and operation = any(${plan.businessOperations})
          and payload->>'sessionGeneration' = ${String(claim.sessionGeneration)} and status in ('pending', 'retry_scheduled', 'processing')
      `;
			await transaction`
        update platform.conversation_messages set status = 'failed', failure_code = ${plan.failureCode}, updated_at = clock_timestamp()
        where conversation_id = ${claim.conversationId} and status = 'submitted' and message_id in (select payload->>'messageId' from platform.outbox_items where scope_type = 'conversation' and scope_id = ${claim.conversationId} and operation = 'conversation.turn.supplement.v1' and payload->>'sessionGeneration' = ${String(claim.sessionGeneration)})
          and execution_id in (select execution_id from platform.conversation_executions where conversation_id = ${claim.conversationId} and session_generation = ${claim.sessionGeneration})
      `;
			await transaction`
        update platform.conversation_stops set status = 'completed', updated_at = clock_timestamp()
        where execution_id in (select execution_id from platform.conversation_executions where conversation_id = ${claim.conversationId} and session_generation = ${claim.sessionGeneration})
          and status = 'submitted'
      `;
			for (const execution of failed)
				await transaction`
        insert into platform.audit_events (id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, details)
        values (${randomUUID()}, ${claim.traceId}, 'system', ${claim.leaseOwner}, ${plan.executionAuditAction}, 'execution', ${execution.execution_id}, 'succeeded',
          ${claim.requestId}, ${claim.agentId}, ${transaction.json({
						operationId: isolation.operation_id,
						originalPrincipal: isolation.original_principal,
						reason: plan.failureCode,
						sessionGeneration: claim.sessionGeneration,
					})})
      `;
			await closeOutbox(
				transaction,
				state,
				claim,
				plan.originalOutboxStatus,
				plan.failureCode,
			);
			await transaction`
        update platform.conversations set session_generation = ${plan.nextGeneration}, status = ${plan.conversationStatus}, updated_at = clock_timestamp()
        where id = ${claim.conversationId} and session_generation = ${claim.sessionGeneration}
      `;
			await transaction`update platform.conversation_generation_tombstones set status = 'confirmed', confirmed_at = clock_timestamp() where operation_id = ${isolation.operation_id}`;
			await transaction`
        insert into platform.audit_events (id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, details)
        values (${randomUUID()}, ${claim.traceId}, 'system', ${claim.leaseOwner}, ${plan.confirmationAuditAction}, 'conversation', ${claim.conversationId}, 'succeeded',
          ${claim.requestId}, ${claim.agentId}, ${transaction.json({
						operationId: isolation.operation_id,
						originalPrincipal: isolation.original_principal,
						previousGeneration: claim.sessionGeneration,
						sessionGeneration: plan.nextGeneration,
					})})
      `;
		});
	}

	async renew(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly leaseDurationMs: number;
	}): Promise<boolean> {
		requireClaim(input.claim);
		requireLeaseDuration(input.leaseDurationMs);
		return transactionResult(this.#client, async (transaction) => {
			// Stop changes authority, not ownership of the original event drain.
			const state = await ownedState(transaction, input.claim, true);
			if (!state) throw new StaleDispatchLease();
			await renewLease(transaction, input.claim, input.leaseDurationMs);
		});
	}

	async prepareRuntimeDispatch(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly leaseDurationMs: number;
	}): Promise<boolean | "capacity_wait" | "capacity_unavailable"> {
		requireClaim(input.claim);
		if (input.claim.metadataRecovery)
			throw new TypeError("Metadata recovery cannot dispatch business work");
		requireLeaseDuration(input.leaseDurationMs);
		try {
			return await transactionResult(this.#client, async (transaction) => {
				// Agent first: management/configuration/reconciliation use this same row.
				// Never hold another Conversation's execution lock while waiting for it.
				await transaction`select id from platform.agents where id = ${input.claim.agentId} for update`;
				// Read only after acquiring the lock: a join evaluated while waiting could
				// retain a pre-lock snapshot of application or reconciliation state.
				const [agent] = await transaction<
					{
						current_configuration_revision: string;
						status: string | null;
						desired_state: string | null;
						service_availability: string | null;
						workload_revision: string | null;
						fence: string | null;
						state: unknown;
					}[]
				>`
				select a.current_configuration_revision::text, ap.status, ap.desired_state,
					ap.service_availability, ap.workload_revision::text, ap.fence::text, w.state
				from platform.agents a
				left join platform.agent_applications ap on ap.agent_id = a.id
				left join platform.workload_reconciliations w on w.agent_id = a.id
					where a.id = ${input.claim.agentId}
				`;
				if (!agent)
					throw new DispatchCapacityUnavailable("capacity_unavailable");
				const state = await ownedState(transaction, input.claim);
				if (!state) throw new StaleDispatchLease();
				const pendingIsolation = await readGenerationIsolation(
					transaction,
					input.claim.conversationId,
					input.claim.sessionGeneration,
				);
				if (
					pendingIsolation &&
					input.claim.operation !== "conversation.turn.stop.v1"
				)
					throw new StaleDispatchLease();
				if (
					isTurn(input.claim.operation) &&
					state.execution.status === "submitted"
				) {
					let workload: WorkloadReconciliationStateV1;
					let desired: ReturnType<typeof validateAgentWorkloadDesiredV1>;
					try {
						const decoded = decodePersistedWorkloadStateV1(
							agent?.state,
							input.claim.agentId,
						);
						if (!agent || !decoded || decoded.legacy) throw new Error();
						workload = decoded.state;
						desired = validateAgentWorkloadDesiredV1(
							workload.verified?.deployment,
						);
					} catch {
						throw new DispatchCapacityUnavailable("capacity_unavailable");
					}
					const [occupancy] = await transaction<
						{ processing: string; unknown: string }[]
					>`
							select count(*) filter (where status = 'processing')::text as processing,
									count(*) filter (where status = 'unknown' or (status <> 'processing' and exists (
										select 1 from platform.conversation_generation_tombstones t
										where t.execution_id = conversation_executions.execution_id
											and t.status = 'pending'
									)))::text as unknown
							from platform.conversation_executions where agent_id = ${input.claim.agentId}
								and (status in ('processing', 'unknown') or exists (select 1 from platform.conversation_generation_tombstones t where t.execution_id = conversation_executions.execution_id and t.status = 'pending'))
						`;
					let capacityDecision: ReturnType<
						typeof decideConversationDispatchCapacityV1
					>;
					try {
						// The Core decision consumes this locked snapshot, before any occupied state is written.
						capacityDecision = decideConversationDispatchCapacityV1({
							agentId: input.claim.agentId,
							modelConfigurationRevision:
								input.claim.modelConfigurationRevision,
							configurationRevision: requireSafeCounter(
								agent.current_configuration_revision,
								1,
							),
							status: agent.status,
							desiredState: agent.desired_state,
							serviceAvailability: agent.service_availability,
							workloadRevision: requireSafeCounter(agent.workload_revision, 1),
							fence: requireSafeCounter(agent.fence, 1),
							workload,
							deployment: {
								agentId: desired.agentId,
								configurationRevision: desired.configRevision,
								interactionMode: desired.runtimeManifest.interactionMode,
								imageDigest: desired.imageDigest,
								resourceProfileRef: desired.resourceProfileRef,
							},
							occupancy: {
								processing: requireSafeCounter(occupancy?.processing),
								unknown: requireSafeCounter(occupancy?.unknown),
							},
						});
					} catch (error) {
						if (error instanceof DispatchCapacityUnavailable) throw error;
						throw new DispatchCapacityUnavailable("capacity_unavailable");
					}
					if (capacityDecision !== "admit")
						throw new DispatchCapacityUnavailable(capacityDecision);
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
		} catch (error) {
			if (error instanceof DispatchCapacityUnavailable) return error.outcome;
			throw error;
		}
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
		if (input.claim.metadataRecovery)
			throw new TypeError(
				"Metadata recovery cannot record a business response",
			);
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
			input.claim.metadataRecovery &&
			Object.keys(input.transition).length !== 0
		)
			throw new TypeError("Metadata recovery cannot transition business state");
		if (
			(input.status === "failed") !== (input.errorCode !== undefined) ||
			(input.errorCode !== undefined && !symbolicCode.test(input.errorCode))
		) {
			throw new TypeError("Conversation dispatch outcome is invalid");
		}
		return transactionResult(this.#client, async (transaction) => {
			const state = await ownedState(transaction, input.claim, true);
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
				input.claim.metadataRecovery?.originalStatus ?? input.status,
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
			input.claim.metadataRecovery &&
			Object.keys(input.transition).length !== 0
		)
			throw new TypeError("Metadata recovery cannot transition business state");
		if (
			!Number.isSafeInteger(input.retryDelayMs) ||
			input.retryDelayMs < 0 ||
			input.retryDelayMs > 86_400_000 ||
			!symbolicCode.test(input.errorCode)
		) {
			throw new TypeError("Conversation dispatch retry is invalid");
		}
		return transactionResult(this.#client, async (transaction) => {
			const state = await ownedState(transaction, input.claim, true);
			if (!state) throw new StaleDispatchLease();
			// A concurrent stop can commit a terminal response before the original
			// event stream fails. Release its lease without undoing that response or
			// changing the Conversation now owned by a later Execution.
			const transition = decideConversationDispatchRetryTransitionV1({
				operation: input.claim.operation,
				executionStatus: state.execution.status,
				transition: input.transition,
			});
			await applyTransition(transaction, state, input.claim, transition);
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
