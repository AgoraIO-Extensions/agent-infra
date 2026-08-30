import { describe, expect, it } from "vitest";

import {
	validateWorkerWorkloadResultV1,
	WorkerWorkloadExpectedRevisionV1Schema,
	WorkerWorkloadResultV1Schema,
} from "../../src/workload/worker-result.js";

const workerCorrelation = {
	schemaVersion: 1,
	outboxItemId: "outbox_01",
	requestId: "request_workload_01",
	traceId: "trace_worker_01",
	agentId: "agent_01",
	configRevision: 7,
	workloadRevision: 9,
	fence: 11,
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
		policyRef: "policy_01",
		decisionRef: "decision_01",
		subjectRef: "subject_01",
		agentId: workerCorrelation.agentId,
		imageDigest,
		evaluatedAt: "2026-08-28T10:00:00Z",
	},
} as const;

const secretRef = {
	schemaVersion: 1,
	ownerType: "agent-owner",
	ownerId: "owner_01",
	agentId: workerCorrelation.agentId,
	secretId: "secret_01",
	secretVersion: 2,
	configRevision: workerCorrelation.configRevision,
	algorithmVersion: "aes-256-gcm:v1",
	wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
	wrappingKeyVersion: "wrapping-key-v1",
	name: "agent-01-secret-01-v2-r7",
} as const;

const desiredWorkload = {
	schemaVersion: 1,
	requestId: workerCorrelation.requestId,
	traceId: workerCorrelation.traceId,
	agentId: workerCorrelation.agentId,
	configRevision: workerCorrelation.configRevision,
	workloadRevision: workerCorrelation.workloadRevision,
	fence: workerCorrelation.fence,
	expectedWorkload: { state: "absent" },
	namespaceRef: "pilot-namespace",
	desiredState: "running",
	replicas: 1,
	imageDigest,
	registryAdmission,
	runtimeManifest,
	resourceProfileRef: "resource-profile_01",
	env: { LOG_LEVEL: "info" },
	service: { name: "agent-01", port: 8080 },
	health: {
		path: "/healthz",
		timeoutSeconds: 5,
		failureThreshold: 3,
	},
	route: {
		name: "agent-01",
		exposure: "internal-only",
		tlsRequired: true,
	},
	persistentVolume: {
		name: "agent-01-data",
		mountPath: "/workspace",
		storageProfileRef: "storage-profile_01",
		accessMode: "ReadWriteOnce",
		retention: "retain",
	},
	serviceAccount: {
		name: "agent-01",
		kubernetesApiAccess: false,
	},
	networkPolicy: {
		deploymentPolicyRef: "deployment-policy_01",
		ingressMode: "runtime-host-client-only",
		kubernetesApiAccess: false,
		platformDatabaseAccess: false,
		connectionDatabaseAccess: false,
		decryptionKeyringAccess: false,
	},
	secretRefs: [secretRef],
} as const;

const reconcileResultCorrelation = {
	...workerCorrelation,
	operation: "reconcile-workload",
	expectedWorkload: desiredWorkload.expectedWorkload,
} as const;

const expected = {
	...workerCorrelation,
	operation: "reconcile-workload",
	desiredWorkload,
} as const;

const appliedWorkload = {
	schemaVersion: 1,
	requestId: desiredWorkload.requestId,
	traceId: desiredWorkload.traceId,
	agentId: desiredWorkload.agentId,
	configRevision: desiredWorkload.configRevision,
	workloadRevision: desiredWorkload.workloadRevision,
	fence: desiredWorkload.fence,
	state: "ready",
	imageDigest: desiredWorkload.imageDigest,
	workloadUid: "workload_uid_01",
	observedGeneration: 4,
	resourceProfileRef: desiredWorkload.resourceProfileRef,
	service: desiredWorkload.service,
	healthCheck: desiredWorkload.health,
	routeIntent: desiredWorkload.route,
	persistentVolume: desiredWorkload.persistentVolume,
	serviceAccount: desiredWorkload.serviceAccount,
	networkPolicy: desiredWorkload.networkPolicy,
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
		workloadRevision: desiredWorkload.workloadRevision,
	},
	health: { state: "healthy", observedAt: "2026-08-28T10:10:00Z" },
	secretRefs: [secretRef],
	cleanupState: "not-requested",
} as const;

