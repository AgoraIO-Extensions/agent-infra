import {
	AgentProjectionV1Schema,
	CommandAcceptedProjectionV1Schema,
	ConversationSseMessageV1Schema,
	ExecutionDetailProjectionV1Schema,
	MessageProjectionV1Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import { describe, expect, it } from "vitest";

import { pilotFakeScenariosV1, resolvePilotReplayV1 } from "./index.js";

describe("Pilot schema-driven Fake scenarios", () => {
	it("covers every required product state with schema-valid responses", () => {
		expect(Object.keys(pilotFakeScenariosV1).sort()).toEqual(
			[
				"busy",
				"failed",
				"heartbeat",
				"replay",
				"staleAuthorization",
				"starting",
				"success",
				"unauthorized",
				"unavailable",
			].sort(),
		);
		expect(
			CommandAcceptedProjectionV1Schema.parse(
				pilotFakeScenariosV1.success.response.body,
			),
		).toEqual(pilotFakeScenariosV1.success.response.body);
		expect(
			AgentProjectionV1Schema.parse(
				pilotFakeScenariosV1.starting.response.body,
			),
		).toEqual(pilotFakeScenariosV1.starting.response.body);
		expect(
			ExecutionDetailProjectionV1Schema.parse(
				pilotFakeScenariosV1.failed.response.body,
			),
		).toEqual(pilotFakeScenariosV1.failed.response.body);
		expect(
			pilotFakeScenariosV1.failed.messages.map(
				(message) => MessageProjectionV1Schema.parse(message).error?.code,
			),
		).toEqual([
			"ORIGINAL_RESPONSE_NOT_STARTED",
			"ORIGINAL_RESPONSE_ALREADY_FINISHED",
			"AUTHORIZATION_REVOKED",
			"EXECUTION_FAILED",
		]);
		for (const scenario of [
			pilotFakeScenariosV1.unauthorized,
			pilotFakeScenariosV1.busy,
			pilotFakeScenariosV1.unavailable,
		]) {
			expect(PilotProtocolErrorV1Schema.parse(scenario.response.body)).toEqual(
				scenario.response.body,
			);
		}
		for (const scenario of [
			pilotFakeScenariosV1.replay,
			pilotFakeScenariosV1.staleAuthorization,
			pilotFakeScenariosV1.heartbeat,
		]) {
			for (const message of scenario.messages) {
				expect(ConversationSseMessageV1Schema.safeParse(message).success).toBe(
					true,
				);
			}
		}
		expect(pilotFakeScenariosV1.replay.messages[0]).toEqual(
			pilotFakeScenariosV1.replay.messages[1],
		);
	});

	it("returns reload controls without leaking events for foreign cursors", () => {
		const crossConversation = resolvePilotReplayV1({
			conversationId: "conversation-pilot-1",
			cursor: "cursor-other-1",
		});
		const unknown = resolvePilotReplayV1({
			conversationId: "conversation-pilot-1",
			cursor: "cursor-unknown",
		});

		expect(
			ConversationSseMessageV1Schema.parse(crossConversation[0]),
		).toMatchObject({
			type: "timeline.reload",
			reason: "cross_conversation_cursor",
		});
		expect(ConversationSseMessageV1Schema.parse(unknown[0])).toMatchObject({
			type: "timeline.reload",
			reason: "unknown_event_id",
		});
		expect(JSON.stringify(crossConversation)).not.toContain("event-replay-1");
	});

	it("replays valid event IDs and rejects foreign or unknown event IDs", () => {
		const valid = resolvePilotReplayV1({
			conversationId: "conversation-pilot-1",
			lastEventId: "event-before-replay",
		});
		const crossConversation = resolvePilotReplayV1({
			conversationId: "conversation-pilot-1",
			lastEventId: "event-other-1",
		});
		const unknown = resolvePilotReplayV1({
			conversationId: "conversation-pilot-1",
			lastEventId: "event-unknown",
		});

		expect(valid.map((message) => message.type)).toContain("text.delta");
		expect(
			ConversationSseMessageV1Schema.parse(crossConversation[0]),
		).toMatchObject({
			type: "timeline.reload",
			reason: "cross_conversation_event_id",
		});
		expect(ConversationSseMessageV1Schema.parse(unknown[0])).toMatchObject({
			type: "timeline.reload",
			reason: "unknown_event_id",
		});
		expect(JSON.stringify(crossConversation)).not.toContain("event-replay-1");
	});
});
