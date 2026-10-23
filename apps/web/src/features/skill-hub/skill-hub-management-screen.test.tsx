import { SkillHubVersionMetadataV1Schema } from "@agent-infra/contracts/pilot";
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
import type {
	SkillHubProjectV1,
	SkillHubPublicationResponseV1,
} from "../../pilot/generated-v2/types.gen.js";
import {
	MySkillsScreen,
	type SkillEditorActions,
	SkillEditorScreen,
} from "./skill-hub-management-screen.js";

afterEach(cleanup);

const project: SkillHubProjectV1 = {
	schemaVersion: 1,
	projectId: "release-notes",
	name: "release-notes",
	ownerId: "user-owner",
	organizationId: null,
	status: "active",
	createdAt: "2026-10-01T00:00:00Z",
	updatedAt: "2026-10-01T00:00:00Z",
};
const published = SkillHubVersionMetadataV1Schema.parse({
	schemaVersion: 1,
	skillId: "release-notes",
	skillVersionId: "release-notes-v1",
	provider: "my_library",
	version: "1.2.0",
	packageDigest: "a".repeat(64),
	manifestDigest: "b".repeat(64),
	signatureDigest: "c".repeat(64),
	name: "release-notes",
	visibility: "MARKET",
	state: "published",
});

function importResponse(
	state: SkillHubPublicationResponseV1["version"]["state"],
): SkillHubPublicationResponseV1 {
	return {
		replayed: false,
		version: {
			schemaVersion: 1,
			skillId: "release-notes",
			skillVersionId: "release-notes-v2",
			provider: "github",
			version: "2.0.0",
			packageDigest: "a".repeat(64),
			manifestDigest: "b".repeat(64),
			signatureDigest: "c".repeat(64),
			visibility: "PRIVATE",
			state,
			needUpgrade: false,
			reviewedBy: null,
			reviewReason: null,
			revokedAt: null,
		},
	};
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
			"/skills/manage",
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
	render(
		<ToastProvider>
			<RouterProvider router={router} />
		</ToastProvider>,
	);
	return router;
}

function editorActions(overrides: Partial<SkillEditorActions> = {}) {
	return {
		createProject: vi.fn(),
		updateProject: vi.fn(),
		importVersion: vi.fn(),
		...overrides,
	} as SkillEditorActions;
}

