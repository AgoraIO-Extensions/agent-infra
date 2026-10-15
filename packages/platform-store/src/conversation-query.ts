import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { types } from "node:util";
import {
	type NativeMetadataObjectScopeV1,
	NativeMetadataObjectScopeV1Schema,
	type RuntimeModelDirectoryDispatchRequestV1,
	RuntimeModelDirectoryDispatchRequestV1Schema,
} from "@agent-infra/contracts/runtime";
import type { RecentPersonalConversationsQueryV1 } from "@agent-infra/platform-core";
import {
	isSessionSandboxReadyV1,
	isTaskApiChannelV1,
	parseConversationOperationEventV2,
	parseSessionSandboxBindingV1,
	parseTaskPrincipalV1,
	type SessionSandboxBindingV1,
	type TaskPrincipalV1,
} from "@agent-infra/platform-core";
import { exactRecord } from "./conversation-execution-common.js";
import { readRecentPersonalConversations } from "./conversation-recent-query.js";
import { platformDatabaseUrlFromEnvironment } from "./migrate.js";
import postgres from "./observed-postgres.js";
import {
	conversationSandboxReadBindingSql,
	sessionSandboxResumableSql,
	sessionSandboxUpgradingSql,
} from "./session-sandbox.js";

type Database = ReturnType<typeof postgres> | postgres.TransactionSql;

const defaultReplayWindowMs = 5 * 60 * 1000;
const maximumReplayWindowMs = 31 * 24 * 60 * 60 * 1000;

export interface ConversationQueryScopeV1 {
	/** Required at the API boundary; never resolved from actorId or an Owner role. */
	readonly principal?: TaskPrincipalV1;
	readonly actorId: string;
	readonly channelId: string;
}

export interface ConversationQueryPageV1 {
	readonly limit: number;
	readonly cursor?: string;
}

export interface ConversationQueryProjectionV1 {
	readonly sandbox?: SessionSandboxBindingV1;
	readonly sandboxReady?: boolean;
	/** Present only while the not-ready Sandbox is being upgraded (ADR 0023). */
	readonly sandboxUpdating?: true;
	/** 空闲回收后等待新消息恢复（#2239）；Web 据此允许发送下一条消息。 */
	readonly sandboxResumable?: true;
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
	readonly eventSchemaVersion?: 2;
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

export interface ConversationEventWindowV1 {
	readonly hasEarlier: boolean;
	readonly beforeCursor: string | null;
}

export interface ConversationQueryDetailV1 {
	readonly conversation: ConversationQueryProjectionV1;
	readonly messages: readonly ConversationQueryMessageV1[];
	readonly executions: readonly ConversationQueryExecutionV1[];
	readonly events: readonly ConversationQueryEventV1[];
	readonly eventWindow?: ConversationEventWindowV1;
}

export interface ConversationQueryReadOptionsV1 {
	readonly beforeCursor?: string;
}

/**
 * The only Store input needed to resolve the original native metadata scope.
 *
 * The query deliberately carries the Conversation and Execution identities
 * separately: the database must prove that they belong to the same persisted
 * principal/Agent/channel tuple before returning the Execution's own
 * generation and authorization revision.
 */
export interface NativeMetadataObjectScopeRequestV1 {
	readonly scope: ConversationQueryScopeV1;
	readonly conversationId: string;
	readonly executionId: string;
	readonly signal?: AbortSignal;
}

export type NativeMetadataObjectScopeResponseV1 =
	NativeMetadataObjectScopeV1 & {
		/** Internal-only immutable Host binding from the requested Execution. */
		readonly originalHostScopeRef: string | null;
	};

export interface RuntimeModelDirectoryDispatchRequestInputV1 {
	readonly scope: ConversationQueryScopeV1;
	readonly conversationId: string;
	readonly signal?: AbortSignal;
}

export type RuntimeModelDirectoryDispatchRequestResponseV1 =
	RuntimeModelDirectoryDispatchRequestV1;

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
	/** Recent event window for detail reads; omitted keeps historical full reads. */
	readonly eventWindow?: number;
}

export interface PlatformQueueResourceSnapshot {
	/** Existing submitted Turns still awaiting dispatch reservation; not the full Task waiting contract. */
	readonly taskWaiting: number;
	/** All pending or retry-scheduled outbox rows, including non-task control work. */
	readonly outboxPending: number;
	/** Bounded duration of this read-only snapshot, in milliseconds. */
	readonly queryDurationMs?: number;
}

