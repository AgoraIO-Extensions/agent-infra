import { describe, expect, it, vi } from "vitest";
import type { BrowserHandoffActionInputV1 } from "../agent-discovery/browser-handoff-panel.js";
import { createBrowserConversationHandlers } from "./active-conversation.js";
import type { BrowserCommandBody } from "./conversation-commands.js";

const input: BrowserHandoffActionInputV1 = {
	id: "opaque-browser-action",
	binding: {
		subjectId: "subject-1",
		agentId: "agent-1",
		conversationId: "conversation-1",
		executionId: "execution-1",
		sessionGeneration: 2,
		resourceFence: 7,
		workloadRevision: 4,
		imageDigest: `sha256:${"a".repeat(64)}`,
		capabilityVersion: 1,
		capabilityRevision: 1,
		pageRevision: 4,
	},
};

describe("ActiveConversation Browser command wiring", () => {
	it("maps every panel callback to the opaque server command payload", () => {
		const invokeBrowser = vi.fn<(body: BrowserCommandBody) => boolean>(
			() => true,
		);
		const handlers = createBrowserConversationHandlers(invokeBrowser);

		handlers.onRevoke(input);
		handlers.onTakeOver(input);
		handlers.onReturnToAgent(input);
		handlers.onConfirmSideEffect(input);
		handlers.onRejectSideEffect(input);
		handlers.onCancelConfirmation(input);

		expect(invokeBrowser.mock.calls.map(([body]) => body)).toEqual([
			{ schemaVersion: 1, command: "revoke", handoffId: input.id },
			{ schemaVersion: 1, command: "take_over", handoffId: input.id },
			{
				schemaVersion: 1,
				command: "return_to_agent",
				handoffId: input.id,
			},
			{
				schemaVersion: 1,
				command: "confirm_side_effect",
				confirmationId: input.id,
			},
			{
				schemaVersion: 1,
				command: "reject_side_effect",
				confirmationId: input.id,
			},
			{
				schemaVersion: 1,
				command: "cancel_side_effect",
				confirmationId: input.id,
			},
		]);
	});
});
