import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { client } from "../../pilot/generated-v2/client.gen.js";
import { ActualFacts, EvaluationAnalysis } from "./evaluation-analysis.js";

beforeEach(() =>
	client.setConfig({
		baseUrl: "https://platform.test",
		fetch: (input, init) => globalThis.fetch(input, init),
	}),
);
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
it.each([
	[400, "EVALUATION_QUERY_TOO_LARGE", "查询范围过大"],
	[400, "INVALID_REQUEST", "请求未被接受"],
	[404, "RESOURCE_UNAVAILABLE", "当前权限不足"],
	[503, "UNAVAILABLE", "服务未配置"],
])(
	"keeps HTTP %s %s failures distinct from empty history",
	async (status, code, label) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ code }, { status: Number(status) })),
		);
		render(
			<EvaluationAnalysis
				selected={null}
				onSelect={() => {}}
				onNewVersion={() => {}}
			/>,
		);
		expect((await screen.findByRole("alert")).textContent).toContain(label);
		expect(screen.queryByText("当前没有获准查看的实验历史。")).toBeNull();
	},
);
it("shows missing observations separately from zero and cumulative duration", () => {
	render(
		<ActualFacts
			facts={{
				attempts: [],
				observedAttempts: 1,
				conditions: [],
				conditionStatus: "missing",
				inputTokens: { value: null, observed: 0, total: 2 },
				outputTokens: { value: 0, observed: 1, total: 2 },
				cachedInputTokens: { value: null, observed: 0, total: 2 },
				modelDurationMs: { value: 30, observed: 2, total: 2 },
			}}
		/>,
	);
	expect(screen.getByText(/^输入 Token：缺失/).textContent).toContain("0/2");
	expect(screen.getByText(/输出 Token：0/).textContent).toContain("1/2");
	expect(screen.getByText(/模型累计耗时（可能并行）：30 ms/)).toBeTruthy();
});

