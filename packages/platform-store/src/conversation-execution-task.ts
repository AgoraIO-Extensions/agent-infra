import { randomUUID } from "node:crypto";
import type {
	ConversationModelConfigurationV1,
	ConversationTaskAdmissionStateV1,
	ConversationTaskAdmissionTransactionPortV1,
	ConversationTaskSubmitResultV1,
} from "@agent-infra/platform-core";
import { decodeAgentConfigurationRecord } from "./agent-configuration-record.js";
import {
	type JsonValue,
	safeInteger,
	type Transaction,
	text,
	unavailable,
} from "./conversation-execution-common.js";
import {
	matchesBinding,
	parseAuthority,
} from "./conversation-execution-records.js";
import {
	completeIdempotency,
	lockConversation,
	readIdempotency,
	reserveIdempotency,
} from "./conversation-execution-sql.js";
import { insertTaskAuthorization } from "./task-authorization.js";

type SubmitRequest = Parameters<
	ConversationTaskAdmissionTransactionPortV1["submitTask"]
>[0];
type SubmitDecide = Parameters<
	ConversationTaskAdmissionTransactionPortV1["submitTask"]
>[1];

function replayResult(value: unknown): ConversationTaskSubmitResultV1 {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		Object.keys(value).length !== 5
	)
		unavailable();
	const row = value as Record<string, unknown>;
	if (row.schemaVersion !== 1 || row.status !== "accepted") unavailable();
	return {
		schemaVersion: 1,
		status: "accepted",
		conversationId: text(row.conversationId),
		executionId: text(row.executionId),
		messageId: text(row.messageId),
	};
}

async function readAgent(
	transaction: Transaction,
	agentId: string,
): Promise<
	Pick<ConversationTaskAdmissionStateV1, "agent" | "modelConfiguration"> & {
		readonly authorizationRevision: string | null;
	}
> {
	const [agent] = await transaction<
		{
			current_configuration_revision: string | number;
			authorization_revision: string | null;
		}[]
	>`
		select current_configuration_revision, authorization_revision from platform.agents
		where id = ${agentId} for share
	`;
	if (!agent)
		return {
			agent: null,
			modelConfiguration: null,
			authorizationRevision: null,
		};
	const [application] = await transaction<
		{
			status: string;
			desired_state: string | null;
			service_availability: string | null;
		}[]
	>`
		select status, desired_state, service_availability
		from platform.agent_applications where agent_id = ${agentId} for share
	`;
	const [configuration] = await transaction<{ configuration: unknown }[]>`
		select configuration from platform.agent_configuration_revisions
		where agent_id = ${agentId}
			and revision = ${agent.current_configuration_revision}
		for share
	`;
	let modelConfiguration: ConversationModelConfigurationV1 | null = null;
	if (configuration) {
		const record = decodeAgentConfigurationRecord(configuration.configuration);
		const model = record.modelConfiguration;
		if (
			record.agentId !== agentId ||
			record.revision !== safeInteger(agent.current_configuration_revision, 1)
		)
			unavailable();
		// Custom images need an explicit task-capability verification seam.
		if (record.source.kind === "standard" && model) {
			modelConfiguration = {
				configurationRevision: record.revision,
				options: model.options.map(({ optionId, reasoningLevels }) => ({
					optionId,
					reasoningLevels,
				})),
				defaultOptionId: model.defaultOptionId,
				defaultReasoningLevel: model.defaultReasoningLevel,
			};
		}
	}
	return {
		authorizationRevision: agent.authorization_revision,
		agent: application
			? {
					status: application.status,
					desiredState: application.desired_state,
					serviceAvailability: application.service_availability,
				}
			: null,
		modelConfiguration,
	};
}

