// @vitest-environment jsdom
import type { AuditCall } from "@agent-infra/connection-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn() }));
vi.mock("../api", () => ({
	connectionApi: { listAuditCalls: mocks.list, getAuditCall: mocks.detail },
}));
vi.mock("../shell", () => ({
	ConsoleShell: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	PageError: ({ error }: { error: Error }) => (
		<p role="alert">{error.message}</p>
	),
}));

import { ActionCallsPage, auditTimeRange } from "./action-calls-page";

const call: AuditCall = {
	callId: "call-1",
	createdAt: "2026-09-26T06:32:08Z",
	principalId: "person",
	person: "张三",
	email: "zhang@example.invalid",
	consumerId: "consumer",
	consumer: "Codex",
	instanceId: "instance",
	actorKey: null,
	connectionId: "connection",
	providerId: "jira",
	action: "jira.create_issue",
	actionVersionId: "jira.create_issue@v1",
	status: "SUCCEEDED",
};
afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});
function mount() {
	render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<ActionCallsPage />
		</QueryClientProvider>,
	);
}
it("uses Shanghai calendar days and rejects invalid custom ranges", () => {
	expect(
		auditTimeRange("today", "", "", new Date("2026-09-25T18:00:00Z")),
	).toEqual({
		from: "2026-09-25T16:00:00.000Z",
		to: "2026-09-26T16:00:00.000Z",
	});
	expect(
		auditTimeRange("custom", "2026-09-26T14:20", "2026-09-26T14:30"),
	).toEqual({
		from: "2026-09-26T06:20:00.000Z",
		to: "2026-09-26T06:31:00.000Z",
	});
	expect(
		auditTimeRange("custom", "2026-09-27T00:00", "2026-09-26T00:00"),
	).toBeUndefined();
	expect(auditTimeRange("custom", "", "")).toBeUndefined();
});
it("combines person and time filters, paginates and resets pagination on a new query", async () => {
	mocks.list.mockImplementation(async (query) => ({
		items: [call],
		nextCursor: query.cursor ? null : "next-page",
	}));
	mocks.detail.mockResolvedValue({
		...call,
		input: [{ label: "标题", value: "已脱敏", state: "REDACTED" }],
		output: [],
		timeline: [],
	});
	mount();
	await screen.findByText("已脱敏");
	fireEvent.click(screen.getByRole("button", { name: "下一页" }));
	await waitFor(() =>
		expect(mocks.list).toHaveBeenLastCalledWith(
			expect.objectContaining({ cursor: "next-page" }),
		),
	);
	fireEvent.change(screen.getByLabelText("搜索操作"), {
		target: { value: "zhang@example.invalid" },
	});
	fireEvent.change(screen.getByLabelText("时间范围"), {
		target: { value: "custom" },
	});
	fireEvent.change(screen.getByLabelText("开始时间"), {
		target: { value: "2026-09-26T14:20" },
	});
	fireEvent.change(screen.getByLabelText("结束时间"), {
		target: { value: "2026-09-26T14:30" },
	});
	fireEvent.change(screen.getByLabelText("执行结果"), {
		target: { value: "SUCCEEDED" },
	});
	fireEvent.click(screen.getByRole("button", { name: "查询" }));
	await waitFor(() =>
		expect(mocks.list).toHaveBeenLastCalledWith({
			cursor: undefined,
			from: "2026-09-26T06:20:00.000Z",
			to: "2026-09-26T06:31:00.000Z",
			query: "zhang@example.invalid",
			status: "SUCCEEDED",
		}),
	);
	expect(screen.queryByText("无权限查看正文")).toBeNull();
	fireEvent.change(screen.getByLabelText("开始时间"), {
		target: { value: "2026-09-27T14:20" },
	});
	const before = mocks.list.mock.calls.length;
	fireEvent.click(screen.getByRole("button", { name: "查询" }));
	expect(await screen.findByRole("alert")).toBeTruthy();
	expect(mocks.list.mock.calls.length).toBe(before);
});
it("does not present query failure as an empty result", async () => {
	mocks.list.mockRejectedValue(new Error("查询失败"));
	mount();
	expect(await screen.findByRole("alert")).toBeTruthy();
	expect(screen.queryByText("没有符合条件的操作")).toBeNull();
	expect(mocks.detail).not.toHaveBeenCalled();
});

it("shows no-parameter state and collapsed diagnostics without replay or export controls", async () => {
	mocks.list.mockResolvedValue({ items: [call], nextCursor: null });
	mocks.detail.mockResolvedValue({
		...call,
		input: [],
		inputState: "NO_PARAMETERS",
		output: [{ label: "账号名称", value: "已脱敏", state: "REDACTED" }],
		outputState: "REDACTED",
		timeline: [],
		diagnosticsTruncated: false,
		diagnostics: [
			{
				executionId: "123e4567-e89b-12d3-a456-426614174000",
				phase: "EXECUTE",
				droppedRequests: 0,
				requests: [
					{
						sequence: 1,
						service: "bitbucket",
						method: "GET",
						origin: "https://bitbucket.example.invalid",
						pathTemplate: "/rest/api/1.0/users/{segment}",
						startedAt: "2026-09-26T06:00:00.001Z",
						finishedAt: "2026-09-26T06:00:00.021Z",
						durationMs: 20,
						status: 200,
						outcome: "RESPONSE_HEADERS",
						errorCategory: null,
						requestIds: [{ name: "x-arequestid", value: "123x456x1" }],
					},
				],
			},
		],
	});
	mount();
	await screen.findByText("此操作无需输入参数");
	const summary = screen.getByText("后端排查信息");
	expect((summary.closest("details") as HTMLDetailsElement).open).toBe(false);
	fireEvent.click(summary);
	expect((summary.closest("details") as HTMLDetailsElement).open).toBe(true);
	expect(screen.getByText("123x456x1")).toBeTruthy();
	expect(screen.getByText("响应头耗时")).toBeTruthy();
	expect(screen.getByText("20 ms")).toBeTruthy();
	expect(document.body.textContent).not.toMatch(/curl|复制|重放|导出/);
});
