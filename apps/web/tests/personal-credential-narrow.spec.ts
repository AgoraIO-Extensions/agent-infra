import { pilotBrowserHttpOpenApiPathsV2 } from "@agent-infra/contracts/pilot";
import { expect, type Page, test } from "@playwright/test";
import type {
	PersonalApiCredentialMetadataV1,
	PersonalApiCredentialNarrowRequestV1,
} from "../src/pilot/generated-v2/types.gen";

const patch =
	pilotBrowserHttpOpenApiPathsV2["/api/v2/me/api-credentials/{credentialId}"]
		.patch;
const list = pilotBrowserHttpOpenApiPathsV2["/api/v2/me/api-credentials"].get;
const initial: PersonalApiCredentialMetadataV1 = {
	credentialId: "personal-browser-narrow",
	createdAt: "2026-10-01T00:00:00Z",
	expiresAt: null,
	lastUsedAt: null,
	revokedAt: null,
	scopes: ["agent:read", "agent:use"],
};

async function fixture(
	page: Page,
	options: {
		firstStatus?: 403 | 409 | 503;
		refreshFails?: boolean;
		staleReadback?: boolean;
	} = {},
) {
	let metadata = { ...initial };
	const requests: {
		body: PersonalApiCredentialNarrowRequestV1;
		key: string;
		origin?: string;
		authorization?: string;
	}[] = [];
	let release: () => void = () => undefined;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path === "/api/v1/session") {
			await route.fulfill({
				json: {
					schemaVersion: 1,
					user: {
						userId: "personal-credential-browser",
						displayName: "凭证管理员",
						roles: ["employee"],
					},
				},
			});
			return;
		}
		if (path === "/api/v2/me/api-credentials") {
			if (options.refreshFails && requests.length) {
				await route.fulfill({
					status: 503,
					json: {
						schemaVersion: 1,
						code: "DEPENDENCY_UNAVAILABLE",
						message: "Controlled refresh failure",
						retryable: true,
						traceId: "trace-credential-refresh",
					},
				});
				return;
			}
			const response = {
				items: [
					options.staleReadback && requests.length ? initial : metadata,
					{
						...initial,
						credentialId: "expired-browser",
						expiresAt: "2020-01-01T00:00:00Z",
					},
					{
						...initial,
						credentialId: "revoked-browser",
						revokedAt: "2026-10-01T00:00:00Z",
					},
				],
				nextCursor: null,
			};
			list.responses["200"].content["application/json"].schema.parse(response);
			await route.fulfill({ json: response });
			return;
		}
		if (
			path === `/api/v2/me/api-credentials/${initial.credentialId}` &&
			request.method() === "PATCH"
		) {
			const body: PersonalApiCredentialNarrowRequestV1 = request.postDataJSON();
			patch.requestBody.content["application/json"].schema.parse(body);
			const key = request.headers()["idempotency-key"];
			patch.requestParams.header.parse({ "Idempotency-Key": key });
			patch.requestParams.path.parse({ credentialId: initial.credentialId });
			requests.push({
				body,
				key,
				origin: request.headers().origin,
				authorization: request.headers().authorization,
			});
			if (options.firstStatus && requests.length === 1) {
				const error = {
					schemaVersion: 1,
					code:
						options.firstStatus === 403
							? "AUTHORIZATION_REVOKED"
							: options.firstStatus === 409
								? "INVALID_REQUEST"
								: "DEPENDENCY_UNAVAILABLE",
					message: "Controlled mutation rejection",
					retryable: options.firstStatus === 503,
					traceId: "trace-credential-narrow",
				};
				patch.responses[String(options.firstStatus) as "403"].content[
					"application/json"
				].schema.parse(error);
				await route.fulfill({ status: options.firstStatus, json: error });
				return;
			}
			await pending;
			metadata = { ...metadata, ...body };
			const response = { metadata, replayed: false };
			patch.responses["200"].content["application/json"].schema.parse(response);
			await route.fulfill({ json: response });
			return;
		}
		// Connection capability is optional and unrelated to personal API authorization.
		await route.fulfill({
			status: 404,
			json: {
				schemaVersion: 1,
				code: "RESOURCE_UNAVAILABLE",
				message: "Not part of credential fixture",
				retryable: false,
				traceId: "trace-credential-fixture",
			},
		});
	});
	return { requests, release };
}

