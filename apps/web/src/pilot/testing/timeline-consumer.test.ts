import { pilotFakeScenariosV1 } from "@agent-infra/test-support/pilot";
import { describe, expect, it } from "vitest";
import type { ConversationSseMessageV1 } from "../generated/types.gen.js";
import { createPilotSseMessageConsumer } from "./timeline-consumer.js";

describe("Pilot Web SSE consumer", () => {
	it("deduplicates replay by stable eventId without reordering new events", () => {
		const consume = createPilotSseMessageConsumer();
		const messages = pilotFakeScenariosV1.replay
			.messages as unknown as readonly ConversationSseMessageV1[];
		const first = consume([messages[0]]);
		const result = consume(messages.slice(1));

		expect(first.events.map((event) => event.eventId)).toEqual([
			"event-replay-1",
		]);
		expect(result.events.map((event) => event.eventId)).toEqual([
			"event-replay-2",
		]);
		expect(result.events.map((event) => event.sequence)).toEqual([2]);
	});

	it("keeps stale-authorization control outside the persisted timeline", () => {
		const consume = createPilotSseMessageConsumer();
		const result = consume(
			pilotFakeScenariosV1.staleAuthorization
				.messages as unknown as readonly ConversationSseMessageV1[],
		);

		expect(result.events).toEqual([]);
		expect(result.controls).toEqual([
			expect.objectContaining({ type: "authorization.revoked" }),
		]);
	});

	it("keeps heartbeat controls outside the persisted timeline", () => {
		const consume = createPilotSseMessageConsumer();
		const heartbeat = {
			schemaVersion: 1,
			kind: "control",
			type: "heartbeat",
			occurredAt: "2026-08-28T10:00:00Z",
		} as unknown as ConversationSseMessageV1;
		const result = consume([heartbeat]);

		expect(result.events).toEqual([]);
		expect(result.controls).toEqual([
			expect.objectContaining({ type: "heartbeat" }),
		]);
	});
});
