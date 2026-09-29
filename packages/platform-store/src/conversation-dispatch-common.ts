import { Buffer } from "node:buffer";
import type {
	ConversationDispatchExecutionStatusV1,
	ConversationDispatchOperationV1,
	ConversationMetadataRecoveryV1,
} from "@agent-infra/platform-core";
import type postgres from "postgres";
import { matchesPostgresErrorCode } from "./postgres-error.ts";

export type Client = ReturnType<typeof postgres>;

export type Transaction = postgres.TransactionSql;

export interface GenerationTombstoneRow {
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

export interface OutboxRow {
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

export interface ConversationRow {
	id: string;
	agent_id: string;
	actor_id: string;
	channel_id: string;
	status: "ready" | "active" | "unavailable";
	session_generation: string | number;
	host_session_ref: string | null;
	authorization_revision: string;
}

export interface ExecutionRow {
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

export interface MessageRow {
	message_id: string;
	conversation_id: string;
	actor_id: string;
	role: string;
	text: string;
	execution_id: string;
	status: string;
}

export interface StopRow {
	execution_id: string;
	stop_request_id: string;
	status: "submitted" | "completed";
}

export interface DispatchState {
	outbox: OutboxRow;
	conversation: ConversationRow;
	execution: ExecutionRow;
}

export interface ConversationPayload {
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

export class ConversationDispatchStoreError extends Error {
	readonly code = "CONVERSATION_DISPATCH_STORE_ERROR";
	readonly retryable: boolean;

	constructor(retryable: boolean) {
		super("Conversation dispatch store is unavailable");
		this.name = "ConversationDispatchStoreError";
		this.retryable = retryable;
	}
}

export class StaleDispatchLease extends Error {}

export class DispatchCapacityUnavailable extends Error {
	constructor(readonly outcome: "capacity_wait" | "capacity_unavailable") {
		super(outcome);
	}
}

export const operations = new Set<ConversationDispatchOperationV1>([
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

export const symbolicCode = /^[A-Z][A-Z0-9_]{0,63}$/;

export const maximumSafeCounter = 9_007_199_254_740_991;

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

export async function databaseOperation<T>(work: () => Promise<T>): Promise<T> {
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

export function validText(value: unknown, maximum = 1024): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.includes("\0") &&
		String.prototype.isWellFormed.call(value) &&
		Buffer.byteLength(value, "utf8") <= maximum
	);
}

export function safeCounter(value: unknown, minimum = 0): number | undefined {
	const normalized = typeof value === "string" ? Number(value) : value;
	return typeof normalized === "number" &&
		Number.isSafeInteger(normalized) &&
		normalized >= minimum &&
		normalized <= maximumSafeCounter
		? normalized
		: undefined;
}

export function requireSafeCounter(value: unknown, minimum = 0): number {
	const counter = safeCounter(value, minimum);
	if (counter === undefined) throw new TypeError("Stored counter is invalid");
	return counter;
}

export function plainObject(
	value: unknown,
): Record<string, unknown> | undefined {
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
