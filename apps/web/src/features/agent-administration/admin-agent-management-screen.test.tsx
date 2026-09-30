import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { AdminAgentManagementScreen } from "./admin-agent-management-screen.js";

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		params,
		to,
	}: {
		children: ReactNode;
		params?: Record<string, string>;
		to: string;
	}) => {
		let href = to;
		for (const [key, value] of Object.entries(params ?? {}))
			href = href.replace(`$${key}`, value);
		return <a href={href}>{children}</a>;
	},
}));

vi.mock("./agent-lifecycle-workflow.js", () => ({
	AgentLifecycleWorkflow: ({ agent }: { agent: AgentProjectionV2 }) => (
		<div>生命周期操作：{agent.name}</div>
	),
}));

afterEach(cleanup);

const agent: AgentProjectionV2 = AgentProjectionV2Schema.parse({
	...pilotFakeScenariosV2.starting.response.body,
	agentId: "agent-codex",
	name: "编程助手",
	description: "管理员可见的 Agent",
});

describe("AdminAgentManagementScreen", () => {
	it("renders the admin list and lifecycle handoff without changing the API owner", () => {
		render(
			<AdminAgentManagementScreen
				state={{ kind: "ready", agents: [agent] }}
				onRetry={vi.fn()}
				retrying={false}
			/>,
		);

		expect(screen.getByRole("heading", { name: "Agent 管理" })).toBeTruthy();
		expect(screen.getByText("生命周期操作：编程助手")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "查看详情" }).getAttribute("href"),
		).toBe("/agents/agent-codex");
		expect(
			screen.getByRole("link", { name: "返回工作台" }).getAttribute("href"),
		).toBe("/");
	});

	it("keeps retry and empty states distinct", () => {
		const retry = vi.fn();
		const { rerender } = render(
			<AdminAgentManagementScreen
				state={{ kind: "unavailable", retryable: true }}
				onRetry={retry}
				retrying={false}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toContain("重新加载 Agent");

		rerender(
			<AdminAgentManagementScreen
				state={{ kind: "ready", agents: [] }}
				onRetry={retry}
				retrying={false}
			/>,
		);
		expect(
			screen.getByRole("heading", { name: "暂无可管理 Agent" }),
		).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
