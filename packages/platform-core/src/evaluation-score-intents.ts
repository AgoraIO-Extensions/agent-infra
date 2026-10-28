import { randomUUID } from "node:crypto";
import {
	EvaluationDataErrorV1,
	type EvaluationPrincipalV1,
	type EvaluationRequestV1,
} from "./evaluation-data.js";
import type {
	EvaluationExperimentV1,
	EvaluationSampleTaskV1,
} from "./evaluation-experiments.js";
import {
	type EvaluationScoreOutcomeV1,
	type EvaluationScorerV1,
	parseEvaluationScoreOutcomeV1,
	requireIndependentEvaluationReviewV1,
	scoreEvaluationRuleV1,
} from "./evaluation-scoring.js";
export interface EvaluationScoreIntentV1 {
	id: string;
	sampleTaskId: string;
	datasetId: string;
	versionId: string;
	experimentId: string;
	executionId: string;
	agentId: string;
	principal: EvaluationPrincipalV1;
	scorer: EvaluationScorerV1;
	policyId: string;
	policyRevision: number;
	resultVersion: string | null;
	status:
		| "waiting_output"
		| "pending"
		| "awaiting_human"
		| "scored"
		| "not_applicable"
		| "failed"
		| "unknown";
	revision: number;
	attempts: number;
	outputObjectId: string | null;
	reasonObjectId: string | null;
	value: number | null;
	passed: boolean | null;
	failureCode: string | null;
	keyBinding: {
		purpose: "agent-default";
		subjectId: string;
		keyId: string;
		keyVersion: number;
	} | null;
	createdAt: string;
	metadataExpiresAt: string;
	scoreActor: EvaluationPrincipalV1 | null;
}
export interface EvaluationScoringInputV1 {
	sample: string;
	context: string | null;
	expected: string | null;
	rubric: string;
	output: string;
}
export interface EvaluationScoreLeaseV1 {
	intentId: string;
	itemId: string;
	leaseOwner: string;
	deliveryFence: string;
}
export interface EvaluationScoreWorkPortV1 {
	prepare(
		lease: EvaluationScoreLeaseV1,
	): Promise<
		| { intent: EvaluationScoreIntentV1; input: EvaluationScoringInputV1 }
		| { waiting: true }
		| { terminal: true }
	>;
	model(
		lease: EvaluationScoreLeaseV1,
		intent: EvaluationScoreIntentV1,
		input: EvaluationScoringInputV1,
	): Promise<unknown>;
	commit(
		lease: EvaluationScoreLeaseV1,
		intent: EvaluationScoreIntentV1,
		result: EvaluationScoreOutcomeV1,
	): Promise<void>;
	failed(
		lease: EvaluationScoreLeaseV1,
		code: "SCORER_UNAVAILABLE" | "SCORER_RESULT_INVALID",
	): Promise<{ retry: boolean; delayMs: number }>;
}
/** Scorer retries call only this intent port; business Task admission is intentionally absent. */
export function createEvaluationScoreWorkV1(port: EvaluationScoreWorkPortV1) {
	return {
		async execute(
			lease: EvaluationScoreLeaseV1,
		): Promise<{
			outcome: "completed" | "waiting" | "retry";
			delayMs?: number;
		}> {
			let prepared: Awaited<ReturnType<EvaluationScoreWorkPortV1["prepare"]>>;
			prepared = await port.prepare(lease);
			if ("waiting" in prepared) return { outcome: "waiting" };
			if ("terminal" in prepared) return { outcome: "completed" };
			const { intent, input } = prepared;
			if (intent.scorer.implementation.kind === "human")
				return { outcome: "completed" };
			try {
				const result =
					intent.scorer.implementation.kind === "rule"
						? scoreEvaluationRuleV1({
								scorer: intent.scorer,
								output: input.output,
								expected: input.expected,
							})
						: parseEvaluationScoreOutcomeV1(
								await port.model(lease, intent, input),
								intent.scorer,
							);
				await port.commit(lease, intent, result);
				return { outcome: "completed" };
			} catch (error) {
				const decision = await port.failed(
					lease,
					error instanceof EvaluationDataErrorV1 && error.code === "invalid"
						? "SCORER_RESULT_INVALID"
						: "SCORER_UNAVAILABLE",
				);
				return decision.retry
					? { outcome: "retry", delayMs: decision.delayMs }
					: { outcome: "completed" };
			}
		},
	};
}
export interface EvaluationHumanScorePortV1 {
	load(
		request: EvaluationRequestV1,
		id: string,
		purpose: "score" | "review",
	): Promise<{ intent: EvaluationScoreIntentV1; actor: EvaluationPrincipalV1 }>;
	submit(
		request: EvaluationRequestV1,
		key: string,
		intent: EvaluationScoreIntentV1,
		result: EvaluationScoreOutcomeV1,
	): Promise<EvaluationScoreIntentV1>;
	review(
		request: EvaluationRequestV1,
		key: string,
		intent: EvaluationScoreIntentV1,
		actor: EvaluationPrincipalV1,
		result: EvaluationScoreOutcomeV1,
	): Promise<{
		reviewId: string;
		scoreId: string;
		scoreRevision: number;
		reviewer: EvaluationPrincipalV1;
	}>;
}
export function createEvaluationHumanScoringV1(
	port: EvaluationHumanScorePortV1,
) {
	return {
		async submit(
			request: EvaluationRequestV1,
			key: string,
			id: string,
			expectedRevision: number,
			value: unknown,
		) {
			const { intent } = await port.load(request, id, "score");
			if (
				intent.scorer.implementation.kind !== "human" ||
				intent.status !== "awaiting_human"
			)
				throw new EvaluationDataErrorV1("conflict");
			if (expectedRevision !== intent.revision)
				throw new EvaluationDataErrorV1("conflict");
			return port.submit(
				request,
				key,
				intent,
				parseEvaluationScoreOutcomeV1(value, intent.scorer),
			);
		},
		async review(
			request: EvaluationRequestV1,
			key: string,
			id: string,
			expectedRevision: number,
			value: unknown,
		) {
			const { intent, actor } = await port.load(request, id, "review");
			if (!["scored", "not_applicable"].includes(intent.status))
				throw new EvaluationDataErrorV1("conflict");
			requireIndependentEvaluationReviewV1({
				reviewer: actor,
				scorerActor:
					intent.scoreActor ??
					(() => {
						throw new EvaluationDataErrorV1("unavailable");
					})(),
				expectedRevision,
				actualRevision: intent.revision,
			});
			return port.review(
				request,
				key,
				intent,
				actor,
				parseEvaluationScoreOutcomeV1(value, intent.scorer),
			);
		},
	};
}

export function planEvaluationScoreIntentV1(
	task: EvaluationSampleTaskV1,
	experiment: EvaluationExperimentV1,
	scorer: EvaluationScorerV1,
): EvaluationScoreIntentV1 {
	return {
		id: randomUUID(),
		sampleTaskId: task.sampleTaskId,
		datasetId: experiment.datasetId,
		versionId: experiment.versionId,
		experimentId: experiment.experimentId,
		executionId: task.executionId,
		agentId: task.requested.agentId,
		principal: experiment.principal,
		scorer,
		policyId: experiment.policyId,
		policyRevision: experiment.policyRevision,
		resultVersion: null,
		status: "waiting_output",
		revision: 1,
		attempts: 0,
		outputObjectId: null,
		reasonObjectId: null,
		value: null,
		passed: null,
		failureCode: null,
		keyBinding: null,
		createdAt: experiment.createdAt,
		metadataExpiresAt: experiment.metadataExpiresAt,
		scoreActor: null,
	};
}
