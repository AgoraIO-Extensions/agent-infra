import { describe, expect, it, vi } from "vitest";
import {
	type ConversationBrowserHandoffExecutorV1,
	type ConversationDispatchClaimV1,
	type ConversationDispatchStorePortV1,
	createConversationDispatchUseCaseV1,
} from "./conversation-dispatch.js";

const claim: ConversationDispatchClaimV1 = {
	schemaVersion: 1,
	itemId: "conversation:browser-handoff:item-1",
	leaseOwner: "worker-1",
	operation: "conversation.browser.handoff.v1",
	requestId: "request-1",
	traceId: "trace-1",
	agentId: "agent-1",
	actorId: "actor-1",
	channelId: "web",
	conversationId: "conversation-1",
	executionId: "execution-1",
	turnId: "turn-1",
	messageId: null,
	stopRequestId: null,
	sessionGeneration: 1,
	deliveryFence: 2,
	executionDeliveryFence: 1,
	authorizationRevision: "authorization-1",
	modelConfigurationRevision: null,
	modelOptionId: null,
	reasoningLevel: null,
	hostSessionRef: "host-1",
	runtimeCursor: null,
	input: null,
	browserHandoff: {
		schemaVersion: 1,
		command: "take_over",
		handoffId: "handoff-1",
	},
	executionStatus: "processing",
	stopPending: false,
};

function harness(outcome: "accepted" | "replayed" | "unknown" | "unavailable") {
	let finished:
		| Parameters<ConversationDispatchStorePortV1["finish"]>[0]
		| null = null;
	let retried: Parameters<ConversationDispatchStorePortV1["retry"]>[0] | null =
		null;
	const store: ConversationDispatchStorePortV1 = {
		claim: vi.fn().mockResolvedValue({ outcome: "claimed", claim }),
		renew: vi.fn().mockResolvedValue(true),
		prepareRuntimeDispatch: vi.fn(),
		cancelUnaccepted: vi.fn().mockResolvedValue(true),
		recordRuntimeResponse: vi.fn().mockResolvedValue(true),
		finish: vi.fn().mockImplementation(async (input) => {
			finished = input;
			return true;
		}),
		retry: vi.fn().mockImplementation(async (input) => {
			retried = input;
			return true;
		}),
	};
	const browserHandoff: ConversationBrowserHandoffExecutorV1 = {
		invoke: vi.fn().mockResolvedValue({ outcome }),
	};
	const useCase = createConversationDispatchUseCaseV1({
		store,
		authorization: {
			authorize: vi.fn().mockResolvedValue({
				outcome: "allowed",
				authority: {
					schemaVersion: 1,
					agentId: claim.agentId,
					actorId: claim.actorId,
					channelId: claim.channelId,
					conversationId: claim.conversationId,
					executionId: claim.executionId,
					turnId: claim.turnId,
					sessionGeneration: claim.sessionGeneration,
					authorizationRevision: claim.authorizationRevision,
					runtimeGrant: {},
				},
			}),
		},
		runtimeHost: {
			dispatch: vi
				.fn()
				.mockRejectedValue(new Error("Browser must not use turn dispatch")),
			recoverStatus: vi.fn(),
			events: vi.fn(),
		},
		browserHandoff,
		events: { persist: vi.fn() },
	});
	return {
		store,
		browserHandoff,
		useCase,
		get finished() {
			return finished;
		},
		get retried() {
			return retried;
		},
	};
}

describe("Conversation Browser handoff dispatch", () => {
	it.each([
		["accepted", "accepted"],
		["replayed", "already_completed"],
	] as const)(
		"finishes a %s Browser result through the existing lease",
		async (executorOutcome, expected) => {
			const h = harness(executorOutcome);
			await expect(
				h.useCase.dispatch({
					schemaVersion: 1,
					itemId: claim.itemId,
					workerId: claim.leaseOwner,
				}),
			).resolves.toEqual({
				schemaVersion: 1,
				outcome: expected,
			});
			expect(h.browserHandoff.invoke).toHaveBeenCalledOnce();
			expect(h.finished).toMatchObject({ claim, status: "succeeded" });
			expect(h.store.retry).not.toHaveBeenCalled();
		},
	);

	it("keeps an uncertain Runtime handoff on the same outbox for bounded recovery", async () => {
		const h = harness("unknown");
		await expect(
			h.useCase.dispatch({
				schemaVersion: 1,
				itemId: claim.itemId,
				workerId: claim.leaseOwner,
			}),
		).resolves.toEqual({
			schemaVersion: 1,
			outcome: "unknown",
			retryScheduled: true,
		});
		expect(h.finished).toBeNull();
		expect(h.retried).toMatchObject({
			claim,
			errorCode: "BROWSER_HANDOFF_ACCEPTANCE_UNKNOWN",
		});
	});

	it("fails closed when no request-local Browser resolver is available", async () => {
		const h = harness("unavailable");
		await expect(
			h.useCase.dispatch({
				schemaVersion: 1,
				itemId: claim.itemId,
				workerId: claim.leaseOwner,
			}),
		).resolves.toEqual({
			schemaVersion: 1,
			outcome: "rejected",
		});
		expect(h.finished).toMatchObject({
			claim,
			status: "failed",
			errorCode: "BROWSER_HANDOFF_UNAVAILABLE",
		});
	});
});
