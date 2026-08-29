import { describe, expect, it } from "vitest";

import {
	AgentWorkloadAppliedV1Schema,
	AgentWorkloadDesiredV1Schema,
	KubernetesReconcileResultV1Schema,
	KubernetesRuntimeCapabilitiesV1Schema,
	validateAgentWorkloadAppliedV1,
	validateAgentWorkloadDesiredV1,
	validateKubernetesReconcileResultV1,
	validateWorkloadCleanupResultV1,
	WorkloadCleanupRequestV1Schema,
	WorkloadCleanupResultV1Schema,
} from "../../src/workload/kubernetes.js";

const runtimeManifest = {
	schemaVersion: 1,
	interactionMode: "platform-adapter",
	protocol: "acp",
	service: { port: 8080 },
	health: { path: "/healthz" },
	capabilities: { connection: true },
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
	namespaceRef: "pilot-namespace",
	desiredState: "running",
	replicas: 1,
	imageDigest: `sha256:${"c".repeat(64)}`,
	runtimeManifest,
	resourceProfileRef: "resource-profile/pilot-standard",
	env: { LOG_LEVEL: "info" },
	service: { name: "agent-01", port: 8080 },
	health: {
		path: "/healthz",
		timeoutSeconds: 5,
		failureThreshold: 3,
	},
	persistentVolume: {
		name: "agent-01-data",
		mountPath: "/workspace",
		storageProfileRef: "storage/pilot-rwo",
		accessMode: "ReadWriteOnce",
		retention: "retain",
	},
	serviceAccount: {
		name: "agent-01",
		kubernetesApiAccess: false,
	},
	networkPolicy: {
		deploymentPolicyRef: "network/pilot",
		ingressMode: "runtime-host-client-only",
		kubernetesApiAccess: false,
		platformDatabaseAccess: false,
		connectionDatabaseAccess: false,
		decryptionKeyringAccess: false,
	},
	route: {
		name: "agent-01",
		exposure: "internal-only",
		tlsRequired: true,
	},
	secretRefs: [secretRef],
} as const;

const applied = {
	schemaVersion: 1,
	requestId: desired.requestId,
	traceId: desired.traceId,
	agentId: desired.agentId,
	configRevision: desired.configRevision,
	workloadRevision: desired.workloadRevision,
	state: "ready",
	imageDigest: desired.imageDigest,
	workloadUid: "workload_uid_01",
	observedGeneration: 4,
	desiredReplicas: 1,
	readyReplicas: 1,
	serviceRef: "service/agent-01",
	serviceAccountRef: "service-account/agent-01",
	persistentVolumeRef: "pvc/agent-01-data",
	networkPolicyRef: "network-policy/agent-01",
	route: { state: "open", routeRef: "route/agent-01" },
	health: { state: "healthy", observedAt: "2026-08-28T10:10:00Z" },
	secretRefs: [secretRef],
	cleanupState: "not-requested",
} as const;

