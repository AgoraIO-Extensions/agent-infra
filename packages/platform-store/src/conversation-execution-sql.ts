import { createHash, randomUUID } from "node:crypto";
import type {
	ConversationExecutionAuthorityV1,
	ConversationExecutionConversationStateV1,
	ConversationExecutionStateV1,
	ConversationMessageWritePlanV1,
	ConversationModelConfigurationV1,
	ConversationModelSelectionFallbackWriteV1,
	ConversationModelSelectionWritePlanV1,
	ConversationRegenerationWritePlanV1,
	ConversationStopWritePlanV1,
} from "@agent-infra/platform-core";
import { decodeAgentConfigurationRecord } from "./agent-configuration-record.js";
import {
	type AgentConfigurationRow,
	activeExecutionStatuses,
	type ConversationRow,
	type ExecutionRow,
	type IdempotencyRow,
	type JsonValue,
	type MessageDecide,
	type ModelSelectionDecide,
	type RegenerationDecide,
	type StopDecide,
	type StopRow,
	safeInteger,
	type Transaction,
	text,
	unavailable,
} from "./conversation-execution-common.js";
import { executionIsTerminal } from "./conversation-execution-plans.js";
import {
	conversationFromRow,
	matchesBinding,
	type parseCreatedResult,
	type parseMessageResult,
	type parseRegenerationResult,
	type parseStopResult,
} from "./conversation-execution-records.js";

async function lockAgentConfiguration(
	transaction: Transaction,
	agentId: string,
): Promise<
	| {
			readonly authorizationRevision: string | null;
			readonly modelConfiguration: ConversationModelConfigurationV1 | undefined;
	  }
	| undefined
> {
	const rows = await transaction<AgentConfigurationRow[]>`
		select agent.current_configuration_revision, agent.authorization_revision,
			configuration.configuration
		from platform.agents as agent
		left join platform.agent_configuration_revisions as configuration
			on configuration.agent_id = agent.id
			and configuration.revision = agent.current_configuration_revision
		where agent.id = ${agentId}
		limit 1
		for share of agent
	`;
	const row = rows[0];
	if (!row) return undefined;
	if (row.configuration === null) {
		return {
			authorizationRevision: row.authorization_revision,
			modelConfiguration: undefined,
		};
	}
	try {
		const revision = safeInteger(row.current_configuration_revision, 1);
		const configuration = decodeAgentConfigurationRecord(row.configuration);
		if (
			configuration.agentId !== agentId ||
			configuration.revision !== revision
		) {
			return unavailable();
		}
		const model = configuration.modelConfiguration;
		return {
			authorizationRevision: row.authorization_revision,
			modelConfiguration: model
				? {
						configurationRevision: revision,
						options: model.options.map(({ optionId, reasoningLevels }) => ({
							optionId,
							reasoningLevels,
						})),
						defaultOptionId: model.defaultOptionId,
						defaultReasoningLevel: model.defaultReasoningLevel,
					}
				: undefined,
		};
	} catch {
		return unavailable();
	}
}

export function createIdempotencyScopeId(
	agentId: string,
	channelId: string,
): string {
	return JSON.stringify([agentId, channelId]);
}

export function outboxId(
	operation: "conversation.turn.submit.v1" | "conversation.turn.supplement.v1",
	messageId: string,
	executionId: string,
): string {
	return operation === "conversation.turn.submit.v1"
		? `conversation:turn:${executionId}`
		: `conversation:supplement:${messageId}`;
}

export function isMessagePlan(
	decision: Awaited<ReturnType<MessageDecide>>,
): decision is ConversationMessageWritePlanV1 {
	return !Object.hasOwn(decision, "outcome");
}

export function isModelSelectionPlan(
	decision: Awaited<ReturnType<ModelSelectionDecide>>,
): decision is ConversationModelSelectionWritePlanV1 {
	return !Object.hasOwn(decision, "outcome");
}

