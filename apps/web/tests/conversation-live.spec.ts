import {
	AgentProjectionV2Schema,
	BrowserSessionProjectionV1Schema,
	CommandAcceptedProjectionV1Schema,
	ConversationDetailProjectionV2Schema,
	ConversationPageV1Schema,
	ExecutionDetailProjectionV2Schema,
	PersistedConversationEventV2Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { expect, type Page, test } from "@playwright/test";
import {
	execution,
	history,
} from "../src/features/conversation/conversation-test-fixtures";

const timestamp = "2026-09-28T02:00:00Z";
const agentId = "agent-1";
const conversationId = "conversation-live-1";
const executionId = "execution-live-1";
const messageId = "message-live-1";

function event(
	type: "text.delta" | "execution.status",
	sequence: number,
	payload:
		| { text: string }
		| { status: "processing" | "completed" | "cancelled" },
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

function ownerSession() {
	return {
		schemaVersion: 1,
		user: {
			userId: "user-owner-1",
			displayName: "开发 Owner",
			roles: ["employee"],
		},
	};
}

function activeAgent() {
	return AgentProjectionV2Schema.parse({
		...pilotFakeScenariosV2.starting.response.body,
		agentId,
		managementStatus: "available",
		serviceAvailability: "ready",
		configuration: {
			...pilotFakeScenariosV2.starting.response.body.configuration,
			modelOptions: [
				{
					optionId: "model-primary",
					displayName: "Primary model",
					modelId: "gpt-5",
					reasoningLevels: ["medium", "high"],
				},
				{
					optionId: "model-secondary",
					displayName: "Secondary model",
					modelId: "claude",
					reasoningLevels: ["high"],
				},
			],
			defaultModelOptionId: "model-primary",
			defaultReasoningLevel: "medium",
		},
		capabilities: {
			...pilotFakeScenariosV2.starting.response.body.capabilities,
			modelSelection: true,
			supplementaryInstruction: true,
		},
	});
}

async function keepConversationStreamOpen(page: Page) {
	await page.addInitScript(() => {
		const realFetch = window.fetch.bind(window);
		window.fetch = async (input, init) => {
			const request = new Request(input, init);
			const response = await realFetch(request);
			if (!new URL(request.url).pathname.endsWith("/events")) return response;
			void response.body?.cancel();
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
					const close = () => controller.close();
					if (request.signal.aborted) close();
					else request.signal.addEventListener("abort", close, { once: true });
				},
			});
			return new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		};
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
	let phase: "ready" | "submitted" | "running" | "completed" = "ready";
	let detailReadsAfterSubmit = 0;
	let submitRequests = 0;
	await page.addInitScript(() => {
		type FixtureWindow = Window & {
			conversationStreamRevision: number;
			hasConversationStream: () => boolean;
			emitConversationFrame: (value: unknown, id: string) => void;
		};
		const fixture = window as unknown as FixtureWindow;
		const realFetch = window.fetch.bind(window);
		const encoder = new TextEncoder();
		let activeController:
			| ReadableStreamDefaultController<Uint8Array>
			| undefined;
		fixture.conversationStreamRevision = 0;
		fixture.hasConversationStream = () => Boolean(activeController);
		fixture.emitConversationFrame = (value, id) => {
			if (!activeController)
				throw new Error("The conversation stream is not open");
			activeController.enqueue(
				encoder.encode(`id: ${id}\n` + `data: ${JSON.stringify(value)}\n\n`),
			);
		};
		window.fetch = async (input, init) => {
			const url = new URL(
				typeof input === "string"
					? input
					: input instanceof Request
						? input.url
						: String(input),
				window.location.href,
			);
			if (!url.pathname.endsWith("/events")) return realFetch(input, init);
			let controllerForStream:
				| ReadableStreamDefaultController<Uint8Array>
				| undefined;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controllerForStream = controller;
					activeController = controller;
					fixture.conversationStreamRevision += 1;
				},
				cancel() {
					if (activeController === controllerForStream)
						activeController = undefined;
				},
			});
			return new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};
	});
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path === "/api/v2/me/conversations/recent")
			return route.fulfill({
				json: ConversationPageV1Schema.parse({ items: [], nextCursor: null }),
			});
		if (path.endsWith("/session")) {
			await route.fulfill({ json: owner });
			return;
		}
		if (path === `/api/v2/agents/${agentId}`) {
			await route.fulfill({ json: agent });
			return;
		}
		if (path === `/api/v2/conversations/${conversationId}`) {
			if (phase !== "ready") detailReadsAfterSubmit += 1;
			const events =
				phase === "completed"
					? [firstDelta, completed]
					: phase === "running"
						? [firstDelta]
						: [];
			const detail = ConversationDetailProjectionV2Schema.parse({
				schemaVersion: 2,
				conversation: {
					...initialConversation,
					status:
						phase === "ready" || phase === "completed" ? "ready" : "active",
					lastConversationCursor: events.at(-1)?.conversationCursor ?? null,
				},
				messages:
					phase === "ready"
						? []
						: [
								{
									...submittedMessage,
									status:
										phase === "completed"
											? "completed"
											: phase === "running"
												? "processing"
												: "submitted",
								},
								...(phase === "completed" ? [finalAnswer] : []),
							],
				events,
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
			phase = "submitted";
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
	const initialStreamRevision = await page.evaluate(
		() =>
			(window as unknown as { conversationStreamRevision: number })
				.conversationStreamRevision,
	);
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
	await expect.poll(() => detailReadsAfterSubmit).toBeGreaterThan(0);
	await page.waitForFunction((revision) => {
		const fixture = window as unknown as {
			conversationStreamRevision: number;
			hasConversationStream: () => boolean;
		};
		return (
			fixture.conversationStreamRevision > revision &&
			fixture.hasConversationStream()
		);
	}, initialStreamRevision);
	phase = "running";
	await page.evaluate(
		(frame) =>
			(
				window as unknown as {
					emitConversationFrame: (value: unknown, id: string) => void;
				}
			).emitConversationFrame(frame, "live-event-1"),
		firstDelta,
	);
	await expect(
		page.getByText("第一段实时输出。", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("第一段实时输出。第二段完成输出。", { exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("status").filter({ hasText: "消息已受理" }),
	).toBeVisible();
	await test.info().attach("conversation-incremental-sse", {
		body: await page.screenshot({ fullPage: true }),
		contentType: "image/png",
	});
	phase = "completed";
	await page.evaluate(
		(frame) =>
			(
				window as unknown as {
					emitConversationFrame: (value: unknown, id: string) => void;
				}
			).emitConversationFrame(frame, "live-event-2"),
		completed,
	);
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
	await test.info().attach("conversation-completed-after-reload", {
		body: await page.screenshot({ fullPage: true }),
		contentType: "image/png",
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
		if (path === "/api/v2/me/conversations/recent")
			return route.fulfill({
				json: ConversationPageV1Schema.parse({ items: [], nextCursor: null }),
			});
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

test("recovers an ordinary conversation 404 through read-only reconnect", async ({
	page,
}) => {
	const agent = AgentProjectionV2Schema.parse({
		...pilotFakeScenariosV2.starting.response.body,
		agentId,
		managementStatus: "available",
		serviceAvailability: "ready",
	});
	let missing = true;
	let historyReads = 0;
	let streamReads = 0;
	let writes = 0;
	await keepConversationStreamOpen(page);
	await page.route(/\/api\/v[12]\//, async (route) => {
		if (route.request().method() !== "GET") writes += 1;
		const path = new URL(route.request().url()).pathname;
		if (path === "/api/v2/me/conversations/recent")
			return route.fulfill({
				json: ConversationPageV1Schema.parse({ items: [], nextCursor: null }),
			});
		if (path.endsWith("/session")) {
			await route.fulfill({ json: ownerSession() });
			return;
		}
		if (path === `/api/v2/agents/${agentId}`) {
			await route.fulfill({ json: agent });
			return;
		}
		if (path === `/api/v2/conversations/${conversationId}`) {
			historyReads += 1;
			if (missing) {
				await route.fulfill({
					status: 404,
					json: { message: "Synthetic route missing" },
				});
			} else {
				await route.fulfill({ json: history(conversationId, []) });
			}
			return;
		}
		if (path === `/api/v2/conversations/${conversationId}/events`) {
			streamReads += 1;
			await route.fulfill({
				contentType: "text/event-stream",
				body: ": heartbeat\n\n",
			});
			return;
		}
		await route.fulfill({ json: { items: [], nextCursor: null } });
	});
	await page.goto(
		`/agents/${agentId}/conversations?conversation=${conversationId}`,
	);
	await expect(
		page.getByText(
			"会话连接暂时中断，草稿已保留。重新连接只恢复读取，不重新发送任务。",
		),
	).toBeVisible();
	await expect(
		page.getByText("当前登录或访问权限已失效，请重新登录或返回 Agent 列表。"),
	).toHaveCount(0);
	await expect(page.getByRole("button", { name: "重新连接" })).toBeVisible();
	await test.info().attach("fake-404-unavailable", {
		body: await page.screenshot({ fullPage: true }),
		contentType: "image/png",
	});
	const readsBeforeReconnect = historyReads;
	missing = false;
	await page.getByRole("button", { name: "重新连接" }).click();
	await expect(
		page.getByRole("heading", { name: "Test conversation" }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "重新连接" })).toHaveCount(0);
	await expect.poll(() => historyReads).toBe(readsBeforeReconnect + 1);
	await expect.poll(() => streamReads).toBe(1);
	expect(writes).toBe(0);
	await test.info().attach("fake-404-read-only-recovery", {
		body: await page.screenshot({ fullPage: true }),
		contentType: "image/png",
	});
});

test("clears a loaded execution after 404 and recovers without resending", async ({
	page,
}) => {
	let missing = false;
	let restored = false;
	let historyReads = 0;
	let writes = 0;
	const streamCursors: (string | null)[] = [];
	const oldSummary = "已读取的历史执行摘要";
	const newSummary = "重新读取的执行摘要";
	await keepConversationStreamOpen(page);
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		if (request.method() !== "GET") writes += 1;
		const url = new URL(request.url());
		if (url.pathname === "/api/v2/me/conversations/recent")
			return route.fulfill({
				json: ConversationPageV1Schema.parse({ items: [], nextCursor: null }),
			});
		if (url.pathname.endsWith("/session")) {
			await route.fulfill({ json: ownerSession() });
		} else if (url.pathname === `/api/v2/agents/${agentId}`) {
			await route.fulfill({ json: activeAgent() });
		} else if (url.pathname === `/api/v2/conversations/${conversationId}`) {
			historyReads += 1;
			await route.fulfill({
				json: history(conversationId, [
					event("execution.status", restored ? 2 : 1, { status: "completed" }),
				]),
			});
		} else if (url.pathname.endsWith(`/executions/${executionId}`)) {
			await route.fulfill(
				missing
					? { status: 404, json: { message: "Synthetic route missing" } }
					: {
							json: {
								...execution(conversationId, executionId),
								processSummary: [
									{
										kind: "agent_summary",
										category: "model_call",
										occurredAt: timestamp,
										summary: restored ? newSummary : oldSummary,
									},
								],
							},
						},
			);
		} else if (url.pathname.endsWith("/events")) {
			streamCursors.push(url.searchParams.get("cursor"));
			await route.fulfill({
				contentType: "text/event-stream",
				body: ": heartbeat\n\n",
			});
		} else {
			await route.fulfill({ json: { items: [], nextCursor: null } });
		}
	});
	await page.goto(
		`/agents/${agentId}/conversations?conversation=${conversationId}`,
	);
	await page.getByRole("button", { name: "执行详情", exact: true }).click();
	await expect(page.getByText(oldSummary, { exact: true })).toBeVisible();
	missing = true;
	await page
		.getByRole("button", { name: "核实原执行状态", exact: true })
		.click();
	const details = page.getByRole("region", { name: "执行详情" });
	await expect(
		details.getByText("执行记录暂时无法读取。", { exact: true }),
	).toBeVisible();
	await expect(
		details.getByRole("button", { name: "重新读取详情", exact: true }),
	).toBeVisible();
	await expect(page.getByText(oldSummary, { exact: true })).toHaveCount(0);
	await expect(
		page.getByText("当前登录或访问权限已失效，请重新登录或返回 Agent 列表。"),
	).toHaveCount(0);
	await test.info().attach("fake-execution-404-cleared", {
		body: await page.screenshot({ fullPage: true }),
		contentType: "image/png",
	});
	const readsBeforeReconnect = historyReads;
	missing = false;
	restored = true;
	await details
		.getByRole("button", { name: "重新读取详情", exact: true })
		.click();
	await expect(page.getByText(newSummary, { exact: true })).toBeVisible();
	await expect(page.getByText(oldSummary, { exact: true })).toHaveCount(0);
	await expect.poll(() => historyReads).toBe(readsBeforeReconnect + 1);
	expect(streamCursors).toEqual(["live-cursor-1", "live-cursor-2"]);
	expect(writes).toBe(0);
	await test.info().attach("fake-execution-404-read-only-recovery", {
		body: await page.screenshot({ fullPage: true }),
		contentType: "image/png",
	});
});

test("saves the next-message model and stops the bound execution", async ({
	page,
}) => {
	const agent = activeAgent();
	const processing = event("execution.status", 1, { status: "processing" });
	const cancelled = event("execution.status", 2, { status: "cancelled" });
	const userMessage = {
		messageId,
		role: "user" as const,
		text: "继续检查当前任务",
		status: "processing" as const,
		executionId,
		replyToMessageId: null,
		answerVersion: null,
		isCurrentAnswer: null,
		error: null,
		createdAt: timestamp,
	};
	let phase: "active" | "cancelled" = "active";
	let selectedModelOptionId = "model-primary";
	let selectedReasoningLevel = "medium";
	let selectionBody: unknown;
	let stopBody: unknown;
	let stopIdempotencyKey: string | undefined;
	const detail = () => {
		const events =
			phase === "cancelled" ? [processing, cancelled] : [processing];
		return ConversationDetailProjectionV2Schema.parse({
			...history(conversationId, events),
			conversation: {
				...history(conversationId, []).conversation,
				status: phase === "cancelled" ? "ready" : "active",
				selectedModelOptionId,
				selectedReasoningLevel,
			},
			messages: [
				{
					...userMessage,
					status: phase === "cancelled" ? "cancelled" : "processing",
				},
			],
		});
	};
	await keepConversationStreamOpen(page);
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path === "/api/v2/me/conversations/recent")
			return route.fulfill({
				json: ConversationPageV1Schema.parse({ items: [], nextCursor: null }),
			});
		if (path.endsWith("/events")) {
			await route.fulfill({
				status: 200,
				contentType: "text/event-stream",
				body: ": heartbeat\n\n",
			});
			return;
		}
		if (path.endsWith("/session")) {
			await route.fulfill({ json: ownerSession() });
			return;
		}
		if (path === `/api/v2/agents/${agentId}`) {
			await route.fulfill({ json: agent });
			return;
		}
		if (path === `/api/v2/conversations/${conversationId}`) {
			await route.fulfill({ json: detail() });
			return;
		}
		if (path.endsWith("/model-selection")) {
			selectionBody = request.postDataJSON();
			selectedModelOptionId = "model-secondary";
			selectedReasoningLevel = "high";
			await route.fulfill({
				status: 200,
				json: {
					schemaVersion: 1,
					conversationId,
					agentId,
					title: "实时验收会话",
					status: "active",
					selectedModelOptionId,
					selectedReasoningLevel,
					lastConversationCursor: null,
					createdAt: timestamp,
					updatedAt: timestamp,
				},
			});
			return;
		}
		if (path.endsWith("/stops")) {
			stopBody = request.postDataJSON();
			stopIdempotencyKey = request.headers()["idempotency-key"];
			phase = "cancelled";
			await route.fulfill({
				status: 202,
				json: {
					schemaVersion: 1,
					status: "submitted",
					messageId: null,
					executionId,
				},
			});
			return;
		}
		await route.fulfill({ json: { items: [], nextCursor: null } });
	});

	await page.goto(
		`/agents/${agentId}/conversations?conversation=${conversationId}`,
	);
	await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
	await page.getByRole("combobox", { name: "模型" }).click();
	await page.getByRole("option", { name: "Secondary model" }).click();
	await page.getByRole("combobox", { name: "推理强度" }).click();
	await page.getByRole("option", { name: "high" }).click();
	await page.getByRole("button", { name: "保存模型选择" }).click();
	await expect(
		page.getByRole("status").filter({
			hasText: "模型选择已保存，从下一条消息开始生效。",
		}),
	).toBeVisible();
	await page.getByRole("button", { name: "停止回复" }).click();
	await expect(
		page.getByRole("status").filter({ hasText: "原回复已结束。" }),
	).toBeVisible();
	expect(selectionBody).toEqual({
		schemaVersion: 1,
		modelOptionId: "model-secondary",
		reasoningLevel: "high",
	});
	expect(stopBody).toEqual({
		schemaVersion: 1,
		targetExecutionId: executionId,
	});
	expect(stopIdempotencyKey).toBeTruthy();
	expect(stopIdempotencyKey).not.toBe("undefined");
	await page.setViewportSize({ width: 390, height: 844 });
	expect(
		await page.evaluate(
			() =>
				Math.max(
					document.documentElement.scrollWidth,
					document.body.scrollWidth,
				) <= innerWidth,
		),
	).toBe(true);
});

test("regenerates a terminal answer and opens its execution details", async ({
	page,
}) => {
	const agent = activeAgent();
	const completed = event("execution.status", 1, { status: "completed" });
	const originalMessage = {
		messageId,
		role: "user" as const,
		text: "请检查当前任务",
		status: "completed" as const,
		executionId,
		replyToMessageId: null,
		answerVersion: null,
		isCurrentAnswer: null,
		error: null,
		createdAt: timestamp,
	};
	const answer = {
		messageId: "answer-live-1",
		role: "assistant" as const,
		text: "已完成检查。",
		status: "completed" as const,
		executionId,
		replyToMessageId: messageId,
		answerVersion: 1,
		isCurrentAnswer: true,
		error: null,
		createdAt: timestamp,
	};
	const detail = ConversationDetailProjectionV2Schema.parse({
		...history(conversationId, [completed]),
		conversation: {
			...history(conversationId, []).conversation,
			status: "ready",
			selectedModelOptionId: "model-primary",
			selectedReasoningLevel: "medium",
		},
		messages: [originalMessage, answer],
	});
	let regenerateBody: unknown;
	await keepConversationStreamOpen(page);
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path === "/api/v2/me/conversations/recent")
			return route.fulfill({
				json: ConversationPageV1Schema.parse({ items: [], nextCursor: null }),
			});
		if (path.endsWith("/events")) {
			await route.fulfill({
				status: 200,
				contentType: "text/event-stream",
				body: ": heartbeat\n\n",
			});
			return;
		}
		if (path.endsWith("/session")) {
			await route.fulfill({ json: ownerSession() });
			return;
		}
		if (path === `/api/v2/agents/${agentId}`) {
			await route.fulfill({ json: agent });
			return;
		}
		if (path === `/api/v2/conversations/${conversationId}`) {
			await route.fulfill({ json: detail });
			return;
		}
		if (path.endsWith(`/executions/${executionId}`)) {
			await route.fulfill({ json: execution(conversationId, executionId) });
			return;
		}
		if (path.endsWith("/regenerations")) {
			regenerateBody = request.postDataJSON();
			await route.fulfill({
				status: 202,
				json: {
					schemaVersion: 1,
					status: "submitted",
					messageId: null,
					executionId: "execution-regenerated",
				},
			});
			return;
		}
		await route.fulfill({ json: { items: [], nextCursor: null } });
	});

	await page.goto(
		`/agents/${agentId}/conversations?conversation=${conversationId}`,
	);
	await expect(page.getByText("已完成检查。", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "重新生成" }).click();
	await expect(
		page.getByRole("status").filter({ hasText: "消息已受理" }),
	).toBeVisible();
	expect(regenerateBody).toEqual({
		schemaVersion: 1,
		messageId,
	});
	await page.getByRole("button", { name: "执行详情" }).click();
	const details = page.getByRole("region", { name: "执行详情" });
	await expect(details).toBeVisible();
	await expect(details.getByText("模型与工具调用事实")).toBeVisible();
	await expect(
		details.getByRole("button", { name: "核实原执行状态" }),
	).toBeVisible();
});

