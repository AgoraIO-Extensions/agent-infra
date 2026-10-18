import { PersonalRelayKeyStateV1Schema } from "@agent-infra/contracts/pilot";
import { expect, type Page, test } from "@playwright/test";

// 个人 Relay Key 页（R-01、RK-01、RK-02 与防回归 NI-39、NI-78）。
const syntheticKey = "synthetic-relay-key-0123456789";

async function fixture(
	page: Page,
	options: { initial?: number | null; writeStatus?: 409 | 503 } = {},
) {
	let keyVersion: number | null =
		options.initial === undefined ? 3 : options.initial;
	const writes: { method: string; body: unknown }[] = [];
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path === "/api/v1/session")
			return route.fulfill({
				json: {
					schemaVersion: 1,
					user: {
						userId: "relay-key-browser",
						displayName: "个人 Key 用户",
						roles: ["employee"],
					},
				},
			});
		if (path === "/api/v2/me/relay-key") {
			if (request.method() !== "GET") {
				writes.push({ method: request.method(), body: request.postDataJSON() });
				if (options.writeStatus)
					return route.fulfill({
						status: options.writeStatus,
						json: {
							schemaVersion: 1,
							code:
								options.writeStatus === 409
									? "INVALID_REQUEST"
									: "DEPENDENCY_UNAVAILABLE",
							message: "Controlled relay key failure",
							retryable: options.writeStatus === 503,
							traceId: "trace-relay-key",
						},
					});
				keyVersion =
					request.method() === "DELETE" ? null : (keyVersion ?? 0) + 1;
			}
			return route.fulfill({
				json: PersonalRelayKeyStateV1Schema.parse({
					schemaVersion: 1,
					isSet: keyVersion !== null,
					keyVersion,
				}),
			});
		}
		return route.fulfill({
			status: 404,
			json: {
				schemaVersion: 1,
				code: "RESOURCE_UNAVAILABLE",
				message: "Not part of relay key fixture",
				retryable: false,
				traceId: "trace-relay-key-fixture",
			},
		});
	});
	return { writes };
}

function danger(page: Page) {
	return page.evaluate(() => {
		const probe = document.createElement("span");
		probe.style.backgroundColor = "var(--danger-ink)";
		probe.style.color = "var(--surface)";
		document.body.append(probe);
		const style = getComputedStyle(probe);
		const colors = { background: style.backgroundColor, text: style.color };
		probe.remove();
		return colors;
	});
}

test("matches the design structure in the standard content area at 1440", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "desktop", "Sets its own viewport.");
	await fixture(page);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/my-settings/relay-key");
	const main = page.locator("#main-content");
	await expect(
		main.getByRole("heading", { level: 1, name: "个人 Relay Key" }),
	).toBeVisible();
	await expect(main.locator(".page-eyebrow")).toHaveText("我的管理 / 个人凭证");
	const status = main.getByTestId("personal-key-status");
	await expect(status).toHaveText("已设置");
	await expect(status).toHaveAttribute("data-tone", "green");
	const notice = main.locator('[data-slot="alert"]', {
		hasText: "费用和权限跟随个人 Key",
	});
	await expect(notice).not.toHaveAttribute("role");
	await expect(notice).not.toHaveAttribute("aria-live");
	await expect(notice.locator("svg[aria-hidden='true']")).toHaveCount(1);
	const form = main.getByTestId("personal-relay-key-form");
	await expect(form).toHaveCSS("border-top-left-radius", "14px");
	await expect(form).toHaveCSS("padding-top", "20px");
	await expect(
		form.getByRole("heading", { level: 2, name: "替换个人 Key" }),
	).toBeVisible();
	await expect(form.getByText("当前状态：已设置 · version 3")).toBeVisible();
	// 页头、notice 与分区与其他管理页共用 1240px 内容区，不再是 672px 居中窄栏。
	for (const locator of [main.locator(".page-heading"), notice, form]) {
		const box = await locator.boundingBox();
		expect(Math.round(box?.x ?? 0)).toBeGreaterThanOrEqual(289);
		expect(Math.round(box?.x ?? 0)).toBeLessThanOrEqual(291);
		expect(
			Math.round((box?.x ?? 0) + (box?.width ?? 0)),
		).toBeGreaterThanOrEqual(1397);
		expect(Math.round((box?.x ?? 0) + (box?.width ?? 0))).toBeLessThanOrEqual(
			1399,
		);
	}
	const input = form.getByLabel("Relay Key", { exact: true });
	await expect(input).toHaveAttribute("type", "password");
	await expect(input).toHaveAttribute("placeholder", "仅本次提交使用");
	await expect(input).toHaveAttribute("autocomplete", "new-password");
	const buttons = form.locator('[data-slot="button"]');
	await expect(buttons).toHaveText(["替换 Key", "撤销 Key"]);
	const colors = await danger(page);
	const revoke = form.getByRole("button", { name: "撤销 Key" });
	await expect(revoke).toHaveCSS("background-color", colors.background);
	await expect(revoke).toHaveCSS("color", colors.text);
	const formBox = await form.boundingBox();
	const replaceBox = await buttons.first().boundingBox();
	expect((replaceBox?.x ?? 0) - (formBox?.x ?? 0)).toBeLessThanOrEqual(22);
	for (const button of await buttons.all())
		expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
	const cards = main.locator(".roadmap-card");
	await expect(cards.locator("h3")).toHaveText([
		"缺少 Key",
		"Key 失效",
		"额度不足",
		"模型无权限",
	]);
	const firstTwo = await Promise.all(
		[0, 1].map((index) => cards.nth(index).boundingBox()),
	);
	expect(firstTwo[0]?.y).toBe(firstTwo[1]?.y);
	await expect(main).not.toContainText(/已配置 · 版本|尚未读取|移除/);
});

