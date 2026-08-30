import { describe, expect, it } from "vitest";

import {
	validateWorkerWorkloadExpectedRevisionV1,
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

const reconcileExpected = {
	...workerCorrelation,
	operation: "reconcile-workload",
	desiredWorkload,
} as const;

const reconcileResultCorrelation = {
	...workerCorrelation,
	operation: "reconcile-workload",
	expectedWorkload: desiredWorkload.expectedWorkload,
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

const kubernetesOutcomeCorrelation = {
	schemaVersion: 1,
	requestId: desiredWorkload.requestId,
	traceId: desiredWorkload.traceId,
	agentId: desiredWorkload.agentId,
	configRevision: desiredWorkload.configRevision,
	workloadRevision: desiredWorkload.workloadRevision,
	fence: desiredWorkload.fence,
} as const;

const kubernetesAppliedOutcome = {
	...kubernetesOutcomeCorrelation,
	status: "applied",
	workloadUid: appliedWorkload.workloadUid,
	workloadGeneration: appliedWorkload.observedGeneration,
	applied: appliedWorkload,
} as const;

const reconcileAppliedResult = {
	...reconcileResultCorrelation,
	status: "succeeded",
	workloadUid: appliedWorkload.workloadUid,
	workloadGeneration: appliedWorkload.observedGeneration,
	outcome: kubernetesAppliedOutcome,
} as const;

const cleanupExpected = {
	...workerCorrelation,
	requestId: "request_cleanup_01",
	operation: "cleanup-workload",
	workloadUid: appliedWorkload.workloadUid,
	workloadGeneration: appliedWorkload.observedGeneration,
	persistentVolumeIntent: "delete-new",
} as const;

const cleanupOutcomeCorrelation = {
	schemaVersion: 1,
	requestId: cleanupExpected.requestId,
	traceId: cleanupExpected.traceId,
	agentId: cleanupExpected.agentId,
	configRevision: cleanupExpected.configRevision,
	workloadRevision: cleanupExpected.workloadRevision,
	workloadUid: cleanupExpected.workloadUid,
	workloadGeneration: cleanupExpected.workloadGeneration,
	fence: cleanupExpected.fence,
} as const;

const removedCleanupResources = {
	route: true,
	workload: true,
	service: true,
	serviceAccount: true,
	networkPolicy: true,
	configuration: true,
	secrets: true,
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
		const failedOutcome = {
			schemaVersion: 1,
			status: "failed",
			activationFence,
			health: "unhealthy",
			error: {
				schemaVersion: 1,
				code: "SECRET_ACTIVATION_FAILED",
				message: "Secret activation failed",
				retryable: true,
				traceId: "trace_other",
			},
		} as const;
		expect(() =>
			validateWorkerWorkloadResultV1(activationExpected, {
				...result,
				outcome: failedOutcome,
			}),
		).toThrow("Worker result revision correlation mismatch");
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
				kubernetesSecretName: "Invalid Secret Name",
			}).success,
		).toBe(false);
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

describe("Worker Workload reconcile expected context V1 contract", () => {
	it("binds a complete desired Workload to the outer work item", () => {
		expect(validateWorkerWorkloadExpectedRevisionV1(reconcileExpected)).toEqual(
			reconcileExpected,
		);
		expect(
			WorkerWorkloadExpectedRevisionV1Schema.safeParse({
				...reconcileExpected,
				schemaVersion: 2,
			}).success,
		).toBe(false);
		expect(
			WorkerWorkloadExpectedRevisionV1Schema.safeParse({
				...reconcileExpected,
				desiredWorkload: {
					...desiredWorkload,
					expectedWorkload: undefined,
				},
			}).success,
		).toBe(false);
		expect(() =>
			validateWorkerWorkloadExpectedRevisionV1({
				...reconcileExpected,
				desiredWorkload: {
					...desiredWorkload,
					service: { ...desiredWorkload.service, port: 9090 },
				},
			}),
		).toThrow("Desired Workload correlation mismatch");
		expect(() =>
			validateWorkerWorkloadExpectedRevisionV1({
				...reconcileExpected,
				desiredWorkload: {
					...desiredWorkload,
					fence: reconcileExpected.fence + 1,
				},
			}),
		).toThrow("Worker expected revision correlation mismatch");
	});
});