async function openForm(page: Page) {
	await page.goto("/my-settings/api-credentials");
	await expect(
		page.getByRole("heading", { level: 1, name: "API 凭证" }),
	).toBeVisible();
	// R-02：个人凭证是表格；已撤销行的状态 chip 为「已撤销」，有效期列只写撤销时间（#2862）。
	const rows = page.getByRole("table", { name: "个人 API 凭证" });
	await expect(
		rows.locator('[data-slot="badge"]', { hasText: /^已过期$/ }),
	).toBeVisible();
	await expect(
		rows.locator('[data-slot="badge"]', { hasText: /^已撤销$/ }),
	).toBeVisible();
	// 已撤销行的有效期列只显示撤销时间（<time>），不提供详情或轮换（#2862）。
	const revokedExpiry = rows
		.locator("tr", {
			has: page.locator('[data-slot="badge"]', { hasText: /^已撤销$/ }),
		})
		.locator('td[data-label="有效期"]');
	await expect(revokedExpiry).toContainText(/^已撤销于 /);
	await expect(revokedExpiry.locator("time")).toHaveCount(1);
	// 收窄前的范围先可见，之后「不再出现」的断言才有意义。
	await expect(
		rows
			.locator(`tr[data-credential-id="${initial.credentialId}"]`)
			.getByText("agent:read · agent:use", { exact: true }),
	).toBeVisible();
	// 凭证时间按本地时区显示在 <time> 中，悬停为完整时间，不出现 ISO 原文。
	const times = rows.locator("time");
	expect(await times.count()).toBeGreaterThan(0);
	for (const time of await times.all())
		await expect(time).toHaveAttribute(
			"title",
			/^\d{4} 年 \d{1,2} 月 \d{1,2} 日 \d{2}:\d{2}:\d{2}$/,
		);
	await expect(rows).not.toContainText(/\d{4}-\d{2}-\d{2}T\d{2}:/);
	const action = rows.getByRole("button", { name: "收窄权限与有效期" });
	await expect(action).toHaveCount(1);
	await action.focus();
	await page.keyboard.press("Enter");
	const form = page.getByRole("form", {
		name: `收窄凭证 ${initial.credentialId}`,
	});
	await expect(
		form.getByRole("checkbox", { name: "读取 Agent" }),
	).toBeFocused();
	return { form, action };
}

async function capture(page: Page, name: string) {
	await page.evaluate(() => window.scrollTo(0, 0));
	const measured = await page.evaluate(() => ({
		viewport: { width: innerWidth, height: innerHeight },
		pageWidth: Math.max(
			document.documentElement.scrollWidth,
			document.body.scrollWidth,
		),
		controls: [
			...document.querySelectorAll(
				'form [data-slot="input"], form [data-slot="button"]',
			),
		]
			.map((element) => element.getBoundingClientRect().toJSON())
			.filter((rect) => rect.width > 0),
	}));
	expect(measured.pageWidth).toBeLessThanOrEqual(measured.viewport.width);
	for (const control of measured.controls) {
		expect(control.height).toBeGreaterThanOrEqual(44);
		expect(control.left).toBeGreaterThanOrEqual(0);
		expect(control.right).toBeLessThanOrEqual(measured.viewport.width);
	}
	await test.info().attach(`${name}-${test.info().project.name}-measurements`, {
		body: JSON.stringify(measured),
		contentType: "application/json",
	});
	await test.info().attach(`${name}-${test.info().project.name}`, {
		body: await page.screenshot({ fullPage: true }),
		contentType: "image/png",
	});
}

