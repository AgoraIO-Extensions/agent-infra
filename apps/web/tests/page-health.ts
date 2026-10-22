import { expect, type Locator, type Page } from "@playwright/test";

// 同页同名控件检查（#3040 AC-2）与动作后的焦点采样（#3235）；控制台错误与横向溢出用
// primitive-styles 的 expectCleanPage。

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

/**
 * 动作后的焦点采样（D2-59、#3235 I6-01）：从调用时刻起，在每个延时（ms）读取一次
 * document.activeElement。是 target 本身记为 "target"，落到 body 记为 "body"，其余记为
 * 「标签:名称」，失败信息能直接看出焦点去了哪里。target 换成新元素也算失败。
 */
export async function expectFocusHeld(
	target: Locator,
	delays: readonly number[],
	context: string,
) {
	const samples = await target.evaluate(async (element, delays) => {
		const start = performance.now();
		const result: string[] = [];
		for (const delay of delays) {
			const wait = start + delay - performance.now();
			if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
			const active = document.activeElement;
			result.push(
				active === element
					? "target"
					: !active || active === document.body
						? "body"
						: `${active.tagName.toLowerCase()}:${active.getAttribute("aria-label") ?? active.textContent?.trim() ?? ""}`,
			);
		}
		return result;
	}, delays);
	expect(samples, `${context} 焦点采样（${delays.join(" / ")}ms）`).toEqual(
		delays.map(() => "target"),
	);
}
