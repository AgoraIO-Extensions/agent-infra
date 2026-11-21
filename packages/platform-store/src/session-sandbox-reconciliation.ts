import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	ExecutorInstanceAdoptionV2Schema,
	type ExecutorInstanceMutationV2,
	ExecutorInstanceStateV2Schema,
	executorInstanceAdoptionBytesV2,
	executorInstanceFactBytesV2,
	executorInstanceStartV2,
} from "@agent-infra/contracts/runtime";
import {
	type AgentWorkloadDesiredV1,
	validateAgentWorkloadDesiredV1,
} from "@agent-infra/contracts/workload";
import {
	type AgentManagementStateV1,
	canAdvanceSessionSandboxDeletionProgressV1,
	canDrainSessionSandboxComputeV1,
	canPrepareSessionSandboxReplacementV1,
	capturePersonalApiTaskAuthorizationBoundaryV1,
	captureTaskApplicationAuthorizationBoundaryV1,
	captureTaskAuthorizationBoundaryV1,
	decideSessionSandboxDrainObservationV1,
	decideSessionSandboxObservationV1,
	decideSessionSandboxRetryV1,
	isSessionSandboxDeletionProgressValidV1,
	isSessionSandboxNormalStartupV1,
	isTaskApiChannelV1,
	planSessionSandboxLostPodRecoveryTransitionV1,
	resolveCurrentPersonalApiUserV1,
	type SessionSandboxDeletionProgressV1,
	type SessionSandboxLifecycleV1,
	type SessionSandboxObservationV1,
	type SessionSandboxPolicyV1,
	type SessionSandboxReconciliationClaimV1,
	type SessionSandboxResourceIdentityV1,
	type SessionSandboxVerifiedPolicyV1,
	sessionSandboxReconcileProgressV1,
	shouldContinueSessionSandboxPreparationV1,
	type TaskApiChannelV1,
	type TaskAuthorizationBoundaryV1,
	type TaskUserDirectoryV1,
	transitionExecutorInstanceV2,
} from "@agent-infra/platform-core";
import type postgres from "postgres";
import { agentManagementStateJsonSql } from "./agent-management-state-sql.js";
import {
	readCurrentTaskApiUseGrantV1,
	readCurrentTaskApplicationV1,
} from "./application-task-authorization.js";
import { lockConversation, lockOutbox } from "./conversation-dispatch-sql.js";
import { readSessionExecutorInstanceStateV2 } from "./session-sandbox.js";
import {
	releaseSessionSandboxComputeBudgetV1,
	reserveSessionSandboxPreparationBudgetV1,
	SessionSandboxPreparationBudgetErrorV1,
} from "./session-sandbox-reserves.js";
import { decodePersistedWorkloadStateV1 } from "./workload-reconciliation.js";

type Transaction = postgres.TransactionSql;
/**
 * #3089：认领 Session Sandbox 准备任务时返回 null 的固定原因，只用于观测，不改变认领判定。
 */
export type SessionSandboxClaimWaitReasonV1 =
	| "intent_mismatch"
	| "lifecycle_stale"
	| "authorization_changed"
	| "agent_not_running"
	| "workload_not_ready"
	| "configuration_pending"
	| "capacity_mismatch"
	| SessionSandboxPreparationBudgetErrorV1["reason"]
	| "lease_ineligible"
	| "policy_changed";
export interface SandboxClaimRequest {
	readonly itemId: string;
	readonly workerId: string;
	readonly leaseDurationMs: number;
	/** 认领返回 null 时同步报告原因；只在认领路径上调用。 */
	readonly onWait?: (reason: SessionSandboxClaimWaitReasonV1) => void;
}

interface AllocationRow {
	resource_fence: string | number;
	desired_state: "running" | "stopped";
	status: string;
	resource_policy: SessionSandboxVerifiedPolicyV1 | null;
	resource_observation: SessionSandboxObservationV1 | null;
}

