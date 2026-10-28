import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
	planEvaluationCancelledScoreV1,
	planEvaluationScoreFailureV1,
} from "./evaluation-score-intents.js";
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
		datasetScopes: ["team"],
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

it("keeps scoring failure budgets and unknown reconciliation in Core", () => {
	const base = {
		status: "pending" as const,
		attempts: 1,
		revision: 4,
		failureCode: null,
		scorer: { maxAttempts: 2, retryDelayMs: 17 },
	};
	expect(
		planEvaluationScoreFailureV1(base, "SCORER_UNAVAILABLE"),
	).toMatchObject({
		state: { status: "pending", attempts: 1, revision: 5 },
		retry: true,
		delayMs: 17,
	});
	expect(
		planEvaluationScoreFailureV1(base, "SCORER_UNAVAILABLE", true),
	).toMatchObject({ state: { status: "failed", attempts: 2 }, retry: false });
	expect(
		planEvaluationScoreFailureV1(
			{ ...base, status: "result_ready" },
			"SCORER_UNAVAILABLE",
		),
	).toMatchObject({
		state: { status: "result_ready", attempts: 2 },
		retry: true,
	});
	expect(
		planEvaluationScoreFailureV1(
			{ ...base, status: "result_ready", attempts: 2 },
			"SCORER_UNAVAILABLE",
		),
	).toMatchObject({ state: { status: "failed", attempts: 2 }, retry: false });
	expect(
		planEvaluationScoreFailureV1(
			{ ...base, status: "unknown", attempts: 2 },
			"SCORER_UNAVAILABLE",
		),
	).toMatchObject({ state: { status: "unknown", attempts: 2 }, retry: true });
	expect(
		planEvaluationScoreFailureV1(
			{ ...base, status: "unknown", attempts: 2 },
			"SCORER_UNAVAILABLE",
			true,
		),
	).toMatchObject({ state: { status: "unknown", attempts: 2 }, retry: false });
	expect(
		planEvaluationScoreFailureV1(
			{ ...base, status: "unknown" },
			"SCORER_AUTHORIZATION_DENIED",
		),
	).toMatchObject({
		state: { status: "failed", failureCode: "SCORER_AUTHORIZATION_DENIED" },
		retry: false,
	});
	for (const status of ["scored", "not_applicable", "failed"] as const)
		expect(
			planEvaluationScoreFailureV1(
				{ ...base, status },
				"SCORER_UNAVAILABLE",
				true,
			),
		).toEqual({ state: null, retry: false, delayMs: 17 });
});

it("settles cancelled experiment metadata without inventing Task or model outcomes", () => {
	const intent = {
		status: "waiting_output" as const,
		revision: 1,
		scorer: scorer(),
	};
	expect(planEvaluationCancelledScoreV1(intent, "active", "completed")).toEqual(
		{ outcome: "proceed" },
	);
	for (const taskStatus of ["waiting", "submitted", "processing", "unknown"])
		expect(
			planEvaluationCancelledScoreV1(intent, "cancelled", taskStatus),
		).toMatchObject({ outcome: "waiting" });
	for (const taskStatus of ["failed", "cancelled"])
		expect(
			planEvaluationCancelledScoreV1(intent, "cancelled", taskStatus),
		).toEqual({
			outcome: "settle",
			status: "not_applicable",
			revision: 2,
			failureCode: "TASK_NOT_COMPLETED",
		});
	expect(
		planEvaluationCancelledScoreV1(
			{ ...intent, status: "awaiting_human" },
			"cancelled",
			"completed",
		),
	).toMatchObject({ outcome: "settle", failureCode: "EXPERIMENT_CANCELLED" });
	for (const status of [
		"scored",
		"not_applicable",
		"failed",
		"unknown",
		"result_ready",
	] as const)
		expect(
			planEvaluationCancelledScoreV1(
				{ ...intent, status },
				"cancelled",
				"cancelled",
			),
		).toEqual({ outcome: "terminal" });
});
