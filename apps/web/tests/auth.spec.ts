import { expect, test } from "@playwright/test";

const session = {
	schemaVersion: 1,
	user: {
		userId: "employee-auth-browser",
		displayName: "登录员工",
		roles: ["employee"],
	},
};

test("consumes the Platform login contract and keeps the form retryable", async ({
	page,
}) => {
	test.skip(
		!process.env.VITE_PLATFORM_LOGIN_URL,
		"Set VITE_PLATFORM_LOGIN_URL=/auth/login when running the auth browser consumer.",
	);
	let authenticated = false;
	const loginRequests: { method: string; body: unknown; origin?: string }[] =
		[];
	await page.route("**/api/v1/session", async (route) => {
		if (authenticated) {
			await route.fulfill({ status: 200, json: session });
			return;
		}
		await route.fulfill({
			status: 401,
			contentType: "application/json",
			json: {
				schemaVersion: 1,
				code: "AUTHENTICATION_REQUIRED",
				message: "Authentication required",
				retryable: false,
				traceId: "trace-auth-browser",
			},
		});
	});
	await page.route("**/auth/login", async (route) => {
		const request = route.request();
		const body = request.postDataJSON();
		loginRequests.push({
			method: request.method(),
			body,
			origin: request.headers().origin,
		});
		if (
			body?.login !== "alice" ||
			body?.password !== "correct horse battery staple"
		) {
			await route.fulfill({ status: 401 });
			return;
		}
		authenticated = true;
		await route.fulfill({ status: 204 });
	});

	await page.goto("/agents");
	const expectedOrigin = new URL(page.url()).origin;
	await expect(
		page.getByRole("heading", { name: "登录工作空间" }),
	).toBeVisible();

	await page.getByRole("button", { name: "登录" }).click();
	expect(
		await page
			.getByLabel("账号")
			.evaluate((element) => (element as HTMLInputElement).validity.valid),
	).toBe(false);
	expect(
		await page
			.getByLabel("密码")
			.evaluate((element) => (element as HTMLInputElement).validity.valid),
	).toBe(false);
	expect(loginRequests).toHaveLength(0);

	await page.getByLabel("账号").fill("alice");
	await page.getByLabel("密码").fill("wrong");
	await page.getByRole("button", { name: "登录" }).click();
	await expect(page.getByRole("status")).toHaveText(
		"登录失败，请检查账号或稍后重试。",
	);
	await expect(page.getByLabel("账号")).toHaveAttribute("aria-invalid", "true");
	await expect(page.getByRole("button", { name: "登录" })).toBeEnabled();

	await page.getByLabel("密码").fill("correct horse battery staple");
	await page.getByRole("button", { name: "登录" }).click();
	await expect(page.getByRole("heading", { name: "登录工作空间" })).toHaveCount(
		0,
	);
	expect(loginRequests).toEqual([
		{
			method: "POST",
			body: { login: "alice", password: "wrong" },
			origin: expectedOrigin,
		},
		{
			method: "POST",
			body: { login: "alice", password: "correct horse battery staple" },
			origin: expectedOrigin,
		},
	]);
	const horizontalOverflow = await page.evaluate(
		() =>
			document.documentElement.scrollWidth >
			document.documentElement.clientWidth,
	);
	expect(horizontalOverflow).toBe(false);
});
