import { PersonalRelayKeyStateV1Schema } from "@agent-infra/contracts/pilot";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import {
	expectFocusableBusy,
	expectFocusHeld,
	expectFocusSettled,
	expectNoDuplicateControls,
	holdRequests,
	pinElement,
} from "./page-health";
import { expectCleanPage, trackPageErrors } from "./primitive-styles";

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

// #3242 K7-02：保存与撤销进行中按钮是可聚焦的禁用（aria-disabled），键盘 Enter 后挂起期间多次采样
// 焦点都在按钮上；保存后到「替换 Key」，撤销后到 Relay Key 输入框（D2-59、H4-27），写入失败后焦点
// 仍在按钮上，不落到 body。
async function acceptanceViewport(page: Page, info: TestInfo) {
	await page.setViewportSize(
		info.project.name === "mobile"
			? { width: 390, height: 844 }
			: { width: 1440, height: 900 },
	);
}

test("saving and revoking keep focus on the pending button and then follow D2-59 (K7-02)", async ({
	page,
}, info) => {
	await acceptanceViewport(page, info);
	const errors = trackPageErrors(page);
	await fixture(page, { initial: null });
	await page.goto("/my-settings/relay-key");
	const input = page.getByLabel("Relay Key", { exact: true });
	await expect(input).toBeEnabled();
	await input.fill(syntheticKey);
	const save = await pinElement(
		page.getByRole("button", { name: "保存 Key", exact: true }),
		"save-key",
	);
	const saving = await holdRequests(page, "PUT", "/api/v2/me/relay-key");
	await save.focus();
	await page.keyboard.press("Enter");
	await expect(save).toHaveText("保存中…");
	await expectFocusableBusy(save, "保存 Key");
	saving.release();
	await expect(save).toHaveText("替换 Key");
	await expectFocusSettled(save, "保存 Key");

	const revoke = await pinElement(
		page.getByRole("button", { name: "撤销 Key", exact: true }),
		"revoke-key",
	);
	const revoking = await holdRequests(page, "DELETE", "/api/v2/me/relay-key");
	await revoke.focus();
	await page.keyboard.press("Enter");
	await expect(revoke).toHaveText("撤销中…");
	await expectFocusableBusy(revoke, "撤销 Key");
	revoking.release();
	await expect(revoke).toHaveCount(0);
	await expectFocusSettled(input, "撤销 Key");
	await expectNoDuplicateControls(page, "个人 Relay Key（K7-02）");
	await expectCleanPage(page, errors);
});

test("a failed save keeps focus on the disabled button instead of body (K7-02)", async ({
	page,
}, info) => {
	await acceptanceViewport(page, info);
	const errors = trackPageErrors(page);
	await fixture(page, { writeStatus: 503 });
	await page.goto("/my-settings/relay-key");
	const input = page.getByLabel("Relay Key", { exact: true });
	await expect(input).toBeEnabled();
	await input.fill(syntheticKey);
	const save = await pinElement(
		page.getByRole("button", { name: "替换 Key", exact: true }),
		"replace-key",
	);
	const saving = await holdRequests(page, "PUT", "/api/v2/me/relay-key");
	await save.focus();
	await page.keyboard.press("Enter");
	await expectFocusableBusy(save, "替换 Key");
	saving.release();
	await expect(page.getByRole("alert")).toBeVisible();
	// 失败后表单保持禁用（需重新读取状态），按钮仍是可聚焦的禁用，焦点留在按钮上。
	await expect(input).toBeDisabled();
	await expect(save).toHaveAttribute("aria-disabled", "true");
	await expectFocusSettled(save, "替换 Key 失败");
	await expectCleanPage(page, errors);
});

