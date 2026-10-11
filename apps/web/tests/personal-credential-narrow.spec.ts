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
		page.getByRole("heading", { name: "个人 API 凭证" }),
	).toBeVisible();
	const rows = page.getByRole("list", { name: "个人 API 凭证列表" });
	await expect(rows.getByText("已过期", { exact: true })).toBeVisible();
	await expect(rows.getByText("已撤销", { exact: true })).toBeVisible();
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
	const row = page
		.getByRole("listitem")
		.filter({ hasText: initial.credentialId });
	await expect(row.getByText("agent:read", { exact: true })).toBeVisible();
	await expect(
		row.getByText("agent:read、agent:use", { exact: true }),
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
			.getByRole("listitem")
			.filter({ hasText: initial.credentialId })
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
