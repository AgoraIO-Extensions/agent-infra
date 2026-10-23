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
import { expectFocusSettled } from "./page-health";
import { duplicateControlNames } from "./page-hygiene";
import { expectCleanPage, trackPageErrors } from "./primitive-styles";

const conversationId = "conversation-1";
const limitsPath = "/api/v2/agents/agent-1/file-limits";
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
	// CH-03：附件入口在默认收起的「会话文件」折叠条内，需要用户先展开。
	const files = page.getByRole("button", { name: /^会话文件/ });
	await expect(files).toHaveAttribute("aria-expanded", "false");
	await expect(files).toContainText("0 个文件 · 0 个待重试");
	await files.click();
	await expect(files).toHaveAttribute("aria-expanded", "true");
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
	await picker.focus();
	await expect(picker).toBeFocused();
	await picker.press("Enter");
	await (await chooser).setFiles({
		name: "notes.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("hello"),
	});
	// #3267：附件区新增一个状态变化播报区（「notes.txt 已上传」），行内状态按整段文字匹配。
	await expect(page.getByText("已上传", { exact: true })).toBeVisible();
	await expect(files).toContainText("1 个文件 · 0 个待重试");
	await page.getByRole("textbox", { name: "消息" }).fill("请查看附件");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect
		.poll(() => fixture.submitted())
		.toEqual({ schemaVersion: 1, text: "请查看附件", attachments: ["file-1"] });
	expect(
		fixture.requests.filter((request) => request.endsWith("/file-limits")),
	).toEqual([`GET ${limitsPath}`]);
});

test("closes the attachment entry when the read-only limits request fails", async ({
	page,
}) => {
	const fixture = await conversationFixture(page, 500);
	// 收起状态的摘要直接反映失败（CH-03 AC-2）；展开后看到原因与禁用的入口。
	const files = page.getByRole("button", { name: /^会话文件/ });
	await expect(files).toContainText("上传暂不可用");
	await expect(files).not.toContainText("0 个待重试");
	await files.click();
	await expect(
		page.getByText("文件限制暂不可用，上传入口已关闭。"),
	).toBeVisible();
	// #3267 N8-1-06：不能上传时只留一行说明，不再渲染禁用的「添加附件」（与 #3259 同一规则）。
	await expect(
		page.locator('button[data-slot="button"]', { hasText: "添加附件" }),
	).toHaveCount(0);
	expect(
		fixture.requests.filter((request) => request.endsWith("/file-limits")),
	).toEqual([`GET ${limitsPath}`]);
});

const viewports = [
	{ width: 1440, height: 900 },
	{ width: 390, height: 844 },
] as const;
const rowLimitCopy = "支持 text/plain, image/png，单文件最大 4 KB";
// 1×1 PNG：图片附件的本地缩略图需要可解码的内容。
const onePixelPng = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

/**
 * #3267：附件行的受控上传链。上传按文件名受控：`hold` 的内容写入等待 `releaseUpload()`，`fail` /
 * `expired` 首次分别得到 500 / 403（上传失败 / 授权过期），重试成功；会话限制只接受
 * text/plain 与 image/png、单文件 4 KB，便于构造类型与大小的预检拒绝。
 */
