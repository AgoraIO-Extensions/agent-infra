import {
	type AgentWorkloadDesiredV1,
	type PlatformSecretRecordV1,
	RuntimeCapabilitySetV1Schema,
	validateAgentWorkloadDesiredV1,
	validateImageRegistryAdmissionResultV1,
	validatePlatformSecretRecordV1,
} from "@agent-infra/contracts/workload";
import type { ImageRegistryAdapterV1 } from "@agent-infra/image-registry";
import {
	cleanupUnactivatedSecretCandidateV1,
	createSecretActivationUseCaseV1,
	immutableSecretNameV1,
	type SecretActivationDecryptorPortV1,
	type SecretActivationReferenceV1,
	type WorkloadReconciliationInputV1,
	type WorkloadReconciliationStateV1,
	type WorkloadRuntimePortV1,
	type WorkloadSecretBindingV1,
} from "@agent-infra/platform-core";
import type { V1StatefulSet } from "@kubernetes/client-node";
import type { WorkerKubernetesClientV1 } from "./kubernetes-client.js";
import {
	createKubernetesRuntimeAdapterV1,
	type KubernetesWorkloadPolicyV1,
	workloadResourceNameV1,
} from "./kubernetes-runtime-adapter.js";

export interface WorkloadRuntimeOptionsV1 {
	readonly workerId: string;
	readonly client: WorkerKubernetesClientV1;
	readonly policy: KubernetesWorkloadPolicyV1;
	readonly registry: ImageRegistryAdapterV1;
	readonly admissionPolicyRef: string;
	readonly registrySubjectRef: string;
	readonly decryptor: SecretActivationDecryptorPortV1;
	readonly fetch?: typeof fetch;
	readonly probeRuntime: (input: {
		readonly agentId: string;
		readonly workloadRevision: number;
		readonly baseUrl: string;
		readonly manifest: AgentWorkloadDesiredV1["runtimeManifest"];
		readonly signal: AbortSignal;
	}) => Promise<{
		readonly core: "passed" | "failed";
		readonly capabilities: unknown;
	}>;
}

function recordReference(
	record: PlatformSecretRecordV1,
): SecretActivationReferenceV1 {
	return {
		schemaVersion: 1,
		ownerType: record.ownerType,
		ownerId: record.ownerId,
		agentId: record.agentId,
		secretId: record.secretId,
		secretVersion: record.secretVersion,
		configRevision: record.configRevision,
		algorithmVersion: record.crypto.algorithmVersion,
		wrappingAlgorithmVersion: record.crypto.wrappingAlgorithmVersion,
		wrappingKeyVersion: record.crypto.wrappingKeyVersion,
		name: immutableSecretNameV1({
			...record,
			wrappingKeyVersion: record.crypto.wrappingKeyVersion,
			encryptedRecord: record,
			failureRetryable: null,
		}),
	};
}

function referencesMatch(
	expected: SecretActivationReferenceV1,
	actual: SecretActivationReferenceV1,
): boolean {
	return (
		expected.schemaVersion === actual.schemaVersion &&
		expected.ownerType === actual.ownerType &&
		expected.ownerId === actual.ownerId &&
		expected.agentId === actual.agentId &&
		expected.secretId === actual.secretId &&
		expected.secretVersion === actual.secretVersion &&
		expected.configRevision === actual.configRevision &&
		expected.algorithmVersion === actual.algorithmVersion &&
		expected.wrappingAlgorithmVersion === actual.wrappingAlgorithmVersion &&
		expected.wrappingKeyVersion === actual.wrappingKeyVersion &&
		expected.name === actual.name
	);
}

function cleanupActivationFence(
	record: PlatformSecretRecordV1,
	reference: SecretActivationReferenceV1,
) {
	if (record.lifecycleState === "pending") return undefined;
	if (
		record.lifecycleState !== "applying" &&
		record.lifecycleState !== "observed"
	)
		return null;
	const { kubernetesSecretRef, activationFence } = record;
	if (
		!referencesMatch(reference, kubernetesSecretRef) ||
		activationFence.agentId !== reference.agentId ||
		activationFence.secretId !== reference.secretId ||
		activationFence.secretVersion !== reference.secretVersion ||
		activationFence.configRevision !== reference.configRevision ||
		activationFence.kubernetesSecretName !== reference.name
	)
		return null;
	return activationFence;
}

