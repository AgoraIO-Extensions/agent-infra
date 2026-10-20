import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { deploymentConfiguration } from "../src/features/my-agents/test-fixtures";
import { captureDesignContract, designViewports } from "./design-contract";
import {
	expectCardTable,
	expectDesktopTable,
	expectFieldLabel,
	expectPageHeadTop,
	expectSearchInput,
} from "./primitive-styles";

const baseline = AgentProjectionV2Schema.parse(
	pilotFakeScenariosV2.starting.response.body,
);
const cursor = "opaque-page/+?=";
// 第 3 行创建失败（行内「重试」），第 4 行为自定义镜像（来源筛选），第 11 行已停用、Owner 显示名唯一。
const agents = Array.from({ length: 12 }, (_, index) =>
	AgentProjectionV2Schema.parse({
		...baseline,
		agentId: `inventory-${index}`,
		name: index === 11 ? "较后页文档助手" : `编程助手 ${index}`,
		description:
			index === 11
				? "很长的受控管理列表说明。".repeat(30)
				: `受控管理列表说明 ${index}`,
		managementStatus:
			index === 11 ? "disabled" : index === 3 ? "creation_failed" : "available",
		serviceAvailability: index === 11 || index === 3 ? null : "ready",
		source:
			index === 4
				? {
						kind: "custom",
						interactionMode: "platform-adapter",
						imageReference: "registry.example.test/custom-agent:1",
					}
				: baseline.source,
		configuration: {
			...baseline.configuration,
			owners: [
				{
					userId:
						index === 11 ? `owner-late-${"x".repeat(80)}` : "another-owner",
					displayName: index === 11 ? "较后 Owner" : "其他 Owner",
					roles: ["employee"],
				},
			],
		},
	}),
);
const ownerIds = [
	...new Set(agents.map((agent) => agent.configuration.owners[0]?.userId)),
];

async function fixture(page: Page, admin = true) {
	let status = 200;
	let secondStatus = 200;
	let empty = false;
	let malformed = false;
	let release: (() => void) | undefined;
	let pending: Promise<void> | undefined;
	let commandStatus = 200;
	let holdCommand: Promise<void> | undefined;
	let releaseCommand: (() => void) | undefined;
	const items = agents.map((agent) => ({ ...agent }));
	const commands: { agentId: string; body: unknown }[] = [];
	const directory: { kind: string | null; ids: string[] }[] = [];
	const requests: { method: string; path: string; cursor: string | null }[] =
		[];
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		requests.push({
			method: request.method(),
			path: url.pathname,
			cursor: url.searchParams.get("cursor"),
		});
		if (url.pathname === "/api/v1/session") {
			await route.fulfill({
				json: {
					schemaVersion: 1,
					user: {
						userId: "controlled-admin",
						displayName: "受控验收账号",
						roles: admin ? ["employee", "system_admin"] : ["employee"],
					},
				},
			});
			return;
		}
		// 来源列的模板显示名来自部署配置（F-02）。
		if (url.pathname === "/api/v2/deployment/configuration") {
			await route.fulfill({ json: deploymentConfiguration });
			return;
		}
		if (url.pathname === "/api/v2/directory/search") {
			const ids = url.searchParams.get("ids")?.split(",") ?? [];
			directory.push({ kind: url.searchParams.get("kind"), ids });
			await route.fulfill({
				json: {
					schemaVersion: 1,
					items: ids.includes("org-platform")
						? [
								{
									kind: "organization",
									canonicalId: "org-platform",
									displayName: "平台工程",
									organizationPath: "研发 / 平台工程",
								},
							]
						: [],
				},
			});
			return;
		}
		const lifecycle = url.pathname.match(
			/^\/api\/v2\/agents\/([^/]+)\/lifecycle$/,
		);
		if (lifecycle && request.method() === "POST") {
			const agentId = decodeURIComponent(lifecycle[1] ?? "");
			const body = request.postDataJSON() as { command?: string };
			commands.push({ agentId, body });
			if (holdCommand) await holdCommand;
			const agent = items.find((item) => item.agentId === agentId);
			if (commandStatus !== 200 || !agent) {
				await route.fulfill({
					status: commandStatus === 200 ? 404 : commandStatus,
					json: {
						...pilotFakeScenariosV2.unavailable.response.body,
						retryable: true,
					},
				});
				return;
			}
			// 停用（#3033）立即撤销运行资格；重试创建回到「创建中」。
			if (body.command === "disable") {
				agent.managementStatus = "disabled";
				agent.serviceAvailability = null;
			} else agent.managementStatus = "creating";
			await route.fulfill({ json: agent });
			return;
		}
		// 管理员读取单个 Agent（#3033）：只有管理员会话可读；普通读取 /api/v2/agents/{id}
		// 落到下方兜底 404，模拟管理员不在使用范围内。
		const adminAgent = url.pathname.match(
			/^\/api\/v2\/admin\/agents\/([^/]+)$/,
		);
		if (adminAgent && request.method() === "GET") {
			const agentId = decodeURIComponent(adminAgent[1] ?? "");
			const agent = items.find((item) => item.agentId === agentId);
			await route.fulfill(
				admin && agent
					? { json: agent }
					: {
							status: admin ? 404 : 403,
							json: pilotFakeScenariosV2.unauthorized.response.body,
						},
			);
			return;
		}
		if (url.pathname === "/api/v2/admin/agents") {
			if (pending) await pending;
			const next = url.searchParams.get("cursor");
			const responseStatus = next === cursor ? secondStatus : status;
			if (responseStatus !== 200) {
				await route.fulfill({
					status: responseStatus,
					json: {
						...pilotFakeScenariosV2.unavailable.response.body,
						retryable: responseStatus >= 500,
					},
				});
			} else {
				await route.fulfill({
					json: {
						items: empty
							? []
							: next === cursor
								? items.slice(6)
								: items.slice(0, 6),
						nextCursor: malformed
							? 42
							: empty || next === cursor
								? null
								: cursor,
					},
				});
			}
			return;
		}
		await route.fulfill({
			status: 404,
			json: pilotFakeScenariosV2.unauthorized.response.body,
		});
	});
	return {
		requests,
		commands,
		directory,
		failCommands() {
			commandStatus = 503;
		},
		recoverCommands() {
			commandStatus = 200;
		},
		holdCommands() {
			holdCommand = new Promise<void>((resolve) => {
				releaseCommand = resolve;
			});
		},
		releaseCommands() {
			releaseCommand?.();
			holdCommand = undefined;
		},
		failSecond() {
			secondStatus = 503;
		},
		deny() {
			status = 403;
		},
		malform() {
			malformed = true;
		},
		empty() {
			empty = true;
		},
		recover() {
			status = 200;
			secondStatus = 200;
			malformed = false;
		},
		pause() {
			pending = new Promise<void>((resolve) => {
				release = resolve;
			});
		},
		resume() {
			release?.();
			pending = undefined;
		},
	};
}

