import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationShell } from "./application-shell.js";
import { NotFoundScreen } from "./not-found-screen.js";

beforeEach(() => {
	vi.stubGlobal(
		"matchMedia",
		vi.fn((media: string) => ({
			matches: false,
			media,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		})),
	);
});
const clients: QueryClient[] = [];
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
});

async function showShell(administrator: boolean, initialEntry = "/agents") {
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Unexpected fixture network request");
		}),
	);
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
		},
	});
	clients.push(client);
	client.setQueryData(["browser-session"], {
		kind: "ready",
		sessionGeneration: "g".repeat(43),
		session: {
			schemaVersion: 1,
			user: {
				userId: "controlled-person",
				displayName: "受控用户",
				roles: administrator ? ["employee", "system_admin"] : ["employee"],
			},
		},
	});
	const root = createRootRoute({
		component: () => (
			<ApplicationShell>
				<Outlet />
			</ApplicationShell>
		),
		notFoundComponent: NotFoundScreen,
	});
	const home = createRoute({
		getParentRoute: () => root,
		path: "/",
		component: () => <h1>受控工作台</h1>,
	});
	const agents = createRoute({
		getParentRoute: () => root,
		path: "/agents",
		component: () => <h1>受控 Agent 目录</h1>,
	});
	const targets = [
		"/my-agents",
		"/my-agents/new",
		"/my-settings/api-credentials",
		"/my-settings/relay-key",
		"/skills",
		"/skills/manage",
		"/skills/$skillVersionId",
		"/agents/$agentId",
		"/agents/$agentId/configuration",
		"/my-agents/$applicationId",
		"/my-agents/$applicationId/edit",
		"/eval",
		"/ops",
		"/audit",
		"/admin/approvals",
		"/admin/agents",
		"/admin/audit",
		"/chat/$agentId/{-$conversationId}",
	].map((path) =>
		createRoute({ getParentRoute: () => root, path, component: () => null }),
	);

	const history = createMemoryHistory({ initialEntries: [initialEntry] });
	const router = createRouter({
		history,
		routeTree: root.addChildren([home, agents, ...targets]),
	});
	await router.load();
	render(
		<QueryClientProvider client={client}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	await screen.findByRole("navigation", { name: "工作区" });
	return { history, client };
}

