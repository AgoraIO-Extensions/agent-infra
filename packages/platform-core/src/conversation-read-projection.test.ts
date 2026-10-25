import { describe, expect, it } from "vitest";

import {
	projectConversationExecutionV1,
	projectConversationMessagesV1,
} from "./conversation-read-projection.js";

const first = new Date("2026-09-06T00:00:00.000Z");
const second = new Date("2026-09-06T00:00:01.000Z");
const third = new Date("2026-09-06T00:00:02.000Z");

describe("Conversation read projection", () => {
	it("owns answer versions, current answer, text assembly, and ordering", () => {
		expect(
			projectConversationMessagesV1({
				messages: [
					{
						messageId: "message-1",
						text: "Run it",
						executionId: "execution-1",
						status: "submitted",
						createdAt: first,
					},
				],
				executions: [
					{
						executionId: "execution-2",
						conversationId: "conversation-1",
						sourceMessageId: "message-1",
						status: "processing",
						createdAt: third,
						updatedAt: third,
						traceId: "trace-2",
					},
					{
						executionId: "execution-1",
						conversationId: "conversation-1",
						sourceMessageId: "message-1",
						status: "completed",
						createdAt: second,
						updatedAt: second,
						traceId: "trace-1",
					},
				],
				events: [
					{
						executionId: "execution-1",
						sequence: 2,
						eventType: "text.delta",
						eventPayload: { type: "text.delta", text: "lo" },
						occurredAt: third,
					},
					{
						executionId: "execution-1",
						sequence: 1,
						eventType: "text.delta",
						eventPayload: { type: "text.delta", text: "Hel" },
						occurredAt: second,
					},
				],
			}),
		).toEqual([
			expect.objectContaining({
				messageId: "message-1",
				role: "user",
				answerVersion: null,
			}),
			expect.objectContaining({
				messageId: "assistant:execution-1",
				text: "Hello",
				answerVersion: 1,
				isCurrentAnswer: false,
			}),
		]);
	});

	it("owns execution status timing and failure projection facts", () => {
		expect(
			projectConversationExecutionV1({
				execution: {
					executionId: "execution-1",
					conversationId: "conversation-1",
					sourceMessageId: "message-1",
					status: "failed",
					createdAt: first,
					updatedAt: third,
					traceId: "trace-1",
				},
				events: [
					{
						executionId: "execution-1",
						sequence: 1,
						eventType: "execution.status",
						eventPayload: {
							type: "execution.status",
							status: "processing",
						},
						occurredAt: second,
					},
					{
						executionId: "execution-1",
						sequence: 2,
						eventType: "execution.detail",
						eventPayload: {
							type: "execution.detail",
							category: "model_call",
							summary: "Runtime reported a model call",
							callId: "call-1",
						},
						occurredAt: second,
					},
					{
						executionId: "execution-1",
						sequence: 3,
						eventType: "execution.status",
						eventPayload: { type: "execution.status", status: "failed" },
						occurredAt: third,
					},
				],
			}),
		).toMatchObject({
			status: "failed",
			startedAt: second,
			finishedAt: third,
			failureTraceId: "trace-1",
			processSummary: [
				{ status: "processing" },
				{
					kind: "agent_summary",
					category: "model_call",
					callId: "call-1",
				},
				{ status: "failed" },
			],
		});
	});

	it("projects a failed supplementary user message", () => {
		expect(
			projectConversationMessagesV1({
				messages: [
					{
						messageId: "message-failed",
						text: "Too late",
						executionId: "execution-1",
						status: "failed",
						failureCode: "ORIGINAL_RESPONSE_NOT_STARTED",
						createdAt: first,
					},
				],
				executions: [
					{
						executionId: "execution-1",
						conversationId: "conversation-1",
						sourceMessageId: null,
						status: "cancelled",
						createdAt: first,
						updatedAt: second,
						traceId: "trace-failed",
					},
				],
				events: [],
			}),
		).toEqual([
			expect.objectContaining({
				messageId: "message-failed",
				role: "user",
				status: "failed",
				failureTraceId: "trace-failed",
				failureCode: "ORIGINAL_RESPONSE_NOT_STARTED",
			}),
		]);
	});

	it("fails closed on malformed persisted facts", () => {
		expect(() =>
			projectConversationMessagesV1({
				messages: [],
				executions: [
					{
						executionId: "execution-1",
						conversationId: "conversation-1",
						sourceMessageId: "message-1",
						status: "completed",
						createdAt: first,
						updatedAt: second,
						traceId: null,
					},
				],
				events: [
					{
						executionId: "execution-1",
						sequence: 1,
						eventType: "text.delta",
						eventPayload: { type: "text.delta", text: "safe", secret: true },
						occurredAt: second,
					},
				],
			}),
		).toThrow();
		expect(() =>
			projectConversationMessagesV1({
				messages: [
					{
						messageId: "message-1",
						text: "Run it",
						executionId: "execution-1",
						status: "unknown",
						createdAt: first,
					},
				],
				executions: [],
				events: [],
			}),
		).toThrow();
	});
});

