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
} from "@testing-library/react";
import { createContext, type ReactNode, useContext } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../../pilot/generated-v2/client/index.js";
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

describe("Original IA workbench presentation", () => {
	it("keeps the original six regions and safe empty-state navigation", async () => {
		await showWorkbench(<WorkbenchScreen {...empty} />);
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
			"从可用 Agent 开始今天的工作。",
		);
		expect(
			screen
				.getAllByRole("heading", { level: 2 })
				.map((heading) => heading.textContent),
		).toEqual([
			"最近的个人对话",
			"可用 Agent",
			"创建状态",
			"需要你处理",
			"需要管理员处理",
		]);
		expect(screen.getByText("暂无个人对话。")).toBeTruthy();
		expect(screen.getByText("暂无需要你处理的事项。")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "新对话" }).getAttribute("href"),
		).toBe("/agents?mode=conversation");
		expect(
			screen.getByRole("link", { name: "创建 Agent" }).getAttribute("href"),
		).toBe("/my-agents/new");
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
			screen.getByRole("link", { name: "查看详情" }).getAttribute("href"),
		).toBe("/agents/usable-agent");
		expect(
			screen.getByRole("link", { name: "修改并重新提交" }).getAttribute("href"),
		).toBe("/my-agents/rejected-application/edit");
		expect(
			screen.getByRole("link", { name: "配置与管理" }).getAttribute("href"),
		).toBe("/agents/owned-failed-agent/configuration");
		expect(screen.getByText("请缩小申请的可用范围。")).toBeTruthy();
		expect(screen.getByText("暂未提供创建失败原因。")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "查看失败清单" }).getAttribute("href"),
		).toBe("/admin/agents?status=creation_failed");
		expect(screen.getByText("1 项待审批")).toBeTruthy();
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
							conversationId: "conversation-unavailable",
							status: "unavailable",
							title: "恢复失败的会话",
						},
						{
							...conversation,
							conversationId: "conversation-unknown-agent",
							agentId: "unknown-agent",
							title: null,
						},
					],
					nextCursor: null,
				}}
			/>,
		);
		const region = screen.getByRole("region", { name: "最近的个人对话" });
		expect(
			Array.from(region.querySelectorAll("h3")).map(
				(heading) => heading.textContent,
			),
		).toEqual([
			"较后 ID 的最近对话",
			"停止后的个人历史",
			"恢复失败的会话",
			"未命名对话",
		]);
		const links = Array.from(region.querySelectorAll('a[href^="/chat/"]')).map(
			(link) => {
				const url = new URL(
					link.getAttribute("href") ?? "",
					"https://platform.example.test",
				);
				return [url.pathname, url.searchParams.get("view")];
			},
		);
		expect(links).toEqual([
			["/chat/usable-agent/conversation-z", null],
			["/chat/stopped-agent/conversation-a", null],
			["/chat/usable-agent/conversation-unavailable", null],
			["/chat/unknown-agent/conversation-unknown-agent", null],
		]);
		expect(
			region.querySelector('time[datetime="2026-09-30T21:00:00Z"]'),
		).toBeTruthy();
	});

	it.each([
		{
			status: 401,
			notice: (label: string) => `${label}无法读取，请重新登录。`,
		},
		{ status: 403, notice: (label: string) => `当前无权读取${label}。` },
		{ status: 404, notice: (label: string) => `${label}读取入口不可用。` },
		{ status: 200, notice: (label: string) => `${label}返回的数据无法读取。` },
	])(
		"removes prior rows and preserves the received HTTP $status failure in the actual collection presentation",
		async ({ status, notice }) => {
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
				await screen.findByText("Owner 创建失败助手");
				failedRead = true;
				await act(async () => refresh());
				await waitFor(() => {
					for (const label of [
						"可用 Agent",
						"Owner 创建状态",
						"我的申请",
						"待审批申请",
						"管理员 Agent 状态",
					])
						expect(screen.getByText(notice(label))).toBeTruthy();
				});
				expect(screen.queryByText("可用编程助手")).toBeNull();
				expect(screen.queryByText("Owner 创建失败助手")).toBeNull();
				expect(screen.queryByText("已驳回的本人申请")).toBeNull();
				expect(screen.queryByRole("button", { name: /^重新加载/ })).toBeNull();
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
		expect(screen.queryByText("Owner 创建失败助手")).toBeNull();
		expect(screen.queryByText("较后 ID 的最近对话")).toBeNull();
		expect(screen.queryByRole("region", { name: "需要管理员处理" })).toBeNull();
		expect(screen.queryByRole("link", { name: "处理创建审批" })).toBeNull();
		expect(screen.getByText("我的申请暂时无法读取。")).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "重新加载最近的个人对话" }),
		).toBeTruthy();
	});

	it("offers continuation only for a supplied cursor and disables it during refresh", async () => {
		const more = vi.fn();
		const view = await showWorkbench(
			<WorkbenchScreen
				{...empty}
				recent={{
					kind: "ready",
					conversations: [conversation],
					nextCursor: "opaque-recent/+?=",
				}}
				onLoadMoreRecent={more}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "加载更多对话" }));
		expect(more).toHaveBeenCalledOnce();
		view.rerender(
			<WorkbenchScreen
				{...empty}
				recent={{
					kind: "ready",
					conversations: [conversation],
					nextCursor: "opaque-recent/+?=",
				}}
				onLoadMoreRecent={more}
				refreshing
			/>,
		);
		expect(
			(
				screen.getByRole("button", {
					name: "加载更多对话",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		view.rerender(<WorkbenchScreen {...empty} onLoadMoreRecent={more} />);
		expect(screen.queryByRole("button", { name: "加载更多对话" })).toBeNull();
	});
});
