import { expect, type Page, test } from "@playwright/test";

const ownerSession = {
	schemaVersion: 1,
	user: {
		userId: "relay-owner",
		displayName: "Relay Owner",
		roles: ["employee"],
	},
};

const otherSession = {
	schemaVersion: 1,
	user: {
		userId: "relay-other",
		displayName: "Relay Other",
		roles: ["employee"],
	},
};

const protocolError = (code: string, retryable: boolean) => ({
	schemaVersion: 1,
	code,
	message: "Controlled personal Relay Key failure",
	retryable,
	traceId: `trace-relay-${code.toLowerCase()}`,
});

async function routeShell(page: Page) {
	let session = ownerSession;
	let relayState: {
		schemaVersion: 1;
		isSet: boolean;
		keyVersion: number | null;
	} = {
		schemaVersion: 1,
		isSet: true,
		keyVersion: 4,
	};
	let nextWriteStatus: 409 | 503 | undefined;
	let readStatus: 200 | 401 | 403 = 200;
	const writes: unknown[] = [];

	await page.route(
		"**/api/v1/session",
		async (route) => await route.fulfill({ status: 200, json: session }),
	);
	await page.route(
		"**/api/v2/agents**",
		async (route) =>
			await route.fulfill({
				status: 200,
				json: { items: [], nextCursor: null },
			}),
	);
	await page.route("**/api/v2/me/relay-key", async (route) => {
		const request = route.request();
		if (request.method() === "GET") {
			if (readStatus !== 200) {
				await route.fulfill({
					status: readStatus,
					json: protocolError(
						readStatus === 401
							? "AUTHENTICATION_REQUIRED"
							: "AUTHORIZATION_REVOKED",
						false,
					),
				});
				return;
			}
			await route.fulfill({ status: 200, json: relayState });
			return;
		}
		writes.push(request.postDataJSON());
		if (nextWriteStatus) {
			const status = nextWriteStatus;
			nextWriteStatus = undefined;
			await route.fulfill({
				status,
				json: protocolError(
					status === 409 ? "RESOURCE_CONFLICT" : "DEPENDENCY_UNAVAILABLE",
					status === 503,
				),
			});
			return;
		}
		relayState = { schemaVersion: 1, isSet: false, keyVersion: null };
		await route.fulfill({ status: 200, json: relayState });
	});

	return {
		setSession(next: typeof ownerSession) {
			session = next;
		},
		setReadStatus(next: 200 | 401 | 403) {
			readStatus = next;
		},
		setNextWriteStatus(next: 409 | 503) {
			nextWriteStatus = next;
		},
		writes,
	};
}

test("covers CAS conflicts, unavailable writes, and cross-user state clearing", async ({
	page,
}) => {
	const fixture = await routeShell(page);
	await page.goto("/agents");
	await page.getByRole("button", { name: "个人 Key 设置" }).click();
	await expect(page.getByText("已配置 · 版本 4")).toBeVisible();

	fixture.setNextWriteStatus(409);
	await page.getByLabel("替换个人 Relay Key").fill("synthetic-browser-secret");
	await page.getByRole("button", { name: "替换 Key" }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"个人 Key 状态已被其他请求更新，请重新读取后再操作。",
	);
	await expect(page.getByText("synthetic-browser-secret")).toHaveCount(0);

	await page.getByRole("button", { name: "重新读取状态" }).click();
	await expect(page.getByText("已配置 · 版本 4")).toBeVisible();
	fixture.setNextWriteStatus(503);
	await page.getByLabel("替换个人 Relay Key").fill("synthetic-browser-secret");
	await page.getByRole("button", { name: "替换 Key" }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"个人 Key 服务暂时不可用，请稍后重试。",
	);

	fixture.setSession(otherSession);
	fixture.setReadStatus(403);
	await page.reload();
	await page.getByRole("button", { name: "个人 Key 设置" }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"当前账号没有设置个人 Relay Key 的权限。",
	);
	await expect(page.getByText("已配置 · 版本 4")).toHaveCount(0);
	await expect(page.getByTestId("personal-key-status")).toHaveText("尚未读取");
	await expect(fixture.writes).toHaveLength(2);
});

test("shows an expired-session read as actionable without a fallback", async ({
	page,
}) => {
	const fixture = await routeShell(page);
	fixture.setReadStatus(401);
	await page.goto("/agents");
	await page.getByRole("button", { name: "个人 Key 设置" }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"登录状态已失效，请重新登录后重试。",
	);
	await expect(
		page.getByRole("button", { name: "重新检查登录" }),
	).toBeVisible();
	await expect(page.getByTestId("personal-key-status")).toHaveText("尚未读取");
});
