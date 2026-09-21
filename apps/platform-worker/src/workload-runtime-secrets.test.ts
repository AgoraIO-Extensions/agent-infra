import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import { FakeAgentManagementV1 } from "@agent-infra/platform-core/testing";
import type { V1Secret } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import { workloadTestPolicy } from "./kubernetes.fixture.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";
import { createWorkloadRuntimeV1 } from "./workload-runtime.js";
import {
	activeSecretRecord,
	cleanupSecrets,
	configurationFixture,
	fixture,
	materializedSecretRecord,
	modelCredentialEnvironmentKey,
	pendingSecretRecord,
	rejectedRegistry,
	secretCleanupStore,
	secretConfiguration,
	standardModelConfiguration,
} from "./workload-runtime-split.fixture.js";

describe("assembled Workload Runtime contracts", () => {
	it.each(["current", "active-origin"] as const)(
		"rejects mismatched persisted active Secret names for %s bindings",
		async (materialization) => {
			const record = activeSecretRecord();
			const cleanup = secretCleanupStore(record);
			const decrypt = vi.fn(async () => ({
				outcome: "decrypted" as const,
				plaintext: new Uint8Array([1, 2, 3]),
			}));
			const f = fixture(
				{ decryptor: { decrypt } },
				{
					configuration: secretConfiguration({
						revision: materialization === "current" ? 1 : 2,
					}),
					secrets: {
						bindings: [{ materialization, record }],
						store: cleanup.store,
						auditDecryption: vi.fn(async () => undefined),
					},
				},
			);
			await f.tick(2);
			const deployment = validateAgentWorkloadDesiredV1(
				f.state?.candidate.deployment,
			);
			const ref = deployment.secretRefs[0];
			if (!ref) throw new Error();
			expect(record.kubernetesSecretRef.name).not.toBe(ref.name);
			expect(record.activationFence.kubernetesSecretName).toBe(
				record.kubernetesSecretRef.name,
			);
			await f.tick(3);
			expect(decrypt).not.toHaveBeenCalled();
			expect(await f.client.read("Secret", ref.name)).toBeNull();
			expect(
				await f.client.read("StatefulSet", deployment.service.name),
			).toBeNull();
			expect(await f.client.read("Ingress", deployment.route.name)).toBeNull();
			expect(f.state?.phase).not.toBe("ready");
		},
	);

	it("rejects preflight when an explicit environment key shadows a Secret", async () => {
		const record = pendingSecretRecord();
		const cleanup = secretCleanupStore(record);
		const f = fixture(
			{},
			{
				configuration: secretConfiguration({
					environment: [{ name: "BOT_TOKEN", value: "shadowed" }],
				}),
				secrets: cleanupSecrets(cleanup),
			},
		);

		await f.tick(2);

		expect(f.state?.phase).toBe("cleaning");
		expect(f.state?.candidate.deployment).toBeNull();
		expect(f.resources.size).toBe(0);
	});

	it("rejects preflight when environment shadows a generated model credential key", async () => {
		const record = pendingSecretRecord({
			name: "model:primary",
			secretId: "model-secret-a",
		});
		const cleanup = secretCleanupStore(record);
		const f = fixture(
			{},
			{
				configuration: standardModelConfiguration({
					environment: [
						{ name: modelCredentialEnvironmentKey, value: "shadowed" },
					],
				}),
				secrets: cleanupSecrets(cleanup),
			},
		);

		await f.tick(2);

		expect(f.state?.phase).toBe("cleaning");
		expect(f.state?.candidate.deployment).toBeNull();
		expect(f.resources.size).toBe(0);
	});

	it("rejects preflight when Secret bindings produce the same data key", async () => {
		const ordinaryRecord = pendingSecretRecord({
			name: modelCredentialEnvironmentKey,
			secretId: "owner-secret-a",
		});
		const modelRecord = pendingSecretRecord({
			name: "model:primary",
			secretId: "model-secret-a",
		});
		const cleanup = secretCleanupStore(ordinaryRecord);
		const f = fixture(
			{},
			{
				configuration: standardModelConfiguration({
					secrets: [
						{
							name: modelCredentialEnvironmentKey,
							secretId: "owner-secret-a",
							version: 1,
							isSet: true,
						},
					],
				}),
				secrets: {
					bindings: [
						{ materialization: "current", record: ordinaryRecord },
						{ materialization: "current", record: modelRecord },
					],
					store: cleanup.store,
					async auditDecryption() {},
				},
			},
		);

		await f.tick(2);

		expect(f.state?.phase).toBe("cleaning");
		expect(f.state?.candidate.deployment).toBeNull();
		expect(f.resources.size).toBe(0);
	});

	it("materializes model credentials under stable environment keys", async () => {
		const optionId = "model:primary/with punctuation";
		const name = `model:${optionId}`;
		const record = pendingSecretRecord({ name, secretId: "model-secret-a" });
		const configuration = configurationFixture({
			modelConfiguration: {
				catalogRevision: "catalog-a",
				options: [
					{
						optionId,
						endpointId: "endpoint-a",
						modelId: "model-a",
						reasoningLevels: ["medium"],
						credential: {
							secretId: record.secretId,
							version: record.secretVersion,
							isSet: true,
						},
					},
				],
				defaultOptionId: optionId,
				defaultReasoningLevel: "medium",
			},
		});
		const cleanup = secretCleanupStore(record);
		const f = fixture(
			{
				decryptor: {
					decrypt: async () => ({
						outcome: "decrypted" as const,
						plaintext: new Uint8Array([1, 2, 3]),
					}),
				},
			},
			{
				configuration,
				secrets: {
					bindings: [{ materialization: "current", record }],
					store: cleanup.store,
					async auditDecryption() {},
				},
			},
		);

		await f.tick(4);
		const secret = [...f.resources.values()].find(
			(object): object is V1Secret => object.kind === "Secret",
		);
		const keys = Object.keys(secret?.data ?? {});
		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatch(/^MODEL_CREDENTIAL_[A-F0-9]{64}$/);
	});

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
		await f.tick(2);
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

	it.each(["pending", "active"] as const)(
		"discards only unactivated candidates before rollback (%s)",
		async (lifecycle) => {
			const cleanup = secretCleanupStore(
				lifecycle === "pending" ? pendingSecretRecord() : activeSecretRecord(),
			);
			const configuration = secretConfiguration();
			const secrets = cleanupSecrets(cleanup);
			const f = fixture(
				{
					decryptor: {
						decrypt: async () => ({
							outcome: "decrypted",
							plaintext: new Uint8Array([1, 2, 3]),
						}),
					},
				},
				{ configuration, secrets },
			);
			await f.tick(lifecycle === "active" ? 2 : 4);
			const state = f.state;
			if (!state?.candidate.deployment) throw new Error();
			const deployment = validateAgentWorkloadDesiredV1(
				state.candidate.deployment,
			);
			const ref = deployment.secretRefs[0];
			if (!ref) throw new Error();
			if (lifecycle === "active") {
				const adapter = createKubernetesRuntimeAdapterV1({
					client: f.client,
					policy: workloadTestPolicy,
					probe: async () => true,
				});
				await adapter.applyImmutableSecret(
					deployment,
					ref.name,
					"BOT_TOKEN",
					new Uint8Array([1, 2, 3]),
				);
				await adapter.apply(deployment);
			}
			const before = structuredClone([...f.resources.entries()]);
			expect(before.some(([key]) => key.startsWith("StatefulSet/"))).toBe(true);
			expect(
				before.some(([key]) => key.startsWith("PersistentVolumeClaim/")),
			).toBe(true);
			const result = await createWorkloadRuntimeV1(
				f.options,
			).discardUnactivatedSecrets(state, {
				state,
				configuration,
				management: f.management,
				secrets,
				requestId: "discard-a",
				traceId: "discard-a",
			});
			expect(result).toBe(true);
			expect([...f.resources.entries()]).toEqual(
				lifecycle === "active"
					? before
					: before.filter(([key]) => key !== `Secret/${ref.name}`),
			);
			expect(cleanup.record.lifecycleState).toBe(
				lifecycle === "active" ? "active" : "failed",
			);
		},
	);
});
