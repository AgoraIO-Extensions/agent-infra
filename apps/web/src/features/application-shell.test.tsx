import {
	QueryClient,
	QueryClientProvider,
	useQueryClient,
} from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { type ReactNode, StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApplicationShell,
	safeDeploymentUrl,
	useApplicationSession,
} from "./application-shell";
import { useSessionRecheck } from "./session-recheck";
import { useBrowserSession } from "./use-browser-session";

// 受控路由位置：useLocation 按 select 读取，useRouter 只暴露 history.replace。
const routerLocation = vi.hoisted(() => ({
	pathname: "/agents",
	search: {} as Record<string, unknown>,
	searchStr: "",
	href: "/agents",
}));
const router = vi.hoisted(() => ({
	history: {
		get location() {
			return {
				pathname: routerLocation.pathname,
				search: routerLocation.searchStr,
				hash: "",
			};
		},
		replace: vi.fn(),
	},
}));
vi.mock("@tanstack/react-router", () => ({
	useLocation: ({
		select,
	}: {
		select?: (location: typeof routerLocation) => unknown;
	} = {}) => (select ? select(routerLocation) : routerLocation),
	useRouter: () => router,
	useRouterState: () => false,
	Link: ({ children, to }: { children: ReactNode; to: string }) => (
		<a href={to}>{children}</a>
	),
	// 品牌链接用 useLinkProps 自行渲染 <a>（N-21）。
	useLinkProps: ({ to }: { to: string }) => ({ href: to }),
}));
function setLocation(search: Record<string, string> = {}) {
	const params = new URLSearchParams(search);
	routerLocation.search = { ...search };
	routerLocation.searchStr = params.size ? `?${params}` : "";
	routerLocation.href = `${routerLocation.pathname}${routerLocation.searchStr}`;
}
const sessionLoader = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./browser-session", async (importOriginal) => ({
	...(await importOriginal<typeof import("./browser-session")>()),
	loadBrowserSession: () => sessionLoader.load(),
}));
beforeEach(() => {
	setLocation();
	router.history.replace.mockReset();
	sessionLoader.load.mockReset();
	sessionLoader.load.mockImplementation(() => new Promise(() => {}));
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
const identity = (
	userId: string,
	admin = false,
	sessionGeneration?: string,
	connection?: {
		status: "available";
		schemaVersion: 1;
		publicOrigin: string;
		mcpPath: string;
		configFingerprint: string;
	},
) => ({
	kind: "ready",
	session: {
		schemaVersion: 1,
		user: {
			userId,
			displayName: userId,
			roles: admin ? ["employee", "system_admin"] : ["employee"],
		},
	},
	...(connection ? { connection } : {}),
	...(sessionGeneration ? { sessionGeneration } : {}),
});
afterEach(() => {
	cleanup();
	for (const client of clients) client.clear();
	clients.length = 0;
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});
function setup(initial: unknown, children: ReactNode = <p>受保护内容</p>) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
		},
	});
	clients.push(client);
	if (initial !== undefined) client.setQueryData(["browser-session"], initial);
	render(
		<StrictMode>
			<QueryClientProvider client={client}>
				<ApplicationShell>{children}</ApplicationShell>
			</QueryClientProvider>
		</StrictMode>,
	);
	return client;
}
const anonymous = { kind: "unavailable", retryable: false } as const;
const sessionError = (retryable: boolean) =>
	Object.assign(new Error("controlled session failure"), { retryable });
