import { describe, expect, it } from "vitest";

import { resolvePilotReplayV1 } from "../../../test-support/src/pilot/index.js";
import {
	ConversationSseMessageV1Schema,
	DelegatedActionRequestV1Schema,
	MessageCommandRequestV1Schema,
} from "../../src/pilot/index.js";

describe("Pilot consumer contract boundaries", () => {
	it("fails closed for unknown versions at every consumer boundary", () => {
		expect(
			MessageCommandRequestV1Schema.safeParse({
				schemaVersion: 2,
				text: "hello",
			}).success,
		).toBe(false);
		expect(
			ConversationSseMessageV1Schema.safeParse({
				schemaVersion: 2,
				kind: "control",
				type: "timeline.reload",
				reason: "unknown_event_id",
				resumeCursor: "cursor-pilot-2",
			}).success,
		).toBe(false);
		expect(
			DelegatedActionRequestV1Schema.safeParse({
				schemaVersion: 2,
				requestId: "request-1",
				idempotencyKey: "tool.call_1",
				grant: {
					schemaVersion: 1,
					format: "compact-jws",
					token: "header.payload.signature",
				},
				action: {
					actionId: "github.issues.read",
					actionVersion: "v3",
					arguments: {},
				},
				traceId: "trace-1",
			}).success,
		).toBe(false);
	});

	it("turns cross-conversation and unknown cursors into reload signals", () => {
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
});