async function capture(page: Page, info: TestInfo, name: string) {
	const path = info.outputPath(`${name}.png`);
	await page.screenshot({ path, fullPage: true });
	await info.attach(name, { path, contentType: "image/png" });
}

test("complete admin collection supports later-page search and URL refresh", async ({
	page,
}, info) => {
	const data = await fixture(page);
	// 搜索匹配 Owner 显示名（AA-02 / F-01：Owner 内部 ID 不再出现、也不参与匹配）。
	await page.goto(
		`/admin/agents?q=${encodeURIComponent("较后 Owner")}&status=disabled&page=2`,
	);
	await expect(page.getByText("较后页文档助手", { exact: true })).toBeVisible();
	await expect(page.getByRole("searchbox", { name: "搜索 Agent" })).toHaveValue(
		"较后 Owner",
	);
	await expect(page.getByLabel("运行状态")).toHaveValue("disabled");
	await expect(page.getByText("第 1 / 1 页")).toBeVisible();
	expect(
		data.requests
			.filter((request) => request.path === "/api/v2/admin/agents")
			.map((request) => request.cursor),
	).toEqual([null, cursor]);
	await page.reload();
	await expect(page.getByText("较后页文档助手", { exact: true })).toBeVisible();
	await capture(page, info, "admin-inventory-restored");
	await page.getByRole("searchbox").fill("");
	await page.getByLabel("运行状态").selectOption("all");
	await expect(page.getByText("第 1 / 2 页")).toBeVisible();
	await page.getByRole("button", { name: "下一页" }).click();
	await expect(page).toHaveURL(/page=2/);
	await page.reload();
	await expect(page.getByText("第 2 / 2 页")).toBeVisible();
	await expect(page.getByText("较后页文档助手", { exact: true })).toBeVisible();
	// #3033：可用的一行有管理员「停用 Agent」，已停用的一行没有任何操作；行内没有重试或开始对话。
	expect(
		await page.getByRole("button", { name: /重试|开始对话/ }).count(),
	).toBe(0);
	const disable = page.getByRole("button", { name: /停用/ });
	await expect(disable).toHaveCount(1);
	await expect(disable).toHaveAttribute("aria-label", "停用：编程助手 10");
	expect(await page.locator('main a[href*="/agents/"]').count()).toBe(1);
	expect(
		await page.locator('main a[href*="/agents/"]').getAttribute("href"),
	).toBe("/agents/inventory-10/configuration");
	const table = page.getByRole("table", { name: "已创建 Agent" });
	for (const ownerId of ownerIds)
		expect(await table.textContent()).not.toContain(ownerId);
	expect(data.requests.every((request) => request.method === "GET")).toBe(true);
});