const eid = "10000000-0000-4000-8000-000000000001";
const tid = "10000000-0000-4000-8000-000000000002";
const sid = "10000000-0000-4000-8000-000000000003";
const cursor = "10000000-0000-4000-8000-000000000004";
const metric = { value: null, observed: 0, total: 0 };
const score = {
	scoreId: sid,
	scorerId: "human",
	scorerVersion: "1",
	source: "human",
	scoringModel: null,
	status: "scored",
	value: 1,
	passed: true,
};
const summary = {
	experimentId: eid,
	datasetId: eid,
	versionId: eid,
	fixedSamples: 1,
	observedAt: "2026-10-01T00:00:00Z",
	contentAvailable: true,
	taskTypesAvailable: true,
	groups: [],
	pairs: [],
	items: [
		{
			sampleTaskId: tid,
			sampleId: "sample",
			variantId: "base",
			executionId: "exec",
			status: "completed",
			failure: null,
			requested: {
				variantId: "base",
				agentId: "agent",
				configurationRevision: 1,
				modelOptionId: null,
				reasoningLevel: null,
				toolEnvironment: "test",
			},
			requestedEvidence: null,
			preparedRuntime: null,
			actual: {
				attempts: [],
				observedAttempts: 0,
				conditions: [],
				conditionStatus: "missing",
				inputTokens: metric,
				outputTokens: metric,
				cachedInputTokens: metric,
				modelDurationMs: metric,
			},
			taskElapsedMs: null,
			scores: [{ ...score, failureCode: null }],
		},
	],
};
it("uses independent score and per-score review cursors, and clears detail on authorization refresh", async () => {
	const urls: URL[] = [];
	let denied = false;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const req = input instanceof Request ? input : new Request(input);
			const url = new URL(req.url);
			urls.push(url);
			if (url.pathname.endsWith("/history"))
				return Response.json({ items: [], nextCursor: null });
			if (denied)
				return Response.json({ code: "RESOURCE_UNAVAILABLE" }, { status: 404 });
			if (!url.pathname.includes("/samples/")) return Response.json(summary);
			const reviewPage = url.searchParams.has("reviewCursor");
			return Response.json({
				experimentId: eid,
				sampleTaskId: tid,
				failure: null,
				sample: {
					id: "sample",
					input: "Sensitive sample",
					context: null,
					taskType: "answer",
					expectedResult: null,
				},
				nextCursor: reviewPage ? null : cursor,
				scores: [
					{
						...score,
						output: { contentStatus: "expired", value: null },
						reason: {
							contentStatus: "available",
							value: { status: "scored", value: 1, reason: "Original reason" },
						},
						reviews: reviewPage
							? [
									{
										reviewId: cursor,
										scoreId: sid,
										scoreRevision: 1,
										reviewer: { kind: "user", id: "reviewer" },
										result: { contentStatus: "deleted", value: null },
									},
								]
							: [],
						nextReviewCursor: reviewPage ? null : cursor,
					},
				],
			});
		}),
	);
	render(
		<EvaluationAnalysis
			selected={eid}
			onSelect={() => {}}
			onNewVersion={() => {}}
		/>,
	);
	fireEvent.click(
		await screen.findByRole("button", { name: "查看样本 sample base" }),
	);
	await screen.findByText("Sensitive sample");
	fireEvent.click(screen.getByRole("button", { name: "下一批评分依据" }));
	await screen.findByText("Sensitive sample");
	expect(urls.at(-1)?.searchParams.get("cursor")).toBe(cursor);
	fireEvent.click(screen.getByRole("button", { name: "下一批复核：human" }));
	await screen.findByText("内容已删除");
	expect(urls.at(-1)?.searchParams.get("reviewCursor")).toBe(cursor);
	expect(urls.at(-1)?.searchParams.get("scoreId")).toBe(sid);
	expect(urls.at(-1)?.searchParams.has("cursor")).toBe(false);
	fireEvent.change(screen.getByLabelText("每页评分与复核条数"), {
		target: { value: "1" },
	});
	await screen.findByText("Sensitive sample");
	expect(urls.at(-1)?.searchParams.get("limit")).toBe("1");
	expect(urls.at(-1)?.searchParams.has("reviewCursor")).toBe(false);

	denied = true;
	fireEvent.click(screen.getByRole("button", { name: "刷新分析" }));
	await screen.findByRole("alert");
	expect(screen.queryByText("Sensitive sample")).toBeNull();
	expect(screen.queryByText("Original reason")).toBeNull();
	expect(
		urls.some(
			(u) =>
				u.pathname.includes("/review-context") ||
				u.pathname.includes("/reviews"),
		),
	).toBe(false);
});
it("shows the controlled business failure separately from scoring faults", async () => {
	const id = "00000000-0000-4000-8000-000000000001";
	const measure = { value: null, observed: 0, total: 0 };
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input) =>
			String(input instanceof Request ? input.url : input).includes("/history")
				? Response.json({ items: [], nextCursor: null })
				: Response.json({
						experimentId: id,
						datasetId: id,
						versionId: id,
						fixedSamples: 1,
						observedAt: "2026-10-29T00:00:00.000Z",
						contentAvailable: false,
						taskTypesAvailable: false,
						groups: [],
						pairs: [],
						items: [
							{
								sampleTaskId: id,
								sampleId: "one",
								variantId: "base",
								executionId: "execution",
								status: "failed",
								failure: {
									category: "queue_timeout",
									message: "排队超过等待时限，本条消息未处理，请稍后重新发送",
								},
								requested: {
									variantId: "base",
									agentId: "agent",
									configurationRevision: 1,
									modelOptionId: null,
									reasoningLevel: null,
									toolEnvironment: "controlled",
								},
								requestedEvidence: null,
								preparedRuntime: null,
								actual: {
									attempts: [],
									observedAttempts: 0,
									conditions: [],
									conditionStatus: "missing",
									inputTokens: measure,
									outputTokens: measure,
									cachedInputTokens: measure,
									modelDurationMs: measure,
								},
								taskElapsedMs: null,
								scores: [],
							},
						],
					}),
		),
	);
	render(
		<EvaluationAnalysis
			selected={id}
			onSelect={() => {}}
			onNewVersion={() => {}}
		/>,
	);
	expect(
		await screen.findByText(
			"业务失败原因：排队超过等待时限，本条消息未处理，请稍后重新发送",
		),
	).not.toBeNull();
});
