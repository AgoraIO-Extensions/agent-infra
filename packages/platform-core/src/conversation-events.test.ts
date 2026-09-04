import { describe, expect, it } from "vitest";

import {
	type ConversationEventStateV1,
	type ConversationEventTransactionPortV1,
	createConversationEventUseCaseV1,
} from "./conversation-events.js";
import { FakeConversationEventsV1 } from "./fake-conversation-events.js";

const event = {
	schemaVersion: 1 as const,
	conversationId: "conversation_events",
	executionId: "execution_events",
	sessionGeneration: 3,
	deliveryFence: 5,
	adapterEventKey: "adapter_event_1",
	runtimeCursor: "runtime_cursor_1",
	occurredAt: "2026-09-04T00:00:00.000Z",
	event: { type: "text.delta" as const, text: "Hello" },
};

function activeState(): ConversationEventStateV1 {
	return {
		conversation: {
			conversationId: event.conversationId,
			sessionGeneration: event.sessionGeneration,
			lastConversationCursor: 0,
		},
		execution: {
			executionId: event.executionId,
			conversationId: event.conversationId,
			sessionGeneration: event.sessionGeneration,
			deliveryFence: event.deliveryFence,
			lastSequence: 0,
		},
		existingEvent: undefined,
	};
}

describe("Conversation event ingestion", () => {
	it("allocates once and replays the original event before stale-fence classification", async () => {
		const events = new FakeConversationEventsV1({
			conversationId: event.conversationId,
			executionId: event.executionId,
			sessionGeneration: event.sessionGeneration,
			deliveryFence: event.deliveryFence,
			newId: () => "event_1",
		});

		const accepted = await events.persist(event);
		if (accepted.outcome !== "accepted") {
			throw new Error("Expected the first event to be accepted");
		}
		expect(accepted).toEqual({
			outcome: "accepted",
			event: {
				schemaVersion: 1,
				eventId: "event_1",
				conversationId: event.conversationId,
				executionId: event.executionId,
				sequence: 1,
				conversationCursor: 1,
				occurredAt: event.occurredAt,
				event: event.event,
			},
		});

		expect(
			await events.persist({
				...event,
				deliveryFence: event.deliveryFence - 1,
			}),
		).toEqual({
			outcome: "replayed",
			event: accepted.event,
		});
		expect(events.snapshot().lastConversationCursor).toBe(1);
	});

	it("accepts the current zero delivery fence without exposing private cursor metadata", async () => {
		const events = new FakeConversationEventsV1({
			conversationId: event.conversationId,
			executionId: event.executionId,
			sessionGeneration: event.sessionGeneration,
			deliveryFence: 0,
			newId: () => "event_zero_fence",
		});

		const accepted = await events.persist({ ...event, deliveryFence: 0 });
		if (accepted.outcome !== "accepted") {
			throw new Error("Expected the zero-fence event to be accepted");
		}
		expect(accepted).toMatchObject({
			outcome: "accepted",
			event: {
				eventId: "event_zero_fence",
				sequence: 1,
				conversationCursor: 1,
			},
		});
		expect(accepted.event).not.toHaveProperty("runtimeCursor");
	});

	it("rejects a first stale event without creating an event or advancing the cursor", async () => {
		const events = new FakeConversationEventsV1({
			conversationId: event.conversationId,
			executionId: event.executionId,
			sessionGeneration: event.sessionGeneration,
			deliveryFence: event.deliveryFence,
		});

		await expect(
			events.persist({
				...event,
				sessionGeneration: event.sessionGeneration - 1,
			}),
		).resolves.toEqual({ outcome: "stale" });
		await expect(
			events.persist({
				...event,
				deliveryFence: event.deliveryFence - 1,
			}),
		).resolves.toEqual({ outcome: "stale" });
		expect(events.snapshot()).toEqual({
			events: [],
			lastConversationCursor: 0,
		});
	});

	it("uses deterministic Fake IDs for equal text at distinct adapter event keys", async () => {
		const events = new FakeConversationEventsV1({
			conversationId: event.conversationId,
			executionId: event.executionId,
			sessionGeneration: event.sessionGeneration,
			deliveryFence: event.deliveryFence,
		});

		const first = await events.persist(event);
		const second = await events.persist({
			...event,
			adapterEventKey: "adapter_event_2",
			runtimeCursor: "runtime_cursor_2",
		});
		if (first.outcome !== "accepted" || second.outcome !== "accepted") {
			throw new Error("Expected both normalized events to be accepted");
		}
		expect(second.event).toMatchObject({
			eventId: "event_2",
			sequence: 2,
			conversationCursor: 2,
			event: event.event,
		});
		expect(first.event.eventId).toBe("event_1");
		expect(events.snapshot().events).toEqual([first.event, second.event]);
	});

	it("rejects raw native fields and conflicting reuse of an adapter event key", async () => {
		const events = new FakeConversationEventsV1({
			conversationId: event.conversationId,
			executionId: event.executionId,
			sessionGeneration: event.sessionGeneration,
			deliveryFence: event.deliveryFence,
		});

		await expect(
			events.persist({
				...event,
				event: {
					...event.event,
					nativeSessionId: "private_runtime_session",
				} as never,
			}),
		).rejects.toMatchObject({ code: "invalid_input" });
		await events.persist(event);
		await expect(
			events.persist({
				...event,
				event: { type: "text.delta", text: "changed" },
			}),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(events.snapshot().lastConversationCursor).toBe(1);
	});

	it("fails closed when a transaction returns a forged event decision", async () => {
		const transaction: ConversationEventTransactionPortV1 = {
			persistEvent: async (_request, decide) => {
				decide(activeState());
				return {
					outcome: "accepted",
					event: {
						schemaVersion: 1,
						eventId: "event_forged",
						conversationId: "conversation_other",
						executionId: event.executionId,
						sequence: 1,
						conversationCursor: 1,
						occurredAt: event.occurredAt,
						event: event.event,
					},
				} as never;
			},
		};
		const events = createConversationEventUseCaseV1(
			{ transaction },
			{ newId: () => "event_1" },
		);

		await expect(events.persist(event)).rejects.toMatchObject({
			code: "unavailable",
		});
	});

	it("fails closed when a transaction mutates the Core event plan", async () => {
		const transaction: ConversationEventTransactionPortV1 = {
			persistEvent: async (_request, decide) => {
				const plan = decide(activeState());
				if (Object.hasOwn(plan, "outcome")) {
					throw new Error("Expected an accepted event plan");
				}
				const mutablePlan = plan as {
					event: { conversationId: string };
				};
				mutablePlan.event.conversationId = "conversation_other";
				return { outcome: "accepted", event: mutablePlan.event } as never;
			},
		};
		const events = createConversationEventUseCaseV1(
			{ transaction },
			{ newId: () => "event_1" },
		);

		await expect(events.persist(event)).rejects.toMatchObject({
			code: "unavailable",
		});
	});

	it("fails closed when a transaction returns a raw replay event", async () => {
		const persisted = {
			schemaVersion: 1 as const,
			eventId: "event_replayed",
			conversationId: event.conversationId,
			executionId: event.executionId,
			sequence: 1,
			conversationCursor: 1,
			occurredAt: event.occurredAt,
			event: event.event,
		};
		const transaction: ConversationEventTransactionPortV1 = {
			persistEvent: async (request, decide) => {
				decide({
					...activeState(),
					existingEvent: {
						event: persisted,
						eventDigest: request.eventDigest,
					},
				});
				return {
					outcome: "replayed",
					event: {
						...persisted,
						event: {
							...persisted.event,
							nativeSessionId: "private_runtime_session",
						},
					},
				} as never;
			},
		};
		const events = createConversationEventUseCaseV1({ transaction });

		await expect(events.persist(event)).rejects.toMatchObject({
			code: "unavailable",
		});
	});
});