async function requireReplay(
	transaction: Transaction,
	result: ConversationTaskSubmitResultV1,
	request: SubmitRequest,
): Promise<void> {
	const [row] = await transaction<
		{
			conversation_agent_id: string;
			conversation_actor_id: string;
			conversation_channel_id: string;
			execution_agent_id: string;
			execution_actor_id: string;
			execution_channel_id: string;
			message_actor_id: string;
		}[]
	>`
		select c.agent_id as conversation_agent_id, c.actor_id as conversation_actor_id,
			c.channel_id as conversation_channel_id, e.agent_id as execution_agent_id,
			e.actor_id as execution_actor_id, e.channel_id as execution_channel_id,
			m.actor_id as message_actor_id
		from platform.conversations c
		join platform.conversation_executions e on e.conversation_id = c.id
		join platform.conversation_messages m on m.execution_id = e.execution_id
		where c.id = ${result.conversationId} and e.execution_id = ${result.executionId}
			and m.message_id = ${result.messageId}
		limit 1
	`;
	const authority = request.authority;
	if (
		!row ||
		row.conversation_agent_id !== authority.agentId ||
		row.execution_agent_id !== authority.agentId ||
		row.conversation_actor_id !== authority.actorId ||
		row.execution_actor_id !== authority.actorId ||
		row.message_actor_id !== authority.actorId ||
		row.conversation_channel_id !== authority.channelId ||
		row.execution_channel_id !== authority.channelId
	)
		unavailable();
}

