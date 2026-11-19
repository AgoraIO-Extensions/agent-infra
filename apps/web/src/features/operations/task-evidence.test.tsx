import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { getOperationsTasksV2 } from "../../pilot/generated-v2/sdk.gen.js";
import { TaskEvidence } from "./task-evidence.js";

vi.mock("../../pilot/generated-v2/sdk.gen.js", () => ({
	getOperationsTasksV2: vi.fn(),
}));

it("keeps acceptance visible and reports missing phases including the terminal result", async () => {
	vi.mocked(getOperationsTasksV2).mockResolvedValueOnce({
		response: { status: 200 },
		data: {
			schemaVersion: 2,
			source: "platform",
			state: "available",
			truncated: false,
			tasks: [
				{
					executionId: "run-1",
					status: "failed",
					evidence: [
						{
							stage: "acceptance",
							state: "accepted",
							observedAt: "2026-11-01T00:00:00Z",
							startedAt: null,
							finishedAt: null,
							durationMs: null,
							errorCode: null,
						},
					],
				},
			],
		},
	} as Awaited<ReturnType<typeof getOperationsTasksV2>>);
	const client = new QueryClient();
	const rendered = render(
		<QueryClientProvider client={client}>
			<TaskEvidence agentId="agent" sessionId="session" identityKey="admin" />
		</QueryClientProvider>,
	);
	try {
		expect(
			await screen.findByText(
				"所选范围缺少阶段证据（等待、投递或恢复、执行、结果）。",
			),
		).toBeTruthy();
		expect(screen.getByText(/受理 · 已受理/)).toBeTruthy();
		expect(screen.getByRole("heading", { name: "run-1 · 失败" })).toBeTruthy();
	} finally {
		rendered.unmount();
		client.clear();
	}
});
