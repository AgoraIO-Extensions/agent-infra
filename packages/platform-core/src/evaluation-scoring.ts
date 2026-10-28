import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { snapshotAgentManagementDenseArray } from "./agent-management-input.js";
import { snapshotObject } from "./conversation-execution-values.js";
import { EvaluationDataErrorV1 } from "./evaluation-data.js";

export type EvaluationScoreOutcomeV1 =
	| {
			readonly status: "scored";
			readonly value: number;
			readonly passed: boolean;
			readonly reason: string;
	  }
	| {
			readonly status: "not_applicable";
			readonly value: null;
			readonly passed: null;
			readonly reason: string;
	  };
export type EvaluationScorerV1 = {
	readonly scorerId: string;
	readonly version: string;
	readonly configurationDigest: string;
	readonly rubricId: string;
	readonly minimum: number;
	readonly maximum: number;
	readonly passThreshold: number;
	readonly maxInputBytes: number;
	readonly maxOutputBytes: number;
	readonly timeoutMs: number;
	readonly maxAttempts: number;
	readonly retryDelayMs: number;
	readonly datasetScopes: readonly string[];
	readonly implementation:
		| {
				readonly kind: "rule";
				readonly rule: "exact_match" | "contains" | "json_equal";
		  }
		| { readonly kind: "human" }
		| {
				readonly kind: "model";
				readonly endpointId: string;
				readonly modelId: string;
				readonly catalogRevision: string;
				readonly maxOutputTokens: number;
				readonly inputCategories: readonly (
					| "sample"
					| "context"
					| "expected"
					| "output"
					| "rubric"
				)[];
		  };
};
const invalid = (): never => {
	throw new EvaluationDataErrorV1("invalid");
};
function object(input: unknown, keys: string[]) {
	try {
		return snapshotObject(input, keys);
	} catch {
		return invalid();
	}
}
function text(input: unknown, max = 256) {
	if (
		typeof input !== "string" ||
		!input ||
		input.length > max ||
		!input.isWellFormed() ||
		[...input].some(
			(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
		)
	)
		return invalid();
	return input;
}
function integer(input: unknown, max: number) {
	if (
		typeof input !== "number" ||
		!Number.isSafeInteger(input) ||
		input < 1 ||
		input > max
	)
		return invalid();
	return input;
}
function finite(input: unknown) {
	if (typeof input !== "number" || !Number.isFinite(input)) return invalid();
	return input;
}
function reason(input: unknown, maxBytes: number) {
	if (
		typeof input !== "string" ||
		!input.isWellFormed() ||
		input.includes("\0") ||
		Buffer.byteLength(input) > maxBytes
	)
		return invalid();
	return input;
}

/** Deployment supplies an immutable registry, never caller scripts or endpoint URLs. */
export function parseEvaluationScorerV1(input: unknown): EvaluationScorerV1 {
	const v = object(input, [
		"scorerId",
		"version",
		"configurationDigest",
		"rubricId",
		"minimum",
		"maximum",
		"passThreshold",
		"maxInputBytes",
		"maxOutputBytes",
		"timeoutMs",
		"maxAttempts",
		"retryDelayMs",
		"datasetScopes",
		"implementation",
	]);
	const minimum = finite(v.minimum);
	const maximum = finite(v.maximum);
	const passThreshold = finite(v.passThreshold);
	if (minimum >= maximum || passThreshold <= minimum || passThreshold > maximum)
		return invalid();
	const raw = v.implementation;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
	const kind = Object.getOwnPropertyDescriptor(raw, "kind")?.value;
	let implementation: EvaluationScorerV1["implementation"];
	if (kind === "rule") {
		const r = object(raw, ["kind", "rule"]);
		if (
			typeof r.rule !== "string" ||
			!["exact_match", "contains", "json_equal"].includes(r.rule)
		)
			return invalid();
		implementation = {
			kind,
			rule: r.rule as "exact_match" | "contains" | "json_equal",
		};
	} else if (kind === "human") {
		object(raw, ["kind"]);
		implementation = { kind };
	} else if (kind === "model") {
		const m = object(raw, [
			"kind",
			"endpointId",
			"modelId",
			"catalogRevision",
			"maxOutputTokens",
			"inputCategories",
		]);
		const categories = snapshotAgentManagementDenseArray(m.inputCategories, 5);
		if (!categories.length) return invalid();
		const inputCategories = categories.map((entry: unknown) => {
			if (
				typeof entry !== "string" ||
				!["sample", "context", "expected", "output", "rubric"].includes(entry)
			)
				return invalid();
			return entry as "sample" | "context" | "expected" | "output" | "rubric";
		});
		if (
			new Set(inputCategories).size !== inputCategories.length ||
			!inputCategories.includes("output") ||
			!inputCategories.includes("rubric")
		)
			return invalid();
		implementation = {
			kind,
			endpointId: text(m.endpointId),
			modelId: text(m.modelId),
			catalogRevision: text(m.catalogRevision),
			maxOutputTokens: integer(m.maxOutputTokens, 100000),
			inputCategories,
		};
	} else return invalid();
	const result = {
		scorerId: text(v.scorerId),
		version: text(v.version),
		rubricId: text(v.rubricId),
		minimum,
		maximum,
		passThreshold,
		maxInputBytes: integer(v.maxInputBytes, 1024 * 1024),
		maxOutputBytes: integer(v.maxOutputBytes, 1024 * 1024),
		timeoutMs: integer(v.timeoutMs, 300000),
		maxAttempts: integer(v.maxAttempts, 10),
		retryDelayMs: integer(v.retryDelayMs, 86400000),
		datasetScopes: snapshotAgentManagementDenseArray(v.datasetScopes, 100).map(
			(scope) => text(scope),
		),
		implementation,
	};
	if (
		!result.datasetScopes.length ||
		new Set(result.datasetScopes).size !== result.datasetScopes.length
	)
		return invalid();
	const configurationDigest = text(v.configurationDigest, 64);
	if (
		!/^[a-f0-9]{64}$/.test(configurationDigest) ||
		createHash("sha256").update(JSON.stringify(result)).digest("hex") !==
			configurationDigest
	)
		return invalid();
	return { ...result, configurationDigest };
}
/** Strict human/model output. A scorer failure is represented by intent state, never zero. */
export function parseEvaluationScoreOutcomeV1(
	input: unknown,
	scorer: EvaluationScorerV1,
): EvaluationScoreOutcomeV1 {
	const v = object(input, ["status", "value", "reason"]);
	const rationale = reason(v.reason, scorer.maxOutputBytes);
	if (Buffer.byteLength(JSON.stringify(v)) > scorer.maxOutputBytes)
		return invalid();
	if (v.status === "not_applicable") {
		if (v.value !== null) return invalid();
		return { status: v.status, value: null, passed: null, reason: rationale };
	}
	if (v.status !== "scored") return invalid();
	const value = finite(v.value);
	if (value < scorer.minimum || value > scorer.maximum) return invalid();
	return {
		status: v.status,
		value,
		passed: value >= scorer.passThreshold,
		reason: rationale,
	};
}
/** Only fixed deterministic implementations; no eval(), regex, or uploaded scripts. */
export function scoreEvaluationRuleV1(input: {
	scorer: EvaluationScorerV1;
	output: string;
	expected: string | null;
}): EvaluationScoreOutcomeV1 {
	const { scorer, output, expected } = input;
	if (
		scorer.implementation.kind !== "rule" ||
		Buffer.byteLength(JSON.stringify({ output, expected })) >
			scorer.maxInputBytes
	)
		return invalid();
	reason(output, scorer.maxInputBytes);
	if (expected !== null) reason(expected, scorer.maxInputBytes);
	if (expected === null)
		return {
			status: "not_applicable",
			value: null,
			passed: null,
			reason: "expected_result_missing",
		};
	let matches = false;
	if (scorer.implementation.rule === "exact_match")
		matches = output === expected;
	else if (scorer.implementation.rule === "contains")
		matches = output.includes(expected);
	else {
		let expectedJson: unknown;
		let outputJson: unknown;
		try {
			expectedJson = JSON.parse(expected);
		} catch {
			return {
				status: "not_applicable",
				value: null,
				passed: null,
				reason: "invalid_expected_json",
			};
		}
		try {
			outputJson = JSON.parse(output);
		} catch {
			return {
				status: "scored",
				value: scorer.minimum,
				passed: false,
				reason: "output_not_json",
			};
		}
		const bounded = (root: unknown) => {
			const stack: [unknown, number][] = [[root, 0]];
			while (stack.length) {
				const pair = stack.pop();
				if (!pair) break;
				const [value, depth] = pair;
				if (depth > 100) return invalid();
				if (value !== null && typeof value === "object")
					for (const child of Object.values(value))
						stack.push([child, depth + 1]);
			}
		};
		bounded(expectedJson);
		bounded(outputJson);
		matches = isDeepStrictEqual(expectedJson, outputJson);
	}
	const value = matches ? scorer.maximum : scorer.minimum;
	return {
		status: "scored",
		value,
		passed: value >= scorer.passThreshold,
		reason: matches ? "rule_matched" : "rule_not_matched",
	};
}

/** A separate review may disagree but cannot rewrite the original score or impersonate its author. */
export function requireIndependentEvaluationReviewV1(input: {
	reviewer: { kind: string; id: string };
	scorerActor: { kind: string; id: string };
	expectedRevision: number;
	actualRevision: number;
}) {
	if (
		input.reviewer.kind === input.scorerActor.kind &&
		input.reviewer.id === input.scorerActor.id
	)
		throw new EvaluationDataErrorV1("denied");
	if (
		!Number.isSafeInteger(input.expectedRevision) ||
		input.expectedRevision < 1
	)
		return invalid();
	if (input.expectedRevision !== input.actualRevision)
		throw new EvaluationDataErrorV1("conflict");
}
