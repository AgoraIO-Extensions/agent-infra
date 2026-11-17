import { createRequire } from "node:module";
import { afterAll, beforeAll, expect, it } from "vitest";
import { HttpProtocolError } from "../../apps/platform-api/src/http/common.js";
import type { OperationsResourceRoutesDependenciesV2 } from "../../apps/platform-api/src/http/operations-resource-routes.js";
import { registerOperationsResourceRoutesV2 } from "../../apps/platform-api/src/http/operations-resource-routes.js";
import { createOperationsQueryV2 } from "../../apps/platform-api/src/operations-query.js";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "../../apps/platform-worker/src/kubernetes.fixture.js";
import { collectOperationsSnapshotV2 } from "../../apps/platform-worker/src/operations-collector.js";
import {
	OperationsHistoryV2Schema,
	OperationsResourcesV2Schema,
} from "../../packages/contracts/src/pilot/operations-resource.js";
import { agentConfigurationConformanceRecordV1 } from "../../packages/platform-core/src/agent-configuration.conformance.js";
import { emptyOperationsResourcesV2 } from "../../packages/platform-core/src/operations-resource.js";
import { migratePlatformDatabase } from "../../packages/platform-store/src/migrate.js";
import { PostgresOperationsResourceStoreV2 } from "../../packages/platform-store/src/operations-resource.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../packages/platform-store/src/postgres-test.js";

const { Hono } = createRequire(
	new URL("../../apps/platform-api/package.json", import.meta.url),
)("hono") as typeof import("../../apps/platform-api/node_modules/hono");
const postgres = createRequire(
	new URL("../../packages/platform-store/package.json", import.meta.url),
)(
	"postgres",
) as typeof import("../../packages/platform-store/node_modules/postgres");

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let store: PostgresOperationsResourceStoreV2;
const scope = { clusterId: "operations-test", namespace: "platform-1" };

beforeAll(async () => {
	database = await startPostgresTestDatabase("operations-resources");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 1 });
	store = new PostgresOperationsResourceStoreV2({
		databaseUrl: database.databaseUrl,
		scope,
		workloadNamespaceRef: workloadTestPolicy.namespaceRef,
	});
}, 120_000);
afterAll(async () => {
	await store?.close();
	await sql?.end();
	await database?.stop();
});

function app(
	operations: OperationsResourceRoutesDependenciesV2["operations"] = store,
) {
	const result = new Hono();
	result.onError((error, context) =>
		error instanceof HttpProtocolError
			? context.json(error.body, error.status)
			: context.json({ error: "internal" }, 500),
	);
	registerOperationsResourceRoutesV2(result, {
		identity: {
			resolve: async () => ({
				schemaVersion: 1,
				userId: "operations-admin",
				displayName: "Administrator",
				accountStatus: "active",
				organizationIds: [],
				roles: ["employee", "system_admin"],
				authorizationRevision: "operations-revision",
			}),
			hydrateUsers: async () => [],
		},
		operations,
	});
	return result;
}

it("rejects a namespace outside the configured deployment", async () => {
	const response = await app().request(
		"/api/v2/ops/resources?namespace=another-namespace",
	);
	expect(response.status).toBe(403);
	expect(JSON.stringify(await response.json())).not.toContain(
		"another-namespace",
	);
});

it("shows bounded database connection aggregates without returning session queries", async () => {
	const response = await app().request("/api/v2/ops/resources");
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		database?: {
			scope: string;
			connections: number;
			active: number;
			maxConnections: number;
		};
	};
	expect(body.database).toMatchObject({ scope: "current-role" });
	expect(body.database?.connections).toBeGreaterThan(0);
	expect(body.database?.active).toBeGreaterThan(0);
	expect(body.database?.maxConnections).toBeGreaterThan(0);
	expect(JSON.stringify(body.database)).not.toContain("select");
});

