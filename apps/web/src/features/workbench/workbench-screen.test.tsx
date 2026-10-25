import {
	AgentProjectionV2Schema,
	ConversationProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { createContext, type ReactNode, useContext } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClockProvider } from "@/lib/clock";
import { createClient } from "../../pilot/generated-v2/client/index.js";
import { agentAvailabilityStatus } from "../agent-management-status.js";
import { pendingApplication } from "../my-agents/test-fixtures.js";
import { useWorkbenchCollections } from "./use-workbench-collections.js";
import {
	WorkbenchScreen,
	type WorkbenchScreenProps,
} from "./workbench-screen.js";

afterEach(cleanup);
const Content = createContext<ReactNode>(null);

async function showWorkbench(content: ReactNode) {
	const root = createRootRoute();
	const home = createRoute({
		getParentRoute: () => root,
		path: "/",
		component: () => useContext(Content),
	});
	const targets = [
		"/agents",
		"/agents/$agentId",
		"/agents/$agentId/configuration",
		"/chat/$agentId/{-$conversationId}",
		"/my-agents",
		"/my-agents/new",
		"/my-agents/$applicationId",
		"/my-agents/$applicationId/edit",
		"/admin/approvals",
		"/admin/agents",
	].map((path) =>
		createRoute({ getParentRoute: () => root, path, component: () => null }),
	);
	const router = createRouter({
		history: createMemoryHistory({ initialEntries: ["/"] }),
		routeTree: root.addChildren([home, ...targets]),
	});
	await router.load();
	const tree = (value: ReactNode) => (
		<Content.Provider value={value}>
			<RouterProvider router={router} />
		</Content.Provider>
	);
	const view = render(tree(content));
	return { ...view, rerender: (next: ReactNode) => view.rerender(tree(next)) };
}

const empty: WorkbenchScreenProps = {
	agents: { kind: "ready", agents: [] },
	ownerAgents: { kind: "ready", agents: [] },
	applications: { kind: "ready", applications: [] },
	pending: { kind: "ready", applications: [] },
	adminAgents: { kind: "ready", agents: [] },
	recent: { kind: "ready", conversations: [], nextCursor: null },
	administrator: true,
	onRetry: vi.fn(),
	onRelogin: vi.fn(),
};
const available = AgentProjectionV2Schema.parse({
	...pilotFakeScenariosV2.starting.response.body,
	agentId: "usable-agent",
	name: "可用编程助手",
	managementStatus: "available",
	serviceAvailability: "ready",
});
const failed = AgentProjectionV2Schema.parse({
	...available,
	agentId: "owned-failed-agent",
	name: "Owner 创建失败助手",
	managementStatus: "creation_failed",
	serviceAvailability: null,
});
const rejected = {
	...pendingApplication,
	applicationId: "rejected-application",
	name: "已驳回的本人申请",
	status: "rejected" as const,
	decision: {
		decidedAt: "2026-09-03T08:01:00Z",
		reason: "请缩小申请的可用范围。",
	},
};
const stopped = {
	...available,
	agentId: "stopped-agent",
	name: "已停止的助手",
	managementStatus: "stopped" as const,
	serviceAvailability: null,
};
const conversation = ConversationProjectionV1Schema.parse({
	schemaVersion: 1,
	conversationId: "conversation-z",
	agentId: "usable-agent",
	title: "较后 ID 的最近对话",
	status: "ready",
	selectedModelOptionId: null,
	selectedReasoningLevel: null,
	lastConversationCursor: null,
	createdAt: "2026-09-30T20:00:00Z",
	updatedAt: "2026-09-30T21:00:00Z",
});