test("saves, revokes and announces each result with a self-dismissing toast", async ({
	page,
}) => {
	const control = await fixture(page, { initial: null });
	await page.goto("/my-settings/relay-key");
	const main = page.locator("#main-content");
	const form = main.getByTestId("personal-relay-key-form");
	await expect(main.getByTestId("personal-key-status")).toHaveText("未设置");
	await expect(
		form.getByRole("heading", { level: 2, name: "接入个人 Key" }),
	).toBeVisible();
	await expect(form.getByText("待设置", { exact: true })).toBeVisible();
	await expect(form.getByRole("button", { name: "撤销 Key" })).toHaveCount(0);
	const input = form.getByLabel("Relay Key", { exact: true });

	await input.fill("too-short");
	await form.getByRole("button", { name: "保存 Key" }).click();
	await expect(form.getByRole("alert")).toHaveText(
		"请输入 16–8192 位 ASCII 可见字符，不含空格的个人 Relay Key。",
	);
	expect(control.writes).toHaveLength(0);

	await input.fill(syntheticKey);
	await form.getByRole("button", { name: "保存 Key" }).click();
	const toast = page.locator('[data-slot="toast"]');
	await expect(toast).toHaveText("个人 Relay Key 已保存，页面不会显示值");
	await expect(toast).toHaveAttribute("role", "status");
	await expect(toast).toHaveAttribute("aria-live", "polite");
	await expect(toast).not.toHaveAttribute("tabindex");
	await expect(main.getByTestId("personal-key-status")).toHaveText("已设置");
	await expect(input).toHaveValue("");
	await expect(form.getByRole("button", { name: "替换 Key" })).toBeFocused();
	expect(
		await page.evaluate(() =>
			Boolean(document.activeElement?.closest('[data-slot="toast"]')),
		),
	).toBe(false);
	await expect(toast).toHaveAttribute("data-state", "closed", {
		timeout: 4000,
	});
	expect(await page.content()).not.toContain(syntheticKey);

	await form.getByRole("button", { name: "撤销 Key" }).click();
	await expect(toast).toHaveText("个人 Relay Key 已撤销");
	await expect(main.getByTestId("personal-key-status")).toHaveText("未设置");
	await expect(
		form.getByRole("heading", { level: 2, name: "接入个人 Key" }),
	).toBeVisible();
	await expect(form.getByRole("button", { name: "撤销 Key" })).toHaveCount(0);
	await expect(input).toBeFocused();
	expect(control.writes.map((write) => write.method)).toEqual([
		"PUT",
		"DELETE",
	]);
	expect(control.writes[0]?.body).toEqual({
		expectedVersion: null,
		keyValue: syntheticKey,
	});
	expect(control.writes[1]?.body).toEqual({ expectedVersion: 1 });
	await expect(main).not.toContainText(/移除 Key|已移除|正在移除/);
});

for (const status of [409, 503] as const) {
	test(`keeps a ${status} write failure in the section with a reread action`, async ({
		page,
	}) => {
		await fixture(page, { writeStatus: status });
		await page.goto("/my-settings/relay-key");
		const form = page.getByTestId("personal-relay-key-form");
		await form.getByLabel("Relay Key", { exact: true }).fill(syntheticKey);
		await form.getByRole("button", { name: "替换 Key" }).click();
		await expect(form.getByRole("alert")).toContainText(
			status === 409 ? "已被其他请求更新" : "暂时不可用",
		);
		const reread = form.getByRole("button", { name: "重新读取状态" });
		await expect(reread).toBeVisible();
		expect((await reread.boundingBox())?.height).toBeGreaterThanOrEqual(44);
		await expect(page.locator('[data-slot="toast"]')).toHaveText("");
	});
}

test("stays within narrow viewports with stacked cards", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "mobile", "Narrow layout only.");
	await fixture(page);
	await page.goto("/my-settings/relay-key");
	await expect(page.getByTestId("personal-key-status")).toHaveText("已设置");
	for (const [width, height] of [
		[390, 844],
		[320, 568],
	] as const) {
		await page.setViewportSize({ width, height });
		const layout = await page.evaluate(() => {
			const cards = [...document.querySelectorAll(".roadmap-card")].map(
				(card) => card.getBoundingClientRect().x,
			);
			return {
				fits: document.documentElement.scrollWidth <= innerWidth,
				oneColumn: new Set(cards.map(Math.round)).size === 1,
			};
		});
		expect(layout).toEqual({ fits: true, oneColumn: true });
		const buttons = page
			.getByTestId("personal-relay-key-form")
			.locator('[data-slot="button"]');
		await expect(buttons).toHaveText(["替换 Key", "撤销 Key"]);
		const formBox = await page
			.getByTestId("personal-relay-key-form")
			.boundingBox();
		const firstButton = await buttons.first().boundingBox();
		expect((firstButton?.x ?? 0) - (formBox?.x ?? 0)).toBeLessThanOrEqual(22);
	}
});
