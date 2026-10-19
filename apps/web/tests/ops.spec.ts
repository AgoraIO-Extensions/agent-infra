import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { captureDesignContract, designViewports } from "./design-contract";
import { computed, expectPageHeadTop, resolved } from "./primitive-styles";

// 运维观测（F-12）：导出设计没有 #ops，结构与状态以 docs/development/web-ui.md「运维观测页」为准；
// 样式断言取设计 #my-agents 已创建卡（.grid-2 > .card：.card-head + .chip + dl.facts）与同类管理页页头的计算值。
const observabilityPath = "/api/v1/ops/observability";
const activeProjection = {
	schemaVersion: 1,
	service: "platform-api",
	enabled: true,
	state: "active",
	captureFailures: 0,
	exportFailures: 0,
	droppedLogs: 0,
	invalidRecords: 0,
};
const domainNames = ["平台健康", "Agent 与任务", "依赖", "告警"];

type ObservabilityReply =
	| { status: 200; body: Record<string, unknown> }
	| { status: 403 | 404 | 503 };

async function fixture(page: Page, { admin = true } = {}) {
	let reply: ObservabilityReply = { status: 200, body: activeProjection };
	let hold: Promise<void> | undefined;
	let release: (() => void) | undefined;
	const requests: string[] = [];
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		requests.push(`${request.method()} ${path}`);
		if (path === "/api/v1/session")
			return route.fulfill({
				json: {
					schemaVersion: 1,
					user: {
						userId: "ops-browser",
						displayName: "运维验收账号",
						roles: admin ? ["employee", "system_admin"] : ["employee"],
					},
				},
			});
		if (path === observabilityPath) {
			if (hold) await hold;
			if (reply.status === 200) return route.fulfill({ json: reply.body });
			return route.fulfill({
				status: reply.status,
				json: {
					schemaVersion: 1,
					code:
						reply.status === 403
							? "FORBIDDEN"
							: reply.status === 404
								? "RESOURCE_UNAVAILABLE"
								: "DEPENDENCY_UNAVAILABLE",
					message: "Controlled observability fixture",
					retryable: reply.status === 503,
					traceId: "trace-ops-fixture",
				},
			});
		}
		return route.fulfill({
			status: 404,
			json: {
				schemaVersion: 1,
				code: "RESOURCE_UNAVAILABLE",
				message: "Not part of ops fixture",
				retryable: false,
				traceId: "trace-ops-fixture",
			},
		});
	});
	return {
		requests,
		observabilityReads: () =>
			requests.filter((entry) => entry === `GET ${observabilityPath}`).length,
		writes: () => requests.filter((entry) => !entry.startsWith("GET ")),
		reply(next: ObservabilityReply) {
			reply = next;
		},
		pause() {
			hold = new Promise<void>((resolve) => {
				release = resolve;
			});
		},
		resume() {
			release?.();
			hold = undefined;
		},
	};
}

async function capture(page: Page, info: TestInfo, name: string) {
	await info.attach(`${name}-${info.project.name}`, {
		body: await page.screenshot({ fullPage: true, animations: "disabled" }),
		contentType: "image/png",
	});
}

function domain(page: Page, name: string) {
	return page
		.locator('main [data-slot="card"]')
		.filter({ has: page.getByRole("heading", { level: 2, name }) });
}

async function expectNoHorizontalOverflow(page: Page) {
	const overflow = await page.evaluate(() => {
		const main = document.querySelector("main");
		if (!main) throw new Error("Missing main");
		const right = main.getBoundingClientRect().right;
		return {
			page:
				Math.max(
					document.body.scrollWidth,
					document.documentElement.scrollWidth,
				) - innerWidth,
			cards: [...main.querySelectorAll('[data-slot="card"]')].map(
				(card) => card.getBoundingClientRect().right - right,
			),
		};
	});
	expect(overflow.page).toBeLessThanOrEqual(0);
	for (const delta of overflow.cards) expect(delta).toBeLessThanOrEqual(0.5);
}