/** Reuses current Platform authority and the original governance -> Agent -> outbox lock order. */
async function lockedContext(
	transaction: Transaction,
	itemId: string,
	policy: SessionSandboxPolicyV1,
	directory: TaskUserDirectoryV1 | undefined,
	wait: (reason: SessionSandboxClaimWaitReasonV1) => void = () => {},
) {
	const waiting = (reason: SessionSandboxClaimWaitReasonV1) => {
		wait(reason);
		return null;
	};
	await transaction`select set_config('lock_timeout', '5s', true)`;
	const [hint] = await transaction<
		{ agent_id: string; actor_id: string; principal_type: string }[]
	>`
		select c.agent_id, c.actor_id, c.principal_type from platform.outbox_items o
		join platform.conversations c on c.id = o.scope_id
		where o.id = ${itemId} and o.scope_type = 'conversation' and o.operation = 'conversation.sandbox.reconcile.v1'`;
	if (!hint) return waiting("intent_mismatch");
	await transaction`lock table platform.platform_user_disables in share mode`;
	await transaction`select id from platform.platform_applications where id = ${hint.actor_id} and ${hint.principal_type} = 'application' for share`;
	await transaction`select principal_id from platform.agent_principal_grants where agent_id = ${hint.agent_id} and principal_type = ${hint.principal_type} and principal_id = ${hint.actor_id} for share`;
	// Sandbox policy 绑定 Runtime 修订：只改渠道的配置修订不阻止新 Sandbox 准备（ADR-0028）。
	const [agent] = await transaction<
		{ authorization_revision: string; runtime_revision: string }[]
	>`
		select a.authorization_revision, coalesce((select cr.runtime_revision from platform.agent_configuration_revisions cr
			where cr.agent_id = a.id and cr.revision = a.current_configuration_revision
		), a.current_configuration_revision)::text as runtime_revision
		from platform.agents a where a.id = ${hint.agent_id} for share of a`;
	await transaction`select id from platform.agent_applications where agent_id = ${hint.agent_id} for share`;
	await transaction`select owner_id from platform.agent_owners where agent_id = ${hint.agent_id} for share`;
	await transaction`select target_id from platform.agent_availability where agent_id = ${hint.agent_id} for share`;
	const [managementRow] = await transaction<
		{ management: AgentManagementStateV1 }[]
	>`
		select ${transaction.unsafe(agentManagementStateJsonSql("a"))} as management
		from platform.agent_applications a where a.agent_id = ${hint.agent_id}`;
	const management = managementRow?.management;
	const reclaimed =
		await transaction`select 1 from platform.audit_events j join platform.outbox_items o on o.scope_id=j.target_id where o.id=${itemId} and j.target_type='conversation' and j.action='conversation.workspace.reclamation.started'`;
	if (reclaimed.length) return waiting("intent_mismatch");
	const outbox = await lockOutbox(transaction, itemId);
	if (
		outbox?.operation !== "conversation.sandbox.reconcile.v1" ||
		outbox.scope_type !== "conversation"
	)
		return waiting("intent_mismatch");
	const conversation = await lockConversation(transaction, outbox.scope_id);
	const sandbox = conversation?.sandbox;
	if (
		!conversation ||
		!sandbox ||
		!agent ||
		!management ||
		sandbox.agentId !== hint.agent_id ||
		sandbox.principal.id !== hint.actor_id ||
		sandbox.principal.kind !== hint.principal_type
	)
		return waiting("intent_mismatch");
	const payload = outbox.payload;
	if (
		!payload ||
		typeof payload !== "object" ||
		Array.isArray(payload) ||
		!isDeepStrictEqual(
			Object.fromEntries(
				Object.entries(payload).filter(
					([key]) =>
						key !== "lifecycle" &&
						key !== "deployment" &&
						key !== "modelProjection",
				),
			),
			{
				schemaVersion: 1,
				conversationId: sandbox.sessionId,
				sessionGeneration: sandbox.generation,
			},
		)
	)
		return waiting("intent_mismatch");
	const [allocation] = await transaction<
		AllocationRow[]
	>`select resource_fence, desired_state, status, resource_policy, resource_observation
		from platform.session_sandbox_allocations where sandbox_id = ${sandbox.sandboxId} for update`;
	if (!allocation) return waiting("intent_mismatch");
	let lifecycle =
		(payload as { lifecycle?: SessionSandboxLifecycleV1 }).lifecycle ?? null;
	let preparationAllowed = false;
	if (lifecycle) {
		if (
			lifecycle.authority &&
			management.desiredState === "stopped" &&
			lifecycle.authority.targetDesiredState === "running" &&
			lifecycle.authority.applicationId === management.applicationId &&
			lifecycle.authority.managementFence <= management.fence
		) {
			lifecycle = {
				...lifecycle,
				authority: {
					...lifecycle.authority,
					managementRevision: management.revision,
					managementFence: management.fence,
					workloadRevision: management.workloadRevision,
					targetDesiredState: "stopped",
				},
			};
			await transaction`update platform.outbox_items
				set payload = payload || ${transaction.json({ lifecycle } as unknown as Parameters<typeof transaction.json>[0])},
					updated_at = clock_timestamp()
				where id = ${itemId}`;
		}
		const authority = lifecycle.authority;
		const source = lifecycle.source;
		if (
			lifecycle.schemaVersion !== 1 ||
			!authority ||
			!source ||
			authority.kind !== "management" ||
			authority.applicationId !== management.applicationId ||
			!Number.isSafeInteger(authority.managementRevision) ||
			management.revision < authority.managementRevision ||
			authority.managementFence !== management.fence ||
			authority.workloadRevision !== management.workloadRevision ||
			authority.targetDesiredState !== management.desiredState ||
			!isDeepStrictEqual(
				{ ...source.sandbox, generation: sandbox.generation },
				sandbox,
			) ||
			!Number.isSafeInteger(source.sandbox.generation) ||
			source.sandbox.generation > sandbox.generation ||
			!Number.isSafeInteger(source.resourceFence) ||
			source.resourceFence < 0 ||
			source.resourceFence >= Number(allocation.resource_fence) ||
			(source.policy && source.policy.namespace !== policy.namespace)
		)
			return waiting("lifecycle_stale");
		const executions = await transaction<
			{ status: string }[]
		>`select status from platform.conversation_executions where conversation_id = ${sandbox.sessionId}`;
		if (lifecycle.stopReceipt || lifecycle.sourceState === "never-prepared") {
			const pending =
				await transaction`select 1 from platform.conversation_generation_tombstones where conversation_id = ${sandbox.sessionId} and status = 'pending' limit 1`;
			if (
				(lifecycle.sourceState === "never-prepared" &&
					!lifecycle.preparation &&
					allocation.resource_policy !== null) ||
				!canPrepareSessionSandboxReplacementV1({
					sandbox,
					resourceFence: Number(allocation.resource_fence),
					lifecycle,
					observation: allocation.resource_observation,
					generationBarrierPending: pending.length > 0,
					executions,
				})
			)
				return waiting("lifecycle_stale");
			preparationAllowed = true;
		} else {
			if (
				!source.policy ||
				source.resourceFence < 1 ||
				allocation.desired_state !== "stopped" ||
				// A retained PVC may resume after the Agent configuration or Workload
				// revision advances. The stop receipt pins the source policy and the
				// adapter rechecks the current PVC spec, UID, ownership and fence before
				// rebinding; requiring byte-identical policies here made every legitimate
				// revision change permanently stale (#3340).
				!isDeepStrictEqual(source.observation, allocation.resource_observation)
			)
				return waiting("lifecycle_stale");
			const [control] = await transaction<
				{
					events_pending: boolean;
					executor_drain_pending: boolean;
				}[]
			>`
                select exists (
                    select 1 from platform.conversation_executions e
                    join platform.outbox_items o on o.scope_type = 'conversation'
                        and o.scope_id = e.conversation_id and o.payload->>'executionId' = e.execution_id
                    where e.conversation_id = ${sandbox.sessionId} and e.delivery_fence > 0
                        and e.status in ('completed', 'failed', 'cancelled')
                        and ${conversation.host_session_ref !== null}
                        and o.operation in ('conversation.turn.submit.v1', 'conversation.turn.regenerate.v1')
                        and o.status in ('pending', 'processing', 'retry_scheduled')
                        and not (o.payload ? 'metadataRecovery')
                ) as events_pending,
                exists (
                    select 1 from platform.conversation_stops s
                    join platform.conversation_executions e on e.execution_id = s.execution_id
                    where e.conversation_id = ${sandbox.sessionId}
                        and s.status = 'submitted' and s.executor_drain_required
                ) as executor_drain_pending
            `;
			return {
				outbox,
				sandbox,
				allocation,
				authorization: null,
				purpose: "drain" as const,
				lifecycle,
				drainComputeAllowed: canDrainSessionSandboxComputeV1(
					executions.map((execution) => execution.status),
					{
						eventsPending: control?.events_pending !== false,
						executorDrainPending: control?.executor_drain_pending !== false,
					},
				),
				policy: source.policy,
				deployment: null,
				modelProjection: null,
			};
		}
	}
	if (conversation.authorization_revision !== agent.authorization_revision)
		return waiting("authorization_changed");
	if (
		(allocation.desired_state !== "running" && !preparationAllowed) ||
		management.status !== "available" ||
		management.desiredState !== "running"
	)
		return waiting("agent_not_running");
	const [workload] = await transaction<
		{ state: unknown }[]
	>`select state from platform.workload_reconciliations where agent_id = ${sandbox.agentId} for share`;
	const decoded = decodePersistedWorkloadStateV1(
		workload?.state,
		sandbox.agentId,
	);
	if (!decoded || decoded.legacy) return waiting("workload_not_ready");
	const state = decoded.state;
	const verified = state.verified;
	if (!verified) return waiting("workload_not_ready");
	const deployment = validateAgentWorkloadDesiredV1(verified.deployment);
	if (
		state.phase !== "ready" ||
		state.verifiedRevision === null ||
		deployment.agentId !== sandbox.agentId ||
		deployment.desiredState !== "running" ||
		deployment.runtimeManifest.interactionMode !== "platform-adapter" ||
		// Two distinct revisions (#1480): the deployment is read from the verified
		// state itself (a rollback keeps its original Workload revision), and the
		// management lifecycle revision proves that state is still current.
		state.sourceLifecycleRevision !== management.workloadRevision
	)
		return waiting("workload_not_ready");
	const runtimeRevision = Number(agent.runtime_revision);
	if (
		state.sourceConfigurationRevision !== runtimeRevision ||
		verified.configuration.revision !== runtimeRevision ||
		deployment.configRevision !== runtimeRevision
	)
		return waiting("configuration_pending");
	if (
		verified.executionCapacity?.resourceConfigurationHash !==
		policy.resourceConfigurationHash
	)
		return waiting("capacity_mismatch");
	const common = {
		principal: sandbox.principal,
		agent: management,
		channelId: sandbox.channelId,
		agentAuthorizationRevision: agent.authorization_revision,
	};
	let authorization: TaskAuthorizationBoundaryV1 | null;
	if (sandbox.principal.kind === "application") {
		const application = await readCurrentTaskApplicationV1(transaction, {
			applicationId: sandbox.principal.id,
			agentId: sandbox.agentId,
		});
		authorization = application
			? captureTaskApplicationAuthorizationBoundaryV1({
					...common,
					application,
				})
			: null;
	} else {
		const disabled =
			await transaction`select user_id from platform.platform_user_disables where user_id = ${sandbox.principal.id}`;
		if (disabled.length) return waiting("authorization_changed");
		const user = await resolveCurrentPersonalApiUserV1(
			directory,
			sandbox.principal.id,
		);
		if (user.accountStatus !== "active")
			return waiting("authorization_changed");
		authorization = isTaskApiChannelV1(sandbox.channelId, sandbox.principal)
			? capturePersonalApiTaskAuthorizationBoundaryV1({
					...common,
					channelId: sandbox.channelId as TaskApiChannelV1,
					user,
					useGrant: await readCurrentTaskApiUseGrantV1(transaction, {
						principal: sandbox.principal,
						agentId: sandbox.agentId,
					}),
				})
			: captureTaskAuthorizationBoundaryV1({ ...common, user });
	}
	if (!authorization) return waiting("authorization_changed");
	const currentPolicy: SessionSandboxVerifiedPolicyV1 = {
		...policy,
		configurationRevision: runtimeRevision,
		workloadRevision: deployment.workloadRevision,
		managementFence: management.fence,
		imageDigest: deployment.imageDigest,
	};
	return {
		outbox,
		sandbox,
		allocation,
		authorization,
		policy: currentPolicy,
		deployment,
		// Passed through unchanged; the Worker admits only a keyless V4 projection.
		modelProjection: verified.modelProjection ?? null,
		purpose: "prepare" as const,
		lifecycle,
		drainComputeAllowed: false,
	};
}

