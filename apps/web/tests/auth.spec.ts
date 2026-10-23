import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import {
	pilotAgentDetailFromV2,
	pilotFakeScenariosV2,
} from "@agent-infra/test-support/pilot";
import {
	expect,
	type Page,
	type Route,
	type TestInfo,
	test,
} from "@playwright/test";
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
const credentialsMessage = "账号或密码不正确，请检查后重试。";
const unavailableMessage = "登录服务暂时不可用，请稍后重试。";
const genericMessage = "登录失败，请稍后重试。";
const agent = AgentProjectionV2Schema.parse(
	pilotFakeScenariosV2.starting.response.body,
);

type LoginReply = (route: Route) => Promise<void>;

/**
 * 受控 API：会话由 authenticated 决定；登录请求按 reply 返回。
 * Agent 目录与详情只返回合成数据，其余 API 一律中止，避免依赖真实后端。
 */
async function platform(
	page: Page,
	{
		reply,
		agentDetailStatus,
	}: { reply?: LoginReply; agentDetailStatus?: () => number } = {},
) {
	const state = { authenticated: false, loginBodies: [] as unknown[] };
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
		if (url.pathname === "/api/v2/agents")
			return route.fulfill({ json: { items: [agent], nextCursor: null } });
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
	await page.route("**/auth/login", async (route) => {
		const request = route.request();
		state.loginBodies.push({
			method: request.method(),
			body: request.postDataJSON(),
			origin: request.headers().origin,
		});
		if (reply) return reply(route);
		const body = request.postDataJSON();
		if (
			body?.login !== "alice" ||
			body?.password !== "correct horse battery staple"
		)
			return route.fulfill({ status: 401 });
		state.authenticated = true;
		return route.fulfill({ status: 204 });
	});
	return state;
}

const account = (page: Page) =>
	page.getByRole("textbox", { name: "公司账号", exact: true });
const password = (page: Page) => page.getByLabel("密码", { exact: true });
const submit = (page: Page) =>
	page.getByRole("button", { name: "登录", exact: true });

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

test("consumes the Platform login contract and keeps the form retryable", async ({
	page,
}) => {
	const errors = trackPageErrors(page);
	const api = await platform(page);
	await page.goto("/agents");
	const expectedOrigin = new URL(page.url()).origin;
	await expect(page.getByRole("heading", { name: "登录工作区" })).toBeVisible();

	// L-04：空提交不发请求、不出现原生气泡，改为内联字段错误。
	await submit(page).click();
	await expect(
		page.getByText("请输入公司账号。", { exact: true }),
	).toBeVisible();
	await expect(page.getByText("请输入密码。", { exact: true })).toBeVisible();
	// V-24：login.html 的字段错误色为 --danger 78% 混入 --fg。
	const loginErrorColor = await resolvedColor(
		page,
		"color-mix(in oklch, var(--danger) 78%, var(--foreground))",
	);
	await expect(page.getByText("请输入公司账号。", { exact: true })).toHaveCSS(
		"color",
		loginErrorColor,
	);
	await expect(account(page)).toHaveAttribute("aria-invalid", "true");
	await expect(password(page)).toHaveAttribute("aria-invalid", "true");
	await expect(account(page)).toBeFocused();
	expect(api.loginBodies).toHaveLength(0);
	// AC-2：登录页没有同名控件（密码显隐钮与「登录」不同名），没有控制台错误与横向溢出。
	await expectNoDuplicateControls(page, "登录");
	await expectCleanPage(page, errors);

	await account(page).fill("alice");
	await password(page).fill("wrong");
	await submit(page).click();
	await expect(page.getByRole("alert")).toHaveText(credentialsMessage);
	await expect(account(page)).toHaveAttribute("aria-invalid", "true");
	await expect(password(page)).toHaveValue("");
	await expect(password(page)).toBeFocused();
	await expect(submit(page)).toBeEnabled();
	await test.info().attach("login-retryable-error", {
		body: await page.screenshot({ fullPage: true }),
		contentType: "image/png",
	});

	await password(page).fill("correct horse battery staple");
	await submit(page).click();
	// 保持原 URL，登录成功后直接显示原目标页（AC-1）。
	await expect(
		page.getByRole("heading", { level: 1, name: "选择要使用的 Agent。" }),
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "登录工作区" })).toHaveCount(
		0,
	);
	expect(new URL(page.url()).pathname).toBe("/agents");
	expect(api.loginBodies).toEqual([
		{
			method: "POST",
			body: { login: "alice", password: "wrong" },
			origin: expectedOrigin,
		},
		{
			method: "POST",
			body: { login: "alice", password: "correct horse battery staple" },
			origin: expectedOrigin,
		},
	]);
	const horizontalOverflow = await page.evaluate(
		() =>
			document.documentElement.scrollWidth >
			document.documentElement.clientWidth,
	);
	expect(horizontalOverflow).toBe(false);
	await test.info().attach("login-session-recovered", {
		body: await page.screenshot({ fullPage: true }),
		contentType: "image/png",
	});
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

