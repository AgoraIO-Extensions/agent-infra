import { AgentDetailProjectionV1Schema } from "@agent-infra/contracts/pilot";
import {
	pilotAgentDetailFromV2,
	pilotFakeScenariosV2,
} from "@agent-infra/test-support/pilot";
import {
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentDetailScreen } from "./agent-detail-screen.js";
import { renderWithAgentRouter } from "./test-router.js";

const startingAgent = AgentDetailProjectionV1Schema.parse(
	pilotAgentDetailFromV2(pilotFakeScenariosV2.starting.response.body),
);
const readyAgent = AgentDetailProjectionV1Schema.parse({
	...startingAgent,
	serviceAvailability: "ready",
});
const connectionUrl = "https://connection.example.test/mcp";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("AgentDetailScreen", () => {
	it("links to a new conversation and directly to history for a ready platform Agent", async () => {
		const agent = AgentDetailProjectionV1Schema.parse({
			...startingAgent,
			serviceAvailability: "ready",
			agentId: "agent:tenant/01?draft#one%",
		});
		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent }} />,
		);
		const chat = screen.getByRole("link", { name: "开始对话" });
		// F-07：历史按钮「查看对话历史」，不与区块标题「个人历史」同名。
		const history = screen.getByRole("link", { name: "查看对话历史" });
		expect(screen.queryByRole("link", { name: "个人历史" })).toBeNull();
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
		expect(screen.getByRole("link", { name: "查看对话历史" })).toBeTruthy();
		// D-04：不可发送的原因写在「运行与渠道」服务状态行的说明里。
		expect(
			within(screen.getByRole("region", { name: "运行与渠道" })).getByText(
				"历史只读，暂时不能发送消息",
			),
		).toBeTruthy();
	});

	it("renders a projected Agent as a responsive read-only detail", async () => {
		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent: startingAgent }} />,
		);

		expect(
			screen.getByRole("heading", { name: "Release assistant" }),
		).toBeTruthy();
		expect(screen.getByText("Helps the release team")).toBeTruthy();
		// D-03：状态行只有一个派生状态 chip（可用 + 启动中 →「启动中」）与非状态 tag。
		const statusLine = document.querySelector(".status-line") as HTMLElement;
		expect(
			Array.from(
				statusLine.querySelectorAll('[data-slot="badge"][data-variant="chip"]'),
			).map((chip) => chip.textContent),
		).toEqual(["启动中"]);
		expect(
			Array.from(
				statusLine.querySelectorAll('[data-slot="badge"][data-variant="tag"]'),
			).map((tag) => tag.textContent),
		).toEqual(["每个用户都有独立会话", "支持 Connection"]);
		expect(statusLine.querySelector('[class*="bg-secondary"]')).toBeNull();
		expect(screen.getByText("Owner", { selector: "dt" })).toBeTruthy();
		// 设计 #agent-detail：「模板 / 入口」一行写来源、模板显示名与入口方式；入口方式不再单独占行。
		const source = screen.getByText("模板 / 入口", { selector: "dt" });
		expect(source.nextElementSibling?.textContent).toBe(
			"标准模板 · 平台交互入口",
		);
		expect(screen.queryByText("模板与入口", { selector: "dt" })).toBeNull();
		expect(screen.queryByText("入口状态", { selector: "dt" })).toBeNull();
		// F-07：标准模板始终由平台校验身份，设计 dl 不列「入口身份责任」。
		expect(screen.queryByText("入口身份责任", { selector: "dt" })).toBeNull();
		expect(screen.queryByText("由平台校验")).toBeNull();
		expect(screen.queryByText(/平台交互入口由平台/)).toBeNull();
		expect(
			screen.getByRole("region", { name: "运行与渠道" }).textContent,
		).toContain("Web平台对话入口可用企微机器人未配置");
		expect(screen.getByText("模型范围", { selector: "dt" })).toBeTruthy();
		// F-07：「默认推理档位」只显示档位中文名，不外露模型名或原始枚举。
		expect(screen.queryByText("默认选项", { selector: "dt" })).toBeNull();
		const level = screen.getByText("默认推理档位", { selector: "dt" });
		expect(level.nextElementSibling?.textContent).toBe("均衡");
		expect(screen.getByText(/Primary model.*均衡、高/)).toBeTruthy();
		expect(screen.queryByText(/medium|high/)).toBeNull();
		expect(
			screen.getByText(
				"此 Agent 支持独立 Connection 直连，使用前需由当前主体完成授权。",
			),
		).toBeTruthy();
		// D-02：ghost sm「返回 Agent 目录」在页头文案块内、Agent 标识行之前。
		const back = screen.getByRole("link", { name: "返回 Agent 目录" });
		expect(back.getAttribute("href")).toBe("/agents");
		expect(back.className).toContain("text-muted-foreground");
		expect(back.className).toContain("text-[12px]");
		expect(back.parentElement?.className).toBe("agent-detail-copy");
		expect(back.nextElementSibling?.className).toBe("agent-detail-heading");
		expect(screen.queryByRole("link", { name: "返回 Agent 列表" })).toBeNull();
		expect(screen.queryByText("MODEL_API_KEY")).toBeNull();
		expect(screen.queryByText("WORKSPACE_NAME")).toBeNull();
		expect(screen.queryByText("批准申请")).toBeNull();
		expect(screen.queryByText("配置与管理")).toBeNull();
		expect(screen.queryByText("Owner 配置")).toBeNull();
		expect(screen.queryByRole("link", { name: "可用 Skill" })).toBeNull();
	});

	it("links the Owner to the Agent Skill page with a ghost「可用 Skill」(D-03)", async () => {
		await renderWithAgentRouter(
			<AgentDetailScreen
				ownerSettings={{ agentId: startingAgent.agentId }}
				skillBindings={{ agentId: startingAgent.agentId }}
				state={{ kind: "ready", agent: startingAgent }}
			/>,
		);
		const actions = document.querySelector(
			".agent-detail-actions",
		) as HTMLElement;
		// 设计页头顺序：primary 开始对话 / outline Owner 配置 / ghost 可用 Skill。
		expect(
			within(actions)
				.getAllByRole("link")
				.map((link) => link.textContent),
		).toEqual(["Owner 配置", "可用 Skill"]);
		const skills = within(actions).getByRole("link", { name: "可用 Skill" });
		expect(skills.getAttribute("href")).toBe(
			`/agents/${startingAgent.agentId}/skills`,
		);
		expect(skills.className).toContain("text-muted-foreground");
		expect(skills.querySelector("svg")).toBeNull();
	});

	it("omits「可用 Skill」for a self-managed Agent even for its Owner", async () => {
		const agent = AgentDetailProjectionV1Schema.parse({
			...startingAgent,
			source: {
				kind: "custom",
				imageReference: "registry.example/agents/pilot@sha256:abc",
				interactionMode: "self-managed",
				identityResponsibility: "self-managed",
			},
		});
		await renderWithAgentRouter(
			<AgentDetailScreen
				ownerSettings={{ agentId: agent.agentId }}
				skillBindings={{ agentId: agent.agentId }}
				state={{ kind: "ready", agent }}
			/>,
		);
		expect(screen.getByRole("link", { name: "Owner 配置" })).toBeTruthy();
		expect(screen.queryByRole("link", { name: "可用 Skill" })).toBeNull();
	});

	it("renders an Owner settings entry only when the route supplies one", async () => {
		await renderWithAgentRouter(
			<AgentDetailScreen
				ownerSettings={{ agentId: startingAgent.agentId }}
				state={{ kind: "ready", agent: startingAgent }}
			/>,
		);

		const settings = screen.getByRole("link", { name: "Owner 配置" });
		expect(settings.getAttribute("href")).toBe(
			`/agents/${startingAgent.agentId}/configuration`,
		);
		expect(settings.className).toContain("border-border");
		expect(screen.queryByRole("link", { name: "配置与管理" })).toBeNull();
	});

	it("renders a server-projected self-managed access entry", async () => {
		const agent = AgentDetailProjectionV1Schema.parse({
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
		// 自有交互入口：「模板 / 入口」写现有入口文案，「入口状态」承载就绪状态，保留。
		expect(
			screen.getByText("模板 / 入口", { selector: "dt" }).nextElementSibling
				?.textContent,
		).toBe("自定义 Agent · 自有交互入口");
		expect(
			screen.getByText("入口状态", { selector: "dt" }).nextElementSibling
				?.textContent,
		).toBe("自有交互入口已就绪。");
		expect(screen.queryByRole("link", { name: "查看对话历史" })).toBeNull();
		expect(screen.queryByRole("link", { name: "开始对话" })).toBeNull();
		expect(screen.queryByRole("button", { name: "开始对话" })).toBeNull();
		// 自有交互入口不在平台建会话，状态行没有「每个用户都有独立会话」。
		expect(screen.queryByText("每个用户都有独立会话")).toBeNull();
	});

	it.each([
		"javascript:alert(1)",
		"https://user:password@agent.example.test",
		"https://agent.example.test?access_token=secret",
		"https://agent.example.test/#token=secret",
	])("omits unsafe self-managed access entry %s", async (interactionUrl) => {
		const selfManagedAgent = AgentDetailProjectionV1Schema.parse({
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
			const agent = AgentDetailProjectionV1Schema.parse({
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
			expect(screen.queryByText("默认推理档位", { selector: "dt" })).toBeNull();
			for (const option of agent.configuration.modelOptions) {
				expect(
					screen.queryByText(option.displayName, { exact: false }),
				).toBeNull();
				for (const level of option.reasoningLevels)
					expect(screen.queryByText(level, { exact: false })).toBeNull();
			}
			expect(screen.getByText("Owner", { selector: "dt" })).toBeTruthy();
			expect(
				screen.getByRole("link", { name: "返回 Agent 目录" }),
			).toBeTruthy();
		},
	);

	it("keeps model information for a platform-adapter projection without a self-managed access entry", async () => {
		const agent = AgentDetailProjectionV1Schema.parse({
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
		// 平台交互入口的旧「入口状态」只重复入口方式，不再单独占行。
		expect(screen.queryByText("入口状态", { selector: "dt" })).toBeNull();
		// F-07：平台交互入口与标准模板一样由平台校验身份，不列「入口身份责任」（身份责任只是自有交互入口的选择）。
		expect(screen.queryByText("入口身份责任", { selector: "dt" })).toBeNull();
		expect(screen.queryByText("由平台校验")).toBeNull();
		expect(screen.getByText("模型范围", { selector: "dt" })).toBeTruthy();
		expect(screen.getByText("默认推理档位", { selector: "dt" })).toBeTruthy();
		expect(screen.getByText(/Primary model.*均衡、高/)).toBeTruthy();
	});

	it("renders a verified platform-auth access entry when Platform owns self-managed identity", async () => {
		const agent = AgentDetailProjectionV1Schema.parse({
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

		expect(
			screen.getByRole("link", { name: "打开 Agent" }).getAttribute("href"),
		).toBe("https://agent.example.test/");
		expect(screen.getByText("由平台校验")).toBeTruthy();
		expect(screen.getByText("平台身份入口已就绪。")).toBeTruthy();
	});

	it("keeps the identity rows for a platform-auth entry that is not ready without naming components", async () => {
		const agent = AgentDetailProjectionV1Schema.parse({
			...startingAgent,
			interactionUrl: null,
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
		expect(
			screen.getByText("入口身份责任", { selector: "dt" }).nextElementSibling
				?.textContent,
		).toBe("由平台校验");
		// PRD §6.4：技术组件名不进入产品界面。
		expect(
			screen.getByText("入口状态", { selector: "dt" }).nextElementSibling
				?.textContent,
		).toBe("平台身份入口尚未就绪。");
		expect(document.body.textContent).not.toContain("Auth Gateway");
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

		// P-01：403 与 404 合并为同一张「无法访问」状态卡，提供返回 Agent 目录。
		const card = screen.getByRole("article", { name: "无法访问" });
		expect(card.getAttribute("data-slot")).toBe("state-card");
		expect(card.textContent).toContain("Agent 不存在，或你没有访问权限。");
		expect(
			screen
				.getByRole("link", { name: "返回 Agent 目录" })
				.getAttribute("href"),
		).toBe("/agents");
		expect(screen.queryByText("此 Agent 暂时无法访问。")).toBeNull();
		expect(screen.queryByText("Release assistant")).toBeNull();
		expect(screen.queryByText(/forbidden|missing/i)).toBeNull();
	});

	it("shows the needs-auth Connection notice and switches to handoff only after opening it", async () => {
		await renderWithAgentRouter(
			<AgentDetailScreen
				connectionUrl={connectionUrl}
				state={{ kind: "ready", agent: readyAgent }}
			/>,
		);
		const section = screen.getByRole("region", { name: "连接器" });
		const notice = section.querySelector(".connection-notice") as HTMLElement;
		expect(notice.dataset.state).toBe("needs-auth");
		expect(within(notice).getByText("需要 Connection 授权")).toBeTruthy();
		// 与对话「会话上下文」同一句 needs-auth 正文（共享常量），不断言当前主体的授权状态。
		expect(
			within(notice).getByText(
				"使用前需在独立 Connection 完成当前账号的授权；具体 Action allowlist 由 Connection Grant 决定，Platform 不保存或编辑这份授权。",
			),
		).toBeTruthy();
		expect(screen.queryByText(/能力说明不代表当前主体已经获得授权/)).toBeNull();
		for (const text of [
			"Action 范围",
			"在 Connection 中确认",
			"按当前主体 / Consumer / Actor 生效",
		])
			expect(within(notice).getByText(text)).toBeTruthy();
		const open = within(notice).getByRole("link", { name: "打开 Connection" });
		expect(open.getAttribute("href")).toBe(connectionUrl);
		expect(open.getAttribute("target")).toBe("_blank");
		expect(open.getAttribute("rel")).toBe("noopener noreferrer");
		expect(screen.queryByText("等待 Connection 授权返回")).toBeNull();
		fireEvent.click(open);
		expect(notice.dataset.state).toBe("handoff");
		expect(within(notice).getByText("等待 Connection 授权返回")).toBeTruthy();
		expect(
			within(notice)
				.getByRole("link", { name: "返回查看授权状态" })
				.getAttribute("href"),
		).toBe(connectionUrl);
		expect(
			within(notice).queryByRole("link", { name: "打开 Connection" }),
		).toBeNull();
	});

	it("shows an unavailable Connection notice without any link when there is no controlled entry", async () => {
		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent: readyAgent }} />,
		);
		const section = screen.getByRole("region", { name: "连接器" });
		const notice = section.querySelector(".connection-notice") as HTMLElement;
		// NI-08：没有入口不等于已跳转，不显示 handoff。
		expect(notice.dataset.state).toBe("unavailable");
		expect(within(notice).getByText("Connection 暂不可用")).toBeTruthy();
		expect(within(section).queryAllByRole("link")).toHaveLength(0);
		expect(screen.queryByText("等待 Connection 授权返回")).toBeNull();
		expect(screen.queryByText("返回查看授权状态")).toBeNull();
	});

	it("omits the Connection notice and tag for an Agent without the capability", async () => {
		const agent = AgentDetailProjectionV1Schema.parse({
			...readyAgent,
			capabilities: { ...readyAgent.capabilities, connection: false },
		});
		await renderWithAgentRouter(
			<AgentDetailScreen
				connectionUrl={connectionUrl}
				state={{ kind: "ready", agent }}
			/>,
		);
		const section = screen.getByRole("region", { name: "连接器" });
		expect(
			within(section).getByText("当前 Agent 未提供 Connection 能力。"),
		).toBeTruthy();
		expect(section.querySelector(".connection-notice")).toBeNull();
		expect(screen.queryByText("支持 Connection")).toBeNull();
		expect(screen.queryByRole("region", { name: "外部能力" })).toBeNull();
	});

	it.each([
		["ready", "可以发送消息并获得回复", "就绪"],
		["starting", "历史只读，暂时不能发送消息", "启动中"],
		["updating", "历史只读，暂时不能发送消息", "更新中"],
		["unavailable", "历史只读，可稍后重试", "暂时不可用"],
	] as const)(
		"describes the %s service row by user-visible behavior",
		async (serviceAvailability, description, label) => {
			await renderWithAgentRouter(
				<AgentDetailScreen
					state={{
						kind: "ready",
						agent: { ...readyAgent, serviceAvailability },
					}}
				/>,
			);
			const row = within(screen.getByRole("region", { name: "运行与渠道" }))
				.getByText("服务状态")
				.closest("li") as HTMLElement;
			expect(within(row).getByText(description).tagName).toBe("SMALL");
			expect(
				within(row).getByText(label, { selector: '[data-slot="badge"]' }),
			).toBeTruthy();
		},
	);

	it("shows an Owner's organization path from the directory and only the name when it cannot be read", async () => {
		const fetch = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(String(input), "http://localhost");
			if (url.searchParams.get("kind") !== "user")
				return Response.json({ items: [] });
			return Response.json({
				items: [
					{
						kind: "user",
						canonicalId: "user-owner-1",
						displayName: "Owner",
						organizationPath: "研发 / 平台工程",
					},
				],
			});
		});
		vi.stubGlobal("fetch", fetch);
		const view = await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent: readyAgent }} />,
		);
		const owners = screen.getByRole("region", { name: "Owner" });
		await waitFor(() =>
			expect(within(owners).getByText("研发 / 平台工程").tagName).toBe("SMALL"),
		);
		// NI-10：不硬编码「主要 Owner」「共同 Owner」（PRD §2.2）。「有效」只由服务端投影的
		// Owner 状态决定（#2910），状态与 chip 的对应见下一个用例。
		expect(within(owners).queryByText(/主要 Owner|共同 Owner/)).toBeNull();
		view.unmount();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("unavailable", { status: 503 })),
		);
		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent: readyAgent }} />,
		);
		const failed = screen.getByRole("region", { name: "Owner" });
		await waitFor(() =>
			expect(
				within(failed).getByText("Owner", { selector: "strong" }),
			).toBeTruthy(),
		);
		expect(failed.querySelector("small")).toBeNull();
		expect(failed.textContent).not.toMatch(/无法|失败|读取/);
	});

	it("shows each Owner's server-projected status chip and never infers「有效」(#2910)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ schemaVersion: 1, items: [] })),
		);
		const owners = [
			{ userId: "user-active", displayName: "在职 Owner", status: "active" },
			{
				userId: "user-disabled",
				displayName: "停用 Owner",
				status: "disabled",
			},
			{
				userId: "user-departed-0123456789",
				displayName: null,
				status: "departed",
			},
			{
				userId: "user-unknown",
				displayName: "未知 Owner",
				status: "unavailable",
			},
		] as const;
		const agent = AgentDetailProjectionV1Schema.parse({
			...readyAgent,
			configuration: { ...readyAgent.configuration, owners },
		});
		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent }} />,
		);
		const region = screen.getByRole("region", { name: "Owner" });
		const rows = within(region).getAllByRole("listitem");
		expect(
			rows.map((row) => {
				const chip = row.querySelector(
					'[data-slot="badge"][data-variant="chip"]',
				);
				return [
					row.querySelector("strong")?.textContent,
					chip?.textContent,
					chip?.getAttribute("data-tone"),
				];
			}),
		).toEqual([
			["在职 Owner", "有效", "green"],
			["停用 Owner", "已禁用", "amber"],
			// 没有显示名时只显示类型与 ID 短形式，不说明原因。
			["用户 user-dep…", "已离职", "gray"],
			["未知 Owner", "状态未知", "gray"],
		]);
		expect(within(region).getAllByText("有效")).toHaveLength(1);
		expect(
			within(region).queryByText(/active|disabled|departed|unavailable/),
		).toBeNull();
		expect(within(region).getByTitle("user-departed-0123456789").tagName).toBe(
			"CODE",
		);
		// 「关于此 Agent」的 Owner 行同样只用服务端名称，缺失时显示 ID 短形式。
		expect(
			screen.getByText("Owner", { selector: "dt" }).nextElementSibling
				?.textContent,
		).toBe("在职 Owner、停用 Owner、用户 user-dep…、未知 Owner");

		// 状态读不到时只有「状态未知」，不伪造「有效」。
		cleanup();
		await renderWithAgentRouter(
			<AgentDetailScreen
				state={{
					kind: "ready",
					agent: AgentDetailProjectionV1Schema.parse({
						...readyAgent,
						configuration: {
							...readyAgent.configuration,
							owners: [
								{
									userId: "user-owner-1",
									displayName: "Owner",
									status: "unavailable",
								},
							],
						},
					}),
				}}
			/>,
		);
		const unknown = screen.getByRole("region", { name: "Owner" });
		expect(within(unknown).queryByText("有效")).toBeNull();
		expect(within(unknown).getByText("状态未知")).toBeTruthy();
	});

	it.each([
		[
			{ retryable: true },
			"服务暂不可用",
			"暂时无法读取 Agent，请稍后重试。",
			"重新加载 Agent",
		],
		[
			{ retryable: false, reason: "authentication-required" as const },
			"登录",
			"当前会话已过期，需要重新登录后再进入工作区。",
			"重新登录",
		],
		[
			{ retryable: false, reason: "invalid-response" as const },
			"数据无法读取",
			"服务返回的数据无法识别，请联系管理员。",
			null,
		],
	])(
		"chooses the state card for %o",
		async (failure, title, description, action) => {
			const onRetry = vi.fn();
			await renderWithAgentRouter(
				<AgentDetailScreen
					state={{ kind: "unavailable", ...failure }}
					onRetry={onRetry}
				/>,
			);
			const card = screen.getByRole("alert");
			expect(
				screen.getByRole("heading", { level: 2, name: title }),
			).toBeTruthy();
			expect(card.textContent).toContain(description);
			const buttons = card.querySelectorAll("button, a");
			expect([...buttons].map((button) => button.textContent)).toEqual(
				action ? [action] : [],
			);
			if (action === "重新加载 Agent") {
				fireEvent.click(screen.getByRole("button", { name: action }));
				expect(onRetry).toHaveBeenCalledOnce();
			}
		},
	);

	it("renders an explicit loading state", async () => {
		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "loading" }} />,
		);

		expect(
			screen.getByText("正在加载 Agent 详情…").getAttribute("aria-live"),
		).toBe("polite");
	});
});