for (const source of ["standard", "custom"] as const) {
	for (const code of ["PROVIDER_RATE_LIMITED", "PROVIDER_REJECTED"] as const) {
		test(`personal Key recovery for ${code} on ${source} preserves the accepted scope`, async ({
			page,
		}, info) => {
			const agent = AgentProjectionV2Schema.parse({
				...activeAgent(),
				...(source === "custom"
					? {
							source: {
								kind: "custom",
								imageReference: "registry.example/agent:v1",
								interactionMode: "platform-adapter",
							},
						}
					: {}),
			});
			const failure = PilotProtocolErrorV1Schema.parse({
				schemaVersion: 1,
				code,
				message: "Synthetic provider detail must not be rendered",
				retryable: code === "PROVIDER_RATE_LIMITED",
				traceId: "trace-personal-key-recovery",
			});
			const failedStatus = PersistedConversationEventV2Schema.parse({
				...event("execution.status", 1, { status: "completed" }),
				payload: { status: "failed" },
			});
			const question = "检查合成任务";
			const message = {
				messageId,
				role: "user",
				text: question,
				status: "completed",
				executionId,
				replyToMessageId: null,
				answerVersion: null,
				isCurrentAnswer: null,
				error: null,
				createdAt: timestamp,
			};
			let accepted = false;
			const writes: { path: string; body: unknown }[] = [];
			const unexpected: string[] = [];
			await keepConversationStreamOpen(page);
			await page.route(/\/api\/v[12]\//, async (route) => {
				const request = route.request();
				const path = new URL(request.url()).pathname;
				if (path === "/api/v2/me/conversations/recent")
					return route.fulfill({
						json: ConversationPageV1Schema.parse({
							items: [],
							nextCursor: null,
						}),
					});
				if (request.method() !== "GET")
					writes.push({ path, body: request.postDataJSON() });
				if (request.method() === "GET" && path.endsWith("/session"))
					await route.fulfill({
						json: BrowserSessionProjectionV1Schema.parse(ownerSession()),
					});
				else if (
					request.method() === "GET" &&
					path === `/api/v2/agents/${agentId}`
				)
					await route.fulfill({ json: agent });
				else if (
					request.method() === "POST" &&
					path === `/api/v1/conversations/${conversationId}/messages`
				) {
					// Acceptance is not a provider result. Errors arrive in later reads.
					accepted = true;
					await route.fulfill({
						status: 202,
						json: CommandAcceptedProjectionV1Schema.parse({
							schemaVersion: 1,
							status: "submitted",
							messageId,
							executionId,
						}),
					});
				} else if (
					request.method() === "GET" &&
					path === `/api/v2/conversations/${conversationId}`
				)
					await route.fulfill({
						json: ConversationDetailProjectionV2Schema.parse({
							...history(conversationId, accepted ? [failedStatus] : []),
							conversation: {
								...history(conversationId, []).conversation,
								status: "ready",
								selectedModelOptionId: "model-secondary",
								selectedReasoningLevel: "high",
								lastConversationCursor: accepted
									? failedStatus.conversationCursor
									: null,
							},
							messages: accepted
								? [
										message,
										{
											...message,
											messageId: "answer-provider-failed",
											role: "assistant",
											text: "",
											status: "failed",
											replyToMessageId: messageId,
											answerVersion: 1,
											isCurrentAnswer: true,
											error: failure,
										},
									]
								: [],
						}),
					});
				else if (
					request.method() === "GET" &&
					path === `/api/v2/conversations/${conversationId}/events`
				)
					await route.fulfill({
						contentType: "text/event-stream",
						body: ": heartbeat\n\n",
					});
				else if (
					request.method() === "GET" &&
					path ===
						`/api/v2/conversations/${conversationId}/executions/${executionId}`
				)
					await route.fulfill({
						json: ExecutionDetailProjectionV2Schema.parse({
							...execution(conversationId, executionId),
							status: "failed",
							error: failure,
							finishedAt: timestamp,
							events: [failedStatus],
						}),
					});
				else {
					unexpected.push(`${request.method()} ${path}`);
					await route.fulfill({ status: 500 });
				}
			});
			await page.goto(`/chat/${agentId}/${conversationId}`);
			const input = page.getByRole("textbox", { name: "消息", exact: true });
			await input.fill(question);
			await page.getByRole("button", { name: "发送", exact: true }).click();
			const timeline = page.getByRole("region", { name: "会话时间线" });
			await expect(
				timeline.getByText("执行失败", { exact: true }),
			).toBeVisible();
			await expect(timeline).toContainText(
				"使用标准模板时，请检查个人 Relay Key",
			);
			await input.fill("下一条草稿");
			await page.getByRole("button", { name: "刷新会话", exact: true }).click();
			await expect(input).toHaveValue("下一条草稿");
			await page.getByRole("button", { name: "执行详情", exact: true }).click();
			const details = page.getByRole("region", { name: "执行详情" });
			const alert = details.getByRole("alert");
			await expect(alert).toContainText("使用标准模板时，请检查个人 Relay Key");
			await expect(alert).toContainText("仍失败请联系 Owner 检查模型配置");
			await expect(alert.getByRole("link")).toHaveCount(0);
			await expect(
				page.getByText(failure.message, { exact: true }),
			).toHaveCount(0);
			for (const viewport of [
				info.project.use.viewport,
				{ width: 320, height: 370 },
			]) {
				if (!viewport) throw new Error("Expected configured browser viewport");
				await page.setViewportSize(viewport);
				await alert.scrollIntoViewIfNeeded();
				await expect(alert).toBeInViewport({ ratio: 1 });
				await info.attach(
					`personal-key-recovery-${source}-${code}-${viewport.width}`,
					{
						body: await page.screenshot({ animations: "disabled" }),
						contentType: "image/png",
					},
				);
			}
			await details
				.getByRole("button", { name: "返回对话", exact: true })
				.focus();
			await page.keyboard.press("Enter");
			for (
				let index = 0;
				index < 12 &&
				!(await input.evaluate((node) => node === document.activeElement));
				index += 1
			)
				await page.keyboard.press("Tab");
			await expect(input).toBeFocused();
			await page.keyboard.type(" / 继续");
			await expect(input).toHaveValue("下一条草稿 / 继续");
			await expect(
				page.getByRole("combobox", { name: "模型", exact: true }),
			).toContainText("Secondary model");
			await expect(
				page.getByRole("combobox", { name: "推理强度", exact: true }),
			).toContainText("high");
			await expect(page).toHaveURL(
				new RegExp(`/chat/${agentId}/${conversationId}$`),
			);
			await expect
				.poll(() =>
					input.evaluate((node) => {
						const rect = node.getBoundingClientRect();
						const hit = document.elementFromPoint(
							rect.left + rect.width / 2,
							rect.top + rect.height / 2,
						);
						return (
							rect.left >= 0 &&
							rect.right <= innerWidth &&
							rect.top >= 0 &&
							rect.bottom <= innerHeight &&
							hit === node
						);
					}),
				)
				.toBe(true);
			expect(writes).toEqual([
				{
					path: `/api/v1/conversations/${conversationId}/messages`,
					body: { schemaVersion: 1, text: question },
				},
			]);
			expect(unexpected).toEqual([]);
		});
	}
}