test("source filter is kept in the URL, ignores unknown values and resets the page", async ({
	page,
}) => {
	await fixture(page);
	await page.goto("/admin/agents?page=2");
	await expect(page.getByText("第 2 / 2 页")).toBeVisible();
	await page.getByLabel("来源").selectOption({ label: "自定义镜像" });
	await expect(page).toHaveURL(/source=custom/);
	await expect(page).not.toHaveURL(/page=/);
	const rows = page
		.getByRole("table", { name: "已创建 Agent" })
		.locator("tbody")
		.getByRole("row");
	await expect(rows).toHaveCount(1);
	await expect(rows).toContainText("编程助手 4");
	// 设计 #admin-agents：自定义来源单元格写「自定义镜像」，筛选项为「全部来源 / 标准模板 / 自定义镜像」。
	await expect(rows.locator('[data-label="来源"]')).toHaveText("自定义镜像");
	await expect(rows).not.toContainText("registry.example.test");
	expect(
		await page.getByLabel("来源").locator("option").allTextContents(),
	).toEqual(["全部来源", "标准模板", "自定义镜像"]);
	await page.reload();
	await expect(page.getByLabel("来源")).toHaveValue("custom");
	await expect(rows).toHaveCount(1);
	await page.goto("/admin/agents?source=foo");
	await expect(page.getByLabel("来源")).toHaveValue("all");
	await expect(rows).toHaveCount(10);
});

test("Agent management page head places the h1 at the design height", async ({
	page,
}, info) => {
	await fixture(page);
	await page.goto("/admin/agents");
	await expect(
		page.getByRole("heading", { level: 1, name: "查看 Agent 状态" }),
	).toBeVisible();
	// 设计 .page-head-copy .eyebrow 上外边距为 0，h1 与设计同高（±1px）。
	await expectPageHeadTop(page, info.project.name === "mobile");
});

test("refresh second-page failure collapses the page to the heading and one retry", async ({
	page,
}, info) => {
	const data = await fixture(page);
	await page.goto("/admin/agents");
	await expect(page.getByRole("table", { name: "已创建 Agent" })).toBeVisible();
	data.failSecond();
	await page.getByRole("button", { name: "刷新 Agent 列表" }).click();
	const main = page.locator("main");
	// N-20：只剩页头文字与一条可重试的失败提示，按钮只有「重新加载」。
	await expect(main.getByRole("alert")).toHaveText(
		"暂时无法读取 Agent 列表，请稍后重试。重新加载",
	);
	await expect(main.getByRole("button")).toHaveCount(1);
	await expect(main.getByRole("button", { name: "重新加载" })).toBeEnabled();
	await expect(page.getByRole("table")).toHaveCount(0);
	await expect(main.getByRole("searchbox")).toHaveCount(0);
	await expect(main.getByRole("region", { name: "员工访问控制" })).toHaveCount(
		0,
	);
	await expect(
		main.getByRole("region", { name: "应用凭证材料授权" }),
	).toHaveCount(0);
	await expect(main.getByText(/个 Agent$/)).toHaveCount(0);
	await expect(main.getByText("Agent 列表暂时无法读取。")).toHaveCount(0);
	await capture(page, info, "admin-inventory-second-page-failed");
	data.recover();
	await main.getByRole("button", { name: "重新加载" }).click();
	await expect(page.getByRole("table", { name: "已创建 Agent" })).toBeVisible();
	await expect(
		main.getByRole("region", { name: "员工访问控制" }),
	).toBeVisible();
	await expect(main.getByText("12 个 Agent", { exact: true })).toBeVisible();
	data.deny();
	await page.getByRole("button", { name: "刷新 Agent 列表" }).click();
	await expect(page.getByText("当前无权访问 Agent 管理。")).toBeVisible();
	await expect(page.getByRole("table")).toHaveCount(0);
	await capture(page, info, "admin-inventory-revoked");
});

test("non-admin deep link never requests or exposes administrator inventory", async ({
	page,
}, info) => {
	const data = await fixture(page, false);
	await page.goto("/admin/agents");
	await expect(page.getByText("当前无权访问 Agent 管理。")).toBeVisible();
	expect(
		data.requests.some((request) => request.path === "/api/v2/admin/agents"),
	).toBe(false);
	await expect(
		page.getByRole("link", { name: "Agent 管理", exact: true }),
	).toHaveCount(0);
	await expect(page.getByRole("table")).toHaveCount(0);
	await capture(page, info, "admin-inventory-non-admin");
});

