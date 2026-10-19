import {
	SkillHubOwnedVersionV1Schema,
	SkillHubVersionDetailV1Schema,
	SkillHubVersionMetadataV1Schema,
} from "@agent-infra/contracts/pilot";
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
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast";
import type {
	SkillHubInstallationResponseV1,
	SkillHubPublicationResponseV1,
	SkillHubVersionDetailV1,
} from "../../pilot/generated-v2/types.gen.js";
import type { SkillHubOwnedVersionsState } from "./skill-hub.js";
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
// 版本详情投影：发布者、本人安装状态与有界正文（#2904）。
const skillBody =
	"# release-notes\n汇总本周变更。\n<script>alert(1)</script>\n";
function detailOf(
	version: typeof v1,
	overrides: Partial<SkillHubVersionDetailV1> = {},
): SkillHubVersionDetailV1 {
	return SkillHubVersionDetailV1Schema.parse({
		...version,
		ownerId: "user-owner",
		installation: { state: "not_installed" },
		content: {
			state: "available",
			body: skillBody,
			bodyTruncated: false,
			resources: [
				{ path: "references/style.md", kind: "reference", sizeBytes: 2048 },
				{ path: "scripts/collect.sh", kind: "script", sizeBytes: 120 },
			],
		},
		...overrides,
	});
}
const detail = detailOf(v2);

function installed(installationId = "installation-1") {
	return {
		replayed: false,
		installation: {
			schemaVersion: 1,
			installationId,
			principalType: "user",
			principalId: "user-viewer",
			skillVersionId: "release-notes-v2",
			state: "installed",
			needUpgrade: false,
			installedAt: "2026-10-18T00:00:00Z",
			updatedAt: "2026-10-18T00:00:00Z",
		},
	} satisfies SkillHubInstallationResponseV1;
}
function removed(installationId = "installation-1") {
	const value = installed(installationId);
	return {
		...value,
		installation: { ...value.installation, state: "uninstalled" },
	} satisfies SkillHubInstallationResponseV1;
}

// 发布者显示名由页面级目录读取解析：测试与生产一样经 QueryClient 读取固定目录记录。
beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) => {
			const url = new URL(String(input), "http://localhost");
			const ids = url.searchParams.get("ids")?.split(",") ?? [];
			return Response.json({
				items: [
					{ kind: "user", canonicalId: "user-owner", displayName: "周可" },
				].filter(
					(item) =>
						item.kind === url.searchParams.get("kind") &&
						ids.includes(item.canonicalId),
				),
			});
		}),
	);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
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

function actions(overrides: Partial<SkillHubVersionActions> = {}) {
	return {
		install: vi.fn<SkillHubVersionActions["install"]>(),
		uninstall: vi.fn<SkillHubVersionActions["uninstall"]>(),
		revoke: vi.fn<SkillHubVersionActions["revoke"]>(),
		...overrides,
	};
}

