import {
	ApplicationApiCredentialResponseV1Schema,
	ApplicationMetadataV1Schema,
} from "@agent-infra/contracts/pilot";
import { expect, type Page, test } from "@playwright/test";

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
	await submitCredential(page);
	await expect(page.getByText("投递结果未知", { exact: true })).toBeVisible();
	await expect(
		page.getByText(credential.metadata.credentialId, { exact: true }),
	).toBeVisible();
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
