import { randomUUID } from "node:crypto";
import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import {
	type ConversationDispatchClaimDecisionV1,
	type ConversationDispatchClaimV1,
	type ConversationDispatchOperationV1,
	type ConversationDispatchStateTransitionV1,
	type ConversationDispatchStorePortV1,
	decideConversationDispatchCapacityV1,
	decideConversationDispatchRetryTransitionV1,
	parseConversationPersistedEventPayloadV1,
	parseTaskAuthorizationBoundaryV1,
	planConversationGenerationConfirmationV1,
	planConversationGenerationIsolationV1,
	planTaskSystemControlV1,
	type SessionSandboxDeletionProgressV1,
	type SessionSandboxObservationV1,
	type SessionSandboxPolicyV1,
	type SessionSandboxReconciliationClaimV1,
	type TaskPrincipalV1,
	type TaskUserDirectoryV1,
	type WorkloadReconciliationStateV1,
} from "@agent-infra/platform-core";
import { claimWork } from "./conversation-dispatch-claim.js";
import {
	type Client,
	DispatchCapacityUnavailable,
	databaseOperation,
	executionPrincipalProjection,
	type OutboxRow,
	requireSafeCounter,
	StaleDispatchLease,
	symbolicCode,
	type Transaction,
	validText,
} from "./conversation-dispatch-common.js";
import { originalOperationBinding } from "./conversation-dispatch-operation-binding.js";
import {
	applyTransition,
	cancelAcceptedTurn,
	cancelStoppedTurn,
	closeOutbox,
	insertPlatformExecutionStatusForFailure,
	isolationProjection,
	lockOutbox,
	ownedState,
	readGenerationIsolation,
	readStop,
	renewLease,
	retryOutbox,
	settleUnacceptedExecutionWork,
	transactionResult,
} from "./conversation-dispatch-sql.js";
import {
	finishWaitingTask,
	lockWaitingTaskAuthority,
	recordTaskStatus,
	revalidateWaitingTask,
	waitingDecision,
} from "./conversation-dispatch-task.js";
import {
	exactPayload,
	isExecutionOperation,
	isTurn,
	operation,
	requireClaim,
	requireCommand,
	requireLeaseDuration,
	requireTransition,
} from "./conversation-dispatch-validation.js";
import { platformDatabaseUrlFromEnvironment } from "./migrate.ts";
import {
	type PlatformQueueResourceSnapshot,
	readPlatformQueueResourceSnapshot,
} from "./observability-snapshot.js";
import postgres from "./observed-postgres.js";
import {
	isSessionSandboxPolicyCurrentV1,
	readSessionSandboxRuntimeState,
	readSessionSandboxUpgrading,
} from "./session-sandbox.js";
import {
	claimSandboxReconciliation,
	prepareSandboxReconciliation,
	recordSandboxDeletionProgress,
	recordSandboxObservation,
	type SandboxClaimRequest,
	type SessionSandboxClaimWaitReasonV1,
} from "./session-sandbox-reconciliation.js";
import { readLegacyControlRecoveryInTransaction } from "./task-authorization-migration.ts";
import { decodePersistedWorkloadStateV1 } from "./workload-reconciliation.ts";

export interface PostgresConversationDispatchOptionsV1 {
	readonly sandboxPolicy?: SessionSandboxPolicyV1;
	readonly userDirectory?: TaskUserDirectoryV1;
	readonly databaseUrl: string;
}

/**
 * stop 认领本地取消时要结算的原执行条目（提交、重新生成或原生调用，只能有一个）。只在它没有被 Worker
 * 持有时返回：正在投递的提交由它自己的认领看到 stop 再处理（#2548），这里不与之竞争（#2674）。
 */
async function lockUnleasedExecutionOutbox(
	transaction: Transaction,
	claim: ConversationDispatchClaimV1,
): Promise<OutboxRow | undefined> {
	const submit = await lockOutbox(
		transaction,
		`conversation:turn:${claim.executionId}`,
		claim.conversationId,
	);
	const regenerate = await lockOutbox(
		transaction,
		`conversation:regenerate:${claim.executionId}`,
		claim.conversationId,
	);
	const native = await lockOutbox(
		transaction,
		`conversation:native-capability:${claim.executionId}`,
		claim.conversationId,
	);
	const origins = [submit, regenerate, native].filter(
		(origin) => origin !== undefined,
	);
	const turn = origins.length === 1 ? origins[0] : undefined;
	return turn?.status === "pending" || turn?.status === "retry_scheduled"
		? turn
		: undefined;
}

