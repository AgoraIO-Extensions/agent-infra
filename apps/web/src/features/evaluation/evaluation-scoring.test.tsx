import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { client } from "../../pilot/generated-v2/client.gen.js";
import { EvaluationScoring } from "./evaluation-scoring.js";

const score = {
	scoreId: "10000000-0000-4000-8000-000000000001",
	sampleTaskId: "10000000-0000-4000-8000-000000000002",
	experimentId: "10000000-0000-4000-8000-000000000003",
	executionId: "execution",
	scorerId: "human",
	scorerVersion: "1",
	source: "human",
	status: "scored",
	revision: 2,
	value: 1,
	passed: true,
	failureCode: null,
	scoreActor: { kind: "user", id: "grader" },
};
const context = {
	scoreId: "10000000-0000-4000-8000-000000000001",
	revision: 2,
	sampleTaskId: "10000000-0000-4000-8000-000000000002",
	experimentId: "10000000-0000-4000-8000-000000000003",
	executionId: "execution",
	status: "scored",
	resultVersion: "1",
	sample: {
		id: "sample",
		input: "Authorized sample",
		context: null,
		expectedResult: "yes",
		taskType: "answer",
	},
	rubric: { id: "quality", description: "Answer yes" },
	scorer: {
		scorerId: "human",
		version: "1",
		source: "human",
		minimum: 0,
		maximum: 1,
		passThreshold: 1,
	},
	output: { text: "yes", executionId: "execution", resultVersion: "1" },
	score: { status: "scored", value: 1, reason: "Original reason" },
};
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
it("review-only uses review context, preserves original score and paginates retained history", async () => {
	const paths: string[] = [];
	let saved = false;
	let body: unknown;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const req = input instanceof Request ? input : new Request(input);
			const url = new URL(req.url);
			paths.push(url.pathname + url.search);
			if (url.pathname.endsWith("/worklist"))
				return url.searchParams.get("purpose") === "review"
					? Response.json({
							purpose: "review",
							items: [score],
							nextCursor: null,
						})
					: Response.json({ code: "RESOURCE_UNAVAILABLE" }, { status: 404 });
			if (url.pathname.endsWith("/review-context"))
				return Response.json(context);
			if (url.pathname.endsWith("/reviews") && req.method === "POST") {
				saved = true;
				body = await req.json();
				return Response.json({
					reviewId: "10000000-0000-4000-8000-000000000004",
					scoreId: "10000000-0000-4000-8000-000000000001",
					scoreRevision: 2,
					reviewer: { kind: "user", id: "reviewer" },
				});
			}
			if (url.pathname.endsWith("/reviews"))
				return Response.json({
					items: saved
						? [
								{
									reviewId: "10000000-0000-4000-8000-000000000004",
									scoreId: "10000000-0000-4000-8000-000000000001",
									scoreRevision: 2,
									reviewer: { kind: "user", id: "reviewer" },
									contentStatus: url.searchParams.has("cursor")
										? "deleted"
										: "available",
									result: url.searchParams.has("cursor")
										? null
										: {
												status: "scored",
												value: 0,
												reason: "Independent reason",
											},
								},
							]
						: [],
					nextCursor:
						saved && !url.searchParams.has("cursor")
							? "10000000-0000-4000-8000-000000000005"
							: null,
				});
			return Response.json({ code: "RESOURCE_UNAVAILABLE" }, { status: 404 });
		}),
	);
	render(<EvaluationScoring />);
	await screen.findByRole("alert");
	fireEvent.change(screen.getByLabelText("工作用途"), {
		target: { value: "review" },
	});
	fireEvent.click(
		await screen.findByRole("button", {
			name: "打开复核 10000000-0000-4000-8000-000000000001",
		}),
	);
	await screen.findByText("Original reason");
	fireEvent.change(screen.getByLabelText("分数（0–1）"), {
		target: { value: "0" },
	});
	fireEvent.change(screen.getByLabelText("判定依据"), {
		target: { value: "Independent reason" },
	});
	fireEvent.click(screen.getByRole("button", { name: "保存独立复核" }));
	await within(screen.getByRole("region", { name: "独立复核历史" })).findByText(
		"Independent reason",
	);
	expect(screen.getByText("Original reason")).toBeTruthy();
	expect(body).toEqual({
		expectedRevision: 2,
		result: { status: "scored", value: 0, reason: "Independent reason" },
	});
	fireEvent.click(screen.getByRole("button", { name: "下一批复核" }));
	await screen.findByText("内容已删除");
	expect(
		within(screen.getByRole("region", { name: "独立复核历史" })).queryByText(
			"Independent reason",
		),
	).toBeNull();
	expect(paths.some((p) => p.includes("/content"))).toBe(false);
	expect(
		paths.some((p) =>
			p.includes("cursor=10000000-0000-4000-8000-000000000005"),
		),
	).toBe(true);
});
it("does not restore review body from a late response after switching purpose", async () => {
	let finish: (r: Response) => void = () => {};
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const req = input instanceof Request ? input : new Request(input);
			const url = new URL(req.url);
			if (url.pathname.endsWith("/worklist"))
				return Response.json({
					purpose: url.searchParams.get("purpose"),
					items: [score],
					nextCursor: null,
				});
			if (url.pathname.endsWith("/review-context"))
				return new Promise<Response>((resolve) => {
					finish = resolve;
				});
			return Response.json({ items: [], nextCursor: null });
		}),
	);
	render(<EvaluationScoring />);
	fireEvent.change(screen.getByLabelText("工作用途"), {
		target: { value: "review" },
	});
	fireEvent.click(
		await screen.findByRole("button", {
			name: "打开复核 10000000-0000-4000-8000-000000000001",
		}),
	);
	await waitFor(() =>
		expect(screen.getByRole("region", { name: "独立复核编辑" })).toBeTruthy(),
	);
	fireEvent.change(screen.getByLabelText("工作用途"), {
		target: { value: "score" },
	});
	await act(async () => finish(Response.json(context)));
	expect(screen.queryByText("Authorized sample")).toBeNull();
	expect(screen.queryByRole("region", { name: "独立复核编辑" })).toBeNull();
});
