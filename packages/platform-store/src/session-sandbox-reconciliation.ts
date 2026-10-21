import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
	isTaskApiChannelV1,
	resolveCurrentPersonalApiUserV1,
	type SessionSandboxDeletionProgressV1,
	type SessionSandboxLifecycleV1,
	type SessionSandboxObservationV1,
	type SessionSandboxPolicyV1,
	type SessionSandboxReconciliationClaimV1,
	type SessionSandboxVerifiedPolicyV1,
	sessionSandboxReconcileProgressV1,
	shouldContinueSessionSandboxPreparationV1,
	type TaskApiChannelV1,
	type TaskAuthorizationBoundaryV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import type postgres from "postgres";
import { agentManagementStateJsonSql } from "./agent-management-state-sql.js";
import {
	readCurrentTaskApiUseGrantV1,
	readCurrentTaskApplicationV1,
} from "./application-task-authorization.js";
import { lockConversation, lockOutbox } from "./conversation-dispatch-sql.js";
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
	const [agent] = await transaction<
		{ authorization_revision: string; current_configuration_revision: number }[]
	>`
		select authorization_revision, current_configuration_revision from platform.agents where id = ${hint.agent_id} for share`;
	await transaction`select id from platform.agent_applications where agent_id = ${hint.agent_id} for share`;
	await transaction`select owner_id from platform.agent_owners where agent_id = ${hint.agent_id} for share`;
	await transaction`select target_id from platform.agent_availability where agent_id = ${hint.agent_id} for share`;
	const [managementRow] = await transaction<
		{ management: AgentManagementStateV1 }[]
	>`
		select ${transaction.unsafe(agentManagementStateJsonSql("a"))} as management
		from platform.agent_applications a where a.agent_id = ${hint.agent_id}`;
	const management = managementRow?.management;
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
				!isDeepStrictEqual(source.policy, allocation.resource_policy) ||
				!isDeepStrictEqual(source.observation, allocation.resource_observation)
			)
				return waiting("lifecycle_stale");
			return {
				outbox,
				sandbox,
				allocation,
				authorization: null,
				purpose: "drain" as const,
				lifecycle,
				drainComputeAllowed: canDrainSessionSandboxComputeV1(
					executions.map((execution) => execution.status),
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
	if (
		state.sourceConfigurationRevision !==
			Number(agent.current_configuration_revision) ||
		verified.configuration.revision !==
			Number(agent.current_configuration_revision) ||
		deployment.configRevision !== Number(agent.current_configuration_revision)
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
		configurationRevision: Number(agent.current_configuration_revision),
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
		!allocation ||
		allocation.desired_state !== "stopped" ||
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
	const context = await lockedContext(
		transaction,
		input.itemId,
		policy,
		directory,
		wait,
	);
	if (!context) {
		await settleRetainedStopReceipt(transaction, input.itemId);
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
		{ progress: string | null; attempt: string | null }[]
	>`select details->>'progress' as progress, details->>'progressAttempt' as attempt
		from platform.conversation_audit_events
		where conversation_id = ${context.sandbox.sessionId}
			and action = 'conversation.sandbox.observed'
			and details->>'sandboxId' = ${context.sandbox.sandboxId}
			and details->>'sessionGeneration' = ${String(context.sandbox.generation)}
		order by occurred_at desc, id desc limit 1`;
	const retry = decideSessionSandboxRetryV1({
		previous: lastChange && {
			progress: lastChange.progress,
			attempt: lastChange.attempt === null ? null : Number(lastChange.attempt),
		},
		progress,
		attemptCount: Number(context.outbox.attempt_count),
		status: decision.status,
	});
	const recorded = await transaction`update platform.outbox_items
		set payload = payload || ${transaction.json((nextLifecycle ? { lifecycle: nextLifecycle } : {}) as unknown as Parameters<typeof transaction.json>[0])},
		status = ${terminal ? "succeeded" : "retry_scheduled"}, lease_owner = null, lease_expires_at = null,
		available_at = clock_timestamp() + (${terminal ? 1000 : retry.delayMs}::bigint * interval '1 millisecond'), updated_at = clock_timestamp()
		where id = ${claim.itemId} and status = 'processing'
			and lease_owner = ${claim.leaseOwner}
			and delivery_fence = ${claim.deliveryFence}
			and lease_expires_at > clock_timestamp() returning id`;
	if (recorded.length !== 1) return "stale";
	await transaction`update platform.session_sandbox_allocations set status = ${decision.status},
		resource_observation = ${transaction.json(decision.observation as unknown as Parameters<typeof transaction.json>[0])},
		updated_at = clock_timestamp() where sandbox_id = ${claim.sandbox.sandboxId}`;
	if (retry.changed)
		await transaction`insert into platform.conversation_audit_events
		(id, conversation_id, execution_id, agent_id, actor_id, action, trace_id, request_id, occurred_at, details)
		values (${randomUUID()}, ${context.sandbox.sessionId}, null, ${context.sandbox.agentId}, ${context.sandbox.principal.id},
			'conversation.sandbox.observed', ${context.outbox.trace_id}, ${context.outbox.request_id}, clock_timestamp(),
			${transaction.json({ sandboxId: context.sandbox.sandboxId, sessionGeneration: context.sandbox.generation, resourceFence: claim.resourceFence, status: decision.status, progress, progressAttempt: Number(context.outbox.attempt_count) })})`;
	return unknown ? "unknown" : "committed";
}
