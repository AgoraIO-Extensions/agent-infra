import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentDetailScreen } from "./agent-detail-screen.js";
import { renderWithAgentRouter } from "./test-router.js";

const startingAgent = AgentProjectionV2Schema.parse(
	pilotFakeScenariosV2.starting.response.body,
);

describe("AgentDetailScreen", () => {
	it("links to a new conversation and directly to history for a ready platform Agent", async () => {
		const agent = AgentProjectionV2Schema.parse({
			...startingAgent,
			serviceAvailability: "ready",
			agentId: "agent:tenant/01?draft#one%",
		});
		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent }} />,
		);
		const chat = screen.getByRole("link", { name: "开始对话" });
		const history = screen.getByRole("link", { name: "个人历史" });
		expect(chat.getAttribute("href")).toBe(
			"/agents/agent%3Atenant%2F01%3Fdraft%23one%25/conversations",
		);
		expect(history.getAttribute("href")).toBe(
			"/agents/agent%3Atenant%2F01%3Fdraft%23one%25/conversations?view=history",
		);
	});
	it("preserves the history entry but disables new conversations while unavailable", async () => {
		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent: startingAgent }} />,
		);
		expect(
			(screen.getByRole("button", { name: "开始对话" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(screen.getByRole("link", { name: "个人历史" })).toBeTruthy();
		expect(screen.getByText("历史保留，当前不可发送消息。")).toBeTruthy();
	});

	it("renders a projected Agent as a responsive read-only detail", async () => {
		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent: startingAgent }} />,
		);

		expect(
			screen.getByRole("heading", { name: "Release assistant" }),
		).toBeTruthy();
		expect(screen.getByText("Helps the release team")).toBeTruthy();
		expect(screen.getByText("可用")).toBeTruthy();
		expect(screen.getByText("启动中")).toBeTruthy();
		expect(screen.getByText("Owner", { selector: "dt" })).toBeTruthy();
		expect(screen.getByText("Web：可用、企微机器人：未配置")).toBeTruthy();
		expect(screen.getByText(/Primary model.*medium、high/)).toBeTruthy();
		expect(
			screen.getByText(
				"此 Agent 支持独立 Connection 直连，使用前需由当前主体完成授权。",
			),
		).toBeTruthy();
		expect(
			screen
				.getByRole("link", { name: "返回 Agent 列表" })
				.getAttribute("href"),
		).toBe("/agents");
		expect(screen.queryByText("MODEL_API_KEY")).toBeNull();
		expect(screen.queryByText("WORKSPACE_NAME")).toBeNull();
		expect(screen.queryByText("批准申请")).toBeNull();
		expect(screen.queryByText("配置与管理")).toBeNull();
	});

	it("renders an Owner settings entry only when the route supplies one", async () => {
		await renderWithAgentRouter(
			<AgentDetailScreen
				ownerSettings={{ agentId: startingAgent.agentId }}
				state={{ kind: "ready", agent: startingAgent }}
			/>,
		);

		expect(
			screen.getByRole("link", { name: "配置与管理" }).getAttribute("href"),
		).toBe(`/agents/${startingAgent.agentId}/configuration`);
	});

	it("renders a server-projected self-managed access entry", async () => {
		const agent = AgentProjectionV2Schema.parse({
			...startingAgent,
			interactionUrl: "https://agent.example.test",
			source: {
				kind: "custom",
				imageReference: "registry.example/agents/pilot@sha256:abc",
				interactionMode: "self-managed",
				identityResponsibility: "self-managed",
			},
		});

		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent }} />,
		);

		expect(
			screen.getByRole("link", { name: "打开 Agent" }).getAttribute("href"),
		).toBe("https://agent.example.test/");
		expect(screen.queryByRole("link", { name: "个人历史" })).toBeNull();
		expect(screen.queryByRole("link", { name: "开始对话" })).toBeNull();
		expect(screen.queryByRole("button", { name: "开始对话" })).toBeNull();
	});

	it.each([
		"javascript:alert(1)",
		"https://user:password@agent.example.test",
		"https://agent.example.test?access_token=secret",
		"https://agent.example.test/#token=secret",
	])("omits unsafe self-managed access entry %s", async (interactionUrl) => {
		const selfManagedAgent = AgentProjectionV2Schema.parse({
			...startingAgent,
			interactionUrl: "https://agent.example.test",
			source: {
				kind: "custom",
				imageReference: "registry.example/agents/pilot@sha256:abc",
				interactionMode: "self-managed",
				identityResponsibility: "self-managed",
			},
		});
		const agent = { ...selfManagedAgent, interactionUrl };

		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent }} />,
		);

		expect(screen.queryByRole("link", { name: "打开 Agent" })).toBeNull();
		expect(screen.queryByText(interactionUrl)).toBeNull();
	});

	it("omits a self-managed access entry from a platform-adapter projection", async () => {
		const agent = AgentProjectionV2Schema.parse({
			...startingAgent,
			interactionUrl: "https://agent.example.test",
			source: {
				kind: "custom",
				imageReference: "registry.example/agents/pilot@sha256:abc",
				interactionMode: "platform-adapter",
			},
		});

		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent }} />,
		);

		expect(screen.queryByRole("link", { name: "打开 Agent" })).toBeNull();
	});

	it("omits a direct access entry when Platform owns self-managed identity", async () => {
		const agent = AgentProjectionV2Schema.parse({
			...startingAgent,
			interactionUrl: "https://agent.example.test",
			source: {
				kind: "custom",
				imageReference: "registry.example/agents/pilot@sha256:abc",
				interactionMode: "self-managed",
				identityResponsibility: "platform-managed",
			},
		});

		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent }} />,
		);

		expect(screen.queryByRole("link", { name: "打开 Agent" })).toBeNull();
	});

	it("renders one opaque unavailable state for a missing or forbidden Agent", async () => {
		await renderWithAgentRouter(
			<AgentDetailScreen
				state={{
					kind: "unavailable",
					retryable: false,
				}}
			/>,
		);

		expect(screen.getByRole("alert").textContent).toContain(
			"此 Agent 暂时无法访问。",
		);
		expect(screen.queryByText("Release assistant")).toBeNull();
		expect(screen.queryByText(/forbidden|missing/i)).toBeNull();
	});

	it("renders an explicit loading state", async () => {
		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "loading" }} />,
		);

		expect(
			screen.getByText("正在加载 Agent 详情…").getAttribute("aria-live"),
		).toBe("polite");
	});
});
