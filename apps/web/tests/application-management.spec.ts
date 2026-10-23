import {
	ApplicationApiCredentialResponseV1Schema,
	ApplicationMetadataV1Schema,
} from "@agent-infra/contracts/pilot";
import { expect, type Page, test } from "@playwright/test";
import { directorySearchResponse } from "../src/features/directory-test-fixtures";
import {
	expectFocusableBusy,
	expectFocusSettled,
	expectNoDuplicateControls,
	holdRequests,
	pinElement,
} from "./page-health";
import { duplicateControlNames } from "./page-hygiene";
import { expectCleanPage, trackPageErrors } from "./primitive-styles";

const application = ApplicationMetadataV1Schema.parse({
	applicationId: "application-browser-1",
	authorizationRevision: "application-revision-1",
	createdAt: "2026-10-10T00:00:00Z",
	name: "Browser build service",
	responsibleUserId: "browser-owner-1",
	status: "active",
	updatedAt: "2026-10-10T00:00:00Z",
});

const credential = ApplicationApiCredentialResponseV1Schema.parse({
	metadata: {
		applicationId: application.applicationId,
		credentialId: `credential-${"browser-id-".repeat(12)}`,
		createdAt: "2026-10-10T00:00:00Z",
		expiresAt: null,
		lastUsedAt: null,
		revokedAt: null,
		scopes: ["agent:read"],
	},
	delivery: {
		attemptId: "application-delivery-1",
		grantRevision: "recipient-grant-1",
		recipient: { principalType: "user", principalId: "browser-recipient-1" },
		status: "unknown",
	},
	replayed: false,
});

async function fixture(page: Page) {
	const commands: {
		applicationId: string;
		body: unknown;
		key: string | undefined;
	}[] = [];
	let nextGate: Promise<void> | undefined;
	let release: (() => void) | undefined;
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path === "/api/v1/session")
			return route.fulfill({
				json: {
					schemaVersion: 1,
					user: {
						userId: "browser-owner-1",
						displayName: "应用负责人",
						roles: ["employee"],
					},
				},
			});
		if (path === "/api/v1/connection/capability")
			return route.fulfill({
				json: { schemaVersion: 1, status: "unavailable", reason: "missing" },
			});
		if (path === "/api/v2/me/api-credentials")
			return route.fulfill({ json: { items: [], nextCursor: null } });
		if (path === "/api/v2/directory/search") {
			const ids =
				new URL(request.url()).searchParams.get("ids")?.split(",") ?? [];
			return route.fulfill({
				json: directorySearchResponse(
					new URL(request.url()),
					[
						{
							kind: "user",
							canonicalId: application.responsibleUserId,
							displayName: "应用负责人",
							email: "app.owner@example.test",
						},
						{
							kind: "user",
							canonicalId: credential.delivery.recipient.principalId,
							displayName: "凭证接收人",
							email: "recipient@example.test",
						},
					].filter((item) => ids.includes(item.canonicalId)),
				),
			});
		}
		const match = /^\/api\/v2\/applications\/([^/]+)(\/credentials)?$/.exec(
			path,
		);
		if (match) {
			const applicationId = decodeURIComponent(match[1] ?? "");
			if (match[2] && request.method() === "POST") {
				commands.push({
					applicationId,
					body: request.postDataJSON(),
					key: request.headers()["idempotency-key"],
				});
				await nextGate;
				nextGate = undefined;
				return route.fulfill({
					status: 201,
					json: {
						...credential,
						metadata: { ...credential.metadata, applicationId },
					},
				});
			}
			if (
				applicationId === "application-missing" ||
				applicationId === "application-denied"
			)
				return route.fulfill({
					status: applicationId === "application-missing" ? 404 : 403,
					json: {
						schemaVersion: 1,
						code: "RESOURCE_UNAVAILABLE",
						message: "Application unavailable",
						retryable: false,
						traceId: "browser-unavailable",
					},
				});
			return route.fulfill({
				json: {
					...application,
					applicationId,
					name:
						applicationId === application.applicationId
							? application.name
							: "Browser second service",
				},
			});
		}
		throw new Error(`Unexpected fixture request: ${request.method()} ${path}`);
	});
	return {
		commands,
		pauseCredential() {
			nextGate = new Promise<void>((resolve) => {
				release = resolve;
			});
		},
		releaseCredential() {
			release?.();
		},
	};
}