it("separates unclaimed reserve budget from retained Session storage without changing charges", async () => {
	const reserveId = "00000000-0000-4000-8000-000000000001";
	const sessionId = "00000000-0000-4000-8000-000000000002";
	const reserveCost = {
		cpuMillis: 1000,
		memoryBytes: 2048,
		storageBytes: 8192,
	};
	const sessionCost = {
		cpuMillis: 500,
		memoryBytes: 1024,
		storageBytes: 16384,
	};
	await sql`insert into platform.session_sandbox_budgets
		(namespace, revision, configuration, updated_at) values
		(${scope.namespace}, 1, ${sql.json({
			schemaVersion: 1,
			enabled: true,
			revision: 1,
			namespace: scope.namespace,
			totalBudget: { cpuMillis: 4000, memoryBytes: 4096, storageBytes: 32768 },
			resourceCosts: [
				{ resourceConfigurationHash: "a".repeat(64), resources: reserveCost },
			],
			maximumReserves: 4,
			maximumConcurrentCreates: 2,
			ttlMs: 60000,
			cooldownMs: 1000,
			failureBackoffMs: 1000,
			profiles: [],
		})}, now())`;
	await sql`insert into platform.session_sandbox_reserves
		(sandbox_id, session_id, agent_id, namespace, profile_digest, profile,
		 status, expires_at, created_at, updated_at) values
		(${reserveId}, 'reserve-session', 'agent-1', ${scope.namespace},
		 ${"b".repeat(64)}, ${sql.json({})}, 'ready', now() + interval '1 hour', now(), now())`;
	await sql`insert into platform.conversations
		(id, agent_id, actor_id, channel_id, status, session_generation, authorization_revision)
		values ('retained-session', 'agent-1', 'actor-1', 'web', 'active', 1, 'revision-1')`;
	await sql`insert into platform.session_sandbox_allocations
		(sandbox_id, conversation_id, agent_id, actor_id, principal_type, channel_id,
		 session_generation, resource_name, workspace_scope, status, created_at, updated_at)
		values (${sessionId}, 'retained-session', 'agent-1', 'actor-1', 'user', 'web',
		 1, ${`sandbox-${sessionId}`}, ${sessionId}, 'stopped', now(), now())`;
	await sql`insert into platform.session_sandbox_resource_charges
		(sandbox_id, namespace, resources, compute_released, released) values
		(${reserveId}, ${scope.namespace}, ${sql.json(reserveCost)}, false, false),
		(${sessionId}, ${scope.namespace}, ${sql.json(sessionCost)}, true, false)`;

	for (let attempt = 0; attempt < 2; attempt += 1) {
		const response = await app().request("/api/v2/ops/resources");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			schemaVersion: 2,
			budget: {
				scope: "unclaimed-reserves",
				reserveUsage: { cpuCores: 1, memoryBytes: 2048, storageBytes: 8192 },
				sessionUsage: { cpuCores: 0, memoryBytes: 0, storageBytes: 16384 },
				counts: { unclaimedReserves: 1, sessions: 1, retainedStorage: 1 },
			},
			sources: expect.arrayContaining([
				expect.objectContaining({ kind: "platform", state: "available" }),
				expect.objectContaining({
					kind: "pod-metrics",
					state: "not-configured",
				}),
			]),
		});
	}
});

it("keeps a measured zero and refuses an unverified Agent attribution", async () => {
	const now = new Date().toISOString();
	const snapshot = emptyOperationsResourcesV2(scope, now);
	snapshot.sources[1] = {
		kind: "kubernetes",
		state: "available",
		observedAt: now,
		windowSeconds: null,
		reason: null,
	};
	snapshot.resources = [
		{
			kind: "Pod",
			uid: "unverified-pod-uid",
			name: "observed-pod",
			namespace: scope.namespace,
			resourceVersion: "1",
			ownerUid: null,
			ownerGeneration: null,
			agentId: "forged-agent",
			agentName: null,
			sessionId: "forged-session",
			sandboxId: null,
			generation: null,
			revision: null,
			workloadRevision: null,
			resourceFence: null,
			ownership: "agent",
			role: "sandbox",
			nodeName: "node-1",
			phase: "Running",
			ready: true,
			restarts: 0,
			reason: null,
			observedAt: now,
			usage: {
				cpuCores: 0,
				memoryBytes: 1024,
				storageBytes: null,
				ephemeralStorageBytes: null,
			},
			requests: {
				cpuCores: 0.5,
				memoryBytes: 2048,
				storageBytes: null,
				ephemeralStorageBytes: null,
			},
			limits: {
				cpuCores: 1,
				memoryBytes: 4096,
				storageBytes: null,
				ephemeralStorageBytes: null,
			},
			containers: [],
			images: [],
			retainedStorage: false,
		},
	];
	await store.write(snapshot);
	const response = await app().request("/api/v2/ops/resources");
	expect(response.status).toBe(200);
	const body = OperationsResourcesV2Schema.parse(await response.json());
	expect(body.resources).toMatchObject([
		{
			uid: "unverified-pod-uid",
			ownership: "unknown",
			agentId: null,
			sessionId: null,
			usage: { cpuCores: 0, memoryBytes: 1024, storageBytes: null },
		},
	]);
	expect(body.agents).toEqual([]);
});

