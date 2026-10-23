import {
	AgentProjectionV2Schema,
	BrowserSessionProjectionV1Schema,
	CommandAcceptedProjectionV1Schema,
	ConnectionCapabilityProjectionV1Schema,
	ConversationDetailProjectionV2Schema,
	ConversationModelSelectionProjectionV1Schema,
	ConversationPageV1Schema,
	ExecutionDetailProjectionV2Schema,
	PersistedConversationEventV2Schema,
	PilotProtocolErrorV1Schema,
	ReasoningDeltaEventV2Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { expect, test } from "@playwright/test";
import {
	execution,
	history,
} from "../src/features/conversation/conversation-test-fixtures";
import { keepConversationStreamOpen } from "./conversation-stream";
import { controlledFileLimits, isFileLimitsRequest } from "./file-limits";
import { expectFocusSettled } from "./page-health";
import { duplicateControlNames } from "./page-hygiene";
import {
	expectCleanPage,
	expectDistinctDialogControls,
	trackPageErrors,
} from "./primitive-styles";

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
		if (isFileLimitsRequest(request.method(), path))
			return route.fulfill({ json: controlledFileLimits() });
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
	// R4-07：受理与处理状态只在助手回复卡内（spinner + 状态文案），卡外不再有受理行。
	await expect(
		page
			.getByRole("article")
			.getByRole("status")
			.filter({ hasText: /已受理，等待处理|处理中/ }),
	).toBeVisible();
	await expect(page.getByText(/消息已受理，等待处理/)).toHaveCount(0);
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

// #2981：思考过程随推理增量实时展开；答案开始后收起，刷新后仍完整且不重复。
test("streams the thinking process above the reply and restores it folded after reload", async ({
	page,
}) => {
	const question = "请分析这道题";
	const thought = (sequence: number, text: string) =>
		ReasoningDeltaEventV2Schema.parse({
			schemaVersion: 2,
			kind: "event",
			eventId: `live-event-${sequence}`,
			conversationId,
			executionId,
			sequence,
			conversationCursor: `live-cursor-${sequence}`,
			occurredAt: timestamp,
			type: "reasoning.delta",
			payload: { kind: "raw", text },
		});
	const thoughts = [thought(1, "先列出已知条件，"), thought(2, "再逐步推导。")];
	const answerDelta = event("text.delta", 3, { text: "答案是 42。" });
	const completed = event("execution.status", 4, { status: "completed" });
	const userQuestion = {
		messageId,
		role: "user",
		text: question,
		status: "processing",
		executionId,
		replyToMessageId: null,
		answerVersion: null,
		isCurrentAnswer: null,
		error: null,
		createdAt: timestamp,
	};
	let phase: "running" | "completed" = "running";
	await page.addInitScript(() => {
		type FixtureWindow = Window & {
			hasConversationStream: () => boolean;
			emitConversationFrame: (value: unknown, id: string) => void;
		};
		const fixture = window as unknown as FixtureWindow;
		const realFetch = window.fetch.bind(window);
		const encoder = new TextEncoder();
		let activeController:
			| ReadableStreamDefaultController<Uint8Array>
			| undefined;
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
		if (isFileLimitsRequest(request.method(), path))
			return route.fulfill({ json: controlledFileLimits() });
		if (path === "/api/v2/me/conversations/recent")
			return route.fulfill({
				json: ConversationPageV1Schema.parse({ items: [], nextCursor: null }),
			});
		if (path.endsWith("/session"))
			return route.fulfill({ json: ownerSession() });
		if (path === `/api/v2/agents/${agentId}`)
			return route.fulfill({ json: activeAgent() });
		if (path === `/api/v2/conversations/${conversationId}`) {
			const events =
				phase === "completed" ? [...thoughts, answerDelta, completed] : [];
			return route.fulfill({
				json: ConversationDetailProjectionV2Schema.parse({
					schemaVersion: 2,
					conversation: {
						schemaVersion: 1,
						conversationId,
						agentId,
						title: "思考过程验收会话",
						status: phase === "completed" ? "ready" : "active",
						selectedModelOptionId: null,
						selectedReasoningLevel: null,
						lastConversationCursor: events.at(-1)?.conversationCursor ?? null,
						createdAt: timestamp,
						updatedAt: timestamp,
					},
					messages:
						phase === "completed"
							? [
									{ ...userQuestion, status: "completed" },
									{
										...userQuestion,
										messageId: "answer-live-1",
										role: "assistant",
										text: "答案是 42。",
										status: "completed",
										replyToMessageId: messageId,
										answerVersion: 1,
										isCurrentAnswer: true,
									},
								]
							: [userQuestion],
					events,
				}),
			});
		}
		await route.fulfill({ json: { items: [], nextCursor: null } });
	});

	await page.goto(
		`/agents/${agentId}/conversations?conversation=${conversationId}`,
	);
	await expect(page.getByText(question, { exact: true })).toBeVisible();
	await page.waitForFunction(() =>
		(
			window as unknown as { hasConversationStream: () => boolean }
		).hasConversationStream(),
	);
	const emit = (frame: unknown, id: string) =>
		page.evaluate(
			([value, frameId]) =>
				(
					window as unknown as {
						emitConversationFrame: (value: unknown, id: string) => void;
					}
				).emitConversationFrame(value, frameId as string),
			[frame, id] as const,
		);
	const toggle = page.getByRole("button", { name: `思考过程：${question}` });
	await expect(toggle).toHaveCount(0);
	await emit(thoughts[0], "live-event-1");
	await emit(thoughts[1], "live-event-2");
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await expect(
		page.getByText("先列出已知条件，再逐步推导。", { exact: true }),
	).toBeVisible();
	await test.info().attach("conversation-thinking-live", {
		body: await page.screenshot({ fullPage: true }),
		contentType: "image/png",
	});

	await emit(answerDelta, "live-event-3");
	await expect(page.getByText("答案是 42。", { exact: true })).toBeVisible();
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(
		page.getByText("先列出已知条件，再逐步推导。", { exact: true }),
	).toBeHidden();

	phase = "completed";
	await emit(completed, "live-event-4");
	await expect(
		page.getByRole("button", { name: `重新生成：${question}` }),
	).toBeVisible();
	await page.reload();
	await expect(page.getByText("答案是 42。", { exact: true })).toBeVisible();
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await expect(
		page.getByText("先列出已知条件，再逐步推导。", { exact: true }),
	).toHaveCount(1);
	await expect(
		page.getByText("先列出已知条件，再逐步推导。", { exact: true }),
	).toBeVisible();
	await test.info().attach("conversation-thinking-after-reload", {
		body: await page.screenshot({ fullPage: true }),
		contentType: "image/png",
	});
});

// #3068：新一轮流式输出期间重新读取时间线（补发窗口外的 timeline.reload、回复结束后的重读）时，
// 服务端首屏窗口只剩最新一轮；前一轮的回复卡与思考过程不能从页面消失。
test("keeps the previous reply and its thinking process while the next round streams", async ({
	page,
}) => {
	const firstQuestion = "第一轮的问题";
	const secondQuestion = "第二轮的问题";
	const firstExecution = "execution-round-1";
	const secondExecution = "execution-round-2";
	type Fact =
		| { type: "reasoning.delta"; text: string }
		| { type: "text.delta"; text: string }
		| { type: "execution.status"; status: "processing" | "completed" };
	const persisted = (executionId: string, sequence: number, fact: Fact) => {
		const position = (executionId === firstExecution ? 0 : 5) + sequence;
		const base = {
			kind: "event",
			eventId: `round-event-${position}`,
			conversationId,
			executionId,
			sequence,
			conversationCursor: `round-cursor-${position}`,
			occurredAt: timestamp,
		};
		if (fact.type === "reasoning.delta")
			return ReasoningDeltaEventV2Schema.parse({
				...base,
				schemaVersion: 2,
				type: fact.type,
				payload: { kind: "raw", text: fact.text },
			});
		return PersistedConversationEventV2Schema.parse({
			...base,
			schemaVersion: 1,
			type: fact.type,
			payload:
				fact.type === "text.delta"
					? { text: fact.text }
					: { status: fact.status },
		});
	};
	const firstRound = [
		persisted(firstExecution, 1, {
			type: "execution.status",
			status: "processing",
		}),
		persisted(firstExecution, 2, {
			type: "reasoning.delta",
			text: "先回顾题目，",
		}),
		persisted(firstExecution, 3, {
			type: "reasoning.delta",
			text: "再给出结论。",
		}),
		persisted(firstExecution, 4, {
			type: "text.delta",
			text: "第一轮的答案。",
		}),
		persisted(firstExecution, 5, {
			type: "execution.status",
			status: "completed",
		}),
	];
	const secondRound = [
		persisted(secondExecution, 1, {
			type: "execution.status",
			status: "processing",
		}),
		persisted(secondExecution, 2, {
			type: "reasoning.delta",
			text: "比较两种方案，",
		}),
		persisted(secondExecution, 3, {
			type: "reasoning.delta",
			text: "选择更稳妥的一种。",
		}),
		persisted(secondExecution, 4, {
			type: "text.delta",
			text: "第二轮的答案。",
		}),
		persisted(secondExecution, 5, {
			type: "execution.status",
			status: "completed",
		}),
	];
	const message = (
		messageId: string,
		role: "user" | "assistant",
		text: string,
		status: "processing" | "completed",
		executionId: string,
		replyToMessageId: string | null = null,
	) => ({
		messageId,
		role,
		text,
		status,
		executionId,
		replyToMessageId,
		answerVersion: role === "assistant" ? 1 : null,
		isCurrentAnswer: role === "assistant" ? true : null,
		error: null,
		createdAt: timestamp,
	});
	// initial：两轮都在首屏；streaming / completed：服务端窗口只含第 2 轮，第 1 轮的回答投影为空。
	let phase: "initial" | "streaming" | "completed" = "initial";
	await page.addInitScript(() => {
		type FixtureWindow = Window & {
			conversationStreams: () => number;
			emitConversationFrame: (value: unknown, id?: string) => void;
		};
		const fixture = window as unknown as FixtureWindow;
		const realFetch = window.fetch.bind(window);
		const encoder = new TextEncoder();
		let streams = 0;
		let activeController:
			| ReadableStreamDefaultController<Uint8Array>
			| undefined;
		fixture.conversationStreams = () => (activeController ? streams : 0);
		fixture.emitConversationFrame = (value, id) => {
			if (!activeController)
				throw new Error("The conversation stream is not open");
			activeController.enqueue(
				encoder.encode(
					`${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(value)}\n\n`,
				),
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
					streams += 1;
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
		if (isFileLimitsRequest(request.method(), path))
			return route.fulfill({ json: controlledFileLimits() });
		if (path === "/api/v2/me/conversations/recent")
			return route.fulfill({
				json: ConversationPageV1Schema.parse({ items: [], nextCursor: null }),
			});
		if (path.endsWith("/session"))
			return route.fulfill({ json: ownerSession() });
		if (path === `/api/v2/agents/${agentId}`)
			return route.fulfill({ json: activeAgent() });
		if (path === `/api/v2/conversations/${conversationId}`) {
			const events =
				phase === "initial"
					? [...firstRound, secondRound[0]]
					: phase === "streaming"
						? secondRound.slice(0, 3)
						: secondRound;
			return route.fulfill({
				json: ConversationDetailProjectionV2Schema.parse({
					schemaVersion: 2,
					conversation: {
						schemaVersion: 1,
						conversationId,
						agentId,
						title: "多轮思考会话",
						status: phase === "completed" ? "ready" : "active",
						selectedModelOptionId: null,
						selectedReasoningLevel: null,
						lastConversationCursor: events.at(-1)?.conversationCursor ?? null,
						createdAt: timestamp,
						updatedAt: timestamp,
					},
					messages: [
						message(
							"question-1",
							"user",
							firstQuestion,
							"completed",
							firstExecution,
						),
						message(
							"answer-1",
							"assistant",
							phase === "initial" ? "第一轮的答案。" : "",
							"completed",
							firstExecution,
							"question-1",
						),
						message(
							"question-2",
							"user",
							secondQuestion,
							phase === "completed" ? "completed" : "processing",
							secondExecution,
						),
						...(phase === "completed"
							? [
									message(
										"answer-2",
										"assistant",
										"第二轮的答案。",
										"completed",
										secondExecution,
										"question-2",
									),
								]
							: []),
					],
					events,
					eventWindow:
						phase === "initial"
							? { hasEarlier: false, beforeCursor: null }
							: { hasEarlier: true, beforeCursor: "before-round-2" },
				}),
			});
		}
		await route.fulfill({ json: { items: [], nextCursor: null } });
	});

	await page.goto(
		`/agents/${agentId}/conversations?conversation=${conversationId}`,
	);
	const firstAnswer = page.getByText("第一轮的答案。", { exact: true });
	const firstToggle = page.getByRole("button", {
		name: `思考过程：${firstQuestion}`,
	});
	const secondToggle = page.getByRole("button", {
		name: `思考过程：${secondQuestion}`,
	});
	const streamsOpened = () =>
		page.evaluate(() =>
			(
				window as unknown as { conversationStreams: () => number }
			).conversationStreams(),
		);
	const emit = (frame: unknown, id?: string) =>
		page.evaluate(
			([value, frameId]) =>
				(
					window as unknown as {
						emitConversationFrame: (value: unknown, id?: string) => void;
					}
				).emitConversationFrame(value, frameId ?? undefined),
			[frame, id ?? null] as const,
		);
	await expect(firstAnswer).toBeVisible();
	await expect(firstToggle).toBeVisible();
	await expect.poll(streamsOpened).toBeGreaterThan(0);
	await emit(secondRound[1], secondRound[1].eventId);
	await expect(secondToggle).toHaveAttribute("aria-expanded", "true");

	// 一批思考增量超过补发窗口：服务端要求重新加载，新首屏只剩第 2 轮。
	phase = "streaming";
	const streamsBeforeReload = await streamsOpened();
	await emit({
		schemaVersion: 1,
		kind: "control",
		type: "timeline.reload",
		reason: "cursor_expired",
		resumeCursor: secondRound[2].conversationCursor,
	});
	await expect.poll(streamsOpened).toBeGreaterThan(streamsBeforeReload);
	await emit(secondRound[3], secondRound[3].eventId);
	await expect(page.getByText("第二轮的答案。", { exact: true })).toBeVisible();
	await expect(firstAnswer).toBeVisible();
	await expect(firstToggle).toBeVisible();
	await expect(page.getByText("正文在更早的记录中")).toHaveCount(0);
	await test.info().attach("conversation-previous-round-while-streaming", {
		body: await page.screenshot({ fullPage: true }),
		contentType: "image/png",
	});

	// 回复结束后重读投影，窗口仍只含第 2 轮；两轮的回复卡与思考过程都还在。
	phase = "completed";
	await emit(secondRound[4], secondRound[4].eventId);
	await expect(
		page.getByRole("button", { name: `重新生成：${secondQuestion}` }),
	).toBeVisible();
	await expect(firstAnswer).toBeVisible();
	await expect(page.getByText("第二轮的答案。", { exact: true })).toHaveCount(
		1,
	);
	await expect(page.getByRole("button", { name: /^思考过程：/ })).toHaveCount(
		2,
	);
	await expect(page.getByText("正文在更早的记录中")).toHaveCount(0);
	await firstToggle.click();
	await expect(firstToggle).toHaveAttribute("aria-expanded", "true");
	await expect(
		page.getByText("先回顾题目，再给出结论。", { exact: true }),
	).toHaveCount(1);
	await test.info().attach("conversation-previous-round-after-completion", {
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
		if (isFileLimitsRequest(route.request().method(), path))
			return route.fulfill({ json: controlledFileLimits() });
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
		page.getByText("当前登录或访问权限已失效，请重新登录或返回 Agent 目录。"),
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
		if (isFileLimitsRequest(route.request().method(), path))
			return route.fulfill({ json: controlledFileLimits() });
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
		page.getByText("当前登录或访问权限已失效，请重新登录或返回 Agent 目录。"),
	).toHaveCount(0);
	await expect(page.getByRole("button", { name: "重新连接" })).toBeVisible();
	await test.info().attach("fake-404-unavailable", {
		body: await page.screenshot({ fullPage: true }),
		contentType: "image/png",
	});
	const readsBeforeReconnect = historyReads;
	missing = false;
	await page.getByRole("button", { name: "重新连接" }).click();
	// 会话标题行已按设计删除（CH-05）：以时间线重新出现确认读取恢复。
	await expect(page.getByRole("region", { name: "会话时间线" })).toBeVisible();
	await expect(page.getByRole("button", { name: "重新连接" })).toHaveCount(0);
	// #3269 N8-3-02：「重新连接」随中断提示卸载后焦点交给页面 h1，不落到 body。
	await expectFocusSettled(
		page.getByRole("heading", { level: 1 }),
		"重新连接后",
		[30, 150, 400, 1000],
	);
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
		if (isFileLimitsRequest(request.method(), url.pathname))
			return route.fulfill({ json: controlledFileLimits() });
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
	await page.getByRole("button", { name: /^查看执行详情/ }).click();
	await expect(page.getByText(oldSummary, { exact: true })).toBeVisible();
	missing = true;
	await page
		.getByRole("button", { name: "核实原执行状态", exact: true })
		.click();
	const details = page.getByRole("dialog", { name: "执行详情" });
	await expect(
		details.getByText("执行记录暂时无法读取。", { exact: true }),
	).toBeVisible();
	await expect(
		details.getByRole("button", { name: "重新读取详情", exact: true }),
	).toBeVisible();
	await expect(page.getByText(oldSummary, { exact: true })).toHaveCount(0);
	await expect(
		page.getByText("当前登录或访问权限已失效，请重新登录或返回 Agent 目录。"),
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
	// #3269 N8-3-02：「重新读取详情」随失败提示卸载后焦点交给执行详情弹窗，不落到 body。
	await expectFocusSettled(details, "重新读取详情后", [30, 150, 400, 1000]);
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
}, info) => {
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
	const unexpectedMessageWrites: string[] = [];
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
				// 服务端投影：已取消的 Execution 即使没有正文也有一条回答（conversation-read-projection）。
				...(phase === "cancelled"
					? [
							{
								...userMessage,
								messageId: `assistant:${executionId}`,
								role: "assistant" as const,
								text: "",
								status: "cancelled" as const,
								replyToMessageId: messageId,
								answerVersion: 1,
								isCurrentAnswer: true,
							},
						]
					: []),
			],
		});
	};
	await keepConversationStreamOpen(page);
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (isFileLimitsRequest(request.method(), path))
			return route.fulfill({ json: controlledFileLimits() });
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
		if (path === `/api/v1/conversations/${conversationId}/messages`) {
			unexpectedMessageWrites.push(request.method());
			await route.fulfill({
				status: 500,
				json: { code: "UNEXPECTED_MESSAGE_WRITE" },
			});
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
	const input = page.getByRole("textbox", { name: "消息", exact: true });
	await input.fill("保留下一条草稿");
	// CH-01：模型与思考入口在 composer 工具栏内，选中即保存；没有独立的模型行和保存按钮。
	const toolbar = page.locator("form.composer-zone .composer-controls");
	const modelTrigger = toolbar.locator(".composer-setting-trigger").first();
	await expect(modelTrigger).toHaveAccessibleName(
		"选择模型，当前 Primary model，思考均衡，下一条消息生效",
	);
	await expect(page.getByRole("button", { name: "保存模型选择" })).toHaveCount(
		0,
	);
	await expect(
		page.getByRole("group", { name: "下一条消息的模型" }),
	).toHaveCount(0);
	expect(
		await modelTrigger.evaluate((node) => {
			const timeline = document.querySelector(".timeline");
			return Boolean(
				timeline &&
					node.compareDocumentPosition(timeline) &
						Node.DOCUMENT_POSITION_PRECEDING,
			);
		}),
	).toBe(true);
	for (const viewport of [
		info.project.use.viewport,
		{ width: 320, height: 370 },
	]) {
		if (!viewport) throw new Error("Expected configured viewport");
		await page.setViewportSize(viewport);
		for (const [index, control] of [
			modelTrigger,
			page.getByText("继续检查当前任务", { exact: true }),
			input,
			page.getByRole("button", { name: "发送补充指令", exact: true }),
		].entries()) {
			await control.evaluate((node) =>
				node.scrollIntoView({
					block: "center",
					inline: "nearest",
					behavior: "instant",
				}),
			);
			await info.attach(
				`model-controls-and-composer-${viewport.width}-${index}`,
				{
					body: await page.screenshot({ animations: "disabled" }),
					contentType: "image/png",
				},
			);
			await expect(control).toBeInViewport({ ratio: 1 });
			if (index !== 1) {
				expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(
					44,
				);
			}
			await control.click({ trial: true });
		}
		expect(
			await page.evaluate(
				() =>
					Math.max(
						document.documentElement.scrollWidth,
						document.body.scrollWidth,
					) <= innerWidth,
			),
		).toBe(true);
	}
	await page.setViewportSize(
		info.project.use.viewport ?? { width: 1440, height: 1000 },
	);
	await modelTrigger.click();
	const menu = page.getByRole("menu", { name: "模型与思考设置" });
	await expect(menu).toBeVisible();
	await expect(
		menu.getByRole("menuitemradio", { name: "Primary model" }),
	).toHaveAttribute("aria-checked", "true");
	await menu.getByRole("menuitemradio", { name: "Secondary model" }).click();
	await expect(menu).toBeHidden();
	// 保存后焦点回到触发器，草稿保持不变；成功只有读屏状态，没有常驻「已保存」。
	await expect(modelTrigger).toBeFocused();
	await expect(modelTrigger).toHaveAccessibleName(
		"选择模型，当前 Secondary model，思考高，下一条消息生效",
	);
	await expect(page.getByText("设置已保存，对下一条消息生效")).toHaveCount(1);
	await expect(
		page.getByText("模型选择已保存，从下一条消息开始生效。"),
	).toHaveCount(0);
	await expect(input).toHaveValue("保留下一条草稿");
	await page.getByRole("button", { name: "停止回复" }).click();
	// Z-14：停止确认后用 Toast 补充确认，回复卡状态行给出「可重新生成」与重新生成入口。
	await expect(
		page.locator('[data-slot="toast"]').filter({ hasText: "回复已停止" }),
	).toBeVisible();
	const stoppedLine = page
		.getByRole("article", { name: `${agent.name}的消息` })
		.locator(".message-status")
		.first();
	await expect(stoppedLine).toHaveText(
		"已停止 · 可重新生成 · 重新生成 · 查看执行详情",
	);
	await expect(
		stoppedLine.getByRole("button", { name: "重新生成：继续检查当前任务" }),
	).toBeVisible();
	await expect(page.getByText("原回复已结束。")).toHaveCount(0);
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
	expect(unexpectedMessageWrites).toEqual([]);
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

// #2830 终验第二轮 A：处理中卡片按导出稿（A2-08），停止回复后焦点不落到 body（A2-09）。
for (const mode of ["click", "keyboard"] as const) {
	test(`processing card follows the design and stopping by ${mode} keeps focus off the body (A2-08, A2-09)`, async ({
		page,
	}, info) => {
		const errors = trackPageErrors(page);
		const mobile = info.project.name === "mobile";
		await page.setViewportSize(
			mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
		);
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
		// 停止受理后的回读先挂起，页面停在「正在停止」，再放行到已取消的投影。
		let releaseCancelled = () => {};
		const cancelledGate = new Promise<void>((resolve) => {
			releaseCancelled = resolve;
		});
		const detail = () =>
			ConversationDetailProjectionV2Schema.parse({
				...history(
					conversationId,
					phase === "cancelled" ? [processing, cancelled] : [processing],
				),
				conversation: {
					...history(conversationId, []).conversation,
					status: phase === "cancelled" ? "ready" : "active",
				},
				messages: [
					{
						...userMessage,
						status: phase === "cancelled" ? "cancelled" : "processing",
					},
					...(phase === "cancelled"
						? [
								{
									...userMessage,
									messageId: `assistant:${executionId}`,
									role: "assistant" as const,
									text: "",
									status: "cancelled" as const,
									replyToMessageId: messageId,
									answerVersion: 1,
									isCurrentAnswer: true,
								},
							]
						: []),
				],
			});
		const stops: unknown[] = [];
		await keepConversationStreamOpen(page);
		await page.route(/\/api\/v[12]\//, async (route) => {
			const request = route.request();
			const path = new URL(request.url()).pathname;
			if (isFileLimitsRequest(request.method(), path))
				return route.fulfill({ json: controlledFileLimits() });
			if (path === "/api/v2/me/conversations/recent")
				return route.fulfill({
					json: ConversationPageV1Schema.parse({ items: [], nextCursor: null }),
				});
			if (path.endsWith("/events"))
				return route.fulfill({
					status: 200,
					contentType: "text/event-stream",
					body: ": heartbeat\n\n",
				});
			if (path.endsWith("/session"))
				return route.fulfill({ json: ownerSession() });
			if (path === `/api/v2/agents/${agentId}`)
				return route.fulfill({ json: agent });
			if (path === `/api/v2/conversations/${conversationId}`) {
				if (phase === "cancelled") await cancelledGate;
				return route.fulfill({ json: detail() });
			}
			if (path.endsWith("/stops")) {
				stops.push(request.postDataJSON());
				phase = "cancelled";
				return route.fulfill({
					status: 202,
					json: {
						schemaVersion: 1,
						status: "submitted",
						messageId: null,
						executionId,
					},
				});
			}
			await route.fulfill({ json: { items: [], nextCursor: null } });
		});
		await page.goto(`/chat/${agentId}/${conversationId}`);
		const reply = page.getByRole("article", { name: `${agent.name}的消息` });
		const stop = reply.getByRole("button", { name: "停止回复", exact: true });
		await expect(stop).toBeVisible();
		// A2-08：「正在整理结果…」用正文色，状态行到「停止回复」16px。
		const pending = reply.getByText("正在整理结果…", { exact: true });
		await expect(pending).toHaveCSS(
			"color",
			await page.evaluate(() => {
				const probe = document.createElement("span");
				probe.style.color = "var(--foreground)";
				document.body.append(probe);
				const color = getComputedStyle(probe).color;
				probe.remove();
				return color;
			}),
		);
		const actions = reply.locator(".card-actions");
		await expect(actions).toHaveCSS("margin-top", "16px");
		const [status, actionsBox] = await Promise.all([
			reply.locator(".message-status").boundingBox(),
			actions.boundingBox(),
		]);
		if (!status || !actionsBox) throw new Error("Expected card geometry");
		expect(
			Math.abs(actionsBox.y - (status.y + status.height) - 16),
		).toBeLessThanOrEqual(0.5);
		// E3-02：处理中「命令 / Skill」入口按设计禁用（opacity .48、not-allowed），活跃回复期间
		// 不再启动新的命令任务或 Skill（PRD §11.3）；输入框与「发送补充指令」不受影响。
		const capabilityTrigger = page.getByRole("button", {
			name: "选择命令或 Skill",
		});
		await expect(capabilityTrigger).toBeDisabled();
		await expect(capabilityTrigger).toHaveCSS("opacity", "0.48");
		await expect(capabilityTrigger).toHaveCSS("cursor", "not-allowed");
		const message = page.getByRole("textbox", { name: "消息", exact: true });
		await expect(message).toBeEnabled();
		await message.fill("补充检查范围");
		await expect(
			page.getByRole("button", { name: "发送补充指令", exact: true }),
		).toBeEnabled();
		await message.fill("");
		await expectCleanPage(page, errors);
		if (mode === "click") await stop.click();
		else {
			await stop.focus();
			await page.keyboard.press("Enter");
		}
		// 停止受理、等待确认期间按钮改为「正在停止」并保持焦点（aria-disabled），不落到 body。
		const stopping = reply.getByRole("button", {
			name: "正在停止",
			exact: true,
		});
		await expect(stopping).toBeFocused();
		await expect(stopping).toHaveAttribute("aria-disabled", "true");
		await expect(stopping).toBeDisabled();
		releaseCancelled();
		await expect(
			page.locator('[data-slot="toast"]').filter({ hasText: "回复已停止" }),
		).toBeVisible();
		const regenerate = reply.getByRole("button", {
			name: "重新生成：继续检查当前任务",
		});
		await expect(regenerate).toBeFocused();
		// 稍后仍在「重新生成」上，没有被后续回读挪到 body。
		await page.waitForTimeout(300);
		await expect(regenerate).toBeFocused();
		expect(
			await page.evaluate(() => document.activeElement === document.body),
		).toBe(false);
		await expect(
			reply.getByRole("button", { name: /停止回复|正在停止/ }),
		).toHaveCount(0);
		// E3-02：回复结束后「命令 / Skill」入口恢复可用。
		await expect(capabilityTrigger).toBeEnabled();
		expect(stops).toEqual([
			{ schemaVersion: 1, targetExecutionId: executionId },
		]);
		await expectCleanPage(page, errors);
		expect(await duplicateControlNames(page)).toEqual([]);
	});
}

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
		if (isFileLimitsRequest(request.method(), path))
			return route.fulfill({ json: controlledFileLimits() });
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
	await page.getByRole("button", { name: /^重新生成/ }).click();
	// R4-07：重新生成受理后，新回复卡内显示受理状态，卡外没有受理行。
	await expect(
		page
			.getByRole("article")
			.getByRole("status")
			.filter({ hasText: "已受理，等待处理" }),
	).toBeVisible();
	await expect(page.getByText(/消息已受理，等待处理/)).toHaveCount(0);
	expect(regenerateBody).toEqual({
		schemaVersion: 1,
		messageId,
	});
	// 原回答与重新生成的新回复各有一个入口，可访问名称可以区分（N-12）。
	await expect(
		page.getByRole("button", { name: "查看执行详情：回复" }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "查看执行详情：请检查当前任务" })
		.click();
	const details = page.getByRole("dialog", { name: "执行详情" });
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
				if (isFileLimitsRequest(request.method(), path))
					return route.fulfill({ json: controlledFileLimits() });
				if (
					request.method() === "GET" &&
					path === "/api/v1/connection/capability"
				)
					return route.fulfill({
						json: ConnectionCapabilityProjectionV1Schema.parse({
							schemaVersion: 1,
							status: "unavailable",
							reason: "missing",
						}),
					});
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
					request.method() === "GET" &&
					path.endsWith("/native-metadata")
				)
					await route.fulfill({
						json: {
							selector:
								new URL(request.url()).searchParams.get("selector") ===
								"commands"
									? "commands"
									: "skills",
							revision: "a".repeat(64),
							capabilities: [],
						},
					});
				else if (
					source === "custom" &&
					request.method() === "GET" &&
					path === `/api/v1/conversations/${conversationId}/model-selection`
				)
					await route.fulfill({
						json: ConversationModelSelectionProjectionV1Schema.parse({
							schemaVersion: 1,
							conversationId,
							agentId,
							source: "custom-platform-adapter",
							available: true,
							options: agent.configuration.modelOptions,
							currentModelOptionId: "model-secondary",
							currentReasoningLevel: "high",
							selectedModelOptionId: "model-secondary",
							selectedReasoningLevel: "high",
						}),
					});
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
			// 「刷新会话」按钮已按设计删除（CH-05），这里只确认草稿保留。
			await expect(input).toHaveValue("下一条草稿");
			await page.getByRole("button", { name: /^查看执行详情/ }).click();
			const details = page.getByRole("dialog", { name: "执行详情" });
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
			// 执行详情是模态弹窗：底部唯一主按钮「关闭」，关闭后焦点回到触发按钮（R4-09）。
			await details
				.locator('[data-slot="dialog-footer"]')
				.getByRole("button", { name: "关闭", exact: true })
				.focus();
			await page.keyboard.press("Enter");
			await expect(details).toHaveCount(0);
			await expect(
				page.getByRole("button", { name: /^查看执行详情/ }),
			).toBeFocused();
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
			// 模型与思考入口在 composer 工具栏内（CH-01），名称同时说明模型与思考档位（CH-12）。
			await expect(
				page.locator("form.composer-zone .composer-setting-trigger").first(),
			).toHaveAccessibleName(
				"选择模型，当前 Secondary model，思考高，下一条消息生效",
			);
			await expect(page).toHaveURL(
				new RegExp(`/chat/${agentId}/${conversationId}$`),
			);
			await info.attach("recovered-composer-geometry", {
				body: JSON.stringify(
					await input.evaluate((node) => ({
						rect: node.getBoundingClientRect().toJSON(),
						viewport: [innerWidth, innerHeight],
						scrollY,
						hit: (() => {
							const r = node.getBoundingClientRect();
							return document
								.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
								?.outerHTML.slice(0, 300);
						})(),
						ancestors: [
							".composer-zone",
							".chat-thread",
							".chat-workspace",
							".conversation-columns",
							".chat-layout",
							".platform-content",
							"#main-content",
						].map((selector) => {
							const el = node.closest(selector);
							return {
								selector,
								rect: el?.getBoundingClientRect().toJSON(),
								overflow: el && getComputedStyle(el).overflow,
								height: el && getComputedStyle(el).height,
							};
						}),
					})),
				),
				contentType: "application/json",
			});
			await info.attach("recovered-composer", {
				body: await page.screenshot({ animations: "disabled" }),
				contentType: "image/png",
			});

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

test("explains a model fallback with the requested and actual model (G-07)", async ({
	page,
}, info) => {
	const pageErrors = trackPageErrors(page);
	// Owner 已从清单删除「Removed model」，会话之后的消息回退到默认选项。
	const agent = activeAgent();
	const legacyExecutionId = "execution-fallback-legacy";
	const currentExecutionId = "execution-fallback-current";
	const fallback = (
		sequence: number,
		executionIdValue: string,
		requested?: string | null,
	) =>
		PersistedConversationEventV2Schema.parse({
			schemaVersion: requested === undefined ? 1 : 2,
			kind: "event",
			eventId: `fallback-event-${sequence}`,
			conversationId,
			executionId: executionIdValue,
			sequence: 1,
			conversationCursor: `fallback-cursor-${sequence}`,
			occurredAt: timestamp,
			type: "model.selection.fell_back",
			payload: {
				modelOptionId: "model-primary",
				reasoningLevel: "medium",
				reason: "selection_unavailable",
				...(requested === undefined
					? {}
					: {
							requestedModelOptionId: "model-removed",
							requestedModelDisplayName: requested,
						}),
			},
		});
	const completedFor = (sequence: number, executionIdValue: string) =>
		PersistedConversationEventV2Schema.parse({
			...event("execution.status", sequence, { status: "completed" }),
			eventId: `fallback-completed-${sequence}`,
			executionId: executionIdValue,
			sequence: 2,
			conversationCursor: `fallback-cursor-${sequence}`,
		});
	const turn = (executionIdValue: string, question: string, reply: string) => [
		{
			messageId: `${executionIdValue}-question`,
			role: "user" as const,
			text: question,
			status: "completed" as const,
			executionId: executionIdValue,
			replyToMessageId: null,
			answerVersion: null,
			isCurrentAnswer: null,
			error: null,
			createdAt: timestamp,
		},
		{
			messageId: `${executionIdValue}-answer`,
			role: "assistant" as const,
			text: reply,
			status: "completed" as const,
			executionId: executionIdValue,
			replyToMessageId: `${executionIdValue}-question`,
			answerVersion: 1,
			isCurrentAnswer: true,
			error: null,
			createdAt: timestamp,
		},
	];
	const detail = ConversationDetailProjectionV2Schema.parse({
		...history(conversationId, [
			// 升级前写入的旧事件没有请求模型字段，仍要正常显示（AC-3）。
			fallback(1, legacyExecutionId),
			completedFor(2, legacyExecutionId),
			fallback(3, currentExecutionId, "Removed model"),
			completedFor(4, currentExecutionId),
		]),
		conversation: {
			...history(conversationId, []).conversation,
			status: "ready",
			selectedModelOptionId: "model-primary",
			selectedReasoningLevel: "medium",
			lastConversationCursor: "fallback-cursor-4",
		},
		messages: [
			...turn(legacyExecutionId, "升级前的问题", "旧回答。"),
			...turn(currentExecutionId, "删除选项后的问题", "新回答。"),
		],
	});
	await keepConversationStreamOpen(page);
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (isFileLimitsRequest(request.method(), path))
			return route.fulfill({ json: controlledFileLimits() });
		if (path === "/api/v2/me/conversations/recent")
			return route.fulfill({
				json: ConversationPageV1Schema.parse({ items: [], nextCursor: null }),
			});
		if (path.endsWith("/events"))
			return route.fulfill({
				status: 200,
				contentType: "text/event-stream",
				body: ": heartbeat\n\n",
			});
		if (path.endsWith("/session"))
			return route.fulfill({ json: ownerSession() });
		if (path === `/api/v2/agents/${agentId}`)
			return route.fulfill({ json: agent });
		if (path === `/api/v2/conversations/${conversationId}`)
			return route.fulfill({ json: detail });
		await route.fulfill({ json: { items: [], nextCursor: null } });
	});

	await page.goto(
		`/agents/${agentId}/conversations?conversation=${conversationId}`,
	);
	await expect(page.getByText("新回答。", { exact: true })).toBeVisible();
	const facts = (dialog: ReturnType<typeof page.getByRole>) =>
		dialog
			.locator("dl.model-fallback-facts")
			.evaluate((list) =>
				Object.fromEntries(
					[...list.querySelectorAll("dt")].map((term) => [
						term.textContent,
						term.nextElementSibling?.textContent,
					]),
				),
			);

	const current = page.getByRole("button", {
		name: "查看模型状态：删除选项后的问题",
	});
	await current.click();
	const dialog = page.getByRole("dialog", { name: "模型回退" });
	await expect(dialog).toBeVisible();
	expect(await facts(dialog)).toEqual({
		请求模型: "Removed model",
		实际模型: "Primary model",
		原因: "会话所选的模型选项已被 Owner 移除，已在当前 Agent 允许范围内改用默认选项。",
	});
	await expect(dialog).not.toContainText("model-removed");
	await expect(dialog).not.toContainText("model-primary");
	// #3037 X-04：页眉图标钮与页脚主按钮不同名。
	await expectDistinctDialogControls(dialog);
	await expectCleanPage(page, pageErrors);
	await info.attach("model-fallback-requested", {
		body: await page.screenshot({ animations: "disabled" }),
		contentType: "image/png",
	});
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	await expect(current).toBeFocused();

	await page
		.getByRole("button", { name: "查看模型状态：升级前的问题" })
		.click();
	await expect(dialog).toBeVisible();
	expect(await facts(dialog)).toMatchObject({
		请求模型: "已删除的模型选项",
		实际模型: "Primary model",
	});
	await expect(dialog).not.toContainText("model-removed");
});

