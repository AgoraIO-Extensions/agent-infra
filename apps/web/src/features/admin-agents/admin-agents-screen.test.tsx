import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AdminAgentsScreen,
	adminAgentStatuses,
	validateAdminAgentSearch,
} from "./admin-agents-screen.js";

vi.mock("@tanstack/react-router", () => ({
	Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
		<a href={to} {...props}>
			{children}
		</a>
	),
}));
afterEach(cleanup);
const baseline = AgentProjectionV2Schema.parse(
	pilotFakeScenariosV2.starting.response.body,
);
const agents = Array.from({ length: 12 }, (_, index) =>
	AgentProjectionV2Schema.parse({
		...baseline,
		agentId: `admin-agent-${index}`,
		name: `Agent ${index}`,
		description: `说明 ${index}`,
		managementStatus: index === 11 ? "disabled" : "available",
		serviceAvailability: index === 11 ? null : "ready",
		configuration: {
			...baseline.configuration,
			owners: [
				{
					userId: index === 11 ? "owner-late" : "someone-else",
					displayName: "其他 Owner",
					roles: ["employee"],
				},
			],
		},
	}),
);

describe("Administrator inventory presentation", () => {
	it("restores controlled search/status and searches Owner across the complete collection", () => {
		const change = vi.fn();
		const view = render(
			<AdminAgentsScreen
				state={{ kind: "ready", agents }}
				filters={{ q: "owner-late", status: "disabled", page: 2 }}
				onFiltersChange={change}
				onRefresh={vi.fn()}
			/>,
		);
		expect(screen.getByText("Agent 11")).toBeTruthy();
		expect(screen.queryByText("Agent 0")).toBeNull();
		expect(screen.getByText("第 1 / 1 页")).toBeTruthy();
		expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe(
			"owner-late",
		);
		fireEvent.change(screen.getByRole("searchbox"), {
			target: { value: "说明" },
		});
		expect(change).toHaveBeenLastCalledWith({
			q: "说明",
			status: "disabled",
			page: undefined,
		});
		view.rerender(
			<AdminAgentsScreen
				state={{ kind: "ready", agents }}
				filters={{ page: 2 }}
				onFiltersChange={change}
				onRefresh={vi.fn()}
			/>,
		);
		expect(screen.getByText("Agent 10")).toBeTruthy();
		expect(screen.queryByText("Agent 0")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "上一页" }));
		expect(change).toHaveBeenLastCalledWith({ page: 1 });
	});
	it("renders all five created states with a narrow Owner handoff entry", () => {
		render(
			<AdminAgentsScreen
				state={{
					kind: "ready",
					agents: adminAgentStatuses.map((managementStatus) => ({
						...baseline,
						agentId: managementStatus,
						managementStatus,
					})),
				}}
				filters={{}}
				onFiltersChange={vi.fn()}
				onRefresh={vi.fn()}
			/>,
		);
		expect(
			screen.getAllByRole("columnheader").map((cell) => cell.textContent),
		).toEqual(["Agent", "来源", "Owner", "状态", "系统操作"]);
		expect(screen.getAllByLabelText("Owner 交接入口")).toHaveLength(5);
		expect(
			screen.getAllByRole("link").map((link) => link.getAttribute("href")),
		).toEqual([
			"/admin/approvals",
			"/agents/$agentId/configuration",
			"/agents/$agentId/configuration",
			"/agents/$agentId/configuration",
			"/agents/$agentId/configuration",
		]);
		for (const name of ["停用", "重试", "查看详情", "开始对话"])
			expect(screen.queryByRole("button", { name })).toBeNull();
	});
	it("clears rows on failure or denial and separates empty from no matches", () => {
		const props = { filters: {}, onFiltersChange: vi.fn(), onRefresh: vi.fn() };
		const view = render(
			<AdminAgentsScreen {...props} state={{ kind: "ready", agents }} />,
		);
		view.rerender(
			<AdminAgentsScreen
				{...props}
				state={{ kind: "error", retryable: true }}
			/>,
		);
		expect(screen.queryByRole("table")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
		expect(props.onRefresh).toHaveBeenCalledOnce();
		view.rerender(<AdminAgentsScreen {...props} state={{ kind: "denied" }} />);
		expect(screen.getByText("当前无权访问 Agent 管理。")).toBeTruthy();
		expect(screen.queryByRole("link")).toBeNull();
		view.rerender(
			<AdminAgentsScreen {...props} state={{ kind: "ready", agents: [] }} />,
		);
		expect(screen.getByText("暂无已创建的 Agent。")).toBeTruthy();
		view.rerender(
			<AdminAgentsScreen
				{...props}
				filters={{ q: "nothing" }}
				state={{ kind: "ready", agents }}
			/>,
		);
		expect(screen.getByText("未找到匹配的 Agent。")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
		expect(props.onFiltersChange).toHaveBeenCalledWith({});
	});
	it("bounds URL values and rejects application statuses and malformed pagination", () => {
		expect(
			validateAdminAgentSearch({ q: "中文", status: "available", page: "2" }),
		).toEqual({ q: "中文", status: "available", page: 2 });
		for (const page of [0, -1, 1.5, 1001, Number.POSITIVE_INFINITY, {}, "oops"])
			expect(
				validateAdminAgentSearch({
					q: "x".repeat(257),
					status: "pending_approval",
					page,
				}),
			).toEqual({ q: undefined, status: undefined, page: undefined });
	});
});