test("loading, empty, no match and invalid response have distinct controls", async ({
	page,
}, info) => {
	const data = await fixture(page);
	data.pause();
	await page.goto("/admin/agents");
	await expect(page.getByText("正在加载 Agent…")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "刷新 Agent 列表" }),
	).toBeDisabled();
	// 加载中页头没有计数 chip。
	await expect(page.locator("main").getByText(/个 Agent$/)).toHaveCount(0);
	data.resume();
	await expect(page.getByRole("table")).toBeVisible();
	await page.getByRole("searchbox").fill("不存在的项目");
	await expect(page.getByText("未找到匹配的 Agent。")).toBeVisible();
	await page.getByRole("button", { name: "清除筛选" }).click();
	data.empty();
	await page.getByRole("button", { name: "刷新 Agent 列表" }).click();
	await expect(page.getByText("暂无已创建的 Agent。")).toBeVisible();
	await capture(page, info, "admin-inventory-empty");
	data.malform();
	await page.getByRole("button", { name: "刷新 Agent 列表" }).click();
	await expect(page.getByRole("alert")).toBeVisible();
	await expect(page.getByRole("table")).toHaveCount(0);
});

test("original navigation groups, long fields and short viewport remain operable", async ({
	page,
}, info) => {
	await fixture(page);
	await page.goto("/admin/agents");
	await expect(page.getByRole("table")).toBeVisible();
	await page.setViewportSize({
		width: info.project.name === "mobile" ? 320 : 1280,
		height: 370,
	});
	await page.getByRole("searchbox").scrollIntoViewIfNeeded();
	await page.getByRole("searchbox").click();
	await expect(page.getByRole("searchbox")).toBeFocused();
	await page.keyboard.type("较后 Owner");
	await expect(page.getByText("较后页文档助手", { exact: true })).toBeVisible();
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);
	if (info.project.name === "mobile")
		await page.getByRole("button", { name: "打开导航" }).click();
	const nav = page
		.getByRole("navigation", { name: "主导航", exact: true })
		.filter({ visible: true });
	for (const name of ["工作区", "我的管理", "系统管理"])
		await expect(
			nav.getByRole("navigation", { name, exact: true }),
		).toBeVisible();
	await nav.getByRole("link", { name: "Agent 管理", exact: true }).click();
	await expect(page.getByRole("searchbox")).toBeVisible();
	await capture(page, info, "admin-inventory-short-viewport");
});

test("exported design viewport matrix admin Agents", async ({ page }, info) => {
	test.skip(
		info.project.name !== "desktop",
		"The exported nine-viewport matrix runs once.",
	);
	await fixture(page);
	await page.goto("/admin/agents");
	await expect(page.getByRole("row")).not.toHaveCount(0);
	for (const viewport of designViewports) {
		await page.setViewportSize(viewport);
		await captureDesignContract(page, info, "admin-agents");
	}
});

test("admin Agent filters and table follow the exported design, with mobile cards", async ({
	page,
}) => {
	await fixture(page);
	await page.goto("/admin/agents");
	const table = page.getByRole("table", { name: "已创建 Agent" });
	await expect(table).toBeVisible();
	const search = page.getByRole("searchbox", { name: "搜索 Agent" });
	const badge = table.locator('tbody [data-slot="badge"]').first();
	for (const viewport of [
		{ width: 1440, height: 900 },
		{ width: 768, height: 1024 },
	]) {
		await page.setViewportSize(viewport);
		await expectSearchInput(search);
		await expectFieldLabel(
			page,
			page.locator("label", { hasText: "运行状态" }),
		);
		await expectDesktopTable(page, table);
	}
	await page.setViewportSize({ width: 1440, height: 900 });
	const desktopBadgeWidth = (await badge.boundingBox())?.width;
	expect(desktopBadgeWidth).toBeGreaterThan(0);
	for (const viewport of [
		{ width: 390, height: 844 },
		{ width: 320, height: 640 },
	]) {
		await page.setViewportSize(viewport);
		await expectSearchInput(search);
		// ≤767 筛选为单列。
		expect(
			await page
				.locator(".admin-agent-filters")
				.evaluate(
					(element) =>
						getComputedStyle(element).gridTemplateColumns.split(" ").length,
				),
		).toBe(1);
		await expectCardTable(
			page,
			table,
			page.getByRole("link", { name: /^配置：/ }).first(),
		);
		// NI-99（自审批表迁来，审批首列按 F-05 已无徽章）：卡片里的状态 chip 仍是带圆点的行内块，
		// 宽度与桌面一致，右缘与值容器对齐。
		const geometry = await badge.evaluate((element) => {
			const value = element.closest('[data-slot="table-cell-value"]');
			const dot = getComputedStyle(element, "::before");
			return {
				display: getComputedStyle(element).display,
				dot: [dot.width, dot.height, dot.display],
				width: element.getBoundingClientRect().width,
				rightGap: Math.abs(
					(value?.getBoundingClientRect().right ?? 0) -
						element.getBoundingClientRect().right,
				),
			};
		});
		expect(geometry.display).not.toBe("block");
		expect(
			Math.abs(geometry.width - (desktopBadgeWidth ?? 0)),
		).toBeLessThanOrEqual(1);
		expect(geometry.dot).toEqual(["6px", "6px", "block"]);
		expect(geometry.rightGap).toBeLessThanOrEqual(1);
	}
});

