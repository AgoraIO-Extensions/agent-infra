import {
	type RuntimeIsolationEvidenceV1,
	RuntimeIsolationEvidenceV1Schema,
	type RuntimeSafetyEvidenceBindingV1,
	type RuntimeSafetyEvidenceWindowV1,
} from "@agent-infra/contracts/runtime";
import {
	type CodexModelContextReceiptV1,
	type CodexModelContextScenarioV1,
	codexModelContextProducerVersionV1,
	codexModelContextScenarioV1,
} from "./codex-model-context-observation.js";
import { runtimeSafetyEvidenceWindowAdmitsV1 } from "./safety-evidence-log.js";

/**
 * The common binding of one Execution (Spec §18.5.1 共同绑定), resolved by the Host from the
 * original Grant and its own deployment identity. Producers never invent a field: without a
 * complete source no evidence is produced and the result stays UNPROVEN.
 */
export type RuntimeSafetyEvidenceBindingSourceV1 = Omit<
	RuntimeSafetyEvidenceBindingV1,
	| "evidenceId"
	| "scenario"
	| "windowRef"
	| "challengeRef"
	| "operation"
	| "producer"
	| "observedAt"
	| "sequence"
>;

/**
 * Turns the per-attempt receipts of one closed Execution into immutable
 * `RUNTIME_ISOLATION_EVIDENCE_V1` records (`model_context`, `model_request`, `self`). Outside
 * the window, its subjects, Agents, scenario or producer version nothing is produced.
 */
export function buildCodexModelContextEvidenceV1(input: {
	readonly receipts: readonly CodexModelContextReceiptV1[];
	readonly binding: RuntimeSafetyEvidenceBindingSourceV1;
	readonly window: RuntimeSafetyEvidenceWindowV1 | undefined;
	readonly now: Date;
	/** Monotonic sequence of the producer's clock domain (`binding.clockId`). */
	readonly nextSequence: () => number;
	readonly randomRef: () => string;
	readonly scenario?: CodexModelContextScenarioV1;
}): readonly RuntimeIsolationEvidenceV1[] {
	const scenario = input.scenario ?? codexModelContextScenarioV1;
	const { window, binding } = input;
	if (
		!window ||
		!runtimeSafetyEvidenceWindowAdmitsV1({
			window,
			agentId: binding.agentId,
			principalRef: binding.principalRef,
			now: input.now,
		}) ||
		!window.scenarios.some(
			(entry) =>
				entry.id === scenario.id &&
				entry.version === scenario.version &&
				entry.resourceClasses.includes("model_context") &&
				entry.actionClasses.includes("model_request"),
		) ||
		!window.producers.some(
			(producer) =>
				producer.kind === "model_transport" &&
				producer.version === codexModelContextProducerVersionV1,
		)
	)
		return [];
	const records: RuntimeIsolationEvidenceV1[] = [];
	for (const receipt of input.receipts) {
		const complete = receipt.observationComplete;
		const resultClass = !complete
			? "unproven"
			: !receipt.foreignMarkerAbsent
				? "isolation_violation"
				: receipt.selfMarkerPresent
					? "allowed"
					: "unproven";
		const parsed = RuntimeIsolationEvidenceV1Schema.safeParse({
			schemaVersion: 1,
			code: "RUNTIME_ISOLATION_EVIDENCE_V1",
			kind: "isolation_observation",
			binding: {
				...structuredClone(binding),
				evidenceId: input.randomRef(),
				scenario: { id: scenario.id, version: scenario.version },
				windowRef: window.windowRef,
				// Fixed when the request arrived, before it was observed; one per receipt.
				challengeRef: receipt.challengeRef,
				operation: {
					ref: receipt.operationRef,
					attemptRef: receipt.attemptRef,
				},
				producer: {
					kind: "model_transport",
					version: codexModelContextProducerVersionV1,
				},
				observedAt: input.now.toISOString(),
				sequence: input.nextSequence(),
			},
			resourceClass: "model_context",
			actionClass: "model_request",
			targetScope: "self",
			resultClass,
			nativeObserved: receipt.observed,
			...(resultClass === "unproven"
				? { failureClass: complete ? "unknown" : "io_unavailable" }
				: {}),
			modelContext: {
				selfMarkerPresent: receipt.selfMarkerPresent,
				foreignMarkerAbsent: receipt.foreignMarkerAbsent,
				observationComplete: complete,
			},
		});
		if (parsed.success) records.push(parsed.data);
	}
	return records;
}