/**
 * #2985：排空完成后 Agent 重启（替换准备未被认领）又再次停止，生命周期保留着原停止回执、
 * 目标又是 stopped。lockedContext 只为替换准备放行带回执的生命周期，这类条目会永远停在
 * pending。回执仍证明停止时（Core 判定通过、分配观测仍是回执保留的同一 PVC、没有进入准备）
 * 直接结束：条目 succeeded，分配 stopped。不触碰任何 Kubernetes 资源。
 */
async function settleRetainedStopReceipt(
	transaction: Transaction,
	itemId: string,
): Promise<boolean> {
	const [outbox] = await transaction<
		{ scope_id: string; payload: { lifecycle?: SessionSandboxLifecycleV1 } }[]
	>`
		select scope_id, payload from platform.outbox_items
		where id = ${itemId} and scope_type = 'conversation'
			and operation = 'conversation.sandbox.reconcile.v1'
			and status in ('pending', 'retry_scheduled')
		for update`;
	const lifecycle = outbox?.payload?.lifecycle;
	const receipt = lifecycle?.stopReceipt;
	if (
		!outbox ||
		!lifecycle ||
		!receipt ||
		lifecycle.schemaVersion !== 1 ||
		lifecycle.authority?.targetDesiredState !== "stopped" ||
		lifecycle.preparation
	)
		return false;
	const [allocation] = await transaction<
		{
			sandbox_id: string;
			agent_id: string;
			desired_state: string;
			resource_observation: SessionSandboxObservationV1 | null;
		}[]
	>`
		select sandbox_id, agent_id, desired_state, resource_observation
		from platform.session_sandbox_allocations where conversation_id = ${outbox.scope_id}
		for update`;
	if (
		allocation?.desired_state !== "stopped" ||
		allocation.sandbox_id !== receipt.sandboxId
	)
		return false;
	const [management] = await transaction<{ desired_state: string }[]>`
		select desired_state from platform.agent_applications where agent_id = ${allocation.agent_id}`;
	if (management?.desired_state !== "stopped") return false;
	const retained = receipt.retainedPVC ? [receipt.retainedPVC] : [];
	const observed = allocation.resource_observation;
	if (
		observed?.status !== "stopped" ||
		observed.resources.length !== retained.length ||
		!retained.every((pvc) =>
			observed.resources.some(
				(resource) =>
					resource.kind === pvc.kind &&
					resource.namespace === pvc.namespace &&
					resource.name === pvc.name &&
					resource.uid === pvc.uid,
			),
		) ||
		!decideSessionSandboxDrainObservationV1({
			sandbox: {
				...lifecycle.source.sandbox,
				generation: receipt.targetGeneration,
			},
			resourceFence: receipt.targetResourceFence,
			lifecycle,
			observation: {
				status: "stopped",
				resources: retained,
				sourceStop: receipt,
			},
		}).finished
	)
		return false;
	await transaction`update platform.outbox_items
		set status = 'succeeded', lease_owner = null, lease_expires_at = null,
			updated_at = clock_timestamp()
		where id = ${itemId}`;
	await transaction`update platform.session_sandbox_allocations
		set status = 'stopped', updated_at = clock_timestamp()
		where sandbox_id = ${allocation.sandbox_id}`;
	return true;
}

export async function claimSandboxReconciliation(
	transaction: Transaction,
	input: SandboxClaimRequest,
	policy: SessionSandboxPolicyV1,
	directory: TaskUserDirectoryV1 | undefined,
): Promise<
	| (SessionSandboxReconciliationClaimV1 & {
			readonly deployment: AgentWorkloadDesiredV1 | null;
	  })
	| null
> {
	const wait = input.onWait ?? (() => {});
	// Stale discovery/commit wakeups must not reacquire Agent FOR SHARE while
	// Workload reconciliation needs FOR UPDATE to make this Sandbox ready.
	const [discovered] = await transaction<{ eligible: boolean }[]>`select
		(status in ('pending','retry_scheduled') and available_at <= clock_timestamp()) or
		(status = 'processing' and lease_expires_at <= clock_timestamp()) as eligible
		from platform.outbox_items where id = ${input.itemId}
			and scope_type = 'conversation' and operation = 'conversation.sandbox.reconcile.v1'`;
	if (!discovered?.eligible) {
		wait(discovered ? "lease_ineligible" : "intent_mismatch");
		return null;
	}
	let waitingForWorkload = false;
	const context = await lockedContext(
		transaction,
		input.itemId,
		policy,
		directory,
		(reason) => {
			waitingForWorkload =
				reason === "workload_not_ready" || reason === "configuration_pending";
			wait(reason);
		},
	);
	if (!context) {
		if (waitingForWorkload) {
			// The outbox is already locked. Preserve the original operation/fences
			// and defer only an eligible delivery, never a live lease or later retry.
			await transaction`update platform.outbox_items
				set status = case when status = 'processing' then 'retry_scheduled' else status end,
					available_at = clock_timestamp() + interval '1 second',
					lease_owner = null, lease_expires_at = null, updated_at = clock_timestamp()
				where id = ${input.itemId} and (
					(status in ('pending', 'retry_scheduled') and available_at <= clock_timestamp())
					or (status = 'processing' and lease_expires_at <= clock_timestamp()))`;
		} else await settleRetainedStopReceipt(transaction, input.itemId);
		return null;
	}
	const { outbox, sandbox, allocation, authorization } = context;
	const [lease] = await transaction<{ eligible: boolean }[]>`select
		(status in ('pending','retry_scheduled') and available_at <= clock_timestamp()) or
		(status = 'processing' and lease_expires_at <= clock_timestamp()) as eligible
		from platform.outbox_items where id = ${input.itemId}`;
	if (!lease?.eligible) {
		wait("lease_ineligible");
		return null;
	}
	if (
		allocation.resource_policy &&
		!isDeepStrictEqual(allocation.resource_policy, context.policy) &&
		!(
			context.purpose === "prepare" &&
			context.lifecycle?.stopReceipt &&
			allocation.desired_state === "stopped"
		)
	) {
		wait("policy_changed");
		return null;
	}
	if (context.purpose === "prepare") {
		try {
			await reserveSessionSandboxPreparationBudgetV1(
				transaction,
				sandbox.sandboxId,
				context.policy,
			);
		} catch (error) {
			if (!(error instanceof SessionSandboxPreparationBudgetErrorV1))
				throw error;
			const retryDelayMs = Math.max(1_000, error.retryDelayMs);
			await transaction`update platform.outbox_items
				set status = 'retry_scheduled',
					available_at = clock_timestamp() + (${retryDelayMs}::bigint * interval '1 millisecond'),
					lease_owner = null, lease_expires_at = null, updated_at = clock_timestamp()
				where id = ${input.itemId}`;
			wait(error.reason);
			return null;
		}
	}
	const resourceFence = Math.max(1, Number(allocation.resource_fence));
	const deliveryFence = Number(outbox.delivery_fence) + 1;
	if (
		!Number.isSafeInteger(resourceFence) ||
		!Number.isSafeInteger(deliveryFence)
	)
		throw new TypeError("Invalid Sandbox fence");
	const claimedLifecycle =
		context.purpose === "prepare" &&
		context.lifecycle &&
		(context.lifecycle.stopReceipt ||
			context.lifecycle.sourceState === "never-prepared")
			? {
					...context.lifecycle,
					preparation: { generation: sandbox.generation, resourceFence },
				}
			: context.lifecycle;
	if (!isDeepStrictEqual(claimedLifecycle, context.lifecycle)) {
		await transaction`update platform.outbox_items set payload = payload || ${transaction.json(
			{
				schemaVersion: 1,
				conversationId: sandbox.sessionId,
				sessionGeneration: sandbox.generation,
				lifecycle: claimedLifecycle,
			} as unknown as Parameters<typeof transaction.json>[0],
		)}
			where id = ${input.itemId}`;
	}
	if (context.purpose === "prepare") {
		await transaction`update platform.outbox_items set payload = payload || jsonb_build_object('deployment',
			${transaction.json(context.deployment as unknown as Parameters<typeof transaction.json>[0])}::jsonb,
			'modelProjection', ${transaction.json(context.modelProjection as Parameters<typeof transaction.json>[0])}::jsonb) where id = ${input.itemId}`;
	}
	await transaction`update platform.outbox_items set status = 'processing', lease_owner = ${input.workerId},
		lease_expires_at = clock_timestamp() + (${input.leaseDurationMs}::bigint * interval '1 millisecond'),
		delivery_fence = ${deliveryFence}, attempt_count = attempt_count + 1, updated_at = clock_timestamp() where id = ${input.itemId}`;
	await transaction`update platform.session_sandbox_allocations set resource_fence = ${resourceFence}, desired_state = ${context.purpose === "prepare" ? "running" : "stopped"}, resource_policy = ${transaction.json(context.policy as unknown as Parameters<typeof transaction.json>[0])},
		status = case when status = 'unknown' then 'unknown' else 'applying' end, updated_at = clock_timestamp() where sandbox_id = ${sandbox.sandboxId}`;
	return {
		schemaVersion: 1,
		operation: "conversation.sandbox.reconcile.v1",
		execution: null,
		itemId: input.itemId,
		leaseOwner: input.workerId,
		deliveryFence,
		attemptCount: Number(context.outbox.attempt_count) + 1,
		sandbox,
		resourceFence,
		resourceStatus: allocation.status === "unknown" ? "unknown" : "applying",
		desiredState: context.purpose === "prepare" ? "running" : "stopped",
		authorization,
		purpose: context.purpose,
		lifecycle: claimedLifecycle,
		drainComputeAllowed: context.drainComputeAllowed,
		policy: context.policy,
		deployment: context.deployment,
		modelProjection: context.modelProjection,
		previousObservation: allocation.resource_observation,
	};
}

