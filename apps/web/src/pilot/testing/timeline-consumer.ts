import { ConversationSseMessageV2Schema } from "@agent-infra/contracts/pilot";
import type { ConversationSseMessageV2 } from "../generated-v2/types.gen.js";

type PersistedEvent = Extract<ConversationSseMessageV2, { kind: "event" }>;
type ControlSignal = Extract<ConversationSseMessageV2, { kind: "control" }>;

export function createPilotSseMessageConsumer() {
	const seenEventIds = new Set<string>();

	const consume = (messages: readonly unknown[]) => {
		const events: PersistedEvent[] = [];
		const controls: ControlSignal[] = [];
		const parsedMessages = messages.map(
			(input) =>
				ConversationSseMessageV2Schema.parse(input) as ConversationSseMessageV2,
		);

		for (const message of parsedMessages) {
			if (message.kind === "control") {
				controls.push(message);
				continue;
			}
			if (seenEventIds.has(message.eventId)) continue;
			seenEventIds.add(message.eventId);
			events.push(message);
		}

		return { events, controls };
	};

	return { consume, reset: () => seenEventIds.clear() };
}
