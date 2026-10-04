import { describe, expect, it } from "vitest";
import {
	conversationFromRow,
	matchesBinding,
	parseAuthority,
} from "./conversation-execution-records.js";

const row = {
	id: "conversation",
	agent_id: "agent",
	actor_id: "shared-id",
	channel_id: "api",
	principal_type: "application",
	status: "ready",
	session_generation: 1,
	host_session_ref: null,
	authorization_revision: "agent-revision",
	last_conversation_cursor: 0,
	selected_model_option_id: null,
	selected_reasoning_level: null,
	created_at: new Date(0),
	updated_at: new Date(0),
};
const authority = (kind: "user" | "application") =>
	parseAuthority({
		schemaVersion: 1,
		actorId: "shared-id",
		agentId: "agent",
		channelId: "api",
		authorizationRevision: "agent-revision",
		supportsSupplementaryInstruction: false,
		taskBoundary: {
			schemaVersion: 1,
			principal: { kind, id: "shared-id" },
			agentId: "agent",
			channelId: "api",
			identityRevision: "identity-revision",
			agentAuthorizationRevision: "agent-revision",
			accessSources: [{ kind: "api-use", useGrantRevision: "use-revision" }],
		},
	});

describe("persisted Conversation principal binding", () => {
	it("projects actual principal_type and refuses the other kind with the same ID", () => {
		const conversation = conversationFromRow(row);
		expect(conversation.principal).toEqual({
			kind: "application",
			id: "shared-id",
		});
		expect(matchesBinding(conversation, authority("application"))).toBe(true);
		expect(matchesBinding(conversation, authority("user"))).toBe(false);
	});
	it("fails closed for absent/invalid application type rather than deriving it from channel or actor", () => {
		for (const principal_type of [undefined, null, "owner", ""]) {
			expect(() =>
				conversationFromRow({
					...row,
					principal_type,
				} as unknown as typeof row),
			).toThrow();
		}
		expect(() =>
			conversationFromRow({ ...row, channel_id: "api:user" }),
		).toThrow();
		expect(
			conversationFromRow({ ...row, principal_type: "user", channel_id: "web" })
				.principal,
		).toEqual({ kind: "user", id: "shared-id" });
	});
});