async function attachmentRowsFixture(
	page: import("@playwright/test").Page,
	limits: "ready" | "pending" | "error" = "ready",
) {
	const requests: string[] = [];
	const attempts = new Map<string, number>();
	let releaseLimits: () => void = () => undefined;
	const limitsHeld = new Promise<void>((resolve) => {
		releaseLimits = resolve;
	});
	let releaseUpload: () => void = () => undefined;
	const uploadHeld = new Promise<void>((resolve) => {
		releaseUpload = resolve;
	});
	const projection = (name: string, mediaType: string) => ({
		...attachment,
		fileId: `file-${name}`,
		descriptor: { ...attachment.descriptor, name, mediaType },
	});
	const limitsBody = () => {
		const body = controlledFileLimits();
		return {
			...body,
			declaration: {
				...body.declaration,
				mediaTypes: ["text/plain", "image/png"],
				maxBytes: 4096,
			},
		};
	};
	await keepConversationStreamOpen(page);
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		requests.push(`${request.method()} ${path}`);
		if (path === limitsPath) {
			if (limits === "pending") {
				await limitsHeld;
				return route.fulfill({ json: limitsBody() }).catch(() => {});
			}
			return limits === "ready"
				? route.fulfill({ json: limitsBody() })
				: route.fulfill({
						status: 503,
						json: { message: "controlled limits failure" },
					});
		}
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
		if (request.method() === "POST" && path.endsWith("/files")) {
			const descriptor = request.postDataJSON().descriptor as {
				name: string;
				mediaType: string;
			};
			const attempt = (attempts.get(descriptor.name) ?? 0) + 1;
			attempts.set(descriptor.name, attempt);
			if (attempt === 1 && descriptor.name.startsWith("fail"))
				return route.fulfill({
					status: 500,
					json: { message: "controlled upload failure" },
				});
			if (attempt === 1 && descriptor.name.startsWith("expired"))
				return route.fulfill({
					status: 403,
					json: { message: "controlled grant expiry" },
				});
			return route.fulfill({
				status: 201,
				json: projection(descriptor.name, descriptor.mediaType),
			});
		}
		if (request.method() === "POST" && path.endsWith("/access")) {
			const fileId = path.split("/").at(-2) ?? "";
			return route.fulfill({
				json: {
					schemaVersion: 1,
					accessId: `access-${fileId}`,
					file: { ...attachment, fileId },
					path: path.replace(/\/access$/, "/content"),
					grant: { format: "compact-jws", schemaVersion: 1, token: "grant" },
					expiresAt: "2027-01-01T00:00:00Z",
				},
			});
		}
		if (request.method() === "PUT" && path.endsWith("/content")) {
			if (path.includes("/file-hold")) await uploadHeld;
			return route.fulfill({ status: 204, body: "" }).catch(() => {});
		}
		if (request.method() === "POST" && path.endsWith("/complete")) {
			const fileId = path.split("/").at(-2) ?? "";
			return route.fulfill({ json: { ...attachment, fileId } });
		}
		return route.fulfill({ json: { items: [], nextCursor: null } });
	});
	await page.goto(`/chat/agent-1/${conversationId}`);
	const files = page.getByRole("button", { name: /^会话文件/ });
	await files.click();
	await expect(files).toHaveAttribute("aria-expanded", "true");
	return {
		files,
		picker: page.getByTestId("conversation-file-picker"),
		requests,
		releaseLimits: () => releaseLimits(),
		releaseUpload: () => releaseUpload(),
	};
}

/** 文字的计算字号、字重，以及颜色是否等于同页某个变量。 */
async function textStyle(
	locator: import("@playwright/test").Locator,
	colorVariable: string,
) {
	return locator.evaluate((node, variable) => {
		const probe = document.createElement("span");
		probe.style.color = `var(${variable})`;
		document.body.append(probe);
		const expected = getComputedStyle(probe).color;
		probe.remove();
		const style = getComputedStyle(node);
		return {
			fontSize: style.fontSize,
			fontWeight: style.fontWeight,
			color: style.color === expected,
		};
	}, colorVariable);
}

async function inLiveRegion(locator: import("@playwright/test").Locator) {
	return locator.evaluate((node) =>
		Boolean(node.closest('[role="status"], [role="alert"], [aria-live]')),
	);
}

