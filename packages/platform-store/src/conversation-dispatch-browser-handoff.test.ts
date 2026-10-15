import { describe, expect, it } from "vitest";
import { bindingMatches } from "./conversation-dispatch-sql.ts";
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

	it("keeps the execution model binding out of Browser handoff matching", () => {
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
				deliveryFence: 3,
				command: {
					schemaVersion: 1,
					command: "revoke",
					handoffId: "handoff-1",
				},
			},
			"conversation.browser.handoff.v1",
		);
		if (!payload) throw new Error("Browser payload fixture is invalid");
		expect(
			bindingMatches(
				{
					id: "item-1",
					scope_type: "conversation",
					scope_id: "conversation-1",
					operation: "conversation.browser.handoff.v1",
					payload,
					status: "processing",
					attempt_count: 1,
					available_at: new Date(0),
					available_now: true,
					waiting_available: false,
					lease_owner: "worker-1",
					lease_expires_at: new Date(10_000),
					delivery_fence: 4,
					trace_id: "trace-1",
					request_id: "request-1",
					trace_parent: null,
					decision_at: new Date(0),
				},
				payload,
				{
					id: "conversation-1",
					agent_id: "agent-1",
					actor_id: "actor-1",
					principal_type: "user",
					channel_id: "web",
					status: "active",
					session_generation: 1,
					authorization_revision: "authorization-1",
					host_session_ref: "host-1",
					sandbox_ready: true,
					sandbox: { sandboxId: "sandbox-1" },
				} as never,
				{
					sandbox_id: "sandbox-1",
					execution_id: "execution-1",
					conversation_id: "conversation-1",
					agent_id: "agent-1",
					actor_id: "actor-1",
					principal_type: "user",
					channel_id: "web",
					turn_id: "turn-1",
					status: "processing",
					session_generation: 1,
					delivery_fence: 3,
					authorization_revision: "authorization-1",
					model_configuration_revision: 9,
					model_option_id: "model-1",
					reasoning_level: "high",
				} as never,
			),
		).toBe(true);
	});
});
