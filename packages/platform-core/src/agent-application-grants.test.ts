import { describe, expect, it } from "vitest";
import {
	planAgentApplicationGrantV1,
	requireAgentApplicationGrantAuthorityV1,
} from "./agent-application-grants.js";
import type { AgentManagementStateV1 } from "./agent-management.js";

const state: AgentManagementStateV1 = {
	schemaVersion: 1,
	applicationId: "registration",
	agentId: "agent",
	applicantId: "owner",
	status: "stopped",
	revision: 2,
	approvalRevision: 1,
	decisionReason: null,
	serviceAvailability: null,
	desiredState: "stopped",
	workloadRevision: 1,
	fence: 1,
	ownerIds: ["owner"],
	availability: [],
	failureCode: null,
};
const input = {
	command: {
		schemaVersion: 1 as const,
		agentId: "agent",
		applicationId: "robot",
		actorId: "owner",
		granted: true,
		idempotencyKey: "grant",
		requestId: "request",
		traceId: "trace",
	},
	state,
	actor: {
		schemaVersion: 1,
		userId: "owner",
		accountStatus: "active",
		organizationIds: [],
		authorizationRevision: "owner-1",
	},
	actorDisabled: false,
	application: {
		id: "robot",
		status: "active",
		authorizationRevision: "robot-1",
	},
};
describe("application Agent manager governance", () => {
	it("plans a new explicit manage grant and its necessary audit without use or material permissions", () => {
		const plan = planAgentApplicationGrantV1({
			command: input.command,
			grantType: "manage",
			current: null,
			replayed: false,
			nextRevision: "grant-1",
			occurredAt: new Date("2026-10-07T00:00:00Z"),
		});
		expect(plan.mutation).toBe("grant");
		expect(plan.result).toMatchObject({
			granted: true,
			authorizationRevision: "grant-1",
		});
		expect(plan.audit).toMatchObject({
			actorType: "user",
			actorId: "owner",
			action: "api.agent.manager.granted",
			targetType: "agent",
			targetId: "agent",
			details: { grantType: "manage" },
		});
	});
	it("keeps a revoked grant revoked when replaying an earlier grant command", () => {
		const plan = planAgentApplicationGrantV1({
			command: input.command,
			grantType: "manage",
			current: { granted: false, authorizationRevision: "revoke-2" },
			replayed: true,
			nextRevision: "unused-revision",
			occurredAt: new Date("2026-10-07T00:00:00Z"),
		});
		expect(plan.mutation).toBe("none");
		expect(plan.result).toMatchObject({
			granted: false,
			authorizationRevision: "revoke-2",
			replayed: true,
		});
		expect(plan.audit.action).toBe("api.agent.manager.replayed");
	});
	it("plans use grants independently and gives them truthful audit facts", () => {
		const plan = planAgentApplicationGrantV1({
			command: input.command,
			grantType: "use",
			current: null,
			replayed: false,
			nextRevision: "use-1",
			occurredAt: new Date("2026-10-07T00:00:00Z"),
		});
		expect(plan.mutation).toBe("grant");
		expect(plan.audit).toMatchObject({
			action: "api.agent.use.granted",
			details: { grantType: "use" },
		});
		const replay = planAgentApplicationGrantV1({
			command: input.command,
			grantType: "use",
			current: { granted: false, authorizationRevision: "use-revoked" },
			replayed: true,
			nextRevision: "unused",
			occurredAt: new Date("2026-10-07T00:00:00Z"),
		});
		expect(replay.result).toMatchObject({
			granted: false,
			authorizationRevision: "use-revoked",
			replayed: true,
		});
		expect(replay.mutation).toBe("none");
		expect(replay.audit.action).toBe("api.agent.use.replayed");
	});
	it("rejects a missing or unsupported grant kind instead of granting a default permission", () => {
		for (const grantType of [undefined, "owner"])
			expect(() =>
				planAgentApplicationGrantV1({
					command: input.command,
					grantType: grantType as never,
					current: null,
					replayed: false,
					nextRevision: "new",
					occurredAt: new Date("2026-10-07T00:00:00Z"),
				}),
			).toThrow(expect.objectContaining({ code: "unavailable" }));
	});
	it("allows current human Owner governance for an independent application", () => {
		expect(requireAgentApplicationGrantAuthorityV1(input)).toBe("owner-1");
	});
	it("rejects a responsible person or administrator who is not the Agent Owner", () => {
		for (const id of ["responsible-person", "administrator"])
			expect(() =>
				requireAgentApplicationGrantAuthorityV1({
					...input,
					command: { ...input.command, actorId: id },
					actor: { ...input.actor, userId: id },
				}),
			).toThrow(expect.objectContaining({ code: "not_found" }));
	});
	it("blocks grants to a disabled application while allowing its manage authority to be revoked", () => {
		const application = { ...input.application, status: "disabled" };
		expect(() =>
			requireAgentApplicationGrantAuthorityV1({ ...input, application }),
		).toThrow(expect.objectContaining({ code: "forbidden" }));
		expect(
			requireAgentApplicationGrantAuthorityV1({
				...input,
				application,
				command: { ...input.command, granted: false },
			}),
		).toBe("owner-1");
	});
	it("does not permit a disabled Owner to govern", () => {
		expect(() =>
			requireAgentApplicationGrantAuthorityV1({
				...input,
				actorDisabled: true,
			}),
		).toThrow(expect.objectContaining({ code: "forbidden" }));
	});
});
