import { describe, expect, it } from "vitest";

import {
	validateWorkerWorkloadResultV1,
	WorkerWorkloadExpectedRevisionV1Schema,
	WorkerWorkloadResultV1Schema,
} from "../../src/workload/worker-result.js";

const workerCorrelation = {
	schemaVersion: 1,
	outboxItemId: "outbox_01",
	requestId: "request_01",
	traceId: "trace_worker_01",
	agentId: "agent_01",
	configRevision: 7,
	workloadRevision: 9,
	fence: 11,
} as const;

const admissionExpected = {
	...workerCorrelation,
	operation: "admit-image",
	registrySubjectRef: "subject_01",
	imageReference: "registry.example/agent:v1",
	usage: "custom-agent",
	admissionPolicyRef: "policy_01",
} as const;

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

const secretRef = {
	schemaVersion: 1,
	ownerType: "agent-owner",
	ownerId: "owner_01",
	agentId: activationExpected.agentId,
	secretId: activationExpected.secretId,
	secretVersion: activationExpected.secretVersion,
	configRevision: activationExpected.configRevision,
	algorithmVersion: "aes-256-gcm:v1",
	wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
	wrappingKeyVersion: "wrapping-key-v1",
	name: activationExpected.kubernetesSecretName,
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

describe("Worker admission and Secret result V1 contract", () => {
	it("represents fence-only staleness and rejects equal or regressed context", () => {
		const fenceStale = {
			...admissionExpected,
			status: "stale",
			currentConfigRevision: admissionExpected.configRevision,
			currentWorkloadRevision: admissionExpected.workloadRevision,
			currentFence: admissionExpected.fence + 1,
			error: {
				schemaVersion: 1,
				code: "WORKER_RESULT_STALE",
				message: "The Worker result is stale",
				retryable: false,
				traceId: admissionExpected.traceId,
			},
		} as const;

		expect(WorkerWorkloadResultV1Schema.parse(fenceStale)).toEqual(fenceStale);
		expect(
			validateWorkerWorkloadResultV1(admissionExpected, fenceStale),
		).toEqual(fenceStale);
		expect(() =>
			validateWorkerWorkloadResultV1(admissionExpected, {
				...fenceStale,
				currentFence: admissionExpected.fence,
			}),
		).toThrow("Worker result revision correlation mismatch");
		expect(() =>
			validateWorkerWorkloadResultV1(admissionExpected, {
				...fenceStale,
				currentConfigRevision: admissionExpected.configRevision + 1,
				currentFence: admissionExpected.fence - 1,
			}),
		).toThrow("Worker result revision correlation mismatch");
		expect(
			validateWorkerWorkloadResultV1(admissionExpected, {
				...fenceStale,
				currentConfigRevision: admissionExpected.configRevision + 1,
				currentFence: admissionExpected.fence,
			}),
		).toEqual({
			...fenceStale,
			currentConfigRevision: admissionExpected.configRevision + 1,
			currentFence: admissionExpected.fence,
		});
		expect(
			WorkerWorkloadResultV1Schema.safeParse({
				...fenceStale,
				currentFence: undefined,
			}).success,
		).toBe(false);
	});

	it("binds Registry outcomes to the exact admission context", () => {
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
			outcome,
		} as const;

		expect(
			WorkerWorkloadExpectedRevisionV1Schema.parse(admissionExpected),
		).toEqual(admissionExpected);
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
				outcome: { ...outcome, requestId: "request_other" },
			}),
		).toThrow("Image registry result correlation mismatch");
		expect(
			WorkerWorkloadResultV1Schema.safeParse({
				...result,
				schemaVersion: 2,
			}).success,
		).toBe(false);
		expect(
			WorkerWorkloadResultV1Schema.safeParse({
				...result,
				outboxItemId: undefined,
			}).success,
		).toBe(false);
	});

	it("binds Secret observations to the exact activation fence", () => {
		const outcome = {
			schemaVersion: 1,
			status: "observed",
			kubernetesSecretRef: secretRef,
			activationFence,
			health: "healthy",
		} as const;
		const result = {
			...activationExpected,
			status: "succeeded",
			outcome,
		} as const;

		expect(validateWorkerWorkloadResultV1(activationExpected, result)).toEqual(
			result,
		);
		expect(() =>
			validateWorkerWorkloadResultV1(activationExpected, {
				...result,
				secretId: "secret_02",
			}),
		).toThrow("Worker result revision correlation mismatch");
		expect(() =>
			validateWorkerWorkloadResultV1(activationExpected, {
				...result,
				outcome: {
					...outcome,
					kubernetesSecretRef: { ...secretRef, agentId: "agent_02" },
				},
			}),
		).toThrow("Secret activation fence mismatch");
	});

	it("requires full operation context and fixed sanitized Worker errors", () => {
		const incompleteFailure = {
			...workerCorrelation,
			requestId: activationExpected.requestId,
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
		expect(
			validateWorkerWorkloadResultV1(activationExpected, completeFailure),
		).toEqual(completeFailure);
		expect(
			WorkerWorkloadResultV1Schema.safeParse({
				...completeFailure,
				error: {
					...completeFailure.error,
					message: "Kubernetes returned bearer super-secret-token",
				},
			}).success,
		).toBe(false);
		expect(
			WorkerWorkloadResultV1Schema.safeParse({
				...completeFailure,
				error: {
					...completeFailure.error,
					code: "PROVIDER_SPECIFIC_FAILURE",
				},
			}).success,
		).toBe(false);
	});
});
