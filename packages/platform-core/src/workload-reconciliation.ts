import { isDeepStrictEqual } from "node:util";
import type { AgentConfigurationRecord } from "./agent-configuration.js";
import {
	type AgentManagementDecisionV1,
	type AgentManagementStateV1,
	type AgentManagementTransactionRequestV1,
	createAgentManagementV1,
} from "./agent-management.js";
import type { SecretActivationStorePortV1 } from "./secret-activation.js";
import {
	hasUnverifiedWorkloadSecretRecoveryV1,
	type WorkloadSecretRecoveryV1,
} from "./workload-secret-recovery.js";

export type WorkloadPhaseV1 =
	| "preflight"
	| "closing"
	| "applying"
	| "observing"
	| "activating"
	| "promoting"
	| "ready"
	| "rejected"
	| "stopped"
	| "cleaning"
	| "failed";

export interface WorkloadIdentityV1 {
	readonly uid: string;
	readonly generation: number;
}

/** Credential-free Runtime Skill metadata carried with the verified Workload. */
export interface WorkloadSkillCapabilityV1 {
	readonly schemaVersion: 1;
	readonly name: string;
	readonly version: string;
	readonly manifestSha256: string;
	readonly packageDigest: string;
	readonly readOnly: true;
}

/** Deployment-owned load evidence, private to reconciliation and Dispatch. */
export interface WorkloadExecutionCapacityV1 {
	readonly schemaVersion: 1;
	readonly imageDigest: string;
	readonly resourceProfileRef: string;
	readonly resourceConfigurationHash: string;
	readonly maximumConcurrentExecutions: number;
	readonly conformanceEvidenceHash: string;
}

export function parseWorkloadExecutionCapacityV1(
	input: unknown,
): WorkloadExecutionCapacityV1 {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new TypeError("Workload execution capacity is invalid");
	const value = input as Record<string, unknown>;
	const keys = [
		"schemaVersion",
		"imageDigest",
		"resourceProfileRef",
		"resourceConfigurationHash",
		"maximumConcurrentExecutions",
		"conformanceEvidenceHash",
	];
	if (
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key)) ||
		value.schemaVersion !== 1 ||
		typeof value.imageDigest !== "string" ||
		!/^sha256:[a-f0-9]{64}$/.test(value.imageDigest) ||
		typeof value.resourceProfileRef !== "string" ||
		!/^[\x21-\x7e]{1,256}$/.test(value.resourceProfileRef) ||
		typeof value.resourceConfigurationHash !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.resourceConfigurationHash) ||
		typeof value.conformanceEvidenceHash !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.conformanceEvidenceHash) ||
		typeof value.maximumConcurrentExecutions !== "number" ||
		!Number.isSafeInteger(value.maximumConcurrentExecutions) ||
		value.maximumConcurrentExecutions < 1
	)
		throw new TypeError("Workload execution capacity is invalid");
	return {
		schemaVersion: 1,
		imageDigest: value.imageDigest,
		resourceProfileRef: value.resourceProfileRef,
		resourceConfigurationHash: value.resourceConfigurationHash,
		maximumConcurrentExecutions: value.maximumConcurrentExecutions,
		conformanceEvidenceHash: value.conformanceEvidenceHash,
	};
}

export interface WorkloadVersionV1 {
	readonly secretRecoveries?: readonly WorkloadSecretRecoveryV1[];
	readonly configuration: AgentConfigurationRecord;
	/** Validated, credential-free deployment contract; never a Kubernetes object. */
	readonly deployment: unknown;
	/** Private Worker projection, persisted with candidate/verified; never public desired state. */
	readonly modelProjection?: unknown;
	/** Absent on legacy or unverified deployments; never inferred from loop limits. */
	readonly executionCapacity?: WorkloadExecutionCapacityV1;
}

export interface WorkloadCapabilitiesV1 {
	readonly modelSelection?: boolean;
	readonly attachments?: boolean;
	readonly resultFiles?: boolean;
	readonly connection?: boolean;
	readonly supplementaryInstruction?: boolean;
	readonly skills?: readonly WorkloadSkillCapabilityV1[];
	readonly browser?: WorkloadBrowserCapabilityProjectionV1;
	readonly [key: string]:
		| boolean
		| readonly WorkloadSkillCapabilityV1[]
		| WorkloadBrowserCapabilityProjectionV1
		| undefined;
}