async function submitCredential(page: Page) {
	await page.getByLabel("接收主体 ID").fill("browser-recipient-1");
	await page.getByRole("button", { name: "签发应用凭证" }).click();
}

test("opens existing applications with keyboard, refresh and back preserving the URL scope", async ({
	page,
}) => {
	const api = await fixture(page);
	await page.goto("/my-settings/api-credentials");
	const input = page.getByLabel("既有应用 ID");
	await input.fill(application.applicationId);
	await input.press("Enter");
	await expect(page).toHaveURL(
		new RegExp(`applicationId=${application.applicationId}`),
	);
	await expect(
		page.getByRole("heading", { name: application.name }),
	).toBeVisible();
	await page.reload();
	await expect(
		page.getByRole("heading", { name: application.name }),
	).toBeVisible();
	await page.getByLabel("既有应用 ID").fill("application-browser-2");
	await page.getByLabel("既有应用 ID").press("Enter");
	await expect(
		page.getByRole("heading", { name: "Browser second service" }),
	).toBeVisible();
	await page.goBack();
	await expect(page).toHaveURL(
		new RegExp(`applicationId=${application.applicationId}`),
	);
	await expect(
		page.getByRole("heading", { name: application.name }),
	).toBeVisible();
	expect(api.commands).toHaveLength(0);
});

test("retains unknown delivery metadata, prepares rotation and wraps 390px results", async ({
	page,
}, info) => {
	const api = await fixture(page);
	await page.goto(
		`/my-settings/api-credentials?applicationId=${application.applicationId}`,
	);
	// 负责人与接收用户显示目录姓名，时间按本地时区显示且悬停为完整时间。
	await expect(
		page.locator("dt", { hasText: "负责人" }).locator("+ dd"),
	).toHaveText("应用负责人");
	const created = page.locator(`time[datetime="${application.createdAt}"]`);
	await expect(created.first()).toHaveAttribute(
		"title",
		/^\d{4} 年 \d{1,2} 月 \d{1,2} 日 \d{2}:\d{2}:\d{2}$/,
	);
	await expect(page.locator("main")).not.toContainText(application.createdAt);
	await submitCredential(page);
	await expect(page.getByText("投递结果未知", { exact: true })).toBeVisible();
	await expect(
		page.getByText(credential.metadata.credentialId, { exact: true }),
	).toBeVisible();
	await expect(
		page.locator("dt", { hasText: "接收者" }).locator("+ dd"),
	).toHaveText("用户 · 凭证接收人");
	await expect(page.locator("main")).not.toContainText(
		application.responsibleUserId,
	);
	await expect(page.locator("main")).not.toContainText(
		credential.delivery.recipient.principalId,
	);
	await expect(
		page.getByText(credential.delivery.attemptId, { exact: true }),
	).toBeVisible();
	await expect(page.getByText(/页面不会自动重发/)).toBeVisible();
	expect(api.commands).toHaveLength(1);
	const rotate = page.getByRole("button", { name: "使用此凭证 ID 轮换" });
	await rotate.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByLabel("要轮换的凭证 ID")).toHaveValue(
		credential.metadata.credentialId,
	);
	expect(api.commands).toHaveLength(1);
	for (const width of [1440, 390]) {
		await page.setViewportSize({ width, height: 844 });
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		const result = page.getByRole("region", { name: "应用凭证结果" });
		await info.attach(`application-metadata-${width}px`, {
			body: await result.screenshot(),
			contentType: "image/png",
		});
	}
	await page.getByRole("button", { name: "轮换应用凭证" }).click();
	await expect(page.getByText("投递结果未知", { exact: true })).toBeVisible();
	expect(api.commands).toHaveLength(2);
	expect(api.commands[1]?.body).toMatchObject({
		operation: "rotate",
		credentialId: credential.metadata.credentialId,
		recipient: credential.delivery.recipient,
	});
	expect(api.commands[1]?.key).not.toBe(api.commands[0]?.key);
});