function expectedSecrets(state: WorkloadReconciliationStateV1): readonly {
	readonly secretId: string;
	readonly version: number;
	readonly name: string;
}[] {
	const configuration = state.candidate.configuration;
	return [
		...configuration.secrets
			.filter((secret) => secret.isSet)
			.map((secret) => ({
				secretId: secret.secretId,
				version: secret.version,
				name: secret.name,
			})),
		...(configuration.modelConfiguration?.options
			.filter((option) => option.credential.isSet)
			.map((option) => ({
				secretId: option.credential.secretId,
				version: option.credential.version,
				name: `model:${option.optionId}`,
			})) ?? []),
	];
}

type ResolvedWorkloadSecretBindingV1 = {
	readonly materialization: WorkloadSecretBindingV1["materialization"];
	readonly record: PlatformSecretRecordV1;
};

function bindingsFor(
	state: WorkloadReconciliationStateV1,
	input: WorkloadReconciliationInputV1,
): ResolvedWorkloadSecretBindingV1[] {
	const configuration = state.candidate.configuration;
	const expected = expectedSecrets(state);
	const bindings = (input.secrets?.bindings ?? []).map(
		({ materialization, record }) => ({
			materialization,
			record: validatePlatformSecretRecordV1(record),
		}),
	);
	return [
		...new Map(
			expected.map((secret) => {
				const matches = bindings.filter(
					({ record }) =>
						record.agentId === state.agentId &&
						record.secretId === secret.secretId &&
						record.secretVersion === secret.version &&
						record.name === secret.name,
				);
				if (matches.length !== 1)
					throw new Error("Workload Secret is unavailable");
				const binding = matches[0];
				if (!binding) throw new Error("Workload Secret is unavailable");
				const record = binding.record;
				if (
					(binding.materialization === "current" &&
						record.configRevision !== configuration.revision) ||
					(binding.materialization === "active-origin" &&
						(record.configRevision >= configuration.revision ||
							record.lifecycleState !== "active"))
				)
					throw new Error("Workload Secret is unavailable");
				return [
					`${record.secretId}:${record.secretVersion}:${record.name}`,
					{ ...binding, record },
				] as const;
			}),
		).values(),
	];
}

