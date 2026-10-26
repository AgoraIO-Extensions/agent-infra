import {
	AgentProjectionV2Schema,
	ConnectionCapabilityProjectionV1Schema,
	ConversationDetailProjectionV2Schema,
	ConversationPageV1Schema,
	PersistedConversationEventV2Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { expect, type Page, test } from "@playwright/test";
import {
	execution,
	history,
	timestamp,
} from "../src/features/conversation/conversation-test-fixtures";
import { keepConversationStreamOpen } from "./conversation-stream";
import { expectFocusSettled, expectNoDuplicateControls } from "./page-health";
import { expectCleanPage, trackPageErrors } from "./primitive-styles";

// #3457（#3451 B16-1～3）：对话页排队期间的「命令 / Skill」入口、排队已满时的说明行与多条
// 「准备重新发送」的可访问名称。导出稿没有这些状态，规格见 web-ui.md F3-06 与「对话页状态说明行」。
// 受控 fixture 只返回合成数据，不代表真实 Runtime。
const agentId = "agent-1";
const conversationId = "conversation-queue-1";
const viewports = [
	{ width: 1440, height: 900 },
	{ width: 390, height: 844 },
] as const;

type UserMessage = {
	messageId: string;
	text: string;
	executionId: string;
	status: "completed" | "submitted" | "processing" | "failed";
};
type QueueItem =
	| {
			messageId: string;
			executionId: string;
			status: "waiting";
			position: number;
	  }
	| { messageId: string; executionId: string; status: "timed_out" };

function statusEvent(sequence: number, executionId: string, status: string) {
	return PersistedConversationEventV2Schema.parse({
		schemaVersion: 1,
		kind: "event",
		eventId: `queue-event-${sequence}`,
		conversationId,
		executionId,
		sequence,
		conversationCursor: `queue-cursor-${sequence}`,
		occurredAt: timestamp,
		type: "execution.status",
		payload: { status },
	});
}

function userMessage(message: UserMessage) {
	return {
		messageId: message.messageId,
		role: "user",
		text: message.text,
		status: message.status,
		executionId: message.executionId,
		replyToMessageId: null,
		answerVersion: null,
		isCurrentAnswer: null,
		error:
			message.status === "failed"
				? {
						schemaVersion: 1,
						code: "EXECUTION_FAILED",
						message: "controlled failure",
						retryable: false,
						traceId: "trace-queue",
					}
				: null,
		createdAt: timestamp,
	};
}

function answer(messageId: string, executionId: string, replyTo: string) {
	return {
		messageId,
		role: "assistant",
		text: "已整理完成。",
		status: "completed",
		executionId,
		replyToMessageId: replyTo,
		answerVersion: 1,
		isCurrentAnswer: true,
		error: null,
		createdAt: timestamp,
	};
}

/**
 * 对话页：第一轮已完成（execution-0）；`current` 给出第二条提问（execution-1）的执行状态，
 * 其后的提问按 `queue` 显示排队状态。`onMessage` 为 POST messages 的受控响应。
 */
async function queueFixture(
	page: Page,
	options: {
		current: "completed" | "processing";
		users: readonly UserMessage[];
		queue: readonly QueueItem[];
		onMessage?: () => { status: number; json: unknown };
	},
) {
	const writes: string[] = [];
	await keepConversationStreamOpen(page);
	const agent = AgentProjectionV2Schema.parse({
		...pilotFakeScenariosV2.starting.response.body,
		agentId,
		name: "受控排队助手",
		managementStatus: "available",
		serviceAvailability: "ready",
		capabilities: {
			...pilotFakeScenariosV2.starting.response.body.capabilities,
			attachments: false,
			nativeMetadata: true,
			supplementaryInstruction: false,
		},
	});
	const events = [
		statusEvent(1, "execution-0", "completed"),
		statusEvent(2, "execution-1", options.current),
	];
	const base = history(conversationId, events);
	const detail = ConversationDetailProjectionV2Schema.parse({
		...base,
		conversation: { ...base.conversation, status: "active" },
		messages: [
			userMessage({
				messageId: "question-0",
				text: "先列出本周的变更",
				executionId: "execution-0",
				status: "completed",
			}),
			answer("answer-0", "execution-0", "question-0"),
			...options.users.map(userMessage),
			...(options.current === "completed"
				? [answer("answer-1", "execution-1", "question-1")]
				: []),
		],
		queue: options.queue,
	});
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname;
		const method = request.method();
		if (method !== "GET") writes.push(`${method} ${path}`);
		if (path === "/api/v1/session")
			return route.fulfill({
				json: {
					schemaVersion: 1,
					user: {
						userId: "controlled-person",
						displayName: "受控员工",
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
			return route.fulfill({ json: agent });
		if (path === `/api/v2/conversations/${conversationId}`)
			return route.fulfill({ json: detail });
		if (path.endsWith("/events"))
			return route.fulfill({
				contentType: "text/event-stream",
				body: ": heartbeat\n\n",
			});
		if (method === "GET" && path.endsWith("/native-metadata")) {
			const commands = url.searchParams.get("selector") === "commands";
			return route.fulfill({
				json: {
					selector: commands ? "commands" : "skills",
					revision: (commands ? "c" : "d").repeat(64),
					capabilities: commands
						? []
						: [
								{
									id: "e".repeat(64),
									kind: "skill",
									name: "workspace-summary",
									description: "Summarize approved workspace files",
									source: { name: "skillhub", version: "1.0.0" },
									availability: "discovered",
								},
							],
				},
			});
		}
		if (
			method === "POST" &&
			path === `/api/v1/conversations/${conversationId}/messages` &&
			options.onMessage
		) {
			const reply = options.onMessage();
			return route.fulfill({ status: reply.status, json: reply.json });
		}
		if (method === "GET" && path.includes("/executions/"))
			return route.fulfill({
				json: execution(conversationId, path.split("/").at(-1)),
			});
		return route.fulfill({ json: { items: [], nextCursor: null } });
	});
	await page.goto(`/chat/${agentId}/${conversationId}`);
	const input = page.getByLabel("消息", { exact: true });
	await expect(input).toBeVisible();
	return { input, writes };
}

for (const viewport of viewports) {
	const size = `${viewport.width} by ${viewport.height}`;

	test(`disables the command and Skill entry while messages wait in the queue at ${size} (#3457 B16-1)`, async ({
		page,
	}, info) => {
		test.skip(info.project.name !== "desktop", "Viewport list runs once.");
		await page.setViewportSize(viewport);
		const errors = trackPageErrors(page);
		// 原回复已结束，会话里仍有一条排队消息（原生命令与 Skill 不进入排队，F3-06、§12.5）。
		const fixture = await queueFixture(page, {
			current: "completed",
			users: [
				{
					messageId: "question-1",
					text: "整理变更说明并分组",
					executionId: "execution-1",
					status: "completed",
				},
				{
					messageId: "question-2",
					text: "再补一份英文摘要",
					executionId: "execution-2",
					status: "submitted",
				},
			],
			queue: [
				{
					messageId: "question-2",
					executionId: "execution-2",
					status: "waiting",
					position: 1,
				},
			],
		});
		await expect(
			page.getByText("排队中（第 1 位），前面还有 0 条消息", { exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "停止回复", exact: true }),
		).toHaveCount(0);
		const trigger = page.getByRole("button", { name: "选择命令或 Skill" });
		await expect(trigger).toBeDisabled();
		await expect(trigger).toHaveCSS("opacity", "0.48");
		await expect(trigger).toHaveCSS("cursor", "not-allowed");
		// 输入框仍可编辑；用 / 从目录选中 Skill 后「确认发送」禁用，按 Enter 也不会发出调用。
		await expect(fixture.input).toBeEnabled();
		await fixture.input.fill("/");
		await expect(
			page.getByRole("option", { name: /workspace-summary/ }),
		).toBeVisible();
		await fixture.input.press("Enter");
		const confirm = page.getByRole("button", { name: "确认发送", exact: true });
		await expect(confirm).toBeDisabled();
		await fixture.input.press("Enter");
		await expect(fixture.input).toBeFocused();
		await expectNoDuplicateControls(page, "排队期间命令入口");
		await expectCleanPage(page, errors);
		expect(fixture.writes).toEqual([]);
	});

	test(`shows a single consistent note when the queue is full at ${size} (#3457 B16-2)`, async ({
		page,
	}, info) => {
		test.skip(info.project.name !== "desktop", "Viewport list runs once.");
		await page.setViewportSize(viewport);
		const errors = trackPageErrors(page);
		const fixture = await queueFixture(page, {
			current: "processing",
			users: [
				{
					messageId: "question-1",
					text: "整理变更说明并分组",
					executionId: "execution-1",
					status: "processing",
				},
				{
					messageId: "question-2",
					text: "再补一份英文摘要",
					executionId: "execution-2",
					status: "submitted",
				},
			],
			queue: [
				{
					messageId: "question-2",
					executionId: "execution-2",
					status: "waiting",
					position: 1,
				},
			],
			onMessage: () => ({
				status: 409,
				json: {
					schemaVersion: 1,
					code: "AGENT_BUSY",
					message: "controlled busy",
					retryable: true,
					traceId: "trace-busy",
				},
			}),
		});
		const queueNote = "当前回复仍在处理，这条消息发送后进入排队，按顺序处理。";
		const waitingNote = "会话中已有排队消息，这条消息发送后排在它们之后。";
		const send = page.getByRole("button", { name: "发送", exact: true });
		await fixture.input.fill("第三条：附上统计表");
		await expect(page.getByText(queueNote, { exact: true })).toBeVisible();
		await send.click();
		const busy = page
			.getByRole("alert")
			.filter({ hasText: "当前会话已有 1 条消息在排队，这条消息未发送" });
		await expect(busy).toBeVisible();
		// 排队已满就是这条消息的结果：不再同时预告「发送后进入排队」。
		await expect(page.getByText(queueNote, { exact: true })).toHaveCount(0);
		await expect(page.getByText(waitingNote, { exact: true })).toHaveCount(0);
		await expect(send).not.toHaveAttribute("aria-describedby");
		await expect(fixture.input).toHaveValue("第三条：附上统计表");
		// 草稿保留、发送按钮仍可用：焦点留在刚按下的发送按钮上，不落到 body。
		await expectFocusSettled(send, "排队已满");
		await expectNoDuplicateControls(page, "排队已满");
		await expectCleanPage(page, errors);
		// 改写草稿后恢复原规则：说明重新出现，并由发送按钮引用。
		await fixture.input.fill("第三条：附上统计表（稍后再发）");
		const note = page.getByText(queueNote, { exact: true });
		await expect(note).toBeVisible();
		const id = await note.getAttribute("id");
		expect(id).toBeTruthy();
		await expect(send).toHaveAttribute("aria-describedby", id ?? "");
		await expectCleanPage(page, errors);
		expect(fixture.writes).toEqual([
			`POST /api/v1/conversations/${conversationId}/messages`,
		]);
	});

	test(`names each prepare-to-resend control after its question at ${size} (#3457 B16-3)`, async ({
		page,
	}, info) => {
		test.skip(info.project.name !== "desktop", "Viewport list runs once.");
		await page.setViewportSize(viewport);
		const errors = trackPageErrors(page);
		const fixture = await queueFixture(page, {
			current: "completed",
			users: [
				{
					messageId: "question-1",
					text: "整理变更说明并分组",
					executionId: "execution-1",
					status: "completed",
				},
				{
					messageId: "question-2",
					text: "最后检查链接是否有效",
					executionId: "execution-2",
					status: "failed",
				},
				{
					messageId: "question-3",
					text: "第二条超时的消息",
					executionId: "execution-3",
					status: "failed",
				},
				{
					messageId: "question-4",
					text: "普通投递失败对照",
					executionId: "execution-4",
					status: "failed",
				},
			],
			queue: [
				{
					messageId: "question-2",
					executionId: "execution-2",
					status: "timed_out",
				},
				{
					messageId: "question-3",
					executionId: "execution-3",
					status: "timed_out",
				},
			],
		});
		const resend = page.getByRole("button", { name: /^准备重新发送/ });
		await expect(resend).toHaveCount(3);
		// 可见文字不变，可访问名称带提问摘要（N-12、Label in Name）。
		await expect(resend).toHaveText([
			"准备重新发送",
			"准备重新发送",
			"准备重新发送",
		]);
		expect(
			await resend.evaluateAll((nodes) =>
				nodes.map((node) => node.getAttribute("aria-label")),
			),
		).toEqual([
			"准备重新发送：最后检查链接是否有效",
			"准备重新发送：第二条超时的消息",
			"准备重新发送：普通投递失败对照",
		]);
		await expectNoDuplicateControls(page, "多条准备重新发送");
		await expectCleanPage(page, errors);
		// 只把原文放回输入框，焦点到输入框，不自动提交。
		await page
			.getByRole("button", {
				name: "准备重新发送：第二条超时的消息",
				exact: true,
			})
			.click();
		await expect(fixture.input).toHaveValue("第二条超时的消息");
		await expectFocusSettled(fixture.input, "准备重新发送");
		await expectCleanPage(page, errors);
		expect(fixture.writes).toEqual([]);
	});
}