// #3179 G4-03 ~ G4-07：时间线提问→回复与轮次之间等距（设计 .messages gap：1440 22px、≤767 16px）；
// 个人历史面板「此 Agent 的全部历史」上距 12px；「命令 / Skill」沿用按钮字距 .02em；思考强度入口为齿轮；
// 模型与思考菜单选项为指针。
test("conversation timeline, history scope switch and composer toolbar follow the design (G4-03 ~ G4-07)", async ({
	page,
}, info) => {
	const mobile = info.project.name === "mobile";
	await page.setViewportSize(
		mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
	);
	const errors = trackPageErrors(page);
	const agent = activeAgent();
	const secondExecution = "execution-live-2";
	const completedEvent = (sequence: number, id: string) =>
		PersistedConversationEventV2Schema.parse({
			schemaVersion: 1,
			kind: "event",
			eventId: `live-event-${sequence}`,
			conversationId,
			executionId: id,
			sequence,
			conversationCursor: `live-cursor-${sequence}`,
			occurredAt: timestamp,
			type: "execution.status",
			payload: { status: "completed" },
		});
	const exchange = (index: number, id: string) => [
		{
			messageId: `question-live-${index}`,
			role: "user" as const,
			text: `第 ${index} 个问题`,
			status: "completed" as const,
			executionId: id,
			replyToMessageId: null,
			answerVersion: null,
			isCurrentAnswer: null,
			error: null,
			createdAt: timestamp,
		},
		{
			messageId: `answer-live-${index}`,
			role: "assistant" as const,
			text: `第 ${index} 个回答。`,
			status: "completed" as const,
			executionId: id,
			replyToMessageId: `question-live-${index}`,
			answerVersion: 1,
			isCurrentAnswer: true,
			error: null,
			createdAt: timestamp,
		},
	];
	const detail = ConversationDetailProjectionV2Schema.parse({
		...history(conversationId, [
			completedEvent(1, executionId),
			completedEvent(2, secondExecution),
		]),
		conversation: {
			...history(conversationId, []).conversation,
			status: "ready",
			selectedModelOptionId: "model-primary",
			selectedReasoningLevel: "medium",
		},
		messages: [...exchange(1, executionId), ...exchange(2, secondExecution)],
	});
	await keepConversationStreamOpen(page);
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (isFileLimitsRequest(request.method(), path))
			return route.fulfill({ json: controlledFileLimits() });
		if (path === "/api/v2/me/conversations/recent")
			return route.fulfill({
				json: ConversationPageV1Schema.parse({ items: [], nextCursor: null }),
			});
		if (path.endsWith("/events"))
			return route.fulfill({
				status: 200,
				contentType: "text/event-stream",
				body: ": heartbeat\n\n",
			});
		if (path.endsWith("/session"))
			return route.fulfill({ json: ownerSession() });
		if (path === `/api/v2/agents/${agentId}`)
			return route.fulfill({ json: agent });
		if (path === `/api/v2/conversations/${conversationId}`)
			return route.fulfill({ json: detail });
		return route.fulfill({ json: { items: [], nextCursor: null } });
	});
	await page.goto(`/chat/${agentId}/${conversationId}`);
	const exchanges = page.locator(".timeline .exchange");
	await expect(exchanges).toHaveCount(2);
	await expect(page.getByText("第 2 个回答。", { exact: true })).toBeVisible();
	const gap = mobile ? 16 : 22;
	const box = async (locator: ReturnType<typeof page.locator>) => {
		const value = await locator.boundingBox();
		if (!value) throw new Error("Expected timeline geometry");
		return value;
	};
	for (const index of [0, 1]) {
		const [question, answer] = await Promise.all([
			box(exchanges.nth(index).locator(":scope > *").first()),
			box(exchanges.nth(index).locator(":scope > *").nth(1)),
		]);
		expect(
			Math.abs(answer.y - (question.y + question.height) - gap),
		).toBeLessThanOrEqual(0.5);
	}
	const [firstAnswer, secondQuestion] = await Promise.all([
		box(exchanges.first().locator(":scope > *").nth(1)),
		box(exchanges.nth(1).locator(":scope > *").first()),
	]);
	expect(
		Math.abs(secondQuestion.y - (firstAnswer.y + firstAnswer.height) - gap),
	).toBeLessThanOrEqual(0.5);
	// G4-04：个人历史面板列表下的范围切换上距 12px。
	await expect(page.locator(".history-scope-actions")).toHaveCSS(
		"margin-top",
		"12px",
	);
	// G4-05：「命令 / Skill」沿用按钮字距 .02em（13px → 0.26px）。
	await expect(
		page.getByRole("button", { name: "选择命令或 Skill" }),
	).toHaveCSS("letter-spacing", "0.26px");
	// G4-06：思考强度入口与「Owner 配置」同为 lucide Settings 齿轮，不是 Settings2 滑杆。
	const effort = page.locator(
		"form.composer-zone .composer-setting-trigger[aria-label^='选择思考强度']",
	);
	if (await effort.count()) {
		const classes =
			(await effort.locator("svg.control-glyph").getAttribute("class"))?.split(
				/\s+/,
			) ?? [];
		expect(classes).toContain("lucide-settings");
		expect(classes).not.toContain("lucide-settings-2");
	} else expect(mobile).toBe(true);
	// G4-07：模型与思考菜单选项为指针。
	await page
		.locator("form.composer-zone .composer-setting-trigger")
		.first()
		.click();
	const menu = page.getByRole("menu", { name: "模型与思考设置" });
	await expect(menu).toBeVisible();
	for (const option of await menu.getByRole("menuitemradio").all())
		await expect(option).toHaveCSS("cursor", "pointer");
	await page.keyboard.press("Escape");
	await expect(menu).toBeHidden();
	await expectCleanPage(page, errors);
	expect(await duplicateControlNames(page)).toEqual([]);
});

