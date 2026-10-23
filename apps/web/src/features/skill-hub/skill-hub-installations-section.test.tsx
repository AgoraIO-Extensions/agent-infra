import { SkillHubInstallationListItemV1Schema } from "@agent-infra/contracts/pilot";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
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
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast";
import { MyInstallationsSection } from "./skill-hub-installations-section.js";

afterEach(cleanup);

const visible = SkillHubInstallationListItemV1Schema.parse({
	installationId: "installation-notes",
	skillVersionId: "release-notes-v1",
	needUpgrade: true,
	installedAt: "2026-10-01T08:00:00Z",
	updatedAt: "2026-10-01T08:00:00Z",
	version: {
		access: "visible",
		skillId: "release-notes",
		name: "release-notes",
		version: "1.2.0",
		provider: "market",
		visibility: "MARKET",
		state: "published",
	},
});
const revoked = SkillHubInstallationListItemV1Schema.parse({
	...visible,
	installationId: "installation-old",
	skillVersionId: "old-v1",
	needUpgrade: false,
	version: {
		...visible.version,
		name: "old",
		version: "0.9.0",
		state: "revoked",
	},
});
const hidden = SkillHubInstallationListItemV1Schema.parse({
	...visible,
	installationId: "installation-hidden",
	skillVersionId: "hidden-v1",
	needUpgrade: false,
	version: { access: "unavailable" },
});

async function renderWithRouter(content: ReactNode) {
	const root = createRootRoute();
	const routes = [
		createRoute({
			getParentRoute: () => root,
			path: "/",
			component: () => content,
		}),
		...["/skills", "/skills/$skillVersionId", "/my-agents"].map((path) =>
			createRoute({ getParentRoute: () => root, path, component: () => null }),
		),
	];
	const router = createRouter({
		history: createMemoryHistory({ initialEntries: ["/"] }),
		routeTree: root.addChildren(routes),
	});
	await router.load();
	render(
		<ToastProvider>
			<RouterProvider router={router} />
		</ToastProvider>,
	);
}

const rows = () =>
	[...document.querySelectorAll("article.skill-row")] as HTMLElement[];

