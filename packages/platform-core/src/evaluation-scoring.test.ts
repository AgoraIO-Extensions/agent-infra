import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
	parseEvaluationScoreOutcomeV1,
	parseEvaluationScorerV1,
	requireIndependentEvaluationReviewV1,
	scoreEvaluationRuleV1,
} from "./evaluation-scoring.js";

function scorer(
	rule: "exact_match" | "contains" | "json_equal" = "exact_match",
) {
	const value = {
		scorerId: "fixture",
		version: "1",
		rubricId: "quality",
		minimum: 0,
		maximum: 1,
		passThreshold: 1,
		maxInputBytes: 65536,
		maxOutputBytes: 1024,
		timeoutMs: 1000,
		maxAttempts: 2,
		retryDelayMs: 1000,
		implementation: { kind: "rule", rule },
	};
	return parseEvaluationScorerV1({
		...value,
		configurationDigest: createHash("sha256")
			.update(JSON.stringify(value))
			.digest("hex"),
	});
}
it("keeps deterministic results and missing inputs distinct from zero scores", () => {
	expect(
		scoreEvaluationRuleV1({ scorer: scorer(), output: "yes", expected: "yes" }),
	).toMatchObject({ status: "scored", value: 1, passed: true });
	expect(
		scoreEvaluationRuleV1({ scorer: scorer(), output: "no", expected: "yes" }),
	).toMatchObject({ status: "scored", value: 0, passed: false });
	expect(
		scoreEvaluationRuleV1({ scorer: scorer(), output: "yes", expected: null }),
	).toMatchObject({ status: "not_applicable", value: null, passed: null });
	expect(
		scoreEvaluationRuleV1({
			scorer: scorer("json_equal"),
			output: '{"b":2,"a":1}',
			expected: '{"a":1,"b":2}',
		}).value,
	).toBe(1);
});
it("rejects unpinned scorers, authority-bearing model output, invalid ranges and oversized reasons", () => {
	expect(() =>
		parseEvaluationScorerV1({ ...scorer(), version: "changed" }),
	).toThrow();
	for (const value of [
		{ status: "scored", value: 2, reason: "x" },
		{ status: "scored", value: 1, reason: "x", tools: [] },
		{ status: "not_applicable", value: 0, reason: "x" },
		{ status: "scored", value: 1, reason: "x".repeat(1025) },
	])
		expect(() => parseEvaluationScoreOutcomeV1(value, scorer())).toThrow();
});
it("independent review preserves typed subjects and original score revision", () => {
	const base = {
		reviewer: { kind: "user", id: "same" },
		scorerActor: { kind: "user", id: "same" },
		expectedRevision: 1,
		actualRevision: 1,
	};
	expect(() => requireIndependentEvaluationReviewV1(base)).toThrow(
		expect.objectContaining({ code: "denied" }),
	);
	expect(() =>
		requireIndependentEvaluationReviewV1({
			...base,
			reviewer: { kind: "application", id: "same" },
		}),
	).not.toThrow();
	expect(() =>
		requireIndependentEvaluationReviewV1({
			...base,
			reviewer: { kind: "user", id: "other" },
			expectedRevision: 2,
		}),
	).toThrow(expect.objectContaining({ code: "conflict" }));
});

it("does not coerce rule/category objects or evaluate category getters", () => {
	let calls = 0;
	const impostor = {
		toString() {
			calls++;
			return "exact_match";
		},
	};
	expect(() =>
		parseEvaluationScorerV1({
			...scorer(),
			implementation: { kind: "rule", rule: impostor },
		}),
	).toThrow();
	const categories = ["output", "rubric"];
	Object.defineProperty(categories, "0", {
		get() {
			calls++;
			return "output";
		},
	});
	expect(() =>
		parseEvaluationScorerV1({
			...scorer(),
			implementation: {
				kind: "model",
				endpointId: "e",
				modelId: "m",
				catalogRevision: "c",
				maxOutputTokens: 100,
				inputCategories: categories,
			},
		}),
	).toThrow();
	expect(calls).toBe(0);
});

it("counts invalid JSON output as failure but keeps an invalid expected fixture separately not applicable", () => {
	expect(
		scoreEvaluationRuleV1({
			scorer: scorer("json_equal"),
			output: "bad answer",
			expected: '{"x":1}',
		}),
	).toMatchObject({
		status: "scored",
		value: 0,
		passed: false,
		reason: "output_not_json",
	});
	expect(
		scoreEvaluationRuleV1({
			scorer: scorer("json_equal"),
			output: '{"x":1}',
			expected: "invalid fixture",
		}),
	).toMatchObject({
		status: "not_applicable",
		value: null,
		reason: "invalid_expected_json",
	});
	expect(() =>
		scoreEvaluationRuleV1({
			scorer: scorer("json_equal"),
			output: "[".repeat(102) + "0" + "]".repeat(102),
			expected: "[]",
		}),
	).toThrow();
});
