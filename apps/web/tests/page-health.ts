import {
	type ConsoleMessage,
	expect,
	type Locator,
	type Page,
	type Request,
	type Response,
	type TestInfo,
} from "@playwright/test";
import type { AnyRouter } from "@tanstack/react-router";

/** 白屏失败的有界启动证据；不保存消息、请求正文、Header 或原始异常文本。 */
export function recordStartupEvidence(page: Page) {
	const startedAt = Date.now();
	const events: object[] = [];
	const counters = () => ({ issued: 0, finished: 0, failed: 0 });
	const api = counters();
	const criticalEvents: object[] = [];
	let criticalDropped = 0;
	// 脚本事件可能先占满100条；另保留最近20条API状态，缺少单条记录不代表请求未发生。
	const apiResponses: object[] = [];
	const requestNavigations = new WeakMap<Request, number>();
	let dropped = 0;
	let navigation = 0;
	let latestNavigation = {
		navigation,
		api: counters(),
		scripts: counters(),
		scriptEvents: [] as object[],
		scriptDropped: 0,
	};
	const path = (url: string) => {
		try {
			const value = new URL(url);
			return value.protocol === "http:" || value.protocol === "https:"
				? value.pathname.slice(0, 256)
				: "non-http";
		} catch {
			return "unavailable";
		}
	};
	const isApi = (request: Request) => path(request.url()).startsWith("/api/");
	const add = (event: { kind: string; [key: string]: unknown }) => {
		const entry = { elapsedMs: Date.now() - startedAt, navigation, ...event };
		if (events.length < 100) events.push(entry);
		else dropped++;
		if (
			["request-failed", "page-error", "console-error", "page-crash"].includes(
				event.kind,
			)
		) {
			criticalEvents.push(entry);
			if (criticalEvents.length > 20) {
				criticalEvents.shift();
				criticalDropped++;
			}
		}
	};
	const scriptEvent = (event: object) => {
		latestNavigation.scriptEvents.push({
			elapsedMs: Date.now() - startedAt,
			...event,
		});
		if (latestNavigation.scriptEvents.length > 20) {
			latestNavigation.scriptEvents.shift();
			latestNavigation.scriptDropped++;
		}
	};
	const observe = (value: Request, phase: "issued" | "finished" | "failed") => {
		const current = requestNavigations.get(value) === navigation;
		if (isApi(value)) {
			api[phase]++;
			if (current) latestNavigation.api[phase]++;
		}
		if (current && value.resourceType() === "script") {
			latestNavigation.scripts[phase]++;
			scriptEvent({ kind: phase, path: path(value.url()) });
		}
	};
	const request = (value: Request) => {
		let mainDocument = false;
		try {
			mainDocument =
				value.resourceType() === "document" &&
				value.isNavigationRequest() &&
				value.frame() === page.mainFrame();
		} catch {}
		if (mainDocument) {
			navigation++;
			latestNavigation = {
				navigation,
				api: counters(),
				scripts: counters(),
				scriptEvents: [],
				scriptDropped: 0,
			};
			add({ kind: "document", path: path(value.url()) });
		}
		requestNavigations.set(value, navigation);
		observe(value, "issued");
		if (value.resourceType() === "script")
			add({ kind: "script-request", path: path(value.url()) });
	};
	const finished = (value: Request) => {
		observe(value, "finished");
		if (["document", "script"].includes(value.resourceType()))
			add({
				kind: "finished",
				navigation: requestNavigations.get(value) ?? navigation,
				type: value.resourceType(),
				path: path(value.url()),
			});
	};
	const failed = (value: Request) => {
		observe(value, "failed");
		add({
			kind: "request-failed",
			navigation: requestNavigations.get(value) ?? navigation,
			type: value.resourceType(),
			path: path(value.url()),
			code:
				value.failure()?.errorText.match(/^net::ERR_[A-Z_]+$/)?.[0] ?? "other",
		});
	};
	const response = (value: Response) => {
		const type = value.request().resourceType();
		if (isApi(value.request())) {
			apiResponses.push({
				navigation: requestNavigations.get(value.request()) ?? navigation,
				path: path(value.url()),
				status: value.status(),
			});
			if (apiResponses.length > 20) apiResponses.shift();
		}
		const mediaType = value.headers()["content-type"]?.split(";", 1)[0]?.trim();
		const contentType = [
			"text/html",
			"text/javascript",
			"application/javascript",
			"application/json",
			"text/css",
			"application/octet-stream",
		].includes(mediaType ?? "")
			? mediaType
			: "other";
		if (
			type === "script" &&
			requestNavigations.get(value.request()) === navigation
		)
			scriptEvent({
				kind: "response",
				path: path(value.url()),
				status: value.status(),
				contentType,
			});
		if (type === "document" || type === "script" || isApi(value.request()))
			add({
				kind: "response",
				navigation: requestNavigations.get(value.request()) ?? navigation,
				type,
				path: path(value.url()),
				status: value.status(),
				contentType,
			});
	};
	const pageError = (error: Error) => {
		const category =
			/dynamically imported module|module script|MIME type/i.test(error.message)
				? "module-load"
				: /unexpected token|syntax/i.test(error.message)
					? "syntax"
					: "runtime";
		add({ kind: "page-error", category });
	};
	const consoleError = (message: ConsoleMessage) => {
		if (message.type() !== "error") return;
		const location = message.location();
		add({
			kind: "console-error",
			path: path(location.url),
			line: location.lineNumber,
			column: location.columnNumber,
		});
	};
	const crash = () => add({ kind: "page-crash" });
	page.on("request", request);
	page.on("requestfinished", finished);
	page.on("requestfailed", failed);
	page.on("response", response);
	page.on("pageerror", pageError);
	page.on("console", consoleError);
	page.on("crash", crash);
	const dispose = () => {
		page.off("request", request);
		page.off("requestfinished", finished);
		page.off("requestfailed", failed);
		page.off("response", response);
		page.off("pageerror", pageError);
		page.off("console", consoleError);
		page.off("crash", crash);
	};
	return {
		dispose,
		async attach(info: TestInfo) {
			const document = await page
				.evaluate(() => {
					const app = window.document.getElementById("app");
					const router = (
						window as typeof window & { __TSR_ROUTER__?: AnyRouter }
					).__TSR_ROUTER__;
					const matches = (value: unknown) =>
						Array.isArray(value)
							? {
									count: value.length,
									statuses: value
										.slice(0, 64)
										.map((match) =>
											[
												"pending",
												"success",
												"error",
												"redirected",
												"notFound",
											].includes(match?.status)
												? match.status
												: "other",
										),
								}
							: null;
					let routing: Record<string, unknown> = { present: Boolean(router) };
					try {
						if (router)
							routing = {
								present: true,
								status: ["pending", "idle"].includes(router.state.status)
									? router.state.status
									: "other",
								isLoading:
									typeof router.state.isLoading === "boolean"
										? router.state.isLoading
										: null,
								isTransitioning:
									typeof router.state.isTransitioning === "boolean"
										? router.state.isTransitioning
										: null,
								matches: matches(router.state.matches),
								pendingMatches: matches(router.stores?.pendingMatches?.get()),
							};
					} catch {
						routing = { present: true, unreadable: true };
					}
					return {
						readyState: window.document.readyState,
						appChildren: app?.childElementCount ?? null,
						bodyTextLength: window.document.body?.innerText.length ?? null,
						reactRootCreated: app
							? Object.getOwnPropertyNames(app).some((key) =>
									key.startsWith("__reactContainer$"),
								)
							: false,
						router: routing,
					};
				})
				.catch(() => null);
			await info
				.attach("startup-evidence", {
					body: JSON.stringify({
						path: path(page.url()),
						navigation,
						document,
						api,
						apiResponses,
						latestNavigation,
						criticalEvents,
						criticalDropped,
						events,
						dropped,
					}),
					contentType: "application/json",
				})
				.catch(() => undefined);
		},
	};
}

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

