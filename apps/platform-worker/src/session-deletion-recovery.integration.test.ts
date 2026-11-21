import { randomUUID } from "node:crypto";
import {
	createAgentManagementV1,
	type SessionSandboxReconciliationClaimV1,
	type SessionSandboxResourceIdentityV1,
} from "@agent-infra/platform-core";
import {
	PostgresAgentManagementTransactionV1,
	PostgresConversationDispatchStoreV1,
} from "@agent-infra/platform-store";
import type { KubernetesObject, V1Pod } from "@kubernetes/client-node";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { fakeKubernetesApi, workloadTestPolicy } from "./kubernetes.fixture.js";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import {
	createSessionSandboxWorkloadAdapterV1,
	type SessionSandboxAllocationV1,
	sessionSandboxResourcesV1,
} from "./session-workload-adapter.js";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
beforeAll(async () => {
	database = await startPostgresTestDatabase("4316-delete-recovery");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 4, onnotice: () => {} });
}, 30_000);
afterAll(async () => {
	await sql?.end();
	await database?.stop();
});

async function fixture(
	outcome: "failed" | "unknown" | "acknowledged" = "failed",
) {
	const suffix = randomUUID();
	const agentId = `agent-${suffix}`;
	const sessionId = `session-${suffix}`;
	const sandboxId = randomUUID();
	const name = `sandbox-${sandboxId}`;
	const ownerId = `owner-${suffix}`;
	const allocation: SessionSandboxAllocationV1 = {
		schemaVersion: 1,
		agentId,
		sessionId,
		sandboxId,
		principal: { kind: "user", id: ownerId },
		channelId: "web",
		resourceName: name,
		workspaceScope: sandboxId,
		generation: 1,
		resourceFence: 1,
		namespace: workloadTestPolicy.namespace,
		podName: name,
		serviceName: name,
		serviceAccountName: name,
		pvcName: name,
		networkPolicyName: name,
		secretName: name,
		egress: {},
		imageDigest: `registry.example.test/runtime@sha256:${"a".repeat(64)}`,
		authorizedIngressSelector: { component: "dispatcher" },
		containerPort: 8080,
		workspaceMountPath: "/workspace",
		resources: {
			requests: { cpu: "100m", memory: "128Mi" },
			limits: { cpu: "1", memory: "1Gi" },
		},
		storageSize: "1Gi",
		env: {},
		runtime: null,
		desiredState: "stopped",
	};
	const fake = fakeKubernetesApi();
	for (const resource of sessionSandboxResourcesV1(allocation))
		await fake.client.create(resource);
	const resources: SessionSandboxResourceIdentityV1[] = [
		...fake.resources.values(),
	].map((o) => ({
		kind: o.kind as SessionSandboxResourceIdentityV1["kind"],
		namespace: allocation.namespace,
		name: o.metadata!.name!,
		uid: o.metadata!.uid!,
		resourceVersion: o.metadata!.resourceVersion!,
	}));
	const sourcePolicy = {
		namespace: allocation.namespace,
		resourceConfigurationHash: "b".repeat(64),
		configurationRevision: 1,
		workloadRevision: 1,
		managementFence: 1,
		imageDigest: `sha256:${"a".repeat(64)}`,
	};
	await sql`insert into platform.agents(id,current_configuration_revision,authorization_revision) values(${agentId},1,'authority-4316')`;
	await sql`insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,desired_state,service_availability,workload_revision,fence) values(${`app-${suffix}`},${agentId},${ownerId},'Agent','Fixture','available','trace','request',now(),1,1,'running','ready',1,1)`;
	await sql`insert into platform.agent_owners(agent_id,owner_id,created_at) values(${agentId},${ownerId},now())`;
	await sql`insert into platform.conversations(id,agent_id,actor_id,principal_type,channel_id,status,session_generation,authorization_revision,last_conversation_cursor,created_at,updated_at) values(${sessionId},${agentId},${ownerId},'user','web','ready',1,'authority-4316',0,now(),now())`;
	await sql`insert into platform.session_sandbox_allocations(sandbox_id,conversation_id,agent_id,actor_id,principal_type,channel_id,session_generation,resource_name,workspace_scope,status,desired_state,resource_fence,resource_policy,resource_observation,created_at,updated_at) values(${sandboxId},${sessionId},${agentId},${ownerId},'user','web',1,${name},${sandboxId},'ready','running',1,${sql.json(sourcePolicy)},${sql.json({ status: "ready", resources } as unknown as Parameters<typeof sql.json>[0])},now(),now())`;
	const managementStore = new PostgresAgentManagementTransactionV1({
		databaseUrl: database.databaseUrl,
	});
	const management = createAgentManagementV1(managementStore);
	const stop = await management.executeManagementCommand(
		{
			schemaVersion: 1,
			command: "stop_agent",
			agentId,
			expectedRevision: 1,
			idempotencyKey: `stop-${suffix}`,
			traceId: "stop",
			requestId: "stop",
		},
		{
			schemaVersion: 1,
			userId: ownerId,
			accountStatus: "active",
			organizationIds: [],
			isAdministrator: false,
		},
	);
	expect(stop).toMatchObject({ outcome: "accepted" });
	const store = new PostgresConversationDispatchStoreV1({
		databaseUrl: database.databaseUrl,
		sandboxPolicy: {
			namespace: allocation.namespace,
			resourceConfigurationHash: sourcePolicy.resourceConfigurationHash,
		},
	});
	const request = {
		schemaVersion: 1 as const,
		itemId: `conversation:sandbox:${sessionId}:1`,
		workerId: "delete-worker",
		leaseDurationMs: 30_000,
	};
	let claim: SessionSandboxReconciliationClaimV1 | null =
		await store.claimSandboxReconciliation(request);
	if (!claim?.lifecycle) throw Error("Expected formal stop drain");
	expect(claim).toMatchObject({ purpose: "drain", drainComputeAllowed: true });
	const calls: KubernetesObject[] = [];
	let injectConflict = true;
	const adapter = createSessionSandboxWorkloadAdapterV1({
		client: {
			...fake.client,
			async deleteResult(resource) {
				calls.push(structuredClone(resource));
				if (resource.kind === "Pod" && injectConflict) {
					injectConflict = false;
					const pod = await fake.client.read<V1Pod>("Pod", name);
					if (!pod?.metadata) throw Error("Missing original Pod");
					fake.seed({
						...pod,
						metadata: {
							...pod.metadata,
							resourceVersion: "status-rv-2",
							...(outcome === "acknowledged"
								? { deletionTimestamp: new Date() }
								: {}),
						},
						status: { phase: "Running" },
					} as V1Pod);
					if (outcome === "unknown")
						throw new WorkloadKubernetesError("unavailable");
					if (outcome === "acknowledged") return "acknowledged";
				}
				await fake.client.delete(resource);
				return "acknowledged";
			},
		},
	});
	const cleanup = () =>
		adapter.cleanup(allocation, resources, {
			sourceGeneration: 1,
			sourceResourceFence: 1,
			targetGeneration: claim!.sandbox.generation,
			targetResourceFence: claim!.resourceFence,
			managementFence: claim!.lifecycle!.authority.managementFence,
			deletionProgress: claim!.lifecycle!.deletionProgress,
			recordDeletionProgress: async (progress) => {
				const recorded = await store.recordSandboxDeletionProgress({
					claim: claim!,
					progress,
					leaseDurationMs: 30_000,
				});
				if (recorded.status === "committed") claim = recorded.claim;
				return recorded.status;
			},
		});
	return {
		allocation,
		fake,
		store,
		managementStore,
		resources,
		calls,
		cleanup,
		agentId,
		sessionId,
		request,
		async managementCommand(
			command: "restart_agent" | "stop_agent",
			revision: number,
		) {
			return management.executeManagementCommand(
				{
					schemaVersion: 1,
					command,
					agentId,
					expectedRevision: revision,
					idempotencyKey: randomUUID(),
					requestId: "management-race",
					traceId: "management-race",
				},
				{
					schemaVersion: 1,
					userId: ownerId,
					accountStatus: "active",
					organizationIds: [],
					isAdministrator: false,
				},
			);
		},
		async reclaim() {
			claim = await store.claimSandboxReconciliation(request);
			if (!claim) throw Error("Expected refreshed source claim");
		},
		get claim() {
			return claim!;
		},
		async close() {
			await store.close();
			await managementStore.close();
		},
	};
}

