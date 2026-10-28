import { expect, it } from "vitest";
import {
	type EvaluationAnalysisTaskV1,
	summarizeEvaluationExperimentV1,
} from "./evaluation-analysis.js";
import type { EvaluationExperimentV1 } from "./evaluation-experiments.js";
import { foldEvaluationModelFactsV1 } from "./evaluation-model-facts.js";

const experiment: EvaluationExperimentV1 = {
	principal: { kind: "user", id: "self" },
	policyId: "policy",
	policyRevision: 1,
	status: "active",
	revision: 1,
	createdAt: "2026-10-29T00:00:00.000Z",
	metadataExpiresAt: "2026-10-30T00:00:00.000Z",
	experimentId: "e",
	datasetId: "d",
	versionId: "v",
	sampleIds: ["a", "b", "c", "d", "e", "f"],
	variantIds: ["base", "candidate"],
	comparisonTargets: ["model"],
	scorerRefs: [{ scorerId: "s", version: "1" }],
};
function task(
	sampleId: string,
	status: string,
	scoreStatus: string,
	variantId = "base",
): EvaluationAnalysisTaskV1 {
	const id = sampleId + variantId;
	return {
		task: {
			sampleTaskId: id,
			sampleId,
			variantId,
			experimentId: "e",
			executionId: id,
			binding: { toolEnvironment: "controlled" },
			requestedEvidence: {
				configurationRevision: 1,
				configurationDigest: "a".repeat(64),
				imageDigest: "sha256:synthetic",
				templateId: "fixture",
				model: {
					configVersion: "1",
					modelOptionId: "option",
					modelId: "actual",
					reasoningLevel: null,
				},
			},
			preparedRuntime: {
				imageDigest: "sha256:synthetic",
				configurationRevision: 1,
				resourceConfigurationHash: "x",
			},
		} as EvaluationAnalysisTaskV1["task"],
		status,
		taskDurationMs: null,
		actual: foldEvaluationModelFactsV1(
			[
				{
					sequence: 1,
					fact: {
						kind: "model",
						operationRef: "op",
						attemptRef: "first",
						phase: "started",
						model: {
							configVersion: "1",
							modelOptionId: "option",
							modelId: "actual",
						},
					},
				},
			],
			10,
		),
		scores: [
			{
				sampleTaskId: id,
				executionId: id,
				experimentId: "e",
				scorer: { scorerId: "s", version: "1" },
				status: scoreStatus,
				passed: scoreStatus === "scored" ? true : null,
				value: scoreStatus === "scored" ? 1 : null,
			} as EvaluationAnalysisTaskV1["scores"][number],
		],
	};
}
it("keeps all fixed samples and mutually exclusive outcome categories for each variant/scorer", () => {
	const rows = [
		task("a", "completed", "scored"),
		task("b", "completed", "failed"),
		task("c", "completed", "not_applicable"),
		task("d", "failed", "failed"),
		task("e", "completed", "awaiting_human"),
	];
	const result = summarizeEvaluationExperimentV1({
		experiment,
		tasks: rows,
		taskTypes: new Map([
			["a", "answer"],
			["b", "tool"],
		]),
	});
	expect(result.groups[0]?.counts).toEqual({
		fixedSamples: 6,
		scored: 1,
		passed: 1,
		notPassed: 0,
		scoreError: 1,
		notApplicable: 1,
		businessFailed: 1,
		unscored: 1,
		missing: 1,
	});
	expect(result.groups[1]?.counts.missing).toBe(6);
	expect(result.pairs[0]?.counts).toMatchObject({
		fixedSamples: 6,
		comparable: 0,
		missingConditions: 6,
	});
	expect(result.groups[0]?.passRate).toBe(1);
});
it("separates missing, mixed and changed environment from comparable pairs", () => {
	const a = task("a", "completed", "scored");
	const b = task("a", "completed", "scored", "candidate");
	const result = summarizeEvaluationExperimentV1({
		experiment: { ...experiment, sampleIds: ["a"] },
		tasks: [a, b],
		taskTypes: null,
	});
	expect(result.pairs[0]?.counts.comparable).toBe(1);
	expect(result.taskTypesAvailable).toBe(false);
	const changed = {
		...b,
		task: {
			...b.task,
			binding: { ...b.task.binding, toolEnvironment: "different" },
		},
	};
	expect(
		summarizeEvaluationExperimentV1({
			experiment: { ...experiment, sampleIds: ["a"] },
			tasks: [a, changed],
			taskTypes: null,
		}).pairs[0]?.counts.differentEnvironment,
	).toBe(1);
	expect(() =>
		summarizeEvaluationExperimentV1({
			experiment,
			tasks: [a, a],
			taskTypes: null,
		}),
	).toThrow();
});

