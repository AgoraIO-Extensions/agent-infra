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
		for (const message of pilotFakeScenariosV1.replay.messages) {
			expect(ConversationSseMessageV1Schema.safeParse(message).success).toBe(
				true,
			);
		}
		expect(pilotFakeScenariosV1.replay.messages[0]).toEqual(
			pilotFakeScenariosV1.replay.messages[1],
		);
		expect(
			ConversationSseMessageV1Schema.parse(
				pilotFakeScenariosV1.staleAuthorization.messages[0],
			),
		).toMatchObject({
			type: "authorization.revoked",
			error: { retryable: false },
		});
	});

	it("returns reload controls without leaking events for foreign or unknown cursors", () => {
		const crossConversation = resolvePilotReplayV1({
			conversationId: "conversation-pilot-1",
			cursor: "cursor-other-1",
		});
		const unknown = resolvePilotReplayV1({
			conversationId: "conversation-pilot-1",
			cursor: "cursor-unknown",
		});
		const sameForeignConversation = resolvePilotReplayV1({
			conversationId: "conversation-other-1",
			cursor: "cursor-other-1",
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
		expect(sameForeignConversation).toEqual([]);
	});
});
