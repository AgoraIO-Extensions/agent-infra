import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
	AgentProjectionV2Schema,
	ConnectionCapabilityProjectionV1Schema,
	ConversationPageV1Schema,
	ExecutionDetailProjectionV2Schema,
} from "@agent-infra/contracts/pilot";
import { ConnectionInstallationProjectionV1Schema } from "@agent-infra/contracts/runtime";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import {
	execution,
	history,
} from "../src/features/conversation/conversation-test-fixtures";
import { keepConversationStreamOpen } from "./conversation-stream";
import {
	expectFocusableBusy,
	expectFocusSettled,
	holdRequests,
	pinElement,
} from "./page-health";
import { expectCleanPage, trackPageErrors } from "./primitive-styles";

const agentId = "agent-1";
const conversationId = "conversation-1";
const executionId = "execution-1";
const authorizationId = "authorization-browser-1";
const authorizationUrl =
	"https://connection.test/oauth/authorize?state=browser";
const beginPath = "/api/connection-installations";
const statusPath = `${beginPath}/${authorizationId}`;
const confirmPath = `${statusPath}/confirm`;

interface ObservedInstallationRequest {
	readonly command: "begin" | "status" | "confirm";
	readonly method: string;
	readonly accepted: boolean;
	readonly origin: string | undefined;
	readonly csrf: string | undefined;
	readonly idempotencyKey: string | undefined;
	readonly secFetchSite: string | undefined;
}

function headerValue(
	headers: Record<string, string | string[] | undefined>,
	name: string,
) {
	const value = headers[name];
	return Array.isArray(value) ? value[0] : value;
}

/**
 * Mirrors the browser gate in
 * `apps/platform-api/src/http/connection-installation-routes.ts`: the exact
 * public Origin, the JavaScript-settable CSRF marker, and an optional
 * same-origin Sec-Fetch-Site. Chromium owns Origin and Sec-Fetch-Site for
 * same-origin POSTs; the panel may not rely on setting either of them.
 *
 * The Platform responses are synthetic fixtures, as in the other
 * `apps/web/tests` journeys; only the browser-owned request headers are real
 * Chromium behaviour, so a pass does not prove a deployed Connection
 * authorization.
 */
function browserGateAccepts(
	headers: Record<string, string | string[] | undefined>,
	publicOrigin: string,
) {
	return (
		headerValue(headers, "origin") === publicOrigin &&
		headerValue(headers, "x-platform-csrf") === "1" &&
		(headerValue(headers, "sec-fetch-site") ?? "same-origin") === "same-origin"
	);
}

function installationProjection(status: "awaiting_confirmation" | "confirmed") {
	return ConnectionInstallationProjectionV1Schema.parse({
		schemaVersion: 1,
		authorizationId,
		status,
		expiresAt: Date.now() + 600_000,
		...(status === "awaiting_confirmation" ? { authorizationUrl } : {}),
	});
}

/** Boots the real execution-details surface and enforces the Platform gate. */
/**
 * 执行详情只在本次执行确实需要 Connection 授权时默认展开安装区（R4-09）；
 * fixture 带一条授权暂不可用的调用事实，用户不需要先展开折叠区。
 */
function authorizationNeededExecution() {
	const base = execution(conversationId, executionId);
	return ExecutionDetailProjectionV2Schema.parse({
		...base,
		events: [
			...base.events,
			{
				schemaVersion: 2,
				kind: "event",
				eventId: "connection-installation-event-2",
				conversationId,
				executionId,
				sequence: 2,
				conversationCursor: "connection-installation-cursor-2",
				occurredAt: base.startedAt,
				type: "execution.operation",
				payload: {
					kind: "tool",
					operationRef: "operation-connection",
					attemptRef: "attempt-connection",
					phase: "failed",
					toolId: "github.issues_read",
					connection: {
						verification: "unverified",
						serviceRef: "service-github",
						reason: "authorization_unavailable",
					},
				},
			},
		],
	});
}