describe("KubernetesRuntimeAdapter V1 contract", () => {
	it("accepts protocol-neutral GA capabilities and rejects legacy/provider objects", () => {
		const capabilities = {
			schemaVersion: 1,
			statefulSetApiVersion: "apps/v1",
			coreApiVersion: "v1",
			networkingApiVersion: "networking.k8s.io/v1",
			routeKind: "deployment-adapter",
			namespaceScoped: true,
		} as const;

		expect(KubernetesRuntimeCapabilitiesV1Schema.parse(capabilities)).toEqual(
			capabilities,
		);
		expect(
			KubernetesRuntimeCapabilitiesV1Schema.safeParse({
				...capabilities,
				networkingApiVersion: "networking.k8s.io/v1beta1",
			}).success,
		).toBe(false);
		expect(
			KubernetesRuntimeCapabilitiesV1Schema.safeParse({
				...capabilities,
				cloudProvider: "provider-specific",
			}).success,
		).toBe(false);
	});

	it("expresses a complete running Workload without exposing Kubernetes objects", () => {
		expect(validateAgentWorkloadDesiredV1(desired)).toEqual(desired);
		expect(
			AgentWorkloadDesiredV1Schema.safeParse({
				...desired,
				route: { ...desired.route, exposure: "self-managed" },
			}).success,
		).toBe(false);
		expect(
			AgentWorkloadDesiredV1Schema.safeParse({
				...desired,
				metadata: { namespace: "must-not-cross-the-port" },
			}).success,
		).toBe(false);
		expect(
			AgentWorkloadDesiredV1Schema.safeParse({
				...desired,
				serviceAccount: {
					...desired.serviceAccount,
					kubernetesApiAccess: true,
				},
			}).success,
		).toBe(false);
		expect(
			AgentWorkloadDesiredV1Schema.safeParse({
				...desired,
				desiredState: "stopped",
				replicas: 1,
			}).success,
		).toBe(false);
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
	])("rejects a mismatched %s before reconciliation", (_name, mismatch) => {
		expect(() =>
			validateAgentWorkloadDesiredV1({ ...desired, ...mismatch }),
		).toThrow("Desired Workload correlation mismatch");
	});

	it("binds each self-managed identity choice to exactly one route policy", () => {
		const selfManaged = {
			...desired,
			runtimeManifest: {
				schemaVersion: 1,
				interactionMode: "self-managed",
				service: { port: 8080 },
				health: { path: "/healthz" },
			},
			route: {
				...desired.route,
				exposure: "platform-auth",
			},
			networkPolicy: {
				...desired.networkPolicy,
				ingressMode: "platform-auth-route",
			},
		} as const;

		expect(AgentWorkloadDesiredV1Schema.parse(selfManaged)).toEqual(
			selfManaged,
		);
		expect(
			AgentWorkloadDesiredV1Schema.safeParse({
				...selfManaged,
				networkPolicy: {
					...selfManaged.networkPolicy,
					ingressMode: "self-managed-route",
				},
			}).success,
		).toBe(false);
	});

	it("rejects stale or mismatched applied state", () => {
		expect(AgentWorkloadAppliedV1Schema.parse(applied)).toEqual(applied);
		expect(
			AgentWorkloadAppliedV1Schema.safeParse({
				...applied,
				readyReplicas: 0,
			}).success,
		).toBe(false);
		expect(validateAgentWorkloadAppliedV1(desired, applied)).toEqual(applied);
		expect(() =>
			validateAgentWorkloadAppliedV1(desired, {
				...applied,
				workloadRevision: desired.workloadRevision - 1,
			}),
		).toThrow("Applied Workload correlation mismatch");
		expect(() =>
			validateAgentWorkloadAppliedV1(desired, {
				...applied,
				secretRefs: [{ ...secretRef, secretVersion: 3 }],
			}),
		).toThrow("Applied Workload correlation mismatch");
	});

	it("represents stale reconciliation without applying an old revision", () => {
		const stale = {
			schemaVersion: 1,
			status: "stale",
			requestId: desired.requestId,
			traceId: desired.traceId,
			agentId: desired.agentId,
			configRevision: desired.configRevision,
			workloadRevision: desired.workloadRevision,
			currentConfigRevision: desired.configRevision + 1,
			currentWorkloadRevision: desired.workloadRevision + 1,
			error: {
				schemaVersion: 1,
				code: "STALE_WORKLOAD_REVISION",
				message: "A newer Workload revision is already current",
				retryable: false,
				traceId: desired.traceId,
			},
		} as const;

		expect(KubernetesReconcileResultV1Schema.parse(stale)).toEqual(stale);
		expect(validateKubernetesReconcileResultV1(desired, stale)).toEqual(stale);
		expect(() =>
			validateKubernetesReconcileResultV1(desired, {
				...stale,
				requestId: "request_workload_02",
			}),
		).toThrow("Kubernetes reconciliation correlation mismatch");
	});

	it("correlates cleanup to the exact Workload revision", () => {
		const request = {
			schemaVersion: 1,
			requestId: "request_cleanup_01",
			traceId: "trace_cleanup_01",
			agentId: desired.agentId,
			configRevision: desired.configRevision,
			workloadRevision: desired.workloadRevision,
			workloadUid: applied.workloadUid,
			deleteNewPersistentVolume: true,
		} as const;
		const result = {
			...request,
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

		expect(WorkloadCleanupRequestV1Schema.parse(request)).toEqual(request);
		expect(WorkloadCleanupResultV1Schema.parse(result)).toEqual(result);
		expect(validateWorkloadCleanupResultV1(request, result)).toEqual(result);
		expect(() =>
			validateWorkloadCleanupResultV1(request, {
				...result,
				workloadUid: "workload_uid_02",
			}),
		).toThrow("Workload cleanup correlation mismatch");
		expect(
			WorkloadCleanupResultV1Schema.safeParse({
				...result,
				providerOperationId: "must-not-cross-the-port",
			}).success,
		).toBe(false);
	});
});
