import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { expect, type Page, test } from "@playwright/test";
import { pendingApplication } from "../src/features/my-agents/test-fixtures";

// R4-02 会话确认期壳层骨架与 P-01 公共状态卡（加载、无权限、不可用、404）。
const agent = AgentProjectionV2Schema.parse({
	...pilotFakeScenariosV2.starting.response.body,
	agentId: "agent-states-1",
});
const application = {
	...pendingApplication,
	applicationId: "application-states-1",
};
const session = {
	schemaVersion: 1,
	user: {
		userId: "employee-session-states",
		displayName: "状态员工",
		roles: ["employee"],
	},
};
const failureBody = (status: number) => ({
	schemaVersion: 1,
	code:
		status === 401
			? "AUTHENTICATION_REQUIRED"
			: status === 403
				? "FORBIDDEN"
				: status === 404
					? "RESOURCE_UNAVAILABLE"
					: "DEPENDENCY_UNAVAILABLE",
	message: "Controlled session state failure",
	retryable: status >= 500,
	traceId: "trace-session-states",
});

type Reply = { status: number; body?: unknown; hold?: Promise<void> };

/** 受控 API：每个读取按当前 reply 返回，记录请求次数；其余 API 返回 503。 */
async function platform(
	page: Page,
	replies: {
		session?: () => Reply;
		agent?: () => Reply;
		application?: () => Reply;
	} = {},
) {
	const counts = { session: 0, agent: 0, application: 0 };
	const fulfill = async (
		route: Parameters<Parameters<Page["route"]>[1]>[0],
		reply: Reply,
		ok: unknown,
	) => {
		await reply.hold;
		await route.fulfill({
			status: reply.status,
			json:
				reply.status === 200
					? (reply.body ?? ok)
					: (reply.body ?? failureBody(reply.status)),
		});
	};
	await page.route("**/api/**", async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname === "/api/v1/session") {
			counts.session += 1;
			return fulfill(route, replies.session?.() ?? { status: 200 }, session);
		}
		if (url.pathname === "/api/v1/connection/capability")
			return route.fulfill({
				json: { schemaVersion: 1, status: "unavailable", reason: "missing" },
			});
		if (url.pathname === "/api/v2/agents")
			return route.fulfill({ json: { items: [agent], nextCursor: null } });
		if (url.pathname === `/api/v2/agents/${agent.agentId}`) {
			counts.agent += 1;
			return fulfill(route, replies.agent?.() ?? { status: 200 }, agent);
		}
		if (
			url.pathname === `/api/v2/agent-applications/${application.applicationId}`
		) {
			counts.application += 1;
			return fulfill(
				route,
				replies.application?.() ?? { status: 200 },
				application,
			);
		}
		return route.fulfill({ status: 503, json: failureBody(503) });
	});
	return counts;
}

function held() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function shellGeometry(page: Page, mobile: boolean) {
	return page.evaluate((narrow) => {
		const rect = (selector: string) => {
			const element = document.querySelector(selector);
			if (!element) return null;
			const value = element.getBoundingClientRect();
			return {
				x: Math.round(value.x),
				y: Math.round(value.y),
				width: Math.round(value.width),
				height: Math.round(value.height),
			};
		};
		return {
			topbar: rect(".platform-topbar")?.height,
			main: rect("#main-content"),
			menu: narrow ? rect(".platform-topbar .mobile-menu") : null,
			sidebar: narrow ? null : rect(".platform-sidebar")?.width,
			brand: narrow ? null : rect(".platform-sidebar .platform-brand"),
			firstGroup: narrow
				? null
				: rect(".platform-sidebar .platform-nav-group")?.y,
			firstItem: narrow
				? null
				: rect(".platform-sidebar .platform-nav-item")?.y,
		};
	}, mobile);
}