// #3215 G5-03：设计 .messages 是 grid gap，滚到底时最后一条消息之后只有时间线下内边距
// （1440 20px、≤767 16px），最后一轮 .exchange 不再叠加 22px / 16px 下外边距。
test("the last timeline exchange ends at the timeline bottom padding when scrolled to the end (G5-03)", async ({
	page,
}, info) => {
	const mobile = info.project.name === "mobile";
	await page.setViewportSize(
		mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
	);
	const errors = trackPageErrors(page);
	const agent = activeAgent();
	const rounds = 8;
	const ids = Array.from({ length: rounds }, (_, index) =>
		index ? `execution-tail-${index}` : executionId,
	);
	const completedEvent = (sequence: number, id: string) =>
		PersistedConversationEventV2Schema.parse({
			schemaVersion: 1,
			kind: "event",
			eventId: `tail-event-${sequence}`,
			conversationId,
			executionId: id,
			sequence,
			conversationCursor: `tail-cursor-${sequence}`,
			occurredAt: timestamp,
			type: "execution.status",
			payload: { status: "completed" },
		});
	const exchange = (index: number, id: string) => [
		{
			messageId: `question-tail-${index}`,
			role: "user" as const,
			text: `第 ${index} 个问题`,
			status: "completed" as const,
			executionId: id,
			replyToMessageId: null,
			answerVersion: null,
			isCurrentAnswer: null,
			error: null,
			createdAt: timestamp,
		},
		{
			messageId: `answer-tail-${index}`,
			role: "assistant" as const,
			text: `第 ${index} 个回答。${"这是一段受控的较长回答正文。".repeat(6)}`,
			status: "completed" as const,
			executionId: id,
			replyToMessageId: `question-tail-${index}`,
			answerVersion: 1,
			isCurrentAnswer: true,
			error: null,
			createdAt: timestamp,
		},
	];
	const detail = ConversationDetailProjectionV2Schema.parse({
		...history(
			conversationId,
			ids.map((id, index) => completedEvent(index + 1, id)),
		),
		conversation: {
			...history(conversationId, []).conversation,
			status: "ready",
			selectedModelOptionId: "model-primary",
			selectedReasoningLevel: "medium",
		},
		messages: ids.flatMap((id, index) => exchange(index + 1, id)),
	});
	await keepConversationStreamOpen(page);
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (isFileLimitsRequest(request.method(), path))
			return route.fulfill({ json: controlledFileLimits() });
		if (path === "/api/v2/me/conversations/recent")
			return route.fulfill({
				json: ConversationPageV1Schema.parse({ items: [], nextCursor: null }),
			});
		if (path.endsWith("/events"))
			return route.fulfill({
				status: 200,
				contentType: "text/event-stream",
				body: ": heartbeat\n\n",
			});
		if (path.endsWith("/session"))
			return route.fulfill({ json: ownerSession() });
		if (path === `/api/v2/agents/${agentId}`)
			return route.fulfill({ json: agent });
		if (path === `/api/v2/conversations/${conversationId}`)
			return route.fulfill({ json: detail });
		return route.fulfill({ json: { items: [], nextCursor: null } });
	});
	await page.goto(`/chat/${agentId}/${conversationId}`);
	const timeline = page.getByRole("region", { name: "会话时间线" });
	const exchanges = timeline.locator(".exchange");
	await expect(exchanges).toHaveCount(rounds);
	await expect(
		page.getByText(/^第 8 个回答。/, { exact: false }),
	).toBeVisible();
	const gap = mobile ? 16 : 22;
	// 轮次之间仍是 G4-03 的等距；只有最后一轮去掉下外边距。
	await expect(exchanges.first()).toHaveCSS("margin-bottom", `${gap}px`);
	await expect(exchanges.last()).toHaveCSS("margin-bottom", "0px");
	const tail = await timeline.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
		const last = element.lastElementChild;
		if (!last) throw new Error("Expected a timeline child");
		const style = getComputedStyle(element);
		return {
			lastIsExchange: last.classList.contains("exchange"),
			scrollable: element.scrollHeight > element.clientHeight,
			atEnd:
				Math.abs(
					element.scrollHeight - element.clientHeight - element.scrollTop,
				) <= 1,
			paddingBottom: Number.parseFloat(style.paddingBottom),
			distance:
				element.getBoundingClientRect().bottom -
				Number.parseFloat(style.borderBottomWidth) -
				last.getBoundingClientRect().bottom,
		};
	});
	expect(tail.lastIsExchange).toBe(true);
	expect(tail.scrollable).toBe(true);
	expect(tail.atEnd).toBe(true);
	expect(tail.paddingBottom).toBe(mobile ? 16 : 20);
	// 设计 1440 20px、390 15.3px：最后一条消息到时间线底只剩下内边距（允许亚像素滚动取整）。
	expect(Math.abs(tail.distance - tail.paddingBottom)).toBeLessThanOrEqual(1);
	await expectCleanPage(page, errors);
	expect(await duplicateControlNames(page)).toEqual([]);
});