describe("Worker Workload reconcile result V1 contract", () => {
	it("accepts an applied result bound to the outer Workload identity", () => {
		expect(WorkerWorkloadResultV1Schema.parse(reconcileAppliedResult)).toEqual(
			reconcileAppliedResult,
		);
		expect(
			validateWorkerWorkloadResultV1(reconcileExpected, reconcileAppliedResult),
		).toEqual(reconcileAppliedResult);
	});

	it("requires an all-or-nothing outer Workload identity for applied outcomes", () => {
		for (const partialIdentity of [
			{ workloadUid: undefined },
			{ workloadGeneration: undefined },
		]) {
			expect(
				WorkerWorkloadResultV1Schema.safeParse({
					...reconcileAppliedResult,
					...partialIdentity,
				}).success,
			).toBe(false);
		}
		expect(() =>
			validateWorkerWorkloadResultV1(reconcileExpected, {
				...reconcileResultCorrelation,
				status: "succeeded",
				outcome: kubernetesAppliedOutcome,
			}),
		).toThrow("Worker result revision correlation mismatch");
		expect(() =>
			validateWorkerWorkloadResultV1(reconcileExpected, {
				...reconcileAppliedResult,
				workloadUid: "workload_uid_02",
			}),
		).toThrow("Worker result revision correlation mismatch");
	});

	it.each([
		{
			...kubernetesOutcomeCorrelation,
			status: "stale",
			currentConfigRevision: desiredWorkload.configRevision + 1,
			currentWorkloadRevision: desiredWorkload.workloadRevision,
			error: {
				schemaVersion: 1,
				code: "KUBERNETES_STALE_REVISION",
				message: "A newer Workload revision is already current",
				retryable: false,
				traceId: desiredWorkload.traceId,
			},
		},
		{
			...kubernetesOutcomeCorrelation,
			status: "rejected",
			error: {
				schemaVersion: 1,
				code: "KUBERNETES_POLICY_REJECTED",
				message: "Kubernetes policy rejected the Workload",
				retryable: false,
				traceId: desiredWorkload.traceId,
			},
		},
		{
			...kubernetesOutcomeCorrelation,
			status: "failed",
			error: {
				schemaVersion: 1,
				code: "KUBERNETES_HEALTH_CHECK_FAILED",
				message: "Kubernetes Workload failed its health check",
				retryable: true,
				traceId: desiredWorkload.traceId,
			},
		},
	])(
		"preserves a sanitized Kubernetes $status outcome without identity",
		(outcome) => {
			const result = {
				...reconcileResultCorrelation,
				status: "succeeded",
				outcome,
			} as const;

			expect(validateWorkerWorkloadResultV1(reconcileExpected, result)).toEqual(
				result,
			);
			expect(() =>
				validateWorkerWorkloadResultV1(reconcileExpected, {
					...result,
					workloadUid: appliedWorkload.workloadUid,
					workloadGeneration: appliedWorkload.observedGeneration,
				}),
			).toThrow("Worker result revision correlation mismatch");
			expect(
				WorkerWorkloadResultV1Schema.safeParse({
					...result,
					outcome: {
						...outcome,
						error: {
							...outcome.error,
							message: "Kubernetes returned bearer secret-token",
						},
					},
				}).success,
			).toBe(false);
		},
	);

	it("reuses Worker stale fence validation for reconcile failures", () => {
		const stale = {
			...reconcileResultCorrelation,
			status: "stale",
			currentConfigRevision: reconcileExpected.configRevision,
			currentWorkloadRevision: reconcileExpected.workloadRevision,
			currentFence: reconcileExpected.fence + 1,
			error: {
				schemaVersion: 1,
				code: "WORKER_RESULT_STALE",
				message: "The Worker result is stale",
				retryable: false,
				traceId: reconcileExpected.traceId,
			},
		} as const;

		expect(validateWorkerWorkloadResultV1(reconcileExpected, stale)).toEqual(
			stale,
		);
		expect(() =>
			validateWorkerWorkloadResultV1(reconcileExpected, {
				...stale,
				currentFence: reconcileExpected.fence,
			}),
		).toThrow("Worker result revision correlation mismatch");
		expect(
			WorkerWorkloadResultV1Schema.safeParse({
				...stale,
				workloadUid: appliedWorkload.workloadUid,
				workloadGeneration: appliedWorkload.observedGeneration,
			}).success,
		).toBe(false);
	});

	it.each([
		{
			...appliedWorkload,
			service: { ...appliedWorkload.service, port: 9090 },
		},
		{ ...appliedWorkload, resourceProfileRef: "resource-profile_02" },
	])("rejects a desired/applied Workload resource mismatch", (applied) => {
		expect(() =>
			validateWorkerWorkloadResultV1(reconcileExpected, {
				...reconcileAppliedResult,
				outcome: { ...kubernetesAppliedOutcome, applied },
			}),
		).toThrow("Applied Workload correlation mismatch");
	});

	it("fails closed on result context, versions, operations and required fields", () => {
		expect(() =>
			validateWorkerWorkloadResultV1(reconcileExpected, {
				...reconcileAppliedResult,
				expectedWorkload: {
					state: "present",
					workloadUid: appliedWorkload.workloadUid,
					workloadGeneration: appliedWorkload.observedGeneration,
				},
			}),
		).toThrow("Worker result revision correlation mismatch");
		for (const result of [
			{ ...reconcileAppliedResult, schemaVersion: 2 },
			{
				...reconcileAppliedResult,
				outcome: { ...kubernetesAppliedOutcome, schemaVersion: 2 },
			},
			{ ...reconcileAppliedResult, operation: "cleanup-workload" },
			{ ...reconcileAppliedResult, outcome: undefined },
			{ ...reconcileAppliedResult, expectedWorkload: undefined },
		]) {
			expect(WorkerWorkloadResultV1Schema.safeParse(result).success).toBe(
				false,
			);
		}
	});
});

