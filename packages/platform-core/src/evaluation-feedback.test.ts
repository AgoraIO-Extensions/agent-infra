import { expect, it } from "vitest";
import {
	parseEvaluationAnalysisPolicyV1,
	parseFeedbackSummaryQueryV1,
	parseTaskFeedbackSubmitV1,
	summarizeTaskFeedbackV1,
	type TaskFeedbackRecordV1,
	type TaskFeedbackTargetV1,
	taskFeedbackConditionDigestV1,
	taskFeedbackEligibilityV1,
} from "./evaluation-feedback.js";

const policy = parseEvaluationAnalysisPolicyV1({
	schemaVersion: 1,
	policyId: "approved",
	revision: 1,
	validUntil: "2027-01-01T00:00:00.000Z",
	maximumWindowMs: 86400000,
	maximumTasks: 20,
	maximumModelFacts: 100,
	feedbackMetadataMs: 86400000,
});
const now = new Date("2026-10-29T12:00:00.000Z");
const query = {
	from: "2026-10-29T00:00:00.000Z",
	to: "2026-10-30T00:00:00.000Z",
};
function target(
	id: string,
	change: Partial<TaskFeedbackTargetV1> = {},
): TaskFeedbackTargetV1 {
	return {
		executionId: id,
		agentId: "agent",
		principal: { kind: "user", id: "self" },
		channelId: "web",
		status: "completed",
		terminalObservedAt: "2026-10-29T01:00:00.000Z",
		conditions: [
			{
				modelId: "actual",
				configVersion: "7",
				modelOptionId: "option",
				reasoningLevel: null,
			},
		],
		...change,
	};
}
function feedback(t: TaskFeedbackTargetV1): TaskFeedbackRecordV1 {
	return {
		executionId: t.executionId,
		agentId: t.agentId,
		principal: t.principal,
		revision: 2,
		conditionDigest: taskFeedbackConditionDigestV1(t),
		useful: false,
		categories: ["correctness", "tool_use"],
		policyId: "approved",
		policyRevision: 1,
		createdAt: "2026-10-29T02:00:00.000Z",
		updatedAt: "2026-10-29T05:00:00.000Z",
		metadataExpiresAt: "2026-10-30T02:00:00.000Z",
	};
}
it("counts fixed eligible Tasks including no feedback, not feedback rows or model attempts", () => {
	const a = target("a");
	const b = target("b", { conditions: [] });
	const c = target("c", {
		status: "failed",
		conditions: [...a.conditions, { ...a.conditions[0]!, modelId: "other" }],
	});
	const result = summarizeTaskFeedbackV1(
		[
			{ target: a, feedback: feedback(a) },
			{ target: b, feedback: null },
			{ target: c, feedback: null },
		],
		query,
		policy,
		now,
	);
	expect(result).toMatchObject({
		eligibleTasks: 3,
		feedbackTasks: 1,
		unfeedbackTasks: 2,
		notUsefulTasks: 1,
		missingActualTasks: 1,
		feedbackRate: 1 / 3,
		classification: { correctness: 1, tool_use: 1 },
	});
	expect(result.conditions.reduce((n, c) => n + c.tasks, 0)).toBe(3);
	expect(JSON.stringify(result)).not.toMatch(
		/executionId|principal|conversationId/,
	);
});
it("uses terminal half-open windows and marks missing terminal evidence independently", () => {
	const values = [
		target("start", { terminalObservedAt: query.from }),
		target("end", { terminalObservedAt: query.to }),
		target("legacy", { terminalObservedAt: null }),
		target("unknown", { status: "unknown" }),
		target("eval", { channelId: "eval" }),
	];
	const result = summarizeTaskFeedbackV1(
		values.map((t) => ({ target: t, feedback: null })),
		query,
		policy,
		now,
	);
	expect(result).toMatchObject({
		eligibleTasks: 1,
		feedbackTasks: 0,
		terminalTimeMissingTasks: 1,
	});
	expect(taskFeedbackEligibilityV1(values[3]!)).toBe("not_terminal");
	expect(taskFeedbackEligibilityV1(values[4]!)).toBe("offline_evaluation");
});
it("keeps feedback independent of update/usage timestamps but excludes changed actual conditions", () => {
	const a = target("a");
	const stored = feedback(a);
	const changed = {
		...a,
		conditions: [{ ...a.conditions[0]!, modelId: "changed" }],
	};
	expect(
		summarizeTaskFeedbackV1(
			[{ target: a, feedback: stored }],
			query,
			policy,
			now,
		).feedbackTasks,
	).toBe(1);
	expect(
		summarizeTaskFeedbackV1(
			[{ target: changed, feedback: stored }],
			query,
			policy,
			now,
		),
	).toMatchObject({
		eligibleTasks: 1,
		feedbackTasks: 0,
		conditionChangedTasks: 1,
	});
	const sameIdApplication = {
		...a,
		principal: { kind: "application" as const, id: "self" },
	};
	expect(taskFeedbackConditionDigestV1(sameIdApplication)).not.toBe(
		taskFeedbackConditionDigestV1(a),
	);
});
it("requires model/config to match one actual condition, rejects truncation and free-form feedback", () => {
	const a = target("a", {
		conditions: [
			{
				modelId: "a",
				configVersion: "1",
				modelOptionId: "x",
				reasoningLevel: null,
			},
			{
				modelId: "b",
				configVersion: "2",
				modelOptionId: "y",
				reasoningLevel: null,
			},
		],
	});
	expect(
		summarizeTaskFeedbackV1(
			[{ target: a, feedback: null }],
			{ ...query, modelId: "a", configVersion: "2" },
			policy,
			now,
		).eligibleTasks,
	).toBe(0);
	expect(() =>
		summarizeTaskFeedbackV1(
			[
				{ target: a, feedback: null },
				{ target: a, feedback: null },
			],
			query,
			policy,
			now,
		),
	).toThrow();
	expect(() =>
		summarizeTaskFeedbackV1(
			[{ target: a, feedback: null }],
			query,
			{ ...policy, maximumTasks: 0 },
			now,
		),
	).toThrow();
	expect(() =>
		parseFeedbackSummaryQueryV1(
			{ ...query, to: "2026-11-01T00:00:00.000Z" },
			policy,
		),
	).toThrow();
	expect(() =>
		parseTaskFeedbackSubmitV1({
			expectedRevision: 0,
			expectedCondition: "a".repeat(64),
			useful: false,
			categories: ["private text"],
		}),
	).toThrow();
	expect(() =>
		parseTaskFeedbackSubmitV1({
			expectedRevision: 0,
			expectedCondition: "a".repeat(64),
			useful: false,
			categories: [],
			actorId: "other",
		}),
	).toThrow();
});