test("not-connected domains follow the design card, chip and facts at 1440×900 and 390×844", async ({
	page,
}, info) => {
	const mobile = info.project.name === "mobile";
	if (!mobile) await page.setViewportSize({ width: 1440, height: 900 });
	const api = await fixture(page);
	await page.goto("/ops");
	const main = page.locator("main");
	await expect(main.locator('[data-slot="card"]')).toHaveCount(4);

	// 页头：eyebrow / h1 / 副标题与同类管理页一致，h1 落在设计高度。
	const header = main.locator("header.page-heading");
	await expect(header.locator(".page-eyebrow")).toHaveText(
		"系统管理 / 运维观测",
	);
	await expect(
		header.getByRole("heading", {
			level: 1,
			name: "先确认平台状态，再定位故障。",
		}),
	).toBeVisible();
	await expect(header.locator("p").nth(1)).toHaveText(
		"只显示正式观测查询返回的状态；没有数据源的区块标为「未接入」，页面不生成指标或告警。",
	);
	await expectPageHeadTop(page, mobile);
	const refresh = header.getByRole("button", { name: "刷新运维状态" });
	await expect(refresh).toBeEnabled();
	expect(await refresh.boundingBox()).toMatchObject({ width: 44, height: 44 });

	// 四个区块按顺序出现；没有数据源的三块写「未接入」，告警块的计数来自正式查询。
	await expect(main.locator('[data-slot="card"] h2')).toHaveText(domainNames);
	for (const name of domainNames) {
		const card = domain(page, name);
		await expect(card).toHaveAttribute("aria-labelledby", /.+/);
		await expect(card.locator('[data-slot="badge"]')).toHaveText("未接入");
		await expect(card.locator('[data-slot="badge"]')).toHaveAttribute(
			"data-tone",
			"gray",
		);
	}
	for (const name of domainNames.slice(0, 3))
		await expect(domain(page, name).locator("dl")).toContainText(
			"数据来源未接入",
		);
	const alerts = domain(page, "告警");
	await expect(alerts.locator("dt")).toHaveText([
		"覆盖",
		"告警出口",
		"观测采集",
		"采集失败",
		"导出失败",
		"丢弃日志",
		"无效记录",
		"最近导出失败",
	]);
	await expect(alerts.locator("dd")).toHaveText([
		"服务不可用、持续积压与异常错误",
		"未接入",
		"Platform API · 正常",
		"0 次",
		"0 次",
		"0 条",
		"0 条",
		"无",
	]);

	// 栅格：设计 .grid-2 两列、gap 16；≤767px 单列，四块依次纵向排列。
	const grid = main.locator(".operations-grid");
	const columns = await grid.evaluate(
		(element) =>
			getComputedStyle(element).gridTemplateColumns.split(" ").length,
	);
	expect(columns).toBe(mobile ? 1 : 2);
	expect(await computed(grid, ["columnGap", "rowGap"])).toEqual({
		columnGap: "16px",
		rowGap: "16px",
	});
	const boxes = await main
		.locator('[data-slot="card"]')
		.evaluateAll((cards) =>
			cards.map((card) => card.getBoundingClientRect().toJSON()),
		);
	if (mobile)
		for (const [index, box] of boxes.entries()) {
			if (index === 0) continue;
			const previous = boxes[index - 1];
			expect(box.x).toBe(previous.x);
			expect(box.y).toBeGreaterThanOrEqual(previous.bottom + 15.5);
		}
	else {
		expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThanOrEqual(0.5);
		expect(Math.abs(boxes[1].x - boxes[0].right - 16)).toBeLessThanOrEqual(0.5);
		expect(boxes[2].y).toBeGreaterThan(boxes[0].y);
	}

	// 卡片：设计 .card padding 18、圆角 14、1px 边框、surface 底。
	const card = domain(page, "平台健康");
	expect(
		await computed(card, [
			"paddingTop",
			"paddingLeft",
			"borderTopLeftRadius",
			"borderTopWidth",
			"backgroundColor",
			"borderTopColor",
		]),
	).toEqual({
		paddingTop: "18px",
		paddingLeft: "18px",
		borderTopLeftRadius: "14px",
		borderTopWidth: "1px",
		backgroundColor: await resolved(page, "backgroundColor", "var(--surface)"),
		borderTopColor: await resolved(page, "color", "var(--border)"),
	});
	// 卡头：设计 .card-head 两端对齐、gap 14；标题为 .card-title h3 的 17px / 650 正文字体。
	expect(
		await computed(card.locator(".operations-domain-head"), [
			"display",
			"justifyContent",
			"alignItems",
			"columnGap",
		]),
	).toEqual({
		display: "flex",
		justifyContent: "space-between",
		alignItems: "flex-start",
		columnGap: "14px",
	});
	const title = card.locator("h2");
	const titleStyle = await computed(title, [
		"fontSize",
		"fontWeight",
		"lineHeight",
		"fontFamily",
		"letterSpacing",
	]);
	const bodyFont = await page.evaluate(() =>
		getComputedStyle(document.body).fontFamily.trim(),
	);
	expect(titleStyle).toEqual({
		fontSize: "17px",
		fontWeight: "650",
		lineHeight: "23.8px",
		fontFamily: bodyFont,
		letterSpacing: "normal",
	});
	// chip：设计 .chip 11px、最小高 24、左右 9px、全圆角，gray 为 muted 文字。
	const chip = card.locator('[data-slot="badge"]');
	expect(
		await computed(chip, [
			"fontSize",
			"minHeight",
			"paddingLeft",
			"borderTopLeftRadius",
			"color",
		]),
	).toEqual({
		fontSize: "11px",
		minHeight: "24px",
		paddingLeft: "9px",
		borderTopLeftRadius: "999px",
		color: await resolved(page, "color", "var(--muted-foreground)"),
	});
	const chipBox = await chip.boundingBox();
	const cardBox = await card.boundingBox();
	// chip 贴卡片右内边距（1px 边框 + 18px），不被标题挤到下一行。
	expect(
		Math.abs(
			(cardBox?.x ?? 0) +
				(cardBox?.width ?? 0) -
				19 -
				((chipBox?.x ?? 0) + (chipBox?.width ?? 0)),
		),
	).toBeLessThanOrEqual(0.5);
	expect(
		Math.abs((chipBox?.y ?? 0) - (cardBox?.y ?? 0) - 19),
	).toBeLessThanOrEqual(0.5);
	// 事实：设计 dl.facts 上距 15、13px；桌面 150px 标签列、gap 10/18；窄屏单列、dt 上距 8、dd 下距 4。
	const facts = card.locator("dl");
	const factStyle = await computed(facts, [
		"gridTemplateColumns",
		"columnGap",
		"rowGap",
		"marginTop",
		"fontSize",
	]);
	expect(factStyle.marginTop).toBe("15px");
	expect(factStyle.fontSize).toBe("13px");
	const tracks = factStyle.gridTemplateColumns.split(" ");
	if (mobile) {
		expect(tracks).toHaveLength(1);
		expect(factStyle.rowGap).toBe("3px");
		expect(
			await computed(facts.locator("dt").first(), ["marginTop", "color"]),
		).toEqual({
			marginTop: "8px",
			color: await resolved(page, "color", "var(--muted-foreground)"),
		});
		expect(
			(await computed(facts.locator("dd").first(), ["marginBottom"]))
				.marginBottom,
		).toBe("4px");
	} else {
		expect(tracks[0]).toBe("150px");
		expect(tracks).toHaveLength(2);
		expect(factStyle.columnGap).toBe("18px");
		expect(factStyle.rowGap).toBe("10px");
		expect(
			await computed(facts.locator("dt").first(), ["marginTop", "color"]),
		).toEqual({
			marginTop: "0px",
			color: await resolved(page, "color", "var(--muted-foreground)"),
		});
	}

	await expectNoHorizontalOverflow(page);
	await capture(page, info, "ops-not-connected");
	expect(api.observabilityReads()).toBe(1);
	expect(api.writes()).toEqual([]);
});