describe("queued message projection (#3376)", () => {
	const at = (minute: number) => new Date(`2026-10-25T00:0${minute}:00.000Z`);
	const user = (
		messageId: string,
		executionId: string,
		minute: number,
		status = "submitted",
		failureCode: string | null = null,
	) => ({
		messageId,
		text: messageId,
		executionId,
		status,
		failureCode,
		createdAt: at(minute),
	});
	const execution = (
		executionId: string,
		status: string,
		minute: number,
		taskWaitOrder: number | null,
	) => ({
		executionId,
		conversationId: "conversation",
		sourceMessageId: `message_${executionId}`,
		status,
		createdAt: at(minute),
		updatedAt: at(minute),
		traceId: `trace_${executionId}`,
		taskWaitOrder,
	});

	it("derives positions from the persisted wait order and omits queued replies", () => {
		const projected = projectConversationMessagesV1({
			messages: [
				user("message_active", "active", 1),
				user("message_second", "second", 2),
				user("message_third", "third", 3),
			],
			executions: [
				execution("active", "processing", 1, null),
				// Agent 内共用的顺序空间：其他会话占用过的顺序不影响本会话位次。
				execution("second", "waiting", 2, 41),
				execution("third", "waiting", 3, 57),
			],
			events: [],
		});
		expect(
			projected.map(({ messageId, role, status, queue }) => ({
				messageId,
				role,
				status,
				queue,
			})),
		).toEqual([
			{
				messageId: "message_active",
				role: "user",
				status: "submitted",
				queue: undefined,
			},
			{
				messageId: "message_second",
				role: "user",
				status: "submitted",
				queue: { status: "waiting", position: 1 },
			},
			{
				messageId: "message_third",
				role: "user",
				status: "submitted",
				queue: { status: "waiting", position: 2 },
			},
		]);
	});

	it.each([
		["TASK_WAIT_TIMEOUT", "failed", { status: "timed_out" }],
		["WITHDRAWN", "cancelled", { status: "withdrawn" }],
		["TASK_CANCELLED", "cancelled", { status: "withdrawn" }],
		[
			"AGENT_UNAVAILABLE",
			"failed",
			{ status: "cancelled", reason: "AGENT_UNAVAILABLE" },
		],
		[
			"CONVERSATION_UNAVAILABLE",
			"failed",
			{ status: "cancelled", reason: "CONVERSATION_UNAVAILABLE" },
		],
		[
			"AUTHORIZATION_REVOKED",
			"failed",
			{ status: "cancelled", reason: "AUTHORIZATION_REVOKED" },
		],
	])(
		"projects a queued message ended by %s without an assistant reply",
		(failureCode, status, queue) => {
			const projected = projectConversationMessagesV1({
				messages: [user("message_queued", "queued", 1, "failed", failureCode)],
				executions: [
					execution(
						"queued",
						failureCode === "WITHDRAWN" ||
							failureCode === "TASK_CANCELLED" ||
							failureCode === "AUTHORIZATION_REVOKED"
							? "cancelled"
							: "failed",
						1,
						7,
					),
				],
				events: [],
			});
			expect(projected).toHaveLength(1);
			expect(projected[0]).toMatchObject({
				role: "user",
				status,
				queue,
				failureCode:
					status === "cancelled"
						? null
						: failureCode === "AUTHORIZATION_REVOKED"
							? "AUTHORIZATION_REVOKED"
							: "EXECUTION_FAILED",
			});
		},
	);

	it("drops the queue state once the queued message started", () => {
		const [message] = projectConversationMessagesV1({
			messages: [user("message_queued", "queued", 1)],
			executions: [execution("queued", "processing", 1, 7)],
			events: [],
		});
		expect(message?.queue).toBeUndefined();
	});

	it("projects a waiting execution detail as submitted", () => {
		expect(
			projectConversationExecutionV1({
				execution: execution("queued", "waiting", 1, 7),
				events: [],
			}).status,
		).toBe("submitted");
	});
});
