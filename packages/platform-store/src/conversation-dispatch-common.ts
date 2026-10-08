import { Buffer } from "node:buffer";
import {
	RuntimeExecutionSourceV1Schema,
	RuntimeRelayKeyBindingV1Schema,
} from "@agent-infra/contracts/runtime";
import type {
	ConversationDispatchClaimV1,
	ConversationDispatchExecutionStatusV1,
	ConversationDispatchOperationV1,
	ConversationMetadataRecoveryV1,
	SessionSandboxBindingV1,
} from "@agent-infra/platform-core";
import {
	conversationExecutionSourceV1,
	isTaskApiChannelV1,
	parseTaskPrincipalV1,
	type TaskPrincipalV1,
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
	original_principal: TaskPrincipalV1;
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
	available_now: boolean;
	waiting_available: boolean;
	lease_owner: string | null;
	lease_expires_at: Date | null;
	delivery_fence: string | number;
	trace_id: string;
	request_id: string | null;
	decision_at: Date;
}

export interface ConversationRow {
	sandbox?: SessionSandboxBindingV1;
	sandbox_ready: boolean;
	id: string;
	agent_id: string;
	actor_id: string;
	principal_type: string;
	channel_id: string;
	status: "ready" | "active" | "unavailable";
	session_generation: string | number;
	host_session_ref: string | null;
	authorization_revision: string;
}

export interface ExecutionRow {
	sandbox_id: string | null;
	execution_id: string;
	conversation_id: string;
	agent_id: string;
	actor_id: string;
	principal_type: string;
	channel_id: string;
	turn_id: string;
	status: ConversationDispatchExecutionStatusV1;
	task_wait_order: string | number | null;
	task_wait_deadline: Date | null;
	session_generation: string | number;
	delivery_fence: string | number;
	authorization_revision: string;
	last_runtime_cursor: string | null;
	model_configuration_revision: string | number | null;
	model_option_id: string | null;
	reasoning_level: string | null;
	execution_source: string | null;
	relay_key_purpose: string | null;
	relay_key_subject_id: string | null;
	relay_key_id: string | null;
	relay_key_version: string | number | null;
	runtime_submit_protocol: string | null;
	original_operation_digest: string | null;
	original_submit_host_session_ref: string | null;
}

/** The existing typed Execution column is the only namespace source. */
export function executionPrincipalProjection(
	execution: ExecutionRow,
): TaskPrincipalV1 {
	const principal = parseTaskPrincipalV1({
		kind: execution.principal_type,
		id: execution.actor_id,
	});
	if (
		principal.kind === "application" &&
		!isTaskApiChannelV1(execution.channel_id, principal)
	)
		throw new TypeError("Stored Execution principal is invalid");
	return principal;
}

/** Project only the accepted immutable version, never a current Key alias. */
export function executionKeyProjection(
	execution: ExecutionRow,
): Pick<ConversationDispatchClaimV1, "executionSource" | "relayKeyBinding"> {
	const fields = [
		execution.execution_source,
		execution.relay_key_purpose,
		execution.relay_key_subject_id,
		execution.relay_key_id,
		execution.relay_key_version,
	];
	if (fields.every((value) => value === null)) return {};
	const executionSource = RuntimeExecutionSourceV1Schema.parse(
		execution.execution_source,
	);
	const key = RuntimeRelayKeyBindingV1Schema.parse({
		purpose: execution.relay_key_purpose,
		subjectId: execution.relay_key_subject_id,
		ciphertextRef: execution.relay_key_id,
		version: requireSafeCounter(execution.relay_key_version, 1),
	});
	if (
		executionSource !== conversationExecutionSourceV1(execution.channel_id) ||
		(executionSource === "web" || executionSource === "wecom"
			? key.purpose !== "personal" || key.subjectId !== execution.actor_id
			: key.purpose !== "agent-default" || key.subjectId !== execution.agent_id)
	)
		throw new TypeError("Stored Execution Key binding is invalid");
	return {
		executionSource,
		relayKeyBinding: {
			purpose: key.purpose,
			subjectId: key.subjectId,
			keyId: key.ciphertextRef,
			keyVersion: key.version,
		},
	};
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
	constructor(
		readonly outcome: "capacity_wait" | "capacity_unavailable" | "sandbox_wait",
	) {
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