describe("MySkillsScreen", () => {
	it("lists the user's own projects instead of manual ID forms (K-03, NI-31)", async () => {
		await renderWithRouter(
			<MySkillsScreen
				projects={{
					kind: "ready",
					items: [project, { ...project, projectId: "draft", name: "draft" }],
				}}
				versions={{ kind: "ready", versions: [published] }}
				installations={{ kind: "ready", installations: [] }}
			/>,
		);
		expect(
			screen.getByRole("heading", { level: 1, name: "我的 Skill" }),
		).toBeTruthy();
		expect(screen.getByText("我的管理 / 我的 Skill")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "创建或导入" }).getAttribute("href"),
		).toBe("/skills/manage/new");
		// 绑定要先选择自己创建的 Agent：入口直达「已创建」标签页。
		expect(
			screen.getByRole("link", { name: "Agent 绑定" }).getAttribute("href"),
		).toBe("/my-agents?tab=owned");
		// V-15 / V-16：设计顺序为「已安装」→「我创建的」，「Agent 绑定」在已安装区头，没有独立绑定区块。
		expect(
			screen
				.getAllByRole("heading", { level: 2 })
				.map((heading) => heading.textContent),
		).toEqual(["已安装", "我创建的"]);
		const installedHeading = screen.getByRole("heading", {
			level: 2,
			name: "已安装",
		});
		expect(
			installedHeading
				.closest("section")
				?.contains(screen.getByRole("link", { name: "Agent 绑定" })),
		).toBe(true);
		expect(screen.queryByText("在 Agent 的 Owner 配置中绑定")).toBeNull();
		expect(
			screen.getByText("管理自己创建的 Skill 和已安装版本。"),
		).toBeTruthy();
		const rows = document.querySelectorAll("article.skill-row");
		expect(rows).toHaveLength(2);
		const release = rows[0] as HTMLElement;
		expect(within(release).getByText("v1.2.0")).toBeTruthy();
		expect(within(release).getByText("内部市场")).toBeTruthy();
		expect(within(release).getByText("已发布")).toBeTruthy();
		expect(
			within(release)
				.getByRole("link", { name: "编辑新版本：release-notes" })
				.getAttribute("href"),
		).toBe("/skills/manage/new?project=release-notes");
		expect(
			within(release)
				.getByRole("link", { name: "详情：release-notes" })
				.getAttribute("href"),
		).toBe("/skills/release-notes-v1");
		// 本人目录含全部状态：没有任何版本的项目显示「暂无版本」。
		expect(within(rows[1] as HTMLElement).getByText("暂无版本")).toBeTruthy();
		expect(
			within(rows[1] as HTMLElement).queryByRole("link", { name: /^详情/ }),
		).toBeNull();
		// 页面上没有任何手填内部 ID、digest 或 Grant 的输入，也没有管理员审核卡。
		expect(screen.queryByRole("textbox")).toBeNull();
		const text = document.body.textContent ?? "";
		for (const removed of [
			"项目 ID",
			"Skill ID",
			"版本 ID",
			"digest",
			"Agent ID",
			"配置 revision",
			"Grant JSON",
			"共享审核",
			"pending_sync",
		])
			expect(text).not.toContain(removed);
	});

	it("shows each project's newest own version in its real state (K-02)", async () => {
		const pending = {
			...published,
			skillVersionId: "release-notes-v2",
			version: "2.0.0",
			state: "pending_review" as const,
		};
		const rejected = {
			...published,
			skillId: "draft",
			skillVersionId: "draft-v1",
			name: "draft",
			version: "0.1.0",
			visibility: "PRIVATE" as const,
			state: "rejected" as const,
		};
		const revoked = {
			...published,
			skillId: "old",
			skillVersionId: "old-v1",
			name: "old",
			state: "revoked" as const,
		};
		await renderWithRouter(
			<MySkillsScreen
				projects={{
					kind: "ready",
					items: [
						project,
						{ ...project, projectId: "draft", name: "draft" },
						{ ...project, projectId: "old", name: "old" },
					],
				}}
				versions={{
					kind: "ready",
					versions: [published, pending, rejected, revoked],
				}}
				installations={{ kind: "ready", installations: [] }}
			/>,
		);
		const rows = [
			...document.querySelectorAll("article.skill-row"),
		] as HTMLElement[];
		expect(
			rows.map((row) => [
				// 「我创建的」是 h2 分区，行标题降为 h3（V-15）。
				row.querySelector("h3")?.textContent,
				row.querySelector('[data-slot="badge"]')?.textContent,
				row.querySelector(".skill-row-meta strong")?.textContent,
				within(row).getByRole("link", { name: /^详情/ }).getAttribute("href"),
			]),
		).toEqual([
			["release-notes", "待审核", "v2.0.0", "/skills/release-notes-v2"],
			["draft", "已驳回", "v0.1.0", "/skills/draft-v1"],
			["old", "已撤销", "v1.2.0", "/skills/old-v1"],
		]);
	});

	it("keeps the project list when version states cannot be read", async () => {
		await renderWithRouter(
			<MySkillsScreen
				projects={{ kind: "ready", items: [project] }}
				versions={{ kind: "unavailable", retryable: true }}
				installations={{ kind: "ready", installations: [] }}
			/>,
		);
		expect(
			screen.getByText("版本状态暂时无法读取，项目列表不受影响。"),
		).toBeTruthy();
		const row = document.querySelector("article.skill-row") as HTMLElement;
		expect(within(row).getByText("版本暂时无法读取")).toBeTruthy();
		expect(within(row).queryByText("暂无版本")).toBeNull();
		expect(within(row).queryByRole("link", { name: /^详情/ })).toBeNull();
	});

	it("keeps retryable and denied project reads separate", async () => {
		const retry = vi.fn();
		await renderWithRouter(
			<MySkillsScreen
				projects={{ kind: "unavailable", retryable: true }}
				versions={{ kind: "loading" }}
				installations={{ kind: "loading" }}
				onRetry={retry}
			/>,
		);
		// 需求变化（#3292 N9-3-05）：与「已安装」同时失败时按钮可区分，名称带分区名，可见文字不变。
		const reread = screen.getByRole("button", { name: "重新读取：我创建的" });
		expect(reread.textContent).toBe("重新读取");
		fireEvent.click(reread);
		expect(retry).toHaveBeenCalledOnce();
		cleanup();
		await renderWithRouter(
			<MySkillsScreen
				projects={{ kind: "unavailable", retryable: false, reason: "denied" }}
				versions={{ kind: "loading" }}
				installations={{ kind: "loading" }}
			/>,
		);
		expect(
			screen.getByText("当前账号没有管理 Skill 项目的权限。"),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: /^重新读取/ })).toBeNull();
	});

	it("names both section recoveries apart when installations and projects fail together (N9-3-05)", async () => {
		const retryProjects = vi.fn();
		const retryInstallations = vi.fn();
		await renderWithRouter(
			<MySkillsScreen
				projects={{ kind: "unavailable", retryable: true }}
				versions={{ kind: "loading" }}
				installations={{ kind: "unavailable", retryable: true }}
				onRetry={retryProjects}
				onInstallationsRetry={retryInstallations}
			/>,
		);
		const names = screen
			.getAllByRole("button")
			.map((button) => button.getAttribute("aria-label") ?? button.textContent);
		expect(names).toEqual(["重新读取：已安装", "重新读取：我创建的"]);
		fireEvent.click(screen.getByRole("button", { name: "重新读取：已安装" }));
		expect(retryInstallations).toHaveBeenCalledOnce();
		expect(retryProjects).not.toHaveBeenCalled();
	});

	it("offers one named re-login per section on 401 instead of contacting an administrator (N9-3-04)", async () => {
		const relogin = vi.fn();
		const expired = {
			kind: "unavailable" as const,
			retryable: false,
			reason: "authentication-required" as const,
		};
		await renderWithRouter(
			<MySkillsScreen
				projects={expired}
				versions={{ kind: "loading" }}
				installations={expired}
				onRelogin={relogin}
			/>,
		);
		expect(screen.queryByText(/请联系管理员/)).toBeNull();
		expect(
			screen.getAllByRole("alert").map((alert) => alert.textContent),
		).toEqual([
			"登录已过期登录状态已失效，请重新登录后再试。",
			"登录已过期登录状态已失效，请重新登录后再试。",
		]);
		fireEvent.click(screen.getByRole("button", { name: "重新登录：我创建的" }));
		fireEvent.click(screen.getByRole("button", { name: "重新登录：已安装" }));
		expect(relogin).toHaveBeenCalledTimes(2);
	});
});

