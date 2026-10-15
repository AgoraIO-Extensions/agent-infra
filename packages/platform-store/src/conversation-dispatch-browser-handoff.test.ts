import { describe, expect, it } from "vitest";
import { exactPayload, operation } from "./conversation-dispatch-validation.ts";

describe("Conversation Browser handoff outbox payload", () => {
	it("parses an admitted handoff command with its immutable execution binding", () => {
		const payload = exactPayload(
			{
				schemaVersion: 1,
				conversationId: "conversation-1",
				agentId: "agent-1",
				actorId: "actor-1",
				channelId: "web",
				executionId: "execution-1",
				turnId: "turn-1",
				sessionGeneration: 1,
				deliveryFence: 2,
				command: {
					schemaVersion: 1,
					command: "return_to_agent",
					handoffId: "handoff-1",
				},
			},
			"conversation.browser.handoff.v1",
		);
		expect(payload).toMatchObject({
			conversationId: "conversation-1",
			executionId: "execution-1",
			turnId: "turn-1",
			browserHandoff: {
				command: "return_to_agent",
				handoffId: "handoff-1",
			},
		});
		expect(operation("conversation.browser.handoff.v1")).toBe(
			"conversation.browser.handoff.v1",
		);
	});

	it("rejects a pause or side-effect command from the Runtime handoff outbox", () => {
		expect(
			exactPayload(
				{
					schemaVersion: 1,
					conversationId: "conversation-1",
					agentId: "agent-1",
					actorId: "actor-1",
					channelId: "web",
					executionId: "execution-1",
					turnId: "turn-1",
					sessionGeneration: 1,
					deliveryFence: 2,
					command: {
						schemaVersion: 1,
						command: "pause",
						handoffId: "handoff-1",
					},
				},
				"conversation.browser.handoff.v1",
			),
		).toBeUndefined();
	});
});