test("uses the designed fields, password toggle and submit button (L-02, NI-54)", async ({
	page,
}, info) => {
	await platform(page);
	await page.goto("/agents");
	for (const name of ["公司账号", "密码"]) {
		const label = page.locator("label", { hasText: new RegExp(`^${name}$`) });
		const labelStyle = await label.evaluate((element) => {
			const computed = getComputedStyle(element);
			return [computed.fontSize, computed.fontWeight];
		});
		expect(labelStyle).toEqual(["13px", "550"]);
	}
	for (const input of [account(page), password(page)]) {
		const computed = await input.evaluate((element) => {
			const value = getComputedStyle(element);
			return {
				height: element.getBoundingClientRect().height,
				paddingTop: value.paddingTop,
				paddingLeft: value.paddingLeft,
				radius: value.borderRadius,
				fontSize: value.fontSize,
			};
		});
		expect(computed).toMatchObject({
			height: 48,
			paddingTop: "10px",
			paddingLeft: "12px",
			radius: "10px",
			fontSize: "15px",
		});
	}
	await expect(account(page)).toHaveAttribute("placeholder", "输入公司账号");
	await expect(account(page)).toHaveAttribute("autocapitalize", "none");
	await expect(account(page)).toHaveAttribute("spellcheck", "false");
	await expect(account(page)).toHaveAttribute("autocomplete", "username");
	await expect(account(page)).toHaveAttribute("maxlength", "256");
	await expect(password(page)).toHaveAttribute("placeholder", "输入密码");
	await expect(password(page)).toHaveAttribute(
		"autocomplete",
		"current-password",
	);
	await expect(password(page)).toHaveAttribute("maxlength", "4096");
	expect(
		await password(page).evaluate(
			(element) => getComputedStyle(element).paddingRight,
		),
	).toBe("54px");

	// 显隐按钮只以密码框为定位参照：top/right 各 2px，44×44、圆角 8px、19px 图标。
	const toggle = page.getByRole("button", { name: "显示密码" });
	const expectToggleInside = async () => {
		const field = await password(page).boundingBox();
		const button = await toggle.boundingBox();
		if (!field || !button) throw new Error("password control missing");
		expect(Math.abs(button.y - (field.y + 2))).toBeLessThanOrEqual(1);
		expect(
			Math.abs(button.x + button.width - (field.x + field.width - 2)),
		).toBeLessThanOrEqual(1);
		expect([button.width, button.height]).toEqual([44, 44]);
	};
	await expectToggleInside();
	expect(
		await toggle.evaluate((element) => getComputedStyle(element).borderRadius),
	).toBe("8px");
	expect(
		await toggle
			.locator("svg")
			.evaluate((element) => element.getBoundingClientRect().width),
	).toBe(19);
	await expect(toggle).toHaveAttribute(
		"aria-controls",
		(await password(page).getAttribute("id")) ?? "",
	);
	await account(page).fill("alice");
	await submit(page).click();
	await expect(page.getByText("请输入密码。", { exact: true })).toBeVisible();
	await expectToggleInside();
	await password(page).fill("secret");
	await toggle.click();
	const hide = page.getByRole("button", { name: "隐藏密码" });
	await expect(hide).toHaveAttribute("aria-pressed", "true");
	await expect(password(page)).toHaveAttribute("type", "text");
	await hide.click();
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await expect(password(page)).toHaveAttribute("type", "password");

	const button = submit(page);
	const form = await box(page, ".login-form");
	const submitBox = await button.boundingBox();
	expect(submitBox?.width).toBe(form.width);
	expect(submitBox?.height).toBeGreaterThanOrEqual(44);
	if (!info.project.name.endsWith("mobile")) expect(submitBox?.width).toBe(374);
	const submitStyle = await button.evaluate((element) => {
		const value = getComputedStyle(element);
		return [value.fontSize, value.fontWeight];
	});
	expect(submitStyle).toEqual(["14px", "600"]);
	// 前面点过提交按钮：移开指针并等待背景过渡结束后再比对底色。
	await page.mouse.move(0, 0);
	await expect
		.poll(() =>
			button.evaluate((element) => getComputedStyle(element).backgroundColor),
		)
		.toBe(
			await resolvedColor(
				page,
				"color-mix(in oklch, var(--accent) 88%, var(--foreground))",
			),
		);
	await button.hover();
	await expect
		.poll(() =>
			button.evaluate((element) => getComputedStyle(element).backgroundColor),
		)
		.toBe(
			await resolvedColor(
				page,
				"color-mix(in oklch, var(--accent) 76%, var(--foreground))",
			),
		);
});

