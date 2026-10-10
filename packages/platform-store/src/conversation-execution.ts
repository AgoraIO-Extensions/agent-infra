import { randomUUID } from "node:crypto";
import type { RuntimeBusinessRequestV4 } from "@agent-infra/contracts/runtime";
import {
	bindInputFileV1,
	type ConversationCommandDecisionV1,
	type ConversationExecutionAuthorityV1,
	ConversationExecutionError,
	type ConversationExecutionTransactionPortV1,
	type ConversationMetadataRecoveryStateV1,
	type ConversationModelSelectionDecisionV1,
	type ConversationStateDecisionV1,
	type ConversationStopDecisionV1,
	type ConversationTaskAdmissionTransactionPortV1,
	type CreateConversationDecisionV1,
	type FileRecordV1,
	PersonalApiCredentialErrorV1,
	parseConversationOperationEventV2,
	parseTaskAuthorizationBoundaryV1,
	planTaskSystemControlV1,
	type TaskApiAuditPlanV1,
	type TaskApiChannelV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import {
	lockConversation as lockDispatchConversation,
	lockExecution as lockDispatchExecution,
	lockOutbox as lockDispatchOutbox,
} from "./conversation-dispatch-sql.js";
import { finishWaitingTask } from "./conversation-dispatch-task.js";
import {
	awaitConversationExecutionQueryV1,
	bindConversationExecutionSignalV1,
} from "./conversation-execution-abort.js";
import {
	type AcceptedExecutionKeyProjectionV4,
	readAcceptedExecutionKeyInTransactionV4,
} from "./conversation-execution-accepted-key.js";
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
import { currentConversationExecutionRelayKeyBindingV1 } from "./conversation-execution-key.js";
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
	requireCurrentPersonalApiTaskAdmissionV1,
	resolvePersonalApiTaskAdmissionAuthorityV1,
} from "./personal-api-task-authorization.js";
import {
	type RelayKeyVersionBindingV1,
	type RelayKeyVersionCiphertextV1,
	readRelayKeyVersionInTransaction,
} from "./relay-key-versions.js";
import { insertSessionSandboxBinding } from "./session-sandbox.js";
import { writeTaskApiAuditV1 } from "./task-api-audit.js";
import { insertTaskAuthorization } from "./task-authorization.js";

function legacyWebExecutionBinding(
	authority: ConversationExecutionAuthorityV1,
) {
	return authority.channelId === "web" && !authority.taskBoundary
		? { executionSource: null, relayKeyBinding: null }
		: undefined;
}

export interface PostgresConversationExecutionOptionsV1 {
	readonly databaseUrl: string;
	readonly userDirectory?: TaskUserDirectoryV1;
}

