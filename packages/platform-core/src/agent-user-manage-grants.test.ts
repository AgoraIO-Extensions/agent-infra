import { describe, expect, it } from "vitest";
import {
	parseAgentUserManageGrantCommandV1,
	planAgentUserManageGrantV1,
} from "./agent-user-manage-grants.js";
import { PersonalApiCredentialErrorV1 } from "./personal-api-credentials.js";

const command = {
	schemaVersion: 1 as const,
	agentId: "agent-1",
	userId: "owner-1",
	actorId: "owner-1",
	expectedRevision: 3,
	idempotencyKey: "manage-1",
	requestId: "request-1",
	traceId: "trace-1",
};
const occurredAt = new Date("2026-10-18T00:00:00.000Z");

describe("user API manage grant policy (#2759)", () => {
	it("grants with a fresh revision and audits the manager scope with the user target", () => {
		const plan = planAgentUserManageGrantV1({
			command,
			granted: true,
			current: { granted: false, authorizationRevision: "manage-old" },
			replayed: false,
			nextRevision: "manage-new",
			occurredAt,
		});
		expect(plan.mutation).toBe("grant");
		expect(plan.result).toEqual({
			schemaVersion: 1,
			agentId: "agent-1",
			userId: "owner-1",
			granted: true,
			authorizationRevision: "manage-new",
			replayed: false,
		});
		expect(plan.audit).toMatchObject({
			action: "api.agent.manager.granted",
			actorType: "user",
			actorId: "owner-1",
			targetType: "agent",
			targetId: "agent-1",
			details: {
				userId: "owner-1",
				grantType: "manage",
				granted: true,
				authorizationRevision: "manage-new",
			},
		});
	});

	it("keeps an active grant unchanged instead of rotating its revision", () => {
		const plan = planAgentUserManageGrantV1({
			command,
			granted: true,
			current: { granted: true, authorizationRevision: "manage-1" },
			replayed: false,
			nextRevision: "manage-2",
			occurredAt,
		});
		expect(plan.mutation).toBe("none");
		expect(plan.result.authorizationRevision).toBe("manage-1");
	});

	it("revokes an active grant and refuses to revoke one that never existed", () => {
		const plan = planAgentUserManageGrantV1({
			command: { ...command, idempotencyKey: "manage-revoke" },
			granted: false,
			current: { granted: true, authorizationRevision: "manage-1" },
			replayed: false,
			nextRevision: "manage-2",
			occurredAt,
		});
		expect(plan.mutation).toBe("revoke");
		expect(plan.result).toMatchObject({
			granted: false,
			authorizationRevision: "manage-2",
		});
		expect(plan.audit.action).toBe("api.agent.manager.revoked");
		expect(plan.audit.details).toEqual({
			userId: "owner-1",
			grantType: "manage",
			granted: false,
			authorizationRevision: "manage-2",
		});
		expect(() =>
			planAgentUserManageGrantV1({
				command,
				granted: false,
				current: null,
				replayed: false,
				nextRevision: "manage-2",
				occurredAt,
			}),
		).toThrow(new PersonalApiCredentialErrorV1("not_found"));
	});

	it("audits a replay without a mutation", () => {
		const plan = planAgentUserManageGrantV1({
			command,
			granted: true,
			current: { granted: true, authorizationRevision: "manage-1" },
			replayed: true,
			nextRevision: "manage-2",
			occurredAt,
		});
		expect(plan.mutation).toBe("none");
		expect(plan.audit.action).toBe("api.agent.manager.replayed");
	});

	it("rejects malformed commands and port facts", () => {
		expect(() =>
			parseAgentUserManageGrantCommandV1({ ...command, credential: "x" }),
		).toThrow(new PersonalApiCredentialErrorV1("invalid_input"));
		expect(() =>
			planAgentUserManageGrantV1({
				command,
				granted: true,
				current: {
					granted: "yes" as unknown as boolean,
					authorizationRevision: "m",
				},
				replayed: false,
				nextRevision: "manage-2",
				occurredAt,
			}),
		).toThrow(new PersonalApiCredentialErrorV1("unavailable"));
		expect(() =>
			planAgentUserManageGrantV1({
				command,
				granted: "true" as unknown as boolean,
				current: null,
				replayed: false,
				nextRevision: "manage-2",
				occurredAt,
			}),
		).toThrow(new PersonalApiCredentialErrorV1("unavailable"));
	});
});
