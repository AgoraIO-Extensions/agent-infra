import { expect, type Locator, type Page } from "@playwright/test";

// 同页同名控件检查（#3040 AC-2）、动作后的焦点采样（#3235）与请求进行中的焦点（#3242）；
// 控制台错误与横向溢出用 primitive-styles 的 expectCleanPage。

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

/**
 * 挂起请求（#3242 K7-02）：在用例自己的 fixture 之后注册（后注册的路由先处理），命中 method 与
 * path 的请求等到 release() 才交回 fixture（route.fallback）。用于在请求进行中多次采样焦点。
 * path 为字符串时与 pathname 整段比较，也可传正则。release() 之后命中的请求直接放行。
 */
export async function holdRequests(
	page: Page,
	method: string,
	path: string | RegExp,
) {
	let open!: () => void;
	const gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	let held = 0;
	const matches = (url: URL) =>
		typeof path === "string" ? url.pathname === path : path.test(url.pathname);
	await page.route(matches, async (route) => {
		if (route.request().method() !== method) return route.fallback();
		held += 1;
		await gate;
		// 页面已离开时请求随之取消，不再交回 fixture。
		await route.fallback().catch(() => undefined);
	});
	return {
		/** 已命中（挂住或已放行）的请求数。 */
		held: () => held,
		release: () => open(),
	};
}

/**
 * 给元素打上测试标记，返回只指向这一个元素的 Locator：按钮在请求进行中会改名（「保存中…」），
 * 按名称查找会换成别的元素；元素被替换时标记随之消失，采样也会失败（#3242 K7-02）。
 */
export async function pinElement(target: Locator, key: string) {
	await target.evaluate((element, value) => {
		element.setAttribute("data-focus-probe", value);
	}, key);
	return target.page().locator(`[data-focus-probe="${key}"]`);
}

/**
 * 请求进行中的触发按钮（D2-59、#3242 K7-02）：可聚焦的禁用——aria-disabled="true"、没有原生
 * disabled——并且焦点一直在它上面（默认在 30 / 150 / 400 / 1000ms 采样）。
 */
export async function expectFocusableBusy(
	trigger: Locator,
	context: string,
	delays: readonly number[] = [30, 150, 400, 1000],
) {
	await expect(trigger, `${context} aria-disabled`).toHaveAttribute(
		"aria-disabled",
		"true",
	);
	expect(
		await trigger.evaluate(
			(element) => (element as HTMLButtonElement).disabled === true,
		),
		`${context} 原生 disabled`,
	).toBe(false);
	await expectFocusHeld(trigger, delays, `${context} 进行中`);
}

/** 动作完成后焦点落到 target，之后多次采样仍在（默认 50 / 300 / 1000ms），不落到 body。 */
export async function expectFocusSettled(
	target: Locator,
	context: string,
	delays: readonly number[] = [50, 300, 1000],
) {
	await expect(target, `${context} 完成后焦点`).toBeFocused();
	await expectFocusHeld(target, delays, `${context} 完成后`);
}