test("a deployment without the observability query shows the not-connected state card", async ({
	page,
}, info) => {
	const api = await fixture(page);
	api.reply({ status: 404 });
	await page.goto("/ops");
	const main = page.locator("main");
	const card = main.locator('[data-slot="state-card"]');
	await expect(card).toHaveAttribute("data-kind", "unavailable");
	await expect(card.getByRole("heading", { level: 2 })).toHaveText(
		"观测查询未接入",
	);
	await expect(card).toContainText(
		"当前部署没有提供运维观测查询，页面不显示指标或告警。",
	);
	// 没有可重试的操作，也没有区块或刷新。
	await expect(main.getByRole("button")).toHaveCount(0);
	await expect(main.locator('[data-slot="card"]')).toHaveCount(0);
	await expectNoHorizontalOverflow(page);
	await capture(page, info, "ops-query-not-connected");
});

test("loading shows the shared loading line, hides domains and keeps refresh disabled", async ({
	page,
}, info) => {
	const api = await fixture(page);
	api.pause();
	await page.goto("/ops");
	const main = page.locator("main");
	const loading = main.locator('[data-slot="loading-line"]');
	await expect(loading).toHaveText("正在读取观测状态…");
	await expect(loading).toHaveAttribute("role", "status");
	await expect(loading.locator('[data-slot="spinner"]')).toBeVisible();
	await expect(
		main.getByRole("button", { name: "刷新运维状态" }),
	).toBeDisabled();
	await expect(main.locator('[data-slot="card"]')).toHaveCount(0);
	await expectNoHorizontalOverflow(page);
	await capture(page, info, "ops-loading");
	api.resume();
	await expect(main.locator('[data-slot="card"]')).toHaveCount(4);
	await expect(loading).toHaveCount(0);
	await expect(
		main.getByRole("button", { name: "刷新运维状态" }),
	).toBeEnabled();

	// 刷新再次进入读取中，返回后按新的查询结果显示。
	api.pause();
	api.reply({
		status: 200,
		body: {
			...activeProjection,
			exportFailures: 2,
			droppedLogs: 1,
			lastExportFailureAt: "2026-10-13T00:00:00.000Z",
		},
	});
	await main.getByRole("button", { name: "刷新运维状态" }).click();
	await expect(loading).toBeVisible();
	await expect(main.locator('[data-slot="card"]')).toHaveCount(0);
	api.resume();
	const alerts = domain(page, "告警");
	await expect(alerts.locator('[data-slot="badge"]')).toHaveText("降级");
	await expect(alerts.locator('[data-slot="badge"]')).toHaveAttribute(
		"data-tone",
		"amber",
	);
	await expect(alerts.locator("dd").nth(2)).toHaveText("Platform API · 有失败");
	await expect(alerts.locator("dd").nth(4)).toHaveText("2 次");
	await expect(alerts.locator("dd").nth(5)).toHaveText("1 条");
	await expect(alerts.locator("time")).toHaveAttribute(
		"datetime",
		"2026-10-13T00:00:00.000Z",
	);
	await expect(
		domain(page, "平台健康").locator('[data-slot="badge"]'),
	).toHaveText("未接入");
	expect(api.observabilityReads()).toBe(2);
	expect(api.writes()).toEqual([]);
});

