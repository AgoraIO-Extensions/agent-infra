import {
	KubernetesReconcileResultV1Schema,
	WorkloadCleanupResultV1Schema,
} from "@agent-infra/contracts/workload";
import { describe, expect, it } from "vitest";

import { createFakeKubernetesRuntimeAdapterV1 } from "./kubernetes.js";

const capabilities = {
	schemaVersion: 1,
	statefulSetApiVersion: "apps/v1",
	coreApiVersion: "v1",
	networkingApiVersion: "networking.k8s.io/v1",
	routeKind: "deployment-adapter",
	namespaceScoped: true,
} as const;

const secretRef = {
	schemaVersion: 1,
	agentId: "agent_01",
	secretId: "secret_01",
	secretVersion: 2,
	configRevision: 7,
	name: "agent-01-secret-01-v2-r7",
} as const;

const desired = {
	schemaVersion: 1,
	requestId: "request_workload_01",
	traceId: "trace_workload_01",
	agentId: "agent_01",
	configRevision: 7,
	workloadRevision: 9,
	fence: 11,
	namespaceRef: "pilot-namespace",
	desiredState: "running",
	replicas: 1,
	imageDigest: `sha256:${"c".repeat(64)}`,
	runtimeManifest: {
		schemaVersion: 1,
		interactionMode: "platform-adapter",
		protocol: "acp",
		service: { port: 8080 },
		health: { path: "/healthz" },
	},
	resourceProfileRef: "resource-profile/pilot-standard",
	env: { LOG_LEVEL: "info" },
	service: { name: "agent-01", port: 8080 },
	health: { path: "/healthz", timeoutSeconds: 5, failureThreshold: 3 },
	persistentVolume: {
		name: "agent-01-data",
		mountPath: "/workspace",
		storageProfileRef: "storage/pilot-rwo",
		accessMode: "ReadWriteOnce",
		retention: "retain",
	},
	serviceAccount: { name: "agent-01", kubernetesApiAccess: false },
	networkPolicy: {
		deploymentPolicyRef: "network/pilot",
		ingressMode: "runtime-host-client-only",
		kubernetesApiAccess: false,
		platformDatabaseAccess: false,
		connectionDatabaseAccess: false,
		decryptionKeyringAccess: false,
	},
	route: { name: "agent-01", exposure: "internal-only", tlsRequired: true },
	secretRefs: [secretRef],
} as const;

const applied = {
	schemaVersion: 1,
	requestId: desired.requestId,
	traceId: desired.traceId,
	agentId: desired.agentId,
	configRevision: desired.configRevision,
	workloadRevision: desired.workloadRevision,
	fence: desired.fence,
	state: "ready",
	imageDigest: desired.imageDigest,
	workloadUid: "workload_uid_01",
	observedGeneration: 4,
	service: desired.service,
	healthCheck: desired.health,
	desiredReplicas: 1,
	readyReplicas: 1,
	serviceRef: "service/agent-01",
	serviceAccountRef: "service-account/agent-01",
	persistentVolumeRef: "pvc/agent-01-data",
	networkPolicyRef: "network-policy/agent-01",
	route: {
		state: "open",
		routeRef: "route/agent-01",
		workloadUid: "workload_uid_01",
		workloadRevision: desired.workloadRevision,
	},
	health: { state: "healthy", observedAt: "2026-08-28T10:10:00Z" },
	secretRefs: [secretRef],
	cleanupState: "not-requested",
} as const;

const appliedResult = {
	schemaVersion: 1,
	status: "applied",
	requestId: desired.requestId,
	traceId: desired.traceId,
	agentId: desired.agentId,
	configRevision: desired.configRevision,
	workloadRevision: desired.workloadRevision,
	fence: desired.fence,
	workloadUid: applied.workloadUid,
	workloadGeneration: applied.observedGeneration,
	applied,
} as const;