it("attributes retained storage only to the current bound PVC UID", async () => {
	const sandboxId = "00000000-0000-4000-8000-000000000002";
	await sql`insert into platform.agents (id) values ('agent-1') on conflict do nothing`;
	await sql`update platform.session_sandbox_allocations set
		desired_state='stopped',
		resource_policy=${sql.json({ namespace: scope.namespace, configurationRevision: 1 })},
		resource_observation=${sql.json({
			resources: [
				{
					kind: "PersistentVolumeClaim",
					namespace: scope.namespace,
					name: "retained-pvc",
					uid: "current-pvc-uid",
					resourceVersion: "3",
				},
			],
		})} where sandbox_id=${sandboxId}`;
	const now = new Date().toISOString();
	const snapshot = emptyOperationsResourcesV2(scope, now);
	const resource = {
		kind: "PersistentVolumeClaim" as const,
		uid: "current-pvc-uid",
		name: "retained-pvc",
		namespace: scope.namespace,
		resourceVersion: "3",
		ownerUid: null,
		ownerGeneration: null,
		agentId: "agent-1",
		agentName: null,
		sessionId: "retained-session",
		sandboxId,
		generation: 1,
		revision: 1,
		workloadRevision: null,
		resourceFence: 0,
		ownership: "agent" as const,
		role: "sandbox" as const,
		nodeName: null,
		phase: "Bound",
		ready: null,
		restarts: 0,
		reason: null,
		observedAt: now,
		identityObservedAt: now,
		usage: {
			cpuCores: null,
			memoryBytes: null,
			storageBytes: null,
			ephemeralStorageBytes: null,
		},
		requests: {
			cpuCores: null,
			memoryBytes: null,
			storageBytes: 16384,
			ephemeralStorageBytes: null,
		},
		limits: {
			cpuCores: null,
			memoryBytes: null,
			storageBytes: null,
			ephemeralStorageBytes: null,
		},
		containers: [],
		images: [],
		retainedStorage: true,
	};
	snapshot.resources = [resource, { ...resource, uid: "old-pvc-uid" }];
	await store.write(snapshot);
	const response = await app().request("/api/v2/ops/resources?agentId=agent-1");
	expect(response.status).toBe(200);
	const body = OperationsResourcesV2Schema.parse(await response.json());
	expect(body.resources).toMatchObject([
		{
			uid: "current-pvc-uid",
			agentId: "agent-1",
			ownership: "agent",
			retainedStorage: true,
		},
	]);
	expect(body.resources).toHaveLength(1);
	expect(body.agents).toMatchObject([
		{
			agentId: "agent-1",
			sessions: 1,
			volumes: 1,
			requests: { storageBytes: 16384 },
		},
	]);
});

it("keeps cache readiness separate from missing hit evidence and marks old observations stale", async () => {
	const snapshot = emptyOperationsResourcesV2(
		scope,
		new Date(Date.now() + 1000).toISOString(),
	);
	const old = new Date(Date.now() - 120_000).toISOString();
	snapshot.sources[4] = {
		kind: "image-cache",
		state: "available",
		observedAt: old,
		windowSeconds: null,
		reason: null,
	};
	snapshot.imageCaches = [
		{
			uid: "cache-uid",
			name: "approved-cache",
			cacheId: "imc-1",
			owner: "deployment-1",
			phase: "Ready",
			images: [
				"registry.example/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			],
			expiresAt: null,
			deleting: false,
			observedAt: old,
			inventoryLimit: 48,
		},
	];
	snapshot.cacheEvidence = [
		{
			podUid: "pod-1",
			podName: "pod-1",
			images: [],
			cacheId: "imc-1",
			coverage: "covered",
			hit: "unknown",
			observedAt: old,
		},
	];
	await store.write(snapshot);
	const response = await app().request("/api/v2/ops/resources");
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		imageCaches: [{ phase: "Ready" }],
		cacheEvidence: [{ coverage: "covered", hit: "unknown" }],
		alerts: expect.arrayContaining([
			expect.objectContaining({
				code: "SOURCE_UNAVAILABLE",
				objectName: "image-cache",
				state: "firing",
				firstAt: new Date(Date.parse(old) + 90_000).toISOString(),
			}),
		]),
		sources: expect.arrayContaining([
			expect.objectContaining({ kind: "image-cache", state: "stale" }),
		]),
	});
});

