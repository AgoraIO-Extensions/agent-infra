import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type OperationsHistoryQueryV2,
	type OperationsResourceQueryV2,
	type OperationsResourcesV2,
	OperationsResourcesV2Schema,
	OperationsScopeV2Schema,
} from "@agent-infra/contracts/pilot";
import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import type { SessionSandboxResourceBudgetV1 } from "@agent-infra/platform-core";
import {
	aggregateOperationsAgentsV2,
	bindOperationsResourcesV2,
	decideSessionSandboxDrainObservationV1,
	emptyOperationsResourcesV2,
	evaluateOperationsAlertsV2,
	type OperationsAlertThresholdsV2,
	type OperationsBindingV2,
	type OperationsInventoryV2,
	OperationsScopeErrorV2,
	type OperationsSessionAllocationV2,
	projectOperationsBudgetV2,
	projectOperationsStalenessV2,
	type SessionSandboxLifecycleV1,
	type SessionSandboxObservationV1,
} from "@agent-infra/platform-core";
import { readPlatformQueueResourceSnapshot } from "./observability-snapshot.js";
import postgres from "./observed-postgres.js";
import { decodePersistedWorkloadStateV1 } from "./workload-reconciliation.js";

function budget(value: unknown): SessionSandboxResourceBudgetV1 | null {
	if (!value || typeof value !== "object") return null;
	const data = value as Record<string, unknown>;
	if (
		![data.cpuMillis, data.memoryBytes, data.storageBytes].every(
			(item) => Number.isSafeInteger(item) && (item as number) >= 0,
		)
	)
		return null;
	return {
		cpuMillis: data.cpuMillis as number,
		memoryBytes: data.memoryBytes as number,
		storageBytes: data.storageBytes as number,
	};
}

function inheritedStopProof(
	lifecycle: SessionSandboxLifecycleV1 | null,
	observation: SessionSandboxObservationV1 | null,
	target: {
		sandboxId: string;
		sessionId: string;
		agentId: string;
		actorId: string;
		principalType: string;
		channelId: string;
		resourceName: string;
		namespace: string;
		generation: number;
		fence: number;
		settledAt: Date;
	},
): OperationsSessionAllocationV2["inheritedStop"] {
	try {
		const receipt = lifecycle?.stopReceipt;
		const source = lifecycle?.source;
		const pvc = receipt?.retainedPVC;
		const observed = observation?.resources?.[0];
		if (
			lifecycle?.schemaVersion !== 1 ||
			lifecycle.preparation !== undefined ||
			!Number.isSafeInteger(lifecycle.authority.managementRevision) ||
			lifecycle.authority.managementRevision < 1 ||
			source?.policy?.namespace !== target.namespace ||
			!receipt ||
			!source ||
			!pvc ||
			!Number.isSafeInteger(receipt.targetResourceFence) ||
			receipt.targetResourceFence <= source.resourceFence ||
			receipt.targetResourceFence >= target.fence ||
			source.sandbox.sandboxId !== target.sandboxId ||
			source.sandbox.sessionId !== target.sessionId ||
			source.sandbox.agentId !== target.agentId ||
			source.sandbox.principal.id !== target.actorId ||
			source.sandbox.principal.kind !== target.principalType ||
			source.sandbox.channelId !== target.channelId ||
			source.sandbox.resourceName !== target.resourceName ||
			receipt.targetGeneration !== target.generation ||
			!isDeepStrictEqual(observation?.sourceStop, receipt) ||
			observation?.status !== "stopped" ||
			observation.resources.length !== 1 ||
			observed?.kind !== "PersistentVolumeClaim" ||
			observed.namespace !== target.namespace ||
			observed.name !== pvc.name ||
			observed.uid !== pvc.uid ||
			!decideSessionSandboxDrainObservationV1({
				sandbox: { ...source.sandbox, generation: target.generation },
				resourceFence: receipt.targetResourceFence,
				lifecycle,
				observation,
			}).finished
		)
			return undefined;
		return {
			pvcUid: pvc.uid,
			removedPodNames: receipt.removed.flatMap(({ resource }) =>
				resource.kind === "Pod" ? [resource.name] : [],
			),
			settledAt: target.settledAt.toISOString(),
		};
	} catch {
		// Older or malformed saved facts do not prove release.
		return undefined;
	}
}

