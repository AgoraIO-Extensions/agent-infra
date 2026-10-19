import { SkillHubVersionMetadataV1Schema } from "@agent-infra/contracts/pilot";
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
import { type ReactNode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast";
import type { SkillHubPublicationResponseV1 } from "../../pilot/generated-v2/types.gen.js";
import {
	type SkillDetailTab,
	type SkillHubVersionActions,
	SkillHubVersionScreen,
} from "./skill-hub-version-screen.js";

const v1 = SkillHubVersionMetadataV1Schema.parse({
	schemaVersion: 1,
	skillId: "release-notes",
	skillVersionId: "release-notes-v1",
	provider: "my_library",
	version: "1.0.0",
	packageDigest: "a".repeat(64),
	manifestDigest: "b".repeat(64),
	signatureDigest: "c".repeat(64),
	name: "release-notes",
	visibility: "PRIVATE",
	state: "published",
});
const v2 = SkillHubVersionMetadataV1Schema.parse({
	...v1,
	skillVersionId: "release-notes-v2",
	version: "1.2.0",
});
const other = SkillHubVersionMetadataV1Schema.parse({
	...v1,
	skillId: "incident-summary",
	skillVersionId: "incident-summary-v1",
	name: "incident-summary",
});

function revoked(version: typeof v1 = v2): SkillHubPublicationResponseV1 {
	return {
		replayed: false,
		version: {
			schemaVersion: 1,
			skillId: version.skillId,
			skillVersionId: version.skillVersionId,
			provider: version.provider,
			version: version.version,
			packageDigest: version.packageDigest,
			manifestDigest: version.manifestDigest,
			signatureDigest: version.signatureDigest,
			visibility: version.visibility,
			state: "revoked",
			needUpgrade: false,
			reviewedBy: null,
			reviewReason: null,
			revokedAt: "2026-10-18T00:00:00Z",
		},
	};
}

function requestError(status: number) {
	return Object.assign(new Error("controlled"), {
		status,
		code: status === 403 ? "AUTHORIZATION_REVOKED" : "CONFLICT",
		retryable: status === 503,
	});
}

afterEach(cleanup);

function actions(overrides: Partial<SkillHubVersionActions> = {}) {
	return {
		install: vi.fn<SkillHubVersionActions["install"]>(),
		revoke: vi.fn<SkillHubVersionActions["revoke"]>(),
		...overrides,
	};
}

async function renderDetail({
	owned = false,
	initialTab = "overview",
	act: detailActions = actions(),
}: {
	owned?: boolean;
	initialTab?: SkillDetailTab;
	act?: ReturnType<typeof actions>;
} = {}) {
	function Detail() {
		const [tab, setTab] = useState<SkillDetailTab>(initialTab);
		return (
			<SkillHubVersionScreen
				state={{ kind: "ready", version: v2 }}
				catalog={{ kind: "ready", versions: [v1, other, v2] }}
				tab={tab}
				onTabChange={setTab}
				owned={owned}
				actions={detailActions}
			/>
		);
	}
	await renderWithRouter(<Detail />);
	return detailActions;
}

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
	return router;
}