describe("SkillEditorScreen", () => {
	it("creates a project through the server action boundary without internal IDs", async () => {
		const createProject = vi.fn().mockResolvedValue(project);
		const onProjectsChanged = vi.fn();
		const onProjectCreated = vi.fn();
		await renderWithRouter(
			<SkillEditorScreen
				actions={editorActions({ createProject })}
				onProjectsChanged={onProjectsChanged}
				onProjectCreated={onProjectCreated}
			/>,
		);
		expect(
			screen.getByRole("heading", { level: 1, name: "创建与发布 Skill" }),
		).toBeTruthy();
		const inputs = screen.getAllByRole("textbox");
		for (const input of inputs)
			expect(input.getAttribute("aria-label") ?? "").not.toMatch(/ID|digest/);
		expect(document.body.textContent).not.toMatch(/项目 ID|版本 ID|digest/i);
		const name = screen.getAllByLabelText("包名称")[0] as HTMLInputElement;
		fireEvent.change(name, { target: { value: "Release Notes" } });
		fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
		expect(createProject).not.toHaveBeenCalled();
		expect(name.getAttribute("aria-invalid")).toBe("true");
		expect(document.activeElement).toBe(name);
		fireEvent.change(name, { target: { value: "release-notes" } });
		fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
		await waitFor(() =>
			expect(createProject).toHaveBeenCalledWith(
				{ schemaVersion: 1, name: "release-notes" },
				expect.any(String),
			),
		);
		expect(
			await screen.findByText(
				"Skill 项目已创建：release-notes。可以继续编辑内容并发布，或导入第一个版本。",
			),
		).toBeTruthy();
		expect(onProjectsChanged).toHaveBeenCalledOnce();
		// 进入新项目后编辑器按项目重新挂载，名称随回调交给路由以保留就地反馈（#3269 N8-3-04）。
		expect(onProjectCreated).toHaveBeenCalledWith(
			"release-notes",
			"release-notes",
		);
	});

	it("reuses the idempotency key when a write is retried", async () => {
		const createProject = vi
			.fn()
			.mockRejectedValueOnce(
				Object.assign(new Error("temporary"), { status: 503 }),
			)
			.mockResolvedValue(project);
		await renderWithRouter(
			<SkillEditorScreen actions={editorActions({ createProject })} />,
		);
		fireEvent.change(screen.getAllByLabelText("包名称")[0] as HTMLElement, {
			target: { value: "release-notes" },
		});
		const button = screen.getByRole("button", { name: "创建项目" });
		fireEvent.click(button);
		expect((await screen.findByRole("alert")).textContent).toBe(
			"Skill Hub 暂时不可用，可稍后重试。",
		);
		fireEvent.click(button);
		await waitFor(() => expect(createProject).toHaveBeenCalledTimes(2));
		expect(createProject.mock.calls[0]?.[1]).toBe(
			createProject.mock.calls[1]?.[1],
		);
	});

	it("rejects floating references and reports the imported state in Chinese", async () => {
		const importVersion = vi
			.fn()
			.mockResolvedValue(importResponse("pending_review"));
		await renderWithRouter(
			<SkillEditorScreen
				project={project}
				actions={editorActions({ importVersion })}
			/>,
		);
		const provider = screen.getByLabelText("来源") as HTMLSelectElement;
		expect([...provider.options].map((option) => option.textContent)).toEqual([
			"ClawHub",
			"SkillHub",
			"npx",
			"GitHub",
		]);
		const reference = screen.getByLabelText("固定版本引用");
		fireEvent.change(reference, { target: { value: "release-notes@latest" } });
		fireEvent.click(screen.getByRole("button", { name: "导入为待检查草稿" }));
		expect(importVersion).not.toHaveBeenCalled();
		expect(screen.getByRole("alert").textContent).toBe(
			"请填写可核验的固定版本引用。",
		);
		expect(document.activeElement).toBe(reference);
		fireEvent.change(reference, { target: { value: "2.0.0" } });
		fireEvent.click(screen.getByRole("button", { name: "导入为待检查草稿" }));
		await waitFor(() =>
			expect(importVersion).toHaveBeenCalledWith(
				{
					schemaVersion: 1,
					name: "release-notes",
					provider: "github",
					version: "2.0.0",
				},
				expect.any(String),
			),
		);
		expect(
			await screen.findByText("v2.0.0 已提交审核，审核通过前不能安装。"),
		).toBeTruthy();
		expect(screen.getAllByText("待审核").length).toBeGreaterThan(0);
		expect(document.body.textContent).not.toMatch(/pending_review|published/);
	});

	it("edits or disables an existing project without asking for its ID", async () => {
		const updateProject = vi
			.fn()
			.mockResolvedValue({ ...project, status: "disabled" });
		await renderWithRouter(
			<SkillEditorScreen
				project={project}
				actions={editorActions({ updateProject })}
			/>,
		);
		fireEvent.change(screen.getByLabelText("项目状态"), {
			target: { value: "disabled" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存项目" }));
		await waitFor(() =>
			expect(updateProject).toHaveBeenCalledWith(
				"release-notes",
				{ schemaVersion: 1, name: "release-notes", status: "disabled" },
				expect.any(String),
			),
		);
		expect(
			await screen.findByText("Skill 项目已停用：release-notes。"),
		).toBeTruthy();
	});

	it("offers content editing and web publication only for an existing project (#2906)", async () => {
		await renderWithRouter(<SkillEditorScreen actions={editorActions()} />);
		expect(screen.queryByRole("heading", { name: "Skill 内容" })).toBeNull();
		// V-18 / V-19：新建时右栏只有说明，没有版本号、范围与发布按钮（项目内容属于已创建的项目）。
		const newAside = screen.getByRole("complementary", {
			name: "版本与发布范围",
		});
		expect(within(newAside).queryByLabelText("版本号")).toBeNull();
		expect(within(newAside).queryByRole("radiogroup")).toBeNull();
		expect(within(newAside).queryByRole("button")).toBeNull();
		cleanup();
		await renderWithRouter(
			<SkillEditorScreen
				project={project}
				actions={editorActions()}
				content={{
					kind: "ready",
					content: {
						schemaVersion: 1,
						projectId: "release-notes",
						revision: 0,
						contentDigest: null,
						fileCount: 0,
						totalBytes: 0,
						updatedAt: null,
						files: [],
					},
				}}
			/>,
		);
		expect(screen.getByRole("heading", { name: "Skill 内容" })).toBeTruthy();
		const aside = screen.getByRole("complementary", {
			name: "版本与发布范围",
		});
		expect(within(aside).getByLabelText("版本号")).toBeTruthy();
		// 四张范围单选卡，名称为范围文字，说明为审核规则；默认「仅自己」。
		expect(
			within(aside)
				.getAllByRole("radio")
				.map((radio) => radio.getAttribute("aria-checked")),
		).toEqual(["true", "false", "false", "false"]);
		for (const name of ["仅自己", "全体成员", "组织共享", "内部市场"])
			expect(within(aside).getByRole("radio", { name })).toBeTruthy();
		// 项目没有所属组织：「组织共享」不可选，并说明原因。
		expect(
			within(aside)
				.getByRole("radio", { name: "组织共享" })
				.hasAttribute("data-disabled"),
		).toBe(true);
		expect(
			within(aside).getByText("项目没有所属组织，不能选择组织共享。"),
		).toBeTruthy();
		expect(
			within(aside).getByRole("button", { name: "保存草稿" }),
		).toBeTruthy();
		expect(
			within(aside).getByRole("button", { name: "发布固定版本" }),
		).toBeTruthy();
		expect(
			(screen.getByLabelText("SKILL.md（任务说明）") as HTMLTextAreaElement)
				.value,
		).toBe("");
		// 浏览器不提交、也不显示包事实。
		expect(document.body.textContent).not.toMatch(/项目 ID|版本 ID|digest/i);
	});
});