export function isRegenerationPlan(
	decision: Awaited<ReturnType<RegenerationDecide>>,
): decision is ConversationRegenerationWritePlanV1 {
	return !Object.hasOwn(decision, "outcome");
}

export function isStopPlan(
	decision: Awaited<ReturnType<StopDecide>>,
): decision is ConversationStopWritePlanV1 {
	return !Object.hasOwn(decision, "outcome");
}

export async function readIdempotency(
	transaction: Transaction,
	input: {
		readonly scopeType: string;
		readonly scopeId: string;
		readonly actorId: string;
		readonly commandType: string;
		readonly key: string;
	},
): Promise<IdempotencyRow | undefined> {
	const rows = await transaction<IdempotencyRow[]>`
		select request_digest, status, result
		from platform.idempotency_records
		where scope_type = ${input.scopeType}
			and scope_id = ${input.scopeId}
			and actor_id = ${input.actorId}
			and command_type = ${input.commandType}
			and idempotency_key = ${input.key}
		limit 1
	`;
	return rows[0];
}

export async function reserveIdempotency(
	transaction: Transaction,
	input: {
		readonly scopeType: string;
		readonly scopeId: string;
		readonly actorId: string;
		readonly commandType: string;
		readonly key: string;
		readonly requestDigest: string;
		readonly occurredAt: Date;
	},
): Promise<string | undefined> {
	const id = randomUUID();
	const inserted = await transaction<{ id: string }[]>`
		insert into platform.idempotency_records
			(id, scope_type, scope_id, actor_id, command_type, idempotency_key,
			 request_digest, status, created_at, updated_at)
		values
			(${id}, ${input.scopeType}, ${input.scopeId}, ${input.actorId},
			 ${input.commandType}, ${input.key}, ${input.requestDigest}, 'reserved',
			 ${input.occurredAt}, ${input.occurredAt})
		on conflict (scope_type, scope_id, actor_id, command_type, idempotency_key)
		do nothing
		returning id
	`;
	return inserted[0]?.id;
}

export async function completeIdempotency(
	transaction: Transaction,
	id: string,
	result: unknown,
	occurredAt: Date,
): Promise<void> {
	const completed = await transaction<{ id: string }[]>`
		update platform.idempotency_records
		set status = 'completed', result = ${transaction.json(result as JsonValue)},
			updated_at = ${occurredAt}
		where id = ${id} and status = 'reserved'
		returning id
	`;
	if (completed.length !== 1) unavailable();
}

export async function lockConversation(
	transaction: Transaction,
	conversationId: string,
): Promise<ConversationExecutionConversationStateV1 | undefined> {
	const rows = await transaction<ConversationRow[]>`
		select id, agent_id, actor_id, channel_id, status, session_generation,
			host_session_ref, authorization_revision, last_conversation_cursor,
			selected_model_option_id, selected_reasoning_level, created_at, updated_at
		from platform.conversations where id = ${conversationId} for update
	`;
	const row = rows[0];
	if (!row) return undefined;
	const [pending] =
		await transaction`select 1 from platform.conversation_generation_tombstones where conversation_id = ${conversationId} and session_generation = ${row.session_generation} and status = 'pending'`;
	return conversationFromRow(row, !!pending);
}

export async function lockConversationForRead(
	transaction: Transaction,
	conversationId: string,
): Promise<ConversationExecutionConversationStateV1 | undefined> {
	const rows = await transaction<ConversationRow[]>`
		select id, agent_id, actor_id, channel_id, status, session_generation,
			host_session_ref, authorization_revision, last_conversation_cursor,
			selected_model_option_id, selected_reasoning_level, created_at, updated_at
		from platform.conversations where id = ${conversationId} for share
	`;
	const row = rows[0];
	if (!row) return undefined;
	const [pending] =
		await transaction`select 1 from platform.conversation_generation_tombstones where conversation_id = ${conversationId} and session_generation = ${row.session_generation} and status = 'pending'`;
	return conversationFromRow(row, !!pending);
}