describe("OpenDesign workbench presentation", () => {
	it("derives available Agent chips from the directory availability rule (G4-01)", async () => {
		const starting = {
			...available,
			agentId: "starting-agent",
			name: "启动中的助手",
			serviceAvailability: "starting" as const,
		};
		await showWorkbench(
			<WorkbenchScreen
				{...empty}
				agents={{ kind: "ready", agents: [available, starting, stopped] }}
			/>,
		);
		const region = screen.getByRole("region", { name: "可用 Agent" });
		// 与 /agents 卡、详情和 Owner 配置页头同一条规则（agentAvailabilityStatus）：就绪 green，
		// 不再对可开始对话的 Agent 固定写「可用」。
		for (const [agent, label, tone] of [
			[available, "就绪", "green"],
			[starting, "启动中", "amber"],
			[stopped, "已停止", "gray"],
		] as const) {
			const card = within(region)
				.getByRole("heading", { level: 3, name: agent.name })
				.closest(".workbench-card") as HTMLElement;
			const chip = within(card).getByText(label, {
				selector: '[data-slot="badge"][data-variant="chip"]',
			});
			expect(chip.dataset.tone).toBe(tone);
			expect(chip.dataset.tone).toBe(agentAvailabilityStatus(agent).tone);
		}
		expect(within(region).queryByText("可用", { exact: true })).toBeNull();
	});

	it("keeps conversation availability labels on recent rows (G5-01)", async () => {
		const starting = {
			...available,
			agentId: "starting-agent",
			name: "启动中的助手",
			serviceAvailability: "starting" as const,
		};
		await showWorkbench(
			<WorkbenchScreen
				{...empty}
				agents={{ kind: "ready", agents: [available, starting, stopped] }}
				recent={{
					kind: "ready",
					conversations: [
						conversation,
						{
							...conversation,
							conversationId: "conversation-starting",
							agentId: starting.agentId,
							title: "启动中助手的对话",
						},
						{
							...conversation,
							conversationId: "conversation-stopped",
							agentId: stopped.agentId,
							title: "已停止助手的对话",
						},
					],
					nextCursor: null,
				}}
			/>,
		);
		const recent = screen.getByRole("region", { name: "最近对话" });
		// 最近对话行是会话可用性（设计 renderWorkbench recent、H4-03）：可开始对话写「可用」green，
		// 其余沿用服务状态或管理状态；「可用 Agent」卡仍按 G4-01 写「就绪」。
		for (const [title, label, tone] of [
			["较后 ID 的最近对话", "可用", "green"],
			["启动中助手的对话", "启动中", "amber"],
			["已停止助手的对话", "已停止", "gray"],
		] as const) {
			const row = within(recent)
				.getByRole("heading", { level: 3, name: title })
				.closest(".workbench-recent-row") as HTMLElement;
			const chip = within(row).getByText(label, {
				selector: '[data-slot="badge"][data-variant="chip"]',
			});
			expect(chip.dataset.tone).toBe(tone);
		}
		expect(within(recent).queryByText("就绪", { exact: true })).toBeNull();
		const agents = screen.getByRole("region", { name: "可用 Agent" });
		const card = within(agents)
			.getByRole("heading", { level: 3, name: available.name })
			.closest(".workbench-card") as HTMLElement;
		expect(
			within(card).getByText("就绪", {
				selector: '[data-slot="badge"][data-variant="chip"]',
			}).dataset.tone,
		).toBe("green");
	});

	it("keeps all responsibility regions and safe empty-state navigation", async () => {
		await showWorkbench(<WorkbenchScreen {...empty} />);
		// W-06：页头文案按设计稿 #workbench。
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
			"选择一个 Agent 开始工作。",
		);
		expect(
			screen.getByText("最近对话、可用 Agent 和待处理事项都在这里。"),
		).toBeTruthy();
		// 空态标题是 strong 而不是 heading，分区标题层级不变（NI-82、NI-75）。
		expect(
			screen
				.getAllByRole("heading", { level: 2 })
				.map((heading) => heading.textContent),
		).toEqual(["最近对话", "待处理", "可用 Agent", "我的申请"]);
		// 分区副标题按设计稿 canonical #workbench。
		for (const description of [
			"只显示你的历史记录",
			"按你的权限显示",
			"按账号和组织权限过滤",
			"查看状态和下一步",
		])
			expect(screen.getByText(description, { exact: true })).toBeTruthy();
		const recent = screen.getByRole("region", { name: "最近对话" });
		const emptyState = recent.querySelector('[data-slot="empty"]');
		expect(emptyState).toBeTruthy();
		const emptyTitle = within(recent).getByText("暂无个人对话");
		expect(emptyTitle.tagName).toBe("STRONG");
		expect(
			within(recent).getByText("选择一个 Agent 开始新的个人对话。"),
		).toBeTruthy();
		expect(emptyState?.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
		expect(screen.getByText("暂无需要修改的申请。")).toBeTruthy();
		// W-02：区块头部没有「新对话」；无历史时也不提供「查看全部」。
		expect(screen.queryByRole("link", { name: "新对话" })).toBeNull();
		expect(screen.queryByRole("link", { name: "查看全部" })).toBeNull();
		const create = screen.getByRole("link", { name: "创建申请" });
		expect(create.getAttribute("href")).toBe("/my-agents/new");
		// F-06：outline「创建申请」带 plus 图标。
		expect(create.className).toContain("border-border");
		expect(create.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
	});

	it("routes projected collections to permitted targets without turning admin inventory into Agent actions", async () => {
		const administratorOnly = {
			...failed,
			agentId: "another-owner-agent",
			name: "其他 Owner 的失败助手",
		};
		await showWorkbench(
			<WorkbenchScreen
				{...empty}
				agents={{ kind: "ready", agents: [available] }}
				ownerAgents={{ kind: "ready", agents: [failed] }}
				applications={{ kind: "ready", applications: [rejected] }}
				pending={{ kind: "ready", applications: [pendingApplication] }}
				adminAgents={{ kind: "ready", agents: [administratorOnly] }}
			/>,
		);
		expect(screen.getByText("可用编程助手")).toBeTruthy();
		expect(
			screen
				.getByRole("link", { name: `查看详情：${available.name}` })
				.getAttribute("href"),
		).toBe("/agents/usable-agent");
		expect(
			screen
				.getByRole("link", { name: `查看：${rejected.name}` })
				.getAttribute("href"),
		).toBe("/my-agents/rejected-application");
		expect(
			screen
				.getByRole("link", { name: `处理：${failed.name}` })
				.getAttribute("href"),
		).toBe("/agents/owned-failed-agent/configuration");
		// Y-09：Owner 行标题、说明按导出稿 #workbench；驳回原因与修改入口在申请详情（PRD §6.3）。
		const ownerTasks = screen.getByRole("region", { name: "需要你处理" });
		expect(
			Array.from(ownerTasks.querySelectorAll("h3")).map(
				(heading) => heading.textContent,
			),
		).toEqual(["Owner 待办", "运行状态", "运行状态"]);
		expect(
			within(ownerTasks).getByText("已驳回的本人申请被驳回，可修改后重提"),
		).toBeTruthy();
		expect(
			within(ownerTasks).getByText("Owner 创建失败助手创建失败，可重试"),
		).toBeTruthy();
		expect(screen.queryByText("请缩小申请的可用范围。")).toBeNull();
		expect(screen.queryByRole("link", { name: /^修改并重新提交/ })).toBeNull();
		expect(screen.queryByRole("link", { name: /^配置与管理/ })).toBeNull();
		expect(
			screen.getByRole("link", { name: "查看失败清单" }).getAttribute("href"),
		).toBe("/admin/agents?status=creation_failed");
		expect(screen.getByText("1 项申请等待系统管理员审阅")).toBeTruthy();
		// F-06：待处理「进入」的可访问名称带对象名；可用 Agent 头部为「查看目录」+ 箭头。
		const approvals = screen.getByRole("link", { name: "进入：创建审批" });
		expect(approvals.textContent).toBe("进入");
		expect(approvals.getAttribute("href")).toBe("/admin/approvals");
		expect(screen.queryByRole("link", { name: /进入审批/ })).toBeNull();
		const directory = screen.getByRole("link", { name: "查看目录" });
		expect(directory.getAttribute("href")).toBe("/agents");
		// Y-05：箭头在文字前。
		expect(directory.firstElementChild?.tagName.toLowerCase()).toBe("svg");
		expect(directory.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
		// Y-06：可用 Agent 卡「查看详情」带前置箭头。
		const detail = screen.getByRole("link", {
			name: `查看详情：${available.name}`,
		});
		expect(detail.firstElementChild?.tagName.toLowerCase()).toBe("svg");
		expect(detail.textContent).toBe("查看详情");
		expect(screen.queryByRole("link", { name: "查看全部 Agent" })).toBeNull();
		// W-04：待处理的操作放在行右侧，不夹在说明文字里。
		for (const name of [
			"进入：创建审批",
			`查看：${rejected.name}`,
			`处理：${failed.name}`,
			"查看失败清单",
		]) {
			const link = screen.getByRole("link", { name });
			expect(link.parentElement?.className).toBe("workbench-list-side");
			expect(
				link.closest(".workbench-list-row")?.querySelector("h3"),
			).toBeTruthy();
		}
		expect(
			document.querySelector('a[href*="/agents/another-owner-agent"]'),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: /重试创建|批准|停用|开始对话/ }),
		).toBeNull();
	});

	it("preserves supplied recent order and binds continued and read-only cards to the original Conversation", async () => {
		await showWorkbench(
			<WorkbenchScreen
				{...empty}
				agents={{ kind: "ready", agents: [available, stopped] }}
				recent={{
					kind: "ready",
					conversations: [
						conversation,
						{
							...conversation,
							conversationId: "conversation-a",
							agentId: stopped.agentId,
							title: "停止后的个人历史",
							updatedAt: "2026-09-30T20:30:00Z",
						},
						{
							...conversation,
							conversationId: "conversation-unknown-agent",
							agentId: "unknown-agent",
							title: null,
						},
						{
							...conversation,
							conversationId: "conversation-unavailable",
							status: "unavailable",
							title: "超出工作台条数的会话",
						},
					],
					nextCursor: "opaque-recent/+?=",
				}}
			/>,
		);
		const region = screen.getByRole("region", { name: "最近对话" });
		// R4-04：工作台最多 3 行，且不提供续页。
		expect(
			Array.from(region.querySelectorAll("h3")).map(
				(heading) => heading.textContent,
			),
		).toEqual(["较后 ID 的最近对话", "停止后的个人历史", "未命名对话"]);
		expect(screen.queryByText("超出工作台条数的会话")).toBeNull();
		expect(screen.queryByRole("button", { name: "加载更多对话" })).toBeNull();
		const links = Array.from(region.querySelectorAll('a[href^="/chat/"]')).map(
			(link) => {
				const url = new URL(
					link.getAttribute("href") ?? "",
					"https://platform.example.test",
				);
				return [url.pathname, url.searchParams.get("view")];
			},
		);
		// 「查看全部」进入最近一条会话的对话页，由其「最近对话」面板承载全部个人对话。
		expect(links).toEqual([
			["/chat/usable-agent/conversation-z", null],
			["/chat/usable-agent/conversation-z", null],
			["/chat/stopped-agent/conversation-a", null],
			["/chat/unknown-agent/conversation-unknown-agent", null],
		]);
		const all = within(region).getByRole("link", { name: "查看全部" });
		expect(all.className).toContain("text-muted-foreground");
		expect(all.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
		// Y-05：箭头在文字前。
		expect(all.firstElementChild?.tagName.toLowerCase()).toBe("svg");
		expect(all.getAttribute("href")).not.toBe("/agents?mode=conversation");
		expect(
			region.querySelector('time[datetime="2026-09-30T21:00:00Z"]'),
		).toBeTruthy();
		// W-04：只读说明并入元信息「· 历史只读」，不再单独成段。
		expect(
			screen.queryByText("历史仍可查看，当前不能继续发送消息。"),
		).toBeNull();
		const rows = Array.from(region.querySelectorAll(".workbench-list-row"));
		expect(
			rows.map((row) =>
				row.querySelector("small")?.textContent?.endsWith(" · 历史只读"),
			),
		).toEqual([false, true, false]);
		// F-06：只读行「查看历史」为 ghost，其余为 outline。
		const history = screen.getByRole("link", {
			name: "查看历史：停止后的个人历史",
		});
		expect(history.className).toContain("text-muted-foreground");
		expect(history.className).not.toContain("border-border");
		expect(
			screen.getByRole("link", { name: "继续对话：较后 ID 的最近对话" })
				.className,
		).toContain("border-border");
		expect(
			screen
				.getByRole("link", { name: "打开对话：未命名对话" })
				.getAttribute("href"),
		).toBe("/chat/unknown-agent/conversation-unknown-agent");
	});

	it.each([
		{ kind: "loading" },
		{ kind: "unavailable", retryable: true },
		{ kind: "ready", agents: [] },
	] satisfies WorkbenchScreenProps["agents"][])(
		"keeps unknown Agent availability distinct from confirmed read-only history ($kind)",
		async (agents) => {
			const props: WorkbenchScreenProps = {
				...empty,
				agents,
				recent: {
					kind: "ready",
					conversations: [conversation],
					nextCursor: null,
				},
			};
			const view = await showWorkbench(<WorkbenchScreen {...props} />);
			const region = screen.getByRole("region", { name: "最近对话" });
			const meta = region.querySelector(".workbench-list-row small");
			if (agents.kind === "loading") {
				// R4-03 / NI-28：Agent 列表还在读取时不显示失败或「待确认」文字，元信息只有时间。
				expect(screen.queryByText("状态暂时无法确认")).toBeNull();
				expect(screen.queryByText(/所属 Agent 暂时无法读取/)).toBeNull();
				expect(screen.queryByText(/正在确认/)).toBeNull();
				expect(
					region
						.querySelector('[data-slot="chip-placeholder"]')
						?.getAttribute("aria-hidden"),
				).toBe("true");
				expect(meta?.textContent).toBe(
					meta?.querySelector("time")?.textContent,
				);
			} else {
				expect(within(region).getAllByText("状态暂时无法确认")).toHaveLength(1);
				expect(
					meta?.textContent?.startsWith("所属 Agent 暂时无法读取 · "),
				).toBe(true);
			}
			expect(meta?.textContent?.includes("历史只读")).toBe(false);
			expect(screen.queryByRole("link", { name: /^继续对话/ })).toBeNull();
			expect(screen.queryByRole("link", { name: /^查看历史/ })).toBeNull();
			expect(
				screen
					.getByRole("link", { name: `打开对话：${conversation.title}` })
					.getAttribute("href"),
			).toBe("/chat/usable-agent/conversation-z");
			view.rerender(
				<WorkbenchScreen
					{...props}
					agents={{ kind: "ready", agents: [available] }}
				/>,
			);
			expect(
				screen.getByRole("link", { name: `继续对话：${conversation.title}` }),
			).toBeTruthy();
			expect(
				region.querySelector(".workbench-list-row small")?.textContent,
			).toMatch(/^可用编程助手 · .+$/);
			expect(screen.queryByText(/历史只读/)).toBeNull();
			view.rerender(
				<WorkbenchScreen
					{...props}
					agents={{
						kind: "ready",
						agents: [
							{
								...available,
								managementStatus: "stopped",
								serviceAvailability: null,
							},
						],
					}}
				/>,
			);
			expect(
				region.querySelector(".workbench-list-row small")?.textContent,
			).toMatch(/ · 历史只读$/);
			expect(
				screen
					.getByRole("link", { name: `查看历史：${conversation.title}` })
					.getAttribute("href"),
			).toBe("/chat/usable-agent/conversation-z");
			view.rerender(
				<WorkbenchScreen
					{...props}
					recent={{
						kind: "ready",
						conversations: [{ ...conversation, status: "unavailable" }],
						nextCursor: null,
					}}
				/>,
			);
			expect(screen.getByText("会话不可用")).toBeTruthy();
			expect(
				screen.getByRole("link", { name: `查看历史：${conversation.title}` }),
			).toBeTruthy();
			expect(screen.queryByRole("link", { name: /^打开对话/ })).toBeNull();
		},
	);

	// 五个分区的失败标题；中文与拉丁字母或数字相邻处有一个空格（「可用 Agent 无法读取」「当前无权读取 Owner 创建状态」）。
	it.each([
		{
			status: 401,
			notices: [
				"可用 Agent 无法读取，请重新登录。",
				"Owner 创建状态无法读取，请重新登录。",
				"我的申请无法读取，请重新登录。",
				"待审批申请无法读取，请重新登录。",
				"管理员 Agent 状态无法读取，请重新登录。",
			],
		},
		{
			status: 403,
			notices: [
				"当前无权读取可用 Agent。",
				"当前无权读取 Owner 创建状态。",
				"当前无权读取我的申请。",
				"当前无权读取待审批申请。",
				"当前无权读取管理员 Agent 状态。",
			],
		},
		{
			status: 404,
			notices: [
				"可用 Agent 读取入口不可用。",
				"Owner 创建状态读取入口不可用。",
				"我的申请读取入口不可用。",
				"待审批申请读取入口不可用。",
				"管理员 Agent 状态读取入口不可用。",
			],
		},
		{
			status: 200,
			notices: [
				"可用 Agent 返回的数据无法读取。",
				"Owner 创建状态返回的数据无法读取。",
				"我的申请返回的数据无法读取。",
				"待审批申请返回的数据无法读取。",
				"管理员 Agent 状态返回的数据无法读取。",
			],
		},
	])(
		"removes prior rows and preserves the received HTTP $status failure in the actual collection presentation",
		async ({ status, notices }) => {
			let failedRead = false;
			let refresh = () => {};
			const requests: Request[] = [];
			const client = createClient({
				baseUrl: "https://platform.example.test",
				fetch: async (input, init) => {
					const request = new Request(input, init);
					requests.push(request);
					if (failedRead)
						return Response.json(
							{ detail: "Controlled invalid response" },
							{ status },
						);
					const url = new URL(request.url);
					return Response.json({
						items: url.pathname.endsWith("agent-applications")
							? [rejected]
							: [
									url.searchParams.get("scope") === "owner"
										? failed
										: available,
								],
						nextCursor: null,
					});
				},
			});
			const queryClient = new QueryClient();
			function Consumer() {
				const collections = useWorkbenchCollections({
					identityKey: "controlled-login:administrator",
					administrator: true,
					client,
				});
				refresh = collections.onRetry;
				return <WorkbenchScreen {...empty} {...collections} />;
			}
			const view = await showWorkbench(
				<QueryClientProvider client={queryClient}>
					<Consumer />
				</QueryClientProvider>,
			);
			try {
				await screen.findByText("可用编程助手");
				// Y-09：Owner 行说明把 Agent 名并入「…创建失败，可重试」。
				await screen.findByText("Owner 创建失败助手创建失败，可重试");
				failedRead = true;
				await act(async () => refresh());
				await waitFor(() => {
					for (const notice of notices)
						expect(screen.getByText(notice)).toBeTruthy();
				});
				expect(screen.queryByText("可用编程助手")).toBeNull();
				expect(screen.queryByText(/Owner 创建失败助手/)).toBeNull();
				expect(screen.queryByText(/已驳回的本人申请/)).toBeNull();
				expect(screen.queryByRole("button", { name: /^重新加载/ })).toBeNull();
				// W-03：只有 401 在页面级给出唯一的「重新登录」，其余失败没有按钮。
				expect(
					screen.queryAllByRole("button", { name: "重新登录" }),
				).toHaveLength(status === 401 ? 1 : 0);
				expect(screen.queryAllByRole("button")).toHaveLength(
					status === 401 ? 1 : 0,
				);
				expect(
					requests.every(
						(request) => request.method === "GET" && request.body === null,
					),
				).toBe(true);
			} finally {
				view.unmount();
				queryClient.clear();
			}
		},
	);

	it("removes prior cards after read failures and removes the administrator region after role loss", async () => {
		const view = await showWorkbench(
			<WorkbenchScreen
				{...empty}
				agents={{ kind: "ready", agents: [available] }}
				ownerAgents={{ kind: "ready", agents: [failed] }}
				applications={{ kind: "ready", applications: [rejected] }}
				recent={{
					kind: "ready",
					conversations: [conversation],
					nextCursor: null,
				}}
			/>,
		);
		expect(screen.getByText(/Owner 创建失败助手/)).toBeTruthy();
		view.rerender(
			<WorkbenchScreen
				{...empty}
				agents={{ kind: "unavailable", retryable: false }}
				ownerAgents={{ kind: "unavailable", retryable: false }}
				applications={{ kind: "unavailable", retryable: false }}
				recent={{ kind: "unavailable", retryable: true }}
				administrator={false}
			/>,
		);
		expect(screen.queryByText("可用编程助手")).toBeNull();
		// Y-09：Agent 名并入运行状态说明，按包含匹配，确保旧行确实被移除。
		expect(screen.queryByText(/Owner 创建失败助手/)).toBeNull();
		expect(screen.queryByText("较后 ID 的最近对话")).toBeNull();
		expect(screen.queryByRole("region", { name: "需要管理员处理" })).toBeNull();
		expect(screen.queryByRole("link", { name: "处理创建审批" })).toBeNull();
		expect(screen.getByText("我的申请暂时无法读取。")).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "重新加载最近对话" }),
		).toBeTruthy();
	});

	it("never pages recent conversations or shows a loaded-count badge even when a cursor is supplied", async () => {
		await showWorkbench(
			<WorkbenchScreen
				{...empty}
				recent={{
					kind: "ready",
					conversations: [conversation],
					nextCursor: "opaque-recent/+?=",
				}}
			/>,
		);
		const region = screen.getByRole("region", { name: "最近对话" });
		// R4-04 / NI-32：续页只在对话页「最近对话」面板；工作台不显示已加载条数徽章。
		expect(within(region).queryByRole("button")).toBeNull();
		expect(region.querySelector("header [data-slot='badge']")).toBeNull();
		expect(within(region).getByRole("link", { name: "查看全部" })).toBeTruthy();
	});

	it("names how many Agents' conversations are omitted without failing the recent section (#3379)", async () => {
		const view = await showWorkbench(
			<WorkbenchScreen
				{...empty}
				recent={{
					kind: "ready",
					conversations: [conversation],
					nextCursor: null,
					unavailableAgentIds: ["stopped-agent", "other-agent"],
				}}
			/>,
		);
		const region = screen.getByRole("region", { name: "最近对话" });
		expect(within(region).getByRole("status").textContent).toBe(
			"2 个 Agent 的对话暂时无法显示，其他对话不受影响。",
		);
		expect(within(region).queryByRole("alert")).toBeNull();
		expect(
			within(region).getByRole("link", {
				name: `打开对话：${conversation.title}`,
			}),
		).toBeTruthy();
		// 只有被省略的 Agent 时不显示「暂无个人对话」之外的失败，也不显示 Agent ID。
		view.rerender(
			<WorkbenchScreen
				{...empty}
				recent={{
					kind: "ready",
					conversations: [],
					nextCursor: null,
					unavailableAgentIds: ["stopped-agent"],
				}}
			/>,
		);
		expect(within(region).getByRole("status").textContent).toBe(
			"1 个 Agent 的对话暂时无法显示，其他对话不受影响。",
		);
		expect(region.textContent).not.toContain("stopped-agent");
		view.rerender(<WorkbenchScreen {...empty} />);
		expect(within(region).queryByRole("status")).toBeNull();
	});

	it("shows one primary re-login for 401 and keeps partition notices without buttons", async () => {
		const relogin = vi.fn();
		const authentication = {
			kind: "unavailable",
			retryable: false,
			reason: "authentication-required",
		} as const;
		await showWorkbench(
			<WorkbenchScreen
				{...empty}
				agents={authentication}
				ownerAgents={authentication}
				applications={authentication}
				pending={authentication}
				adminAgents={{
					kind: "error",
					retryable: false,
					reason: "authentication-required",
				}}
				recent={authentication}
				onRelogin={relogin}
			/>,
		);
		const relogins = screen.getAllByRole("button", { name: "重新登录" });
		expect(relogins).toHaveLength(1);
		expect(screen.getAllByRole("button")).toHaveLength(1);
		expect(relogins[0]?.className).toContain("bg-accent-ink");
		// 与状态卡、Agent 目录的「重新登录」同一按钮，带 LogIn 图标（#3327 N10-1-04）。
		expect(
			relogins[0]?.querySelector(":scope > svg")?.getAttribute("class"),
		).toContain("lucide-log-in");
		expect(screen.getByText("登录已过期")).toBeTruthy();
		expect(
			screen.getByText("当前会话已过期，需要重新登录后再进入工作区。"),
		).toBeTruthy();
		for (const name of ["最近对话", "可用 Agent", "我的申请"]) {
			const region = screen.getByRole("region", { name });
			expect(within(region).queryByRole("button")).toBeNull();
			expect(within(region).getByText(/无法读取，请重新登录。$/)).toBeTruthy();
		}
		fireEvent.click(relogins[0] as HTMLElement);
		expect(relogin).toHaveBeenCalledOnce();
	});

	it.each([
		{
			state: { kind: "unavailable", retryable: true },
			title: "最近对话暂时无法读取。",
			tone: "info",
			retry: true,
		},
		{
			state: { kind: "unavailable", retryable: false, reason: "denied" },
			title: "当前无权读取最近对话。",
			tone: "danger",
			retry: false,
		},
		{
			state: { kind: "unavailable", retryable: false, reason: "not-found" },
			title: "最近对话读取入口不可用。",
			tone: "danger",
			retry: false,
		},
		{
			state: {
				kind: "unavailable",
				retryable: false,
				reason: "invalid-response",
			},
			title: "最近对话返回的数据无法读取。",
			tone: "danger",
			retry: false,
		},
	] satisfies {
		state: WorkbenchScreenProps["recent"];
		title: string;
		tone: string;
		retry: boolean;
	}[])(
		"renders the recent read failure as a notice with its own title ($title)",
		async ({ state, title, tone, retry }) => {
			const onRetry = vi.fn();
			await showWorkbench(
				<WorkbenchScreen {...empty} recent={state} onRetry={onRetry} />,
			);
			const region = screen.getByRole("region", { name: "最近对话" });
			const notice = region.querySelector('[data-slot="alert"]');
			expect(notice?.getAttribute("data-tone")).toBe(tone);
			expect(notice?.getAttribute("role")).toBe("alert");
			expect(notice?.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
			expect(within(region).getByText(title).tagName).toBe("STRONG");
			expect(screen.queryByRole("button", { name: "重新登录" })).toBeNull();
			if (retry) {
				fireEvent.click(
					within(region).getByRole("button", {
						name: "重新加载最近对话",
					}),
				);
				expect(onRetry).toHaveBeenCalledOnce();
			} else expect(within(region).queryByRole("button")).toBeNull();
		},
	);

	it("names the recent section 最近对话 in loading, failure and retry copy and spaces Latin labels", async () => {
		const onRetry = vi.fn();
		const view = await showWorkbench(
			<WorkbenchScreen
				{...empty}
				recent={{ kind: "loading" }}
				agents={{ kind: "loading" }}
			/>,
		);
		const recent = () => screen.getByRole("region", { name: "最近对话" });
		const agents = () => screen.getByRole("region", { name: "可用 Agent" });
		expect(within(recent()).getByText("正在加载最近对话…")).toBeTruthy();
		expect(within(agents()).getByText("正在加载可用 Agent…")).toBeTruthy();
		view.rerender(
			<WorkbenchScreen
				{...empty}
				recent={{ kind: "unavailable", retryable: true }}
				agents={{ kind: "unavailable", retryable: true }}
				onRetry={onRetry}
			/>,
		);
		expect(within(recent()).getByText("最近对话暂时无法读取。")).toBeTruthy();
		expect(
			within(recent()).getByRole("button", { name: "重新加载最近对话" }),
		).toBeTruthy();
		// label 以拉丁字母结尾时与中文之间有一个空格。
		expect(
			within(agents()).getByText("可用 Agent 暂时无法读取。"),
		).toBeTruthy();
		expect(
			within(agents()).getByRole("button", { name: "重新加载可用 Agent" }),
		).toBeTruthy();
		expect(screen.queryByText(/最近的个人对话/)).toBeNull();
		expect(screen.queryByText(/Agent(无法|暂时|读取|返回)/)).toBeNull();
	});

	it("colors each application status chip inside its own row", async () => {
		const failedApplication = {
			...pendingApplication,
			applicationId: "failed-application",
			name: "创建失败的本人申请",
			status: "creation_failed" as const,
		};
		// 工作台最多列 2 条申请（A2-02），三种状态分两次渲染，逐行核对 chip 色调。
		for (const batch of [
			[
				[failedApplication, "创建失败", "red"],
				[rejected, "已驳回", "red"],
			],
			[[pendingApplication, "待审批", "amber"]],
		] as const) {
			const view = await showWorkbench(
				<WorkbenchScreen
					{...empty}
					applications={{
						kind: "ready",
						applications: batch.map(([application]) => application),
					}}
				/>,
			);
			const region = screen.getByRole("region", { name: "我的申请" });
			for (const [application, label, tone] of batch) {
				const row = within(region)
					.getByRole("heading", { level: 3, name: application.name })
					.closest(".workbench-list-row") as HTMLElement;
				const chip = within(row).getByText(label, {
					selector: '[data-slot="badge"]',
				});
				expect(chip.dataset.variant).toBe("chip");
				expect(chip.dataset.tone).toBe(tone);
			}
			view.unmount();
		}
	});

	it("lists at most two applications like the exported design (A2-02)", async () => {
		const applications = [1, 2, 3].map((index) => ({
			...pendingApplication,
			applicationId: `application-${index}`,
			name: `本人申请 ${index}`,
		}));
		await showWorkbench(
			<WorkbenchScreen
				{...empty}
				applications={{ kind: "ready", applications }}
			/>,
		);
		const region = screen.getByRole("region", { name: "我的申请" });
		expect(
			within(region)
				.getAllByRole("heading", { level: 3 })
				.map((heading) => heading.textContent),
		).toEqual(["本人申请 1", "本人申请 2"]);
		expect(region.querySelectorAll(".workbench-list-row")).toHaveLength(2);
	});

	it("shows one channel tag with the available channel summary (A2-01)", async () => {
		const agent = AgentProjectionV2Schema.parse({
			...available,
			configuration: {
				...available.configuration,
				channels: [
					{ kind: "web", status: "available" },
					{ kind: "wecom_bot", status: "bound" },
					{ kind: "wecom_app", status: "not_configured" },
				],
			},
		});
		const unconfigured = AgentProjectionV2Schema.parse({
			...available,
			agentId: "unconfigured-agent",
			name: "未配置渠道的助手",
			configuration: {
				...available.configuration,
				channels: [{ kind: "wecom_bot", status: "not_configured" }],
			},
		});
		await showWorkbench(
			<WorkbenchScreen
				{...empty}
				agents={{ kind: "ready", agents: [agent, unconfigured] }}
				templateName={(templateId) =>
					templateId === "codex" ? "Codex" : undefined
				}
			/>,
		);
		const region = screen.getByRole("region", { name: "可用 Agent" });
		const tags = (name: string) =>
			Array.from(
				(
					within(region)
						.getByRole("heading", { level: 3, name })
						.closest(".workbench-card") as HTMLElement
				).querySelectorAll('.workbench-agent-tags [data-slot="badge"]'),
			).map((tag) => tag.textContent);
		expect(tags(agent.name)).toEqual(["Codex", "Web · 企微机器人"]);
		// 只列可用或已绑定的渠道：未配置的企微机器人不出现，与 /agents 卡片一致。
		expect(tags(unconfigured.name)).toEqual(["Codex", "暂无可用渠道"]);
		expect(within(region).queryByText("企微应用")).toBeNull();
	});

	it("lists each application with source, update time and description and a 查看状态 link (Y-10)", async () => {
		const custom = {
			...pendingApplication,
			applicationId: "custom-application",
			name: "自定义镜像申请",
			description: "镜像来源的申请说明",
			source: {
				kind: "custom" as const,
				imageReference: "registry.example.test/agent:1.0.0",
				interactionMode: "platform-adapter" as const,
			},
			updatedAt: undefined,
			submittedAt: "2026-09-04T08:00:00Z",
		};
		await showWorkbench(
			<WorkbenchScreen
				{...empty}
				applications={{
					kind: "ready",
					applications: [pendingApplication, custom],
				}}
				templateName={(templateId) =>
					templateId === "codex" ? "Codex" : undefined
				}
			/>,
		);
		const region = screen.getByRole("region", { name: "我的申请" });
		const rows = Array.from(region.querySelectorAll(".workbench-list-row"));
		const meta = rows.map((row) => row.querySelector("small"));
		expect(meta[0]?.textContent).toMatch(
			/^Codex · .+ · Helps the release team$/,
		);
		expect(meta[0]?.querySelector("time")?.getAttribute("datetime")).toBe(
			pendingApplication.updatedAt,
		);
		// 没有 updatedAt 时用提交时间；自定义来源不外露镜像地址。
		expect(meta[1]?.textContent).toMatch(
			/^自定义 Agent · .+ · 镜像来源的申请说明$/,
		);
		expect(meta[1]?.querySelector("time")?.getAttribute("datetime")).toBe(
			"2026-09-04T08:00:00Z",
		);
		expect(region.textContent).not.toContain("registry.example.test");
		const links = within(region).getAllByRole("link", { name: /^查看状态：/ });
		expect(links.map((link) => link.textContent)).toEqual([
			"查看状态",
			"查看状态",
		]);
		expect(links.map((link) => link.getAttribute("aria-label"))).toEqual([
			`查看状态：${pendingApplication.name}`,
			"查看状态：自定义镜像申请",
		]);
		expect(screen.queryByRole("link", { name: /^查看申请状态/ })).toBeNull();
	});

	it("continues only the first recent conversation and opens the others (Y-11)", async () => {
		await showWorkbench(
			<WorkbenchScreen
				{...empty}
				agents={{ kind: "ready", agents: [available, stopped] }}
				recent={{
					kind: "ready",
					conversations: [
						conversation,
						{
							...conversation,
							conversationId: "conversation-second",
							title: "第二条可用会话",
						},
						{
							...conversation,
							conversationId: "conversation-stopped",
							agentId: stopped.agentId,
							title: "已停止 Agent 的会话",
						},
					],
					nextCursor: null,
				}}
			/>,
		);
		const region = screen.getByRole("region", { name: "最近对话" });
		const actions = Array.from(
			region.querySelectorAll(".workbench-list-side a"),
		);
		expect(actions.map((link) => link.textContent)).toEqual([
			"继续对话",
			"打开对话",
			"查看历史",
		]);
		// 设计：「继续对话」「打开对话」为 outline，「查看历史」为 ghost。
		expect(
			actions.map((link) => link.className.includes("border-border")),
		).toEqual([true, true, false]);
	});

	it("numbers duplicate and untitled recent titles so continue links stay distinct (N-12)", async () => {
		await showWorkbench(
			<WorkbenchScreen
				{...empty}
				agents={{ kind: "ready", agents: [available] }}
				recent={{
					kind: "ready",
					conversations: [
						{ ...conversation, conversationId: "untitled-1", title: null },
						{ ...conversation, conversationId: "untitled-2", title: "  " },
						{ ...conversation, conversationId: "titled" },
					],
					nextCursor: null,
				}}
			/>,
		);
		const region = screen.getByRole("region", { name: "最近对话" });
		// 可见标题仍是「未命名对话」；只有链接的对象名按出现顺序编号。
		expect(
			within(region)
				.getAllByRole("heading", { level: 3 })
				.map((heading) => heading.textContent),
		).toEqual(["未命名对话", "未命名对话", "较后 ID 的最近对话"]);
		const names = within(region)
			.getAllByRole("link", { name: /^(继续对话|打开对话)：/ })
			.map((link) => link.getAttribute("aria-label"));
		// Y-11：只有首行写「继续对话」，其余可用会话写「打开对话」；对象名仍按出现顺序编号。
		expect(names).toEqual([
			"继续对话：未命名对话（第 1 次）",
			"打开对话：未命名对话（第 2 次）",
			"打开对话：较后 ID 的最近对话",
		]);
		expect(new Set(names).size).toBe(names.length);
	});

	it("shows today and earlier recent times with the shared formatter", async () => {
		const originalTimeZone = process.env.TZ;
		process.env.TZ = "Asia/Shanghai";
		try {
			await showWorkbench(
				<ClockProvider now={() => new Date("2026-10-18T02:40:00Z")}>
					<WorkbenchScreen
						{...empty}
						agents={{ kind: "ready", agents: [available] }}
						recent={{
							kind: "ready",
							conversations: [
								{ ...conversation, updatedAt: "2026-10-18T02:33:00Z" },
								{
									...conversation,
									conversationId: "conversation-july",
									updatedAt: "2026-07-27T02:00:00Z",
								},
							],
							nextCursor: null,
						}}
					/>
				</ClockProvider>,
			);
			const region = await screen.findByRole("region", {
				name: "最近对话",
			});
			const times = Array.from(region.querySelectorAll("time"));
			expect(times.map((time) => time.textContent)).toEqual([
				"今天 10:33",
				"7 月 27 日",
			]);
			expect(times.map((time) => time.getAttribute("datetime"))).toEqual([
				"2026-10-18T02:33:00Z",
				"2026-07-27T02:00:00Z",
			]);
		} finally {
			if (originalTimeZone === undefined) delete process.env.TZ;
			else process.env.TZ = originalTimeZone;
		}
	});
});