/** Decode persisted, credential-free Runtime capability facts strictly. */
export function parseWorkloadCapabilitiesV1(
	input: unknown,
): WorkloadCapabilitiesV1 {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new TypeError("Workload capabilities are invalid");
	const value = input as Record<string, unknown>;
	const capabilities: Record<string, unknown> = {};
	for (const [name, item] of Object.entries(value)) {
		if (name === "skills") {
			if (!Array.isArray(item) || item.length > 150)
				throw new TypeError("Workload Skill capabilities are invalid");
			const skills = item.map((skill) => {
				if (!skill || typeof skill !== "object" || Array.isArray(skill))
					throw new TypeError("Workload Skill capability is invalid");
				const entry = skill as Record<string, unknown>;
				const keys = Object.keys(entry).sort();
				if (
					keys.join(",") !==
						"manifestSha256,name,packageDigest,readOnly,schemaVersion,version" ||
					entry.schemaVersion !== 1 ||
					typeof entry.name !== "string" ||
					entry.name.length < 1 ||
					entry.name.length > 128 ||
					typeof entry.version !== "string" ||
					entry.version.length < 1 ||
					entry.version.length > 128 ||
					typeof entry.manifestSha256 !== "string" ||
					!/^[a-f0-9]{64}$/.test(entry.manifestSha256) ||
					typeof entry.packageDigest !== "string" ||
					!/^[a-f0-9]{64}$/.test(entry.packageDigest) ||
					entry.readOnly !== true
				)
					throw new TypeError("Workload Skill capability is invalid");
				return entry as unknown as WorkloadSkillCapabilityV1;
			});
			if (new Set(skills.map((skill) => skill.name)).size !== skills.length)
				throw new TypeError("Workload Skill capabilities are duplicated");
			capabilities.skills = skills;
			continue;
		}
		if (name === "browser") {
			if (
				!item ||
				typeof item !== "object" ||
				Array.isArray(item) ||
				typeof (item as Record<string, unknown>).status !== "string"
			)
				throw new TypeError("Workload Browser capability is invalid");
			capabilities.browser = item;
			continue;
		}
		if (typeof item !== "boolean")
			throw new TypeError("Workload capabilities are invalid");
		capabilities[name] = item;
	}
	return capabilities as WorkloadCapabilitiesV1;
}

/** Opaque, server-validated Browser projection retained by Workload state. */
export interface WorkloadBrowserCapabilityProjectionV1 {
	readonly status: string;
	readonly [key: string]: unknown;
}

export interface WorkloadReconciliationStateV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly sourceConfigurationRevision: number;
	readonly sourceLifecycleRevision: number;
	readonly revision: number;
	/** Management-owned fencing token; independent from the local Workload revision. */
	readonly fence: number;
	readonly phase: WorkloadPhaseV1;
	readonly candidate: WorkloadVersionV1;
	readonly verified: WorkloadVersionV1 | null;
	readonly verifiedRevision: number | null;
	readonly identity: WorkloadIdentityV1 | null;
	readonly rollback: boolean;
	/** A newer accepted intent is waiting for failed-candidate Secret cleanup. */
	readonly cleanupInterrupted?: true;
	readonly failureCode: "reconciliation_failed" | "health_check_failed" | null;
	readonly attempts: number;
	/** Latest bounded swallowed-step failure; absent on legacy states. */
	readonly lastFailure?: WorkloadReconciliationFailureV1;
	readonly capabilities?: WorkloadCapabilitiesV1;
}

/**
 * Store-derived material for the exact configuration the reconciler may mount.
 * Historical material is only reusable after it has completed its own
 * activation; the Worker never selects arbitrary Secret history.
 */
export interface WorkloadSecretBindingV1 {
	readonly materialization: "current" | "active-origin";
	/** The Worker validates the Store-derived record before materializing it. */
	readonly record: unknown;
}

export interface WorkloadReconciliationInputV1 {
	readonly management: AgentManagementStateV1;
	readonly configuration: AgentConfigurationRecord;
	readonly state: WorkloadReconciliationStateV1 | null;
	readonly requestId: string;
	readonly traceId: string;
	readonly secrets?: {
		readonly bindings: readonly WorkloadSecretBindingV1[];
		readonly store: SecretActivationStorePortV1;
		auditDecryption(
			secretId: string,
			wrappingKeyVersion: string,
			outcome: "succeeded" | "rejected",
		): Promise<void>;
	};
}

