import { randomUUID } from "node:crypto";
import type { ConversationTaskAdmissionTransactionPortV1 } from "@agent-infra/platform-core";
import {
	bindInputFileV1,
	type ConversationCommandDecisionV1,
	ConversationExecutionError,
	type ConversationExecutionTransactionPortV1,
	type ConversationMetadataRecoveryStateV1,
	type ConversationModelSelectionDecisionV1,
	type ConversationStateDecisionV1,
	type ConversationStopDecisionV1,
	type CreateConversationDecisionV1,
	type FileRecordV1,
	parseConversationOperationEventV2,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import {
	lockConversation as lockDispatchConversation,
	lockExecution as lockDispatchExecution,
	lockOutbox as lockDispatchOutbox,
} from "./conversation-dispatch-sql.js";
import { finishWaitingTask } from "./conversation-dispatch-task.js";
import {
	type ConversationQueryProject,
	type ConversationQueryRequest,
	type CreateDecide,
	type CreateRequest,
	type JsonValue,
	type MessageDecide,
	type MessageRequest,
	type ModelSelectionDecide,
	type ModelSelectionRequest,
	type RegenerationDecide,
	type RegenerationRequest,
	type StopDecide,
	type StopRequest,
	safeInteger,
	type Transaction,
	text,
	unavailable,
} from "./conversation-execution-common.js";
import {
	validateCreatePlan,
	validateMessagePlan,
	validateModelSelectionPlan,
	validateRegenerationPlan,
	validateStopNoop,
	validateStopPlan,
} from "./conversation-execution-plans.js";
import {
	matchesBinding,
	parseAuthority,
	parseCreatedResult,
	parseMessageResult,
	parseModelSelectionResult,
	parseRegenerationResult,
	parseStopResult,
} from "./conversation-execution-records.js";
import {
	completeIdempotency,
	createIdempotencyScopeId,
	insertModelSelectionFallback,
	isMessagePlan,
	isModelSelectionPlan,
	isRegenerationPlan,
	isStopPlan,
	lockConversation,
	lockConversationForRead,
	outboxId,
	readIdempotency,
	readMessageState,
	readModelSelectionState,
	readRegenerationState,
	readStopState,
	requireCreateReplay,
	requireMessageReplay,
	requireRegenerationReplay,
	requireStopReplay,
	reserveIdempotency,
} from "./conversation-execution-sql.js";
import { submitConversationTask } from "./conversation-execution-task.js";
import { platformDatabaseUrlFromEnvironment } from "./migrate.js";
import {
	insertTaskAuthorization,
	requireCurrentTaskApiAccess,
} from "./task-authorization.js";

export interface PostgresConversationExecutionOptionsV1 {
	readonly databaseUrl: string;
}

export class PostgresConversationExecutionTransactionV1
	implements
		ConversationExecutionTransactionPortV1,
		ConversationTaskAdmissionTransactionPortV1
{
	readonly #client: ReturnType<typeof postgres> | undefined;
	readonly #existingTransaction: Transaction | undefined;

	constructor(
		options:
			| PostgresConversationExecutionOptionsV1
			| { readonly transaction: Transaction },
	) {
		if ("transaction" in options) {
			this.#existingTransaction = options.transaction;
			return;
		}
		try {
			this.#client = postgres(
				platformDatabaseUrlFromEnvironment({
					PLATFORM_DATABASE_URL: options.databaseUrl,
				}),
				{ max: 10 },
			);
		} catch {
			unavailable();
		}
	}

	async submitTask(
		request: Parameters<
			ConversationTaskAdmissionTransactionPortV1["submitTask"]
		>[0],
		decide: Parameters<
			ConversationTaskAdmissionTransactionPortV1["submitTask"]
		>[1],
	) {
		return this.#transaction((transaction) =>
			submitConversationTask(transaction, request, decide),
		);
	}

	async requestMetadataRecovery(
		request: Parameters<
			ConversationExecutionTransactionPortV1["requestMetadataRecovery"]
		>[0],
		decide: Parameters<
			ConversationExecutionTransactionPortV1["requestMetadataRecovery"]
		>[1],
	) {
		return this.#transaction(async (transaction) => {
			const authority = parseAuthority(request.authority);
			const conversation = await lockConversation(
				transaction,
				text(request.query.conversationId),
			);
			if (!conversation) return decide({ conversation, candidates: [] }).result;
			// Lock order matches dispatch: Conversation, original outbox, Execution.
			const candidates = await transaction<
				{
					id: string;
					payload: Record<string, unknown>;
					status: string;
					execution_id: string;
					authorization_revision: string;
				}[]
			>`
				select o.id, o.payload, o.status, e.execution_id, e.authorization_revision
				from platform.outbox_items o join platform.conversation_executions e on e.execution_id = o.payload->>'executionId'
				where o.scope_type = 'conversation' and o.scope_id = ${conversation.conversationId}
					and o.operation in ('conversation.turn.submit.v1', 'conversation.turn.regenerate.v1')
					and o.id in ('conversation:turn:' || e.execution_id, 'conversation:regenerate:' || e.execution_id)
					and e.conversation_id = ${conversation.conversationId} and e.agent_id = ${authority.agentId}
					and e.actor_id = ${authority.actorId} and e.channel_id = ${authority.channelId}
					and e.session_generation = ${conversation.sessionGeneration}
					and o.payload->>'sessionGeneration' = ${String(conversation.sessionGeneration)}
					and o.payload->>'turnId' = e.turn_id and e.delivery_fence > 0 and e.last_runtime_cursor is not null
					and e.status in ('completed', 'failed', 'cancelled')
					and (o.status in ('succeeded', 'failed') or o.payload ? 'metadataRecovery')
					and (${request.query.executionId ?? null}::text is null or e.execution_id = ${request.query.executionId ?? null})
					and exists (select 1 from platform.conversation_events ev where ev.execution_id = e.execution_id
						and ev.source = 'runtime' and ev.event_type = 'execution.operation'
						and ev.event_payload->'fact'->>'kind' = 'tool'
						and ev.event_payload->'fact'->'connection'->>'verification' = 'unverified'
						and not exists (select 1 from platform.conversation_events newer where newer.execution_id = e.execution_id
							and newer.event_type = 'execution.operation' and newer.sequence > ev.sequence
							and newer.event_payload->'fact'->>'operationRef' = ev.event_payload->'fact'->>'operationRef'
							and newer.event_payload->'fact'->>'attemptRef' = ev.event_payload->'fact'->>'attemptRef'))
				order by (o.payload->'metadataRecovery'->>'requestedAt')::bigint nulls first, o.id limit 16
				for update of o
			`;
			const recoveryCandidates: ConversationMetadataRecoveryStateV1["candidates"][number][] =
				[];
			const originalPayloads = new Map<string, unknown>();
			for (const candidate of candidates) {
				const [execution] = await transaction<
					{
						execution_id: string;
						conversation_id: string;
						agent_id: string;
						actor_id: string;
						channel_id: string;
						turn_id: string;
						session_generation: number | string;
						delivery_fence: number | string;
						last_runtime_cursor: string | null;
						authorization_revision: string;
						status: string;
					}[]
				>`select execution_id, conversation_id, agent_id, actor_id, channel_id, turn_id, session_generation,
					delivery_fence, last_runtime_cursor, authorization_revision, status from platform.conversation_executions
					where execution_id = ${candidate.execution_id} for update`;
				if (!execution) continue;
				const origins = await transaction<
					{ id: string; operation: string; status: string; payload: unknown }[]
				>`
					select id, operation, status, payload from platform.outbox_items
					where id in (${`conversation:turn:${candidate.execution_id}`}, ${`conversation:regenerate:${candidate.execution_id}`})`;
				for (const origin of origins)
					originalPayloads.set(origin.id, origin.payload);
				const [record] = await transaction<
					{ boundary: unknown }[]
				>`select boundary from platform.task_authorization_records where execution_id = ${candidate.execution_id}`;
				const facts = await transaction<{ event_payload: unknown }[]>`
					select distinct on (event_payload->'fact'->>'operationRef', event_payload->'fact'->>'attemptRef') event_payload
					from platform.conversation_events where execution_id = ${candidate.execution_id} and source = 'runtime'
						and event_type = 'execution.operation' and event_payload->'fact'->>'kind' = 'tool'
					order by event_payload->'fact'->>'operationRef', event_payload->'fact'->>'attemptRef', sequence desc`;
				recoveryCandidates.push({
					execution: {
						executionId: execution.execution_id,
						conversationId: execution.conversation_id,
						agentId: execution.agent_id,
						actorId: execution.actor_id,
						channelId: execution.channel_id,
						turnId: execution.turn_id,
						sessionGeneration: safeInteger(execution.session_generation, 1),
						deliveryFence: safeInteger(execution.delivery_fence, 0),
						runtimeCursor: execution.last_runtime_cursor,
						authorizationRevision: execution.authorization_revision,
						status: execution.status,
					},
					originalOutboxes: origins.map((origin) => ({
						itemId: origin.id,
						operation: origin.operation,
						status: origin.status,
						payload: origin.payload,
					})),
					boundary: record?.boundary ?? null,
					latestToolFacts: facts.map(
						(row) => parseConversationOperationEventV2(row.event_payload).fact,
					),
				});
			}
			const plan = decide({ conversation, candidates: recoveryCandidates });
			for (const update of plan.updates) {
				const payload = originalPayloads.get(update.itemId);
				if (!payload || typeof payload !== "object" || Array.isArray(payload))
					unavailable();
				await transaction`update platform.outbox_items set status = 'pending', available_at = clock_timestamp(), lease_owner = null,
					lease_expires_at = null, payload = ${transaction.json({ ...payload, metadataRecovery: { ...update.metadataRecovery } })}, updated_at = clock_timestamp()
					where id = ${update.itemId}`;
			}
			return plan.result;
		});
	}

	async readConversation(
		request: ConversationQueryRequest,
		project: ConversationQueryProject,
	): Promise<ConversationStateDecisionV1> {
		return this.#transaction(async (transaction) => {
			const authority = parseAuthority(request.authority);
			await transaction`select id from platform.agents where id = ${authority.agentId} for share`;
			const conversation = await lockConversationForRead(
				transaction,
				text(request.query.conversationId),
			);
			if (!conversation || !matchesBinding(conversation, authority)) {
				return { outcome: "denied" };
			}
			const selectionState = await readModelSelectionState(
				transaction,
				conversation,
			);
			const { currentAuthorizationRevision, ...state } = selectionState;
			if (
				currentAuthorizationRevision !== undefined &&
				currentAuthorizationRevision !== authority.authorizationRevision
			) {
				return { outcome: "denied" };
			}
			return project(state);
		});
	}

	async createConversation(
		request: CreateRequest,
		decide: CreateDecide,
	): Promise<CreateConversationDecisionV1> {
		return this.#transaction(async (transaction) => {
			const authority = parseAuthority(request.authority);
			if (request.command.agentId !== authority.agentId) {
				return { outcome: "denied" };
			}
			const scope = {
				scopeType: "agent",
				scopeId: createIdempotencyScopeId(
					authority.agentId,
					authority.channelId,
				),
				actorId: authority.actorId,
				commandType: "conversation.create",
				key: text(request.command.idempotencyKey, 128),
			};
			const existing = await readIdempotency(transaction, scope);
			if (existing) {
				if (existing.request_digest !== request.requestDigest) {
					return { outcome: "conflict", reason: "idempotency_conflict" };
				}
				if (existing.status !== "completed") unavailable();
				const result = parseCreatedResult(existing.result);
				await requireCreateReplay(transaction, result, authority);
				return { outcome: "replayed", result };
			}
			const plan = validateCreatePlan(decide(), request);
			const occurredAt = plan.conversation.createdAt;
			const reservationId = await reserveIdempotency(transaction, {
				...scope,
				requestDigest: request.requestDigest,
				occurredAt,
			});
			if (!reservationId) {
				const raced = await readIdempotency(transaction, scope);
				if (!raced) unavailable();
				if (raced.request_digest !== request.requestDigest) {
					return { outcome: "conflict", reason: "idempotency_conflict" };
				}
				if (raced.status !== "completed") unavailable();
				const result = parseCreatedResult(raced.result);
				await requireCreateReplay(transaction, result, authority);
				return { outcome: "replayed", result };
			}
			await transaction`
					insert into platform.conversations
						(id, agent_id, actor_id, channel_id, status, session_generation,
						 host_session_ref, authorization_revision, last_conversation_cursor,
						 selected_model_option_id, selected_reasoning_level,
						 created_at, updated_at)
				values
					(${plan.conversation.conversationId}, ${plan.conversation.agentId},
					 ${plan.conversation.actorId}, ${plan.conversation.channelId},
					 ${plan.conversation.status}, ${plan.conversation.sessionGeneration},
					 ${plan.conversation.hostSessionRef},
						 ${plan.conversation.authorizationRevision},
						 ${plan.conversation.lastConversationCursor},
						 ${plan.conversation.selectedModelOptionId},
						 ${plan.conversation.selectedReasoningLevel}, ${occurredAt}, ${occurredAt})
			`;
			await completeIdempotency(
				transaction,
				reservationId,
				plan.result,
				occurredAt,
			);
			return { outcome: "accepted", result: plan.result };
		});
	}

	async executeMessage(
		request: MessageRequest,
		decide: MessageDecide,
	): Promise<ConversationCommandDecisionV1> {
		return this.#transaction(async (transaction) => {
			const authority = parseAuthority(request.authority);
			await transaction`select id from platform.agents where id = ${authority.agentId} for share`;
			const conversation = await lockConversation(
				transaction,
				text(request.command.conversationId),
			);
			if (!conversation || !matchesBinding(conversation, authority)) {
				return { outcome: "denied" };
			}
			const scope = {
				scopeType: "conversation",
				scopeId: conversation.conversationId,
				actorId: authority.actorId,
				commandType: "message",
				key: text(request.command.idempotencyKey, 128),
			};
			const existing = await readIdempotency(transaction, scope);
			if (existing) {
				if (existing.request_digest !== request.requestDigest) {
					return { outcome: "conflict", reason: "idempotency_conflict" };
				}
				if (existing.status !== "completed") unavailable();
				const result = parseMessageResult(existing.result);
				await requireMessageReplay(
					transaction,
					result,
					conversation.conversationId,
					authority,
				);
				return { outcome: "replayed", result };
			}
			const state = await readMessageState(transaction, conversation);
			const decision = decide(state);
			if (!isMessagePlan(decision)) {
				return decision;
			}
			const plan = validateMessagePlan(decision, request, state);
			const reservationId = await reserveIdempotency(transaction, {
				...scope,
				requestDigest: request.requestDigest,
				occurredAt: plan.message.createdAt,
			});
			if (!reservationId) unavailable();
			const updated = await transaction<{ id: string }[]>`
				update platform.conversations
				set status = ${plan.conversation.status},
					authorization_revision = ${plan.conversation.authorizationRevision},
					last_conversation_cursor = ${plan.conversation.lastConversationCursor},
					selected_model_option_id = ${plan.conversation.selectedModelOptionId},
					selected_reasoning_level = ${plan.conversation.selectedReasoningLevel},
					updated_at = ${plan.message.createdAt}
				where id = ${conversation.conversationId}
				returning id
			`;
			if (updated.length !== 1) unavailable();
			if (plan.execution) {
				await transaction`
					insert into platform.conversation_executions
						(execution_id, conversation_id, agent_id, actor_id, channel_id,
						 turn_id, status, session_generation, delivery_fence,
						 authorization_revision, model_configuration_revision,
						 model_option_id, reasoning_level, created_at, updated_at)
					values
						(${plan.execution.executionId}, ${plan.execution.conversationId},
						 ${plan.execution.agentId}, ${plan.execution.actorId},
						 ${plan.execution.channelId}, ${plan.execution.turnId},
						 ${plan.execution.status}, ${plan.execution.sessionGeneration},
						 ${plan.execution.deliveryFence},
						 ${plan.execution.authorizationRevision},
						 ${plan.execution.modelConfigurationRevision},
						 ${plan.execution.modelOptionId}, ${plan.execution.reasoningLevel},
						 ${plan.execution.createdAt},
						 ${plan.execution.createdAt})
				`;
				await insertTaskAuthorization(transaction, {
					executionId: plan.execution.executionId,
					boundary: authority.taskBoundary,
					traceId: request.command.traceId,
					requestId: request.command.requestId,
				});
			}
			for (const fileId of request.command.attachments ?? []) {
				const [row] = await transaction<{ record: FileRecordV1 }[]>`
                    select record from platform.files where file_id = ${fileId} and conversation_id = ${conversation.conversationId}
                `;
				const file = bindInputFileV1(
					row?.record ?? null,
					{
						actorId: conversation.actorId,
						agentId: conversation.agentId,
						channelId: conversation.channelId,
						conversationId: conversation.conversationId,
					},
					{
						messageId: plan.message.messageId,
						executionId: plan.message.executionId,
						sessionGeneration: plan.conversation.sessionGeneration,
					},
					plan.message.createdAt,
				);
				await transaction`update platform.files set record = ${transaction.json(file as unknown as JsonValue)}, updated_at = ${plan.message.createdAt} where file_id = ${fileId}`;
			}
			await transaction`
				insert into platform.conversation_messages
					(message_id, conversation_id, actor_id, role, text, execution_id,
					 status, created_at, updated_at)
				values
					(${plan.message.messageId}, ${plan.message.conversationId},
					 ${plan.message.actorId}, 'user', ${plan.message.text},
					 ${plan.message.executionId}, ${plan.message.status},
					 ${plan.message.createdAt}, ${plan.message.createdAt})
			`;
			await transaction`
				insert into platform.outbox_items
					(id, scope_type, scope_id, operation, payload, trace_id, request_id,
					 available_at, created_at, updated_at)
				values
					(${outboxId(
						plan.outboxIntent.operation,
						plan.outboxIntent.messageId,
						plan.outboxIntent.executionId,
					)}, 'conversation', ${plan.outboxIntent.conversationId},
					 ${plan.outboxIntent.operation}, ${transaction.json({
							schemaVersion: 1,
							conversationId: plan.outboxIntent.conversationId,
							executionId: plan.outboxIntent.executionId,
							messageId: plan.outboxIntent.messageId,
							turnId: plan.outboxIntent.turnId,
							sessionGeneration: plan.outboxIntent.sessionGeneration,
							modelConfigurationRevision:
								plan.outboxIntent.modelConfigurationRevision,
							modelOptionId: plan.outboxIntent.modelOptionId,
							reasoningLevel: plan.outboxIntent.reasoningLevel,
						} as JsonValue)}, ${plan.outboxIntent.traceId},
					 ${plan.outboxIntent.requestId}, ${plan.outboxIntent.occurredAt},
					 ${plan.outboxIntent.occurredAt}, ${plan.outboxIntent.occurredAt})
			`;
			await transaction`
				insert into platform.conversation_audit_events
					(id, conversation_id, execution_id, agent_id, actor_id, action, trace_id,
					 request_id, occurred_at)
				values
					(${randomUUID()}, ${plan.auditEvent.conversationId},
					 ${plan.auditEvent.executionId}, ${plan.auditEvent.agentId},
					 ${plan.auditEvent.actorId}, ${plan.auditEvent.action},
					 ${plan.auditEvent.traceId}, ${plan.auditEvent.requestId},
					 ${plan.auditEvent.occurredAt})
			`;
			await insertModelSelectionFallback(
				transaction,
				plan.modelSelectionFallback,
			);
			await completeIdempotency(
				transaction,
				reservationId,
				plan.result,
				plan.message.createdAt,
			);
			return { outcome: "accepted", result: plan.result };
		});
	}

	async executeModelSelection(
		request: ModelSelectionRequest,
		decide: ModelSelectionDecide,
	): Promise<ConversationModelSelectionDecisionV1> {
		return this.#transaction(async (transaction) => {
			const authority = parseAuthority(request.authority);
			await transaction`select id from platform.agents where id = ${authority.agentId} for share`;
			const conversation = await lockConversation(
				transaction,
				text(request.command.conversationId),
			);
			if (!conversation || !matchesBinding(conversation, authority)) {
				return { outcome: "denied" };
			}
			const selectionState = await readModelSelectionState(
				transaction,
				conversation,
			);
			const { currentAuthorizationRevision, ...state } = selectionState;
			if (currentAuthorizationRevision !== authority.authorizationRevision) {
				return { outcome: "denied" };
			}
			const scope = {
				scopeType: "conversation",
				scopeId: conversation.conversationId,
				actorId: authority.actorId,
				commandType: "model.select",
				key: text(request.command.idempotencyKey, 128),
			};
			const existing = await readIdempotency(transaction, scope);
			if (existing) {
				if (existing.request_digest !== request.requestDigest) {
					return { outcome: "conflict", reason: "idempotency_conflict" };
				}
				if (existing.status !== "completed") unavailable();
				const result = parseModelSelectionResult(existing.result);
				if (result.conversationId !== conversation.conversationId)
					unavailable();
				return { outcome: "replayed", result };
			}
			const decision = decide(state);
			if (!isModelSelectionPlan(decision)) return decision;
			const plan = validateModelSelectionPlan(decision, request, state);
			const reservationId = await reserveIdempotency(transaction, {
				...scope,
				requestDigest: request.requestDigest,
				occurredAt: plan.auditEvent.occurredAt,
			});
			if (!reservationId) unavailable();
			const updated = await transaction<{ id: string }[]>`
				update platform.conversations
				set authorization_revision = ${plan.conversation.authorizationRevision},
					selected_model_option_id = ${plan.conversation.selectedModelOptionId},
					selected_reasoning_level = ${plan.conversation.selectedReasoningLevel},
					updated_at = ${plan.auditEvent.occurredAt}
				where id = ${conversation.conversationId}
				returning id
			`;
			if (updated.length !== 1) unavailable();
			await transaction`
				insert into platform.conversation_audit_events
					(id, conversation_id, execution_id, agent_id, actor_id, action, trace_id,
					 request_id, occurred_at, details)
				values
					(${randomUUID()}, ${plan.auditEvent.conversationId}, null,
					 ${plan.auditEvent.agentId}, ${plan.auditEvent.actorId},
					 ${plan.auditEvent.action}, ${plan.auditEvent.traceId},
					 ${plan.auditEvent.requestId}, ${plan.auditEvent.occurredAt},
					 ${transaction.json({
							modelConfigurationRevision:
								plan.auditEvent.modelConfigurationRevision,
							modelOptionId: plan.auditEvent.modelOptionId,
							reasoningLevel: plan.auditEvent.reasoningLevel,
						} as JsonValue)})
			`;
			await completeIdempotency(
				transaction,
				reservationId,
				plan.result,
				plan.auditEvent.occurredAt,
			);
			return { outcome: "accepted", result: plan.result };
		});
	}

	async executeRegeneration(
		request: RegenerationRequest,
		decide: RegenerationDecide,
	): Promise<ConversationCommandDecisionV1> {
		return this.#transaction(async (transaction) => {
			const authority = parseAuthority(request.authority);
			await transaction`select id from platform.agents where id = ${authority.agentId} for share`;
			const conversation = await lockConversation(
				transaction,
				text(request.command.conversationId),
			);
			if (!conversation || !matchesBinding(conversation, authority)) {
				return { outcome: "denied" };
			}
			const scope = {
				scopeType: "conversation",
				scopeId: conversation.conversationId,
				actorId: authority.actorId,
				commandType: "regenerate",
				key: text(request.command.idempotencyKey, 128),
			};
			const existing = await readIdempotency(transaction, scope);
			if (existing) {
				if (existing.request_digest !== request.requestDigest) {
					return { outcome: "conflict", reason: "idempotency_conflict" };
				}
				if (existing.status !== "completed") unavailable();
				const result = parseRegenerationResult(existing.result);
				await requireRegenerationReplay(
					transaction,
					result,
					conversation.conversationId,
					authority,
				);
				return { outcome: "replayed", result };
			}
			const state = await readRegenerationState(
				transaction,
				conversation,
				text(request.command.sourceMessageId),
			);
			const decision = decide(state);
			if (!isRegenerationPlan(decision)) return decision;
			const plan = validateRegenerationPlan(decision, request, state);
			const reservationId = await reserveIdempotency(transaction, {
				...scope,
				requestDigest: request.requestDigest,
				occurredAt: plan.execution.createdAt,
			});
			if (!reservationId) unavailable();
			const updated = await transaction<{ id: string }[]>`
				update platform.conversations
				set status = ${plan.conversation.status},
					authorization_revision = ${plan.conversation.authorizationRevision},
					last_conversation_cursor = ${plan.conversation.lastConversationCursor},
					selected_model_option_id = ${plan.conversation.selectedModelOptionId},
					selected_reasoning_level = ${plan.conversation.selectedReasoningLevel},
					updated_at = ${plan.execution.createdAt}
				where id = ${conversation.conversationId}
				returning id
			`;
			if (updated.length !== 1) unavailable();
			await transaction`
				insert into platform.conversation_executions
					(execution_id, conversation_id, agent_id, actor_id, channel_id,
					 turn_id, status, session_generation, delivery_fence,
					 authorization_revision, model_configuration_revision,
					 model_option_id, reasoning_level, created_at, updated_at)
				values
					(${plan.execution.executionId}, ${plan.execution.conversationId},
					 ${plan.execution.agentId}, ${plan.execution.actorId},
					 ${plan.execution.channelId}, ${plan.execution.turnId},
					 ${plan.execution.status}, ${plan.execution.sessionGeneration},
					 ${plan.execution.deliveryFence},
					 ${plan.execution.authorizationRevision},
					 ${plan.execution.modelConfigurationRevision},
					 ${plan.execution.modelOptionId}, ${plan.execution.reasoningLevel},
					 ${plan.execution.createdAt},
					 ${plan.execution.createdAt})
			`;
			await insertTaskAuthorization(transaction, {
				executionId: plan.execution.executionId,
				boundary: authority.taskBoundary,
				traceId: request.command.traceId,
				requestId: request.command.requestId,
			});
			await transaction`
				insert into platform.outbox_items
					(id, scope_type, scope_id, operation, payload, trace_id, request_id,
					 available_at, created_at, updated_at)
				values
					(${`conversation:regenerate:${plan.execution.executionId}`},
					 'conversation', ${plan.outboxIntent.conversationId},
					 ${plan.outboxIntent.operation}, ${transaction.json({
							schemaVersion: 1,
							conversationId: plan.outboxIntent.conversationId,
							executionId: plan.outboxIntent.executionId,
							messageId: plan.outboxIntent.messageId,
							turnId: plan.outboxIntent.turnId,
							sessionGeneration: plan.outboxIntent.sessionGeneration,
							modelConfigurationRevision:
								plan.outboxIntent.modelConfigurationRevision,
							modelOptionId: plan.outboxIntent.modelOptionId,
							reasoningLevel: plan.outboxIntent.reasoningLevel,
						} as JsonValue)}, ${plan.outboxIntent.traceId},
					 ${plan.outboxIntent.requestId}, ${plan.outboxIntent.occurredAt},
					 ${plan.outboxIntent.occurredAt}, ${plan.outboxIntent.occurredAt})
			`;
			await transaction`
				insert into platform.conversation_audit_events
					(id, conversation_id, execution_id, agent_id, actor_id, action, trace_id,
					 request_id, occurred_at)
				values
					(${randomUUID()}, ${plan.auditEvent.conversationId},
					 ${plan.auditEvent.executionId}, ${plan.auditEvent.agentId},
					 ${plan.auditEvent.actorId}, ${plan.auditEvent.action},
					 ${plan.auditEvent.traceId}, ${plan.auditEvent.requestId},
					 ${plan.auditEvent.occurredAt})
			`;
			await insertModelSelectionFallback(
				transaction,
				plan.modelSelectionFallback,
			);
			await completeIdempotency(
				transaction,
				reservationId,
				plan.result,
				plan.execution.createdAt,
			);
			return { outcome: "accepted", result: plan.result };
		});
	}

	async executeStop(
		request: StopRequest,
		decide: StopDecide,
	): Promise<ConversationStopDecisionV1> {
		return this.#transaction(async (transaction) => {
			const authority = parseAuthority(request.authority);
			const [agent] = await transaction<
				{ authorization_revision: string | null }[]
			>`select authorization_revision from platform.agents where id = ${authority.agentId} for share`;
			await requireCurrentTaskApiAccess(
				transaction,
				authority.taskBoundary,
				agent?.authorization_revision ?? null,
			);
			// Match Worker lock order: Agent, original outbox, Conversation, Execution.
			const [original] = await transaction<{ id: string }[]>`
				select id from platform.outbox_items where scope_type = 'conversation'
					and scope_id = ${request.command.conversationId} and payload->>'executionId' = ${request.command.targetExecutionId}
					and operation in ('conversation.turn.submit.v1', 'conversation.turn.regenerate.v1')
			`;
			const originalOutbox = original
				? await lockDispatchOutbox(transaction, original.id)
				: undefined;
			const conversation = await lockConversation(
				transaction,
				text(request.command.conversationId),
			);
			if (!conversation || !matchesBinding(conversation, authority)) {
				return { outcome: "denied" };
			}
			const scope = {
				scopeType: "conversation",
				scopeId: conversation.conversationId,
				actorId: authority.actorId,
				commandType: "stop",
				key: text(request.command.idempotencyKey, 128),
			};
			const existing = await readIdempotency(transaction, scope);
			if (existing) {
				if (existing.request_digest !== request.requestDigest) {
					return { outcome: "conflict", reason: "idempotency_conflict" };
				}
				if (existing.status !== "completed") unavailable();
				const result = parseStopResult(existing.result);
				await requireStopReplay(
					transaction,
					result,
					conversation.conversationId,
					authority,
				);
				return { outcome: "replayed", result };
			}
			const state = await readStopState(
				transaction,
				conversation,
				text(request.command.targetExecutionId),
			);
			const decision = decide(state);
			if (!isStopPlan(decision)) {
				const validated = validateStopNoop(decision, request, state);
				if (validated.outcome === "denied") return validated;
				const occurredAt = new Date();
				const reservationId = await reserveIdempotency(transaction, {
					...scope,
					requestDigest: request.requestDigest,
					occurredAt,
				});
				if (!reservationId) unavailable();
				await completeIdempotency(
					transaction,
					reservationId,
					validated.result,
					occurredAt,
				);
				return validated;
			}
			const plan = validateStopPlan(decision, request, state);
			const reservationId = await reserveIdempotency(transaction, {
				...scope,
				requestDigest: request.requestDigest,
				occurredAt: plan.outboxIntent.occurredAt,
			});
			if (!reservationId) unavailable();
			const waiting = state.targetExecution?.status === "waiting";
			if (waiting) {
				const dispatchConversation = await lockDispatchConversation(
					transaction,
					conversation.conversationId,
				);
				const execution = await lockDispatchExecution(
					transaction,
					conversation.conversationId,
					plan.targetExecution.executionId,
				);
				if (!originalOutbox || !dispatchConversation || !execution)
					unavailable();
				await finishWaitingTask(
					transaction,
					{
						outbox: originalOutbox,
						conversation: dispatchConversation,
						execution,
					},
					"cancelled",
					"TASK_CANCELLED",
					"platform-api",
				);
			}
			await transaction`
				insert into platform.conversation_stops
					(execution_id, stop_request_id, status, confirmation_deadline, created_at, updated_at)
				values
					(${plan.targetExecution.executionId}, ${plan.stopRequestId}, ${waiting ? "completed" : "submitted"},
					 ${plan.confirmationDeadline}, ${plan.outboxIntent.occurredAt}, ${plan.outboxIntent.occurredAt})
			`;
			if (!waiting) {
				await transaction`
				insert into platform.outbox_items
					(id, scope_type, scope_id, operation, payload, trace_id, request_id,
					 available_at, created_at, updated_at)
				values
					(${`conversation:stop:${plan.stopRequestId}`}, 'conversation',
					 ${plan.outboxIntent.conversationId}, ${plan.outboxIntent.operation},
					 ${transaction.json({
							schemaVersion: 1,
							conversationId: plan.outboxIntent.conversationId,
							executionId: plan.outboxIntent.executionId,
							sessionGeneration: plan.outboxIntent.sessionGeneration,
							stopRequestId: plan.outboxIntent.stopRequestId,
						} as JsonValue)}, ${plan.outboxIntent.traceId},
					 ${plan.outboxIntent.requestId}, ${plan.outboxIntent.occurredAt},
					 ${plan.outboxIntent.occurredAt}, ${plan.outboxIntent.occurredAt})
			`;
			}
			await transaction`
				insert into platform.conversation_audit_events
					(id, conversation_id, execution_id, agent_id, actor_id, action, trace_id,
					 request_id, occurred_at)
				values
					(${randomUUID()}, ${plan.auditEvent.conversationId},
					 ${plan.auditEvent.executionId}, ${plan.auditEvent.agentId},
					 ${plan.auditEvent.actorId}, ${plan.auditEvent.action},
					 ${plan.auditEvent.traceId}, ${plan.auditEvent.requestId},
					 ${plan.auditEvent.occurredAt})
			`;
			await completeIdempotency(
				transaction,
				reservationId,
				plan.result,
				plan.outboxIntent.occurredAt,
			);
			return { outcome: "accepted", result: plan.result };
		});
	}

	async close(): Promise<void> {
		try {
			await this.#client?.end();
		} catch {
			unavailable();
		}
	}

	async #transaction<T>(
		work: (transaction: Transaction) => Promise<T>,
	): Promise<T> {
		try {
			if (this.#existingTransaction)
				return await work(this.#existingTransaction);
			if (!this.#client) return unavailable();
			return (await this.#client.begin(async (transaction) => {
				await transaction`select set_config('lock_timeout', '5s', true)`;
				return work(transaction);
			})) as T;
		} catch (error) {
			if (error instanceof ConversationExecutionError) throw error;
			return unavailable();
		}
	}
}
