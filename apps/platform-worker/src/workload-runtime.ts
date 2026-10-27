import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { discoverRuntimeBrowserCapabilityV1 } from "@agent-infra/agent-runtime";
import { MultiServiceManifestDocumentV1Schema } from "@agent-infra/contracts/pilot";
import {
	type BrowserCapabilityBindingV1,
	BrowserCapabilityProjectionV1Schema,
	RuntimeCapabilitiesV1Schema,
} from "@agent-infra/contracts/runtime";
import {
	type AgentWorkloadDesiredV1,
	type PlatformSecretRecordV1,
	RuntimeCapabilitySetV1Schema,
	resolveRuntimeManifestCapabilitiesV1,
	validateAgentWorkloadDesiredV1,
	validateImageRegistryAdmissionResultV1,
	validatePlatformSecretRecordV1,
} from "@agent-infra/contracts/workload";
import type { ImageRegistryAdapterV1 } from "@agent-infra/image-registry";
import {
	type ModelAccessValidatorV1,
	type ModelCatalogAdapterV1,
	ModelConfigurationErrorV1,
	projectRuntimeModelConfigurationV1,
	projectRuntimeModelConfigurationV4,
	revalidateRuntimeModelCatalogV1,
	revalidateRuntimeModelCatalogV4,
	type StandardTemplateModelBindingV1,
	standardTemplateModelBindingV1,
	validateRuntimeModelProjectionV1,
	validateRuntimeModelProjectionV4,
	validateStandardTemplateModelBindingsV1,
} from "@agent-infra/model-catalog";
import {
	cleanupUnactivatedSecretCandidateV1,
	createSecretActivationUseCaseV1,
	immutableSecretNameV1,
	parseWorkloadExecutionCapacityV1,
	type SecretActivationDecryptorPortV1,
	type SecretActivationReferenceV1,
	type WorkloadCapabilitiesV1,
	type WorkloadExecutionCapacityV1,
	WorkloadPreflightRejectedErrorV1,
	type WorkloadReconciliationInputV1,
	type WorkloadReconciliationStateV1,
	type WorkloadRuntimePortV1,
	type WorkloadSecretBindingV1,
} from "@agent-infra/platform-core";
import type { V1StatefulSet } from "@kubernetes/client-node";
import { parseAllDocuments } from "yaml";
import {
	type WorkerKubernetesClientV1,
	WorkloadKubernetesError,
} from "./kubernetes-client.js";
import {
	createKubernetesRuntimeAdapterV1,
	type KubernetesWorkloadPolicyV1,
	workloadResourceNameV1,
} from "./kubernetes-runtime-adapter.js";
import { createWorkloadInteractionOriginV1 } from "./kubernetes-runtime-policy.js";
import type { MultiServiceHealthDiagnosticV1 } from "./multi-service-runtime.js";
import {
	createMultiServiceRuntimeOperations,
	isMultiService,
} from "./multi-service-runtime.js";
import { runtimeFetch } from "./runtime-transport.js";
import {
	validateWorkloadSkillMaterializationV1,
	type WorkloadSkillMaterializationResultV1,
	type WorkloadSkillMaterializerV1,
} from "./skill-materialization.js";
import {
	isTransientProbeStatusV1,
	WorkloadProbeIncompleteErrorV1,
	workloadProbeIncompleteReasonV1,
} from "./workload-probe-failure.js";
import { WorkloadStepErrorV1 } from "./workload-step-failure.js";

export type WorkloadBrowserBindingResolverV1 = (input: {
	readonly agentId: string;
	readonly workloadRevision: number;
	readonly fence: number;
	readonly imageDigest: string;
	readonly manifest: AgentWorkloadDesiredV1["runtimeManifest"];
}) => BrowserCapabilityBindingV1 | undefined;

export interface WorkloadRuntimeOptionsV1 {
	readonly workerId: string;
	readonly client: WorkerKubernetesClientV1;
	readonly policy: KubernetesWorkloadPolicyV1;
	readonly registry: ImageRegistryAdapterV1;
	readonly admissionPolicyRef: string;
	readonly registrySubjectRef: string;
	/** Workload-only decryptor supports Store-authorized current and active-origin records. */
	readonly decryptor: SecretActivationDecryptorPortV1;
	readonly modelCatalog?: ModelCatalogAdapterV1;
	readonly modelAccess?: ModelAccessValidatorV1;
	/** Explicit trusted deployment rollout for keyless Codex configurations. */
	readonly runtimeModelVersion?: 4;
	/** Trusted template/digest profiles; an explicit empty list supports custom Agents only. */
	readonly templateModelBindings: readonly StandardTemplateModelBindingV1[];
	readonly executionCapacityProfiles?: readonly WorkloadExecutionCapacityV1[];
	/** Trusted deployment-owned fixed Skill materialization; failures reject preflight. */
	readonly skillMaterializer?: WorkloadSkillMaterializerV1;
	readonly fetch?: typeof fetch;
	/** Deployment-owned Session binding for the current Browser Sandbox. */
	readonly browserBinding?: WorkloadBrowserBindingResolverV1;
	/** Bounded multi-service health facts; recording is observational only. */
	readonly onHealthDiagnostic?: (
		diagnostic: MultiServiceHealthDiagnosticV1,
	) => void;
	readonly probeRuntime: (input: {
		readonly agentId: string;
		readonly workloadRevision: number;
		readonly baseUrl: string;
		readonly fence: number;
		readonly imageDigest: string;
		readonly manifest: AgentWorkloadDesiredV1["runtimeManifest"];
		readonly browserBinding?: {
			readonly agentId: string;
			readonly sessionId: string;
			readonly sessionGeneration: number;
			readonly resourceFence: number;
			readonly workloadRevision: number;
			readonly imageDigest: string;
		};
		readonly signal: AbortSignal;
	}) => Promise<{
		readonly core: "passed" | "failed";
		readonly capabilities: unknown;
	}>;
	/** Credential-free record of each failed Workload probe (#2046). */
	readonly onProbeFailure?: (failure: WorkloadProbeFailureV1) => void;
	/** Credential-free timing/count evidence for readiness CPU investigation (#3303). */
	readonly onProbe?: (observation: WorkloadProbeObservationV1) => void;
	/**
	 * 同一 Worker 进程内 Workload 监测与会话路由共享的 readiness 记录（#1889）。
	 * 未提供时每个实例使用自己的记录，只复用本实例最近一次完整探测的结果。
	 */
	readonly readinessLedger?: WorkloadReadinessLedgerV1;
}