/**
 * The Store runs at most one step per Agent, without an open transaction or
 * Agent row lock while the step performs external I/O, and persists the result
 * only when the management, configuration and Workload inputs it read are
 * still current. A discarded step is retried from the stored state.
 */
export interface WorkloadReconciliationStorePortV1 {
	runNext(
		workerId: string,
		step: (
			input: WorkloadReconciliationInputV1,
		) => Promise<WorkloadReconciliationStateV1>,
	): Promise<"idle" | "advanced">;
}

export class WorkloadPreflightRejectedErrorV1 extends Error {
	constructor() {
		super("Workload preflight rejected");
	}
}

/** One exception swallowed by a reconciliation step, for diagnostics only. */
export interface WorkloadStepFailureV1 {
	readonly agentId: string;
	/** The phase whose step threw. */
	readonly phase: WorkloadPhaseV1;
	/** Consecutive failed attempts in this phase, including this one. */
	readonly attempts: number;
	/** The failure ended the run: the Workload moves to cleanup or the candidate is rejected. */
	readonly terminal: boolean;
	readonly error: unknown;
}

export type WorkloadFailureReasonCodeV1 =
	| "kubernetes_unauthorized"
	| "kubernetes_forbidden"
	| "kubernetes_not_found"
	| "kubernetes_conflict"
	| "kubernetes_invalid"
	| "kubernetes_throttled"
	| "kubernetes_server_error"
	| "kubernetes_unreachable"
	| "kubernetes_policy"
	| "preflight_rejected"
	| "capabilities_unavailable"
	| "unexpected_error";

/** Credential-free persisted explanation of a swallowed Workload step failure. */
export interface WorkloadReconciliationFailureV1 {
	readonly schemaVersion: 1;
	readonly reason: WorkloadFailureReasonCodeV1;
	readonly attempts: number;
	readonly status?: number;
	readonly kind?: string;
	readonly verb?: string;
}

function classifyWorkloadFailureReasonV1(
	error: unknown,
): WorkloadFailureReasonCodeV1 {
	if (error instanceof WorkloadPreflightRejectedErrorV1)
		return "preflight_rejected";
	if (!error || typeof error !== "object") return "unexpected_error";
	const value = error as Record<string, unknown>;
	if (value.reason === "capabilities_unavailable")
		return "capabilities_unavailable";
	const code = value.code;
	if (code === "policy") return "kubernetes_policy";
	if (code === "conflict") return "kubernetes_conflict";
	if (code !== "unavailable") return "unexpected_error";
	const details = value.details;
	const status =
		details && typeof details === "object"
			? (details as Record<string, unknown>).status
			: undefined;
	if (typeof status !== "number") return "kubernetes_unreachable";
	if (status === 401) return "kubernetes_unauthorized";
	if (status === 403) return "kubernetes_forbidden";
	if (status === 404) return "kubernetes_not_found";
	if (status === 409) return "kubernetes_conflict";
	if (status === 400 || status === 422) return "kubernetes_invalid";
	if (status === 429) return "kubernetes_throttled";
	if (status >= 500) return "kubernetes_server_error";
	return "kubernetes_unreachable";
}

function classifyWorkloadFailureDetailsV1(
	error: unknown,
	reason: WorkloadFailureReasonCodeV1,
	attempts: number,
): WorkloadReconciliationFailureV1 {
	const value =
		error && typeof error === "object"
			? (error as Record<string, unknown>)
			: {};
	const details =
		value.details && typeof value.details === "object"
			? (value.details as Record<string, unknown>)
			: {};
	const status =
		typeof details.status === "number" &&
		Number.isSafeInteger(details.status) &&
		details.status >= 100 &&
		details.status <= 599
			? details.status
			: undefined;
	const kind =
		typeof details.kind === "string" &&
		/^[A-Za-z][A-Za-z0-9.-]{0,63}$/.test(details.kind)
			? details.kind
			: undefined;
	const verb =
		typeof details.verb === "string" && /^[a-z][a-z-]{0,31}$/.test(details.verb)
			? details.verb
			: undefined;
	return {
		schemaVersion: 1,
		reason,
		attempts,
		...(status === undefined ? {} : { status }),
		...(kind === undefined ? {} : { kind }),
		...(verb === undefined ? {} : { verb }),
	};
}

