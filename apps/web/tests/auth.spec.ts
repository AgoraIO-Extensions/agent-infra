import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import {
	pilotAgentDetailFromV2,
	pilotFakeScenariosV2,
} from "@agent-infra/test-support/pilot";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import {
	expectFocusableBusy,
	expectFocusSettled,
	expectNoDuplicateControls,
	holdRequests,
	pinElement,
} from "./page-health";
import { expectCleanPage, trackPageErrors } from "./primitive-styles";

// 本文件在 auth-desktop / auth-mobile project 中运行：构建配置了同源登录入口（NI-113）。
const session = {
	schemaVersion: 1,
	user: {
		userId: "employee-auth-browser",
		displayName: "登录员工",
		roles: ["employee"],
	},
};
const anonymousBody = {
	schemaVersion: 1,
	code: "AUTHENTICATION_REQUIRED",
	message: "Authentication required",
	retryable: false,
	traceId: "trace-auth-browser",
};
const agent = AgentProjectionV2Schema.parse(
	pilotFakeScenariosV2.starting.response.body,
);

/**
 * 受控 API：会话由 authenticated 决定；模拟 OIDC 完成后重定向回平台。
 * Agent 目录与详情只返回合成数据，其余 API 一律中止，避免依赖真实后端。
 */
async function platform(
	page: Page,
	{
		agentDetailStatus,
		agentsStatus,
	}: {
		agentDetailStatus?: () => number;
		/** Agent 目录读取的状态码（默认 200）。 */
		agentsStatus?: () => number;
	} = {},
) {
	const state = { authenticated: false };
	await page.route("**/api/**", async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname === "/api/v1/session")
			return state.authenticated
				? route.fulfill({ status: 200, json: session })
				: route.fulfill({ status: 401, json: anonymousBody });
		if (url.pathname === "/api/v1/connection/capability")
			return route.fulfill({
				json: { schemaVersion: 1, status: "unavailable", reason: "missing" },
			});
		if (url.pathname === "/api/v2/agents") {
			const status = agentsStatus?.() ?? 200;
			return status === 200
				? route.fulfill({ json: { items: [agent], nextCursor: null } })
				: route.fulfill({ status, json: anonymousBody });
		}
		if (url.pathname === `/api/v2/agents/${agent.agentId}`) {
			const status = agentDetailStatus?.() ?? 200;
			return status === 200
				? route.fulfill({ json: agent })
				: route.fulfill({ status, json: anonymousBody });
		}
		// Agent 详情页读取带 Owner 状态的详情投影（#2910）。
		if (url.pathname === `/api/v2/agents/${agent.agentId}/detail`) {
			const status = agentDetailStatus?.() ?? 200;
			return status === 200
				? route.fulfill({ json: pilotAgentDetailFromV2(agent) })
				: route.fulfill({ status, json: anonymousBody });
		}
		return route.abort();
	});
	await page.route("**/auth/oidc/login", async (route) => {
		expect(route.request().isNavigationRequest()).toBe(true);
		expect(route.request().method()).toBe("GET");
		state.authenticated = true;
		await route.fulfill({ status: 303, headers: { location: "/agents" } });
	});
	return state;
}

const companyLogin = (page: Page) =>
	page.getByRole("link", { name: "使用公司账号登录" });

async function box(page: Page, selector: string) {
	const rect = await page.locator(selector).first().boundingBox();
	if (!rect) throw new Error(`${selector} is not rendered`);
	return rect;
}
function style(page: Page, selector: string, properties: string[]) {
	return page
		.locator(selector)
		.first()
		.evaluate(
			(element, names) =>
				Object.fromEntries(
					names.map((name) => [
						name,
						getComputedStyle(element).getPropertyValue(name),
					]),
				),
			properties,
		);
}
/** 计算设计 color-mix 的实际颜色，避免手写近似值。 */
function resolvedColor(page: Page, value: string) {
	return page.evaluate((color) => {
		const probe = document.createElement("span");
		probe.style.color = color;
		document.body.append(probe);
		const resolved = getComputedStyle(probe).color;
		probe.remove();
		return resolved;
	}, value);
}

test("starts company single sign-on with a navigation and reads the new session", async ({
	page,
}) => {
	await platform(page);
	await page.goto("/agents");
	await expect(page.locator('input[type="password"]')).toHaveCount(0);
	await expect(companyLogin(page)).toHaveAttribute("href", "/auth/oidc/login");
	await companyLogin(page).focus();
	await page.keyboard.press("Enter");
	await expect(
		page.getByRole("heading", { level: 1, name: "选择要使用的 Agent。" }),
	).toBeVisible();
});