async function ownedContext(
	transaction: Transaction,
	claim: SessionSandboxReconciliationClaimV1,
	policy: SessionSandboxPolicyV1,
	directory: TaskUserDirectoryV1 | undefined,
) {
	if (
		claim.schemaVersion !== 1 ||
		claim.operation !== "conversation.sandbox.reconcile.v1" ||
		claim.execution !== null
	)
		return null;
	const context = await lockedContext(
		transaction,
		claim.itemId,
		policy,
		directory,
	);
	const lifecycleMatchesClaim =
		isDeepStrictEqual(context?.lifecycle, claim.lifecycle) ||
		(context?.lifecycle?.resumeRequested !== claim.lifecycle?.resumeRequested &&
			context?.lifecycle &&
			claim.lifecycle &&
			isDeepStrictEqual(
				{ ...context.lifecycle, resumeRequested: undefined },
				{ ...claim.lifecycle, resumeRequested: undefined },
			));
	if (
		context?.outbox.status !== "processing" ||
		context.outbox.lease_owner !== claim.leaseOwner ||
		Number(context.outbox.delivery_fence) !== claim.deliveryFence ||
		!context.outbox.lease_expires_at ||
		context.outbox.lease_expires_at <= context.outbox.decision_at ||
		Number(context.allocation.resource_fence) !== claim.resourceFence ||
		context.allocation.desired_state !== claim.desiredState ||
		context.allocation.status !== claim.resourceStatus ||
		!isDeepStrictEqual(
			context.allocation.resource_observation,
			claim.previousObservation,
		) ||
		!isDeepStrictEqual(context.sandbox, claim.sandbox) ||
		context.purpose !== claim.purpose ||
		context.drainComputeAllowed !== claim.drainComputeAllowed ||
		!lifecycleMatchesClaim ||
		!isDeepStrictEqual(context.authorization, claim.authorization) ||
		!isDeepStrictEqual(context.policy, claim.policy) ||
		!isDeepStrictEqual(context.deployment, claim.deployment) ||
		!isDeepStrictEqual(context.modelProjection, claim.modelProjection) ||
		!isDeepStrictEqual(context.allocation.resource_policy, claim.policy)
	)
		return null;
	// Authority may require an external directory lookup after the outbox lock.
	// Its original decision_at cannot authorize a write after that lease expires.
	const [lease] = await transaction<{ current: boolean }[]>`
		select lease_expires_at > clock_timestamp() as current
		from platform.outbox_items where id = ${claim.itemId}
	`;
	if (!lease?.current) return null;
	return context;
}

export async function prepareSandboxReconciliation(
	transaction: Transaction,
	claim: SessionSandboxReconciliationClaimV1,
	leaseDurationMs: number,
	policy: SessionSandboxPolicyV1,
	directory: TaskUserDirectoryV1 | undefined,
): Promise<boolean> {
	if (!(await ownedContext(transaction, claim, policy, directory)))
		return false;
	const renewed = await transaction`update platform.outbox_items
		set lease_expires_at = clock_timestamp() + (${leaseDurationMs}::bigint * interval '1 millisecond')
		where id = ${claim.itemId} and lease_expires_at > clock_timestamp() returning id`;
	return renewed.length === 1;
}

export async function readSandboxExecutorInstanceV2(
	transaction: Transaction,
	claim: SessionSandboxReconciliationClaimV1,
) {
	const source =
		claim.purpose === "drain" ? claim.lifecycle?.source : undefined;
	return readSessionExecutorInstanceStateV2(
		transaction,
		source?.sandbox ?? claim.sandbox,
		source?.resourceFence ?? claim.resourceFence,
		source?.policy?.namespace ?? claim.policy.namespace,
	);
}