interface ConversationRow {
	readonly sandbox_status: string | null;
	readonly sandbox_desired_state: string | null;
	readonly sandbox_resource_fence: number | string | null;
	readonly sandbox_observation_status: string | null;
	/** Selected only by the Conversation detail/list reads. */
	readonly sandbox_upgrading?: boolean | null;
	readonly sandbox_resumable?: boolean | null;
	readonly sandbox_id: string | null;
	readonly resource_name: string | null;
	readonly workspace_scope: string | null;
	readonly actor_id: string;
	readonly principal_type: string;
	readonly channel_id: string;
	readonly session_generation: number | string;
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

interface NativeMetadataObjectScopeRow {
	readonly conversation_id: string;
	readonly conversation_agent: string;
	readonly conversation_actor: string;
	readonly conversation_channel: string;
	readonly conversation_principal_type: string;
	readonly execution_id: string;
	readonly execution_conversation: string;
	readonly execution_agent: string;
	readonly execution_actor: string;
	readonly execution_channel: string;
	readonly execution_principal_type: string;
	readonly session_generation: string | number;
	readonly authorization_revision: string;
	readonly original_host_scope_ref: string | null;
}

interface RuntimeModelDirectoryDispatchRow {
	readonly conversation_id: string;
	readonly conversation_agent: string;
	readonly conversation_actor: string;
	readonly conversation_channel: string;
	readonly conversation_principal_type: string;
	readonly conversation_host_session_ref: string | null;
	readonly conversation_session_generation: string | number;
	readonly execution_id: string;
	readonly execution_conversation: string;
	readonly execution_agent: string;
	readonly execution_actor: string;
	readonly execution_channel: string;
	readonly execution_principal_type: string;
	readonly turn_id: string;
	readonly session_generation: string | number;
	readonly delivery_fence: string | number;
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
	readonly beforeCursor?: number;
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
		if (types.isProxy(input)) return invalidRequest();
		const value = exactRecord(input, ["actorId", "channelId"], ["principal"]);
		const actorId = requestText(value.actorId);
		const channelId = requestText(value.channelId);
		const principal =
			value.principal === undefined
				? undefined
				: parseTaskPrincipalV1(value.principal);
		const api = channelId === "api" || channelId.startsWith("api:");
		if (
			(api && (!principal || !isTaskApiChannelV1(channelId, principal))) ||
			(principal &&
				(principal.id !== actorId || (!api && principal.kind !== "user")))
		)
			return invalidRequest();
		return { actorId, channelId, ...(principal ? { principal } : {}) };
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
				requestText(payload[1], 1024 + "application:".length),
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
	const sandboxReady = isSessionSandboxReadyV1({
		status: row.sandbox_status,
		desiredState: row.sandbox_desired_state,
		resourceFence: Number(row.sandbox_resource_fence),
		observationStatus: row.sandbox_observation_status,
	});
	return {
		conversationId: text(row.id),
		agentId: text(row.agent_id),
		...(row.sandbox_id === null
			? {}
			: {
					sandbox: parseSessionSandboxBindingV1({
						schemaVersion: 1,
						sandboxId: row.sandbox_id,
						sessionId: row.id,
						agentId: row.agent_id,
						principal: { kind: row.principal_type, id: row.actor_id },
						channelId: row.channel_id,
						generation: Number(row.session_generation),
						resourceName: row.resource_name,
						workspaceScope: row.workspace_scope,
					}),
				}),
		status: row.status,
		sandboxReady,
		...(!sandboxReady && row.sandbox_upgrading === true
			? { sandboxUpdating: true as const }
			: {}),
		...(!sandboxReady && row.sandbox_resumable === true
			? { sandboxResumable: true as const }
			: {}),
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
	const operation =
		row.event_type === "execution.operation"
			? parseConversationOperationEventV2(row.event_payload)
			: undefined;
	return {
		...(operation ? { eventSchemaVersion: 2 as const } : {}),
		eventId: text(row.event_id),
		conversationId: text(row.conversation_id),
		executionId: text(row.execution_id),
		sequence: safeInteger(row.sequence, 1),
		conversationCursor: conversationCursor(row.conversation_id, cursor),
		eventType: text(row.event_type, 128),
		eventPayload: operation?.fact ?? structuredClone(row.event_payload),
		occurredAt: timestamp(row.occurred_at),
		traceId: row.trace_id === null ? null : text(row.trace_id),
	};
}

const conversationSelection = `
 select id, agent_id, status, last_conversation_cursor, created_at, updated_at,
   sandbox_id, resource_name, workspace_scope, sandbox_status, sandbox_desired_state, sandbox_resource_fence, sandbox_observation_status, sandbox_upgrading, sandbox_resumable, actor_id, principal_type, channel_id, session_generation
 from (select c.*, s.sandbox_id, s.resource_name, s.workspace_scope,
   s.status as sandbox_status, s.desired_state as sandbox_desired_state,
   s.resource_fence as sandbox_resource_fence, s.resource_observation->>'status' as sandbox_observation_status,
   ${sessionSandboxUpgradingSql} as sandbox_upgrading,
   ${sessionSandboxResumableSql} as sandbox_resumable
   from platform.conversations c left join platform.session_sandbox_allocations s
     on s.conversation_id = c.id
   where ${conversationSandboxReadBindingSql}
 ) as conversations
`;

/**
 * Runs one top-level statement of a read. Only executed statements go through
 * it: cancelling an unsent SQL fragment would reject a promise nobody awaits.
 */
type RunStatement = <T>(
	statement: Promise<T> & { cancel(): unknown },
) => Promise<T>;

const runStatement: RunStatement = (statement) => statement;

/**
 * Statements of one read that stop when the caller aborts (#1732): an aborted
 * browser read no longer keeps a pooled connection busy. postgres-js removes a
 * queued statement and sends PostgreSQL a cancel request for the running one.
 */
function cancellableStatements(signal: AbortSignal | undefined) {
	if (!signal) return { run: runStatement, dispose: () => {} };
	const running = new Set<{ cancel(): unknown }>();
	const cancel = () => {
		for (const statement of running) statement.cancel();
	};
	signal.addEventListener("abort", cancel, { once: true });
	const run: RunStatement = async (statement) => {
		running.add(statement);
		try {
			if (signal.aborted) statement.cancel();
			return await statement;
		} finally {
			running.delete(statement);
		}
	};
	return {
		run,
		dispose: () => signal.removeEventListener("abort", cancel),
	};
}

async function readConversation(
	database: Database,
	readScope: ConversationQueryScopeV1,
	conversationId: string,
	run: RunStatement = runStatement,
): Promise<ConversationRow | undefined> {
	const rows = await run(
		database.unsafe<ConversationRow[]>(
			`${conversationSelection}
		 where id = $1 and actor_id = $2 and channel_id = $3 and principal_type = $4
		 limit 1`,
			[
				conversationId,
				readScope.actorId,
				readScope.channelId,
				readScope.principal?.kind ?? "user",
			],
		),
	);
	if (rows.length > 1) return unavailable();
	return rows[0];
}

async function readMessages(
	database: Database,
	conversationId: string,
	run: RunStatement = runStatement,
): Promise<ConversationQueryMessageV1[]> {
	const rows = await run(database<MessageRow[]>`
		select message_id, text, execution_id, status, failure_code, created_at
		from platform.conversation_messages
		where conversation_id = ${conversationId}
		order by created_at, message_id
	`);
	return rows.map(message);
}

async function readExecutions(
	database: Database,
	conversationId: string,
	executionId?: string,
	run: RunStatement = runStatement,
): Promise<ConversationQueryExecutionV1[]> {
	const rows = await run(database<ExecutionRow[]>`
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
		join platform.conversations c on c.id = e.conversation_id
			and c.agent_id = e.agent_id and c.actor_id = e.actor_id
			and c.channel_id = e.channel_id and c.principal_type = e.principal_type
		where e.conversation_id = ${conversationId}
			and (${executionId ?? null}::text is null or e.execution_id = ${executionId ?? null})
		order by e.created_at, e.execution_id
	`);
	return rows.map(execution);
}

async function readEvents(
	database: Database,
	conversationId: string,
	options: EventReadOptions = {},
	run: RunStatement = runStatement,
): Promise<ConversationQueryEventV1[]> {
	// Every event of an Execution carries the same trace: its first audit
	// record. Look it up once per Execution in the page, not once per event,
	// so an incremental replay costs only the Executions it returns (#1732).
	const rows = await run(database<EventRow[]>`
		with page as materialized (
			select e.event_id, e.conversation_id, e.execution_id, e.sequence,
				e.conversation_cursor, e.event_type, e.event_payload, e.occurred_at
			from platform.conversation_events e
			join platform.conversation_executions x
				on x.execution_id = e.execution_id and x.conversation_id = e.conversation_id
			join platform.conversations c on c.id = x.conversation_id
				and c.agent_id = x.agent_id and c.actor_id = x.actor_id
				and c.principal_type = x.principal_type and c.channel_id = x.channel_id
			where e.conversation_id = ${conversationId}
				and e.conversation_cursor > ${options.afterCursor ?? 0}
				${options.beforeCursor === undefined ? database`` : database`and e.conversation_cursor < ${options.beforeCursor}`}
				${options.executionId === undefined ? database`` : database`and e.execution_id = ${options.executionId}`}
			order by e.conversation_cursor
			${options.limit === undefined ? database`` : database`limit ${options.limit}`}
		), traces as materialized (
			select executions.execution_id,
				(
					select a.trace_id
					from platform.conversation_audit_events a
					where a.execution_id = executions.execution_id
					order by a.occurred_at, a.id
					limit 1
				) as trace_id
			from (select distinct execution_id from page) executions
		)
		select page.*, traces.trace_id
		from page
		left join traces on traces.execution_id = page.execution_id
		order by page.conversation_cursor
	`);
	return rows.map(event);
}

async function readEventPage(
	database: Database,
	conversationId: string,
	options: { readonly beforeCursor?: number; readonly limit: number },
	run: RunStatement = runStatement,
): Promise<{
	readonly events: readonly ConversationQueryEventV1[];
	readonly eventWindow: ConversationEventWindowV1;
}> {
	const [boundary] = await run(database<
		{ page_start: string | number | null }[]
	>`
		with boundary_event as (
			select e.execution_id
			from platform.conversation_events e
			where e.conversation_id = ${conversationId}
				${options.beforeCursor === undefined ? database`` : database`and e.conversation_cursor < ${options.beforeCursor}`}
			order by e.conversation_cursor desc
			offset ${Math.max(0, options.limit - 1)}
			limit 1
		), boundary as (
			select min(e.conversation_cursor) as page_start
			from platform.conversation_events e
			join boundary_event b on b.execution_id = e.execution_id
			where e.conversation_id = ${conversationId}
		), first_event as (
			select min(e.conversation_cursor) as page_start
			from platform.conversation_events e
			where e.conversation_id = ${conversationId}
				${options.beforeCursor === undefined ? database`` : database`and e.conversation_cursor < ${options.beforeCursor}`}
		)
		select coalesce(boundary.page_start, first_event.page_start) as page_start
		from boundary cross join first_event
	`);
	const pageStart =
		boundary?.page_start === null || boundary?.page_start === undefined
			? 0
			: safeInteger(boundary.page_start, 1);
	const events =
		pageStart === 0
			? []
			: await readEvents(
					database,
					conversationId,
					{
						afterCursor: pageStart - 1,
						limit: undefined,
						...(options.beforeCursor === undefined
							? {}
							: { beforeCursor: options.beforeCursor }),
					},
					run,
				);
	const [earlier] = await run(database<{ cursor: string | number | null }[]>`
		select max(e.conversation_cursor) as cursor
		from platform.conversation_events e
		where e.conversation_id = ${conversationId}
			and e.conversation_cursor < ${pageStart}
	`);
	const beforeCursor =
		earlier?.cursor === null || earlier?.cursor === undefined
			? null
			: conversationCursor(conversationId, pageStart);
	return {
		events,
		eventWindow: { hasEarlier: beforeCursor !== null, beforeCursor },
	};
}

async function isWithinReplayTimeWindow(
	database: Database,
	conversationId: string,
	afterCursor: number,
	latestCursor: number,
	replayWindowMs: number,
	executionId?: string,
	run: RunStatement = runStatement,
): Promise<boolean> {
	if (afterCursor === latestCursor) return true;
	const anchorCursor = afterCursor + 1;
	const rows = await run(database<EventWindowRow[]>`
		select persisted_at >= now() - (${replayWindowMs}::bigint * interval '1 millisecond')
			as within_window
		from platform.conversation_events
		where conversation_id = ${conversationId}
			${executionId === undefined ? database`and conversation_cursor = ${anchorCursor}` : database`and execution_id = ${executionId} and conversation_cursor > ${afterCursor}`}
		order by conversation_cursor
		limit 1
	`);
	return rows[0]?.within_window === true;
}

async function repeatableRead<T>(
	client: ReturnType<typeof postgres>,
	read: (transaction: postgres.TransactionSql, run: RunStatement) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (signal?.aborted) return unavailable();
	const statements = cancellableStatements(signal);
	try {
		return (await client.begin(async (transaction) => {
			await statements.run(
				transaction`set transaction isolation level repeatable read read only`,
			);
			return read(transaction, statements.run);
		})) as T;
	} finally {
		statements.dispose();
	}
}

function countResource(value: unknown): number {
	if (typeof value !== "string" || !/^\d+$/.test(value))
		throw new Error("Platform resource snapshot is unavailable");
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed))
		throw new Error("Platform resource snapshot is unavailable");
	return parsed;
}