/** 吸顶顶栏下缘与视口高度，以及 locator 当前的上下缘（视口坐标）。 */
export async function topbarClearance(target: Locator) {
	return target.evaluate((element) => {
		const bar = document
			.querySelector(".platform-topbar")
			?.getBoundingClientRect();
		const rect = element.getBoundingClientRect();
		return {
			barTop: bar?.top ?? Number.NaN,
			barBottom: bar?.bottom ?? Number.NaN,
			top: rect.top,
			bottom: rect.bottom,
			innerHeight,
		};
	});
}

/**
 * 吸顶顶栏与让位规则（#3329 N10-3-02）：顶栏 sticky、高 72px（1440 与 390 相同），根滚动容器的
 * scroll-padding-top 为顶栏高度加 16px，顶栏里的控件的滚动目标区下移同样的距离。
 */
export async function expectStickyTopbarClearance(page: Page) {
	expect(
		await page.evaluate(() => {
			const bar = document.querySelector(".platform-topbar");
			const control = bar?.querySelector("a, button");
			return {
				position: bar ? getComputedStyle(bar).position : null,
				height: bar?.getBoundingClientRect().height,
				padding: getComputedStyle(document.documentElement).scrollPaddingTop,
				controlMargin: control
					? [
							getComputedStyle(control).scrollMarginTop,
							getComputedStyle(control).scrollMarginBottom,
						]
					: null,
			};
		}),
	).toEqual({
		position: "sticky",
		height: 72,
		padding: "88px",
		controlMargin: ["-88px", "88px"],
	});
}

/**
 * 获得焦点的控件不被吸顶顶栏遮挡（WCAG 2.2 SC 2.4.11，#3329 N10-3-02）：target 是当前焦点，整框在
 * 顶栏下缘与视口下缘之间。调用方先把 target 滚到顶栏之下（precondition），再触发程序聚焦或 Tab。
 */
export async function expectFocusUnobscured(target: Locator, context: string) {
	await expect(target, `${context} 焦点`).toBeFocused();
	// 浏览器在聚焦的同一帧滚动；等一帧再量，不读到滚动前的位置。
	await target.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(resolve)),
	);
	const box = await topbarClearance(target);
	// 顶栏吸顶在视口顶端，没有随页面滚走。
	expect(box.barTop, `${context} 顶栏位置`).toBe(0);
	expect(box.top, `${context} 焦点目标上缘在顶栏之下`).toBeGreaterThanOrEqual(
		box.barBottom - 0.5,
	);
	expect(box.bottom, `${context} 焦点目标下缘在视口内`).toBeLessThanOrEqual(
		box.innerHeight + 0.5,
	);
}

/**
 * 不经焦点移动地滚动页面，让 target 的上缘停在视口 y 处（#3329 N10-3-02 的前置状态：把触发按钮滚到
 * 顶栏附近，上方的字段因此在顶栏之下）。返回滚动后的位置，调用方断言前置状态确实成立。
 */
export async function scrollTopTo(target: Locator, y: number) {
	await target.evaluate((element, y) => {
		window.scrollBy({
			top: element.getBoundingClientRect().top - y,
			behavior: "instant",
		});
	}, y);
	return topbarClearance(target);
}