// #3269 N8-3-02：「重新读取状态」开始即清除失败提示、按钮卸载，是 RecoveryButton：读取中与恢复后焦点在
// 页面 h1，仍失败时回到按钮，不落到 body。N8-3-08：状态未知（读取中、读取失败、写入被拒后清空投影）
// 时分区为中性标题「个人 Key」与说明，不按未设置写「接入个人 Key」。
test("rereading the status hands focus to the h1 and keeps a neutral section while the state is unknown (N8-3-02, N8-3-08)", async ({
	page,
}, info) => {
	await acceptanceViewport(page, info);
	const errors = trackPageErrors(page);
	await fixture(page);
	let failedReads = 1;
	let rejectWrite = false;
	const failure = (status: 403 | 503) => ({
		status,
		json: {
			schemaVersion: 1,
			code: status === 403 ? "AUTHORIZATION_REVOKED" : "DEPENDENCY_UNAVAILABLE",
			message: "Controlled relay key failure",
			retryable: status === 503,
			traceId: "trace-relay-key-reread",
		},
	});
	await page.route("**/api/v2/me/relay-key", (route) => {
		const method = route.request().method();
		if (method === "GET" && failedReads > 0) {
			failedReads -= 1;
			return route.fulfill(failure(503));
		}
		if (method === "PUT" && rejectWrite) return route.fulfill(failure(403));
		return route.fallback();
	});
	await page.goto("/my-settings/relay-key");
	const main = page.locator("#main-content");
	const heading = main.getByRole("heading", {
		level: 1,
		name: "个人 Relay Key",
	});
	const form = main.getByTestId("personal-relay-key-form");
	const title = form.getByRole("heading", { level: 2 });
	const neutral = form.getByText("读取当前状态后才能设置、替换或撤销。");
	const alert = form.getByRole("alert");
	await expect(alert).toContainText("个人 Key 服务暂时不可用");
	await expect(title).toHaveText("个人 Key");
	await expect(neutral).toBeVisible();
	await expect(main.getByTestId("personal-key-status")).toHaveCount(0);
	await expect(form.getByText("接入个人 Key")).toHaveCount(0);

	// 再次失败：读取中焦点在 h1，失败后回到重新出现的「重新读取状态」。
	failedReads = 1;
	const reread = form.getByRole("button", { name: "重新读取状态" });
	let reading = await holdRequests(page, "GET", "/api/v2/me/relay-key");
	await reread.focus();
	await page.keyboard.press("Enter");
	await expect(form.getByText("正在读取个人 Key 状态…")).toBeVisible();
	await expect(title).toHaveText("个人 Key");
	await expect(neutral).toBeVisible();
	await expectFocusHeld(heading, [30, 150, 400, 1000], "重新读取状态读取中");
	reading.release();
	await expect(alert).toBeVisible();
	await expectFocusSettled(reread, "重新读取状态仍失败");

	// 恢复：分区回到「替换个人 Key」，焦点留在 h1。
	reading = await holdRequests(page, "GET", "/api/v2/me/relay-key");
	await page.keyboard.press("Enter");
	await expectFocusHeld(heading, [30, 150, 400, 1000], "重新读取状态恢复中");
	reading.release();
	await expect(title).toHaveText("替换个人 Key");
	await expect(form.getByText("当前状态：已设置 · version 3")).toBeVisible();
	await expectFocusSettled(heading, "重新读取状态恢复后");

	// 写入被拒（403）：投影清空，分区不再显示已设置，也不推断为「接入个人 Key」。
	rejectWrite = true;
	await page.getByLabel("Relay Key", { exact: true }).fill(syntheticKey);
	await form.getByRole("button", { name: "替换 Key", exact: true }).click();
	await expect(alert).toContainText("当前账号没有设置个人 Relay Key 的权限。");
	await expect(title).toHaveText("个人 Key");
	await expect(neutral).toBeVisible();
	await expect(form.getByText("当前状态：已设置 · version 3")).toHaveCount(0);
	await expect(form.getByText("接入个人 Key")).toHaveCount(0);
	await expect(main.getByTestId("personal-key-status")).toHaveCount(0);
	await expectNoDuplicateControls(page, "个人 Relay Key（N8-3-02）");
	await expectCleanPage(page, errors);
});