test("navigation rejects late credential success and removes another application's metadata", async ({
	page,
}) => {
	const api = await fixture(page);
	await page.goto(
		`/my-settings/api-credentials?applicationId=${application.applicationId}`,
	);
	api.pauseCredential();
	await submitCredential(page);
	await expect.poll(() => api.commands.length).toBe(1);
	await page.goto(
		"/my-settings/api-credentials?applicationId=application-browser-2",
	);
	await expect(
		page.getByRole("heading", { name: "Browser second service" }),
	).toBeVisible();
	api.releaseCredential();
	await expect(page.getByRole("region", { name: "应用凭证结果" })).toHaveCount(
		0,
	);
	await expect(
		page.getByText(credential.metadata.credentialId, { exact: true }),
	).toHaveCount(0);
	await page.goto(
		`/my-settings/api-credentials?applicationId=${application.applicationId}`,
	);
	await expect(page.getByRole("region", { name: "应用凭证结果" })).toHaveCount(
		0,
	);
	await submitCredential(page);
	await expect(
		page.getByText(credential.metadata.credentialId, { exact: true }),
	).toBeVisible();
	await page.goto(
		"/my-settings/api-credentials?applicationId=application-denied",
	);
	await expect(
		page.getByText("当前账号无权管理应用。", { exact: true }),
	).toBeVisible();
	await expect(page.getByRole("region", { name: "应用凭证结果" })).toHaveCount(
		0,
	);
	await expect(page.getByRole("button", { name: "注册应用" })).toHaveCount(0);
});

test("missing existing applications show an opaque denial instead of registration", async ({
	page,
}) => {
	await fixture(page);
	await page.goto(
		"/my-settings/api-credentials?applicationId=application-missing",
	);
	await expect(
		page.getByText("找不到这个应用，或当前账号不是负责人。", { exact: true }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "注册应用" })).toHaveCount(0);
});

// F-11：停用应用先确认对象与后果，确认后恰好一次请求，焦点落在应用名标题。
test("disabling an application is confirmed before one PATCH and returns focus to its title", async ({
	page,
}) => {
	await fixture(page);
	const disables: unknown[] = [];
	let disabled = false;
	await page.route(/\/api\/v2\/applications\/[^/]+$/, async (route) => {
		const request = route.request();
		if (request.method() === "PATCH") {
			disables.push(request.postDataJSON());
			disabled = true;
			return route.fulfill({ json: { ...application, status: "disabled" } });
		}
		if (disabled)
			return route.fulfill({ json: { ...application, status: "disabled" } });
		return route.fallback();
	});
	await page.goto(
		`/my-settings/api-credentials?applicationId=${application.applicationId}`,
	);
	const trigger = page.getByRole("button", {
		name: `停用应用：${application.name}`,
		exact: true,
	});
	await expect(trigger).toBeVisible();
	await trigger.click();
	const dialog = page.getByRole("dialog", { name: "停用这个应用？" });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(application.name);
	await expect(dialog).toContainText("拒绝该应用的新任务");
	expect(disables).toHaveLength(0);
	await dialog.getByRole("button", { name: "取消" }).click();
	await expect(dialog).not.toBeVisible();
	await trigger.click();
	await page.keyboard.press("Escape");
	await expect(dialog).not.toBeVisible();
	expect(disables).toHaveLength(0);
	await trigger.click();
	await dialog.getByRole("button", { name: "停用应用", exact: true }).click();
	await expect.poll(() => disables).toEqual([{ status: "disabled" }]);
	await expect(page.getByText("应用已停用")).toBeVisible();
	await expect(
		page.getByRole("heading", { name: application.name }),
	).toBeFocused();
});