describe("Original IA workbench navigation", () => {
	it.each(["/no-such-page", "/admin/no-such-page", "/agents/a/b/c"])(
		"shows a Chinese not-found page inside the shell for %s (#2297)",
		async (entry) => {
			const { history } = await showShell(false, entry);
			expect(
				await screen.findByRole("heading", { level: 1, name: "页面不存在" }),
			).toBeTruthy();
			expect(screen.queryByText("Not Found")).toBeNull();
			// 面包屑不沿用其他页面的标题。
			const breadcrumb = screen.getByRole("navigation", { name: "breadcrumb" });
			expect(within(breadcrumb).getByText("页面不存在")).toBeTruthy();
			expect(within(breadcrumb).queryByText("Agent 详情")).toBeNull();
			expect(within(breadcrumb).queryByText("创建审批")).toBeNull();
			fireEvent.click(screen.getByRole("link", { name: "返回工作台" }));
			expect(
				await screen.findByRole("heading", { name: "受控工作台" }),
			).toBeTruthy();
			expect(history.location.pathname).toBe("/");
		},
	);
	it.each([
		["/skills/manage", "我的 Skill"],
		["/skills/manage/", "我的 Skill"],
	])("maps Skill Hub route %s to the management IA", async (entry, label) => {
		await showShell(false, entry);
		const management = screen.getByRole("navigation", { name: "我的管理" });
		expect(
			within(management)
				.getByRole("link", { name: label })
				.getAttribute("aria-current"),
		).toBe("page");
		expect(
			screen.getByText(label, { selector: '[data-slot="breadcrumb-page"]' }),
		).toBeTruthy();
		cleanup();
	});

	it.each([
		["/eval", "评测"],
		["/eval/", "评测"],
		["/ops", "运维观测"],
		["/ops/", "运维观测"],
	])("maps administrator route %s to the system IA", async (entry, label) => {
		await showShell(true, entry);
		const system = screen.getByRole("navigation", { name: "系统管理" });
		expect(
			within(system)
				.getByRole("link", { name: label })
				.getAttribute("aria-current"),
		).toBe("page");
		expect(
			screen.getByText("系统管理", {
				selector: '[data-slot="breadcrumb-item"]',
			}),
		).toBeTruthy();
		expect(
			screen.getByText(label, { selector: '[data-slot="breadcrumb-page"]' }),
		).toBeTruthy();
		cleanup();
	});

	it.each(["/ops/", "/admin/approvals/", "/admin/agents/", "/admin/audit/"])(
		"keeps the system navigation hidden from a non-admin deep link at %s",
		async (entry) => {
			await showShell(false, entry);
			expect(screen.queryByRole("navigation", { name: "系统管理" })).toBeNull();
		},
	);

	it.each([
		{
			entry: "/my-agents/",
			group: "我的管理",
			label: "我的 Agent",
			title: "我的 Agent",
			administrator: false,
		},
		{
			entry: "/my-agents/new/",
			group: "我的管理",
			label: "创建申请",
			title: "创建申请",
			administrator: false,
		},
		{
			entry: "/audit/",
			group: "我的管理",
			label: "我的执行审计",
			title: "我的执行审计",
			administrator: false,
		},
		{
			entry: "/my-settings/api-credentials/",
			group: "我的管理",
			label: "API 凭证",
			title: "API 凭证",
			administrator: false,
		},
		{
			entry: "/my-settings/relay-key/",
			group: "我的管理",
			label: "个人 Relay Key",
			title: "个人 Relay Key",
			administrator: false,
		},
		{
			entry: "/admin/approvals/",
			group: "系统管理",
			label: "创建审批",
			title: "创建审批",
			administrator: true,
		},
		{
			entry: "/admin/agents/",
			group: "系统管理",
			label: "Agent 管理",
			title: "Agent 管理",
			administrator: true,
		},
		{
			entry: "/admin/audit/",
			group: "系统管理",
			label: "平台审计",
			title: "平台审计",
			administrator: true,
		},
	])(
		"keeps trailing-slash deep links aligned with their IA state at $entry",
		async ({ entry, group: groupName, label, title, administrator }) => {
			await showShell(administrator, entry);
			const group = screen.getByRole("navigation", { name: groupName });
			const link = within(group).getByRole("link", { name: label });
			expect(link.getAttribute("aria-current")).toBe("page");
			expect(link.className).toContain("selected");
			expect(
				screen.getByText(title, {
					selector: '[data-slot="breadcrumb-page"]',
				}),
			).toBeTruthy();
			cleanup();
		},
	);

	it.each(["/agents?mode=conversation", "/chat/agent-1/conversation-1"])(
		"uses one chat navigation highlight and the appropriate breadcrumb at %s",
		async (entry) => {
			await showShell(false, entry);
			const work = screen.getByRole("navigation", { name: "工作区" });
			const chat = within(work).getByRole("link", {
				name: "对话",
			});
			expect(chat.getAttribute("href")).toBe("/agents?mode=conversation");
			expect(chat.getAttribute("aria-current")).toBe("page");
			expect(
				within(work)
					.getByRole("link", { name: "Agent 目录" })
					.getAttribute("aria-current"),
			).toBeNull();
			expect(work.querySelectorAll(".selected")).toHaveLength(1);
			expect(
				screen.getByText(
					entry.startsWith("/chat/") ? "对话" : "选择 Agent 开始对话",
					{ selector: '[data-slot="breadcrumb-page"]' },
				),
			).toBeTruthy();
			fireEvent.click(within(work).getByRole("link", { name: "Agent 目录" }));
			await screen.findByRole("heading", { name: "受控 Agent 目录" });
			expect(
				within(work)
					.getByRole("link", { name: "Agent 目录" })
					.getAttribute("aria-current"),
			).toBe("page");
			expect(
				within(work)
					.getByRole("link", { name: "对话" })
					.getAttribute("aria-current"),
			).toBeNull();
			expect(globalThis.fetch).not.toHaveBeenCalled();
		},
	);
	it.each([false, true])(
		"opens the workbench from the working area and preserves role-filtered groups (administrator=%s)",
		async (administrator) => {
			const { history } = await showShell(administrator);
			const work = screen.getByRole("navigation", { name: "工作区" });
			const link = within(work).getByRole("link", { name: "工作台" });
			expect(link.getAttribute("href")).toBe("/");
			expect(
				within(work)
					.getByRole("link", { name: "Agent 目录" })
					.getAttribute("href"),
			).toBe("/agents");
			expect(screen.getByRole("navigation", { name: "我的管理" })).toBeTruthy();
			expect(
				Boolean(screen.queryByRole("navigation", { name: "系统管理" })),
			).toBe(administrator);
			fireEvent.click(link);
			await screen.findByRole("heading", { name: "受控工作台" });
			expect(history.location.pathname).toBe("/");
			expect(
				within(work)
					.getByRole("link", { name: "工作台" })
					.getAttribute("aria-current"),
			).toBe("page");
			expect(
				screen.getByText("工作台", {
					selector: '[data-slot="breadcrumb-page"]',
				}),
			).toBeTruthy();
			expect(globalThis.fetch).not.toHaveBeenCalled();
		},
	);
	it.each([
		{
			entry: "/my-settings/api-credentials",
			label: "API 凭证",
		},
		{ entry: "/my-settings/relay-key", label: "个人 Relay Key" },
	])(
		"keeps personal settings in the original management IA: %s",
		async ({ entry, label }) => {
			await showShell(false, entry);
			const management = screen.getByRole("navigation", { name: "我的管理" });
			const link = within(management).getByRole("link", { name: label });
			expect(link.getAttribute("aria-current")).toBe("page");
			expect(link.className).toContain("selected");
			expect(management.querySelectorAll(".selected")).toHaveLength(1);
			expect(
				screen.getByText("我的管理", {
					selector: '[data-slot="breadcrumb-item"]',
				}),
			).toBeTruthy();
			expect(
				screen.getByText(label, {
					selector: '[data-slot="breadcrumb-page"]',
				}),
			).toBeTruthy();
			expect(screen.queryByRole("navigation", { name: "系统管理" })).toBeNull();
		},
	);

	const navigationOrder = {
		工作区: ["工作台", "Agent 目录", "对话", "Skill Hub"],
		我的管理: [
			"我的 Agent",
			"创建申请",
			"我的 Skill",
			"个人 Relay Key",
			"API 凭证",
			"我的执行审计",
		],
		系统管理: ["创建审批", "Agent 管理", "评测", "平台审计", "运维观测"],
	} as const;
	it.each([false, true])(
		"orders navigation groups and items as designed (administrator=%s)",
		async (administrator) => {
			await showShell(administrator, "/");
			const main = screen.getByRole("navigation", { name: "主导航" });
			const groups = within(main)
				.getAllByRole("navigation")
				.map((group) => group.getAttribute("aria-label"));
			expect(groups).toEqual(
				administrator
					? ["工作区", "我的管理", "系统管理"]
					: ["工作区", "我的管理"],
			);
			for (const [group, labels] of Object.entries(navigationOrder)) {
				if (group === "系统管理" && !administrator) continue;
				const nav = screen.getByRole("navigation", { name: group });
				expect(
					within(nav)
						.getAllByRole("link")
						.map((link) => link.textContent),
				).toEqual(labels);
			}
			// 不可用的 Connection 是我的管理的最后一项，排在「我的执行审计」之后。
			const items = screen
				.getByRole("navigation", { name: "我的管理" })
				.querySelectorAll(".platform-nav-item");
			expect(items[items.length - 1]?.getAttribute("aria-disabled")).toBe(
				"true",
			);
			expect(items[items.length - 2]?.textContent).toBe("我的执行审计");
		},
	);

	it.each([
		{
			entry: "/",
			group: "工作区",
			label: "工作台",
			parent: "工作区",
			title: "工作台",
			documentTitle: "Agora Agent · Platform",
		},
		{
			entry: "/agents",
			group: "工作区",
			label: "Agent 目录",
			parent: "工作区",
			title: "Agent 目录",
			documentTitle: "Agent 目录 · Agora Agent",
		},
		{
			entry: "/agents/agent-1",
			group: "工作区",
			label: "Agent 目录",
			parent: "Agent 目录",
			title: "Agent 详情",
			documentTitle: "Agent 详情 · Agora Agent",
		},
		{
			entry: "/agents/agent-1/configuration",
			group: "工作区",
			label: "Agent 目录",
			parent: "Agent 目录",
			title: "Owner 配置",
			documentTitle: "Owner 配置 · Agora Agent",
		},
		{
			entry: "/agents?mode=conversation",
			group: "工作区",
			label: "对话",
			parent: "工作区",
			title: "选择 Agent 开始对话",
			documentTitle: "选择 Agent 开始对话 · Agora Agent",
		},
		{
			entry: "/chat/agent-1/conversation-1",
			group: "工作区",
			label: "对话",
			parent: "工作区",
			title: "对话",
			documentTitle: "对话 · Agora Agent",
		},
		{
			entry: "/skills",
			group: "工作区",
			label: "Skill Hub",
			parent: "工作区",
			title: "Skill Hub",
			documentTitle: "Skill Hub · Agora Agent",
		},
		{
			entry: "/skills/version-1",
			group: "工作区",
			label: "Skill Hub",
			parent: "Skill Hub",
			title: "Skill 详情",
			documentTitle: "Skill 详情 · Agora Agent",
		},
		{
			entry: "/skills/manage",
			group: "我的管理",
			label: "我的 Skill",
			parent: "我的管理",
			title: "我的 Skill",
			documentTitle: "我的 Skill · Agora Agent",
		},
		{
			entry: "/my-agents",
			group: "我的管理",
			label: "我的 Agent",
			parent: "我的管理",
			title: "我的 Agent",
			documentTitle: "我的 Agent · Agora Agent",
		},
		{
			entry: "/my-agents/new",
			group: "我的管理",
			label: "创建申请",
			parent: "我的管理",
			title: "创建申请",
			documentTitle: "创建申请 · Agora Agent",
		},
		{
			entry: "/my-agents/application-1",
			group: "我的管理",
			label: "我的 Agent",
			parent: "我的管理",
			title: "申请详情",
			documentTitle: "申请详情 · Agora Agent",
		},
		{
			entry: "/my-agents/application-1/edit",
			group: "我的管理",
			label: "我的 Agent",
			parent: "我的管理",
			title: "编辑申请",
			documentTitle: "编辑申请 · Agora Agent",
		},
		{
			entry: "/my-settings/relay-key",
			group: "我的管理",
			label: "个人 Relay Key",
			parent: "我的管理",
			title: "个人 Relay Key",
			documentTitle: "个人 Relay Key · Agora Agent",
		},
		{
			entry: "/my-settings/api-credentials",
			group: "我的管理",
			label: "API 凭证",
			parent: "我的管理",
			title: "API 凭证",
			documentTitle: "API 凭证 · Agora Agent",
		},
		{
			entry: "/audit",
			group: "我的管理",
			label: "我的执行审计",
			parent: "我的管理",
			title: "我的执行审计",
			documentTitle: "我的执行审计 · Agora Agent",
		},
		{
			entry: "/admin/approvals",
			group: "系统管理",
			label: "创建审批",
			parent: "系统管理",
			title: "创建审批",
			documentTitle: "创建审批 · Agora Agent",
		},
		{
			entry: "/admin/agents",
			group: "系统管理",
			label: "Agent 管理",
			parent: "系统管理",
			title: "Agent 管理",
			documentTitle: "Agent 管理 · Agora Agent",
		},
		{
			entry: "/eval",
			group: "系统管理",
			label: "评测",
			parent: "系统管理",
			title: "评测",
			documentTitle: "评测 · Agora Agent",
		},
		{
			entry: "/admin/audit",
			group: "系统管理",
			label: "平台审计",
			parent: "系统管理",
			title: "平台审计",
			documentTitle: "平台审计 · Agora Agent",
		},
		{
			entry: "/ops",
			group: "系统管理",
			label: "运维观测",
			parent: "系统管理",
			title: "运维观测",
			documentTitle: "运维观测 · Agora Agent",
		},
	])(
		"derives one current item, breadcrumb and document title from the route table at $entry",
		async ({ entry, group, label, parent, title, documentTitle }) => {
			await showShell(true, entry);
			const main = screen.getByRole("navigation", { name: "主导航" });
			// 每条路由恰好一个当前导航项（N-16、N-21）。
			const current = main.querySelectorAll('[aria-current="page"]');
			expect(current).toHaveLength(1);
			expect(current[0]?.textContent).toBe(label);
			expect(current[0]?.closest("nav")?.getAttribute("aria-label")).toBe(
				group,
			);
			expect(main.querySelectorAll(".selected")).toHaveLength(1);
			const breadcrumb = screen.getByRole("navigation", { name: "breadcrumb" });
			expect(
				[...breadcrumb.querySelectorAll('[data-slot="breadcrumb-item"]')].map(
					(item) => item.textContent,
				),
			).toEqual([parent, title]);
			expect(document.title).toBe(documentTitle);
			cleanup();
		},
	);

	it("updates the document title after client-side navigation", async () => {
		await showShell(false, "/my-agents/new");
		expect(document.title).toBe("创建申请 · Agora Agent");
		const work = screen.getByRole("navigation", { name: "工作区" });
		fireEvent.click(within(work).getByRole("link", { name: "工作台" }));
		await screen.findByRole("heading", { name: "受控工作台" });
		expect(document.title).toBe("Agora Agent · Platform");
		fireEvent.click(within(work).getByRole("link", { name: "Skill Hub" }));
		await waitFor(() => expect(document.title).toBe("Skill Hub · Agora Agent"));
	});

	it("titles an unregistered route as not found instead of guessing a prefix", async () => {
		await showShell(true, "/admin/no-such-page");
		await screen.findByRole("heading", { level: 1, name: "页面不存在" });
		expect(document.title).toBe("页面不存在 · Agora Agent");
		expect(
			screen
				.getByRole("navigation", { name: "主导航" })
				.querySelectorAll('[aria-current="page"]'),
		).toHaveLength(0);
	});
});
