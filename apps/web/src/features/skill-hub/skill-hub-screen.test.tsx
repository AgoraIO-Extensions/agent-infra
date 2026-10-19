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
	within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillHubDirectoryScreen } from "./skill-hub-screen.js";

const version = SkillHubVersionMetadataV1Schema.parse({
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
const newerVersion = SkillHubVersionMetadataV1Schema.parse({
	...version,
	skillVersionId: "release-notes-v2",
	version: "1.2.0",
});
const marketVersion = SkillHubVersionMetadataV1Schema.parse({
	...version,
	skillId: "incident-summary",
	skillVersionId: "incident-summary-v2",
	name: "incident-summary",
	version: "2.0.0",
	provider: "market",
	visibility: "MARKET",
});

afterEach(cleanup);

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
		].map((path) =>
			createRoute({
				getParentRoute: () => root,
				path,
				component: () => null,
			}),
		),
	];
	const router = createRouter({
		history: createMemoryHistory({ initialEntries: ["/"] }),
		routeTree: root.addChildren(routes),
	});
	await router.load();
	render(<RouterProvider router={router} />);
	return router;
}

describe("SkillHubDirectoryScreen", () => {
	it("renders one row per Skill with its highest published version and one detail link", async () => {
		await renderWithRouter(
			<SkillHubDirectoryScreen
				state={{
					kind: "ready",
					versions: [version, marketVersion, newerVersion],
				}}
			/>,
		);
		expect(
			screen.getByRole("heading", { level: 1, name: "Skill Hub" }),
		).toBeTruthy();
		expect(
			screen.getByRole("heading", { level: 2, name: "Skill 目录" }),
		).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "创建或导入" }).getAttribute("href"),
		).toBe("/skills/manage/new");
		expect(
			screen.getByRole("link", { name: "我的 Skill" }).getAttribute("href"),
		).toBe("/skills/manage");
		const rows = document.querySelectorAll("article.skill-row");
		expect(rows).toHaveLength(2);
		const release = rows[0] as HTMLElement;
		expect(within(release).getByText("v1.2.0")).toBeTruthy();
		expect(within(release).queryByText("v1.0.0")).toBeNull();
		// 名称是纯文本标题，行内唯一的详情链接带对象名（NI-100）。
		expect(release.querySelector("h2 a")).toBeNull();
		const links = within(release).getAllByRole("link");
		expect(links).toHaveLength(1);
		expect(links[0]?.getAttribute("aria-label")).toBe(
			"查看详情：release-notes",
		);
		expect(links[0]?.getAttribute("href")).toBe("/skills/release-notes-v2");
		// 页面不显示内部 ID、摘要、metadata 或实现说明。
		const text = document.body.textContent ?? "";
		expect(text).not.toContain("release-notes-v");
		expect(text).not.toContain("版本 ID");
		expect(text).not.toContain("a".repeat(64));
		expect(text).not.toMatch(/metadata|Worker\/Runtime|个版本/);
		expect(screen.getByRole("status").textContent).toBe("共 2 个 Skill");
		expect(screen.getByRole("status").className).toContain("sr-only");
	});

	it("merges scope and source into one quiet pill without aria-label (N-04, NI-98)", async () => {
		await renderWithRouter(
			<SkillHubDirectoryScreen
				state={{ kind: "ready", versions: [version, marketVersion] }}
			/>,
		);
		const [release, incident] = [
			...document.querySelectorAll("article.skill-row"),
		] as HTMLElement[];
		for (const [row, visible, full] of [
			[release, "仅自己 · 我的库", "范围：仅自己 · 来源：我的库"],
			[incident, "内部市场 · 内部市场", "范围：内部市场 · 来源：内部市场"],
		] as const) {
			const pills = row.querySelectorAll('[data-slot="badge"]');
			expect(pills).toHaveLength(1);
			const pill = pills[0] as HTMLElement;
			expect(pill.getAttribute("data-variant")).toBe("tag");
			expect(pill.textContent).toBe(full);
			// 去掉 sr-only 前缀后的可见文字。
			const clone = pill.cloneNode(true) as HTMLElement;
			for (const hidden of clone.querySelectorAll(".sr-only")) hidden.remove();
			expect(clone.textContent).toBe(visible);
			expect(pill.closest(".skill-row-copy")).toBeTruthy();
			expect(pill.hasAttribute("aria-label")).toBe(false);
			expect(pill.querySelector("[aria-label]")).toBeNull();
			expect(within(row).queryByText("已发布")).toBeNull();
		}
	});

	it("uses design labels for the source and scope filters and clears every filter", async () => {
		const router = await renderWithRouter(
			<SkillHubDirectoryScreen
				state={{ kind: "ready", versions: [version, marketVersion] }}
			/>,
		);
		const source = screen.getByLabelText("来源") as HTMLSelectElement;
		const scope = screen.getByLabelText("发布范围") as HTMLSelectElement;
		expect([...source.options].map((option) => option.textContent)).toEqual([
			"全部来源",
			"平台预置",
			"我的库",
			"内部市场",
			"ClawHub",
			"SkillHub",
			"npx",
			"GitHub",
		]);
		expect([...scope.options].map((option) => option.textContent)).toEqual([
			"全部范围",
			"仅自己",
			"全体成员",
			"组织共享",
			"内部市场",
		]);
		for (const label of document.querySelectorAll('[data-slot="label"]'))
			expect(label.className).toContain("sr-only");
		// 没有筛选条件时不出现「清除筛选」。
		expect(screen.queryByRole("button", { name: "清除筛选" })).toBeNull();

		const search = screen.getByRole("searchbox", { name: "搜索 Skill" });
		fireEvent.change(search, { target: { value: "incident" } });
		expect(document.querySelectorAll("article.skill-row")).toHaveLength(1);
		expect(screen.getByRole("status").textContent).toBe(
			"共 2 个 Skill，匹配 1 个",
		);
		fireEvent.change(source, { target: { value: "my_library" } });
		expect(screen.getByText("没有匹配的 Skill")).toBeTruthy();
		expect(screen.getByText("换个关键词，或清除筛选。")).toBeTruthy();
		fireEvent.change(scope, { target: { value: "PRIVATE" } });
		fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
		expect((search as HTMLInputElement).value).toBe("");
		expect(source.value).toBe("all");
		expect(scope.value).toBe("all");
		expect(document.activeElement).toBe(search);
		expect(document.querySelectorAll("article.skill-row")).toHaveLength(2);
		expect(router.state.location.pathname).toBe("/");
	});

	it("shows a skeleton status while loading and while retrying a failed read", async () => {
		await renderWithRouter(
			<SkillHubDirectoryScreen state={{ kind: "loading" }} />,
		);
		const loading = screen.getByRole("status");
		expect(loading.className).toContain("skill-loading");
		expect(loading.querySelectorAll(".skill-skeleton")).toHaveLength(2);
		expect(loading.textContent).toBe("正在读取 Skill 目录…");
		cleanup();

		await renderWithRouter(
			<SkillHubDirectoryScreen
				state={{ kind: "unavailable", retryable: true }}
				retrying
			/>,
		);
		expect(screen.getByRole("status").textContent).toBe("正在读取 Skill 目录…");
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("reports failures with an empty state and only offers retry when retryable", async () => {
		const retry = vi.fn();
		await renderWithRouter(
			<SkillHubDirectoryScreen
				state={{ kind: "unavailable", retryable: true }}
				onRetry={retry}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toContain("暂时无法读取目录");
		expect(screen.getByText("已安装和绑定记录仍然保留。")).toBeTruthy();
		expect(document.querySelector('[data-slot="alert"]')).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
		expect(retry).toHaveBeenCalledOnce();
		cleanup();

		await renderWithRouter(
			<SkillHubDirectoryScreen
				state={{ kind: "unavailable", retryable: false, reason: "denied" }}
				onRetry={retry}
			/>,
		);
		expect(
			screen.getByText("当前账号没有读取 Skill 目录的权限。"),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "重新读取" })).toBeNull();
	});
});
