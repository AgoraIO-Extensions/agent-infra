import { isDeepStrictEqual } from "node:util";
import { snapshotAgentManagementDenseArray } from "./agent-management-input.js";
import { snapshotObject } from "./conversation-execution-values.js";
import {
	type ConversationOperationFactV2,
	parseConversationOperationFactV2,
} from "./conversation-operation-facts.js";
import { EvaluationDataErrorV1 } from "./evaluation-data.js";

export class EvaluationQueryLimitErrorV1 extends Error {
	readonly code = "query_too_large";
	constructor() {
		super("Evaluation query exceeds the configured budget");
	}
}
export interface EvaluationModelConditionV1 {
	readonly configVersion: string;
	readonly modelOptionId: string;
	readonly modelId: string;
	readonly reasoningLevel: string | null;
}
export interface EvaluationObservedMeasureV1 {
	readonly value: number | null;
	readonly observed: number;
	readonly total: number;
}
type ModelFact = Extract<ConversationOperationFactV2, { kind: "model" }>;
export interface EvaluationModelAttemptV1 {
	readonly operationRef: string;
	readonly attemptRef: string;
	readonly sequence: number;
	readonly phase: ModelFact["phase"];
	readonly observed: boolean;
	readonly condition: EvaluationModelConditionV1;
	readonly inputTokens: number | null;
	readonly outputTokens: number | null;
	readonly cachedInputTokens: number | null;
	readonly durationMs: number | null;
}
export interface EvaluationModelFactsV1 {
	readonly attempts: readonly EvaluationModelAttemptV1[];
	readonly observedAttempts: number;
	readonly conditions: readonly EvaluationModelConditionV1[];
	readonly conditionStatus: "missing" | "single" | "mixed";
	readonly inputTokens: EvaluationObservedMeasureV1;
	readonly outputTokens: EvaluationObservedMeasureV1;
	readonly cachedInputTokens: EvaluationObservedMeasureV1;
	readonly modelDurationMs: EvaluationObservedMeasureV1;
}

/** Reads the full bounded model subset of the persisted journal, never a UI preview. */
export function foldEvaluationModelFactsV1(
	input: unknown,
	maximumFacts: number,
): EvaluationModelFactsV1 {
	if (
		!Number.isSafeInteger(maximumFacts) ||
		maximumFacts < 1 ||
		maximumFacts > 1000000
	)
		throw new EvaluationDataErrorV1("invalid");
	if (Array.isArray(input) && input.length > maximumFacts)
		throw new EvaluationQueryLimitErrorV1();
	const rows = snapshotAgentManagementDenseArray(input, maximumFacts);
	const attempts = new Map<string, EvaluationModelAttemptV1>();
	let previousSequence = 0;
	for (const row of rows) {
		const entry = snapshotObject(row, ["sequence", "fact"]);
		if (
			typeof entry.sequence !== "number" ||
			!Number.isSafeInteger(entry.sequence) ||
			entry.sequence <= previousSequence
		)
			throw new EvaluationDataErrorV1("unavailable");
		previousSequence = entry.sequence;
		const fact = parseConversationOperationFactV2(entry.fact);
		if (fact.kind !== "model") throw new EvaluationDataErrorV1("unavailable");
		const condition = {
			...fact.model,
			reasoningLevel: fact.model.reasoningLevel ?? null,
		};
		const key = JSON.stringify([fact.operationRef, fact.attemptRef]);
		const previous = attempts.get(key);
		if (previous && !isDeepStrictEqual(previous.condition, condition))
			throw new EvaluationDataErrorV1("unavailable");
		// The persisted writer validates full operation ancestry; this model-only subset cannot.
		attempts.set(key, {
			operationRef: fact.operationRef,
			attemptRef: fact.attemptRef,
			sequence: entry.sequence,
			phase: fact.phase,
			condition,
			observed:
				previous?.observed === true ||
				fact.phase === "started" ||
				fact.startedAt !== undefined,
			inputTokens: fact.usage?.inputTokens ?? null,
			outputTokens: fact.usage?.outputTokens ?? null,
			cachedInputTokens: fact.usage?.cachedInputTokens ?? null,
			durationMs: fact.durationMs ?? null,
		});
	}
	const values = [...attempts.values()];
	const observed = values.filter((attempt) => attempt.observed);
	const conditions = [
		...new Map(
			observed.map((attempt) => [
				JSON.stringify(attempt.condition),
				attempt.condition,
			]),
		).entries(),
	]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, condition]) => condition);
	function measure(
		key: "inputTokens" | "outputTokens" | "cachedInputTokens" | "durationMs",
	): EvaluationObservedMeasureV1 {
		const present = observed.flatMap((attempt) =>
			attempt[key] === null ? [] : [attempt[key]],
		);
		const value = present.reduce((sum, count) => sum + count, 0);
		if (!Number.isSafeInteger(value))
			throw new EvaluationDataErrorV1("unavailable");
		return {
			value: present.length ? value : null,
			observed: present.length,
			total: observed.length,
		};
	}
	return {
		attempts: values,
		observedAttempts: observed.length,
		conditions,
		conditionStatus:
			conditions.length === 0
				? "missing"
				: conditions.length === 1
					? "single"
					: "mixed",
		inputTokens: measure("inputTokens"),
		outputTokens: measure("outputTokens"),
		cachedInputTokens: measure("cachedInputTokens"),
		modelDurationMs: measure("durationMs"),
	};
}
