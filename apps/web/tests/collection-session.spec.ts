import {
	AgentProjectionV2Schema,
	ConnectionCapabilityProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { expect, test } from "@playwright/test";
import {
	deploymentConfiguration,
	pendingApplication,
} from "../src/features/my-agents/test-fixtures";

test("logout and another login cancel old collection pages without restoring their data", async ({
	page,
}, info) => {
	// 在 auth-desktop / auth-mobile project 中运行，构建配置了同源登录与退出入口（NI-113）。
	const mobile = info.project.name.endsWith("mobile");
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
	const directoryReads: ("a" | "b" | null)[] = [];
	const deploymentReads: ("a" | "b" | null)[] = [];
	page.on("requestfailed", (request) => {
		if (new URL(request.url()).searchParams.has("cursor"))
			cancelled.push(new URL(request.url()).pathname);
	});
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (
			request.method() === "GET" &&
			url.pathname === "/api/v1/connection/capability"
		)
			return route.fulfill({
				json: ConnectionCapabilityProjectionV1Schema.parse({
					schemaVersion: 1,
					status: "unavailable",
					reason: "missing",
				}),
			});
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
		// 申请行按目录反查显示名（不在本用例建模，直接中止）；只允许在已登录时发生。
		if (url.pathname === "/api/v2/directory/search") {
			directoryReads.push(actor);
			return route.abort();
		}
		// 模板显示名来自部署配置（F-02）；同样只允许在已登录时读取。
		if (url.pathname === "/api/v2/deployment/configuration") {
			deploymentReads.push(actor);
			return route.fulfill({ json: deploymentConfiguration });
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
	if (mobile)
		await page.getByRole("button", { name: "打开导航", exact: true }).click();
	await page.getByRole("button", { name: "退出登录", exact: true }).click();
	// 退出后整页为独立登录页（L-01），导航 Sheet 随应用壳一起卸载，无需再关闭。
	await expect(
		page.getByRole("heading", { name: "登录工作区", exact: true }),
	).toBeVisible();
	// 主动退出不是「登录已过期」（L-06）。
	await expect(page.getByText("登录已过期，请重新登录")).toHaveCount(0);
	await page.getByLabel("公司账号", { exact: true }).fill("controlled-b");
	await page
		.getByLabel("密码", { exact: true })
		.fill("controlled-fixture-value");
	await page.getByRole("button", { name: "登录", exact: true }).click();
	await expect(
		page.getByText("Controlled b application", { exact: true }),
	).toBeVisible();
	// 退出前打开的窄屏导航不随重新登录自动展开。
	await expect(page.getByRole("dialog", { name: "主导航" })).toHaveCount(0);
	// F-09：Tab 文案按设计改为「已创建」。
	await page.getByRole("tab", { name: "已创建", exact: true }).click();
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
	// 「申请」Tab 在申请读取成功后带计数（可访问名称「申请 N」，第一波 mine）。
	const applicationsTab = page.getByRole("tab", { name: /^申请(?: \d+)?$/ });
	await applicationsTab.click();
	await expect(applicationsTab).toHaveAttribute("aria-selected", "true");
	await expect(
		page.getByText("Controlled a application", { exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByText("Controlled b application", { exact: true }),
	).toBeVisible();
	// 计数只反映新账号的申请，不带入上一账号的数据。
	await expect(applicationsTab).toHaveAccessibleName("申请 1");
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
	expect(directoryReads).not.toContain(null);
	expect(deploymentReads).not.toContain(null);
	await test.info().attach("controlled-new-login-applicant-data", {
		body: await page.screenshot({ fullPage: true, animations: "disabled" }),
		contentType: "image/png",
	});
});
