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
import { type ReactNode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast";
import type {
	SkillHubProjectContentV1,
	SkillHubProjectV1,
	SkillHubPublicationResponseV1,
} from "../../pilot/generated-v2/types.gen.js";
import {
	type SkillProjectContentActions,
	SkillProjectContentEditor,
	type SkillProjectContentState,
} from "./skill-project-content-editor.js";

afterEach(cleanup);

const project: SkillHubProjectV1 = {
	schemaVersion: 1,
	projectId: "project-a",
	name: "release-notes",
	ownerId: "user-owner",
	organizationId: null,
	status: "active",
	createdAt: "2026-10-01T00:00:00Z",
	updatedAt: "2026-10-01T00:00:00Z",
};
const stored: SkillHubProjectContentV1 = {
	schemaVersion: 1,
	projectId: "project-a",
	revision: 2,
	contentDigest: "d".repeat(64),
	fileCount: 3,
	totalBytes: 30,
	updatedAt: "2026-10-01T00:00:00Z",
	files: [
		{
			path: "SKILL.md",
			encoding: "utf8",
			content: "# release-notes\n",
			sizeBytes: 16,
		},
		{
			path: "assets/logo.png",
			encoding: "base64",
			content: "iVBORw0KGgo=",
			sizeBytes: 8,
		},
		{
			path: "scripts/run.sh",
			encoding: "utf8",
			content: "echo run\n",
			sizeBytes: 9,
		},
	],
};
function publication(
	state: SkillHubPublicationResponseV1["version"]["state"],
): SkillHubPublicationResponseV1 {
	return {
		replayed: false,
		version: {
			schemaVersion: 1,
			skillId: "project-a",
			skillVersionId: "release-notes-v1",
			provider: "my_library",
			version: "1.0.0",
			packageDigest: "a".repeat(64),
			manifestDigest: "b".repeat(64),
			signatureDigest: "c".repeat(64),
			visibility: state === "published" ? "PRIVATE" : "MEMBER",
			state,
			needUpgrade: false,
			reviewedBy: null,
			reviewReason: null,
			revokedAt: null,
		},
	};
}
const saveResult = (revision: number) => ({
	replayed: false,
	projectId: "project-a",
	revision,
	contentDigest: "e".repeat(64),
	fileCount: 3,
	totalBytes: 40,
	updatedAt: "2026-10-02T00:00:00Z",
});

async function renderWithRouter(content: ReactNode) {
	const root = createRootRoute();
	const routes = [
		createRoute({
			getParentRoute: () => root,
			path: "/",
			component: () => content,
		}),
		createRoute({
			getParentRoute: () => root,
			path: "/skills/$skillVersionId",
			component: () => null,
		}),
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
function actions(overrides: Partial<SkillProjectContentActions> = {}) {
	return {
		saveContent: vi.fn(async () => saveResult(3)),
		publishVersion: vi.fn(async () => publication("published")),
		...overrides,
	} as unknown as SkillProjectContentActions & {
		saveContent: ReturnType<typeof vi.fn>;
		publishVersion: ReturnType<typeof vi.fn>;
	};
}
const ready: SkillProjectContentState = { kind: "ready", content: stored };

describe("SkillProjectContentEditor (#2906)", () => {
	it("shows the stored SKILL.md and files without internal IDs or digests", async () => {
		await renderWithRouter(
			<SkillProjectContentEditor
				project={project}
				content={ready}
				actions={actions()}
			/>,
		);
		expect(
			(screen.getByLabelText("SKILL.md（任务说明）") as HTMLTextAreaElement)
				.value,
		).toBe("# release-notes\n");
		const names = screen
			.getAllByLabelText("文件名")
			.map((input) => (input as HTMLInputElement).value);
		expect(names).toEqual(["logo.png", "run.sh"]);
		expect(screen.getByText("二进制文件")).toBeTruthy();
		expect(
			(screen.getByLabelText("文件内容") as HTMLTextAreaElement).value,
		).toBe("echo run\n");
		const text = document.body.textContent ?? "";
		for (const internal of ["project-a", "dddd", "digest", "revision"])
			expect(text).not.toContain(internal);
		// 项目没有所属组织：组织共享不可选（V-18 范围单选卡）。
		const scope = screen.getByRole("radiogroup", { name: "发布范围" });
		expect(
			within(scope)
				.getByRole("radio", { name: "组织共享" })
				.hasAttribute("data-disabled"),
		).toBe(true);
		expect(screen.getByText(/项目没有所属组织/)).toBeTruthy();
	});

	it("saves the whole content against the revision it read", async () => {
		const control = actions();
		await renderWithRouter(
			<SkillProjectContentEditor
				project={project}
				content={ready}
				actions={control}
			/>,
		);
		fireEvent.change(screen.getByLabelText("SKILL.md（任务说明）"), {
			target: { value: "# release-notes v2\n" },
		});
		expect(screen.getByText("有未保存的修改")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "添加文本文件" }));
		const names = screen.getAllByLabelText("文件名");
		fireEvent.change(names[2] as HTMLElement, {
			target: { value: "guide.md" },
		});
		fireEvent.change(screen.getAllByLabelText("目录")[2] as HTMLElement, {
			target: { value: "references" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
		await screen.findByText(/内容已保存/);
		expect(control.saveContent).toHaveBeenCalledWith(
			"project-a",
			{
				schemaVersion: 1,
				baseRevision: 2,
				files: [
					{
						path: "SKILL.md",
						encoding: "utf8",
						content: "# release-notes v2\n",
					},
					{
						path: "assets/logo.png",
						encoding: "base64",
						content: "iVBORw0KGgo=",
					},
					{ path: "scripts/run.sh", encoding: "utf8", content: "echo run\n" },
					{ path: "references/guide.md", encoding: "utf8", content: "" },
				],
			},
			expect.any(String),
		);
		expect(screen.queryByText("有未保存的修改")).toBeNull();
		// 之后的保存基于新修订。
		fireEvent.change(screen.getByLabelText("SKILL.md（任务说明）"), {
			target: { value: "# release-notes v3\n" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
		await waitFor(() => expect(control.saveContent).toHaveBeenCalledTimes(2));
		expect(control.saveContent.mock.calls[1]?.[1]).toMatchObject({
			baseRevision: 3,
		});
	});

	it.each([
		[
			"an empty SKILL.md",
			{ skillMd: "  " },
			"请填写 SKILL.md，说明用途和使用步骤。",
		],
		[
			"a file name with a parent segment",
			{ name: "../secret" },
			"文件名只能使用字母、数字、点、短横线和下划线，可用 / 分隔子目录。",
		],
		[
			"a duplicate path",
			{ name: "run.sh", directory: "scripts" },
			"文件路径重复。",
		],
	])("refuses %s before saving", async (_label, change, message) => {
		const control = actions();
		await renderWithRouter(
			<SkillProjectContentEditor
				project={project}
				content={ready}
				actions={control}
			/>,
		);
		if ("skillMd" in change)
			fireEvent.change(screen.getByLabelText("SKILL.md（任务说明）"), {
				target: { value: change.skillMd },
			});
		else {
			fireEvent.click(screen.getByRole("button", { name: "添加文本文件" }));
			fireEvent.change(screen.getAllByLabelText("文件名")[2] as HTMLElement, {
				target: { value: change.name },
			});
		}
		fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
		expect((await screen.findByRole("alert")).textContent).toBe(message);
		expect(document.activeElement?.getAttribute("aria-invalid")).toBe("true");
		expect(control.saveContent).not.toHaveBeenCalled();
	});

	it("saves pending edits first, then publishes that revision and links to the version", async () => {
		const onPublished = vi.fn();
		const control = actions({
			publishVersion: vi.fn(async () => publication("pending_review")),
		});
		await renderWithRouter(
			<SkillProjectContentEditor
				project={project}
				content={ready}
				actions={control}
				onPublished={onPublished}
			/>,
		);
		fireEvent.change(screen.getByLabelText("SKILL.md（任务说明）"), {
			target: { value: "# release-notes v2\n" },
		});
		fireEvent.change(screen.getByLabelText("版本号"), {
			target: { value: "latest version" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存并发布" }));
		expect((await screen.findByRole("alert")).textContent).toMatch(
			/请填写版本号/,
		);
		expect(control.saveContent).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText("版本号"), {
			target: { value: "1.0.0" },
		});
		// 共享范围的主按钮按设计为「提交审核」，有未保存修改时先保存。
		fireEvent.click(screen.getByRole("radio", { name: "全体成员" }));
		expect(
			screen
				.getByRole("radio", { name: "全体成员" })
				.getAttribute("aria-checked"),
		).toBe("true");
		fireEvent.click(screen.getByRole("button", { name: "保存并提交审核" }));
		expect(
			await screen.findByText("v1.0.0 已提交审核，审核通过前不能安装。"),
		).toBeTruthy();
		expect(control.saveContent).toHaveBeenCalledOnce();
		expect(control.publishVersion).toHaveBeenCalledWith(
			"project-a",
			{
				schemaVersion: 1,
				contentRevision: 3,
				version: "1.0.0",
				visibility: "MEMBER",
			},
			expect.any(String),
		);
		expect(screen.getByText("待审核")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "查看版本详情" }).getAttribute("href"),
		).toBe("/skills/release-notes-v1");
		expect(onPublished).toHaveBeenCalledOnce();
		expect(document.body.textContent).not.toMatch(/aaaa|pending_review|MEMBER/);
	});

	it("explains a taken version number and reuses the key when retrying a failed publication", async () => {
		const publishVersion = vi
			.fn()
			.mockRejectedValueOnce(Object.assign(new Error("taken"), { status: 409 }))
			.mockRejectedValueOnce(
				Object.assign(new Error("temporary"), { status: 503 }),
			)
			.mockResolvedValueOnce(publication("published"));
		const control = actions({ publishVersion });
		await renderWithRouter(
			<SkillProjectContentEditor
				project={project}
				content={ready}
				actions={control}
			/>,
		);
		fireEvent.change(screen.getByLabelText("版本号"), {
			target: { value: "1.0.0" },
		});
		fireEvent.click(screen.getByRole("button", { name: "发布固定版本" }));
		expect((await screen.findByRole("alert")).textContent).toBe(
			"这个版本号已被使用，或内容已在其他地方修改。已提交的版本不能换包，修改内容请使用新的版本号。",
		);
		// 未修改内容时不重复保存。
		expect(control.saveContent).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "发布固定版本" }));
		expect((await screen.findByRole("alert")).textContent).toBe(
			"Skill 发布暂时不可用，可稍后重试。",
		);
		fireEvent.click(screen.getByRole("button", { name: "发布固定版本" }));
		expect(
			await screen.findByText("v1.0.0 已发布，可以在 Skill Hub 中查看。"),
		).toBeTruthy();
		const keys = publishVersion.mock.calls.map((call) => call[2]);
		expect(new Set(keys).size).toBe(1);
	});

	it("re-reads the server content after a revision conflict", async () => {
		const saveContent = vi
			.fn()
			.mockRejectedValue(Object.assign(new Error("stale"), { status: 409 }));
		const newer: SkillHubProjectContentV1 = {
			...stored,
			revision: 5,
			files: [
				{
					path: "SKILL.md",
					encoding: "utf8",
					content: "# edited elsewhere\n",
					sizeBytes: 19,
				},
			],
		};
		function Harness() {
			const [content, setContent] = useState<SkillProjectContentState>(ready);
			return (
				<SkillProjectContentEditor
					project={project}
					content={content}
					actions={actions({ saveContent })}
					onRetry={async () => setContent({ kind: "ready", content: newer })}
				/>
			);
		}
		await renderWithRouter(<Harness />);
		fireEvent.change(screen.getByLabelText("SKILL.md（任务说明）"), {
			target: { value: "# local\n" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
		expect((await screen.findByRole("alert")).textContent).toMatch(
			/内容已在其他地方修改/,
		);
		fireEvent.click(screen.getByRole("button", { name: "重新读取内容" }));
		await waitFor(() =>
			expect(
				(screen.getByLabelText("SKILL.md（任务说明）") as HTMLTextAreaElement)
					.value,
			).toBe("# edited elsewhere\n"),
		);
		expect(screen.queryAllByLabelText("文件名")).toHaveLength(0);
		// 「重新读取内容」随冲突消失，焦点回到正文而不是 body。
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByLabelText("SKILL.md（任务说明）"),
			),
		);
	});

	it("lays out content on the left and version, scope cards and actions on the right (V-18)", async () => {
		await renderWithRouter(
			<SkillProjectContentEditor
				project={{ ...project, organizationId: "org-a" }}
				content={ready}
				actions={actions()}
				before={<section aria-label="项目信息" />}
				after={<section aria-label="导入固定来源" />}
				notice={<p>权限不会扩大</p>}
			/>,
		);
		const layout = document.querySelector(
			".skill-editor-layout",
		) as HTMLElement;
		const [main, aside] = [...layout.children] as [HTMLElement, HTMLElement];
		// 左栏：项目信息 → Skill 内容 → 导入固定来源。
		expect(
			[...main.querySelectorAll("section")].map(
				(section) =>
					section.getAttribute("aria-label") ??
					section.querySelector("h2")?.textContent,
			),
		).toEqual(["项目信息", "Skill 内容", "导入固定来源"]);
		expect(within(main).getByLabelText("SKILL.md（任务说明）")).toBeTruthy();
		// 右栏：标题、版本号、四张范围卡、说明、「保存草稿」与「发布固定版本」。
		expect(aside.tagName).toBe("ASIDE");
		expect(
			within(layout).getByRole("complementary", { name: "版本与发布范围" }),
		).toBe(aside);
		expect(within(aside).getByLabelText("版本号")).toBeTruthy();
		const scope = within(aside).getByRole("radiogroup", { name: "发布范围" });
		expect(
			within(scope)
				.getAllByRole("radio")
				.map((radio) => [
					radio.getAttribute("aria-checked"),
					radio.hasAttribute("data-disabled"),
				]),
		).toEqual([
			["true", false],
			["false", false],
			["false", false],
			["false", false],
		]);
		expect(
			within(scope)
				.getAllByRole("radio")
				.map(
					(radio) =>
						document.getElementById(
							radio.getAttribute("aria-describedby") ?? "",
						)?.textContent,
				),
		).toEqual([
			"自主创建内容可直接发布",
			"需要独立审核后才可见",
			"需要独立审核后才可见",
			"需要独立审核后才可见",
		]);
		expect(within(aside).getByText("权限不会扩大")).toBeTruthy();
		expect(
			within(aside)
				.getAllByRole("button")
				.map((button) => button.textContent),
		).toEqual(["保存草稿", "发布固定版本"]);
		// 组织项目可以选择组织共享，主按钮随范围改为「提交审核」。
		fireEvent.click(within(scope).getByRole("radio", { name: "组织共享" }));
		expect(
			within(aside).getByRole("button", { name: "提交审核" }),
		).toBeTruthy();
		expect(screen.queryByText(/项目没有所属组织/)).toBeNull();
	});

	it("moves focus to the add-file control after removing a file", async () => {
		await renderWithRouter(
			<SkillProjectContentEditor
				project={project}
				content={ready}
				actions={actions()}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "移除文件：scripts/run.sh" }),
		);
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "添加文本文件" }),
			),
		);
		expect(screen.getAllByLabelText("文件名")).toHaveLength(1);
	});

	it("shows loading and read failures without an editor", async () => {
		await renderWithRouter(
			<SkillProjectContentEditor
				project={project}
				content={{ kind: "loading" }}
			/>,
		);
		expect(screen.getByText("正在读取 Skill 内容…")).toBeTruthy();
		expect(screen.queryByLabelText("SKILL.md（任务说明）")).toBeNull();
		cleanup();
		const retry = vi.fn();
		await renderWithRouter(
			<SkillProjectContentEditor
				project={project}
				content={{ kind: "unavailable", retryable: true }}
				onRetry={retry}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
		expect(retry).toHaveBeenCalledOnce();
		expect(screen.queryByRole("button", { name: "发布固定版本" })).toBeNull();
	});
});