// #2830 终验 V-21–V-23：应用摘要为 dl.facts 两列事实行（标签列 150px、13px），应用名与
// 「应用凭证元数据」为 17px / 650 / 1.4，说明与「应用 ID」13px，「停用应用」不带图标。
test("application summary follows the design facts, headings and plain disable button (V-21, V-22, V-23)", async ({
	page,
}, info) => {
	const mobile = info.project.name === "mobile";
	const errors = trackPageErrors(page);
	await fixture(page);
	await page.goto(
		`/my-settings/api-credentials?applicationId=${application.applicationId}`,
	);
	const name = page.getByRole("heading", { name: application.name });
	await expect(name).toBeVisible();
	if (!mobile) await page.setViewportSize({ width: 1440, height: 900 });
	for (const heading of [
		name,
		page.getByRole("heading", { name: "应用凭证元数据" }),
	]) {
		await expect(heading).toHaveCSS("font-size", "17px");
		await expect(heading).toHaveCSS("font-weight", "650");
		await expect(heading).toHaveCSS("line-height", "23.8px");
	}
	await expect(page.getByText(/^应用 ID：/)).toHaveCSS("font-size", "13px");
	await expect(page.getByText(/^当前接口只返回元数据/)).toHaveCSS(
		"font-size",
		"13px",
	);
	const facts = page.locator("dl.application-facts");
	await expect(facts.locator("dt")).toHaveText([
		"负责人",
		"创建时间",
		"更新时间",
	]);
	await expect(facts).toHaveCSS("font-size", "13px");
	await expect(facts.locator("dd").first()).toHaveCSS("line-height", "21.45px");
	const columns = await facts.evaluate(
		(element) =>
			getComputedStyle(element).gridTemplateColumns.split(" ").length,
	);
	if (mobile) expect(columns).toBe(1);
	else {
		expect(
			await facts.evaluate(
				(element) =>
					getComputedStyle(element).gridTemplateColumns.split(" ")[0],
			),
		).toBe("150px");
		// 两列事实行：dt 与 dd 在同一行。
		const [dt, dd] = await Promise.all([
			facts.locator("dt").first().boundingBox(),
			facts.locator("dd").first().boundingBox(),
		]);
		expect(Math.abs((dt?.y ?? 0) - (dd?.y ?? 0))).toBeLessThanOrEqual(1);
	}
	const disable = page.getByRole("button", {
		name: `停用应用：${application.name}`,
	});
	await expect(disable.locator("svg")).toHaveCount(0);
	await expect(disable).toHaveCSS("border-top-width", "1px");
	// AC-2：同一页面没有同名按钮或链接，没有控制台错误与横向溢出。个人凭证与应用凭证的权限
	// 复选框选项相同，各自在「权限范围：个人凭证 / 应用凭证」命名分组内，由分组名区分。
	expect(await duplicateControlNames(page)).toEqual([]);
	for (const group of ["权限范围：个人凭证", "权限范围：应用凭证"])
		await expect(
			page.getByRole("group", { name: group, exact: true }),
		).toHaveCount(1);
	// E3-16：打开既有应用后，应用凭证表单的权限复选框名称带应用名（同 C2-19），与签发个人凭证区
	// 的同名复选框区分；整页（含复选框）没有同名控件。
	for (const label of [
		"读取 Agent",
		"使用 Agent",
		"管理 Agent",
		"创建 Agent",
	]) {
		await expect(
			page
				.getByRole("group", { name: "权限范围：应用凭证", exact: true })
				.getByRole("checkbox", {
					name: `${label}：${application.name}`,
					exact: true,
				}),
		).toHaveCount(1);
		await expect(
			page.getByRole("checkbox", { name: label, exact: true }),
		).toHaveCount(1);
	}
	await expectNoDuplicateControls(page, "API 凭证（打开既有应用）");
	await expectCleanPage(page, errors);
});

