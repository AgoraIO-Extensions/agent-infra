import {
	AgentDetailProjectionV1Schema,
	AgentProjectionV2Schema,
} from "@agent-infra/contracts/pilot";
import {
	pilotAgentDetailFromV2,
	pilotFakeScenariosV2,
} from "@agent-infra/test-support/pilot";
import { expect, type Page, test } from "@playwright/test";
import { pendingApplication } from "../src/features/my-agents/test-fixtures";
import { backgroundReread } from "./background-reread";
import {
	expectFocusableBusy,
	expectFocusSettled,
	pinElement,
} from "./page-health";
import { expectCleanPage, trackPageErrors } from "./primitive-styles";

// R4-02 会话确认期壳层骨架与 P-01 公共状态卡（加载、无权限、不可用、404）。
const agent = AgentProjectionV2Schema.parse({
	...pilotFakeScenariosV2.starting.response.body,
	agentId: "agent-states-1",
});
const agentDetail = AgentDetailProjectionV1Schema.parse(
	pilotAgentDetailFromV2(agent),
);
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
		/** Agent 目录列表（#3388）；不传时返回 [agent]。 */
		agents?: () => Reply;
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
			return fulfill(route, replies.agents?.() ?? { status: 200 }, {
				items: [agent],
				nextCursor: null,
			});
		if (url.pathname === `/api/v2/agents/${agent.agentId}`) {
			counts.agent += 1;
			return fulfill(route, replies.agent?.() ?? { status: 200 }, agent);
		}
		// Agent 详情页读取带 Owner 状态的详情投影（#2910）；配置与 Skill 页仍读 V2。
		if (url.pathname === `/api/v2/agents/${agent.agentId}/detail`) {
			counts.agent += 1;
			return fulfill(route, replies.agent?.() ?? { status: 200 }, agentDetail);
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

// FIX3-7：恢复焦点在公共状态卡层统一处理，所有使用 ReadFailureCard 的页面都落到页面 h1。
const recoveryPages = [
	...detailPages.map((detail) => ({
		name: detail.name,
		path: detail.path,
		key: detail.key,
		retry: detail.retry,
	})),
	{
		name: "conversation",
		path: `/chat/${agent.agentId}`,
		key: "agent" as const,
		retry: "重新读取",
	},
];

for (const target of recoveryPages) {
	test(`keyboard recovery on the ${target.name} moves focus to the page h1, not body (FIX3-7)`, async ({
		page,
	}) => {
		let reply: Reply = { status: 401 };
		await platform(page, { [target.key]: () => reply });
		const heading = page.locator("#main-content h1");
		for (const [status, name] of [
			[401, "重新登录"],
			[503, target.retry],
		] as const) {
			// 需求变化（#3268 N8-2-09）：本用例的会话是员工，Owner 配置与 Agent 的 Skill 页恢复后是公共
			// 「无法访问」卡（同为 state-card）。所以只看被恢复的那张读取失败卡（login / unavailable）
			// 是否卸载，原先断言主内容区没有任何 state-card。
			const card = page.locator(
				`#main-content [data-slot="state-card"][data-kind="${status === 401 ? "login" : "unavailable"}"]`,
			);
			reply = { status };
			await page.goto(target.path);
			const action = card.getByRole("button", { name, exact: true });
			await action.focus();
			await expect(action).toBeFocused();
			reply = { status: 200 };
			await page.keyboard.press("Enter");
			await expect(card).toHaveCount(0);
			await expect(heading).toHaveCount(1);
			await expect(heading).toBeFocused();
			await expect(heading).toHaveAttribute("tabindex", "-1");
			expect(
				await page.evaluate(() => document.activeElement === document.body),
			).toBe(false);
		}
	});

	test(`a failed keyboard retry on the ${target.name} keeps focus on the retry button (FIX3-6)`, async ({
		page,
	}) => {
		let reply: Reply = { status: 401 };
		await platform(page, { [target.key]: () => reply });
		const card = page.locator('#main-content [data-slot="state-card"]');
		const readPath =
			target.key === "application"
				? `/api/v2/agent-applications/${application.applicationId}`
				: target.path === `/agents/${agent.agentId}`
					? `/api/v2/agents/${agent.agentId}/detail`
					: `/api/v2/agents/${agent.agentId}`;
		for (const [status, name] of [
			// 401：会话仍有效，但数据仍返回 401。
			[401, "重新登录"],
			[503, target.retry],
		] as const) {
			reply = { status };
			await page.goto(target.path);
			const action = card.getByRole("button", { name, exact: true });
			await action.focus();
			await expect(action).toBeFocused();
			const reread = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === readPath &&
					response.status() === status,
			);
			await page.keyboard.press("Enter");
			await reread;
			// 请求结束、仍然失败：按钮回到可用状态，焦点仍在按钮上，不落到 body。
			await expect(action).toHaveAttribute("aria-disabled", "false");
			await expect(action).toBeFocused();
			expect(
				await page.evaluate(() => document.activeElement === document.body),
			).toBe(false);
		}
	});
}

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
		// 带返回 / 取消链接的子路由：返回目标是当前地址的前缀（FIX3-4）。
		`/my-agents/${application.applicationId}/edit`,
		"/skills",
		"/skills/skill-states-v1",
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

	// 未匹配的 /agents/... 子地址以 /agents 为前缀：404 卡片的「前往 Agent 目录」不能被
	// 前缀匹配标成当前页（N-21）。
	await page.goto(`/agents/${agent.agentId}/no-such-page`);
	await expect(card).toHaveAttribute("data-kind", "not-found");
	await expect(
		card.getByRole("link", { name: "前往 Agent 目录" }),
	).not.toHaveAttribute("aria-current", /.*/);
	await expect(page.locator('main a[aria-current="page"]')).toHaveCount(0);
});