it("recovers a definitively failed same-UID delete after status RV drift and retains failed history", async () => {
	const f = await fixture();
	try {
		await expect(f.cleanup()).rejects.toMatchObject({ code: "conflict" });
		const failed = f.claim.lifecycle!.deletionProgress!.find(
			(p) => p.resource.kind === "Pod",
		)!;
		expect(failed).toMatchObject({
			state: "unknown",
			deleteAttempted: true,
			deleteCallResult: "failed",
		});
		const receipt = await f.cleanup();
		const current = f.claim.lifecycle!.deletionProgress!.find(
			(p) => p.resource.kind === "Pod",
		)!;
		expect(current.deleteAttemptId).not.toBe(failed.deleteAttemptId);
		expect(current).toMatchObject({
			state: "absent",
			preconditions: {
				uid: failed.resource.uid,
				resourceVersion: "status-rv-2",
			},
		});
		expect(
			f.calls
				.filter((c) => c.kind === "Pod")
				.map((c) => c.metadata?.resourceVersion),
		).toEqual([failed.preconditions.resourceVersion, "status-rv-2"]);
		expect(await f.fake.client.read("Pod", f.allocation.podName)).toBeNull();
		expect(receipt.retainedPVC?.uid).toBe(
			f.resources.find((r) => r.kind === "PersistentVolumeClaim")!.uid,
		);
		expect(
			await f.fake.client.read("PersistentVolumeClaim", f.allocation.pvcName),
		).not.toBeNull();
		const rows =
			await sql`select details from platform.conversation_audit_events where conversation_id=${f.sessionId} and details->>'checkpoint'='sandbox-deletion-attempt-replaced'`;
		expect(rows).toHaveLength(1);
		expect(rows[0]!.details.previous).toEqual(failed);
		expect(
			await f.store.recordSandboxObservation({
				claim: f.claim,
				observation: {
					status: "stopped",
					resources: [receipt.retainedPVC!],
					sourceStop: receipt,
				},
			}),
		).toBe("committed");
		const [settled] =
			await sql`select o.status as outbox_status,o.payload->'lifecycle'->'stopReceipt' as receipt,a.status as sandbox_status from platform.outbox_items o join platform.session_sandbox_allocations a on a.conversation_id=o.scope_id where o.id=${f.request.itemId}`;
		expect(settled).toMatchObject({
			outbox_status: "succeeded",
			sandbox_status: "stopped",
			receipt,
		});
	} finally {
		await f.close();
	}
}, 30_000);

