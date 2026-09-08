import type { AgentConfigurationRecordV1 } from "./agent-configuration.js";
import {
	type AgentManagementDecisionV1,
	type AgentManagementStateV1,
	type AgentManagementTransactionRequestV1,
	createAgentManagementV1,
} from "./agent-management.js";
import type { SecretActivationStorePortV1 } from "./secret-activation.js";

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

export interface WorkloadVersionV1 {
	readonly configuration: AgentConfigurationRecordV1;
	/** Validated, credential-free deployment contract; never a Kubernetes object. */
	readonly deployment: unknown;
}

export interface WorkloadReconciliationStateV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly sourceConfigurationRevision: number;
	readonly sourceLifecycleRevision: number;
	readonly revision: number;
	readonly phase: WorkloadPhaseV1;
	readonly candidate: WorkloadVersionV1;
	readonly verified: WorkloadVersionV1 | null;
	readonly verifiedRevision: number | null;
	readonly identity: WorkloadIdentityV1 | null;
	readonly rollback: boolean;
	readonly failureCode: "reconciliation_failed" | "health_check_failed" | null;
	readonly attempts: number;
	readonly capabilities?: Readonly<Record<string, boolean>>;
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
	readonly configuration: AgentConfigurationRecordV1;
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

/** The Store serializes each step with lifecycle/configuration writers. */
export interface WorkloadReconciliationStorePortV1 {
	runNext(
		workerId: string,
		step: (
			input: WorkloadReconciliationInputV1,
		) => Promise<WorkloadReconciliationStateV1>,
	): Promise<"idle" | "advanced">;
}

export interface WorkloadRuntimePortV1 {
	capabilities(
		state: WorkloadReconciliationStateV1,
	): Promise<Readonly<Record<string, boolean>>>;
	preflight(
		input: WorkloadReconciliationInputV1,
		state: WorkloadReconciliationStateV1,
	): Promise<WorkloadVersionV1>;
	closeRoute(state: WorkloadReconciliationStateV1): Promise<void>;
	apply(
		state: WorkloadReconciliationStateV1,
		stopped: boolean,
		input: WorkloadReconciliationInputV1,
	): Promise<WorkloadIdentityV1 | "pending" | null>;
	observe(
		state: WorkloadReconciliationStateV1,
	): Promise<"pending" | "healthy" | "unhealthy" | "drifted">;
	activateSecrets(
		state: WorkloadReconciliationStateV1,
		input: WorkloadReconciliationInputV1,
	): Promise<"pending" | "active" | "failed">;
	promote(state: WorkloadReconciliationStateV1): Promise<void>;
	cleanup(
		state: WorkloadReconciliationStateV1,
		deleteNewVolume: boolean,
		input: WorkloadReconciliationInputV1,
	): Promise<boolean>;
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
}) {
	const maximumAttempts = dependencies.maximumAttempts ?? 60;
	if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1)
		throw new TypeError("Invalid Workload retry limit");
	const runtime = dependencies.runtime;
	return {
		async tick(workerId: string): Promise<"idle" | "advanced"> {
			if (!workerId || workerId.includes("\0"))
				throw new TypeError("Invalid Worker identity");
			return dependencies.store.runNext(workerId, async (input) => {
				const { management, configuration } = input;
				let state = input.state;
				const stopped =
					management.desiredState === "stopped" ||
					management.status === "disabled";
				if (
					!state ||
					state.sourceConfigurationRevision !== configuration.revision ||
					state.sourceLifecycleRevision !== management.workloadRevision
				) {
					state = {
						schemaVersion: 1,
						agentId: management.agentId,
						sourceConfigurationRevision: configuration.revision,
						sourceLifecycleRevision: management.workloadRevision,
						revision: nextRevision(state?.revision ?? 0),
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
				) => ({ ...state, phase, attempts: 0, ...changes });
				const failed = (
					failureCode: "reconciliation_failed" | "health_check_failed",
				) => advance("cleaning", { failureCode });
				try {
					switch (state.phase) {
						case "preflight": {
							const candidate = await runtime.preflight(input, state);
							if (
								candidate.configuration.source.imageDigest !==
								state.candidate.configuration.source.imageDigest
							)
								throw new Error();
							const previous = state.verified?.configuration.source;
							const current = candidate.configuration.source;
							const mode = (source: typeof current) =>
								source.kind === "standard"
									? "platform-adapter"
									: source.interactionMode;
							if (previous && mode(previous) !== mode(current))
								throw new Error();
							return advance("closing", { candidate });
						}
						case "closing":
							await runtime.closeRoute(state);
							return advance("applying");
						case "applying": {
							const identity = await runtime.apply(state, stopped, input);
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
						case "promoting":
							// Recheck the exact observed identity immediately before exposure.
							if ((await runtime.observe(state)) !== "healthy") {
								await runtime.closeRoute(state);
								return failed("health_check_failed");
							}
							{
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
								return state;
							}
							await runtime.closeRoute(state);
							return health === "drifted"
								? advance("applying", {
										revision: nextRevision(state.revision),
									})
								: advance("observing");
						}
						case "rejected":
							if ((await runtime.observe(state)) === "healthy") {
								await runtime.promote(state);
								return state;
							}
							return advance("closing", {
								revision: nextRevision(state.revision),
							});
						case "cleaning":
							await runtime.closeRoute(state);
							if (state.verified && !state.rollback) {
								return advance("applying", {
									candidate: state.verified,
									revision: nextRevision(state.revision),
									rollback: true,
								});
							}
							if (
								!(await runtime.cleanup(state, state.verified === null, input))
							)
								return state;
							return advance("failed", { identity: null });
						case "stopped":
							await runtime.closeRoute(state);
							await runtime.apply(state, true, input);
							return state;
						case "failed":
							await runtime.closeRoute(state);
							if (
								!(await runtime.cleanup(state, state.verified === null, input))
							)
								return advance("cleaning");
							return state;
					}
				} catch {
					if (state.phase === "preflight" && state.verified) {
						return advance("rejected", {
							candidate: state.verified,
							rollback: true,
							failureCode: "reconciliation_failed",
						});
					}
					// Cleanup and route closure are retried durably, even after the
					// bounded candidate budget is exhausted. Never report clean early.
					if (
						state.phase === "cleaning" ||
						state.phase === "closing" ||
						state.phase === "stopped"
					)
						return {
							...state,
							attempts: Math.min(state.attempts + 1, maximumAttempts),
						};
					if (
						state.phase === "preflight" ||
						state.attempts + 1 >= maximumAttempts
					)
						return failed("reconciliation_failed");
					return { ...state, attempts: state.attempts + 1 };
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
