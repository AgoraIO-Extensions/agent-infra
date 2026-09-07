import { Buffer } from "node:buffer";

import {
	type ConversationEventCommandV1,
	type ConversationEventDecisionV1,
	ConversationEventError,
	type ConversationEventStateV1,
	type ConversationEventTransactionPortV1,
	type ConversationEventWritePlanV1,
	type ConversationNormalizedEventV1,
	type ConversationPersistedEventPayloadV1,
	type PersistedRuntimeConversationEventV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";

type Transaction = postgres.TransactionSql;
type JsonValue = Parameters<ReturnType<typeof postgres>["json"]>[0];
type PersistRequest = Parameters<
	ConversationEventTransactionPortV1["persistEvent"]
>[0];
type PersistDecide = Parameters<
	ConversationEventTransactionPortV1["persistEvent"]
>[1];

interface ConversationRow {
	readonly id: string;
	readonly session_generation: string | number;
	readonly last_conversation_cursor: string | number;
}

interface ExecutionRow {
	readonly execution_id: string;
	readonly conversation_id: string;
	readonly session_generation: string | number;
	readonly delivery_fence: string | number;
	readonly last_event_sequence: string | number;
}

interface EventRow {
	readonly event_id: string;
	readonly conversation_id: string;
	readonly execution_id: string;
	readonly sequence: string | number;
	readonly conversation_cursor: string | number;
	readonly event_type: string;
	readonly event_payload: unknown;
	readonly event_digest: string;
	readonly occurred_at: Date;
}

interface DispatchLeaseRow {
	readonly id: string;
	readonly scope_type: string;
	readonly scope_id: string;
	readonly status: string;
	readonly lease_owner: string | null;
	readonly delivery_fence: string | number;
	readonly lease_active: boolean | null;
}

export interface PostgresConversationEventOptionsV1 {
	readonly databaseUrl: string;
}

function unavailable(): never {
	throw new ConversationEventError("unavailable");
}

function exactRecord(
	value: unknown,
	requiredKeys: readonly string[],
	optionalKeys: readonly string[] = [],
): Record<string, unknown> {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return unavailable();
		}
		const allowed = new Set([...requiredKeys, ...optionalKeys]);
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (
			Reflect.ownKeys(descriptors).some(
				(key) => typeof key !== "string" || !allowed.has(key),
			) ||
			requiredKeys.some((key) => !Object.hasOwn(descriptors, key))
		) {
			return unavailable();
		}
		const result: Record<string, unknown> = {};
		for (const key of [...requiredKeys, ...optionalKeys]) {
			const descriptor = descriptors[key];
			if (descriptor === undefined) continue;
			if (
				descriptor.enumerable !== true ||
				!Object.hasOwn(descriptor, "value") ||
				Object.hasOwn(descriptor, "get") ||
				Object.hasOwn(descriptor, "set")
			) {
				return unavailable();
			}
			result[key] = descriptor.value;
		}
		return result;
	} catch {
		return unavailable();
	}
}

function text(value: unknown, maximum = 1024): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.includes("\0") ||
		!String.prototype.isWellFormed.call(value) ||
		Buffer.byteLength(value, "utf8") > maximum
	) {
		return unavailable();
	}
	return value;
}

function safeInteger(value: unknown, minimum: number): number {
	const normalized = typeof value === "string" ? Number(value) : value;
	if (
		typeof normalized !== "number" ||
		!Number.isSafeInteger(normalized) ||
		normalized < minimum
	) {
		return unavailable();
	}
	return normalized;
}

function timestamp(value: unknown): string {
	if (typeof value !== "string" || !text(value, 128)) return unavailable();
	try {
		const parsed = new Date(value);
		if (!Number.isFinite(parsed.getTime())) return unavailable();
		return parsed.toISOString();
	} catch {
		return unavailable();
	}
}

function timestampFromDatabase(value: unknown): string {
	try {
		if (!Number.isFinite(Date.prototype.getTime.call(value))) unavailable();
		return new Date(Date.prototype.getTime.call(value)).toISOString();
	} catch {
		return unavailable();
	}
}

function eventType(value: unknown): unknown {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return unavailable();
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, "type");
		if (
			descriptor?.enumerable !== true ||
			!Object.hasOwn(descriptor, "value") ||
			Object.hasOwn(descriptor, "get") ||
			Object.hasOwn(descriptor, "set")
		) {
			return unavailable();
		}
		return descriptor.value;
	} catch {
		return unavailable();
	}
}