export class PostgresConversationDispatchStoreV1
	implements ConversationDispatchStorePortV1
{
	readonly #client: Client;
	readonly #userDirectory: TaskUserDirectoryV1 | undefined;
	readonly #sandboxPolicy: SessionSandboxPolicyV1 | undefined;

	constructor(options: PostgresConversationDispatchOptionsV1) {
		if (!options || typeof options !== "object") {
			throw new TypeError("Conversation dispatch Store options are invalid");
		}
		this.#userDirectory = options.userDirectory;
		if (
			options.sandboxPolicy &&
			(!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(
				options.sandboxPolicy.namespace,
			) ||
				!/^[a-f0-9]{64}$/.test(options.sandboxPolicy.resourceConfigurationHash))
		)
			throw new TypeError("Sandbox policy is invalid");
		this.#sandboxPolicy = options.sandboxPolicy
			? { ...options.sandboxPolicy }
			: undefined;
		this.#client = postgres(
			platformDatabaseUrlFromEnvironment({
				PLATFORM_DATABASE_URL: options.databaseUrl,
			}),
		);
	}

	readResourceSnapshot(
		signal: AbortSignal,
	): Promise<PlatformQueueResourceSnapshot> {
		return readPlatformQueueResourceSnapshot(this.#client, signal);
	}

	/** #3089：`onWait` 在认领返回 null 时报告固定原因码，只用于观测。 */
	async claimSandboxReconciliation(
		input: Omit<SandboxClaimRequest, "onWait"> & { readonly schemaVersion: 1 },
		onWait?: (reason: SessionSandboxClaimWaitReasonV1) => void,
	) {
		requireCommand(input);
		const policy = this.#sandboxPolicy;
		if (!policy) return null;
		return databaseOperation(() =>
			this.#client.begin((transaction) =>
				claimSandboxReconciliation(
					transaction,
					{ ...input, ...(onWait ? { onWait } : {}) },
					policy,
					this.#userDirectory,
				),
			),
		);
	}

	async prepareSandboxReconciliation(input: {
		readonly claim: SessionSandboxReconciliationClaimV1;
		readonly leaseDurationMs: number;
	}) {
		requireLeaseDuration(input.leaseDurationMs);
		const policy = this.#sandboxPolicy;
		if (!policy) return false;
		return databaseOperation(() =>
			this.#client.begin((transaction) =>
				prepareSandboxReconciliation(
					transaction,
					input.claim,
					input.leaseDurationMs,
					policy,
					this.#userDirectory,
				),
			),
		);
	}

	async recordSandboxObservation(input: {
		readonly claim: SessionSandboxReconciliationClaimV1;
		readonly observation: SessionSandboxObservationV1;
	}) {
		const policy = this.#sandboxPolicy;
		if (!policy) return "stale" as const;
		return databaseOperation(() =>
			this.#client.begin((transaction) =>
				recordSandboxObservation(
					transaction,
					input.claim,
					input.observation,
					policy,
					this.#userDirectory,
				),
			),
		);
	}

	async recordSandboxDeletionProgress(input: {
		readonly claim: SessionSandboxReconciliationClaimV1;
		readonly progress: SessionSandboxDeletionProgressV1;
		readonly leaseDurationMs: number;
	}) {
		requireLeaseDuration(input.leaseDurationMs);
		const policy = this.#sandboxPolicy;
		if (!policy) return { status: "stale" as const };
		return databaseOperation(() =>
			this.#client.begin((transaction) =>
				recordSandboxDeletionProgress(
					transaction,
					input.claim,
					input.progress,
					input.leaseDurationMs,
					policy,
					this.#userDirectory,
				),
			),
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
				// 最近一次签发的 stop/撤权控制记录即 Host 当前的闩锁（#2152）。
				const [latched] = await transaction<{ reason: string }[]>`
					select reason from platform.task_control_records
					where execution_id = ${claim.executionId}
						and reason in ('stop', 'authorization_revoked')
					order by created_at desc, id desc
					limit 1
				`;
				const original = await originalOperationBinding(
					transaction,
					state,
					claim,
				);
				if (!original) return null;
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
					sandboxResource:
						state.conversation.sandbox && this.#sandboxPolicy
							? await readSessionSandboxRuntimeState(
									transaction,
									state.conversation.sandbox,
									this.#sandboxPolicy,
								)
							: null,
					hostSessionRef: state.conversation.host_session_ref,
					...(isolation
						? { generationIsolation: isolationProjection(isolation) }
						: {}),
					runtimeCursor: state.execution.last_runtime_cursor,
					...(payload.metadataRecovery
						? { metadataRecovery: payload.metadataRecovery }
						: {}),
					originalOperationDigest: original.originalOperationDigest,
					...(state.execution.runtime_submit_protocol === null
						? {}
						: {
								runtimeSubmitProtocol: original.runtimeSubmitProtocol,
								originalSubmitHostSessionRef:
									original.originalSubmitHostSessionRef,
							}),
					executionStatus: state.execution.status,
					stopPending: stop?.status === "submitted",
					...(latched?.reason === "stop" ||
					latched?.reason === "authorization_revoked"
						? {
								latchedControlReason: latched.reason as
									| "stop"
									| "authorization_revoked",
							}
						: {}),
				};
			}),
		);
	}

	/**
	 * Resolve only the latest authenticated Browser binding already persisted in
	 * Conversation events. This is a read projection under the current outbox
	 * lease; it does not create another Browser or Runtime authority.
	 */
	async readBrowserHandoffBinding(input: {
		readonly claim: ConversationDispatchClaimV1;
	}): Promise<unknown | null> {
		if (input.claim.operation !== "conversation.browser.handoff.v1")
			return null;
		return databaseOperation(() =>
			this.#client.begin(async (transaction) => {
				const state = await ownedState(transaction, input.claim, true);
				if (!state) return null;
				const [row] = await transaction<{ event_payload: unknown }[]>`
					select event_payload
					from platform.conversation_events
					where conversation_id = ${input.claim.conversationId}
						and execution_id = ${input.claim.executionId}
						and event_type = 'browser.handoff'
					order by conversation_cursor desc, event_id desc
					limit 1
				`;
				if (!row) return null;
				let event: ReturnType<typeof parseConversationPersistedEventPayloadV1>;
				try {
					event = parseConversationPersistedEventPayloadV1(row.event_payload);
				} catch {
					return null;
				}
				if (
					event.type !== "browser.handoff" ||
					event.binding.subjectId !== input.claim.actorId ||
					event.binding.agentId !== input.claim.agentId ||
					event.binding.conversationId !== input.claim.conversationId ||
					event.binding.executionId !== input.claim.executionId ||
					event.binding.sessionGeneration !== input.claim.sessionGeneration ||
					event.binding.resourceFence !== input.claim.executionDeliveryFence
				)
					return null;
				return {
					browserAlive: event.status !== "crashed",
					authorized: !["revoked", "expired", "crashed"].includes(event.status),
					subjectId: event.binding.subjectId,
					agentId: event.binding.agentId,
					conversationId: event.binding.conversationId,
					executionId: event.binding.executionId,
					sessionGeneration: event.binding.sessionGeneration,
					resourceFence: event.binding.resourceFence,
					workloadRevision: event.binding.workloadRevision,
					imageDigest: event.binding.imageDigest,
					capabilityVersion: event.binding.capabilityVersion,
					pageRevision: event.binding.pageRevision,
				};
			}),
		);
	}

	async readBrowserSideEffectBinding(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly confirmationId: string;
	}): Promise<unknown | null> {
		if (input.claim.operation !== "conversation.browser.handoff.v1")
			return null;
		return databaseOperation(() =>
			this.#client.begin(async (transaction) => {
				const state = await ownedState(transaction, input.claim, true);
				if (!state) return null;
				const [row] = await transaction<{ event_payload: unknown }[]>`
					select event_payload
					from platform.conversation_events
					where conversation_id = ${input.claim.conversationId}
						and execution_id = ${input.claim.executionId}
						and event_type = 'browser.side_effect'
						and event_payload->>'confirmationId' = ${input.confirmationId}
					order by conversation_cursor desc, event_id desc
					limit 1
				`;
				if (!row) return null;
				let event: ReturnType<typeof parseConversationPersistedEventPayloadV1>;
				try {
					event = parseConversationPersistedEventPayloadV1(row.event_payload);
				} catch {
					return null;
				}
				if (
					event.type !== "browser.side_effect" ||
					event.confirmationId !== input.confirmationId ||
					event.binding.subjectId !== input.claim.actorId ||
					event.binding.agentId !== input.claim.agentId ||
					event.binding.conversationId !== input.claim.conversationId ||
					event.binding.executionId !== input.claim.executionId ||
					event.binding.sessionGeneration !== input.claim.sessionGeneration ||
					event.binding.resourceFence !== input.claim.executionDeliveryFence
				)
					return null;
				return event;
			}),
		);
	}

	/** Discovery grants no lease; claim rechecks eligibility under database locks. */
	async findDispatchable(input: {
		readonly limit: number;
		readonly afterItemId?: string;
		readonly signal?: AbortSignal;
	}): Promise<
		readonly {
			readonly itemId: string;
			readonly operation:
				| ConversationDispatchOperationV1
				| "conversation.sandbox.reconcile.v1";
			readonly traceParent?: string;
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
			const query = this.#client<
				{
					id: string;
					operation:
						| ConversationDispatchOperationV1
						| "conversation.sandbox.reconcile.v1";
					trace_parent: string | null;
				}[]
			>`
				select id, operation, trace_parent
				from platform.outbox_items
				where scope_type = 'conversation'
					and operation in (
						'conversation.turn.submit.v1',
						'conversation.turn.regenerate.v1',
						'conversation.turn.supplement.v1',
						'conversation.turn.stop.v1',
						'conversation.native-capability.invoke.v1',
						'conversation.browser.handoff.v1',
						'conversation.sandbox.reconcile.v1'
					)
					and (
						(status in ('pending', 'retry_scheduled') and available_at <= now())
						or (status = 'processing' and lease_expires_at <= now())
						or (status in ('pending', 'retry_scheduled') and exists (
							select 1 from platform.conversation_executions e
							where e.execution_id = outbox_items.payload->>'executionId'
								and e.conversation_id = outbox_items.scope_id and e.status = 'waiting'
								and ((outbox_items.status = 'pending' and outbox_items.available_at = 'infinity'::timestamptz)
									or e.task_wait_deadline <= now())
						))
						or (status in ('pending', 'retry_scheduled', 'processing')
							and operation = 'conversation.turn.stop.v1'
							and exists (
								select 1 from platform.conversation_stops s
								where s.execution_id = outbox_items.payload->>'executionId'
									and s.confirmation_deadline <= now()
									and s.confirmation_timed_out_at is null
							))
						or (status in ('succeeded', 'failed') and exists (
							select 1 from platform.conversation_generation_tombstones t
							where t.item_id = outbox_items.id and t.status = 'pending'
						))
					)
					and (
						-- Control and terminal recovery are never gated on business readiness.
						operation = 'conversation.turn.stop.v1'
						or (status = 'processing' and lease_expires_at <= now())
						or (status in ('succeeded', 'failed') and exists (
							select 1 from platform.conversation_generation_tombstones t
							where t.item_id = outbox_items.id and t.status = 'pending'
						))
						or (
							operation in (
								'conversation.turn.submit.v1',
								'conversation.turn.regenerate.v1',
								'conversation.turn.supplement.v1',
								'conversation.native-capability.invoke.v1',
								'conversation.browser.handoff.v1'
							)
							and (
								payload ? 'metadataRecovery'
								or exists (
									select 1 from platform.conversation_executions e
									where e.execution_id = outbox_items.payload->>'executionId'
										and e.conversation_id = outbox_items.scope_id
										and e.status = 'waiting'
										and e.task_wait_deadline <= now()
								)
								or exists (
									select 1
									from platform.conversations c
									join platform.session_sandbox_allocations s
										on s.conversation_id = c.id
									where c.id = outbox_items.scope_id
										and s.status = 'ready'
										and s.desired_state = 'running'
										and s.resource_fence > 0
										and s.resource_observation->>'status' = 'ready'
								)
								or (
									operation in (
										'conversation.turn.submit.v1',
										'conversation.turn.regenerate.v1',
										'conversation.native-capability.invoke.v1'
									)
									and exists (
										select 1
										from platform.conversation_executions e
										join platform.agent_applications ap
											on ap.agent_id = e.agent_id
										where e.execution_id = outbox_items.payload->>'executionId'
											and e.conversation_id = outbox_items.scope_id
											and e.status in ('processing', 'unknown')
											and (
												ap.status in ('stopped', 'disabled')
												or ap.desired_state = 'stopped'
											)
									)
								)
							)
						)
						or (
							operation = 'conversation.sandbox.reconcile.v1'
							and (
								payload ? 'lifecycle'
								or not exists (
									select 1
									from platform.agent_applications a
									join platform.conversations c on c.agent_id = a.agent_id
									where c.id = outbox_items.scope_id
								)
								or exists (
									select 1
									from platform.agent_applications a
									join platform.conversations c on c.agent_id = a.agent_id
									where c.id = outbox_items.scope_id
										and (
										a.status is distinct from 'stopped'
										and a.status is distinct from 'disabled'
										or a.desired_state is distinct from 'stopped'
											or a.service_availability is not null
										)
									)
							)
						)
					)
				order by
					case when ${input.afterItemId ?? null}::text is null
						or id > ${input.afterItemId ?? null} then 0 else 1 end,
					case when operation = 'conversation.sandbox.reconcile.v1' then 1 else 0 end,
					id
				limit ${input.limit}
			`;
			// 已中止时不触碰这条查询：postgres-js 对尚未执行的查询 cancel() 后再 await，会把
			// 它交给一个连接，连接什么也不发却被标成「已满」，从此不再归还连接池（#2664）。
			if (input.signal?.aborted) return [];
			const onAbort = () => query.cancel();
			input.signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const rows = await query;
				return rows.map((row) => ({
					itemId: row.id,
					operation: row.operation,
					...(row.trace_parent ? { traceParent: row.trace_parent } : {}),
				}));
			} catch (error) {
				if (
					input.signal?.aborted &&
					error instanceof postgres.PostgresError &&
					error.code === "57014"
				)
					return [];
				throw error;
			} finally {
				input.signal?.removeEventListener("abort", onAbort);
			}
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
					return claimWork(transaction, input, this.#userDirectory);
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
						principal: executionPrincipalProjection(state.execution),
						agentId: claim.agentId,
						channelId: claim.channelId,
						authorizationRevision: claim.authorizationRevision,
						status: state.execution.status,
					},
				});
				const principal = boundary.principal;
				if (
					principal.kind !== state.execution.principal_type ||
					principal.id !== claim.actorId
				)
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
			for (const execution of failed)
				await insertPlatformExecutionStatusForFailure(
					transaction,
					claim.conversationId,
					execution.execution_id,
					"failed",
				);
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
			// Capture the source before changing the allocation generation/fence. The
			// same durable intent is resumed by later management; no second allocation.
			await transaction`update platform.outbox_items o set payload = o.payload || jsonb_build_object('sourceSnapshot',
				jsonb_build_object('sandbox', ${transaction.json(claim.sandbox as unknown as Parameters<typeof transaction.json>[0])},
					'resourceFence', a.resource_fence, 'policy', a.resource_policy, 'observation', a.resource_observation, 'deployment', o.payload->'deployment',
					'modelProjection', o.payload->'modelProjection'))
				from platform.session_sandbox_allocations a where a.conversation_id = ${claim.conversationId}
					and o.scope_type = 'conversation' and o.scope_id = a.conversation_id
					and o.operation = 'conversation.sandbox.reconcile.v1'
					and o.payload->>'sessionGeneration' = ${String(claim.sessionGeneration)}`;
			const rebound = await transaction<{ sandbox_id: string }[]>`
				update platform.session_sandbox_allocations
				set session_generation = ${plan.nextGeneration}, resource_fence = resource_fence + 1,
					status = 'unavailable', updated_at = clock_timestamp()
				where conversation_id = ${claim.conversationId} and sandbox_id = ${claim.sandbox?.sandboxId ?? null}
					and session_generation = ${claim.sessionGeneration}
				returning sandbox_id
			`;
			if (rebound.length !== 1)
				throw new Error("Sandbox generation binding changed");
			// The confirmed Runtime barrier invalidates the source resource lease too.
			// Retain its identities/PVC as evidence; it does not prove resource absence.
			await transaction`update platform.outbox_items
				set status = 'failed', lease_owner = null, lease_expires_at = null, updated_at = clock_timestamp()
				where scope_type = 'conversation' and scope_id = ${claim.conversationId}
					and operation = 'conversation.sandbox.reconcile.v1'
					and payload->>'sessionGeneration' = ${String(claim.sessionGeneration)}
					and status in ('pending', 'retry_scheduled', 'processing')`;
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
	}): Promise<
		| boolean
		| "capacity_wait"
		| "capacity_unavailable"
		| "sandbox_wait"
		| "stop_changed"
	> {
		requireClaim(input.claim);
		if (input.claim.metadataRecovery)
			throw new TypeError("Metadata recovery cannot dispatch business work");
		requireLeaseDuration(input.leaseDurationMs);
		let settledWaiting = false;
		let releasedForStopChange = false;
		try {
			const prepared = await transactionResult(
				this.#client,
				async (transaction) => {
					// 回调若被重试，上一次尝试留下的标志不能带到这一次。
					releasedForStopChange = false;
					await lockWaitingTaskAuthority(transaction, input.claim.itemId);
					// Governance precedes Agent; management uses this same Agent row.
					// Never hold another Conversation's execution lock while waiting for it.
					await transaction`select id from platform.agents where id = ${input.claim.agentId} for update`;
					// Read only after acquiring the lock: a join evaluated while waiting could
					// retain a pre-lock snapshot of application or reconciliation state.
					const [agent] = await transaction<
						{
							runtime_revision: string;
							status: string | null;
							desired_state: string | null;
							service_availability: string | null;
							workload_revision: string | null;
							fence: string | null;
							state: unknown;
						}[]
					>`
				select coalesce(cr.runtime_revision, a.current_configuration_revision)::text as runtime_revision,
					ap.status, ap.desired_state,
					ap.service_availability, ap.workload_revision::text, ap.fence::text, w.state
				from platform.agents a
				left join platform.agent_configuration_revisions cr
					on cr.agent_id = a.id and cr.revision = a.current_configuration_revision
				left join platform.agent_applications ap on ap.agent_id = a.id
				left join platform.workload_reconciliations w on w.agent_id = a.id
					where a.id = ${input.claim.agentId}
				`;
					if (!agent)
						throw new DispatchCapacityUnavailable("capacity_unavailable");
					const state = await ownedState(transaction, input.claim);
					if (!state) {
						// 认领之后 stop 才被受理：认领作废，但并没有丢失租约（放开 stop 比较后
						// 其余认领条件仍成立）。立即把条目释放为可重新认领，让下一次认领看到
						// stop；否则它会一直持有租约到期，而 stop 工作项在原始响应开始之前只能
						// 重试，整个停止被拖满一个租约（#2534）。
						const changed = await ownedState(transaction, input.claim, true);
						if (changed) {
							await retryOutbox(
								transaction,
								changed,
								input.claim,
								0,
								"DISPATCH_STOP_CHANGED",
							);
							releasedForStopChange = true;
							return;
						}
						throw new StaleDispatchLease();
					}
					const pendingIsolation = await readGenerationIsolation(
						transaction,
						input.claim.conversationId,
						input.claim.sessionGeneration,
					);
					if (state.execution.status === "waiting") {
						if (
							!(await revalidateWaitingTask(
								transaction,
								state,
								input.claim.leaseOwner,
								this.#userDirectory,
							))
						) {
							settledWaiting = true;
							return;
						}
						const decision = await waitingDecision(
							transaction,
							state,
							agent,
							Boolean(pendingIsolation),
						);
						if (decision.outcome === "fail") {
							await finishWaitingTask(
								transaction,
								state,
								"failed",
								decision.reason,
								input.claim.leaseOwner,
							);
							settledWaiting = true;
							return;
						}
						if (decision.outcome === "wait")
							throw new DispatchCapacityUnavailable("capacity_wait");
					}
					const stoppedRecovery =
						isExecutionOperation(input.claim.operation) &&
						(input.claim.executionStatus === "processing" ||
							input.claim.executionStatus === "unknown") &&
						(agent.status === "stopped" ||
							agent.status === "disabled" ||
							agent.desired_state === "stopped");
					if (
						!state.conversation.sandbox_ready &&
						input.claim.operation !== "conversation.turn.stop.v1" &&
						!stoppedRecovery
					)
						// An upgrading Sandbox is this Session's own wait, not
						// Agent capacity (ADR 0023).
						throw new DispatchCapacityUnavailable(
							(await readSessionSandboxUpgrading(
								transaction,
								input.claim.conversationId,
							))
								? "sandbox_wait"
								: "capacity_wait",
						);
					if (
						pendingIsolation &&
						input.claim.operation !== "conversation.turn.stop.v1"
					)
						throw new StaleDispatchLease();
					if (
						input.claim.operation ===
							"conversation.native-capability.invoke.v1" &&
						state.execution.status === "submitted" &&
						state.conversation.status !== "ready"
					)
						throw new DispatchCapacityUnavailable("capacity_wait");
					if (
						isExecutionOperation(input.claim.operation) &&
						(state.execution.status === "submitted" ||
							state.execution.status === "waiting")
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
								operation: input.claim.operation,
								agentId: input.claim.agentId,
								modelConfigurationRevision:
									input.claim.modelConfigurationRevision,
								// 投递就绪比较 Runtime 修订：只改渠道不让已受理任务等待（ADR-0028）。
								runtimeRevision: requireSafeCounter(agent.runtime_revision, 1),
								status: agent.status,
								desiredState: agent.desired_state,
								serviceAvailability: agent.service_availability,
								workloadRevision: requireSafeCounter(
									agent.workload_revision,
									1,
								),
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
						// A Sandbox prepared for an earlier Runtime or Workload
						// revision cannot serve this Turn. Keep it waiting without
						// reserving capacity; never write unknown for work that is
						// not going to be sent (HLD §8.4).
						const binding = state.conversation.sandbox;
						const [allocation] = binding
							? await transaction<{ resource_policy: unknown }[]>`
								select resource_policy from platform.session_sandbox_allocations
								where sandbox_id = ${binding.sandboxId}
									and conversation_id = ${binding.sessionId}
									and session_generation = ${binding.generation}
							`
							: [];
						let sandboxCurrent: boolean;
						try {
							sandboxCurrent =
								!!binding &&
								isSessionSandboxPolicyCurrentV1({
									agentId: input.claim.agentId,
									policy: (allocation?.resource_policy ?? null) as Parameters<
										typeof isSessionSandboxPolicyCurrentV1
									>[0]["policy"],
									runtimeRevision: requireSafeCounter(
										agent.runtime_revision,
										1,
									),
									managementFence: requireSafeCounter(agent.fence, 1),
									lifecycleRevision: requireSafeCounter(
										agent.workload_revision,
										1,
									),
									workloadState: agent.state,
								});
						} catch {
							throw new DispatchCapacityUnavailable("capacity_unavailable");
						}
						if (!sandboxCurrent)
							throw new DispatchCapacityUnavailable("sandbox_wait");
						const original = await originalOperationBinding(
							transaction,
							state,
							input.claim,
						);
						if (
							!original ||
							(workload.verified?.configuration.source.kind === "standard"
								? original.runtimeSubmitProtocol !== "v4" &&
									!(
										input.claim.channelId === "web" &&
										original.runtimeSubmitProtocol === "v2"
									)
								: original.runtimeSubmitProtocol !== "v2")
						)
							throw new DispatchCapacityUnavailable("capacity_unavailable");
						const rows = await transaction<{ execution_id: string }[]>`
					update platform.conversation_executions
					set status = 'unknown', runtime_submit_protocol = ${original.runtimeSubmitProtocol},
						original_operation_digest = ${original.originalOperationDigest},
						original_submit_host_session_ref = ${original.originalSubmitHostSessionRef},
						updated_at = clock_timestamp()
					where execution_id = ${input.claim.executionId}
						and conversation_id = ${input.claim.conversationId}
						and session_generation = ${input.claim.sessionGeneration}
						and delivery_fence = ${input.claim.executionDeliveryFence}
						and status = ${state.execution.status}
						and runtime_submit_protocol is not distinct from ${state.execution.runtime_submit_protocol}
						and original_operation_digest is not distinct from ${state.execution.original_operation_digest}
						and original_submit_host_session_ref is not distinct from ${state.execution.original_submit_host_session_ref}
					returning execution_id
				`;
						if (rows.length !== 1) throw new StaleDispatchLease();
						await recordTaskStatus(
							transaction,
							state,
							"unknown",
							input.claim.leaseOwner,
						);
					}
					await renewLease(transaction, input.claim, input.leaseDurationMs);
				},
			);
			if (releasedForStopChange) return "stop_changed";
			return prepared && !settledWaiting;
		} catch (error) {
			if (error instanceof DispatchCapacityUnavailable) return error.outcome;
			throw error;
		}
	}

	/**
	 * Undo prepareRuntimeDispatch's unknown write-ahead for a Turn whose Runtime
	 * request was provably never sent. Only the same lease and delivery fence may
	 * do this; the pinned original operation stays authoritative for the retry.
	 */
	async releaseUnsentDispatch(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly retryDelayMs: number;
		readonly errorCode: string;
	}): Promise<boolean> {
		requireClaim(input.claim);
		const recoveringUnacceptedTurn =
			input.claim.executionStatus === "unknown" &&
			!input.claim.metadataRecovery &&
			isExecutionOperation(input.claim.operation);
		const original = recoveringUnacceptedTurn
			? input.claim.taskWaitOrder === undefined
				? "submitted"
				: "waiting"
			: input.claim.executionStatus;
		if (
			input.claim.metadataRecovery ||
			!isExecutionOperation(input.claim.operation) ||
			(!recoveringUnacceptedTurn &&
				input.claim.executionStatus !== "submitted" &&
				input.claim.executionStatus !== "waiting") ||
			!Number.isSafeInteger(input.retryDelayMs) ||
			input.retryDelayMs < 0 ||
			input.retryDelayMs > 86_400_000 ||
			!symbolicCode.test(input.errorCode)
		)
			throw new TypeError("Conversation dispatch release is invalid");
		return transactionResult(this.#client, async (transaction) => {
			// 请求确实没有发出，stop 在认领之后才被受理不影响这个事实：放开 stop 比较，
			// 否则释放失败，条目一直持有租约，stop 工作项只能等它到期（#2534）。
			const state = await ownedState(transaction, input.claim, true);
			if (
				state?.execution.status !== "unknown" ||
				state.execution.last_runtime_cursor !== null ||
				state.conversation.host_session_ref !== input.claim.hostSessionRef
			)
				throw new StaleDispatchLease();
			const rows = await transaction<{ execution_id: string }[]>`
				update platform.conversation_executions
				set status = ${original}, updated_at = clock_timestamp()
				where execution_id = ${input.claim.executionId}
					and conversation_id = ${input.claim.conversationId}
					and session_generation = ${input.claim.sessionGeneration}
					and delivery_fence = ${input.claim.executionDeliveryFence}
					and status = 'unknown'
				returning execution_id
			`;
			if (rows.length !== 1) throw new StaleDispatchLease();
			state.execution.status = original;
			await recordTaskStatus(
				transaction,
				state,
				original,
				input.claim.leaseOwner,
			);
			await retryOutbox(
				transaction,
				state,
				input.claim,
				input.retryDelayMs,
				input.errorCode,
			);
		});
	}

	async cancelUnaccepted(input: {
		readonly claim: ConversationDispatchClaimV1;
	}): Promise<boolean> {
		requireClaim(input.claim);
		return transactionResult(this.#client, async (transaction) => {
			const state = await ownedState(transaction, input.claim);
			// stop 认领（授权被拒时 Core 用它本地取消，#2662）要结算的是原 Turn 的条目（#2674）。
			const turnOutbox =
				state && input.claim.operation === "conversation.turn.stop.v1"
					? await lockUnleasedExecutionOutbox(transaction, input.claim)
					: state?.outbox;
			const turnOperation = turnOutbox
				? operation(turnOutbox.operation)
				: undefined;
			const payload =
				turnOutbox && turnOperation && isExecutionOperation(turnOperation)
					? exactPayload(turnOutbox.payload, turnOperation)
					: undefined;
			const stop = state
				? await readStop(transaction, input.claim.executionId)
				: undefined;
			if (
				!state ||
				!turnOutbox ||
				!payload ||
				(state.execution.status !== "unknown" &&
					state.execution.status !== "submitted" &&
					state.execution.status !== "waiting") ||
				stop?.status !== "submitted"
			) {
				throw new StaleDispatchLease();
			}
			await cancelStoppedTurn(
				transaction,
				turnOutbox,
				state.conversation,
				state.execution,
				stop,
				payload,
			);
			await recordTaskStatus(
				transaction,
				state,
				"cancelled",
				input.claim.leaseOwner,
			);
		});
	}

	async cancelAccepted(input: {
		readonly claim: ConversationDispatchClaimV1;
	}): Promise<boolean> {
		requireClaim(input.claim);
		if (
			!isExecutionOperation(input.claim.operation) ||
			input.claim.executionDeliveryFence < 1
		)
			return false;
		return transactionResult(this.#client, async (transaction) => {
			const state = await ownedState(transaction, input.claim, true);
			if (!state) throw new StaleDispatchLease();
			await cancelAcceptedTurn(transaction, state, input.claim);
		});
	}

	async recordRuntimeResponse(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly hostSessionRef: string;
		readonly originalOperationAccepted?: true;
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
		if (
			input.originalOperationAccepted &&
			!isExecutionOperation(input.claim.operation)
		)
			throw new TypeError(
				"Only original executions can record Runtime acceptance",
			);
		return transactionResult(this.#client, async (transaction) => {
			// 提交/重新生成认领时没有 stop、现在有了：「Runtime 已受理这次提交」这个事实不受 stop
			// 影响，照常记录，让已经在重试的 stop 工作项把停止送到 Runtime。否则本次认领作废、
			// 租约一直占到期，stop 被拖约 40 秒后只能按已完成收口（#2675）。stop 认领仍严格比较。
			const state = await ownedState(
				transaction,
				input.claim,
				isExecutionOperation(input.claim.operation) && !input.claim.stopPending,
			);
			if (
				!state ||
				(state.conversation.host_session_ref !== null &&
					state.conversation.host_session_ref !== input.hostSessionRef)
			) {
				throw new StaleDispatchLease();
			}
			if (
				input.originalOperationAccepted &&
				state.execution.runtime_submit_protocol === "v4"
			) {
				// The owned original claim and pinned digest identify the accepted
				// operation. Never infer this fact from Conversation's current Host.
				const accepted = await transaction<{ execution_id: string }[]>`
					update platform.conversation_executions
					set accepted_original_host_session_ref = ${input.hostSessionRef}
					where execution_id = ${input.claim.executionId}
						and conversation_id = ${input.claim.conversationId}
						and session_generation = ${input.claim.sessionGeneration}
						and authorization_revision = ${input.claim.authorizationRevision}
						and runtime_submit_protocol = 'v4'
						and original_operation_digest = ${state.execution.original_operation_digest}
						and (original_submit_host_session_ref is null or original_submit_host_session_ref = ${input.hostSessionRef})
						and (accepted_original_host_session_ref is null or accepted_original_host_session_ref = ${input.hostSessionRef})
					returning execution_id
				`;
				if (accepted.length !== 1) throw new StaleDispatchLease();
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
			// 只有 RUNTIME_SESSION_BLOCKED 的 rejected 收敛会经 finish 把会话置为不可用（ADR-0029）；
			// 代次隔离走 confirmGenerationIsolation，不经过这里。两个条件同时满足才收敛，避免其他
			// 路径将来复用 unavailable 迁移时误终结本次 Execution 的补充指令与 stop。
			if (
				input.errorCode === "RUNTIME_SESSION_BLOCKED" &&
				input.transition.conversationStatus === "unavailable"
			)
				await settleUnacceptedExecutionWork(transaction, input.claim);
			// #3314：附件读取在原生副作用前被平台明确拒绝，初始 Turn 未被 Runtime 接受即失败
			// （HLD §8.1）：同一事务终结本次 Execution 的待处理补充指令与 stop，会话保持可用。
			if (
				input.errorCode === "RUNTIME_FILE_INPUT_REJECTED" &&
				isTurn(input.claim.operation) &&
				input.transition.executionStatus === "failed"
			)
				await settleUnacceptedExecutionWork(transaction, input.claim);
			if (
				input.claim.operation === "conversation.turn.stop.v1" &&
				input.status === "succeeded" &&
				!["completed", "failed", "cancelled"].includes(state.execution.status)
			)
				throw new StaleDispatchLease();
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
			if (
				input.claim.operation === "conversation.turn.stop.v1" &&
				input.status === "failed" &&
				input.errorCode === "RUNTIME_RECOVERY_TIMEOUT"
			) {
				const rows = await transaction<{ execution_id: string }[]>`
						update platform.conversation_stops
						set status = 'completed', updated_at = clock_timestamp()
						where execution_id = ${input.claim.executionId}
							and stop_request_id = ${input.claim.stopRequestId}
							and status = 'submitted'
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
		await databaseOperation(() => this.#client.end({ timeout: 5 }));
	}
}

export function openPostgresConversationDispatchStoreV1(
	options: PostgresConversationDispatchOptionsV1,
) {
	return new PostgresConversationDispatchStoreV1(options);
}

export { ConversationDispatchStoreError } from "./conversation-dispatch-common.js";