const kubernetesAppliedOutcome = {
	schemaVersion: 1,
	requestId: desiredWorkload.requestId,
	traceId: desiredWorkload.traceId,
	agentId: desiredWorkload.agentId,
	configRevision: desiredWorkload.configRevision,
	workloadRevision: desiredWorkload.workloadRevision,
	fence: desiredWorkload.fence,
	status: "applied",
	workloadUid: appliedWorkload.workloadUid,
	workloadGeneration: appliedWorkload.observedGeneration,
	applied: appliedWorkload,
} as const;

describe("Worker Workload result V1 contract", () => {
	it("accepts a result correlated to the exact outbox fence and revisions", () => {
		const result = {
			...reconcileResultCorrelation,
			workloadUid: appliedWorkload.workloadUid,
			workloadGeneration: appliedWorkload.observedGeneration,
			status: "succeeded",
			operation: "reconcile-workload",
			outcome: kubernetesAppliedOutcome,
		} as const;

		expect(WorkerWorkloadExpectedRevisionV1Schema.parse(expected)).toEqual(
			expected,
		);
		expect(WorkerWorkloadResultV1Schema.parse(result)).toEqual(result);
		expect(validateWorkerWorkloadResultV1(expected, result)).toEqual(result);
	});

	it("rejects stale or mismatched Worker results before writeback", () => {
		const stale = {
			...reconcileResultCorrelation,
			status: "stale",
			operation: "reconcile-workload",
			currentConfigRevision: 8,
			currentWorkloadRevision: 10,
			error: {
				schemaVersion: 1,
				code: "WORKER_RESULT_STALE",
				message: "The Worker result is stale",
				retryable: false,
				traceId: expected.traceId,
			},
		} as const;

		expect(WorkerWorkloadResultV1Schema.parse(stale)).toEqual(stale);
		expect(() =>
			validateWorkerWorkloadResultV1(expected, {
				...stale,
				fence: expected.fence - 1,
			}),
		).toThrow("Worker result revision correlation mismatch");
		expect(() =>
			validateWorkerWorkloadResultV1(expected, {
				...stale,
				agentId: "agent_02",
			}),
		).toThrow("Worker result revision correlation mismatch");
		expect(() =>
			validateWorkerWorkloadResultV1(expected, {
				...stale,
				currentConfigRevision: expected.configRevision,
				currentWorkloadRevision: expected.workloadRevision,
			}),
		).toThrow("Worker result revision correlation mismatch");
		expect(() =>
			validateWorkerWorkloadResultV1(expected, {
				...stale,
				error: { ...stale.error, traceId: "trace_other" },
			}),
		).toThrow("Worker result revision correlation mismatch");
		expect(() =>
			validateWorkerWorkloadResultV1(expected, {
				...stale,
				requestId: "request_workload_02",
			}),
		).toThrow("Worker result revision correlation mismatch");
		expect(() =>
			validateWorkerWorkloadResultV1(
				{
					...expected,
					desiredWorkload: {
						...desiredWorkload,
						fence: expected.fence + 1,
					},
				},
				stale,
			),
		).toThrow("Worker result revision correlation mismatch");
	});

	it("rejects inconsistent outer and nested Workload UIDs on first reconciliation", () => {
		const result = {
			...reconcileResultCorrelation,
			workloadUid: "workload_uid_02",
			workloadGeneration: appliedWorkload.observedGeneration,
			status: "succeeded",
			operation: "reconcile-workload",
			outcome: kubernetesAppliedOutcome,
		} as const;

		expect(WorkerWorkloadResultV1Schema.parse(result)).toEqual(result);
		expect(() => validateWorkerWorkloadResultV1(expected, result)).toThrow(
			"Worker result revision correlation mismatch",
		);
		expect(() =>
			validateWorkerWorkloadResultV1(expected, {
				...result,
				workloadUid: appliedWorkload.workloadUid,
				workloadGeneration: appliedWorkload.observedGeneration + 1,
			}),
		).toThrow("Worker result revision correlation mismatch");
		expect(() =>
			validateWorkerWorkloadResultV1(expected, {
				...result,
				workloadUid: undefined,
			}),
		).toThrow("Worker result revision correlation mismatch");
		expect(() =>
			validateWorkerWorkloadResultV1(expected, {
				...result,
				workloadUid: appliedWorkload.workloadUid,
				workloadGeneration: appliedWorkload.observedGeneration,
				outcome: {
					...kubernetesAppliedOutcome,
					requestId: "request_workload_02",
				},
			}),
		).toThrow("Kubernetes reconciliation correlation mismatch");
		expect(() =>
			validateWorkerWorkloadResultV1(expected, {
				...result,
				workloadUid: appliedWorkload.workloadUid,
				workloadGeneration: appliedWorkload.observedGeneration,
				outcome: {
					...kubernetesAppliedOutcome,
					applied: { ...appliedWorkload, fence: expected.fence - 1 },
				},
			}),
		).toThrow("Applied Workload correlation mismatch");
		expect(() =>
			validateWorkerWorkloadResultV1(expected, {
				...result,
				workloadUid: appliedWorkload.workloadUid,
				outcome: {
					...kubernetesAppliedOutcome,
					applied: {
						...appliedWorkload,
						service: { ...appliedWorkload.service, port: 9090 },
					},
				},
			}),
		).toThrow("Applied Workload correlation mismatch");
	});

	it("requires an existing Workload precondition to match the applied result", () => {
		const expectedWorkload = {
			state: "present",
			workloadUid: appliedWorkload.workloadUid,
			workloadGeneration: appliedWorkload.observedGeneration + 1,
		} as const;
		const expectedUpdate = {
			...expected,
			desiredWorkload: {
				...desiredWorkload,
				expectedWorkload,
			},
		} as const;
		const result = {
			...reconcileResultCorrelation,
			expectedWorkload,
			workloadUid: appliedWorkload.workloadUid,
			workloadGeneration: appliedWorkload.observedGeneration,
			status: "succeeded",
			operation: "reconcile-workload",
			outcome: kubernetesAppliedOutcome,
		} as const;

		expect(() =>
			validateWorkerWorkloadResultV1(expectedUpdate, result),
		).toThrow("Applied Workload correlation mismatch");
	});

	it("preserves fixed repairable Kubernetes apply and health failures", () => {
		const outcome = {
			schemaVersion: 1,
			status: "failed",
			requestId: desiredWorkload.requestId,
			traceId: desiredWorkload.traceId,
			agentId: desiredWorkload.agentId,
			configRevision: desiredWorkload.configRevision,
			workloadRevision: desiredWorkload.workloadRevision,
			fence: desiredWorkload.fence,
			error: {
				schemaVersion: 1,
				code: "KUBERNETES_HEALTH_CHECK_FAILED",
				message: "Kubernetes Workload failed its health check",
				retryable: true,
				traceId: desiredWorkload.traceId,
			},
		} as const;
		const result = {
			...reconcileResultCorrelation,
			status: "succeeded",
			outcome,
		} as const;

		expect(WorkerWorkloadResultV1Schema.parse(result)).toEqual(result);
		expect(validateWorkerWorkloadResultV1(expected, result)).toEqual(result);
		expect(
			WorkerWorkloadResultV1Schema.safeParse({
				...result,
				outcome: {
					...outcome,
					error: {
						...outcome.error,
						message: "pod agent-01 leaked provider failure details",
					},
				},
			}).success,
		).toBe(false);
		expect(() =>
			validateWorkerWorkloadResultV1(expected, {
				...result,
				workloadUid: appliedWorkload.workloadUid,
				workloadGeneration: appliedWorkload.observedGeneration,
			}),
		).toThrow("Worker result revision correlation mismatch");
	});

	it("rejects raw provider or Kubernetes failure details", () => {
		const failed = {
			...reconcileResultCorrelation,
			status: "failed",
			operation: "reconcile-workload",
			error: {
				schemaVersion: 1,
				code: "WORKER_REQUEST_FAILED",
				message: "The Worker request failed",
				retryable: true,
				traceId: expected.traceId,
			},
		} as const;

		expect(WorkerWorkloadResultV1Schema.parse(failed)).toEqual(failed);
		expect(
			WorkerWorkloadResultV1Schema.safeParse({
				...failed,
				providerResponse: { kind: "StatefulSet", metadata: {} },
			}).success,
		).toBe(false);
		expect(
			WorkerWorkloadResultV1Schema.safeParse({
				...failed,
				error: {
					...failed.error,
					message: "Kubernetes returned bearer super-secret-token",
				},
			}).success,
		).toBe(false);
		expect(
			WorkerWorkloadResultV1Schema.safeParse({
				...failed,
				error: { ...failed.error, code: "PROVIDER_SPECIFIC_FAILURE" },
			}).success,
		).toBe(false);
		expect(
			WorkerWorkloadResultV1Schema.safeParse({
				...failed,
				schemaVersion: 2,
			}).success,
		).toBe(false);
		expect(
			WorkerWorkloadResultV1Schema.safeParse({
				...failed,
				fence: undefined,
			}).success,
		).toBe(false);
		expect(
			WorkerWorkloadResultV1Schema.safeParse({
				...failed,
				requestId: undefined,
			}).success,
		).toBe(false);
		const rejected = {
			...reconcileResultCorrelation,
			status: "rejected",
			operation: "reconcile-workload",
			error: {
				schemaVersion: 1,
				code: "WORKER_REQUEST_REJECTED",
				message: "The Worker request was rejected",
				retryable: false,
				traceId: expected.traceId,
			},
		} as const;
		expect(WorkerWorkloadResultV1Schema.parse(rejected)).toEqual(rejected);
		expect(
			WorkerWorkloadResultV1Schema.safeParse({
				...rejected,
				error: { ...rejected.error, retryable: true },
			}).success,
		).toBe(false);
		expect(() =>
			validateWorkerWorkloadResultV1(expected, {
				...workerCorrelation,
				status: "failed",
				operation: "cleanup-workload",
				workloadUid: appliedWorkload.workloadUid,
				workloadGeneration: appliedWorkload.observedGeneration,
				persistentVolumeIntent: "retain-existing",
				error: failed.error,
			}),
		).toThrow("Worker result revision correlation mismatch");
	});

	it("rejects mismatched nested cleanup facts", () => {
		const cleanupExpected = {
			...workerCorrelation,
			requestId: "request_cleanup_01",
			operation: "cleanup-workload",
			workloadUid: "workload_uid_01",
			workloadGeneration: appliedWorkload.observedGeneration,
			persistentVolumeIntent: "delete-new",
		} as const;
		const cleanupResult = {
			...cleanupExpected,
			status: "succeeded",
			operation: "cleanup-workload",
			outcome: {
				schemaVersion: 1,
				status: "completed",
				requestId: cleanupExpected.requestId,
				traceId: expected.traceId,
				agentId: expected.agentId,
				configRevision: expected.configRevision,
				workloadRevision: expected.workloadRevision - 1,
				workloadUid: "workload_uid_02",
				workloadGeneration: cleanupExpected.workloadGeneration,
				fence: expected.fence,
				persistentVolumeIntent: "delete-new",
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
			},
		} as const;

		expect(() =>
			validateWorkerWorkloadResultV1(cleanupExpected, cleanupResult),
		).toThrow("Workload cleanup correlation mismatch");

		const correlated = {
			...cleanupResult,
			outcome: {
				...cleanupResult.outcome,
				workloadRevision: cleanupExpected.workloadRevision,
				workloadUid: cleanupExpected.workloadUid,
			},
		} as const;
		expect(validateWorkerWorkloadResultV1(cleanupExpected, correlated)).toEqual(
			correlated,
		);
		expect(() =>
			validateWorkerWorkloadResultV1(cleanupExpected, {
				...correlated,
				outcome: {
					...correlated.outcome,
					requestId: "request_cleanup_02",
				},
			}),
		).toThrow("Workload cleanup correlation mismatch");
		expect(() =>
			validateWorkerWorkloadResultV1(
				{ ...cleanupExpected, persistentVolumeIntent: "retain-existing" },
				{ ...correlated, persistentVolumeIntent: "retain-existing" },
			),
		).toThrow("Workload cleanup correlation mismatch");
	});

	it("binds Registry outcomes to the exact admission request", () => {
		const admissionExpected = {
			...workerCorrelation,
			requestId: "registry_request_01",
			operation: "admit-image",
			registrySubjectRef: "subject_01",
			imageReference: "registry.example/agent:v1",
			usage: "custom-agent",
			admissionPolicyRef: "policy_01",
		} as const;
		const outcome = {
			schemaVersion: 1,
			requestId: admissionExpected.requestId,
			traceId: admissionExpected.traceId,
			status: "rejected",
			error: {
				schemaVersion: 1,
				code: "IMAGE_NOT_ADMITTED",
				message: "The image is not admitted by deployment policy",
				retryable: false,
				traceId: admissionExpected.traceId,
			},
		} as const;
		const result = {
			...admissionExpected,
			status: "succeeded",
			operation: "admit-image",
			outcome,
		} as const;

		expect(validateWorkerWorkloadResultV1(admissionExpected, result)).toEqual(
			result,
		);
		expect(
			WorkerWorkloadExpectedRevisionV1Schema.safeParse({
				...admissionExpected,
				imageReference: "registry.example/Agent With Spaces:v1",
			}).success,
		).toBe(false);
		expect(() =>
			validateWorkerWorkloadResultV1(admissionExpected, {
				...result,
				outcome: { ...outcome, requestId: "registry_request_02" },
			}),
		).toThrow("Image registry result correlation mismatch");
		expect(() =>
			validateWorkerWorkloadResultV1(admissionExpected, {
				...result,
				outcome: {
					...outcome,
					error: { ...outcome.error, traceId: "trace_other" },
				},
			}),
		).toThrow("Image registry result correlation mismatch");
	});

	it("requires full Secret and Workload context on failed activation results", () => {
		const activationExpected = {
			...workerCorrelation,
			requestId: "request_secret_01",
			operation: "activate-secret",
			secretId: "secret_01",
			secretVersion: 2,
			kubernetesSecretName: "agent-01-secret-01-v2-r7",
			workloadUid: "workload_uid_01",
			workloadGeneration: 4,
		} as const;
		const incompleteFailure = {
			schemaVersion: 1,
			outboxItemId: activationExpected.outboxItemId,
			requestId: activationExpected.requestId,
			traceId: activationExpected.traceId,
			agentId: activationExpected.agentId,
			configRevision: activationExpected.configRevision,
			workloadRevision: activationExpected.workloadRevision,
			fence: activationExpected.fence,
			status: "failed",
			operation: "activate-secret",
			error: {
				schemaVersion: 1,
				code: "WORKER_REQUEST_FAILED",
				message: "The Worker request failed",
				retryable: true,
				traceId: activationExpected.traceId,
			},
		} as const;

		expect(
			WorkerWorkloadResultV1Schema.safeParse(incompleteFailure).success,
		).toBe(false);
		const completeFailure = {
			...incompleteFailure,
			secretId: activationExpected.secretId,
			secretVersion: activationExpected.secretVersion,
			kubernetesSecretName: activationExpected.kubernetesSecretName,
			workloadUid: activationExpected.workloadUid,
			workloadGeneration: activationExpected.workloadGeneration,
		} as const;
		expect(WorkerWorkloadResultV1Schema.parse(completeFailure)).toEqual(
			completeFailure,
		);
		expect(
			validateWorkerWorkloadResultV1(activationExpected, completeFailure),
		).toEqual(completeFailure);
	});

	it("rejects a Secret observation reference outside the activation fence", () => {
		const activationExpected = {
			...workerCorrelation,
			operation: "activate-secret",
			secretId: "secret_01",
			secretVersion: 2,
			kubernetesSecretName: "agent-01-secret-01-v2-r7",
			workloadUid: "workload_uid_01",
			workloadGeneration: 4,
		} as const;
		const activationFence = {
			schemaVersion: 1,
			agentId: activationExpected.agentId,
			secretId: activationExpected.secretId,
			secretVersion: activationExpected.secretVersion,
			configRevision: activationExpected.configRevision,
			kubernetesSecretName: activationExpected.kubernetesSecretName,
			workloadUid: activationExpected.workloadUid,
			workloadGeneration: activationExpected.workloadGeneration,
			fence: activationExpected.fence,
		} as const;
		const result = {
			...activationExpected,
			status: "succeeded",
			operation: "activate-secret",
			outcome: {
				schemaVersion: 1,
				status: "observed",
				kubernetesSecretRef: {
					...secretRef,
					agentId: "agent_02",
				},
				activationFence,
				health: "healthy",
			},
		} as const;

		expect(WorkerWorkloadResultV1Schema.parse(result)).toEqual(result);
		expect(() =>
			validateWorkerWorkloadResultV1(activationExpected, result),
		).toThrow("Secret activation fence mismatch");
	});
});
