import { describe, expect, it } from "vitest";

import {
	AgentWorkloadAppliedV1Schema,
	AgentWorkloadDesiredV1Schema,
	KubernetesBoundaryErrorV1Schema,
	KubernetesReconcileResultV1Schema,
	KubernetesRuntimeCapabilitiesV1Schema,
	validateAgentWorkloadAppliedV1,
	validateAgentWorkloadDesiredV1,
	validateKubernetesReconcileResultV1,
	validateWorkloadCleanupResultV1,
	validateWorkloadRouteSwitchRequestV1,
	validateWorkloadRouteSwitchResultV1,
	WorkloadCleanupRequestV1Schema,
	WorkloadCleanupResultV1Schema,
	WorkloadRouteSwitchRequestV1Schema,
	WorkloadRouteSwitchResultV1Schema,
} from "../../src/workload/kubernetes.js";

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
		connection: true,
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
		const { expectedWorkload: _expectedWorkload, ...withoutExpectation } =
			desired;
		expect(
			AgentWorkloadDesiredV1Schema.safeParse(withoutExpectation).success,
		).toBe(false);
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
		[
			"Registry digest",
			{
				registryAdmission: {
					...registryAdmission,
					immutableDigest: `sha256:${"d".repeat(64)}`,
				},
			},
		],
		[
			"Registry policy Agent",
			{
				registryAdmission: {
					...registryAdmission,
					policyEvidence: {
						...registryAdmission.policyEvidence,
						agentId: "agent_02",
					},
				},
			},
		],
		[
			"Registry Runtime Manifest",
			{
				registryAdmission: {
					...registryAdmission,
					runtimeManifest: {
						...runtimeManifest,
						service: { port: 9090 },
					},
				},
			},
		],
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
		const selfManagedManifest = {
			schemaVersion: 1,
			interactionMode: "self-managed",
			service: { port: 8080 },
			health: { path: "/healthz" },
		} as const;
		const selfManaged = {
			...desired,
			registryAdmission: {
				...registryAdmission,
				runtimeManifest: selfManagedManifest,
			},
			runtimeManifest: selfManagedManifest,
			route: {
				...desired.route,
				exposure: "platform-auth",
			},
			networkPolicy: {
				...desired.networkPolicy,
				ingressMode: "platform-auth-route",
			},
		} as const;

		expect(validateAgentWorkloadDesiredV1(selfManaged)).toEqual(selfManaged);
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
		expect(() =>
			validateAgentWorkloadAppliedV1(desired, {
				...applied,
				fence: desired.fence - 1,
			}),
		).toThrow("Applied Workload correlation mismatch");
		expect(() =>
			validateAgentWorkloadAppliedV1(desired, {
				...applied,
				service: { ...applied.service, port: 9090 },
			}),
		).toThrow("Applied Workload correlation mismatch");
		expect(() =>
			validateAgentWorkloadAppliedV1(desired, {
				...applied,
				persistentVolume: {
					...applied.persistentVolume,
					storageProfileRef: "storage/other",
				},
			}),
		).toThrow("Applied Workload correlation mismatch");
		expect(() =>
			validateAgentWorkloadAppliedV1(desired, {
				...applied,
				serviceAccount: {
					...applied.serviceAccount,
					name: "agent-other",
				},
			}),
		).toThrow("Applied Workload correlation mismatch");
		expect(() =>
			validateAgentWorkloadAppliedV1(desired, {
				...applied,
				networkPolicy: {
					...applied.networkPolicy,
					deploymentPolicyRef: "network/other",
				},
			}),
		).toThrow("Applied Workload correlation mismatch");
		expect(() =>
			validateAgentWorkloadAppliedV1(desired, {
				...applied,
				routeIntent: { ...applied.routeIntent, name: "agent-other" },
			}),
		).toThrow("Applied Workload correlation mismatch");
		expect(() =>
			validateAgentWorkloadAppliedV1(desired, {
				...applied,
				route: { ...applied.route, workloadUid: "workload_uid_02" },
			}),
		).toThrow("Applied Workload correlation mismatch");
		expect(
			AgentWorkloadAppliedV1Schema.safeParse({
				...applied,
				state: "degraded",
				readyReplicas: 0,
				health: {
					state: "unhealthy",
					observedAt: "2026-08-28T10:10:00Z",
				},
			}).success,
		).toBe(false);
		expect(() =>
			validateAgentWorkloadAppliedV1(
				{
					...desired,
					expectedWorkload: {
						state: "present",
						workloadUid: applied.workloadUid,
						workloadGeneration: applied.observedGeneration + 1,
					},
				},
				applied,
			),
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
			fence: desired.fence,
			currentConfigRevision: desired.configRevision + 1,
			currentWorkloadRevision: desired.workloadRevision + 1,
			error: {
				schemaVersion: 1,
				code: "KUBERNETES_STALE_REVISION",
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
		expect(() =>
			validateKubernetesReconcileResultV1(desired, {
				...stale,
				currentConfigRevision: desired.configRevision,
				currentWorkloadRevision: desired.workloadRevision,
			}),
		).toThrow("Kubernetes reconciliation correlation mismatch");
		expect(() =>
			validateKubernetesReconcileResultV1(desired, {
				...stale,
				error: { ...stale.error, traceId: "trace_other" },
			}),
		).toThrow("Kubernetes reconciliation correlation mismatch");
	});

	it("accepts only fixed sanitized Kubernetes errors", () => {
		const error = {
			schemaVersion: 1,
			code: "KUBERNETES_APPLY_INCOMPLETE",
			message: "Kubernetes Workload did not fully converge",
			retryable: true,
			traceId: desired.traceId,
		} as const;

		expect(KubernetesBoundaryErrorV1Schema.parse(error)).toEqual(error);
		expect(
			KubernetesBoundaryErrorV1Schema.safeParse({
				...error,
				message: "pods agent-01-token-raw failed: provider detail",
			}).success,
		).toBe(false);
		expect(
			KubernetesBoundaryErrorV1Schema.safeParse({
				...error,
				code: "PROVIDER_ERROR",
			}).success,
		).toBe(false);
	});

	it("binds an applied reconciliation envelope to its nested Workload", () => {
		const result = {
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

		expect(validateKubernetesReconcileResultV1(desired, result)).toEqual(
			result,
		);
		expect(() =>
			validateKubernetesReconcileResultV1(desired, {
				...result,
				workloadGeneration: result.workloadGeneration + 1,
			}),
		).toThrow("Kubernetes reconciliation correlation mismatch");
	});

	it("promotes or rolls back exactly one validated route target", () => {
		const previousRoute = {
			routeRef: "route/agent-01",
			workloadUid: "workload_uid_01",
			workloadRevision: 8,
			workloadGeneration: 3,
		} as const;
		const candidateRoute = {
			...previousRoute,
			workloadRevision: desired.workloadRevision,
			workloadGeneration: applied.observedGeneration,
		} as const;
		const promote = {
			schemaVersion: 1,
			requestId: "request_route_01",
			traceId: desired.traceId,
			agentId: desired.agentId,
			fence: desired.fence,
			action: "promote",
			previousRoute,
			candidateRoute,
			candidateValidated: true,
		} as const;
		const promoted = {
			schemaVersion: 1,
			requestId: promote.requestId,
			traceId: promote.traceId,
			agentId: promote.agentId,
			fence: promote.fence,
			action: promote.action,
			status: "completed",
			routedWorkloads: [candidateRoute],
		} as const;

		expect(validateWorkloadRouteSwitchRequestV1(promote)).toEqual(promote);
		expect(validateWorkloadRouteSwitchResultV1(promote, promoted)).toEqual(
			promoted,
		);
		expect(
			WorkloadRouteSwitchRequestV1Schema.safeParse({
				...promote,
				candidateValidated: false,
			}).success,
		).toBe(false);
		expect(
			WorkloadRouteSwitchResultV1Schema.safeParse({
				...promoted,
				routedWorkloads: [previousRoute, candidateRoute],
			}).success,
		).toBe(false);
		expect(
			WorkloadRouteSwitchResultV1Schema.safeParse({
				...promoted,
				routedWorkloads: [],
			}).success,
		).toBe(false);

		const failedPromotion = {
			...promoted,
			status: "failed",
			routedWorkloads: [candidateRoute],
			error: {
				schemaVersion: 1,
				code: "KUBERNETES_ROUTE_SWITCH_FAILED",
				message: "Kubernetes route switch did not converge",
				retryable: true,
				traceId: promote.traceId,
			},
		} as const;
		expect(() =>
			validateWorkloadRouteSwitchResultV1(promote, failedPromotion),
		).toThrow("Kubernetes route switch correlation mismatch");
		expect(() =>
			validateWorkloadRouteSwitchResultV1(promote, {
				...failedPromotion,
				routedWorkloads: [
					{ ...candidateRoute, workloadUid: "workload_uid_other" },
				],
			}),
		).toThrow("Kubernetes route switch correlation mismatch");

		const rollback = {
			...promote,
			requestId: "request_route_02",
			action: "rollback",
		} as const;
		const { candidateValidated: _candidateValidated, ...rollbackRequest } =
			rollback;
		const rolledBack = {
			...promoted,
			requestId: rollbackRequest.requestId,
			action: rollbackRequest.action,
			routedWorkloads: [previousRoute],
		} as const;
		expect(
			validateWorkloadRouteSwitchResultV1(rollbackRequest, rolledBack),
		).toEqual(rolledBack);
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
			workloadGeneration: applied.observedGeneration,
			fence: desired.fence,
			persistentVolumeIntent: "delete-new",
		} as const;
		const result = {
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
		expect(
			WorkloadCleanupResultV1Schema.safeParse({
				...result,
				removed: { ...result.removed, service: false },
			}).success,
		).toBe(false);
		const closingRoute = {
			...request,
			status: "in-progress",
			phase: "closing-route",
			routeClosed: false,
			removed: {
				route: false,
				workload: false,
				service: false,
				serviceAccount: false,
				networkPolicy: false,
				configuration: false,
				secrets: false,
				persistentVolume: false,
			},
		} as const;
		expect(validateWorkloadCleanupResultV1(request, closingRoute)).toEqual(
			closingRoute,
		);
		expect(
			WorkloadCleanupResultV1Schema.safeParse({
				...closingRoute,
				removed: { ...closingRoute.removed, workload: true },
			}).success,
		).toBe(false);

		const retainRequest = {
			...request,
			persistentVolumeIntent: "retain-existing",
		} as const;
		expect(() =>
			validateWorkloadCleanupResultV1(retainRequest, {
				...closingRoute,
				persistentVolumeIntent: "retain-existing",
				phase: "removing-resources",
				routeClosed: true,
				removed: { ...closingRoute.removed, persistentVolume: true },
			}),
		).toThrow("Workload cleanup correlation mismatch");
	});
});