/** 一次通过的签名 readiness 所绑定的实际 Workload（#1889）。 */
export interface WorkloadReadinessBindingV1 {
	readonly agentId: string;
	readonly workloadUid: string;
	readonly workloadGeneration: number;
	readonly workloadRevision: number;
	readonly fence: number;
}

export interface WorkloadReadinessPassV1 {
	readonly podUid: string;
	readonly passedAt: number;
}

function parseMultiServiceManifest(input: string) {
	const documents = parseAllDocuments(input, {
		prettyErrors: false,
		maxAliasCount: 0,
	} as never);
	if (documents.length !== 1 || documents[0]?.errors.length) throw new Error();
	return MultiServiceManifestDocumentV1Schema.parse(documents[0]?.toJSON());
}

/**
 * 记录每个 Agent 最近一次通过的签名 readiness 及其 Pod。每个 Agent 只保留一条，
 * Workload 绑定不一致即视为没有记录；任何一次未通过的观测都会清除该 Agent 的记录。
 */
export interface WorkloadReadinessLedgerV1 {
	record(
		binding: WorkloadReadinessBindingV1,
		pass: WorkloadReadinessPassV1,
	): void;
	lookup(
		binding: WorkloadReadinessBindingV1,
	): WorkloadReadinessPassV1 | undefined;
	forget(agentId: string): void;
}

export function createWorkloadReadinessLedgerV1(): WorkloadReadinessLedgerV1 {
	const entries = new Map<
		string,
		{
			readonly binding: WorkloadReadinessBindingV1;
			readonly pass: WorkloadReadinessPassV1;
		}
	>();
	return {
		record(binding, pass) {
			entries.set(binding.agentId, {
				binding: { ...binding },
				pass: { ...pass },
			});
		},
		lookup(binding) {
			const entry = entries.get(binding.agentId);
			return entry && isDeepStrictEqual(entry.binding, binding)
				? { ...entry.pass }
				: undefined;
		},
		forget(agentId) {
			entries.delete(agentId);
		},
	};
}

/**
 * 排空复用 readiness 的有效期：不超过一个 Workload 监测周期，与 Store
 * 默认 `monitorDelayMs`（30 s）一致。
 */
export const drainReadinessMaxAgeMs = 30_000;

export interface WorkloadProbeFailureV1 {
	readonly agentId: string;
	readonly workloadRevision: number;
	readonly stage: "health" | "readiness";
	/** `timeout`/`connection` never answered; `unavailable` answered 5xx;
	 * `response` answered unhealthy. */
	readonly reason: "timeout" | "connection" | "unavailable" | "response";
}

export interface WorkloadProbeObservationV1 {
	readonly agentId: string;
	readonly workloadRevision: number;
	readonly stage: "health" | "readiness";
	readonly outcome: "passed" | "failed" | "reused";
	readonly durationMs: number;
	readonly reason?: WorkloadProbeFailureV1["reason"];
}

export function workloadResourceConfigurationHashV1(
	policy: WorkloadRuntimeOptionsV1["policy"],
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				resourceProfileRef: policy.resourceProfileRef,
				requests: {
					cpu: policy.resources.requests.cpu,
					memory: policy.resources.requests.memory,
				},
				limits: {
					cpu: policy.resources.limits.cpu,
					memory: policy.resources.limits.memory,
				},
			}),
		)
		.digest("hex");
}

export function resolveWorkloadExecutionCapacityV1(
	options: Pick<
		WorkloadRuntimeOptionsV1,
		"policy" | "executionCapacityProfiles"
	>,
	imageDigest: string,
): WorkloadExecutionCapacityV1 | undefined {
	const profiles = options.executionCapacityProfiles ?? [];
	if (!Array.isArray(profiles))
		throw new TypeError("Workload execution capacity is invalid");
	const matches = profiles
		.map(parseWorkloadExecutionCapacityV1)
		.filter(
			(profile) =>
				profile.imageDigest === imageDigest &&
				profile.resourceProfileRef === options.policy.resourceProfileRef &&
				profile.resourceConfigurationHash ===
					workloadResourceConfigurationHashV1(options.policy),
		);
	if (matches.length > 1)
		throw new TypeError("Workload execution capacity is ambiguous");
	return matches[0];
}

