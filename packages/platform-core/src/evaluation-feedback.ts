import { createHash } from "node:crypto";
import type { AgentManagementStateV1 } from "./agent-management.js";
import { snapshotAgentManagementDenseArray } from "./agent-management-input.js";
import { snapshotObject } from "./conversation-execution-values.js";
import {
	EvaluationDataErrorV1,
	type EvaluationPrincipalV1,
	type EvaluationRequestV1,
} from "./evaluation-data.js";
import {
	type EvaluationModelConditionV1,
	EvaluationQueryLimitErrorV1,
} from "./evaluation-model-facts.js";
import {
	type CurrentTaskApiUseGrantV1,
	type CurrentTaskApplicationV1,
	type CurrentTaskUserV1,
	capturePersonalApiTaskAuthorizationBoundaryV1,
	captureTaskApplicationAuthorizationBoundaryV1,
	captureTaskAuthorizationBoundaryV1,
	isTaskApiChannelV1,
	parseTaskPrincipalV1,
	type TaskApiChannelV1,
} from "./task-authorization.js";

export const taskFeedbackCategoriesV1 = [
	"correctness",
	"relevance",
	"instruction_following",
	"format",
	"tool_use",
	"incomplete",
	"performance",
	"other",
] as const;
export type TaskFeedbackCategoryV1 = (typeof taskFeedbackCategoriesV1)[number];
export interface EvaluationAnalysisPolicyV1 {
	schemaVersion: 1;
	policyId: string;
	revision: number;
	validUntil: string;
	maximumWindowMs: number;
	maximumTasks: number;
	maximumModelFacts: number;
	feedbackMetadataMs: number;
}
const invalid = (): never => {
	throw new EvaluationDataErrorV1("invalid");
};
function text(x: unknown): string {
	return typeof x === "string" &&
		x.length > 0 &&
		x.length <= 256 &&
		x.isWellFormed() &&
		[...x].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
		? x
		: invalid();
}
function count(x: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
	return typeof x === "number" &&
		Number.isSafeInteger(x) &&
		x >= 0 &&
		x <= maximum
		? x
		: invalid();
}
function instant(x: unknown): string {
	return typeof x === "string" &&
		Number.isFinite(Date.parse(x)) &&
		new Date(x).toISOString() === x
		? x
		: invalid();
}
export function parseEvaluationAnalysisPolicyV1(
	input: unknown,
): EvaluationAnalysisPolicyV1 {
	const x = snapshotObject(input, [
		"schemaVersion",
		"policyId",
		"revision",
		"validUntil",
		"maximumWindowMs",
		"maximumTasks",
		"maximumModelFacts",
		"feedbackMetadataMs",
	]);
	if (x.schemaVersion !== 1) return invalid();
	const result = {
		schemaVersion: 1 as const,
		policyId: text(x.policyId),
		revision: count(x.revision),
		validUntil: instant(x.validUntil),
		maximumWindowMs: count(x.maximumWindowMs, 366 * 86400000),
		maximumTasks: count(x.maximumTasks, 100000),
		maximumModelFacts: count(x.maximumModelFacts, 1000000),
		feedbackMetadataMs: count(x.feedbackMetadataMs),
	};
	if (
		[
			result.revision,
			result.maximumWindowMs,
			result.maximumTasks,
			result.maximumModelFacts,
			result.feedbackMetadataMs,
		].some((v) => v === 0)
	)
		return invalid();
	return result;
}
export interface TaskFeedbackTargetV1 {
	executionId: string;
	principal: EvaluationPrincipalV1;
	agentId: string;
	channelId: string;
	status: string;
	terminalObservedAt: string | null;
	conditions: readonly EvaluationModelConditionV1[];
}
export interface TaskFeedbackRecordV1 {
	executionId: string;
	principal: EvaluationPrincipalV1;
	agentId: string;
	revision: number;
	conditionDigest: string;
	useful: boolean;
	categories: readonly TaskFeedbackCategoryV1[];
	policyId: string;
	policyRevision: number;
	createdAt: string;
	updatedAt: string;
	metadataExpiresAt: string;
}
export function taskFeedbackConditionDigestV1(
	target: TaskFeedbackTargetV1,
): string {
	const conditions = [...target.conditions].sort((a, b) =>
		JSON.stringify(a).localeCompare(JSON.stringify(b)),
	);
	return createHash("sha256")
		.update(
			JSON.stringify([
				target.executionId,
				target.principal,
				target.agentId,
				target.channelId,
				target.status,
				target.terminalObservedAt,
				conditions,
			]),
		)
		.digest("hex");
}
export function taskFeedbackEligibilityV1(
	target: TaskFeedbackTargetV1,
): "eligible" | "not_terminal" | "offline_evaluation" {
	if (target.channelId === "eval") return "offline_evaluation";
	if (!["completed", "failed", "cancelled"].includes(target.status))
		return "not_terminal";
	return "eligible";
}
function categories(input: unknown): readonly TaskFeedbackCategoryV1[] {
	const result = snapshotAgentManagementDenseArray(
		input,
		taskFeedbackCategoriesV1.length,
	).map((value) => {
		if (
			typeof value !== "string" ||
			!taskFeedbackCategoriesV1.some((item) => item === value)
		)
			return invalid();
		return value as TaskFeedbackCategoryV1;
	});
	if (new Set(result).size !== result.length) return invalid();
	return result.sort();
}
export function parseTaskFeedbackRecordV1(
	input: unknown,
): TaskFeedbackRecordV1 {
	const x = snapshotObject(input, [
		"executionId",
		"principal",
		"agentId",
		"revision",
		"conditionDigest",
		"useful",
		"categories",
		"policyId",
		"policyRevision",
		"createdAt",
		"updatedAt",
		"metadataExpiresAt",
	]);
	if (
		typeof x.useful !== "boolean" ||
		typeof x.conditionDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(x.conditionDigest)
	)
		return invalid();
	const result = {
		executionId: text(x.executionId),
		principal: parseTaskPrincipalV1(x.principal),
		agentId: text(x.agentId),
		revision: count(x.revision),
		conditionDigest: x.conditionDigest,
		useful: x.useful,
		categories: categories(x.categories),
		policyId: text(x.policyId),
		policyRevision: count(x.policyRevision),
		createdAt: instant(x.createdAt),
		updatedAt: instant(x.updatedAt),
		metadataExpiresAt: instant(x.metadataExpiresAt),
	};
	if (
		!result.revision ||
		!result.policyRevision ||
		result.updatedAt < result.createdAt ||
		result.metadataExpiresAt <= result.createdAt
	)
		return invalid();
	return result;
}
export interface TaskFeedbackSubmitV1 {
	expectedRevision: number;
	expectedCondition: string;
	useful: boolean;
	categories: readonly TaskFeedbackCategoryV1[];
}
export function parseTaskFeedbackSubmitV1(
	input: unknown,
): TaskFeedbackSubmitV1 {
	const x = snapshotObject(input, [
		"expectedRevision",
		"expectedCondition",
		"useful",
		"categories",
	]);
	if (
		typeof x.useful !== "boolean" ||
		typeof x.expectedCondition !== "string" ||
		!/^[a-f0-9]{64}$/.test(x.expectedCondition)
	)
		return invalid();
	return {
		expectedRevision: count(x.expectedRevision),
		expectedCondition: x.expectedCondition,
		useful: x.useful,
		categories: categories(x.categories),
	};
}
export interface TaskFeedbackTransactionV1 {
	resultExpiresAt?: string;
	now: Date;
	principal: EvaluationPrincipalV1;
	target: TaskFeedbackTargetV1;
	policy: EvaluationAnalysisPolicyV1;
	current(): Promise<TaskFeedbackRecordV1 | null>;
	receipt(key: string): Promise<{
		digest: string;
		result: TaskFeedbackRecordV1;
		expiresAt: string;
	} | null>;
	save(value: TaskFeedbackRecordV1, key: string, digest: string): Promise<void>;
	audit(value: TaskFeedbackRecordV1): Promise<void>;
}
export interface TaskFeedbackPortV1 {
	transaction<T>(
		request: EvaluationRequestV1,
		executionId: string,
		operation: "read" | "write",
		work: (tx: TaskFeedbackTransactionV1) => Promise<T>,
	): Promise<T>;
}
function currentFeedback(
	value: TaskFeedbackRecordV1 | null,
	tx: Pick<TaskFeedbackTransactionV1, "now" | "policy">,
) {
	return value &&
		Math.min(
			Date.parse(value.metadataExpiresAt),
			Date.parse(value.createdAt) + tx.policy.feedbackMetadataMs,
		) > +tx.now
		? value
		: null;
}
function requireFeedbackActor(tx: TaskFeedbackTransactionV1) {
	if (
		tx.principal.kind !== tx.target.principal.kind ||
		tx.principal.id !== tx.target.principal.id ||
		Date.parse(tx.policy.validUntil) <= +tx.now
	)
		throw new EvaluationDataErrorV1("denied");
}
export function createTaskFeedbackV1(port: TaskFeedbackPortV1) {
	return {
		get(request: EvaluationRequestV1, executionId: string) {
			return port.transaction(
				request,
				text(executionId),
				"read",
				async (tx) => {
					requireFeedbackActor(tx);
					const feedback = currentFeedback(await tx.current(), tx);
					const conditionDigest = taskFeedbackConditionDigestV1(tx.target);
					return {
						executionId,
						eligibility: taskFeedbackEligibilityV1(tx.target),
						terminalObservedAt: tx.target.terminalObservedAt,
						conditions: tx.target.conditions,
						conditionDigest,
						revision: feedback?.revision ?? 0,
						feedback,
						feedbackCurrent:
							feedback !== null && feedback.conditionDigest === conditionDigest,
						categories: taskFeedbackCategoriesV1,
					};
				},
			);
		},
		submit(
			request: EvaluationRequestV1,
			executionId: string,
			key: string,
			input: unknown,
		) {
			const command = parseTaskFeedbackSubmitV1(input);
			if (!/^[A-Za-z0-9._~-]{1,128}$/.test(key)) return invalid();
			return port.transaction(
				request,
				text(executionId),
				"write",
				async (tx) => {
					requireFeedbackActor(tx);
					if (taskFeedbackEligibilityV1(tx.target) !== "eligible")
						throw new EvaluationDataErrorV1("denied");
					const conditionDigest = taskFeedbackConditionDigestV1(tx.target);
					if (conditionDigest !== command.expectedCondition)
						throw new EvaluationDataErrorV1("conflict");
					const digest = createHash("sha256")
						.update(JSON.stringify([executionId, command]))
						.digest("hex");
					const receipt = await tx.receipt(key);
					if (
						receipt &&
						Math.min(
							Date.parse(receipt.expiresAt),
							Date.parse(receipt.result.createdAt) +
								tx.policy.feedbackMetadataMs,
						) > +tx.now
					) {
						if (receipt.digest !== digest)
							throw new EvaluationDataErrorV1("conflict");
						tx.resultExpiresAt = new Date(
							Math.min(
								Date.parse(receipt.expiresAt),
								Date.parse(receipt.result.createdAt) +
									tx.policy.feedbackMetadataMs,
							),
						).toISOString();
						return parseTaskFeedbackRecordV1(receipt.result);
					}
					const previous = currentFeedback(await tx.current(), tx);
					if ((previous?.revision ?? 0) !== command.expectedRevision)
						throw new EvaluationDataErrorV1("conflict");
					const createdAt = previous?.createdAt ?? tx.now.toISOString();
					const record: TaskFeedbackRecordV1 = {
						executionId,
						principal: tx.principal,
						agentId: tx.target.agentId,
						revision: (previous?.revision ?? 0) + 1,
						conditionDigest,
						useful: command.useful,
						categories: command.categories,
						policyId: tx.policy.policyId,
						policyRevision: tx.policy.revision,
						createdAt,
						updatedAt: tx.now.toISOString(),
						metadataExpiresAt: new Date(
							Math.min(
								previous
									? Date.parse(previous.metadataExpiresAt)
									: Number.POSITIVE_INFINITY,
								Date.parse(createdAt) + tx.policy.feedbackMetadataMs,
							),
						).toISOString(),
					};
					tx.resultExpiresAt = record.metadataExpiresAt;
					await tx.save(record, key, digest);
					await tx.audit(record);
					return record;
				},
			);
		},
	};
}
export interface FeedbackSummaryQueryV1 {
	from: string;
	to: string;
	modelId?: string;
	configVersion?: string;
}
export function parseFeedbackSummaryQueryV1(
	input: unknown,
	policy: EvaluationAnalysisPolicyV1,
): FeedbackSummaryQueryV1 {
	const x = snapshotObject(input, ["from", "to"], ["modelId", "configVersion"]);
	const from = instant(x.from);
	const to = instant(x.to);
	if (from >= to) return invalid();
	if (Date.parse(to) - Date.parse(from) > policy.maximumWindowMs)
		throw new EvaluationQueryLimitErrorV1();
	return {
		from,
		to,
		...(x.modelId === undefined ? {} : { modelId: text(x.modelId) }),
		...(x.configVersion === undefined
			? {}
			: { configVersion: text(x.configVersion) }),
	};
}
export function summarizeTaskFeedbackV1(
	rows: readonly {
		target: TaskFeedbackTargetV1;
		feedback: TaskFeedbackRecordV1 | null;
	}[],
	query: FeedbackSummaryQueryV1,
	policy: EvaluationAnalysisPolicyV1,
	now: Date,
) {
	if (rows.length > policy.maximumTasks)
		throw new EvaluationQueryLimitErrorV1();
	const ids = new Set<string>();
	const classification = Object.fromEntries(
		taskFeedbackCategoriesV1.map((category) => [category, 0]),
	) as Record<TaskFeedbackCategoryV1, number>;
	let eligibleTasks = 0;
	let feedbackTasks = 0;
	let usefulTasks = 0;
	let conditionChangedTasks = 0;
	let missingActualTasks = 0;
	let terminalTimeMissingTasks = 0;
	const distributions = new Map<
		string,
		{
			conditions: readonly EvaluationModelConditionV1[];
			tasks: number;
			feedbackTasks: number;
		}
	>();
	for (const { target, feedback: stored } of rows) {
		if (ids.has(target.executionId))
			throw new EvaluationDataErrorV1("unavailable");
		ids.add(target.executionId);
		const eligibility = taskFeedbackEligibilityV1(target);
		const matches =
			(!query.modelId && !query.configVersion) ||
			target.conditions.some(
				(c) =>
					(!query.modelId || c.modelId === query.modelId) &&
					(!query.configVersion || c.configVersion === query.configVersion),
			);
		if (!matches) continue;
		if (eligibility === "eligible" && target.terminalObservedAt === null) {
			terminalTimeMissingTasks++;
			continue;
		}
		if (
			eligibility !== "eligible" ||
			!target.terminalObservedAt ||
			target.terminalObservedAt < query.from ||
			target.terminalObservedAt >= query.to
		)
			continue;
		eligibleTasks++;
		if (!target.conditions.length) missingActualTasks++;
		const key = JSON.stringify(target.conditions);
		const group = distributions.get(key) ?? {
			conditions: target.conditions,
			tasks: 0,
			feedbackTasks: 0,
		};
		group.tasks++;
		distributions.set(key, group);
		const feedback = currentFeedback(stored, { now, policy });
		if (!feedback) continue;
		if (feedback.conditionDigest !== taskFeedbackConditionDigestV1(target)) {
			conditionChangedTasks++;
			continue;
		}
		feedbackTasks++;
		group.feedbackTasks++;
		if (feedback.useful) usefulTasks++;
		for (const category of feedback.categories) classification[category]++;
	}
	return {
		query,
		eligibleTasks,
		feedbackTasks,
		unfeedbackTasks: eligibleTasks - feedbackTasks,
		usefulTasks,
		notUsefulTasks: feedbackTasks - usefulTasks,
		conditionChangedTasks,
		missingActualTasks,
		terminalTimeMissingTasks,
		feedbackRate: eligibleTasks ? feedbackTasks / eligibleTasks : null,
		classification,
		conditions: [...distributions.values()],
	};
}

