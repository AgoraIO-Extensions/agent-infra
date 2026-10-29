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
import { EvaluationFeedbackSummary } from "./evaluation-feedback.js";

vi.mock("../agent-discovery/agent-discovery.js", () => ({
	loadAgentDiscovery: vi.fn(async () => ({
		kind: "ready",
		agents: [{ agentId: "agent", name: "Visible agent" }],
	})),
}));
const summary = {
	query: { from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" },
	agentId: "agent",
	view: "self",
	observedAt: "2026-10-02T00:00:00Z",
	eligibleTasks: 0,
	feedbackTasks: 0,
	unfeedbackTasks: 0,
	usefulTasks: 0,
	notUsefulTasks: 0,
	conditionChangedTasks: 1,
	missingActualTasks: 0,
	terminalTimeMissingTasks: 2,
	feedbackRate: null,
	classification: {
		correctness: 0,
		relevance: 0,
		instruction_following: 0,
		format: 0,
		tool_use: 0,
		incomplete: 0,
		performance: 0,
		other: 0,
	},
	conditions: [],
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
it("shows zero denominator and missing terminal time explicitly with a half-open query", async () => {
	let url: URL | undefined;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const req = input instanceof Request ? input : new Request(input);
			url = new URL(req.url);
			return Response.json(summary);
		}),
	);
	render(<EvaluationFeedbackSummary />);
	await screen.findByRole("option", { name: "Visible agent" });
	fireEvent.change(screen.getByLabelText("查看范围"), {
		target: { value: "self" },
	});
	expect(screen.getByRole("option", { name: "Visible agent" })).toBeTruthy();
	fireEvent.change(screen.getByLabelText("Agent"), {
		target: { value: "agent" },
	});
	fireEvent.click(screen.getByRole("button", { name: "查询反馈汇总" }));
	const result = await screen.findByRole("region", { name: "反馈汇总结果" });
	expect(within(result).getByText("无样本")).toBeTruthy();
	expect(
		within(result).getByText("此窗口没有可计入的任务，不推断为全部通过。"),
	).toBeTruthy();
	expect(result.textContent).toContain("终态时间缺失2");
	expect(result.textContent).toContain("条件已变化1");
	expect(result.textContent).toContain("（不含）");
	expect(url?.searchParams.get("view")).toBe("self");
	expect(url?.searchParams.has("principalId")).toBe(false);
});
it("drops a late self summary when changing to Owner scope", async () => {
	let finish: (value: Response) => void = () => {};
	const fetcher = vi.fn(
		() =>
			new Promise<Response>((resolve) => {
				finish = resolve;
			}),
	);
	vi.stubGlobal("fetch", fetcher);
	render(<EvaluationFeedbackSummary />);
	await screen.findByRole("option", { name: "Visible agent" });
	fireEvent.change(screen.getByLabelText("Agent"), {
		target: { value: "agent" },
	});
	fireEvent.click(screen.getByRole("button", { name: "查询反馈汇总" }));
	await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
	fireEvent.change(screen.getByLabelText("查看范围"), {
		target: { value: "owner" },
	});
	await act(async () => finish(Response.json(summary)));
	expect(screen.queryByRole("region", { name: "反馈汇总结果" })).toBeNull();
	expect((screen.getByLabelText("Agent") as HTMLSelectElement).value).toBe("");
});
