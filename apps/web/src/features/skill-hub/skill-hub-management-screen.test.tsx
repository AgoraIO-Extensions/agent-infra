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
			expect(createProject).toHaveBeenCalledWith({
				schemaVersion: 1,
				name: "release-notes",
			}),
		);
		expect(listProjects).toHaveBeenCalledOnce();
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