it("preserves a firing alert across samples and records recovery once", async () => {
	const first = new Date(Date.now() + 2000).toISOString();
	const sample = emptyOperationsResourcesV2(scope, first);
	sample.sources[3] = {
		kind: "node-metrics",
		state: "available",
		observedAt: first,
		windowSeconds: 30,
		reason: null,
	};
	sample.sources[2] = {
		kind: "pod-metrics",
		state: "available",
		observedAt: first,
		windowSeconds: 30,
		reason: null,
	};
	sample.nodes = [
		{
			uid: "hot-node-uid",
			name: "hot-node",
			virtual: false,
			ready: true,
			pressures: [],
			observedAt: first,
			capacity: {
				cpuCores: 4,
				memoryBytes: 10000,
				storageBytes: null,
				ephemeralStorageBytes: null,
			},
			allocatable: {
				cpuCores: 4,
				memoryBytes: 10000,
				storageBytes: null,
				ephemeralStorageBytes: null,
			},
			usage: {
				cpuCores: 1,
				memoryBytes: 9600,
				storageBytes: null,
				ephemeralStorageBytes: null,
			},
			requests: {
				cpuCores: 1,
				memoryBytes: 5000,
				storageBytes: null,
				ephemeralStorageBytes: null,
			},
		},
	];
	await store.write(sample);
	const firing = OperationsResourcesV2Schema.parse(
		await (await app().request("/api/v2/ops/resources")).json(),
	);
	expect(firing.alerts).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				code: "MEMORY_PRESSURE",
				objectUid: "hot-node-uid",
				state: "firing",
				firstAt: first,
				resolvedAt: null,
			}),
		]),
	);
	const next = {
		...sample,
		generatedAt: new Date(Date.now() + 3000).toISOString(),
	};
	next.collectionStartedAt = next.generatedAt;
	next.nodes = sample.nodes.map((node) => ({
		...node,
		observedAt: next.generatedAt,
		usage: { ...node.usage, memoryBytes: 5000 },
	}));
	await store.write(next);
	await store.write(sample);
	const recovered = OperationsResourcesV2Schema.parse(
		await (await app().request("/api/v2/ops/resources")).json(),
	);
	expect(
		recovered.alerts.filter(
			(alert: { code: string }) => alert.code === "MEMORY_PRESSURE",
		),
	).toMatchObject([
		{
			objectUid: "hot-node-uid",
			state: "resolved",
			firstAt: first,
			resolvedAt: next.generatedAt,
		},
	]);
});

it("binds Agent Workload samples to the verified controller without reusing another controller UID", async () => {
	const agentId = "workload-agent";
	const deployment = workloadDesiredFixture(1, agentId);
	const configuration = {
		...structuredClone(agentConfigurationConformanceRecordV1),
		agentId,
		revision: 1,
	};
	const version = JSON.parse(JSON.stringify({ configuration, deployment }));
	await sql`insert into platform.agents(id) values (${agentId})`;
	await sql`insert into platform.workload_reconciliations(agent_id, revision, state, next_attempt_at)
		values (${agentId}, 1, ${sql.json({
			schemaVersion: 1,
			agentId,
			sourceConfigurationRevision: 1,
			sourceLifecycleRevision: 1,
			revision: 1,
			fence: 1,
			phase: "ready",
			candidate: version,
			verified: version,
			verifiedRevision: 1,
			identity: { uid: "controller-current", generation: 2 },
			rollback: false,
			failureCode: null,
			attempts: 0,
		})}, now())`;
	const now = new Date(Date.now() + 4000).toISOString();
	const snapshot = emptyOperationsResourcesV2(scope, now);
	const resource = {
		kind: "Pod" as const,
		uid: "workload-pod-uid",
		name: "workload-pod",
		namespace: scope.namespace,
		resourceVersion: "1",
		ownerUid: "controller-current",
		ownerGeneration: 2,
		agentId,
		agentName: null,
		sessionId: null,
		sandboxId: null,
		generation: null,
		revision: 1,
		workloadRevision: 1,
		resourceFence: 1,
		ownership: "agent" as const,
		role: "workload" as const,
		nodeName: "node-1",
		phase: "Running",
		ready: true,
		restarts: 0,
		reason: null,
		observedAt: now,
		identityObservedAt: now,
		usage: {
			cpuCores: 0.5,
			memoryBytes: 1024,
			storageBytes: null,
			ephemeralStorageBytes: null,
		},
		requests: {
			cpuCores: 1,
			memoryBytes: 2048,
			storageBytes: null,
			ephemeralStorageBytes: null,
		},
		limits: {
			cpuCores: 2,
			memoryBytes: 4096,
			storageBytes: null,
			ephemeralStorageBytes: null,
		},
		containers: [],
		images: [],
		retainedStorage: false,
	};
	snapshot.resources = [
		resource,
		{ ...resource, uid: "foreign-pod", ownerUid: "controller-other" },
	];
	await store.write(snapshot);
	const response = await app().request(
		`/api/v2/ops/resources?agentId=${agentId}`,
	);
	expect(response.status).toBe(200);
	const body = OperationsResourcesV2Schema.parse(await response.json());
	expect(body.resources).toHaveLength(1);
	expect(body.resources[0]).toMatchObject({
		uid: "workload-pod-uid",
		ownership: "agent",
	});
});

