import { expect, it } from "vitest";
import { foldEvaluationModelFactsV1 } from "./evaluation-model-facts.js";

const model = {
	configVersion: "7",
	modelOptionId: "baseline",
	modelId: "actual-a",
};
const fact = (phase: string, extra: Record<string, unknown> = {}) => ({
	kind: "model",
	operationRef: "op",
	attemptRef: "first",
	phase,
	model,
	...extra,
});
it("counts each actual attempt once, preserves true zero, and never sums phase copies", () => {
	const result = foldEvaluationModelFactsV1(
		[
			{ sequence: 1, fact: fact("intent") },
			{ sequence: 2, fact: fact("started") },
			{
				sequence: 3,
				fact: fact("unknown", {
					usage: { inputTokens: 99 },
					failureCode: "response_incomplete",
				}),
			},
			{
				sequence: 4,
				fact: fact("completed", {
					usage: { inputTokens: 0, outputTokens: 3 },
					durationMs: 8,
				}),
			},
			{ sequence: 5, fact: fact("started", { attemptRef: "second" }) },
			{
				sequence: 6,
				fact: fact("failed", {
					attemptRef: "second",
					failureCode: "operation_failed",
				}),
			},
		],
		20,
	);
	expect(result.conditions).toEqual([{ ...model, reasoningLevel: null }]);
	expect(result.conditionStatus).toBe("single");
	expect(result.observedAttempts).toBe(2);
	expect(result.attempts).toHaveLength(2);
	expect(result.inputTokens).toEqual({ value: 0, observed: 1, total: 2 });
	expect(result.outputTokens).toEqual({ value: 3, observed: 1, total: 2 });
	expect(result.cachedInputTokens).toEqual({
		value: null,
		observed: 0,
		total: 2,
	});
	expect(result.modelDurationMs).toEqual({ value: 8, observed: 1, total: 2 });
});
it("keeps intent-only/local failure missing and mixed actual conditions explicit", () => {
	const unused = foldEvaluationModelFactsV1(
		[
			{ sequence: 1, fact: fact("intent") },
			{
				sequence: 2,
				fact: fact("failed", { failureCode: "authorization_denied" }),
			},
		],
		5,
	);
	expect(unused).toMatchObject({
		conditions: [],
		conditionStatus: "missing",
		observedAttempts: 0,
	});
	const result = foldEvaluationModelFactsV1(
		[
			{ sequence: 1, fact: fact("started") },
			{
				sequence: 2,
				fact: fact("completed", {
					attemptRef: "other",
					model: { ...model, modelId: "actual-b" },
					startedAt: "2026-10-29T00:00:00.000Z",
					usage: { inputTokens: 4 },
				}),
			},
		],
		5,
	);
	expect(result.conditionStatus).toBe("mixed");
	expect(result.conditions.map((v) => v.modelId)).toEqual([
		"actual-a",
		"actual-b",
	]);
	expect(result.inputTokens).toEqual({ value: 4, observed: 1, total: 2 });
});
it("rejects budget overflow, invalid order and changed immutable attempt identity", () => {
	const first = { sequence: 1, fact: fact("started") };
	expect(() =>
		foldEvaluationModelFactsV1([first, { ...first, sequence: 2 }], 1),
	).toThrow();
	expect(() => foldEvaluationModelFactsV1([first, first], 5)).toThrow();
	expect(() =>
		foldEvaluationModelFactsV1(
			[
				first,
				{
					sequence: 2,
					fact: fact("completed", { model: { ...model, modelId: "changed" } }),
				},
			],
			5,
		),
	).toThrow();
	expect(() =>
		foldEvaluationModelFactsV1(
			[
				{
					sequence: 1,
					fact: { ...fact("started"), secret: "synthetic-private-sentinel" },
				},
			],
			5,
		),
	).toThrow();
});

it("measures escaped wire JSON exactly and rejects even the first oversized item", async () => {
	const { requireEvaluationResponseBudgetV1 } = await import(
		"./evaluation-model-facts.js"
	);
	const value = { items: [{ text: '\n\t"\\\u0001' }], nextCursor: null };
	const exact = Buffer.byteLength(JSON.stringify(value));
	expect(requireEvaluationResponseBudgetV1(value, exact)).toBe(value);
	expect(() => requireEvaluationResponseBudgetV1(value, exact - 1)).toThrow(
		expect.objectContaining({ code: "query_too_large" }),
	);
	expect(exact).toBeGreaterThan(Buffer.byteLength(value.items[0]!.text));
});