/** 单元测试不发真实请求：会话读取由受控 loader 返回或挂起。 */
function stubSessionReads(read: () => Promise<unknown>) {
	sessionLoader.load.mockImplementation(read);
	return sessionLoader.load;
}
function mainContent() {
	const main = document.getElementById("main-content");
	if (!main) throw new Error("main content is missing");
	return within(main);
}
describe("application session boundary", () => {
	it("gates all protected content when anonymous and removes it on logout", async () => {
		const client = setup(anonymous);
		expect(screen.queryByText("受保护内容")).toBeNull();
		// L-01：确认未登录时整页为独立登录页，标题按 login.html 为「登录工作区」。
		expect(screen.getByRole("heading", { name: "登录工作区" })).toBeTruthy();
		// F-10：未登录时标签页标题与设计稿登录页一致。
		expect(document.title).toBe("登录 · Agora Agent");
		await act(async () => {
			client.setQueryData(["browser-session"], identity("owner"));
		});
		await screen.findByText("受保护内容");
		expect(document.title).not.toBe("登录 · Agora Agent");
		expect(document.title).toMatch(/ · Agora Agent$/);
		await act(async () => {
			client.setQueryData(["browser-session"], {
				kind: "unavailable",
				retryable: false,
			});
		});
		await waitFor(() => expect(screen.queryByText("受保护内容")).toBeNull());
	});
	it("uses a fresh feature cache for another user while sharing the authoritative session", async () => {
		const observed: { user: string; cached: unknown; client: QueryClient }[] =
			[];
		function Probe() {
			const { session } = useApplicationSession();
			const cache = useQueryClient();
			const nested = useBrowserSession();
			observed.push({
				user: session.user.userId,
				cached: cache.getQueryData(["private"]),
				client: cache,
			});
			return (
				<p>
					{nested.state.kind === "ready"
						? `nested-${nested.state.session.user.userId}`
						: "no-session"}
				</p>
			);
		}
		const client = setup(identity("owner"), <Probe />);
		await screen.findByText("nested-owner");
		const old = observed[0]?.client;
		old?.setQueryData(["private"], "owner-secret");
		await act(async () => {
			client.setQueryData(["browser-session"], identity("admin", true));
		});
		await screen.findByText("nested-admin");
		expect(
			observed
				.filter((entry) => entry.user === "admin")
				.every((entry) => entry.cached === undefined && entry.client !== old),
		).toBe(true);
		expect(old?.getQueryData(["private"])).toBeUndefined();
		expect(screen.getByRole("link", { name: "创建审批" })).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "Agent 管理" }).getAttribute("href"),
		).toBe("/admin/agents");
		for (const name of ["工作区", "我的管理", "系统管理"])
			expect(screen.getByRole("navigation", { name })).toBeTruthy();
		await act(async () => {
			client.setQueryData(["browser-session"], identity("admin", false));
		});
		await waitFor(() =>
			expect(screen.queryByRole("link", { name: "创建审批" })).toBeNull(),
		);
	});
	it("recreates the feature cache when the same user gets a new session", async () => {
		const observed: { user: string; cached: unknown; client: QueryClient }[] =
			[];
		function Probe() {
			const { session } = useApplicationSession();
			const cache = useQueryClient();
			observed.push({
				user: session.user.userId,
				cached: cache.getQueryData(["private"]),
				client: cache,
			});
			return <p>{session.user.userId}</p>;
		}
		const client = setup(identity("owner"), <Probe />);
		await waitFor(() => expect(observed.length).toBeGreaterThan(0));
		const old = observed.at(-1)?.client;
		old?.setQueryData(["private"], "old-session-secret");
		await act(async () => {
			const next = identity("owner");
			next.session.user.displayName = "owner-again";
			client.setQueryData(["browser-session"], next);
		});
		await waitFor(() =>
			expect(
				observed.some(
					(entry) =>
						entry.user === "owner" &&
						entry.client !== old &&
						entry.cached === undefined,
				),
			).toBe(true),
		);
		expect(old?.getQueryData(["private"])).toBeUndefined();
	});
	it("uses the server session generation when the projection is unchanged", async () => {
		const observed: QueryClient[] = [];
		function Probe() {
			observed.push(useQueryClient());
			return <p>受保护内容</p>;
		}
		const client = setup(identity("owner", false, "generation-1"), <Probe />);
		await screen.findByText("受保护内容");
		const old = observed.at(-1);
		old?.setQueryData(["private"], "old-session-secret");
		await act(async () => {
			client.setQueryData(
				["browser-session"],
				identity("owner", false, "generation-2"),
			);
		});
		await waitFor(() =>
			expect(
				observed.some(
					(value) =>
						value !== old && value.getQueryData(["private"]) === undefined,
				),
			).toBe(true),
		);
		expect(old?.getQueryData(["private"])).toBeUndefined();
	});
	it.each([
		{ fromAdmin: true, toAdmin: false },
		{ fromAdmin: false, toAdmin: true },
	])(
		"clears feature cache and drafts when admin changes from $fromAdmin to $toAdmin within one session generation",
		async ({ fromAdmin, toAdmin }) => {
			const observed: { client: QueryClient; identityKey: string }[] = [];
			function Probe() {
				const cache = useQueryClient();
				const { identityKey } = useApplicationSession();
				const [draft, setDraft] = useState("");
				observed.push({ client: cache, identityKey });
				return (
					<input
						aria-label="Private draft"
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
					/>
				);
			}
			const generation = "g".repeat(43);
			const client = setup(
				identity("same-user", fromAdmin, generation),
				<Probe />,
			);
			const old = observed.at(-1);
			expect(old).toBeDefined();
			old?.client.setQueryData(["private"], "previous-role-cache");
			fireEvent.change(screen.getByLabelText("Private draft"), {
				target: { value: "previous-role-draft" },
			});
			await act(async () => {
				client.setQueryData(
					["browser-session"],
					identity("same-user", toAdmin, generation),
				);
			});
			await waitFor(() => {
				expect(Boolean(screen.queryByRole("link", { name: "创建审批" }))).toBe(
					toAdmin,
				);
			});
			expect(old?.client.getQueryData(["private"])).toBeUndefined();
			expect(observed.at(-1)?.client).not.toBe(old?.client);
			expect(observed.at(-1)?.identityKey).not.toBe(old?.identityKey);
			expect(
				(screen.getByLabelText("Private draft") as HTMLInputElement).value,
			).toBe("");
		},
	);
});
describe("deployment links", () => {
	it("uses the server session capability for the Connection entry", () => {
		setup(
			identity("owner", false, undefined, {
				status: "available",
				schemaVersion: 1,
				publicOrigin: "https://connection.example.test",
				mcpPath: "/mcp",
				configFingerprint: "a".repeat(64),
			}),
		);
		expect(
			screen
				.getByRole("link", { name: /我的 Connection/ })
				.getAttribute("href"),
		).toBe("https://connection.example.test/mcp");
		// Y-01：key 与外链图标都按设计 .nav-item svg 统一为 17px。
		const icons = screen
			.getByRole("link", { name: /我的 Connection/ })
			.querySelectorAll("svg");
		expect(
			Array.from(icons).map((icon) => [
				icon.getAttribute("width"),
				icon.getAttribute("height"),
				icon.getAttribute("aria-hidden"),
			]),
		).toEqual([
			["17", "17", "true"],
			["17", "17", "true"],
		]);
	});

	it.each([
		undefined,
		"missing",
		"invalid",
		"unapproved",
		"unavailable",
	] as const)(
		"keeps an unavailable Connection entry (%s) on one line without an outbound link or raw reason",
		(reason) => {
			setup({
				...identity("user-1"),
				...(reason
					? { connection: { schemaVersion: 1, status: "unavailable", reason } }
					: {}),
			});
			// 设计稿：单行「我的 Connection」+ 灰色 chip，不再拼接「（暂不可用）」（S-08）。
			const entry = screen.getByText("我的 Connection");
			expect(entry.getAttribute("aria-disabled")).toBe("true");
			expect(entry.hasAttribute("title")).toBe(false);
			expect(entry.querySelector('[data-slot="badge"]')?.textContent).toBe(
				"不可用",
			);
			const description = document.getElementById(
				entry.getAttribute("aria-describedby") ?? "",
			);
			expect(description?.textContent).toBe("Connection 服务当前不可用。");
			expect(screen.queryByText(/我的 Connection（暂不可用）/)).toBeNull();
			expect(document.body.textContent).not.toContain("Connection:");
			if (reason && reason !== "unavailable")
				expect(document.body.textContent).not.toContain(reason);
			expect(
				screen.queryByRole("link", { name: /我的 Connection/ }),
			).toBeNull();
		},
	);
	it("does not invent a platform health state without a server projection", () => {
		setup(identity("user-1"));
		// S-01：服务端尚无平台健康投影，顶栏不得伪造「平台就绪」。
		expect(screen.queryByText("平台就绪")).toBeNull();
		expect(document.querySelector(".platform-topbar")?.textContent).not.toMatch(
			/就绪/,
		);
	});
	it.each([
		["https://connection.example.test", "//evil.example/mcp"],
		["https://connection.example.test", "/\\evil.example/mcp"],
		["https://connection.example.test", "\\\\evil.example\\mcp"],
		["https://connection.example.test\n", "/mcp"],
		["https://connection.example.test/", "/mcp"],
		["http://connection.example.test", "/mcp"],
		["https://user:pass@connection.example.test", "/mcp"],
		["https://connection.example.test", "/mcp?next=/evil"],
	])(
		"does not link the sidebar Connection entry for %j + %j (NI-68)",
		(publicOrigin, mcpPath) => {
			setup(
				identity("user-1", false, undefined, {
					status: "available",
					schemaVersion: 1,
					publicOrigin,
					mcpPath,
					configFingerprint: "a".repeat(64),
				}),
			);
			expect(
				screen.queryByRole("link", { name: /我的 Connection/ }),
			).toBeNull();
			expect(
				document.querySelector('a[href*="evil.example"], a[href^="http:"]'),
			).toBeNull();
		},
	);
	it.each(["/\n/evil.test", "/\t/evil.test", "/\r/evil.test"])(
		"does not normalize unsafe path %j into an external link",
		(mcpPath) => {
			setup(
				identity("user-1", false, undefined, {
					status: "available",
					schemaVersion: 1,
					publicOrigin: "https://connection.example.test",
					mcpPath,
					configFingerprint: "a".repeat(64),
				}),
			);
			expect(
				screen.queryByRole("link", { name: /我的 Connection/ }),
			).toBeNull();
		},
	);
	it("accepts configured HTTPS or local paths and rejects executable or ambiguous URLs", () => {
		expect(safeDeploymentUrl("/__local/login")).toBe("/__local/login");
		expect(safeDeploymentUrl("https://identity.example.test/login")).toBe(
			"https://identity.example.test/login",
		);
		for (const value of [
			"//evil.test",
			"javascript:alert(1)",
			"https://user:password@example.test",
			"http://example.test",
			" /login",
			"/\\evil.test",
		])
			expect(safeDeploymentUrl(value)).toBeUndefined();
	});
});