it("collects container samples while a cache source fails without counting executor as another Pod", async () => {
	const now = new Date(Date.now() + 4500).toISOString();
	const metadata = {
		name: "shared-worker",
		namespace: scope.namespace,
		uid: "worker-pod-uid",
		resourceVersion: "1",
		creationTimestamp: new Date(Date.now() - 60_000).toISOString(),
		ownerReferences: [
			{
				apiVersion: "apps/v1",
				kind: "ReplicaSet",
				name: "worker-rs",
				uid: "worker-rs-uid",
				controller: true,
			},
		],
	};
	const objects: Record<string, unknown[]> = {
		pods: [
			{
				metadata,
				spec: {
					nodeName: "node-1",
					containers: [
						{
							name: "platform-worker",
							image:
								"registry.example/worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
							resources: {
								requests: { cpu: "250m", memory: "256Mi" },
								limits: { cpu: "1", memory: "512Mi" },
							},
						},
						{
							name: "codex-session-executor",
							image:
								"registry.example/executor@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
							resources: {
								requests: { cpu: "100m", memory: "128Mi" },
								limits: { cpu: "1", memory: "256Mi" },
							},
						},
					],
				},
				status: {
					phase: "Running",
					conditions: [{ type: "Ready", status: "True" }],
				},
			},
		],
		replicasets: [
			{
				metadata: {
					name: "worker-rs",
					namespace: scope.namespace,
					uid: "worker-rs-uid",
					ownerReferences: [
						{
							apiVersion: "apps/v1",
							kind: "Deployment",
							name: "agent-infra-worker",
							uid: "worker-deploy-uid",
							controller: true,
						},
					],
				},
			},
		],
		deployments: [
			{
				metadata: {
					name: "agent-infra-worker",
					namespace: scope.namespace,
					uid: "worker-deploy-uid",
					generation: 1,
				},
			},
		],
		podMetrics: [
			{
				metadata: {
					name: metadata.name,
					namespace: scope.namespace,
					uid: metadata.uid,
				},
				timestamp: now,
				window: "30s",
				containers: [
					{
						name: "platform-worker",
						usage: { cpu: "100000000n", memory: "100Mi" },
					},
					{
						name: "codex-session-executor",
						usage: { cpu: "50000000n", memory: "50Mi" },
					},
				],
			},
		],
	};
	const snapshot = await collectOperationsSnapshotV2({
		scope,
		readCluster: true,
		cacheOwner: "deployment-1",
		cacheInventoryLimit: 48,
		now: () => now,
		bindings: [],
		read: async (kind) => {
			if (kind === "imageCaches") throw new Error("private cloud message");
			return { items: objects[kind] ?? [], truncated: false };
		},
	});
	await store.write(snapshot);
	const response = await app().request("/api/v2/ops/resources");
	const body = OperationsResourcesV2Schema.parse(await response.json());
	expect(body.resources).toHaveLength(1);
	expect(body.resources[0]).toMatchObject({
		ownership: "shared",
		role: "worker",
		usage: { cpuCores: 0.15, memoryBytes: 157286400 },
	});
	expect(body.resources[0]?.containers).toHaveLength(2);
	expect(body.sources).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ kind: "image-cache", state: "unavailable" }),
		]),
	);
	expect(JSON.stringify(body)).not.toContain("private cloud message");
});

