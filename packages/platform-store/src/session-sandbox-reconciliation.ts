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
	isSessionSandboxDeletionProgressValidV1,
	isTaskApiChannelV1,
	resolveCurrentPersonalApiUserV1,
	type SessionSandboxDeletionProgressV1,
	type SessionSandboxLifecycleV1,
	type SessionSandboxObservationV1,
	type SessionSandboxPolicyV1,
	type SessionSandboxReconciliationClaimV1,
	type SessionSandboxVerifiedPolicyV1,
	type TaskApiChannelV1,
	type TaskAuthorizationBoundaryV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import type postgres from "postgres";
import {
	readCurrentTaskApiUseGrantV1,
	readCurrentTaskApplicationV1,
} from "./application-task-authorization.js";
import { lockConversation, lockOutbox } from "./conversation-dispatch-sql.js";
import { decodePersistedWorkloadStateV1 } from "./workload-reconciliation.js";

type Transaction = postgres.TransactionSql;
export interface SandboxClaimRequest {
	readonly itemId: string;
	readonly workerId: string;
	readonly leaseDurationMs: number;
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
) {
	await transaction`select set_config('lock_timeout', '5s', true)`;
	const [hint] = await transaction<
		{ agent_id: string; actor_id: string; principal_type: string }[]
	>`
		select c.agent_id, c.actor_id, c.principal_type from platform.outbox_items o
		join platform.conversations c on c.id = o.scope_id
		where o.id = ${itemId} and o.scope_type = 'conversation' and o.operation = 'conversation.sandbox.reconcile.v1'`;
	if (!hint) return null;
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
		select jsonb_build_object(
			'schemaVersion', 1, 'applicationId', a.id, 'agentId', a.agent_id,
			'applicantId', a.applicant_id, 'status', a.status, 'revision', a.management_revision,
			'approvalRevision', a.approval_revision, 'decisionReason', a.decision_reason,
			'serviceAvailability', a.service_availability, 'desiredState', a.desired_state,
			'workloadRevision', a.workload_revision, 'fence', a.fence, 'failureCode', a.failure_code,
			'ownerIds', (select coalesce(jsonb_agg(owner_id order by owner_id), '[]'::jsonb) from platform.agent_owners where agent_id = a.agent_id),
			'availability', (select coalesce(jsonb_agg(case when target_type = 'user'
				then jsonb_build_object('kind', 'user', 'userId', target_id)
				else jsonb_build_object('kind', 'organization', 'organizationId', target_id) end order by target_type, target_id), '[]'::jsonb)
				from platform.agent_availability where agent_id = a.agent_id)
		) as management from platform.agent_applications a where a.agent_id = ${hint.agent_id}`;
	const management = managementRow?.management;
	const outbox = await lockOutbox(transaction, itemId);
	if (
		outbox?.operation !== "conversation.sandbox.reconcile.v1" ||
		outbox.scope_type !== "conversation"
	)
		return null;
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
		return null;
	const payload = outbox.payload;
	if (
		!payload ||
		typeof payload !== "object" ||
		Array.isArray(payload) ||
		!isDeepStrictEqual(
			Object.fromEntries(
				Object.entries(payload).filter(
					([key]) => key !== "lifecycle" && key !== "deployment",
				),
			),
			{
				schemaVersion: 1,
				conversationId: sandbox.sessionId,
				sessionGeneration: sandbox.generation,
			},
		)
	)
		return null;
	const [allocation] = await transaction<
		AllocationRow[]
	>`select resource_fence, desired_state, status, resource_policy, resource_observation
		from platform.session_sandbox_allocations where sandbox_id = ${sandbox.sandboxId} for update`;
	if (!allocation) return null;
	const lifecycle =
		(payload as { lifecycle?: SessionSandboxLifecycleV1 }).lifecycle ?? null;
	let preparationAllowed = false;
	if (lifecycle) {
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
			return null;
		const executions = await transaction<
			{ status: string; delivery_fence: string }[]
		>`select status, delivery_fence::text from platform.conversation_executions where conversation_id = ${sandbox.sessionId}`;
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
					executions: executions.map((execution) => ({
						status: execution.status,
						deliveryFence: Number(execution.delivery_fence),
					})),
				})
			)
				return null;
			preparationAllowed = true;
		} else {
			if (
				!source.policy ||
				source.resourceFence < 1 ||
				allocation.desired_state !== "stopped" ||
				!isDeepStrictEqual(source.policy, allocation.resource_policy) ||
				!isDeepStrictEqual(source.observation, allocation.resource_observation)
			)
				return null;
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
			};
		}
	}
	if (
		(allocation.desired_state !== "running" && !preparationAllowed) ||
		conversation.authorization_revision !== agent.authorization_revision ||
		management.status !== "available" ||
		management.desiredState !== "running"
	)
		return null;
	const [workload] = await transaction<
		{ state: unknown }[]
	>`select state from platform.workload_reconciliations where agent_id = ${sandbox.agentId} for share`;
	const decoded = decodePersistedWorkloadStateV1(
		workload?.state,
		sandbox.agentId,
	);
	if (!decoded || decoded.legacy) return null;
	const state = decoded.state;
	const verified = state.verified;
	if (!verified) return null;
	const deployment = validateAgentWorkloadDesiredV1(verified.deployment);
	if (
		state.phase !== "ready" ||
		state.verifiedRevision === null ||
		state.sourceConfigurationRevision !==
			Number(agent.current_configuration_revision) ||
		verified.configuration.revision !==
			Number(agent.current_configuration_revision) ||
		deployment.agentId !== sandbox.agentId ||
		deployment.configRevision !==
			Number(agent.current_configuration_revision) ||
		deployment.desiredState !== "running" ||
		deployment.runtimeManifest.interactionMode !== "platform-adapter" ||
		deployment.workloadRevision !== management.workloadRevision ||
		verified.executionCapacity?.resourceConfigurationHash !==
			policy.resourceConfigurationHash
	)
		return null;
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
		if (disabled.length) return null;
		const user = await resolveCurrentPersonalApiUserV1(
			directory,
			sandbox.principal.id,
		);
		if (user.accountStatus !== "active") return null;
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
	if (!authorization) return null;
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
		purpose: "prepare" as const,
		lifecycle,
		drainComputeAllowed: false,
	};
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
	const context = await lockedContext(
		transaction,
		input.itemId,
		policy,
		directory,
	);
	if (!context) return null;
	const { outbox, sandbox, allocation, authorization } = context;
	const [lease] = await transaction<{ eligible: boolean }[]>`select
		(status in ('pending','retry_scheduled') and available_at <= clock_timestamp()) or
		(status = 'processing' and lease_expires_at <= clock_timestamp()) as eligible
		from platform.outbox_items where id = ${input.itemId}`;
	if (!lease?.eligible) return null;
	if (
		allocation.resource_policy &&
		!isDeepStrictEqual(allocation.resource_policy, context.policy) &&
		!(
			context.purpose === "prepare" &&
			context.lifecycle?.stopReceipt &&
			allocation.desired_state === "stopped"
		)
	)
		return null;
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
			${transaction.json(context.deployment as unknown as Parameters<typeof transaction.json>[0])}::jsonb) where id = ${input.itemId}`;
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
		!isDeepStrictEqual(context.lifecycle, claim.lifecycle) ||
		!isDeepStrictEqual(context.authorization, claim.authorization) ||
		!isDeepStrictEqual(context.policy, claim.policy) ||
		!isDeepStrictEqual(context.deployment, claim.deployment) ||
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
				resource.uid === progress.resource.uid &&
				resource.resourceVersion === progress.preconditions.resourceVersion,
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
		context.lifecycle?.authority.targetDesiredState === "running";
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
	const recorded = await transaction`update platform.outbox_items
		set payload = payload || ${transaction.json((nextLifecycle ? { lifecycle: nextLifecycle } : {}) as unknown as Parameters<typeof transaction.json>[0])},
		status = ${decision.finished && !continuePreparation ? "succeeded" : "retry_scheduled"}, lease_owner = null, lease_expires_at = null,
		available_at = clock_timestamp() + interval '1 second', updated_at = clock_timestamp()
		where id = ${claim.itemId} and status = 'processing'
			and lease_owner = ${claim.leaseOwner}
			and delivery_fence = ${claim.deliveryFence}
			and lease_expires_at > clock_timestamp() returning id`;
	if (recorded.length !== 1) return "stale";
	await transaction`update platform.session_sandbox_allocations set status = ${decision.status},
		resource_observation = ${transaction.json(decision.observation as unknown as Parameters<typeof transaction.json>[0])},
		updated_at = clock_timestamp() where sandbox_id = ${claim.sandbox.sandboxId}`;
	await transaction`insert into platform.conversation_audit_events
		(id, conversation_id, execution_id, agent_id, actor_id, action, trace_id, request_id, occurred_at, details)
		values (${randomUUID()}, ${context.sandbox.sessionId}, null, ${context.sandbox.agentId}, ${context.sandbox.principal.id},
			'conversation.sandbox.observed', ${context.outbox.trace_id}, ${context.outbox.request_id}, clock_timestamp(),
			${transaction.json({ sandboxId: context.sandbox.sandboxId, sessionGeneration: context.sandbox.generation, resourceFence: claim.resourceFence, status: decision.status })})`;
	return unknown ? "unknown" : "committed";
}