function normalizedEvent(value: unknown): ConversationNormalizedEventV1 {
	const type = eventType(value);
	if (type === "text.delta") {
		const input = exactRecord(value, ["type", "text"]);
		return { type: "text.delta", text: text(input.text, 65_536) };
	}
	if (type === "execution.status") {
		const input = exactRecord(value, ["type", "status"]);
		if (
			input.status !== "submitted" &&
			input.status !== "processing" &&
			input.status !== "completed" &&
			input.status !== "failed" &&
			input.status !== "cancelled" &&
			input.status !== "unknown"
		) {
			return unavailable();
		}
		return { type: "execution.status", status: input.status };
	}
	if (type === "execution.detail") {
		const input = exactRecord(
			value,
			["type", "category", "summary"],
			["callId"],
		);
		if (
			(input.category !== "status" &&
				input.category !== "model_call" &&
				input.category !== "connection_call") ||
			typeof input.summary !== "string" ||
			(input.callId !== undefined && typeof input.callId !== "string")
		) {
			return unavailable();
		}
		return {
			type: "execution.detail",
			category: input.category,
			summary: text(input.summary, 4096),
			...(input.callId === undefined ? {} : { callId: text(input.callId) }),
		};
	}
	if (type === "result.file") {
		const input = exactRecord(value, [
			"type",
			"fileId",
			"name",
			"mediaType",
			"sizeBytes",
		]);
		return {
			type: "result.file",
			fileId: text(input.fileId),
			name: text(input.name, 1024),
			mediaType: text(input.mediaType, 255),
			sizeBytes: safeInteger(input.sizeBytes, 0),
		};
	}
	if (type === "conversation.error") {
		const input = exactRecord(value, ["type", "code", "message", "retryable"]);
		if (typeof input.retryable !== "boolean") return unavailable();
		return {
			type: "conversation.error",
			code: text(input.code, 128),
			message: text(input.message, 4096),
			retryable: input.retryable,
		};
	}
	return unavailable();
}

function eventTransition(
	value: unknown,
	event: ConversationNormalizedEventV1,
): NonNullable<ConversationEventCommandV1["transition"]> {
	const input = exactRecord(value, ["executionStatus", "conversationStatus"]);
	if (
		(input.executionStatus !== "submitted" &&
			input.executionStatus !== "processing" &&
			input.executionStatus !== "completed" &&
			input.executionStatus !== "failed" &&
			input.executionStatus !== "cancelled" &&
			input.executionStatus !== "unknown") ||
		(input.conversationStatus !== "ready" &&
			input.conversationStatus !== "active") ||
		event.type !== "execution.status" ||
		input.executionStatus !== event.status ||
		input.conversationStatus !==
			(["completed", "failed", "cancelled"].includes(event.status)
				? "ready"
				: "active")
	) {
		return unavailable();
	}
	return {
		executionStatus: input.executionStatus,
		conversationStatus: input.conversationStatus,
	};
}

function command(value: unknown): ConversationEventCommandV1 {
	const input = exactRecord(
		value,
		[
			"schemaVersion",
			"conversationId",
			"executionId",
			"sessionGeneration",
			"deliveryFence",
			"adapterEventKey",
			"runtimeCursor",
			"occurredAt",
			"event",
		],
		["transition", "dispatchLease"],
	);
	if (input.schemaVersion !== 1) return unavailable();
	const event = normalizedEvent(input.event);
	const transition =
		input.transition === undefined
			? undefined
			: eventTransition(input.transition, event);
	const dispatchLease = (() => {
		if (input.dispatchLease === undefined) return undefined;
		const lease = exactRecord(input.dispatchLease, [
			"schemaVersion",
			"itemId",
			"leaseOwner",
			"deliveryFence",
		]);
		if (lease.schemaVersion !== 1) return unavailable();
		return {
			schemaVersion: 1 as const,
			itemId: text(lease.itemId),
			leaseOwner: text(lease.leaseOwner),
			deliveryFence: safeInteger(lease.deliveryFence, 1),
		};
	})();
	return {
		schemaVersion: 1,
		conversationId: text(input.conversationId),
		executionId: text(input.executionId),
		sessionGeneration: safeInteger(input.sessionGeneration, 1),
		deliveryFence: safeInteger(input.deliveryFence, 0),
		adapterEventKey: text(input.adapterEventKey),
		runtimeCursor: text(input.runtimeCursor),
		occurredAt: timestamp(input.occurredAt),
		event,
		...(transition ? { transition } : {}),
		...(dispatchLease ? { dispatchLease } : {}),
	};
}

