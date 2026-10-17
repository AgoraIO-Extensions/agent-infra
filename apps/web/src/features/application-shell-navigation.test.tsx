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
	document.title = "Agent Infra";
	vi.unstubAllGlobals();
});

async function showShell(
	administrator: boolean,
	initialEntry = "/agents",
	ready = true,
) {
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
	client.setQueryData(
		["browser-session"],
		ready
			? {
					kind: "ready",
					sessionGeneration: "g".repeat(43),
					session: {
						schemaVersion: 1,
						user: {
							userId: "controlled-person",
							displayName: "受控用户",
							roles: administrator
								? ["employee", "system_admin"]
								: ["employee"],
						},
					},
				}
			: { kind: "unavailable", retryable: false },
	);
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
	if (ready) await screen.findByRole("navigation", { name: "工作区" });
	else await screen.findByRole("heading", { name: "登录工作空间" });
	return { history, client };
}

describe("Original IA workbench navigation", () => {
	it("updates the document title from the active route", async () => {
		await showShell(false, "/agents");
		expect(document.title).toBe("Agent 目录 · Agent Infra");
	});

	it("uses a standalone login screen without the application shell", async () => {
		await showShell(false, "/agents", false);
		expect(screen.getByRole("heading", { name: "登录工作空间" })).toBeTruthy();
		expect(screen.queryByRole("navigation", { name: "工作区" })).toBeNull();
	});

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
			label: "API 凭证与应用",
			title: "API 凭证与应用",
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
			label: "API 凭证与应用",
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
});
