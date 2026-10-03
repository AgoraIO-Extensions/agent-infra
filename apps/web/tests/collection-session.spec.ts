import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { expect, test } from "@playwright/test";
import { pendingApplication } from "../src/features/my-agents/test-fixtures";

test("logout and another login cancel old collection pages without restoring their data", async ({
	page,
}, info) => {
	test.skip(
		!process.env.VITE_PLATFORM_LOGIN_URL ||
			!process.env.VITE_PLATFORM_LOGOUT_URL,
		"Controlled same-origin auth entry points are required",
	);
	let actor: "a" | "b" | null = "a";
	let release!: () => void;
	const pending = new Promise<void>((done) => {
		release = done;
	});
	const held: string[] = [];
	const cancelled: string[] = [];
	const requests: {
		actor: "a" | "b" | null;
		path: string;
		search: string;
		method: string;
	}[] = [];
	const unexpected: string[] = [];
	page.on("requestfailed", (request) => {
		if (new URL(request.url()).searchParams.has("cursor"))
			cancelled.push(new URL(request.url()).pathname);
	});
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.pathname === "/api/v1/session") {
			if (actor === null)
				return route.fulfill({
					status: 401,
					json: {
						schemaVersion: 1,
						code: "AUTHENTICATION_REQUIRED",
						message: "Controlled logged-out session",
						retryable: false,
						traceId: "controlled-session",
					},
				});
			return route.fulfill({
				json: {
					schemaVersion: 1,
					user: {
						userId: `controlled-${actor}`,
						displayName: `Controlled actor ${actor}`,
						roles: ["employee"],
					},
				},
				headers: { "X-Platform-Session-Generation": actor.repeat(43) },
			});
		}
		if (
			url.pathname !== "/api/v2/agents" &&
			url.pathname !== "/api/v2/agent-applications"
		) {
			unexpected.push(url.pathname);
			return route.abort();
		}
		const requestedActor = actor;
		requests.push({
			actor: requestedActor,
			path: url.pathname,
			search: url.search,
			method: request.method(),
		});
		if (requestedActor === null)
			return route.fulfill({
				status: 401,
				json: {
					schemaVersion: 1,
					code: "AUTHENTICATION_REQUIRED",
					message: "Controlled logged-out collection",
					retryable: false,
					traceId: "controlled-collection-session",
				},
			});
		if (requestedActor === "a" && url.searchParams.has("cursor")) {
			held.push(url.pathname);
			await pending;
		}
		const collection =
			url.pathname === "/api/v2/agents"
				? AgentProjectionV2Schema.parse({
						...pilotFakeScenariosV2.starting.response.body,
						agentId: `controlled-agent-${requestedActor}${url.searchParams.has("cursor") ? "-later" : ""}`,
						name: `Controlled ${requestedActor} Agent`,
						configuration: {
							...pilotFakeScenariosV2.starting.response.body.configuration,
							owners: [
								{
									userId: `controlled-${requestedActor}`,
									displayName: `Controlled actor ${requestedActor}`,
									roles: ["employee"],
								},
							],
						},
					})
				: {
						...pendingApplication,
						applicationId: `controlled-application-${requestedActor}${url.searchParams.has("cursor") ? "-later" : ""}`,
						name: `Controlled ${requestedActor} application`,
					};
		try {
			await route.fulfill({
				json: {
					items: [collection],
					nextCursor:
						requestedActor === "a" && !url.searchParams.has("cursor")
							? "controlled-next/+?="
							: null,
				},
			});
		} catch (error) {
			if (
				!url.searchParams.has("cursor") ||
				!request.failure()?.errorText.includes("ERR_ABORTED")
			)
				throw error;
		}
	});
	await page.route("**/auth/logout", async (route) => {
		expect(route.request().method()).toBe("POST");
		actor = null;
		await route.fulfill({ status: 204 });
	});
	await page.route("**/auth/login", async (route) => {
		expect(route.request().method()).toBe("POST");
		actor = "b";
		await route.fulfill({ status: 204 });
	});

	await page.goto("/my-agents");
	await expect
		.poll(() => held.sort())
		.toEqual(["/api/v2/agent-applications", "/api/v2/agents"]);
	await expect(
		page.getByText("Controlled a application", { exact: true }),
	).toHaveCount(0);
	if (info.project.name === "mobile")
		await page.getByRole("button", { name: "打开导航", exact: true }).click();
	await page.getByRole("button", { name: "退出登录", exact: true }).click();
	if (info.project.name === "mobile")
		await page.getByRole("button", { name: "关闭导航", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "登录工作空间", exact: true }),
	).toBeVisible();
	await page.getByLabel("账号", { exact: true }).fill("controlled-b");
	await page
		.getByLabel("密码", { exact: true })
		.fill("controlled-fixture-value");
	await page.getByRole("button", { name: "登录", exact: true }).click();
	await expect(
		page.getByText("Controlled b application", { exact: true }),
	).toBeVisible();
	await page.getByRole("tab", { name: "已创建 Agent", exact: true }).click();
	await expect(
		page.getByText("Controlled b Agent", { exact: true }),
	).toBeVisible();
	release();
	await expect
		.poll(() => cancelled.sort())
		.toEqual(["/api/v2/agent-applications", "/api/v2/agents"]);
	await expect(
		page.getByText("Controlled a Agent", { exact: true }),
	).toHaveCount(0);
	await page.getByRole("tab", { name: "申请", exact: true }).click();
	await expect(
		page.getByRole("tab", { name: "申请", exact: true }),
	).toHaveAttribute("aria-selected", "true");
	await expect(
		page.getByText("Controlled a application", { exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByText("Controlled b application", { exact: true }),
	).toBeVisible();
	expect(requests).toHaveLength(6);
	expect(requests.every((request) => request.method === "GET")).toBe(true);
	expect(
		requests
			.filter((request) => request.path === "/api/v2/agents")
			.every(
				(request) =>
					new URLSearchParams(request.search).get("scope") === "owner",
			),
	).toBe(true);
	expect(
		requests.every(
			(request) => !new URLSearchParams(request.search).has("userId"),
		),
	).toBe(true);
	expect(unexpected).toEqual([]);
	await test.info().attach("controlled-new-login-applicant-data", {
		body: await page.screenshot({ fullPage: true, animations: "disabled" }),
		contentType: "image/png",
	});
});
