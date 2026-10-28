import { randomUUID } from "node:crypto";
import {
	EvaluationAnalysisSummaryV1Schema,
	EvaluationExperimentV1Schema,
	TaskFeedbackContextV1Schema,
	TaskFeedbackSummaryV1Schema,
} from "@agent-infra/contracts/pilot";
import { expect, it } from "vitest";
import { startEvaluationWorkflowBrowserFixture } from "./evaluation-workflow.browser-test-support.js";

it("drives production Task/scoring and self feedback through isolated HTTP assembly", async () => {
	const fixture = await startEvaluationWorkflowBrowserFixture();
	try {
		const request = (
			path: string,
			role: keyof typeof fixture.roles,
			body?: unknown,
			method = body === undefined ? "GET" : "POST",
		) =>
			fetch(fixture.origin + path, {
				method,
				headers: {
					Cookie: `session=${fixture.roles[role]}`,
					"Content-Type": "application/json",
					"Idempotency-Key": randomUUID(),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		const directory = await request(
			"/api/v2/directory/search?kind=user&q=eval-runner",
			"manager",
		);
		expect(directory.status).toBe(200);
		expect(await directory.json()).toMatchObject({
			items: [{ canonicalId: fixture.roles.runner }],
		});
		const created = await request("/api/v2/evaluation/experiments", "runner", {
			datasetId: fixture.datasetId,
			versionId: fixture.versionId,
			variantIds: ["baseline", "candidate"],
			scorerRefs: ["rule", "human", "model"].map((scorerId) => ({
				scorerId,
				version: "1",
			})),
			comparisonTargets: ["model"],
		});
		expect(created.status).toBe(201);
		const experiment = EvaluationExperimentV1Schema.parse(await created.json());
		await fixture.tick();
		const path = `/api/v2/evaluation/analysis/${experiment.experimentId}`;
		const analysis = await request(path, "analyst");
		expect(analysis.status).toBe(200);
		const report = EvaluationAnalysisSummaryV1Schema.parse(
			await analysis.json(),
		);
		expect(report.items).toHaveLength(2);
		expect(report.items.every((item) => item.status === "completed")).toBe(
			true,
		);
		expect(fixture.modelCalls()).toBe(2);
		expect(fixture.runtimeCalls()).toBe(2);
		expect((await request(path, "reviewer")).status).toBe(404);

		const first = await fixture.createOnlineTask();
		await fixture.createOnlineTask();
		const feedbackPath = `/api/v2/task-feedback/${first.executionId}`;
		const feedback = await request(feedbackPath, "runner");
		expect(feedback.status).toBe(200);
		const context = TaskFeedbackContextV1Schema.parse(await feedback.json());
		expect(context.eligibility).toBe("eligible");
		expect((await request(feedbackPath, "outsider")).status).toBe(404);
		const submitted = await request(
			feedbackPath,
			"runner",
			{
				expectedRevision: context.revision,
				expectedCondition: context.conditionDigest,
				useful: true,
				categories: [],
			},
			"PUT",
		);
		expect(submitted.status).toBe(200);
		const query = new URLSearchParams({
			view: "owner",
			from: new Date(Date.now() - 60000).toISOString(),
			to: new Date(Date.now() + 60000).toISOString(),
		});
		const summary = await request(
			`/api/v2/agents/${fixture.agentId}/feedback-summary?${query}`,
			"owner",
		);
		expect(summary.status).toBe(200);
		const aggregate = TaskFeedbackSummaryV1Schema.parse(await summary.json());
		expect(aggregate).toMatchObject({
			view: "owner",
			eligibleTasks: 2,
			feedbackTasks: 1,
			unfeedbackTasks: 1,
			feedbackRate: 0.5,
		});
		expect(JSON.stringify(aggregate)).not.toContain(first.executionId);
		expect(JSON.stringify(aggregate)).not.toContain("Synthetic feedback task");
	} finally {
		await fixture.close();
	}
}, 120000);
