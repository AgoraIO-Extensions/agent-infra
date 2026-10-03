import { describe, expect, it } from "vitest";
import { decideConversationTaskWaitingV1 } from "./index.js";

function waiting(
	changes: Partial<Parameters<typeof decideConversationTaskWaitingV1>[0]> = {},
): Parameters<typeof decideConversationTaskWaitingV1>[0] {
	return {
		nowMs: 1_000,
		deadlineMs: 2_000,
		agent: {
			status: "available",
			desiredState: "running",
			serviceAvailability: "ready",
		},
		conversationAvailable: true,
		isolationPending: false,
		occupied: false,
		earlierWaiting: false,
		...changes,
	};
}

describe("never-sent task waiting decision", () => {
	it("dispatches only the unoccupied earliest task of a ready Agent", () => {
		expect(decideConversationTaskWaitingV1(waiting())).toEqual({
			outcome: "dispatch",
		});
		for (const changes of [
			{ occupied: true },
			{ earlierWaiting: true },
			{ isolationPending: true, conversationAvailable: false },
		])
			expect(decideConversationTaskWaitingV1(waiting(changes))).toEqual({
				outcome: "wait",
			});
	});

	it.each(["starting", "updating"])(
		"retains the original deadline while %s and after a restart",
		(serviceAvailability) => {
			const state = waiting({
				agent: {
					status: "available",
					desiredState: "running",
					serviceAvailability,
				},
			});
			expect(decideConversationTaskWaitingV1(state)).toEqual({
				outcome: "wait",
			});
			expect(
				decideConversationTaskWaitingV1({
					...structuredClone(state),
					nowMs: state.deadlineMs,
				}),
			).toEqual({ outcome: "fail", reason: "TASK_WAIT_TIMEOUT" });
		},
	);

	it.each([
		null,
		{
			status: "disabled",
			desiredState: "running",
			serviceAvailability: "ready",
		},
		{
			status: "available",
			desiredState: "stopped",
			serviceAvailability: "ready",
		},
		{
			status: "available",
			desiredState: "running",
			serviceAvailability: "fault",
		},
		{ status: "available", desiredState: "running", serviceAvailability: null },
	])("fails unavailable Agent state %j without starting it", (agent) => {
		expect(decideConversationTaskWaitingV1(waiting({ agent }))).toEqual({
			outcome: "fail",
			reason: "AGENT_UNAVAILABLE",
		});
	});

	it("fails an unavailable Conversation only after isolation is confirmed", () => {
		expect(
			decideConversationTaskWaitingV1(
				waiting({ conversationAvailable: false }),
			),
		).toEqual({ outcome: "fail", reason: "CONVERSATION_UNAVAILABLE" });
	});

	it("expires never-sent work even when capacity or earlier work still blocks it", () => {
		expect(
			decideConversationTaskWaitingV1(
				waiting({ nowMs: 2_001, occupied: true, earlierWaiting: true }),
			),
		).toEqual({ outcome: "fail", reason: "TASK_WAIT_TIMEOUT" });
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
		"refuses invalid clock %s",
		(clock) => {
			expect(() =>
				decideConversationTaskWaitingV1(waiting({ nowMs: clock })),
			).toThrow("Task waiting clock is invalid");
			expect(() =>
				decideConversationTaskWaitingV1(waiting({ deadlineMs: clock })),
			).toThrow("Task waiting clock is invalid");
		},
	);
});
