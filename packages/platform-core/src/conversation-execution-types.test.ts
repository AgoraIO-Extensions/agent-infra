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
			accessSources:
				channelId === "api" || channelId === "api:user"
					? [{ kind: "api-use", useGrantRevision: "use-1" }]
					: [{ kind: "organization", organizationId: "org-1" }],
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
		["api:user", "platform-api", "agent-default", "agent-1"],
		["eval", "eval", "agent-default", "agent-1"],
	] as const)(
		"binds trusted %s to its own Key subject",
		(channel, executionSource, purpose, subjectId) => {
			expect(
				conversationExecutionKeySubjectV1(authority(channel), "standard", user),
			).toEqual({ executionSource, purpose, subjectId });
		},
	);

	it.each(["unknown", "api:application", "wecom_bot:", "wecom_app:"])(
		"rejects unconfirmed %s instead of guessing a subject",
		(channel) => {
			expect(() =>
				conversationExecutionKeySubjectV1(authority(channel), "standard", user),
			).toThrow(TypeError);
		},
	);

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

it.each(["api", "api:application"])(
	"keeps an application %s task on Agent default Key with no person fallback",
	(channelId) => {
		const current = {
			schemaVersion: 1 as const,
			applicationId: "app-1",
			status: "active" as const,
			authorizationRevision: "app-revision-1",
			useGrant: {
				principal: { kind: "application" as const, id: "app-1" },
				grantType: "use" as const,
				agentId: "agent-1",
				authorizationRevision: "use-1",
				revoked: false,
			},
		};
		const input = authority(channelId);
		if (!input.taskBoundary) throw new Error("Expected original boundary");
		const bound = {
			...input,
			actorId: "app-1",
			taskBoundary: {
				...input.taskBoundary,
				principal: current.useGrant.principal,
				identityRevision: current.authorizationRevision,
				accessSources: [
					{ kind: "api-use" as const, useGrantRevision: "use-1" },
				],
			},
		};
		expect(
			conversationExecutionKeySubjectV1(bound, "standard", current),
		).toEqual({
			executionSource: "platform-api",
			purpose: "agent-default",
			subjectId: "agent-1",
		});
		expect(
			conversationExecutionKeySubjectV1(bound, "standard", {
				...current,
				useGrant: { ...current.useGrant, revoked: true },
			}),
		).toBeNull();
		expect(
			conversationExecutionKeySubjectV1(bound, "standard", {
				...current,
				useGrant: { ...current.useGrant, authorizationRevision: "replacement" },
			}),
		).toBeNull();
		expect(() =>
			conversationExecutionKeySubjectV1(bound, "standard", user),
		).toThrow();
	},
);