export async function transitionSandboxExecutorInstance(
	transaction: Transaction,
	claim: SessionSandboxReconciliationClaimV1,
	mutation: ExecutorInstanceMutationV2,
	policy: SessionSandboxPolicyV1,
	directory: TaskUserDirectoryV1 | undefined,
) {
	await transaction`select pg_advisory_xact_lock_shared(hashtextextended(${`agent-infra/executor-instance-v2/${policy.namespace}`},0))`;
	const context = await ownedContext(transaction, claim, policy, directory);
	if (
		!context ||
		(context.purpose !== "prepare" && mutation.kind === "prepare")
	)
		return null;
	const state = await readSandboxExecutorInstanceV2(transaction, claim);
	if (
		context.purpose === "drain" &&
		(!(
			[
				"read",
				"published",
				"cleanup-request",
				"cleanup-absent",
				"seal",
				"retirement-progress",
				"retired",
			] as readonly string[]
		).includes(mutation.kind) ||
			(mutation.kind === "published" && state?.phase !== "closing"))
	)
		return null;
	if (mutation.kind === "prepare" && !state) {
		const [legacy] = await transaction<
			{ present: boolean }[]
		>`select exists(select 1 from platform.conversation_audit_events where conversation_id=${claim.sandbox.sessionId}
		 and details->>'checkpoint'='executor-startup' and details->>'sandboxId'=${claim.sandbox.sandboxId}
		 and details->>'sessionGeneration'=${String(claim.sandbox.generation)} and details->>'resourceFence'=${String(claim.resourceFence)}) as present`;
		if (
			legacy?.present ||
			context.allocation.resource_observation?.resources.some(
				(r) => r.kind === "Pod",
			)
		)
			return null;
	}
	const source =
		context.purpose === "drain" ? context.lifecycle?.source : undefined;
	const sandbox = source?.sandbox ?? claim.sandbox;
	const fence = source?.resourceFence ?? claim.resourceFence;
	const verifiedPolicy = source?.policy ?? claim.policy;
	if (!verifiedPolicy) return null;
	const [clock] = await transaction<
		{ now: number; unresolved: boolean }[]
	>`select floor(extract(epoch from clock_timestamp())*1000)::float8 as now,
  (exists(select 1 from platform.conversation_executions e where e.sandbox_id=${sandbox.sandboxId} and
    (e.status in ('processing','unknown') or e.status='submitted' and (e.original_operation_digest is not null or e.accepted_original_host_session_ref is not null)))
   or exists(select 1 from platform.conversation_stops s join platform.conversation_executions e on e.execution_id=s.execution_id
    where e.sandbox_id=${sandbox.sandboxId} and s.status<>'completed')) as unresolved`;
	if (!clock) return null;
	if (mutation.kind === "bind" && state) {
		const [old] = await transaction<
			{ present: boolean }[]
		>`select exists(select 1 from platform.conversation_audit_events
		 where conversation_id=${sandbox.sessionId} and details->>'checkpoint'='executor-instance-v2'
		 and details->'state'->>'podUid'=${mutation.podUid} and details->'state'->>'attemptId'<>${state.attemptId}) as present`;
		if (old?.present) return null;
	}
	let proofVerified = false;
	if (
		mutation.kind === "adopted" &&
		state?.delivery &&
		state.podUid &&
		state.recordRef
	) {
		const proof = ExecutorInstanceAdoptionV2Schema.parse(mutation.proof);
		const fact = executorInstanceStartV2(state);
		if (
			proof.challenge === state.delivery.challenge &&
			proof.podUid === state.podUid &&
			proof.attemptId === state.attemptId &&
			proof.recordRef === state.recordRef &&
			proof.startupRef === state.startupRef &&
			proof.bindingDigest === state.bindingDigest &&
			proof.generation === state.generation &&
			proof.resourceFence === state.resourceFence &&
			proof.factDigest ===
				createHash("sha256")
					.update(executorInstanceFactBytesV2(fact))
					.digest("hex")
		) {
			try {
				proofVerified = verify(
					null,
					Buffer.from(executorInstanceAdoptionBytesV2(proof)),
					createPublicKey({
						key: Buffer.from(state.delivery.hostPublicKey, "base64url"),
						format: "der",
						type: "spki",
					}),
					Buffer.from(proof.signature, "base64url"),
				);
			} catch {
				proofVerified = false;
			}
		}
	}
	const decision = transitionExecutorInstanceV2({
		state,
		mutation,
		authority: {
			namespace: verifiedPolicy.namespace,
			podName: sandbox.resourceName,
			sandboxId: sandbox.sandboxId,
			generation: sandbox.generation,
			resourceFence: fence,
			configurationRevision: verifiedPolicy.configurationRevision,
			imageDigest: verifiedPolicy.imageDigest,
			now: clock.now,
			hasUnresolvedExecution: clock.unresolved,
			proofVerified,
		},
	});
	if (!decision) return null;
	let currentClaim = claim;
	if (
		context.purpose === "prepare" &&
		(decision.clearReady ||
			(mutation.kind === "retired" && decision.state.phase === "retired"))
	) {
		const { executorInstance: _previousInstance, ...previousObservation } =
			context.allocation.resource_observation ?? { resources: [] };
		void _previousInstance;
		const observation: SessionSandboxObservationV1 = {
			...previousObservation,
			status: "unknown" as const,
			...(mutation.kind === "retired"
				? {
						resources: (
							context.allocation.resource_observation?.resources ?? []
						).filter((r) => r.kind === "PersistentVolumeClaim"),
					}
				: {}),
		};

		await transaction`update platform.session_sandbox_allocations set status='unknown',resource_observation=${transaction.json(observation as unknown as Parameters<typeof transaction.json>[0])},updated_at=clock_timestamp() where sandbox_id=${sandbox.sandboxId} and resource_fence=${fence}`;
		currentClaim = {
			...claim,
			resourceStatus: "unknown",
			previousObservation: observation,
		};
	}
	if (!isDeepStrictEqual(state, decision.state)) {
		const next = ExecutorInstanceStateV2Schema.parse(decision.state);
		const recordId =
			mutation.kind === "bind" && !state?.recordRef
				? (next.recordRef ?? randomUUID())
				: randomUUID();
		await transaction`insert into platform.conversation_audit_events (id,conversation_id,execution_id,agent_id,actor_id,action,trace_id,request_id,occurred_at,details)
   values (${recordId},${sandbox.sessionId},null,${sandbox.agentId},${sandbox.principal.id},'conversation.sandbox.observed',${context.outbox.trace_id},${context.outbox.request_id},clock_timestamp(),${transaction.json({ checkpoint: "executor-instance-v2", sandboxId: sandbox.sandboxId, sessionGeneration: sandbox.generation, resourceFence: fence, state: next } as unknown as Parameters<typeof transaction.json>[0])})`;
		if (mutation.kind === "prepare")
			await transaction`insert into platform.conversation_audit_events (id,conversation_id,execution_id,agent_id,actor_id,action,trace_id,request_id,occurred_at,details)
   values (${randomUUID()},${sandbox.sessionId},null,${sandbox.agentId},${sandbox.principal.id},'conversation.sandbox.observed',${context.outbox.trace_id},${context.outbox.request_id},clock_timestamp(),${transaction.json({ checkpoint: "executor-startup", startupRef: next.startupRef, deadlineMs: next.expiresAt, sandboxId: sandbox.sandboxId, sessionGeneration: sandbox.generation, resourceFence: fence, schemaVersion: 2 })})`;
	}
	return {
		state: decision.state,
		permit: decision.permit,
		claim: currentClaim,
	};
}

/** Freeze the projection and deadline before the first Kubernetes side effect. */
export async function recordSandboxExecutorStartup(
	transaction: Transaction,
	claim: SessionSandboxReconciliationClaimV1,
	startupRef: string,
	timeoutMs: number,
	policy: SessionSandboxPolicyV1,
	directory: TaskUserDirectoryV1 | undefined,
): Promise<number | null> {
	if (
		startupRef !==
			`${claim.sandbox.resourceName}-executor-${claim.resourceFence}` ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1000 ||
		timeoutMs > 900_000
	)
		throw new TypeError("Invalid executor startup authorization");
	const context = await ownedContext(transaction, claim, policy, directory);
	if (context?.purpose !== "prepare") return null;
	const [existing] = await transaction<
		{ details: { startupRef?: string; deadlineMs?: number } }[]
	>`
		select details from platform.conversation_audit_events
		where conversation_id = ${claim.sandbox.sessionId}
			and action = 'conversation.sandbox.observed'
			and details->>'checkpoint' = 'executor-startup'
			and details->>'sandboxId' = ${claim.sandbox.sandboxId}
			and details->>'sessionGeneration' = ${String(claim.sandbox.generation)}
			and details->>'resourceFence' = ${String(claim.resourceFence)}
		order by occurred_at desc, id desc limit 1
	`;
	if (existing) {
		const deadline = existing.details.deadlineMs;
		if (
			existing.details.startupRef !== startupRef ||
			typeof deadline !== "number" ||
			!Number.isSafeInteger(deadline) ||
			deadline < 1
		)
			return null;
		return deadline;
	}
	const [clock] = await transaction<{ deadline_ms: number }[]>`
		select floor(extract(epoch from clock_timestamp()) * 1000)::float8 + ${timeoutMs}::float8 as deadline_ms
	`;
	const deadline = clock?.deadline_ms;
	if (typeof deadline !== "number" || !Number.isSafeInteger(deadline))
		return null;
	await transaction`
		insert into platform.conversation_audit_events
			(id, conversation_id, execution_id, agent_id, actor_id, action, trace_id, request_id, occurred_at, details)
		values
			(${randomUUID()}, ${claim.sandbox.sessionId}, null, ${claim.sandbox.agentId}, ${claim.sandbox.principal.id},
			'conversation.sandbox.observed', ${context.outbox.trace_id}, ${context.outbox.request_id},
			clock_timestamp(), ${transaction.json({
				checkpoint: "executor-startup",
				startupRef,
				deadlineMs: deadline,
				sandboxId: claim.sandbox.sandboxId,
				sessionGeneration: claim.sandbox.generation,
				resourceFence: claim.resourceFence,
			})})
	`;
	return deadline;
}