it.each([
	"old_evidence",
	"old_targets",
	"actual_model",
	"actual_image",
	"configuration",
	"template",
	"mixed",
] as const)("does not claim a same-condition comparison for %s", (mode) => {
	const a = task("a", "completed", "scored");
	const b = task("a", "completed", "scored", "candidate");
	let exp = { ...experiment, sampleIds: ["a"] };
	if (mode === "old_evidence")
		b.task = { ...b.task, requestedEvidence: undefined };
	if (mode === "old_targets") exp = { ...exp, comparisonTargets: undefined };
	if (mode === "actual_model")
		b.actual = {
			...b.actual,
			conditions: [{ ...b.actual.conditions[0]!, modelId: "unexpected" }],
		};
	if (mode === "actual_image")
		b.task = {
			...b.task,
			preparedRuntime: { ...b.task.preparedRuntime!, imageDigest: "drift" },
		};
	if (mode === "configuration")
		b.task = {
			...b.task,
			requestedEvidence: {
				...b.task.requestedEvidence!,
				configurationDigest: "b".repeat(64),
			},
		};
	if (mode === "template")
		b.task = {
			...b.task,
			requestedEvidence: {
				...b.task.requestedEvidence!,
				imageDigest: "changed",
			},
			preparedRuntime: { ...b.task.preparedRuntime!, imageDigest: "changed" },
		};
	if (mode === "mixed") b.actual = { ...b.actual, conditionStatus: "mixed" };
	const result = summarizeEvaluationExperimentV1({
		experiment: exp,
		tasks: [a, b],
		taskTypes: null,
	});
	expect(result.pairs[0]?.counts.comparable).toBe(0);
});
it("allows only explicitly combined target changes after each actual side matches frozen evidence", () => {
	const a = task("a", "completed", "scored");
	const b = task("a", "completed", "scored", "candidate");
	b.task = {
		...b.task,
		requestedEvidence: {
			...b.task.requestedEvidence!,
			configurationDigest: "b".repeat(64),
			model: { ...b.task.requestedEvidence!.model!, modelId: "candidate" },
		},
	};
	b.actual = {
		...b.actual,
		conditions: [{ ...b.actual.conditions[0]!, modelId: "candidate" }],
	};
	expect(
		summarizeEvaluationExperimentV1({
			experiment: {
				...experiment,
				sampleIds: ["a"],
				comparisonTargets: ["model", "configuration"],
			},
			tasks: [a, b],
			taskTypes: null,
		}).pairs[0]?.counts.comparable,
	).toBe(1);
	expect(
		summarizeEvaluationExperimentV1({
			experiment: {
				...experiment,
				sampleIds: ["a"],
				comparisonTargets: ["model"],
			},
			tasks: [a, b],
			taskTypes: null,
		}).pairs[0]?.counts.nonTargetDrift,
	).toBe(1);
});

it("keeps comparison intent in the idempotency request and rejects invented or duplicate target dimensions", async () => {
	const {
		parseEvaluationExperimentCreateV1,
		parseEvaluationRequestedEvidenceV1,
	} = await import("./evaluation-experiments.js");
	const base = {
		datasetId: "d",
		versionId: "v",
		variantIds: ["base", "candidate"],
		scorerRefs: [{ scorerId: "s", version: "1" }],
	};
	expect(parseEvaluationExperimentCreateV1(base)).toEqual(base);
	expect(
		parseEvaluationExperimentCreateV1({
			...base,
			comparisonTargets: ["template", "model"],
		}),
	).toMatchObject({ comparisonTargets: ["model", "template"] });
	for (const comparisonTargets of [[], ["arbitrary"], ["model", "model"]])
		expect(() =>
			parseEvaluationExperimentCreateV1({ ...base, comparisonTargets }),
		).toThrow();
	expect(() =>
		parseEvaluationRequestedEvidenceV1({
			configurationRevision: 1,
			configurationDigest: "a".repeat(64),
			imageDigest: "sha256:" + "a".repeat(64),
			templateId: null,
			model: null,
			endpoint: "private",
		}),
	).toThrow();
});