/** Capacity approval can be withdrawn without preventing the original execution's controls. */
export function isWorkloadExecutionCapacityCurrentV1(
	options: Pick<
		WorkloadRuntimeOptionsV1,
		"policy" | "executionCapacityProfiles"
	>,
	state: WorkloadReconciliationStateV1,
): boolean {
	const persisted = state.verified?.executionCapacity;
	return (
		!!persisted &&
		isDeepStrictEqual(
			persisted,
			resolveWorkloadExecutionCapacityV1(
				options,
				state.verified?.configuration.source.imageDigest ?? "",
			),
		)
	);
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

function activeSecretFence(
	record: PlatformSecretRecordV1,
	reference: SecretActivationReferenceV1,
) {
	if (record.lifecycleState !== "active") return null;
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

function expectedSecrets(
	state: WorkloadReconciliationStateV1,
	keylessModel = false,
): readonly {
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
		...(keylessModel
			? []
			: configuration.schemaVersion === 2
				? (configuration.modelConfiguration?.options
						.filter((option) => option.credential.isSet)
						.map((option) => ({
							secretId: option.credential.secretId,
							version: option.credential.version,
							name: `model:${option.optionId}`,
						})) ?? [])
				: []),
	];
}

type ResolvedWorkloadSecretBindingV1 = {
	readonly materialization: WorkloadSecretBindingV1["materialization"];
	readonly record: PlatformSecretRecordV1;
};

function secretDataKey(name: string): string {
	if (!name.startsWith("model:")) return name;
	return `MODEL_CREDENTIAL_${createHash("sha256")
		.update(name)
		.digest("hex")
		.toUpperCase()}`;
}

function validateSecretDataKeys(
	configuration: WorkloadReconciliationStateV1["candidate"]["configuration"],
	bindings: readonly ResolvedWorkloadSecretBindingV1[],
): void {
	// Owner-supplied environment, including Secret-backed names, must not alter
	// the native loader before the trusted Runtime launcher can run. NODE_ENV is
	// an ordinary application setting and remains allowed.
	if (
		[
			...configuration.environment,
			...configuration.secrets,
			...bindings.map(({ record }) => record),
		].some(
			({ name }) =>
				name.startsWith("LD_") ||
				name.startsWith("DYLD_") ||
				[
					"NODE_OPTIONS",
					"NODE_DEBUG",
					"NODE_DEBUG_NATIVE",
					"NODE_V8_COVERAGE",
					"NODE_PATH",
					"PATH",
				].includes(name),
		)
	)
		throw new WorkloadPreflightRejectedErrorV1();
	const environmentNames = new Set(
		configuration.environment.map(({ name }) => name),
	);
	const secretDataKeys = new Set<string>();
	for (const { record } of bindings) {
		const key = secretDataKey(record.name);
		if (environmentNames.has(key) || secretDataKeys.has(key))
			throw new WorkloadPreflightRejectedErrorV1();
		secretDataKeys.add(key);
	}
}

function bindingsFor(
	state: WorkloadReconciliationStateV1,
	input: WorkloadReconciliationInputV1,
	keylessModel = false,
): ResolvedWorkloadSecretBindingV1[] {
	const configuration = state.candidate.configuration;
	const expected = expectedSecrets(state, keylessModel);
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

/**
 * 排空路径可复用 Monitor readiness 缓存的命令白名单。
 * 这些命令在同一 Execution 排空中反复执行，签名 readiness 是性能瓶颈；
 * turn.submit / turn.supplement / session.status / control 用途始终做完整探测。
 */
export const drainCacheableCommands = new Set([
	"events.persist",
	"events.ack",
	"execution.renew",
] as const);

export function createWorkloadRuntimeV1(
	options: WorkloadRuntimeOptionsV1,
): WorkloadRuntimePortV1 & {
	observeVerifiedControl(
		state: WorkloadReconciliationStateV1,
	): ReturnType<WorkloadRuntimePortV1["observe"]>;
	observeSession(
		state: WorkloadReconciliationStateV1,
		browserBinding: BrowserCapabilityBindingV1,
	): ReturnType<WorkloadRuntimePortV1["observe"]>;
	/**
	 * 排空路径轻量路由复核：缓存命中时跳过签名 readiness，仅核对 Kubernetes
	 * 实际路由、所有权/漂移与 Pod 就绪（保留 /healthz）。
	 * 记录来自同进程 Workload 监测（或本实例）最近一次通过的签名 readiness，
	 * 绑定 Pod UID、generation、Workload revision 和 fence，有效期不超过
	 * drainReadinessMaxAgeMs（一个监测周期，30 s）。任何绑定不匹配、超期、phase 非
	 * ready、attempts 非 0 或缺失记录时退回完整签名 readiness（fail-closed）。
	 * 仅供 business purpose 排空命令（events.persist / events.ack /
	 * execution.renew）使用；turn.submit / supplement / control 不得调用此方法。
	 */
	observeForDrain(
		state: WorkloadReconciliationStateV1,
		browserBinding?: BrowserCapabilityBindingV1,
	): ReturnType<WorkloadRuntimePortV1["observe"]>;
} {
	if (!Array.isArray(options.templateModelBindings))
		throw new TypeError("Template model bindings are required");
	const templateModelBindings = validateStandardTemplateModelBindingsV1(
		options.templateModelBindings,
	);
	const multiService = createMultiServiceRuntimeOperations({
		client: options.client,
		policy: options.policy,
		onHealthDiagnostic: options.onHealthDiagnostic,
	});
	const fetcher = options.fetch ?? globalThis.fetch;
	const observedCapabilities = new WeakMap<
		WorkloadReconciliationStateV1,
		WorkloadCapabilitiesV1
	>();
	// 排空复用的签名 readiness 记录；部署装配时与 Workload 监测共享（#1889）。
	const readinessLedger =
		options.readinessLedger ?? createWorkloadReadinessLedgerV1();
	function readinessBinding(
		state: WorkloadReconciliationStateV1,
	): WorkloadReadinessBindingV1 | null {
		if (!state.identity) return null;
		return {
			agentId: state.agentId,
			workloadUid: state.identity.uid,
			workloadGeneration: state.identity.generation,
			workloadRevision: state.revision,
			fence: state.fence,
		};
	}
	function candidateKeyless(
		state: Pick<WorkloadReconciliationStateV1, "candidate">,
	): boolean {
		if (state.candidate.configuration.source.kind !== "standard") return false;
		const projection = state.candidate.modelProjection;
		if (
			projection &&
			typeof projection === "object" &&
			"schemaVersion" in projection
		)
			return projection.schemaVersion === 4;
		return options.runtimeModelVersion === 4;
	}

	function assertCandidateMaterializationAllowed(
		state: WorkloadReconciliationStateV1,
	) {
		if (
			options.runtimeModelVersion === 4 &&
			state.candidate.configuration.source.kind === "standard" &&
			!candidateKeyless(state)
		)
			throw new ModelConfigurationErrorV1();
	}

	function createAdapter(
		recordCapabilities: (value: WorkloadCapabilitiesV1) => void = () => {},
		state?: Pick<WorkloadReconciliationStateV1, "candidate">,
		purpose: "authorize" | "cleanup" = "authorize",
		connectionConsumerControl = false,
		browserBinding?: BrowserCapabilityBindingV1,
		/**
		 * 签名 readiness 的复用与记录（#1889）：`reuse` 对本次观测到的 Pod 返回
		 * true 时跳过签名 readiness；完整探测通过时以该 Pod 调用 `passed`。
		 */
		readiness?: {
			readonly reuse?: (podUid: string) => boolean;
			readonly passed?: (podUid: string) => void;
		},
	) {
		const modelProjection =
			state?.candidate.configuration.source.kind === "standard"
				? candidateKeyless(state)
					? validateRuntimeModelProjectionV4(
							state.candidate.modelProjection,
							state.candidate.configuration,
						)
					: validateRuntimeModelProjectionV1(
							state.candidate.modelProjection,
							state.candidate.configuration.schemaVersion === 2
								? state.candidate.configuration
								: undefined,
						)
				: undefined;
		if (modelProjection && state && purpose === "authorize") {
			const binding = standardTemplateModelBindingV1(
				state.candidate.configuration.source,
				templateModelBindings,
			);
			if (!isDeepStrictEqual(modelProjection.standardTemplateBinding, binding))
				throw new ModelConfigurationErrorV1();
		}
		const standardTemplateBinding =
			state?.candidate.configuration.source.kind === "standard" &&
			purpose === "authorize"
				? standardTemplateModelBindingV1(
						state.candidate.configuration.source,
						templateModelBindings,
					)
				: undefined;
		return createKubernetesRuntimeAdapterV1({
			connectionConsumerControl:
				purpose === "cleanup" || connectionConsumerControl,
			client: options.client,
			policy: options.policy,
			onHealthDiagnostic: options.onHealthDiagnostic,
			modelProjection,
			standardTemplateBinding,
			async probe({ desired, serviceOrigin, podUid }) {
				const probeStartedAt = performance.now();
				const observed = (
					stage: WorkloadProbeObservationV1["stage"],
					outcome: WorkloadProbeObservationV1["outcome"],
					reason?: WorkloadProbeFailureV1["reason"],
				) => {
					try {
						options.onProbe?.({
							agentId: desired.agentId,
							workloadRevision: desired.workloadRevision,
							stage,
							outcome,
							durationMs: performance.now() - probeStartedAt,
							...(reason ? { reason } : {}),
						});
					} catch {
						// Probe telemetry is observational and never changes readiness.
					}
				};
				const baseUrl = serviceOrigin;
				const healthFetch =
					desired.runtimeManifest.interactionMode === "self-managed"
						? fetcher
						: (options.fetch ?? runtimeFetch);
				const failed = (
					stage: WorkloadProbeFailureV1["stage"],
					reason: WorkloadProbeFailureV1["reason"],
				) => {
					try {
						options.onProbeFailure?.({
							agentId: desired.agentId,
							workloadRevision: desired.workloadRevision,
							stage,
							reason,
						});
					} catch {
						// Recording a failure is observational and never changes it.
					}
					observed(stage, "failed", reason);
				};
				// Only a probe that never answered is incomplete; every answer
				// that fails validation stays an unhealthy result (#2046).
				const rethrown = (
					stage: WorkloadProbeFailureV1["stage"],
					error: unknown,
				) => {
					const reason = workloadProbeIncompleteReasonV1(error);
					failed(stage, reason ?? "response");
					return reason
						? new WorkloadProbeIncompleteErrorV1(stage, reason)
						: error;
				};
				let response: Response;
				try {
					response = await healthFetch(`${baseUrl}${desired.health.path}`, {
						redirect: "error",
						signal: AbortSignal.timeout(desired.health.timeoutSeconds * 1000),
					});
					await response.body?.cancel();
				} catch (error) {
					throw rethrown("health", error);
				}
				if (!response.ok) {
					// 5xx 是暂时性故障，与未完成的探测同样按阈值容忍（#2252）。
					if (isTransientProbeStatusV1(response.status)) {
						failed("health", "unavailable");
						throw new WorkloadProbeIncompleteErrorV1("health", "unavailable");
					}
					failed("health", "response");
					return false;
				}
				if (desired.runtimeManifest.interactionMode === "self-managed") {
					observed("health", "passed");
					recordCapabilities(RuntimeCapabilitySetV1Schema.parse({}));
					return true;
				}
				observed("health", "passed");
				// 同一 Pod 在有效期内已通过签名 readiness：只保留上面的 /healthz。
				if (podUid && readiness?.reuse?.(podUid)) {
					observed("readiness", "reused");
					return true;
				}
				const controller = new AbortController();
				const resolvedBrowserBinding =
					browserBinding ??
					(desired.runtimeManifest.capabilities?.browser &&
					options.browserBinding
						? options.browserBinding({
								agentId: desired.agentId,
								workloadRevision: desired.workloadRevision,
								fence: desired.fence,
								imageDigest: desired.imageDigest,
								manifest: desired.runtimeManifest,
							})
						: undefined);
				const timer = setTimeout(() => controller.abort(), 10_000);
				let probe: Awaited<
					ReturnType<WorkloadRuntimeOptionsV1["probeRuntime"]>
				>;
				try {
					probe = await Promise.race([
						options.probeRuntime({
							agentId: desired.agentId,
							workloadRevision: desired.workloadRevision,
							fence: desired.fence,
							imageDigest: desired.imageDigest,
							baseUrl,
							manifest: desired.runtimeManifest,
							...(resolvedBrowserBinding
								? { browserBinding: resolvedBrowserBinding }
								: {}),
							signal: controller.signal,
						}),
						new Promise<never>((_resolve, reject) =>
							controller.signal.addEventListener(
								"abort",
								() =>
									reject(
										new WorkloadProbeIncompleteErrorV1("readiness", "timeout"),
									),
								{ once: true },
							),
						),
					]);
				} catch (error) {
					throw rethrown("readiness", error);
				} finally {
					clearTimeout(timer);
				}
				const runtimeCapabilities = RuntimeCapabilitiesV1Schema.safeParse(
					probe.capabilities,
				);
				const optional = RuntimeCapabilitySetV1Schema.safeParse(
					probe.capabilities,
				);
				const detected = runtimeCapabilities.success
					? {
							modelSelection: runtimeCapabilities.data.modelSelection,
							attachments: runtimeCapabilities.data.attachments,
							resultFiles: runtimeCapabilities.data.resultFiles,
							connection: runtimeCapabilities.data.connection,
							supplementaryInstruction:
								runtimeCapabilities.data.supplementaryInstruction,
						}
					: optional.success
						? optional.data
						: RuntimeCapabilitySetV1Schema.parse({});
				const declared = resolveRuntimeManifestCapabilitiesV1(
					desired.runtimeManifest,
				);
				const browserResult =
					desired.runtimeManifest.capabilities?.browser &&
					runtimeCapabilities.success &&
					runtimeCapabilities.data.browser
						? discoverRuntimeBrowserCapabilityV1(
								{ schemaVersion: 1 },
								{
									declaration: desired.runtimeManifest.capabilities.browser,
									manifestDigest: desired.imageDigest,
									probe: runtimeCapabilities.data.browser,
								},
							)
						: desired.runtimeManifest.capabilities?.browser
							? discoverRuntimeBrowserCapabilityV1(
									{ schemaVersion: 1 },
									{
										declaration: desired.runtimeManifest.capabilities.browser,
										manifestDigest: desired.imageDigest,
										probe: undefined,
									},
								)
							: undefined;
				const browser = browserResult
					? BrowserCapabilityProjectionV1Schema.parse(browserResult)
					: undefined;
				recordCapabilities({
					...Object.fromEntries(
						Object.entries(declared).map(([name, value]) => [
							name,
							value && detected[name as keyof typeof detected],
						]),
					),
					...(runtimeCapabilities.success && runtimeCapabilities.data.skills
						? { skills: runtimeCapabilities.data.skills }
						: {}),
					...(browser ? { browser } : {}),
				});
				if (probe.core !== "passed") failed("readiness", "response");
				else {
					observed("readiness", "passed");
					if (podUid) readiness?.passed?.(podUid);
				}
				return probe.core === "passed";
			},
		});
	}
	const adapter = createAdapter();
	function isUnmaterializedInitialWorkload(
		state: WorkloadReconciliationStateV1,
	) {
		return (
			state.candidate.deployment === null &&
			state.identity === null &&
			state.verified === null
		);
	}
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
				fence: state.fence,
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
			fence: state.fence,
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
	async function revalidateCandidateCatalog(
		state: WorkloadReconciliationStateV1,
		force = false,
	) {
		if (
			state.candidate.configuration.source.kind !== "standard" ||
			(!force &&
				!candidateKeyless(state) &&
				state.candidate.configuration.revision ===
					state.verified?.configuration.revision)
		)
			return;
		if (!options.modelCatalog) throw new ModelConfigurationErrorV1();
		if (candidateKeyless(state)) {
			const projection = validateRuntimeModelProjectionV4(
				state.candidate.modelProjection,
				state.candidate.configuration,
			);
			const binding = standardTemplateModelBindingV1(
				state.candidate.configuration.source,
				templateModelBindings,
			);
			if (!isDeepStrictEqual(projection.standardTemplateBinding, binding))
				throw new ModelConfigurationErrorV1();
			await revalidateRuntimeModelCatalogV4(
				projection,
				options.modelCatalog,
				AbortSignal.timeout(60_000),
			);
		} else {
			const projection = validateRuntimeModelProjectionV1(
				state.candidate.modelProjection,
				state.candidate.configuration.schemaVersion === 2
					? state.candidate.configuration
					: undefined,
			);
			await revalidateRuntimeModelCatalogV1(
				projection,
				options.modelCatalog,
				AbortSignal.timeout(60_000),
			);
		}
	}
	async function cleanupModelConfiguration(
		state: WorkloadReconciliationStateV1,
	) {
		if (
			state.candidate.configuration.source.kind !== "standard" ||
			state.candidate.deployment === null ||
			state.candidate.configuration.revision ===
				state.verified?.configuration.revision
		)
			return true;
		return createAdapter(undefined, state, "cleanup").removeModelConfiguration(
			desired(state),
		);
	}
	function routeSelectorMode(
		state: WorkloadReconciliationStateV1,
	): "closed" | "open" {
		return state.phase === "ready" || state.phase === "rejected"
			? "open"
			: "closed";
	}
	async function cleanupUnactivatedSecrets(
		state: WorkloadReconciliationStateV1,
		input: WorkloadReconciliationInputV1,
	): Promise<boolean> {
		const resolvedBindings = bindingsFor(state, input, candidateKeyless(state));
		if (state.candidate.deployment === null) {
			// Preflight has not materialized a Kubernetes Secret. Retain the exact
			// current pending record so retry_agent_creation can activate it later.
			return resolvedBindings.every(
				({ materialization, record }) =>
					materialization === "current" &&
					record.lifecycleState === "pending" &&
					record.ownerType === "agent-owner" &&
					input.management.ownerIds.includes(record.ownerId),
			);
		}
		const bindings = resolvedBindings.filter(
			({ materialization, record }) =>
				materialization === "current" &&
				["pending", "applying", "observed"].includes(record.lifecycleState),
		);
		if (!bindings.length) return true;
		if (!input.secrets) return false;
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
	async function observe(
		state: WorkloadReconciliationStateV1,
		browserBinding?: BrowserCapabilityBindingV1,
	) {
		observedCapabilities.delete(state);
		if (!state.identity) return "pending" as const;
		const observedWorkload = desired(state);
		if (isMultiService(observedWorkload)) {
			const health = await multiService.observe(
				observedWorkload,
				state.identity,
			);
			// 多服务 Agent 是自有交互入口，没有平台适配能力；与单镜像 self-managed
			// 一致，只对完全相同的一次健康晋升尝试保留空能力集。
			if (health === "healthy" && state.phase === "promoting")
				observedCapabilities.set(state, RuntimeCapabilitySetV1Schema.parse({}));
			return health;
		}
		if (state.phase === "ready" && candidateKeyless(state))
			await revalidateCandidateCatalog(state, true);
		let capabilities: WorkloadCapabilitiesV1 | undefined;
		let passedPodUid: string | undefined;
		const observation = createAdapter(
			(value) => {
				capabilities = value;
			},
			state,
			"authorize",
			false,
			browserBinding,
			{
				passed(podUid) {
					passedPodUid = podUid;
				},
			},
		);
		const health = await observation.observe(
			desired(state),
			state.identity,
			routeSelectorMode(state),
			state.phase === "observing" ? "activation" : "required",
		);
		if (health === "healthy" && state.phase === "promoting" && capabilities)
			observedCapabilities.set(state, capabilities);
		// 只有 ready 阶段的完整观测（含签名 readiness）通过才记录；
		// 任何未通过的完整观测都清除该 Agent 的记录，排空随即回到完整探测。
		const binding = readinessBinding(state);
		if (health !== "healthy") readinessLedger.forget(state.agentId);
		else if (state.phase === "ready" && binding && passedPodUid && capabilities)
			readinessLedger.record(binding, {
				podUid: passedPodUid,
				passedAt: Date.now(),
			});
		return health;
	}

	/**
	 * 排空路径的路由复核（#1889）：Workload 为 ready、attempts 为 0，且同一
	 * Pod UID/generation、Workload revision 与 fence 在一个监测周期内通过过签名
	 * readiness 时，只做 Kubernetes 实际路由、漂移、Pod 就绪与 `/healthz` 核对，
	 * 不再发签名 readiness；其余情况一律走完整观测。
	 */
	async function observeForDrain(
		state: WorkloadReconciliationStateV1,
		browserBinding?: BrowserCapabilityBindingV1,
	) {
		const binding = readinessBinding(state);
		const pass =
			binding && state.phase === "ready" && state.attempts === 0
				? readinessLedger.lookup(binding)
				: undefined;
		const age = pass ? Date.now() - pass.passedAt : -1;
		if (!binding || !pass || age < 0 || age >= drainReadinessMaxAgeMs)
			return observe(state, browserBinding);
		observedCapabilities.delete(state);
		let capabilities: WorkloadCapabilitiesV1 | undefined;
		let passedPodUid: string | undefined;
		// 观测到的 Pod 与记录不一致时，适配器在本次观测内执行完整签名 readiness。
		const health = await createAdapter(
			(value) => {
				capabilities = value;
			},
			state,
			"authorize",
			false,
			browserBinding,
			{
				reuse: (podUid) => podUid === pass.podUid,
				passed(podUid) {
					passedPodUid = podUid;
				},
			},
		).observe(
			desired(state),
			{ uid: binding.workloadUid, generation: binding.workloadGeneration },
			routeSelectorMode(state),
			"required",
		);
		if (health !== "healthy") readinessLedger.forget(state.agentId);
		else if (passedPodUid && capabilities)
			readinessLedger.record(binding, {
				podUid: passedPodUid,
				passedAt: Date.now(),
			});
		return health;
	}
	return {
		async capabilities(state) {
			const capabilities = observedCapabilities.get(state);
			if (!capabilities)
				throw new WorkloadStepErrorV1(
					"capabilities_unavailable",
					"Runtime capabilities are unavailable",
				);
			observedCapabilities.delete(state);
			return capabilities;
		},
		async preflight(input, state) {
			const configuration = state.candidate.configuration;
			// 平台身份入口需要部署提供可信的路由集成；没有时是确定性的策略拒绝（#3034）。
			// 在 Registry 准入、模型投影和任何 Kubernetes 写入之前结束，不消耗重试预算。
			if (
				configuration.source.kind === "custom" &&
				configuration.source.interactionMode === "self-managed" &&
				configuration.source.identityResponsibility === "platform-managed" &&
				Object.keys(options.policy.platformAuthAnnotations).length === 0
			)
				throw new WorkloadKubernetesError("policy");
			let secretBindings: ResolvedWorkloadSecretBindingV1[];
			try {
				secretBindings = bindingsFor(state, input, candidateKeyless(state));
				validateSecretDataKeys(configuration, secretBindings);
			} catch (error) {
				if (error instanceof WorkloadPreflightRejectedErrorV1) throw error;
				throw new WorkloadPreflightRejectedErrorV1("secret-bindings");
			}
			if ("manifest" in configuration.source) {
				try {
					const multiServiceManifest = parseMultiServiceManifest(
						configuration.source.manifest,
					);
					const entryService = multiServiceManifest.resources.find(
						(resource) =>
							resource.kind === "Service" &&
							resource.metadata.name === multiServiceManifest.entryServiceName,
					);
					if (entryService?.kind !== "Service") throw new Error();
					const port = entryService.spec.ports[0]?.port;
					if (!port) throw new Error();
					const runtimeManifest = {
						schemaVersion: 1 as const,
						interactionMode: "self-managed" as const,
						service: { port },
						health: { path: "/" },
					};
					const deployment = validateAgentWorkloadDesiredV1({
						schemaVersion: 1,
						requestId: input.requestId,
						traceId: input.traceId,
						agentId: state.agentId,
						configRevision: configuration.revision,
						workloadRevision: state.revision,
						fence: state.fence,
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
							immutableDigest: configuration.source.imageDigest,
							runtimeManifest,
							policyEvidence: {
								schemaVersion: 1,
								policyRef: options.admissionPolicyRef,
								decisionRef: configuration.source.admissionRevision,
								subjectRef: options.registrySubjectRef,
								agentId: state.agentId,
								imageDigest: configuration.source.imageDigest,
								evaluatedAt: new Date().toISOString(),
							},
							runtimeManifestParsingEvidence: {
								schemaVersion: 1,
								labelName: "io.agora.agent.runtime.manifest",
								utf8ByteLength: 1,
								maxDepth: 1,
								duplicateKeysDetected: false,
								unknownFieldsDetected: false,
							},
						},
						runtimeManifest,
						resourceProfileRef: options.policy.resourceProfileRef,
						env: Object.fromEntries(
							configuration.environment.map((entry) => [
								entry.name,
								entry.value,
							]),
						),
						service: {
							name: workloadResourceNameV1(state.agentId),
							port,
						},
						health: { path: "/", timeoutSeconds: 5, failureThreshold: 3 },
						persistentVolume: {
							name: `${workloadResourceNameV1(state.agentId)}-data`,
							mountPath: "/workspace",
							storageProfileRef: options.policy.storageProfileRef,
							accessMode: "ReadWriteOnce",
							retention: "retain",
						},
						serviceAccount: {
							name: workloadResourceNameV1(state.agentId),
							kubernetesApiAccess: false,
						},
						networkPolicy: {
							deploymentPolicyRef: options.policy.networkPolicyRef,
							ingressMode: "self-managed-route",
							kubernetesApiAccess: false,
							platformDatabaseAccess: false,
							connectionDatabaseAccess: false,
							decryptionKeyringAccess: false,
						},
						route: {
							name: workloadResourceNameV1(state.agentId),
							exposure: "self-managed",
							tlsRequired: true,
							interactionOrigin: createWorkloadInteractionOriginV1({
								routeHostSuffix: options.policy.routeHostSuffix,
								agentId: state.agentId,
							}),
						},
						secretRefs: secretBindings.map(({ record }) =>
							recordReference(record),
						),
						desiredState: "running",
						replicas: 1,
						multiService: multiServiceManifest,
					});
					return { configuration, deployment };
				} catch {
					throw new WorkloadPreflightRejectedErrorV1();
				}
			}
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
			const controller = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const deadline = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new Error("Workload admission is unavailable"));
				}, 60_000);
			});
			let result: Awaited<ReturnType<typeof options.registry.admit>>;
			try {
				result = await Promise.race([
					options.registry.admit(request, { signal: controller.signal }),
					deadline,
				]);
			} finally {
				clearTimeout(timer);
			}
			let admission: ReturnType<typeof validateImageRegistryAdmissionResultV1>;
			try {
				admission = validateImageRegistryAdmissionResultV1(request, result);
			} catch {
				throw new WorkloadPreflightRejectedErrorV1("registry-admission");
			}
			if (admission.status === "rejected") {
				if (admission.error.retryable)
					throw new Error("Workload admission is unavailable");
				throw new WorkloadPreflightRejectedErrorV1("registry-admission");
			}
			if (admission.immutableDigest !== configuration.source.imageDigest)
				throw new WorkloadPreflightRejectedErrorV1("registry-admission");
			const mode =
				configuration.source.kind === "standard"
					? "platform-adapter"
					: configuration.source.interactionMode;
			if (admission.runtimeManifest.interactionMode !== mode)
				throw new WorkloadPreflightRejectedErrorV1("registry-admission");
			let modelProjection: unknown;
			if (configuration.source.kind === "standard") {
				if (!options.modelCatalog)
					throw new WorkloadPreflightRejectedErrorV1("model-projection");
				try {
					if (candidateKeyless(state)) {
						modelProjection = await projectRuntimeModelConfigurationV4({
							configuration,
							standardTemplateBinding: standardTemplateModelBindingV1(
								configuration.source,
								templateModelBindings,
							),
							catalog: options.modelCatalog,
							signal: AbortSignal.timeout(60_000),
						});
					} else {
						if (!options.modelAccess)
							throw new WorkloadPreflightRejectedErrorV1("model-projection");
						modelProjection = await projectRuntimeModelConfigurationV1({
							configuration:
								configuration.schemaVersion === 2
									? configuration
									: (() => {
											throw new WorkloadPreflightRejectedErrorV1(
												"model-projection",
											);
										})(),
							standardTemplateBinding: standardTemplateModelBindingV1(
								configuration.source,
								templateModelBindings,
							),
							catalog: options.modelCatalog,
							access: options.modelAccess,
							signal: AbortSignal.timeout(60_000),
							async credentialFor(option) {
								const binding = secretBindings.find(
									({ record }) => record.name === `model:${option.optionId}`,
								);
								if (!binding)
									throw new WorkloadPreflightRejectedErrorV1(
										"model-projection",
									);
								const { record } = binding;
								const decrypted = await options.decryptor.decrypt({
									encryptedRecord: record,
									traceId: input.traceId,
								});
								if (decrypted.outcome !== "decrypted") {
									await input.secrets?.auditDecryption(
										record.secretId,
										record.crypto.wrappingKeyVersion,
										"rejected",
									);
									throw new WorkloadPreflightRejectedErrorV1(
										"model-projection",
									);
								}
								try {
									await input.secrets?.auditDecryption(
										record.secretId,
										record.crypto.wrappingKeyVersion,
										"succeeded",
									);
								} catch {
									decrypted.plaintext.fill(0);
									throw new WorkloadPreflightRejectedErrorV1(
										"model-projection",
									);
								}
								const ref = recordReference(record);
								return {
									reference: {
										name: ref.name,
										secretId: ref.secretId,
										secretVersion: ref.secretVersion,
										configRevision: ref.configRevision,
									},
									key: secretDataKey(record.name),
									plaintext: decrypted.plaintext,
								};
							},
						});
					}
				} catch (error) {
					if (error instanceof ModelConfigurationErrorV1 && error.retryable)
						throw new Error("Workload model configuration is unavailable");
					throw new WorkloadPreflightRejectedErrorV1("model-projection");
				}
			}
			const name = workloadResourceNameV1(state.agentId);
			const exposure =
				mode === "platform-adapter"
					? "internal-only"
					: configuration.source.kind === "custom" &&
							configuration.source.identityResponsibility === "platform-managed"
						? "platform-auth"
						: "self-managed";
			let materializedSkills: WorkloadSkillMaterializationResultV1 | undefined;
			if (options.skillMaterializer) {
				materializedSkills = validateWorkloadSkillMaterializationV1(
					{
						agentId: state.agentId,
						configurationRevision: configuration.revision,
						workloadRevision: state.revision,
						fence: state.fence,
					},
					await options.skillMaterializer.materialize({
						agentId: state.agentId,
						configurationRevision: configuration.revision,
						workloadRevision: state.revision,
						fence: state.fence,
					}),
				);
			}
			try {
				const deployment = validateAgentWorkloadDesiredV1({
					schemaVersion: 1,
					requestId: input.requestId,
					traceId: input.traceId,
					agentId: state.agentId,
					configRevision: configuration.revision,
					workloadRevision: state.revision,
					fence: state.fence,
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
					route: {
						name,
						exposure,
						tlsRequired: true,
						...(exposure === "self-managed"
							? {
									interactionOrigin: createWorkloadInteractionOriginV1({
										routeHostSuffix: options.policy.routeHostSuffix,
										agentId: state.agentId,
									}),
								}
							: {}),
					},
					secretRefs: secretBindings.map(({ record }) =>
						recordReference(record),
					),
					...(materializedSkills
						? {
								skills: materializedSkills.skills,
								skillAppliedBindings: materializedSkills.appliedBindings?.length
									? JSON.stringify(materializedSkills.appliedBindings)
									: undefined,
								skillGenerationId: materializedSkills.generationId,
							}
						: {}),
					desiredState: "running",
					replicas: 1,
				});
				const executionCapacity = resolveWorkloadExecutionCapacityV1(
					options,
					configuration.source.imageDigest,
				);
				return {
					configuration,
					deployment,
					...(executionCapacity ? { executionCapacity } : {}),
					...(modelProjection ? { modelProjection } : {}),
				};
			} catch {
				throw new WorkloadPreflightRejectedErrorV1("desired-workload");
			}
		},
		async closeRoute(state) {
			if ("manifest" in state.candidate.configuration.source) {
				if (isUnmaterializedInitialWorkload(state)) return;
				const workload = desired(state);
				if (
					!isMultiService(workload) ||
					!(await multiService.closeRoute(workload, {
						allowOwnershipTransition: true,
					}))
				)
					throw new Error("Workload route is closing");
				return;
			}
			const revision =
				state.phase === "rejected" ? state.verifiedRevision : state.revision;
			if (
				revision === null ||
				!(await adapter.closeAgent(state.agentId, revision, state.fence))
			)
				throw new Error("Workload route is closing");
		},
		async discardUnactivatedSecrets(state, input) {
			if (!(await cleanupUnactivatedSecrets(state, input))) return false;
			if (!(await cleanupModelConfiguration(state))) return false;
			if ("manifest" in state.candidate.configuration.source) {
				if (isUnmaterializedInitialWorkload(state)) return true;
				const workload = desired(state);
				if (!isMultiService(workload)) return false;
				return multiService.cleanupMigration(workload);
			}
			return true;
		},
		async apply(state, stopped, input) {
			if (stopped && "manifest" in state.candidate.configuration.source) {
				if (isUnmaterializedInitialWorkload(state)) return null;
				const workload = desired(state);
				if (!isMultiService(workload)) return null;
				await multiService.closeRoute(workload, {
					allowOwnershipTransition: true,
				});
				return multiService.scaleDown(workload);
			}
			if (stopped)
				return createAdapter().scaleDownAgent(
					state.agentId,
					state.revision,
					state.fence,
				);
			assertCandidateMaterializationAllowed(state);
			const adapter = createAdapter(undefined, state);
			await revalidateCandidateCatalog(state);
			const workload = desired(state);
			if (isMultiService(workload))
				return multiService.apply(workload, {
					allowOwnershipTransition: true,
				});
			await adapter.assertStandardTemplateSelector(workload);
			const activeBindingsToRepair: {
				readonly reference: SecretActivationReferenceV1;
				readonly activationFence: NonNullable<
					ReturnType<typeof activeSecretFence>
				>;
				readonly secretUid: string;
			}[] = [];
			for (const { record } of bindingsFor(
				state,
				input,
				candidateKeyless(state),
			)) {
				const reference = recordReference(record);
				const activationFence = activeSecretFence(record, reference);
				if (record.lifecycleState === "active" && !activationFence)
					throw new Error("Active Workload Secret fence is unavailable");
				if (
					activationFence &&
					(await adapter.observeActiveImmutableSecret(
						workload,
						reference,
						activationFence,
					))
				)
					continue;
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
					const secretUid = await adapter.applyImmutableSecret(
						workload,
						reference.name,
						secretDataKey(record.name),
						decryption.plaintext,
						activationFence ?? undefined,
					);
					if (activationFence)
						activeBindingsToRepair.push({
							reference,
							activationFence,
							secretUid,
						});
				} finally {
					decryption.plaintext.fill(0);
				}
			}
			const result = await adapter.reconcile(workload);
			if (result.status !== "applied") return "pending";
			const identity = {
				uid: result.workloadUid,
				generation: result.workloadGeneration,
			};
			for (const repaired of activeBindingsToRepair) {
				if (
					repaired.activationFence.workloadUid !== identity.uid ||
					identity.generation < repaired.activationFence.workloadGeneration
				)
					throw new Error("Active Workload Secret fence is unavailable");
				await adapter.bindSecretFence(
					workload,
					identity,
					repaired.reference.name,
					repaired.activationFence.fence,
					repaired.secretUid,
				);
			}
			return identity;
		},
		async observeVerifiedControl(state) {
			if (!state.identity || !state.verified || state.verifiedRevision === null)
				return "pending";
			const deployment = validateAgentWorkloadDesiredV1(
				state.verified.deployment,
			);
			if (
				deployment.agentId !== state.agentId ||
				state.verified.configuration.agentId !== state.agentId ||
				deployment.configRevision !== state.verified.configuration.revision ||
				deployment.imageDigest !==
					state.verified.configuration.source.imageDigest
			)
				return "drifted";
			const observation = createAdapter(
				undefined,
				{
					candidate: state.verified,
				},
				"authorize",
				true,
			);
			const original = validateAgentWorkloadDesiredV1({
				...deployment,
				workloadRevision: state.verifiedRevision,
				expectedWorkload: {
					state: "present",
					workloadUid: state.identity.uid,
					workloadGeneration: state.identity.generation,
				},
			});
			// Before route closure, controls use the verified business route directly.
			if (state.phase === "ready" || state.phase === "preflight")
				return observation.observe(
					original,
					state.identity,
					"open",
					"required",
				);
			const health = await observation.observe(
				original,
				state.identity,
				"closed",
				"required",
				{ workloadRevision: state.revision, fence: state.fence },
			);
			return state.phase === "closing" && health === "drifted"
				? observation.observe(original, state.identity, "open", "required")
				: health;
		},
		async observeSession(state, browserBinding) {
			// A newly started Runtime Host can miss the first bounded /healthz
			// window while its bridge is still starting. Retry one incomplete probe
			// for Session delivery; any second timeout remains fail-closed and is
			// handled by the existing reconciliation retry/route closure policy.
			const health = await observe(state, browserBinding);
			return health === "unreachable" ? observe(state, browserBinding) : health;
		},
		async observe(state) {
			return observe(state);
		},
		async observeForDrain(state, browserBinding) {
			return observeForDrain(state, browserBinding);
		},
		async activateSecrets(state, input) {
			assertCandidateMaterializationAllowed(state);
			const adapter = createAdapter(undefined, state);
			await revalidateCandidateCatalog(state);
			const bindings = bindingsFor(state, input, candidateKeyless(state));
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
						const secretUid = await adapter.applyImmutableSecret(
							workload,
							candidate.kubernetesSecretRef.name,
							secretDataKey(candidate.secretKey),
							candidate.plaintext,
						);
						await adapter.bindSecretFence(
							workload,
							identity,
							candidate.kubernetesSecretRef.name,
							candidate.fence,
							secretUid,
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
			assertCandidateMaterializationAllowed(state);
			if ("manifest" in state.candidate.configuration.source) {
				const workload = desired(state);
				if (isMultiService(workload)) await multiService.promote(workload);
				return;
			}
			const adapter = createAdapter(undefined, state);
			await revalidateCandidateCatalog(state);
			if (!state.identity) throw new Error();
			if (
				state.phase === "promoting" &&
				!(await adapter.closeAgent(state.agentId, state.revision, state.fence))
			)
				throw new Error("Workload route is closing");
			const workload = desired(state);
			const result = await adapter.switchRoute(
				{
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
				},
				routeSelectorMode(state),
				workload,
			);
			if (result.status !== "completed")
				throw new Error("Workload route is unavailable");
		},
		async cleanup(state, deleteNewVolume, input) {
			if (deleteNewVolume && !(await cleanupUnactivatedSecrets(state, input)))
				return false;
			let resourcesRemoved: boolean;
			if ("manifest" in state.candidate.configuration.source) {
				if (isUnmaterializedInitialWorkload(state)) return true;
				const workload = desired(state);
				if (!isMultiService(workload)) return false;
				resourcesRemoved = await multiService.cleanupAgent(
					workload,
					deleteNewVolume,
					{ allowOwnershipTransition: true },
				);
				return resourcesRemoved;
			}
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
					fence: state.fence,
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
					state.fence,
					deleteNewVolume,
				);
			}
			return resourcesRemoved && (await cleanupModelConfiguration(state));
		},
	};
}
