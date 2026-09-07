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
						executionId: "execution-1",
						conversationId: "conversation-1",
						sourceMessageId: "message-1",
						status: "completed",
						updatedAt: second,
						traceId: "trace-1",
					},
					{
						executionId: "execution-2",
						conversationId: "conversation-1",
						sourceMessageId: "message-1",
						status: "processing",
						updatedAt: third,
						traceId: "trace-2",
					},
				],
				events: [
					{
						executionId: "execution-1",
						eventType: "text.delta",
						eventPayload: { type: "text.delta", text: "Hel" },
						occurredAt: second,
					},
					{
						executionId: "execution-1",
						eventType: "text.delta",
						eventPayload: { type: "text.delta", text: "lo" },
						occurredAt: third,
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
					updatedAt: third,
					traceId: "trace-1",
				},
				events: [
					{
						executionId: "execution-1",
						eventType: "execution.status",
						eventPayload: {
							type: "execution.status",
							status: "processing",
						},
						occurredAt: second,
					},
					{
						executionId: "execution-1",
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
						updatedAt: second,
						traceId: null,
					},
				],
				events: [
					{
						executionId: "execution-1",
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