export async function submitConversationTask(
	transaction: Transaction,
	request: SubmitRequest,
	decide: SubmitDecide,
): ReturnType<ConversationTaskAdmissionTransactionPortV1["submitTask"]> {
	const authority = parseAuthority(request.authority);
	const principal = authority.taskBoundary?.principal;
	if (
		principal?.kind !== "user" ||
		principal.id !== authority.actorId ||
		request.command.agentId !== authority.agentId
	)
		return { outcome: "denied", reason: "conversation_unavailable" };
	const scope = {
		scopeType: "principal",
		scopeId: JSON.stringify([principal.kind, principal.id]),
		actorId: authority.actorId,
		commandType: "task.submit",
		key: text(request.command.idempotencyKey, 128),
	};
	// This lock also covers default-conversation retries before any Conversation exists.
	await transaction`select pg_advisory_xact_lock(pg_catalog.hashtextextended(${`task:principal:${scope.scopeId}`}, 0))`;
	const existing = await readIdempotency(transaction, scope);
	if (existing) {
		if (existing.request_digest !== request.requestDigest)
			return { outcome: "conflict", reason: "idempotency_conflict" };
		if (existing.status !== "completed") unavailable();
		const result = replayResult(existing.result);
		await requireReplay(transaction, result, request);
		return { outcome: "replayed", result };
	}
	// Different principals share one Agent waiting capacity and order.
	await transaction`select pg_advisory_xact_lock(pg_catalog.hashtextextended(${`task:agent:${authority.agentId}`}, 0))`;
	const agent = await readAgent(transaction, authority.agentId);
	if (agent.authorizationRevision !== authority.authorizationRevision)
		return { outcome: "denied", reason: "agent_unavailable" };
	const conversation = request.command.conversationId
		? await lockConversation(transaction, request.command.conversationId)
		: undefined;
	if (conversation && !matchesBinding(conversation, authority))
		return { outcome: "denied", reason: "conversation_unavailable" };
	const [queue] = await transaction<
		{ waiting_count: string; last_order: string | null }[]
	>`
		select count(*) filter (where status = 'waiting')::text as waiting_count,
			max(task_wait_order)::text as last_order
		from platform.conversation_executions where agent_id = ${authority.agentId}
	`;
	if (!queue) unavailable();
	const state: ConversationTaskAdmissionStateV1 = {
		...agent,
		conversation: conversation ?? null,
		waitingCount: safeInteger(queue.waiting_count, 0),
	};
	const decision = decide(state);
	if ("outcome" in decision) return decision;
	const plan = decision;
	if (
		(conversation && plan.conversationId !== conversation.conversationId) ||
		plan.createConversation !== !conversation ||
		plan.acceptedAt.getTime() >= plan.waitDeadline.getTime()
	)
		unavailable();
	const order = safeInteger(queue.last_order ?? "0", 0) + 1;
	if (!Number.isSafeInteger(order)) unavailable();
	const result: ConversationTaskSubmitResultV1 = {
		schemaVersion: 1,
		status: "accepted",
		conversationId: plan.conversationId,
		executionId: plan.executionId,
		messageId: plan.messageId,
	};
	const reservationId = await reserveIdempotency(transaction, {
		...scope,
		requestDigest: request.requestDigest,
		occurredAt: plan.acceptedAt,
	});
	if (!reservationId) unavailable();
	if (plan.createConversation) {
		await transaction`
			insert into platform.conversations
				(id, agent_id, actor_id, channel_id, status, session_generation,
				 host_session_ref, authorization_revision, last_conversation_cursor,
				 selected_model_option_id, selected_reasoning_level, created_at, updated_at)
			values (${plan.conversationId}, ${authority.agentId}, ${authority.actorId},
				${authority.channelId}, 'ready', 1, null, ${authority.authorizationRevision},
				0, null, null, ${plan.acceptedAt}, ${plan.acceptedAt})
		`;
	}
	await transaction`
		insert into platform.conversation_executions
			(execution_id, conversation_id, agent_id, actor_id, channel_id,
			 turn_id, status, task_wait_order, task_wait_deadline, session_generation,
			 delivery_fence, authorization_revision, model_configuration_revision,
			 model_option_id, reasoning_level, created_at, updated_at)
		values (${plan.executionId}, ${plan.conversationId}, ${authority.agentId},
			${authority.actorId}, ${authority.channelId}, ${plan.turnId}, 'waiting',
			${order}, ${plan.waitDeadline}, ${conversation?.sessionGeneration ?? 1}, 0,
			${authority.authorizationRevision}, ${plan.modelConfigurationRevision},
			${plan.modelOptionId}, ${plan.reasoningLevel}, ${plan.acceptedAt}, ${plan.acceptedAt})
	`;
	await insertTaskAuthorization(transaction, {
		executionId: plan.executionId,
		boundary: authority.taskBoundary,
		traceId: request.command.traceId,
		requestId: request.command.requestId,
	});
	await transaction`
		insert into platform.conversation_messages
			(message_id, conversation_id, actor_id, role, text, execution_id,
			 status, created_at, updated_at)
		values (${plan.messageId}, ${plan.conversationId}, ${authority.actorId},
			'user', ${request.command.text}, ${plan.executionId}, 'submitted',
			${plan.acceptedAt}, ${plan.acceptedAt})
	`;
	await transaction`
		insert into platform.outbox_items
			(id, scope_type, scope_id, operation, payload, trace_id, request_id,
			 available_at, created_at, updated_at)
		values (${`conversation:turn:${plan.executionId}`}, 'conversation',
			${plan.conversationId}, 'conversation.turn.submit.v1',
			${transaction.json({
				schemaVersion: 1,
				conversationId: plan.conversationId,
				executionId: plan.executionId,
				messageId: plan.messageId,
				turnId: plan.turnId,
				sessionGeneration: conversation?.sessionGeneration ?? 1,
				modelConfigurationRevision: plan.modelConfigurationRevision,
				modelOptionId: plan.modelOptionId,
				reasoningLevel: plan.reasoningLevel,
			} as JsonValue)},
			${request.command.traceId}, ${request.command.requestId},
			'infinity'::timestamptz, ${plan.acceptedAt}, ${plan.acceptedAt})
	`;
	await transaction`
		insert into platform.conversation_audit_events
			(id, conversation_id, execution_id, agent_id, actor_id, action,
			 trace_id, request_id, occurred_at)
		values (${randomUUID()}, ${plan.conversationId}, ${plan.executionId},
			${authority.agentId}, ${authority.actorId}, 'conversation.task.accepted',
			${request.command.traceId}, ${request.command.requestId}, ${plan.acceptedAt})
	`;
	await completeIdempotency(
		transaction,
		reservationId,
		result,
		plan.acceptedAt,
	);
	return { outcome: "accepted", result };
}
