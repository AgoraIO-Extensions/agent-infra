import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillHubManagementScreen } from "./skill-hub-management-screen.js";

afterEach(cleanup);

async function renderWithRouter(content: ReactNode) {
	const root = createRootRoute();
	const contentRoute = createRoute({
		getParentRoute: () => root,
		path: "/",
		component: () => content,
	});
	const directoryRoute = createRoute({
		getParentRoute: () => root,
		path: "/skills",
		component: () => null,
	});
	const detailRoute = createRoute({
		getParentRoute: () => root,
		path: "/skills/$skillVersionId",
		component: () => null,
	});
	const router = createRouter({
		history: createMemoryHistory({ initialEntries: ["/"] }),
		routeTree: root.addChildren([contentRoute, directoryRoute, detailRoute]),
	});
	await router.load();
	render(<RouterProvider router={router} />);
	return router;
}

describe("SkillHubManagementScreen", () => {
	it("shows management boundaries and authorized published metadata", async () => {
		await renderWithRouter(
			<SkillHubManagementScreen
				isAdministrator
				state={{
					kind: "ready",
					versions: [
						{
							schemaVersion: 1,
							skillId: "release-notes",
							skillVersionId: "release-notes-v1",
							provider: "my_library",
							version: "1.2.0",
							packageDigest: "a".repeat(64),
							manifestDigest: "b".repeat(64),
							signatureDigest: "c".repeat(64),
							name: "release-notes",
							visibility: "PRIVATE",
							state: "published",
						},
					],
				}}
			/>,
		);
		expect(
			screen.getByRole("heading", { name: "管理固定版本与 Agent 配置。" }),
		).toBeTruthy();
		expect(screen.getByText("release-notes")).toBeTruthy();
		expect(screen.getByText("范围：私人 · 来源：我的库")).toBeTruthy();
		expect(screen.getByText("已发布")).toBeTruthy();
		expect(
			screen
				.getByRole("link", { name: "打开 Skill 目录" })
				.getAttribute("href"),
		).toBe("/skills");
		expect(
			screen.getByRole("link", { name: "release-notes" }).getAttribute("href"),
		).toBe("/skills/release-notes-v1");
		expect(screen.getByText(/绑定固定版本并读取 pending_sync/)).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "创建项目" }).hasAttribute("disabled"),
		).toBe(true);
	});

	it("submits a project through the server action boundary", async () => {
		const createProject = vi.fn().mockResolvedValue({});
		const listProjects = vi.fn().mockResolvedValue({ items: [] });
		await renderWithRouter(
			<SkillHubManagementScreen
				isAdministrator={false}
				state={{ kind: "ready", versions: [] }}
				actions={{
					createProject,
					listProjects,
					updateProject: vi.fn(),
					importVersion: vi.fn(),
					publishVersion: vi.fn(),
					reviewVersion: vi.fn(),
					revokeVersion: vi.fn(),
					readBindings: vi.fn(),
					bindVersion: vi.fn(),
				}}
			/>,
		);
		fireEvent.change(screen.getByLabelText("项目名称"), {
			target: { value: "release-notes" },
		});
		fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
		await vi.waitFor(() =>
			expect(createProject).toHaveBeenCalledWith(
				{
					schemaVersion: 1,
					name: "release-notes",
				},
				expect.any(String),
			),
		);
		expect(listProjects).toHaveBeenCalledOnce();
	});

	it("reuses the idempotency key when a write is retried", async () => {
		const createProject = vi
			.fn()
			.mockRejectedValueOnce(
				Object.assign(new Error("temporary"), { status: 503 }),
			)
			.mockResolvedValue({
				name: "release-notes",
				status: "active",
			});
		await renderWithRouter(
			<SkillHubManagementScreen
				isAdministrator={false}
				state={{ kind: "ready", versions: [] }}
				actions={{
					createProject,
					listProjects: vi.fn().mockResolvedValue({ items: [] }),
					updateProject: vi.fn(),
					importVersion: vi.fn(),
					publishVersion: vi.fn(),
					reviewVersion: vi.fn(),
					revokeVersion: vi.fn(),
					readBindings: vi.fn(),
					bindVersion: vi.fn(),
				}}
			/>,
		);
		fireEvent.change(screen.getByLabelText("项目名称"), {
			target: { value: "release-notes" },
		});
		const button = screen.getByRole("button", { name: "创建项目" });
		fireEvent.click(button);
		await vi.waitFor(() =>
			expect(
				screen.getByText("Skill Hub 后端暂时不可用，可稍后重试。"),
			).toBeTruthy(),
		);
		fireEvent.click(button);
		await vi.waitFor(() => expect(createProject).toHaveBeenCalledTimes(2));
		expect(createProject.mock.calls[0]?.[1]).toBe(
			createProject.mock.calls[1]?.[1],
		);
	});

	it("renders the publication state returned by review", async () => {
		const reviewVersion = vi.fn().mockResolvedValue({
			replayed: false,
			version: { state: "published", reviewReason: null },
		});
		await renderWithRouter(
			<SkillHubManagementScreen
				isAdministrator
				state={{ kind: "ready", versions: [] }}
				actions={{
					createProject: vi.fn(),
					listProjects: vi.fn().mockResolvedValue({ items: [] }),
					updateProject: vi.fn(),
					importVersion: vi.fn(),
					publishVersion: vi.fn(),
					reviewVersion,
					revokeVersion: vi.fn(),
					readBindings: vi.fn(),
					bindVersion: vi.fn(),
				}}
			/>,
		);
		fireEvent.change(screen.getAllByLabelText("Skill 版本 ID")[0], {
			target: { value: "release-notes-v1" },
		});
		fireEvent.click(screen.getByRole("button", { name: "提交审核" }));
		await vi.waitFor(() =>
			expect(screen.getByText("审核成功：服务端状态 published。")).toBeTruthy(),
		);
	});

	it("keeps server publication and Applied states visible", async () => {
		const readBindings = vi.fn().mockResolvedValue({
			bindings: [
				{
					state: "synced",
					appliedReceipt: { targetPath: ".agents/skills/release-notes" },
				},
			],
		});
		await renderWithRouter(
			<SkillHubManagementScreen
				isAdministrator={false}
				state={{ kind: "ready", versions: [] }}
				actions={{
					createProject: vi.fn(),
					listProjects: vi.fn().mockResolvedValue({ items: [] }),
					updateProject: vi.fn(),
					importVersion: vi.fn(),
					publishVersion: vi.fn(),
					reviewVersion: vi.fn(),
					revokeVersion: vi.fn(),
					readBindings,
					bindVersion: vi.fn(),
				}}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Agent ID"), {
			target: { value: "agent-1" },
		});
		fireEvent.change(screen.getByLabelText("Agent 版本"), {
			target: { value: "v1" },
		});
		fireEvent.click(screen.getByRole("button", { name: "读取状态" }));
		await vi.waitFor(() =>
			expect(
				screen.getByText(
					"服务端绑定状态：synced / Applied（.agents/skills/release-notes）。",
				),
			).toBeTruthy(),
		);
	});

	it("allows an Owner-authorized revoke without requiring administrator role", async () => {
		const revokeVersion = vi.fn().mockResolvedValue({
			replayed: false,
			version: { state: "revoked", reviewReason: null },
		});
		const version = {
			schemaVersion: 1 as const,
			skillId: "release-notes",
			skillVersionId: "release-notes-v1",
			provider: "my_library" as const,
			version: "1.2.0",
			packageDigest: "a".repeat(64),
			manifestDigest: "b".repeat(64),
			signatureDigest: "c".repeat(64),
			name: "release-notes",
			visibility: "PRIVATE" as const,
			state: "published" as const,
		};
		await renderWithRouter(
			<SkillHubManagementScreen
				isAdministrator={false}
				state={{ kind: "ready", versions: [version] }}
				actions={{
					createProject: vi.fn(),
					listProjects: vi.fn().mockResolvedValue({ items: [] }),
					updateProject: vi.fn(),
					importVersion: vi.fn(),
					publishVersion: vi.fn(),
					reviewVersion: vi.fn(),
					revokeVersion,
					readBindings: vi.fn(),
					bindVersion: vi.fn(),
				}}
			/>,
		);
		fireEvent.change(screen.getAllByLabelText("Skill 版本 ID")[0], {
			target: { value: "release-notes-v1" },
		});
		const revokeButton = screen.getByRole("button", { name: "撤销版本" });
		expect(revokeButton.hasAttribute("disabled")).toBe(false);
		fireEvent.click(revokeButton);
		await vi.waitFor(() =>
			expect(revokeVersion).toHaveBeenCalledWith(
				"release-notes-v1",
				expect.any(String),
			),
		);
	});

	it("keeps retryable and denied states separate", async () => {
		await renderWithRouter(
			<SkillHubManagementScreen
				isAdministrator={false}
				state={{ kind: "unavailable", retryable: false, reason: "denied" }}
			/>,
		);
		expect(screen.getByText("当前账号无法读取 Skill Hub 状态。")).toBeTruthy();
	});
});
