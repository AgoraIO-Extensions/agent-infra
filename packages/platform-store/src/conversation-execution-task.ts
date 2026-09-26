import { createHash, randomUUID } from "node:crypto";
import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import type {
	ConversationTaskAdmissionStateV1,
	ConversationTaskAdmissionTransactionPortV1,
	ConversationTaskSubmitDecisionV1,
	ConversationTaskSubmitResultV1,
} from "@agent-infra/platform-core";
import {
	isTaskPrincipalChannelV1,
	parseTaskApiAuditInputV1,
} from "@agent-infra/platform-core";
import {
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
	insertModelSelectionFallback,
	lockAgentConfiguration,
	lockConversation,
	readIdempotency,
	reserveIdempotency,
} from "./conversation-execution-sql.js";
import { writeTaskApiAudit } from "./task-api-audit.js";
import { insertTaskAuthorization } from "./task-authorization.js";
import { decodePersistedWorkloadStateV1 } from "./workload-reconciliation.js";

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
	Pick<
		ConversationTaskAdmissionStateV1,
		"agent" | "modelConfiguration" | "sourceKind" | "customCapability"
	> & {
		readonly authorizationRevision: string | null;
	}
> {
	const agent = await lockAgentConfiguration(transaction, agentId);
	if (!agent)
		return {
			agent: null,
			modelConfiguration: null,
			sourceKind: null,
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
	let customCapability: ConversationTaskAdmissionStateV1["customCapability"] =
		null;
	if (agent.configuration?.source.kind === "custom") {
		const [row] = await transaction<{ state: unknown }[]>`
			select state from platform.workload_reconciliations
			where agent_id = ${agentId} for share
		`;
		const decoded = decodePersistedWorkloadStateV1(row?.state, agentId);
		if (decoded && !decoded.legacy && decoded.state.verified) {
			const deployment = validateAgentWorkloadDesiredV1(
				decoded.state.verified.deployment,
			);
			customCapability = {
				configuration: agent.configuration,
				verified: decoded.state.verified,
				deployment: {
					agentId: deployment.agentId,
					configurationRevision: deployment.configRevision,
					interactionMode: deployment.runtimeManifest.interactionMode,
					imageDigest: deployment.imageDigest,
					resourceProfileRef: deployment.resourceProfileRef,
				},
			};
		}
	}
	return {
		authorizationRevision: agent.authorizationRevision,
		agent: application
			? {
					status: application.status,
					desiredState: application.desired_state,
					serviceAvailability: application.service_availability,
				}
			: null,
		modelConfiguration: agent.modelConfiguration ?? null,
		sourceKind: agent.sourceKind ?? null,
		customCapability,
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
		!principal ||
		!isTaskPrincipalChannelV1(principal, authority.channelId) ||
		principal.id !== authority.actorId ||
		request.command.agentId !== authority.agentId
	)
		return { outcome: "denied", reason: "conversation_unavailable" };
	async function recordResult(
		decision: ConversationTaskSubmitDecisionV1,
		occurredAt?: Date,
	): Promise<ConversationTaskSubmitDecisionV1> {
		const succeeded =
			decision.outcome === "accepted" || decision.outcome === "replayed";
		const input = parseTaskApiAuditInputV1({
			schemaVersion: 1,
			auditId: randomUUID(),
			operation: "submit",
			phase: "submit.result",
			result: succeeded ? "succeeded" : "rejected",
			reason:
				"reason" in decision
					? decision.reason
					: decision.outcome === "capacity_full"
						? "capacity_full"
						: decision.outcome === "accepted"
							? "task_accepted"
							: "task_replayed",
			principal,
			target: succeeded
				? {
						kind: "execution",
						agentId: authority.agentId,
						conversationId: decision.result.conversationId,
						executionId: decision.result.executionId,
					}
				: { kind: "agent", agentId: authority.agentId },
			requestId: request.command.requestId,
			traceId: request.command.traceId,
			...(occurredAt ? { occurredAt } : {}),
		});
		await writeTaskApiAudit(transaction, {
			...input,
			action: "task.api.submit.result",
		});
		return decision;
	}
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
			return recordResult({
				outcome: "conflict",
				reason: "idempotency_conflict",
			});
		if (existing.status !== "completed") unavailable();
		const result = replayResult(existing.result);
		await requireReplay(transaction, result, request);
		return recordResult({ outcome: "replayed", result });
	}
	// Different principals share one Agent waiting capacity and order.
	await transaction`select pg_advisory_xact_lock(pg_catalog.hashtextextended(${`task:agent:${authority.agentId}`}, 0))`;
	const agent = await readAgent(transaction, authority.agentId);
	if (agent.authorizationRevision !== authority.authorizationRevision)
		return recordResult({ outcome: "denied", reason: "agent_unavailable" });
	const conversation = request.command.conversationId
		? await lockConversation(transaction, request.command.conversationId)
		: undefined;
	if (conversation && !matchesBinding(conversation, authority))
		return recordResult({
			outcome: "denied",
			reason: "conversation_unavailable",
		});
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
		lastWaitOrder: safeInteger(queue.last_order ?? "0", 0),
	};
	const decision = decide(state);
	if ("outcome" in decision) return recordResult(decision);
	const plan = decision;
	const statusEvent = plan.statusEvent;
	const finalCursor =
		plan.modelSelectionFallback?.timelineEvent.conversationCursor ??
		statusEvent.conversationCursor;
	if (
		(conversation && plan.conversationId !== conversation.conversationId) ||
		plan.createConversation !== !conversation ||
		plan.acceptedAt.getTime() >= plan.waitDeadline.getTime() ||
		plan.waitOrder !== state.lastWaitOrder + 1 ||
		plan.outbox.availability !== "after_dispatch" ||
		plan.outbox.id !== `conversation:turn:${plan.executionId}` ||
		plan.outbox.payload.conversationId !== plan.conversationId ||
		plan.outbox.payload.executionId !== plan.executionId ||
		plan.outbox.payload.messageId !== plan.messageId ||
		plan.outbox.payload.turnId !== plan.turnId ||
		plan.outbox.payload.sessionGeneration !==
			(conversation?.sessionGeneration ?? 1) ||
		statusEvent.conversationCursor !==
			(conversation?.lastConversationCursor ?? 0) + 1 ||
		(plan.modelSelectionFallback !== null &&
			plan.modelSelectionFallback.timelineEvent.conversationCursor !==
				statusEvent.conversationCursor + 1)
	)
		unavailable();
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
				${authority.channelId}, ${plan.conversationStatus}, 1, null, ${authority.authorizationRevision},
				${finalCursor}, ${plan.modelOptionId}, ${plan.reasoningLevel},
				${plan.acceptedAt}, ${plan.acceptedAt})
		`;
	} else {
		await transaction`
			update platform.conversations
			set last_conversation_cursor = ${finalCursor},
				selected_model_option_id = ${plan.modelOptionId},
				selected_reasoning_level = ${plan.reasoningLevel},
				updated_at = ${plan.acceptedAt}
			where id = ${plan.conversationId}
		`;
	}
	await transaction`
		insert into platform.conversation_executions
			(execution_id, conversation_id, agent_id, actor_id, channel_id,
			 turn_id, status, task_wait_order, task_wait_deadline, session_generation,
			 delivery_fence, authorization_revision, model_configuration_revision,
			 model_option_id, reasoning_level, last_event_sequence, created_at, updated_at)
		values (${plan.executionId}, ${plan.conversationId}, ${authority.agentId},
			${authority.actorId}, ${authority.channelId}, ${plan.turnId}, ${plan.executionStatus},
			${plan.waitOrder}, ${plan.waitDeadline}, ${plan.outbox.payload.sessionGeneration}, 0,
			${authority.authorizationRevision}, ${plan.modelConfigurationRevision},
			${plan.modelOptionId}, ${plan.reasoningLevel}, ${statusEvent.sequence},
			${plan.acceptedAt}, ${plan.acceptedAt})
	`;
	await transaction`
		insert into platform.conversation_events
			(event_id, conversation_id, execution_id, adapter_event_key, sequence,
			 conversation_cursor, event_type, event_payload, event_digest, source,
			 runtime_cursor, occurred_at)
		values (${statusEvent.eventId}, ${plan.conversationId}, ${plan.executionId},
			${`platform:${statusEvent.eventId}`}, ${statusEvent.sequence},
			${statusEvent.conversationCursor}, ${statusEvent.event.type},
			${transaction.json(statusEvent.event)},
			${createHash("sha256").update(JSON.stringify(statusEvent.event)).digest("hex")},
			'platform', null, ${plan.acceptedAt})
	`;
	await insertModelSelectionFallback(transaction, plan.modelSelectionFallback);
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
			'user', ${request.command.text}, ${plan.executionId}, ${plan.messageStatus},
			${plan.acceptedAt}, ${plan.acceptedAt})
	`;
	await transaction`
		insert into platform.outbox_items
			(id, scope_type, scope_id, operation, payload, trace_id, request_id,
			 available_at, created_at, updated_at)
		values (${plan.outbox.id}, 'conversation',
			${plan.conversationId}, ${plan.outbox.operation},
			${transaction.json(plan.outbox.payload)},
			${request.command.traceId}, ${request.command.requestId},
			'infinity'::timestamptz, ${plan.acceptedAt}, ${plan.acceptedAt})
	`;
	await transaction`
		insert into platform.conversation_audit_events
			(id, conversation_id, execution_id, agent_id, actor_id, action,
			 trace_id, request_id, occurred_at)
		values (${randomUUID()}, ${plan.conversationId}, ${plan.executionId},
			${authority.agentId}, ${authority.actorId}, ${plan.auditAction},
			${request.command.traceId}, ${request.command.requestId}, ${plan.acceptedAt})
	`;
	await completeIdempotency(
		transaction,
		reservationId,
		result,
		plan.acceptedAt,
	);
	return recordResult({ outcome: "accepted", result }, plan.acceptedAt);
}
