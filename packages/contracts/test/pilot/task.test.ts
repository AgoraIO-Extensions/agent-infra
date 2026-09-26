import { describe, expect, it } from "vitest";
import {
	frameTaskSseMessageV1,
	SubmitTaskRequestV1Schema,
	TaskProjectionV1Schema,
} from "../../src/pilot/task.ts";

describe("Public task contracts", () => {
	it("rejects caller identity, credentials and scheduling overrides", () => {
		const request = { schemaVersion: 1, text: "synthetic task" };
		expect(SubmitTaskRequestV1Schema.parse(request)).toEqual(request);
		for (const field of [
			"actorId",
			"principal",
			"channelId",
			"credential",
			"priority",
			"timeoutMs",
		]) {
			expect(
				SubmitTaskRequestV1Schema.safeParse({ ...request, [field]: "forged" })
					.success,
			).toBe(false);
		}
	});
	it("preserves waiting and unknown instead of projecting an idle conversation", () => {
		for (const status of ["waiting", "unknown", "cancelled"]) {
			expect(
				TaskProjectionV1Schema.parse({
					schemaVersion: 1,
					conversationId: "conversation_1",
					executionId: "execution_1",
					status,
					output: "",
					events: [],
				}).status,
			).toBe(status);
		}
	});
	it("frames original durable IDs and never assigns a persisted ID to stream errors", () => {
		const event = {
			schemaVersion: 1,
			kind: "event",
			type: "task.status",
			eventId: "event_1",
			conversationId: "conversation_1",
			executionId: "execution_1",
			sequence: 1,
			conversationCursor: "cursor_1",
			occurredAt: "2026-09-26T00:00:00Z",
			payload: { status: "waiting" },
		};
		expect(frameTaskSseMessageV1(event)).toEqual({
			id: event.eventId,
			data: event,
		});
		const control = {
			schemaVersion: 1,
			kind: "control",
			type: "task.stream.error",
			error: {
				schemaVersion: 1,
				code: "DEPENDENCY_UNAVAILABLE",
				message: "Storage unavailable",
				retryable: true,
				traceId: "trace_1",
			},
		};
		expect(frameTaskSseMessageV1(control)).toEqual({ data: control });
		expect(() =>
			frameTaskSseMessageV1({ ...control, eventId: "forged" }),
		).toThrow();
	});
});
