import { describe, expect, it } from "vitest";
import type {
	PlatformAuditQueryScopeV1,
	PlatformExecutionAuditBindingV1,
} from "./audit-query.js";
import {
	type PlatformAuditCandidateV1,
	requirePlatformAuditCandidateAccessV1,
} from "./audit-query-access.js";

const scope: PlatformAuditQueryScopeV1 = {
	kind: "execution",
	principal: { kind: "user", id: "user-a" },
	user: {
		schemaVersion: 1,
		userId: "user-a",
		accountStatus: "active",
		organizationIds: [],
		authorizationRevision: "directory-a",
	},
};
const binding: PlatformExecutionAuditBindingV1 = {
	executionId: "execution-a",
	agentId: "agent-a",
	actorId: "user-a",
	channelId: "web",
	authorizationRecordId: "authorization-a",
	acceptedActor: { kind: "user", id: "user-a" },
	acceptedExecutionId: "execution-a",
	acceptedAgentId: "agent-a",
	acceptedAuthorizationRecordId: "authorization-a",
	boundary: {
		schemaVersion: 1,
		principal: { kind: "user", id: "user-a" },
		agentId: "agent-a",
		channelId: "web",
		identityRevision: "directory-a",
		agentAuthorizationRevision: "agent-a",
		accessSources: [{ kind: "user", userId: "user-a" }],
	},
};
const bound: PlatformAuditCandidateV1 = {
	source: "conversation",
	action: "conversation.task.accepted",
	actorType: "unknown",
	actorId: "user-a",
	targetType: "execution",
	targetId: "execution-a",
	agentId: "agent-a",
	conversationId: "conversation-a",
	executionId: "execution-a",
	executionConversationId: "conversation-a",
	binding,
	attempt: null,
};
const attemptDetails: NonNullable<PlatformAuditCandidateV1["attempt"]> = {
	schemaVersion: 1,
	operation: "submit",
	phase: "submit.result",
	targetKind: "agent",
	targetAgentId: "agent-a",
};
const attempt: PlatformAuditCandidateV1 = {
	source: "platform",
	action: "task.api.submit.result",
	actorType: "user",
	actorId: "user-a",
	targetType: "agent",
	targetId: "agent-a",
	agentId: "agent-a",
	conversationId: null,
	executionId: null,
	executionConversationId: null,
	binding: null,
	attempt: attemptDetails,
};

describe("audit candidate access", () => {
	it("accepts matching durable execution and own admission attempt", () => {
		expect(() =>
			requirePlatformAuditCandidateAccessV1(bound, scope),
		).not.toThrow();
		expect(() =>
			requirePlatformAuditCandidateAccessV1(
				{
					...bound,
					source: "platform",
					action: "task.status.changed",
					actorType: "system",
					actorId: "platform_worker",
					conversationId: null,
				},
				scope,
			),
		).not.toThrow();
		expect(() =>
			requirePlatformAuditCandidateAccessV1(attempt, scope),
		).not.toThrow();
	});

	it.each([
		{ conversationId: "other" },
		{ actorId: "other" },
		{ agentId: "other" },
		{ binding: null },
		{ binding: { ...binding, channelId: "api:application" } },
		{ binding: { ...binding, acceptedAuthorizationRecordId: "other" } },
		{
			source: "platform" as const,
			actorType: "system",
			actorId: "platform_worker",
		},
	])("denies an inconsistent execution candidate: %j", (change) => {
		expect(() =>
			requirePlatformAuditCandidateAccessV1({ ...bound, ...change }, scope),
		).toThrowError(expect.objectContaining({ code: "access_denied" }));
	});

	it.each([
		{ actorId: "other" },
		{ targetId: "other" },
		{ executionId: "execution-a" },
		{ action: "task.api.subscription.started" },
		{ attempt: { ...attemptDetails, phase: "access" } },
		{ attempt: { ...attemptDetails, targetAgentId: "other" } },
	])("denies an inconsistent admission attempt: %j", (change) => {
		expect(() =>
			requirePlatformAuditCandidateAccessV1({ ...attempt, ...change }, scope),
		).toThrowError(expect.objectContaining({ code: "access_denied" }));
	});

	it("allows administrator metadata while requiring the principal's own execution", () => {
		const admin: PlatformAuditQueryScopeV1 = {
			kind: "administrator",
			administratorId: "admin-a",
		};
		expect(() =>
			requirePlatformAuditCandidateAccessV1({ ...bound, binding: null }, admin),
		).not.toThrow();
		expect(() =>
			requirePlatformAuditCandidateAccessV1(bound, {
				...scope,
				principal: { kind: "user", id: "other" },
			}),
		).toThrowError(expect.objectContaining({ code: "access_denied" }));
	});
});