function request(value: unknown): PersistRequest {
	const input = exactRecord(value, ["command", "eventDigest"]);
	if (
		typeof input.eventDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(input.eventDigest)
	) {
		return unavailable();
	}
	return { command: command(input.command), eventDigest: input.eventDigest };
}

function persistedEvent(row: EventRow): PersistedRuntimeConversationEventV1 {
	const event = normalizedEvent(row.event_payload);
	if (row.event_type !== event.type) return unavailable();
	return {
		schemaVersion: 1,
		eventId: text(row.event_id),
		conversationId: text(row.conversation_id),
		executionId: text(row.execution_id),
		sequence: safeInteger(row.sequence, 1),
		conversationCursor: safeInteger(row.conversation_cursor, 1),
		occurredAt: timestampFromDatabase(row.occurred_at),
		event,
	};
}

function conversationState(
	row: ConversationRow | undefined,
): ConversationEventStateV1["conversation"] {
	if (!row) return undefined;
	return {
		conversationId: text(row.id),
		sessionGeneration: safeInteger(row.session_generation, 1),
		lastConversationCursor: safeInteger(row.last_conversation_cursor, 0),
	};
}

function executionState(
	row: ExecutionRow | undefined,
): ConversationEventStateV1["execution"] {
	if (!row) return undefined;
	return {
		executionId: text(row.execution_id),
		conversationId: text(row.conversation_id),
		sessionGeneration: safeInteger(row.session_generation, 1),
		deliveryFence: safeInteger(row.delivery_fence, 0),
		lastSequence: safeInteger(row.last_event_sequence, 0),
	};
}

function eventState(
	row: EventRow | undefined,
): ConversationEventStateV1["existingEvent"] {
	if (!row) return undefined;
	if (
		typeof row.event_digest !== "string" ||
		!/^[a-f0-9]{64}$/.test(row.event_digest)
	) {
		return unavailable();
	}
	return { event: persistedEvent(row), eventDigest: row.event_digest };
}