test("admin Agent page structure, header tools and columns match the design at 1440", async ({
	page,
}) => {
	test.skip(test.info().project.name !== "desktop", "Desktop geometry");
	const data = await fixture(page);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/admin/agents");
	const main = page.locator("main");
	const table = page.getByRole("table", { name: "已创建 Agent" });
	await expect(table).toBeVisible();
	await expect(table.getByText("平台工程").first()).toBeVisible();
	// AA-02：四轨筛选 466/204/204/204、gap 10；搜索 18px 图标、无可见 label；第 2、3 轨为运行状态与来源。
	const filters = main.locator(".admin-agent-filters");
	const grid = await filters.evaluate((element) => {
		const style = getComputedStyle(element);
		return {
			columns: style.gridTemplateColumns
				.split(" ")
				.map((value) => Math.round(Number.parseFloat(value))),
			gap: style.columnGap,
			labels: [...element.children].map(
				(child) =>
					child.querySelector("label:not(.sr-only)")?.textContent ?? "",
			),
		};
	});
	expect(grid.columns).toHaveLength(4);
	for (const [index, width] of [466, 204, 204, 204].entries())
		expect(Math.abs((grid.columns[index] ?? 0) - width)).toBeLessThanOrEqual(1);
	expect(grid.gap).toBe("10px");
	expect(grid.labels).toEqual(["", "运行状态", "来源"]);
	const search = page.getByRole("searchbox", { name: "搜索 Agent" });
	await expect(search).toHaveAttribute(
		"placeholder",
		"搜索 Agent、Owner 或来源",
	);
	expect(
		await search.evaluate((input) => getComputedStyle(input).paddingLeft),
	).toBe("39px");
	// AA-01：表格紧跟筛选（20px），之后为分页与两个治理区；h2 为正文字体 16px。
	const filterBox = await filters.boundingBox();
	const tableBox = await main
		.locator('[data-slot="table-container"]')
		.boundingBox();
	expect(
		Math.abs(
			(tableBox?.y ?? 0) -
				((filterBox?.y ?? 0) + (filterBox?.height ?? 0)) -
				20,
		),
	).toBeLessThanOrEqual(1);
	const order = await main.evaluate((root) => {
		const pick = (selector: string) => root.querySelector(selector);
		const nodes = [
			pick("header.page-heading"),
			pick(".admin-agent-filters"),
			pick('[data-slot="table-container"]'),
			pick(".admin-agent-pagination"),
			...root.querySelectorAll('[data-slot="form-section"]'),
		];
		return nodes.every(
			(node, index) =>
				index === 0 ||
				Boolean(
					(nodes[index - 1]?.compareDocumentPosition(node as Node) ?? 0) &
						Node.DOCUMENT_POSITION_FOLLOWING,
				),
		);
	});
	expect(order).toBe(true);
	await expect(main.locator(".admin-agent-summary")).toHaveCount(0);
	for (const name of ["员工访问控制", "应用凭证材料授权"]) {
		const heading = main.getByRole("heading", { name, level: 2 });
		const style = await heading.evaluate((element) => ({
			fontSize: getComputedStyle(element).fontSize,
			fontFamily: getComputedStyle(element).fontFamily,
			display: getComputedStyle(document.documentElement).getPropertyValue(
				"--font-display",
			),
		}));
		expect(style.fontSize).toBe("16px");
		expect(style.fontFamily).not.toBe(style.display.trim());
		expect(style.fontFamily).not.toContain("Iowan");
	}
	// F-04：页头右侧 gray 计数 chip（总数，不随搜索变化）+ 44×44 ghost 刷新按钮；没有「创建审批」。
	const header = main.locator("header.page-heading");
	const count = header.getByText("12 个 Agent", { exact: true });
	await expect(count).toHaveAttribute("data-tone", "gray");
	// chip 保持设计高度（约 26px），不被同行 44px 按钮拉伸。
	expect((await count.boundingBox())?.height).toBeLessThanOrEqual(27);
	const refresh = header.getByRole("button", { name: "刷新 Agent 列表" });
	expect(await refresh.boundingBox()).toMatchObject({ width: 44, height: 44 });
	expect(
		await refresh.locator("svg").evaluate((svg) => {
			const box = svg.getBoundingClientRect();
			return [box.width, box.height];
		}),
	).toEqual([16, 16]);
	await expect(header.getByRole("link", { name: "创建审批" })).toHaveCount(0);
	await search.fill("编程助手 1");
	await expect(main.getByRole("status").filter({ hasText: "匹配" })).toHaveText(
		"匹配 2 个",
	);
	await expect(count).toBeVisible();
	await search.fill("");
	// AA-02：六列，每格 data-label 等于表头；状态格只有一个 chip，没有「服务：」。
	const headers = await table.locator("thead th").allTextContents();
	expect(headers).toEqual([
		"Agent",
		"Owner",
		"来源",
		"状态",
		"可用范围",
		"操作",
	]);
	const labels = await table
		.locator("tbody tr")
		.first()
		.locator("td")
		.evaluateAll((cells) =>
			cells.map((cell) => cell.getAttribute("data-label")),
		);
	expect(labels).toEqual([...headers.slice(0, 5), null]);
	// F-02 与设计 #admin-agents：标准模板来源只写模板显示名，不显示原始 templateId。
	await expect(
		table.locator("tbody tr").first().locator('[data-label="来源"]'),
	).toHaveText("Codex");
	await expect(table).not.toContainText("codex");
	for (const cell of await table.locator("tbody tr td:nth-child(4)").all())
		await expect(cell.locator('[data-slot="badge"]')).toHaveCount(1);
	await expect(table).not.toContainText("服务：");
	// 可用范围显示目录名称；当前页员工与组织各至多一次目录请求，单元格内没有 status。
	expect(await table.textContent()).not.toContain("org-platform");
	expect(
		data.directory.filter((request) => request.kind === "organization"),
	).toHaveLength(1);
	await expect(table.getByRole("status")).toHaveCount(0);
	// 行操作：ghost「配置」带 16px 图标，名称两两不同；只有创建失败行有「重试」。
	const configure = table.getByRole("link", { name: /^配置：/ });
	await expect(configure).toHaveCount(10);
	const names = await configure.evaluateAll((links) =>
		links.map((link) => link.getAttribute("aria-label")),
	);
	expect(new Set(names).size).toBe(10);
	expect(
		await configure
			.first()
			.locator("svg")
			.evaluate((svg) => {
				const box = svg.getBoundingClientRect();
				return [box.width, box.height];
			}),
	).toEqual([16, 16]);
	await expect(table.getByRole("button", { name: /^重试/ })).toHaveCount(1);
	await expect(page.getByText("处理 Owner 交接")).toHaveCount(0);
	await expect(page.getByLabel("Owner 交接入口")).toHaveCount(0);
});