/** Feedback reads historical metadata under current use; it does not renew execution authority. */
export function isCurrentTaskFeedbackUseV1(input: {
	principal: EvaluationPrincipalV1;
	channelId: string;
	agent: AgentManagementStateV1;
	agentAuthorizationRevision: string;
	user: CurrentTaskUserV1 | null;
	application: CurrentTaskApplicationV1 | null;
	useGrant: CurrentTaskApiUseGrantV1 | null;
}) {
	if (input.channelId === "eval") return false;
	if (input.principal.kind === "application")
		return (
			input.application !== null &&
			captureTaskApplicationAuthorizationBoundaryV1({
				principal: input.principal,
				application: input.application,
				agent: input.agent,
				channelId: input.channelId as TaskApiChannelV1,
				agentAuthorizationRevision: input.agentAuthorizationRevision,
			}) !== null
		);
	if (!input.user) return false;
	return isTaskApiChannelV1(input.channelId, input.principal)
		? capturePersonalApiTaskAuthorizationBoundaryV1({
				user: input.user,
				useGrant: input.useGrant,
				agent: input.agent,
				channelId: input.channelId as TaskApiChannelV1,
				agentAuthorizationRevision: input.agentAuthorizationRevision,
			}) !== null
		: captureTaskAuthorizationBoundaryV1({
				principal: input.principal,
				user: input.user,
				agent: input.agent,
				channelId: input.channelId as TaskApiChannelV1,
				agentAuthorizationRevision: input.agentAuthorizationRevision,
			}) !== null;
}
