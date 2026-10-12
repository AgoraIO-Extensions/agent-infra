import { describe, expect, it } from "vitest";
import type { PersistedConversationEventV2 } from "../../pilot/generated-v2/types.gen.js";
import { latestBrowserOperationStatus } from "./browser-operation-status.js";
import { timestamp } from "./conversation-test-fixtures.js";

function browserEvent(
	sequence: number,
	phase: "intent" | "started" | "completed" | "failed" | "unknown",
	toolId = "browser_navigate",
): Extract<PersistedConversationEventV2, { type: "execution.operation" }> {
	return {
		schemaVersion: 2,
		kind: "event",
		eventId: `conversation-1-operation-${sequence}`,
		conversationId: "conversation-1",
		executionId: "execution-1",
		sequence,
		conversationCursor: `conversation-1-cursor-${sequence}`,
		type: "execution.operation" as const,
		occurredAt: timestamp,
		payload: {
			operationRef: "operation-1",
			attemptRef: "attempt-1",
			kind: "tool" as const,
			toolId,
			phase,
			browser: {
				actionId: "action-1",
				capabilityVersion: 3,
				pageRevision: 1,
				sessionGeneration: 1,
				resourceFence: 2,
				sideEffect: false,
			},
		},
	};
}

describe("latest Browser operation status", () => {
	it("uses the latest phase for the same operation across snapshot and replay", () => {
		const status = latestBrowserOperationStatus(
			[
				browserEvent(1, "intent"),
				browserEvent(2, "started"),
				browserEvent(3, "completed"),
			],
			"execution-1",
		);
		expect(status).toEqual({
			phase: "completed",
			operation: "browser_navigate",
		});
	});

	it("keeps unknown visible and ignores other executions or non-Browser tools", () => {
		const otherExecution = {
			...browserEvent(3, "completed"),
			executionId: "other",
		};
		const nonBrowserEvent = browserEvent(4, "started");
		const nonBrowser = {
			...nonBrowserEvent,
			payload: {
				operationRef: nonBrowserEvent.payload.operationRef,
				attemptRef: nonBrowserEvent.payload.attemptRef,
				kind: "tool" as const,
				toolId: "shell_exec",
				phase: "started" as const,
			},
		};
		const status = latestBrowserOperationStatus(
			[
				browserEvent(1, "started"),
				otherExecution,
				nonBrowser,
				browserEvent(5, "unknown"),
			],
			"execution-1",
		);
		expect(status).toEqual({ phase: "unknown", operation: "browser_navigate" });
	});

	it("returns no status when the execution is absent", () => {
		expect(
			latestBrowserOperationStatus([browserEvent(1, "started")], undefined),
		).toBeUndefined();
		expect(
			latestBrowserOperationStatus([browserEvent(1, "started")], "other"),
		).toBeUndefined();
	});
});