async function readExecutorStartupRetirement(
	transaction: Transaction,
	claim: SessionSandboxReconciliationClaimV1,
) {
	const [entry] = await transaction<
		{ resources: SessionSandboxResourceIdentityV1[] }[]
	>`
		select details->'resources' as resources from platform.conversation_audit_events
		where conversation_id = ${claim.sandbox.sessionId}
			and action = 'conversation.sandbox.observed'
			and details->>'checkpoint' = 'executor-startup-retirement'
			and details->>'sandboxId' = ${claim.sandbox.sandboxId}
			and details->>'sessionGeneration' = ${String(claim.sandbox.generation)}
			and details->>'resourceFence' = ${String(claim.resourceFence)}
		order by occurred_at desc, id desc limit 1
	`;
	return entry?.resources ?? null;
}

export async function hasSandboxExecutorRetirement(
	transaction: Transaction,
	claim: SessionSandboxReconciliationClaimV1,
	policy: SessionSandboxPolicyV1,
	directory: TaskUserDirectoryV1 | undefined,
) {
	const context = await ownedContext(transaction, claim, policy, directory);
	if (!context || context.purpose !== "prepare")
		throw new Error("Executor startup lease is unavailable");
	return (await readExecutorStartupRetirement(transaction, claim)) !== null;
}

export async function recordSandboxExecutorRetirement(
	transaction: Transaction,
	claim: SessionSandboxReconciliationClaimV1,
	resources: readonly SessionSandboxResourceIdentityV1[],
	policy: SessionSandboxPolicyV1,
	directory: TaskUserDirectoryV1 | undefined,
) {
	const context = await ownedContext(transaction, claim, policy, directory);
	if (
		!context ||
		context.purpose !== "prepare" ||
		context.allocation.resource_observation?.status === "ready"
	)
		return null;
	const [priorAdmission] = await transaction<{ ready: boolean }[]>`
		select exists (
			select 1 from platform.conversation_audit_events
			where conversation_id = ${claim.sandbox.sessionId}
				and action = 'conversation.sandbox.observed'
				and details->>'status' = 'ready'
				and details->>'sandboxId' = ${claim.sandbox.sandboxId}
				and details->>'sessionGeneration' = ${String(claim.sandbox.generation)}
				and details->>'resourceFence' = ${String(claim.resourceFence)}
		) as ready
	`;
	if (priorAdmission?.ready) return null;
	// A claimed executor reserve keeps its original deadline for first consumption
	// only; a later NotReady is a promotion failure, never startup-timeout retirement.
	const [expired] = await transaction<
		{ expired: boolean; source: string | null }[]
	>`
		select (details->>'deadlineMs')::numeric <= extract(epoch from clock_timestamp()) * 1000 as expired,
			details->>'source' as source
		from platform.conversation_audit_events
		where conversation_id = ${claim.sandbox.sessionId}
			and action = 'conversation.sandbox.observed'
			and details->>'checkpoint' = 'executor-startup'
			and details->>'sandboxId' = ${claim.sandbox.sandboxId}
			and details->>'sessionGeneration' = ${String(claim.sandbox.generation)}
			and details->>'resourceFence' = ${String(claim.resourceFence)}
		order by occurred_at desc, id desc limit 1
	`;
	if (
		!expired?.expired ||
		expired.source === "reserve" ||
		resources.length > 2 ||
		new Set(resources.map(({ kind }) => kind)).size !== resources.length ||
		resources.some(
			({ kind, name, namespace, uid, resourceVersion }) =>
				(kind !== "Pod" && kind !== "Service") ||
				name !== claim.sandbox.resourceName ||
				namespace !== claim.policy.namespace ||
				!uid ||
				!resourceVersion,
		)
	)
		return null;
	const original = await readExecutorStartupRetirement(transaction, claim);
	if (original)
		return resources.every((current) =>
			original.some(
				(item) => item.kind === current.kind && item.uid === current.uid,
			),
		)
			? original
			: null;
	await transaction`
		insert into platform.conversation_audit_events
			(id, conversation_id, execution_id, agent_id, actor_id, action, trace_id, request_id, occurred_at, details)
		values
			(${randomUUID()}, ${claim.sandbox.sessionId}, null, ${claim.sandbox.agentId}, ${claim.sandbox.principal.id},
			'conversation.sandbox.observed', ${context.outbox.trace_id}, ${context.outbox.request_id},
			clock_timestamp(), ${transaction.json({
				checkpoint: "executor-startup-retirement",
				sandboxId: claim.sandbox.sandboxId,
				sessionGeneration: claim.sandbox.generation,
				resourceFence: claim.resourceFence,
				resources: [...resources],
			} as unknown as Parameters<typeof transaction.json>[0])})
	`;
	return resources;
}

/** Persist the delete intent/attempt before or after the Kubernetes call and refresh the claim. */
export async function recordSandboxDeletionProgress(
	transaction: Transaction,
	claim: SessionSandboxReconciliationClaimV1,
	progress: SessionSandboxDeletionProgressV1,
	leaseDurationMs: number,
	policy: SessionSandboxPolicyV1,
	directory: TaskUserDirectoryV1 | undefined,
): Promise<
	| {
			readonly status: "committed";
			readonly claim: SessionSandboxReconciliationClaimV1;
	  }
	| { readonly status: "stale" | "unknown" }
> {
	const context = await ownedContext(transaction, claim, policy, directory);
	const source = context?.lifecycle?.source;
	const valid =
		!!context &&
		context.purpose === "drain" &&
		context.drainComputeAllowed &&
		!!context.lifecycle &&
		!context.lifecycle.stopReceipt &&
		!context.lifecycle.preparation &&
		isSessionSandboxDeletionProgressValidV1([progress]) &&
		!!source?.observation?.resources.some(
			(resource) =>
				resource.kind === progress.resource.kind &&
				resource.namespace === progress.resource.namespace &&
				resource.name === progress.resource.name &&
				resource.uid === progress.resource.uid,
		) &&
		progress.sourceGeneration === source.sandbox.generation &&
		progress.resourceFence === source.resourceFence &&
		progress.managementFence <= context.lifecycle.authority.managementFence;
	if (!valid || !context?.lifecycle) return { status: "stale" };
	const existing = context.lifecycle.deletionProgress ?? [];
	const previous = existing.find(
		(entry) => entry.resource.kind === progress.resource.kind,
	);
	if (
		(!previous &&
			(progress.managementFence !==
				context.lifecycle.authority.managementFence ||
				!source?.observation?.resources.some(
					(resource) =>
						resource.kind === progress.resource.kind &&
						resource.resourceVersion ===
							progress.preconditions.resourceVersion &&
						resource.controllerUid === progress.resource.controllerUid,
				))) ||
		(previous &&
			previous.deleteAttemptId !== progress.deleteAttemptId &&
			progress.managementFence !==
				context.lifecycle.authority.managementFence) ||
		!canAdvanceSessionSandboxDeletionProgressV1(previous, progress)
	)
		return { status: "stale" };
	const merged = [
		...existing.filter(
			(entry) => entry.resource.kind !== progress.resource.kind,
		),
		progress,
	];
	const lifecycle: SessionSandboxLifecycleV1 = {
		...context.lifecycle,
		deletionProgress: merged,
	};
	const updated = await transaction`update platform.outbox_items
		set payload = payload || ${transaction.json({
			schemaVersion: 1,
			conversationId: claim.sandbox.sessionId,
			sessionGeneration: claim.sandbox.generation,
			lifecycle,
		} as unknown as Parameters<
			typeof transaction.json
		>[0])} , lease_expires_at = clock_timestamp() + (${leaseDurationMs}::bigint * interval '1 millisecond'),
		updated_at = clock_timestamp()
		where id = ${claim.itemId} and status = 'processing'
			and lease_owner = ${claim.leaseOwner}
			and delivery_fence = ${claim.deliveryFence}
			and lease_expires_at > clock_timestamp()
		returning id`;
	if (updated.length !== 1) return { status: "stale" };
	if (previous && previous.deleteAttemptId !== progress.deleteAttemptId) {
		// Keep the superseded failure in the same transaction as the new active intent.
		await transaction`insert into platform.conversation_audit_events
            (id, conversation_id, execution_id, agent_id, actor_id, action, trace_id, request_id, occurred_at, details)
            values (${randomUUID()}, ${claim.sandbox.sessionId}, null, ${claim.sandbox.agentId}, ${claim.sandbox.principal.id},
                'conversation.sandbox.observed', ${context.outbox.trace_id}, ${context.outbox.request_id}, clock_timestamp(),
                ${transaction.json({
									checkpoint: "sandbox-deletion-attempt-replaced",
									sandboxId: claim.sandbox.sandboxId,
									sourceGeneration: progress.sourceGeneration,
									resourceFence: progress.resourceFence,
									previous,
									next: progress,
								} as unknown as Parameters<typeof transaction.json>[0])})`;
	}
	return {
		status: "committed",
		claim: { ...claim, lifecycle },
	};
}

