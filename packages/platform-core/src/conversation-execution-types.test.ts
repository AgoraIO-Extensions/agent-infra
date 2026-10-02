import { describe, expect, it } from "vitest";
import {
	type ConversationExecutionAuthorityV1,
	conversationExecutionKeySubjectV1,
} from "./conversation-execution-types.js";
import type { CurrentTaskUserV1 } from "./task-authorization.js";

const user: CurrentTaskUserV1 = {
	schemaVersion: 1,
	userId: "user-1",
	accountStatus: "active",
	organizationIds: ["org-1"],
	authorizationRevision: "identity-1",
};

function authority(channelId = "web"): ConversationExecutionAuthorityV1 {
	return {
		schemaVersion: 1,
		actorId: user.userId,
		agentId: "agent-1",
		channelId,
		authorizationRevision: "access-1",
		supportsSupplementaryInstruction: false,
		taskBoundary: {
			schemaVersion: 1,
			principal: { kind: "user", id: user.userId },
			agentId: "agent-1",
			channelId,
			identityRevision: user.authorizationRevision,
			agentAuthorizationRevision: "access-1",
			accessSources: [{ kind: "organization", organizationId: "org-1" }],
		},
	};
}

describe("conversation execution Key subject", () => {
	it.each([
		["web", "web", "personal", "user-1"],
		["wecom", "wecom", "personal", "user-1"],
		["wecom_bot:service-1", "wecom", "personal", "user-1"],
		["wecom_app:service-1", "wecom", "personal", "user-1"],
		["api", "platform-api", "agent-default", "agent-1"],
		["eval", "eval", "agent-default", "agent-1"],
	] as const)(
		"binds trusted %s to its own Key subject",
		(channel, executionSource, purpose, subjectId) => {
			expect(
				conversationExecutionKeySubjectV1(authority(channel), "standard", user),
			).toEqual({ executionSource, purpose, subjectId });
		},
	);

	it.each([
		"unknown",
		"api:user",
		"api:application",
		"wecom_bot:",
		"wecom_app:",
	])("rejects unconfirmed %s instead of guessing a subject", (channel) => {
		expect(() =>
			conversationExecutionKeySubjectV1(authority(channel), "standard", user),
		).toThrow(TypeError);
	});

	it.each(["web", "wecom_app:service-1", "api", "eval"])(
		"does not assign a Platform Key to custom %s",
		(channel) => {
			expect(
				conversationExecutionKeySubjectV1(authority(channel), "custom", user),
			).toBeNull();
		},
	);

	it.each([null, undefined])("rejects absent Agent source %s", (source) => {
		expect(() =>
			conversationExecutionKeySubjectV1(authority(), source, user),
		).toThrow(TypeError);
	});

	it.each([
		{ actorId: "user-2" },
		{ agentId: "agent-2" },
		{ channelId: "api" },
		{ authorizationRevision: "access-2" },
		{ taskBoundary: undefined },
	])("rejects a boundary mismatch %j", (changed) => {
		expect(() =>
			conversationExecutionKeySubjectV1(
				{ ...authority(), ...changed },
				"standard",
				user,
			),
		).toThrow(TypeError);
	});

	it.each([
		{ accountStatus: "disabled" as const },
		{ authorizationRevision: "identity-2" },
		{ organizationIds: ["org-2"] },
	])("refuses changed current identity/access %j", (changed) => {
		expect(
			conversationExecutionKeySubjectV1(authority(), "standard", {
				...user,
				...changed,
			}),
		).toBeNull();
	});

	it("cannot select an application's responsible person's personal Key", () => {
		const value = authority("api");
		expect(() =>
			conversationExecutionKeySubjectV1(
				{
					...value,
					taskBoundary: {
						...value.taskBoundary,
						principal: { kind: "application", id: "application-1" },
					},
				} as unknown as ConversationExecutionAuthorityV1,
				"standard",
				user,
			),
		).toThrow(TypeError);
	});
});
