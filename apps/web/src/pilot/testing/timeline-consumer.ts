import type { ConversationSseMessageV1 } from "../generated/types.gen.js";

type PersistedEvent = Extract<ConversationSseMessageV1, { kind: "event" }>;
type ControlSignal = Extract<ConversationSseMessageV1, { kind: "control" }>;

export function createPilotSseMessageConsumer() {
	const seenEventIds = new Set<string>();

	return (messages: readonly ConversationSseMessageV1[]) => {
		const events: PersistedEvent[] = [];
		const controls: ControlSignal[] = [];

		for (const message of messages) {
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
}