describe("standalone login page", () => {
	it("renders without the application shell once the session is confirmed anonymous (L-01, L-03)", () => {
		vi.stubEnv("VITE_PLATFORM_LOGIN_URL", "/auth/login");
		setup(anonymous);
		expect(screen.queryByRole("navigation", { name: "主导航" })).toBeNull();
		expect(screen.queryByRole("navigation", { name: "breadcrumb" })).toBeNull();
		expect(document.querySelector(".platform-sidebar")).toBeNull();
		expect(document.querySelector(".platform-topbar")).toBeNull();
		for (const text of ["尚未登录", "登录后进入工作空间", "访"])
			expect(screen.queryByText(text)).toBeNull();
		const brand = document.querySelector(".login-brand");
		expect(brand?.textContent).toBe("AAgora Agent");
		expect(
			brand?.querySelector(".login-brand-mark")?.getAttribute("aria-hidden"),
		).toBe("true");
		expect(screen.getByText("企业内部工作区")).toBeTruthy();
		expect(
			screen.getByRole("heading", { level: 1, name: "登录工作区" }),
		).toBeTruthy();
		expect(screen.getByText("公司账号", { selector: "p" })).toBeTruthy();
		expect(screen.getByText("使用公司账号登录。")).toBeTruthy();
		expect(
			screen.getByText("账号由公司管理。无法登录时联系 IT 支持。"),
		).toBeTruthy();
		expect(screen.getByText("仅限公司授权账号访问。")).toBeTruthy();
		expect(screen.getByRole("textbox", { name: "公司账号" })).toBeTruthy();
		// NI-44：不再出现等宽 kicker 与面板内的第二个品牌标。
		expect(document.body.textContent).not.toContain("AGORA AGENT PLATFORM");
		expect(document.querySelectorAll(".login-brand-mark")).toHaveLength(1);
		// 设计原型里的示例入口不进入生产页面。
		expect(screen.queryByText(/界面示例|查看登录示例/)).toBeNull();
		// 登录页不放「重新检查」（L-02）。
		expect(screen.queryByRole("button", { name: "重新检查" })).toBeNull();
		expect(screen.queryByText("登录已过期，请重新登录")).toBeNull();
		expect(document.title).toBe("登录 · Agora Agent");
	});

	it("explains a missing login entry inside the same panel", () => {
		setup(anonymous);
		const panel = document.querySelector(".login-panel");
		expect(panel?.textContent).toContain("登录入口尚未配置。");
		expect(screen.queryByRole("textbox", { name: "公司账号" })).toBeNull();
	});

	it("shows the expiry notice when a ready session becomes anonymous without logout (L-06)", async () => {
		const client = setup(identity("owner"));
		await screen.findByText("受保护内容");
		await act(async () => {
			client.setQueryData(["browser-session"], anonymous);
		});
		const notice = await screen.findByRole("status");
		expect(notice.textContent).toBe(
			"登录已过期，请重新登录已提交的任务会继续处理。",
		);
		expect(notice.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
			"true",
		);
		expect(notice.querySelector("strong")?.textContent).toBe(
			"登录已过期，请重新登录",
		);
		// 过期提示不替换 lead（NI-109）。
		expect(screen.getByText("使用公司账号登录。")).toBeTruthy();
		await act(async () => {
			client.setQueryData(["browser-session"], identity("owner"));
		});
		await screen.findByText("受保护内容");
		await act(async () => {
			client.setQueryData(["browser-session"], anonymous);
		});
		await screen.findByText("登录已过期，请重新登录");
	});

	it("does not call an explicit logout an expired session", async () => {
		vi.stubEnv("VITE_PLATFORM_LOGOUT_URL", "/auth/logout");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 204 })),
		);
		stubSessionReads(async () => anonymous);
		setup(identity("owner"));
		await screen.findByText("受保护内容");
		fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
		await screen.findByRole("heading", { name: "登录工作区" });
		expect(screen.queryByText("登录已过期，请重新登录")).toBeNull();
	});

	it("shows the expiry notice for reason=expired only on the confirmed login page", () => {
		setLocation({ reason: "expired", tab: "owned" });
		setup(anonymous);
		expect(screen.getByRole("status").textContent).toContain(
			"登录已过期，请重新登录",
		);
		expect(screen.getByText("使用公司账号登录。")).toBeTruthy();
		expect(router.history.replace).not.toHaveBeenCalled();
	});

	it("drops only the reason parameter once the session is ready", async () => {
		setLocation({ reason: "expired", tab: "owned" });
		setup(identity("owner"));
		await screen.findByText("受保护内容");
		await waitFor(() =>
			expect(router.history.replace).toHaveBeenCalledWith("/agents?tab=owned"),
		);
	});
});

