import { Buffer } from "node:buffer";

import postgres from "postgres";

import { platformDatabaseUrlFromEnvironment } from "./migrate.js";

type Database = ReturnType<typeof postgres> | postgres.TransactionSql;

const defaultReplayWindowMs = 5 * 60 * 1000;
const maximumReplayWindowMs = 31 * 24 * 60 * 60 * 1000;

export interface ConversationQueryScopeV1 {
	readonly actorId: string;
	readonly channelId: string;
}

export interface ConversationQueryPageV1 {
	readonly limit: number;
	readonly cursor?: string;
}

export interface ConversationQueryProjectionV1 {
	readonly conversationId: string;
	readonly agentId: string;
	readonly status: "ready" | "active" | "unavailable";
	readonly lastConversationCursor: string | null;
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

export interface ConversationQueryMessageV1 {
	readonly messageId: string;
	readonly text: string;
	readonly executionId: string;
	readonly status: string;
	readonly failureCode: string | null;
	readonly createdAt: Date;
}

export interface ConversationQueryExecutionV1 {
	readonly executionId: string;
	readonly conversationId: string;
	readonly sourceMessageId: string | null;
	readonly status: string;
	readonly createdAt: Date;
	readonly updatedAt: Date;
	readonly traceId: string | null;
}

export interface ConversationQueryEventV1 {
	readonly eventId: string;
	readonly conversationId: string;
	readonly executionId: string;
	readonly sequence: number;
	readonly conversationCursor: string;
	readonly eventType: string;
	readonly eventPayload: unknown;
	readonly occurredAt: Date;
	readonly traceId: string | null;
}

export interface ConversationQueryDetailV1 {
	readonly conversation: ConversationQueryProjectionV1;
	readonly messages: readonly ConversationQueryMessageV1[];
	readonly executions: readonly ConversationQueryExecutionV1[];
	readonly events: readonly ConversationQueryEventV1[];
}

export interface ConversationExecutionDetailV1 {
	readonly execution: ConversationQueryExecutionV1;
	readonly events: readonly ConversationQueryEventV1[];
}

export type ConversationReplayResultV1 =
	| {
			readonly outcome: "events";
			readonly events: readonly ConversationQueryEventV1[];
			readonly resumeCursor: string;
	  }
	| {
			readonly outcome: "reload";
			readonly reason:
				| "unknown_event_id"
				| "cross_conversation_cursor"
				| "cross_conversation_event_id"
				| "cursor_expired";
			readonly resumeCursor: string;
	  };

export interface PostgresConversationQueryOptionsV1 {
	readonly databaseUrl: string;
	readonly replayWindow?: number;
	readonly replayWindowMs?: number;
}

interface ConversationRow {
	readonly id: string;
	readonly agent_id: string;
	readonly status: "ready" | "active" | "unavailable";
	readonly last_conversation_cursor: string | number;
	readonly created_at: Date;
	readonly updated_at: Date;
}

interface MessageRow {
	readonly message_id: string;
	readonly text: string;
	readonly execution_id: string;
	readonly status: string;
	readonly failure_code: string | null;
	readonly created_at: Date;
}

interface ExecutionRow {
	readonly execution_id: string;
	readonly conversation_id: string;
	readonly source_message_id: string | null;
	readonly status: string;
	readonly created_at: Date;
	readonly updated_at: Date;
	readonly trace_id: string | null;
}

interface EventRow {
	readonly event_id: string;
	readonly conversation_id: string;
	readonly execution_id: string;
	readonly sequence: string | number;
	readonly conversation_cursor: string | number;
	readonly event_type: string;
	readonly event_payload: unknown;
	readonly occurred_at: Date;
	readonly trace_id: string | null;
}

interface EventIdentityRow {
	readonly conversation_cursor: string | number;
}

interface EventWindowRow {
	readonly within_window: boolean;
}

interface EventReadOptions {
	readonly afterCursor?: number;
	readonly executionId?: string;
	readonly limit?: number;
}

export class ConversationQueryError extends Error {
	readonly code: "invalid_request" | "unavailable";