export interface WorkloadRuntimePortV1 {
	capabilities(
		state: WorkloadReconciliationStateV1,
	): Promise<WorkloadCapabilitiesV1>;
	preflight(
		input: WorkloadReconciliationInputV1,
		state: WorkloadReconciliationStateV1,
	): Promise<WorkloadVersionV1>;
	closeRoute(state: WorkloadReconciliationStateV1): Promise<void>;
	apply(
		state: WorkloadReconciliationStateV1,
		stopped: boolean,
		input: WorkloadReconciliationInputV1,
	): Promise<WorkloadIdentityV1 | WorkloadPreparationV1 | "pending" | null>;
	observe(
		state: WorkloadReconciliationStateV1,
	): Promise<"pending" | "healthy" | "unhealthy" | "unreachable" | "drifted">;
	activateSecrets(
		state: WorkloadReconciliationStateV1,
		input: WorkloadReconciliationInputV1,
	): Promise<"pending" | "active" | "failed">;
	promote(state: WorkloadReconciliationStateV1): Promise<void>;
	discardUnactivatedSecrets(
		state: WorkloadReconciliationStateV1,
		input: WorkloadReconciliationInputV1,
	): Promise<boolean | WorkloadPreparationV1>;
	cleanup(
		state: WorkloadReconciliationStateV1,
		deleteNewVolume: boolean,
		input: WorkloadReconciliationInputV1,
	): Promise<boolean | WorkloadPreparationV1>;
}

/** Persist a resource intention or observed identity before its next side effect. */
export interface WorkloadPreparationV1 {
	readonly status: "prepared";
	readonly candidate: WorkloadVersionV1;
	readonly identity: WorkloadIdentityV1 | null;
}

function nextRevision(revision: number): number {
	if (
		!Number.isSafeInteger(revision) ||
		revision < 0 ||
		revision === Number.MAX_SAFE_INTEGER
	) {
		throw new Error("Workload revision is unavailable");
	}
	return revision + 1;
}