export async function readMessageState(
	transaction: Transaction,
	conversation: ConversationExecutionConversationStateV1,
): Promise<ConversationExecutionStateV1> {
	const agent = await lockAgentConfiguration(transaction, conversation.agentId);
	const activeRows = await transaction<ExecutionRow[]>`
		select execution_id, conversation_id, actor_id, turn_id, session_generation,
			model_configuration_revision, model_option_id, reasoning_level,
			last_event_sequence, status
		from platform.conversation_executions
		where conversation_id = ${conversation.conversationId}
			and status in ('submitted', 'processing', 'unknown')
		limit 2
		for update
	`;
	if (activeRows.length > 1) unavailable();
	const active = activeRows[0];
	if (!active) {
		return {
			conversation,
			modelConfiguration: agent?.modelConfiguration,
			sourceMessage: undefined,
			targetExecution: undefined,
			existingStop: undefined,
			activeExecution: undefined,
		};
	}
	const status = text(active.status);
	if (!activeExecutionStatuses.has(status)) unavailable();
	const stopRows = await transaction<StopRow[]>`
		select execution_id, stop_request_id, status
		from platform.conversation_stops
		where execution_id = ${active.execution_id}
		limit 1
	`;
	const stop = stopRows[0];
	if (stop && stop.status !== "submitted" && stop.status !== "completed")
		unavailable();
	return {
		conversation,
		modelConfiguration: agent?.modelConfiguration,
		sourceMessage: undefined,
		targetExecution: undefined,
		existingStop: undefined,
		activeExecution: {
			executionId: text(active.execution_id),
			conversationId: text(active.conversation_id),
			actorId: text(active.actor_id),
			turnId: text(active.turn_id),
			sessionGeneration: safeInteger(active.session_generation, 1),
			modelConfigurationRevision:
				active.model_configuration_revision === null
					? null
					: safeInteger(active.model_configuration_revision, 1),
			modelOptionId:
				active.model_option_id === null ? null : text(active.model_option_id),
			reasoningLevel:
				active.reasoning_level === null ? null : text(active.reasoning_level),
			lastEventSequence: safeInteger(active.last_event_sequence, 0),
			stopPending: stop?.status === "submitted",
			status: status as "submitted" | "processing" | "unknown",
		},
	};
}

export async function readModelSelectionState(
	transaction: Transaction,
	conversation: ConversationExecutionConversationStateV1,
): Promise<
	ConversationExecutionStateV1 & {
		readonly currentAuthorizationRevision: string | null | undefined;
	}
> {
	const agent = await lockAgentConfiguration(transaction, conversation.agentId);
	return {
		conversation,
		modelConfiguration: agent?.modelConfiguration,
		sourceMessage: undefined,
		targetExecution: undefined,
		existingStop: undefined,
		activeExecution: undefined,
		currentAuthorizationRevision: agent?.authorizationRevision,
	};
}

export async function readRegenerationState(
	transaction: Transaction,
	conversation: ConversationExecutionConversationStateV1,
	sourceMessageId: string,
): Promise<ConversationExecutionStateV1> {
	const state = await readMessageState(transaction, conversation);
	const rows = await transaction<
		{
			readonly message_id: string;
			readonly conversation_id: string;
			readonly actor_id: string;
			readonly role: string;
		}[]
	>`
		select message_id, conversation_id, actor_id, role
		from platform.conversation_messages
		where conversation_id = ${conversation.conversationId}
			and message_id = ${sourceMessageId}
		limit 1
	`;
	const source = rows[0];
	if (!source) return state;
	if (source.role !== "user") unavailable();
	return {
		...state,
		sourceMessage: {
			messageId: text(source.message_id),
			conversationId: text(source.conversation_id),
			actorId: text(source.actor_id),
			role: "user",
		},
	};
}