export class PostgresConversationExecutionTransactionV1
	implements ConversationExecutionTransactionPortV1
{
	readonly #client: ReturnType<typeof postgres> | undefined;
	readonly #existingTransaction: Transaction | undefined;
	readonly #userDirectory: TaskUserDirectoryV1 | undefined;
	readonly #acceptedKeyReads = new Set<Promise<unknown>>();
	#acceptedKeyClosing = false;

	constructor(
		options:
			| PostgresConversationExecutionOptionsV1
			| {
					readonly transaction: Transaction;
					readonly userDirectory?: TaskUserDirectoryV1;
					readonly signal?: AbortSignal;
			  },
	) {
		this.#userDirectory = options.userDirectory;
		if ("transaction" in options) {
			bindConversationExecutionSignalV1(options.transaction, options.signal);
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

	/** Reads the saved operation and Key tuple using this original Store instance. */
	async readAcceptedExecution(
		request: RuntimeBusinessRequestV4,
	): Promise<AcceptedExecutionKeyProjectionV4 | null> {
		if (this.#acceptedKeyClosing) unavailable();
		const pending = this.#transaction((transaction) =>
			readAcceptedExecutionKeyInTransactionV4(transaction, request),
		);
		this.#acceptedKeyReads.add(pending);
		try {
			return await pending;
		} finally {
			this.#acceptedKeyReads.delete(pending);
		}
	}

	/**
	 * Reads only the immutable ciphertext tuple pinned by an accepted Execution.
	 * Callers must obtain the accepted projection first; this method never follows
	 * a subject's mutable current-version alias.
	 */
	async readCiphertext(
		binding: RelayKeyVersionBindingV1,
	): Promise<RelayKeyVersionCiphertextV1 | null> {
		if (this.#acceptedKeyClosing) unavailable();
		const pending = this.#transaction((transaction) =>
			readRelayKeyVersionInTransaction(transaction, binding),
		);
		this.#acceptedKeyReads.add(pending);
		try {
			return await pending;
		} finally {
			this.#acceptedKeyReads.delete(pending);
		}
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
			await awaitConversationExecutionQueryV1(
				transaction,
				transaction`
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
			`,
			);
			await insertSessionSandboxBinding(transaction, plan.sandbox, {
				requestId: request.command.requestId,
				traceId: request.command.traceId,
				occurredAt,
			});
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
			// API governance locks precede Agent; Agent still precedes Conversation.
			await this.#requireCurrentPersonalApiAdmission(transaction, authority);
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
				await this.#requireCurrentPersonalApiAdmission(transaction, authority);
				return { outcome: "replayed", result };
			}
			const state = await readMessageState(transaction, conversation);
			const decision = decide(state);
			if (!isMessagePlan(decision)) {
				return decision;
			}
			const plan = validateMessagePlan(decision, request, state);
			const executionBinding = plan.execution
				? (legacyWebExecutionBinding(authority) ??
					(await currentConversationExecutionRelayKeyBindingV1(transaction, {
						authority,
						userDirectory: this.#userDirectory,
						personalApiAdmissionAuthority:
							authority.personalApiAdmissionAuthority,
					})))
				: undefined;
			if (plan.execution && !executionBinding) return { outcome: "denied" };
			const reservationId = await reserveIdempotency(transaction, {
				...scope,
				requestDigest: request.requestDigest,
				occurredAt: plan.message.createdAt,
			});
			if (!reservationId) unavailable();
			const updated = await awaitConversationExecutionQueryV1(
				transaction,
				transaction<{ id: string }[]>`
				update platform.conversations
				set status = ${plan.conversation.status},
					authorization_revision = ${plan.conversation.authorizationRevision},
					last_conversation_cursor = ${plan.conversation.lastConversationCursor},
					selected_model_option_id = ${plan.conversation.selectedModelOptionId},
					selected_reasoning_level = ${plan.conversation.selectedReasoningLevel},
					updated_at = ${plan.message.createdAt}
				where id = ${conversation.conversationId}
				returning id
			`,
			);
			if (updated.length !== 1) unavailable();
			if (plan.execution) {
				await awaitConversationExecutionQueryV1(
					transaction,
					transaction`
					insert into platform.conversation_executions
						(execution_id, conversation_id, sandbox_id, agent_id, actor_id, channel_id,
						 turn_id, status, session_generation, delivery_fence,
						 authorization_revision, model_configuration_revision,
						 model_option_id, reasoning_level, execution_source,
						relay_key_purpose, relay_key_subject_id, relay_key_id, relay_key_version,
						created_at, updated_at)
					values
						(${plan.execution.executionId}, ${plan.execution.conversationId}, ${conversation.sandbox?.sandboxId ?? null},
						 ${plan.execution.agentId}, ${plan.execution.actorId},
						 ${plan.execution.channelId}, ${plan.execution.turnId},
						 ${plan.execution.status}, ${plan.execution.sessionGeneration},
						 ${plan.execution.deliveryFence},
						 ${plan.execution.authorizationRevision},
						 ${plan.execution.modelConfigurationRevision},
						 ${plan.execution.modelOptionId}, ${plan.execution.reasoningLevel},
						${executionBinding?.executionSource ?? null},
						${executionBinding?.relayKeyBinding?.purpose ?? null},
						${executionBinding?.relayKeyBinding?.subjectId ?? null},
						${executionBinding?.relayKeyBinding?.keyId ?? null},
						${executionBinding?.relayKeyBinding?.keyVersion ?? null},
						 ${plan.execution.createdAt},
						 ${plan.execution.createdAt})
				`,
				);
				await insertTaskAuthorization(transaction, {
					executionId: plan.execution.executionId,
					boundary: authority.taskBoundary,
					traceId: request.command.traceId,
					requestId: request.command.requestId,
				});
			}
			for (const fileId of request.command.attachments ?? []) {
				const [row] = await awaitConversationExecutionQueryV1(
					transaction,
					transaction<{ record: FileRecordV1 }[]>`
                    select record from platform.files where file_id = ${fileId} and conversation_id = ${conversation.conversationId}
                `,
				);
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
				await awaitConversationExecutionQueryV1(
					transaction,
					transaction`update platform.files set record = ${transaction.json(file as unknown as JsonValue)}, updated_at = ${plan.message.createdAt} where file_id = ${fileId}`,
				);
			}
			await awaitConversationExecutionQueryV1(
				transaction,
				transaction`
				insert into platform.conversation_messages
					(message_id, conversation_id, actor_id, role, text, execution_id,
					 status, created_at, updated_at)
				values
					(${plan.message.messageId}, ${plan.message.conversationId},
					 ${plan.message.actorId}, 'user', ${plan.message.text},
					 ${plan.message.executionId}, ${plan.message.status},
					 ${plan.message.createdAt}, ${plan.message.createdAt})
			`,
			);
			await awaitConversationExecutionQueryV1(
				transaction,
				transaction`
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
			`,
			);
			await awaitConversationExecutionQueryV1(
				transaction,
				transaction`
				insert into platform.conversation_audit_events
					(id, conversation_id, execution_id, agent_id, actor_id, action, trace_id,
					 request_id, occurred_at)
				values
					(${randomUUID()}, ${plan.auditEvent.conversationId},
					 ${plan.auditEvent.executionId}, ${plan.auditEvent.agentId},
					 ${plan.auditEvent.actorId}, ${plan.auditEvent.action},
					 ${plan.auditEvent.traceId}, ${plan.auditEvent.requestId},
					 ${plan.auditEvent.occurredAt})
			`,
			);
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
			await this.#requireCurrentPersonalApiAdmission(transaction, authority);
			return { outcome: "accepted", result: plan.result };
		});
	}

	async executeModelSelection(
		request: ModelSelectionRequest,
		decide: ModelSelectionDecide,
	): Promise<ConversationModelSelectionDecisionV1> {
		return this.#transaction(async (transaction) => {
			const authority = parseAuthority(request.authority);
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
			// API governance locks precede Agent; Agent still precedes Conversation.
			await this.#requireCurrentPersonalApiAdmission(transaction, authority);
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
				await this.#requireCurrentPersonalApiAdmission(transaction, authority);
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
			const executionBinding =
				legacyWebExecutionBinding(authority) ??
				(await currentConversationExecutionRelayKeyBindingV1(transaction, {
					authority,
					userDirectory: this.#userDirectory,
					personalApiAdmissionAuthority:
						authority.personalApiAdmissionAuthority,
				}));
			if (!executionBinding) return { outcome: "denied" };
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
					(execution_id, conversation_id, sandbox_id, agent_id, actor_id, channel_id,
					 turn_id, status, session_generation, delivery_fence,
					 authorization_revision, model_configuration_revision,
					 model_option_id, reasoning_level, execution_source,
						relay_key_purpose, relay_key_subject_id, relay_key_id, relay_key_version,
						created_at, updated_at)
				values
					(${plan.execution.executionId}, ${plan.execution.conversationId}, ${conversation.sandbox?.sandboxId ?? null},
					 ${plan.execution.agentId}, ${plan.execution.actorId},
					 ${plan.execution.channelId}, ${plan.execution.turnId},
					 ${plan.execution.status}, ${plan.execution.sessionGeneration},
					 ${plan.execution.deliveryFence},
					 ${plan.execution.authorizationRevision},
					 ${plan.execution.modelConfigurationRevision},
					 ${plan.execution.modelOptionId}, ${plan.execution.reasoningLevel},
						${executionBinding?.executionSource ?? null},
						${executionBinding?.relayKeyBinding?.purpose ?? null},
						${executionBinding?.relayKeyBinding?.subjectId ?? null},
						${executionBinding?.relayKeyBinding?.keyId ?? null},
						${executionBinding?.relayKeyBinding?.keyVersion ?? null},
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
			await this.#requireCurrentPersonalApiAdmission(transaction, authority);
			return { outcome: "accepted", result: plan.result };
		});
	}

	async executeStop(
		request: StopRequest,
		decide: StopDecide,
	): Promise<ConversationStopDecisionV1> {
		return this.#transaction(async (transaction) => {
			const authority = parseAuthority(request.authority);
			await this.#requireCurrentPersonalApiAdmission(transaction, authority);
			await transaction`select id from platform.agents where id = ${authority.agentId} for share`;
			const executionId = text(request.command.targetExecutionId);
			const [initialExecution] = await transaction<{ status: string }[]>`
				select status from platform.conversation_executions where execution_id = ${executionId}
			`;
			// Waiting transitions share the Worker's original outbox lock. Terminal/replay
			// paths keep Conversation first, matching historical metadata recovery.
			let originalOutbox: Awaited<ReturnType<typeof lockDispatchOutbox>>;
			if (initialExecution?.status === "waiting") {
				originalOutbox = await lockDispatchOutbox(
					transaction,
					`conversation:turn:${executionId}`,
				);
				const [currentExecution] = await transaction<{ status: string }[]>`
					select status from platform.conversation_executions where execution_id = ${executionId}
				`;
				// Never carry Outbox -> Conversation into a non-waiting legacy path.
				if (currentExecution?.status !== "waiting") unavailable();
			}
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
				await this.#requireCurrentPersonalApiAdmission(transaction, authority);
				return { outcome: "replayed", result };
			}
			const dispatchConversation = await lockDispatchConversation(
				transaction,
				conversation.conversationId,
			);
			const execution = await lockDispatchExecution(
				transaction,
				conversation.conversationId,
				text(request.command.targetExecutionId),
			);
			if (execution?.status === "waiting") {
				if (!originalOutbox || !dispatchConversation || !authority.taskBoundary)
					unavailable();
				if (
					execution.principal_type !== authority.taskBoundary.principal.kind ||
					execution.actor_id !== authority.actorId ||
					execution.agent_id !== authority.agentId ||
					execution.channel_id !== authority.channelId
				)
					unavailable();
				const [record] = await transaction<{ boundary: unknown }[]>`
     select boundary from platform.task_authorization_records
     where execution_id = ${execution.execution_id} for update
    `;
				if (!record) unavailable();
				const control = planTaskSystemControlV1({
					reason: "stop",
					workerId: "platform-api",
					boundary: parseTaskAuthorizationBoundaryV1(record.boundary),
					execution: {
						executionId: execution.execution_id,
						conversationId: execution.conversation_id,
						sessionGeneration: safeInteger(execution.session_generation, 1),
						actorId: execution.actor_id,
						principal: authority.taskBoundary.principal,
						agentId: execution.agent_id,
						channelId: execution.channel_id,
						authorizationRevision: execution.authorization_revision,
						status: execution.status,
					},
				});
				if (control.ensureStop || control.revokeAuthorization) unavailable();
				const occurredAt = new Date();
				const reservationId = await reserveIdempotency(transaction, {
					...scope,
					requestDigest: request.requestDigest,
					occurredAt,
				});
				if (!reservationId) unavailable();
				await finishWaitingTask(
					transaction,
					{
						outbox: originalOutbox,
						conversation: dispatchConversation,
						execution,
					},
					"cancelled",
					"TASK_CANCELLED",
					control.workerId,
				);
				await transaction`
     insert into platform.conversation_stops
      (execution_id, stop_request_id, status, created_at, updated_at)
     values (${execution.execution_id}, ${randomUUID()}, 'completed', ${occurredAt}, ${occurredAt})
    `;
				await transaction`
     insert into platform.conversation_audit_events
      (id, conversation_id, execution_id, agent_id, actor_id, action, trace_id, request_id, occurred_at)
     values (${randomUUID()}, ${conversation.conversationId}, ${execution.execution_id},
      ${authority.agentId}, ${authority.actorId}, 'conversation.stop.accepted',
      ${request.command.traceId}, ${request.command.requestId}, ${occurredAt})
    `;
				const result = {
					schemaVersion: 1 as const,
					status: "submitted" as const,
					executionId: execution.execution_id,
				};
				await completeIdempotency(
					transaction,
					reservationId,
					result,
					occurredAt,
				);
				await this.#requireCurrentPersonalApiAdmission(transaction, authority);
				return { outcome: "accepted", result };
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
				await this.#requireCurrentPersonalApiAdmission(transaction, authority);
				return validated;
			}
			const plan = validateStopPlan(decision, request, state);
			const reservationId = await reserveIdempotency(transaction, {
				...scope,
				requestDigest: request.requestDigest,
				occurredAt: plan.outboxIntent.occurredAt,
			});
			if (!reservationId) unavailable();
			await transaction`
				insert into platform.conversation_stops
					(execution_id, stop_request_id, status, confirmation_deadline, created_at, updated_at)
				values
					(${plan.targetExecution.executionId}, ${plan.stopRequestId}, 'submitted',
					 ${plan.confirmationDeadline}, ${plan.outboxIntent.occurredAt}, ${plan.outboxIntent.occurredAt})
			`;
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
			await this.#requireCurrentPersonalApiAdmission(transaction, authority);
			return { outcome: "accepted", result: plan.result };
		});
	}

	/** Resolve actual request Bearer using the original Store transaction and lock order. */
	async authorizeTaskApi(input: {
		readonly material: string;
		readonly operation: "agent:use" | "agent:read";
		readonly agentId?: string;
		readonly conversationId?: string;
	}): Promise<ConversationExecutionAuthorityV1 | null> {
		return this.#transaction(async (transaction) => {
			if (input.operation !== "agent:use" && input.operation !== "agent:read")
				unavailable();
			// This unlocked lookup supplies only the target binding. No authority escapes it.
			const [target] =
				input.conversationId === undefined
					? []
					: await transaction<
							{
								agent_id: string;
								channel_id: string;
							}[]
						>`select agent_id, channel_id from platform.conversations where id = ${text(input.conversationId)}`;
			if (input.conversationId !== undefined && !target) return null;
			if (
				target &&
				input.agentId !== undefined &&
				target.agent_id !== input.agentId
			)
				return null;
			const agentId = text(input.agentId ?? target?.agent_id);
			const channelId = target?.channel_id ?? "api";
			if (!["api", "api:user", "api:application"].includes(channelId))
				return null;
			const admission = await resolvePersonalApiTaskAdmissionAuthorityV1(
				transaction,
				{
					material: input.material,
					agentId,
					channelId: channelId as TaskApiChannelV1,
					operation: input.operation,
				},
				this.#userDirectory,
			);
			const [agent] = await transaction<
				{ authorization_revision: string | null }[]
			>`
				select authorization_revision from platform.agents where id = ${agentId} for share
			`;
			if (!agent?.authorization_revision) return null;
			const authority = parseAuthority({
				schemaVersion: 1,
				actorId: admission.principal.id,
				agentId,
				channelId,
				authorizationRevision: agent.authorization_revision,
				supportsSupplementaryInstruction: false,
				personalApiAdmissionAuthority: admission,
				taskBoundary: {
					schemaVersion: 1,
					principal: admission.principal,
					agentId,
					channelId,
					identityRevision: admission.identityRevision,
					agentAuthorizationRevision: agent.authorization_revision,
					accessSources: [
						{ kind: "api-use", useGrantRevision: admission.useGrantRevision },
					],
				},
			});
			if (input.conversationId !== undefined) {
				const conversation =
					input.operation === "agent:read"
						? await lockConversationForRead(transaction, input.conversationId)
						: await lockConversation(transaction, input.conversationId);
				if (
					!conversation ||
					conversation.agentId !== agentId ||
					conversation.channelId !== channelId ||
					conversation.actorId !== admission.principal.id ||
					conversation.principal?.kind !== admission.principal.kind
				)
					return null;
			}
			await requireCurrentPersonalApiTaskAdmissionV1(
				transaction,
				admission,
				{
					principal: admission.principal,
					actorId: authority.actorId,
					agentId,
					channelId: admission.channelId,
					operation: input.operation,
				},
				this.#userDirectory,
			);
			return authority;
		}).catch((error: unknown) => {
			// Initial and final credential checks share the missing-resource response.
			if (
				input.conversationId !== undefined &&
				error instanceof PersonalApiCredentialErrorV1
			)
				return null;
			throw error;
		});
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
			submitConversationTask(transaction, request, decide, this.#userDirectory),
		);
	}

	async writeTaskApiAudit(plan: TaskApiAuditPlanV1): Promise<void> {
		await this.#transaction((transaction) =>
			writeTaskApiAuditV1(transaction, plan),
		);
	}

	async close(): Promise<void> {
		this.#acceptedKeyClosing = true;
		// Caller abort does not settle SQL reads; join them before closing their pool.
		await Promise.allSettled([...this.#acceptedKeyReads]);
		try {
			await this.#client?.end();
		} catch {
			unavailable();
		}
	}

	/** Entry and both successful exits use the original transaction and fresh policy clock. */
	async #requireCurrentPersonalApiAdmission(
		transaction: Transaction,
		authority: ConversationExecutionAuthorityV1,
	) {
		if (!["api", "api:user", "api:application"].includes(authority.channelId))
			return;
		if (!authority.personalApiAdmissionAuthority || !authority.taskBoundary)
			unavailable();
		const current = await requireCurrentPersonalApiTaskAdmissionV1(
			transaction,
			authority.personalApiAdmissionAuthority,
			{
				principal: authority.taskBoundary.principal,
				actorId: authority.actorId,
				agentId: authority.agentId,
				channelId: authority.channelId as TaskApiChannelV1,
				operation: "agent:use",
			},
			this.#userDirectory,
		);
		const sources = authority.taskBoundary.accessSources;
		if (
			current.identityRevision !== authority.taskBoundary.identityRevision ||
			sources.length !== 1 ||
			sources[0]?.kind !== "api-use" ||
			current.useGrantRevision !== sources[0].useGrantRevision
		)
			unavailable();
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
			if (
				error instanceof ConversationExecutionError ||
				error instanceof PersonalApiCredentialErrorV1
			)
				throw error;
			return unavailable();
		}
	}
}