const activeResourceSnapshots = new WeakSet<postgres.Sql>();

/** The Store query and both process samplers share this bounded timeout. */
export const platformQueueResourceSnapshotTimeoutMs = 2_000;

function boundedResourceSnapshotDuration(startedAt: number): number {
	const duration = performance.now() - startedAt;
	if (!Number.isFinite(duration)) return platformQueueResourceSnapshotTimeoutMs;
	return Math.min(
		platformQueueResourceSnapshotTimeoutMs,
		Math.max(0, duration),
	);
}

/** Read one bounded, read-only resource snapshot for the observability consumer. */
export async function readPlatformQueueResourceSnapshot(
	client: postgres.Sql,
	signal: AbortSignal,
): Promise<PlatformQueueResourceSnapshot> {
	const startedAt = performance.now();
	const unavailable = () =>
		new Error("Platform resource snapshot is unavailable");
	if (signal.aborted) throw unavailable();
	if (activeResourceSnapshots.has(client)) throw unavailable();
	activeResourceSnapshots.add(client);
	const controller = new AbortController();
	const operationSignal = controller.signal;
	let callerAborted: boolean = signal.aborted;
	const onAbort = () => {
		callerAborted = true;
		controller.abort();
	};
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	const timer = setTimeout(
		() => controller.abort(),
		platformQueueResourceSnapshotTimeoutMs,
	);
	let rejectOnAbort: () => void = () => {};
	let removeOperationAbortListener = () => {};
	let began = false;
	let snapshot: Promise<PlatformQueueResourceSnapshot> | undefined;
	const releaseClient = () => {
		removeOperationAbortListener();
		activeResourceSnapshots.delete(client);
	};
	try {
		const cancelled = new Promise<never>((_, reject) => {
			rejectOnAbort = () => reject(unavailable());
			operationSignal.addEventListener("abort", rejectOnAbort, {
				once: true,
			});
			if (operationSignal.aborted) rejectOnAbort();
		});
		let currentQuery: { cancel(): void } | undefined;
		const onOperationAbort = () => currentQuery?.cancel();
		operationSignal.addEventListener("abort", onOperationAbort);
		removeOperationAbortListener = () =>
			operationSignal.removeEventListener("abort", onOperationAbort);
		const runQuery = async <T>(
			query: Promise<T> & { cancel(): void },
		): Promise<T> => {
			currentQuery = query;
			try {
				if (operationSignal.aborted) query.cancel();
				return await query;
			} finally {
				if (currentQuery === query) currentQuery = undefined;
			}
		};
		snapshot = client.begin("read only", async (transaction) => {
			if (operationSignal.aborted) throw unavailable();
			await runQuery(transaction`set local statement_timeout = '2000ms'`);
			if (operationSignal.aborted) throw unavailable();
			const rows = await runQuery(transaction<
				{ task_waiting: string; outbox_pending: string }[]
			>`
		select
			(select count(distinct e.execution_id)::text
				from platform.conversation_executions e
				join platform.conversations c
					on c.id = e.conversation_id
					and c.agent_id = e.agent_id
					and c.actor_id = e.actor_id
					and c.channel_id = e.channel_id
					and c.session_generation = e.session_generation
					and c.authorization_revision = e.authorization_revision
				where e.status = 'submitted'
					and c.status <> 'unavailable'
					and exists (
						select 1
						from platform.outbox_items o
						where o.scope_type = 'conversation'
							and o.scope_id = c.id
							and o.operation in (
								'conversation.turn.submit.v1',
								'conversation.turn.regenerate.v1'
							)
							and o.status in ('pending', 'retry_scheduled', 'processing')
							and o.payload->>'schemaVersion' = '1'
							and o.payload->>'conversationId' = e.conversation_id
							and o.payload->>'executionId' = e.execution_id
							and o.payload->>'sessionGeneration' = e.session_generation::text
							and o.payload->>'turnId' = e.turn_id
							and not (o.payload ? 'metadataRecovery')
							and exists (
								select 1
								from platform.conversation_messages m
								where m.message_id = o.payload->>'messageId'
									and m.conversation_id = e.conversation_id
									and m.actor_id = e.actor_id
									and m.role = 'user'
									and m.status = 'submitted'
									and (
										o.operation = 'conversation.turn.regenerate.v1'
										or m.execution_id = e.execution_id
									)
							)
					)
					and not exists (
						select 1
						from platform.conversation_stops s
						where s.execution_id = e.execution_id
					)
					and not exists (
						select 1
						from platform.task_authorization_records a
						where a.execution_id = e.execution_id
							and a.revoked_at is not null
					)
					and not exists (
						select 1
						from platform.conversation_generation_tombstones t
						where t.execution_id = e.execution_id
							and t.conversation_id = e.conversation_id
							and t.session_generation = e.session_generation
							and t.status = 'pending'
					)) as task_waiting,
			(select count(*)::text from platform.outbox_items
				where status in ('pending', 'retry_scheduled')) as outbox_pending
	`);
			if (operationSignal.aborted) throw unavailable();
			if (rows.length !== 1) throw unavailable();
			return {
				taskWaiting: countResource(rows[0]?.task_waiting),
				outboxPending: countResource(rows[0]?.outbox_pending),
				queryDurationMs: boundedResourceSnapshotDuration(startedAt),
			};
		});
		began = true;
		const queueSnapshot = await Promise.race([snapshot, cancelled]);
		if (operationSignal.aborted) {
			if (callerAborted) throw unavailable();
			return queueSnapshot;
		}
		// Keep the existing mock/adapter behavior for an empty transaction result;
		// a real Store transaction always returns the complete queue snapshot.
		if (!queueSnapshot) {
			releaseClient();
			return queueSnapshot as PlatformQueueResourceSnapshot;
		}

		return queueSnapshot;
	} catch {
		if (!began) {
			releaseClient();
		}
		// Sampling errors never expose driver messages, connection details or raw data.
		throw unavailable();
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
		operationSignal.removeEventListener("abort", rejectOnAbort);
		if (!began) {
			releaseClient();
		} else {
			void Promise.allSettled(
				[snapshot].filter((value) => value !== undefined),
			).then(() => {
				releaseClient();
			});
		}
	}
}