export async function recordSandboxObservation(
	transaction: Transaction,
	claim: SessionSandboxReconciliationClaimV1,
	observation: SessionSandboxObservationV1,
	policy: SessionSandboxPolicyV1,
	directory: TaskUserDirectoryV1 | undefined,
): Promise<"committed" | "stale" | "unknown"> {
	const context = await ownedContext(transaction, claim, policy, directory);
	if (!context) return "stale";
	const instance = await readSandboxExecutorInstanceV2(transaction, claim);
	if (
		context.purpose === "drain" &&
		observation.status === "stopped" &&
		instance &&
		instance.phase !== "retired"
	)
		return "stale";
	if (
		observation.status === "ready" &&
		context.purpose === "prepare" &&
		instance
	) {
		if (
			instance.phase !== "adopted" ||
			!instance.adoption ||
			instance.cleanup !== "absent" ||
			observation.executorInstance?.attemptId !== instance.attemptId ||
			observation.executorInstance.startupRef !== instance.startupRef ||
			observation.executorInstance.podUid !== instance.podUid ||
			observation.executorInstance.epoch !== instance.adoption.epoch ||
			!observation.resources.some(
				(r) => r.kind === "Pod" && r.uid === instance.podUid,
			)
		)
			return "stale";
	}
	if (
		observation.status === "ready" &&
		context.purpose === "prepare" &&
		!instance
	) {
		if ((await readExecutorStartupRetirement(transaction, claim)) !== null)
			return "stale";
		if (context.allocation.resource_observation?.status !== "ready") {
			const [startup] = await transaction<
				{
					on_time: boolean;
					previously_ready: boolean;
					source: string | null;
					promoted: boolean;
				}[]
			>`
				select (s.details->>'deadlineMs')::numeric > extract(epoch from clock_timestamp()) * 1000 as on_time,
					exists (
						select 1 from platform.conversation_audit_events r
						where r.conversation_id = s.conversation_id
							and r.action = s.action
							and r.details->>'status' = 'ready'
							and r.details->>'sandboxId' = s.details->>'sandboxId'
							and r.details->>'sessionGeneration' = s.details->>'sessionGeneration'
							and r.details->>'resourceFence' = s.details->>'resourceFence'
							and extract(epoch from r.occurred_at) * 1000 < (s.details->>'deadlineMs')::numeric
					) as previously_ready,
					s.details->>'source' as source,
					exists (
						select 1 from platform.session_sandbox_executor_promotions p
						where p.sandbox_id = ${claim.sandbox.sandboxId}
							and p.conversation_id = ${claim.sandbox.sessionId}
							and p.session_generation = ${claim.sandbox.generation}
							and p.resource_fence = ${claim.resourceFence}
					) as promoted
				from platform.conversation_audit_events s
				where s.conversation_id = ${claim.sandbox.sessionId}
					and s.action = 'conversation.sandbox.observed'
					and s.details->>'checkpoint' = 'executor-startup'
					and s.details->>'sandboxId' = ${claim.sandbox.sandboxId}
					and s.details->>'sessionGeneration' = ${String(claim.sandbox.generation)}
					and s.details->>'resourceFence' = ${String(claim.resourceFence)}
				order by s.occurred_at desc, s.id desc limit 1
			`;
			// A claimed executor reserve becomes business-ready only after its
			// promotion receipt commits; its original startup deadline no longer applies.
			if (startup?.source === "reserve") {
				if (!startup.promoted) return "stale";
			} else if (
				observation.executorDrainRequired &&
				!startup?.on_time &&
				!startup?.previously_ready
			)
				return "stale";
		}
	}

	if (
		observation.status === "unknown" &&
		observation.failureCode === "sandbox.pod_lost" &&
		context.purpose === "prepare"
	) {
		const recovery = await requestSessionSandboxLostPodRecoveryV1(
			transaction,
			claim,
			context,
		);
		if (recovery) return recovery;
	}
	const decision =
		context.purpose === "drain" && context.lifecycle
			? decideSessionSandboxDrainObservationV1({
					sandbox: claim.sandbox,
					resourceFence: claim.resourceFence,
					lifecycle: context.lifecycle,
					observation:
						context.drainComputeAllowed || observation.status === "observed"
							? observation
							: { status: "unknown", resources: [] },
				})
			: decideSessionSandboxObservationV1(
					claim,
					context.allocation.resource_observation,
					observation,
				);
	const executorStartupRetired =
		observation.status === "unknown" &&
		observation.failureCode === "runtime.executor_identity_timeout" &&
		!observation.resources.some(
			({ kind }) => kind === "Pod" || kind === "Service",
		) &&
		context.purpose === "prepare" &&
		(await readExecutorStartupRetirement(transaction, claim)) !== null;
	const executorInstanceUnresolved =
		!!instance &&
		instance.phase !== "retired" &&
		observation.status === "unknown";
	const unknown = decision.status === "unknown";
	const continuePreparation =
		decision.finished &&
		context.purpose === "drain" &&
		!!context.lifecycle &&
		shouldContinueSessionSandboxPreparationV1(context.lifecycle);
	const stopReceipt = "stopReceipt" in decision ? decision.stopReceipt : null;
	let nextLifecycle: SessionSandboxLifecycleV1 | undefined;
	if (context.lifecycle && context.purpose === "drain") {
		nextLifecycle = {
			...context.lifecycle,
			source: stopReceipt
				? context.lifecycle.source
				: {
						...context.lifecycle.source,
						observation: decision.observation,
					},
			deletionProgress: context.lifecycle.deletionProgress ?? [],
			...(stopReceipt
				? {
						stopReceipt,
					}
				: {}),
		};
	}
	// 证据不变的重复观测不再每秒重试，也不再逐次写审计；条目仍保留到真正收敛（Spec §10.1.1）。
	// 停滞状态取自上一次“有变化”的审计行（指纹和当时的首次尝试次数），而不是写进 outbox
	// payload：旧版本 Worker 对 payload 做严格比较，多出的键会让回滚后的 Worker 认领不了
	// 这些条目。审计查询同时按 Sandbox 身份和 session generation 限定，替换后的 Sandbox
	// 不会继承上一代的指纹或退避。
	const terminal = decision.finished && !continuePreparation;
	const progress = sessionSandboxReconcileProgressV1({
		sandboxId: context.sandbox.sandboxId,
		sessionGeneration: context.sandbox.generation,
		resourceFence: claim.resourceFence,
		status: decision.status,
		finished: decision.finished,
		observation: decision.observation,
		deletionProgress: (nextLifecycle ?? context.lifecycle)?.deletionProgress,
		hasStopReceipt: Boolean((nextLifecycle ?? context.lifecycle)?.stopReceipt),
		// 用户消息重新打开空闲回收后，恢复请求本身必须让退避立即重新计时。
		resumeRequested: Boolean(
			(nextLifecycle ?? context.lifecycle)?.resumeRequested,
		),
	});
	const [lastChange] = await transaction<
		{
			progress: string | null;
			attempt: string | null;
			status: string | null;
			ageMs: number;
		}[]
	>`select details->>'progress' as progress, details->>'progressAttempt' as attempt,
		details->>'status' as status,
		extract(epoch from (clock_timestamp() - occurred_at)) * 1000 as "ageMs"
		from platform.conversation_audit_events
		where conversation_id = ${context.sandbox.sessionId}
			and action = 'conversation.sandbox.observed'
			and details ? 'progress'
			and details->>'sandboxId' = ${context.sandbox.sandboxId}
			and details->>'sessionGeneration' = ${String(context.sandbox.generation)}
			and details->>'resourceFence' = ${String(claim.resourceFence)}
		order by occurred_at desc, id desc limit 1`;
	const auditAgeMs = Number(lastChange?.ageMs);
	const retry = decideSessionSandboxRetryV1({
		previous: lastChange && {
			progress: lastChange.progress,
			attempt: lastChange.attempt === null ? null : Number(lastChange.attempt),
		},
		progress,
		attemptCount: Number(context.outbox.attempt_count),
		status: decision.status,
		normalPrepareAgeMs:
			claim.purpose === "prepare" &&
			claim.desiredState === "running" &&
			decision.status === "observed" &&
			isSessionSandboxNormalStartupV1(observation) &&
			observation.resources.length === 6 &&
			lastChange?.status === "observed" &&
			Number.isFinite(auditAgeMs) &&
			auditAgeMs >= 0
				? auditAgeMs
				: undefined,
	});
	const recorded = await transaction`update platform.outbox_items
		set payload = payload || ${transaction.json((nextLifecycle ? { lifecycle: nextLifecycle } : {}) as unknown as Parameters<typeof transaction.json>[0])},
		status = ${executorStartupRetired ? "failed" : terminal ? "succeeded" : "retry_scheduled"}, lease_owner = null, lease_expires_at = null,
		available_at = clock_timestamp() + (${terminal ? 1000 : retry.delayMs}::bigint * interval '1 millisecond'), updated_at = clock_timestamp()
		where id = ${claim.itemId} and status = 'processing'
			and lease_owner = ${claim.leaseOwner}
			and delivery_fence = ${claim.deliveryFence}
			and lease_expires_at > clock_timestamp() returning id`;
	if (recorded.length !== 1) return "stale";
	await transaction`update platform.session_sandbox_allocations set status = ${executorStartupRetired || executorInstanceUnresolved ? "unknown" : decision.status},
		resource_observation = ${transaction.json((executorStartupRetired || executorInstanceUnresolved ? observation : decision.observation) as unknown as Parameters<typeof transaction.json>[0])},
		updated_at = clock_timestamp() where sandbox_id = ${claim.sandbox.sandboxId}`;
	if (stopReceipt)
		await releaseSessionSandboxComputeBudgetV1(
			transaction,
			claim.sandbox.sandboxId,
		);
	if (retry.changed)
		await transaction`insert into platform.conversation_audit_events
		(id, conversation_id, execution_id, agent_id, actor_id, action, trace_id, request_id, occurred_at, details)
		values (${randomUUID()}, ${context.sandbox.sessionId}, null, ${context.sandbox.agentId}, ${context.sandbox.principal.id},
			'conversation.sandbox.observed', ${context.outbox.trace_id}, ${context.outbox.request_id}, clock_timestamp(),
			${transaction.json({ sandboxId: context.sandbox.sandboxId, sessionGeneration: context.sandbox.generation, resourceFence: claim.resourceFence, status: decision.status, executorDrainRequired: decision.observation.executorDrainRequired === true, progress, progressAttempt: Number(context.outbox.attempt_count) })})`;
	return unknown ? "unknown" : "committed";
}