it("queries only verified historical Pod UIDs and does not turn backend failure into zero usage", async () => {
	const input = {
		metric: "cpu" as const,
		agentId: "workload-agent",
		statistic: "average" as const,
		start: new Date(Date.now() - 3600_000).toISOString(),
		end: new Date(Date.now() + 50_000).toISOString(),
	};
	const identities = await store.historyIdentities(input);
	const identity = identities.identities.find(
		(entry) => entry.uid === "workload-pod-uid",
	);
	if (!identity) throw new Error("Expected owned workload fixture");
	let fail = false;
	const query = createOperationsQueryV2({
		store,
		configuration: {
			scope,
			readCluster: false,
			cacheOwner: "deployment-1",
			cacheInventoryLimit: 48,
			intervalSeconds: 30,
			alerts: { capacityRatio: 0.9, criticalRatio: 0.95, queueCount: 100 },
			prometheus: {
				endpoint: "https://metrics.example.test/read",
				detailDays: 7,
				aggregateDays: 30,
				aggregateStepSeconds: 300,
			},
		},
		queryPrometheus: async (_configuration, expression) => {
			expect(expression).toContain('namespace="platform-1"');
			expect(expression).toContain("workload-pod-uid");
			if (fail) throw new Error("private remote error");
			return {
				resultType: "matrix",
				result: [
					{
						metric: { uid: "workload-pod-uid", pod: "workload-pod" },
						values: [[Date.parse(identity.firstSeen) / 1000, "0"]],
					},
					{
						metric: { uid: "foreign-pod", pod: "foreign" },
						values: [[Date.parse(identity.firstSeen) / 1000, "999"]],
					},
				],
			};
		},
	});
	const url = `/api/v2/ops/history?${new URLSearchParams(input).toString()}`;
	const result = OperationsHistoryV2Schema.parse(
		await (await app(query).request(url)).json(),
	);
	expect(result).toMatchObject({
		state: "available",
		series: [{ resourceUid: "workload-pod-uid", points: [{ value: 0 }] }],
	});
	expect(result.series).toHaveLength(1);
	fail = true;
	const unavailable = OperationsHistoryV2Schema.parse(
		await (await app(query).request(url)).json(),
	);
	expect(unavailable).toMatchObject({ state: "unavailable", series: [] });
	expect(JSON.stringify(unavailable)).not.toContain("private remote error");
});

it("clips name-based PVC history to the observed lifetime of the requested UID", async () => {
	const input = {
		metric: "storage" as const,
		resourceUid: "current-pvc-uid",
		statistic: "average" as const,
		start: new Date(Date.now() - 3600_000).toISOString(),
		end: new Date(Date.now() + 50_000).toISOString(),
	};
	const references = await store.historyIdentities(input);
	const identity = references.identities[0];
	if (!identity) throw new Error("Expected retained volume fixture");
	const query = createOperationsQueryV2({
		store,
		configuration: {
			scope,
			readCluster: false,
			cacheOwner: "deployment-1",
			cacheInventoryLimit: 48,
			intervalSeconds: 30,
			alerts: { capacityRatio: 0.9, criticalRatio: 0.95, queueCount: 100 },
			prometheus: {
				endpoint: "https://metrics.example.test",
				detailDays: 7,
				aggregateDays: 30,
				aggregateStepSeconds: 300,
			},
		},
		queryPrometheus: async () => ({
			resultType: "matrix",
			result: [
				{
					metric: {
						uid: "current-pvc-uid",
						persistentvolumeclaim: "retained-pvc",
					},
					values: [
						[(Date.parse(identity.firstSeen) - 1000) / 1000, "999"],
						[Date.parse(identity.firstSeen) / 1000, "12"],
						[(Date.parse(identity.lastSeen) + 1000) / 1000, "999"],
					],
				},
			],
		}),
	});
	const result = OperationsHistoryV2Schema.parse(
		await (
			await app(query).request(
				`/api/v2/ops/history?${new URLSearchParams(input)}`,
			)
		).json(),
	);
	expect(result).toMatchObject({
		state: "available",
		series: [{ resourceUid: "current-pvc-uid", points: [{ value: 12 }] }],
	});
	expect(result.series[0]?.points).toHaveLength(1);
});