export function createWorkloadReconciliationV1(dependencies: {
	readonly store: WorkloadReconciliationStorePortV1;
	readonly runtime: WorkloadRuntimePortV1;
	readonly maximumAttempts?: number;
	/** Consecutive Kubernetes 401/403 failures before existing failure cleanup. */
	readonly authorizationFailureThreshold?: number;
	/**
	 * Consecutive monitor probes of a serving Workload that may fail to
	 * complete before its route closes (#2046). An unhealthy answer, drift or a
	 * changed Pod still closes it at once.
	 */
	readonly probeFailureThreshold?: number;
	/**
	 * Observes an exception that a step swallowed (the run retries or ends).
	 * Purely diagnostic: its exceptions are ignored and nothing it receives is
	 * persisted, so the raw error must not be stored by the caller.
	 */
	readonly onStepFailure?: (failure: WorkloadStepFailureV1) => void;
}) {
	const maximumAttempts = dependencies.maximumAttempts ?? 60;
	if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1)
		throw new TypeError("Invalid Workload retry limit");
	const configuredAuthorizationFailureThreshold =
		dependencies.authorizationFailureThreshold ?? 3;
	if (
		!Number.isSafeInteger(configuredAuthorizationFailureThreshold) ||
		configuredAuthorizationFailureThreshold < 1
	)
		throw new TypeError("Invalid Workload authorization failure threshold");
	const authorizationFailureThreshold = Math.min(
		configuredAuthorizationFailureThreshold,
		maximumAttempts,
	);
	const probeFailureThreshold = dependencies.probeFailureThreshold ?? 3;
	if (
		!Number.isSafeInteger(probeFailureThreshold) ||
		probeFailureThreshold < 1 ||
		probeFailureThreshold > 100
	)
		throw new TypeError("Invalid Workload probe failure threshold");
	// In a serving phase `attempts` counts consecutive monitor probes that did
	// not complete; the route stays as it was until the run reaches the
	// threshold (#2046). Any other unhealthy result closes it at once.
	const servingProbeTolerated = (
		state: WorkloadReconciliationStateV1,
		health: Awaited<ReturnType<WorkloadRuntimePortV1["observe"]>>,
	) => health === "unreachable" && state.attempts + 1 < probeFailureThreshold;
	const servingProbeCompleted = (state: WorkloadReconciliationStateV1) => {
		const { lastFailure: _, ...retained } = state;
		return state.attempts === 0 && state.lastFailure === undefined
			? state
			: { ...retained, attempts: 0 };
	};
	const runtime = dependencies.runtime;
	return {
		async tick(workerId: string): Promise<"idle" | "advanced"> {
			if (!workerId || workerId.includes("\0"))
				throw new TypeError("Invalid Worker identity");
			return dependencies.store.runNext(workerId, async (input) => {
				const { management, configuration } = input;
				if (!Number.isSafeInteger(management.fence) || management.fence < 1)
					throw new Error("Workload fence is unavailable");
				let state = input.state;
				const stopped =
					management.desiredState === "stopped" ||
					management.status === "disabled";
				if (
					!state ||
					state.sourceConfigurationRevision !== configuration.revision ||
					state.sourceLifecycleRevision !== management.workloadRevision ||
					state.fence !== management.fence
				) {
					const supersedesUnverifiedCandidate =
						state &&
						state.candidate.deployment !== null &&
						(state.candidate.configuration.revision !==
							state.verified?.configuration.revision ||
							hasUnverifiedWorkloadSecretRecoveryV1(
								state.candidate,
								state.verified,
							)) &&
						[
							"closing",
							"applying",
							"observing",
							"activating",
							"promoting",
						].includes(state.phase);
					if (
						state &&
						(state.phase === "cleaning" ||
							hasUnverifiedWorkloadSecretRecoveryV1(
								state.candidate,
								state.verified,
							) ||
							(!state.rollback && supersedesUnverifiedCandidate))
					) {
						const interruptedState: WorkloadReconciliationStateV1 = {
							...state,
							phase: "cleaning",
							sourceConfigurationRevision: configuration.revision,
							sourceLifecycleRevision: management.workloadRevision,
							fence: management.fence,
							cleanupInterrupted: true,
						};
						await runtime.closeRoute(interruptedState);
						return interruptedState;
					}
					state = {
						schemaVersion: 1,
						agentId: management.agentId,
						sourceConfigurationRevision: configuration.revision,
						sourceLifecycleRevision: management.workloadRevision,
						revision: nextRevision(state?.revision ?? 0),
						fence: management.fence,
						phase: stopped ? "closing" : "preflight",
						candidate:
							stopped && state
								? state.candidate
								: state?.rollback &&
										state.sourceConfigurationRevision ===
											configuration.revision &&
										state.verified
									? state.verified
									: { configuration, deployment: null },
						verified: state?.verified ?? null,
						verifiedRevision: state?.verifiedRevision ?? null,
						identity: state?.identity ?? null,
						rollback:
							state?.sourceConfigurationRevision === configuration.revision &&
							state.rollback,
						failureCode: null,
						attempts: 0,
						capabilities: state?.capabilities,
					};
					return state;
				}
				const advance = (
					phase: WorkloadPhaseV1,
					changes: Partial<WorkloadReconciliationStateV1> = {},
				) => {
					const next = { ...state, phase, attempts: 0, ...changes };
					if (!Object.hasOwn(changes, "lastFailure"))
						delete (next as { lastFailure?: WorkloadReconciliationFailureV1 })
							.lastFailure;
					return next;
				};
				const failed = (
					failureCode: "reconciliation_failed" | "health_check_failed",
					lastFailure?: WorkloadReconciliationFailureV1,
				) =>
					advance("cleaning", {
						failureCode,
						...(lastFailure ? { lastFailure } : {}),
					});
				try {
					switch (state.phase) {
						case "preflight": {
							const candidate = await runtime.preflight(input, state);
							if (
								!isDeepStrictEqual(
									candidate.configuration,
									state.candidate.configuration,
								)
							)
								throw new WorkloadPreflightRejectedErrorV1();
							const previous = state.verified?.configuration.source;
							const current = candidate.configuration.source;
							const mode = (source: typeof current) =>
								source.kind === "standard"
									? "platform-adapter"
									: source.interactionMode;
							if (previous && mode(previous) !== mode(current))
								throw new WorkloadPreflightRejectedErrorV1();
							return advance("closing", { candidate });
						}
						case "closing":
							await runtime.closeRoute(state);
							return advance("applying");
						case "applying": {
							const identity = await runtime.apply(state, stopped, input);
							if (
								identity &&
								typeof identity === "object" &&
								"status" in identity
							)
								return advance("applying", {
									candidate: identity.candidate,
									identity: identity.identity,
								});
							if (identity === "pending") {
								if (!stopped && state.attempts + 1 >= maximumAttempts)
									return failed("reconciliation_failed");
								return {
									...state,
									attempts: Math.min(state.attempts + 1, maximumAttempts),
								};
							}
							if (!identity && !stopped) throw new Error();
							return advance(stopped ? "stopped" : "observing", { identity });
						}
						case "observing": {
							const health = await runtime.observe(state);
							if (health === "healthy") return advance("activating");
							if (health === "drifted") {
								await runtime.closeRoute(state);
								return advance("applying");
							}
							// A probe that did not complete is retried like a Pod not yet
							// ready, within the same budget; only an answer fails it (#2046).
							if (
								health === "unhealthy" ||
								state.attempts + 1 >= maximumAttempts
							)
								return failed("health_check_failed");
							return { ...state, attempts: state.attempts + 1 };
						}
						case "activating": {
							const activation = await runtime.activateSecrets(state, input);
							if (activation === "active") return advance("promoting");
							if (
								activation === "failed" ||
								state.attempts + 1 >= maximumAttempts
							)
								return failed("reconciliation_failed");
							return { ...state, attempts: state.attempts + 1 };
						}
						case "promoting": {
							// Re-establish a closed route before rechecking a partially published candidate.
							await runtime.closeRoute(state);
							const health = await runtime.observe(state);
							if (health !== "healthy") {
								if (
									health === "unreachable" &&
									state.attempts + 1 < maximumAttempts
								)
									return { ...state, attempts: state.attempts + 1 };
								return failed("health_check_failed");
							}
							const capabilities = await runtime.capabilities(state);
							await runtime.promote(state);
							return advance("ready", {
								verified: state.candidate,
								verifiedRevision: state.revision,
								capabilities,
							});
						}
						case "ready": {
							const health = await runtime.observe(state);
							if (health === "healthy") {
								await runtime.promote(state);
								return servingProbeCompleted(state);
							}
							if (servingProbeTolerated(state, health))
								return { ...state, attempts: state.attempts + 1 };
							await runtime.closeRoute(state);
							return health === "drifted"
								? advance("applying", {
										revision: nextRevision(state.revision),
									})
								: advance("observing");
						}
						case "rejected": {
							const health = await runtime.observe(state);
							if (health === "healthy") {
								await runtime.promote(state);
								return servingProbeCompleted(state);
							}
							if (servingProbeTolerated(state, health))
								return { ...state, attempts: state.attempts + 1 };
							await runtime.closeRoute(state);
							return advance("closing", {
								revision: nextRevision(state.revision),
							});
						}
						case "cleaning": {
							await runtime.closeRoute(state);
							const preservesResources =
								state.verified !== null && !state.rollback;
							const cleaned = preservesResources
								? await runtime.discardUnactivatedSecrets(state, input)
								: await runtime.cleanup(state, state.verified === null, input);
							if (typeof cleaned === "object")
								return advance("cleaning", {
									candidate: cleaned.candidate,
									identity: cleaned.identity,
								});
							if (!cleaned) return state;
							const preservesIdentity =
								preservesResources &&
								!hasUnverifiedWorkloadSecretRecoveryV1(
									state.candidate,
									state.verified,
								);
							if (state.cleanupInterrupted) {
								const { cleanupInterrupted: _, ...retained } = state;
								return {
									...retained,
									identity: preservesIdentity ? state.identity : null,
									phase: stopped ? "closing" : "preflight",
									candidate: stopped
										? state.candidate
										: { configuration, deployment: null },
									revision: nextRevision(state.revision),
									rollback: false,
									failureCode: null,
									attempts: 0,
								};
							}
							if (state.verified && !state.rollback) {
								return advance("applying", {
									candidate: state.verified,
									identity: preservesIdentity ? state.identity : null,
									revision: nextRevision(state.revision),
									rollback: true,
								});
							}
							return advance("failed", {
								identity: null,
								...(state.lastFailure
									? { lastFailure: state.lastFailure }
									: {}),
							});
						}
						case "stopped":
							await runtime.closeRoute(state);
							await runtime.apply(state, true, input);
							return state;
						case "failed":
							await runtime.closeRoute(state);
							{
								const cleaned = await runtime.cleanup(
									state,
									state.verified === null,
									input,
								);
								if (typeof cleaned === "object")
									return advance("cleaning", {
										candidate: cleaned.candidate,
										identity: cleaned.identity,
									});
								return cleaned ? state : advance("cleaning");
							}
					}
				} catch (error) {
					const reason = classifyWorkloadFailureReasonV1(error);
					const previousFailure = state.lastFailure;
					const consecutiveAttempts =
						previousFailure?.reason === reason
							? Math.min(previousFailure.attempts + 1, maximumAttempts)
							: 1;
					const lastFailure = classifyWorkloadFailureDetailsV1(
						error,
						reason,
						consecutiveAttempts,
					);
					const authorizationTerminal =
						(reason === "kubernetes_unauthorized" ||
							reason === "kubernetes_forbidden") &&
						consecutiveAttempts >= authorizationFailureThreshold;
					const retrying = {
						...state,
						attempts: Math.min(state.attempts + 1, maximumAttempts),
						lastFailure,
					};
					// 步骤里的异常被吞掉后只会让 attempts 加一或进入失败处理；这里把它交给
					// 观测回调，由调用方决定记录什么（正文不进入持久状态）。
					const observe = (next: WorkloadReconciliationStateV1) => {
						try {
							dependencies.onStepFailure?.({
								agentId: state.agentId,
								phase: state.phase,
								attempts: Math.min(state.attempts + 1, maximumAttempts),
								terminal: next.phase !== state.phase,
								error,
							});
						} catch {
							// 观测只用于诊断，不能改变调谐结果。
						}
						return next;
					};
					if (state.phase === "preflight") {
						// 部署策略不匹配与 preflight 拒绝同为确定性结果（#3034）：立即进入既有失败
						// 处理，不再消耗重试预算；临时异常仍在预算内重试。
						const permanent =
							error instanceof WorkloadPreflightRejectedErrorV1 ||
							reason === "kubernetes_policy";
						if (
							!permanent &&
							state.attempts + 1 < maximumAttempts &&
							!authorizationTerminal
						)
							return observe(retrying);
						if (state.verified)
							return observe(
								advance("rejected", {
									candidate: state.verified,
									rollback: true,
									failureCode: "reconciliation_failed",
									lastFailure,
								}),
							);
						return observe(failed("reconciliation_failed", lastFailure));
					}
					// Cleanup and route closure are retried durably, even after the
					// bounded candidate budget is exhausted. Never report clean early.
					if (
						state.phase === "cleaning" ||
						state.phase === "closing" ||
						state.phase === "stopped"
					)
						return observe(retrying);
					if (state.attempts + 1 >= maximumAttempts || authorizationTerminal)
						return observe(failed("reconciliation_failed", lastFailure));
					return observe(retrying);
				}
			});
		},
	};
}