async function expectNoLoginPage(page: Page) {
	await expect(page.getByRole("heading", { name: /登录工作/ })).toHaveCount(0);
	await expect(page.getByRole("textbox")).toHaveCount(0);
	for (const text of ["尚未登录", "登录后进入工作空间"])
		await expect(page.getByText(text)).toHaveCount(0);
	await expect(page.getByText("访", { exact: true })).toHaveCount(0);
	expect(await page.title()).not.toBe("登录 · Agora Agent");
}

test("keeps a stable shell skeleton while the session is being confirmed (R4-02)", async ({
	page,
}, info) => {
	const mobile = info.project.name === "mobile";
	const gate = held();
	await platform(page, {
		session: () => ({ status: 200, hold: gate.promise }),
	});
	await page.goto("/agents", { waitUntil: "commit" });
	await expect(page.locator(".platform-topbar")).toBeVisible();
	for (const wait of [300, 400, 500]) {
		await page.waitForTimeout(wait);
		await expectNoLoginPage(page);
		const statuses = page.locator("#main-content").getByRole("status");
		await expect(statuses).toHaveCount(1);
		await expect(statuses).toHaveText("正在确认登录状态…");
		await expect(statuses.locator('[data-slot="spinner"]')).toBeVisible();
		await expect(page).toHaveTitle("Agent 目录 · Agora Agent");
	}
	await expect(page.getByRole("navigation", { name: "主导航" })).toHaveCount(0);
	const skeleton = await shellGeometry(page, mobile);
	await test.info().attach("session-confirming", {
		body: await page.screenshot(),
		contentType: "image/png",
	});
	gate.release();
	await expect(
		page.getByRole("heading", { level: 1, name: "选择要使用的 Agent。" }),
	).toBeVisible();
	const ready = await shellGeometry(page, mobile);
	// 骨架与就绪态的品牌块、侧栏宽度、顶栏高度、内容区起点与首组导航位置一致（±1px）。
	expect(ready.topbar).toBe(skeleton.topbar);
	expect(
		Math.abs((ready.main?.x ?? 0) - (skeleton.main?.x ?? -9)),
	).toBeLessThanOrEqual(1);
	expect(
		Math.abs((ready.main?.y ?? 0) - (skeleton.main?.y ?? -9)),
	).toBeLessThanOrEqual(1);
	if (mobile) {
		expect(ready.menu).toEqual(skeleton.menu);
	} else {
		expect(ready.sidebar).toBe(skeleton.sidebar);
		expect(ready.brand).toEqual(skeleton.brand);
		expect(ready.firstGroup).toBe(skeleton.firstGroup);
		expect(ready.firstItem).toBe(skeleton.firstItem);
	}
});

test("shows the login page only after the session is confirmed anonymous (R4-02)", async ({
	page,
}) => {
	const gate = held();
	await platform(page, {
		session: () => ({ status: 401, hold: gate.promise }),
	});
	await page.goto("/agents", { waitUntil: "commit" });
	await expect(page.locator(".platform-topbar")).toBeVisible();
	await page.waitForTimeout(700);
	await expectNoLoginPage(page);
	gate.release();
	await expect(page.getByRole("heading", { name: "登录工作区" })).toBeVisible();
	await expect(page.locator(".platform-topbar")).toHaveCount(0);
	await expect(page).toHaveTitle("登录 · Agora Agent");
});