it.each([
	"uid",
	"owner",
	"owner-reference",
	"generation",
	"fence",
	"spec-args",
	"spec-envFrom",
	"spec-security",
])(
	"keeps failed progress closed when original Pod %s drifts",
	async (drift) => {
		const f = await fixture();
		try {
			await expect(f.cleanup()).rejects.toMatchObject({ code: "conflict" });
			const original = structuredClone(f.claim.lifecycle!.deletionProgress);
			const pod = await f.fake.client.read<V1Pod>("Pod", f.allocation.podName);
			if (!pod?.metadata || !pod.spec) throw Error("Missing Pod");
			if (drift === "uid") pod.metadata.uid = "replacement-pod";
			else if (drift === "owner")
				pod.metadata.annotations!["agent-infra.agora.io/agent-id"] =
					"foreign-agent";
			else if (drift === "owner-reference")
				pod.metadata.ownerReferences = [
					{
						apiVersion: "apps/v1",
						kind: "StatefulSet",
						name: "foreign",
						uid: "foreign",
						controller: true,
					},
				];
			else if (drift === "generation")
				pod.metadata.labels!["agent-infra.agora.io/generation"] = "2";
			else if (drift === "fence")
				pod.metadata.annotations!["agent-infra.agora.io/fence"] = "2";
			else if (drift === "spec-args")
				pod.spec.containers[0]!.args = ["unapproved"];
			else if (drift === "spec-envFrom")
				pod.spec.containers[0]!.envFrom = [
					{ secretRef: { name: "foreign-secret" } },
				];
			else pod.spec.containers[0]!.securityContext = { privileged: true };
			f.fake.seed(pod);
			await expect(f.cleanup()).rejects.toMatchObject({ code: "conflict" });
			expect(f.calls.filter((c) => c.kind === "Pod")).toHaveLength(1);
			expect(f.claim.lifecycle!.deletionProgress).toEqual(original);
			expect(
				await sql`select id from platform.conversation_audit_events where conversation_id=${f.sessionId} and details->>'checkpoint'='sandbox-deletion-attempt-replaced'`,
			).toHaveLength(0);
		} finally {
			await f.close();
		}
	},
	30_000,
);

it.each(["unknown", "acknowledged"] as const)(
	"only observes an original %s DELETE outcome and never resends it",
	async (outcome) => {
		const f = await fixture(outcome);
		try {
			await expect(f.cleanup()).rejects.toMatchObject({ code: "unavailable" });
			const old = structuredClone(f.claim.lifecycle!.deletionProgress);
			expect(old![0]!.deleteCallResult).toBe(outcome);
			expect(
				await f.store.recordSandboxDeletionProgress({
					claim: f.claim,
					progress: {
						...old![0]!,
						state: "unknown",
						deleteCallResult: "failed",
					},
					leaseDurationMs: 30_000,
				}),
			).toEqual({ status: "stale" });
			await expect(f.cleanup()).rejects.toMatchObject({ code: "unavailable" });
			expect(f.calls.filter((c) => c.kind === "Pod")).toHaveLength(1);
			expect(f.claim.lifecycle!.deletionProgress).toEqual(old);
		} finally {
			await f.close();
		}
	},
	30_000,
);