it("establishes a history interval only after separate observations confirm the same object", async () => {
	const isolatedScope = {
		clusterId: scope.clusterId,
		namespace: "interval-fixture",
	};
	const isolated = new PostgresOperationsResourceStoreV2({
		databaseUrl: database.databaseUrl,
		scope: isolatedScope,
	});
	try {
		const now = Date.now();
		const objects: Record<string, unknown[]> = {
			pods: [
				{
					metadata: {
						uid: "interval-pod",
						name: "interval-pod",
						namespace: isolatedScope.namespace,
						resourceVersion: "1",
						ownerReferences: [
							{
								kind: "StatefulSet",
								name: "agent-infra-postgres",
								uid: "interval-controller",
								controller: true,
							},
						],
					},
					spec: {
						containers: [{ name: "postgres", image: "postgres:synthetic" }],
					},
					status: { phase: "Running" },
				},
			],
			statefulsets: [
				{
					metadata: {
						uid: "interval-controller",
						name: "agent-infra-postgres",
						namespace: isolatedScope.namespace,
						generation: 1,
					},
				},
			],
		};
		const observe = async (start: number, end: number) => {
			const times = [
				new Date(start).toISOString(),
				new Date(end).toISOString(),
			];
			const snapshot = await collectOperationsSnapshotV2({
				scope: isolatedScope,
				readCluster: false,
				cacheOwner: "fixture-cache",
				cacheInventoryLimit: 48,
				bindings: [],
				now: () => times.shift() ?? new Date(end).toISOString(),
				read: async (kind) => ({
					items: objects[kind] ?? [],
					truncated: false,
				}),
			});
			// Remaining provider queries finish after the identity observation.
			snapshot.generatedAt = new Date(end + 1000).toISOString();
			await isolated.write(snapshot);
		};
		const reader = createOperationsQueryV2({
			store: isolated,
			configuration: {
				scope: isolatedScope,
				readCluster: false,
				cacheOwner: "fixture-cache",
				cacheInventoryLimit: 48,
				intervalSeconds: 30,
				alerts: { capacityRatio: 0.9, criticalRatio: 0.95, queueCount: 100 },
				prometheus: {
					endpoint: "https://metrics.example.test",
					detailDays: 7,
					aggregateDays: 30,
					aggregateStepSeconds: 300,
				},
			},
			queryPrometheus: async () => ({
				resultType: "matrix",
				result: [
					{
						metric: { uid: "interval-pod", pod: "interval-pod" },
						values: [[(now - 25000) / 1000, "3"]],
					},
				],
			}),
		});
		const path = `/api/v2/ops/history?${new URLSearchParams({ metric: "cpu", resourceUid: "interval-pod", start: new Date(now - 60000).toISOString(), end: new Date(now).toISOString(), statistic: "average" })}`;
		await observe(now - 40000, now - 30000);
		expect(await (await app(reader).request(path)).json()).toMatchObject({
			state: "missing",
			series: [],
		});
		await observe(now - 20000, now - 10000);
		expect(await (await app(reader).request(path)).json()).toMatchObject({
			state: "available",
			series: [{ resourceUid: "interval-pod", points: [{ value: 3 }] }],
		});
	} finally {
		await isolated.close();
	}
});

it("rejects a previous Node UID's metrics after same-name recreation", async () => {
	const now = new Date().toISOString();
	let nodeReads = 0;
	const snapshot = await collectOperationsSnapshotV2({
		scope,
		readCluster: true,
		cacheOwner: "fixture-cache",
		cacheInventoryLimit: 48,
		bindings: [],
		now: () => now,
		read: async (kind) => ({
			truncated: false,
			items:
				kind === "nodes"
					? [
							{
								metadata: {
									name: "reused-node",
									uid: ++nodeReads === 1 ? "old-node" : "new-node",
									creationTimestamp: new Date(Date.now() - 1000).toISOString(),
								},
								status: {
									capacity: { cpu: "4", memory: "10Gi" },
									allocatable: { cpu: "4", memory: "10Gi" },
								},
							},
						]
					: kind === "nodeMetrics"
						? [
								{
									metadata: { name: "reused-node", uid: "old-node" },
									timestamp: now,
									window: "30s",
									usage: { cpu: "3800m", memory: "9Gi" },
								},
							]
						: [],
		}),
	});
	expect(snapshot.nodes[0]).toMatchObject({
		uid: "new-node",
		usage: { cpuCores: null, memoryBytes: null },
	});
});

