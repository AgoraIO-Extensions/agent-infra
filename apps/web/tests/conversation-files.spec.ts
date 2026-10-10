import {
	AgentProjectionV2Schema,
	CommandAcceptedProjectionV1Schema,
	ConnectionCapabilityProjectionV1Schema,
	ConversationDetailProjectionV2Schema,
	ConversationPageV1Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { expect, test } from "@playwright/test";
import { history } from "../src/features/conversation/conversation-test-fixtures";
import { keepConversationStreamOpen } from "./conversation-stream";
import { controlledFileLimits } from "./file-limits";

const conversationId = "conversation-1";
const limitsPath = `/api/v1/conversations/${conversationId}/files/limits`;
const attachment = {
	schemaVersion: 1,
	fileId: "file-1",
	kind: "attachment",
	descriptor: {
		name: "notes.txt",
		mediaType: "text/plain",
		sizeBytes: 5,
		sha256: "a".repeat(64),
	},
	status: "available",
	createdAt: "2026-09-28T02:00:00Z",
	expiresAt: "2027-01-01T00:00:00Z",
} as const;

/** Serves the read-only limits plus the controlled upload chain. */
async function conversationFixture(
	page: import("@playwright/test").Page,
	limitsStatus: number,
) {
	const requests: string[] = [];
	let submitted: unknown;
	await keepConversationStreamOpen(page);
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		requests.push(`${request.method()} ${path}`);
		if (path === limitsPath)
			return limitsStatus === 200
				? route.fulfill({ json: controlledFileLimits() })
				: route.fulfill({
						status: limitsStatus,
						json: { message: "controlled limits failure" },
					});
		if (path === "/api/v1/connection/capability")
			return route.fulfill({
				json: ConnectionCapabilityProjectionV1Schema.parse({
					schemaVersion: 1,
					status: "unavailable",
					reason: "missing",
				}),
			});
		if (path.endsWith("/session"))
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
		if (path === "/api/v2/me/conversations/recent")
			return route.fulfill({
				json: ConversationPageV1Schema.parse({ items: [], nextCursor: null }),
			});
		if (path === "/api/v2/agents/agent-1")
			return route.fulfill({
				json: AgentProjectionV2Schema.parse({
					...pilotFakeScenariosV2.starting.response.body,
					agentId: "agent-1",
					managementStatus: "available",
					serviceAvailability: "ready",
				}),
			});
		if (path === `/api/v2/conversations/${conversationId}`)
			return route.fulfill({
				json: ConversationDetailProjectionV2Schema.parse({
					...history(conversationId, []),
					conversation: { ...history().conversation, status: "ready" },
				}),
			});
		if (path.endsWith("/events"))
			return route.fulfill({
				contentType: "text/event-stream",
				body: ": heartbeat\n\n",
			});
		if (request.method() === "POST" && path.endsWith("/files"))
			return route.fulfill({ status: 201, json: attachment });
		if (request.method() === "POST" && path.endsWith("/access"))
			return route.fulfill({
				json: {
					schemaVersion: 1,
					accessId: "access-1",
					file: attachment,
					path: `/api/v1/conversations/${conversationId}/files/file-1/content`,
					grant: { format: "compact-jws", schemaVersion: 1, token: "grant" },
					expiresAt: "2027-01-01T00:00:00Z",
				},
			});
		if (request.method() === "PUT" && path.endsWith("/content"))
			return route.fulfill({ status: 204, body: "" });
		if (request.method() === "POST" && path.endsWith("/complete"))
			return route.fulfill({ json: attachment });
		if (request.method() === "POST" && path.endsWith("/messages")) {
			submitted = request.postDataJSON();
			return route.fulfill({
				status: 202,
				json: CommandAcceptedProjectionV1Schema.parse({
					schemaVersion: 1,
					executionId: "execution-1",
					messageId: "message-1",
					status: "submitted",
				}),
			});
		}
		return route.fulfill({ json: { items: [], nextCursor: null } });
	});
	await page.goto(
		`/agents/agent-1/conversations?conversation=${conversationId}`,
	);
	return { requests, submitted: () => submitted };
}

test("reads the read-only limits, uploads one attachment and keeps narrow layouts inside the viewport", async ({
	page,
}) => {
	const fixture = await conversationFixture(page, 200);
	// The visually hidden file input is also exposed as a button, so scope the
	// trigger to the rendered control.
	const picker = page.locator('button[data-slot="button"]', {
		hasText: "添加附件",
	});
	await expect(picker).toBeEnabled();
	await expect(
		page.getByText("支持 text/plain, application/pdf，单文件最大 10.0 MB"),
	).toBeVisible();
	const viewport = page.viewportSize();
	await page.setViewportSize({ width: 360, height: 800 });
	await expect
		.poll(
			() =>
				page.evaluate(
					() =>
						Math.max(
							document.documentElement.scrollWidth,
							document.body.scrollWidth,
						) <= innerWidth,
				),
			{ message: "the file picker must not add horizontal overflow" },
		)
		.toBe(true);
	if (viewport) await page.setViewportSize(viewport);
	const chooser = page.waitForEvent("filechooser");
	await picker.click();
	await (await chooser).setFiles({
		name: "notes.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("hello"),
	});
	await expect(page.getByText("已上传")).toBeVisible();
	await page.getByRole("textbox", { name: "消息" }).fill("请查看附件");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect
		.poll(() => fixture.submitted())
		.toEqual({ schemaVersion: 1, text: "请查看附件", attachments: ["file-1"] });
	expect(
		fixture.requests.filter((request) => request.endsWith("/files/limits")),
	).toEqual([`GET ${limitsPath}`]);
});

test("closes the attachment entry when the read-only limits request fails", async ({
	page,
}) => {
	const fixture = await conversationFixture(page, 500);
	await expect(
		page.getByText("文件限制暂不可用，上传入口已关闭。"),
	).toBeVisible();
	await expect(
		page.locator('button[data-slot="button"]', { hasText: "添加附件" }),
	).toBeDisabled();
	expect(
		fixture.requests.filter((request) => request.endsWith("/files/limits")),
	).toEqual([`GET ${limitsPath}`]);
});