test("uses the SDK PATCH, retries the same request key and reads back narrowed metadata", async ({
	page,
}) => {
	const control = await fixture(page, { firstStatus: 503 });
	const { form, action } = await openForm(page);
	const useScope = form.getByRole("checkbox", { name: "使用 Agent" });
	await useScope.focus();
	await page.keyboard.press("Space");
	await expect(useScope).not.toBeChecked();
	const expiry = form.getByLabel("提前到期时间（可选）");
	await expiry.fill("2099-10-20T12:30");
	const save = form.getByRole("button", { name: "保存收窄" });
	await save.focus();
	await page.keyboard.press("Enter");
	await expect(form.getByRole("alert")).toContainText("收窄凭证失败");
	await expect(page.getByText("凭证已收窄，已读取最新元数据。")).toHaveCount(0);
	await capture(page, "credential-retry");
	await save.click();
	await expect(form.getByRole("button", { name: "正在保存…" })).toBeDisabled();
	await expect(expiry).toBeDisabled();
	await expect(form.getByRole("button", { name: "取消" })).toBeDisabled();
	await expect(action).toBeDisabled();
	control.release();
	await expect(page.getByText("凭证已收窄，已读取最新元数据。")).toBeVisible();
	await expect(action).toBeFocused();
	// 表格只显示缩写 ID，按行上的完整 ID 属性定位；范围列用「 · 」连接。
	const row = page.locator(`tr[data-credential-id="${initial.credentialId}"]`);
	await expect(row.getByText("agent:read", { exact: true })).toBeVisible();
	await expect(
		row.getByText("agent:read · agent:use", { exact: true }),
	).toHaveCount(0);
	await expect(row.getByText("永不过期")).toHaveCount(0);
	expect(control.requests).toHaveLength(2);
	expect(control.requests[0]).toEqual(control.requests[1]);
	expect(control.requests[0].body.scopes).toEqual(["agent:read"]);
	expect(control.requests[0].body.expiresAt).toBe(
		await page.evaluate(() => new Date("2099-10-20T12:30").toISOString()),
	);
	expect(control.requests[0].origin).toBe(new URL(page.url()).origin);
	expect(control.requests[0].authorization).toBeUndefined();
	await capture(page, "credential-narrowed");
	await page.reload();
	await expect(
		page
			.locator(`tr[data-credential-id="${initial.credentialId}"]`)
			.getByText("agent:read", { exact: true }),
	).toBeVisible();
	const stored = await page.evaluate(() =>
		JSON.stringify([
			Object.entries(localStorage),
			Object.entries(sessionStorage),
		]),
	);
	expect(stored).not.toContain(initial.credentialId);
	expect(stored).not.toContain("agent:read");
	expect(stored).not.toContain(control.requests[0].body.expiresAt);
});

test("associates empty scope and past expiry errors without sending a PATCH", async ({
	page,
}) => {
	const control = await fixture(page);
	const { form } = await openForm(page);
	await form.getByRole("checkbox", { name: "读取 Agent" }).uncheck();
	await form.getByRole("checkbox", { name: "使用 Agent" }).uncheck();
	await form.getByRole("button", { name: "保存收窄" }).click();
	const scopeError = form
		.getByRole("alert")
		.filter({ hasText: "至少保留一项当前权限。" });
	await expect(
		form.getByRole("checkbox", { name: "读取 Agent" }),
	).toHaveAttribute(
		"aria-describedby",
		(await scopeError.getAttribute("id")) ?? "",
	);
	await expect(
		form.getByRole("checkbox", { name: "读取 Agent" }),
	).toBeFocused();
	await form.getByRole("checkbox", { name: "读取 Agent" }).check();
	const expiry = form.getByLabel("提前到期时间（可选）");
	await expiry.fill("2020-01-01T00:00");
	await form.getByRole("button", { name: "保存收窄" }).click();
	await expect(expiry).toHaveAttribute("aria-invalid", "true");
	await expect(expiry).toBeFocused();
	expect(control.requests).toHaveLength(0);
	await capture(page, "credential-invalid-fields");
});

for (const status of [403, 409] as const) {
	test(`keeps server ${status} rejection visible without reporting success`, async ({
		page,
	}) => {
		const control = await fixture(page, { firstStatus: status });
		const { form } = await openForm(page);
		await form.getByRole("checkbox", { name: "使用 Agent" }).uncheck();
		await form.getByRole("button", { name: "保存收窄" }).click();
		await expect(form.getByRole("alert")).toContainText(
			status === 403 ? "当前账号无权修改" : "凭证状态已变化",
		);
		await expect(
			form.getByRole("button", { name: "重新加载凭证" }),
		).toBeEnabled();
		await expect(page.getByText("凭证已收窄，已读取最新元数据。")).toHaveCount(
			0,
		);
		expect(control.requests).toHaveLength(1);
		await capture(page, `credential-rejected-${status}`);
	});
}

test("offers metadata reload when PATCH succeeds but readback fails", async ({
	page,
}) => {
	const control = await fixture(page, { refreshFails: true });
	const { form } = await openForm(page);
	await form.getByRole("checkbox", { name: "使用 Agent" }).uncheck();
	control.release();
	await form.getByRole("button", { name: "保存收窄" }).click();
	await expect(
		page.getByRole("button", { name: "重新加载", exact: true }),
	).toBeVisible();
	await expect(page.getByText("凭证已收窄，已读取最新元数据。")).toHaveCount(0);
	await capture(page, "credential-refresh-failed");
});

