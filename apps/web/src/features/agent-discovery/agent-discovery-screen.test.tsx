import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { AgentDiscoveryScreen } from "./agent-discovery-screen.js";
import { renderWithAgentRouter } from "./test-router.js";

const startingAgent = AgentProjectionV2Schema.parse(
	pilotFakeScenariosV2.starting.response.body,
);

describe("AgentDiscoveryScreen", () => {
	it("uses the supplied search value as authority and applies restored values", async () => {
		const onQueryChange = vi.fn();
		const documentAgent = AgentProjectionV2Schema.parse({
			...startingAgent,
			agentId: "documents",
			name: "文档检查",
			description: "检查发布说明和措辞",
		});
		function ControlledCollection() {
			const [query, setQuery] = useState("Release");
			return (
				<>
					<button type="button" onClick={() => setQuery("发布说明")}>
						恢复页面搜索
					</button>
					<AgentDiscoveryScreen
						query={query}
						onQueryChange={onQueryChange}
						state={{ kind: "ready", agents: [startingAgent, documentAgent] }}
					/>
				</>
			);
		}
		await renderWithAgentRouter(<ControlledCollection />);
		const input = screen.getByRole("searchbox", {
			name: "搜索 Agent",
		}) as HTMLInputElement;
		expect(input.value).toBe("Release");
		expect(
			screen.getByRole("link", { name: "查看 Release assistant 详情" }),
		).toBeTruthy();
		expect(
			screen.queryByRole("link", { name: "查看 文档检查 详情" }),
		).toBeNull();
		fireEvent.change(input, { target: { value: "next search" } });
		expect(onQueryChange).toHaveBeenCalledWith("next search");
		expect(input.value).toBe("Release");
		expect(
			screen.getByRole("link", { name: "查看 Release assistant 详情" }),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "恢复页面搜索" }));
		expect(input.value).toBe("发布说明");
		expect(
			screen.getByRole("link", { name: "查看 文档检查 详情" }),
		).toBeTruthy();
		expect(
			screen.queryByRole("link", { name: "查看 Release assistant 详情" }),
		).toBeNull();
	});

	it("searches only authorized names and purposes while reporting the actual collection size", async () => {
		const documentAgent = AgentProjectionV2Schema.parse({
			...startingAgent,
			agentId: "documents",
			name: "文档检查",
			description: "检查发布说明和措辞",
		});
		await renderWithAgentRouter(
			<AgentDiscoveryScreen
				state={{ kind: "ready", agents: [startingAgent, documentAgent] }}
			/>,
		);
		expect(screen.getByRole("status").textContent).toBe("2 个获授权 Agent");
		fireEvent.change(screen.getByRole("searchbox", { name: "搜索 Agent" }), {
			target: { value: "  RELEASE  " },
		});
		expect(
			screen.getByRole("link", { name: "查看 Release assistant 详情" }),
		).toBeTruthy();
		expect(
			screen.queryByRole("link", { name: "查看 文档检查 详情" }),
		).toBeNull();
		expect(screen.getByRole("status").textContent).toBe(
			"2 个获授权 Agent，匹配 1 个",
		);
		fireEvent.change(screen.getByRole("searchbox", { name: "搜索 Agent" }), {
			target: { value: "发布说明" },
		});
		expect(
			screen.getByRole("link", { name: "查看 文档检查 详情" }),
		).toBeTruthy();
		expect(
			screen.queryByRole("link", { name: "查看 Release assistant 详情" }),
		).toBeNull();
		fireEvent.change(screen.getByRole("searchbox", { name: "搜索 Agent" }), {
			target: { value: "not-in-authorized-response" },
		});
		expect(screen.getByText("未找到匹配的 Agent。")).toBeTruthy();
		expect(screen.queryAllByRole("link")).toHaveLength(0);
	});
	it("drops previously visible Agents when the authorized collection changes", async () => {
		function Collection() {
			const [agents, setAgents] = useState([startingAgent]);
			return (
				<>
					<button type="button" onClick={() => setAgents([])}>
						刷新授权集合
					</button>
					<AgentDiscoveryScreen state={{ kind: "ready", agents }} />
				</>
			);
		}
		await renderWithAgentRouter(<Collection />);
		fireEvent.change(screen.getByRole("searchbox", { name: "搜索 Agent" }), {
			target: { value: "Release" },
		});
		fireEvent.click(screen.getByRole("button", { name: "刷新授权集合" }));
		expect(
			screen.queryByRole("link", { name: /Release assistant/ }),
		).toBeNull();
		expect(screen.getByRole("status").textContent).toBe(
			"0 个获授权 Agent，匹配 0 个",
		);
	});

	it("renders a visible Agent as a responsive detail link", async () => {
		await renderWithAgentRouter(
			<AgentDiscoveryScreen
				state={{ kind: "ready", agents: [startingAgent] }}
			/>,
		);

		const link = screen.getByRole("link", { name: /Release assistant/ });
		expect(link.getAttribute("href")).toBe("/agents/agent-pilot-1");
		expect(screen.getByText("启动中")).toBeTruthy();
		expect(link.className).toContain("min-w-0");
	});

	it.each([
		["starting", "启动中"],
		["updating", "更新中"],
		["unavailable", "暂时不可用"],
		["ready", "就绪"],
	])(
		"shows management status alongside %s service availability",
		async (serviceAvailability, label) => {
			const agent = AgentProjectionV2Schema.parse({
				...startingAgent,
				serviceAvailability,
			});
			await renderWithAgentRouter(
				<AgentDiscoveryScreen state={{ kind: "ready", agents: [agent] }} />,
			);
			expect(screen.getByText("可用")).toBeTruthy();
			expect(screen.getByText(label)).toBeTruthy();
		},
	);

	it("uses Router navigation for an opaque Agent identifier", async () => {
		const agent = AgentProjectionV2Schema.parse({
			...startingAgent,
			agentId: "agent:tenant/01?draft#one%",
		});

		await renderWithAgentRouter(
			<AgentDiscoveryScreen state={{ kind: "ready", agents: [agent] }} />,
		);

		expect(
			screen
				.getByRole("link", { name: /Release assistant/ })
				.getAttribute("href"),
		).toBe("/agents/agent%3Atenant%2F01%3Fdraft%23one%25");
	});

	it("renders an explicit empty state for an empty visible-Agent response", async () => {
		await renderWithAgentRouter(
			<AgentDiscoveryScreen state={{ kind: "ready", agents: [] }} />,
		);

		expect(screen.getByText("暂无你有权访问的 Agent。")).toBeTruthy();
	});

	it("renders an unavailable list without stale Agent data", async () => {
		await renderWithAgentRouter(
			<AgentDiscoveryScreen
				state={{
					kind: "unavailable",
					retryable: false,
				}}
			/>,
		);

		expect(screen.getByRole("alert").textContent).toContain(
			"Agent 列表暂时无法访问，请联系管理员。",
		);
		expect(screen.queryByText("Release assistant")).toBeNull();
		expect(screen.queryByText(/forbidden|missing/i)).toBeNull();
	});

	it("renders an explicit loading state", async () => {
		await renderWithAgentRouter(
			<AgentDiscoveryScreen state={{ kind: "loading" }} />,
		);

		expect(screen.getByText("正在加载 Agent…").getAttribute("aria-live")).toBe(
			"polite",
		);
	});
});
