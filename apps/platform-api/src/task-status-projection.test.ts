import { TaskStatusEventV1Schema } from "@agent-infra/contracts/pilot";
import { publicTaskStatusEventV1 } from "@agent-infra/platform-core";
import type { ConversationQueryEventV1 } from "@agent-infra/platform-store";
import { describe, expect, it } from "vitest";
import {
	taskEventProjection,
	taskProjection,
} from "./http/task-route-support.js";

const occurredAt = new Date("2026-01-01T00:00:00Z");
const event: ConversationQueryEventV1 = {
	eventId: "event-status",
	conversationId: "conversation",
	executionId: "execution",
	sequence: 2,
	conversationCursor: "cursor",
	eventType: "task.status",
	eventPayload: { type: "task.status", status: "waiting" },
	occurredAt,
	traceId: null,
};

describe("Task status consumes the original Core event", () => {
	it.each([
		"waiting",
		"submitted",
		"processing",
		"completed",
		"failed",
		"cancelled",
		"unknown",
	] as const)("preserves %s on GET", (status) => {
		const payload = publicTaskStatusEventV1({ isTask: true, status });
		const projected = taskEventProjection({ ...event, eventPayload: payload });
		expect(projected).toEqual({
			schemaVersion: 1,
			kind: "event",
			eventId: event.eventId,
			conversationId: event.conversationId,
			executionId: event.executionId,
			sequence: event.sequence,
			conversationCursor: event.conversationCursor,
			occurredAt: occurredAt.toISOString(),
			type: "task.status",
			payload: { status },
		});
		expect(
			taskProjection({
				execution: {
					executionId: "execution",
					conversationId: "conversation",
					sourceMessageId: null,
					status,
					createdAt: occurredAt,
					updatedAt: occurredAt,
					traceId: null,
				},
				events: [{ ...event, eventPayload: payload }],
			}),
		).toMatchObject({ status, output: "", events: [projected] });
	});
	it.each([
		{ status: "unknown", reason: "STOP_CONFIRMATION_TIMEOUT" },
		{ status: "failed", reason: "TASK_WAIT_TIMEOUT" },
		{ status: "failed", reason: "AGENT_UNAVAILABLE" },
		{ status: "failed", reason: "CONVERSATION_UNAVAILABLE" },
	])("preserves a valid Core status/reason pair %j", (payload) => {
		expect(
			taskEventProjection({
				...event,
				eventPayload: { type: "task.status", ...payload },
			}),
		).toMatchObject({ payload });
	});
	it.each([
		{ status: "waiting", reason: "TASK_WAIT_TIMEOUT" },
		{ status: "failed", reason: "STOP_CONFIRMATION_TIMEOUT" },
		{ status: "unknown", reason: "AGENT_UNAVAILABLE" },
		{ status: "complete" },
		{ status: "waiting", privateText: "body sentinel" },
	])("rejects malformed persisted and wire payloads %j", (payload) => {
		expect(() =>
			taskEventProjection({
				...event,
				eventPayload: { type: "task.status", ...payload },
			}),
		).toThrow();
		const valid = taskEventProjection(event);
		expect(
			TaskStatusEventV1Schema.safeParse({ ...valid, payload }).success,
		).toBe(false);
	});
	it("rejects wrong event version/type and another Task's event", () => {
		expect(() =>
			taskEventProjection({ ...event, eventSchemaVersion: 2 }),
		).toThrow();
		expect(() =>
			taskEventProjection({
				...event,
				eventPayload: { type: "text.delta", text: "private" },
			}),
		).toThrow();
		expect(() =>
			taskProjection({
				execution: {
					executionId: "other",
					conversationId: "conversation",
					sourceMessageId: null,
					status: "completed",
					createdAt: occurredAt,
					updatedAt: occurredAt,
					traceId: null,
				},
				events: [event],
			}),
		).toThrow();
	});
	it("preserves old text output alongside status events", () => {
		const text = {
			...event,
			eventId: "event-text",
			sequence: 1,
			eventType: "text.delta",
			eventPayload: { type: "text.delta", text: "original output" },
		};
		expect(
			taskProjection({
				execution: {
					executionId: "execution",
					conversationId: "conversation",
					sourceMessageId: null,
					status: "waiting",
					createdAt: occurredAt,
					updatedAt: occurredAt,
					traceId: null,
				},
				events: [text, event],
			}),
		).toMatchObject({
			output: "original output",
			events: [{ type: "text.delta" }, { type: "task.status" }],
		});
	});
});
