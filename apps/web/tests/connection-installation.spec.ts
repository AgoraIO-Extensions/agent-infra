import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
	AgentProjectionV2Schema,
	ConnectionCapabilityProjectionV1Schema,
	ConversationPageV1Schema,
} from "@agent-infra/contracts/pilot";
import { ConnectionInstallationProjectionV1Schema } from "@agent-infra/contracts/runtime";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { expect, type Page, test } from "@playwright/test";
import {
	execution,
	history,
} from "../src/features/conversation/conversation-test-fixtures";
import { keepConversationStreamOpen } from "./conversation-stream";

const agentId = "agent-1";
const conversationId = "conversation-1";
const executionId = "execution-1";
const authorizationId = "authorization-browser-1";
const authorizationUrl =
	"https://connection.test/oauth/authorize?state=browser";
const beginPath = "/api/connection-installations";
const statusPath = `${beginPath}/${authorizationId}`;

interface ObservedInstallationRequest {
	readonly command: "begin" | "status";
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
async function openExecutionDetails(page: Page) {
	const observed: ObservedInstallationRequest[] = [];
	await keepConversationStreamOpen(page);
	await page.route(/\/api\//, async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path === beginPath || path === statusPath) {
			const headers = request.headers();
			const publicOrigin = new URL(page.url()).origin;
			const accepted = browserGateAccepts(headers, publicOrigin);
			observed.push({
				command: path === beginPath ? "begin" : "status",
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
			await route.fulfill(
				path === beginPath
					? {
							status: 202,
							json: installationProjection("awaiting_confirmation"),
						}
					: { status: 200, json: installationProjection("confirmed") },
			);
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
			return route.fulfill({ json: execution(conversationId, executionId) });
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
	await page.getByRole("button", { name: "执行详情", exact: true }).click();
	return observed;
}

test("begins and polls a Connection installation through the browser Origin gate", async ({
	page,
}) => {
	const observed = await openExecutionDetails(page);
	const details = page.getByRole("region", { name: "执行详情" });
	await details.getByRole("button", { name: "开始安装", exact: true }).click();
	await expect(
		details.getByText("等待 Connection 确认", { exact: true }),
	).toBeVisible();
	// The panel's own bounded poll reads the status, without any mocked header.
	await expect(details.getByText("已确认", { exact: true })).toBeVisible({
		timeout: 15_000,
	});

	const publicOrigin = new URL(page.url()).origin;
	const [begin, ...statuses] = observed;
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
			accepted ? (request.url === beginPath ? 202 : 200) : 403,
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
			async (paths: { readonly begin: string; readonly status: string }) => {
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
				return [begin.status, status.status];
			},
			{ begin: beginPath, status: statusPath },
		);
		expect(responses).toEqual([202, 200]);
		expect(wire).toHaveLength(2);
		for (const request of wire) {
			expect(request.origin).toBe(origin);
			expect(request.secFetchSite).toBe("same-origin");
			expect(request.csrf).toBe("1");
		}
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
