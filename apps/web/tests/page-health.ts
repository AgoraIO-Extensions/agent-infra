import { expect, type Page } from "@playwright/test";

// 同页同名控件检查（#3040 AC-2）；控制台错误与横向溢出用 primitive-styles 的 expectCleanPage。

const controlRoles = [
	"button",
	"link",
	"checkbox",
	"combobox",
	"textbox",
	"searchbox",
	"tab",
	"radio",
	"switch",
	"menuitem",
	"spinbutton",
] as const;

/**
 * 主内容区内同一角色的可交互控件不能同名（读屏用户按名称区分）。可访问名称取
 * Playwright 的 ARIA 快照，与读屏计算一致；没有名称的控件不参与比较。
 */
export async function expectNoDuplicateControls(page: Page, context: string) {
	const snapshot = await page.locator("#main-content").ariaSnapshot();
	const pattern = new RegExp(
		`^\\s*- (${controlRoles.join("|")}) "((?:[^"\\\\]|\\\\.)*)"`,
	);
	const counts = new Map<string, number>();
	for (const line of snapshot.split("\n")) {
		const match = pattern.exec(line);
		if (!match) continue;
		const key = `${match[1]} "${match[2]}"`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const duplicates = [...counts].filter(([, count]) => count > 1);
	expect(duplicates, `${context} 同名控件`).toEqual([]);
}
