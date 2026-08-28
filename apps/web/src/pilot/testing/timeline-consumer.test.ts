import { describe, expect, it } from "vitest";
import { pilotFakeScenariosV1 } from "../../../../../packages/test-support/src/pilot/index.js";
import type { ConversationSseMessageV1 } from "../generated/types.gen.js";
import { consumePilotSseMessages } from "./timeline-consumer.js";

describe("Pilot Web SSE consumer", () => {
	it("deduplicates replay by stable eventId without reordering new events", () => {
		const result = consumePilotSseMessages(
			pilotFakeScenariosV1.replay
				.messages as unknown as readonly ConversationSseMessageV1[],
		);

		expect(result.events.map((event) => event.eventId)).toEqual([
			"event-replay-1",
			"event-replay-2",
		]);
		expect(result.events.map((event) => event.sequence)).toEqual([1, 2]);
	});

	it("keeps stale-authorization control outside the persisted timeline", () => {
		const result = consumePilotSseMessages(
			pilotFakeScenariosV1.staleAuthorization
				.messages as unknown as readonly ConversationSseMessageV1[],
		);

		expect(result.events).toEqual([]);
		expect(result.controls).toEqual([
			expect.objectContaining({ type: "authorization.revoked" }),
		]);
	});
});
