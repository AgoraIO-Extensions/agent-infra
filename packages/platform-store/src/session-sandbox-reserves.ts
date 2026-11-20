import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type AgentWorkloadDesiredV1,
	validateAgentWorkloadDesiredV1,
} from "@agent-infra/contracts/workload";
import {
	type RuntimeModelProjectionV4,
	validateRuntimeModelProjectionV4,
} from "@agent-infra/model-catalog";
import {
	type AgentManagementStateV1,
	type ConversationExecutionAuthorityV1,
	canReadySessionSandboxReserveV1,
	canReleaseSessionSandboxReserveV1,
	captureTaskAuthorizationBoundaryV1,
	createSessionSandboxBindingV1,
	parseSessionSandboxReserveConfigurationV1,
	resolveCurrentPersonalApiUserV1,
	type SessionSandboxBindingV1,
	type SessionSandboxInstanceEvidenceV1,
	type SessionSandboxObservationV1,
	type SessionSandboxReserveClaimV1,
	type SessionSandboxReserveConfigurationV1,
	type SessionSandboxReserveExecutorStartupV1,
	type SessionSandboxReserveLeaseV1,
	type SessionSandboxReserveOperationInputV1,
	type SessionSandboxReserveOperationV1,
	type SessionSandboxReserveProfileV1,
	type SessionSandboxReserveProjectionWriteV1,
	type SessionSandboxReserveStatusV1,
	type SessionSandboxResourceBudgetV1,
	type SessionSandboxResourceIdentityV1,
	type SessionSandboxVerifiedPolicyV1,
	sessionSandboxAllocationRefV1,
	sessionSandboxBudgetFitsV1,
	sessionSandboxInstanceEvidenceShapeV1,
	sessionSandboxReserveClaimRefV1,
	sessionSandboxReserveDigestV1,
	sessionSandboxReserveExecutorSettledV1,
	sessionSandboxReserveExecutorStartupRefV1,
	sessionSandboxReserveRefV1,
	sessionSandboxReserveResourceKindsV1,
	sessionSandboxReserveTargetV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import { agentManagementStateJsonSql } from "./agent-management-state-sql.js";
import type { Transaction } from "./conversation-execution-common.js";
import { lockAgentConfiguration } from "./conversation-execution-sql.js";
import postgres from "./observed-postgres.js";
import { decodePersistedWorkloadStateV1 } from "./workload-reconciliation.js";

type Json = Parameters<Transaction["json"]>[0];
export interface SessionSandboxReserveWorkerClaimV1
	extends SessionSandboxReserveClaimV1 {
	readonly deployment: AgentWorkloadDesiredV1 | null;
	readonly modelProjection: RuntimeModelProjectionV4 | null;
}
/** Read-only reserve state; it deliberately carries no worker lease or delivery fence. */
export type SessionSandboxReserveInspectionV1 = Omit<
	SessionSandboxReserveWorkerClaimV1,
	"leaseOwner" | "deliveryFence"
> & {
	readonly currentProfileDigest: string | null;
};
export type SessionSandboxReserveDeleteResponseV1 =
	| "acknowledged"
	| "absent"
	| "rejected";
interface ReserveRow {
	sandbox_id: string;
	session_id: string;
	agent_id: string;
	namespace: string;
	profile_digest: string;
	profile: SessionSandboxReserveProfileV1;
	status: SessionSandboxReserveStatusV1;
	operations: SessionSandboxReserveOperationV1[];
	lease_owner: string | null;
	delivery_fence: number | string;
	expires_at: Date;
	executor_startup: SessionSandboxReserveExecutorStartupV1 | null;
}
interface ReserveSizing {
	profileDigest: string;
	target: number;
	lowTarget: number | null;
	lowSince: number | null;
}
async function readReserveStatistics(
	tx: Transaction,
	windowMs: number,
	agentId: string | null = null,
) {
	const [clock] = await tx<
		{ observed_at: Date }[]
	>`select clock_timestamp() as observed_at`;
	const observedAt = clock?.observed_at ?? unavailable();
	const rows = await tx<
		{
			agentId: string;
			profileDigest: string | null;
			newSessionCount: string;
			claimedCount: string;
			replenishmentCount: string;
			replenishmentUpperBoundMs: string | null;
		}[]
	>`
		with demand as (
			select a.agent_id, a.admission_profile_digest as profile_digest,
				count(*) as arrivals, count(r.sandbox_id) as claims
			from platform.session_sandbox_allocations a
			left join platform.session_sandbox_reserves r on r.sandbox_id = a.sandbox_id
				and r.session_id = a.conversation_id and r.agent_id = a.agent_id
				and r.status = 'claimed' and r.profile_digest = a.admission_profile_digest
			where a.created_at >= ${observedAt}::timestamptz - ${windowMs} * interval '1 millisecond'
				and a.created_at <= ${observedAt}
				and (${agentId}::text is null or a.agent_id = ${agentId})
			group by a.agent_id, a.admission_profile_digest
		), replenishment as (
			select agent_id, profile_digest, count(*) as samples,
				max(extract(epoch from (ready_at - created_at)) * 1000) as upper_bound_ms
			from platform.session_sandbox_reserves
			where ready_at >= ${observedAt}::timestamptz - ${windowMs} * interval '1 millisecond'
				and ready_at <= ${observedAt} and ready_at >= created_at
				and (${agentId}::text is null or agent_id = ${agentId})
			group by agent_id, profile_digest
		)
		select coalesce(d.agent_id, r.agent_id) as "agentId",
			coalesce(d.profile_digest, r.profile_digest) as "profileDigest",
			coalesce(d.arrivals, 0)::text as "newSessionCount",
			coalesce(d.claims, 0)::text as "claimedCount",
			coalesce(r.samples, 0)::text as "replenishmentCount",
			r.upper_bound_ms::text as "replenishmentUpperBoundMs"
		from demand d full join replenishment r on r.agent_id = d.agent_id and r.profile_digest = d.profile_digest
		order by 1, 2 nulls last`;
	return {
		observedAt,
		windowMs,
		profiles: rows.map((row) => ({
			...row,
			newSessionCount: Number(row.newSessionCount),
			claimedCount: Number(row.claimedCount),
			replenishmentCount: Number(row.replenishmentCount),
			replenishmentUpperBoundMs:
				row.replenishmentUpperBoundMs === null
					? null
					: Number(row.replenishmentUpperBoundMs),
		})),
	};
}
async function retireReserve(
	tx: Transaction,
	sandboxId: string,
): Promise<boolean> {
	const rows =
		await tx`update platform.session_sandbox_reserves r set status = 'retiring', lease_owner = null, lease_expires_at = null, delivery_fence = delivery_fence + 1, updated_at = clock_timestamp() where sandbox_id = ${sandboxId} and status in ('preparing','ready','unknown') and retired_at is null and not exists(select 1 from platform.session_sandbox_allocations a where a.sandbox_id = r.sandbox_id) and not exists(select 1 from platform.conversations c where c.id = r.session_id) returning sandbox_id`;
	return rows.length === 1;
}
export interface SessionSandboxAdmissionV1 {
	readonly binding: SessionSandboxBindingV1;
	readonly admissionProfileDigest: string | null;
	readonly profile: SessionSandboxReserveProfileV1 | null;
	readonly observation: SessionSandboxObservationV1 | null;
	/** Original executor startup facts handed to the business path on claim (Spec §10.1.1 G6). */
	readonly executorStartup?: SessionSandboxReserveExecutorStartupV1 | null;
}
function boundedText(value: string): boolean {
	return value.length > 0 && value.length <= 512;
}
function isProjectionIdentity(
	resource: SessionSandboxResourceIdentityV1 | null,
	row: ReserveRow,
	startup: SessionSandboxReserveExecutorStartupV1,
): resource is SessionSandboxResourceIdentityV1 {
	return (
		resource?.kind === "Secret" &&
		resource.name === startup.startupRef &&
		resource.namespace === row.namespace &&
		!!resource.uid &&
		!!resource.resourceVersion
	);
}
/** An unknown reserve returns to preparing only after every original write has its response. */
function settledStatus(
	row: ReserveRow,
	startup: SessionSandboxReserveExecutorStartupV1,
): SessionSandboxReserveStatusV1 {
	return row.status === "unknown" &&
		row.operations.every(
			(operation) => operation.writeCompletion === "response",
		) &&
		sessionSandboxReserveExecutorSettledV1(startup)
		? "preparing"
		: row.status;
}
/** The original reserve instance (generation 1, fence 1) under the current lease. */
function reserveEvidenceMatches(
	evidence: SessionSandboxInstanceEvidenceV1 | undefined,
	sandboxId: string,
	lease: SessionSandboxReserveLeaseV1,
	instance: {
		readonly podUid: string;
		readonly hostKeyId: string;
		readonly runnerEpoch: string;
	},
): evidence is SessionSandboxInstanceEvidenceV1 {
	return (
		sessionSandboxInstanceEvidenceShapeV1(evidence) &&
		evidence.scope.phase === "reserve" &&
		evidence.scope.reserveRef === sessionSandboxReserveRefV1(sandboxId) &&
		evidence.scope.reserveDeliveryFence === lease.deliveryFence &&
		evidence.generation === 1 &&
		evidence.resourceFence === 1 &&
		evidence.podUid === instance.podUid &&
		evidence.hostKeyId === instance.hostKeyId &&
		evidence.runnerEpoch === instance.runnerEpoch
	);
}
/** Evidence is still valid by the database clock at commit, after the row locks. */
async function evidenceCurrent(
	tx: Transaction,
	evidence: SessionSandboxInstanceEvidenceV1,
	notBeforeMs?: number,
): Promise<boolean> {
	const [clock] = await tx<{ now_ms: number }[]>`
		select floor(extract(epoch from clock_timestamp()) * 1000)::float8 as now_ms`;
	const now = clock?.now_ms;
	return (
		typeof now === "number" &&
		evidence.observedAtMs <= now &&
		now < evidence.expiresAtMs &&
		(notBeforeMs === undefined || evidence.issuedAtMs >= notBeforeMs)
	);
}
function unavailable(): never {
	throw new Error("Session Sandbox reserve persistence is unavailable");
}

/** Current principal locks precede Agent, budget and reserve. API/Eval already own their stronger admission locks. */
export async function lockSessionSandboxCreateAuthorityV1(
	tx: Transaction,
	authority: ConversationExecutionAuthorityV1,
	directory: TaskUserDirectoryV1 | undefined,
): Promise<boolean> {
	await tx`lock table platform.platform_user_disables in share mode`;
	const disabled =
		await tx`select 1 from platform.platform_user_disables where user_id = ${authority.actorId}`;
	if (disabled.length || authority.taskBoundary?.principal.kind !== "user")
		return false;
	const agent = await lockAgentConfiguration(tx, authority.agentId);
	await tx`select id from platform.agent_applications where agent_id = ${authority.agentId} for share`;
	await tx`select owner_id from platform.agent_owners where agent_id = ${authority.agentId} for share`;
	await tx`select target_id from platform.agent_availability where agent_id = ${authority.agentId} for share`;
	const [row] = await tx<
		{ management: AgentManagementStateV1 }[]
	>`select ${tx.unsafe(agentManagementStateJsonSql("a"))} as management from platform.agent_applications a where a.agent_id = ${authority.agentId}`;
	if (!row || agent?.authorizationRevision !== authority.authorizationRevision)
		return false;
	const user = await resolveCurrentPersonalApiUserV1(
		directory,
		authority.actorId,
	);
	const current = captureTaskAuthorizationBoundaryV1({
		principal: authority.taskBoundary.principal,
		agent: row.management,
		channelId: authority.channelId,
		agentAuthorizationRevision: authority.authorizationRevision,
		user,
	});
	return current !== null && isDeepStrictEqual(current, authority.taskBoundary);
}

/** Only locked DB verified facts and trusted deployment configuration determine a claimable profile. */
export async function readCurrentSessionSandboxReserveProfileV1(
	tx: Transaction,
	agentId: string,
	config: SessionSandboxReserveConfigurationV1,
) {
	const approved = config.profiles.find((p) => p.agentId === agentId);
	if (!config.enabled || !approved) return null;
	const agent = await lockAgentConfiguration(tx, agentId);
	const [management] = await tx<
		{
			fence: number;
			workload_revision: number;
			status: string;
			desired_state: string;
		}[]
	>`select fence, workload_revision, status, desired_state from platform.agent_applications where agent_id = ${agentId} for share`;
	const [workload] = await tx<
		{ state: unknown }[]
	>`select state from platform.workload_reconciliations where agent_id = ${agentId} for share`;
	const decoded = decodePersistedWorkloadStateV1(workload?.state, agentId);
	if (
		management?.status !== "available" ||
		management.desired_state !== "running" ||
		!decoded ||
		decoded.legacy ||
		decoded.state.phase !== "ready" ||
		!decoded.state.verified ||
		decoded.state.verifiedRevision === null ||
		decoded.state.sourceLifecycleRevision !==
			Number(management.workload_revision)
	)
		return null;
	const verified = decoded.state.verified;
	const configuration = agent?.runtimeConfiguration;
	// Reserves stay standard-template only (ADR-0038, #3937): custom
	// platform-adapter Agents keep the original preparation path.
	if (
		configuration?.source.kind !== "standard" ||
		configuration.secrets.length ||
		configuration.source.templateId !== approved.templateId ||
		configuration.source.imageDigest !== approved.imageDigest ||
		configuration.revision !== decoded.state.sourceConfigurationRevision ||
		verified.configuration.revision !== configuration.revision ||
		!isDeepStrictEqual(verified.configuration, configuration)
	)
		return null;
	try {
		const deployment = validateAgentWorkloadDesiredV1(verified.deployment);
		const projection = validateRuntimeModelProjectionV4(
			verified.modelProjection,
			configuration,
		);
		if (
			deployment.agentId !== agentId ||
			deployment.desiredState !== "running" ||
			deployment.configRevision !== configuration.revision ||
			deployment.imageDigest !== approved.imageDigest ||
			deployment.runtimeManifest.interactionMode !== "platform-adapter" ||
			deployment.multiService ||
			verified.executionCapacity?.resourceConfigurationHash !==
				approved.resourceConfigurationHash ||
			projection.standardTemplateBinding.templateId !== approved.templateId ||
			projection.standardTemplateBinding.imageDigest !== approved.imageDigest
		)
			return null;
		const policy = {
			namespace: config.namespace,
			resourceConfigurationHash: approved.resourceConfigurationHash,
			configurationRevision: configuration.revision,
			workloadRevision: deployment.workloadRevision,
			managementFence: Number(management.fence),
			imageDigest: deployment.imageDigest,
		};
		// Hash all admitted Pod inputs, including env, Skills generation and Connection consumer projection.
		const deploymentDigest = sessionSandboxReserveDigestV1(deployment);
		const modelProjectionDigest = sessionSandboxReserveDigestV1(projection);
		const environmentDigest = sessionSandboxReserveDigestV1(deployment.env);
		const skillsDigest = sessionSandboxReserveDigestV1(deployment.skills ?? []);
		const profile: SessionSandboxReserveProfileV1 = {
			schemaVersion: 1,
			agentId,
			configurationRevision: config.revision,
			policy,
			resources: approved.resources,
			deploymentDigest,
			modelProjectionDigest,
			environmentDigest,
			skillsDigest,
			connectionConfigurationVersion: approved.connectionConfigurationVersion,
			networkPolicyVersion: approved.networkPolicyVersion,
			signingConfigurationVersion: approved.signingConfigurationVersion,
			transportConfigurationVersion: approved.transportConfigurationVersion,
			storageConfigurationVersion: approved.storageConfigurationVersion,
			digest: sessionSandboxReserveDigestV1({
				policy,
				approved,
				deploymentDigest,
				modelProjectionDigest,
				environmentDigest,
				skillsDigest,
				configurationRevision: config.revision,
			}),
		};
		return { profile, deployment, modelProjection: projection };
	} catch {
		return null;
	}
}

interface StoredReservePolicy extends SessionSandboxReserveConfigurationV1 {
	/** Accounting survives disabling the reserve controller; never accepted from deployment input. */
	readonly reserveAccounting?: Pick<
		SessionSandboxReserveConfigurationV1,
		"totalBudget" | "resourceCosts"
	>;
}
function decodeReservePolicy(value: StoredReservePolicy) {
	const { reserveAccounting, ...submitted } = value;
	const policy = parseSessionSandboxReserveConfigurationV1(submitted);
	const accounting = reserveAccounting ?? policy;
	const effective = parseSessionSandboxReserveConfigurationV1({
		...policy,
		totalBudget: accounting.totalBudget,
		resourceCosts: accounting.resourceCosts,
	});
	return {
		policy,
		effective,
		hasAccounting: policy.enabled || reserveAccounting !== undefined,
	};
}
async function lockReserveBudget(tx: Transaction) {
	await tx`select pg_advisory_xact_lock(pg_catalog.hashtextextended('session-sandbox:deployment-budget', 0))`;
}
/** Persist control revision separately from the retained accounting facts. No resource charge is released here. */
async function applyReserveConfiguration(
	tx: Transaction,
	configured: SessionSandboxReserveConfigurationV1,
) {
	await lockReserveBudget(tx);
	const { reserveAccounting: _ignored, ...input } =
		configured as StoredReservePolicy;
	const config = parseSessionSandboxReserveConfigurationV1(input);
	const rows = await tx<
		{
			namespace: string;
			revision: number;
			configuration: StoredReservePolicy;
		}[]
	>`
		select namespace, revision, configuration from platform.session_sandbox_budgets for update`;
	if (rows.length > 1 || (rows[0] && rows[0].namespace !== config.namespace))
		unavailable();
	const previous = rows[0];
	const decoded = previous ? decodeReservePolicy(previous.configuration) : null;
	if (
		previous &&
		(Number(previous.revision) > config.revision ||
			(Number(previous.revision) === config.revision &&
				!isDeepStrictEqual(decoded?.policy, config)))
	)
		unavailable();
	if (previous && Number(previous.revision) === config.revision) return decoded;
	const persisted: StoredReservePolicy =
		!config.enabled && decoded?.hasAccounting
			? {
					...config,
					reserveAccounting: {
						totalBudget: decoded.effective.totalBudget,
						resourceCosts: decoded.effective.resourceCosts,
					},
				}
			: config;
	await tx`insert into platform.session_sandbox_budgets (namespace, revision, configuration, updated_at)
		values (${config.namespace}, ${config.revision}, ${tx.json(persisted as unknown as Json)}, clock_timestamp())
		on conflict(namespace) do update set revision=excluded.revision, configuration=excluded.configuration, updated_at=excluded.updated_at`;
	return decodeReservePolicy(persisted);
}
/** One transaction lock is shared by cold allocation, replenishment, claim, resume and retirement. */
async function lockBudget(
	tx: Transaction,
	configured?: SessionSandboxReserveConfigurationV1,
) {
	await lockReserveBudget(tx);
	if (configured) await applyReserveConfiguration(tx, configured);
	const rows = await tx<
		{ configuration: StoredReservePolicy }[]
	>`select configuration from platform.session_sandbox_budgets for update`;
	if (!rows.length) return null;
	if (rows.length !== 1) unavailable();
	const {
		policy,
		effective: config,
		hasAccounting,
	} = decodeReservePolicy((rows[0] ?? unavailable()).configuration);
	// Never-enabled default-off has no accounting policy and must preserve the existing cold path.
	if (!hasAccounting) return null;
	// Disabled mode fences new reserve use but never revalidates or rewrites existing allocation charges.
	if (!policy.enabled) return { ...config, enabled: false };
	// Existing allocation charges are retained as facts; missing historical charge
	// rows are not backfilled or used to reject ordinary cold Sessions.
	// Only the original Session lifecycle's confirmed stop receipt releases compute. PVC remains charged.
	await tx`update platform.session_sandbox_resource_charges ch set compute_released = true from platform.session_sandbox_allocations a
  where a.sandbox_id = ch.sandbox_id and a.desired_state = 'stopped' and (
   (a.status = 'stopped' and exists (
     select 1 from platform.outbox_items o where o.scope_type = 'conversation' and o.scope_id = a.conversation_id and o.operation = 'conversation.sandbox.reconcile.v1'
     and o.payload->'lifecycle'->'stopReceipt'->>'sandboxId' = a.sandbox_id
     and o.payload->'lifecycle'->'stopReceipt'->>'sessionId' = a.conversation_id
     and o.payload->'lifecycle'->'stopReceipt'->>'targetGeneration' = a.session_generation::text
     and o.payload->'lifecycle'->'stopReceipt'->>'targetResourceFence' = a.resource_fence::text))
   or (a.status = 'unavailable' and a.resource_observation->>'status' = 'stopped' and jsonb_typeof(a.resource_observation->'sourceStop'->'removed') = 'array')
  )`;
	return { ...config, enabled: policy.enabled };
}
async function usedBudget(
	tx: Transaction,
	namespace: string,
): Promise<SessionSandboxResourceBudgetV1> {
	const [used] = await tx<
		{ cpu: string; memory: string; storage: string }[]
	>`select
  coalesce(sum(case when compute_released then 0 else (resources->>'cpuMillis')::bigint end), 0)::text as cpu,
  coalesce(sum(case when compute_released then 0 else (resources->>'memoryBytes')::bigint end), 0)::text as memory,
  coalesce(sum((resources->>'storageBytes')::bigint), 0)::text as storage
  from platform.session_sandbox_resource_charges ch where namespace = ${namespace} and not released
   and exists(select 1 from platform.session_sandbox_reserves r where r.sandbox_id = ch.sandbox_id
     and r.status <> 'claimed' and r.retired_at is null)`;
	return {
		cpuMillis: Number(used?.cpu),
		memoryBytes: Number(used?.memory),
		storageBytes: Number(used?.storage),
	};
}
async function charge(
	tx: Transaction,
	config: SessionSandboxReserveConfigurationV1,
	sandboxId: string,
	resources: SessionSandboxResourceBudgetV1,
) {
	if (
		!sessionSandboxBudgetFitsV1(
			config.totalBudget,
			await usedBudget(tx, config.namespace),
			resources,
		)
	)
		unavailable();
	await tx`insert into platform.session_sandbox_resource_charges (sandbox_id, namespace, resources) values (${sandboxId}, ${config.namespace}, ${tx.json(resources as unknown as Json)})`;
}

/** Invoked only after authority and the original idempotency reservation, never for replay/continuation. */
export async function admitNewSessionSandboxV1(
	tx: Transaction,
	authority: ConversationExecutionAuthorityV1,
	fallback: SessionSandboxBindingV1,
	configured?: SessionSandboxReserveConfigurationV1,
): Promise<SessionSandboxAdmissionV1> {
	const current = configured
		? await readCurrentSessionSandboxReserveProfileV1(
				tx,
				authority.agentId,
				configured,
			)
		: null;
	const config = await lockBudget(tx, configured);
	// A live DB policy cannot silently enable new cold Sessions when the API
	// deployment did not provide the matching reserve configuration.
	if (config?.enabled && configured === undefined) unavailable();
	if (current && configured?.enabled && config?.enabled) {
		const rows = await tx<
			ReserveRow[]
		>`select * from platform.session_sandbox_reserves where agent_id = ${authority.agentId} and namespace = ${config.namespace} and profile_digest = ${current.profile.digest} and status = 'ready' and expires_at > clock_timestamp() and retired_at is null order by created_at for update skip locked limit 1`;
		const row = rows[0];
		if (
			row &&
			isDeepStrictEqual(row.profile, current.profile) &&
			canReadySessionSandboxReserveV1({
				status: "preparing",
				operations: row.operations,
				bootstrapReady: true,
				businessStateAbsent: true,
				executorStartup: row.executor_startup,
			})
		) {
			const changed =
				await tx`update platform.session_sandbox_reserves set status = 'claimed', claimed_at = clock_timestamp(), lease_owner = null, lease_expires_at = null, delivery_fence = delivery_fence + 1, updated_at = clock_timestamp() where sandbox_id = ${row.sandbox_id} and status = 'ready' returning sandbox_id`;
			if (changed.length !== 1) unavailable();
			const binding = {
				...createSessionSandboxBindingV1(authority, row.session_id),
				sandboxId: row.sandbox_id,
				resourceName: `sandbox-${row.sandbox_id}`,
				workspaceScope: row.sandbox_id,
			};
			return {
				binding,
				admissionProfileDigest: current.profile.digest,
				profile: current.profile,
				observation: {
					status: "observed",
					resources: row.operations.map((o) => o.resource ?? unavailable()),
				},
				executorStartup: row.executor_startup,
			};
		}
	}
	// Ordinary cold-start Sessions are admitted independently of deployment-wide
	// accounting. The reserve pool is the only path that calls charge().
	return {
		binding: fallback,
		admissionProfileDigest: current?.profile.digest ?? null,
		profile: null,
		observation: null,
	};
}
export async function adoptSessionSandboxReserveV1(
	tx: Transaction,
	admission: SessionSandboxAdmissionV1,
	audit?: {
		readonly requestId: string;
		readonly traceId: string;
	},
): Promise<void> {
	if (admission.admissionProfileDigest !== null) {
		const rows = await tx`update platform.session_sandbox_allocations
			set admission_profile_digest = ${admission.admissionProfileDigest}
			where sandbox_id = ${admission.binding.sandboxId} and conversation_id = ${admission.binding.sessionId}
				and session_generation = 1 and admission_profile_digest is null returning sandbox_id`;
		if (rows.length !== 1) unavailable();
	}
	if (!admission.profile || !admission.observation) return;
	const changed =
		await tx`update platform.session_sandbox_allocations set resource_fence = 1, resource_policy = ${tx.json(admission.profile.policy as unknown as Json)}, resource_observation = ${tx.json(admission.observation as unknown as Json)}, status = 'allocated' where sandbox_id = ${admission.binding.sandboxId} and conversation_id = ${admission.binding.sessionId} and session_generation = 1 returning sandbox_id`;
	if (changed.length !== 1) unavailable();
	const startup = admission.executorStartup;
	if (!startup) return;
	// The business path reads the original startup record instead of signing a
	// new deadline; `source` keeps a claimed reserve out of startup-timeout retirement.
	if (!audit || !startup.projection || !startup.consumption) unavailable();
	const binding = admission.binding;
	await tx`
		insert into platform.conversation_audit_events
			(id, conversation_id, execution_id, agent_id, actor_id, action, trace_id, request_id, occurred_at, details)
		values
			(${randomUUID()}, ${binding.sessionId}, null, ${binding.agentId}, ${binding.principal.id},
			'conversation.sandbox.observed', ${audit.traceId}, ${audit.requestId}, clock_timestamp(),
			${tx.json({
				checkpoint: "executor-startup",
				startupRef: startup.startupRef,
				deadlineMs: startup.deadlineMs,
				sandboxId: binding.sandboxId,
				sessionGeneration: 1,
				resourceFence: 1,
				source: "reserve",
				podUid: startup.projection.podUid,
				hostKeyId: startup.projection.hostKeyId,
				hostPublicKey: startup.projection.hostPublicKey,
				bindingDigest: startup.projection.bindingDigest,
				projectionAttemptId: startup.projection.create.attemptId,
				projectionUid: startup.consumption.projectionUid,
				runnerEpoch: startup.consumption.runnerEpoch,
			})})
	`;
}
/** Non-secret facts a Worker binds into one business promotion receipt (Spec §10.1.1). */
export interface SessionSandboxExecutorPromotionInputV1 {
	readonly sandboxId: string;
	readonly sessionId: string;
	readonly agentId: string;
	readonly principal: {
		readonly kind: "user" | "application";
		readonly id: string;
	};
	readonly channelId: string;
	readonly generation: number;
	readonly resourceFence: number;
	readonly profileDigest: string;
	readonly bindingDigest: string;
	readonly layoutDigest: string;
	readonly podUid: string;
	/** Evidence snapshot only; later admission compares Pod UID, epoch and generation/fence. */
	readonly podResourceVersion: string;
	readonly pvcUid: string;
	readonly hostKeyId: string;
	readonly runnerEpoch: string;
	/** Verified `claimed`-scope evidence issued after the claim committed. */
	readonly evidence: SessionSandboxInstanceEvidenceV1;
}
export interface SessionSandboxExecutorPromotionReceiptRefV1 {
	readonly receiptId: string;
	readonly receiptDigest: string;
}
const digestPattern = /^[0-9a-f]{64}$/;
/**
 * Persist the promotion receipt of a claimed executor reserve under the
 * current allocation binding and fence. Replay returns the original receipt;
 * a different receipt for the same generation/fence is refused.
 */
export async function recordSessionSandboxExecutorPromotionV1(
	tx: Transaction,
	input: SessionSandboxExecutorPromotionInputV1,
): Promise<SessionSandboxExecutorPromotionReceiptRefV1 | null> {
	if (
		![
			input.sandboxId,
			input.sessionId,
			input.agentId,
			input.principal?.id,
			input.channelId,
			input.podUid,
			input.podResourceVersion,
			input.pvcUid,
			input.hostKeyId,
			input.runnerEpoch,
		].every((value) => typeof value === "string" && boundedText(value)) ||
		!["user", "application"].includes(input.principal.kind) ||
		![input.generation, input.resourceFence].every(
			(value) => Number.isSafeInteger(value) && value > 0,
		) ||
		![input.profileDigest, input.bindingDigest, input.layoutDigest].every(
			(value) => digestPattern.test(value),
		)
	)
		return null;
	const evidence = input.evidence;
	if (
		!sessionSandboxInstanceEvidenceShapeV1(evidence) ||
		evidence.scope.phase !== "claimed" ||
		evidence.scope.claimRef !==
			sessionSandboxReserveClaimRefV1({
				sandboxId: input.sandboxId,
				sessionId: input.sessionId,
			}) ||
		evidence.scope.allocationRef !==
			sessionSandboxAllocationRefV1({
				sandboxId: input.sandboxId,
				sessionId: input.sessionId,
				generation: input.generation,
				resourceFence: input.resourceFence,
			}) ||
		evidence.podUid !== input.podUid ||
		evidence.hostKeyId !== input.hostKeyId ||
		evidence.runnerEpoch !== input.runnerEpoch ||
		evidence.generation !== input.generation ||
		evidence.resourceFence !== input.resourceFence
	)
		return null;
	const [allocation] = await tx<
		{
			agent_id: string;
			actor_id: string;
			principal_type: string;
			channel_id: string;
			session_generation: number | string;
			resource_fence: number | string;
			status: string;
		}[]
	>`select agent_id, actor_id, principal_type, channel_id, session_generation, resource_fence, status
		from platform.session_sandbox_allocations
		where sandbox_id = ${input.sandboxId} and conversation_id = ${input.sessionId} for update`;
	if (
		!allocation ||
		allocation.agent_id !== input.agentId ||
		allocation.actor_id !== input.principal.id ||
		allocation.principal_type !== input.principal.kind ||
		allocation.channel_id !== input.channelId ||
		Number(allocation.session_generation) !== input.generation ||
		Number(allocation.resource_fence) !== input.resourceFence ||
		["stopped", "unavailable"].includes(allocation.status)
	)
		return null;
	const [reserve] = await tx<
		(Pick<ReserveRow, "profile_digest" | "operations" | "executor_startup"> & {
			claimed_ms: number | null;
		})[]
	>`select profile_digest, operations, executor_startup,
			floor(extract(epoch from claimed_at) * 1000)::float8 as claimed_ms
		from platform.session_sandbox_reserves
		where sandbox_id = ${input.sandboxId} and session_id = ${input.sessionId} and status = 'claimed'`;
	const startup = reserve?.executor_startup;
	const projection = startup?.projection;
	const pvc = reserve?.operations.find(
		(operation) =>
			operation.kind === "PersistentVolumeClaim" &&
			operation.operation === "create",
	);
	if (
		!reserve ||
		!startup ||
		!projection ||
		!startup.consumption ||
		typeof reserve.claimed_ms !== "number" ||
		// Only the original reserve instance: its startup fixes generation 1 and this fence.
		input.generation !== 1 ||
		startup.startupRef !==
			`sandbox-${input.sandboxId}-executor-${input.resourceFence}` ||
		reserve.profile_digest !== input.profileDigest ||
		projection.bindingDigest !== input.bindingDigest ||
		projection.podUid !== input.podUid ||
		projection.hostKeyId !== input.hostKeyId ||
		startup.consumption.runnerEpoch !== input.runnerEpoch ||
		pvc?.resource?.uid !== input.pvcUid ||
		!(await evidenceCurrent(tx, evidence, reserve.claimed_ms))
	)
		return null;
	const { evidence: _evidence, ...binding } = input;
	// Replay compares the instance binding; fresh evidence of the same instance replays it.
	const receiptDigest = sessionSandboxReserveDigestV1({
		schemaVersion: 1,
		startupRef: startup.startupRef,
		...binding,
	});
	const receipt = {
		schemaVersion: 1 as const,
		startupRef: startup.startupRef,
		...binding,
		evidence,
	};
	const [existing] = await tx<{ id: string; receipt_digest: string }[]>`
		select id, receipt_digest from platform.session_sandbox_executor_promotions
		where sandbox_id = ${input.sandboxId} and session_generation = ${input.generation}
			and resource_fence = ${input.resourceFence}`;
	if (existing)
		return existing.receipt_digest === receiptDigest
			? { receiptId: existing.id, receiptDigest }
			: null;
	const receiptId = randomUUID();
	await tx`insert into platform.session_sandbox_executor_promotions
		(id, sandbox_id, conversation_id, session_generation, resource_fence, receipt, receipt_digest, created_at)
		values (${receiptId}, ${input.sandboxId}, ${input.sessionId}, ${input.generation}, ${input.resourceFence},
			${tx.json(receipt as unknown as Json)}, ${receiptDigest}, clock_timestamp())`;
	return { receiptId, receiptDigest };
}
/** Resume the original allocation; a stopped Session is never given a reserve. */
export async function reserveSessionSandboxResumeBudgetV1(
	tx: Transaction,
	sandboxId: string,
): Promise<void> {
	const config = await lockBudget(tx);
	if (!config) return;
	const [row] = await tx<
		{ resources: SessionSandboxResourceBudgetV1; compute_released: boolean }[]
	>`select resources, compute_released from platform.session_sandbox_resource_charges where sandbox_id = ${sandboxId}`;
	if (!row?.compute_released) return;
	// An owned Session may resume even when aggregate deployment usage is high.
	await tx`update platform.session_sandbox_resource_charges set compute_released = false where sandbox_id = ${sandboxId}`;
}

export class SessionSandboxPreparationBudgetErrorV1 extends Error {
	constructor(
		readonly reason: "budget_configuration_unavailable" | "budget_exhausted",
		readonly retryDelayMs: number,
	) {
		super("Session Sandbox preparation is waiting for its deployment budget");
	}
}

/** Rechecks the deployment budget before an original Session preparation/recovery write. */
export async function reserveSessionSandboxPreparationBudgetV1(
	tx: Transaction,
	sandboxId: string,
	policy: SessionSandboxVerifiedPolicyV1,
): Promise<void> {
	const config = await lockBudget(tx);
	if (!config) return;
	if (policy.namespace !== config.namespace)
		throw new SessionSandboxPreparationBudgetErrorV1(
			"budget_configuration_unavailable",
			config.failureBackoffMs,
		);
	const [row] = await tx<
		{ resources: SessionSandboxResourceBudgetV1; compute_released: boolean }[]
	>`select resources, compute_released from platform.session_sandbox_resource_charges where sandbox_id = ${sandboxId}`;
	// Ordinary cold Sessions have no reserve charge. Preparation must continue
	// without creating an aggregate-budget admission record.
	if (!row) return;
	const approved = config.resourceCosts.find(
		(c) => c.resourceConfigurationHash === policy.resourceConfigurationHash,
	);
	if (!approved)
		throw new SessionSandboxPreparationBudgetErrorV1(
			"budget_configuration_unavailable",
			config.failureBackoffMs,
		);
	const resources = {
		cpuMillis: Math.max(row.resources.cpuMillis, approved.resources.cpuMillis),
		memoryBytes: Math.max(
			row.resources.memoryBytes,
			approved.resources.memoryBytes,
		),
		storageBytes: Math.max(
			row.resources.storageBytes,
			approved.resources.storageBytes,
		),
	};
	// Preparation/recovery updates owned charge facts for observability; it does
	// not apply the deployment-wide reserve admission budget.
	await tx`update platform.session_sandbox_resource_charges set resources = ${tx.json(resources as unknown as Json)}, compute_released = false where sandbox_id = ${sandboxId}`;
}
/** Releases CPU/memory only after a durable stop receipt; retained PVC remains charged. */
export async function releaseSessionSandboxComputeBudgetV1(
	tx: Transaction,
	sandboxId: string,
): Promise<void> {
	await lockBudget(tx);
	await tx`update platform.session_sandbox_resource_charges ch set compute_released = true from platform.session_sandbox_allocations a where ch.sandbox_id = ${sandboxId} and a.sandbox_id = ch.sandbox_id and a.status = 'stopped' and a.desired_state = 'stopped' and exists(select 1 from platform.outbox_items o where o.scope_type = 'conversation' and o.scope_id = a.conversation_id and o.operation = 'conversation.sandbox.reconcile.v1' and o.payload->'lifecycle'->'stopReceipt'->>'sandboxId' = a.sandbox_id and o.payload->'lifecycle'->'stopReceipt'->>'sessionId' = a.conversation_id and o.payload->'lifecycle'->'stopReceipt'->>'targetGeneration' = a.session_generation::text and o.payload->'lifecycle'->'stopReceipt'->>'targetResourceFence' = a.resource_fence::text)`;
}

/** Worker #3778 consumes this independent conditional store; it never receives business principals or credentials. */
export class PostgresSessionSandboxReserveStoreV1 {
	readonly #client: ReturnType<typeof postgres>;
	readonly #configuration: SessionSandboxReserveConfigurationV1;
	constructor(options: {
		databaseUrl: string;
		configuration: SessionSandboxReserveConfigurationV1;
	}) {
		this.#configuration = parseSessionSandboxReserveConfigurationV1(
			options.configuration,
		);
		this.#client = postgres(options.databaseUrl, { max: 5 });
	}
	async applyConfiguration(): Promise<void> {
		await this.#client.begin(async (tx) => {
			await applyReserveConfiguration(tx, this.#configuration);
		});
	}

	async #readConfiguration(tx: Transaction) {
		const [row] = await tx<{ configuration: StoredReservePolicy }[]>`
			select configuration from platform.session_sandbox_budgets where namespace = ${this.#configuration.namespace}`;
		return row
			? decodeReservePolicy(row.configuration).policy
			: this.#configuration;
	}

	async close() {
		await this.#client.end();
	}
	async list(): Promise<
		readonly {
			sandboxId: string;
			agentId: string;
			profileDigest: string;
			status: SessionSandboxReserveStatusV1;
			expiresAt: Date;
			createdAt: Date;
			updatedAt: Date;
		}[]
	> {
		let page = await this.listPage({ limit: 100 });
		const items = [...page.items];
		while (page.nextCursor !== null) {
			page = await this.listPage({ cursor: page.nextCursor, limit: 100 });
			items.push(...page.items);
		}
		return items;
	}
	async listPage(
		input: { readonly cursor?: string; readonly limit?: number } = {},
	) {
		const limit = input.limit === undefined ? 100 : input.limit;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) unavailable();
		const cursor = input.cursor ?? "";
		const rows = await this.#client<
			{
				sandboxId: string;
				agentId: string;
				profileDigest: string;
				status: SessionSandboxReserveStatusV1;
				expiresAt: Date;
				createdAt: Date;
				updatedAt: Date;
			}[]
		>`select sandbox_id as "sandboxId", agent_id as "agentId", profile_digest as "profileDigest", status, expires_at as "expiresAt", created_at as "createdAt", updated_at as "updatedAt" from platform.session_sandbox_reserves where status <> 'claimed' and retired_at is null and (${cursor} = '' or sandbox_id > ${cursor}) order by sandbox_id limit ${limit + 1}`;
		const hasMore = rows.length > limit;
		const items = hasMore ? rows.slice(0, limit) : rows;
		const last = items.at(-1);
		return { items, nextCursor: hasMore && last ? last.sandboxId : null };
	}
	async inspect(
		sandboxId: string,
	): Promise<SessionSandboxReserveInspectionV1 | null> {
		return this.#client.begin(async (tx) => {
			const [row] = await tx<ReserveRow[]>`
				select * from platform.session_sandbox_reserves
				where sandbox_id = ${sandboxId} and retired_at is null`;
			if (!row) return null;
			const current = await readCurrentSessionSandboxReserveProfileV1(
				tx,
				row.agent_id,
				await this.#readConfiguration(tx),
			);
			return {
				sandboxId: row.sandbox_id,
				sessionId: row.session_id,
				agentId: row.agent_id,
				generation: 1,
				resourceFence: 1,
				status: row.status,
				profile: row.profile,
				operations: row.operations,
				expiresAt: row.expires_at,
				deployment: current?.deployment ?? null,
				modelProjection: current?.modelProjection ?? null,
				currentProfileDigest: current?.profile.digest ?? null,
			};
		});
	}
	/** Keep a verified ready reserve alive while this Worker is healthy. */
	async refreshReady(sandboxId: string, ttlMs: number): Promise<boolean> {
		if (!sandboxId || !Number.isSafeInteger(ttlMs) || ttlMs < 1) unavailable();
		return this.#client.begin(async (tx) => {
			await lockBudget(tx, this.#configuration);
			const rows = await tx`
				update platform.session_sandbox_reserves
				set expires_at = clock_timestamp() + ${ttlMs} * interval '1 millisecond',
					updated_at = clock_timestamp()
				where sandbox_id = ${sandboxId}
					and status = 'ready'
					and retired_at is null
					and expires_at > clock_timestamp()
				returning sandbox_id`;
			return rows.length === 1;
		});
	}
	async statistics(input: { readonly windowMs: number }) {
		if (!Number.isSafeInteger(input.windowMs) || input.windowMs < 1)
			unavailable();
		return this.#client.begin(async (tx) => {
			const { observedAt, profiles: rows } = await readReserveStatistics(
				tx,
				input.windowMs,
			);
			const configuration = await this.#readConfiguration(tx);
			const currentDigests = new Map<string, string | null>();
			for (const agentId of [
				...new Set([
					...rows.map((row) => row.agentId),
					...configuration.profiles.map((profile) => profile.agentId),
				]),
			].sort()) {
				const current = await readCurrentSessionSandboxReserveProfileV1(
					tx,
					agentId,
					configuration,
				);
				currentDigests.set(agentId, current?.profile.digest ?? null);
			}
			const profiles = rows.map((row) => ({
				...row,
				currentProfileDigest: currentDigests.get(row.agentId) ?? null,
				newSessionCount: Number(row.newSessionCount),
				claimedCount: Number(row.claimedCount),
			}));
			for (const [agentId, currentProfileDigest] of currentDigests) {
				if (
					currentProfileDigest &&
					!profiles.some(
						(profile) =>
							profile.agentId === agentId &&
							profile.profileDigest === currentProfileDigest,
					)
				) {
					profiles.push({
						agentId,
						profileDigest: currentProfileDigest,
						currentProfileDigest,
						newSessionCount: 0,
						claimedCount: 0,
						replenishmentCount: 0,
						replenishmentUpperBoundMs: null,
					});
				}
			}
			return {
				observedAt,
				windowMs: input.windowMs,
				profiles,
			};
		});
	}
	/** Bounded aggregate for monitoring; never used to reject ordinary Sessions. */
	async usage() {
		return this.#client.begin(async (tx) => {
			const [charges] = await tx<
				{ cpu: string; memory: string; storage: string }[]
			>`
				select coalesce(sum(case when compute_released or released then 0 else (resources->>'cpuMillis')::bigint end), 0)::text as cpu,
				coalesce(sum(case when compute_released or released then 0 else (resources->>'memoryBytes')::bigint end), 0)::text as memory,
				coalesce(sum(case when released then 0 else (resources->>'storageBytes')::bigint end), 0)::text as storage
				from platform.session_sandbox_resource_charges where namespace = ${this.#configuration.namespace}`;
			const [sessions] = await tx<{ count: string }[]>`
				select count(*)::text as count from platform.session_sandbox_allocations
				where namespace = ${this.#configuration.namespace}`;
			const [reserves] = await tx<{ count: string; claimed: string }[]>`
				select count(*) filter (where status <> 'claimed' and retired_at is null)::text as count,
				count(*) filter (where status = 'claimed' and retired_at is null)::text as claimed
				from platform.session_sandbox_reserves where namespace = ${this.#configuration.namespace}`;
			const [unknown] = await tx<{ count: string }[]>`
				select count(*)::text as count from platform.session_sandbox_allocations a
				where a.namespace = ${this.#configuration.namespace}
				and not exists (select 1 from platform.session_sandbox_resource_charges ch where ch.sandbox_id = a.sandbox_id)`;
			return {
				cpuMillis: Number(charges?.cpu ?? 0),
				memoryBytes: Number(charges?.memory ?? 0),
				storageBytes: Number(charges?.storage ?? 0),
				sessionCount: Number(sessions?.count ?? 0),
				reserveCount: Number(reserves?.count ?? 0),
				claimedReserveCount: Number(reserves?.claimed ?? 0),
				usageUnknownAllocationCount: Number(unknown?.count ?? 0),
			};
		});
	}
	async renewLease(
		lease: SessionSandboxReserveLeaseV1,
		leaseDurationMs: number,
	): Promise<boolean> {
		if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1)
			unavailable();
		return this.#mutate(lease, async (tx, row) => {
			await tx`update platform.session_sandbox_reserves set lease_expires_at = clock_timestamp() + ${leaseDurationMs} * interval '1 millisecond' where sandbox_id = ${row.sandbox_id}`;
			return true;
		});
	}

	async prepare(agentId: string): Promise<string | null> {
		return this.#client.begin(async (tx) => {
			const current = await readCurrentSessionSandboxReserveProfileV1(
				tx,
				agentId,
				this.#configuration,
			);
			const config = await lockBudget(tx, this.#configuration);
			if (!current || !config?.enabled) return null;
			return this.#prepare(tx, config, current.profile);
		});
	}
	async #prepare(
		tx: Transaction,
		config: SessionSandboxReserveConfigurationV1,
		profile: SessionSandboxReserveProfileV1,
	): Promise<string | null> {
		const approved =
			config.profiles.find((p) => p.agentId === profile.agentId) ??
			unavailable();
		const [count] = await tx<
			{ total: string; profile: string; preparing: string }[]
		>`select count(*)::text as total, count(*) filter(where profile_digest = ${profile.digest})::text as profile, count(*) filter(where status in ('preparing','unknown') or (status = 'retiring' and (exists(select 1 from jsonb_array_elements(operations) o where o->>'operation' = 'create' and o->>'writeCompletion' <> 'response') or executor_startup->'projection'->'create'->>'writeCompletion' = 'pending')))::text as preparing from platform.session_sandbox_reserves where status <> 'claimed' and retired_at is null`;
		if (
			!count ||
			Number(count.total) >= config.maximumReserves ||
			Number(count.profile) >= approved.maximum ||
			Number(count.preparing) >= config.maximumConcurrentCreates
		)
			return null;
		const sandboxId = randomUUID();
		const sessionId = randomUUID();
		await charge(tx, config, sandboxId, profile.resources);
		await tx`insert into platform.session_sandbox_reserves (sandbox_id, session_id, agent_id, namespace, profile_digest, profile, status, operations, expires_at, created_at, updated_at) values (${sandboxId}, ${sessionId}, ${profile.agentId}, ${config.namespace}, ${profile.digest}, ${tx.json(profile as unknown as Json)}, 'preparing', '[]', clock_timestamp() + ${config.ttlMs} * interval '1 millisecond', clock_timestamp(), clock_timestamp())`;
		return sandboxId;
	}
	/** One locked decision owns the target, cooldown, retire CAS and refill across Worker restarts. */
	async reconcileCapacity(
		agentId: string,
	): Promise<{ target: number; prepared: number; retired: number }> {
		return this.#client.begin(async (tx) => {
			const current = await readCurrentSessionSandboxReserveProfileV1(
				tx,
				agentId,
				this.#configuration,
			);
			const config = await lockBudget(tx, this.#configuration);
			if (!current || !config?.enabled)
				return { target: 0, prepared: 0, retired: 0 };
			const approved =
				config.profiles.find((p) => p.agentId === agentId) ?? unavailable();
			const statistics = await readReserveStatistics(tx, 60_000, agentId);
			const sample = statistics.profiles.find(
				(row) => row.profileDigest === current.profile.digest,
			);
			const active = await tx<
				{ sandbox_id: string }[]
			>`select sandbox_id from platform.session_sandbox_reserves where agent_id = ${agentId} and namespace = ${config.namespace} and profile_digest = ${current.profile.digest} and status in ('ready','preparing') and retired_at is null order by created_at desc, sandbox_id for update`;
			const [total] = await tx<
				{ count: string }[]
			>`select count(*)::text as count from platform.session_sandbox_reserves where status <> 'claimed' and retired_at is null`;
			const used = await usedBudget(tx, config.namespace);
			const capacity = Math.max(
				0,
				Math.min(
					config.maximumReserves - Number(total?.count ?? 0) + active.length,
					...(["cpuMillis", "memoryBytes", "storageBytes"] as const).map(
						(key) =>
							active.length +
							Math.floor(
								(config.totalBudget[key] - used[key]) /
									current.profile.resources[key],
							),
					),
				),
			);
			const target = Math.min(
				capacity,
				sessionSandboxReserveTargetV1({
					minimum: approved.minimum,
					maximum: approved.maximum,
					windowMs: statistics.windowMs,
					newSessionCount: sample?.newSessionCount ?? 0,
					replenishmentUpperBoundMs: sample?.replenishmentUpperBoundMs ?? null,
				}),
			);
			const [budget] = await tx<
				{ reserve_sizing: Record<string, ReserveSizing> }[]
			>`select reserve_sizing from platform.session_sandbox_budgets where namespace = ${config.namespace}`;
			const sizing = budget?.reserve_sizing ?? {};
			const previous = sizing[agentId];
			const time = statistics.observedAt.getTime();
			const low = active.length > target;
			const lowSince = low
				? previous?.profileDigest === current.profile.digest &&
					previous.lowSince !== null &&
					previous.lowTarget !== null &&
					target === previous.lowTarget
					? previous.lowSince
					: time
				: null;
			sizing[agentId] = {
				profileDigest: current.profile.digest,
				target,
				lowTarget: low ? target : null,
				lowSince,
			};
			await tx`update platform.session_sandbox_budgets set reserve_sizing = ${tx.json(sizing as unknown as Json)} where namespace = ${config.namespace}`;
			let retired = 0;
			if (lowSince !== null && time - lowSince >= config.cooldownMs) {
				for (const row of active.slice(0, active.length - target)) {
					if (await retireReserve(tx, row.sandbox_id)) retired++;
				}
			}
			const prepared =
				active.length < target &&
				(await this.#prepare(tx, config, current.profile))
					? 1
					: 0;
			return { target, prepared, retired };
		});
	}
	async claimLease(input: {
		sandboxId: string;
		workerId: string;
		leaseDurationMs: number;
	}): Promise<SessionSandboxReserveWorkerClaimV1 | null> {
		if (
			!input.workerId ||
			!Number.isSafeInteger(input.leaseDurationMs) ||
			input.leaseDurationMs < 1
		)
			unavailable();
		return this.#client.begin(async (tx) => {
			const [hint] = await tx<
				{ agent_id: string }[]
			>`select agent_id from platform.session_sandbox_reserves where sandbox_id = ${input.sandboxId}`;
			if (!hint) return null;
			const current = await readCurrentSessionSandboxReserveProfileV1(
				tx,
				hint.agent_id,
				this.#configuration,
			);
			await lockBudget(tx, this.#configuration);
			const [row] = await tx<
				ReserveRow[]
			>`update platform.session_sandbox_reserves set lease_owner = ${input.workerId}, lease_expires_at = clock_timestamp() + ${input.leaseDurationMs} * interval '1 millisecond', delivery_fence = delivery_fence + 1, updated_at = clock_timestamp() where sandbox_id = ${input.sandboxId} and status in ('preparing','unknown','retiring') and retired_at is null and (lease_expires_at is null or lease_expires_at <= clock_timestamp()) and (status = 'retiring' or (profile_digest = ${current?.profile.digest ?? ""} and expires_at > clock_timestamp())) returning *`;
			if (!row) return null;
			return {
				sandboxId: row.sandbox_id,
				sessionId: row.session_id,
				agentId: row.agent_id,
				generation: 1,
				resourceFence: 1,
				status: row.status,
				profile: row.profile,
				operations: row.operations,
				expiresAt: row.expires_at,
				leaseOwner: input.workerId,
				deliveryFence: Number(row.delivery_fence),
				deployment: current?.deployment ?? null,
				modelProjection: current?.modelProjection ?? null,
				executorStartup: row.executor_startup,
			};
		});
	}
	async #mutate<T = boolean>(
		lease: SessionSandboxReserveLeaseV1,
		action: (tx: Transaction, row: ReserveRow) => Promise<T | false>,
	): Promise<T | false> {
		return this.#client.begin(async (tx) => {
			await lockBudget(tx, this.#configuration);
			const [row] = await tx<
				ReserveRow[]
			>`select * from platform.session_sandbox_reserves where sandbox_id = ${lease.sandboxId} and lease_owner = ${lease.leaseOwner} and delivery_fence = ${lease.deliveryFence} and lease_expires_at > clock_timestamp() and status <> 'claimed' and retired_at is null for update`;
			if (!row) return false;
			return action(tx, row);
		}) as Promise<T | false>;
	}
	async recordIntent(
		lease: SessionSandboxReserveLeaseV1,
		operation: SessionSandboxReserveOperationInputV1,
	): Promise<boolean> {
		return this.#mutate(lease, async (tx, row) => {
			const sameOperation = row.operations.filter(
				(o) => o.kind === operation.kind && o.operation === operation.operation,
			);
			if (
				!sessionSandboxReserveResourceKindsV1.includes(operation.kind) ||
				operation.status !== "pending" ||
				operation.absent ||
				!operation.attemptId ||
				operation.name !== `sandbox-${row.sandbox_id}` ||
				row.operations.some((o) => o.attemptId === operation.attemptId)
			)
				return false;
			if (
				sameOperation.some(
					(o) =>
						operation.operation !== "delete" ||
						o.status !== "rejected" ||
						o.writeCompletion !== "response",
				)
			)
				return false;
			if (
				operation.operation === "delete" &&
				(sameOperation.length >= 3 ||
					sameOperation.some(
						(prior) =>
							prior.resource?.resourceVersion ===
							operation.resource?.resourceVersion,
					))
			)
				return false;
			if (
				operation.operation === "create"
					? row.status === "retiring" || operation.resource !== null
					: row.status !== "retiring" ||
						!operation.resource ||
						!operation.resource.uid ||
						!operation.resource.resourceVersion ||
						operation.resource.kind !== operation.kind ||
						operation.resource.name !== operation.name ||
						operation.resource.namespace !== row.namespace ||
						!row.operations.some(
							(o) =>
								o.operation === "create" &&
								o.status === "confirmed" &&
								o.writeCompletion === "response" &&
								isDeepStrictEqual(o.resource, operation.resource),
						)
			)
				return false;
			const intent: SessionSandboxReserveOperationV1 = {
				...operation,
				writeCompletion: "pending",
				writer: { owner: lease.leaseOwner, fence: lease.deliveryFence },
			};
			await tx`update platform.session_sandbox_reserves set operations = ${tx.json([...row.operations, intent] as unknown as Json)}, updated_at = clock_timestamp() where sandbox_id = ${row.sandbox_id}`;
			return true;
		});
	}
	async recordResult(
		lease: SessionSandboxReserveLeaseV1,
		operation: SessionSandboxReserveOperationInputV1,
	): Promise<boolean> {
		return this.#mutate(lease, async (tx, row) => {
			const before = row.operations.find(
				(o) => o.attemptId === operation.attemptId,
			);
			if (
				!before ||
				before.writer.owner !== lease.leaseOwner ||
				before.writer.fence !== lease.deliveryFence ||
				before.writeCompletion !== "pending" ||
				!["pending", "unknown"].includes(before.status) ||
				operation.status !== "unknown" ||
				operation.absent ||
				before.operation !== operation.operation ||
				before.kind !== operation.kind ||
				before.name !== operation.name
			)
				return false;
			if (
				operation.resource &&
				(operation.resource.kind !== operation.kind ||
					operation.resource.name !== operation.name ||
					operation.resource.namespace !== row.namespace ||
					!operation.resource.uid ||
					!operation.resource.resourceVersion)
			)
				return false;
			// A create absence never proves the attempt has finished. Only observed UID or definite create rejection does.
			if (
				operation.operation === "create" &&
				(operation.absent || operation.status !== "unknown")
			)
				return false;
			if (
				operation.operation === "delete" &&
				!isDeepStrictEqual(operation.resource, before.resource)
			)
				return false;
			const operations = row.operations.map((o) =>
				o.attemptId === operation.attemptId
					? {
							...operation,
							writer: before.writer,
							writeCompletion: before.writeCompletion,
						}
					: o,
			);
			await tx`update platform.session_sandbox_reserves set operations = ${tx.json(operations as unknown as Json)}, status = case when status = 'retiring' then status when ${operation.status} = 'unknown' then 'unknown' else status end, updated_at = clock_timestamp() where sandbox_id = ${row.sandbox_id}`;
			return true;
		});
	}

	async recordCreateResponse(
		lease: SessionSandboxReserveLeaseV1,
		input: {
			attemptId: string;
			response: "created" | "rejected";
			resource: SessionSandboxResourceIdentityV1 | null;
		},
	): Promise<boolean> {
		return this.#client.begin(async (tx) => {
			await lockBudget(tx);
			const [row] = await tx<
				ReserveRow[]
			>`select * from platform.session_sandbox_reserves where sandbox_id = ${lease.sandboxId} and status in ('preparing','unknown','retiring') and retired_at is null for update`;
			const before = row?.operations.find(
				(o) => o.attemptId === input.attemptId,
			);
			if (
				!row ||
				!before ||
				before.operation !== "create" ||
				before.writeCompletion !== "pending" ||
				before.writer.owner !== lease.leaseOwner ||
				before.writer.fence !== lease.deliveryFence ||
				!["pending", "unknown"].includes(before.status)
			)
				return false;
			if (
				input.response === "created"
					? !input.resource ||
						input.resource.kind !== before.kind ||
						input.resource.name !== before.name ||
						input.resource.namespace !== row.namespace ||
						!input.resource.uid ||
						!input.resource.resourceVersion ||
						(before.resource && before.resource.uid !== input.resource.uid)
					: input.resource !== null || before.resource !== null
			)
				return false;
			const completed: SessionSandboxReserveOperationV1 = {
				...before,
				status: input.response === "created" ? "confirmed" : "rejected",
				resource: input.resource,
				writeCompletion: "response",
			};
			const operations = row.operations.map((o) =>
				o.attemptId === before.attemptId ? completed : o,
			);
			const settled =
				operations.every(
					(operation) => operation.writeCompletion === "response",
				) && sessionSandboxReserveExecutorSettledV1(row.executor_startup);
			const status =
				row.status === "unknown" && settled ? "preparing" : row.status;
			await tx`update platform.session_sandbox_reserves set operations = ${tx.json(operations as unknown as Json)}, status = ${status}, updated_at = clock_timestamp() where sandbox_id = ${row.sandbox_id}`;
			return true;
		});
	}

	async recordDeleteResponse(
		lease: SessionSandboxReserveLeaseV1,
		input: {
			attemptId: string;
			response: SessionSandboxReserveDeleteResponseV1;
			resource: SessionSandboxResourceIdentityV1;
		},
	): Promise<boolean> {
		return this.#client.begin(async (tx) => {
			await lockBudget(tx);
			const [row] = await tx<ReserveRow[]>`
				select * from platform.session_sandbox_reserves
				where sandbox_id = ${lease.sandboxId}
					and status = 'retiring' and retired_at is null
				for update`;
			const before = row?.operations.find(
				(operation) => operation.attemptId === input.attemptId,
			);
			if (
				!row ||
				before?.operation !== "delete" ||
				before.writeCompletion !== "pending" ||
				!before.resource ||
				before.writer.owner !== lease.leaseOwner ||
				before.writer.fence !== lease.deliveryFence ||
				!isDeepStrictEqual(before.resource, input.resource)
			)
				return false;
			const completed: SessionSandboxReserveOperationV1 = {
				...before,
				status: input.response === "rejected" ? "rejected" : "confirmed",
				absent: input.response === "absent",
				writeCompletion: "response",
			};
			await tx`update platform.session_sandbox_reserves set operations = ${tx.json(row.operations.map((operation) => (operation.attemptId === before.attemptId ? completed : operation)) as unknown as Json)}, updated_at = clock_timestamp() where sandbox_id = ${row.sandbox_id}`;
			return true;
		});
	}

	/** GET absence is release evidence only after the original DELETE response settles. */
	async recordDeleteObservation(
		lease: SessionSandboxReserveLeaseV1,
		input: { readonly attemptId: string },
	): Promise<boolean> {
		return this.#mutate(lease, async (tx, row) => {
			const before = row.operations.find(
				(operation) => operation.attemptId === input.attemptId,
			);
			if (
				row.status !== "retiring" ||
				before?.operation !== "delete" ||
				before.absent ||
				!before.resource ||
				before.writeCompletion !== "response" ||
				!["confirmed", "rejected"].includes(before.status)
			)
				return false;
			if (
				row.operations.some(
					(operation) =>
						operation !== before &&
						operation.operation === "delete" &&
						operation.kind === before.kind &&
						(operation.status !== "rejected" ||
							operation.writeCompletion !== "response"),
				)
			)
				return false;
			const observed: SessionSandboxReserveOperationV1 = {
				...before,
				status: "confirmed",
				absent: true,
			};
			await tx`update platform.session_sandbox_reserves set operations = ${tx.json(row.operations.map((operation) => (operation.attemptId === before.attemptId ? observed : operation)) as unknown as Json)}, updated_at = clock_timestamp() where sandbox_id = ${row.sandbox_id}`;
			return true;
		});
	}

	async recordObservation(
		lease: SessionSandboxReserveLeaseV1,
		resource: SessionSandboxResourceIdentityV1,
	): Promise<boolean> {
		return this.#mutate(lease, async (tx, row) => {
			const before = row.operations.find(
				(o) => o.operation === "create" && o.kind === resource.kind,
			);
			if (
				!before ||
				!resource.uid ||
				!resource.resourceVersion ||
				resource.namespace !== row.namespace ||
				resource.name !== before.name ||
				(before.resource && before.resource.uid !== resource.uid) ||
				before.status === "rejected" ||
				row.operations.some(
					(o) =>
						o.operation === "delete" &&
						o.kind === resource.kind &&
						(o.status !== "rejected" || o.writeCompletion !== "response"),
				)
			)
				return false;
			const observed: SessionSandboxReserveOperationV1 = {
				...before,
				resource,
				status: before.writeCompletion === "response" ? "confirmed" : "unknown",
			};
			await tx`update platform.session_sandbox_reserves set operations = ${tx.json(row.operations.map((o) => (o.attemptId === before.attemptId ? observed : o)) as unknown as Json)}, updated_at = clock_timestamp() where sandbox_id = ${row.sandbox_id}`;
			return true;
		});
	}

	async #writeExecutor(
		tx: Transaction,
		row: ReserveRow,
		startup: SessionSandboxReserveExecutorStartupV1,
		status: SessionSandboxReserveStatusV1 = row.status,
	): Promise<void> {
		await tx`update platform.session_sandbox_reserves set executor_startup = ${tx.json(startup as unknown as Json)}, status = ${status}, updated_at = clock_timestamp() where sandbox_id = ${row.sandbox_id}`;
	}
	async #beforeExecutorDeadline(
		tx: Transaction,
		startup: SessionSandboxReserveExecutorStartupV1,
	): Promise<boolean> {
		const [clock] = await tx<{ open: boolean }[]>`
			select ${startup.deadlineMs}::float8 > extract(epoch from clock_timestamp()) * 1000 as open`;
		return clock?.open === true;
	}
	/**
	 * Freeze the startup ref and absolute deadline from the database clock before
	 * the reserve Pod create intent. Retries return the original deadline.
	 */
	async recordExecutorStartup(
		lease: SessionSandboxReserveLeaseV1,
		input: { readonly timeoutMs: number },
	): Promise<number | null> {
		if (
			!Number.isSafeInteger(input.timeoutMs) ||
			input.timeoutMs < 1000 ||
			input.timeoutMs > 900_000
		)
			throw new TypeError("Invalid executor startup timeout");
		const deadline = await this.#mutate<number>(lease, async (tx, row) => {
			const startupRef = sessionSandboxReserveExecutorStartupRefV1(
				row.sandbox_id,
			);
			const existing = row.executor_startup;
			if (existing)
				return existing.startupRef === startupRef ? existing.deadlineMs : false;
			if (
				row.status !== "preparing" ||
				row.operations.some((operation) => operation.kind === "Pod")
			)
				return false;
			const [clock] = await tx<{ deadline_ms: number }[]>`
				select floor(extract(epoch from clock_timestamp()) * 1000)::float8 + ${input.timeoutMs}::float8 as deadline_ms`;
			const deadlineMs = clock?.deadline_ms;
			if (typeof deadlineMs !== "number" || !Number.isSafeInteger(deadlineMs))
				return false;
			await this.#writeExecutor(tx, row, {
				schemaVersion: 1,
				startupRef,
				deadlineMs,
				writer: { owner: lease.leaseOwner, fence: lease.deliveryFence },
				projection: null,
				consumption: null,
			});
			return deadlineMs;
		});
		return deadline === false ? null : deadline;
	}
	/**
	 * Fix the projection attempt and Host public identity after the actual Pod UID
	 * is read back and before the projection is created. One attempt never re-keys.
	 */
	async recordExecutorProjectionIntent(
		lease: SessionSandboxReserveLeaseV1,
		input: {
			readonly attemptId: string;
			readonly podUid: string;
			readonly hostKeyId: string;
			readonly hostPublicKey: string;
			readonly bindingDigest: string;
		},
	): Promise<boolean> {
		if (
			![
				input.attemptId,
				input.podUid,
				input.hostKeyId,
				input.hostPublicKey,
			].every((value) => typeof value === "string" && boundedText(value)) ||
			!/^[0-9a-f]{64}$/.test(input.bindingDigest)
		)
			return false;
		return this.#mutate(lease, async (tx, row) => {
			const startup = row.executor_startup;
			if (!startup || row.status !== "preparing") return false;
			const existing = startup.projection;
			if (existing)
				return (
					existing.create.attemptId === input.attemptId &&
					existing.podUid === input.podUid &&
					existing.hostKeyId === input.hostKeyId &&
					existing.hostPublicKey === input.hostPublicKey &&
					existing.bindingDigest === input.bindingDigest
				);
			const pod = row.operations.find(
				(operation) =>
					operation.kind === "Pod" && operation.operation === "create",
			);
			if (
				pod?.status !== "confirmed" ||
				pod.writeCompletion !== "response" ||
				pod.resource?.uid !== input.podUid ||
				row.operations.some(
					(operation) => operation.attemptId === input.attemptId,
				) ||
				!(await this.#beforeExecutorDeadline(tx, startup))
			)
				return false;
			await this.#writeExecutor(tx, row, {
				...startup,
				projection: {
					podUid: input.podUid,
					hostKeyId: input.hostKeyId,
					hostPublicKey: input.hostPublicKey,
					bindingDigest: input.bindingDigest,
					create: {
						attemptId: input.attemptId,
						status: "pending",
						resource: null,
						absent: false,
						writeCompletion: "pending",
						writer: { owner: lease.leaseOwner, fence: lease.deliveryFence },
					},
					deletes: [],
				},
			});
			return true;
		});
	}
	/** Original projection create response; like `recordCreateResponse`, only the original writer settles it. */
	async recordExecutorProjectionCreateResponse(
		lease: SessionSandboxReserveLeaseV1,
		input: {
			readonly attemptId: string;
			readonly response: "created" | "rejected";
			readonly resource: SessionSandboxResourceIdentityV1 | null;
		},
	): Promise<boolean> {
		return this.#client.begin(async (tx) => {
			await lockBudget(tx);
			const [row] = await tx<
				ReserveRow[]
			>`select * from platform.session_sandbox_reserves where sandbox_id = ${lease.sandboxId} and status in ('preparing','unknown','retiring') and retired_at is null for update`;
			const startup = row?.executor_startup;
			const projection = startup?.projection;
			const create = projection?.create;
			if (
				!row ||
				!startup ||
				!projection ||
				create?.attemptId !== input.attemptId ||
				create.writeCompletion !== "pending" ||
				create.writer.owner !== lease.leaseOwner ||
				create.writer.fence !== lease.deliveryFence ||
				!["pending", "unknown"].includes(create.status) ||
				(input.response === "created"
					? !isProjectionIdentity(input.resource, row, startup)
					: input.resource !== null)
			)
				return false;
			const next: SessionSandboxReserveExecutorStartupV1 = {
				...startup,
				projection: {
					...projection,
					create: {
						...create,
						status: input.response === "created" ? "confirmed" : "rejected",
						resource: input.resource,
						writeCompletion: "response",
					},
				},
			};
			await this.#writeExecutor(tx, row, next, settledStatus(row, next));
			return true;
		});
	}
	/** A projection write whose result is unknown keeps the reserve unclaimable. */
	async recordExecutorProjectionResult(
		lease: SessionSandboxReserveLeaseV1,
		input: { readonly attemptId: string },
	): Promise<boolean> {
		return this.#mutate(lease, async (tx, row) => {
			const startup = row.executor_startup;
			const projection = startup?.projection;
			if (!startup || !projection) return false;
			const before = [projection.create, ...projection.deletes].find(
				(write) => write.attemptId === input.attemptId,
			);
			if (
				!before ||
				before.writer.owner !== lease.leaseOwner ||
				before.writer.fence !== lease.deliveryFence ||
				before.writeCompletion !== "pending" ||
				!["pending", "unknown"].includes(before.status)
			)
				return false;
			const mark = (write: SessionSandboxReserveProjectionWriteV1) =>
				write.attemptId === input.attemptId
					? { ...write, status: "unknown" as const }
					: write;
			await this.#writeExecutor(
				tx,
				row,
				{
					...startup,
					projection: {
						...projection,
						create: mark(projection.create),
						deletes: projection.deletes.map(mark),
					},
				},
				row.status === "retiring" ? "retiring" : "unknown",
			);
			return true;
		});
	}
	/** Both roles consumed the original projection before the deadline (from verified Host evidence). */
	async recordExecutorConsumption(
		lease: SessionSandboxReserveLeaseV1,
		input: {
			readonly attemptId: string;
			readonly podUid: string;
			readonly projectionUid: string;
			readonly hostKeyId: string;
			readonly runnerEpoch: string;
			/** Verified `reserve`-scope instance evidence for this lease. */
			readonly evidence: SessionSandboxInstanceEvidenceV1;
		},
	): Promise<boolean> {
		if (!boundedText(input.runnerEpoch)) return false;
		const consumption = {
			attemptId: input.attemptId,
			podUid: input.podUid,
			projectionUid: input.projectionUid,
			hostKeyId: input.hostKeyId,
			runnerEpoch: input.runnerEpoch,
		};
		return this.#mutate(lease, async (tx, row) => {
			const startup = row.executor_startup;
			const projection = startup?.projection;
			if (
				!startup ||
				!projection ||
				row.status !== "preparing" ||
				!reserveEvidenceMatches(input.evidence, row.sandbox_id, lease, input) ||
				!(await evidenceCurrent(tx, input.evidence))
			)
				return false;
			if (startup.consumption)
				return isDeepStrictEqual(startup.consumption, consumption);
			const { create } = projection;
			if (
				create.attemptId !== input.attemptId ||
				create.status !== "confirmed" ||
				create.writeCompletion !== "response" ||
				create.resource?.uid !== input.projectionUid ||
				projection.podUid !== input.podUid ||
				projection.hostKeyId !== input.hostKeyId ||
				projection.deletes.length > 0 ||
				!(await this.#beforeExecutorDeadline(tx, startup))
			)
				return false;
			await this.#writeExecutor(tx, row, { ...startup, consumption });
			return true;
		});
	}
	/** Persist the conditional DELETE intent of the original projection before sending it. */
	async recordExecutorProjectionDeleteIntent(
		lease: SessionSandboxReserveLeaseV1,
		input: {
			readonly attemptId: string;
			readonly resource: SessionSandboxResourceIdentityV1;
		},
	): Promise<boolean> {
		return this.#mutate(lease, async (tx, row) => {
			const startup = row.executor_startup;
			const projection = startup?.projection;
			if (!startup || !projection || !boundedText(input.attemptId))
				return false;
			const { create } = projection;
			if (
				create.status !== "confirmed" ||
				create.writeCompletion !== "response" ||
				!isProjectionIdentity(input.resource, row, startup) ||
				input.resource.uid !== create.resource?.uid ||
				(row.status === "preparing"
					? !startup.consumption
					: row.status !== "retiring") ||
				projection.deletes.length >= 3 ||
				projection.deletes.some(
					(prior) =>
						prior.status !== "rejected" ||
						prior.writeCompletion !== "response" ||
						prior.resource?.resourceVersion === input.resource.resourceVersion,
				) ||
				[create, ...projection.deletes].some(
					(write) => write.attemptId === input.attemptId,
				) ||
				row.operations.some(
					(operation) => operation.attemptId === input.attemptId,
				)
			)
				return false;
			await this.#writeExecutor(tx, row, {
				...startup,
				projection: {
					...projection,
					deletes: [
						...projection.deletes,
						{
							attemptId: input.attemptId,
							status: "pending",
							resource: input.resource,
							absent: false,
							writeCompletion: "pending",
							writer: { owner: lease.leaseOwner, fence: lease.deliveryFence },
						},
					],
				},
			});
			return true;
		});
	}
	/** Original projection DELETE response; `absent` is the provider's own not-found response. */
	async recordExecutorProjectionDeleteResponse(
		lease: SessionSandboxReserveLeaseV1,
		input: {
			readonly attemptId: string;
			readonly response: SessionSandboxReserveDeleteResponseV1;
		},
	): Promise<boolean> {
		return this.#client.begin(async (tx) => {
			await lockBudget(tx);
			const [row] = await tx<
				ReserveRow[]
			>`select * from platform.session_sandbox_reserves where sandbox_id = ${lease.sandboxId} and status in ('preparing','unknown','retiring') and retired_at is null for update`;
			const startup = row?.executor_startup;
			const projection = startup?.projection;
			const before = projection?.deletes.find(
				(write) => write.attemptId === input.attemptId,
			);
			if (
				!row ||
				!startup ||
				!projection ||
				!before ||
				before.writeCompletion !== "pending" ||
				before.writer.owner !== lease.leaseOwner ||
				before.writer.fence !== lease.deliveryFence
			)
				return false;
			const completed: SessionSandboxReserveProjectionWriteV1 = {
				...before,
				status: input.response === "rejected" ? "rejected" : "confirmed",
				absent: input.response === "absent",
				writeCompletion: "response",
			};
			const next: SessionSandboxReserveExecutorStartupV1 = {
				...startup,
				projection: {
					...projection,
					deletes: projection.deletes.map((write) =>
						write.attemptId === before.attemptId ? completed : write,
					),
				},
			};
			await this.#writeExecutor(tx, row, next, settledStatus(row, next));
			return true;
		});
	}
	/** A fresh absence after the original DELETE response settled; never a DELETE acknowledgement. */
	async recordExecutorProjectionDeleteObservation(
		lease: SessionSandboxReserveLeaseV1,
		input: { readonly attemptId: string },
	): Promise<boolean> {
		return this.#mutate(lease, async (tx, row) => {
			const startup = row.executor_startup;
			const projection = startup?.projection;
			const last = projection?.deletes.at(-1);
			if (
				!startup ||
				!projection ||
				last?.attemptId !== input.attemptId ||
				last.absent ||
				last.writeCompletion !== "response" ||
				!["confirmed", "rejected"].includes(last.status)
			)
				return false;
			await this.#writeExecutor(tx, row, {
				...startup,
				projection: {
					...projection,
					deletes: [
						...projection.deletes.slice(0, -1),
						{ ...last, status: "confirmed", absent: true },
					],
				},
			});
			return true;
		});
	}
	async recordExecutorPromotion(
		input: SessionSandboxExecutorPromotionInputV1,
	): Promise<SessionSandboxExecutorPromotionReceiptRefV1 | null> {
		return this.#client.begin((tx) =>
			recordSessionSandboxExecutorPromotionV1(tx, input),
		) as Promise<SessionSandboxExecutorPromotionReceiptRefV1 | null>;
	}
	async markReady(
		lease: SessionSandboxReserveLeaseV1,
		evidence: {
			bootstrapReady: boolean;
			businessStateAbsent: boolean;
			/** Required for an executor reserve: fresh `reserve`-scope evidence of the consumed instance. */
			instanceEvidence?: SessionSandboxInstanceEvidenceV1;
		},
	): Promise<boolean> {
		// Re-read current profile before budget/reserve locks. Old deployment facts cannot confer readiness.
		return this.#client.begin(async (tx) => {
			const [hint] = await tx<
				{ agent_id: string }[]
			>`select agent_id from platform.session_sandbox_reserves where sandbox_id = ${lease.sandboxId}`;
			const current = hint
				? await readCurrentSessionSandboxReserveProfileV1(
						tx,
						hint.agent_id,
						this.#configuration,
					)
				: null;
			await lockBudget(tx, this.#configuration);
			const [row] = await tx<
				ReserveRow[]
			>`select * from platform.session_sandbox_reserves where sandbox_id = ${lease.sandboxId} and lease_owner = ${lease.leaseOwner} and delivery_fence = ${lease.deliveryFence} and lease_expires_at > clock_timestamp() and expires_at > clock_timestamp() and retired_at is null for update`;
			if (
				!row ||
				!current ||
				row.profile_digest !== current.profile.digest ||
				!canReadySessionSandboxReserveV1({
					bootstrapReady: evidence.bootstrapReady,
					businessStateAbsent: evidence.businessStateAbsent,
					status: row.status,
					operations: row.operations,
					executorStartup: row.executor_startup,
				})
			)
				return false;
			const consumed = row.executor_startup?.consumption;
			if (
				row.executor_startup &&
				(!consumed ||
					!reserveEvidenceMatches(
						evidence.instanceEvidence,
						row.sandbox_id,
						lease,
						consumed,
					) ||
					!(await evidenceCurrent(tx, evidence.instanceEvidence)))
			)
				return false;
			const business =
				await tx`select 1 from platform.conversations where id = ${row.session_id} union all select 1 from platform.session_sandbox_allocations where sandbox_id = ${row.sandbox_id}`;
			if (business.length) return false;
			await tx`update platform.session_sandbox_reserves set status = 'ready', ready_at = coalesce(ready_at, clock_timestamp()), lease_owner = null, lease_expires_at = null, delivery_fence = delivery_fence + 1, updated_at = clock_timestamp() where sandbox_id = ${row.sandbox_id}`;
			return true;
		});
	}
	async retire(sandboxId: string): Promise<boolean> {
		return this.#client.begin(async (tx) => {
			await lockBudget(tx, this.#configuration);
			return retireReserve(tx, sandboxId);
		});
	}
	async finishRetirement(
		lease: SessionSandboxReserveLeaseV1,
	): Promise<boolean> {
		return this.#mutate(lease, async (tx, row) => {
			if (
				!canReleaseSessionSandboxReserveV1({
					status: row.status,
					operations: row.operations,
					executorStartup: row.executor_startup,
				})
			)
				return false;
			const business =
				await tx`select 1 from platform.conversations where id = ${row.session_id} union all select 1 from platform.session_sandbox_allocations where sandbox_id = ${row.sandbox_id}`;
			if (business.length) return false;
			await tx`update platform.session_sandbox_reserves set retired_at = clock_timestamp(), lease_owner = null, lease_expires_at = null, delivery_fence = delivery_fence + 1, updated_at = clock_timestamp() where sandbox_id = ${row.sandbox_id}`;
			await tx`update platform.session_sandbox_resource_charges set released = true where sandbox_id = ${row.sandbox_id}`;
			return true;
		});
	}
}
