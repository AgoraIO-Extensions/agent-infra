import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
} from "@agent-infra/agent-runtime";
import { RuntimeCapabilitiesResponseV1Schema } from "@agent-infra/contracts/runtime";
import {
	type PlatformSecretRecordV1,
	validatePlatformSecretRecordV1,
} from "@agent-infra/contracts/workload";
import {
	type AgentConfigurationRecordV1,
	createWorkloadReconciliationV1,
	type SecretActivationCandidateV1,
	type SecretActivationStorePortV1,
	type WorkloadReconciliationInputV1,
	type WorkloadReconciliationStateV1,
} from "@agent-infra/platform-core";
import { FakeAgentManagementV1 } from "@agent-infra/platform-core/testing";
import { describe, expect, it, vi } from "vitest";
import {
	runtimeGrantFixture,
	verificationForRuntimeGrant,
} from "../../../packages/agent-runtime/src/grant-fixture.test-support.js";
import { createRuntimeHostApp } from "../../agent-runtime-host/src/app.js";
import {
	fakeKubernetesApi,
	workloadRegistryFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import {
	createWorkloadRuntimeV1,
	type WorkloadRuntimeOptionsV1,
} from "./workload-runtime.js";

function configurationFixture(
	overrides: Partial<AgentConfigurationRecordV1> = {},
): AgentConfigurationRecordV1 {
	return {
		schemaVersion: 1,
		actions: [],
		actionSetRevision: "actions-a",
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

function pendingSecretRecord(
	overrides: {
		readonly ownerId?: string;
		readonly configRevision?: number;
	} = {},
): PlatformSecretRecordV1 {
	const ownerId = overrides.ownerId ?? "owner-a";
	const configRevision = overrides.configRevision ?? 1;
	return validatePlatformSecretRecordV1({
		schemaVersion: 1,
		secretId: "secret-a",
		ownerType: "agent-owner",
		ownerId,
		agentId: "agent-a",
		name: "BOT_TOKEN",
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
				secretId: "secret-a",
				ownerType: "agent-owner",
				ownerId,
				agentId: "agent-a",
				name: "BOT_TOKEN",
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

function materializedSecretRecord(
	lifecycleState: "applying" | "observed",
): PlatformSecretRecordV1 {
	const record = pendingSecretRecord();
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

function activeSecretRecord(): PlatformSecretRecordV1 {
	const record = materializedSecretRecord("observed");
	return validatePlatformSecretRecordV1({
		...record,
		lifecycleState: "active",
	});
}

function secretCleanupStore(
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

function fixture(
	overrides: Partial<WorkloadRuntimeOptionsV1> = {},
	inputOverrides: Partial<
		Pick<WorkloadReconciliationInputV1, "configuration" | "secrets">
	> = {},
) {
	const api = fakeKubernetesApi();
	const configuration = inputOverrides.configuration ?? configurationFixture();
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

function rejectedRegistry(): WorkloadRuntimeOptionsV1["registry"] {
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

function secretConfiguration(
	overrides: Partial<AgentConfigurationRecordV1> = {},
): AgentConfigurationRecordV1 {
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

function cleanupSecrets(
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

describe("assembled Workload Runtime contracts", () => {
	it("retains the exact pending Secret when rejected preflight has no Kubernetes material", async () => {
		const record = pendingSecretRecord();
		const cleanup = secretCleanupStore(record);
		const configuration = secretConfiguration();
		const f = fixture(
			{ registry: rejectedRegistry() },
			{
				configuration,
				secrets: cleanupSecrets(cleanup),
			},
		);
		await f.tick(2);
		expect(f.state?.phase).toBe("cleaning");
		expect(f.state?.candidate.deployment).toBeNull();
		await f.tick(1);
		expect(f.state?.phase).toBe("failed");
		expect(cleanup.record.lifecycleState).toBe("pending");
		expect(cleanup.claims).toBe(0);
		expect(cleanup.commits).toBe(0);
		expect(f.resources.size).toBe(0);
		expect(f.writes).toHaveLength(0);

		const retryManagement = new FakeAgentManagementV1({
			states: [
				{
					...f.management,
					status: "creation_failed",
					revision: 2,
					serviceAvailability: null,
					failureCode: "reconciliation_failed",
				},
			],
		});
		const retry = await retryManagement.executeManagementCommand(
			{
				schemaVersion: 1,
				command: "retry_agent_creation",
				agentId: f.management.agentId,
				expectedRevision: 2,
				idempotencyKey: "retry-pending-secret",
				requestId: "request-retry-pending-secret",
				traceId: "trace-retry-pending-secret",
			},
			{
				schemaVersion: 1,
				userId: "owner-a",
				accountStatus: "active",
				organizationIds: [],
				isAdministrator: false,
			},
		);
		if (retry.outcome !== "accepted") throw new Error();
		expect(retry.writePlan.state).toMatchObject({
			status: "creating",
			revision: 3,
			workloadRevision: 2,
			fence: 2,
			desiredState: "running",
		});
		f.setManagement(retry.writePlan.state);
		await f.tick(1);
		expect(f.state).toMatchObject({
			phase: "preflight",
			sourceConfigurationRevision: configuration.revision,
			sourceLifecycleRevision: retry.writePlan.state.workloadRevision,
			candidate: { configuration, deployment: null },
		});
		await f.tick(1);
		expect(f.state?.phase).toBe("cleaning");
		expect(cleanup.record.lifecycleState).toBe("pending");
		expect(cleanup.claims).toBe(0);
		expect(cleanup.commits).toBe(0);
		expect(f.resources.size).toBe(0);
		expect(f.writes).toHaveLength(0);
	});

	it.each(["applying", "observed"] as const)(
		"keeps a preflight-rejected %s Secret fenced until a deployment exists",
		async (lifecycleState) => {
			const record = materializedSecretRecord(lifecycleState);
			const cleanup = secretCleanupStore(record);
			const f = fixture(
				{ registry: rejectedRegistry() },
				{
					configuration: secretConfiguration(),
					secrets: cleanupSecrets(cleanup),
				},
			);
			await f.tick(3);
			expect(f.state?.phase).toBe("cleaning");
			expect(cleanup.record.lifecycleState).toBe(lifecycleState);
			expect(f.resources.size).toBe(0);
		},
	);

	it.each([
		[
			"foreign",
			pendingSecretRecord({ ownerId: "owner-b" }),
			secretConfiguration(),
		],
		[
			"newer",
			pendingSecretRecord({ configRevision: 2 }),
			secretConfiguration(),
		],
		["stale", pendingSecretRecord(), secretConfiguration({ revision: 2 })],
	] as const)(
		"keeps a %s pending Secret fenced during rejected preflight",
		async (_condition, record, configuration) => {
			const cleanup = secretCleanupStore(record);
			const f = fixture(
				{ registry: rejectedRegistry() },
				{
					configuration,
					secrets: cleanupSecrets(cleanup),
				},
			);
			await f.tick(3);
			expect(f.state?.phase).toBe("cleaning");
			expect(cleanup.record.lifecycleState).toBe("pending");
			expect(f.resources.size).toBe(0);
		},
	);

	it("keeps an active-origin Secret fenced during rejected preflight", async () => {
		const record = activeSecretRecord();
		const cleanup = secretCleanupStore(record);
		const f = fixture(
			{ registry: rejectedRegistry() },
			{
				configuration: secretConfiguration({ revision: 2 }),
				secrets: cleanupSecrets(cleanup, "active-origin"),
			},
		);
		await f.tick(3);
		expect(f.state?.phase).toBe("cleaning");
		expect(cleanup.record.lifecycleState).toBe("active");
		expect(cleanup.claims).toBe(0);
		expect(cleanup.commits).toBe(0);
		expect(f.resources.size).toBe(0);
	});

	it.each(["NetworkPolicy", "ServiceAccount", "Service"])(
		"repairs a missing %s after readiness without promoting until the replacement is verified",
		async (kind) => {
			const f = fixture();
			await f.tick(8);
			expect(f.state?.phase).toBe("ready");
			const resource = [...f.resources.entries()].find(
				([_, object]) => object.kind === kind,
			);
			if (!resource) throw new Error();
			const pvc = [...f.resources.values()].find(
				(object) => object.kind === "PersistentVolumeClaim",
			);
			f.resources.delete(resource[0]);
			await f.tick(1);
			expect(f.state).toMatchObject({ phase: "applying", revision: 2 });
			await f.tick(7);
			expect(f.state?.phase).toBe("ready");
			expect(f.resources.has(resource[0])).toBe(true);
			expect(
				[...f.resources.values()].find(
					(object) => object.kind === "PersistentVolumeClaim",
				)?.metadata?.uid,
			).toBe(pvc?.metadata?.uid);
		},
	);
	it("keeps a core-compatible candidate available when optional capability probing has no valid result", async () => {
		const f = fixture({
			probeRuntime: async () => ({
				core: "passed",
				capabilities: { attachments: "unavailable" },
			}),
		});
		await f.tick(8);
		expect(f.state?.phase).toBe("ready");
		expect(Object.values(f.state?.capabilities ?? {})).toEqual([
			false,
			false,
			false,
			false,
			false,
		]);
	});
	it("uses RuntimeHost Fake HTTP capabilities and persists only the declared intersection across Worker restarts", async () => {
		const directory = await mkdtemp(join(tmpdir(), "workload-runtime-"));
		try {
			const host = await RuntimeHost.open({
				store: await FileRuntimeStore.open(join(directory, "host.json")),
				driver: await FakeRuntimeDriver.open(join(directory, "driver.json")),
				grantValidation: {
					expectedIssuer: "agent-platform",
					now: () => "2026-08-28T10:00:00Z",
				},
			});
			const app = createRuntimeHostApp({
				host,
				serviceToken: "synthetic-service-proof",
				verifyGrant: verificationForRuntimeGrant,
			});
			const f = fixture({
				fetch: (async (url, init) =>
					app.request(String(url), init)) as typeof fetch,
				async probeRuntime({ agentId, workloadRevision, baseUrl }) {
					const binding = {
						agentId,
						actorId: "worker-a",
						channelId: "web",
						conversationId: "probe",
						executionId: `probe-${workloadRevision}`,
						turnId: "probe",
						sessionGeneration: 1,
						traceId: "trace-a",
					};
					const response = await app.request(
						`${baseUrl}/internal/runtime/v1/capabilities`,
						{
							method: "POST",
							headers: {
								authorization: "Bearer synthetic-service-proof",
								"content-type": "application/json",
							},
							body: JSON.stringify({
								schemaVersion: 1,
								...binding,
								requestId: "probe-a",
								deliveryFence: 1,
								grant: runtimeGrantFixture(binding, ["capabilities.read"]),
							}),
						},
					);
					expect(response.status).toBe(200);
					return {
						core: "passed",
						capabilities: RuntimeCapabilitiesResponseV1Schema.parse(
							await response.json(),
						).capabilities,
					};
				},
			});
			await f.tick(8);
			expect(f.state?.phase).toBe("ready");
			expect(f.state?.capabilities).toMatchObject({
				modelSelection: true,
				attachments: true,
				connection: false,
				resultFiles: false,
			});
			expect(
				[...f.resources.values()].filter(
					(resource) => resource.kind === "Ingress",
				),
			).toHaveLength(0);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("closes and cleans a candidate whose Runtime core probe fails", async () => {
		const f = fixture({
			probeRuntime: async () => ({ core: "failed", capabilities: {} }),
		});
		await f.tick(10);
		expect(f.state?.phase).toBe("failed");
		expect(f.resources.size).toBe(0);
	});
	it("removes delayed resource writes even after creation failure was persisted", async () => {
		const f = fixture({
			probeRuntime: async () => ({ core: "failed", capabilities: {} }),
		});
		await f.tick(4);
		const remnants = new Map(f.resources);
		await f.tick(6);
		expect(f.state?.phase).toBe("failed");
		expect(f.resources.size).toBe(0);
		for (const [key, object] of remnants) f.resources.set(key, object);
		await f.tick(1);
		expect(f.state?.phase).toBe("failed");
		expect(f.resources.size).toBe(0);
	});
	it("cleans the same UID after an uncommitted generation change", async () => {
		const f = fixture({
			probeRuntime: async () => ({ core: "failed", capabilities: {} }),
		});
		await f.tick(5);
		expect(f.state?.phase).toBe("cleaning");
		for (const [key, object] of f.resources) {
			if (object.kind === "StatefulSet" && object.metadata)
				f.resources.set(key, {
					...object,
					metadata: { ...object.metadata, generation: 2 },
				});
		}
		await f.tick(1);
		expect(f.state?.phase).toBe("failed");
		expect(f.resources.size).toBe(0);
	});
	it("does not clean a replacement UID or a newer resource revision", async () => {
		for (const metadata of [
			{ uid: "replacement" },
			{ labels: { "agent-infra.agora.io/revision": "2" } },
		]) {
			const f = fixture({
				probeRuntime: async () => ({ core: "failed", capabilities: {} }),
			});
			await f.tick(5);
			for (const [key, object] of f.resources) {
				if (object.kind === "StatefulSet" && object.metadata)
					f.resources.set(key, {
						...object,
						metadata: {
							...object.metadata,
							...metadata,
							labels: { ...object.metadata.labels, ...metadata.labels },
						},
					});
			}
			await f.tick(1);
			expect(f.state?.phase).toBe("cleaning");
			expect(
				[...f.resources.values()].some(
					(object) => object.kind === "StatefulSet",
				),
			).toBe(true);
		}
	});
	it("uses a fixed origin and disables redirects for image-declared health paths", async () => {
		const fetcher = vi.fn(async () => new Response("", { status: 503 }));
		const probe = vi.fn(async () => ({
			core: "passed" as const,
			capabilities: {},
		}));
		const f = fixture({ fetch: fetcher, probeRuntime: probe });
		await f.tick(5);
		expect(fetcher).toHaveBeenCalledWith(
			expect.stringMatching(
				/^http:\/\/agent-[a-f0-9]+-probe\.workload-test\.svc:8080\/healthz$/,
			),
			expect.objectContaining({
				redirect: "error",
				signal: expect.any(AbortSignal),
			}),
		);
		expect(probe).not.toHaveBeenCalled();
		expect(f.state?.phase).toBe("cleaning");
	});
});
