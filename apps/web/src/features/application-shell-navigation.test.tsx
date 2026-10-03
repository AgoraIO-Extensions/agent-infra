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
});