export async function readStopState(
	transaction: Transaction,
	conversation: ConversationExecutionConversationStateV1,
	targetExecutionId: string,
): Promise<ConversationExecutionStateV1> {
	const state = await readMessageState(transaction, conversation);
	const rows = await transaction<
		{
			readonly execution_id: string;
			readonly conversation_id: string;
			readonly actor_id: string;
			readonly session_generation: string | number;
			readonly model_configuration_revision: string | number | null;
			readonly model_option_id: string | null;
			readonly reasoning_level: string | null;
			readonly status: string;
		}[]
	>`
		select execution_id, conversation_id, actor_id, session_generation,
			model_configuration_revision, model_option_id, reasoning_level, status
		from platform.conversation_executions
		where conversation_id = ${conversation.conversationId}
			and execution_id = ${targetExecutionId}
		limit 1
		for update
	`;
	const target = rows[0];
	if (!target) return state;
	const status = text(target.status);
	if (!activeExecutionStatuses.has(status) && !executionIsTerminal(status)) {
		unavailable();
	}
	const stops = await transaction<StopRow[]>`
		select execution_id, stop_request_id, status
		from platform.conversation_stops
		where execution_id = ${target.execution_id}
		limit 1
	`;
	const stop = stops[0];
	if (stop && stop.status !== "submitted" && stop.status !== "completed") {
		unavailable();
	}
	return {
		...state,
		targetExecution: {
			executionId: text(target.execution_id),
			conversationId: text(target.conversation_id),
			actorId: text(target.actor_id),
			sessionGeneration: safeInteger(target.session_generation, 1),
			modelConfigurationRevision:
				target.model_configuration_revision === null
					? null
					: safeInteger(target.model_configuration_revision, 1),
			modelOptionId:
				target.model_option_id === null ? null : text(target.model_option_id),
			reasoningLevel:
				target.reasoning_level === null ? null : text(target.reasoning_level),
			status: status as
				| "submitted"
				| "processing"
				| "unknown"
				| "completed"
				| "failed"
				| "cancelled",
		},
		existingStop: stop
			? {
					executionId: text(stop.execution_id),
					stopRequestId: text(stop.stop_request_id),
					status: stop.status as "submitted" | "completed",
				}
			: undefined,
	};
}

export async function requireCreateReplay(
	transaction: Transaction,
	result: ReturnType<typeof parseCreatedResult>,
	authority: ConversationExecutionAuthorityV1,
): Promise<void> {
	const rows = await transaction<ConversationRow[]>`
		select id, agent_id, actor_id, channel_id, status, session_generation,
			host_session_ref, authorization_revision, last_conversation_cursor,
			selected_model_option_id, selected_reasoning_level, created_at, updated_at
		from platform.conversations where id = ${result.conversationId} limit 1
	`;
	const conversation = rows[0] && conversationFromRow(rows[0]);
	if (
		!conversation ||
		result.agentId !== authority.agentId ||
		!matchesBinding(conversation, authority)
	) {
		unavailable();
	}
}

export async function requireMessageReplay(
	transaction: Transaction,
	result: ReturnType<typeof parseMessageResult>,
	conversationId: string,
	authority: ConversationExecutionAuthorityV1,
): Promise<void> {
	const rows = await transaction<
		{
			readonly message_id: string;
			readonly message_conversation_id: string;
			readonly message_actor_id: string;
			readonly execution_id: string;
			readonly execution_conversation_id: string;
			readonly execution_actor_id: string;
		}[]
	>`
		select message.message_id, message.conversation_id as message_conversation_id,
			message.actor_id as message_actor_id, execution.execution_id,
			execution.conversation_id as execution_conversation_id,
			execution.actor_id as execution_actor_id
		from platform.conversation_messages as message
		join platform.conversation_executions as execution
			on execution.execution_id = message.execution_id
		where message.message_id = ${result.messageId}
		limit 1
	`;
	const row = rows[0];
	if (
		!row ||
		row.message_conversation_id !== conversationId ||
		row.execution_conversation_id !== conversationId ||
		row.message_actor_id !== authority.actorId ||
		row.execution_actor_id !== authority.actorId ||
		row.execution_id !== result.executionId
	) {
		unavailable();
	}
}