async function renderDetail({
	owned = false,
	initialTab = "overview",
	act: detailActions = actions(),
	version = detail,
	ownedVersions,
	onVersionChanged,
}: {
	owned?: boolean;
	initialTab?: SkillDetailTab;
	act?: ReturnType<typeof actions>;
	version?: SkillHubVersionDetailV1;
	ownedVersions?: SkillHubOwnedVersionsState;
	onVersionChanged?: () => void;
} = {}) {
	function Detail() {
		const [tab, setTab] = useState<SkillDetailTab>(initialTab);
		return (
			<SkillHubVersionScreen
				state={{ kind: "ready", version }}
				catalog={{ kind: "ready", versions: [v1, other, v2] }}
				ownedVersions={ownedVersions}
				onVersionChanged={onVersionChanged}
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
		...[
			"/skills",
			"/skills/$skillVersionId",
			"/skills/manage/new",
			"/my-agents",
		].map((path) =>
			createRoute({ getParentRoute: () => root, path, component: () => null }),
		),
	];
	const router = createRouter({
		history: createMemoryHistory({ initialEntries: ["/"] }),
		routeTree: root.addChildren(routes),
	});
	await router.load();
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	render(
		<QueryClientProvider client={client}>
			<ToastProvider>
				<RouterProvider router={router} />
			</ToastProvider>
		</QueryClientProvider>,
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
		const summary = screen.getByRole("complementary", { name: "版本与权限" });
		// 发布者显示名来自目录读取，不显示内部用户 ID。
		await within(summary).findByText("周可");
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
			"user-owner",
		])
			expect(text).not.toContain(hidden);
		expect(
			[...summary.querySelectorAll("dt")].map((item) => item.textContent),
		).toEqual([
			"版本",
			"发布状态",
			"发布者",
			"来源",
			"可见范围",
			"我的库",
			"脚本",
			"网络权限",
		]);
		expect(
			[...summary.querySelectorAll("dd")].map((item) => item.textContent),
		).toEqual([
			"v1.2.0",
			"已发布",
			"周可",
			"我的库",
			"仅自己",
			"尚未安装",
			"禁用",
			"不会新增",
		]);
		expect(
			within(summary).getByText(
				"安装后还不能直接使用。先绑定到 Agent 版本并完成同步。",
			),
		).toBeTruthy();
	});

	it("renders SKILL.md as plain text and lists resources without their content", async () => {
		await renderDetail();
		const body = screen.getByRole("region", { name: "SKILL.md 正文" });
		// 正文按纯文本显示：<script> 只作为文字出现，不生成任何元素。
		expect(body.querySelector("pre")?.textContent).toBe(skillBody);
		expect(document.querySelector("script")).toBeNull();
		expect(body.querySelectorAll("*")).toHaveLength(1);
		const resources = screen
			.getByRole("heading", { level: 2, name: "配套资源" })
			.closest("section") as HTMLElement;
		expect(
			[...resources.querySelectorAll("li")].map((item) => item.textContent),
		).toEqual([
			"references/style.md参考资料 · 2 KB",
			"scripts/collect.sh脚本 · 120 B",
		]);
		expect(screen.queryByText(/正文较长/)).toBeNull();
		cleanup();

		await renderDetail({
			version: detailOf(v2, {
				content: {
					state: "available",
					body: "x".repeat(10),
					bodyTruncated: true,
					resources: [],
				},
			}),
		});
		expect(
			screen.getByText(
				"正文较长，这里只显示开头部分；调用时会按需加载完整内容。",
			),
		).toBeTruthy();
		expect(screen.getByText("这个版本没有配套资源。")).toBeTruthy();
		cleanup();

		await renderDetail({
			version: detailOf(v2, { content: { state: "unavailable" } }),
		});
		expect(
			screen.getByText("正文与配套资源暂时无法读取，版本信息不受影响。"),
		).toBeTruthy();
		expect(screen.queryByRole("region", { name: "SKILL.md 正文" })).toBeNull();
		expect(screen.getByRole("button", { name: "加入我的库" })).toBeTruthy();
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
			.mockResolvedValueOnce(installed());
		const onVersionChanged = vi.fn();
		await renderDetail({ act: actions({ install }), onVersionChanged });
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
		// 成功后立即显示「已在我的库」并请求回读详情。
		const summary = screen.getByRole("complementary", { name: "版本与权限" });
		expect(within(summary).getByText("已在我的库")).toBeTruthy();
		expect(screen.getByRole("button", { name: "移出我的库" })).toBeTruthy();
		expect(onVersionChanged).toHaveBeenCalledOnce();
	});

	it("shows a server-read installation and removes it with one reused key, then re-reads", async () => {
		const uninstall = vi
			.fn<SkillHubVersionActions["uninstall"]>()
			.mockRejectedValueOnce(requestError(503))
			.mockResolvedValueOnce(removed());
		const onVersionChanged = vi.fn();
		await renderDetail({
			act: actions({ uninstall }),
			onVersionChanged,
			version: detailOf(v2, {
				installation: {
					state: "installed",
					installationId: "installation-1",
				},
			}),
		});
		const summary = screen.getByRole("complementary", { name: "版本与权限" });
		expect(within(summary).getByText("已在我的库")).toBeTruthy();
		expect(screen.getByRole("link", { name: "配置 Agent 绑定" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "加入我的库" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "移出我的库" }));
		expect((await screen.findByRole("alert")).textContent).toBe(
			"暂时无法移出我的库，请稍后重试。",
		);
		fireEvent.click(screen.getByRole("button", { name: "移出我的库" }));
		const add = await screen.findByRole("button", { name: "加入我的库" });
		await waitFor(() => expect(document.activeElement).toBe(add));
		expect(uninstall).toHaveBeenCalledTimes(2);
		expect(uninstall.mock.calls[0]?.[0]).toBe("installation-1");
		expect(uninstall.mock.calls[0]?.[1]).toBe(uninstall.mock.calls[1]?.[1]);
		expect(within(summary).getByText("尚未安装")).toBeTruthy();
		expect(screen.getByText("已移出我的库")).toBeTruthy();
		expect(onVersionChanged).toHaveBeenCalledOnce();
	});

	it("drops the optimistic library state once the server reads back a different installation", async () => {
		let readBack: (version: SkillHubVersionDetailV1) => void = () => undefined;
		const install = vi
			.fn<SkillHubVersionActions["install"]>()
			.mockResolvedValue(installed("installation-1"));
		function Detail() {
			const [current, setCurrent] = useState(detail);
			readBack = setCurrent;
			return (
				<SkillHubVersionScreen
					state={{ kind: "ready", version: current }}
					catalog={{ kind: "ready", versions: [v1, v2] }}
					tab="overview"
					onTabChange={() => undefined}
					owned={false}
					actions={actions({ install })}
				/>
			);
		}
		await renderWithRouter(<Detail />);
		const summary = screen.getByRole("complementary", { name: "版本与权限" });
		fireEvent.click(screen.getByRole("button", { name: "加入我的库" }));
		await screen.findByRole("link", { name: "配置 Agent 绑定" });
		// 回读确认安装后，另一个页面又把它移出；再次回读必须显示服务端的「尚未安装」。
		act(() =>
			readBack(
				detailOf(v2, {
					installation: {
						state: "installed",
						installationId: "installation-1",
					},
				}),
			),
		);
		expect(within(summary).getByText("已在我的库")).toBeTruthy();
		act(() =>
			readBack(detailOf(v2, { installation: { state: "not_installed" } })),
		);
		expect(within(summary).getByText("尚未安装")).toBeTruthy();
		expect(screen.getByRole("button", { name: "加入我的库" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "移出我的库" })).toBeNull();
		expect(screen.queryByRole("link", { name: "配置 Agent 绑定" })).toBeNull();
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

	it("shows the publisher's own unpublished versions without install or revoke", async () => {
		const pending = SkillHubOwnedVersionV1Schema.parse({
			...v2,
			skillVersionId: "release-notes-v3",
			version: "1.3.0",
			visibility: "MARKET",
			state: "pending_review",
		});
		const rejected = SkillHubOwnedVersionV1Schema.parse({
			...pending,
			skillVersionId: "release-notes-v4",
			version: "1.4.0",
			state: "rejected",
		});
		await renderDetail({
			owned: true,
			initialTab: "versions",
			version: detailOf(v2, pending),
			ownedVersions: { kind: "ready", versions: [v1, v2, pending, rejected] },
		});
		const summary = screen.getByRole("complementary", { name: "版本与权限" });
		expect(within(summary).getByText("待审核")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "加入我的库" })).toBeNull();
		expect(screen.queryByRole("button", { name: "撤销此版本" })).toBeNull();
		expect(
			screen.getByRole("link", { name: "编辑新版本" }).getAttribute("href"),
		).toBe("/skills/manage/new?project=release-notes");
		// 版本列表合并本人目录：本人的待审核、已驳回版本与已发布版本按版本号排列。
		const lines = [...document.querySelectorAll(".version-line")];
		expect(
			lines.map((line) => [
				line.querySelector("strong")?.textContent,
				line.querySelector('[data-slot="badge"]')?.textContent,
			]),
		).toEqual([
			["v1.4.0", "已驳回"],
			["v1.3.0", "待审核"],
			["v1.2.0", "已发布"],
			["v1.0.0", "已发布"],
		]);
		expect(
			within(lines[1] as HTMLElement)
				.getByRole("button", { name: "正在查看" })
				.hasAttribute("disabled"),
		).toBe(true);
		cleanup();

		// 非创建者（理论上读不到）也不显示编辑入口。
		await renderDetail({ version: detailOf(v2, pending) });
		expect(screen.queryByRole("link", { name: "编辑新版本" })).toBeNull();
		expect(screen.queryByRole("button", { name: "加入我的库" })).toBeNull();
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