test("unavailable uses the shared state card and retry returns focus as the read recovers", async ({
	page,
}, info) => {
	const api = await fixture(page);
	api.reply({ status: 503 });
	await page.goto("/ops");
	const main = page.locator("main");
	const card = main.getByRole("alert");
	await expect(card).toHaveAttribute("data-kind", "unavailable");
	await expect(card.getByRole("heading", { level: 2 })).toHaveText(
		"服务暂不可用",
	);
	await expect(card).toContainText("观测服务当前不可用。");
	// 失败卡只有一个重试；页头不再重复刷新，也不显示区块。
	await expect(main.getByRole("button")).toHaveText(["重新读取观测状态"]);
	await expect(main.locator('[data-slot="card"]')).toHaveCount(0);
	await expectNoHorizontalOverflow(page);
	await capture(page, info, "ops-unavailable");

	// 仍然失败：焦点回到同一个重试按钮。
	const retry = main.getByRole("button", { name: "重新读取观测状态" });
	await retry.focus();
	await retry.press("Enter");
	await expect(retry).toBeFocused();
	expect(api.observabilityReads()).toBe(2);

	// 恢复：区块出现，焦点移到页面 h1。
	api.reply({ status: 200, body: activeProjection });
	await retry.press("Enter");
	await expect(main.locator('[data-slot="card"]')).toHaveCount(4);
	await expect(
		main.getByRole("heading", {
			level: 1,
			name: "先确认平台状态，再定位故障。",
		}),
	).toBeFocused();
	expect(api.writes()).toEqual([]);
});