it("retains a capacity alert until that object's own measurement confirms recovery", async () => {
	const isolated = new PostgresOperationsResourceStoreV2({
		databaseUrl: database.databaseUrl,
		scope: { ...scope, namespace: "pressure-fixture" },
	});
	try {
		const at = Date.now();
		const observation = (offset: number, cpu: number | null) => {
			const now = new Date(at + offset).toISOString();
			const snapshot = emptyOperationsResourcesV2(
				{ ...scope, namespace: "pressure-fixture" },
				now,
			);
			snapshot.sources[2] = {
				kind: "pod-metrics",
				state: "available",
				observedAt: now,
				windowSeconds: 30,
				reason: null,
			};
			snapshot.resources = [
				{
					kind: "Pod",
					uid: "hot-pod",
					name: "hot-pod",
					namespace: "pressure-fixture",
					resourceVersion: "1",
					ownerUid: null,
					ownerGeneration: null,
					agentId: null,
					agentName: null,
					sessionId: null,
					sandboxId: null,
					generation: null,
					revision: null,
					workloadRevision: null,
					resourceFence: null,
					ownership: "unknown",
					role: "unknown",
					nodeName: null,
					phase: "Running",
					ready: true,
					restarts: 0,
					reason: null,
					observedAt: now,
					usage: {
						cpuCores: cpu,
						memoryBytes: null,
						storageBytes: null,
						ephemeralStorageBytes: null,
					},
					requests: {
						cpuCores: 1,
						memoryBytes: null,
						storageBytes: null,
						ephemeralStorageBytes: null,
					},
					limits: {
						cpuCores: 1,
						memoryBytes: null,
						storageBytes: null,
						ephemeralStorageBytes: null,
					},
					containers: [],
					images: [],
					retainedStorage: false,
				},
			];
			return snapshot;
		};
		await isolated.write(observation(0, 0.96));
		await isolated.write(observation(10, null));
		const missing = OperationsResourcesV2Schema.parse(
			await (await app(isolated).request("/api/v2/ops/resources")).json(),
		);
		expect(
			missing.alerts.find((alert) => alert.id === "CPU_PRESSURE:hot-pod")
				?.state,
		).toBe("firing");
		await isolated.write(observation(20, 0.2));
		const recovered = OperationsResourcesV2Schema.parse(
			await (await app(isolated).request("/api/v2/ops/resources")).json(),
		);
		expect(
			recovered.alerts.find((alert) => alert.id === "CPU_PRESSURE:hot-pod")
				?.state,
		).toBe("resolved");
	} finally {
		await isolated.close();
	}
});

it.each(["session_sandbox_budgets", "outbox_items"])(
	"keeps stored resource facts when %s cannot be queried",
	async (table) => {
		const isolated = new PostgresOperationsResourceStoreV2({
			databaseUrl: database.databaseUrl,
			scope: { ...scope, namespace: "partial-fixture" },
		});
		try {
			const now = new Date().toISOString();
			const snapshot = emptyOperationsResourcesV2(
				{ ...scope, namespace: "partial-fixture" },
				now,
			);
			snapshot.nodes = [
				{
					uid: "visible-node",
					name: "visible-node",
					virtual: false,
					ready: true,
					pressures: [],
					observedAt: now,
					capacity: {
						cpuCores: 4,
						memoryBytes: 10000,
						storageBytes: null,
						ephemeralStorageBytes: null,
					},
					allocatable: {
						cpuCores: 4,
						memoryBytes: 10000,
						storageBytes: null,
						ephemeralStorageBytes: null,
					},
					usage: {
						cpuCores: 1,
						memoryBytes: 5000,
						storageBytes: null,
						ephemeralStorageBytes: null,
					},
					requests: {
						cpuCores: null,
						memoryBytes: null,
						storageBytes: null,
						ephemeralStorageBytes: null,
					},
				},
			];
			await isolated.write(snapshot);
			await sql.begin(async (transaction) => {
				await transaction.unsafe(
					`lock table platform.${table} in access exclusive mode`,
				);
				const response = await app(isolated).request("/api/v2/ops/resources");
				expect(response.status).toBe(200);
				const body = OperationsResourcesV2Schema.parse(await response.json());
				expect(body.nodes).toMatchObject([
					{ uid: "visible-node", usage: { cpuCores: 1 } },
				]);
				expect(body.sources).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ kind: "platform", state: "unavailable" }),
					]),
				);
			});
		} finally {
			await isolated.close();
		}
	},
);