async function openExecutionDetails(
	page: Page,
	pendingConfirmationResponse = false,
) {
	let confirmed = false;
	const observed: ObservedInstallationRequest[] = [];
	await keepConversationStreamOpen(page);
	await page.route(/\/api\//, async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path === beginPath || path === statusPath || path === confirmPath) {
			const headers = request.headers();
			const publicOrigin = new URL(page.url()).origin;
			const accepted = browserGateAccepts(headers, publicOrigin);
			observed.push({
				command:
					path === beginPath
						? "begin"
						: path === confirmPath
							? "confirm"
							: "status",
				method: request.method(),
				accepted,
				origin: headers.origin,
				csrf: headers["x-platform-csrf"],
				idempotencyKey: headers["idempotency-key"],
				secFetchSite: headers["sec-fetch-site"],
			});
			if (!accepted) {
				await route.fulfill({
					status: 403,
					json: { code: "AUTHORIZATION_REVOKED" },
				});
				return;
			}
			if (path === confirmPath) {
				expect(request.postDataJSON()).toEqual({ schemaVersion: 1 });
				expect(headers["idempotency-key"]).toBeTruthy();
				confirmed = true;
			}
			await route.fulfill({
				status: path === statusPath ? 200 : 202,
				json: installationProjection(
					confirmed && !(path === confirmPath && pendingConfirmationResponse)
						? "confirmed"
						: "awaiting_confirmation",
				),
			});
			return;
		}
		if (path === "/api/v1/session")
			return route.fulfill({
				json: {
					schemaVersion: 1,
					user: {
						userId: "user-owner-1",
						displayName: "开发测试",
						roles: ["employee"],
					},
				},
			});
		if (path === "/api/v1/connection/capability")
			return route.fulfill({
				json: ConnectionCapabilityProjectionV1Schema.parse({
					schemaVersion: 1,
					status: "unavailable",
					reason: "missing",
				}),
			});
		if (path === "/api/v2/me/conversations/recent")
			return route.fulfill({
				json: ConversationPageV1Schema.parse({ items: [], nextCursor: null }),
			});
		if (path === `/api/v2/agents/${agentId}`)
			return route.fulfill({
				json: AgentProjectionV2Schema.parse({
					...pilotFakeScenariosV2.starting.response.body,
					agentId,
					managementStatus: "available",
					serviceAvailability: "ready",
				}),
			});
		if (path === `/api/v2/conversations/${conversationId}`)
			return route.fulfill({ json: history(conversationId) });
		if (path.endsWith(`/executions/${executionId}`))
			return route.fulfill({ json: authorizationNeededExecution() });
		if (path.endsWith("/events"))
			return route.fulfill({
				contentType: "text/event-stream",
				body: ": heartbeat\n\n",
			});
		return route.fulfill({ json: { items: [], nextCursor: null } });
	});
	await page.goto(
		`/agents/${agentId}/conversations?conversation=${conversationId}`,
	);
	// CH-08：执行详情入口是回复卡状态行里的「查看执行详情」文字链接。
	await page.getByRole("button", { name: /^查看执行详情/ }).click();
	return observed;
}