test("does not announce success when metadata readback still has the old scopes", async ({
	page,
}) => {
	const control = await fixture(page, { staleReadback: true });
	const { form } = await openForm(page);
	await form.getByRole("checkbox", { name: "使用 Agent" }).uncheck();
	control.release();
	await form.getByRole("button", { name: "保存收窄" }).click();
	await expect(form.getByRole("alert")).toContainText("读取的元数据尚未同步");
	await expect(page.getByText("凭证已收窄，已读取最新元数据。")).toHaveCount(0);
	await capture(page, "credential-readback-stale");
});

// F-11：撤销是不可逆操作，先确认对象与后果，确认后恰好一次请求。
test("revocation is confirmed with the credential and its consequence before one request", async ({
	page,
}) => {
	await fixture(page);
	const revocations: string[] = [];
	await page.route(/\/api\/v2\/me\/api-credentials\/[^/]+$/, async (route) => {
		const request = route.request();
		if (request.method() !== "DELETE") return route.fallback();
		const credentialId = decodeURIComponent(
			new URL(request.url()).pathname.split("/").at(-1) ?? "",
		);
		revocations.push(credentialId);
		await route.fulfill({
			json: {
				metadata: { ...initial, revokedAt: "2026-10-02T00:00:00Z" },
				replayed: false,
			},
		});
	});
	await page.goto("/my-settings/api-credentials");
	const rows = page.getByRole("table", { name: "个人 API 凭证" });
	const trigger = rows.getByRole("button", {
		name: `撤销：${initial.credentialId}`,
		exact: true,
	});
	await expect(trigger).toBeVisible();
	// 每个撤销按钮的可访问名称都带凭证标识（R3/R1b、N-12「{可见文字}：{对象名}」）。
	await expect(
		rows.getByRole("button", { name: "撤销：expired-browser", exact: true }),
	).toBeVisible();
	await expect(
		rows.getByRole("button", { name: "撤销", exact: true }),
	).toHaveCount(0);
	// 默认状态下页面没有实心 danger 按钮。
	const solidDanger = () =>
		page.evaluate(() => {
			const probe = document.createElement("span");
			document.body.append(probe);
			const fills = ["var(--destructive)", "var(--danger-ink)"].map((value) => {
				probe.style.color = value;
				return getComputedStyle(probe).color;
			});
			probe.remove();
			return Array.from(
				document.querySelectorAll('#main-content [data-slot="button"]'),
			).filter((element) =>
				fills.includes(getComputedStyle(element).backgroundColor),
			).length;
		});
	expect(await solidDanger()).toBe(0);

	await trigger.click();
	const dialog = page.getByRole("dialog", { name: "撤销这张 API 凭证？" });
	await expect(dialog).toBeVisible();
	// V-20：凭证标识为等宽 700 短形式（与列表一致），完整值在 title；权限行 11px / 1.65 --muted-ink。
	const subject = dialog.locator("strong", { hasText: "personal…" });
	await expect(subject).toHaveText("personal…");
	await expect(subject).toHaveAttribute("title", initial.credentialId);
	await expect(subject).toHaveCSS("font-weight", "700");
	await expect(subject).toHaveCSS("font-family", /^ui-monospace/);
	const scopes = dialog.locator(".credential-revoke-scopes");
	await expect(scopes).toHaveText(/^权限：/);
	await expect(scopes).toHaveCSS("font-size", "11px");
	await expect(scopes).toHaveCSS("line-height", "18.15px");
	await expect(scopes).toHaveCSS(
		"color",
		await page.evaluate(() => {
			const probe = document.createElement("span");
			probe.style.color = "var(--muted-ink)";
			document.body.append(probe);
			const color = getComputedStyle(probe).color;
			probe.remove();
			return color;
		}),
	);
	await expect(dialog).toContainText("撤销后不能恢复");
	expect(revocations).toHaveLength(0);
	await dialog.getByRole("button", { name: "取消" }).click();
	await expect(dialog).not.toBeVisible();
	await trigger.click();
	await expect(dialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).not.toBeVisible();
	await trigger.click();
	await expect(dialog).toBeVisible();
	await page.mouse.click(4, 4);
	await expect(dialog).not.toBeVisible();
	expect(revocations).toHaveLength(0);

	await trigger.click();
	await dialog.getByRole("button", { name: "撤销凭证", exact: true }).click();
	await expect(dialog).not.toBeVisible();
	await expect.poll(() => revocations).toEqual([initial.credentialId]);
	await expect
		.poll(() => page.evaluate(() => document.activeElement === document.body))
		.toBe(false);
	await capture(page, "credential-revoke-confirmed");
});

