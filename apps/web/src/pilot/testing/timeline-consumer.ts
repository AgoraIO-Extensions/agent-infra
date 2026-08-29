import { ConversationSseMessageV1Schema } from "@agent-infra/contracts/pilot";
import type { ConversationSseMessageV1 } from "../generated/types.gen.js";

type PersistedEvent = Extract<ConversationSseMessageV1, { kind: "event" }>;
type ControlSignal = Extract<ConversationSseMessageV1, { kind: "control" }>;

export function createPilotSseMessageConsumer() {
	const seenEventIds = new Set<string>();

	const consume = (messages: readonly unknown[]) => {
		const events: PersistedEvent[] = [];
		const controls: ControlSignal[] = [];

		for (const input of messages) {
			const message = ConversationSseMessageV1Schema.parse(
				input,
			) as ConversationSseMessageV1;
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
