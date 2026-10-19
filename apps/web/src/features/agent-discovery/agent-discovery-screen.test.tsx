import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { templateNameLookup } from "../template-display-name.js";
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

	it("treats a supplied query without a callback as an editable initial value", async () => {
		await renderWithAgentRouter(
			<AgentDiscoveryScreen
				query="Release"
				state={{ kind: "ready", agents: [startingAgent] }}
			/>,
		);
		const input = screen.getByRole("searchbox", {
			name: "搜索 Agent",
		}) as HTMLInputElement;
		expect(input.value).toBe("Release");
		fireEvent.change(input, { target: { value: "other" } });
		expect(input.value).toBe("other");
		expect(screen.getByText("没有匹配的 Agent")).toBeTruthy();
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
		// A-01：计数是筛选后的结果数，写在 role=status 里的 gray chip 中。
		expect(screen.getByRole("status").textContent).toBe("2 个结果");
		expect(
			within(screen.getByRole("status")).getByText("2 个结果").dataset.tone,
		).toBe("gray");
		fireEvent.change(screen.getByRole("searchbox", { name: "搜索 Agent" }), {
			target: { value: "  RELEASE  " },
		});
		expect(
			screen.getByRole("link", { name: "查看 Release assistant 详情" }),
		).toBeTruthy();
		expect(
			screen.queryByRole("link", { name: "查看 文档检查 详情" }),
		).toBeNull();
		expect(screen.getByRole("status").textContent).toBe("1 个结果");
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
		expect(screen.getByText("没有匹配的 Agent")).toBeTruthy();
		expect(
			screen.queryAllByRole("link", { name: /^查看 .+ 详情$/ }),
		).toHaveLength(0);
	});

	it("finds displayed template and channel labels independently of name and purpose", async () => {
		const channelAgent = AgentProjectionV2Schema.parse({
			...startingAgent,
			agentId: "channel-agent",
			name: "团队助理",
			description: "检查发布说明",
			source: { kind: "standard", templateId: "opencode" },
			configuration: {
				...startingAgent.configuration,
				channels: [{ kind: "wecom_bot", status: "bound" }],
			},
		});
		await renderWithAgentRouter(
			<AgentDiscoveryScreen
				state={{ kind: "ready", agents: [startingAgent, channelAgent] }}
				templateName={templateNameLookup([
					{ templateId: "codex", displayName: "Codex" },
					{ templateId: "opencode", displayName: "OpenCode" },
				])}
			/>,
		);
		const search = screen.getByRole("searchbox", { name: "搜索 Agent" });
		expect(search.getAttribute("placeholder")).toBe("搜索名称、模板或渠道");
		// F-02：卡片 tag 与模板筛选显示部署配置的模板显示名，不显示原始 templateId。
		expect(
			screen
				.getAllByRole("option")
				.map((option) => option.textContent)
				.filter((text) =>
					["Codex", "OpenCode", "codex", "opencode"].includes(text ?? ""),
				),
		).toEqual(["Codex", "OpenCode"]);
		for (const [query, name, label] of [
			["  CODEX  ", "Release assistant", "标准模板 · Codex"],
			["  wEB  ", "Release assistant", "Web"],
			["企微机器人", "团队助理", "企微机器人"],
		]) {
			fireEvent.change(search, { target: { value: query } });
			expect(
				screen.getByRole("link", { name: `查看 ${name} 详情` }),
			).toBeTruthy();
			expect(
				screen.getByText(label, { selector: '[data-slot="badge"]' }),
			).toBeTruthy();
			expect(screen.getByRole("status").textContent).toBe("1 个结果");
		}
		fireEvent.change(search, { target: { value: "" } });
		expect(
			screen.queryAllByRole("link", { name: /^查看 .+ 详情$/ }),
		).toHaveLength(2);
	});

	it("falls back to 标准模板 without exposing the templateId when names are unavailable (F-02)", async () => {
		await renderWithAgentRouter(
			<AgentDiscoveryScreen
				state={{ kind: "ready", agents: [startingAgent] }}
			/>,
		);
		expect(
			screen.getByText("标准模板", { selector: '[data-slot="badge"]' }),
		).toBeTruthy();
		const list = screen.getByRole("list", { name: "可用范围" });
		expect(list.textContent?.toLocaleLowerCase()).not.toContain("codex");
		expect(screen.queryByRole("option", { name: "codex" })).toBeNull();
	});

	it.each(["not_configured", "binding", "failed"] as const)(
		"does not match a hidden channel in status %s or hidden configuration fields",
		async (status) => {
			const agent = AgentProjectionV2Schema.parse({
				...startingAgent,
				source: {
					kind: "custom",
					imageReference: "registry.example/private-image-marker:v1",
					interactionMode: "platform-adapter",
				},
				configuration: {
					...startingAgent.configuration,
					channels: [{ kind: "wecom_app", status }],
				},
			});
			await renderWithAgentRouter(
				<AgentDiscoveryScreen state={{ kind: "ready", agents: [agent] }} />,
			);
			const search = screen.getByRole("searchbox", { name: "搜索 Agent" });
			for (const query of [
				"企微应用",
				"private-image-marker",
				"user-owner-1",
				"MODEL_API_KEY",
				"gpt-5",
			]) {
				fireEvent.change(search, { target: { value: query } });
				expect(screen.getByText("没有匹配的 Agent")).toBeTruthy();
				expect(
					screen.queryAllByRole("link", { name: /^查看 .+ 详情$/ }),
				).toHaveLength(0);
			}
			fireEvent.change(search, { target: { value: "暂无可用渠道" } });
			expect(
				screen.getByRole("link", { name: /Release assistant/ }),
			).toBeTruthy();
		},
	);

	it("finds the displayed self-managed fallback without granting conversation eligibility", async () => {
		const agent = AgentProjectionV2Schema.parse({
			...startingAgent,
			serviceAvailability: "ready",
			source: {
				kind: "custom",
				imageReference: "registry.example/self-managed:v1",
				interactionMode: "self-managed",
				identityResponsibility: "self-managed",
			},
			configuration: { ...startingAgent.configuration, channels: [] },
		});
		await renderWithAgentRouter(
			<AgentDiscoveryScreen
				conversationSelection
				query="自有交互入口"
				state={{ kind: "ready", agents: [agent] }}
			/>,
		);
		expect(screen.getByText("自有交互入口")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: /Release assistant/ }),
		).toBeTruthy();
		expect(screen.queryByRole("link", { name: "开始对话" })).toBeNull();
	});

	it("filters only the authorized projection by status, template and model and clears filters", async () => {
		const ready = AgentProjectionV2Schema.parse({
			...startingAgent,
			agentId: "ready-agent",
			name: "可用编程助手",
			serviceAvailability: "ready",
		});
		await renderWithAgentRouter(
			<AgentDiscoveryScreen
				state={{ kind: "ready", agents: [startingAgent, ready] }}
			/>,
		);
		fireEvent.change(screen.getByRole("combobox", { name: "状态" }), {
			target: { value: "ready" },
		});
		expect(
			screen.getByRole("link", { name: "查看 可用编程助手 详情" }),
		).toBeTruthy();
		expect(
			screen.queryByRole("link", { name: "查看 Release assistant 详情" }),
		).toBeNull();
		fireEvent.change(screen.getByRole("searchbox", { name: "搜索 Agent" }), {
			target: { value: "不存在" },
		});
		fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
		expect(
			screen.getAllByRole("link", { name: /^查看 .+ 详情$/ }),
		).toHaveLength(2);
		expect(
			screen.getByRole("link", { name: "创建申请" }).getAttribute("href"),
		).toBe("/my-agents/new");
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
		expect(screen.getByRole("status").textContent).toBe("0 个结果");
	});

	it("renders a visible Agent as a responsive detail link", async () => {
		await renderWithAgentRouter(
			<AgentDiscoveryScreen
				state={{ kind: "ready", agents: [startingAgent] }}
			/>,
		);

		const link = screen.getByRole("link", { name: /Release assistant/ });
		expect(link.getAttribute("href")).toBe("/agents/agent-pilot-1");
		expect(
			screen.getByText("启动中", { selector: '[data-slot="badge"]' }),
		).toBeTruthy();
		expect(link.className).toContain("min-w-0");
	});

	it("keeps a ready self-managed Agent out of the platform conversation chooser", async () => {
		const agent = AgentProjectionV2Schema.parse({
			...startingAgent,
			managementStatus: "available",
			serviceAvailability: "ready",
			source: {
				kind: "custom",
				imageReference: "registry.example/agents/pilot@sha256:abc",
				interactionMode: "self-managed",
				identityResponsibility: "self-managed",
			},
		});
		await renderWithAgentRouter(
			<AgentDiscoveryScreen
				conversationSelection
				state={{ kind: "ready", agents: [agent] }}
			/>,
		);
		expect(screen.queryByRole("link", { name: "开始对话" })).toBeNull();
		expect(
			screen.getByRole("link", { name: /查看 Release assistant 详情/ }),
		).toBeTruthy();
	});

	it.each([
		["available", "ready", true],
		["available", "starting", false],
		["available", "updating", false],
		["available", "unavailable", false],
		["creating", null, false],
		["stopped", null, false],
		["disabled", null, false],
		["creation_failed", null, false],
	] as const)(
		"chooses the existing conversation or detail route for %s/%s",
		async (managementStatus, serviceAvailability, canOpenConversation) => {
			const agent = AgentProjectionV2Schema.parse({
				...startingAgent,
				managementStatus,
				serviceAvailability,
			});
			await renderWithAgentRouter(
				<AgentDiscoveryScreen
					conversationSelection
					state={{ kind: "ready", agents: [agent] }}
				/>,
			);
			const action = screen.getByRole("link", {
				name: canOpenConversation ? "开始对话" : /查看 Release assistant 详情/,
			});
			expect(action.getAttribute("href")).toBe(
				canOpenConversation
					? `/chat/${agent.agentId}`
					: `/agents/${agent.agentId}`,
			);
			if (!canOpenConversation)
				expect(screen.queryByRole("link", { name: "开始对话" })).toBeNull();
		},
	);

	it.each([
		["available", "ready", "就绪", "green"],
		["available", "starting", "启动中", "amber"],
		["available", "updating", "更新中", "amber"],
		["available", "unavailable", "暂时不可用", "gray"],
		["stopped", null, "已停止", "gray"],
	] as const)(
		"shows one derived availability chip for %s/%s",
		async (managementStatus, serviceAvailability, label, tone) => {
			const agent = AgentProjectionV2Schema.parse({
				...startingAgent,
				managementStatus,
				serviceAvailability,
			});
			await renderWithAgentRouter(
				<AgentDiscoveryScreen state={{ kind: "ready", agents: [agent] }} />,
			);
			// A-02：卡片只有一个状态 chip，没有 secondary 徽章。
			const card = screen.getByRole("listitem");
			const chips = card.querySelectorAll(
				'[data-slot="badge"][data-variant="chip"]',
			);
			expect(Array.from(chips).map((chip) => chip.textContent)).toEqual([
				label,
			]);
			expect((chips[0] as HTMLElement).dataset.tone).toBe(tone);
			expect(card.querySelector('[class*="bg-secondary"]')).toBeNull();
		},
	);

	it("shows Owner and model range in the card foot", async () => {
		const selfManaged = AgentProjectionV2Schema.parse({
			...startingAgent,
			agentId: "self-managed",
			name: "自有入口助手",
			source: {
				kind: "custom",
				imageReference: "registry.example/agents/pilot@sha256:abc",
				interactionMode: "self-managed",
				identityResponsibility: "self-managed",
			},
		});
		const noModels = AgentProjectionV2Schema.parse({
			...startingAgent,
			agentId: "no-models",
			name: "无模型助手",
			configuration: {
				...startingAgent.configuration,
				modelOptions: [],
				defaultModelOptionId: null,
				defaultReasoningLevel: null,
			},
		});
		await renderWithAgentRouter(
			<AgentDiscoveryScreen
				state={{
					kind: "ready",
					agents: [startingAgent, selfManaged, noModels],
				}}
			/>,
		);
		const foot = (name: string) =>
			Array.from(
				screen
					.getByRole("heading", { level: 3, name })
					.closest("li")
					?.querySelectorAll(".directory-card-foot-main small") ?? [],
			).map((line) => line.textContent);
		expect(foot("Release assistant")).toEqual([
			`Owner · ${startingAgent.configuration.owners.map((owner) => owner.displayName).join("、")}`,
			startingAgent.configuration.modelOptions
				.map((option) => option.displayName)
				.join(" · "),
		]);
		expect(foot("自有入口助手")[1]).toBe("由 Agent 自行管理");
		expect(foot("无模型助手")[1]).toBe("无可选择模型");
		expect(
			screen
				.getByRole("link", { name: "查看 Release assistant 详情" })
				.closest(".directory-card-foot-side"),
		).toBeTruthy();
	});

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

		const empty = document.querySelector('[data-slot="empty"]');
		const title = screen.getByText("暂无你有权访问的 Agent");
		expect(title.tagName).toBe("STRONG");
		expect(
			screen.getByText("目录只展示当前账号有权访问的 Agent。"),
		).toBeTruthy();
		expect(empty?.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
		expect(screen.queryByRole("button", { name: "清除筛选" })).toBeNull();
	});

	it("shows a search empty state with an icon, a non-heading title and clear filters", async () => {
		await renderWithAgentRouter(
			<AgentDiscoveryScreen
				query="不存在"
				state={{ kind: "ready", agents: [startingAgent] }}
			/>,
		);
		const empty = document.querySelector('[data-slot="empty"]') as HTMLElement;
		expect(within(empty).getByText("没有匹配的 Agent").tagName).toBe("STRONG");
		expect(
			within(empty).getByText("换一个名称、模板或渠道关键词再试。"),
		).toBeTruthy();
		expect(empty.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
		expect(
			screen
				.getAllByRole("heading", { level: 2 })
				.map((node) => node.textContent),
		).toEqual(["可用范围"]);
		fireEvent.click(within(empty).getByRole("button", { name: "清除筛选" }));
		expect(
			screen.getByRole("link", { name: "查看 Release assistant 详情" }),
		).toBeTruthy();
	});

	it.each([
		{
			state: {
				kind: "unavailable",
				retryable: false,
				reason: "authentication-required",
			},
			title: "登录已过期",
			button: "重新登录",
			alert: true,
		},
		{
			state: { kind: "unavailable", retryable: false, reason: "denied" },
			title: "未授权",
			link: ["返回工作台", "/"],
			alert: false,
		},
		{
			state: { kind: "unavailable", retryable: false, reason: "not-found" },
			title: "目录入口不可用",
			alert: true,
		},
		{
			state: {
				kind: "unavailable",
				retryable: false,
				reason: "invalid-response",
			},
			title: "目录数据无法读取",
			alert: true,
		},
		{
			state: { kind: "unavailable", retryable: true },
			title: "服务暂不可用",
			button: "重新加载 Agent",
			alert: true,
		},
	] as const)(
		"renders the $title state card without stale Agent data",
		async (expected) => {
			const onRetry = vi.fn();
			const onRelogin = vi.fn();
			await renderWithAgentRouter(
				<AgentDiscoveryScreen
					state={expected.state}
					onRetry={onRetry}
					onRelogin={onRelogin}
				/>,
			);
			const card = screen
				.getByRole("heading", { level: 2, name: expected.title })
				.closest('[data-slot="state-card"]') as HTMLElement;
			expect(card).toBeTruthy();
			expect(card.getAttribute("role")).toBe(expected.alert ? "alert" : null);
			expect(
				screen.queryByText("Agent 列表暂时无法访问，请联系管理员。"),
			).toBeNull();
			expect(screen.queryByText("Release assistant")).toBeNull();
			expect(screen.queryByText(/forbidden|missing/i)).toBeNull();
			const buttons = within(card).queryAllByRole("button");
			expect(buttons.map((button) => button.textContent)).toEqual(
				"button" in expected ? [expected.button] : [],
			);
			if ("link" in expected && expected.link)
				expect(
					within(card)
						.getByRole("link", { name: expected.link[0] })
						.getAttribute("href"),
				).toBe(expected.link[1]);
			if ("button" in expected) {
				fireEvent.click(buttons[0] as HTMLElement);
				expect(
					expected.button === "重新登录" ? onRelogin : onRetry,
				).toHaveBeenCalledOnce();
			}
		},
	);

	it("renders an explicit loading state", async () => {
		await renderWithAgentRouter(
			<AgentDiscoveryScreen state={{ kind: "loading" }} />,
		);

		expect(screen.getByText("正在加载 Agent…").getAttribute("aria-live")).toBe(
			"polite",
		);
		// A-03：加载用 15px spinner + 文案，放在 role=status 内。
		expect(
			screen
				.getByRole("status")
				.querySelector('[data-slot="spinner"][aria-hidden="true"]'),
		).toBeTruthy();
	});
});
