import { isDeepStrictEqual } from "node:util";
import { EvaluationDataErrorV1 } from "./evaluation-data.js";
import type {
	EvaluationExperimentV1,
	EvaluationSampleTaskV1,
} from "./evaluation-experiments.js";
import type { EvaluationModelFactsV1 } from "./evaluation-model-facts.js";
import type { EvaluationScoreIntentV1 } from "./evaluation-score-intents.js";
import {
	classifyExecutionFailureV1,
	type ExecutionFailureFactsV1,
	executionFailureMessageV1,
} from "./execution-failure.js";

export type EvaluationAnalysisCategoryV1 =
	| "scored"
	| "unscored"
	| "score_error"
	| "not_applicable"
	| "business_failed"
	| "missing";
export interface EvaluationAnalysisTaskV1 {
	task: EvaluationSampleTaskV1;
	status: string;
	actual: EvaluationModelFactsV1;
	taskDurationMs: number | null;
	failure?: {
		category: ReturnType<typeof classifyExecutionFailureV1>;
		message: string;
	} | null;
	scores: readonly EvaluationScoreIntentV1[];
}
export interface EvaluationAnalysisCountsV1 {
	fixedSamples: number;
	scored: number;
	passed: number;
	notPassed: number;
	unscored: number;
	scoreError: number;
	notApplicable: number;
	businessFailed: number;
	missing: number;
}
function empty(): EvaluationAnalysisCountsV1 {
	return {
		fixedSamples: 0,
		scored: 0,
		passed: 0,
		notPassed: 0,
		unscored: 0,
		scoreError: 0,
		notApplicable: 0,
		businessFailed: 0,
		missing: 0,
	};
}
function classify(
	task: EvaluationAnalysisTaskV1 | undefined,
	score: EvaluationScoreIntentV1 | undefined,
): EvaluationAnalysisCategoryV1 {
	if (!task) return "missing";
	if (["failed", "cancelled"].includes(task.status)) return "business_failed";
	if (!score) return "missing";
	if (score.status === "failed" || score.status === "unknown")
		return "score_error";
	if (score.status === "not_applicable") return "not_applicable";
	return score.status === "scored" ? "scored" : "unscored";
}
function add(
	counts: EvaluationAnalysisCountsV1,
	category: EvaluationAnalysisCategoryV1,
	score: EvaluationScoreIntentV1 | undefined,
) {
	counts.fixedSamples++;
	switch (category) {
		case "missing":
			counts.missing++;
			break;
		case "business_failed":
			counts.businessFailed++;
			break;
		case "score_error":
			counts.scoreError++;
			break;
		case "not_applicable":
			counts.notApplicable++;
			break;
		case "unscored":
			counts.unscored++;
			break;
		case "scored":
			if (
				score?.passed === null ||
				score?.passed === undefined ||
				score.value === null
			)
				throw new EvaluationDataErrorV1("unavailable");
			counts.scored++;
			if (score.passed) counts.passed++;
			else counts.notPassed++;
			break;
	}
}
/** Paired comparison may change its target model/config; missing facts or tool-environment drift are explicit. */
function comparability(
	a: EvaluationAnalysisTaskV1 | undefined,
	b: EvaluationAnalysisTaskV1 | undefined,
	targets: EvaluationExperimentV1["comparisonTargets"],
) {
	if (
		!a ||
		!b ||
		!a.actual.conditions.length ||
		!b.actual.conditions.length ||
		!a.task.preparedRuntime ||
		!b.task.preparedRuntime
	)
		return "missing_conditions" as const;
	if (a.task.binding.toolEnvironment !== b.task.binding.toolEnvironment)
		return "different_environment" as const;
	// Auxiliary/mixed actual conditions cannot be attributed to one requested comparison target.
	if (
		a.actual.conditionStatus === "mixed" ||
		b.actual.conditionStatus === "mixed"
	)
		return "mixed_conditions" as const;
	const ae = a.task.requestedEvidence;
	const be = b.task.requestedEvidence;
	if (!targets || !ae?.model || !be?.model) return "unknown_target" as const;
	for (const task of [a, b]) {
		const evidence = task.task.requestedEvidence;
		if (
			!evidence ||
			!isDeepStrictEqual(task.actual.conditions[0], evidence.model) ||
			task.task.preparedRuntime?.configurationRevision !==
				evidence.configurationRevision ||
			task.task.preparedRuntime.imageDigest !== evidence.imageDigest
		)
			return "actual_drift" as const;
	}
	if (
		(!targets.includes("template") &&
			(ae.imageDigest !== be.imageDigest || ae.templateId !== be.templateId)) ||
		(!targets.includes("configuration") &&
			(ae.configurationDigest !== be.configurationDigest ||
				a.task.preparedRuntime.resourceConfigurationHash !==
					b.task.preparedRuntime.resourceConfigurationHash)) ||
		(!targets.includes("model") &&
			!isDeepStrictEqual(
				[ae.model.modelId, ae.model.reasoningLevel],
				[be.model.modelId, be.model.reasoningLevel],
			))
	)
		return "non_target_drift" as const;
	return "comparable" as const;
}
export function summarizeEvaluationExperimentV1(input: {
	experiment: EvaluationExperimentV1;
	tasks: readonly EvaluationAnalysisTaskV1[];
	taskTypes: ReadonlyMap<string, string> | null;
}) {
	const { experiment } = input;
	if (
		!experiment.sampleIds.length ||
		!experiment.variantIds.length ||
		new Set(experiment.sampleIds).size !== experiment.sampleIds.length ||
		new Set(experiment.variantIds).size !== experiment.variantIds.length ||
		new Set(
			experiment.scorerRefs.map((ref) =>
				JSON.stringify([ref.scorerId, ref.version]),
			),
		).size !== experiment.scorerRefs.length
	)
		throw new EvaluationDataErrorV1("unavailable");
	const taskMap = new Map<string, EvaluationAnalysisTaskV1>();
	for (const task of input.tasks) {
		const key = JSON.stringify([task.task.sampleId, task.task.variantId]);
		if (
			taskMap.has(key) ||
			task.task.experimentId !== experiment.experimentId ||
			!experiment.sampleIds.includes(task.task.sampleId) ||
			!experiment.variantIds.includes(task.task.variantId)
		)
			throw new EvaluationDataErrorV1("unavailable");
		for (const score of task.scores)
			if (
				score.sampleTaskId !== task.task.sampleTaskId ||
				score.executionId !== task.task.executionId ||
				score.experimentId !== experiment.experimentId
			)
				throw new EvaluationDataErrorV1("unavailable");
		taskMap.set(key, task);
	}
	const groups = [];
	for (const variantId of experiment.variantIds)
		for (const ref of experiment.scorerRefs) {
			const counts = empty();
			const types = new Map<string | null, EvaluationAnalysisCountsV1>();
			for (const sampleId of experiment.sampleIds) {
				const task = taskMap.get(JSON.stringify([sampleId, variantId]));
				const scores =
					task?.scores.filter(
						(s) =>
							s.scorer.scorerId === ref.scorerId &&
							s.scorer.version === ref.version,
					) ?? [];
				if (scores.length > 1) throw new EvaluationDataErrorV1("unavailable");
				const score = scores[0];
				const category = classify(task, score);
				add(counts, category, score);
				const type = input.taskTypes?.get(sampleId) ?? null;
				const bucket = types.get(type) ?? empty();
				add(bucket, category, score);
				types.set(type, bucket);
			}
			groups.push({
				variantId,
				scorerId: ref.scorerId,
				scorerVersion: ref.version,
				counts,
				taskTypes: [...types].map(([taskType, counts]) => ({
					taskType,
					counts,
				})),
				passRate: counts.scored ? counts.passed / counts.scored : null,
			});
		}
	const pairs = [];
	const baselineId = experiment.variantIds[0];
	if (!baselineId) throw new EvaluationDataErrorV1("unavailable");
	for (const candidateId of experiment.variantIds.slice(1)) {
		const counts = {
			fixedSamples: experiment.sampleIds.length,
			comparable: 0,
			missingConditions: 0,
			differentEnvironment: 0,
			mixedConditions: 0,
			unknownTarget: 0,
			actualDrift: 0,
			nonTargetDrift: 0,
			conditionsChanged: 0,
		};
		const samples = experiment.sampleIds.map((sampleId) => {
			const baseline = taskMap.get(JSON.stringify([sampleId, baselineId]));
			const candidate = taskMap.get(JSON.stringify([sampleId, candidateId]));
			const status = comparability(
				baseline,
				candidate,
				experiment.comparisonTargets,
			);
			if (status === "comparable") counts.comparable++;
			else if (status === "missing_conditions") counts.missingConditions++;
			else if (status === "different_environment")
				counts.differentEnvironment++;
			else if (status === "mixed_conditions") counts.mixedConditions++;
			else if (status === "unknown_target") counts.unknownTarget++;
			else if (status === "actual_drift") counts.actualDrift++;
			else counts.nonTargetDrift++;
			const conditionsChanged = Boolean(
				baseline &&
					candidate &&
					(!isDeepStrictEqual(
						baseline.actual.conditions,
						candidate.actual.conditions,
					) ||
						!isDeepStrictEqual(
							baseline.task.preparedRuntime,
							candidate.task.preparedRuntime,
						)),
			);
			if (conditionsChanged) counts.conditionsChanged++;
			return {
				sampleId,
				taskType: input.taskTypes?.get(sampleId) ?? null,
				status,
				conditionsChanged,
				baseline: baseline?.task.sampleTaskId ?? null,
				candidate: candidate?.task.sampleTaskId ?? null,
			};
		});
		pairs.push({ baselineId, candidateId, counts, samples });
	}
	return {
		experimentId: experiment.experimentId,
		datasetId: experiment.datasetId,
		versionId: experiment.versionId,
		fixedSamples: experiment.sampleIds.length,
		groups,
		pairs,
		taskTypesAvailable: input.taskTypes !== null,
	};
}

export function projectEvaluationBusinessFailureV1(
	status: string,
	facts: ExecutionFailureFactsV1,
) {
	if (status !== "failed") return null;
	const category = classifyExecutionFailureV1(facts);
	return { category, message: executionFailureMessageV1(category) };
}