test("keeps confirmation and unavailable copy when reason=expired is present (NI-109, R4-02)", async ({
	page,
}) => {
	test.setTimeout(60_000);
	let available = false;
	const gate = held();
	const counts = await platform(page, {
		session: () =>
			available
				? { status: 200 }
				: {
						status: 503,
						hold: counts.session === 1 ? gate.promise : undefined,
					},
	});
	await page.goto("/agents?reason=expired", { waitUntil: "commit" });
	await expect(page.locator(".platform-topbar")).toBeVisible();
	await page.waitForTimeout(700);
	await expect(page.locator("#main-content").getByRole("status")).toHaveText(
		"正在确认登录状态…",
	);
	await expect(page.getByText(/登录已过期/)).toHaveCount(0);
	gate.release();

	// 重试用尽后：壳层骨架 + 「服务暂不可用」状态卡，没有登录表单。
	const card = page.locator('#main-content [data-slot="state-card"]');
	await expect(card).toBeVisible({ timeout: 30_000 });
	await expect(
		card.getByRole("heading", { name: "服务暂不可用" }),
	).toBeVisible();
	await expect(card).toContainText("暂时无法确认登录状态，请稍后重试。");
	await expect(page.getByText(/登录已过期/)).toHaveCount(0);
	await expectNoLoginPage(page);
	const recheck = card.getByRole("button", { name: "重新检查" });
	await expect(recheck).toHaveClass(/border-border/);

	available = true;
	await recheck.click();
	await expect(
		page.getByRole("heading", { level: 1, name: "选择要使用的 Agent。" }),
	).toBeVisible();
	expect(
		await page.evaluate(
			() => performance.getEntriesByType("navigation").length,
		),
	).toBe(1);
});

const detailPages = [
	{
		name: "Agent detail",
		path: `/agents/${agent.agentId}`,
		heading: "Agent 详情",
		key: "agent",
		denied: "Agent 不存在，或你没有访问权限。",
		unavailable: "暂时无法读取 Agent，请稍后重试。",
		back: { name: "返回 Agent 目录", href: "/agents" },
		retry: "重新加载 Agent",
	},
	{
		name: "application detail",
		path: `/my-agents/${application.applicationId}`,
		heading: "申请详情",
		key: "application",
		denied: "申请不存在，或你没有访问权限。",
		unavailable: "暂时无法读取申请，请稍后重试。",
		back: { name: "返回我的 Agent", href: "/my-agents" },
		retry: "重新加载申请",
	},
	{
		name: "Owner configuration",
		path: `/agents/${agent.agentId}/configuration`,
		heading: "Owner 配置",
		key: "agent",
		denied: "Agent 不存在，或你没有访问权限。",
		unavailable: "暂时无法读取 Owner 配置，请稍后重试。",
		back: { name: "返回 Agent 详情", href: `/agents/${agent.agentId}` },
		retry: "重新加载配置",
	},
	{
		name: "Agent skills",
		path: `/agents/${agent.agentId}/skills`,
		heading: "Agent 的 Skill",
		key: "agent",
		denied: "Agent 不存在，或你没有访问权限。",
		unavailable: "暂时无法读取 Agent，请稍后重试。",
		back: { name: "返回 Agent 目录", href: "/agents" },
		retry: "重新加载 Agent",
	},
] as const;

for (const detail of detailPages) {
	test(`chooses the ${detail.name} state card by read failure (P-01)`, async ({
		page,
	}) => {
		let reply: Reply = { status: 401 };
		const counts = await platform(page, {
			[detail.key]: () => reply,
		});
		const card = page.locator('#main-content [data-slot="state-card"]');
		const actions = card.locator("a, button");

		await page.goto(detail.path);
		await expect(
			page.getByRole("heading", { level: 1, name: detail.heading }),
		).toBeVisible();
		await expect(card).toHaveAttribute("data-kind", "login");
		await expect(actions).toHaveText(["重新登录"]);
		const sessionReads = counts.session;
		await card.getByRole("button", { name: "重新登录" }).click();
		await expect.poll(() => counts.session).toBeGreaterThan(sessionReads);
		expect(
			await page.evaluate(
				() => performance.getEntriesByType("navigation").length,
			),
		).toBe(1);

		const deniedTexts: string[] = [];
		for (const status of [403, 404]) {
			reply = { status };
			await page.goto(detail.path);
			await expect(card).toHaveAttribute("data-kind", "unauthorized");
			await expect(card).toContainText(detail.denied);
			await expect(actions).toHaveText([detail.back.name]);
			await expect(actions.first()).toHaveAttribute("href", detail.back.href);
			await expect(card).not.toHaveAttribute("role", /.*/);
			deniedTexts.push((await card.textContent()) ?? "");
		}
		expect(deniedTexts[0]).toBe(deniedTexts[1]);

		reply = { status: 503 };
		await page.goto(detail.path);
		await expect(card).toHaveAttribute("data-kind", "unavailable");
		await expect(card).toHaveAttribute("role", "alert");
		await expect(card).toContainText(detail.unavailable);
		const reads = counts[detail.key];
		await card.getByRole("button", { name: detail.retry }).click();
		await expect.poll(() => counts[detail.key]).toBeGreaterThan(reads);

		reply = { status: 200, body: { schemaVersion: 1 } };
		await page.goto(detail.path);
		await expect(card).toHaveAttribute("data-kind", "invalid");
		await expect(card).toContainText("服务返回的数据无法识别，请联系管理员。");
		await expect(actions).toHaveCount(0);
		await expect(page.getByText("此 Agent 暂时无法访问。")).toHaveCount(0);
	});
}

