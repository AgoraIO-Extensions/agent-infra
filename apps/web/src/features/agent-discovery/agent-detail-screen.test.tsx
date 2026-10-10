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
			"/chat/agent%3Atenant%2F01%3Fdraft%23one%25",
		);
		expect(history.getAttribute("href")).toBe(
			"/chat/agent%3Atenant%2F01%3Fdraft%23one%25?view=history",
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
		expect(
			screen.getByText("可用", {
				selector: '.status-line [data-slot="badge"]',
			}),
		).toBeTruthy();
		expect(
			screen.getByText("启动中", {
				selector: '.status-line [data-slot="badge"]',
			}),
		).toBeTruthy();
		expect(screen.getByText("Owner", { selector: "dt" })).toBeTruthy();
		expect(
			screen.getByRole("region", { name: "运行与渠道" }).textContent,
		).toContain("Web可用企微机器人未配置");
		expect(screen.getByText("模型范围", { selector: "dt" })).toBeTruthy();
		expect(screen.getByText("默认选项", { selector: "dt" })).toBeTruthy();
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
		expect(screen.getByText("入口身份责任", { selector: "dt" })).toBeTruthy();
		expect(screen.getByText("由自有入口校验")).toBeTruthy();
		expect(screen.getByText("自有交互入口已就绪。")).toBeTruthy();
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

	it.each(["self-managed", "platform-managed"] as const)(
		"omits nonempty model information for a self-managed Agent with %s identity",
		async (identityResponsibility) => {
			const agent = AgentProjectionV2Schema.parse({
				...startingAgent,
				source: {
					kind: "custom",
					imageReference: "registry.example/agents/pilot@sha256:abc",
					interactionMode: "self-managed",
					identityResponsibility,
				},
			});
			expect(agent.configuration.modelOptions.length).toBeGreaterThan(0);
			expect(agent.configuration.defaultModelOptionId).toBeTruthy();
			expect(agent.configuration.defaultReasoningLevel).toBeTruthy();

			await renderWithAgentRouter(
				<AgentDetailScreen state={{ kind: "ready", agent }} />,
			);

			expect(screen.queryByText("模型范围", { selector: "dt" })).toBeNull();
			expect(screen.queryByText("默认选项", { selector: "dt" })).toBeNull();
			for (const option of agent.configuration.modelOptions) {
				expect(
					screen.queryByText(option.displayName, { exact: false }),
				).toBeNull();
				for (const level of option.reasoningLevels)
					expect(screen.queryByText(level, { exact: false })).toBeNull();
			}
			expect(screen.getByText("Owner", { selector: "dt" })).toBeTruthy();
			expect(
				screen.getByRole("link", { name: "返回 Agent 列表" }),
			).toBeTruthy();
		},
	);

	it("keeps model information for a platform-adapter projection without a self-managed access entry", async () => {
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
		expect(screen.getByText("自定义 Agent · 平台交互入口")).toBeTruthy();
		expect(screen.getByText("由平台校验")).toBeTruthy();
		expect(screen.getByText("模型范围", { selector: "dt" })).toBeTruthy();
		expect(screen.getByText("默认选项", { selector: "dt" })).toBeTruthy();
		expect(screen.getByText(/Primary model.*medium、high/)).toBeTruthy();
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
		expect(screen.getByText("由平台校验")).toBeTruthy();
		expect(
			screen.getByText("平台身份入口需经过 Auth Gateway；当前未提供直接入口。"),
		).toBeTruthy();
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
