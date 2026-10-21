import {
	AgentProjectionV2Schema,
	ConversationDetailProjectionV2Schema,
	ConversationPageV1Schema,
	PersistedConversationEventV2Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { expect, test } from "@playwright/test";
import {
	event,
	history,
} from "../src/features/conversation/conversation-test-fixtures";

// This is a browser interaction contract test with bounded API fixtures. It proves
// the Web preview/link/upload experience; Runtime and File Core evidence remains separate.
test("previews a diff artifact, keeps safe links clickable and shows an image upload thumbnail", async ({
	page,
}) => {
	const conversationId = "conversation-1";
	const resultEvent = PersistedConversationEventV2Schema.parse({
		...event(2, conversationId),
		type: "result.file",
		payload: {
			fileId: "result-1",
			name: "changes.diff",
			mediaType: "text/x-diff",
			sizeBytes: 42,
		},
	});
	const detail = ConversationDetailProjectionV2Schema.parse({
		...history(conversationId, [resultEvent]),
		conversation: {
			...history(conversationId, []).conversation,
			status: "ready",
		},
		messages: [
			{
				messageId: "question-1",
				role: "user",
				text: "请查看产物",
				status: "completed",
				executionId: "execution-1",
				replyToMessageId: null,
				answerVersion: null,
				isCurrentAnswer: null,
				error: null,
				createdAt: "2026-10-21T00:00:00Z",
			},
			{
				messageId: "answer-1",
				role: "assistant",
				text: "[文档](https://example.com/docs?tab=api#auth)",
				status: "completed",
				executionId: "execution-1",
				replyToMessageId: "question-1",
				answerVersion: 1,
				isCurrentAnswer: true,
				error: null,
				createdAt: "2026-10-21T00:00:00Z",
			},
		],
	});
	const agent = AgentProjectionV2Schema.parse({
		...pilotFakeScenariosV2.starting.response.body,
		agentId: "agent-1",
		managementStatus: "available",
		serviceAvailability: "ready",
		capabilities: {
			...pilotFakeScenariosV2.starting.response.body.capabilities,
			attachments: true,
			resultFiles: true,
		},
	});
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path.endsWith("/files/limits"))
			return route.fulfill({
				json: {
					schemaVersion: 1,
					revision: "files-v1",
					expiresAt: "2099-01-01T00:00:00Z",
					mediaTypes: ["image/png", "text/plain"],
					maxBytes: 10 * 1024 * 1024,
				},
			});
		if (path === "/api/v1/session")
			return route.fulfill({
				json: {
					schemaVersion: 1,
					user: {
						userId: "user-1",
						displayName: "验收用户",
						roles: ["employee"],
					},
				},
			});
		if (path === "/api/v2/me/conversations/recent")
			return route.fulfill({
				json: ConversationPageV1Schema.parse({ items: [], nextCursor: null }),
			});
		if (path === "/api/v2/agents/agent-1")
			return route.fulfill({ json: agent });
		if (path === `/api/v2/conversations/${conversationId}`)
			return route.fulfill({ json: detail });
		if (path.endsWith("/events"))
			return route.fulfill({
				contentType: "text/event-stream",
				body: ": heartbeat\n\n",
			});
		if (path.endsWith("/files/result-1/access"))
			return route.fulfill({
				json: {
					schemaVersion: 1,
					accessId: "read-access-1",
					file: {
						schemaVersion: 1,
						fileId: "result-1",
						kind: "result",
						descriptor: {
							name: "changes.diff",
							mediaType: "text/x-diff",
							sizeBytes: 42,
							sha256: "a".repeat(64),
						},
						status: "available",
						createdAt: "2026-10-21T00:00:00Z",
						expiresAt: "2099-01-01T00:00:00Z",
					},
					path: `/api/v1/conversations/${conversationId}/files/result-1/content`,
					grant: {
						format: "compact-jws",
						schemaVersion: 1,
						token: "read-grant",
					},
					expiresAt: "2099-01-01T00:00:00Z",
				},
			});
		if (path.endsWith("/files/result-1/content"))
			return route.fulfill({
				contentType: "text/x-diff",
				body: "@@ -1 +1 @@\n-old\n+new",
			});
		if (request.method() === "POST" && path.endsWith("/files"))
			return route.fulfill({
				status: 201,
				json: {
					schemaVersion: 1,
					fileId: "upload-1",
					kind: "attachment",
					descriptor: {
						name: "screen.png",
						mediaType: "image/png",
						sizeBytes: 3,
						sha256: "b".repeat(64),
					},
					status: "pending",
					createdAt: "2026-10-21T00:00:00Z",
					expiresAt: "2099-01-01T00:00:00Z",
				},
			});
		if (request.method() === "POST" && path.endsWith("/files/upload-1/access"))
			return route.fulfill({
				json: {
					schemaVersion: 1,
					accessId: "write-access-1",
					file: {
						schemaVersion: 1,
						fileId: "upload-1",
						kind: "attachment",
						descriptor: {
							name: "screen.png",
							mediaType: "image/png",
							sizeBytes: 3,
							sha256: "b".repeat(64),
						},
						status: "pending",
						createdAt: "2026-10-21T00:00:00Z",
						expiresAt: "2099-01-01T00:00:00Z",
					},
					path: `/api/v1/conversations/${conversationId}/files/upload-1/content`,
					grant: {
						format: "compact-jws",
						schemaVersion: 1,
						token: "write-grant",
					},
					expiresAt: "2099-01-01T00:00:00Z",
				},
			});
		if (request.method() === "PUT" && path.endsWith("/files/upload-1/content"))
			return route.fulfill({ status: 204 });
		if (
			request.method() === "POST" &&
			path.endsWith("/files/upload-1/complete")
		)
			return route.fulfill({
				json: {
					schemaVersion: 1,
					fileId: "upload-1",
					kind: "attachment",
					descriptor: {
						name: "screen.png",
						mediaType: "image/png",
						sizeBytes: 3,
						sha256: "b".repeat(64),
					},
					status: "available",
					createdAt: "2026-10-21T00:00:00Z",
					expiresAt: "2099-01-01T00:00:00Z",
				},
			});
		return route.fulfill({ json: { items: [], nextCursor: null } });
	});

	await page.goto(
		`/agents/agent-1/conversations?conversation=${conversationId}`,
	);
	await expect(page.getByRole("link", { name: "文档" })).toHaveAttribute(
		"href",
		"https://example.com/docs?tab=api#auth",
	);
	await page.getByRole("button", { name: "预览" }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(page.getByText("+1 新增")).toBeVisible();
	await page.getByRole("button", { name: "关闭", exact: true }).click();

	await page.getByRole("button", { name: /^会话文件/ }).click();
	const chooser = page.waitForEvent("filechooser");
	await page
		.locator('button[data-slot="button"]', { hasText: "添加附件" })
		.click();
	await (await chooser).setFiles({
		name: "screen.png",
		mimeType: "image/png",
		buffer: Buffer.from("png"),
	});
	await expect(page.locator('img[src^="blob:"]')).toHaveCount(1);
});
