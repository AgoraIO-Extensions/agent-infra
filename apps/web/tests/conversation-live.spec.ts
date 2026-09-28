import {
	AgentProjectionV2Schema,
	ConversationDetailProjectionV2Schema,
	PersistedConversationEventV2Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { expect, test } from "@playwright/test";

const timestamp = "2026-09-28T02:00:00Z";
const agentId = "agent-1";
const conversationId = "conversation-live-1";
const executionId = "execution-live-1";
const messageId = "message-live-1";

function event(
	type: "text.delta" | "execution.status",
	sequence: number,
	payload: { text: string } | { status: "completed" },
) {
	return PersistedConversationEventV2Schema.parse({
		schemaVersion: 1,
		kind: "event",
		eventId: `live-event-${sequence}`,
		conversationId,
		executionId,
		sequence,
		conversationCursor: `live-cursor-${sequence}`,
		occurredAt: timestamp,
		type,
		payload,
	});
}

test("submits once, renders incremental SSE, and restores the completed reply", async ({
	page,
}) => {
	const agent = AgentProjectionV2Schema.parse({
		...pilotFakeScenariosV2.starting.response.body,
		agentId,
		managementStatus: "available",
		serviceAvailability: "ready",
	});
	const firstDelta = event("text.delta", 1, { text: "第一段实时输出。" });
	const completed = event("execution.status", 2, { status: "completed" });
	const owner = {
		schemaVersion: 1,
		user: {
			userId: "user-owner-1",
			displayName: "开发 Owner",
			roles: ["employee"],
		},
	};
	const initialConversation = {
		schemaVersion: 1,
		conversationId,
		agentId,
		title: "实时验收会话",
		status: "ready",
		selectedModelOptionId: null,
		selectedReasoningLevel: null,
		lastConversationCursor: null,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
	const submittedMessage = {
		messageId,
		role: "user",
		text: "请输出一段实时结果",
		status: "submitted",
		executionId,
		replyToMessageId: null,
		answerVersion: null,
		isCurrentAnswer: null,
		error: null,
		createdAt: timestamp,
	};
	const finalAnswer = {
		messageId: "answer-live-1",
		role: "assistant",
		text: "第一段实时输出。第二段完成输出。",
		status: "completed",
		executionId,
		replyToMessageId: messageId,
		answerVersion: 1,
		isCurrentAnswer: true,
		error: null,
		createdAt: timestamp,
	};
	let detailReads = 0;
	let submitRequests = 0;
	let completionSignaled = false;
	await page.exposeFunction("markConversationComplete", () => {
		completionSignaled = true;
	});
	await page.addInitScript(
		({ first, terminal }: { first: unknown; terminal: unknown }) => {
			const realFetch = window.fetch.bind(window);
			let messageAccepted = false;
			window.fetch = async (input, init) => {
				const url = new URL(
					typeof input === "string"
						? input
						: input instanceof Request
							? input.url
							: String(input),
					window.location.href,
				);
				if (!url.pathname.endsWith("/events")) {
					const response = await realFetch(input, init);
					if (
						url.pathname.endsWith("/messages") &&
						(init?.method ??
							(input instanceof Request ? input.method : "GET")) === "POST"
					)
						messageAccepted = response.ok;
					return response;
				}
				const encoder = new TextEncoder();
				const frame = (value: unknown, id?: string) =>
					`${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(value)}\n\n`;
				const body = new ReadableStream<Uint8Array>({
					async start(controller) {
						while (!messageAccepted)
							await new Promise((resolve) => setTimeout(resolve, 10));
						setTimeout(
							() =>
								controller.enqueue(
									encoder.encode(frame(first, "live-event-1")),
								),
							40,
						);
						setTimeout(() => {
							controller.enqueue(
								encoder.encode(frame(terminal, "live-event-2")),
							);
							controller.close();
							void (
								window as unknown as { markConversationComplete: () => void }
							).markConversationComplete();
						}, 220);
					},
				});
				return new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			};
		},
		{ first: firstDelta, terminal: completed },
	);
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path.endsWith("/session")) {
			await route.fulfill({ json: owner });
			return;
		}
		if (path === `/api/v2/agents/${agentId}`) {
			await route.fulfill({ json: agent });
			return;
		}
		if (path === `/api/v2/conversations/${conversationId}`) {
			detailReads += 1;
			if (detailReads > 1) {
				await expect
					.poll(() => completionSignaled, {
						timeout: 2_000,
						message: "The refresh must wait for the terminal SSE frame",
					})
					.toBe(true);
			}
			const detail = ConversationDetailProjectionV2Schema.parse({
				schemaVersion: 2,
				conversation:
					detailReads > 1
						? {
								...initialConversation,
								lastConversationCursor: "live-cursor-2",
							}
						: initialConversation,
				messages: detailReads > 1 ? [submittedMessage, finalAnswer] : [],
				events: detailReads > 1 ? [firstDelta, completed] : [],
			});
			await route.fulfill({ json: detail });
			return;
		}
		if (path === `/api/v1/conversations/${conversationId}/messages`) {
			submitRequests += 1;
			if (submitRequests > 1) {
				await route.fulfill({ status: 409, json: { code: "DUPLICATE" } });
				return;
			}
			await route.fulfill({
				status: 202,
				json: { schemaVersion: 1, status: "submitted", messageId, executionId },
			});
			return;
		}
		await route.fulfill({ json: { items: [], nextCursor: null } });
	});

	await page.goto(
		`/agents/${agentId}/conversations?conversation=${conversationId}`,
	);
	await expect(page.getByRole("textbox", { name: "消息" })).toBeEnabled();
	const input = page.getByRole("textbox", { name: "消息" });
	await input.fill("请输出一段实时结果");
	const send = page.getByRole("button", { name: "发送", exact: true });
	await expect(send).toBeEnabled();
	await Promise.all([
		page.waitForResponse(
			(response) =>
				response.request().method() === "POST" &&
				new URL(response.url()).pathname ===
					`/api/v1/conversations/${conversationId}/messages`,
		),
		page.evaluate(() => {
			const form = document.querySelector<HTMLFormElement>(
				"form[data-c02-guard='pending-submit']",
			);
			if (!form) throw new Error("Conversation composer form was not found");
			form.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true }),
			);
			form.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true }),
			);
		}),
	]);
	await expect.poll(() => submitRequests).toBe(1);
	await expect(
		page.getByText("第一段实时输出。", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("第一段实时输出。第二段完成输出。", { exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("status").filter({ hasText: "消息已受理" }),
	).toBeVisible();
	await expect(
		page.getByText("第一段实时输出。第二段完成输出。", { exact: true }),
	).toBeVisible({
		timeout: 3_000,
	});
	await page.reload();
	await expect(
		page.getByText("第一段实时输出。第二段完成输出。", { exact: true }),
	).toBeVisible();
	await expect.poll(() => submitRequests).toBe(1);
	await page.screenshot({
		path: test.info().outputPath("conversation-live.png"),
	});
});

test("renders an authorization failure without retaining another subject's conversation", async ({
	page,
}) => {
	const agent = AgentProjectionV2Schema.parse({
		...pilotFakeScenariosV2.starting.response.body,
		agentId,
		managementStatus: "available",
		serviceAvailability: "ready",
	});
	await page.route(/\/api\/v[12]\//, async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith("/session")) {
			await route.fulfill({
				json: {
					schemaVersion: 1,
					user: {
						userId: "user-other-2",
						displayName: "其他主体",
						roles: ["employee"],
					},
				},
			});
			return;
		}
		if (path === `/api/v2/agents/${agentId}`) {
			await route.fulfill({ json: agent });
			return;
		}
		if (
			path === `/api/v2/conversations/${conversationId}` ||
			path.endsWith("/events")
		) {
			await route.fulfill({
				status: 403,
				json: { code: "AUTHORIZATION_REVOKED" },
			});
			return;
		}
		await route.fulfill({ json: { items: [], nextCursor: null } });
	});
	await page.goto(
		`/agents/${agentId}/conversations?conversation=${conversationId}`,
	);
	await expect(
		page.getByText("当前登录或访问权限已失效，请重新登录或返回 Agent 列表。"),
	).toBeVisible();
	await expect(
		page.getByText("请输出一段实时结果", { exact: true }),
	).toHaveCount(0);
});