export function createWorkloadRuntimeV1(
	options: WorkloadRuntimeOptionsV1,
): WorkloadRuntimePortV1 {
	const fetcher = options.fetch ?? globalThis.fetch;
	const observedCapabilities = new Map<string, Record<string, boolean>>();
	const adapter = createKubernetesRuntimeAdapterV1({
		client: options.client,
		policy: options.policy,
		async probe({ desired, serviceOrigin }) {
			const baseUrl = serviceOrigin;
			const response = await fetcher(`${baseUrl}${desired.health.path}`, {
				redirect: "error",
				signal: AbortSignal.timeout(desired.health.timeoutSeconds * 1000),
			});
			await response.body?.cancel();
			if (!response.ok) return false;
			if (desired.runtimeManifest.interactionMode === "self-managed") {
				observedCapabilities.set(
					`${desired.agentId}:${desired.workloadRevision}`,
					RuntimeCapabilitySetV1Schema.parse({}),
				);
				return true;
			}
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 10_000);
			let probe: Awaited<ReturnType<WorkloadRuntimeOptionsV1["probeRuntime"]>>;
			try {
				probe = await Promise.race([
					options.probeRuntime({
						agentId: desired.agentId,
						workloadRevision: desired.workloadRevision,
						baseUrl,
						manifest: desired.runtimeManifest,
						signal: controller.signal,
					}),
					new Promise<never>((_resolve, reject) =>
						controller.signal.addEventListener(
							"abort",
							() => reject(new Error("Runtime probe timed out")),
							{ once: true },
						),
					),
				]);
			} finally {
				clearTimeout(timer);
			}
			const optional = RuntimeCapabilitySetV1Schema.safeParse(
				probe.capabilities,
			);
			const detected = optional.success
				? optional.data
				: RuntimeCapabilitySetV1Schema.parse({});
			const declared = RuntimeCapabilitySetV1Schema.parse(
				desired.runtimeManifest.capabilities ?? {},
			);
			observedCapabilities.set(
				`${desired.agentId}:${desired.workloadRevision}`,
				Object.fromEntries(
					Object.entries(declared).map(([name, value]) => [
						name,
						value && detected[name as keyof typeof detected],
					]),
				),
			);
			return probe.core === "passed";
		},
	});
	function desired(
		state: WorkloadReconciliationStateV1,
		stopped = false,
	): AgentWorkloadDesiredV1 {
		const deployment = validateAgentWorkloadDesiredV1(
			state.candidate.deployment,
		);
		if (
			deployment.agentId !== state.agentId ||
			deployment.configRevision !== state.candidate.configuration.revision ||
			deployment.imageDigest !==
				state.candidate.configuration.source.imageDigest
		)
			throw new Error("Workload deployment correlation mismatch");
		if (state.phase === "rejected")
			return validateAgentWorkloadDesiredV1({
				...deployment,
				workloadRevision: state.verifiedRevision,
				fence: state.verifiedRevision,
				expectedWorkload: state.identity
					? {
							state: "present",
							workloadUid: state.identity.uid,
							workloadGeneration: state.identity.generation,
						}
					: { state: "absent" },
			});
		return validateAgentWorkloadDesiredV1({
			...deployment,
			workloadRevision: state.revision,
			fence: state.revision,
			desiredState: stopped ? "stopped" : "running",
			replicas: stopped ? 0 : 1,
			expectedWorkload: state.identity
				? {
						state: "present",
						workloadUid: state.identity.uid,
						workloadGeneration: state.identity.generation,
					}
				: { state: "absent" },
		});
	}
	async function cleanupUnactivatedSecrets(
		state: WorkloadReconciliationStateV1,
		input: WorkloadReconciliationInputV1,
	): Promise<boolean> {
		const bindings = bindingsFor(state, input).filter(
			({ materialization, record }) =>
				materialization === "current" &&
				["pending", "applying", "observed"].includes(record.lifecycleState),
		);
		if (!bindings.length) return true;
		if (!input.secrets) return false;
		if (state.candidate.deployment === null) {
			if (bindings.some(({ record }) => record.lifecycleState !== "pending"))
				return false;
			for (const { record } of bindings) {
				const removed = await cleanupUnactivatedSecretCandidateV1(
					{
						store: input.secrets.store,
						kubernetes: {
							async removeCandidate(candidate) {
								return (
									candidate.agentId === record.agentId &&
									candidate.secretId === record.secretId &&
									candidate.secretVersion === record.secretVersion &&
									candidate.configRevision === record.configRevision &&
									candidate.ownerType === record.ownerType &&
									candidate.ownerId === record.ownerId &&
									candidate.name === record.name &&
									candidate.wrappingKeyVersion ===
										record.crypto.wrappingKeyVersion &&
									candidate.lifecycleState === "pending"
								);
							},
						},
					},
					{
						schemaVersion: 1,
						agentId: record.agentId,
						secretId: record.secretId,
						secretVersion: record.secretVersion,
						configRevision: record.configRevision,
						ownerType: record.ownerType,
						ownerId: record.ownerId,
						name: record.name,
						wrappingKeyVersion: record.crypto.wrappingKeyVersion,
						workerId: options.workerId,
						traceId: input.traceId,
					},
				);
				if (!removed) return false;
			}
			return true;
		}
		const workload = desired(state);
		for (const { record } of bindings) {
			const reference = recordReference(record);
			const activationFence = cleanupActivationFence(record, reference);
			if (activationFence === null) return false;
			const removed = await cleanupUnactivatedSecretCandidateV1(
				{
					store: input.secrets.store,
					kubernetes: {
						async removeCandidate(candidate) {
							if (
								candidate.agentId !== record.agentId ||
								candidate.secretId !== record.secretId ||
								candidate.secretVersion !== record.secretVersion ||
								candidate.configRevision !== record.configRevision ||
								candidate.ownerType !== record.ownerType ||
								candidate.ownerId !== record.ownerId ||
								candidate.name !== record.name ||
								candidate.wrappingKeyVersion !==
									record.crypto.wrappingKeyVersion ||
								candidate.lifecycleState !== record.lifecycleState
							)
								return false;
							return adapter.removeImmutableSecret(
								workload,
								reference,
								activationFence,
							);
						},
					},
				},
				{
					schemaVersion: 1,
					agentId: record.agentId,
					secretId: record.secretId,
					secretVersion: record.secretVersion,
					configRevision: record.configRevision,
					ownerType: record.ownerType,
					ownerId: record.ownerId,
					name: record.name,
					wrappingKeyVersion: record.crypto.wrappingKeyVersion,
					workerId: options.workerId,
					traceId: input.traceId,
				},
			);
			if (!removed) return false;
		}
		return true;
	}
	return {
		async capabilities(state) {
			const capabilities = observedCapabilities.get(
				`${state.agentId}:${state.revision}`,
			);
			if (!capabilities)
				throw new Error("Runtime capabilities are unavailable");
			observedCapabilities.delete(`${state.agentId}:${state.revision}`);
			return capabilities;
		},
		async preflight(input, state) {
			const configuration = state.candidate.configuration;
			const request = {
				schemaVersion: 1 as const,
				requestId: input.requestId,
				traceId: input.traceId,
				subjectRef: options.registrySubjectRef,
				agentId: state.agentId,
				imageReference: `${options.policy.imageRepository}@${configuration.source.imageDigest}`,
				usage:
					configuration.source.kind === "standard"
						? ("standard-template" as const)
						: ("custom-agent" as const),
				admissionPolicyRef: options.admissionPolicyRef,
			};
			const admission = validateImageRegistryAdmissionResultV1(
				request,
				await options.registry.admit(request),
			);
			if (
				admission.status !== "admitted" ||
				admission.immutableDigest !== configuration.source.imageDigest
			)
				throw new Error("Workload admission rejected");
			const mode =
				configuration.source.kind === "standard"
					? "platform-adapter"
					: configuration.source.interactionMode;
			if (admission.runtimeManifest.interactionMode !== mode)
				throw new Error("Workload interaction mode rejected");
			const secretBindings = bindingsFor(state, input);
			const name = workloadResourceNameV1(state.agentId);
			const exposure =
				mode === "platform-adapter"
					? "internal-only"
					: configuration.source.kind === "custom" &&
							configuration.source.identityResponsibility === "platform-managed"
						? "platform-auth"
						: "self-managed";
			const deployment = validateAgentWorkloadDesiredV1({
				schemaVersion: 1,
				requestId: input.requestId,
				traceId: input.traceId,
				agentId: state.agentId,
				configRevision: configuration.revision,
				workloadRevision: state.revision,
				fence: state.revision,
				expectedWorkload: state.identity
					? {
							state: "present",
							workloadUid: state.identity.uid,
							workloadGeneration: state.identity.generation,
						}
					: { state: "absent" },
				namespaceRef: options.policy.namespaceRef,
				imageDigest: configuration.source.imageDigest,
				registryAdmission: {
					schemaVersion: 1,
					immutableDigest: admission.immutableDigest,
					runtimeManifest: admission.runtimeManifest,
					policyEvidence: admission.policyEvidence,
					runtimeManifestParsingEvidence:
						admission.runtimeManifestParsingEvidence,
				},
				runtimeManifest: admission.runtimeManifest,
				resourceProfileRef: options.policy.resourceProfileRef,
				env: Object.fromEntries(
					configuration.environment.map((entry) => [entry.name, entry.value]),
				),
				service: { name, port: admission.runtimeManifest.service.port },
				health: {
					path: admission.runtimeManifest.health.path,
					timeoutSeconds: 5,
					failureThreshold: 3,
				},
				persistentVolume: {
					name: `${name}-data`,
					mountPath: "/workspace",
					storageProfileRef: options.policy.storageProfileRef,
					accessMode: "ReadWriteOnce",
					retention: "retain",
				},
				serviceAccount: { name, kubernetesApiAccess: false },
				networkPolicy: {
					deploymentPolicyRef: options.policy.networkPolicyRef,
					ingressMode:
						exposure === "internal-only"
							? "runtime-host-client-only"
							: exposure === "platform-auth"
								? "platform-auth-route"
								: "self-managed-route",
					kubernetesApiAccess: false,
					platformDatabaseAccess: false,
					connectionDatabaseAccess: false,
					decryptionKeyringAccess: false,
				},
				route: { name, exposure, tlsRequired: true },
				secretRefs: secretBindings.map(({ record }) => recordReference(record)),
				desiredState: "running",
				replicas: 1,
			});
			return { configuration, deployment };
		},
		async closeRoute(state) {
			if (!(await adapter.closeAgent(state.agentId, state.revision)))
				throw new Error("Workload route is closing");
		},
		async apply(state, stopped, input) {
			if (stopped) return adapter.scaleDownAgent(state.agentId, state.revision);
			const workload = desired(state);
			for (const { materialization, record } of bindingsFor(state, input)) {
				if (materialization === "active-origin") continue;
				const decryption = await options.decryptor.decrypt({
					encryptedRecord: record,
					traceId: input.traceId,
				});
				if (decryption.outcome !== "decrypted") {
					await input.secrets?.auditDecryption(
						record.secretId,
						record.crypto.wrappingKeyVersion,
						"rejected",
					);
					throw new Error("Workload Secret is unavailable");
				}
				try {
					await input.secrets?.auditDecryption(
						record.secretId,
						record.crypto.wrappingKeyVersion,
						"succeeded",
					);
					await adapter.applyImmutableSecret(
						workload,
						recordReference(record).name,
						record.name,
						decryption.plaintext,
					);
				} finally {
					decryption.plaintext.fill(0);
				}
			}
			const result = await adapter.reconcile(workload);
			return result.status === "applied"
				? { uid: result.workloadUid, generation: result.workloadGeneration }
				: "pending";
		},
		async observe(state) {
			return state.identity
				? adapter.observe(desired(state), state.identity)
				: "pending";
		},
		async activateSecrets(state, input) {
			const bindings = bindingsFor(state, input);
			if (!bindings.length) return "active";
			if (!input.secrets || !state.identity) return "failed";
			if (state.rollback)
				return bindings.every(
					({ record }) => record.lifecycleState === "active",
				)
					? "active"
					: "failed";
			const pending = bindings
				.filter(
					({ materialization, record }) =>
						materialization === "current" && record.lifecycleState !== "active",
				)
				.map(({ record }) => record);
			if (!pending.length) return "active";
			const workload = desired(state);
			const identity = state.identity;
			const activation = createSecretActivationUseCaseV1({
				store: input.secrets.store,
				decryptor: options.decryptor,
				kubernetes: {
					async applyCandidate(candidate) {
						await adapter.applyImmutableSecret(
							workload,
							candidate.kubernetesSecretRef.name,
							candidate.secretKey,
							candidate.plaintext,
						);
						await adapter.bindSecretFence(
							workload,
							identity,
							candidate.kubernetesSecretRef.name,
							candidate.fence,
						);
						return {
							outcome: "applied",
							workloadUid: identity.uid,
							workloadGeneration: identity.generation,
						};
					},
					async observeCandidate(candidate) {
						if (
							!(await adapter.observeSecretFence(
								workload,
								identity,
								candidate.kubernetesSecretRef.name,
								candidate.activationFence.fence,
							))
						)
							return { status: "pending" };
						return {
							schemaVersion: 1,
							status: "observed",
							kubernetesSecretRef: candidate.kubernetesSecretRef,
							activationFence: candidate.activationFence,
							health: "healthy",
						};
					},
				},
			});
			for (const record of pending) {
				const result = await activation.activate({
					schemaVersion: 1,
					agentId: state.agentId,
					secretId: record.secretId,
					secretVersion: record.secretVersion,
					configRevision: record.configRevision,
					workerId: options.workerId,
					traceId: input.traceId,
				});
				if (result.outcome === "failed" || result.outcome === "stale")
					return "failed";
				if (result.outcome !== "active") return "pending";
			}
			return "active";
		},
		async promote(state) {
			if (!state.identity) throw new Error();
			const workload = desired(state);
			const result = await adapter.switchRoute({
				schemaVersion: 1,
				requestId: workload.requestId,
				traceId: workload.traceId,
				agentId: workload.agentId,
				fence: workload.fence,
				action: "promote",
				candidateValidated: true,
				candidateRoute: {
					routeRef: workload.route.name,
					workloadUid: state.identity.uid,
					workloadGeneration: state.identity.generation,
					workloadRevision: workload.workloadRevision,
				},
			});
			if (result.status !== "completed")
				throw new Error("Workload route is unavailable");
		},
		async cleanup(state, deleteNewVolume, input) {
			if (deleteNewVolume && !(await cleanupUnactivatedSecrets(state, input)))
				return false;
			let resourcesRemoved: boolean;
			if (state.identity) {
				// An apply can advance generation before its database step commits.
				// Refresh only this UID; cleanup still fences every resource revision.
				const current = await options.client.read<V1StatefulSet>(
					"StatefulSet",
					workloadResourceNameV1(state.agentId),
				);
				if (current && current.metadata?.uid !== state.identity.uid)
					return false;
				const result = await adapter.cleanup({
					schemaVersion: 1,
					requestId: `cleanup-${state.agentId}-${state.revision}`,
					traceId: `workload-${state.agentId}`,
					agentId: state.agentId,
					configRevision: state.candidate.configuration.revision,
					workloadRevision: state.revision,
					fence: state.revision,
					workloadUid: state.identity.uid,
					workloadGeneration:
						current?.metadata?.generation ?? state.identity.generation,
					persistentVolumeIntent: deleteNewVolume
						? "delete-new"
						: "retain-existing",
				});
				resourcesRemoved = result.status === "completed";
			} else {
				resourcesRemoved = await adapter.cleanupAgent(
					state.agentId,
					state.revision,
					deleteNewVolume,
				);
			}
			return resourcesRemoved;
		},
	};
}