test("a failed creation row retries once, keeps focus on its row and reports failures", async ({
	page,
}) => {
	const data = await fixture(page);
	await page.goto("/admin/agents");
	const row = page.getByRole("row", { name: /编程助手 3/ });
	const retry = row.getByRole("button", { name: "重试：编程助手 3" });
	await expect(row.locator('[data-slot="badge"]')).toHaveText("创建失败");
	// 失败：表格上方一条 alert，焦点留在「重试」，可再次提交。
	data.failCommands();
	await retry.click();
	await expect(page.locator("main").getByRole("alert")).toHaveText(
		"操作未能提交，请稍后重试。",
	);
	await expect(retry).toBeFocused();
	expect(data.commands).toHaveLength(1);
	data.recoverCommands();
	data.holdCommands();
	await retry.click();
	await expect(
		row.getByRole("button", { name: "重试中…：编程助手 3" }),
	).toBeDisabled();
	await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
	data.releaseCommands();
	const configure = row.getByRole("link", { name: "配置：编程助手 3" });
	await expect(configure).toBeFocused();
	await expect(page.locator('[data-slot="toast"]')).toHaveText(
		"已提交重试，创建状态会在后台更新",
	);
	await expect(row.locator('[data-slot="badge"]')).toHaveText("创建中");
	await expect(row.getByRole("button", { name: /^重试/ })).toHaveCount(0);
	expect(data.commands).toEqual([
		{
			agentId: "inventory-3",
			body: { schemaVersion: 1, command: "retry_creation" },
		},
		{
			agentId: "inventory-3",
			body: { schemaVersion: 1, command: "retry_creation" },
		},
	]);
	// 越过 Toast 2.6s 与 .18s 退场后，焦点仍在同行「配置」。
	await page.waitForTimeout(2_900);
	await expect(configure).toBeFocused();
	await expect(page.locator('[data-slot="toast"]')).toHaveText("");
});

