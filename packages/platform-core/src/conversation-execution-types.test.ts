import { describe, expect, it } from "vitest";
import { conversationExecutionKeySubjectV1 } from "./conversation-execution-types.js";

describe("conversation execution Key subject", () => {
	it.each([
		["web", "web", "personal", "user-1"],
		["wecom_app:service-1", "wecom", "personal", "user-1"],
		["api:client-1", "platform-api", "agent-default", "agent-1"],
		["eval", "eval", "agent-default", "agent-1"],
	] as const)(
		"binds %s to the %s source and its Key subject",
		(channelId, executionSource, purpose, subjectId) => {
			expect(
				conversationExecutionKeySubjectV1({
					actorId: "user-1",
					agentId: "agent-1",
					channelId,
				}),
			).toEqual({ executionSource, purpose, subjectId });
		},
	);

	it("rejects an unknown source before selecting a Key", () => {
		expect(() =>
			conversationExecutionKeySubjectV1({
				actorId: "user-1",
				agentId: "agent-1",
				channelId: "unknown",
			}),
		).toThrow(TypeError);
	});
});