for (const detail of detailPages) {
	test(`re-reads the ${detail.name} when re-login finds the session still valid (W-03)`, async ({
		page,
	}) => {
		let reply: Reply = { status: 401 };
		const counts = await platform(page, {
			[detail.key]: () => reply,
		});
		const login = page.locator(
			'#main-content [data-slot="state-card"][data-kind="login"]',
		);
		await page.goto(detail.path);
		await expect(login).toBeVisible();
		const reads = counts[detail.key];
		const sessionReads = counts.session;
		// 会话仍有效、详情恢复：「重新登录」确认会话后重读详情，不停在同一张卡上。
		reply = { status: 200 };
		await login.getByRole("button", { name: "重新登录" }).click();
		await expect.poll(() => counts.session).toBeGreaterThan(sessionReads);
		await expect.poll(() => counts[detail.key]).toBeGreaterThan(reads);
		await expect(login).toHaveCount(0);
		if (detail.key === "application")
			await expect(
				page.getByRole("heading", { level: 1, name: application.name }),
			).toBeVisible();
		if (detail.name === "Agent detail")
			await expect(
				page.getByRole("heading", { level: 1, name: agent.name }),
			).toBeVisible();
		expect(
			await page.evaluate(
				() => performance.getEntriesByType("navigation").length,
			),
		).toBe(1);
	});
}

test("keyboard recovery on the Agent detail moves focus to the Agent h1, not body", async ({
	page,
}) => {
	let reply: Reply = { status: 401 };
	await platform(page, { agent: () => reply });
	const card = page.locator('#main-content [data-slot="state-card"]');
	const heading = page.getByRole("heading", { level: 1, name: agent.name });
	for (const [status, name] of [
		[401, "重新登录"],
		[503, "重新加载 Agent"],
	] as const) {
		reply = { status };
		await page.goto(`/agents/${agent.agentId}`);
		const action = card.getByRole("button", { name, exact: true });
		await action.focus();
		await expect(action).toBeFocused();
		reply = { status: 200 };
		await page.keyboard.press("Enter");
		await expect(card).toHaveCount(0);
		// 恢复后状态卡卸载：焦点移到详情 h1（tabIndex=-1），不落到 body。
		await expect(heading).toBeFocused();
		await expect(heading).toHaveAttribute("tabindex", "-1");
		expect(
			await page.evaluate(() => document.activeElement === document.body),
		).toBe(false);
	}
});