export async function requireRegenerationReplay(
	transaction: Transaction,
	result: ReturnType<typeof parseRegenerationResult>,
	conversationId: string,
	authority: ConversationExecutionAuthorityV1,
): Promise<void> {
	const rows = await transaction<
		{
			readonly execution_id: string;
			readonly conversation_id: string;
			readonly actor_id: string;
		}[]
	>`
		select execution_id, conversation_id, actor_id
		from platform.conversation_executions
		where execution_id = ${result.executionId}
		limit 1
	`;
	const execution = rows[0];
	if (
		!execution ||
		execution.conversation_id !== conversationId ||
		execution.actor_id !== authority.actorId
	) {
		unavailable();
	}
}

export async function requireStopReplay(
	transaction: Transaction,
	result: ReturnType<typeof parseStopResult>,
	conversationId: string,
	authority: ConversationExecutionAuthorityV1,
): Promise<void> {
	const rows = await transaction<
		{
			readonly execution_id: string;
			readonly conversation_id: string;
			readonly actor_id: string;
			readonly status: string;
			readonly stop_request_id: string | null;
		}[]
	>`
		select execution.execution_id, execution.conversation_id, execution.actor_id,
			execution.status, stop.stop_request_id
		from platform.conversation_executions as execution
		left join platform.conversation_stops as stop
			on stop.execution_id = execution.execution_id
		where execution.execution_id = ${result.executionId}
		limit 1
	`;
	const execution = rows[0];
	if (
		!execution ||
		execution.conversation_id !== conversationId ||
		execution.actor_id !== authority.actorId ||
		(result.status === "submitted" && execution.stop_request_id === null) ||
		(result.status === "already_finished" &&
			!executionIsTerminal(execution.status))
	) {
		unavailable();
	}
}

export async function insertModelSelectionFallback(
	transaction: Transaction,
	fallback: ConversationModelSelectionFallbackWriteV1 | null,
): Promise<void> {
	if (!fallback) return;
	const timeline = fallback.timelineEvent;
	await transaction`
		insert into platform.conversation_events
			(event_id, conversation_id, execution_id, adapter_event_key, sequence,
			 conversation_cursor, event_type, event_payload, event_digest, source,
			 runtime_cursor, occurred_at)
		values
			(${timeline.eventId}, ${timeline.conversationId}, ${timeline.executionId},
			 ${`platform:${timeline.eventId}`}, ${timeline.sequence},
			 ${timeline.conversationCursor}, ${timeline.event.type},
			 ${transaction.json(timeline.event as unknown as JsonValue)},
			 ${createHash("sha256").update(JSON.stringify(timeline.event)).digest("hex")},
			 'platform', null, ${timeline.occurredAt})
	`;
	const updated = await transaction<{ execution_id: string }[]>`
		update platform.conversation_executions
		set last_event_sequence = ${timeline.sequence}, updated_at = now()
		where execution_id = ${timeline.executionId}
			and conversation_id = ${timeline.conversationId}
			and last_event_sequence = ${timeline.sequence - 1}
		returning execution_id
	`;
	if (updated.length !== 1) unavailable();
	await transaction`
		insert into platform.conversation_audit_events
			(id, conversation_id, execution_id, agent_id, actor_id, action, trace_id,
			 request_id, occurred_at, details)
		values
			(${randomUUID()}, ${fallback.auditEvent.conversationId},
			 ${fallback.auditEvent.executionId},
			 ${fallback.auditEvent.agentId}, ${fallback.auditEvent.actorId},
			 ${fallback.auditEvent.action}, ${fallback.auditEvent.traceId},
			 ${fallback.auditEvent.requestId}, ${fallback.auditEvent.occurredAt},
			 ${transaction.json({
					previousModelOptionId: fallback.previousModelOptionId,
					previousReasoningLevel: fallback.previousReasoningLevel,
					modelConfigurationRevision: fallback.modelConfigurationRevision,
					modelOptionId: fallback.modelOptionId,
					reasoningLevel: fallback.reasoningLevel,
				} as JsonValue)})
	`;
}