// #3327 N10-1-01：页面的「重新登录」（useSessionRecheck）确认会话已失效后，壳层整页换成登录页，
// 焦点同主动退出交给第一个登录控件：生产为「公司账号」，受控开发模式为「选择开发测试身份」，
// 未配置登录入口时为「登录工作区」标题；直接打开登录页（新文档）时不抢焦点。
describe("focus after a re-login finds the session expired", () => {
	function Relogin() {
		const relogin = useSessionRecheck(vi.fn());
		return (
			<button type="button" onClick={() => void relogin.recheck()}>
				重新登录
			</button>
		);
	}
	it.each([
		{
			name: "production login entry",
			env: { VITE_PLATFORM_LOGIN_URL: "/auth/login" },
			target: () => screen.getByRole("textbox", { name: "公司账号" }),
		},
		{
			name: "controlled development mode",
			env: {
				VITE_PLATFORM_LOGIN_URL: "/dev/login",
				VITE_PLATFORM_DEVELOPMENT_MODE: "controlled",
			},
			target: () => screen.getByRole("link", { name: "选择开发测试身份" }),
		},
		{
			name: "no login entry",
			env: {},
			target: () =>
				screen.getByRole("heading", { level: 1, name: "登录工作区" }),
		},
	])("hands focus to the login page ($name)", async ({ env, target }) => {
		for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
		stubSessionReads(async () => anonymous);
		setup(identity("owner"), <Relogin />);
		const button = await screen.findByRole("button", { name: "重新登录" });
		button.focus();
		fireEvent.click(button);
		await screen.findByRole("heading", { level: 1, name: "登录工作区" });
		expect(screen.getByRole("status").textContent).toContain(
			"登录已过期，请重新登录",
		);
		await waitFor(() => expect(document.activeElement).toBe(target()));
	});

	it("does not take focus on a directly opened login page", async () => {
		vi.stubEnv("VITE_PLATFORM_LOGIN_URL", "/auth/login");
		setLocation({ reason: "expired" });
		setup(anonymous);
		await screen.findByRole("heading", { level: 1, name: "登录工作区" });
		await act(async () => {
			await new Promise((resolve) => window.setTimeout(resolve, 20));
		});
		expect(document.activeElement).toBe(document.body);
	});
});