test("renders the standalone login page with the designed frame (L-01, L-03, NI-44)", async ({
	page,
}, info) => {
	await platform(page);
	await page.goto("/agents");
	await expect(page.getByRole("heading", { name: "登录工作区" })).toBeVisible();
	await expect(page).toHaveTitle("登录 · Agora Agent");
	await expect(page.locator('nav[aria-label="主导航"]')).toHaveCount(0);
	await expect(
		page.getByRole("navigation", { name: "breadcrumb" }),
	).toHaveCount(0);
	for (const text of ["尚未登录", "登录后进入工作空间"])
		await expect(page.getByText(text)).toHaveCount(0);
	await expect(page.getByText("访", { exact: true })).toHaveCount(0);
	await expect(page.locator(".login-brand-mark")).toHaveAttribute(
		"aria-hidden",
		"true",
	);
	await expect(page.locator(".login-brand")).toHaveText("AAgora Agent");
	await expect(page.getByText("企业内部工作区", { exact: true })).toBeVisible();
	await expect(
		page.getByText("账号由公司管理。无法登录时联系 IT 支持。"),
	).toBeVisible();
	await expect(page.getByText("仅限公司授权账号访问。")).toBeVisible();
	await expect(page.getByText(/界面示例|查看登录示例/)).toHaveCount(0);
	await expect(page.getByText("AGORA AGENT PLATFORM")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "重新检查" })).toHaveCount(0);
	await expect(page.locator(".login-brand-mark")).toHaveCount(1);
	expect(new URL(page.url()).pathname).toBe("/agents");

	const desktop = !info.project.name.endsWith("mobile");
	const panel = await box(page, ".login-panel");
	const panelStyle = await style(page, ".login-panel", [
		"padding",
		"border-radius",
		"box-shadow",
		"min-height",
	]);
	expect(panelStyle["border-radius"]).toBe("14px");
	expect(panelStyle["min-height"]).toBe("auto");
	expect(panelStyle["box-shadow"]).toBe(
		`${await resolvedColor(page, "color-mix(in oklch, var(--foreground) 4%, transparent)")} 0px 12px 35px 0px`,
	);
	const h1 = await style(page, ".login-intro h1", [
		"font-family",
		"font-size",
		"font-weight",
		"line-height",
	]);
	expect(h1["font-family"]).toMatch(/^"Iowan Old Style"/);
	expect(h1["font-weight"]).toBe("600");
	const kicker = await style(page, ".login-kicker", [
		"font-size",
		"color",
		"font-family",
	]);
	expect(kicker["font-size"]).toBe("12px");
	expect(kicker.color).toBe(
		await resolvedColor(page, "var(--muted-foreground)"),
	);
	expect(kicker["font-family"]).not.toMatch(/mono|Menlo|Courier/i);
	await expect(page.locator(".login-kicker")).toHaveText("公司账号");
	await expect(page.locator(".login-lead")).toHaveText("使用公司账号登录。");
	expect((await style(page, ".login-lead", ["font-size"]))["font-size"]).toBe(
		"14px",
	);
	// NI-44：登录页不使用等宽字体，也就不会在 Chromium 回退到 Courier。
	const monospace = await page.evaluate(
		() =>
			[...document.querySelectorAll("body *")].filter((element) =>
				/mono|menlo|consolas|courier/i.test(
					getComputedStyle(element).fontFamily,
				),
			).length,
	);
	expect(monospace).toBe(0);

	if (desktop) {
		expect(panel.width).toBe(440);
		expect(Math.abs(panel.x - 500)).toBeLessThanOrEqual(1);
		expect(panelStyle.padding).toBe("32px");
		expect(h1["font-size"]).toBe("30px");
		expect(h1["line-height"]).toBe("40.5px");
	} else {
		const header = await box(page, ".login-header");
		expect(panelStyle.padding).toBe("26px 22px");
		expect(h1["font-size"]).toBe("26px");
		expect(
			Math.abs(panel.y - (header.y + header.height + 12)),
		).toBeLessThanOrEqual(1);
		await page.setViewportSize({ width: 320, height: 568 });
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true);
	}
	await test.info().attach("login-initial", {
		body: await page.screenshot({ fullPage: true }),
		contentType: "image/png",
	});
});