it("uses the current management intent for the refreshed attempt while retaining source fence and old failure", async () => {
	const f = await fixture();
	try {
		await expect(f.cleanup()).rejects.toMatchObject({ code: "conflict" });
		const failed = f.claim.lifecycle!.deletionProgress![0]!;
		expect(await f.managementCommand("restart_agent", 2)).toMatchObject({
			outcome: "accepted",
		});
		expect(await f.managementCommand("stop_agent", 3)).toMatchObject({
			outcome: "accepted",
		});
		// The caller still holds the former management/lease: CAS must reject before a second DELETE.
		await expect(f.cleanup()).rejects.toMatchObject({ code: "unavailable" });
		expect(f.calls.filter((c) => c.kind === "Pod")).toHaveLength(1);
		await f.reclaim();
		const sourcePod = f.claim.lifecycle!.deletionProgress!.find(
			(p) => p.resource.kind === "Pod",
		)!;
		const obsoleteIntent = {
			...sourcePod,
			state: "delete-requested" as const,
			deleteAttemptId: randomUUID(),
			deleteAttempted: false,
			deleteCallResult: "not-attempted" as const,
			resource: { ...sourcePod.resource, resourceVersion: "status-rv-2" },
			preconditions: {
				...sourcePod.preconditions,
				resourceVersion: "status-rv-2",
			},
		};
		expect(
			await f.store.recordSandboxDeletionProgress({
				claim: f.claim,
				progress: obsoleteIntent,
				leaseDurationMs: 30_000,
			}),
		).toEqual({ status: "stale" });
		await f.cleanup();
		const progress = f.claim.lifecycle!.deletionProgress!.find(
			(p) => p.resource.kind === "Pod",
		)!;
		expect(progress.managementFence).toBeGreaterThan(failed.managementFence);
		expect(progress.sourceGeneration).toBe(failed.sourceGeneration);
		expect(progress.resourceFence).toBe(failed.resourceFence);
		expect(
			(
				await sql`select details from platform.conversation_audit_events where conversation_id=${f.sessionId} and details->>'checkpoint'='sandbox-deletion-attempt-replaced'`
			)[0]!.details.previous,
		).toEqual(failed);
	} finally {
		await f.close();
	}
}, 30_000);

it("rolls back a replacement CAS if preserving failed history fails and never sends the new DELETE", async () => {
	const f = await fixture();
	try {
		await expect(f.cleanup()).rejects.toMatchObject({ code: "conflict" });
		const failed = structuredClone(f.claim.lifecycle!.deletionProgress);
		await sql.unsafe(
			`create function platform.fail_delete_history() returns trigger language plpgsql as $$ begin if new.details->>'checkpoint'='sandbox-deletion-attempt-replaced' then raise exception 'synthetic audit failure'; end if; return new; end $$`,
		);
		await sql.unsafe(
			"create trigger fail_delete_history before insert on platform.conversation_audit_events for each row execute function platform.fail_delete_history()",
		);
		try {
			await expect(f.cleanup()).rejects.toThrow();
		} finally {
			await sql.unsafe(
				"drop trigger fail_delete_history on platform.conversation_audit_events",
			);
			await sql.unsafe("drop function platform.fail_delete_history()");
		}
		const [row] =
			await sql`select payload from platform.outbox_items where id=${f.request.itemId}`;
		expect(row!.payload.lifecycle.deletionProgress).toEqual(failed);
		expect(f.calls.filter((c) => c.kind === "Pod")).toHaveLength(1);
		await f.cleanup();
	} finally {
		await f.close();
	}
}, 30_000);

it("commits only one competing refreshed delete attempt and keeps the previous failure exactly once", async () => {
	const f = await fixture();
	try {
		await expect(f.cleanup()).rejects.toMatchObject({ code: "conflict" });
		const previous = f.claim.lifecycle!.deletionProgress![0]!;
		const next = {
			...previous,
			state: "delete-requested" as const,
			deleteAttempted: false,
			deleteCallResult: "not-attempted" as const,
			resource: { ...previous.resource, resourceVersion: "status-rv-2" },
			preconditions: {
				...previous.preconditions,
				resourceVersion: "status-rv-2",
			},
		};
		const results = await Promise.all(
			["retry-one", "retry-two"].map((deleteAttemptId) =>
				f.store.recordSandboxDeletionProgress({
					claim: f.claim,
					progress: { ...next, deleteAttemptId },
					leaseDurationMs: 30_000,
				}),
			),
		);
		expect(results.map((r) => r.status).sort()).toEqual(["committed", "stale"]);
		const history =
			await sql`select details from platform.conversation_audit_events where conversation_id=${f.sessionId} and details->>'checkpoint'='sandbox-deletion-attempt-replaced'`;
		expect(history).toHaveLength(1);
		expect(history[0]!.details.previous).toEqual(previous);
		expect(f.calls.filter((c) => c.kind === "Pod")).toHaveLength(1);
	} finally {
		await f.close();
	}
}, 30_000);