	constructor(code: "invalid_request" | "unavailable") {
		super(
			code === "invalid_request"
				? "Conversation query is invalid"
				: "Conversation query is unavailable",
		);
		this.name = "ConversationQueryError";
		this.code = code;
	}
}

function invalidRequest(): never {
	throw new ConversationQueryError("invalid_request");
}

function unavailable(): never {
	throw new ConversationQueryError("unavailable");
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

function requestText(value: unknown, maximum = 1024): string {
	try {
		return text(value, maximum);
	} catch {
		return invalidRequest();
	}
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

function timestamp(value: unknown): Date {
	try {
		const milliseconds = Date.prototype.getTime.call(value);
		if (!Number.isFinite(milliseconds)) return unavailable();
		return new Date(milliseconds);
	} catch {
		return unavailable();
	}
}

function scope(input: ConversationQueryScopeV1): ConversationQueryScopeV1 {
	try {
		if (
			typeof input !== "object" ||
			input === null ||
			Array.isArray(input) ||
			Object.keys(input).length !== 2
		) {
			return invalidRequest();
		}
		return {
			actorId: requestText(input.actorId),
			channelId: requestText(input.channelId),
		};
	} catch (error) {
		if (error instanceof ConversationQueryError) throw error;
		return invalidRequest();
	}
}

function parsePage(input: ConversationQueryPageV1): ConversationQueryPageV1 {
	try {
		if (
			typeof input !== "object" ||
			input === null ||
			Array.isArray(input) ||
			Object.keys(input).some((key) => key !== "limit" && key !== "cursor") ||
			!Number.isSafeInteger(input.limit) ||
			input.limit < 1 ||
			input.limit > 100
		) {
			return invalidRequest();
		}
		return {
			limit: input.limit,
			...(input.cursor === undefined
				? {}
				: { cursor: requestText(input.cursor, 4096) }),
		};
	} catch (error) {
		if (error instanceof ConversationQueryError) throw error;
		return invalidRequest();
	}
}

function replaySelector(
	input:
		| { readonly kind: "cursor" | "last-event-id"; readonly value: string }
		| undefined,
) {
	if (input === undefined) return undefined;
	try {
		if (
			typeof input !== "object" ||
			input === null ||
			Array.isArray(input) ||
			Object.keys(input).length !== 2 ||
			(input.kind !== "cursor" && input.kind !== "last-event-id")
		) {
			return invalidRequest();
		}
		return { kind: input.kind, value: requestText(input.value, 4096) };
	} catch (error) {
		if (error instanceof ConversationQueryError) throw error;
		return invalidRequest();
	}
}

type CursorPayload =
	| readonly ["conversation", string, number]
	| readonly ["list", string, string, string, string];

function encodeCursor(payload: CursorPayload): string {
	return `v1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}

function decodeCursor(value: string): CursorPayload {
	try {
		const encoded = requestText(value, 4096);
		if (!encoded.startsWith("v1.")) return invalidRequest();
		const payload = JSON.parse(
			Buffer.from(encoded.slice(3), "base64url").toString("utf8"),
		) as unknown;
		if (
			!Array.isArray(payload) ||
			encodeCursor(payload as unknown as CursorPayload) !== value
		) {
			return invalidRequest();
		}
		if (
			payload.length === 3 &&
			payload[0] === "conversation" &&
			typeof payload[1] === "string" &&
			typeof payload[2] === "number" &&
			Number.isSafeInteger(payload[2]) &&
			payload[2] >= 0
		) {
			return ["conversation", requestText(payload[1]), payload[2]];
		}
		if (
			payload.length === 5 &&
			payload[0] === "list" &&
			payload.slice(1).every((item) => typeof item === "string")
		) {
			return [
				"list",
				requestText(payload[1]),
				requestText(payload[2]),
				requestText(payload[3]),
				requestText(payload[4]),
			];
		}
		return invalidRequest();
	} catch (error) {
		if (error instanceof ConversationQueryError) throw error;
		return invalidRequest();
	}
}

function conversationCursor(conversationId: string, cursor: number): string {
	return encodeCursor(["conversation", conversationId, cursor]);
}

function projection(row: ConversationRow): ConversationQueryProjectionV1 {
	const cursor = safeInteger(row.last_conversation_cursor, 0);
	return {
		conversationId: text(row.id),
		agentId: text(row.agent_id),
		status: row.status,
		lastConversationCursor:
			cursor === 0 ? null : conversationCursor(row.id, cursor),
		createdAt: timestamp(row.created_at),
		updatedAt: timestamp(row.updated_at),
	};
}

function message(row: MessageRow): ConversationQueryMessageV1 {
	return {
		messageId: text(row.message_id),
		text: typeof row.text === "string" ? row.text : unavailable(),
		executionId: text(row.execution_id),
		status: text(row.status, 64),
		failureCode: row.failure_code === null ? null : text(row.failure_code, 64),
		createdAt: timestamp(row.created_at),
	};
}

function execution(row: ExecutionRow): ConversationQueryExecutionV1 {
	return {
		executionId: text(row.execution_id),
		conversationId: text(row.conversation_id),
		sourceMessageId:
			row.source_message_id === null ? null : text(row.source_message_id),
		status: text(row.status, 64),
		createdAt: timestamp(row.created_at),
		updatedAt: timestamp(row.updated_at),
		traceId: row.trace_id === null ? null : text(row.trace_id),
	};
}

function event(row: EventRow): ConversationQueryEventV1 {
	const cursor = safeInteger(row.conversation_cursor, 1);
	return {
		eventId: text(row.event_id),
		conversationId: text(row.conversation_id),
		executionId: text(row.execution_id),
		sequence: safeInteger(row.sequence, 1),
		conversationCursor: conversationCursor(row.conversation_id, cursor),
		eventType: text(row.event_type, 128),
		eventPayload: structuredClone(row.event_payload),
		occurredAt: timestamp(row.occurred_at),
		traceId: row.trace_id === null ? null : text(row.trace_id),
	};
}

const conversationSelection = `
	select id, agent_id, status, last_conversation_cursor, created_at, updated_at
	from platform.conversations
`;

async function readConversation(
	database: Database,
	readScope: ConversationQueryScopeV1,
	conversationId: string,
): Promise<ConversationRow | undefined> {
	const rows = await database.unsafe<ConversationRow[]>(
		`${conversationSelection}
		 where id = $1 and actor_id = $2 and channel_id = $3
		 limit 1`,
		[conversationId, readScope.actorId, readScope.channelId],
	);
	if (rows.length > 1) return unavailable();
	return rows[0];
}

async function readMessages(
	database: Database,
	conversationId: string,
): Promise<ConversationQueryMessageV1[]> {
	const rows = await database<MessageRow[]>`
		select message_id, text, execution_id, status, failure_code, created_at
		from platform.conversation_messages
		where conversation_id = ${conversationId}
		order by created_at, message_id
	`;
	return rows.map(message);
}

async function readExecutions(
	database: Database,
	conversationId: string,
	executionId?: string,
): Promise<ConversationQueryExecutionV1[]> {
	const rows = await database<ExecutionRow[]>`
		select e.execution_id, e.conversation_id, e.status, e.created_at, e.updated_at,
			(
				select o.payload ->> 'messageId'
				from platform.outbox_items o
				where o.scope_type = 'conversation'
					and o.scope_id = e.conversation_id
					and o.payload ->> 'executionId' = e.execution_id
					and o.operation in (
						'conversation.turn.submit.v1',
						'conversation.turn.regenerate.v1'
					)
				order by o.created_at, o.id
				limit 1
			) as source_message_id,
			(
				select a.trace_id
				from platform.conversation_audit_events a
				where a.execution_id = e.execution_id
				order by a.occurred_at, a.id
				limit 1
			) as trace_id
		from platform.conversation_executions e
		where e.conversation_id = ${conversationId}
			and (${executionId ?? null}::text is null or e.execution_id = ${executionId ?? null})
		order by e.created_at, e.execution_id
	`;
	return rows.map(execution);
}

async function readEvents(
	database: Database,
	conversationId: string,
	options: EventReadOptions = {},
): Promise<ConversationQueryEventV1[]> {
	const rows = await database<EventRow[]>`
		select e.event_id, e.conversation_id, e.execution_id, e.sequence,
			e.conversation_cursor, e.event_type, e.event_payload, e.occurred_at,
			(
				select a.trace_id
				from platform.conversation_audit_events a
				where a.execution_id = e.execution_id
				order by a.occurred_at, a.id
				limit 1
			) as trace_id
		from platform.conversation_events e
		where e.conversation_id = ${conversationId}
			and e.conversation_cursor > ${options.afterCursor ?? 0}
			${options.executionId === undefined ? database`` : database`and e.execution_id = ${options.executionId}`}
		order by e.conversation_cursor
		${options.limit === undefined ? database`` : database`limit ${options.limit}`}
	`;
	return rows.map(event);
}

async function isWithinReplayTimeWindow(
	database: Database,
	conversationId: string,
	afterCursor: number,
	latestCursor: number,
	replayWindowMs: number,
): Promise<boolean> {
	if (afterCursor === latestCursor) return true;
	const anchorCursor = afterCursor + 1;
	const rows = await database<EventWindowRow[]>`
		select persisted_at >= now() - (${replayWindowMs}::bigint * interval '1 millisecond')
			as within_window
		from platform.conversation_events
		where conversation_id = ${conversationId}
			and conversation_cursor = ${anchorCursor}
		limit 1
	`;
	return rows[0]?.within_window === true;
}

async function repeatableRead<T>(
	client: ReturnType<typeof postgres>,
	read: (transaction: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
	return (await client.begin(async (transaction) => {
		await transaction`set transaction isolation level repeatable read read only`;
		return read(transaction);
	})) as T;
}

export class PostgresConversationQueryV1 {
	readonly #client: ReturnType<typeof postgres>;
	readonly #replayWindow: number;
	readonly #replayWindowMs: number;

	constructor(options: PostgresConversationQueryOptionsV1) {
		try {
			if (
				!Number.isSafeInteger(options.replayWindow ?? 100) ||
				(options.replayWindow ?? 100) < 1 ||
				(options.replayWindow ?? 100) > 1000 ||
				!Number.isSafeInteger(
					options.replayWindowMs ?? defaultReplayWindowMs,
				) ||
				(options.replayWindowMs ?? defaultReplayWindowMs) < 1 ||
				(options.replayWindowMs ?? defaultReplayWindowMs) >
					maximumReplayWindowMs
			) {
				invalidRequest();
			}
			this.#client = postgres(
				platformDatabaseUrlFromEnvironment({
					PLATFORM_DATABASE_URL: options.databaseUrl,
				}),
				{ max: 10 },
			);
			this.#replayWindow = options.replayWindow ?? 100;
			this.#replayWindowMs = options.replayWindowMs ?? defaultReplayWindowMs;
		} catch (error) {
			if (error instanceof ConversationQueryError) throw error;
			unavailable();
		}
	}

	async getAuthorizationTarget(
		inputScope: ConversationQueryScopeV1,
		conversationIdInput: string,
	): Promise<{ readonly agentId: string } | undefined> {
		const readScope = scope(inputScope);
		const conversationId = requestText(conversationIdInput);
		try {
			const row = await readConversation(
				this.#client,
				readScope,
				conversationId,
			);
			return row ? { agentId: text(row.agent_id) } : undefined;
		} catch (error) {
			if (error instanceof ConversationQueryError) throw error;
			return unavailable();
		}
	}

	async list(
		inputScope: ConversationQueryScopeV1,
		agentIdInput: string,
		pageInput: ConversationQueryPageV1,
	): Promise<{
		readonly items: readonly ConversationQueryProjectionV1[];
		readonly nextCursor: string | null;
	}> {
		const readScope = scope(inputScope);
		const agentId = requestText(agentIdInput);
		const page = parsePage(pageInput);
		let afterId: string | undefined;
		if (page.cursor !== undefined) {
			const cursor = decodeCursor(page.cursor);
			if (
				cursor[0] !== "list" ||
				cursor[1] !== readScope.actorId ||
				cursor[2] !== readScope.channelId ||
				cursor[3] !== agentId
			) {
				return invalidRequest();
			}
			afterId = cursor[4];
		}
		try {
			const rows = await this.#client.unsafe<ConversationRow[]>(
				`${conversationSelection}
				 where actor_id = $1 and channel_id = $2 and agent_id = $3
					and ($4::text is null or id > $4)
				 order by id
				 limit $5`,
				[
					readScope.actorId,
					readScope.channelId,
					agentId,
					afterId ?? null,
					page.limit + 1,
				],
			);
			const items = rows.slice(0, page.limit).map(projection);
			const nextId =
				rows.length > page.limit ? items.at(-1)?.conversationId : null;
			return {
				items,
				nextCursor: nextId
					? encodeCursor([
							"list",
							readScope.actorId,
							readScope.channelId,
							agentId,
							nextId,
						])
					: null,
			};
		} catch (error) {
			if (error instanceof ConversationQueryError) throw error;
			return unavailable();
		}
	}

	async get(
		inputScope: ConversationQueryScopeV1,
		conversationIdInput: string,
	): Promise<ConversationQueryDetailV1 | undefined> {
		const readScope = scope(inputScope);
		const conversationId = requestText(conversationIdInput);
		try {
			return await repeatableRead(this.#client, async (transaction) => {
				const row = await readConversation(
					transaction,
					readScope,
					conversationId,
				);
				if (!row) return undefined;
				const [messages, executions, events] = await Promise.all([
					readMessages(transaction, conversationId),
					readExecutions(transaction, conversationId),
					readEvents(transaction, conversationId),
				]);
				return { conversation: projection(row), messages, executions, events };
			});
		} catch (error) {
			if (error instanceof ConversationQueryError) throw error;
			return unavailable();
		}
	}

	async getExecution(
		inputScope: ConversationQueryScopeV1,
		conversationIdInput: string,
		executionIdInput: string,
	): Promise<ConversationExecutionDetailV1 | undefined> {
		const readScope = scope(inputScope);
		const conversationId = requestText(conversationIdInput);
		const executionId = requestText(executionIdInput);
		try {
			return await repeatableRead(this.#client, async (transaction) => {
				if (!(await readConversation(transaction, readScope, conversationId))) {
					return undefined;
				}
				const [executionItem, events] = await Promise.all([
					readExecutions(transaction, conversationId, executionId).then(
						(items) => items[0],
					),
					readEvents(transaction, conversationId, { executionId }),
				]);
				return executionItem ? { execution: executionItem, events } : undefined;
			});
		} catch (error) {
			if (error instanceof ConversationQueryError) throw error;
			return unavailable();
		}
	}

	async replay(
		inputScope: ConversationQueryScopeV1,
		conversationIdInput: string,
		selectorInput:
			| { readonly kind: "cursor" | "last-event-id"; readonly value: string }
			| undefined,
	): Promise<ConversationReplayResultV1 | undefined> {
		const readScope = scope(inputScope);
		const conversationId = requestText(conversationIdInput);
		const selector = replaySelector(selectorInput);
		try {
			return await repeatableRead(this.#client, async (transaction) => {
				const conversation = await readConversation(
					transaction,
					readScope,
					conversationId,
				);
				if (!conversation) return undefined;
				const latest = safeInteger(conversation.last_conversation_cursor, 0);
				const resumeCursor = conversationCursor(conversationId, latest);
				let after = 0;
				if (selector?.kind === "cursor") {
					const decoded = decodeCursor(selector.value);
					if (decoded[0] !== "conversation" || decoded[1] !== conversationId) {
						return {
							outcome: "reload",
							reason: "cross_conversation_cursor",
							resumeCursor,
						};
					}
					after = decoded[2];
				} else if (selector?.kind === "last-event-id") {
					const rows = await transaction<EventIdentityRow[]>`
						select conversation_cursor
						from platform.conversation_events
						where event_id = ${selector.value}
							and conversation_id = ${conversationId}
						limit 1
					`;
					const identity = rows[0];
					if (!identity) {
						return {
							outcome: "reload",
							reason: "unknown_event_id",
							resumeCursor,
						};
					}
					after = safeInteger(identity.conversation_cursor, 1);
				}
				if (
					after > latest ||
					after < Math.max(0, latest - this.#replayWindow) ||
					!(await isWithinReplayTimeWindow(
						transaction,
						conversationId,
						after,
						latest,
						this.#replayWindowMs,
					))
				) {
					return {
						outcome: "reload",
						reason: "cursor_expired",
						resumeCursor,
					};
				}
				return {
					outcome: "events",
					events: await readEvents(transaction, conversationId, {
						afterCursor: after,
						limit: this.#replayWindow,
					}),
					resumeCursor,
				};
			});
		} catch (error) {
			if (error instanceof ConversationQueryError) throw error;
			return unavailable();
		}
	}

	async close(): Promise<void> {
		try {
			await this.#client.end();
		} catch {
			return unavailable();
		}
	}
}