test("shows the expiry notice only after a ready session expires and clears reason after login (L-06, NI-109)", async ({
	page,
}) => {
	let detailStatus = 200;
	const api = await platform(page, { agentDetailStatus: () => detailStatus });
	api.authenticated = true;
	await page.goto(`/agents/${agent.agentId}`);
	await expect(
		page.getByRole("heading", { level: 1, name: agent.name }),
	).toBeVisible();

	// 会话中途失效：详情读取得到 401 → login 卡；重新登录读会话得到 401 → 登录页带过期提示。
	api.authenticated = false;
	detailStatus = 401;
	await page.reload();
	await expect(page.getByRole("heading", { name: "登录工作区" })).toBeVisible();
	// 整页刷新后从未就绪，不是「过期」。
	await expect(page.getByText("登录已过期，请重新登录")).toHaveCount(0);

	api.authenticated = true;
	await page.reload();
	const card = page.locator('#main-content [data-slot="state-card"]');
	await expect(card).toHaveAttribute("data-kind", "login");
	await expect(card).toContainText(
		"当前会话已过期，需要重新登录后再进入工作区。",
	);
	api.authenticated = false;
	await card.getByRole("button", { name: "重新登录" }).click();
	const notice = page.locator(".login-expired");
	await expect(notice).toHaveAttribute("role", "status");
	await expect(notice.locator("strong")).toHaveText("登录已过期，请重新登录");
	await expect(notice.locator("p")).toHaveText("已提交的任务会继续处理。");
	await expect(page.locator(".login-lead")).toHaveText("使用公司账号登录。");
	expect(
		await notice.evaluate((element) => {
			const value = getComputedStyle(element);
			const icon = element.querySelector("svg")?.getBoundingClientRect();
			return [
				value.padding,
				value.borderRadius,
				value.marginBottom,
				icon?.width,
				icon?.height,
				element.querySelector("svg")?.getAttribute("aria-hidden"),
			];
		}),
	).toEqual(["12px", "10px", "24px", 17, 17, "true"]);
	expect(
		await notice.evaluate(
			(element) => getComputedStyle(element).backgroundColor,
		),
	).toBe(await resolvedColor(page, "var(--surface-raised)"));
	expect(
		await page.evaluate(
			() => performance.getEntriesByType("navigation").length,
		),
	).toBe(1);

	// 直接打开 ?reason=expired 也显示，OIDC 回跳后读取新会话。
	await page.goto("/agents?reason=expired&mode=conversation");
	await expect(page.locator(".login-expired")).toBeVisible();
	detailStatus = 200;
	await companyLogin(page).click();
	await expect(
		page.getByRole("heading", { level: 1, name: "选择要使用的 Agent。" }),
	).toBeVisible();
	await expect(page.locator(".login-expired")).toHaveCount(0);
});

async function acceptanceViewport(page: Page, info: TestInfo) {
	await page.setViewportSize(
		info.project.name.endsWith("mobile")
			? { width: 390, height: 844 }
			: { width: 1440, height: 900 },
	);
}

test("signing out keeps focus on the pending button (K7-02)", async ({
	page,
}, info) => {
	await acceptanceViewport(page, info);
	const errors = trackPageErrors(page);
	const api = await platform(page);
	api.authenticated = true;
	await page.goto("/agents");
	await expect(
		page.getByRole("heading", { level: 1, name: "选择要使用的 Agent。" }),
	).toBeVisible();
	if (info.project.name.endsWith("mobile"))
		await page.getByRole("button", { name: "打开导航", exact: true }).click();
	const logout = await pinElement(
		page.getByRole("button", { name: "退出登录", exact: true }),
		"logout",
	);
	await page.route("**/auth/logout", (route) => {
		api.authenticated = false;
		return route.fulfill({ status: 204 });
	});
	const leaving = await holdRequests(page, "POST", "/auth/logout");
	await logout.focus();
	await page.keyboard.press("Enter");
	await expect(logout).toHaveText("正在退出…");
	await expectFocusableBusy(logout, "退出登录");
	leaving.release();
	// 退出后整页换成登录页，焦点在公司登录入口（L-01），不落到 body。
	await expect(
		page.getByRole("heading", { name: "登录工作区", exact: true }),
	).toBeVisible();
	await expectFocusSettled(companyLogin(page), "退出登录后");
	await expectCleanPage(page, errors);
});

