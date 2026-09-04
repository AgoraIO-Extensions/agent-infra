import {
	type ConversationEventDecisionV1,
	type ConversationEventStateV1,
	type ConversationEventTransactionPortV1,
	type ConversationEventUseCaseOptionsV1,
	type ConversationEventUseCaseV1,
	type ConversationEventWritePlanV1,
	createConversationEventUseCaseV1,
	type PersistedConversationEventV1,
} from "./conversation-events.js";

export interface FakeConversationEventsOptionsV1
	extends ConversationEventUseCaseOptionsV1 {
	readonly conversationId: string;
	readonly executionId: string;
	readonly sessionGeneration: number;
	readonly deliveryFence: number;
}

interface StoredEvent {
	readonly adapterEventKey: string;
	readonly eventDigest: string;
	readonly event: PersistedConversationEventV1;
}

function isWritePlan(
	decision: ConversationEventWritePlanV1 | ConversationEventDecisionV1,
): decision is ConversationEventWritePlanV1 {
	return !Object.hasOwn(decision, "outcome");
}

export class FakeConversationEventsV1 implements ConversationEventUseCaseV1 {
	readonly #events: StoredEvent[] = [];
	readonly #interface: ConversationEventUseCaseV1;
	#lastConversationCursor = 0;
	#lastSequence = 0;

	constructor(private readonly options: FakeConversationEventsOptionsV1) {
		const transaction: ConversationEventTransactionPortV1 = {
			persistEvent: async (request, decide) => {
				const existing = this.#events.find(
					(event) => event.adapterEventKey === request.command.adapterEventKey,
				);
				const decision = decide(this.#state(existing));
				if (!isWritePlan(decision)) return decision;
				this.#events.push({
					adapterEventKey: decision.adapterEventKey,
					eventDigest: decision.eventDigest,
					event: structuredClone(decision.event),
				});
				this.#lastConversationCursor = decision.event.conversationCursor;
				this.#lastSequence = decision.event.sequence;
				return { outcome: "accepted", event: structuredClone(decision.event) };
			},
		};
		this.#interface = createConversationEventUseCaseV1(
			{ transaction },
			options,
		);
	}

	persist: ConversationEventUseCaseV1["persist"] = (command) =>
		this.#interface.persist(command);

	snapshot() {
		return structuredClone({
			events: this.#events.map(({ event }) => event),
			lastConversationCursor: this.#lastConversationCursor,
		});
	}

	#state(existing: StoredEvent | undefined): ConversationEventStateV1 {
		return {
			conversation: {
				conversationId: this.options.conversationId,
				sessionGeneration: this.options.sessionGeneration,
				lastConversationCursor: this.#lastConversationCursor,
			},
			execution: {
				executionId: this.options.executionId,
				conversationId: this.options.conversationId,
				sessionGeneration: this.options.sessionGeneration,
				deliveryFence: this.options.deliveryFence,
				lastSequence: this.#lastSequence,
			},
			existingEvent: existing
				? {
						event: structuredClone(existing.event),
						eventDigest: existing.eventDigest,
					}
				: undefined,
		};
	}
}