test("re-reads the Agent on the conversation page when re-login finds the session still valid (W-03)", async ({
	page,
}) => {
	let reply: Reply = { status: 401 };
	const counts = await platform(page, { agent: () => reply });
	const login = page.locator(
		'#main-content [data-slot="state-card"][data-kind="login"]',
	);
	await page.goto(`/chat/${agent.agentId}`);
	await expect(login).toBeVisible();
	await expect(
		page.getByRole("heading", { level: 1, name: "对话" }),
	).toBeVisible();
	const reads = counts.agent;
	const sessionReads = counts.session;
	// 会话仍有效、Agent 恢复：「重新登录」确认会话后重读 Agent，不停在同一张卡上。
	reply = { status: 200 };
	await login.getByRole("button", { name: "重新登录" }).click();
	await expect.poll(() => counts.session).toBeGreaterThan(sessionReads);
	await expect.poll(() => counts.agent).toBeGreaterThan(reads);
	await expect(login).toHaveCount(0);
	await expect(
		page.getByRole("heading", { level: 1, name: agent.name }),
	).toBeVisible();
	expect(
		await page.evaluate(
			() => performance.getEntriesByType("navigation").length,
		),
	).toBe(1);
});

// N-21：主要路由上只有一个导航链接是当前页；品牌、页内返回与取消链接不因前缀匹配被读成「当前页」。
test("every main route marks exactly one link as the current page (N-21)", async ({
	page,
}) => {
	await platform(page, {
		session: () => ({
			status: 200,
			body: {
				...session,
				user: { ...session.user, roles: ["employee", "system_admin"] },
			},
		}),
	});
	for (const path of [
		"/",
		"/agents",
		`/agents/${agent.agentId}`,
		`/agents/${agent.agentId}/configuration`,
		`/agents/${agent.agentId}/skills`,
		"/my-agents",
		"/my-agents/new",
		`/my-agents/${application.applicationId}`,
		"/skills",
		"/skills/manage",
		"/skills/manage/new",
		"/audit",
		"/admin/approvals",
		"/admin/agents",
		"/admin/audit",
		"/admin/skill-reviews",
		"/my-settings/relay-key",
		"/my-settings/api-credentials",
	]) {
		await page.goto(path);
		await expect(page.locator("main h1").first()).toBeVisible();
		// 审计页的「审计范围」是页内范围切换，标出的就是当前页本身，不计入。
		const current = 'a[aria-current="page"]:not(nav[aria-label="审计范围"] a)';
		await expect(
			page.locator(`main ${current}`),
			`${path} 页内链接不应标为当前页`,
		).toHaveCount(0);
		await expect(
			page.locator(current),
			`${path} 只应有一个当前页链接`,
		).toHaveCount(1);
		// 唯一的当前页链接是主导航里的导航项（子页面高亮所属导航项）。
		await expect(
			page.locator(`nav[aria-label="主导航"] ${current}`),
			`${path} 的当前页链接应是导航项`,
		).toHaveCount(1);
	}
});

