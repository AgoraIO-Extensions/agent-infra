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
	type SessionSandboxObservationV1,
	type SessionSandboxReserveClaimV1,
	type SessionSandboxReserveConfigurationV1,
	type SessionSandboxReserveLeaseV1,
	type SessionSandboxReserveOperationInputV1,
	type SessionSandboxReserveOperationV1,
	type SessionSandboxReserveProfileV1,
	type SessionSandboxReserveStatusV1,
	type SessionSandboxResourceBudgetV1,
	type SessionSandboxResourceIdentityV1,
	type SessionSandboxVerifiedPolicyV1,
	sessionSandboxBudgetFitsV1,
	sessionSandboxReserveDigestV1,
	sessionSandboxReserveResourceKindsV1,
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
}
export interface SessionSandboxAdmissionV1 {
	readonly binding: SessionSandboxBindingV1;
	readonly profile: SessionSandboxReserveProfileV1 | null;
	readonly observation: SessionSandboxObservationV1 | null;
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
	if (!previous && !config.enabled) return null;
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
	// Missing original resource policy or unapproved costs cannot be guessed during rollout.
	const uncharged = await tx<
		{ sandbox_id: string; resource_hash: string | null }[]
	>`select a.sandbox_id, a.resource_policy->>'resourceConfigurationHash' as resource_hash from platform.session_sandbox_allocations a where not exists(select 1 from platform.session_sandbox_resource_charges ch where ch.sandbox_id = a.sandbox_id)`;
	for (const allocation of uncharged) {
		const cost = allocation.resource_hash
			? config.resourceCosts.find(
					(c) => c.resourceConfigurationHash === allocation.resource_hash,
				)
			: config.resourceCosts.length === 1
				? config.resourceCosts[0]
				: undefined;
		if (!cost) unavailable();
		await tx`insert into platform.session_sandbox_resource_charges (sandbox_id, namespace, resources) values (${allocation.sandbox_id}, ${config.namespace}, ${tx.json(cost.resources as unknown as Json)})`;
	}
	// Only the original Session lifecycle's confirmed stop receipt releases compute. PVC remains charged.
	await tx`update platform.session_sandbox_resource_charges ch set compute_released = true from platform.session_sandbox_allocations a
  where a.sandbox_id = ch.sandbox_id and a.status = 'stopped' and a.desired_state = 'stopped' and exists (
   select 1 from platform.outbox_items o where o.scope_type = 'conversation' and o.scope_id = a.conversation_id and o.operation = 'conversation.sandbox.reconcile.v1'
   and o.payload->'lifecycle'->'stopReceipt'->>'sandboxId' = a.sandbox_id
   and o.payload->'lifecycle'->'stopReceipt'->>'sessionId' = a.conversation_id
   and o.payload->'lifecycle'->'stopReceipt'->>'targetGeneration' = a.session_generation::text
   and o.payload->'lifecycle'->'stopReceipt'->>'targetResourceFence' = a.resource_fence::text)`;
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
  from platform.session_sandbox_resource_charges ch where namespace = ${namespace} and not released and (
   exists(select 1 from platform.session_sandbox_allocations a where a.sandbox_id = ch.sandbox_id)
   or exists(select 1 from platform.session_sandbox_reserves r where r.sandbox_id = ch.sandbox_id and r.retired_at is null))`;
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
				profile: current.profile,
				observation: {
					status: "observed",
					resources: row.operations.map((o) => o.resource ?? unavailable()),
				},
			};
		}
	}
	if (configured?.enabled && config?.enabled) {
		const [workload] = await tx<
			{ resource_hash: string | null }[]
		>`select state->'verified'->'executionCapacity'->>'resourceConfigurationHash' as resource_hash from platform.workload_reconciliations where agent_id = ${authority.agentId}`;
		const cost = config.resourceCosts.find(
			(c) => c.resourceConfigurationHash === workload?.resource_hash,
		);
		if (!cost) unavailable();
		await charge(
			tx,
			config,
			fallback.sandboxId,
			current?.profile.resources ?? cost.resources,
		);
	}
	return { binding: fallback, profile: null, observation: null };
}
export async function adoptSessionSandboxReserveV1(
	tx: Transaction,
	admission: SessionSandboxAdmissionV1,
): Promise<void> {
	if (!admission.profile || !admission.observation) return;
	const changed =
		await tx`update platform.session_sandbox_allocations set resource_fence = 1, resource_policy = ${tx.json(admission.profile.policy as unknown as Json)}, resource_observation = ${tx.json(admission.observation as unknown as Json)}, status = 'allocated' where sandbox_id = ${admission.binding.sandboxId} and conversation_id = ${admission.binding.sessionId} and session_generation = 1 returning sandbox_id`;
	if (changed.length !== 1) unavailable();
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
	if (
		!sessionSandboxBudgetFitsV1(
			config.totalBudget,
			await usedBudget(tx, config.namespace),
			{ ...row.resources, storageBytes: 0 },
		)
	)
		unavailable();
	await tx`update platform.session_sandbox_resource_charges set compute_released = false where sandbox_id = ${sandboxId}`;
}

/** Rechecks the deployment budget before an original Session preparation/recovery write. */
export async function reserveSessionSandboxPreparationBudgetV1(
	tx: Transaction,
	sandboxId: string,
	policy: SessionSandboxVerifiedPolicyV1,
): Promise<void> {
	const config = await lockBudget(tx);
	if (!config) return;
	if (policy.namespace !== config.namespace) unavailable();
	const approved = config.resourceCosts.find(
		(c) => c.resourceConfigurationHash === policy.resourceConfigurationHash,
	);
	if (!approved) unavailable();
	const [row] = await tx<
		{ resources: SessionSandboxResourceBudgetV1; compute_released: boolean }[]
	>`select resources, compute_released from platform.session_sandbox_resource_charges where sandbox_id = ${sandboxId}`;
	if (!row) unavailable();
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
	const added = {
		cpuMillis:
			resources.cpuMillis -
			(row.compute_released ? 0 : row.resources.cpuMillis),
		memoryBytes:
			resources.memoryBytes -
			(row.compute_released ? 0 : row.resources.memoryBytes),
		storageBytes: resources.storageBytes - row.resources.storageBytes,
	};
	if (
		!sessionSandboxBudgetFitsV1(
			config.totalBudget,
			await usedBudget(tx, config.namespace),
			added,
		)
	)
		unavailable();
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
				this.#configuration,
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
	async statistics(input: { readonly windowMs: number }) {
		if (!Number.isSafeInteger(input.windowMs) || input.windowMs < 1)
			unavailable();
		return this.#client.begin(async (tx) => {
			const observedAt = new Date();
			const currentDigests = new Map<string, string>();
			if (this.#configuration.enabled) {
				for (const profile of this.#configuration.profiles) {
					const current = await readCurrentSessionSandboxReserveProfileV1(
						tx,
						profile.agentId,
						this.#configuration,
					);
					if (current) {
						currentDigests.set(
							`${profile.agentId}:${profile.resourceConfigurationHash}`,
							current.profile.digest,
						);
					}
				}
			}
			const [demandRows, refillRows] = await Promise.all([
				tx<
					{
						agentId: string;
						resourceConfigurationHash: string | null;
						newSessionCount: string;
					}[]
				>`select agent_id as "agentId", resource_policy->>'resourceConfigurationHash' as "resourceConfigurationHash", count(distinct conversation_id)::text as "newSessionCount"
					from platform.session_sandbox_allocations
					where created_at >= clock_timestamp() - ${input.windowMs} * interval '1 millisecond'
					group by agent_id, resource_policy->>'resourceConfigurationHash'`,
				tx<
					{
						agentId: string;
						profileDigest: string;
						resourceConfigurationHash: string | null;
						claimedCount: string;
					}[]
				>`select agent_id as "agentId", profile_digest as "profileDigest", profile->'policy'->>'resourceConfigurationHash' as "resourceConfigurationHash", count(distinct sandbox_id)::text as "claimedCount"
					from platform.session_sandbox_reserves
					where claimed_at >= clock_timestamp() - ${input.windowMs} * interval '1 millisecond'
					group by agent_id, profile_digest, profile->'policy'->>'resourceConfigurationHash'`,
			]);
			const demand = new Map(
				demandRows.map((row) => [
					`${row.agentId}:${row.resourceConfigurationHash ?? ""}`,
					Number(row.newSessionCount),
				]),
			);
			const profiles = refillRows.map((row) => {
				const key = `${row.agentId}:${row.resourceConfigurationHash ?? ""}`;
				const currentDigest = currentDigests.get(key);
				return {
					agentId: row.agentId,
					profileDigest: row.profileDigest,
					resourceConfigurationHash: row.resourceConfigurationHash,
					newSessionCount:
						currentDigest === row.profileDigest ? (demand.get(key) ?? 0) : 0,
					claimedCount: Number(row.claimedCount),
				};
			});
			for (const row of demandRows) {
				const key = `${row.agentId}:${row.resourceConfigurationHash ?? ""}`;
				const currentDigest = currentDigests.get(key) ?? null;
				if (
					!profiles.some(
						(profile) =>
							profile.agentId === row.agentId &&
							profile.resourceConfigurationHash === row.resourceConfigurationHash &&
							profile.profileDigest === currentDigest,
					)
				) {
					profiles.push({
						agentId: row.agentId,
						profileDigest: currentDigest,
						resourceConfigurationHash: row.resourceConfigurationHash,
						newSessionCount: Number(row.newSessionCount),
						claimedCount: 0,
					});
				}
			}
			return { observedAt, windowMs: input.windowMs, profiles };
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
			const approved =
				config.profiles.find((p) => p.agentId === agentId) ?? unavailable();
			const [count] = await tx<
				{ total: string; profile: string; preparing: string }[]
			>`select count(*)::text as total, count(*) filter(where profile_digest = ${current.profile.digest})::text as profile, count(*) filter(where status in ('preparing','unknown'))::text as preparing from platform.session_sandbox_reserves where status <> 'claimed' and retired_at is null`;
			if (
				!count ||
				Number(count.total) >= config.maximumReserves ||
				Number(count.profile) >= approved.maximum ||
				Number(count.preparing) >= config.maximumConcurrentCreates
			)
				return null;
			const sandboxId = randomUUID();
			const sessionId = randomUUID();
			await charge(tx, config, sandboxId, current.profile.resources);
			await tx`insert into platform.session_sandbox_reserves (sandbox_id, session_id, agent_id, namespace, profile_digest, profile, status, operations, expires_at, created_at, updated_at) values (${sandboxId}, ${sessionId}, ${agentId}, ${config.namespace}, ${current.profile.digest}, ${tx.json(current.profile as unknown as Json)}, 'preparing', '[]', clock_timestamp() + ${config.ttlMs} * interval '1 millisecond', clock_timestamp(), clock_timestamp())`;
			return sandboxId;
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
			};
		});
	}
	async #mutate(
		lease: SessionSandboxReserveLeaseV1,
		action: (tx: Transaction, row: ReserveRow) => Promise<boolean>,
	): Promise<boolean> {
		return this.#client.begin(async (tx) => {
			await lockBudget(tx, this.#configuration);
			const [row] = await tx<
				ReserveRow[]
			>`select * from platform.session_sandbox_reserves where sandbox_id = ${lease.sandboxId} and lease_owner = ${lease.leaseOwner} and delivery_fence = ${lease.deliveryFence} and lease_expires_at > clock_timestamp() and status <> 'claimed' and retired_at is null for update`;
			if (!row) return false;
			return action(tx, row);
		});
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
								o.resource?.uid === operation.resource?.uid,
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
				!["pending", "unknown"].includes(before.status) ||
				!["confirmed", "unknown", "rejected"].includes(operation.status) ||
				(before.status === "unknown" && operation.status === "rejected") ||
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
				(!isDeepStrictEqual(operation.resource, before.resource) ||
					operation.status === "rejected" ||
					(operation.status === "confirmed" && !operation.absent))
			)
				return false;
			const operations = row.operations.map((o) =>
				o.attemptId === operation.attemptId
					? {
							...operation,
							writer: before.writer,
							writeCompletion:
								operation.operation === "delete" &&
								operation.status === "confirmed"
									? "response"
									: before.writeCompletion,
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
			await lockBudget(tx, this.#configuration);
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
			const settled = operations.every(
				(operation) => operation.writeCompletion === "response",
			);
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
			await lockBudget(tx, this.#configuration);
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
				!before ||
				before.operation !== "delete" ||
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

	/** Records a GET absence after an acknowledged, rejected, or uncertain DELETE. */
	async recordDeleteObservation(
		lease: SessionSandboxReserveLeaseV1,
		input: { readonly attemptId: string },
	): Promise<boolean> {
		return this.#mutate(lease, async (tx, row) => {
			const before = row.operations.find(
				(operation) => operation.attemptId === input.attemptId,
			);
			if (
				!before ||
				before.operation !== "delete" ||
				before.absent ||
				!before.resource ||
				before.writeCompletion !== "response" ||
				!["pending", "unknown", "confirmed", "rejected"].includes(before.status)
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

	async markReady(
		lease: SessionSandboxReserveLeaseV1,
		evidence: { bootstrapReady: boolean; businessStateAbsent: boolean },
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
					...evidence,
					status: row.status,
					operations: row.operations,
				})
			)
				return false;
			const business =
				await tx`select 1 from platform.conversations where id = ${row.session_id} union all select 1 from platform.session_sandbox_allocations where sandbox_id = ${row.sandbox_id}`;
			if (business.length) return false;
			await tx`update platform.session_sandbox_reserves set status = 'ready', lease_owner = null, lease_expires_at = null, delivery_fence = delivery_fence + 1, updated_at = clock_timestamp() where sandbox_id = ${row.sandbox_id}`;
			return true;
		});
	}
	async retire(sandboxId: string): Promise<boolean> {
		return this.#client.begin(async (tx) => {
			await lockBudget(tx, this.#configuration);
			const rows =
				await tx`update platform.session_sandbox_reserves r set status = 'retiring', lease_owner = null, lease_expires_at = null, delivery_fence = delivery_fence + 1, updated_at = clock_timestamp() where sandbox_id = ${sandboxId} and status in ('preparing','ready','unknown') and retired_at is null and not exists(select 1 from platform.session_sandbox_allocations a where a.sandbox_id = r.sandbox_id) and not exists(select 1 from platform.conversations c where c.id = r.session_id) returning sandbox_id`;
			return rows.length === 1;
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