describe("session confirmation shell", () => {
	it("renders a shell skeleton instead of the login page while confirming (R4-02)", () => {
		setup(undefined);
		expect(screen.queryByRole("heading", { name: /登录工作/ })).toBeNull();
		expect(screen.queryByRole("textbox")).toBeNull();
		for (const text of ["尚未登录", "登录后进入工作空间", "访"])
			expect(screen.queryByText(text)).toBeNull();
		// 侧栏只有 aria-hidden 的品牌块与占位行，不渲染可点击的导航项。
		const sidebar = document.querySelector(".platform-sidebar");
		expect(sidebar?.querySelectorAll("a, button")).toHaveLength(0);
		expect(sidebar?.querySelector(".platform-brand")).toBeTruthy();
		expect(
			sidebar?.querySelectorAll(".platform-nav-skeleton .platform-nav-item"),
		).toHaveLength(11);
		expect(screen.queryByRole("navigation", { name: "主导航" })).toBeNull();
		// 顶栏保留同位置的菜单占位与目标页面包屑。
		expect(
			document.querySelector(".platform-topbar .platform-menu-placeholder"),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "打开导航" })).toBeNull();
		expect(
			within(screen.getByRole("navigation", { name: "breadcrumb" })).getByText(
				"Agent 目录",
			),
		).toBeTruthy();
		const statuses = mainContent().getAllByRole("status");
		expect(statuses).toHaveLength(1);
		expect(statuses[0]?.textContent).toBe("正在确认登录状态…");
		expect(statuses[0]?.querySelector('[data-slot="spinner"]')).toBeTruthy();
		expect(document.title).toBe("Agent 目录 · Agora Agent");
	});

	it("keeps confirmation copy when reason=expired is present (NI-109)", () => {
		setLocation({ reason: "expired" });
		setup(undefined);
		expect(mainContent().getByRole("status").textContent).toBe(
			"正在确认登录状态…",
		);
		expect(screen.queryByText(/登录已过期/)).toBeNull();
	});

	it("shows an unavailable card with a recheck action after a retryable failure (R4-02, NI-109)", async () => {
		setLocation({ reason: "expired" });
		let available = false;
		const reads = stubSessionReads(async () => {
			if (available) return identity("owner");
			throw sessionError(true);
		});
		setup(undefined);
		const card = await mainContent().findByRole("alert");
		expect(
			within(card).getByRole("heading", { level: 1, name: "服务暂不可用" }),
		).toBeTruthy();
		expect(card.textContent).toContain("暂时无法确认登录状态，请稍后重试。");
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(screen.queryByRole("heading", { name: /登录工作/ })).toBeNull();
		expect(screen.queryByText(/登录已过期/)).toBeNull();
		expect(document.title).toBe("Agent 目录 · Agora Agent");
		available = true;
		const sessionReads = reads.mock.calls.length;
		fireEvent.click(within(card).getByRole("button", { name: "重新检查" }));
		await screen.findByText("受保护内容");
		expect(reads.mock.calls.length).toBeGreaterThan(sessionReads);
	});
});
