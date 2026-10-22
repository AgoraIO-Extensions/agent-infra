import { deflateSync } from "node:zlib";
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
	timestamp,
} from "../src/features/conversation/conversation-test-fixtures";
import { controlledFileLimits, isFileLimitsRequest } from "./file-limits";
import { duplicateControlNames } from "./page-hygiene";
import { expectCleanPage, trackPageErrors } from "./primitive-styles";

// #3228：浏览器交互契约测试，API 为有界 fixture。证明回答内 `sandbox:` 引用在真实布局中
// 内联显示、文件卡可用且桌面与移动端不溢出；Runtime 发布与 File Core 授权由各自测试证明。

/** 生成单色 PNG：宽于消息区，用于确认内联图片被限制在有界尺寸内。 */
function png(width: number, height: number) {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (bytes: Buffer) => {
		let c = 0xffffffff;
		for (const byte of bytes)
			c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const sum = Buffer.alloc(4);
		sum.writeUInt32BE(crc(body));
		return Buffer.concat([length, body, sum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const row = Buffer.concat([
		Buffer.from([0]),
		Buffer.alloc(width * 3, Buffer.from([40, 120, 200])),
	]);
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

test("shows sandbox: images inline and files as cards without overflow (#3228 AC-1, AC-2, AC-4)", async ({
	page,
}, testInfo) => {
	const conversationId = "conversation-1";
	const image = png(1600, 900);
	const longName = `${"quarterly-sales-report-".repeat(6)}final.zip`;
	const results = [
		{
			fileId: "chart-1",
			name: "chart.png",
			mediaType: "image/png",
			sizeBytes: image.length,
			workspaceReference: "out/chart.png",
		},
		{
			fileId: "report-1",
			name: "r.pdf",
			mediaType: "application/pdf",
			sizeBytes: 2048,
			workspaceReference: "out/r.pdf",
		},
		{
			fileId: "archive-1",
			name: longName,
			mediaType: "application/zip",
			sizeBytes: 4096,
			workspaceReference: "out/bundle.zip",
		},
	];
	const answer = [
		"结果如下：",
		"![销量图](sandbox:out/chart.png)",
		"请查看[季度报告](sandbox:out/r.pdf)，以及[打包结果](sandbox:out/bundle.zip)。",
		"![未发布](sandbox:out/missing.png) ![远程](https://tracker.example/pixel.png)",
	].join("\n\n");
	const detail = ConversationDetailProjectionV2Schema.parse({
		...history(conversationId, [
			...results.map((payload, index) =>
				PersistedConversationEventV2Schema.parse({
					...event(index + 2, conversationId),
					schemaVersion: 2,
					type: "result.file",
					payload,
				}),
			),
			PersistedConversationEventV2Schema.parse({
				...event(9, conversationId),
				type: "execution.status",
				payload: { status: "completed" },
			}),
		]),
		conversation: {
			...history(conversationId, []).conversation,
			status: "ready",
		},
		messages: [
			{
				messageId: "question-1",
				role: "user",
				text: "请出图并附上报告",
				status: "completed",
				executionId: "execution-1",
				replyToMessageId: null,
				answerVersion: null,
				isCurrentAnswer: null,
				error: null,
				createdAt: timestamp,
			},
			{
				messageId: "answer-1",
				role: "assistant",
				text: answer,
				status: "completed",
				executionId: "execution-1",
				replyToMessageId: "question-1",
				answerVersion: 1,
				isCurrentAnswer: true,
				error: null,
				createdAt: timestamp,
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
			resultFiles: true,
		},
	});
	const errors = trackPageErrors(page);
	const outside: string[] = [];
	const fileRequests: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.hostname === "tracker.example") outside.push(url.href);
		if (url.pathname.includes("/files/"))
			fileRequests.push(`${request.method()} ${url.pathname}`);
	});
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (isFileLimitsRequest(request.method(), path))
			return route.fulfill({ json: controlledFileLimits() });
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
		const match = path.match(/\/files\/([^/]+)\/(access|content)$/);
		const result = results.find((item) => item.fileId === match?.[1]);
		if (match && result && match[2] === "access")
			return route.fulfill({
				json: {
					schemaVersion: 1,
					accessId: `access-${result.fileId}`,
					file: {
						schemaVersion: 1,
						fileId: result.fileId,
						kind: "result",
						descriptor: {
							name: result.name,
							mediaType: result.mediaType,
							sizeBytes: result.sizeBytes,
							sha256: "a".repeat(64),
						},
						status: "available",
						createdAt: timestamp,
						expiresAt: "2099-01-01T00:00:00Z",
					},
					path: `/api/v1/conversations/${conversationId}/files/${result.fileId}/content`,
					grant: {
						format: "compact-jws",
						schemaVersion: 1,
						token: `${result.fileId}-grant`,
					},
					expiresAt: "2099-01-01T00:00:00Z",
				},
			});
		if (match && result && match[2] === "content")
			return route.fulfill({
				contentType: result.mediaType,
				body: result.fileId === "chart-1" ? image : Buffer.from("%PDF-1.7"),
			});
		return route.fulfill({ json: { items: [], nextCursor: null } });
	});

	await page.goto(
		`/agents/agent-1/conversations?conversation=${conversationId}`,
	);
	const reply = page.getByRole("article", { name: /的消息$/ }).filter({
		hasText: "结果如下",
	});
	const inline = reply.getByRole("img", { name: "销量图" });
	await expect(inline).toBeVisible();
	await expect
		.poll(() =>
			inline.evaluate((element) => (element as HTMLImageElement).naturalWidth),
		)
		.toBe(1600);
	const markdown = reply.locator(".assistant-markdown");
	const bodyWidth = (await markdown.boundingBox())?.width ?? 0;
	const imageBox = await inline.boundingBox();
	expect(imageBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
		Math.min(bodyWidth, 480),
	);
	expect(imageBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(320);
	for (const name of ["r.pdf", longName]) {
		const card = reply.getByRole("group", { name: `结果文件：${name}` });
		await expect(card).toBeVisible();
		const box = await card.boundingBox();
		expect(box?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
			bodyWidth + 1,
		);
		// 长文件名截断显示，下载按钮始终留在卡片内，不被挤出消息区。
		const download = await card
			.getByRole("button", { name: `下载：${name}` })
			.boundingBox();
		expect(download && box).toBeTruthy();
		if (download && box)
			expect(download.x + download.width).toBeLessThanOrEqual(
				box.x + box.width + 1,
			);
	}
	await expect(reply.getByText("图片未发送：未发布")).toBeVisible();
	await expect(reply.getByText("[图片：远程]")).toBeVisible();
	// 只有命中的图片经 File Grant 读取；文件卡在用户操作前不读取，其他 URL 一律不加载。
	expect(fileRequests).toEqual([
		"POST /api/v1/conversations/conversation-1/files/chart-1/access",
		"GET /api/v1/conversations/conversation-1/files/chart-1/content",
	]);
	expect(outside).toEqual([]);
	expect(await duplicateControlNames(page)).toEqual([]);
	await expectCleanPage(page, errors);
	expect(
		await page
			.getByRole("region", { name: "会话时间线" })
			.evaluate((element) => element.scrollWidth <= element.clientWidth),
	).toBe(true);
	await page.screenshot({
		path: testInfo.outputPath("sandbox-references.png"),
		fullPage: true,
	});
	await reply
		.getByRole("group", { name: `结果文件：${longName}` })
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		path: testInfo.outputPath("sandbox-file-cards.png"),
	});

	// 键盘可达：内联图片是带可读名称的按钮，回车打开现有预览，并复用已读到的 Blob。
	const open = reply.getByRole("button", { name: "预览图片：销量图" });
	await open.focus();
	await page.keyboard.press("Enter");
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByRole("img", { name: "chart.png" })).toBeVisible();
	expect(fileRequests).toHaveLength(2);
	await dialog
		.locator('[data-slot="dialog-footer"]')
		.getByRole("button", { name: "关闭" })
		.click();
	await expect(dialog).toBeHidden();
	await reply.getByRole("button", { name: "预览：r.pdf" }).click();
	await expect(page.getByRole("dialog").locator("iframe")).toHaveAttribute(
		"title",
		"r.pdf",
	);
	expect(fileRequests.slice(2)).toEqual([
		"POST /api/v1/conversations/conversation-1/files/report-1/access",
		"GET /api/v1/conversations/conversation-1/files/report-1/content",
	]);
});