// F-11：禁用员工先确认对象（姓名与邮箱）与后果；解除禁用仍直接提交。
test("disabling an employee is confirmed with the person before one request", async ({
	page,
}) => {
	await fixture(page);
	const userId = "11111111-1111-4111-8111-111111111111";
	const writes: unknown[] = [];
	await page.route("**/api/v2/directory/search?**", (route) =>
		route.fulfill({
			json: {
				schemaVersion: 1,
				items: [
					{
						kind: "user",
						canonicalId: userId,
						displayName: "验收员工",
						email: "employee@example.test",
					},
				],
			},
		}),
	);
	await page.route(`**/api/v2/admin/users/${userId}/disable`, (route) => {
		const request = route.request();
		if (request.method() === "PUT") {
			writes.push(request.postDataJSON());
			return route.fulfill({
				json: {
					schemaVersion: 1,
					userId,
					disabled: true,
					changed: true,
					auditOutcome: "recorded",
				},
			});
		}
		return route.fulfill({
			json: { schemaVersion: 1, userId, disabled: false },
		});
	});
	await page.goto("/admin/agents");
	const picker = page.getByRole("combobox", { name: "员工" });
	await picker.click();
	await page.getByRole("option", { name: /验收员工/ }).click();
	await expect(page.getByText("当前状态：未禁用")).toBeVisible();
	// 触发按钮名称带员工姓名（「禁用员工：{姓名}」），确认钮仍是「禁用员工」。
	const trigger = page.getByRole("button", {
		name: "禁用员工：验收员工",
		exact: true,
	});
	await trigger.click();
	const dialog = page.getByRole("dialog", { name: "禁用这名员工？" });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("验收员工");
	await expect(dialog).toContainText("employee@example.test");
	await expect(dialog).toContainText("立即不能登录平台");
	expect(writes).toHaveLength(0);
	await dialog.getByRole("button", { name: "取消" }).click();
	await expect(dialog).not.toBeVisible();
	expect(writes).toHaveLength(0);
	await trigger.click();
	await dialog.getByRole("button", { name: "禁用员工", exact: true }).click();
	await expect
		.poll(() => writes)
		.toEqual([{ schemaVersion: 1, disabled: true }]);
	// 确认后触发器因提交中被禁用，焦点回到分区标题而不是 body。
	await expect(
		page.getByRole("heading", { name: "员工访问控制" }),
	).toBeFocused();
	await expect(
		page
			.locator("#main-content")
			.getByRole("status")
			.filter({ hasText: "禁用已确认" }),
	).toBeVisible();
});

// #3033 AC-1：不依赖管理员个人使用范围，从 Agent 管理行内确认后停用。
test("an administrator disables an Agent from its row only after confirmation", async ({
	page,
}, info) => {
	const data = await fixture(page);
	await page.goto("/admin/agents");
	const row = page.getByRole("row", { name: /编程助手 2/ });
	const disable = row.getByRole("button", {
		name: "停用：编程助手 2",
		exact: true,
	});
	await expect(row.locator('[data-slot="badge"]')).toHaveText("就绪");
	// 行操作顺序：配置 → 停用；与 Owner 的「停止」区分，不另起一列，桌面同一行放下不换行。
	await expect(row.locator(".admin-agent-row-actions > *")).toHaveText([
		"配置",
		"停用",
	]);
	if (info.project.name === "desktop") {
		const tops = await row
			.locator(".admin-agent-row-actions > *")
			.evaluateAll((nodes) =>
				nodes.map((node) => Math.round(node.getBoundingClientRect().top)),
			);
		expect(new Set(tops).size).toBe(1);
	}
	await disable.click();
	const dialog = page.getByRole("dialog", { name: "停用 Agent？" });
	await expect(dialog).toContainText("编程助手 2");
	await expect(dialog).toContainText("Owner 不能恢复");
	await capture(page, info, "admin-agent-row-disable-confirm");
	await dialog.getByRole("button", { name: "取消" }).click();
	await expect(dialog).toBeHidden();
	await expect(disable).toBeFocused();
	expect(data.commands).toHaveLength(0);

	data.holdCommands();
	await disable.click();
	await dialog.getByRole("button", { name: "确认停用" }).click();
	await expect(
		row.getByRole("button", { name: "停用中…：编程助手 2" }),
	).toBeDisabled();
	data.releaseCommands();
	await expect(page.locator('[data-slot="toast"]')).toHaveText(
		"已提交停用请求",
	);
	// 列表回读后该行只剩「—」：焦点在页面标题，不落到 body。
	await expect(row.locator('[data-slot="badge"]')).toHaveText("已停用");
	await expect(row.getByRole("button")).toHaveCount(0);
	await expect(row.getByRole("link")).toHaveCount(0);
	await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
	expect(data.commands).toEqual([
		{ agentId: "inventory-2", body: { schemaVersion: 1, command: "disable" } },
	]);
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);
	await capture(page, info, "admin-agent-row-disabled");
});