describe("MyInstallationsSection (#2953)", () => {
	it("lists the user's installations with Chinese state and no internal IDs", async () => {
		await renderWithRouter(
			<MyInstallationsSection
				installations={{
					kind: "ready",
					installations: [visible, revoked, hidden],
				}}
			/>,
		);
		// V-15：区块标题为「已安装」，区头右侧是 outline「Agent 绑定」，直达「已创建」标签页。
		expect(
			screen.getByRole("heading", { level: 2, name: "已安装" }),
		).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "Agent 绑定" }).getAttribute("href"),
		).toBe("/my-agents?tab=owned");
		expect(rows().map((row) => row.querySelector("h3")?.textContent)).toEqual([
			"release-notes",
			"old",
			"版本不可用",
		]);
		const [notes, old, unavailable] = rows() as [
			HTMLElement,
			HTMLElement,
			HTMLElement,
		];
		expect(within(notes).getByText("v1.2.0")).toBeTruthy();
		expect(within(notes).getByText("有新版本")).toBeTruthy();
		expect(notes.textContent).toContain("内部市场");
		expect(
			within(notes)
				.getByRole("link", { name: "查看：release-notes" })
				.getAttribute("href"),
		).toBe("/skills/release-notes-v1");
		expect(within(old).getByText("已撤销")).toBeTruthy();
		// 不可见的版本只给安装事实：没有名称、版本号与详情入口，仍可移出。
		expect(within(unavailable).getByText("当前无权查看")).toBeTruthy();
		expect(within(unavailable).queryByRole("link")).toBeNull();
		expect(
			within(unavailable).getByRole("button", {
				name: "移出我的库：版本不可用",
			}),
		).toBeTruthy();
		const text = document.body.textContent ?? "";
		for (const internal of [
			"installation-",
			"hidden-v1",
			"release-notes-v1",
			"MARKET",
			"published",
			"revoked",
		])
			expect(text).not.toContain(internal);
	});

	it("removes an installation, hides it, focuses the heading and re-reads the list", async () => {
		const uninstall = vi.fn().mockResolvedValue({});
		const onChanged = vi.fn();
		await renderWithRouter(
			<MyInstallationsSection
				installations={{ kind: "ready", installations: [visible, revoked] }}
				uninstall={uninstall}
				onChanged={onChanged}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "移出我的库：release-notes" }),
		);
		await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
		expect(uninstall).toHaveBeenCalledWith(
			"installation-notes",
			expect.any(String),
		);
		expect(rows().map((row) => row.querySelector("h3")?.textContent)).toEqual([
			"old",
		]);
		expect(document.activeElement?.textContent).toBe("已安装");
		expect(await screen.findByText("已移出我的库")).toBeTruthy();
	});

	it("reuses the idempotency key when a failed removal is retried", async () => {
		const uninstall = vi
			.fn()
			.mockRejectedValueOnce(
				Object.assign(new Error("temporary"), { status: 503 }),
			)
			.mockResolvedValueOnce({});
		const onChanged = vi.fn();
		await renderWithRouter(
			<MyInstallationsSection
				installations={{ kind: "ready", installations: [visible] }}
				uninstall={uninstall}
				onChanged={onChanged}
			/>,
		);
		const button = () =>
			screen.getByRole("button", { name: "移出我的库：release-notes" });
		fireEvent.click(button());
		expect((await screen.findByRole("alert")).textContent).toBe(
			"暂时无法移出我的库，请稍后重试。",
		);
		expect(onChanged).not.toHaveBeenCalled();
		expect(rows()).toHaveLength(1);
		fireEvent.click(button());
		await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
		expect(uninstall).toHaveBeenCalledTimes(2);
		expect(uninstall.mock.calls[1]?.[1]).toBe(uninstall.mock.calls[0]?.[1]);
		expect(screen.getByText("我的库还是空的")).toBeTruthy();
	});

	it("re-reads the list when the installation no longer exists", async () => {
		const uninstall = vi
			.fn()
			.mockRejectedValue(Object.assign(new Error("gone"), { status: 404 }));
		const onChanged = vi.fn();
		await renderWithRouter(
			<MyInstallationsSection
				installations={{ kind: "ready", installations: [visible] }}
				uninstall={uninstall}
				onChanged={onChanged}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "移出我的库：release-notes" }),
		);
		expect((await screen.findByRole("alert")).textContent).toBe(
			"我的库状态已变化，列表已重新读取。",
		);
		expect(onChanged).toHaveBeenCalledOnce();
	});

	it("shows loading, empty, retryable and denied states", async () => {
		await renderWithRouter(
			<MyInstallationsSection installations={{ kind: "loading" }} />,
		);
		expect(screen.getByText("正在读取已安装的 Skill…")).toBeTruthy();
		cleanup();
		await renderWithRouter(
			<MyInstallationsSection
				installations={{ kind: "ready", installations: [] }}
			/>,
		);
		expect(screen.getByText("我的库还是空的")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "浏览 Skill Hub" }).getAttribute("href"),
		).toBe("/skills");
		cleanup();
		const retry = vi.fn();
		await renderWithRouter(
			<MyInstallationsSection
				installations={{ kind: "unavailable", retryable: true }}
				onRetry={retry}
			/>,
		);
		// 需求变化（#3292 N9-3-05）：与「我创建的」同时失败时按钮可区分，名称带分区名，可见文字不变。
		const reread = screen.getByRole("button", { name: "重新读取：已安装" });
		expect(reread.textContent).toBe("重新读取");
		fireEvent.click(reread);
		expect(retry).toHaveBeenCalledOnce();
		cleanup();
		// 401 不说成要找管理员：「登录已过期」与「重新登录：已安装」（#3292 N9-3-04）。
		const relogin = vi.fn();
		await renderWithRouter(
			<MyInstallationsSection
				installations={{
					kind: "unavailable",
					retryable: false,
					reason: "authentication-required",
				}}
				onRelogin={relogin}
			/>,
		);
		const expired = screen.getByRole("alert");
		expect(expired.textContent).toContain("登录已过期");
		expect(expired.textContent).toContain("登录状态已失效，请重新登录后再试。");
		expect(screen.queryByText(/请联系管理员/)).toBeNull();
		const login = screen.getByRole("button", { name: "重新登录：已安装" });
		expect(login.textContent).toBe("重新登录");
		fireEvent.click(login);
		expect(relogin).toHaveBeenCalledOnce();
		cleanup();
		await renderWithRouter(
			<MyInstallationsSection
				installations={{
					kind: "unavailable",
					retryable: false,
					reason: "denied",
				}}
			/>,
		);
		expect(
			screen.getByText("当前账号没有读取已安装 Skill 的权限。"),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: /^重新读取/ })).toBeNull();
	});
});
