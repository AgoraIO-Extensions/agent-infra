import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { captureDesignContract, designViewports } from "./design-contract";

const baseline = AgentProjectionV2Schema.parse(
	pilotFakeScenariosV2.starting.response.body,
);
const cursor = "opaque-page/+?=";
const agents = Array.from({ length: 12 }, (_, index) =>
	AgentProjectionV2Schema.parse({
		...baseline,
		agentId: `inventory-${index}`,
		name: index === 11 ? "较后页文档助手" : `编程助手 ${index}`,
		description:
			index === 11
				? "很长的受控管理列表说明。".repeat(30)
				: `受控管理列表说明 ${index}`,
		managementStatus: index === 11 ? "disabled" : "available",
		serviceAvailability: index === 11 ? null : "ready",
		configuration: {
			...baseline.configuration,
			owners: [
				{
					userId:
						index === 11 ? `owner-late-${"x".repeat(80)}` : "another-owner",
					displayName: "其他 Owner",
					roles: ["employee"],
				},
			],
		},
	}),
);

async function fixture(page: Page, admin = true) {
	let status = 200;
	let secondStatus = 200;
	let empty = false;
	let malformed = false;
	let release: (() => void) | undefined;
	let pending: Promise<void> | undefined;
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
								? agents.slice(6)
								: agents.slice(0, 6),
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
	await page.goto("/admin/agents?q=owner-late&status=disabled&page=2");
	await expect(page.getByText("较后页文档助手", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("searchbox", { name: "搜索 Agent 或 Owner" }),
	).toHaveValue("owner-late");
	await expect(page.getByLabel("产品状态")).toHaveValue("disabled");
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
	await page.getByLabel("产品状态").selectOption("all");
	await expect(page.getByText("第 1 / 2 页")).toBeVisible();
	await page.getByRole("button", { name: "下一页" }).click();
	await expect(page).toHaveURL(/page=2/);
	await page.reload();
	await expect(page.getByText("第 2 / 2 页")).toBeVisible();
	await expect(page.getByText("较后页文档助手", { exact: true })).toBeVisible();
	expect(
		await page.getByRole("button", { name: /停用|重试创建|开始对话/ }).count(),
	).toBe(0);
	expect(await page.locator('main a[href*="/agents/"]').count()).toBe(0);
	expect(data.requests.every((request) => request.method === "GET")).toBe(true);
});

test("refresh second-page failure removes previous rows and retries the complete collection", async ({
	page,
}, info) => {
	const data = await fixture(page);
	await page.goto("/admin/agents");
	await expect(page.getByRole("table", { name: "已创建 Agent" })).toBeVisible();
	data.failSecond();
	await page.getByRole("button", { name: "刷新列表" }).click();
	await expect(page.getByRole("button", { name: "重新加载" })).toBeEnabled();
	await expect(page.getByRole("table")).toHaveCount(0);
	await capture(page, info, "admin-inventory-second-page-failed");
	data.recover();
	await page.getByRole("button", { name: "重新加载" }).click();
	await expect(page.getByRole("table", { name: "已创建 Agent" })).toBeVisible();
	data.deny();
	await page.getByRole("button", { name: "刷新列表" }).click();
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
	await expect(page.getByRole("button", { name: "刷新列表" })).toBeDisabled();
	data.resume();
	await expect(page.getByRole("table")).toBeVisible();
	await page.getByRole("searchbox").fill("不存在的项目");
	await expect(page.getByText("未找到匹配的 Agent。")).toBeVisible();
	await page.getByRole("button", { name: "清除筛选" }).click();
	data.empty();
	await page.getByRole("button", { name: "刷新列表" }).click();
	await expect(page.getByText("暂无已创建的 Agent。")).toBeVisible();
	await capture(page, info, "admin-inventory-empty");
	data.malform();
	await page.getByRole("button", { name: "刷新列表" }).click();
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
	await page.keyboard.type("owner-late");
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
