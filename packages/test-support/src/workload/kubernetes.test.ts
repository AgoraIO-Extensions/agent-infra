import {
	KubernetesReconcileResultV1Schema,
	WorkloadCleanupResultV1Schema,
	WorkloadRouteSwitchResultV1Schema,
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
	ownerType: "agent-owner",
	ownerId: "user_01",
	agentId: "agent_01",
	secretId: "secret_01",
	secretVersion: 2,
	configRevision: 7,
	algorithmVersion: "aes-256-gcm:v1",
	wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
	wrappingKeyVersion: "key-2026-08",
	name: "agent-01-secret-01-v2-r7",
} as const;
const runtimeManifest = {
	schemaVersion: 1,
	interactionMode: "platform-adapter",
	protocol: "acp",
	service: { port: 8080 },
	health: { path: "/healthz" },
	capabilities: {
		modelSelection: false,
		attachments: false,
		resultFiles: false,
		connection: false,
		supplementaryInstruction: false,
	},
} as const;
const imageDigest = `sha256:${"c".repeat(64)}` as const;
const registryAdmission = {
	schemaVersion: 1,
	immutableDigest: imageDigest,
	runtimeManifest,
	runtimeManifestParsingEvidence: {
		schemaVersion: 1,
		labelName: "io.agora.agent.runtime.manifest",
		utf8ByteLength: 256,
		maxDepth: 3,
		duplicateKeysDetected: false,
		unknownFieldsDetected: false,
	},
	policyEvidence: {
		schemaVersion: 1,
		policyRef: "policy/pilot-v1",
		decisionRef: "decision_01",
		subjectRef: "subject_01",
		agentId: "agent_01",
		imageDigest,
		evaluatedAt: "2026-08-28T10:00:00Z",
	},
} as const;

const desired = {
	schemaVersion: 1,
	requestId: "request_workload_01",
	traceId: "trace_workload_01",
	agentId: "agent_01",
	configRevision: 7,
	workloadRevision: 9,
	fence: 11,
	expectedWorkload: { state: "absent" },
	namespaceRef: "pilot-namespace",
	desiredState: "running",
	replicas: 1,
	imageDigest,
	registryAdmission,
	runtimeManifest,
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
	resourceProfileRef: desired.resourceProfileRef,
	service: desired.service,
	healthCheck: desired.health,
	routeIntent: desired.route,
	persistentVolume: desired.persistentVolume,
	serviceAccount: desired.serviceAccount,
	networkPolicy: desired.networkPolicy,
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

	it("fails closed with a fixed sanitized error when no result is configured", async () => {
		const adapter = createFakeKubernetesRuntimeAdapterV1({ capabilities });

		const result = await adapter.reconcile(desired);
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.error).toEqual({
				schemaVersion: 1,
				code: "KUBERNETES_ADAPTER_UNAVAILABLE",
				message: "Kubernetes reconciliation is temporarily unavailable",
				retryable: true,
				traceId: desired.traceId,
			});
		}
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
				code: "KUBERNETES_STALE_REVISION",
				message: "A newer Workload revision is already current",
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
				code: "KUBERNETES_POLICY_REJECTED",
				message: "Kubernetes policy rejected the Workload",
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
		const adapter = createFakeKubernetesRuntimeAdapterV1({
			capabilities,
			reconcile: (_desired, attempt) => outcomes[attempt],
		});

		expect((await adapter.reconcile(desired)).status).toBe("rejected");
		const partial = await adapter.reconcile(desired);
		expect(partial.status).toBe("applied");
		if (partial.status === "applied") {
			expect(partial.applied.route.state).toBe("closed");
		}
		const restarted = adapter.restart();
		expect(restarted).not.toBe(adapter);
		expect(await restarted.reconcile(desired)).toEqual(appliedResult);
	});

	it("keeps a failed candidate closed and restores the previous route", async () => {
		const previousRoute = {
			routeRef: "route/agent-01",
			workloadUid: applied.workloadUid,
			workloadRevision: desired.workloadRevision - 1,
			workloadGeneration: applied.observedGeneration - 1,
		} as const;
		const candidateRoute = {
			...previousRoute,
			workloadRevision: desired.workloadRevision,
			workloadGeneration: applied.observedGeneration,
		} as const;
		const request = {
			schemaVersion: 1,
			requestId: "request_route_01",
			traceId: desired.traceId,
			agentId: desired.agentId,
			fence: desired.fence,
			action: "rollback",
			previousRoute,
			candidateRoute,
		} as const;
		const result = {
			schemaVersion: 1,
			requestId: request.requestId,
			traceId: request.traceId,
			agentId: request.agentId,
			fence: request.fence,
			action: request.action,
			status: "completed",
			routedWorkloads: [previousRoute],
		} as const;
		const adapter = createFakeKubernetesRuntimeAdapterV1({
			capabilities,
			switchRoute: () => result,
		});

		const switched = await adapter.switchRoute(request);
		expect(WorkloadRouteSwitchResultV1Schema.parse(switched)).toEqual(result);
		expect(switched.routedWorkloads).toEqual([previousRoute]);
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
			persistentVolumeIntent: "delete-new",
		} as const;
		const cleanupResult = {
			...cleanupRequest,
			status: "completed",
			routeClosed: true,
			removed: {
				route: true,
				workload: true,
				service: true,
				serviceAccount: true,
				networkPolicy: true,
				configuration: true,
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

	it("resumes cleanup after route closure without deleting a retained PVC", async () => {
		const request = {
			schemaVersion: 1,
			requestId: "request_cleanup_restart_01",
			traceId: "trace_cleanup_restart_01",
			agentId: desired.agentId,
			configRevision: desired.configRevision,
			workloadRevision: desired.workloadRevision,
			workloadUid: applied.workloadUid,
			workloadGeneration: applied.observedGeneration,
			fence: desired.fence,
			persistentVolumeIntent: "retain-existing",
		} as const;
		const removed = {
			route: false,
			workload: false,
			service: false,
			serviceAccount: false,
			networkPolicy: false,
			configuration: false,
			secrets: false,
			persistentVolume: false,
		} as const;
		const adapter = createFakeKubernetesRuntimeAdapterV1({
			capabilities,
			cleanup: (_request, attempt) =>
				attempt === 0
					? {
							...request,
							status: "in-progress",
							phase: "removing-resources",
							routeClosed: true,
							removed,
						}
					: {
							...request,
							status: "completed",
							routeClosed: true,
							removed: {
								route: true,
								workload: true,
								service: true,
								serviceAccount: true,
								networkPolicy: true,
								configuration: true,
								secrets: true,
								persistentVolume: false,
							},
						},
		});

		const partial = await adapter.cleanup(request);
		expect(partial.status).toBe("in-progress");
		const restarted = adapter.restart();
		expect(restarted).not.toBe(adapter);
		const completed = await restarted.cleanup(request);
		expect(completed.status).toBe("completed");
		expect(completed.removed.persistentVolume).toBe(false);
	});
});