for (const viewport of viewports) {
	for (const [state, copy] of [
		["pending", "正在读取文件限制…"],
		["error", "文件限制暂不可用，上传入口已关闭。"],
	] as const) {
		test(`keeps one static line without an entry when the limits are ${state} at ${viewport.width} by ${viewport.height} (#3267 N8-1-06)`, async ({
			page,
		}, info) => {
			test.skip(info.project.name !== "desktop", "Viewport list runs once.");
			await page.setViewportSize(viewport);
			const errors = trackPageErrors(page);
			const fixture = await attachmentRowsFixture(page, state);
			const notice = fixture.picker.getByText(copy, { exact: true });
			await expect(notice).toBeVisible();
			await expect(fixture.picker).toHaveText(copy);
			await expect(page.getByRole("button", { name: "添加附件" })).toHaveCount(
				0,
			);
			await expect(page.getByLabel("选择附件文件")).toHaveCount(0);
			expect(await inLiveRegion(notice)).toBe(false);
			await expect(fixture.picker.locator('[role="status"]')).toHaveText("");
			// 单行说明与 Skill 控制文件同为 12px `--muted-ink`。
			expect(await textStyle(notice, "--muted-ink")).toEqual({
				fontSize: "12px",
				fontWeight: "400",
				color: true,
			});
			expect(await duplicateControlNames(page)).toEqual([]);
			await expectCleanPage(page, errors);
			fixture.releaseLimits();
		});
	}

	test(`lays out attachment rows as cards with visible names, reasons and focus kept off body at ${viewport.width} by ${viewport.height} (#3267 N8-1-05–N8-1-07)`, async ({
		page,
	}, info) => {
		test.skip(info.project.name !== "desktop", "Viewport list runs once.");
		await page.setViewportSize(viewport);
		const errors = trackPageErrors(page);
		const fixture = await attachmentRowsFixture(page);
		const { picker } = fixture;
		const add = page.getByRole("button", { name: "添加附件" });
		await expect(add).toBeVisible();
		const limit = picker.getByText(rowLimitCopy, { exact: true });
		await expect(limit).toBeVisible();
		expect(await inLiveRegion(limit)).toBe(false);
		expect(await textStyle(limit, "--muted-ink")).toEqual({
			fontSize: "11px",
			fontWeight: "400",
			color: true,
		});
		await expect(add).toHaveAttribute(
			"aria-describedby",
			(await limit.getAttribute("id")) ?? "missing",
		);
		// 隐藏文件输入与可见按钮不同名：展开会话文件后同页没有同名控件。
		await expect(page.getByLabel("选择附件文件")).toHaveCount(1);
		expect(await duplicateControlNames(page)).toEqual([]);
		const chooser = page.waitForEvent("filechooser");
		await add.click();
		await (await chooser).setFiles([
			{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("x") },
			{ name: "hold.txt", mimeType: "text/plain", buffer: Buffer.from("x") },
			{ name: "fail.txt", mimeType: "text/plain", buffer: Buffer.from("x") },
			{
				name: "fail-shot.png",
				mimeType: "image/png",
				buffer: onePixelPng,
			},
			{
				name: "expired.txt",
				mimeType: "text/plain",
				buffer: Buffer.from("x"),
			},
			{
				name: "archive.zip",
				mimeType: "application/zip",
				buffer: Buffer.from("x"),
			},
			{
				name: "big.txt",
				mimeType: "text/plain",
				buffer: Buffer.alloc(5000, "x"),
			},
			{
				name: "latin1.txt",
				mimeType: "text/plain",
				buffer: Buffer.from([0x63, 0x61, 0x66, 0xe9]),
			},
		]);
		const rows = picker.getByRole("listitem");
		await expect(rows).toHaveCount(8);
		const row = (name: string) => rows.filter({ hasText: name });
		await expect(row("a.txt")).toHaveAttribute("data-file-status", "available");
		await expect(row("hold.txt")).toHaveAttribute(
			"data-file-status",
			"uploading",
		);
		const reasons = {
			"fail.txt": "上传失败，请重试。",
			"fail-shot.png": "上传失败，请重试。",
			"expired.txt": "上传授权已过期，请重试。",
			"archive.zip": "当前 Agent 不支持此文件类型。",
			"big.txt": "文件超过 4 KB 限制。",
			"latin1.txt": "文件内容不是有效的 UTF-8 文本，与文件类型不符。",
		} as const;
		for (const [name, reason] of Object.entries(reasons))
			await expect(row(name).getByRole("alert")).toHaveText(reason);
		// 摘要只把可重试的失败算作「待重试」，预检拒绝与非 UTF-8 文本另计「无法上传」。
		await expect(fixture.files).toContainText(
			"8 个文件 · 3 个待重试 · 3 个无法上传",
		);
		// 行内状态不是 live region；区块只有一个常驻播报区。
		await expect(rows.locator('[role="status"]')).toHaveCount(0);
		await expect(picker.locator('[role="status"]')).toHaveCount(1);
		// 只有可重试的失败有「重试：{文件名}」；预检拒绝与非 UTF-8 文本只能移除。
		for (const name of ["fail.txt", "fail-shot.png", "expired.txt"])
			await expect(
				page.getByRole("button", { name: `重试：${name}` }),
			).toBeVisible();
		for (const name of ["archive.zip", "big.txt", "latin1.txt"]) {
			await expect(
				row(name).getByRole("button", { name: /^重试/ }),
			).toHaveCount(0);
			await expect(
				page.getByRole("button", { name: `移除附件 ${name}` }),
			).toBeVisible();
		}
		// 导出稿 .chat-file-row：行卡与名称、状态的规格；每行名称完整可见、不被挤没。
		const rowStyle = await row("fail.txt").evaluate((node) => {
			const style = getComputedStyle(node);
			const probe = document.createElement("div");
			probe.style.backgroundColor = "var(--surface-raised)";
			document.body.append(probe);
			const raised = getComputedStyle(probe).backgroundColor;
			probe.remove();
			return {
				borderWidth: style.borderTopWidth,
				borderRadius: style.borderTopLeftRadius,
				padding: style.padding,
				raised: style.backgroundColor === raised,
				alignItems: style.alignItems,
			};
		});
		expect(rowStyle).toEqual({
			borderWidth: "1px",
			borderRadius: "9px",
			padding: "8px",
			raised: true,
			alignItems: viewport.width <= 767 ? "flex-start" : "center",
		});
		for (const name of Object.keys(reasons).concat(["a.txt", "hold.txt"])) {
			const geometry = await row(name).evaluate((node) => {
				const label = node.querySelector(".conversation-file-name");
				const icon = node.querySelector(":scope > svg, :scope > img");
				const list = node.closest('[data-testid="conversation-file-picker"]');
				if (!label || !icon || !list) throw new Error("Expected row parts");
				const text = label.getBoundingClientRect();
				const box = node.getBoundingClientRect();
				const outer = list.getBoundingClientRect();
				const style = getComputedStyle(label);
				return {
					labelWidth: text.width,
					fullName: label.scrollWidth <= label.clientWidth + 0.5,
					iconWidth: icon.getBoundingClientRect().width,
					inside:
						box.left >= outer.left - 0.5 && box.right <= outer.right + 0.5,
					fontSize: style.fontSize,
					fontWeight: style.fontWeight,
				};
			});
			expect(geometry, name).toEqual({
				labelWidth: expect.any(Number),
				fullName: true,
				iconWidth: name.endsWith(".png") ? 40 : 16,
				inside: true,
				fontSize: "12px",
				fontWeight: "700",
			});
			expect(geometry.labelWidth, name).toBeGreaterThan(40);
		}
		expect(
			await textStyle(row("a.txt").locator("small"), "--muted-ink"),
		).toEqual({ fontSize: "11px", fontWeight: "400", color: true });
		expect(
			await textStyle(row("fail.txt").getByRole("alert"), "--danger-ink"),
		).toMatchObject({ fontSize: "11px", color: true });
		// 「重试」沿导出稿为 outline，保持 44px 触达下限。
		const retry = page.getByRole("button", { name: "重试：fail.txt" });
		const retryBox = await retry.evaluate((node) => {
			const style = getComputedStyle(node);
			return {
				height: node.getBoundingClientRect().height,
				border: style.borderTopWidth,
			};
		});
		expect(retryBox).toEqual({ height: 44, border: "1px" });
		expect(await duplicateControlNames(page)).toEqual([]);
		await expectCleanPage(page, errors);
		await info.attach(`conversation-file-rows-${viewport.width}`, {
			body: await page.screenshot({ animations: "disabled" }),
			contentType: "image/png",
		});
		// 上传完成只在状态变化时播报。
		fixture.releaseUpload();
		await expect(row("hold.txt")).toHaveAttribute(
			"data-file-status",
			"available",
		);
		await expect(picker.locator('[role="status"]')).toHaveText(
			"hold.txt 已上传",
		);
		// 键盘重试：「重试」随失败状态卸载，焦点到同一行的移除按钮，不落到 body。
		await retry.focus();
		await page.keyboard.press("Enter");
		await expect(row("fail.txt")).toHaveAttribute(
			"data-file-status",
			"available",
		);
		await expectFocusSettled(
			page.getByRole("button", { name: "移除附件 fail.txt" }),
			"附件重试",
		);
		// 移除：行卸载后焦点回到「添加附件」，播报移除结果。
		await page.getByRole("button", { name: "移除附件 archive.zip" }).focus();
		await page.keyboard.press("Enter");
		await expect(rows).toHaveCount(7);
		await expectFocusSettled(add, "移除附件");
		await expect(picker.locator('[role="status"]')).toHaveText(
			"已移除 archive.zip",
		);
		expect(await duplicateControlNames(page)).toEqual([]);
		await expectCleanPage(page, errors);
		// 被拒的文件没有发出上传请求；fail.txt 重试一次。
		const created = fixture.requests.filter(
			(request) => request.startsWith("POST") && request.endsWith("/files"),
		);
		expect(created).toHaveLength(6);
	});
}