describe("Fake KubernetesRuntimeAdapter V1", () => {
	it("returns schema-valid capabilities and applied state", async () => {
		const adapter = createFakeKubernetesRuntimeAdapterV1({
			capabilities,
			reconcile: () => appliedResult,
		});

		expect(adapter.capabilities()).toEqual(capabilities);
		const result = await adapter.reconcile(desired);
		expect(KubernetesReconcileResultV1Schema.parse(result)).toEqual(result);
		expect(result.status).toBe("applied");
	});

	it("reproduces a stale revision without applying it", async () => {
		const stale = {
			schemaVersion: 1,
			status: "stale",
			requestId: desired.requestId,
			traceId: desired.traceId,
			agentId: desired.agentId,
			configRevision: desired.configRevision,
			workloadRevision: desired.workloadRevision,
			fence: desired.fence,
			currentConfigRevision: 8,
			currentWorkloadRevision: 10,
			error: {
				schemaVersion: 1,
				code: "STALE_WORKLOAD_REVISION",
				message: "A newer Workload revision is current",
				retryable: false,
				traceId: desired.traceId,
			},
		} as const;
		const adapter = createFakeKubernetesRuntimeAdapterV1({
			capabilities,
			reconcile: () => stale,
		});

		expect(await adapter.reconcile(desired)).toEqual(stale);
	});

	it("reproduces rejection, partial apply, route closure, and crash recovery", async () => {
		const rejected = {
			schemaVersion: 1,
			status: "rejected",
			requestId: desired.requestId,
			traceId: desired.traceId,
			agentId: desired.agentId,
			configRevision: desired.configRevision,
			workloadRevision: desired.workloadRevision,
			fence: desired.fence,
			error: {
				schemaVersion: 1,
				code: "WORKLOAD_POLICY_REJECTED",
				message: "The Workload policy rejected the request",
				retryable: false,
				traceId: desired.traceId,
			},
		} as const;
		const applying = {
			...applied,
			state: "applying",
			desiredReplicas: 1,
			readyReplicas: 0,
			route: { state: "closed" },
			health: { state: "unknown" },
			cleanupState: "pending",
		} as const;
		const outcomes = [
			rejected,
			{ ...appliedResult, applied: applying },
			appliedResult,
		] as const;
		let call = 0;
		const adapter = createFakeKubernetesRuntimeAdapterV1({
			capabilities,
			reconcile: () => outcomes[call++],
		});

		expect((await adapter.reconcile(desired)).status).toBe("rejected");
		const partial = await adapter.reconcile(desired);
		expect(partial.status).toBe("applied");
		if (partial.status === "applied") {
			expect(partial.applied.route.state).toBe("closed");
		}
		expect(await adapter.reconcile(desired)).toEqual(appliedResult);
	});

	it.each([
		["Secret Agent", { secretRefs: [{ ...secretRef, agentId: "agent_02" }] }],
		[
			"Secret config revision",
			{ secretRefs: [{ ...secretRef, configRevision: 8 }] },
		],
		["Runtime service port", { service: { ...desired.service, port: 9090 } }],
		[
			"Runtime health path",
			{ health: { ...desired.health, path: "/different-health" } },
		],
	])(
		"rejects a mismatched %s before calling the Fake",
		async (_name, mismatch) => {
			let reconciled = false;
			const adapter = createFakeKubernetesRuntimeAdapterV1({
				capabilities,
				reconcile: () => {
					reconciled = true;
					return appliedResult;
				},
			});

			await expect(
				adapter.reconcile({ ...desired, ...mismatch }),
			).rejects.toThrow("Desired Workload correlation mismatch");
			expect(reconciled).toBe(false);
		},
	);

	it("reproduces cleanup and rejects mismatched configured results", async () => {
		const cleanupRequest = {
			schemaVersion: 1,
			requestId: "request_cleanup_01",
			traceId: "trace_cleanup_01",
			agentId: desired.agentId,
			configRevision: desired.configRevision,
			workloadRevision: desired.workloadRevision,
			workloadUid: applied.workloadUid,
			workloadGeneration: applied.observedGeneration,
			fence: desired.fence,
			deleteNewPersistentVolume: true,
		} as const;
		const cleanupResult = {
			...cleanupRequest,
			status: "completed",
			deleted: {
				workload: true,
				service: true,
				serviceAccount: true,
				networkPolicy: true,
				route: true,
				secrets: true,
				persistentVolume: true,
			},
		} as const;
		const adapter = createFakeKubernetesRuntimeAdapterV1({
			capabilities,
			cleanup: () => cleanupResult,
		});

		const result = await adapter.cleanup(cleanupRequest);
		expect(WorkloadCleanupResultV1Schema.parse(result)).toEqual(result);

		const mismatched = createFakeKubernetesRuntimeAdapterV1({
			capabilities,
			reconcile: () => ({ ...appliedResult, requestId: "other" }),
		});
		await expect(mismatched.reconcile(desired)).rejects.toThrow(
			"Kubernetes reconciliation correlation mismatch",
		);
	});
});