test("renders the state card with the designed metrics (P-01)", async ({
	page,
}) => {
	await platform(page, { agent: () => ({ status: 403 }) });
	await page.goto(`/agents/${agent.agentId}`);
	const card = page.locator('#main-content [data-slot="state-card"]');
	await expect(card).toBeVisible();
	const metrics = await card.evaluate((element) => {
		const value = getComputedStyle(element);
		const title = element.querySelector('[data-slot="state-card-title"]');
		const description = element.querySelector(
			'[data-slot="state-card-description"]',
		);
		const probe = (color: string) => {
			const span = document.createElement("span");
			span.style.color = color;
			document.body.append(span);
			const resolved = getComputedStyle(span).color;
			span.remove();
			return resolved;
		};
		const main = element.closest("main");
		const mainStyle = main ? getComputedStyle(main) : null;
		return {
			minHeight: value.minHeight,
			padding: value.padding,
			radius: value.borderRadius,
			border: `${value.borderTopWidth} ${value.borderTopStyle} ${value.borderTopColor}`,
			expectedBorder: `1px solid ${probe("var(--border)")}`,
			background: value.backgroundColor,
			surface: probe("var(--surface)"),
			titleSize: title ? getComputedStyle(title).fontSize : null,
			titleFont: title ? getComputedStyle(title).fontFamily : null,
			bodyFont: getComputedStyle(document.body).fontFamily,
			descriptionSize: description
				? getComputedStyle(description).fontSize
				: null,
			descriptionColor: description
				? getComputedStyle(description).color
				: null,
			muted: probe("var(--muted-foreground)"),
			descriptionMargin: description
				? getComputedStyle(description).marginTop
				: null,
			width: element.getBoundingClientRect().width,
			contentWidth:
				main && mainStyle
					? main.clientWidth -
						Number.parseFloat(mainStyle.paddingLeft) -
						Number.parseFloat(mainStyle.paddingRight)
					: null,
		};
	});
	expect(metrics.minHeight).toBe("190px");
	expect(metrics.padding).toBe("18px");
	expect(metrics.radius).toBe("14px");
	expect(metrics.border).toBe(metrics.expectedBorder);
	expect(metrics.background).toBe(metrics.surface);
	expect(metrics.titleSize).toBe("16px");
	expect(metrics.titleFont).toBe(metrics.bodyFont);
	expect(metrics.titleFont).not.toMatch(/Iowan/);
	expect(metrics.descriptionSize).toBe("13px");
	expect(metrics.descriptionColor).toBe(metrics.muted);
	expect(metrics.descriptionMargin).toBe("6px");
	if (page.viewportSize()?.width === 390)
		expect(
			Math.abs(metrics.width - (metrics.contentWidth ?? 0)),
		).toBeLessThanOrEqual(1);
	await test.info().attach("state-card-unauthorized", {
		body: await page.screenshot(),
		contentType: "image/png",
	});
});

test("keeps detail loading lines outside any card frame (P-01)", async ({
	page,
}) => {
	const gate = held();
	await platform(page, {
		agent: () => ({ status: 200, hold: gate.promise }),
		application: () => ({ status: 200, hold: gate.promise }),
	});
	for (const path of [
		`/agents/${agent.agentId}`,
		`/my-agents/${application.applicationId}`,
		`/agents/${agent.agentId}/configuration`,
	]) {
		await page.goto(path);
		const line = page.locator('#main-content [data-slot="loading-line"]');
		await expect(line).toBeVisible();
		await expect(line.locator('[data-slot="spinner"]')).toBeVisible();
		expect(
			await line.evaluate((element) => {
				for (
					let node = element.parentElement;
					node && node.id !== "main-content";
					node = node.parentElement
				) {
					if (
						node.matches('[data-slot="card"], [data-slot="state-card"]') ||
						getComputedStyle(node).minHeight === "190px"
					)
						return false;
				}
				return true;
			}),
		).toBe(true);
	}
	gate.release();
});

test("shows the not-found state card inside the usable shell (P-01, #2297)", async ({
	page,
}, info) => {
	await platform(page);
	await page.goto("/no-such-page");
	await expect(
		page.getByRole("heading", { level: 1, name: "页面不存在" }),
	).toBeVisible();
	await expect(page).toHaveTitle("页面不存在 · Agora Agent");
	const card = page.locator('#main-content [data-slot="state-card"]');
	await expect(card).toHaveAttribute("data-kind", "not-found");
	await expect(card.getByRole("link", { name: "返回工作台" })).toHaveAttribute(
		"href",
		"/",
	);
	await expect(
		card.getByRole("link", { name: "前往 Agent 目录" }),
	).toHaveAttribute("href", "/agents");
	if (info.project.name === "mobile")
		await page.getByRole("button", { name: "打开导航" }).click();
	await page
		.getByRole("navigation", { name: "工作区" })
		.getByRole("link", { name: "Agent 目录" })
		.click();
	await expect(
		page.getByRole("heading", { level: 1, name: "选择要使用的 Agent。" }),
	).toBeVisible();
});