// #3033 AC-2：管理员不在使用范围内时，配置页改读服务端管理员投影，只显示管理员操作。
test("an administrator outside the use scope opens configuration through the administrator projection", async ({
	page,
}, info) => {
	const data = await fixture(page);
	await page.goto("/admin/agents");
	await page
		.getByRole("row", { name: /编程助手 0/ })
		.getByRole("link", { name: "配置：编程助手 0" })
		.click();
	await expect(page).toHaveURL(/\/agents\/inventory-0\/configuration$/);
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(
		"配置 Agent 的 Owner、范围和运行方式。",
	);
	const main = page.locator("main");
	await expect(main).not.toContainText("Agent 不存在");
	await expect(main).not.toContainText("无法访问");
	// Owner 来自服务端管理员投影，不由页面合成。
	await expect(main).toContainText("Owner · 其他 Owner");
	await expect(main).toContainText("权限边界");
	await expect(
		page.getByRole("region", { name: "Agent 授权控制", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: /停止 Agent|重启 Agent|保存配置/ }),
	).toHaveCount(0);
	const admin = page.getByRole("region", { name: "管理员操作", exact: true });
	await expect(admin.getByRole("button")).toHaveText(["停用 Agent"]);
	// 先按使用范围读取（不可见），再读管理员投影；不改读其他管理员入口。
	const reads = data.requests
		.filter(
			(request) =>
				request.method === "GET" && request.path.endsWith("/inventory-0"),
		)
		.map((request) => request.path);
	expect(reads).toEqual([
		"/api/v2/agents/inventory-0",
		"/api/v2/admin/agents/inventory-0",
	]);
	await capture(page, info, "admin-configuration-out-of-scope");

	await admin.getByRole("button", { name: "停用 Agent" }).click();
	const dialog = page.getByRole("dialog", { name: "停用 Agent？" });
	await expect(dialog).toContainText("编程助手 0");
	await dialog.getByRole("button", { name: "确认停用" }).click();
	await expect(page.locator('[data-slot="toast"]')).toHaveText("Agent 已停用");
	await expect(page.locator(".configuration-notices")).toContainText(
		"运行资格已撤销，Owner 无法恢复。",
	);
	await expect(page.getByText("管理员操作")).toHaveCount(0);
	expect(data.commands).toEqual([
		{ agentId: "inventory-0", body: { schemaVersion: 1, command: "disable" } },
	]);
	await capture(page, info, "admin-configuration-out-of-scope-disabled");

	// Agent 详情对其不可见：返回 Agent 管理，该行已停用且没有操作。
	await page.getByRole("link", { name: "返回 Agent 管理" }).click();
	await expect(page).toHaveURL(/\/admin\/agents$/);
	const row = page.getByRole("row", { name: /编程助手 0/ });
	await expect(row.locator('[data-slot="badge"]')).toHaveText("已停用");
	await expect(row.getByRole("button")).toHaveCount(0);
	await expect(row.getByRole("link")).toHaveCount(0);
});

test("an administrator deep link to a missing Agent stays inaccessible and returns to Agent management", async ({
	page,
}) => {
	const data = await fixture(page);
	await page.goto("/agents/agent-missing/configuration");
	await expect(
		page.getByText("Agent 不存在，或你没有访问权限。"),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "返回 Agent 管理" }),
	).toHaveAttribute("href", "/admin/agents");
	await expect(page.getByText("管理员操作")).toHaveCount(0);
	expect(
		data.requests
			.filter((request) => request.path.endsWith("/agent-missing"))
			.map((request) => request.path),
	).toEqual([
		"/api/v2/agents/agent-missing",
		"/api/v2/admin/agents/agent-missing",
	]);
});

// #3033 AC-3：非管理员看不到、也不会调用管理员读取与停用入口。
test("an employee never reads the administrator projection or sees disable for a hidden Agent", async ({
	page,
}) => {
	const data = await fixture(page, false);
	await page.goto("/agents/inventory-0/configuration");
	await expect(
		page.getByText("Agent 不存在，或你没有访问权限。"),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "返回 Agent 详情" }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: /停用/ })).toHaveCount(0);
	await expect(page.getByText("管理员操作")).toHaveCount(0);
	expect(
		data.requests.some((request) =>
			request.path.startsWith("/api/v2/admin/agents"),
		),
	).toBe(false);
	expect(data.commands).toHaveLength(0);
});