// R-02：页头、notice 与 credential-table；窄屏按 X-07 转为行卡片。
test("lays out the API credential page head, notice and credential table", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "desktop", "Sets its own viewports.");
	await fixture(page);
	const writes: string[] = [];
	page.on("request", (request) => {
		if (request.method() !== "GET") writes.push(request.url());
	});
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/my-settings/api-credentials");
	const main = page.locator("#main-content");
	await expect(main.getByRole("heading", { level: 1 })).toHaveCount(1);
	await expect(
		main.getByRole("heading", { level: 1, name: "API 凭证" }),
	).toBeVisible();
	await expect(main.locator(".page-eyebrow")).toHaveText("我的管理 / API 凭证");
	await expect(main).not.toContainText(/安全设置|userId/);
	const notice = main.locator('[data-slot="alert"]', {
		hasText: "凭证值不会回显",
	});
	await expect(notice).not.toHaveAttribute("role");
	await expect(notice).toContainText(
		"本页只展示元数据；发放、轮换和接收者授权由服务端校验。",
	);
	const table = main.getByRole("table", { name: "个人 API 凭证" });
	await expect(table).toBeVisible();
	const surface = main.locator("section.settings-surface", {
		has: page.locator("table.credential-table"),
	});
	await expect(surface).toHaveCSS("border-top-left-radius", "14px");
	await expect(surface).toHaveCSS("padding-top", "20px");
	await expect(table.locator("thead th")).toHaveText([
		"名称",
		"主体",
		"范围",
		"状态",
		"有效期",
		"操作",
	]);
	await expect(
		table.locator("thead th").last().locator(".sr-only"),
	).toHaveCount(1);
	const cell = table.locator("tbody td").first();
	await expect(cell).toHaveCSS("padding", "12px 14px");
	await expect(cell).toHaveCSS("font-size", "12px");
	await expect(cell).toHaveCSS("border-bottom-width", "1px");
	await expect(cell.locator("small")).toHaveCSS("font-size", "11px");
	await expect(table).not.toContainText(initial.credentialId);
	const tone = (text: string) =>
		table
			.locator('[data-slot="badge"]', { hasText: new RegExp(`^${text}$`) })
			.getAttribute("data-tone");
	expect(await tone("有效")).toBe("green");
	expect(await tone("已过期")).toBe("amber");
	expect(await tone("已撤销")).toBe("red");
	await expect(table.getByText("永不过期")).toBeVisible();
	await expect(
		main.getByRole("button", { name: /^(轮换|查看详情)/ }),
	).toHaveCount(0);

	// 页头的「创建应用凭证」只做页内跳转。
	const create = main.getByRole("button", { name: "创建应用凭证" });
	const head = await main.locator(".page-heading > div").first().boundingBox();
	const createBox = await create.boundingBox();
	expect(
		Math.abs(
			(head?.y ?? 0) +
				(head?.height ?? 0) -
				((createBox?.y ?? 0) + (createBox?.height ?? 0)),
		),
	).toBeLessThanOrEqual(2);
	await create.press("Enter");
	const applications = main.getByRole("heading", {
		level: 2,
		name: "应用管理",
	});
	await expect(applications).toBeFocused();
	await expect(applications).toBeInViewport();
	expect(writes).toEqual([]);

	// 窄屏行卡片：隐藏表头，左侧显示列名，页面不横向滚动。
	for (const [width, height] of [
		[390, 844],
		[360, 640],
		[320, 568],
	] as const) {
		await page.setViewportSize({ width, height });
		await expect(table.locator("thead")).toHaveCSS("display", "none");
		const narrow = await page.evaluate(() => {
			const cell = document.querySelector<HTMLElement>(
				".credential-table tbody td",
			);
			const before = cell ? getComputedStyle(cell, "::before") : null;
			const actions = [
				...document.querySelectorAll<HTMLElement>(
					".credential-table [data-slot='button']",
				),
			].map((button) => button.getBoundingClientRect().toJSON());
			return {
				fits: document.documentElement.scrollWidth <= innerWidth,
				label: before?.content,
				labelSize: before?.fontSize,
				actionsInside: actions.every(
					(rect) => rect.left >= 0 && rect.right <= innerWidth,
				),
			};
		});
		expect(narrow).toEqual({
			fits: true,
			label: '"名称"',
			labelSize: "11px",
			actionsInside: true,
		});
	}
});
