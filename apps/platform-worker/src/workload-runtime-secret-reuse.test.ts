import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import {
	createDeploymentModelCatalogAdapterV1,
	createFakeModelAccessValidatorV1,
	validateRuntimeModelProjectionV1,
} from "@agent-infra/model-catalog";
import { FakeAgentManagementV1 } from "@agent-infra/platform-core/testing";
import type { V1Pod, V1Secret, V1StatefulSet } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import { catalogFixture } from "../../../packages/model-catalog/src/catalog.fixture.js";
import { workloadTestPolicy } from "./kubernetes.fixture.js";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";
import {
	activeSecretRecord,
	fixture,
	modelCredentialEnvironmentKey,
	secretCleanupStore,
	secretConfiguration,
	standardModelConfiguration,
	validateActiveSecretRecordV1,
} from "./workload-runtime-split.fixture.js";

describe("assembled Workload Runtime contracts", () => {
	const secretReuseScenarios: readonly {
		label: string;
		binding?:
			| "bound"
			| "legacy missing UID"
			| "missing Secret"
			| "recreated UID"
			| "missing Secret after CAS retry";
		standard?: boolean;
		recovery?: {
			secretDrift?: "missing" | "uid";
			restartAgain?: boolean;
			changeConfiguration?: boolean;
			lostReceiptKind?: "Secret" | "StatefulSet";
			stop?: "before" | "after";
			failHealth?: boolean;
			revokedOwner?: boolean;
		};
	}[] = [
		{ label: "bound", binding: "bound" },
		{ label: "legacy missing UID", binding: "legacy missing UID" },
		{ label: "missing Secret", binding: "missing Secret" },
		{ label: "recreated UID", binding: "recreated UID" },
		{
			label: "missing Secret after CAS retry",
			binding: "missing Secret after CAS retry",
		},
		{ label: "missing Workload", recovery: {} },
		{
			label: "missing Workload then Secret disappears",
			recovery: { secretDrift: "missing" },
		},
		{
			label: "missing Workload then Secret UID changes",
			recovery: { secretDrift: "uid" },
		},
		{
			label: "missing Workload then another restart",
			recovery: { restartAgain: true },
		},
		{
			label: "missing Workload then configuration changes",
			recovery: { changeConfiguration: true },
		},
		{
			label: "missing Workload with lost Secret create receipt",
			recovery: { lostReceiptKind: "Secret" },
		},
		{
			label: "missing Workload with lost Workload create receipt",
			recovery: { lostReceiptKind: "StatefulSet" },
		},
		{
			label: "missing Workload stopped before creation",
			recovery: { stop: "before" },
		},
		{
			label: "missing Workload stopped after creation",
			recovery: { stop: "after" },
		},
		{
			label: "missing Workload with failed health",
			recovery: { failHealth: true },
		},
		{
			label: "missing Workload with revoked Owner",
			recovery: { revokedOwner: true },
		},
		{
			label: "missing Workload with model projection",
			standard: true,
			recovery: {},
		},
		{
			label:
				"missing Workload with model projection then configuration changes",
			standard: true,
			recovery: { changeConfiguration: true },
		},
		{
			label: "missing Workload with model projection and failed health",
			standard: true,
			recovery: { failHealth: true },
		},
		{
			label: "missing Workload with model projection stopped after creation",
			standard: true,
			recovery: { stop: "after" },
		},
	];

	it.each(
		(["current", "active-origin"] as const).flatMap((materialization) =>
			secretReuseScenarios.map((scenario) => ({
				materialization,
				...scenario,
			})),
		),
	)(
		"safely reuses an $materialization Secret with $label identity",
		async ({ materialization, binding, standard = false, recovery }) => {
			let currentMaterialization = materialization;
			const secretBytes = () =>
				standard
					? new TextEncoder().encode("synthetic-primary-credential")
					: new Uint8Array([1, 2, 3]);
			let record = activeSecretRecord(
				standard ? { name: "model:primary", secretId: "model-secret-a" } : {},
			);
			if (record.lifecycleState !== "active") throw new Error();
			const cleanup = secretCleanupStore(record);
			const decrypt = vi.fn(async () => ({
				outcome: "decrypted" as const,
				plaintext: secretBytes(),
			}));
			const audit = vi.fn(async () => undefined);
			const f = fixture(
				{
					decryptor: { decrypt },
					...(standard
						? {
								modelCatalog: createDeploymentModelCatalogAdapterV1({
									load: async () => catalogFixture(),
								}),
								modelAccess: createFakeModelAccessValidatorV1([
									{
										endpointId: "endpoint-a",
										modelId: "model-a",
										reasoningLevels: ["medium"],
										credential: "synthetic-primary-credential",
									},
								]),
							}
						: {}),
				},
				{
					configuration: (standard
						? standardModelConfiguration
						: secretConfiguration)({
						revision: materialization === "current" ? 1 : 2,
					}),
					secrets: {
						get bindings() {
							return [{ materialization: currentMaterialization, record }];
						},
						store: cleanup.store,
						auditDecryption: audit,
					},
				},
			);
			await f.tick(2);
			const deployment = validateAgentWorkloadDesiredV1(
				f.state?.candidate.deployment,
			);
			const ref = deployment.secretRefs[0];
			if (!ref) throw new Error();
			record = validateActiveSecretRecordV1({
				...record,
				kubernetesSecretRef: ref,
				activationFence: {
					...record.activationFence,
					kubernetesSecretName: ref.name,
				},
			});
			expect(record.kubernetesSecretRef).toEqual(ref);
			const adapter = createKubernetesRuntimeAdapterV1({
				client: f.client,
				policy: workloadTestPolicy,
				probe: async () => true,
				...(standard
					? {
							modelProjection: validateRuntimeModelProjectionV1(
								f.state?.candidate.modelProjection,
							),
						}
					: {}),
			});
			const secretUid = await adapter.applyImmutableSecret(
				deployment,
				ref.name,
				standard ? modelCredentialEnvironmentKey : "BOT_TOKEN",
				secretBytes(),
			);
			const identity = await adapter.apply(deployment);
			if (!identity || identity === "pending") throw new Error();
			record = validateActiveSecretRecordV1({
				...record,
				activationFence: {
					...record.activationFence,
					workloadUid: identity.uid,
					workloadGeneration: identity.generation,
				},
			});
			await adapter.bindSecretFence(
				deployment,
				identity,
				ref.name,
				record.activationFence.fence,
				secretUid,
			);

			const resourceKey = `StatefulSet/${deployment.service.name}`;
			const statefulSet = await f.client.read<V1StatefulSet>(
				"StatefulSet",
				deployment.service.name,
			);
			if (!statefulSet?.metadata?.annotations) throw new Error();
			const uidKey = Object.keys(statefulSet.metadata.annotations).find((key) =>
				key.startsWith("agent-infra.agora.io/secret-uid-"),
			);
			if (!uidKey) throw new Error();
			if (binding === "legacy missing UID") {
				delete statefulSet.metadata.annotations[uidKey];
				f.resources.set(resourceKey, statefulSet);
			}
			const recreated = binding === "recreated UID";
			const missing =
				binding === "missing Secret" ||
				binding === "missing Secret after CAS retry";
			let expectedUid = recreated ? "replacement-secret-uid" : secretUid;
			if (recreated) {
				const secret = await f.client.read<V1Secret>("Secret", ref.name);
				if (!secret) throw new Error();
				f.resources.set(`Secret/${ref.name}`, {
					...secret,
					metadata: { ...secret.metadata, uid: expectedUid },
				} as V1Secret);
			}
			if (missing) f.resources.delete(`Secret/${ref.name}`);
			if (recovery) {
				await f.tick(8);
				expect(f.state?.phase).toBe("ready");
				const originalSecret = await f.client.read<V1Secret>(
					"Secret",
					ref.name,
				);
				const originalVolume = await f.client.read(
					"PersistentVolumeClaim",
					deployment.persistentVolume.name,
				);
				const originalRecord = structuredClone(record);
				const originalSecrets = [...f.resources.entries()].filter(([key]) =>
					key.startsWith("Secret/"),
				);
				const unavailable = vi
					.spyOn(f.options.decryptor, "decrypt")
					.mockResolvedValue({
						outcome: "failed",
						code: "SECRET_KEY_UNAVAILABLE",
					});
				f.resources.delete(resourceKey);
				for (const key of f.resources.keys()) {
					if (key.startsWith("Pod/")) f.resources.delete(key);
				}
				await f.tick(24);
				expect(f.state?.phase).toBe("failed");
				expect(f.state?.identity).toBeNull();
				unavailable.mockImplementation(async () => ({
					outcome: "decrypted",
					plaintext: secretBytes(),
				}));
				const management = new FakeAgentManagementV1({
					states: [
						{
							...f.management,
							status: "available",
							revision: 2,
							serviceAvailability: "unavailable",
							failureCode: "health_check_failed",
						},
					],
				});
				const restart = await management.executeManagementCommand(
					{
						schemaVersion: 1,
						command: "restart_agent",
						agentId: "agent-a",
						expectedRevision: 2,
						idempotencyKey: "recover-original-workload",
						requestId: "request-recover-original-workload",
						traceId: "trace-recover-original-workload",
					},
					{
						schemaVersion: 1,
						userId: "owner-a",
						accountStatus: "active",
						organizationIds: [],
						isAdministrator: false,
					},
				);
				if (restart.outcome !== "accepted")
					throw new Error("Restart was not accepted");
				f.setManagement(restart.writePlan.state);
				let lostReceipt = false;
				if (recovery.lostReceiptKind) {
					const create = f.client.create.bind(f.client);
					vi.spyOn(f.client, "create").mockImplementation(async (object) => {
						const result = await create(object);
						if (
							!lostReceipt &&
							object.kind === recovery.lostReceiptKind &&
							object.metadata?.name !== ref.name
						) {
							lostReceipt = true;
							throw new WorkloadKubernetesError("unavailable");
						}
						return result;
					});
				}
				if (recovery.stop) {
					await f.until(
						(value) =>
							value?.phase === "applying" &&
							!!value.candidate.secretRecoveries?.length &&
							(recovery.stop === "before"
								? value.candidate.secretRecoveries.every(
										(recovery) => recovery.secretUid === null,
									)
								: !!value.candidate.secretRecoveries[0]?.identity),
					);
					const intent = f.state?.candidate.secretRecoveries?.[0];
					expect(intent).toBeDefined();
					if (recovery.stop === "before")
						expect(
							await f.client.read("Secret", intent?.reference.name ?? ""),
						).toBeNull();
					else expect(f.state?.identity?.uid).not.toBe(identity.uid);
					const stop = await management.executeManagementCommand(
						{
							schemaVersion: 1,
							command: "stop_agent",
							agentId: "agent-a",
							expectedRevision: restart.writePlan.state.revision,
							idempotencyKey: "stop-workload-recovery",
							requestId: "stop-workload-recovery",
							traceId: "stop-workload-recovery",
						},
						{
							schemaVersion: 1,
							userId: "owner-a",
							accountStatus: "active",
							organizationIds: [],
							isAdministrator: false,
						},
					);
					if (stop.outcome !== "accepted")
						throw new Error("Stop was not accepted");
					f.setManagement(stop.writePlan.state);
					await f.tick(20);
					expect(f.state?.phase).toBe("stopped");
					expect(f.state?.identity).toBeNull();
					expect(
						[...f.resources.entries()].filter(([key]) =>
							key.startsWith("Secret/"),
						),
					).toEqual(originalSecrets);
					expect(
						await f.client.read("StatefulSet", deployment.service.name),
					).toBeNull();
					expect(
						await f.client.read("Secret", intent?.reference.name ?? ""),
					).toBeNull();
					expect(await f.client.read("Secret", ref.name)).toEqual(
						originalSecret,
					);
					expect(
						(
							await f.client.read(
								"PersistentVolumeClaim",
								deployment.persistentVolume.name,
							)
						)?.metadata?.uid,
					).toBe(originalVolume?.metadata?.uid);
					return;
				}
				if (recovery.revokedOwner) {
					f.setManagement({ ...f.management, ownerIds: ["other-owner"] });
					unavailable.mockClear();
					await f.tick(24);
					expect(f.state?.phase).toBe("cleaning");
					expect(f.state?.cleanupInterrupted).toBe(true);
					expect(unavailable).not.toHaveBeenCalled();
					expect(
						await f.client.read("StatefulSet", deployment.service.name),
					).toBeNull();
					expect(await f.client.read("Secret", ref.name)).toEqual(
						originalSecret,
					);
					return;
				}
				if (recovery.failHealth) {
					const probe = vi
						.spyOn(f.options, "probeRuntime")
						.mockResolvedValue({ core: "failed", capabilities: {} });
					await f.tick(32);
					expect(f.state?.phase).toBe("failed");
					expect(
						await f.client.read("StatefulSet", deployment.service.name),
					).toBeNull();
					expect(
						[...f.resources.entries()].filter(([key]) =>
							key.startsWith("Secret/"),
						),
					).toEqual(originalSecrets);
					expect(
						(
							await f.client.read(
								"PersistentVolumeClaim",
								deployment.persistentVolume.name,
							)
						)?.metadata?.uid,
					).toBe(originalVolume?.metadata?.uid);
					probe.mockResolvedValue({ core: "passed", capabilities: {} });
					const retry = await management.executeManagementCommand(
						{
							schemaVersion: 1,
							command: "restart_agent",
							agentId: "agent-a",
							expectedRevision: restart.writePlan.state.revision,
							idempotencyKey: "retry-workload-recovery",
							requestId: "retry-workload-recovery",
							traceId: "retry-workload-recovery",
						},
						{
							schemaVersion: 1,
							userId: "owner-a",
							accountStatus: "active",
							organizationIds: [],
							isAdministrator: false,
						},
					);
					if (retry.outcome !== "accepted")
						throw new Error("Retry was not accepted");
					f.setManagement(retry.writePlan.state);
				}
				await f.tick(24);
				expect(f.state?.phase).toBe("ready");
				const recovered = f.state?.verified?.secretRecoveries?.[0];
				expect(recovered?.identity?.uid).toBe(f.state?.identity?.uid);
				expect(recovered?.identity?.uid).not.toBe(identity.uid);
				expect(recovered?.reference.name).not.toBe(ref.name);
				expect(recovered?.fence).toBe(f.management.fence);
				expect(await f.client.read<V1Secret>("Secret", ref.name)).toEqual(
					originalSecret,
				);
				expect(record).toEqual(originalRecord);
				const retainedVolume = await f.client.read(
					"PersistentVolumeClaim",
					deployment.persistentVolume.name,
				);
				expect(retainedVolume?.metadata?.uid).toBe(
					originalVolume?.metadata?.uid,
				);
				expect(cleanup.claims).toBe(0);
				expect(cleanup.commits).toBe(0);
				if (standard) {
					const projection = validateRuntimeModelProjectionV1(
						f.state?.verified?.modelProjection,
					);
					expect(projection.options[0]?.secretRef.name).toBe(
						recovered?.reference.name,
					);
					const pod = await f.client.read<V1Pod>(
						"Pod",
						`${deployment.service.name}-0`,
					);
					expect(
						pod?.spec?.containers[0]?.env?.some(
							(value) =>
								value.valueFrom?.secretKeyRef?.name ===
								recovered?.reference.name,
						),
					).toBe(true);
				}
				if (recovery.lostReceiptKind) {
					expect(lostReceipt).toBe(true);
					expect(
						[...f.resources.keys()].filter((key) => key.startsWith("Secret/")),
					).toHaveLength(2);
				}
				if (recovery.secretDrift) {
					if (!recovered) throw new Error();
					const current = await f.client.read<V1Secret>(
						"Secret",
						recovered.reference.name,
					);
					if (!current) throw new Error();
					if (recovery.secretDrift === "missing")
						f.resources.delete(`Secret/${recovered.reference.name}`);
					else
						f.resources.set(`Secret/${recovered.reference.name}`, {
							...current,
							metadata: {
								...current.metadata,
								uid: "recreated-recovery-secret",
							},
						});
					await f.tick(18);
					expect(f.state?.phase).toBe("ready");
					expect(f.state?.identity?.uid).toBe(recovered.identity?.uid);
					expect(f.state?.verified?.secretRecoveries?.[0]?.reference).toEqual(
						recovered.reference,
					);
					expect(f.state?.verified?.secretRecoveries?.[0]?.secretUid).not.toBe(
						recovered.secretUid,
					);
					expect(await f.client.read("Secret", ref.name)).toEqual(
						originalSecret,
					);
				}
				if (recovery.restartAgain) {
					const next = await management.executeManagementCommand(
						{
							schemaVersion: 1,
							command: "restart_agent",
							agentId: "agent-a",
							expectedRevision: restart.writePlan.state.revision,
							idempotencyKey: "restart-recovered-workload",
							requestId: "restart-recovered-workload",
							traceId: "restart-recovered-workload",
						},
						{
							schemaVersion: 1,
							userId: "owner-a",
							accountStatus: "active",
							organizationIds: [],
							isAdministrator: false,
						},
					);
					if (next.outcome !== "accepted") throw new Error();
					f.setManagement(next.writePlan.state);
					await f.tick(18);
					expect(f.state?.phase).toBe("ready");
					expect(f.state?.identity?.uid).toBe(recovered?.identity?.uid);
					expect(f.state?.verified?.secretRecoveries?.[0]?.reference).toEqual(
						recovered?.reference,
					);
					expect(f.state?.verified?.secretRecoveries?.[0]?.fence).toBe(
						recovered?.fence,
					);
				}
				if (recovery.changeConfiguration) {
					const previous = f.state?.verified?.configuration;
					if (!previous || !recovered) throw new Error();
					const next = {
						...previous,
						revision: previous.revision + 1,
						...(standard
							? {}
							: { environment: [{ name: "LOG_LEVEL", value: "debug" }] }),
					};
					currentMaterialization = "active-origin";
					f.setConfiguration(next);
					await f.tick(24);
					expect(f.state?.phase).toBe("ready");
					expect(f.state?.sourceConfigurationRevision).toBe(next.revision);
					expect(f.state?.verified?.configuration).toEqual(next);
					expect(f.state?.identity?.uid).toBe(recovered.identity?.uid);
					expect(f.state?.verified?.secretRecoveries?.[0]?.reference).toEqual(
						recovered.reference,
					);
					expect(f.state?.verified?.secretRecoveries?.[0]?.fence).toBe(
						recovered.fence,
					);
					expect(record).toEqual(originalRecord);
					expect(await f.client.read("Secret", ref.name)).toEqual(
						originalSecret,
					);
					if (standard) {
						const projection = validateRuntimeModelProjectionV1(
							f.state?.verified?.modelProjection,
						);
						expect(projection.options[0]?.secretRef.name).toBe(
							recovered.reference.name,
						);
					}
				}
				return;
			}
			let failedCas = false;
			if (binding === "missing Secret after CAS retry") {
				const replace = f.client.replace.bind(f.client);
				vi.spyOn(f.client, "replace").mockImplementation(async (object) => {
					const bindsReplacementUid = Object.entries(
						object.metadata?.annotations ?? {},
					).some(
						([key, value]) =>
							key.startsWith("agent-infra.agora.io/secret-uid-") &&
							value !== secretUid,
					);
					if (
						!failedCas &&
						object.kind === "StatefulSet" &&
						bindsReplacementUid
					) {
						failedCas = true;
						throw new WorkloadKubernetesError("conflict");
					}
					return replace(object);
				});
			}
			const before = structuredClone(record);

			await f.tick(8);
			expect(f.state?.phase).toBe("ready");
			if (missing) {
				const live = await f.client.read<V1Secret>("Secret", ref.name);
				if (!live?.metadata?.uid) throw new Error();
				expectedUid = live.metadata.uid;
			}
			expect(decrypt).toHaveBeenCalledTimes(
				binding === "bound"
					? 0
					: binding === "missing Secret after CAS retry"
						? 2
						: 1,
			);
			expect(failedCas).toBe(binding === "missing Secret after CAS retry");
			if (binding === "bound") expect(audit).not.toHaveBeenCalled();
			else expect(audit).toHaveBeenCalledWith("secret-a", "key-a", "succeeded");
			expect(
				(
					await f.client.read<V1StatefulSet>(
						"StatefulSet",
						deployment.service.name,
					)
				)?.metadata?.annotations?.[uidKey],
			).toBe(expectedUid);
			expect(record).toEqual(before);
			expect(cleanup.claims).toBe(0);
			expect(cleanup.commits).toBe(0);
			expect(record.kubernetesSecretRef).toEqual(ref);
			expect(record.activationFence.fence).toBe(1);
		},
	);
});
