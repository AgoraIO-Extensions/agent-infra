import { describe, expect, it } from "vitest";
import {
	planAgentUserUseRevokeV1,
	requireAgentUserUseRevokeAuthorityV1,
} from "./agent-user-use-grants.js";

const command = {
	schemaVersion: 1 as const,
	agentId: "agent-1",
	userId: "user-2",
	actorId: "owner-1",
	expectedRevision: 1,
	idempotencyKey: "revoke-1",
	requestId: "request-1",
	traceId: "trace-1",
};
const state = {
	schemaVersion: 1 as const,
	applicationId: "application-1",
	agentId: "agent-1",
	applicantId: "owner-1",
	status: "available" as const,
	revision: 1,
	approvalRevision: 1,
	decisionReason: null,
	serviceAvailability: "ready" as const,
	desiredState: "running" as const,
	workloadRevision: 1,
	fence: 1,
	ownerIds: ["owner-1"],
	availability: [],
	failureCode: null,
};
const actor = {
	schemaVersion: 1 as const,
	userId: "owner-1",
	accountStatus: "active" as const,
	organizationIds: [],
	authorizationRevision: "actor-1",
};

describe("user API use revoke policy", () => {
	it("requires the current Owner and allows a disabled target to be revoked", () => {
		expect(
			requireAgentUserUseRevokeAuthorityV1({
				command,
				state,
				actor,
				actorDisabled: false,
			}),
		).toBe("actor-1");
	});

	it("plans an idempotent revoke without granting the target", () => {
		const plan = planAgentUserUseRevokeV1({
			command,
			current: { granted: true, authorizationRevision: "use-1" },
			replayed: false,
			nextRevision: "use-2",
			occurredAt: new Date("2026-10-10T00:00:00.000Z"),
		});
		expect(plan.mutation).toBe("revoke");
		expect(plan.result).toMatchObject({
			agentId: "agent-1",
			userId: "user-2",
			granted: false,
			authorizationRevision: "use-2",
		});
	});
});
