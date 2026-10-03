import {
	type ConversationEventDecisionV1,
	type ConversationEventStateV1,
	type ConversationEventTransactionPortV1,
	type ConversationEventUseCaseOptionsV1,
	type ConversationEventUseCaseV1,
	type ConversationEventWritePlanV1,
	createConversationEventUseCaseV1,
	type PersistedRuntimeConversationEventV1,
} from "./conversation-events.js";
import {
	type FileRecordV1,
	type FileScopeV1,
	isConfirmedResultFileV1,
} from "./file-authority.js";

export interface FakeConversationEventsOptionsV1
	extends ConversationEventUseCaseOptionsV1 {
	readonly fileScope?: FileScopeV1;
	readonly conversationId: string;
	readonly executionId: string;
	readonly sessionGeneration: number;
	readonly deliveryFence: number;
}

interface StoredEvent {
	readonly adapterEventKey: string;
	readonly eventDigest: string;
	readonly runtimeCursor: string;
	readonly event: PersistedRuntimeConversationEventV1;
}

function isWritePlan(
	decision: ConversationEventWritePlanV1 | ConversationEventDecisionV1,
): decision is ConversationEventWritePlanV1 {
	return !Object.hasOwn(decision, "outcome");
}

export class FakeConversationEventsV1 implements ConversationEventUseCaseV1 {
	readonly #events: StoredEvent[] = [];
	private readonly files = new Map<string, FileRecordV1>();
	seedFile(file: FileRecordV1) {
		this.files.set(file.fileId, structuredClone(file));
	}
	readonly #interface: ConversationEventUseCaseV1;
	#failNextCommit = false;
	#lastConversationCursor = 0;
	#lastSequence = 0;

	constructor(private readonly options: FakeConversationEventsOptionsV1) {
		let nextEventId = 1;
		const transaction: ConversationEventTransactionPortV1 = {
			persistEvent: async (request, decide) => {
				const existing = this.#events.find(
					(event) => event.adapterEventKey === request.command.adapterEventKey,
				);
				const decision = decide(this.#state(existing));
				if (!isWritePlan(decision)) return decision;
				if (
					decision.event.event.type === "result.file" &&
					(!options.fileScope ||
						!isConfirmedResultFileV1(
							this.files.get(decision.event.event.fileId) ?? null,
							{
								...options.fileScope,
								executionId: options.executionId,
								sessionGeneration: options.sessionGeneration,
							},
							decision.event.event,
						))
				)
					throw new Error("Unconfirmed result file");

				if (this.#failNextCommit) {
					this.#failNextCommit = false;
					throw new Error("Injected Fake Conversation event commit failure");
				}
				this.#events.push({
					adapterEventKey: decision.adapterEventKey,
					eventDigest: decision.eventDigest,
					runtimeCursor: decision.runtimeCursor,
					event: structuredClone(decision.event),
				});
				this.#lastConversationCursor = decision.event.conversationCursor;
				this.#lastSequence = decision.event.sequence;
				return { outcome: "accepted", event: structuredClone(decision.event) };
			},
		};
		this.#interface = createConversationEventUseCaseV1(
			{ transaction },
			{
				newId: options.newId ?? (() => `event_${nextEventId++}`),
			},
		);
	}

	persist: ConversationEventUseCaseV1["persist"] = (command) =>
		this.#interface.persist(command);

	failNextCommit() {
		this.#failNextCommit = true;
	}

	snapshot() {
		return structuredClone({
			events: this.#events.map(({ event }) => event),
			lastConversationCursor: this.#lastConversationCursor,
		});
	}

	executionSequence() {
		return this.#lastSequence;
	}

	runtimeCursor() {
		return this.#events.at(-1)?.runtimeCursor ?? null;
	}

	#state(existing: StoredEvent | undefined): ConversationEventStateV1 {
		return {
			operationHistory: this.#events.flatMap(({ event }) =>
				event.event.type === "execution.operation"
					? [structuredClone(event.event.fact)]
					: [],
			),
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
