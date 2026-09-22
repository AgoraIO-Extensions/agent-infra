import {
	AgentProjectionV2Schema,
	ConversationDetailProjectionV2Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { expect, test } from "@playwright/test";
import {
	history,
	timestamp,
} from "../src/features/conversation/conversation-test-fixtures";

const longCode = `const value = "${"long-value-".repeat(80)}";`;
const markdown = [
	"## 检查结果",
	"**通过**，请检查以下代码。",
	`\`\`\`ts\n${longCode}\n\`\`\``,
	"| 模块 | 状态 | 描述 | 下一步 |\n| --- | --- | --- | --- |\n| Web | 通过 | 长内容检查 | 查看结果 |",
	"![禁止加载的远程图片](https://tracker.example/pixel)",
	"[来源](https://example.com/docs) [危险](javascript:alert%281%29)",
	...Array.from(
		{ length: 20 },
		(_, index) => `第 ${index + 1} 段：${"长回复应在时间线内滚动。".repeat(8)}`,
	),
].join("\n\n");

test("assistant Markdown stays readable through history reload and version switching", async ({
	page,
}, testInfo) => {
	const agent = AgentProjectionV2Schema.parse({
		...pilotFakeScenariosV2.starting.response.body,
		agentId: "agent-1",
		managementStatus: "available",
		serviceAvailability: "ready",
	});
	const user = {
		messageId: "message-1",
		role: "user",
		text: "**用户输入保持原文**",
		status: "completed",
		executionId: "execution-1",
		replyToMessageId: null,
		answerVersion: null,
		isCurrentAnswer: null,
		error: null,
		createdAt: timestamp,
	};
	const detail = ConversationDetailProjectionV2Schema.parse({
		...history("conversation-1", []),
		conversation: { ...history().conversation, status: "ready" },
		messages: [
			user,
			...["旧版本内容", markdown].map((text, index) => ({
				...user,
				role: "assistant",
				messageId: `answer-${index + 1}`,
				executionId: `execution-${index + 1}`,
				replyToMessageId: user.messageId,
				answerVersion: index + 1,
				isCurrentAnswer: index === 1,
				text,
			})),
		],
	});
	const remoteRequests: string[] = [];
	page.on("request", (request) => {
		if (new URL(request.url()).hostname === "tracker.example")
			remoteRequests.push(request.url());
	});
	await page.route(/\/api\/v[12]\//, async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith("/events")) {
			await route.fulfill({
				contentType: "text/event-stream",
				body: ": heartbeat\n\n",
			});
			return;
		}
		const body = path.endsWith("/session")
			? {
					schemaVersion: 1,
					user: {
						userId: "user-owner-1",
						displayName: "开发测试",
						roles: ["employee"],
					},
				}
			: path === "/api/v2/agents/agent-1"
				? agent
				: path === "/api/v2/conversations/conversation-1"
					? detail
					: { items: [], nextCursor: null };
		await route.fulfill({ json: body });
	});
	await page.goto("/agents/agent-1/conversations?conversation=conversation-1");
	await expect(page.getByRole("heading", { name: "检查结果" })).toBeVisible();
	await expect(page.getByText(user.text, { exact: true })).toBeVisible();
	await expect(page.locator(".assistant-markdown pre code")).toHaveText(
		longCode,
	);
	await expect(page.locator(".assistant-markdown img")).toHaveCount(0);
	await expect(page.getByRole("link", { name: "危险" })).toHaveCount(0);
	const code = page.getByRole("region", { name: "代码块" });
	await code.focus();
	await page.keyboard.press("ArrowRight");
	await expect
		.poll(() => code.evaluate((element) => element.scrollLeft))
		.toBeGreaterThan(0);
	const table = page.getByRole("region", { name: "表格" });
	await expect(table).toBeVisible();
	if (testInfo.project.name === "mobile") {
		await table.focus();
		await page.keyboard.press("ArrowRight");
		await expect
			.poll(() => table.evaluate((element) => element.scrollLeft))
			.toBeGreaterThan(0);
	}
	const timeline = page.getByRole("region", { name: "会话时间线" });
	await timeline.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	await expect(page.getByRole("textbox", { name: "消息" })).toBeVisible();
	await page.getByRole("button", { name: "上一个回答版本" }).click();
	await expect(page.getByText("旧版本内容", { exact: true })).toBeVisible();
	await expect(page.locator(".assistant-markdown pre")).toHaveCount(0);
	await page.getByRole("button", { name: "下一个回答版本" }).click();
	await expect(page.locator(".assistant-markdown pre")).toHaveCount(1);
	await page.reload();
	await expect(page.locator(".assistant-markdown pre")).toHaveCount(1);
	await expect(page.getByRole("heading", { name: "检查结果" })).toBeVisible();
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);
	expect(
		await timeline.evaluate(
			(element) => element.scrollWidth <= element.clientWidth,
		),
	).toBe(true);
	expect(remoteRequests).toEqual([]);
	await page.screenshot({ path: testInfo.outputPath("markdown.png") });
});
