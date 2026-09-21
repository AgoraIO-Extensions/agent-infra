import {
	type PlatformSecretRecordV1,
	validatePlatformSecretRecordV1,
} from "@agent-infra/contracts/workload";
import {
	type AgentConfigurationRecordV2,
	createWorkloadReconciliationV1,
	type SecretActivationCandidateV1,
	type SecretActivationStorePortV1,
	type WorkloadReconciliationInputV1,
	type WorkloadReconciliationStateV1,
} from "@agent-infra/platform-core";
import { vi } from "vitest";
import {
	fakeKubernetesApi,
	workloadRegistryFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import {
	createWorkloadRuntimeV1,
	type WorkloadRuntimeOptionsV1,
	workloadResourceConfigurationHashV1,
} from "./workload-runtime.js";

export function configurationFixture(
	overrides: Partial<AgentConfigurationRecordV2> = {},
): AgentConfigurationRecordV2 {
	return {
		schemaVersion: 2,
		channels: [],
		channelRevision: "channels-a",
		agentId: "agent-a",
		revision: 1,
		modelConfiguration: null,
		secrets: [],
		environment: [],
		source: {
			kind: "custom",
			imageDigest: `sha256:${"a".repeat(64)}`,
			admissionRevision: "admission-a",
			interactionMode: "platform-adapter",
			connectionEnabled: false,
		},
		...overrides,
	};
}

export function pendingSecretRecord(
	overrides: {
		readonly ownerId?: string;
		readonly configRevision?: number;
		readonly name?: string;
		readonly secretId?: string;
	} = {},
): PlatformSecretRecordV1 {
	const ownerId = overrides.ownerId ?? "owner-a";
	const configRevision = overrides.configRevision ?? 1;
	const name = overrides.name ?? "BOT_TOKEN";
	const secretId = overrides.secretId ?? "secret-a";
	return validatePlatformSecretRecordV1({
		schemaVersion: 1,
		secretId,
		ownerType: "agent-owner",
		ownerId,
		agentId: "agent-a",
		name,
		secretVersion: 1,
		configRevision,
		lifecycleState: "pending",
		crypto: {
			schemaVersion: 1,
			algorithmVersion: "aes-256-gcm:v1",
			wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
			wrappingKeyVersion: "key-a",
			aadBinding: {
				schemaVersion: 1,
				aadVersion: "platform-secret-aad:v1",
				secretId,
				ownerType: "agent-owner",
				ownerId,
				agentId: "agent-a",
				name,
				secretVersion: 1,
				configRevision,
				algorithmVersion: "aes-256-gcm:v1",
				wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
				wrappingKeyVersion: "key-a",
			},
			dekFingerprint: "a".repeat(64),
			nonce: "AAAAAAAAAAAAAAAA",
			ciphertext: "YWJjZA==",
			authenticationTag: "AAAAAAAAAAAAAAAAAAAAAA==",
			wrappedDek: "A".repeat(512),
		},
		createdAt: "2026-09-08T00:00:00.000Z",
		updatedAt: "2026-09-08T00:00:00.000Z",
	});
}

export function materializedSecretRecord(
	lifecycleState: "applying" | "observed",
	overrides: Parameters<typeof pendingSecretRecord>[0] = {},
): PlatformSecretRecordV1 {
	const record = pendingSecretRecord(overrides);
	const reference = {
		schemaVersion: 1 as const,
		ownerType: record.ownerType,
		ownerId: record.ownerId,
		agentId: record.agentId,
		secretId: record.secretId,
		secretVersion: record.secretVersion,
		configRevision: record.configRevision,
		algorithmVersion: record.crypto.algorithmVersion,
		wrappingAlgorithmVersion: record.crypto.wrappingAlgorithmVersion,
		wrappingKeyVersion: record.crypto.wrappingKeyVersion,
		name: "agent-aaaaaaaaaaaaaaaa.secret-aaaaaaaaaaaaaaaa-v1-r1",
	};
	return validatePlatformSecretRecordV1({
		...record,
		lifecycleState,
		kubernetesSecretRef: reference,
		activationFence: {
			schemaVersion: 1,
			agentId: record.agentId,
			secretId: record.secretId,
			secretVersion: record.secretVersion,
			configRevision: record.configRevision,
			kubernetesSecretName: reference.name,
			workloadUid: "workload-a",
			workloadGeneration: 1,
			fence: 1,
		},
	});
}

export function activeSecretRecord(
	overrides: Parameters<typeof pendingSecretRecord>[0] = {},
): ActiveSecretRecordV1 {
	const record = materializedSecretRecord("observed", overrides);
	return validateActiveSecretRecordV1({
		...record,
		lifecycleState: "active",
	});
}

type ActiveSecretRecordV1 = Extract<
	PlatformSecretRecordV1,
	{ readonly lifecycleState: "active" }
>;

export function validateActiveSecretRecordV1(
	input: unknown,
): ActiveSecretRecordV1 {
	const record = validatePlatformSecretRecordV1(input);
	if (record.lifecycleState !== "active") throw new Error();
	return record;
}

export function secretCleanupStore(
	record: PlatformSecretRecordV1,
	options: {
		readonly currentConfigurationRevision?: number;
		readonly storedOwnerId?: string;
		readonly failTransitionOnce?: boolean;
	} = {},
) {
	let persistedRecord = structuredClone(record);
	let candidate: SecretActivationCandidateV1 = {
		schemaVersion: 1,
		agentId: record.agentId,
		secretId: record.secretId,
		secretVersion: record.secretVersion,
		configRevision: record.configRevision,
		ownerType: record.ownerType,
		ownerId: options.storedOwnerId ?? record.ownerId,
		name: record.name,
		wrappingKeyVersion: record.crypto.wrappingKeyVersion,
		lifecycleState: record.lifecycleState,
		failureRetryable: null,
		encryptedRecord: record,
	};
	let claimFence = 0;
	let claimCount = 0;
	let commitCount = 0;
	let transitionFailed = options.failTransitionOnce ?? false;
	const store = {
		async claimCandidate(input, decide) {
			claimCount += 1;
			const plan = decide({
				schemaVersion: 1,
				currentConfigurationRevision:
					options.currentConfigurationRevision ?? record.configRevision,
				candidate: structuredClone(candidate),
			});
			if (plan.outcome !== "claim") return plan;
			claimFence += 1;
			return {
				outcome: "claimed" as const,
				claim: {
					schemaVersion: 1 as const,
					workerId: input.workerId,
					fence: claimFence,
					leaseExpiresAt: new Date(Date.now() + input.leaseDurationMs),
					candidate: structuredClone(candidate),
				},
			};
		},
		async recordAudit() {
			return true;
		},
		async commitTransition(input) {
			commitCount += 1;
			if (transitionFailed) {
				transitionFailed = false;
				return false;
			}
			if (
				input.claim.fence !== claimFence ||
				input.plan.next.lifecycleState !== "failed"
			)
				return false;
			candidate = {
				...candidate,
				lifecycleState: "failed",
				failureRetryable: input.plan.next.error.retryable,
			};
			persistedRecord = validatePlatformSecretRecordV1({
				...persistedRecord,
				lifecycleState: "failed",
				error: input.plan.next.error,
			});
			return true;
		},
	} satisfies SecretActivationStorePortV1;
	return {
		store,
		get record() {
			return persistedRecord;
		},
		get commits() {
			return commitCount;
		},
		get claims() {
			return claimCount;
		},
	};
}

export function fixture(
	overrides: Partial<WorkloadRuntimeOptionsV1> = {},
	inputOverrides: Partial<
		Pick<WorkloadReconciliationInputV1, "configuration" | "secrets">
	> = {},
) {
	const api = fakeKubernetesApi();
	let configuration = inputOverrides.configuration ?? configurationFixture();
	let state: WorkloadReconciliationStateV1 | null = null;
	let management: WorkloadReconciliationInputV1["management"] = {
		schemaVersion: 1,
		agentId: "agent-a",
		applicationId: "application-a",
		applicantId: "owner-a",
		ownerIds: ["owner-a"],
		availability: [],
		decisionReason: null,
		revision: 1,
		workloadRevision: 1,
		fence: 1,
		status: "creating",
		desiredState: "running",
		serviceAvailability: "updating",
		approvalRevision: 1,
		failureCode: null,
	};
	const options: WorkloadRuntimeOptionsV1 = {
		executionCapacityProfiles: [
			{
				schemaVersion: 1,
				imageDigest: `sha256:${"a".repeat(64)}`,
				resourceProfileRef: workloadTestPolicy.resourceProfileRef,
				resourceConfigurationHash:
					workloadResourceConfigurationHashV1(workloadTestPolicy),
				maximumConcurrentExecutions: 2,
				conformanceEvidenceHash: "c".repeat(64),
			},
		],
		templateModelBindings: [
			{
				templateId: "template-a",
				imageDigest: `sha256:${"a".repeat(64)}`,
				protocol: "openai-responses-v1",
			},
		],
		workerId: "worker-a",
		client: api.client,
		policy: workloadTestPolicy,
		registry: workloadRegistryFixture({
			schemaVersion: 1,
			interactionMode: "platform-adapter",
			protocol: "acp",
			service: { port: 8080 },
			health: { path: "/healthz" },
			capabilities: {
				attachments: true,
				modelSelection: true,
				supplementaryInstruction: true,
			},
		}),
		admissionPolicyRef: "policy-a",
		registrySubjectRef: "subject-a",
		decryptor: {
			decrypt: async () => ({
				outcome: "failed",
				code: "SECRET_KEY_UNAVAILABLE",
			}),
		},
		fetch: vi.fn(async () => new Response("ok")),
		probeRuntime: async () => ({ core: "passed", capabilities: {} }),
		...overrides,
	};
	return {
		...api,
		options,
		get state() {
			return state;
		},
		get management() {
			return structuredClone(management);
		},
		setManagement(next: WorkloadReconciliationInputV1["management"]) {
			management = structuredClone(next);
		},
		setConfiguration(next: WorkloadReconciliationInputV1["configuration"]) {
			configuration = structuredClone(next);
		},
		async until(
			predicate: (value: WorkloadReconciliationStateV1 | null) => boolean,
		) {
			for (let i = 0; i < 50; i++) {
				if (predicate(state)) return;
				await this.tick(1);
			}
			throw new Error("Workload did not reach the expected recovery step");
		},
		async tick(times: number) {
			for (let i = 0; i < times; i++) {
				await createWorkloadReconciliationV1({
					runtime: createWorkloadRuntimeV1(options),
					maximumAttempts: 2,
					store: {
						async runNext(_workerId, step) {
							state = await step({
								state,
								configuration,
								management,
								requestId: "request-a",
								traceId: "trace-a",
								secrets: inputOverrides.secrets,
							});
							return "advanced";
						},
					},
				}).tick("worker-a");
			}
		},
	};
}

export function rejectedRegistry(): WorkloadRuntimeOptionsV1["registry"] {
	return {
		async admit(request) {
			return {
				schemaVersion: 1,
				status: "rejected",
				requestId: request.requestId,
				traceId: request.traceId,
				error: {
					schemaVersion: 1,
					code: "IMAGE_NOT_ADMITTED",
					message: "The image is not admitted by deployment policy",
					retryable: false,
					traceId: request.traceId,
				},
			};
		},
	};
}

export function secretConfiguration(
	overrides: Partial<AgentConfigurationRecordV2> = {},
): AgentConfigurationRecordV2 {
	return configurationFixture({
		secrets: [
			{
				name: "BOT_TOKEN",
				secretId: "secret-a",
				version: 1,
				isSet: true,
			},
		],
		...overrides,
	});
}

export const modelCredentialEnvironmentKey =
	"MODEL_CREDENTIAL_8797B0599D5943E951FFB4D92C441B669B051F3EC38058B37737816D5C061E52";

export function standardModelConfiguration(
	overrides: Partial<AgentConfigurationRecordV2> = {},
): AgentConfigurationRecordV2 {
	return configurationFixture({
		source: {
			kind: "standard",
			templateId: "template-a",
			imageDigest: `sha256:${"a".repeat(64)}`,
			admissionRevision: "admission-a",
			allowedEnvironmentKeys: [modelCredentialEnvironmentKey],
			allowedSecretKeys: [modelCredentialEnvironmentKey],
			platformManagedKeys: [],
			connectionEnabled: false,
		},
		modelConfiguration: {
			catalogRevision: "catalog-a",
			options: [
				{
					optionId: "primary",
					endpointId: "endpoint-a",
					modelId: "model-a",
					reasoningLevels: ["medium"],
					credential: {
						secretId: "model-secret-a",
						version: 1,
						isSet: true,
					},
				},
			],
			defaultOptionId: "primary",
			defaultReasoningLevel: "medium",
		},
		...overrides,
	});
}

export function cleanupSecrets(
	input: ReturnType<typeof secretCleanupStore>,
	materialization: "current" | "active-origin" = "current",
): NonNullable<WorkloadReconciliationInputV1["secrets"]> {
	return {
		get bindings() {
			return [{ materialization, record: input.record }];
		},
		store: input.store,
		async auditDecryption() {},
	};
}
