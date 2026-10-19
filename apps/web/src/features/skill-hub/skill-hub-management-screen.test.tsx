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
				catalog={{ kind: "ready", versions: [published] }}
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
		expect(
			within(rows[1] as HTMLElement).getByText("暂无已发布版本"),
		).toBeTruthy();
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

	it("keeps retryable and denied project reads separate", async () => {
		const retry = vi.fn();
		await renderWithRouter(
			<MySkillsScreen
				projects={{ kind: "unavailable", retryable: true }}
				catalog={{ kind: "loading" }}
				onRetry={retry}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
		expect(retry).toHaveBeenCalledOnce();
		cleanup();
		await renderWithRouter(
			<MySkillsScreen
				projects={{ kind: "unavailable", retryable: false, reason: "denied" }}
				catalog={{ kind: "loading" }}
			/>,
		);
		expect(
			screen.getByText("当前账号没有管理 Skill 项目的权限。"),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "重新读取" })).toBeNull();
	});
});

describe("SkillEditorScreen", () => {
	it("creates a project through the server action boundary without internal IDs", async () => {
		const createProject = vi.fn().mockResolvedValue(project);
		const onProjectsChanged = vi.fn();
		await renderWithRouter(
			<SkillEditorScreen
				actions={editorActions({ createProject })}
				onProjectsChanged={onProjectsChanged}
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
				"Skill 项目已创建：release-notes。可以继续导入第一个版本。",
			),
		).toBeTruthy();
		expect(onProjectsChanged).toHaveBeenCalledOnce();
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
});