for (const scenario of [
	{ name: "401", status: 401, message: credentialsMessage },
	{ name: "403", status: 403, message: "请从平台入口地址访问后重试。" },
	{ name: "500", status: 500, message: unavailableMessage },
	{ name: "503", status: 503, message: unavailableMessage },
	{ name: "429", status: 429, message: unavailableMessage },
	{ name: "400", status: 400, message: genericMessage },
	{ name: "405", status: 405, message: genericMessage },
	{ name: "network", status: 0, message: unavailableMessage },
	{ name: "session-missing", status: 204, message: unavailableMessage },
])
	test(`classifies the ${scenario.name} login failure (L-05, R4-12, NI-16, NI-30)`, async ({
		page,
	}) => {
		await platform(page, {
			reply: (route) =>
				scenario.status === 0
					? route.abort("internetdisconnected")
					: route.fulfill({ status: scenario.status }),
		});
		await page.goto("/agents");
		await account(page).fill("alice");
		await password(page).fill("secret");
		await submit(page).click();

		const alert = page.getByRole("alert");
		await expect(alert).toHaveCount(1);
		await expect(alert).toHaveText(scenario.message);
		const credentials = scenario.status === 401;
		for (const input of [account(page), password(page)]) {
			if (credentials) {
				await expect(input).toHaveAttribute("aria-invalid", "true");
				await expect(input).toHaveAttribute(
					"aria-describedby",
					(await alert.getAttribute("id")) ?? "",
				);
			} else {
				await expect(input).not.toHaveAttribute("aria-invalid", /.*/);
			}
			// 每个 aria-describedby 引用都存在（NI-16）。
			const ids = ((await input.getAttribute("aria-describedby")) ?? "")
				.split(/\s+/)
				.filter(Boolean);
			for (const id of ids)
				await expect(page.locator(`[id="${id}"]`)).toHaveCount(1);
		}
		if (!credentials)
			await expect(page.getByText(credentialsMessage)).toHaveCount(0);
		await expect(password(page)).toHaveValue("");
		await expect(password(page)).toBeFocused();

		// 错误框位于提交按钮之上 18px，padding 12、圆角 10、13px / 1.7。
		const errorBox = await alert.boundingBox();
		const submitBox = await submit(page).boundingBox();
		if (!errorBox || !submitBox) throw new Error("login feedback missing");
		expect(
			Math.abs(errorBox.y + errorBox.height + 18 - submitBox.y),
		).toBeLessThanOrEqual(1);
		expect(
			await alert.evaluate((element) => {
				const value = getComputedStyle(element);
				return [
					value.padding,
					value.borderRadius,
					value.fontSize,
					value.lineHeight,
				];
			}),
		).toEqual(["12px", "10px", "13px", "22.1px"]);
		// V-24：表单错误色与字段错误相同，为 --danger 78% 混入 --fg（login.html .form-error）。
		await expect(alert).toHaveCSS(
			"color",
			await resolvedColor(
				page,
				"color-mix(in oklch, var(--danger) 78%, var(--foreground))",
			),
		);

		await account(page).press("End");
		await account(page).pressSequentially("x");
		await expect(page.getByRole("alert")).toHaveCount(0);
		await expect(account(page)).not.toHaveAttribute("aria-invalid", /.*/);
		await expect(password(page)).not.toHaveAttribute("aria-invalid", /.*/);
	});