test("requires an explicit confirmation through the browser Origin gate", async ({
	page,
}) => {
	const observed = await openExecutionDetails(page);
	const details = page.getByRole("dialog", { name: "执行详情" });
	await details.getByRole("button", { name: "开始安装", exact: true }).click();
	await expect(
		details.getByText("等待 Connection 确认", { exact: true }),
	).toBeVisible();
	// A status read cannot grant the user's confirmation.
	await expect
		.poll(
			() => observed.filter((request) => request.command === "status").length,
		)
		.toBeGreaterThan(0);
	expect(observed.some((request) => request.command === "confirm")).toBe(false);
	await expect(details.getByText("已确认", { exact: true })).toHaveCount(0);
	await details.getByRole("button", { name: "确认安装", exact: true }).click();
	await expect(details.getByText("已确认", { exact: true })).toBeVisible();

	const publicOrigin = new URL(page.url()).origin;
	const [begin] = observed;
	const statuses = observed.filter((request) => request.command === "status");
	const confirmations = observed.filter(
		(request) => request.command === "confirm",
	);
	expect(confirmations).toHaveLength(1);
	expect(confirmations[0]).toMatchObject({
		method: "POST",
		accepted: true,
		origin: publicOrigin,
		csrf: "1",
	});
	expect(confirmations[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
	expect(confirmations[0]?.idempotencyKey).not.toBe(begin?.idempotencyKey);
	expect(begin).toMatchObject({
		command: "begin",
		method: "POST",
		accepted: true,
		origin: publicOrigin,
		csrf: "1",
	});
	expect(begin?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
	// Interception observes the browser-supplied Origin but never Sec-Fetch-Site;
	// the wire-level case below covers that header.
	expect(begin?.secFetchSite).toBeUndefined();
	expect(statuses.length).toBeGreaterThan(0);
	for (const status of statuses) {
		// A browser POST keeps the exact-Origin gate satisfiable; JavaScript
		// cannot supply Origin for a GET, so the read contract must stay POST.
		expect(status).toMatchObject({
			command: "status",
			method: "POST",
			accepted: true,
			origin: publicOrigin,
			csrf: "1",
		});
		expect(status.idempotencyKey).toBeUndefined();
	}
	await test.info().attach("connection-installation-gate-accepted", {
		body: await page.screenshot({ fullPage: true }),
		contentType: "image/png",
	});
});

test("keeps Origin and Sec-Fetch-Site browser-owned on same-origin POSTs", async ({
	page,
}) => {
	const wire: Array<{
		readonly path: string;
		readonly origin: string | undefined;
		readonly secFetchSite: string | undefined;
		readonly csrf: string | undefined;
	}> = [];
	const server = createServer((request, response) => {
		if (request.method !== "POST") {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(
				"<!doctype html><html><body>installation probe</body></html>",
			);
			return;
		}
		const address = server.address() as AddressInfo;
		const accepted = browserGateAccepts(
			request.headers,
			`http://127.0.0.1:${address.port}`,
		);
		wire.push({
			path: request.url ?? "",
			origin: headerValue(request.headers, "origin"),
			secFetchSite: headerValue(request.headers, "sec-fetch-site"),
			csrf: headerValue(request.headers, "x-platform-csrf"),
		});
		response.writeHead(
			accepted ? (request.url === statusPath ? 200 : 202) : 403,
			{
				"content-type": "application/json",
			},
		);
		response.end(JSON.stringify({ accepted }));
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);
	const { port } = server.address() as AddressInfo;
	const origin = `http://127.0.0.1:${port}`;
	try {
		await page.goto(`${origin}/installation-probe`);
		const responses = await page.evaluate(
			async (paths: {
				readonly begin: string;
				readonly status: string;
				readonly confirm: string;
			}) => {
				// Forged values prove that the browser, not JavaScript, decides these
				// headers: the page cannot widen its own authorization gate.
				const forge = {
					Origin: "https://forged.test",
					"Sec-Fetch-Site": "cross-site",
					"X-Platform-CSRF": "1",
				};
				const begin = await fetch(paths.begin, {
					method: "POST",
					headers: { ...forge, "Idempotency-Key": "probe-key" },
					body: JSON.stringify({
						schemaVersion: 1,
						executionId: "execution-1",
					}),
				});
				const status = await fetch(paths.status, {
					method: "POST",
					headers: forge,
				});
				const confirmation = await fetch(paths.confirm, {
					method: "POST",
					headers: { ...forge, "Idempotency-Key": "confirm-probe-key" },
					body: JSON.stringify({ schemaVersion: 1 }),
				});
				return [begin.status, status.status, confirmation.status];
			},
			{ begin: beginPath, status: statusPath, confirm: confirmPath },
		);
		expect(responses).toEqual([202, 200, 202]);
		expect(wire).toHaveLength(3);
		for (const request of wire) {
			expect(request.origin).toBe(origin);
			expect(request.secFetchSite).toBe("same-origin");
			expect(request.csrf).toBe("1");
		}
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

async function acceptanceViewport(page: Page, info: TestInfo) {
	await page.setViewportSize(
		info.project.name === "mobile"
			? { width: 390, height: 844 }
			: { width: 1440, height: 900 },
	);
}

// #3242 K7-02：Connection「查询状态」读取中是可聚焦的禁用（aria-disabled），键盘 Enter 后挂起期间多次
// 采样焦点都在按钮上；查到终态（已确认）后同一个按钮原地换成「重新开始」，焦点仍在它上面，不落到 body，
// 也不被执行详情弹窗收回到弹窗本身。
test("querying the installation status keeps focus on the pending button, then on 重新开始 (K7-02)", async ({
	page,
}, info) => {
	await acceptanceViewport(page, info);
	const errors = trackPageErrors(page);
	await openExecutionDetails(page, true);
	// 在 fixture 之后注册（后注册的路由先处理）：状态读取全部挂起。
	const statusRead = await holdRequests(page, "POST", statusPath);
	const details = page.getByRole("dialog", { name: "执行详情" });
	await details.getByRole("button", { name: "开始安装", exact: true }).click();
	await details.getByRole("button", { name: "确认安装", exact: true }).click();
	const query = await pinElement(
		details.getByRole("button", { name: "查询状态", exact: true }),
		"connection-status",
	);
	await query.focus();
	await page.keyboard.press("Enter");
	await expect(query).toHaveText("查询中");
	await expectFocusableBusy(query, "查询 Connection 状态");
	statusRead.release();
	await expect(details.getByText("已确认", { exact: true })).toBeVisible();
	await expect(query).toHaveAccessibleName("重新开始");
	await expect(query).not.toHaveAttribute("aria-disabled", "true");
	await expectFocusSettled(query, "查询 Connection 状态");
	await expectCleanPage(page, errors);
});

// #3242 K7-02：「核实原执行状态」读取中是可聚焦的禁用；核实到终态、按钮随之卸载后焦点交给执行详情
// 弹窗本身，Escape 仍可关闭。
test("verifying the original execution keeps focus on the pending button, then on the dialog (K7-02)", async ({
	page,
}, info) => {
	await acceptanceViewport(page, info);
	const errors = trackPageErrors(page);
	await openExecutionDetails(page);
	const details = page.getByRole("dialog", { name: "执行详情" });
	// 首次读取为待核实；之后的核实读取到已完成（终态）。
	await page.route(new RegExp(`/executions/${executionId}$`), (route) =>
		route.fulfill({
			json: ExecutionDetailProjectionV2Schema.parse({
				...authorizationNeededExecution(),
				status: "completed",
				finishedAt: authorizationNeededExecution().startedAt,
			}),
		}),
	);
	const verify = await pinElement(
		details.getByRole("button", { name: "核实原执行状态" }),
		"verify-execution",
	);
	const reading = await holdRequests(
		page,
		"GET",
		new RegExp(`/executions/${executionId}$`),
	);
	await verify.focus();
	await page.keyboard.press("Enter");
	await expectFocusableBusy(verify, "核实原执行状态");
	reading.release();
	await expect(verify).toHaveCount(0);
	await expectFocusSettled(details, "核实原执行状态（终态）");
	await page.keyboard.press("Escape");
	await expect(details).toHaveCount(0);
	await expectCleanPage(page, errors);
});

// #3269 N8-3-02：「开始安装」与「查询状态」「重新开始」占同一个位置、复用同一个按钮元素：准备授权期间是
// 可聚焦的禁用，焦点留在按钮上；受理后同一个按钮原地换成「查询状态」，焦点仍在它上面，不落到 body。
test("beginning an installation keeps focus on the same step button while preparing and after (N8-3-02)", async ({
	page,
}, info) => {
	await acceptanceViewport(page, info);
	const errors = trackPageErrors(page);
	await openExecutionDetails(page);
	const details = page.getByRole("dialog", { name: "执行详情" });
	const step = await pinElement(
		details.getByRole("button", { name: "开始安装", exact: true }),
		"connection-step",
	);
	const beginning = await holdRequests(page, "POST", beginPath);
	// 状态读取也挂起，确认焦点停在「查询状态」而不是被轮询改变。
	const statusRead = await holdRequests(page, "POST", statusPath);
	await step.focus();
	await page.keyboard.press("Enter");
	await expect(details.getByText("正在准备授权…")).toBeVisible();
	await expectFocusableBusy(step, "开始安装准备中");
	beginning.release();
	await expect(step).toHaveAccessibleName("查询状态");
	await expectFocusSettled(step, "开始安装受理后");
	statusRead.release();
	await expectCleanPage(page, errors);
});

// #3433（轮询全量收口）：安装状态轮询按 #3418 的轮询规则。可重试的失败（503、网络中断）保留「等待 Connection
// 确认」并按原节奏继续、不另加提示，读到「已确认」（终态）后停止；不可重试的失败（401、404、响应无效）停止轮询，
// 显示「Connection 安装暂不可用。」，步骤按钮保留原安装的「查询状态」，不重新发起安装。两视口一致。
test("the installation status poll continues through retryable failures and stops at the terminal state (#3433)", async ({
	page,
}, info) => {
	await acceptanceViewport(page, info);
	const errors = trackPageErrors(page);
	const observed = await openExecutionDetails(page, true);
	const reads: string[] = [];
	await page.route(statusPath, (route) => {
		expect(observed.some((request) => request.command === "confirm")).toBe(
			true,
		);
		const step = ["503", "network", "awaiting"][reads.length] ?? "confirmed";
		reads.push(step);
		if (step === "network") return route.abort("internetdisconnected");
		if (step === "503")
			return route.fulfill({
				status: 503,
				json: { code: "DEPENDENCY_UNAVAILABLE", retryable: true },
			});
		return route.fulfill({
			status: 200,
			json: installationProjection(
				step === "awaiting" ? "awaiting_confirmation" : "confirmed",
			),
		});
	});
	const details = page.getByRole("dialog", { name: "执行详情" });
	const step = await pinElement(
		details.getByRole("button", { name: "开始安装", exact: true }),
		"connection-step-poll",
	);
	await step.click();
	await expect(step).toHaveAccessibleName("查询状态");
	await details.getByRole("button", { name: "确认安装", exact: true }).click();
	await step.focus();
	await expect.poll(() => reads.length, { timeout: 8_000 }).toBe(2);
	// 两次可重试的失败之后仍在等待确认，不另加提示，焦点仍在步骤按钮上。
	await expect(
		details.getByText("等待 Connection 确认", { exact: true }),
	).toBeVisible();
	await expect(details.getByText("暂时无法读取安装状态。")).toHaveCount(0);
	await expect(details.getByRole("alert")).toHaveCount(0);
	await expect(step).toBeFocused();
	await expect(details.getByText("已确认", { exact: true })).toBeVisible({
		timeout: 10_000,
	});
	await expect(step).toHaveAccessibleName("重新开始");
	await expect(step).toBeFocused();
	const settled = reads.length;
	await page.waitForTimeout(4_500);
	expect(reads.length, "读到终态后不再轮询").toBe(settled);
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
	await expectCleanPage(page, errors);
});

for (const failure of ["401", "404", "invalid"] as const)
	test(`the installation status poll stops after a non-retryable failure: ${failure} (#3433)`, async ({
		page,
	}, info) => {
		await acceptanceViewport(page, info);
		const errors = trackPageErrors(page);
		await openExecutionDetails(page);
		let reads = 0;
		await page.route(statusPath, (route) => {
			reads += 1;
			if (failure === "invalid")
				return route.fulfill({ status: 200, json: { schemaVersion: 1 } });
			return route.fulfill({
				status: Number(failure),
				json: { code: "RESOURCE_UNAVAILABLE", retryable: false },
			});
		});
		const details = page.getByRole("dialog", { name: "执行详情" });
		const step = await pinElement(
			details.getByRole("button", { name: "开始安装", exact: true }),
			"connection-step-fatal",
		);
		await step.click();
		const alert = details
			.getByRole("alert")
			.filter({ hasText: "Connection 安装暂不可用。" });
		await expect(alert).toBeVisible({ timeout: 8_000 });
		expect(reads).toBe(1);
		await expect(alert.getByRole("button")).toHaveCount(0);
		await expect(
			details.getByText("等待 Connection 确认", { exact: true }),
		).toHaveCount(0);
		await expect(step).toHaveAccessibleName("查询状态");
		await expectFocusSettled(step, `安装状态轮询 ${failure} 后`);
		await page.waitForTimeout(4_500);
		expect(reads, "不可重试的失败之后不再轮询").toBe(1);
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true);
		await expectCleanPage(page, errors);
	});

test("confirmation keeps focus while pending and returns it to the persistent step button", async ({
	page,
}, info) => {
	await acceptanceViewport(page, info);
	const errors = trackPageErrors(page);
	const observed = await openExecutionDetails(page);
	const confirmation = await holdRequests(page, "POST", confirmPath);
	const details = page.getByRole("dialog", { name: "执行详情" });
	await details.getByRole("button", { name: "开始安装", exact: true }).click();
	const step = await pinElement(
		details.getByRole("button", { name: "查询状态", exact: true }),
		"installation-step-confirm",
	);
	const confirm = await pinElement(
		details.getByRole("button", { name: "确认安装", exact: true }),
		"installation-confirm",
	);
	await confirm.focus();
	await page.keyboard.press("Enter");
	await expect(confirm).toHaveText("确认中");
	await expectFocusableBusy(confirm, "确认 Connection 安装");
	await page.keyboard.press("Enter");
	await expect(step).toHaveAttribute("aria-disabled", "true");
	confirmation.release();
	await expect(details.getByText("已确认", { exact: true })).toBeVisible();
	await expect(confirm).toHaveCount(0);
	await expect(step).toHaveAccessibleName("重新开始");
	await expectFocusSettled(step, "确认安装完成后");
	expect(
		observed.filter((request) => request.command === "confirm"),
	).toHaveLength(1);
	await expectCleanPage(page, errors);
});

test("a lost confirmation response keeps the original installation and retries only on click with the same key", async ({
	page,
}, info) => {
	await acceptanceViewport(page, info);
	const observed = await openExecutionDetails(page);
	const confirmationKeys: string[] = [];
	await page.route(confirmPath, async (route) => {
		const key = route.request().headers()["idempotency-key"];
		expect(key).toBeTruthy();
		confirmationKeys.push(key ?? "");
		if (confirmationKeys.length === 1)
			return route.abort("internetdisconnected");
		return route.fallback();
	});
	const details = page.getByRole("dialog", { name: "执行详情" });
	await details.getByRole("button", { name: "开始安装", exact: true }).click();
	await details.getByRole("button", { name: "确认安装", exact: true }).click();
	await expect(
		details.getByText("确认结果尚未核实，请查询原安装状态。"),
	).toBeVisible();
	await expect(
		details.getByRole("button", { name: "重新开始", exact: true }),
	).toHaveCount(0);
	await page.waitForTimeout(2_500);
	expect(confirmationKeys).toHaveLength(1);
	await details.getByRole("button", { name: "查询状态", exact: true }).click();
	await expect(
		details.getByText("确认结果尚未核实，请查询原安装状态。"),
	).toHaveCount(0);
	expect(confirmationKeys).toHaveLength(1);
	await details.getByRole("button", { name: "确认安装", exact: true }).click();
	await expect(details.getByText("已确认", { exact: true })).toBeVisible();
	expect(confirmationKeys).toHaveLength(2);
	expect(confirmationKeys[1]).toBe(confirmationKeys[0]);
	expect(
		observed.filter((request) => request.command === "begin"),
	).toHaveLength(1);
	expect(
		observed.filter((request) => request.command === "status").length,
	).toBeGreaterThan(0);
});