test("a non-administrator sees the unauthorized card and never requests observability", async ({
	page,
}, info) => {
	const api = await fixture(page, { admin: false });
	await page.goto("/ops");
	const main = page.locator("main");
	const card = main.locator('[data-slot="state-card"]');
	await expect(card).toHaveAttribute("data-kind", "unauthorized");
	await expect(card.getByRole("heading", { level: 2 })).toHaveText("未授权");
	await expect(card).toContainText("你没有访问运维观测的权限。");
	await expect(card.getByRole("link", { name: "返回工作台" })).toBeVisible();
	// 无权限卡是静态边界，不播报；没有刷新、区块或观测事实。
	await expect(main.getByRole("alert")).toHaveCount(0);
	await expect(main.getByRole("button")).toHaveCount(0);
	await expect(main.locator('[data-slot="card"]')).toHaveCount(0);
	await expect(main).not.toContainText("告警出口");
	await expect(page.getByRole("link", { name: "运维观测" })).toHaveCount(0);
	await expectNoHorizontalOverflow(page);
	await capture(page, info, "ops-unauthorized");
	// 会话不含 system_admin 时路由直接显示无权限卡，不发出观测查询。
	expect(api.observabilityReads()).toBe(0);
	expect(api.requests.some((entry) => entry.includes("/ops/"))).toBe(false);
	await card.getByRole("link", { name: "返回工作台" }).click();
	await expect(page).toHaveURL(/\/$/);
	expect(api.observabilityReads()).toBe(0);
});

test("a server denial for a stale administrator session shows the same unauthorized card", async ({
	page,
}) => {
	const api = await fixture(page);
	api.reply({ status: 403 });
	await page.goto("/ops");
	const main = page.locator("main");
	const card = main.locator('[data-slot="state-card"]');
	await expect(card).toHaveAttribute("data-kind", "unauthorized");
	await expect(card).toContainText("你没有访问运维观测的权限。");
	await expect(main.getByRole("button")).toHaveCount(0);
	await expect(main.locator('[data-slot="card"]')).toHaveCount(0);
	expect(api.observabilityReads()).toBe(1);
});

test("exported design viewport matrix ops", async ({ page }, info) => {
	test.skip(
		info.project.name !== "desktop",
		"The exported nine-viewport matrix runs once.",
	);
	await fixture(page);
	await page.goto("/ops");
	await expect(page.locator('main [data-slot="card"]')).toHaveCount(4);
	for (const viewport of designViewports) {
		await page.setViewportSize(viewport);
		await expectNoHorizontalOverflow(page);
		await captureDesignContract(page, info, "ops");
	}
});