/**
 * 从工作台经侧栏到 Agent 目录；目录的后台重读读到 401（不可重试，整页换成「登录已过期」卡），用户按
 * 「重新登录」确认会话，会话暂时确认不了（503，重试用尽）：壳层换成「暂时无法确认登录状态」卡（#3388
 * F13-1 ④；已就绪会话自己的后台重读失败不再换卡，#3387）。返回这张卡。
 */
async function sessionLostOnDirectory(
	page: Page,
	mobile: boolean,
	set: { session: (reply: Reply) => void; agents: (reply: Reply) => void },
) {
	await page.goto("/");
	await expect(
		page.getByRole("heading", { level: 1, name: "选择一个 Agent 开始工作。" }),
	).toBeVisible();
	if (mobile)
		await page.getByRole("button", { name: "打开导航", exact: true }).click();
	await page
		.getByRole("navigation")
		.getByRole("link", { name: "Agent 目录" })
		.first()
		.click();
	await expect(page).toHaveURL(/\/agents$/);
	await expect(
		page.getByRole("heading", { level: 1, name: "选择要使用的 Agent。" }),
	).toBeVisible();
	set.agents({ status: 401 });
	await backgroundReread(page);
	const login = page.locator(
		'#main-content [data-slot="state-card"][data-kind="login"]',
	);
	await expect(login).toBeVisible();
	set.session({ status: 503 });
	set.agents({ status: 200 });
	await login.getByRole("button", { name: "重新登录", exact: true }).click();
	const card = page.locator('#main-content [data-slot="state-card"]');
	await expect(card).toContainText("暂时无法确认登录状态，请稍后重试。", {
		timeout: 30_000,
	});
	return card;
}

// #3388 N13-03：壳层状态卡跨路由保留。确认会话暂时不可用、壳层换成状态卡后按「重新检查」（挂起，
// 按钮可聚焦地禁用），浏览器后退到 /：按钮随壳层留在文档中，代管以后退后的页面为准。确认成功换成工作台后
// 焦点到工作台 h1，仍无法确认时留在「重新检查」上，都不落到 body。两视口一致。
for (const outcome of ["recovers", "fails again"] as const)
	test(`going back while the shell rechecks the session follows the current route (${outcome}, #3388 N13-03)`, async ({
		page,
	}, info) => {
		test.setTimeout(90_000);
		const mobile = info.project.name === "mobile";
		if (!mobile) await page.setViewportSize({ width: 1440, height: 900 });
		const errors = trackPageErrors(page);
		let sessionReply: Reply = { status: 200 };
		let agentsReply: Reply = { status: 200 };
		await platform(page, {
			session: () => sessionReply,
			agents: () => agentsReply,
		});
		const card = await sessionLostOnDirectory(page, mobile, {
			session: (reply) => {
				sessionReply = reply;
			},
			agents: (reply) => {
				agentsReply = reply;
			},
		});
		const recheck = await pinElement(
			card.getByRole("button", { name: "重新检查", exact: true }),
			"shell-recheck",
		);
		const gate = held();
		sessionReply = {
			status: outcome === "recovers" ? 200 : 503,
			hold: gate.promise,
		};
		await recheck.focus();
		await page.keyboard.press("Enter");
		await expectFocusableBusy(recheck, "重新检查确认中", [30, 150]);
		await page.goBack();
		await expect(page).toHaveURL(/\/$/);
		await expectFocusableBusy(recheck, "后退到 / 后（确认中）", [30, 150]);
		gate.release();
		if (outcome === "recovers") {
			await expectFocusSettled(
				page.getByRole("heading", {
					level: 1,
					name: "选择一个 Agent 开始工作。",
				}),
				"后退后确认成功",
				[150, 600, 1500, 3000],
			);
		} else {
			await expect(recheck).toHaveText("重新检查", { timeout: 30_000 });
			await expect(recheck).toHaveAttribute("aria-disabled", "false");
			await expectFocusSettled(recheck, "后退后仍无法确认", [50, 300, 1000]);
		}
		await expectCleanPage(page, errors);
	});

// #3388 N13-05：焦点在壳层状态卡未按下的「重新检查」上（Tab 到它）时回到标签页，会话后台重读确认成功、状态卡
// 换成当前路由：焦点交给 Agent 目录 h1，不落到 body、不滚动页面。两视口一致。
test("a background session recheck that replaces the focused, unpressed recheck hands focus to the route h1 (#3388 N13-05)", async ({
	page,
}, info) => {
	test.setTimeout(90_000);
	const mobile = info.project.name === "mobile";
	if (!mobile) await page.setViewportSize({ width: 1440, height: 900 });
	const errors = trackPageErrors(page);
	let sessionReply: Reply = { status: 200 };
	let agentsReply: Reply = { status: 200 };
	await platform(page, {
		session: () => sessionReply,
		agents: () => agentsReply,
	});
	const card = await sessionLostOnDirectory(page, mobile, {
		session: (reply) => {
			sessionReply = reply;
		},
		agents: (reply) => {
			agentsReply = reply;
		},
	});
	const recheck = card.getByRole("button", { name: "重新检查", exact: true });
	await recheck.focus();
	await expect(recheck).toBeFocused();
	const scrolled = await page.evaluate(() => window.scrollY);
	sessionReply = { status: 200 };
	await backgroundReread(page);
	await expectFocusSettled(
		page.getByRole("heading", { level: 1, name: "选择要使用的 Agent。" }),
		"后台确认会话成功后",
		[150, 600, 1500, 3000],
	);
	expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
	await expectCleanPage(page, errors);
});