function sameEvent(
	left: ConversationPersistedEventPayloadV1,
	right: ConversationPersistedEventPayloadV1,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function isWritePlan(
	value: ConversationEventWritePlanV1 | ConversationEventDecisionV1,
): value is ConversationEventWritePlanV1 {
	return !Object.hasOwn(value, "outcome");
}

function validatePlan(
	value: unknown,
	requestValue: PersistRequest,
	state: ConversationEventStateV1,
): ConversationEventWritePlanV1 {
	const input = exactRecord(
		value,
		[
			"schemaVersion",
			"event",
			"adapterEventKey",
			"eventDigest",
			"runtimeCursor",
			"sessionGeneration",
			"deliveryFence",
		],
		["transition"],
	);
	if (
		input.schemaVersion !== 1 ||
		input.adapterEventKey !== requestValue.command.adapterEventKey ||
		input.eventDigest !== requestValue.eventDigest ||
		input.runtimeCursor !== requestValue.command.runtimeCursor ||
		input.sessionGeneration !== requestValue.command.sessionGeneration ||
		input.deliveryFence !== requestValue.command.deliveryFence ||
		!state.conversation ||
		!state.execution ||
		state.existingEvent ||
		state.conversation.conversationId !== requestValue.command.conversationId ||
		state.execution.executionId !== requestValue.command.executionId ||
		state.execution.conversationId !== requestValue.command.conversationId ||
		state.conversation.sessionGeneration !==
			requestValue.command.sessionGeneration ||
		state.execution.sessionGeneration !==
			requestValue.command.sessionGeneration ||
		state.execution.deliveryFence !== requestValue.command.deliveryFence
	) {
		return unavailable();
	}
	const eventInput = exactRecord(input.event, [
		"schemaVersion",
		"eventId",
		"conversationId",
		"executionId",
		"sequence",
		"conversationCursor",
		"occurredAt",
		"event",
	]);
	if (eventInput.schemaVersion !== 1) return unavailable();
	const event: PersistedRuntimeConversationEventV1 = {
		schemaVersion: 1,
		eventId: text(eventInput.eventId),
		conversationId: text(eventInput.conversationId),
		executionId: text(eventInput.executionId),
		sequence: safeInteger(eventInput.sequence, 1),
		conversationCursor: safeInteger(eventInput.conversationCursor, 1),
		occurredAt: timestamp(eventInput.occurredAt),
		event: normalizedEvent(eventInput.event),
	};
	const transition =
		input.transition === undefined
			? undefined
			: eventTransition(input.transition, event.event);
	if (
		event.conversationId !== requestValue.command.conversationId ||
		event.executionId !== requestValue.command.executionId ||
		event.sequence !== state.execution.lastSequence + 1 ||
		event.conversationCursor !==
			state.conversation.lastConversationCursor + 1 ||
		event.occurredAt !== requestValue.command.occurredAt ||
		!sameEvent(event.event, requestValue.command.event) ||
		JSON.stringify(transition) !==
			JSON.stringify(requestValue.command.transition)
	) {
		return unavailable();
	}
	return {
		schemaVersion: 1,
		event,
		adapterEventKey: requestValue.command.adapterEventKey,
		eventDigest: requestValue.eventDigest,
		runtimeCursor: requestValue.command.runtimeCursor,
		sessionGeneration: requestValue.command.sessionGeneration,
		deliveryFence: requestValue.command.deliveryFence,
		...(transition ? { transition } : {}),
	};
}

function validateDecision(
	value: unknown,
	state: ConversationEventStateV1,
): ConversationEventDecisionV1 {
	const input = exactRecord(value, ["outcome"], ["event"]);
	if (input.outcome === "stale" && input.event === undefined) {
		return { outcome: "stale" };
	}
	if (input.outcome !== "replayed" || !state.existingEvent)
		return unavailable();
	const replayed = exactRecord(input.event, [
		"schemaVersion",
		"eventId",
		"conversationId",
		"executionId",
		"sequence",
		"conversationCursor",
		"occurredAt",
		"event",
	]);
	if (replayed.schemaVersion !== 1) return unavailable();
	const event: PersistedRuntimeConversationEventV1 = {
		schemaVersion: 1,
		eventId: text(replayed.eventId),
		conversationId: text(replayed.conversationId),
		executionId: text(replayed.executionId),
		sequence: safeInteger(replayed.sequence, 1),
		conversationCursor: safeInteger(replayed.conversationCursor, 1),
		occurredAt: timestamp(replayed.occurredAt),
		event: normalizedEvent(replayed.event),
	};
	if (JSON.stringify(event) !== JSON.stringify(state.existingEvent.event)) {
		return unavailable();
	}
	return { outcome: "replayed", event };
}

async function lockConversation(
	transaction: Transaction,
	conversationId: string,
): Promise<ConversationRow | undefined> {
	const rows = await transaction<ConversationRow[]>`
		select id, session_generation, last_conversation_cursor
		from platform.conversations
		where id = ${conversationId}
		for update
	`;
	if (rows.length > 1) unavailable();
	return rows[0];
}

async function readExecution(
	transaction: Transaction,
	conversationId: string,
	executionId: string,
): Promise<ExecutionRow | undefined> {
	const rows = await transaction<ExecutionRow[]>`
		select execution_id, conversation_id, session_generation, delivery_fence,
			last_event_sequence
		from platform.conversation_executions
		where execution_id = ${executionId} and conversation_id = ${conversationId}
		for update
	`;
	if (rows.length > 1) unavailable();
	return rows[0];
}

async function readExistingEvent(
	transaction: Transaction,
	executionId: string,
	adapterEventKey: string,
): Promise<EventRow | undefined> {
	const rows = await transaction<EventRow[]>`
		select event_id, conversation_id, execution_id, sequence, conversation_cursor,
			event_type, event_payload, event_digest, occurred_at
		from platform.conversation_events
		where execution_id = ${executionId} and adapter_event_key = ${adapterEventKey}
			and source = 'runtime'
	`;
	if (rows.length > 1) unavailable();
	return rows[0];
}

async function currentDispatchLease(
	transaction: Transaction,
	command: ConversationEventCommandV1,
): Promise<boolean> {
	if (!command.dispatchLease) return true;
	const rows = await transaction<DispatchLeaseRow[]>`
		select id, scope_type, scope_id, status, lease_owner,
			delivery_fence::text,
			lease_expires_at > clock_timestamp() as lease_active
		from platform.outbox_items
		where id = ${command.dispatchLease.itemId}
		for update
	`;
	const row = rows[0];
	return (
		rows.length === 1 &&
		row?.scope_type === "conversation" &&
		row.scope_id === command.conversationId &&
		row.status === "processing" &&
		row.lease_owner === command.dispatchLease.leaseOwner &&
		safeInteger(row.delivery_fence, 1) ===
			command.dispatchLease.deliveryFence &&
		row.lease_active === true
	);
}

export class PostgresConversationEventTransactionV1
	implements ConversationEventTransactionPortV1
{
	readonly #client: ReturnType<typeof postgres>;

	constructor(options: PostgresConversationEventOptionsV1) {
		this.#client = postgres(options.databaseUrl, { max: 10 });
	}

	async persistEvent(
		requestInput: PersistRequest,
		decide: PersistDecide,
	): Promise<ConversationEventDecisionV1> {
		const persistedRequest = request(requestInput);
		if (typeof decide !== "function") unavailable();
		return this.#transaction(async (transaction) => {
			const leaseCurrent = await currentDispatchLease(
				transaction,
				persistedRequest.command,
			);
			const conversation = await lockConversation(
				transaction,
				persistedRequest.command.conversationId,
			);
			const existing = await readExistingEvent(
				transaction,
				persistedRequest.command.executionId,
				persistedRequest.command.adapterEventKey,
			);
			const execution =
				conversation && leaseCurrent
					? await readExecution(
							transaction,
							conversation.id,
							persistedRequest.command.executionId,
						)
					: undefined;
			const state: ConversationEventStateV1 = {
				conversation: conversationState(conversation),
				execution: executionState(execution),
				existingEvent: eventState(existing),
			};
			const decision = decide(state);
			if (!isWritePlan(decision)) return validateDecision(decision, state);
			const currentConversation = state.conversation;
			const currentExecution = state.execution;
			if (!currentConversation || !currentExecution || state.existingEvent) {
				return unavailable();
			}
			const plan = validatePlan(decision, persistedRequest, state);

			await transaction`
					insert into platform.conversation_events
						(event_id, conversation_id, execution_id, adapter_event_key, sequence,
						 conversation_cursor, event_type, event_payload, event_digest,
						 source, runtime_cursor, occurred_at)
				values
					(${plan.event.eventId}, ${plan.event.conversationId},
					 ${plan.event.executionId}, ${plan.adapterEventKey}, ${plan.event.sequence},
						 ${plan.event.conversationCursor}, ${plan.event.event.type},
						 ${transaction.json(plan.event.event as JsonValue)}, ${plan.eventDigest},
						 'runtime', ${plan.runtimeCursor}, ${plan.event.occurredAt})
			`;
			const updatedExecution = await transaction<{ execution_id: string }[]>`
				update platform.conversation_executions
				set last_event_sequence = ${plan.event.sequence},
					last_runtime_cursor = ${plan.runtimeCursor},
					updated_at = now()
				where execution_id = ${plan.event.executionId}
					and conversation_id = ${plan.event.conversationId}
					and session_generation = ${plan.sessionGeneration}
					and delivery_fence = ${plan.deliveryFence}
					and last_event_sequence = ${currentExecution.lastSequence}
				returning execution_id
			`;
			if (updatedExecution.length !== 1) unavailable();
			const updatedConversation = await transaction<{ id: string }[]>`
				update platform.conversations
				set last_conversation_cursor = ${plan.event.conversationCursor},
					updated_at = now()
				where id = ${plan.event.conversationId}
					and session_generation = ${plan.sessionGeneration}
					and last_conversation_cursor = ${currentConversation.lastConversationCursor}
				returning id
			`;
			if (updatedConversation.length !== 1) unavailable();
			if (plan.transition) {
				const transitionedExecution = await transaction<
					{ execution_id: string }[]
				>`
					update platform.conversation_executions
					set status = ${plan.transition.executionStatus}, updated_at = now()
					where execution_id = ${plan.event.executionId}
						and conversation_id = ${plan.event.conversationId}
						and session_generation = ${plan.sessionGeneration}
						and delivery_fence = ${plan.deliveryFence}
						and last_event_sequence = ${plan.event.sequence}
						and (status not in ('completed', 'failed', 'cancelled')
							or status = ${plan.transition.executionStatus})
					returning execution_id
				`;
				if (transitionedExecution.length !== 1) unavailable();
				const transitionedConversation = await transaction<{ id: string }[]>`
					update platform.conversations
					set status = ${plan.transition.conversationStatus}, updated_at = now()
					where id = ${plan.event.conversationId}
						and session_generation = ${plan.sessionGeneration}
						and last_conversation_cursor = ${plan.event.conversationCursor}
						and status <> 'unavailable'
					returning id
				`;
				if (transitionedConversation.length !== 1) unavailable();
			}
			return { outcome: "accepted", event: plan.event };
		});
	}

	async close(): Promise<void> {
		try {
			await this.#client.end();
		} catch {
			unavailable();
		}
	}

	async #transaction<T>(
		work: (transaction: Transaction) => Promise<T>,
	): Promise<T> {
		try {
			return (await this.#client.begin(async (transaction) => {
				await transaction`select set_config('lock_timeout', '5s', true)`;
				return work(transaction);
			})) as T;
		} catch (error) {
			if (error instanceof ConversationEventError) throw error;
			return unavailable();
		}
	}
}