export async function workloadManagementObservationV1(
	input: WorkloadReconciliationInputV1,
	next: WorkloadReconciliationStateV1,
): Promise<{
	request: AgentManagementTransactionRequestV1;
	decision: AgentManagementDecisionV1;
} | null> {
	const management = input.management;
	if (management.status !== "creating" && management.status !== "available")
		return null;
	const observation =
		next.phase === "ready" || next.phase === "rejected"
			? management.status === "creating"
				? "creation_succeeded"
				: "service_ready"
			: next.phase === "failed"
				? management.status === "creating"
					? "creation_failed"
					: "service_unavailable"
				: management.status === "available"
					? "service_updating"
					: null;
	if (
		!observation ||
		(observation === "service_ready" &&
			management.serviceAvailability === "ready") ||
		(observation === "service_updating" &&
			management.serviceAvailability === "updating") ||
		(observation === "service_unavailable" &&
			management.serviceAvailability === "unavailable")
	)
		return null;
	let result: {
		request: AgentManagementTransactionRequestV1;
		decision: AgentManagementDecisionV1;
	} | null = null;
	await createAgentManagementV1({
		async resolveAgentAccessState() {
			return management;
		},
		async executeAgentManagementTransaction(request, decide) {
			const decision = decide(management);
			result = { request, decision };
			return decision;
		},
	}).recordWorkloadObservation({
		schemaVersion: 1,
		observationId: `workload.${next.revision}.${next.phase}.${management.revision}`,
		agentId: management.agentId,
		expectedRevision: management.revision,
		workloadRevision: management.workloadRevision,
		fence: management.fence,
		requestId: input.requestId,
		traceId: input.traceId,
		...(observation === "creation_failed" ||
		observation === "service_unavailable"
			? {
					observation,
					failureCode: next.failureCode ?? "reconciliation_failed",
				}
			: { observation }),
	});
	return result;
}
