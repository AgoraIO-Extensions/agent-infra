import type { BrowserActionRecordV1 } from "@agent-infra/agent-runtime";
import type { ConversationEventUseCaseV1 } from "@agent-infra/platform-core";
import { describe, expect, it, vi } from "vitest";
import {
	type BrowserRecoveryEventInputV1,
	createBrowserRecoveryEventAdapterV1,
} from "./browser-recovery-events.js";

const binding = {
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	capabilityVersion: 5,
	pageRevision: 2,
	sessionGeneration: 3,
	resourceFence: 4,
} as const;
const record: BrowserActionRecordV1 = {
	actionId: "action-1",
	operationRef: "operation-1",
	attemptRef: "attempt-1",
	kind: "click",
	status: "unknown",
	page: { pageId: "page-1", pageRevision: 2 },
	sideEffect: true,
	executionBinding: binding,
	createdAt: "2026-10-08T00:00:00Z",
};

function setup(status: BrowserActionRecordV1["status"] | null = "unknown") {
	const readAction = vi.fn(() => (status ? { ...record, status } : null));
	const persist = vi.fn(async (command) => ({
		outcome: "accepted" as const,
		event: {
			...command,
			eventId: "event-1",
			sequence: 1,
			conversationCursor: 1,
		},
	}));
	const adapter = createBrowserRecoveryEventAdapterV1({
		controller: { readAction },
		events: { persist } as unknown as ConversationEventUseCaseV1,
	});
	const input: BrowserRecoveryEventInputV1 = {
		actionId: record.actionId,
		binding,
		attempt: {
			operationRef: "operation-1",
			attemptRef: "attempt-1",
		},
		toolId: "browser.click",
		sideEffect: true,
		startedAt: "2026-10-08T00:00:00.500Z",
		occurredAt: "2026-10-08T00:00:01Z",
		adapterEventKeyPrefix: "browser-recovery-1",
		runtimeCursorPrefix: "browser-recovery-cursor-1",
		now: () => "2026-10-08T00:00:02Z",
	};
	return { adapter, input, readAction, persist };
}

describe("Browser recovery event adapter", () => {
	it.each([
		["completed", "completed"],
		["failed", "failed"],
		["rejected", "failed"],
		["unknown", "unknown"],
		[null, "unknown"],
	] as const)(
		"maps %s readback to %s operation phase",
		async (status, phase) => {
			const state = setup(status);
			await expect(state.adapter.reconcile(state.input)).resolves.toMatchObject(
				{
					status: phase,
				},
			);
			expect(state.readAction).toHaveBeenCalledOnce();
			expect(state.persist).toHaveBeenCalledWith(
				expect.objectContaining({
					event: expect.objectContaining({
						fact: expect.objectContaining({
							phase,
							operationRef: record.operationRef,
							attemptRef: record.attemptRef,
							startedAt: "2026-10-08T00:00:00.500Z",
							browser: expect.objectContaining({ sideEffect: true }),
						}),
					}),
				}),
			);
		},
	);

	it("fails closed when the recovery event is stale", async () => {
		const state = setup();
		state.persist.mockResolvedValue({ outcome: "stale" } as never);
		await expect(state.adapter.reconcile(state.input)).rejects.toThrow(
			"BROWSER_RECOVERY_EVENT_PERSISTENCE_STALE",
		);
	});

	it("does not invoke Browser execute and fails closed on readback binding conflict", async () => {
		const state = setup();
		state.readAction.mockImplementation(() => {
			throw new Error("BROWSER_ACTION_READBACK_BINDING_CONFLICT");
		});
		await expect(state.adapter.reconcile(state.input)).rejects.toThrow(
			"BROWSER_ACTION_RECOVERY_BINDING_CONFLICT",
		);
		expect(state.persist).not.toHaveBeenCalled();
	});
});