describe("Worker Workload cleanup result V1 contract", () => {
	it.each([
		["delete-new", true],
		["retain-existing", false],
	] as const)(
		"accepts completed cleanup with %s PVC intent",
		(persistentVolumeIntent, persistentVolume) => {
			const expected = { ...cleanupExpected, persistentVolumeIntent } as const;
			const result = {
				...expected,
				status: "succeeded",
				outcome: {
					...cleanupOutcomeCorrelation,
					persistentVolumeIntent,
					status: "completed",
					routeClosed: true,
					removed: { ...removedCleanupResources, persistentVolume },
				},
			} as const;

			expect(WorkerWorkloadExpectedRevisionV1Schema.parse(expected)).toEqual(
				expected,
			);
			expect(WorkerWorkloadResultV1Schema.parse(result)).toEqual(result);
			expect(validateWorkerWorkloadResultV1(expected, result)).toEqual(result);
		},
	);

	it("binds outer and nested cleanup facts to the exact work item", () => {
		const result = {
			...cleanupExpected,
			status: "succeeded",
			outcome: {
				...cleanupOutcomeCorrelation,
				persistentVolumeIntent: "delete-new",
				status: "completed",
				routeClosed: true,
				removed: { ...removedCleanupResources, persistentVolume: true },
			},
		} as const;

		expect(() =>
			validateWorkerWorkloadResultV1(cleanupExpected, {
				...result,
				workloadUid: "workload_uid_02",
			}),
		).toThrow("Worker result revision correlation mismatch");
		expect(() =>
			validateWorkerWorkloadResultV1(cleanupExpected, {
				...result,
				outcome: {
					...result.outcome,
					workloadGeneration: cleanupExpected.workloadGeneration + 1,
				},
			}),
		).toThrow("Workload cleanup correlation mismatch");
		expect(() =>
			validateWorkerWorkloadResultV1(cleanupExpected, {
				...result,
				persistentVolumeIntent: "retain-existing",
			}),
		).toThrow("Worker result revision correlation mismatch");
	});

	it("preserves route-first in-progress and fixed failed cleanup outcomes", () => {
		const untouched = {
			route: false,
			workload: false,
			service: false,
			serviceAccount: false,
			networkPolicy: false,
			configuration: false,
			secrets: false,
			persistentVolume: false,
		} as const;
		const closingRoute = {
			...cleanupOutcomeCorrelation,
			persistentVolumeIntent: "delete-new",
			status: "in-progress",
			phase: "closing-route",
			routeClosed: false,
			removed: untouched,
		} as const;
		const removingResources = {
			...closingRoute,
			phase: "removing-resources",
			routeClosed: true,
			removed: { ...untouched, route: true },
		} as const;
		const failed = {
			...closingRoute,
			status: "failed",
			error: {
				schemaVersion: 1,
				code: "KUBERNETES_CLEANUP_FAILED",
				message: "Kubernetes Workload cleanup did not complete",
				retryable: true,
				traceId: cleanupExpected.traceId,
			},
		} as const;

		for (const outcome of [closingRoute, removingResources, failed]) {
			const result = {
				...cleanupExpected,
				status: "succeeded",
				outcome,
			} as const;
			expect(validateWorkerWorkloadResultV1(cleanupExpected, result)).toEqual(
				result,
			);
		}
		expect(() =>
			validateWorkerWorkloadResultV1(cleanupExpected, {
				...cleanupExpected,
				status: "succeeded",
				outcome: {
					...failed,
					removed: { ...failed.removed, workload: true },
				},
			}),
		).toThrow("Workload cleanup correlation mismatch");
		expect(() =>
			validateWorkerWorkloadResultV1(cleanupExpected, {
				...cleanupExpected,
				status: "succeeded",
				outcome: { ...failed, phase: "removing-resources" },
			}),
		).toThrow("Workload cleanup correlation mismatch");
		expect(
			WorkerWorkloadResultV1Schema.safeParse({
				...cleanupExpected,
				status: "succeeded",
				outcome: {
					...failed,
					error: {
						...failed.error,
						message: "Kubernetes returned bearer secret-token",
					},
				},
			}).success,
		).toBe(false);
	});

	it("reuses Worker stale fence validation for cleanup errors", () => {
		const stale = {
			...cleanupExpected,
			status: "stale",
			currentConfigRevision: cleanupExpected.configRevision,
			currentWorkloadRevision: cleanupExpected.workloadRevision,
			currentFence: cleanupExpected.fence + 1,
			error: {
				schemaVersion: 1,
				code: "WORKER_RESULT_STALE",
				message: "The Worker result is stale",
				retryable: false,
				traceId: cleanupExpected.traceId,
			},
		} as const;

		expect(validateWorkerWorkloadResultV1(cleanupExpected, stale)).toEqual(
			stale,
		);
		expect(() =>
			validateWorkerWorkloadResultV1(cleanupExpected, {
				...stale,
				currentFence: cleanupExpected.fence,
			}),
		).toThrow("Worker result revision correlation mismatch");
	});

	it("fails closed on PVC contradictions and incomplete cleanup results", () => {
		const retainExpected = {
			...cleanupExpected,
			persistentVolumeIntent: "retain-existing",
		} as const;
		const contradictory = {
			...retainExpected,
			status: "succeeded",
			outcome: {
				...cleanupOutcomeCorrelation,
				persistentVolumeIntent: "retain-existing",
				status: "in-progress",
				phase: "removing-resources",
				routeClosed: true,
				removed: {
					route: true,
					workload: false,
					service: false,
					serviceAccount: false,
					networkPolicy: false,
					configuration: false,
					secrets: false,
					persistentVolume: true,
				},
			},
		} as const;

		expect(() =>
			validateWorkerWorkloadResultV1(retainExpected, contradictory),
		).toThrow("Workload cleanup correlation mismatch");
		for (const invalid of [
			{ ...cleanupExpected, schemaVersion: 2 },
			{
				...contradictory,
				outcome: { ...contradictory.outcome, schemaVersion: 2 },
			},
			{ ...cleanupExpected, workloadGeneration: undefined },
			{ ...cleanupExpected, persistentVolumeIntent: "snapshot" },
			{ ...contradictory, operation: "reconcile-workload" },
			{ ...contradictory, outcome: undefined },
			{
				...cleanupExpected,
				status: "succeeded",
				outcome: {
					...cleanupOutcomeCorrelation,
					persistentVolumeIntent: "delete-new",
					status: "completed",
					routeClosed: true,
					removed: {
						...removedCleanupResources,
						service: false,
						persistentVolume: true,
					},
				},
			},
		]) {
			expect(WorkerWorkloadResultV1Schema.safeParse(invalid).success).toBe(
				false,
			);
		}
	});
});
