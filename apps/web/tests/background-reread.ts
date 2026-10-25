import { expect, type Locator, type Page } from "@playwright/test";
import { expectFocusHeld, holdRequests } from "./page-health";

// 后台重读（#3387）：回到标签页、窗口重新聚焦、轮询与失效后重取。已显示过读取结果时，重读进行中与
// 可重试的失败都不替换页面，未保存的输入、焦点与滚动位置保留（docs/development/web-ui.md「组件与调用方」）。

/** 回到标签页：TanStack Query 只监听 window 上的 visibilitychange / focus，在 window 上派发。 */
export async function backgroundReread(page: Page) {
	await page.evaluate(() =>
		window.dispatchEvent(new Event("visibilitychange")),
	);
}

const backgroundFailure = {
	schemaVersion: 1,
	code: "DEPENDENCY_UNAVAILABLE",
	message: "Controlled background reread failure",
	retryable: true,
	traceId: "trace-background-reread",
};

function scrollState(page: Page) {
	return page.evaluate(() => ({
		scrollY: Math.round(window.scrollY),
		scrollHeight: document.documentElement.scrollHeight,
	}));
}

/**
 * 在用例自己的 fixture 之后调用：回到标签页触发 path 的 GET，先挂起、再以 503 失败（failure 为
 * "network" 时为网络中断）、最后读到。
 * 每一步之后 expectKept 断言已显示的内容与未保存的输入仍在，焦点一直在 focus 上（采样，不落到 body），
 * 页面高度与滚动位置不变。path 为字符串时与 pathname 整段比较，也可传正则。
 */
export async function expectBackgroundRereadKeeps(
	page: Page,
	{
		path,
		focus,
		expectKept,
		expectPending,
		context,
		failure = "503",
	}: {
		path: string | RegExp;
		focus: Locator;
		expectKept: () => Promise<void>;
		/** 挂起时额外的断言（例如页头刷新显示读取中）。 */
		expectPending?: () => Promise<void>;
		context: string;
		/** 可重试失败的形态：503（默认）或网络中断（#3418）。 */
		failure?: "503" | "network";
	},
) {
	const matches = (url: URL) =>
		typeof path === "string" ? url.pathname === path : path.test(url.pathname);
	let failing = false;
	await page.route(matches, (route) =>
		failing && route.request().method() === "GET"
			? failure === "network"
				? route.abort("internetdisconnected")
				: route.fulfill({ status: 503, json: backgroundFailure })
			: route.fallback(),
	);
	await expect(focus, `${context} 前置焦点`).toBeFocused();
	const before = await scrollState(page);
	const check = async (step: string, delays: readonly number[]) => {
		await expectKept();
		await expectFocusHeld(focus, delays, `${context} ${step}`);
		expect(await scrollState(page), `${context} ${step} 滚动位置`).toEqual(
			before,
		);
	};

	// 挂起（后注册的路由先处理：放行后交给上面的失败路由）。
	const holding = await holdRequests(page, "GET", path);
	await backgroundReread(page);
	await expect
		.poll(() => holding.held(), `${context} 后台重读已发出`)
		.toBeGreaterThan(0);
	await check("后台重读挂起", [50, 300]);
	await expectPending?.();

	// 失败（503 或网络中断，可重试）。
	failing = true;
	const failed =
		failure === "network"
			? page.waitForEvent(
					"requestfailed",
					(request) =>
						matches(new URL(request.url())) && request.method() === "GET",
				)
			: page.waitForResponse(
					(response) =>
						matches(new URL(response.url())) &&
						response.request().method() === "GET" &&
						response.status() === 503,
				);
	holding.release();
	await failed;
	await check("后台重读失败", [50, 300, 1000]);

	// 再次回到标签页读到：内容与输入仍是用户留下的。
	failing = false;
	const recovered = page.waitForResponse(
		(response) =>
			matches(new URL(response.url())) &&
			response.request().method() === "GET" &&
			response.ok(),
	);
	await backgroundReread(page);
	await recovered;
	await check("后台重读恢复", [50, 300, 1000]);
}
