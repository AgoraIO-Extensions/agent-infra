import {
	AgentProjectionV2Schema,
	ConversationDetailProjectionV2Schema,
	ConversationPageV1Schema,
	PersistedConversationEventV2Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import {
	event,
	history,
} from "../src/features/conversation/conversation-test-fixtures";
import {
	expectFocusableBusy,
	expectFocusHeld,
	expectFocusSettled,
	holdRequests,
	pinElement,
} from "./page-health";
import { expectCleanPage, trackPageErrors } from "./primitive-styles";

// This is a browser interaction contract test with bounded API fixtures. It proves
// the Web preview/link/upload experience; Runtime and File Core evidence remains separate.
const conversationId = "conversation-1";

/**
 * 受控会话：一条带 diff 结果文件的回答，以及读取、上传结果文件的受控 File Grant 链路。
 * sandboxCard 时结果文件带 workspaceReference，回答以 `sandbox:` 引用它，显示为回答内文件卡（#3228）。
 */
async function artifactFixture(page: Page, { sandboxCard = false } = {}) {
	const resultEvent = PersistedConversationEventV2Schema.parse({
		...event(2, conversationId),
		type: "result.file",
		...(sandboxCard ? { schemaVersion: 2 } : {}),
		payload: {
			fileId: "result-1",
			name: "changes.diff",
			mediaType: "text/x-diff",
			sizeBytes: 42,
			...(sandboxCard ? { workspaceReference: "out/changes.diff" } : {}),
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
				text: sandboxCard
					? "变更见[本次变更](sandbox:out/changes.diff)。"
					: "[文档](https://example.com/docs?tab=api#auth)",
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
	const imageFileLimits = {
		schemaVersion: 1,
		declaration: {
			schemaVersion: 1,
			scope: "agent" as const,
			revision: 1,
			expiresAt: "2099-01-01T00:00:00Z",
			mediaTypes: ["image/png", "text/plain"] as const,
			maxBytes: 10 * 1024 * 1024,
			updatedAt: "2026-01-01T00:00:00Z",
			updatedBy: "controlled-employee",
		},
	};
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path.endsWith("/file-limits"))
			return route.fulfill({ json: imageFileLimits });
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
}

test("previews a diff artifact, keeps safe links clickable and shows an image upload thumbnail", async ({
	page,
}) => {
	await artifactFixture(page);
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

// #3242 K7-02：结果文件「预览」「下载」准备期间是可聚焦的禁用（aria-disabled）。「预览」随点击打开预览
// 弹窗，准备期间焦点在弹窗上（D2-59：弹窗打开时聚焦弹窗容器），弹窗关闭后回到「预览」；「下载」挂起
// 期间多次采样焦点都在按钮上，下载完成后留在「下载」，都不落到 body。
test("result file preview and download keep focus on the pending button (K7-02)", async ({
	page,
}, info: TestInfo) => {
	await page.setViewportSize(
		info.project.name === "mobile"
			? { width: 390, height: 844 }
			: { width: 1440, height: 900 },
	);
	const errors = trackPageErrors(page);
	await artifactFixture(page);
	const preview = await pinElement(
		page.getByRole("button", { name: "预览" }),
		"preview-result",
	);
	let access = await holdRequests(page, "POST", /\/files\/result-1\/access$/);
	await preview.focus();
	await page.keyboard.press("Enter");
	await expect(preview).toHaveText("准备预览…");
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByText("正在准备预览…")).toBeVisible();
	await expect(preview).toHaveAttribute("aria-disabled", "true");
	expect(
		await preview.evaluate(
			(element) => (element as HTMLButtonElement).disabled,
		),
	).toBe(false);
	await expectFocusHeld(dialog, [30, 150, 400, 1000], "准备预览 进行中");
	access.release();
	await expect(dialog.getByText("+1 新增")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expectFocusSettled(preview, "预览关闭");

	const download = await pinElement(
		page.getByRole("button", { name: "下载" }),
		"download-result",
	);
	access = await holdRequests(page, "POST", /\/files\/result-1\/access$/);
	await download.focus();
	await page.keyboard.press("Enter");
	await expect(download).toHaveText("准备下载…");
	await expectFocusableBusy(download, "准备下载");
	access.release();
	await expect(download).toHaveText("下载");
	await expectFocusSettled(download, "下载完成");
	await expectCleanPage(page, errors);
});

// #3242 K7-02：回答内文件卡（#3228）的「预览」「下载」与结果文件列表同样是可聚焦的禁用：「预览」打开预览
// 弹窗，准备期间焦点在弹窗上，关闭后回到文件卡的「预览」；「下载」挂起期间多次采样焦点都在按钮上。
test("answer file card preview and download keep focus off body (K7-02)", async ({
	page,
}, info: TestInfo) => {
	await page.setViewportSize(
		info.project.name === "mobile"
			? { width: 390, height: 844 }
			: { width: 1440, height: 900 },
	);
	const errors = trackPageErrors(page);
	await artifactFixture(page, { sandboxCard: true });
	const card = page.getByRole("group", { name: "结果文件：changes.diff" });
	await expect(card).toBeVisible();
	const preview = await pinElement(
		card.getByRole("button", { name: "预览：changes.diff" }),
		"card-preview",
	);
	let access = await holdRequests(page, "POST", /\/files\/result-1\/access$/);
	await preview.focus();
	await page.keyboard.press("Enter");
	// 预览弹窗打开后背景 inert，可访问名称算不出来，直接比对 aria-label。
	await expect(preview).toHaveAttribute(
		"aria-label",
		"准备预览…：changes.diff",
	);
	await expect(preview).toHaveAttribute("aria-disabled", "true");
	expect(
		await preview.evaluate(
			(element) => (element as HTMLButtonElement).disabled,
		),
	).toBe(false);
	const dialog = page.getByRole("dialog");
	await expectFocusHeld(dialog, [30, 150, 400, 1000], "文件卡 准备预览");
	access.release();
	await expect(dialog.getByText("+1 新增")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expectFocusSettled(preview, "文件卡 预览关闭");

	const download = await pinElement(
		card.getByRole("button", { name: "下载：changes.diff" }),
		"card-download",
	);
	access = await holdRequests(page, "POST", /\/files\/result-1\/access$/);
	await download.focus();
	await page.keyboard.press("Enter");
	await expect(download).toHaveAccessibleName("准备下载…：changes.diff");
	await expectFocusableBusy(download, "文件卡 准备下载");
	access.release();
	await expect(download).toHaveAccessibleName("下载：changes.diff");
	await expectFocusSettled(download, "文件卡 下载完成");
	await expectCleanPage(page, errors);
});

// #3267 N8-1-08（导出稿缺失）：预览读取中用公共 LoadingLine（spinner + 文字，role="status"），读取失败的
// Alert 为 role="alert"；「重新读取」随读取中卸载时焦点交给弹窗，仍失败时回到新的「重新读取」，
// 成功后留在弹窗上，都不落到 body。
test("preview read failure is an alert and loading uses LoadingLine with focus kept off body (#3267 N8-1-08)", async ({
	page,
}, info: TestInfo) => {
	await page.setViewportSize(
		info.project.name === "mobile"
			? { width: 390, height: 844 }
			: { width: 1440, height: 900 },
	);
	const errors = trackPageErrors(page);
	await artifactFixture(page);
	// 前两次读取授权被拒（读取失败），第三次放行；第一次重试挂起，用于采样读取中的焦点。
	let attempts = 0;
	await page.route(/\/files\/result-1\/access$/, (route) => {
		attempts += 1;
		return attempts <= 2
			? route.fulfill({ status: 403, json: { message: "controlled denial" } })
			: route.fallback();
	});
	const preview = page.getByRole("button", { name: "预览" });
	await preview.focus();
	await page.keyboard.press("Enter");
	const dialog = page.getByRole("dialog");
	const failure = dialog.getByRole("alert");
	await expect(failure).toContainText("文件读取失败，请重试。");
	const retry = dialog.getByRole("button", { name: "重新读取" });
	await expect(retry).toBeVisible();
	// 第一次重试：仍失败，焦点回到新的「重新读取」。
	const held = await holdRequests(page, "POST", /\/files\/result-1\/access$/);
	await retry.focus();
	await page.keyboard.press("Enter");
	const loading = dialog.locator('[data-slot="loading-line"]');
	await expect(loading).toHaveText("正在准备预览…");
	await expect(loading).toHaveAttribute("role", "status");
	await expect(loading.locator('[data-slot="spinner"]')).toHaveCount(1);
	await expectFocusHeld(dialog, [30, 150, 400], "重新读取 进行中");
	held.release();
	await expect(failure).toContainText("文件读取失败，请重试。");
	await expectFocusSettled(retry, "重新读取仍失败");
	// 第二次重试成功：焦点留在弹窗上。
	await page.keyboard.press("Enter");
	await expect(dialog.getByText("+1 新增")).toBeVisible();
	await expect(dialog.getByRole("alert")).toHaveCount(0);
	await expectFocusSettled(dialog, "重新读取成功");
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expectFocusSettled(preview, "预览关闭");
	await expectCleanPage(page, errors);
});
