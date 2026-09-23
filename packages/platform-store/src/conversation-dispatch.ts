import { createHash, randomUUID } from "node:crypto";
import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import {
	type ConversationDispatchClaimDecisionV1,
	type ConversationDispatchClaimV1,
	type ConversationDispatchOperationV1,
	type ConversationDispatchStateTransitionV1,
	type ConversationDispatchStorePortV1,
	decideConversationDispatchCapacityV1,
	decideConversationDispatchRetryTransitionV1,
	parseTaskAuthorizationBoundaryV1,
	planConversationGenerationConfirmationV1,
	planConversationGenerationIsolationV1,
	planTaskSystemControlV1,
	type TaskPrincipalV1,
	type WorkloadReconciliationStateV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { claimWork } from "./conversation-dispatch-claim.js";
import {
	type Client,
	DispatchCapacityUnavailable,
	databaseOperation,
	type OutboxRow,
	requireSafeCounter,
	StaleDispatchLease,
	safeCounter,
	symbolicCode,
	validText,
} from "./conversation-dispatch-common.js";
import {
	applyTransition,
	cancelStoppedTurn,
	closeOutbox,
	isolationProjection,
	ownedState,
	readGenerationIsolation,
	readMessage,
	readStop,
	renewLease,
	retryOutbox,
	transactionResult,
} from "./conversation-dispatch-sql.js";
import {
	exactPayload,
	isTurn,
	operation,
	requireClaim,
	requireCommand,
	requireLeaseDuration,
	requireTransition,
} from "./conversation-dispatch-validation.js";
import { platformDatabaseUrlFromEnvironment } from "./migrate.ts";
import { readLegacyControlRecoveryInTransaction } from "./task-authorization-migration.ts";
import { decodePersistedWorkloadStateV1 } from "./workload-reconciliation.ts";

export interface PostgresConversationDispatchOptionsV1 {
	readonly databaseUrl: string;
}

export class PostgresConversationDispatchStoreV1
	implements ConversationDispatchStorePortV1
{
	readonly #client: Client;

	constructor(options: PostgresConversationDispatchOptionsV1) {
		if (!options || typeof options !== "object") {
			throw new TypeError("Conversation dispatch Store options are invalid");
		}
		this.#client = postgres(
			platformDatabaseUrlFromEnvironment({
				PLATFORM_DATABASE_URL: options.databaseUrl,
			}),
		);
	}

	/** Recheck the live lease and derive recovery metadata from the original accepted task. */
	async readRuntimeState(input: {
		readonly claim: ConversationDispatchClaimV1;
	}) {
		requireClaim(input.claim);
		const claim = input.claim;
		return databaseOperation(() =>
			this.#client.begin(async (transaction) => {
				await transaction`select set_config('lock_timeout', '5s', true)`;
				const state = await ownedState(transaction, claim, true);
				if (!state) return null;
				const payload = exactPayload(state.outbox.payload, claim.operation);
				if (!payload) return null;
				const stop = await readStop(transaction, claim.executionId);
				const base = {
					agentId: state.execution.agent_id,
					conversationId: state.execution.conversation_id,
					executionId: state.execution.execution_id,
					turnId: state.execution.turn_id,
					sessionGeneration: safeCounter(state.execution.session_generation),
				};
				const origins = await transaction<OutboxRow[]>`
				select * from platform.outbox_items where scope_type = 'conversation'
				and scope_id = ${claim.conversationId}
				and id in (${`conversation:turn:${claim.executionId}`}, ${`conversation:regenerate:${claim.executionId}`})
				and operation in ('conversation.turn.submit.v1', 'conversation.turn.regenerate.v1')
			`;
				const [origin] = origins;
				if (
					origins.length !== 1 ||
					!origin ||
					(isTurn(claim.operation) && origin.id !== state.outbox.id)
				)
					return null;
				const originOperation = operation(origin.operation);
				if (!originOperation || !isTurn(originOperation)) return null;
				const originalPayload = exactPayload(origin.payload, originOperation);
				if (
					!originalPayload?.messageId ||
					originalPayload.executionId !== claim.executionId ||
					originalPayload.conversationId !== claim.conversationId ||
					originalPayload.turnId !== claim.turnId ||
					originalPayload.sessionGeneration !== claim.sessionGeneration ||
					originalPayload.modelOptionId !== state.execution.model_option_id ||
					originalPayload.reasoningLevel !== state.execution.reasoning_level
				)
					return null;
				const message = await readMessage(
					transaction,
					claim.conversationId,
					originalPayload.messageId,
				);
				if (
					!message ||
					message.actor_id !== state.execution.actor_id ||
					message.role !== "user"
				)
					return null;
				const inputFiles = await transaction<{ file_id: string }[]>`
					select file_id from platform.files
					where conversation_id = ${claim.conversationId}
						and record->>'messageId' = ${originalPayload.messageId}
						and record->>'kind' = 'attachment'
						and record->>'status' = 'available'
					order by file_id
				`;
				const original = {
					...base,
					kind: "submit-turn",
					input: {
						text: message.text,
						attachments: inputFiles.map((file) => file.file_id),
					},
					...(state.execution.model_option_id && state.execution.reasoning_level
						? {
								selection: {
									schemaVersion: 1,
									modelOptionId: state.execution.model_option_id,
									reasoningLevel: state.execution.reasoning_level,
								},
							}
						: {}),
				};
				// Preserve the published Host operation digest, including its base64url
				// encoding; it is independent of the V2 Grant's hex request signature.
				function canonical(value: unknown): unknown {
					if (Array.isArray(value)) return value.map(canonical);
					if (!value || typeof value !== "object") return value;
					return Object.fromEntries(
						Object.entries(value)
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([key, entry]) => [key, canonical(entry)]),
					);
				}
				const isolation = await readGenerationIsolation(
					transaction,
					claim.conversationId,
					claim.sessionGeneration,
				);
				if (
					isolation &&
					((isolation.execution_id !== claim.executionId &&
						!claim.metadataRecovery) ||
						isolation.original_principal.id !== claim.actorId)
				)
					return null;
				return {
					hostSessionRef: state.conversation.host_session_ref,
					...(isolation
						? { generationIsolation: isolationProjection(isolation) }
						: {}),
					runtimeCursor: state.execution.last_runtime_cursor,
					...(payload.metadataRecovery
						? { metadataRecovery: payload.metadataRecovery }
						: {}),
					originalOperationDigest: createHash("sha256")
						.update(JSON.stringify(canonical(original)))
						.digest("base64url"),
					executionStatus: state.execution.status,
					stopPending: stop?.status === "submitted",
				};
			}),
		);
	}

	/** Discovery grants no lease; claim rechecks eligibility under database locks. */
	async findDispatchable(input: {
		readonly limit: number;
		readonly afterItemId?: string;
	}): Promise<
		readonly {
			readonly itemId: string;
			readonly operation: ConversationDispatchOperationV1;
		}[]
	> {
		if (
			!Number.isSafeInteger(input.limit) ||
			input.limit < 1 ||
			input.limit > 256 ||
			(input.afterItemId !== undefined && !validText(input.afterItemId))
		) {
			throw new TypeError("Conversation dispatch discovery is invalid");
		}
		return databaseOperation(async () => {
			const rows = await this.#client<
				{ id: string; operation: ConversationDispatchOperationV1 }[]
			>`
				select id, operation from platform.outbox_items
				where scope_type = 'conversation'
					and operation in (
						'conversation.turn.submit.v1', 'conversation.turn.regenerate.v1',
						'conversation.turn.supplement.v1', 'conversation.turn.stop.v1'
					)
					and (
						(status in ('pending', 'retry_scheduled') and available_at <= clock_timestamp())
						or (status = 'processing' and lease_expires_at <= clock_timestamp())
            or (status in ('succeeded', 'failed') and exists (
              select 1 from platform.conversation_generation_tombstones t where t.item_id = outbox_items.id and t.status = 'pending'
            ))
					)
				order by
					case when ${input.afterItemId ?? null}::text is null
						or id > ${input.afterItemId ?? null} then 0 else 1 end,
					id
				limit ${input.limit}
			`;
			return rows.map((row) => ({ itemId: row.id, operation: row.operation }));
		});
	}

	async claim(input: {
		readonly schemaVersion: 1;
		readonly itemId: string;
		readonly workerId: string;
		readonly leaseDurationMs: number;
	}): Promise<ConversationDispatchClaimDecisionV1> {
		requireCommand(input);
		try {
			return await databaseOperation(() =>
				this.#client.begin(async (transaction) => {
					await transaction`select set_config('lock_timeout', '5s', true)`;
					return claimWork(transaction, input);
				}),
			);
		} catch (error) {
			if (error instanceof StaleDispatchLease) return { outcome: "stale" };
			throw error;
		}
	}

	async beginGenerationIsolation(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly failureCode: "RUNTIME_SESSION_RECOVERY_FAILED";
		readonly hostSessionRef: string;
	}): Promise<boolean> {
		requireClaim(input.claim);
		return transactionResult(this.#client, async (transaction) => {
			const claim = input.claim;
			const state = await ownedState(transaction, claim, true);
			if (!state) throw new StaleDispatchLease();
			if (
				!validText(input.hostSessionRef) ||
				(state.conversation.host_session_ref !== null &&
					state.conversation.host_session_ref !== input.hostSessionRef)
			)
				throw new StaleDispatchLease();
			const existing = await readGenerationIsolation(
				transaction,
				claim.conversationId,
				claim.sessionGeneration,
			);
			if (existing) {
				if (
					existing.item_id !== claim.itemId ||
					existing.execution_id !== claim.executionId
				)
					throw new StaleDispatchLease();
				return;
			}
			const [authorization] = await transaction<
				{ id: string; boundary: unknown }[]
			>`
        select id, boundary from platform.task_authorization_records where execution_id = ${claim.executionId} for update
      `;
			let originalPrincipal: TaskPrincipalV1;
			let controlSourceId: string;
			let authorizationRecordId: string;
			if (authorization) {
				const boundary = parseTaskAuthorizationBoundaryV1(
					authorization.boundary,
				);
				planTaskSystemControlV1({
					reason: "generation_isolation",
					workerId: claim.leaseOwner,
					boundary,
					execution: {
						executionId: claim.executionId,
						conversationId: claim.conversationId,
						sessionGeneration: claim.sessionGeneration,
						actorId: claim.actorId,
						agentId: claim.agentId,
						channelId: claim.channelId,
						authorizationRevision: claim.authorizationRevision,
						status: state.execution.status,
					},
				});
				const principal = boundary.principal;
				if (principal.kind !== "user" || principal.id !== claim.actorId)
					throw new StaleDispatchLease();
				originalPrincipal = principal;
				controlSourceId = authorization.id;
				authorizationRecordId = authorization.id;
			} else {
				await readLegacyControlRecoveryInTransaction(
					transaction,
					claim.executionId,
				);
				// A generation isolation control must be bound to a persisted
				// authorization record. Legacy evidence without that record cannot
				// satisfy the integrity foreign key and therefore fails closed.
				throw new StaleDispatchLease();
			}
			const plan = planConversationGenerationIsolationV1({
				claim: { ...claim, hostSessionRef: input.hostSessionRef },
				originalPrincipal,
				controlSourceId,
				failureCode: input.failureCode,
			});
			const controlRecordId = randomUUID();
			await transaction`
        insert into platform.task_control_records (id, execution_id, authorization_record_id, reason)
        values (${controlRecordId}, ${claim.executionId}, ${authorizationRecordId}, 'generation_isolation')
      `;
			await transaction`
        insert into platform.conversation_generation_tombstones
          (operation_id, conversation_id, session_generation, execution_id, item_id, control_record_id, control_source_id, original_principal, host_session_ref, failure_code)
        values (${plan.operationId}, ${claim.conversationId}, ${claim.sessionGeneration}, ${claim.executionId}, ${claim.itemId}, ${controlRecordId},
          ${plan.controlSourceId}, ${transaction.json(plan.originalPrincipal)}, ${input.hostSessionRef}, ${plan.failureCode})
      `;
			await transaction`
				insert into platform.audit_events (id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, details)
				values (${randomUUID()}, ${claim.traceId}, 'system', ${claim.leaseOwner}, ${plan.auditAction}, 'conversation', ${claim.conversationId}, 'succeeded',
					${claim.requestId}, ${claim.agentId}, ${transaction.json({
						originalPrincipal: plan.originalPrincipal,
						controlSourceId,
						authorizationRecordId,
						controlRecordId,
						operationId: plan.operationId,
						reason: plan.reason,
						failureCode: plan.failureCode,
						executionId: claim.executionId,
						sessionGeneration: claim.sessionGeneration,
					})})
      `;
			await transaction`update platform.conversations set host_session_ref = ${input.hostSessionRef}, updated_at = clock_timestamp() where id = ${claim.conversationId}`;
		});
	}

	async confirmGenerationIsolation(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly operationId: string;
		readonly hostSessionRef: string;
	}): Promise<boolean> {
		requireClaim(input.claim);
		return transactionResult(this.#client, async (transaction) => {
			const claim = input.claim;
			const state = await ownedState(transaction, claim, true);
			if (!state) throw new StaleDispatchLease();
			const isolation = await readGenerationIsolation(
				transaction,
				claim.conversationId,
				claim.sessionGeneration,
			);
			if (
				!isolation ||
				isolation.operation_id !== input.operationId ||
				isolation.item_id !== claim.itemId ||
				isolation.execution_id !== claim.executionId ||
				isolation.original_principal.id !== claim.actorId ||
				isolation.host_session_ref !== input.hostSessionRef ||
				state.conversation.host_session_ref !== input.hostSessionRef ||
				claim.generationIsolation?.controlRecordId !==
					isolation.control_record_id
			)
				throw new StaleDispatchLease();
			const [pendingMetadata] =
				await transaction`select 1 from platform.outbox_items where scope_type = 'conversation' and scope_id = ${claim.conversationId}
				and id <> ${claim.itemId} and payload->>'sessionGeneration' = ${String(claim.sessionGeneration)} and payload ? 'metadataRecovery'
				and status in ('pending', 'retry_scheduled', 'processing') limit 1`;
			if (pendingMetadata) throw new StaleDispatchLease();
			const plan = planConversationGenerationConfirmationV1({
				...claim,
				executionStatus: state.execution.status,
			});
			const failed = await transaction<{ execution_id: string }[]>`
        update platform.conversation_executions set status = 'failed', updated_at = clock_timestamp()
        where conversation_id = ${claim.conversationId} and session_generation = ${claim.sessionGeneration}
          and status::text = any(${plan.executionStatusesToFail}) returning execution_id
      `;
			await transaction`
        update platform.outbox_items set status = 'failed', lease_owner = null, lease_expires_at = null, updated_at = clock_timestamp()
        where scope_type = 'conversation' and scope_id = ${claim.conversationId} and id <> ${claim.itemId}
          and operation = any(${plan.businessOperations})
          and payload->>'sessionGeneration' = ${String(claim.sessionGeneration)} and status in ('pending', 'retry_scheduled', 'processing')
      `;
			await transaction`
        update platform.conversation_messages set status = 'failed', failure_code = ${plan.failureCode}, updated_at = clock_timestamp()
        where conversation_id = ${claim.conversationId} and status = 'submitted' and message_id in (select payload->>'messageId' from platform.outbox_items where scope_type = 'conversation' and scope_id = ${claim.conversationId} and operation = 'conversation.turn.supplement.v1' and payload->>'sessionGeneration' = ${String(claim.sessionGeneration)})
          and execution_id in (select execution_id from platform.conversation_executions where conversation_id = ${claim.conversationId} and session_generation = ${claim.sessionGeneration})
      `;
			await transaction`
        update platform.conversation_stops set status = 'completed', updated_at = clock_timestamp()
        where execution_id in (select execution_id from platform.conversation_executions where conversation_id = ${claim.conversationId} and session_generation = ${claim.sessionGeneration})
          and status = 'submitted'
      `;
			for (const execution of failed)
				await transaction`
        insert into platform.audit_events (id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, details)
        values (${randomUUID()}, ${claim.traceId}, 'system', ${claim.leaseOwner}, ${plan.executionAuditAction}, 'execution', ${execution.execution_id}, 'succeeded',
          ${claim.requestId}, ${claim.agentId}, ${transaction.json({
						operationId: isolation.operation_id,
						originalPrincipal: isolation.original_principal,
						reason: plan.failureCode,
						sessionGeneration: claim.sessionGeneration,
					})})
      `;
			await closeOutbox(
				transaction,
				state,
				claim,
				plan.originalOutboxStatus,
				plan.failureCode,
			);
			await transaction`
        update platform.conversations set session_generation = ${plan.nextGeneration}, status = ${plan.conversationStatus}, updated_at = clock_timestamp()
        where id = ${claim.conversationId} and session_generation = ${claim.sessionGeneration}
      `;
			await transaction`update platform.conversation_generation_tombstones set status = 'confirmed', confirmed_at = clock_timestamp() where operation_id = ${isolation.operation_id}`;
			await transaction`
        insert into platform.audit_events (id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, details)
        values (${randomUUID()}, ${claim.traceId}, 'system', ${claim.leaseOwner}, ${plan.confirmationAuditAction}, 'conversation', ${claim.conversationId}, 'succeeded',
          ${claim.requestId}, ${claim.agentId}, ${transaction.json({
						operationId: isolation.operation_id,
						originalPrincipal: isolation.original_principal,
						previousGeneration: claim.sessionGeneration,
						sessionGeneration: plan.nextGeneration,
					})})
      `;
		});
	}

	async renew(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly leaseDurationMs: number;
	}): Promise<boolean> {
		requireClaim(input.claim);
		requireLeaseDuration(input.leaseDurationMs);
		return transactionResult(this.#client, async (transaction) => {
			// Stop changes authority, not ownership of the original event drain.
			const state = await ownedState(transaction, input.claim, true);
			if (!state) throw new StaleDispatchLease();
			await renewLease(transaction, input.claim, input.leaseDurationMs);
		});
	}

	async prepareRuntimeDispatch(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly leaseDurationMs: number;
	}): Promise<boolean | "capacity_wait" | "capacity_unavailable"> {
		requireClaim(input.claim);
		if (input.claim.metadataRecovery)
			throw new TypeError("Metadata recovery cannot dispatch business work");
		requireLeaseDuration(input.leaseDurationMs);
		try {
			return await transactionResult(this.#client, async (transaction) => {
				// Agent first: management/configuration/reconciliation use this same row.
				// Never hold another Conversation's execution lock while waiting for it.
				await transaction`select id from platform.agents where id = ${input.claim.agentId} for update`;
				// Read only after acquiring the lock: a join evaluated while waiting could
				// retain a pre-lock snapshot of application or reconciliation state.
				const [agent] = await transaction<
					{
						current_configuration_revision: string;
						status: string | null;
						desired_state: string | null;
						service_availability: string | null;
						workload_revision: string | null;
						fence: string | null;
						state: unknown;
					}[]
				>`
				select a.current_configuration_revision::text, ap.status, ap.desired_state,
					ap.service_availability, ap.workload_revision::text, ap.fence::text, w.state
				from platform.agents a
				left join platform.agent_applications ap on ap.agent_id = a.id
				left join platform.workload_reconciliations w on w.agent_id = a.id
					where a.id = ${input.claim.agentId}
				`;
				if (!agent)
					throw new DispatchCapacityUnavailable("capacity_unavailable");
				const state = await ownedState(transaction, input.claim);
				if (!state) throw new StaleDispatchLease();
				const pendingIsolation = await readGenerationIsolation(
					transaction,
					input.claim.conversationId,
					input.claim.sessionGeneration,
				);
				if (
					pendingIsolation &&
					input.claim.operation !== "conversation.turn.stop.v1"
				)
					throw new StaleDispatchLease();
				if (
					isTurn(input.claim.operation) &&
					state.execution.status === "submitted"
				) {
					let workload: WorkloadReconciliationStateV1;
					let desired: ReturnType<typeof validateAgentWorkloadDesiredV1>;
					try {
						const decoded = decodePersistedWorkloadStateV1(
							agent?.state,
							input.claim.agentId,
						);
						if (!agent || !decoded || decoded.legacy) throw new Error();
						workload = decoded.state;
						desired = validateAgentWorkloadDesiredV1(
							workload.verified?.deployment,
						);
					} catch {
						throw new DispatchCapacityUnavailable("capacity_unavailable");
					}
					const [occupancy] = await transaction<
						{ processing: string; unknown: string }[]
					>`
							select count(*) filter (where status = 'processing')::text as processing,
									count(*) filter (where status = 'unknown' or (status <> 'processing' and exists (
										select 1 from platform.conversation_generation_tombstones t
										where t.execution_id = conversation_executions.execution_id
											and t.status = 'pending'
									)))::text as unknown
							from platform.conversation_executions where agent_id = ${input.claim.agentId}
								and (status in ('processing', 'unknown') or exists (select 1 from platform.conversation_generation_tombstones t where t.execution_id = conversation_executions.execution_id and t.status = 'pending'))
						`;
					let capacityDecision: ReturnType<
						typeof decideConversationDispatchCapacityV1
					>;
					try {
						// The Core decision consumes this locked snapshot, before any occupied state is written.
						capacityDecision = decideConversationDispatchCapacityV1({
							agentId: input.claim.agentId,
							modelConfigurationRevision:
								input.claim.modelConfigurationRevision,
							configurationRevision: requireSafeCounter(
								agent.current_configuration_revision,
								1,
							),
							status: agent.status,
							desiredState: agent.desired_state,
							serviceAvailability: agent.service_availability,
							workloadRevision: requireSafeCounter(agent.workload_revision, 1),
							fence: requireSafeCounter(agent.fence, 1),
							workload,
							deployment: {
								agentId: desired.agentId,
								configurationRevision: desired.configRevision,
								interactionMode: desired.runtimeManifest.interactionMode,
								imageDigest: desired.imageDigest,
								resourceProfileRef: desired.resourceProfileRef,
							},
							occupancy: {
								processing: requireSafeCounter(occupancy?.processing),
								unknown: requireSafeCounter(occupancy?.unknown),
							},
						});
					} catch (error) {
						if (error instanceof DispatchCapacityUnavailable) throw error;
						throw new DispatchCapacityUnavailable("capacity_unavailable");
					}
					if (capacityDecision !== "admit")
						throw new DispatchCapacityUnavailable(capacityDecision);
					const rows = await transaction<{ execution_id: string }[]>`
					update platform.conversation_executions
					set status = 'unknown', updated_at = clock_timestamp()
					where execution_id = ${input.claim.executionId}
						and conversation_id = ${input.claim.conversationId}
						and session_generation = ${input.claim.sessionGeneration}
						and delivery_fence = ${input.claim.executionDeliveryFence}
						and status = 'submitted'
					returning execution_id
				`;
					if (rows.length !== 1) throw new StaleDispatchLease();
				}
				await renewLease(transaction, input.claim, input.leaseDurationMs);
			});
		} catch (error) {
			if (error instanceof DispatchCapacityUnavailable) return error.outcome;
			throw error;
		}
	}

	async cancelUnaccepted(input: {
		readonly claim: ConversationDispatchClaimV1;
	}): Promise<boolean> {
		requireClaim(input.claim);
		return transactionResult(this.#client, async (transaction) => {
			const state = await ownedState(transaction, input.claim);
			const payload = state
				? exactPayload(state.outbox.payload, input.claim.operation)
				: undefined;
			const stop = state
				? await readStop(transaction, input.claim.executionId)
				: undefined;
			if (
				!state ||
				!payload ||
				!isTurn(input.claim.operation) ||
				state.execution.status !== "unknown" ||
				stop?.status !== "submitted"
			) {
				throw new StaleDispatchLease();
			}
			await cancelStoppedTurn(
				transaction,
				state.outbox,
				state.conversation,
				state.execution,
				stop,
				payload,
			);
		});
	}

	async recordRuntimeResponse(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly hostSessionRef: string;
		readonly transition: ConversationDispatchStateTransitionV1;
	}): Promise<boolean> {
		requireClaim(input.claim);
		requireTransition(input.transition);
		if (input.claim.metadataRecovery)
			throw new TypeError(
				"Metadata recovery cannot record a business response",
			);
		if (!validText(input.hostSessionRef)) {
			throw new TypeError("RuntimeHost Session reference is invalid");
		}
		return transactionResult(this.#client, async (transaction) => {
			const state = await ownedState(transaction, input.claim);
			if (
				!state ||
				(state.conversation.host_session_ref !== null &&
					state.conversation.host_session_ref !== input.hostSessionRef)
			) {
				throw new StaleDispatchLease();
			}
			await applyTransition(transaction, state, input.claim, input.transition);
			const rows = await transaction<{ id: string }[]>`
				update platform.conversations
				set host_session_ref = ${input.hostSessionRef}, updated_at = clock_timestamp()
				where id = ${input.claim.conversationId}
					and session_generation = ${input.claim.sessionGeneration}
					and authorization_revision = ${input.claim.authorizationRevision}
					and (host_session_ref is null or host_session_ref = ${input.hostSessionRef})
				returning id
			`;
			if (rows.length !== 1) throw new StaleDispatchLease();
		});
	}

	async finish(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly status: "succeeded" | "failed";
		readonly transition: ConversationDispatchStateTransitionV1;
		readonly errorCode?: string;
	}): Promise<boolean> {
		requireClaim(input.claim);
		requireTransition(input.transition);
		if (
			input.claim.metadataRecovery &&
			Object.keys(input.transition).length !== 0
		)
			throw new TypeError("Metadata recovery cannot transition business state");
		if (
			(input.status === "failed") !== (input.errorCode !== undefined) ||
			(input.errorCode !== undefined && !symbolicCode.test(input.errorCode))
		) {
			throw new TypeError("Conversation dispatch outcome is invalid");
		}
		return transactionResult(this.#client, async (transaction) => {
			const state = await ownedState(transaction, input.claim, true);
			if (!state) throw new StaleDispatchLease();
			await applyTransition(transaction, state, input.claim, input.transition);
			if (
				input.claim.operation === "conversation.turn.supplement.v1" &&
				input.status === "failed"
			) {
				const failureCode =
					input.errorCode === "AUTHORIZATION_REVOKED" ||
					input.errorCode === "ORIGINAL_RESPONSE_NOT_STARTED" ||
					input.errorCode === "ORIGINAL_RESPONSE_ALREADY_FINISHED"
						? input.errorCode
						: "EXECUTION_FAILED";
				const messages = await transaction<{ message_id: string }[]>`
					update platform.conversation_messages
					set status = 'failed', failure_code = ${failureCode},
						updated_at = clock_timestamp()
					where message_id = ${input.claim.messageId}
						and conversation_id = ${input.claim.conversationId}
						and execution_id = ${input.claim.executionId}
						and status = 'submitted'
					returning message_id
				`;
				if (messages.length !== 1) throw new StaleDispatchLease();
			}
			if (
				input.claim.operation === "conversation.turn.stop.v1" &&
				input.status === "succeeded"
			) {
				const rows = await transaction<{ execution_id: string }[]>`
					update platform.conversation_stops
					set status = 'completed', updated_at = clock_timestamp()
					where execution_id = ${input.claim.executionId}
						and stop_request_id = ${input.claim.stopRequestId}
					returning execution_id
				`;
				if (rows.length !== 1) throw new StaleDispatchLease();
			}
			await closeOutbox(
				transaction,
				state,
				input.claim,
				input.claim.metadataRecovery?.originalStatus ?? input.status,
				input.errorCode,
			);
		});
	}

	async retry(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly retryDelayMs: number;
		readonly errorCode: string;
		readonly transition: ConversationDispatchStateTransitionV1;
	}): Promise<boolean> {
		requireClaim(input.claim);
		requireTransition(input.transition);
		if (
			input.claim.metadataRecovery &&
			Object.keys(input.transition).length !== 0
		)
			throw new TypeError("Metadata recovery cannot transition business state");
		if (
			!Number.isSafeInteger(input.retryDelayMs) ||
			input.retryDelayMs < 0 ||
			input.retryDelayMs > 86_400_000 ||
			!symbolicCode.test(input.errorCode)
		) {
			throw new TypeError("Conversation dispatch retry is invalid");
		}
		return transactionResult(this.#client, async (transaction) => {
			const state = await ownedState(transaction, input.claim, true);
			if (!state) throw new StaleDispatchLease();
			// A concurrent stop can commit a terminal response before the original
			// event stream fails. Release its lease without undoing that response or
			// changing the Conversation now owned by a later Execution.
			const transition = decideConversationDispatchRetryTransitionV1({
				operation: input.claim.operation,
				executionStatus: state.execution.status,
				transition: input.transition,
			});
			await applyTransition(transaction, state, input.claim, transition);
			await retryOutbox(
				transaction,
				state,
				input.claim,
				input.retryDelayMs,
				input.errorCode,
			);
		});
	}

	async close(): Promise<void> {
		await databaseOperation(() => this.#client.end());
	}
}

export function openPostgresConversationDispatchStoreV1(
	options: PostgresConversationDispatchOptionsV1,
) {
	return new PostgresConversationDispatchStoreV1(options);
}

export { ConversationDispatchStoreError } from "./conversation-dispatch-common.js";
