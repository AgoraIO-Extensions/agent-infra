import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { client } from "../../pilot/generated-v2/client.gen.js";
import { TaskFeedback } from "./task-feedback.js";

const context = (id: string) => ({
	executionId: id,
	eligibility: "eligible",
	terminalObservedAt: null,
	conditions: [],
	conditionDigest: "a".repeat(64),
	revision: 0,
	feedback: null,
	feedbackCurrent: false,
	categories: ["correctness", "other"],
});
const record = (id: string) => ({
	executionId: id,
	principal: { kind: "user", id: "viewer" },
	agentId: "agent",
	revision: 1,
	conditionDigest: "a".repeat(64),
	useful: true,
	categories: [],
	policyId: "policy",
	policyRevision: 1,
	createdAt: "2026-10-01T00:00:00.000Z",
	updatedAt: "2026-10-01T00:00:00.000Z",
	metadataExpiresAt: "2027-10-01T00:00:00.000Z",
});
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
it("keeps a lost write on the original Execution, body and idempotency key across refresh", async () => {
	const writes: { key: string | null; body: string; path: string }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const req = input instanceof Request ? input : new Request(input);
			if (req.method === "PUT") {
				writes.push({
					key: req.headers.get("Idempotency-Key"),
					body: await req.text(),
					path: new URL(req.url).pathname,
				});
				if (writes.length === 1) throw new Error("synthetic lost response");
				return Response.json(record("first"));
			}
			return Response.json(context("first"));
		}),
	);
	render(<TaskFeedback executionId="first" />);
	fireEvent.click(screen.getByRole("button", { name: "任务反馈" }));
	await screen.findByText(
		"历史终态时间缺失：可以反馈，但不会虚构所属统计窗口。",
	);
	fireEvent.click(screen.getByRole("button", { name: "有用" }));
	fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));
	await screen.findByText(/操作未确认/);
	fireEvent.click(screen.getByRole("button", { name: "刷新反馈" }));
	await screen.findByRole("button", { name: "提交反馈" });
	expect(
		(screen.getByRole("button", { name: "提交反馈" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
	fireEvent.click(screen.getByRole("button", { name: "重试原操作" }));
	await screen.findByText("反馈已保存。");
	expect(writes).toHaveLength(2);
	expect(writes[1]).toEqual(writes[0]);
	expect(writes[0].key).toBeTruthy();
	expect(writes[0].path).toBe("/api/v2/task-feedback/first");
});
it("does not paint a late write or replay its intent after the rendered Execution changes", async () => {
	let finish: (value: Response) => void = () => {};
	const paths: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const req = input instanceof Request ? input : new Request(input);
			const id = new URL(req.url).pathname.split("/").at(-1) ?? "";
			if (req.method === "PUT") {
				paths.push(id);
				return new Promise<Response>((resolve) => {
					finish = resolve;
				});
			}
			return Response.json(context(id));
		}),
	);
	const view = render(<TaskFeedback executionId="first" />);
	fireEvent.click(screen.getByRole("button", { name: "任务反馈" }));
	await screen.findByRole("button", { name: "提交反馈" });
	fireEvent.click(screen.getByRole("button", { name: "有用" }));
	fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));
	await waitFor(() => expect(paths).toEqual(["first"]));
	view.rerender(<TaskFeedback executionId="second" />);
	await screen.findByRole("button", { name: "提交反馈" });
	await act(async () => finish(Response.json(record("first"))));
	expect(screen.queryByText("反馈已保存。")).toBeNull();
	expect(screen.queryByRole("button", { name: "重试原操作" })).toBeNull();
	expect(paths).toEqual(["first"]);
});
it("clears late context on revocation and does not call the API for an unopened card", async () => {
	let finish: (value: Response) => void = () => {};
	const fetcher = vi.fn(
		() =>
			new Promise<Response>((resolve) => {
				finish = resolve;
			}),
	);
	vi.stubGlobal("fetch", fetcher);
	const view = render(<TaskFeedback executionId="first" />);
	expect(fetcher).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "任务反馈" }));
	await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
	view.rerender(<TaskFeedback executionId="first" disabled />);
	await act(async () =>
		finish(Response.json({ ...context("first"), feedback: record("first") })),
	);
	expect(screen.queryByRole("button", { name: "更新反馈" })).toBeNull();
	expect(screen.queryByRole("form")).toBeNull();
});