export class PostgresConversationQueryV1 {
	readonly #client: ReturnType<typeof postgres>;
	readonly #replayWindow: number;
	readonly #replayWindowMs: number;
	readonly #eventWindow: number | undefined;

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
					maximumReplayWindowMs ||
				(options.eventWindow !== undefined &&
					(!Number.isSafeInteger(options.eventWindow) ||
						options.eventWindow < 1 ||
						options.eventWindow > 10_000))
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
			this.#eventWindow = options.eventWindow;
		} catch (error) {
			if (error instanceof ConversationQueryError) throw error;
			unavailable();
		}
	}

	readResourceSnapshot(
		signal: AbortSignal,
	): Promise<PlatformQueueResourceSnapshot> {
		return readPlatformQueueResourceSnapshot(this.#client, signal);
	}

	readRecentPersonalConversations(input: RecentPersonalConversationsQueryV1) {
		return readRecentPersonalConversations(this.#client, input, projection);
	}

	async readNativeMetadataObjectScopeV1(
		inputScope: ConversationQueryScopeV1,
		conversationIdInput: string,
		executionIdInput: string,
		signal?: AbortSignal,
	): Promise<NativeMetadataObjectScopeResponseV1 | undefined>;
	async readNativeMetadataObjectScopeV1(
		request: NativeMetadataObjectScopeRequestV1,
	): Promise<NativeMetadataObjectScopeResponseV1 | undefined>;
	async readNativeMetadataObjectScopeV1(
		inputOrRequest:
			| ConversationQueryScopeV1
			| NativeMetadataObjectScopeRequestV1,
		conversationIdInput?: string,
		executionIdInput?: string,
		signal?: AbortSignal,
	): Promise<NativeMetadataObjectScopeResponseV1 | undefined> {
		const request =
			"scope" in inputOrRequest
				? inputOrRequest
				: {
						scope: inputOrRequest,
						conversationId: conversationIdInput,
						executionId: executionIdInput,
						signal,
					};
		const readScope = scope(request.scope);
		const conversationId = requestText(request.conversationId);
		const executionId = requestText(request.executionId);
		// API/application metadata reads remain closed until their current
		// credential contract is connected. Web uses the original-user policy.
		if (readScope.channelId !== "web") return undefined;
		try {
			return await repeatableRead(
				this.#client,
				async (transaction, run) => {
					const rows = await run(
						transaction<NativeMetadataObjectScopeRow[]>`
							/* native_metadata_read.original_execution */
							select
								c.id as conversation_id,
								c.agent_id as conversation_agent,
								c.actor_id as conversation_actor,
								c.channel_id as conversation_channel,
								c.principal_type as conversation_principal_type,
								e.execution_id,
								e.conversation_id as execution_conversation,
								e.agent_id as execution_agent,
								e.actor_id as execution_actor,
								e.channel_id as execution_channel,
								e.principal_type as execution_principal_type,
								e.session_generation::text,
								e.authorization_revision,
								e.original_submit_host_session_ref as original_host_scope_ref
							from platform.conversations c
							join platform.conversation_executions e
								on e.conversation_id = c.id
								and e.agent_id = c.agent_id
								and e.actor_id = c.actor_id
								and e.channel_id = c.channel_id
								and e.principal_type = c.principal_type
								and e.execution_id = ${executionId}
							where c.id = ${conversationId}
								and c.actor_id = ${readScope.actorId}
								and c.channel_id = ${readScope.channelId}
								and c.principal_type = ${readScope.principal?.kind ?? "user"}
							limit 2
						`,
					);
					if (rows.length === 0) return undefined;
					const row = rows[0];
					if (
						rows.length !== 1 ||
						!row ||
						row.conversation_id !== conversationId ||
						row.execution_id !== executionId ||
						row.execution_conversation !== row.conversation_id ||
						row.conversation_agent !== row.execution_agent ||
						row.conversation_actor !== row.execution_actor ||
						row.conversation_channel !== row.execution_channel ||
						row.conversation_principal_type !== row.execution_principal_type ||
						(row.execution_principal_type !== "user" &&
							row.execution_principal_type !== "application") ||
						row.execution_actor !== readScope.actorId ||
						row.execution_channel !== readScope.channelId
					)
						return unavailable();
					return {
						...NativeMetadataObjectScopeV1Schema.parse({
							schemaVersion: 1,
							principal: {
								kind:
									row.execution_principal_type === "application"
										? "application"
										: "user",
								id: row.execution_actor,
							},
							agentId: row.execution_agent,
							channelId: row.execution_channel,
							conversationId: row.execution_conversation,
							executionId: row.execution_id,
							sessionGeneration: safeInteger(row.session_generation, 1),
							authorizationRevision: row.authorization_revision,
						}),
						originalHostScopeRef: row.original_host_scope_ref,
					};
				},
				request.signal,
			);
		} catch (error) {
			if (error instanceof ConversationQueryError) throw error;
			return unavailable();
		}
	}

	/**
	 * Resolve the current Web execution for the API → Worker model-directory
	 * dispatch. The Store proves the Conversation/Execution/Session/fence
	 * relationship; the Worker remains responsible for issuing the Host Grant.
	 */
	async readRuntimeModelDirectoryDispatchRequestV1(
		request: RuntimeModelDirectoryDispatchRequestInputV1,
	): Promise<RuntimeModelDirectoryDispatchRequestResponseV1 | undefined> {
		const readScope = scope(request.scope);
		const conversationId = requestText(request.conversationId);
		if (readScope.channelId !== "web") return undefined;
		try {
			return await repeatableRead(
				this.#client,
				async (transaction, run) => {
					const rows = await run(
						transaction<RuntimeModelDirectoryDispatchRow[]>`
							/* runtime_model_directory.current_dispatch */
							select
								c.id as conversation_id,
								c.agent_id as conversation_agent,
								c.actor_id as conversation_actor,
								c.channel_id as conversation_channel,
								c.principal_type as conversation_principal_type,
								c.host_session_ref as conversation_host_session_ref,
								c.session_generation as conversation_session_generation,
								e.execution_id,
								e.conversation_id as execution_conversation,
								e.agent_id as execution_agent,
								e.actor_id as execution_actor,
								e.channel_id as execution_channel,
								e.principal_type as execution_principal_type,
								e.turn_id,
								e.session_generation,
								e.delivery_fence,
								(
									select a.trace_id
									from platform.conversation_audit_events a
									where a.execution_id = e.execution_id
									order by a.occurred_at, a.id
									limit 1
								) as trace_id
							from platform.conversations c
							join platform.conversation_executions e
								on e.conversation_id = c.id
								and e.agent_id = c.agent_id
								and e.actor_id = c.actor_id
								and e.channel_id = c.channel_id
								and e.principal_type = c.principal_type
							where c.id = ${conversationId}
								and c.actor_id = ${readScope.actorId}
								and c.channel_id = ${readScope.channelId}
								and c.principal_type = ${readScope.principal?.kind ?? "user"}
								and c.channel_id = 'web'
								and c.principal_type = 'user'
								and c.host_session_ref is not null
								and c.session_generation = e.session_generation
								and e.delivery_fence > 0
								and e.status in ('submitted', 'processing', 'unknown')
							order by e.updated_at desc, e.execution_id
							limit 2
						`,
					);
					if (rows.length !== 1) return undefined;
					const row = rows[0];
					if (
						!row ||
						row.conversation_id !== conversationId ||
						row.execution_conversation !== row.conversation_id ||
						row.conversation_agent !== row.execution_agent ||
						row.conversation_actor !== row.execution_actor ||
						row.conversation_channel !== row.execution_channel ||
						row.conversation_principal_type !== row.execution_principal_type ||
						row.conversation_channel !== "web" ||
						row.conversation_principal_type !== "user" ||
						row.conversation_host_session_ref === null
					)
						return undefined;
					return RuntimeModelDirectoryDispatchRequestV1Schema.parse({
						schemaVersion: 1,
						requestId: randomUUID(),
						traceId: row.trace_id ?? randomUUID(),
						actorId: row.conversation_actor,
						channelId: row.conversation_channel,
						agentId: row.conversation_agent,
						conversationId: row.conversation_id,
						executionId: row.execution_id,
						turnId: row.turn_id,
						sessionGeneration: safeInteger(row.session_generation, 1),
						deliveryFence: safeInteger(row.delivery_fence, 1),
						hostSessionRef: row.conversation_host_session_ref,
					});
				},
				request.signal,
			);
		} catch (error) {
			if (error instanceof ConversationQueryError) throw error;
			return unavailable();
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
		const cursorActor =
			readScope.channelId === "api"
				? `${readScope.principal?.kind}:${readScope.actorId}`
				: readScope.actorId;
		const page = parsePage(pageInput);
		let afterId: string | undefined;
		if (page.cursor !== undefined) {
			const cursor = decodeCursor(page.cursor);
			if (
				cursor[0] !== "list" ||
				cursor[1] !== cursorActor ||
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
				 where actor_id = $1 and channel_id = $2 and agent_id = $3 and principal_type = $6
					and ($4::text is null or id > $4)
				 order by id
				 limit $5`,
				[
					readScope.actorId,
					readScope.channelId,
					agentId,
					afterId ?? null,
					page.limit + 1,
					readScope.principal?.kind ?? "user",
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
							cursorActor,
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
		signal?: AbortSignal,
		readOptionsInput?: ConversationQueryReadOptionsV1,
	): Promise<ConversationQueryDetailV1 | undefined> {
		const readScope = scope(inputScope);
		const conversationId = requestText(conversationIdInput);
		let beforeCursor: number | undefined;
		if (readOptionsInput?.beforeCursor !== undefined) {
			const decoded = decodeCursor(
				requestText(readOptionsInput.beforeCursor, 4096),
			);
			if (decoded[0] !== "conversation" || decoded[1] !== conversationId)
				return invalidRequest();
			beforeCursor = decoded[2];
		}
		try {
			return await repeatableRead(
				this.#client,
				async (transaction, run) => {
					const row = await readConversation(
						transaction,
						readScope,
						conversationId,
						run,
					);
					if (!row) return undefined;
					const [messages, executions, page] = await Promise.all([
						readMessages(transaction, conversationId, run),
						readExecutions(transaction, conversationId, undefined, run),
						this.#eventWindow === undefined && beforeCursor === undefined
							? readEvents(transaction, conversationId, {}, run).then(
									(events) => ({
										events,
										eventWindow: { hasEarlier: false, beforeCursor: null },
									}),
								)
							: readEventPage(
									transaction,
									conversationId,
									{
										limit: this.#eventWindow ?? 200,
										...(beforeCursor === undefined ? {} : { beforeCursor }),
									},
									run,
								),
					]);
					return {
						conversation: projection(row),
						messages,
						executions,
						events: page.events,
						eventWindow: page.eventWindow,
					};
				},
				signal,
			);
		} catch (error) {
			if (error instanceof ConversationQueryError) throw error;
			return unavailable();
		}
	}

	async getProjection(
		inputScope: ConversationQueryScopeV1,
		conversationIdInput: string,
		signal?: AbortSignal,
	): Promise<ConversationQueryProjectionV1 | undefined> {
		const readScope = scope(inputScope);
		const conversationId = requestText(conversationIdInput);
		try {
			return await repeatableRead(
				this.#client,
				async (transaction, run) => {
					const row = await readConversation(
						transaction,
						readScope,
						conversationId,
						run,
					);
					return row === undefined ? undefined : projection(row);
				},
				signal,
			);
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
		signal?: AbortSignal,
	): Promise<ConversationReplayResultV1 | undefined> {
		return this.#replay(
			inputScope,
			conversationIdInput,
			selectorInput,
			undefined,
			signal,
		);
	}

	async #replay(
		inputScope: ConversationQueryScopeV1,
		conversationIdInput: string,
		selectorInput:
			| { readonly kind: "cursor" | "last-event-id"; readonly value: string }
			| undefined,
		executionIdInput: string | undefined,
		signal: AbortSignal | undefined,
	): Promise<ConversationReplayResultV1 | undefined> {
		const readScope = scope(inputScope);
		const conversationId = requestText(conversationIdInput);
		const selector = replaySelector(selectorInput);
		const executionId =
			executionIdInput === undefined
				? undefined
				: requestText(executionIdInput);
		try {
			return await repeatableRead(
				this.#client,
				async (transaction, run) => {
					const conversation = await readConversation(
						transaction,
						readScope,
						conversationId,
						run,
					);
					if (!conversation) return undefined;
					if (
						executionId !== undefined &&
						(
							await readExecutions(
								transaction,
								conversationId,
								executionId,
								run,
							)
						).length !== 1
					)
						return undefined;
					const latest = safeInteger(conversation.last_conversation_cursor, 0);
					let resumePosition = latest;
					if (executionId !== undefined) {
						const [last] = await run(transaction<EventIdentityRow[]>`
						select conversation_cursor from platform.conversation_events
						where conversation_id = ${conversationId} and execution_id = ${executionId}
						order by conversation_cursor desc limit 1
					`);
						resumePosition = last
							? safeInteger(last.conversation_cursor, 1)
							: 0;
					}
					const resumeCursor = conversationCursor(
						conversationId,
						resumePosition,
					);
					let after = 0;
					if (selector?.kind === "cursor") {
						const decoded = decodeCursor(selector.value);
						if (
							decoded[0] !== "conversation" ||
							decoded[1] !== conversationId
						) {
							return {
								outcome: "reload",
								reason: "cross_conversation_cursor",
								resumeCursor,
							};
						}
						after = decoded[2];
						if (executionId !== undefined && after !== 0) {
							const [anchor] = await run(transaction<EventIdentityRow[]>`
							select conversation_cursor from platform.conversation_events
							where conversation_id = ${conversationId} and execution_id = ${executionId}
								and conversation_cursor = ${after}
						`);
							if (!anchor)
								return {
									outcome: "reload",
									reason: "cursor_expired",
									resumeCursor,
								};
						}
					} else if (selector?.kind === "last-event-id") {
						const rows = await run(transaction<EventIdentityRow[]>`
						select conversation_cursor
						from platform.conversation_events
						where event_id = ${selector.value}
							and conversation_id = ${conversationId}
							${executionId === undefined ? transaction`` : transaction`and execution_id = ${executionId}`}
						limit 1
					`);
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
					let exceedsWindow = after < Math.max(0, latest - this.#replayWindow);
					if (executionId !== undefined) {
						const [pending] = await run(transaction<{ count: number }[]>`
						select count(*)::int as count from platform.conversation_events
						where conversation_id = ${conversationId} and execution_id = ${executionId}
							and conversation_cursor > ${after}
					`);
						if (!pending) return unavailable();
						exceedsWindow = pending.count > this.#replayWindow;
					}
					if (
						after > resumePosition ||
						exceedsWindow ||
						!(await isWithinReplayTimeWindow(
							transaction,
							conversationId,
							after,
							resumePosition,
							this.#replayWindowMs,
							executionId,
							run,
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
						events: await readEvents(
							transaction,
							conversationId,
							{
								afterCursor: after,
								limit: this.#replayWindow,
								...(executionId === undefined ? {} : { executionId }),
							},
							run,
						),
						resumeCursor,
					};
				},
				signal,
			);
		} catch (error) {
			if (error instanceof ConversationQueryError) throw error;
			return unavailable();
		}
	}

	async replayExecution(
		inputScope: ConversationQueryScopeV1,
		conversationId: string,
		executionId: string,
		selector:
			| { readonly kind: "cursor" | "last-event-id"; readonly value: string }
			| undefined,
		signal?: AbortSignal,
	): Promise<ConversationReplayResultV1 | undefined> {
		return this.#replay(
			inputScope,
			conversationId,
			selector,
			executionId,
			signal,
		);
	}

	async close(): Promise<void> {
		try {
			await this.#client.end();
		} catch {
			return unavailable();
		}
	}
}
