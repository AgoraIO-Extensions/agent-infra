import type { BrowserActionRecordV1 } from "@agent-infra/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import {
	type BrowserRecoveryBindingV1,
	createBrowserRecoveryConsumerV1,
} from "./browser-recovery-consumer.js";

const binding: BrowserRecoveryBindingV1 = {
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	capabilityVersion: 5,
	pageRevision: 2,
	sessionGeneration: 3,
	resourceFence: 4,
};

const record: BrowserActionRecordV1 = {
	actionId: "action-1",
	operationRef: "operation-1",
	attemptRef: "attempt-1",
	kind: "click",
	status: "completed",
	page: { pageId: "page-1", pageRevision: 2 },
	sideEffect: true,
	executionBinding: binding,
	createdAt: "2026-10-08T00:00:00Z",
};

function setup(value: BrowserActionRecordV1 | null = record) {
	const readAction = vi.fn(() => value);
	const consumer = createBrowserRecoveryConsumerV1({
		controller: { readAction },
	});
	return { consumer, readAction };
}

describe("Browser recovery consumer", () => {
	it("reads a completed outcome with the original binding and performs no Browser I/O", () => {
		const { consumer, readAction } = setup();
		const result = consumer.read({ actionId: record.actionId, binding });

		expect(result).toEqual({ status: "completed", record });
		expect(readAction).toHaveBeenCalledWith({
			actionId: record.actionId,
			executionBinding: binding,
		});
	});

	it.each([
		["failed", "failed"],
		["rejected", "rejected"],
		["unknown", "unknown"],
	] as const)(
		"preserves %s instead of treating recovery as completed",
		(status, expected) => {
			const { consumer } = setup({ ...record, status });
			expect(
				consumer.read({ actionId: record.actionId, binding }),
			).toMatchObject({
				status: expected,
			});
		},
	);

	it("returns missing when the original action is not readable", () => {
		const { consumer } = setup(null);
		expect(consumer.read({ actionId: record.actionId, binding })).toEqual({
			status: "missing",
		});
	});

	it("fails closed on a Runtime binding conflict", () => {
		const { consumer } = setup();
		const readAction = vi.fn(() => {
			throw new Error("BROWSER_ACTION_READBACK_BINDING_CONFLICT");
		});
		const conflictConsumer = createBrowserRecoveryConsumerV1({
			controller: { readAction },
		});
		expect(() =>
			conflictConsumer.read({
				actionId: record.actionId,
				binding: { ...binding, executionId: "other" },
			}),
		).toThrow("BROWSER_ACTION_RECOVERY_BINDING_CONFLICT");
		expect(consumer.read({ actionId: record.actionId, binding })).toMatchObject(
			{
				status: "completed",
			},
		);
	});
});
