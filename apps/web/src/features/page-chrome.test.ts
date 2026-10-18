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
		expect(resolvePageChrome({ pathname: "/admin/no-such-page" })).toBe(
			notFoundChrome,
		);
		expect(resolvePageChrome({ pathname: "/agents", notFound: true })).toBe(
			notFoundChrome,
		);
	});
});
