import { describe, expect, it } from "vitest";

import {
	validateWorkerWorkloadResultV1,
	WorkerWorkloadExpectedRevisionV1Schema,
	WorkerWorkloadResultV1Schema,
} from "../../src/workload/worker-result.js";

const expected = {
	schemaVersion: 1,
	outboxItemId: "outbox_01",
	traceId: "trace_worker_01",
	agentId: "agent_01",
	configRevision: 7,
	workloadRevision: 9,
	fence: 11,
	operation: "reconcile-workload",
} as const;

const secretRef = {
	schemaVersion: 1,
	agentId: expected.agentId,
	secretId: "secret_01",
	secretVersion: 2,
	configRevision: expected.configRevision,
	name: "agent-01-secret-01-v2-r7",
} as const;

const appliedWorkload = {
	schemaVersion: 1,
	requestId: "request_workload_01",
	traceId: expected.traceId,
	agentId: expected.agentId,
	configRevision: expected.configRevision,
	workloadRevision: expected.workloadRevision,
	fence: expected.fence,
	state: "ready",
	imageDigest: `sha256:${"c".repeat(64)}`,
	workloadUid: "workload_uid_01",
	observedGeneration: 4,
	service: { name: "agent-01", port: 8080 },
	healthCheck: {
		path: "/healthz",
		timeoutSeconds: 5,
		failureThreshold: 3,
	},
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
		workloadRevision: expected.workloadRevision,
	},
	health: { state: "healthy", observedAt: "2026-08-28T10:10:00Z" },
	secretRefs: [secretRef],
	cleanupState: "not-requested",
} as const;

describe("Worker Workload result V1 contract", () => {
	it("accepts a result correlated to the exact outbox fence and revisions", () => {
		const result = {
			...expected,
			workloadUid: appliedWorkload.workloadUid,
			workloadGeneration: appliedWorkload.observedGeneration,
			status: "succeeded",
			operation: "reconcile-workload",
			outcome: appliedWorkload,
		} as const;

		expect(WorkerWorkloadExpectedRevisionV1Schema.parse(expected)).toEqual(
			expected,
		);
		expect(WorkerWorkloadResultV1Schema.parse(result)).toEqual(result);
		expect(validateWorkerWorkloadResultV1(expected, result)).toEqual(result);
	});

	it("rejects stale or mismatched Worker results before writeback", () => {
		const stale = {
			...expected,
			status: "stale",
			operation: "reconcile-workload",
			currentConfigRevision: 8,
			currentWorkloadRevision: 10,
			error: {
				schemaVersion: 1,
				code: "STALE_WORKLOAD_REVISION",
				message: "The Workload revision is stale",
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
	});

	it("rejects inconsistent outer and nested Workload UIDs on first reconciliation", () => {
		const result = {
			...expected,
			workloadUid: "workload_uid_02",
			workloadGeneration: appliedWorkload.observedGeneration,
			status: "succeeded",
			operation: "reconcile-workload",
			outcome: appliedWorkload,
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
				workloadUid: appliedWorkload.workloadUid,
				workloadGeneration: appliedWorkload.observedGeneration,
				outcome: { ...appliedWorkload, fence: expected.fence - 1 },
			}),
		).toThrow("Worker result revision correlation mismatch");
	});

	it("requires an existing Workload precondition to match the applied result", () => {
		const expectedUpdate = {
			...expected,
			expectedWorkload: {
				workloadUid: appliedWorkload.workloadUid,
				workloadGeneration: appliedWorkload.observedGeneration + 1,
			},
		} as const;
		const result = {
			...expectedUpdate,
			workloadUid: appliedWorkload.workloadUid,
			workloadGeneration: appliedWorkload.observedGeneration,
			status: "succeeded",
			operation: "reconcile-workload",
			outcome: appliedWorkload,
		} as const;

		expect(() =>
			validateWorkerWorkloadResultV1(expectedUpdate, result),
		).toThrow("Worker result revision correlation mismatch");
	});

	it("rejects raw provider or Kubernetes failure details", () => {
		const failed = {
			...expected,
			status: "failed",
			operation: "reconcile-workload",
			error: {
				schemaVersion: 1,
				code: "WORKLOAD_APPLY_FAILED",
				message: "The Workload could not be applied",
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
				schemaVersion: 2,
			}).success,
		).toBe(false);
		expect(
			WorkerWorkloadResultV1Schema.safeParse({
				...failed,
				fence: undefined,
			}).success,
		).toBe(false);
		expect(() =>
			validateWorkerWorkloadResultV1(expected, {
				...failed,
				operation: "cleanup-workload",
				workloadUid: appliedWorkload.workloadUid,
				workloadGeneration: appliedWorkload.observedGeneration,
			}),
		).toThrow("Worker result revision correlation mismatch");
	});

	it("rejects a nested cleanup outcome for another Workload revision", () => {
		const cleanupExpected = {
			...expected,
			operation: "cleanup-workload",
			workloadUid: "workload_uid_01",
			workloadGeneration: appliedWorkload.observedGeneration,
		} as const;
		const cleanupResult = {
			...cleanupExpected,
			status: "succeeded",
			operation: "cleanup-workload",
			outcome: {
				schemaVersion: 1,
				status: "completed",
				requestId: "request_cleanup_01",
				traceId: expected.traceId,
				agentId: expected.agentId,
				configRevision: expected.configRevision,
				workloadRevision: expected.workloadRevision - 1,
				workloadUid: "workload_uid_02",
				workloadGeneration: cleanupExpected.workloadGeneration,
				fence: expected.fence,
				deleteNewPersistentVolume: true,
				deleted: {
					workload: true,
					service: true,
					serviceAccount: true,
					networkPolicy: true,
					route: true,
					secrets: true,
					persistentVolume: true,
				},
			},
		} as const;

		expect(() =>
			validateWorkerWorkloadResultV1(cleanupExpected, cleanupResult),
		).toThrow("Worker result revision correlation mismatch");
	});

	it("binds Registry outcomes to the exact admission request", () => {
		const admissionExpected = {
			...expected,
			operation: "admit-image",
			registryRequestId: "registry_request_01",
			registrySubjectRef: "subject_01",
			imageReference: "registry.example/agent:v1",
			usage: "custom-agent",
			admissionPolicyRef: "policy_01",
		} as const;
		const outcome = {
			schemaVersion: 1,
			requestId: admissionExpected.registryRequestId,
			traceId: admissionExpected.traceId,
			imageReference: admissionExpected.imageReference,
			status: "rejected",
			error: {
				schemaVersion: 1,
				code: "IMAGE_POLICY_REJECTED",
				message: "The image policy rejected the image",
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
		expect(() =>
			validateWorkerWorkloadResultV1(admissionExpected, {
				...result,
				outcome: { ...outcome, imageReference: "registry.example/other:v1" },
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
		).toThrow("Worker result revision correlation mismatch");
	});

	it("requires full Secret and Workload context on failed activation results", () => {
		const activationExpected = {
			...expected,
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
			traceId: activationExpected.traceId,
			agentId: activationExpected.agentId,
			configRevision: activationExpected.configRevision,
			workloadRevision: activationExpected.workloadRevision,
			fence: activationExpected.fence,
			status: "failed",
			operation: "activate-secret",
			error: {
				schemaVersion: 1,
				code: "SECRET_ACTIVATION_FAILED",
				message: "The Secret activation failed",
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
			...expected,
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