describe("SkillHubVersionScreen", () => {
	it("keeps internal IDs and digests out of the detail and shows the design summary", async () => {
		await renderDetail();
		expect(
			screen.getByRole("heading", { level: 1, name: "release-notes" }),
		).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "返回 Skill Hub" }).getAttribute("href"),
		).toBe("/skills");
		const text = document.body.textContent ?? "";
		for (const hidden of [
			"版本 ID",
			"Skill ID",
			"Manifest 摘要",
			"签名摘要",
			"metadata",
			"release-notes-v",
			"a".repeat(64),
			"文件权限",
			"发布者",
		])
			expect(text).not.toContain(hidden);
		const summary = screen.getByRole("complementary", { name: "版本与权限" });
		expect(
			[...summary.querySelectorAll("dt")].map((item) => item.textContent),
		).toEqual(["版本", "发布状态", "来源", "可见范围", "脚本", "网络权限"]);
		expect(
			[...summary.querySelectorAll("dd")].map((item) => item.textContent),
		).toEqual(["v1.2.0", "已发布", "我的库", "仅自己", "禁用", "不会新增"]);
		expect(
			within(summary).getByText(
				"安装后还不能直接使用。先绑定到 Agent 版本并完成同步。",
			),
		).toBeTruthy();
	});

	it("lists only this Skill's versions newest first and keeps the current one disabled", async () => {
		await renderDetail();
		const tablist = screen.getByRole("tablist", { name: "Skill 详情" });
		const overview = within(tablist).getByRole("tab", { name: "用途与内容" });
		expect(overview.getAttribute("aria-selected")).toBe("true");
		overview.focus();
		fireEvent.keyDown(overview, { key: "ArrowRight" });
		await waitFor(() =>
			expect(
				within(tablist)
					.getByRole("tab", { name: "版本与变更" })
					.getAttribute("aria-selected"),
			).toBe("true"),
		);
		const lines = document.querySelectorAll(".version-line");
		expect(lines).toHaveLength(2);
		expect(lines[0]?.querySelector("strong")?.textContent).toBe("v1.2.0");
		expect(lines[1]?.querySelector("strong")?.textContent).toBe("v1.0.0");
		for (const line of lines)
			expect(within(line as HTMLElement).getByText("已发布")).toBeTruthy();
		const current = within(lines[0] as HTMLElement).getByRole("button", {
			name: "正在查看",
		});
		expect(current.hasAttribute("disabled")).toBe(true);
		const older = within(lines[1] as HTMLElement).getByRole("link", {
			name: "查看版本：v1.0.0",
		});
		expect(older.getAttribute("href")).toBe(
			"/skills/release-notes-v1?tab=versions",
		);
		expect(screen.queryByText("incident-summary")).toBeNull();
	});

	it("installs for the current session principal once and reuses the key after a retryable failure", async () => {
		const install = vi
			.fn<SkillHubVersionActions["install"]>()
			.mockRejectedValueOnce(requestError(503))
			.mockResolvedValueOnce(
				{} as Awaited<ReturnType<SkillHubVersionActions["install"]>>,
			);
		await renderDetail({ act: actions({ install }) });
		expect(screen.queryByRole("textbox")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "加入我的库" }));
		expect(
			screen
				.getByRole("button", { name: "正在校验包…" })
				.hasAttribute("disabled"),
		).toBe(true);
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toBe("暂时无法加入我的库，请稍后重试。");
		fireEvent.click(screen.getByRole("button", { name: "加入我的库" }));
		const configure = await screen.findByRole("link", {
			name: "配置 Agent 绑定",
		});
		// 绑定要先选择自己创建的 Agent：入口直达「已创建」标签页。
		expect(configure.getAttribute("href")).toBe("/my-agents?tab=owned");
		expect(install).toHaveBeenCalledTimes(2);
		expect(install.mock.calls[0]?.[0]).toBe("release-notes-v2");
		expect(install.mock.calls[0]?.[1]).toBe(install.mock.calls[1]?.[1]);
		await waitFor(() => expect(document.activeElement).toBe(configure));
		expect(
			screen.getByText("固定版本已加入我的库，尚未绑定到 Agent"),
		).toBeTruthy();
	});

	it("treats a 409 install as already in the library and keeps 403 inline without error codes", async () => {
		const install = vi
			.fn<SkillHubVersionActions["install"]>()
			.mockRejectedValueOnce(requestError(409));
		await renderDetail({ act: actions({ install }) });
		fireEvent.click(screen.getByRole("button", { name: "加入我的库" }));
		await screen.findByRole("link", { name: "配置 Agent 绑定" });
		expect(screen.getByText("这个版本已在我的库中")).toBeTruthy();
		cleanup();

		const denied = vi
			.fn<SkillHubVersionActions["install"]>()
			.mockRejectedValueOnce(requestError(403));
		await renderDetail({ act: actions({ install: denied }) });
		fireEvent.click(screen.getByRole("button", { name: "加入我的库" }));
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toBe("当前账号不能把这个版本加入我的库。");
		expect(document.body.textContent).not.toMatch(
			/AUTHORIZATION_REVOKED|CONFLICT/,
		);
	});

	it("only offers revoke to the Skill owner", async () => {
		await renderDetail({ owned: false });
		expect(screen.queryByRole("button", { name: "撤销此版本" })).toBeNull();
		cleanup();
		await renderDetail({ owned: true });
		expect(screen.getByRole("button", { name: "撤销此版本" })).toBeTruthy();
	});

	it("confirms a revoke before exactly one request and then blocks new installs", async () => {
		const revoke = vi
			.fn<SkillHubVersionActions["revoke"]>()
			.mockResolvedValue(revoked());
		await renderDetail({ owned: true, act: actions({ revoke }) });
		const trigger = screen.getByRole("button", { name: "撤销此版本" });
		fireEvent.click(trigger);
		let dialog = await screen.findByRole("dialog", {
			name: "撤销这个 Skill 版本？",
		});
		expect(within(dialog).getByText("release-notes · v1.2.0")).toBeTruthy();
		expect(
			within(dialog).getByText(
				"阻止新的安装、绑定与调用。已发生的执行及结果继续保留原版本。",
			),
		).toBeTruthy();
		fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		fireEvent.click(trigger);
		dialog = await screen.findByRole("dialog");
		fireEvent.keyDown(dialog, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(revoke).not.toHaveBeenCalled();

		fireEvent.click(trigger);
		dialog = await screen.findByRole("dialog");
		const confirm = within(dialog).getByRole("button", { name: "确认撤销" });
		fireEvent.click(confirm);
		fireEvent.click(confirm);
		await waitFor(() => expect(revoke).toHaveBeenCalledOnce());
		expect(revoke.mock.calls[0]?.[0]).toBe("release-notes-v2");
		expect(typeof revoke.mock.calls[0]?.[1]).toBe("string");
		const heading = screen.getByRole("heading", { level: 1 });
		await waitFor(() => expect(document.activeElement).toBe(heading));
		expect(screen.getByText("版本已撤销，新的调用已被阻止")).toBeTruthy();
		const summary = screen.getByRole("complementary", { name: "版本与权限" });
		expect(within(summary).getByText("已撤销")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "加入我的库" })).toBeNull();
		expect(screen.queryByRole("button", { name: "撤销此版本" })).toBeNull();
	});

	it("keeps the version published and explains a failed revoke", async () => {
		const revoke = vi
			.fn<SkillHubVersionActions["revoke"]>()
			.mockRejectedValue(requestError(409));
		await renderDetail({ owned: true, act: actions({ revoke }) });
		fireEvent.click(screen.getByRole("button", { name: "撤销此版本" }));
		const dialog = await screen.findByRole("dialog");
		await act(async () => {
			fireEvent.click(within(dialog).getByRole("button", { name: "确认撤销" }));
		});
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toBe("版本状态已变化，请刷新后再操作。");
		const summary = screen.getByRole("complementary", { name: "版本与权限" });
		expect(within(summary).getByText("已发布")).toBeTruthy();
	});

	it("uses the page loading state and only retries retryable read failures", async () => {
		await renderWithRouter(
			<SkillHubVersionScreen
				state={{ kind: "loading" }}
				catalog={{ kind: "loading" }}
				tab="overview"
				onTabChange={() => undefined}
				owned={false}
				actions={actions()}
			/>,
		);
		expect(
			screen
				.getAllByRole("status")
				.some((item) => item.textContent?.includes("正在读取 Skill 版本…")),
		).toBe(true);
		cleanup();
		const retry = vi.fn();
		for (const [state, retryable] of [
			[{ kind: "unavailable", retryable: true }, true],
			[{ kind: "unavailable", retryable: false, reason: "denied" }, false],
			[{ kind: "unavailable", retryable: false, reason: "not-found" }, false],
		] as const) {
			await renderWithRouter(
				<SkillHubVersionScreen
					state={state}
					onRetry={retry}
					catalog={{ kind: "loading" }}
					tab="overview"
					onTabChange={() => undefined}
					owned={false}
					actions={actions()}
				/>,
			);
			expect(screen.getByRole("alert")).toBeTruthy();
			expect(Boolean(screen.queryByRole("button", { name: "重新读取" }))).toBe(
				retryable,
			);
			cleanup();
		}
	});
});
