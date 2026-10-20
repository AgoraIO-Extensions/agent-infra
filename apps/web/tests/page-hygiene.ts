import type { Page } from "@playwright/test";

/**
 * 同一页面没有同名控件（#2830 终验 AC-2、N-12）：可见按钮的可访问名称互不相同；可见链接只有
 * 指向同一地址时才允许同名（例如侧栏与区块头的「创建申请」都进入 /my-agents/new）。
 * 返回重名项（名称与各自目标），断言时期望为空数组。
 */
export async function duplicateControlNames(page: Page) {
	return page.evaluate(() => {
		const accessibleName = (element: HTMLElement) => {
			const label = element.getAttribute("aria-label");
			if (label) return label;
			const labelledBy = element.getAttribute("aria-labelledby");
			if (labelledBy)
				return labelledBy
					.split(/\s+/)
					.map((id) => document.getElementById(id)?.textContent ?? "")
					.join(" ");
			return element.textContent ?? "";
		};
		const targets = new Map<string, string[]>();
		for (const element of document.querySelectorAll<HTMLElement>(
			"a[href], button",
		)) {
			if (!element.checkVisibility()) continue;
			if (element.closest('[aria-hidden="true"], [inert]')) continue;
			const name = accessibleName(element).replace(/\s+/g, " ").trim();
			if (!name) continue;
			const target =
				element instanceof HTMLAnchorElement
					? `link:${element.href}`
					: `button:${targets.get(name)?.length ?? 0}`;
			targets.set(name, [...(targets.get(name) ?? []), target]);
		}
		return [...targets]
			.filter(([, values]) => new Set(values).size > 1)
			.map(([name, values]) => `${name} → ${values.join(" | ")}`);
	});
}