test("shows progress while signing in and keeps the spinner still under reduced motion (L-06)", async ({
	page,
}) => {
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await platform(page, {
		reply: async (route) => {
			await held;
			await route.fulfill({ status: 503 });
		},
	});
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto("/agents");
	await account(page).fill("alice");
	await password(page).fill("secret");
	await submit(page).click();

	const busy = page.getByRole("button", { name: "正在登录…" });
	await expect(busy).toBeDisabled();
	const spinner = busy.locator('[data-slot="spinner"]');
	await expect(spinner).toBeVisible();
	expect(
		await spinner.evaluate((element) => {
			const value = getComputedStyle(element);
			return [
				element.getBoundingClientRect().width,
				value.animationName,
				value.borderTopColor === value.borderRightColor,
			];
		}),
	).toEqual([16, "none", false]);
	await expect(page.locator(".login-form")).toHaveAttribute(
		"aria-busy",
		"true",
	);
	await expect(account(page)).toBeDisabled();
	await expect(password(page)).toBeDisabled();
	await expect(page.getByRole("button", { name: "显示密码" })).toBeDisabled();
	release();
	await expect(page.getByRole("alert")).toHaveText(unavailableMessage);
	await expect(page.locator(".login-form")).not.toHaveAttribute(
		"aria-busy",
		/.*/,
	);
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
	await account(page).fill("alice");
	await password(page).fill("correct horse battery staple");
	await submit(page).click();
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

	// 直接打开 ?reason=expired 也显示；登录成功后只去掉 reason，保留其他参数。
	await page.goto("/agents?reason=expired&mode=conversation");
	await expect(page.locator(".login-expired")).toBeVisible();
	detailStatus = 200;
	await account(page).fill("alice");
	await password(page).fill("correct horse battery staple");
	await submit(page).click();
	await expect(page.locator(".login-expired")).toHaveCount(0);
	await expect
		.poll(() => new URL(page.url()).search)
		.toBe("?mode=conversation");
});

// #3242 K7-02：登录与退出进行中按钮是可聚焦的禁用（aria-disabled）；在账号或密码框里按 Enter
// 提交时焦点先交给「正在登录…」（输入框随提交禁用），挂起期间多次采样都在按钮上；失败后回到密码框。
async function acceptanceViewport(page: Page, info: TestInfo) {
	await page.setViewportSize(
		info.project.name.endsWith("mobile")
			? { width: 390, height: 844 }
			: { width: 1440, height: 900 },
	);
}

for (const via of ["button", "field"] as const)
	test(`signing in keeps focus on the pending submit button and returns to the password on failure (${via}, K7-02)`, async ({
		page,
	}, info) => {
		await acceptanceViewport(page, info);
		const errors = trackPageErrors(page);
		await platform(page);
		await page.goto("/agents");
		await account(page).fill("alice");
		await password(page).fill("wrong-fixture-password");
		const button = await pinElement(submit(page), "login-submit");
		const login = await holdRequests(page, "POST", "/auth/login");
		await (via === "button" ? button : password(page)).focus();
		await page.keyboard.press("Enter");
		await expect(button).toHaveText("正在登录…");
		await expectFocusableBusy(button, `${via} 登录`);
		// login.html `.submit:disabled`：提交中不透明度 .65、光标 wait，不落到 Button 通用的
		// aria-disabled .48 / not-allowed（#3269 N8-3-11）。
		expect(
			await button.evaluate((element) => {
				const style = getComputedStyle(element);
				return [style.opacity, style.cursor];
			}),
			`${via} 登录提交中的计算样式`,
		).toEqual(["0.65", "wait"]);
		await expect(password(page)).toBeDisabled();
		login.release();
		await expect(page.getByRole("alert")).toHaveText(credentialsMessage);
		await expectFocusSettled(password(page), `${via} 登录失败`);
		await expectCleanPage(page, errors);
	});

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
	// 退出后整页换成登录页，焦点在账号框（L-01），不落到 body。
	await expect(
		page.getByRole("heading", { name: "登录工作区", exact: true }),
	).toBeVisible();
	await expectFocusSettled(account(page), "退出登录后");
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
	const textLeft = (target: typeof logout) =>
		target.evaluate((node) => {
			const range = document.createRange();
			range.selectNodeContents(node);
			return range.getBoundingClientRect().left;
		});
	expect(
		Math.abs((await textLeft(failure)) - (await textLeft(logout))),
	).toBeLessThanOrEqual(0.5);
	await expectFocusSettled(logout, "退出登录失败");
	await expectNoDuplicateControls(page, "退出登录失败");
	await expectCleanPage(page, errors);
});