// #3327 N10-1-01：「重新登录」确认会话已失效、整页换成登录页后，焦点同主动退出到「公司账号」（K7-02）；
// 确认中留在可聚焦的「重新登录」上。覆盖 useSessionRecheck（Agent 目录）与状态卡默认操作（Agent 详情）
// 两条路径，都在配置了登录入口的生产构建中运行。
for (const target of [
	{
		name: "Agent directory",
		path: "/agents",
		busyText: "重新登录",
	},
	{
		name: "Agent detail",
		path: `/agents/${agent.agentId}`,
		busyText: "正在检查…",
	},
] as const)
	test(`a re-login on the ${target.name} that finds the session expired focuses 公司账号, not body (#3327 N10-1-01)`, async ({
		page,
	}, info) => {
		await acceptanceViewport(page, info);
		const errors = trackPageErrors(page);
		const api = await platform(page, {
			agentsStatus: () => 401,
			agentDetailStatus: () => 401,
		});
		api.authenticated = true;
		await page.goto(target.path);
		const card = page.locator('#main-content [data-slot="state-card"]');
		await expect(card).toHaveAttribute("data-kind", "login");
		const relogin = await pinElement(
			card.getByRole("button", { name: "重新登录", exact: true }),
			"relogin",
		);
		await expect(relogin.locator(":scope > svg")).toHaveClass(/lucide-log-in/);
		api.authenticated = false;
		const hold = await holdRequests(page, "GET", "/api/v1/session");
		await relogin.focus();
		await page.keyboard.press("Enter");
		await expect.poll(() => hold.held()).toBeGreaterThanOrEqual(1);
		await expect(relogin).toHaveText(target.busyText);
		await expectFocusableBusy(relogin, `${target.name} 确认会话中`, [30, 150]);
		hold.release();
		await expect(
			page.getByRole("heading", { level: 1, name: "登录工作区" }),
		).toBeVisible();
		await expect(page.locator(".login-expired")).toHaveAttribute(
			"role",
			"status",
		);
		await expectFocusSettled(
			companyLogin(page),
			`${target.name} 确认会话已失效后`,
			[30, 150, 400, 1200],
		);
		expect(
			await page.evaluate(
				() => performance.getEntriesByType("navigation").length,
			),
		).toBe(1);
		await expectCleanPage(page, errors);
	});

// #3267 N8-1-01：导出稿侧栏没有「退出登录」。入口与相邻导航项同为 13px / 400 / muted、44px、8px 11px；
// 失败提示为 12px --danger-ink 的 role="alert"，左缘与入口文字对齐，焦点留在入口上。
test("signing out matches the sidebar navigation items and reports a failure as an alert (#3267 N8-1-01)", async ({
	page,
}, info) => {
	await acceptanceViewport(page, info);
	const errors = trackPageErrors(page);
	const api = await platform(page);
	api.authenticated = true;
	await page.goto("/agents");
	await expect(
		page.getByRole("heading", { level: 1, name: "选择要使用的 Agent。" }),
	).toBeVisible();
	if (info.project.name.endsWith("mobile"))
		await page.getByRole("button", { name: "打开导航", exact: true }).click();
	const logout = page.getByRole("button", { name: "退出登录", exact: true });
	await expect(logout).toBeVisible();
	const navItem = page
		.locator("a.platform-nav-item:not(.selected)")
		.filter({ visible: true })
		.first();
	const typography = (target: typeof logout) =>
		target.evaluate((node) => {
			const style = getComputedStyle(node);
			return {
				fontSize: style.fontSize,
				fontWeight: style.fontWeight,
				color: style.color,
				letterSpacing: style.letterSpacing,
				lineHeight: style.lineHeight,
				padding: style.padding,
				height: node.getBoundingClientRect().height,
				width: node.getBoundingClientRect().width,
			};
		});
	const expected = await typography(navItem);
	expect(expected).toMatchObject({
		fontSize: "13px",
		fontWeight: "400",
		padding: "8px 11px",
		height: 44,
	});
	expect(await typography(logout)).toEqual(expected);
	await page.route("**/auth/logout", (route) =>
		route.fulfill({ status: 500, body: "" }),
	);
	await logout.focus();
	await page.keyboard.press("Enter");
	const failure = page.getByRole("alert").filter({
		hasText: "退出登录失败，请重试。",
	});
	await expect(failure).toBeVisible();
	await expect(
		page.getByRole("status").filter({ hasText: "退出登录失败" }),
	).toHaveCount(0);
	const failureStyle = await failure.evaluate((node) => {
		const probe = document.createElement("span");
		probe.style.color = "var(--danger-ink)";
		document.body.append(probe);
		const dangerInk = getComputedStyle(probe).color;
		probe.remove();
		const style = getComputedStyle(node);
		return {
			fontSize: style.fontSize,
			dangerInk: style.color === dangerInk,
		};
	});
	expect(failureStyle).toEqual({ fontSize: "12px", dangerInk: true });
	// 两段文字在同一次求值里测量，窄屏导航 Sheet 的滑入动画不影响比较。
	const [failureLeft, logoutLeft] = await page.evaluate(
		(texts) =>
			texts.map((text) => {
				const node = [
					...document.querySelectorAll<HTMLElement>(
						'[role="alert"], button[data-slot="button"]',
					),
				].find(
					(element) =>
						element.checkVisibility() && element.textContent?.trim() === text,
				);
				if (!node) throw new Error(`Missing ${text}`);
				const range = document.createRange();
				range.selectNodeContents(node);
				return range.getBoundingClientRect().left;
			}),
		["退出登录失败，请重试。", "退出登录"],
	);
	expect(Math.abs(failureLeft - logoutLeft)).toBeLessThanOrEqual(0.5);
	await expectFocusSettled(logout, "退出登录失败");
	await expectNoDuplicateControls(page, "退出登录失败");
	await expectCleanPage(page, errors);
});
