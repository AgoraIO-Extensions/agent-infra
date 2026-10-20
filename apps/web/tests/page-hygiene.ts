import { expect, type Page } from "@playwright/test";

/**
 * 收集页面的 console error 与未捕获异常（#2830 终验 AC-2）。在 page.goto 之前调用，
 * 断言时检查返回的数组为空。
 */
export function collectPageErrors(page: Page) {
	const errors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	page.on("pageerror", (error) => errors.push(error.message));
	return errors;
}

/** 页面没有横向溢出：文档宽度不超过视口宽度。 */
export async function expectNoHorizontalOverflow(page: Page) {
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
}

/**
 * 同一页面没有同名控件（N-12）：可见按钮的可访问名称互不相同；可见链接只有指向同一地址时
 * 才允许同名（例如侧栏与区块头的「创建申请」都进入 /my-agents/new）。返回重名项供断言。
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