/**
 * #3985：Worker 读回已就绪的 Pod 丢失（含恢复后的再次丢失），Store 仍是旧的 ready 回执。
 * 写入与空闲回收相同形状的 lifecycle 并立即请求恢复：下一次认领排空来源（已不存在的 Pod 记为
 * absent，保留 PVC），再沿保留 PVC 的替换准备重建。条件不满足时返回 undefined，按普通未知观测处理。
 */
async function requestSessionSandboxLostPodRecoveryV1(
	transaction: Transaction,
	claim: SessionSandboxReconciliationClaimV1,
	context: NonNullable<Awaited<ReturnType<typeof ownedContext>>>,
): Promise<"committed" | "stale" | undefined> {
	const [managementRow] = await transaction<
		{ management: AgentManagementStateV1 }[]
	>`
		select ${transaction.unsafe(agentManagementStateJsonSql("a"))} as management
		from platform.agent_applications a where a.agent_id = ${context.sandbox.agentId}`;
	const management = managementRow?.management;
	if (!management) return undefined;
	const executions = await transaction<
		{ status: string }[]
	>`select status from platform.conversation_executions where conversation_id = ${context.sandbox.sessionId}`;
	const pending =
		await transaction`select 1 from platform.conversation_generation_tombstones where conversation_id = ${context.sandbox.sessionId} and status = 'pending' limit 1`;
	const payload = (context.outbox.payload ?? {}) as {
		deployment?: unknown;
		modelProjection?: unknown;
	};
	const next = planSessionSandboxLostPodRecoveryTransitionV1({
		management,
		current: {
			sandbox: context.sandbox,
			resourceFence: Number(context.allocation.resource_fence),
			policy: context.allocation.resource_policy,
			observation: context.allocation.resource_observation,
			deployment: payload.deployment ?? null,
			modelProjection: payload.modelProjection ?? null,
		},
		allocationDesiredState: context.allocation.desired_state,
		executionStatuses: executions.map((execution) => execution.status),
		generationBarrierPending: pending.length > 0,
	});
	if (!next) return undefined;
	const reopened = await transaction`update platform.outbox_items
		set payload = payload || ${transaction.json({ lifecycle: next.lifecycle } as unknown as Parameters<typeof transaction.json>[0])},
			status = 'pending', lease_owner = null, lease_expires_at = null,
			available_at = clock_timestamp(), updated_at = clock_timestamp()
		where id = ${claim.itemId} and status = 'processing'
			and lease_owner = ${claim.leaseOwner}
			and delivery_fence = ${claim.deliveryFence}
			and lease_expires_at > clock_timestamp()
		returning id`;
	if (reopened.length !== 1) return "stale";
	await transaction`update platform.session_sandbox_allocations
		set desired_state = ${next.desiredState}, status = ${next.status},
			resource_fence = ${next.resourceFence}, updated_at = clock_timestamp()
		where sandbox_id = ${claim.sandbox.sandboxId}`;
	await transaction`insert into platform.audit_events
		(id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, occurred_at, details)
		values (${randomUUID()}, ${context.outbox.trace_id}, 'system', ${claim.leaseOwner},
			'conversation.sandbox.lost_pod_recovery_requested', 'sandbox', ${claim.sandbox.sandboxId}, 'succeeded',
			${context.outbox.request_id}, ${context.sandbox.agentId}, clock_timestamp(),
			${transaction.json({
				conversationId: context.sandbox.sessionId,
				reason: "pod_lost",
				sourceResourceFence: Number(context.allocation.resource_fence),
				resourceFence: next.resourceFence,
			})})`;
	return "committed";
}
