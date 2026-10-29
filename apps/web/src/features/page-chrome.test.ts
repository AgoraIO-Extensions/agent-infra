import { describe, expect, it } from "vitest";
import {
	navigationGroups,
	type navigationLabels,
	notFoundChrome,
	resolvePageChrome,
} from "./page-chrome.js";

// 只取文件名，不加载路由模块。
const routeFiles = Object.keys(import.meta.glob("../routes/**/*.tsx")).filter(
	(file) => !file.endsWith("/__root.tsx"),
);

/** 把 TanStack 文件路由名换成一条示例路径（参数代入示例值）。 */
function samplePath(file: string): string {
	const segments = file
		.replace(/^\.\.\/routes\//, "")
		.replace(/\.tsx$/, "")
		.split(/[/.]/)
		.filter((segment) => segment !== "index")
		.map((segment) =>
			/^\{?-?\$/.test(segment) ? "sample-id" : segment.replace(/[{}]/g, ""),
		);
	return `/${segments.join("/")}`;
}

describe("page chrome route table", () => {
	it("exposes evaluation once in the employee workspace without exposing admin routes", () => {
		const groups = navigationGroups.filter((g) => g.items.includes("eval"));
		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({
			label: "工作区",
			administratorOnly: false,
		});
		expect(resolvePageChrome({ pathname: "/eval" })).toMatchObject({
			crumbParent: "工作区",
			title: "评测",
		});
		expect(
			navigationGroups.find((g) => g.items.includes("admin-agents"))
				?.administratorOnly,
		).toBe(true);
	});
	it("finds the file routes it is checking", () => {
		expect(routeFiles.length).toBeGreaterThan(15);
		expect(routeFiles.map(samplePath)).toContain("/chat/sample-id/sample-id");
	});

	it.each(routeFiles.map((file) => [file, samplePath(file)]))(
		"registers file route %s (%s) instead of falling back to not found",
		(_file, path) => {
			const chrome = resolvePageChrome({ pathname: path });
			expect(chrome).not.toBe(notFoundChrome);
			expect(chrome.navKey).toBeDefined();
			// 当前导航项必须在某个侧栏分组里。
			expect(
				navigationGroups.some((group) =>
					group.items.includes(chrome.navKey as keyof typeof navigationLabels),
				),
			).toBe(true);
		},
	);

	it("treats trailing slashes as the same route and unknown paths as not found", () => {
		expect(resolvePageChrome({ pathname: "/skills/manage/" }).title).toBe(
			"我的 Skill",
		);
		// 创建与发布页不被 /skills/$skillVersionId 吞掉，侧栏仍高亮我的 Skill。
		expect(resolvePageChrome({ pathname: "/skills/manage/new" })).toMatchObject(
			{ crumbParent: "我的 Skill", title: "创建与发布", navKey: "my-skills" },
		);
		expect(
			resolvePageChrome({ pathname: "/admin/skill-reviews" }),
		).toMatchObject({
			crumbParent: "系统管理",
			title: "Skill 审核",
			navKey: "skill-reviews",
		});
		expect(resolvePageChrome({ pathname: "/admin/no-such-page" })).toBe(
			notFoundChrome,
		);
		expect(resolvePageChrome({ pathname: "/agents", notFound: true })).toBe(
			notFoundChrome,
		);
	});

	// B2-06：Agent 的 Skill 页顶栏按导出稿 'agent-skills' 为「Owner 配置 / Skill 绑定」。
	it("names the Agent Skill page Skill 绑定 under Owner 配置 (B2-06)", () => {
		expect(
			resolvePageChrome({ pathname: "/agents/agent-pilot-1/skills" }),
		).toEqual({
			navKey: "agents",
			crumbParent: "Owner 配置",
			title: "Skill 绑定",
			documentTitle: "Skill 绑定 · Agora Agent",
		});
	});
});