// #3179 G4-26：签发 / 轮换应用凭证提交后，按钮在提交中用 aria-disabled 保持焦点，结果出现后焦点交给
// 「应用凭证结果」标题；全程不落到 body。键盘 Enter 与点击两种方式都覆盖，两个视口都运行。
for (const mode of ["keyboard", "click"] as const)
	test(`issuing an application credential by ${mode} keeps focus off the body (G4-26)`, async ({
		page,
	}, info) => {
		const errors = trackPageErrors(page);
		await page.setViewportSize(
			info.project.name === "mobile"
				? { width: 390, height: 844 }
				: { width: 1440, height: 900 },
		);
		const api = await fixture(page);
		await page.goto(
			`/my-settings/api-credentials?applicationId=${application.applicationId}`,
		);
		await page.getByLabel("接收主体 ID").fill("browser-recipient-1");
		const activeElement = () =>
			page.evaluate(() => {
				const active = document.activeElement;
				return !active || active === document.body
					? "body"
					: `${active.tagName.toLowerCase()}:${active.textContent?.trim()}`;
			});
		const submit = async (name: string) => {
			const button = page.getByRole("button", { name, exact: true });
			api.pauseCredential();
			if (mode === "keyboard") {
				await button.focus();
				await page.keyboard.press("Enter");
			} else await button.click();
			// 提交中：按钮改为「正在提交…」，aria-disabled 仍可聚焦，焦点留在按钮上。
			const pending = page.getByRole("button", {
				name: "正在提交…",
				exact: true,
			});
			await expect(pending).toBeFocused();
			await expect(pending).toHaveAttribute("aria-disabled", "true");
			// 提交中再按 Enter 不会发出第二个请求。
			await page.keyboard.press("Enter");
			api.releaseCredential();
			const heading = page
				.getByRole("region", { name: "应用凭证结果" })
				.getByRole("heading", { name: "应用凭证结果" });
			await expect(heading).toBeFocused();
			for (let sample = 0; sample < 5; sample += 1) {
				await page.waitForTimeout(300);
				expect(await activeElement()).toBe("h3:应用凭证结果");
			}
		};
		await submit("签发应用凭证");
		expect(api.commands).toHaveLength(1);
		await page.getByRole("button", { name: "使用此凭证 ID 轮换" }).click();
		await submit("轮换应用凭证");
		expect(api.commands).toHaveLength(2);
		expect(api.commands[1]?.body).toMatchObject({ operation: "rotate" });
		await expectCleanPage(page, errors);
		expect(await duplicateControlNames(page)).toEqual([]);
	});

// #3242 K7-02：「注册应用」进行中是可聚焦的禁用（aria-disabled），键盘 Enter 后挂起期间多次采样焦点
// 都在按钮上；注册成功后注册表单随状态切换卸载，焦点到新应用详情的应用名标题（D2-59）。
test("registering an application keeps focus on the pending button, then on the new application title (K7-02)", async ({
	page,
}, info) => {
	await page.setViewportSize(
		info.project.name === "mobile"
			? { width: 390, height: 844 }
			: { width: 1440, height: 900 },
	);
	const errors = trackPageErrors(page);
	await fixture(page);
	await page.route("**/api/v2/applications", (route) =>
		route.request().method() === "POST"
			? route.fulfill({
					status: 201,
					json: {
						metadata: {
							...application,
							applicationId: "application-registered",
							name: "Browser second service",
						},
						replayed: false,
					},
				})
			: route.fallback(),
	);
	const registering = await holdRequests(page, "POST", "/api/v2/applications");
	await page.goto("/my-settings/api-credentials");
	await page
		.getByLabel("应用名称", { exact: true })
		.fill("Browser second service");
	const register = await pinElement(
		page.getByRole("button", { name: "注册应用", exact: true }),
		"register-application",
	);
	await register.focus();
	await page.keyboard.press("Enter");
	await expect(register).toHaveText("正在注册…");
	await expectFocusableBusy(register, "注册应用");
	registering.release();
	await expect(page).toHaveURL(/applicationId=application-registered/);
	await expectFocusSettled(
		page.getByRole("heading", { level: 3, name: "Browser second service" }),
		"注册应用",
	);
	await expectCleanPage(page, errors);
});
