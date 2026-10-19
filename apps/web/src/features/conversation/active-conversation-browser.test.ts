import { describe, expect, it } from "vitest";
import { browserCommandBody } from "./active-conversation.js";

describe("ActiveConversation Browser command wiring", () => {
	it("maps every card command to the opaque server command payload", () => {
		expect(
			[
				{ kind: "take_over", handoffId: "opaque-handoff" },
				{ kind: "return_to_agent", handoffId: "opaque-handoff" },
				{ kind: "revoke", handoffId: "opaque-handoff" },
				{ kind: "confirm_side_effect", confirmationId: "opaque-confirmation" },
				{ kind: "reject_side_effect", confirmationId: "opaque-confirmation" },
			].map((command) =>
				browserCommandBody(command as Parameters<typeof browserCommandBody>[0]),
			),
		).toEqual([
			{ schemaVersion: 1, command: "take_over", handoffId: "opaque-handoff" },
			{
				schemaVersion: 1,
				command: "return_to_agent",
				handoffId: "opaque-handoff",
			},
			{ schemaVersion: 1, command: "revoke", handoffId: "opaque-handoff" },
			{
				schemaVersion: 1,
				command: "confirm_side_effect",
				confirmationId: "opaque-confirmation",
			},
			{
				schemaVersion: 1,
				command: "reject_side_effect",
				confirmationId: "opaque-confirmation",
			},
		]);
	});
});
