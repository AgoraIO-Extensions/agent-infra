import { randomUUID } from "node:crypto";
import { snapshotObject } from "./conversation-execution-values.js";
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
	parseEvaluationScorerV1,
	requireIndependentEvaluationReviewV1,
	scoreEvaluationRuleV1,
} from "./evaluation-scoring.js";
import { parseTaskPrincipalV1 } from "./task-authorization.js";
/** Trusted model adapter evidence that no request reached the transport. */
export class EvaluationModelNotSentErrorV1 extends Error {
	constructor() {
		super("EVALUATION_MODEL_NOT_SENT");
	}
}
/** Trusted adapter observed a direct authentication/authorization refusal. */
export class EvaluationModelAuthorizationDeniedErrorV1 extends Error {
	constructor() {
		super("EVALUATION_MODEL_AUTHORIZATION_DENIED");
	}
}
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
		| "result_ready"
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
		| { waiting: true; delayMs: number }
		| { terminal: true }
		| { intent: EvaluationScoreIntentV1; recovered: EvaluationScoreOutcomeV1 }
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
		preparationFailure?: boolean,
	): Promise<{ retry: boolean; delayMs: number }>;
}
/** Scorer retries call only this intent port; business Task admission is intentionally absent. */
export function createEvaluationScoreWorkV1(port: EvaluationScoreWorkPortV1) {
	return {
		async execute(lease: EvaluationScoreLeaseV1): Promise<{
			outcome: "completed" | "waiting" | "retry";
			delayMs?: number;
		}> {
			let prepared: Awaited<ReturnType<EvaluationScoreWorkPortV1["prepare"]>>;
			try {
				prepared = await port.prepare(lease);
			} catch {
				const failure = await port.failed(lease, "SCORER_UNAVAILABLE", true);
				return failure.retry
					? { outcome: "retry", delayMs: failure.delayMs }
					: { outcome: "completed" };
			}
			if ("waiting" in prepared)
				return { outcome: "waiting", delayMs: prepared.delayMs };
			if ("terminal" in prepared) return { outcome: "completed" };
			if ("recovered" in prepared) {
				try {
					await port.commit(lease, prepared.intent, prepared.recovered);
					return { outcome: "completed" };
				} catch {
					const failure = await port.failed(lease, "SCORER_UNAVAILABLE");
					return failure.retry
						? { outcome: "retry", delayMs: failure.delayMs }
						: { outcome: "completed" };
				}
			}
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
				!["awaiting_human", "scored", "not_applicable"].includes(intent.status)
			)
				throw new EvaluationDataErrorV1("conflict");
			if (
				intent.status === "awaiting_human" &&
				expectedRevision !== intent.revision
			)
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

export function parseEvaluationScoreIntentV1(
	input: unknown,
): EvaluationScoreIntentV1 {
	const v = snapshotObject(input, [
		"id",
		"sampleTaskId",
		"datasetId",
		"versionId",
		"experimentId",
		"executionId",
		"agentId",
		"principal",
		"scorer",
		"policyId",
		"policyRevision",
		"resultVersion",
		"status",
		"revision",
		"attempts",
		"outputObjectId",
		"reasonObjectId",
		"value",
		"passed",
		"failureCode",
		"keyBinding",
		"createdAt",
		"metadataExpiresAt",
		"scoreActor",
	]);
	const text = (value: unknown) => {
		if (
			typeof value !== "string" ||
			!value ||
			value.length > 256 ||
			!value.isWellFormed()
		)
			throw new EvaluationDataErrorV1("unavailable");
		return value;
	};
	for (const key of [
		"id",
		"sampleTaskId",
		"datasetId",
		"versionId",
		"experimentId",
		"executionId",
		"agentId",
		"policyId",
	])
		text(v[key]);
	for (const key of ["policyRevision", "revision", "attempts"]) {
		const count = v[key];
		if (
			typeof count !== "number" ||
			!Number.isSafeInteger(count) ||
			count < (key === "attempts" ? 0 : 1)
		)
			throw new EvaluationDataErrorV1("unavailable");
	}
	const principal = parseTaskPrincipalV1(v.principal);
	const scorer = parseEvaluationScorerV1(v.scorer);
	if (
		![
			"waiting_output",
			"pending",
			"result_ready",
			"awaiting_human",
			"scored",
			"not_applicable",
			"failed",
			"unknown",
		].includes(text(v.status))
	)
		throw new EvaluationDataErrorV1("unavailable");
	for (const key of [
		"resultVersion",
		"outputObjectId",
		"reasonObjectId",
		"failureCode",
	])
		if (v[key] !== null) text(v[key]);
	for (const key of ["createdAt", "metadataExpiresAt"])
		if (
			!Number.isFinite(Date.parse(text(v[key]))) ||
			new Date(text(v[key])).toISOString() !== v[key]
		)
			throw new EvaluationDataErrorV1("unavailable");
	if (v.scoreActor !== null) parseTaskPrincipalV1(v.scoreActor);
	if (
		v.value !== null &&
		(typeof v.value !== "number" ||
			!Number.isFinite(v.value) ||
			v.value < scorer.minimum ||
			v.value > scorer.maximum)
	)
		throw new EvaluationDataErrorV1("unavailable");
	if (v.passed !== null && typeof v.passed !== "boolean")
		throw new EvaluationDataErrorV1("unavailable");
	if (
		v.status === "scored" &&
		(v.value === null ||
			v.passed === null ||
			v.scoreActor === null ||
			v.reasonObjectId === null)
	)
		throw new EvaluationDataErrorV1("unavailable");
	if (v.keyBinding !== null) {
		const key = snapshotObject(v.keyBinding, [
			"purpose",
			"subjectId",
			"keyId",
			"keyVersion",
		]);
		if (
			key.purpose !== "agent-default" ||
			key.subjectId !== v.agentId ||
			typeof key.keyVersion !== "number" ||
			!Number.isSafeInteger(key.keyVersion) ||
			key.keyVersion < 1
		)
			throw new EvaluationDataErrorV1("unavailable");
		text(key.keyId);
	}
	return { ...v, principal, scorer } as unknown as EvaluationScoreIntentV1;
}

/** Stored independent review binding; content remains in its purpose-bound object. */
export function parseEvaluationReviewRecordV1(input: unknown) {
	const value = snapshotObject(input, [
		"reviewId",
		"scoreId",
		"scoreRevision",
		"reviewer",
		"objectId",
		"metadataExpiresAt",
	]);
	for (const key of ["reviewId", "scoreId", "objectId"])
		if (
			typeof value[key] !== "string" ||
			!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
				value[key],
			)
		)
			throw new EvaluationDataErrorV1("unavailable");
	if (
		typeof value.scoreRevision !== "number" ||
		!Number.isSafeInteger(value.scoreRevision) ||
		value.scoreRevision < 1 ||
		typeof value.metadataExpiresAt !== "string" ||
		!Number.isFinite(Date.parse(value.metadataExpiresAt)) ||
		new Date(value.metadataExpiresAt).toISOString() !== value.metadataExpiresAt
	)
		throw new EvaluationDataErrorV1("unavailable");
	return {
		reviewId: value.reviewId as string,
		scoreId: value.scoreId as string,
		scoreRevision: value.scoreRevision,
		reviewer: parseTaskPrincipalV1(value.reviewer),
		objectId: value.objectId as string,
		metadataExpiresAt: value.metadataExpiresAt,
	};
}

export function projectEvaluationScoringContextV1(input: {
	intent: EvaluationScoreIntentV1;
	sampleId: string;
	source: import("./evaluation-experiments.js").EvaluationRunSourceV1["content"];
	output: unknown;
	score: unknown;
}) {
	const { intent } = input;
	const sample = input.source.samples.find(
		(value) => value.id === input.sampleId,
	);
	const rubric = input.source.rubric.find(
		(value) => value.id === intent.scorer.rubricId,
	);
	if (!sample || !rubric) throw new EvaluationDataErrorV1("denied");
	let output: {
		text: string;
		executionId: string;
		resultVersion: string;
	} | null = null;
	if (input.output !== null) {
		const value = snapshotObject(input.output, [
			"text",
			"executionId",
			"resultVersion",
		]);
		if (
			typeof value.text !== "string" ||
			!value.text.isWellFormed() ||
			Buffer.byteLength(value.text) > intent.scorer.maxInputBytes ||
			value.executionId !== intent.executionId ||
			value.resultVersion !== intent.resultVersion
		)
			throw new EvaluationDataErrorV1("unavailable");
		output = {
			text: value.text,
			executionId: intent.executionId,
			resultVersion: value.resultVersion as string,
		};
	}
	const result =
		input.score === null
			? null
			: parseEvaluationScoreOutcomeV1(input.score, intent.scorer);
	return {
		scoreId: intent.id,
		revision: intent.revision,
		sampleTaskId: intent.sampleTaskId,
		experimentId: intent.experimentId,
		executionId: intent.executionId,
		status: intent.status,
		resultVersion: intent.resultVersion,
		sample,
		rubric,
		scorer: {
			scorerId: intent.scorer.scorerId,
			version: intent.scorer.version,
			minimum: intent.scorer.minimum,
			maximum: intent.scorer.maximum,
			passThreshold: intent.scorer.passThreshold,
		},
		output,
		score: result
			? { status: result.status, value: result.value, reason: result.reason }
			: null,
	};
}

export function planEvaluationScoreFailureV1(
	intent: Pick<
		EvaluationScoreIntentV1,
		"status" | "attempts" | "revision" | "failureCode"
	> & { scorer: Pick<EvaluationScorerV1, "maxAttempts" | "retryDelayMs"> },
	code:
		| "SCORER_UNAVAILABLE"
		| "SCORER_RESULT_INVALID"
		| "SCORER_AUTHORIZATION_DENIED",
	preparationFailure = false,
): {
	state: Pick<
		EvaluationScoreIntentV1,
		"status" | "attempts" | "revision" | "failureCode"
	> | null;
	retry: boolean;
	delayMs: number;
} {
	const delayMs = intent.scorer.retryDelayMs;
	if (["scored", "not_applicable", "failed"].includes(intent.status))
		return { state: null, retry: false, delayMs };
	if (code === "SCORER_AUTHORIZATION_DENIED")
		return {
			state: {
				status: "failed",
				attempts: intent.attempts,
				revision: intent.revision + 1,
				failureCode: code,
			},
			retry: false,
			delayMs,
		};
	if (intent.status === "result_ready") {
		const retry = intent.attempts < intent.scorer.maxAttempts;
		return {
			state: {
				status: retry ? "result_ready" : "failed",
				attempts: Math.min(intent.scorer.maxAttempts, intent.attempts + 1),
				revision: intent.revision + 1,
				failureCode: code,
			},
			retry,
			delayMs,
		};
	}
	const attempts = Math.min(
		intent.scorer.maxAttempts,
		intent.attempts + (preparationFailure ? 1 : 0),
	);
	// Unknown may reconcile its original result once; it must never resend a model call.
	const retry =
		intent.status === "unknown"
			? !preparationFailure || attempts < intent.scorer.maxAttempts
			: attempts < intent.scorer.maxAttempts;
	return {
		state: {
			status:
				intent.status === "unknown" ? "unknown" : retry ? "pending" : "failed",
			attempts,
			revision: intent.revision + 1,
			failureCode: code,
		},
		retry,
		delayMs,
	};
}

/** Cancellation is metadata control, never new permission to read inputs or send a score. */
export function planEvaluationCancelledScoreV1(
	intent: Pick<EvaluationScoreIntentV1, "status" | "revision" | "scorer">,
	experimentStatus: "active" | "cancelled",
	taskStatus: string,
):
	| { outcome: "proceed" | "terminal" }
	| { outcome: "waiting"; delayMs: number }
	| {
			outcome: "settle";
			status: "not_applicable";
			revision: number;
			failureCode: "TASK_NOT_COMPLETED" | "EXPERIMENT_CANCELLED";
	  } {
	if (experimentStatus !== "cancelled") return { outcome: "proceed" };
	if (
		["scored", "not_applicable", "failed", "unknown", "result_ready"].includes(
			intent.status,
		)
	)
		return { outcome: "terminal" };
	if (["submitted", "waiting", "processing", "unknown"].includes(taskStatus))
		return { outcome: "waiting", delayMs: intent.scorer.retryDelayMs };
	if (!["completed", "cancelled", "failed"].includes(taskStatus))
		throw new EvaluationDataErrorV1("unavailable");
	return {
		outcome: "settle",
		status: "not_applicable",
		revision: intent.revision + 1,
		failureCode:
			taskStatus === "completed"
				? "EXPERIMENT_CANCELLED"
				: "TASK_NOT_COMPLETED",
	};
}