export class PostgresOperationsResourceStoreV2 {
	readonly #sql: ReturnType<typeof postgres>;
	readonly #scope: OperationsResourcesV2["scope"];
	readonly #workloadNamespaceRef: string | undefined;
	readonly #alertThresholds: OperationsAlertThresholdsV2 | undefined;

	constructor(options: {
		databaseUrl: string;
		scope: OperationsResourcesV2["scope"];
		workloadNamespaceRef?: string;
		alertThresholds?: OperationsAlertThresholdsV2;
	}) {
		this.#scope = OperationsScopeV2Schema.parse(options.scope);
		this.#workloadNamespaceRef = options.workloadNamespaceRef;
		this.#alertThresholds = options.alertThresholds;
		this.#sql = postgres(options.databaseUrl, {
			max: 2,
			connect_timeout: 5,
			connection: {
				statement_timeout: 3000,
				idle_in_transaction_session_timeout: 5000,
			},
		});
	}

	async close(): Promise<void> {
		await this.#sql.end();
	}

	async write(
		value: unknown,
		requestInventory?: OperationsInventoryV2,
	): Promise<void> {
		const snapshot = OperationsResourcesV2Schema.parse(value);
		if (snapshot.budget?.sessionRequestCoverage)
			throw new Error(
				"Operations snapshots require the budget charge projection",
			);
		if (
			snapshot.scope.clusterId !== this.#scope.clusterId ||
			snapshot.scope.namespace !== this.#scope.namespace
		)
			throw new OperationsScopeErrorV2();
		if (
			Date.parse(snapshot.generatedAt) > Date.now() + 5000 ||
			Buffer.byteLength(JSON.stringify(snapshot)) > 8 * 1024 * 1024
		)
			throw new Error("Invalid operations observation");
		const collectionStartedAt =
			snapshot.collectionStartedAt ?? snapshot.generatedAt;
		if (
			Date.parse(collectionStartedAt) > Date.parse(snapshot.generatedAt) ||
			Date.parse(snapshot.generatedAt) - Date.parse(collectionStartedAt) >
				120_000
		)
			throw new Error("Invalid operations observation interval");
		const verified = bindOperationsResourcesV2(
			snapshot.resources,
			await this.readBindings(),
		);
		// First confirmation ends at the metadata response; a later sample extends only to its read start.
		// Before two real observations the interval can be empty; names alone never establish a historical UID.
		const identities = [
			...verified.flatMap((resource) =>
				resource.ownership !== "unknown" &&
				resource.identityObservedAt &&
				Date.parse(resource.identityObservedAt) >=
					Date.parse(collectionStartedAt) &&
				Date.parse(resource.identityObservedAt) <= Date.now() + 5000
					? [
							{
								uid: resource.uid,
								kind: resource.kind,
								name: resource.name,
								agentId: resource.agentId,
								sessionId: resource.sessionId,
								observedAfter: resource.identityObservedAt,
							},
						]
					: [],
			),
			...snapshot.nodes.flatMap((node) =>
				!node.virtual &&
				node.identityObservedAt &&
				Date.parse(node.identityObservedAt) >=
					Date.parse(collectionStartedAt) &&
				Date.parse(node.identityObservedAt) <= Date.now() + 5000
					? [
							{
								uid: node.uid,
								kind: "Node",
								name: node.name,
								agentId: null,
								sessionId: null,
								observedAfter: node.identityObservedAt,
							},
						]
					: [],
			),
		];
		const identitiesByUid = new Map<
			string,
			(typeof identities)[number] | null
		>();
		for (const identity of identities) {
			const prior = identitiesByUid.get(identity.uid);
			if (prior === undefined) identitiesByUid.set(identity.uid, identity);
			else if (
				prior !== null &&
				JSON.stringify(prior) !== JSON.stringify(identity)
			)
				identitiesByUid.set(identity.uid, null);
		}
		const uniqueIdentities = [...identitiesByUid.values()].filter(
			(identity) => identity !== null,
		);
		await this.#sql.begin(async (tx) => {
			await tx`set local statement_timeout = '3000ms'`;
			await tx`select pg_advisory_xact_lock(hashtextextended(${`operations:${this.#scope.clusterId}:${this.#scope.namespace}`}, 0))`;
			const previous = await tx<
				{ snapshot: unknown }[]
			>`select snapshot from platform.operations_resource_snapshots
				where cluster_id=${this.#scope.clusterId} and namespace=${this.#scope.namespace}`;
			const old = previous[0]
				? OperationsResourcesV2Schema.parse(previous[0].snapshot)
				: undefined;
			if (
				old &&
				Date.parse(old.collectionStartedAt ?? old.generatedAt) >=
					Date.parse(collectionStartedAt)
			)
				return;
			snapshot.alerts = evaluateOperationsAlertsV2(
				snapshot,
				old
					? projectOperationsStalenessV2(old, snapshot.generatedAt).alerts
					: [],
				this.#alertThresholds,
			);
			const inventory = requestInventory
				? tx.json({ ...requestInventory, collectionStartedAt })
				: null;
			await tx`insert into platform.operations_resource_snapshots
			(cluster_id, namespace, observed_at, snapshot, request_inventory) values
			(${this.#scope.clusterId}, ${this.#scope.namespace}, ${collectionStartedAt}, ${tx.json(snapshot)}, ${inventory})
			on conflict(cluster_id, namespace) do update set observed_at=excluded.observed_at,
			snapshot=excluded.snapshot, request_inventory=excluded.request_inventory
			where platform.operations_resource_snapshots.observed_at < excluded.observed_at`;
			if (uniqueIdentities.length)
				await tx`insert into platform.operations_resource_identities
				(cluster_id,namespace,uid,kind,name,agent_id,session_id,first_seen,last_seen)
				select ${this.#scope.clusterId},${this.#scope.namespace},v.uid,v.kind,v.name,v."agentId",v."sessionId",v."observedAfter",${collectionStartedAt}
				from jsonb_to_recordset(${tx.json(uniqueIdentities)}) as v(uid text,kind text,name text,"agentId" text,"sessionId" text,"observedAfter" timestamptz)
				on conflict(cluster_id,namespace,uid) do update set last_seen=excluded.last_seen
				where platform.operations_resource_identities.agent_id is not distinct from excluded.agent_id
				and platform.operations_resource_identities.session_id is not distinct from excluded.session_id
				and platform.operations_resource_identities.kind=excluded.kind and platform.operations_resource_identities.name=excluded.name`;
			await tx`delete from platform.operations_resource_identities where cluster_id=${this.#scope.clusterId}
				and namespace=${this.#scope.namespace} and last_seen < now() - interval '30 days'`;
		});
	}

	async historyIdentities(input: OperationsHistoryQueryV2) {
		const rows = await this.#sql<
			{
				uid: string;
				kind: string;
				name: string;
				first_seen: Date;
				last_seen: Date;
			}[]
		>`
			select uid,kind,name,first_seen,last_seen from platform.operations_resource_identities
			where cluster_id=${this.#scope.clusterId} and namespace=${this.#scope.namespace}
			and (${input.agentId ?? null}::text is null or agent_id=${input.agentId ?? null})
			and (${input.sessionId ?? null}::text is null or session_id=${input.sessionId ?? null})
			and (${input.resourceUid ?? null}::text is null or uid=${input.resourceUid ?? null})
			and first_seen <= last_seen and first_seen <= ${input.end} and last_seen >= ${input.start}
			order by last_seen desc,uid limit 129`;
		return {
			identities: rows.slice(0, 128).map((row) => ({
				uid: row.uid,
				kind: row.kind,
				name: row.name,
				firstSeen: row.first_seen.toISOString(),
				lastSeen: row.last_seen.toISOString(),
			})),
			truncated: rows.length > 128,
		};
	}

	async readBindings(): Promise<OperationsBindingV2[]> {
		return (await this.#readAttribution()).bindings;
	}

	async #readAttribution(includeSessionRequests = false) {
		const rows = await this.#sql<
			{
				agent_id: string;
				name: string;
				conversation_id: string;
				actor_id: string;
				principal_type: string;
				channel_id: string;
				sandbox_id: string;
				session_generation: string;
				resource_fence: string;
				desired_state: string;
				status: string;
				resource_name: string;
				identity_verified: boolean;
				resource_policy: {
					namespace?: string;
					configurationRevision?: number;
				} | null;
				resource_observation: SessionSandboxObservationV1 | null;
				inherited_lifecycle: SessionSandboxLifecycleV1 | null;
				settled_at: Date;
			}[]
		>`with candidates as materialized (
			select * from platform.session_sandbox_allocations
			where resource_policy->>'namespace'=${this.#scope.namespace}
				or nullif(resource_policy->>'namespace','') is null
			limit 10001
		)
			select a.agent_id, coalesce(app.name, a.agent_id) as name, a.conversation_id, a.sandbox_id,
			a.session_generation, a.resource_fence, a.desired_state, a.status, a.resource_name, a.updated_at as settled_at, a.actor_id, a.principal_type, a.channel_id,
			(agent.id is not null and c.id is not null) as identity_verified, a.resource_policy, a.resource_observation,
			${includeSessionRequests ? this.#sql`intent.payload->'lifecycle'` : this.#sql`null`} as inherited_lifecycle
			from candidates a
			left join platform.agents agent on agent.id=a.agent_id
			left join platform.conversations c on c.id=a.conversation_id and c.agent_id=a.agent_id
			and c.actor_id=a.actor_id and c.principal_type=a.principal_type and c.channel_id=a.channel_id
			and c.session_generation=a.session_generation
			left join platform.agent_applications app on app.agent_id=a.agent_id
			${
				includeSessionRequests
					? this.#sql`
			left join lateral (
				select min(id) as id from (
					select id from platform.outbox_items
					where scope_type='conversation' and scope_id=a.conversation_id
						and operation='conversation.sandbox.reconcile.v1'
						and a.status='stopped' and a.desired_state='stopped'
						and a.resource_observation->'sourceStop'->>'targetResourceFence' <> a.resource_fence::text
					order by id limit 2
				) matches having count(*)=1
			) original on true
			left join platform.outbox_items intent on intent.id=original.id
				and intent.status='succeeded' and intent.lease_owner is null and intent.lease_expires_at is null
				and intent.payload->'schemaVersion'='1'::jsonb
				and intent.payload->>'conversationId'=a.conversation_id
				and intent.payload->>'sessionGeneration'=a.session_generation::text
				and app.desired_state='stopped'
				and intent.payload #>> '{lifecycle,authority,targetDesiredState}' = 'stopped'
				and intent.payload #>> '{lifecycle,authority,kind}' = 'management'
				and intent.payload #>> '{lifecycle,authority,applicationId}' = app.id
				and intent.payload #>> '{lifecycle,authority,managementFence}' = app.fence::text
				and intent.payload #>> '{lifecycle,authority,workloadRevision}' = app.workload_revision::text
				and intent.payload #> '{lifecycle,authority,managementRevision}' between '1'::jsonb and to_jsonb(app.management_revision)
				and not exists (select 1 from platform.conversation_generation_tombstones pending
					where pending.conversation_id=a.conversation_id and pending.status='pending')
			`
					: this.#sql``
			}
			`;
		if (rows.length > 10000) throw new Error("Operations bindings unavailable");
		const scoped = rows.filter(
			(row) => row.resource_policy?.namespace === this.#scope.namespace,
		);
		const unscopedSessions = rows.length - scoped.length;
		const allocations: OperationsSessionAllocationV2[] = scoped.map((row) => {
			const observation = row.resource_observation;
			const receipt = observation?.sourceStop;
			const revision = row.resource_policy?.configurationRevision;
			const stopped =
				row.identity_verified &&
				row.status === "stopped" &&
				row.desired_state === "stopped" &&
				observation?.status === "stopped" &&
				Array.isArray(observation.resources) &&
				observation.resources.every(
					(resource) => resource.kind === "PersistentVolumeClaim",
				) &&
				receipt?.schemaVersion === 1 &&
				receipt.sandboxId === row.sandbox_id &&
				receipt.sessionId === row.conversation_id &&
				receipt.targetGeneration === Number(row.session_generation) &&
				receipt.targetResourceFence === Number(row.resource_fence);
			const inheritedStop =
				row.identity_verified && row.inherited_lifecycle
					? inheritedStopProof(row.inherited_lifecycle, observation, {
							sandboxId: row.sandbox_id,
							sessionId: row.conversation_id,
							agentId: row.agent_id,
							actorId: row.actor_id,
							principalType: row.principal_type,
							channelId: row.channel_id,
							resourceName: row.resource_name,
							namespace: this.#scope.namespace,
							generation: Number(row.session_generation),
							fence: Number(row.resource_fence),
							settledAt: row.settled_at,
						})
					: undefined;
			return {
				sandboxId: row.sandbox_id,
				resourceName: row.resource_name,
				...(inheritedStop ? { inheritedStop } : {}),
				configurationRevision:
					row.identity_verified &&
					typeof revision === "number" &&
					Number.isSafeInteger(revision) &&
					revision >= 0
						? revision
						: null,
				stopped,
				noRetainedPvc:
					stopped &&
					receipt?.retainedPVC === null &&
					observation?.resources?.length === 0,
			};
		});
		const bindings: OperationsBindingV2[] = scoped.flatMap((row) => {
			const identities = row.resource_observation?.resources;
			if (!row.identity_verified || !Array.isArray(identities)) return [];
			return [
				{
					agentId: row.agent_id,
					agentName: row.name,
					sessionId: row.conversation_id,
					sandboxId: row.sandbox_id,
					namespace: this.#scope.namespace,
					generation: Number(row.session_generation),
					revision: row.resource_policy?.configurationRevision ?? null,
					resourceFence: Number(row.resource_fence),
					ownership: "agent" as const,
					retainedStorage: row.desired_state === "stopped",
					identities: identities.filter(
						(identity) => identity.namespace === this.#scope.namespace,
					),
				},
			];
		});
		const reserves = await this.#sql<
			{
				agent_id: string;
				name: string;
				session_id: string;
				sandbox_id: string;
				profile_digest: string;
				profile: {
					agentId?: string;
					digest?: string;
					policy?: { namespace?: string; configurationRevision?: number };
				};
				operations: {
					operation: string;
					status: string;
					writeCompletion: string;
					absent: boolean;
					kind: string;
					name: string;
					resource?: {
						kind: string;
						name: string;
						namespace: string;
						uid: string;
					};
				}[];
			}[]
		>`select r.agent_id, coalesce(app.name, r.agent_id) as name, r.session_id, r.sandbox_id, r.profile_digest, r.profile, r.operations
			from platform.session_sandbox_reserves r join platform.agents a on a.id=r.agent_id
			left join platform.agent_applications app on app.agent_id=r.agent_id
			where r.namespace=${this.#scope.namespace} and r.retired_at is null and r.status <> 'claimed'
			and not exists(select 1 from platform.session_sandbox_allocations a where a.sandbox_id=r.sandbox_id)
			and not exists(select 1 from platform.conversations c where c.id=r.session_id) limit 10001`;
		if (reserves.length > 10000)
			throw new Error("Operations bindings unavailable");
		for (const row of reserves) {
			if (
				row.profile.agentId !== row.agent_id ||
				row.profile.digest !== row.profile_digest ||
				row.profile.policy?.namespace !== this.#scope.namespace ||
				!Array.isArray(row.operations)
			)
				continue;
			bindings.push({
				agentId: row.agent_id,
				agentName: row.name,
				sessionId: row.session_id,
				sandboxId: row.sandbox_id,
				namespace: this.#scope.namespace,
				generation: 1,
				revision: row.profile.policy.configurationRevision ?? null,
				resourceFence: 1,
				ownership: "reserve",
				retainedStorage: false,
				identities: row.operations.flatMap((operation) =>
					operation.operation === "create" &&
					operation.status === "confirmed" &&
					operation.writeCompletion === "response" &&
					!operation.absent &&
					operation.resource?.namespace === this.#scope.namespace &&
					operation.resource.kind === operation.kind &&
					operation.resource.name === operation.name
						? [operation.resource]
						: [],
				),
			});
		}
		if (!this.#workloadNamespaceRef)
			return { bindings, allocations, unscopedSessions };
		const workloads = await this.#sql<
			{
				agent_id: string;
				name: string;
				revision: string;
				state: unknown;
				stopped: boolean | null;
				fence: string | null;
				lifecycle_revision: string | null;
			}[]
		>`
			select w.agent_id, coalesce(app.name, w.agent_id) as name, w.revision, w.state,
				(app.status='stopped' and app.desired_state='stopped') as stopped,
				app.fence, app.workload_revision as lifecycle_revision
			from platform.workload_reconciliations w join platform.agents a on a.id=w.agent_id
			left join platform.agent_applications app on app.agent_id=w.agent_id
			limit 10001`;
		if (workloads.length > 10000)
			throw new Error("Operations bindings unavailable");
		for (const row of workloads) {
			try {
				const decoded = decodePersistedWorkloadStateV1(row.state, row.agent_id);
				if (
					!decoded ||
					decoded.legacy ||
					!decoded.state.verified ||
					!decoded.state.identity ||
					decoded.state.revision !== Number(row.revision)
				)
					continue;
				const deployment = validateAgentWorkloadDesiredV1(
					decoded.state.verified.deployment,
				);
				if (
					deployment.agentId !== row.agent_id ||
					deployment.namespaceRef !== this.#workloadNamespaceRef
				)
					continue;
				const state = decoded.state;
				if (
					row.stopped &&
					state.phase === "stopped" &&
					state.fence === Number(row.fence) &&
					state.sourceLifecycleRevision === Number(row.lifecycle_revision) &&
					!deployment.multiService &&
					deployment.persistentVolume.retention === "retain" &&
					decoded.state.verified.persistentVolumeUid
				) {
					bindings.push({
						agentId: row.agent_id,
						agentName: row.name,
						sessionId: null,
						sandboxId: null,
						namespace: this.#scope.namespace,
						generation: decoded.state.identity.generation,
						revision: deployment.configRevision,
						resourceFence: state.fence,
						ownership: "agent",
						retainedStorage: true,
						identities: [
							{
								kind: "PersistentVolumeClaim",
								name: deployment.persistentVolume.name,
								uid: decoded.state.verified.persistentVolumeUid,
							},
						],
						controllerUid: decoded.state.identity.uid,
						workloadRevision: state.revision,
					});
				}
				bindings.push({
					agentId: row.agent_id,
					agentName: row.name,
					sessionId: null,
					sandboxId: null,
					namespace: this.#scope.namespace,
					generation: decoded.state.identity.generation,
					revision: deployment.configRevision,
					resourceFence: deployment.fence,
					ownership: "agent",
					retainedStorage: false,
					identities: [],
					controllerUid: decoded.state.identity.uid,
					workloadRevision: deployment.workloadRevision,
					...(deployment.multiService
						? {
								manifestHash: createHash("sha256")
									.update(JSON.stringify(deployment.multiService))
									.digest("hex"),
								members: deployment.multiService.resources
									.filter(
										(entry) =>
											entry.kind === "Deployment" ||
											entry.kind === "StatefulSet",
									)
									.map((entry) => ({
										kind: entry.kind,
										name: entry.metadata.name,
									})),
							}
						: {}),
				});
			} catch {
				/* Legacy or unverified bindings stay unknown in the read projection. */
			}
		}
		return { bindings, allocations, unscopedSessions };
	}

	async read(
		input: OperationsResourceQueryV2 & { includeSessionRequests?: boolean },
		signal = AbortSignal.timeout(5000),
	): Promise<OperationsResourcesV2> {
		signal.throwIfAborted();
		if (input.namespace && input.namespace !== this.#scope.namespace)
			throw new OperationsScopeErrorV2();
		const namespace = this.#scope.namespace;
		const [selection] = await this.#sql<
			{ agent_exists: boolean; session_exists: boolean }[]
		>`select
            exists(select 1 from platform.agents where id=${input.agentId ?? null}) as agent_exists,
            exists(select 1 from platform.conversations where id=${input.sessionId ?? null} and (${input.agentId ?? null}::text is null or agent_id=${input.agentId ?? null})) as session_exists`;
		const [saved] = await this.#sql<
			{
				snapshot: unknown;
				request_inventory:
					| (OperationsInventoryV2 & { collectionStartedAt: string })
					| null;
			}[]
		>`
			select snapshot, request_inventory from platform.operations_resource_snapshots where cluster_id=${this.#scope.clusterId} and namespace=${namespace}`;
		const now = new Date().toISOString();
		const snapshot = saved
			? OperationsResourcesV2Schema.parse(saved.snapshot)
			: emptyOperationsResourcesV2(this.#scope, now);
		const result = projectOperationsStalenessV2(snapshot, now);
		result.selection = {
			agent: input.agentId
				? selection?.agent_exists
					? "present"
					: "not-found"
				: "not-requested",
			session: input.sessionId
				? selection?.session_exists
					? "present"
					: "not-found"
				: "not-requested",
		};

		// Attribution is resolved again from authoritative business bindings at read time.
		const observed = result.resources;
		const { bindings, allocations, unscopedSessions } =
			await this.#readAttribution(input.includeSessionRequests === true);
		const bound = bindOperationsResourcesV2(observed, bindings);
		const kubernetes = result.sources.find(
			(source) => source.kind === "kubernetes",
		);
		const legacyComplete =
			!result.truncated &&
			kubernetes?.state === "available" &&
			kubernetes.observedAt !== null &&
			kubernetes.reason === null;
		const inventory = saved?.request_inventory;
		const currentInventory =
			inventory?.collectionStartedAt ===
			(snapshot.collectionStartedAt ?? snapshot.generatedAt)
				? inventory
				: undefined;
		const fresh = (observedAt: string | null) =>
			observedAt !== null &&
			Date.parse(observedAt) >=
				Date.parse(snapshot.collectionStartedAt ?? snapshot.generatedAt) &&
			Date.parse(observedAt) <= Date.parse(snapshot.generatedAt) &&
			Date.parse(now) - Date.parse(observedAt) <=
				Math.max(90_000, snapshot.refreshSeconds * 3000);
		const podsComplete = currentInventory
			? fresh(currentInventory.podsObservedAt)
			: legacyComplete;
		const claimsComplete = currentInventory
			? fresh(currentInventory.claimsObservedAt)
			: legacyComplete;
		result.resources = bound.filter(
			(resource) =>
				(!input.agentId || input.agentId === resource.agentId) &&
				(!input.sessionId || input.sessionId === resource.sessionId),
		);
		result.agents = aggregateOperationsAgentsV2(result.resources);
		let platformAvailable = true;
		try {
			result.budget = await this.#sql.begin("read only", async (tx) => {
				await tx`set local statement_timeout = '3000ms'`;
				await tx`set local lock_timeout = '1000ms'`;
				signal.throwIfAborted();
				const configurations = await tx<
					{
						revision: string;
						configuration: Record<string, unknown>;
						updated_at: Date;
					}[]
				>`
				select revision, configuration, updated_at from platform.session_sandbox_budgets where namespace = ${namespace}`;
				const rows = await tx<
					{
						resources: unknown;
						compute_released: boolean;
						has_allocation: boolean;
						has_reserve: boolean;
						claimed: boolean;
						has_conversation: boolean;
					}[]
				>`select ch.resources, ch.compute_released,
				exists(select 1 from platform.session_sandbox_allocations a where a.sandbox_id=ch.sandbox_id) as has_allocation,
				exists(select 1 from platform.session_sandbox_reserves r where r.sandbox_id=ch.sandbox_id and r.retired_at is null) as has_reserve,
				exists(select 1 from platform.session_sandbox_reserves r where r.sandbox_id=ch.sandbox_id and r.status='claimed') as claimed,
				exists(select 1 from platform.session_sandbox_reserves r join platform.conversations c on c.id=r.session_id where r.sandbox_id=ch.sandbox_id) as has_conversation
				from platform.session_sandbox_resource_charges ch where ch.namespace=${namespace} and not ch.released
				limit 10001`;
				if (rows.length > 10000)
					throw new Error("Operations budget observation is unavailable");
				const saved = configurations[0];
				const missing = await tx<
					{ reserves: string; sessions: string }[]
				>`select
				case when ${input.includeSessionRequests === true} then 0 else
				(select count(*) from platform.session_sandbox_allocations a where a.resource_policy->>'namespace'=${namespace}
				and not exists(select 1 from platform.session_sandbox_resource_charges ch where ch.sandbox_id=a.sandbox_id)) end as sessions,
				(select count(*) from platform.session_sandbox_reserves r where r.namespace=${namespace} and r.retired_at is null and r.status <> 'claimed'
				and not exists(select 1 from platform.session_sandbox_allocations a where a.sandbox_id=r.sandbox_id)
				and not exists(select 1 from platform.session_sandbox_resource_charges ch where ch.sandbox_id=r.sandbox_id)) as reserves`;
				const unaccountedReserves = Number(missing[0]?.reserves ?? 0);
				const configuration = saved?.configuration;
				const accounting = configuration?.reserveAccounting as
					| Record<string, unknown>
					| undefined;
				return projectOperationsBudgetV2({
					namespace,
					revision: saved ? Number(saved.revision) : null,
					enabled:
						typeof configuration?.enabled === "boolean"
							? configuration.enabled
							: null,
					updatedAt: saved?.updated_at.toISOString() ?? null,
					limits: budget(
						configuration?.enabled
							? configuration.totalBudget
							: accounting?.totalBudget,
					),
					charges: rows.map((row) => ({
						resources: budget(row.resources),
						computeReleased: row.compute_released,
						hasAllocation: row.has_allocation,
						hasReserve: row.has_reserve,
						claimed: row.claimed,
						hasConversation: row.has_conversation,
					})),
					unaccountedReserves,
					unaccountedSessions: Number(missing[0]?.sessions ?? 0),
					sessionRequests: input.includeSessionRequests
						? {
								allocations,
								unscopedSessions,
								observed,
								bound,
								podsComplete,
								podsObservedAt: currentInventory?.podsObservedAt ?? null,
								claimsObservedAt: currentInventory?.claimsObservedAt ?? null,
								claimsComplete,
							}
						: undefined,
				});
			});
		} catch {
			result.budget = null;
			platformAvailable = false;
		}
		try {
			const queue = await readPlatformQueueResourceSnapshot(this.#sql, signal);
			result.queue = {
				waiting: queue.taskWaiting,
				outboxPending: queue.outboxPending,
				oldestWaitingAt: queue.oldestWaitingAt ?? null,
			};
		} catch {
			result.queue = null;
			platformAvailable = false;
		}
		let databaseAvailable = true;
		try {
			const [database] = await this.#sql<
				{
					connections: string;
					active: string;
					idle: string;
					idle_in_transaction: string;
					lock_waiting: string;
					database_connections: string;
					max_connections: string;
					role_limit: number;
				}[]
			>`
                select count(*) filter(where usename=current_user)::text as connections,
                count(*) filter(where usename=current_user and state='active')::text as active,
                count(*) filter(where usename=current_user and state='idle')::text as idle,
                count(*) filter(where usename=current_user and state like 'idle in transaction%')::text as idle_in_transaction,
                count(*) filter(where usename=current_user and wait_event_type='Lock')::text as lock_waiting,
                count(*)::text as database_connections, current_setting('max_connections') as max_connections,
                (select rolconnlimit from pg_roles where rolname=current_user) as role_limit
                from pg_stat_activity where datname=current_database()`;
			if (!database || database.role_limit === null) throw new Error();
			result.database = {
				scope: "current-role",
				connections: Number(database.connections),
				active: Number(database.active),
				idle: Number(database.idle),
				idleInTransaction: Number(database.idle_in_transaction),
				lockWaiting: Number(database.lock_waiting),
				databaseConnections: Number(database.database_connections),
				maxConnections: Number(database.max_connections),
				roleConnectionLimit:
					database.role_limit < 0 ? null : database.role_limit,
				observedAt: new Date().toISOString(),
			};
		} catch {
			result.database = null;
			databaseAvailable = false;
		}
		result.sources[0] = {
			kind: "platform",
			state:
				databaseAvailable && platformAvailable ? "available" : "unavailable",
			observedAt: result.generatedAt,
			windowSeconds: null,
			reason: databaseAvailable && platformAvailable ? null : "QUERY_FAILED",
		};
		return OperationsResourcesV2Schema.parse(
			projectOperationsStalenessV2(result, result.generatedAt),
		);
	}
}
