import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PersistedConversationEventV2 } from "../../pilot/generated-v2/types.gen.js";
import { BrowserAuditView, browserAuditEntries } from "./browser-audit-view.js";
import { timestamp } from "./conversation-test-fixtures.js";

const binding = {
	subjectId: "subject-1",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	sessionGeneration: 1,
	resourceFence: 2,
	workloadRevision: 3,
	imageDigest: `sha256:${"a".repeat(64)}`,
	capabilityVersion: 1,
	capabilityRevision: 1,
	pageRevision: 4,
};

function operation(
	sequence: number,
	phase: "intent" | "started" | "completed" | "failed" | "unknown",
	executionId = "execution-1",
): Extract<PersistedConversationEventV2, { type: "execution.operation" }> {
	return {
		schemaVersion: 2,
		kind: "event",
		eventId: `operation-${sequence}`,
		conversationId: "conversation-1",
		executionId,
		sequence,
		conversationCursor: `cursor-${sequence}`,
		occurredAt: timestamp,
		type: "execution.operation",
		payload: {
			operationRef: "operation-1",
			attemptRef: "attempt-1",
			kind: "tool",
			toolId: "browser_click",
			phase,
			browser: {
				actionId: "action-1",
				capabilityVersion: 1,
				pageRevision: 4,
				sessionGeneration: 1,
				resourceFence: 2,
				workloadRevision: 3,
				imageDigest: binding.imageDigest,
				sideEffect: false,
			},
		},
	};
}

function handoff(
	sequence: number,
	status: "requested" | "active" | "completed" | "unknown",
): Extract<PersistedConversationEventV2, { type: "browser.handoff" }> {
	return {
		schemaVersion: 2,
		kind: "event",
		eventId: `handoff-${sequence}`,
		conversationId: "conversation-1",
		executionId: "execution-1",
		sequence,
		conversationCursor: `cursor-${sequence}`,
		occurredAt: timestamp,
		type: "browser.handoff",
		payload: {
			handoffId: "handoff-1",
			status,
			reason: "mfa",
			requestedAt: timestamp,
			expiresAt: "2027-01-01T00:00:00.000Z",
			binding,
		},
	};
}

function sideEffect(
	sequence: number,
	status: "pending" | "confirmed" | "unknown",
	patch: Partial<
		Extract<
			PersistedConversationEventV2,
			{ type: "browser.side_effect" }
		>["payload"]
	> = {},
): Extract<PersistedConversationEventV2, { type: "browser.side_effect" }> {
	return {
		schemaVersion: 2,
		kind: "event",
		eventId: `side-effect-${sequence}`,
		conversationId: "conversation-1",
		executionId: "execution-1",
		sequence,
		conversationCursor: `cursor-${sequence}`,
		occurredAt: timestamp,
		type: "browser.side_effect",
		payload: {
			confirmationId: "confirmation-1",
			status,
			requestedAt: timestamp,
			expiresAt: "2027-01-01T00:00:00.000Z",
			operation: "submit",
			targetOrigin: "https://example.test/",
			redactedTargetSummary: "提交公开表单（已脱敏）",
			binding: {
				...binding,
				actionId: "action-1",
				confirmationId: "confirmation-1",
				operationRef: "operation-1",
				attemptRef: "attempt-1",
			},
			...patch,
		},
	};
}

afterEach(() => cleanup());

describe("Browser audit and recovery projection", () => {
	it("deduplicates terminal facts, keeps recovery states and isolates executions", () => {
		const entries = browserAuditEntries(
			[
				operation(1, "intent"),
				operation(2, "completed"),
				handoff(3, "active"),
				sideEffect(4, "pending"),
				sideEffect(5, "unknown"),
				operation(6, "completed", "foreign-execution"),
			],
			"conversation-1",
			"execution-1",
		);

		expect(entries).toHaveLength(3);
		expect(entries.map((entry) => [entry.kind, entry.status])).toEqual([
			["operation", "completed"],
			["handoff", "active"],
			["side_effect", "unknown"],
		]);
		expect(entries.at(-1)?.detail).toContain("example.test");
	});

	it("rejects foreign side-effect bindings and non-origin URLs", () => {
		const entries = browserAuditEntries(
			[
				sideEffect(1, "pending", {
					targetOrigin: "https://example.test/private?token=secret",
				}),
				sideEffect(2, "pending", {
					binding: {
						...binding,
						conversationId: "foreign-conversation",
						actionId: "action-1",
						confirmationId: "confirmation-1",
						operationRef: "operation-1",
						attemptRef: "attempt-1",
					},
				}),
			],
			"conversation-1",
			"execution-1",
		);
		expect(entries).toEqual([]);
	});

	it("bounds the history to the latest fifty entries", () => {
		const entries = browserAuditEntries(
			Array.from({ length: 55 }, (_, index) =>
				handoff(index + 1, index === 54 ? "unknown" : "active"),
			),
			"conversation-1",
			"execution-1",
		);
		expect(entries).toHaveLength(50);
		expect(entries[0]?.sequence).toBe(6);
		expect(entries.at(-1)?.status).toBe("unknown");
	});

	it("renders unknown recovery as read-only and never exposes URL paths", () => {
		render(
			<BrowserAuditView
				conversationId="conversation-1"
				executionId="execution-1"
				events={[
					sideEffect(1, "unknown", {
						targetOrigin: "https://example.test/",
					}),
				]}
			/>,
		);
		expect(
			screen.getByRole("heading", { name: "Browser 审计与恢复" }),
		).toBeTruthy();
		expect(screen.getByRole("alert", { name: /结果待核实/ })).toBeTruthy();
		expect(screen.getByText(/https:\/\/example\.test/)).toBeTruthy();
		expect(screen.queryByText(/secret\/path|token=hidden/)).toBeNull();
		expect(screen.queryByRole("button")).toBeNull();
	});
});
