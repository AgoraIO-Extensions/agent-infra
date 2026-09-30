import { describe, expect, it } from "vitest";

import { agentManagementV1Conformance } from "./agent-management.conformance.ts";
import {
	AgentManagementError,
	type AgentManagementStateV1,
	createAgentManagementV1,
	isAgentAccessAllowedV1,
	snapshotAgentManagementWritePlanV1,
} from "./agent-management.ts";
import { FakeAgentManagementV1 } from "./fake-agent-management.ts";

describe("Fake Agent management Interface", () => {
	agentManagementV1Conformance(async (options) =>
		Promise.resolve(new FakeAgentManagementV1(options)),
	);
});

it("allows an API manage grant to discover without granting use", () => {
	const grant = {
		principal: { kind: "application" as const, id: "application-caller" },
		grantType: "manage" as const,
		authorizationRevision: "grant-1",
		revokedAt: null,
	};
	const state: AgentManagementStateV1 = {
		schemaVersion: 1,
		applicationId: "application-access",
		agentId: "agent-access",
		applicantId: "owner-access",
		status: "available",
		revision: 1,
		approvalRevision: 1,
		decisionReason: null,
		serviceAvailability: "ready",
		desiredState: "running",
		workloadRevision: 1,
		fence: 1,
		ownerIds: [],
		availability: [],
		failureCode: null,
		authorizationRevision: grant.authorizationRevision,
		principalGrants: [grant],
	};
	const actor = {
		schemaVersion: 1 as const,
		userId: "owner-access",
		accountStatus: "active" as const,
		organizationIds: [],
		isAdministrator: false,
		principal: { kind: "application" as const, id: "application-caller" },
	};
	expect(isAgentAccessAllowedV1(state, actor, "discover")).toBe(true);
	expect(isAgentAccessAllowedV1(state, actor, "manage")).toBe(true);
	expect(isAgentAccessAllowedV1(state, actor, "use")).toBe(false);
	expect(
		isAgentAccessAllowedV1(
			{ ...state, principalGrants: [{ ...grant, revokedAt: new Date() }] },
			actor,
			"discover",
		),
	).toBe(false);
});

it.each(["user", "application"] as const)(
	"requires a current Agent revision for %s API access and lifecycle commands",
	async (kind) => {
		const principal = { kind, id: "api-caller" };
		const current: AgentManagementStateV1 = {
			schemaVersion: 1,
			applicationId: "application_current_grant",
			agentId: "agent_current_grant",
			applicantId: "api-caller",
			status: "available",
			revision: 1,
			approvalRevision: 1,
			decisionReason: null,
			serviceAvailability: "ready",
			desiredState: "running",
			workloadRevision: 1,
			fence: 1,
			ownerIds: ["api-caller"],
			availability: [{ kind: "user", userId: "api-caller" }],
			failureCode: null,
			authorizationRevision: "current-agent-revision",
			principalGrants: [
				{
					principal,
					grantType: "manage",
					authorizationRevision: "current-agent-revision",
					revokedAt: null,
				},
			],
		};
		let state = current;
		const management = createAgentManagementV1({
			async executeAgentManagementTransaction(_request, decide) {
				return decide(state);
			},
			async resolveAgentAccessState() {
				return state;
			},
		});
		const actor = {
			schemaVersion: 1 as const,
			userId: "api-caller",
			accountStatus: "active" as const,
			organizationIds: [],
			isAdministrator: false,
			principal,
		};
		for (const intent of ["discover", "manage", "use"] as const) {
			const grant = {
				principal,
				grantType: intent === "use" ? ("use" as const) : ("manage" as const),
				authorizationRevision: "current-agent-revision",
				revokedAt: null,
			};
			state = { ...current, principalGrants: [grant] };
			const query = {
				schemaVersion: 1 as const,
				agentId: state.agentId,
				intent,
			};
			await expect(
				management.resolveAgentAccess(query, actor),
			).resolves.toMatchObject({
				outcome: "allowed",
			});
			for (const invalid of [
				{
					...state,
					principalGrants: [
						{ ...grant, authorizationRevision: "old-agent-revision" },
					],
				},
				{ ...state, authorizationRevision: null },
				{ ...state, principalGrants: [{ ...grant, revokedAt: new Date(1) }] },
			]) {
				state = invalid;
				await expect(
					management.resolveAgentAccess(query, actor),
				).resolves.toEqual({ outcome: "denied" });
			}
			const { authorizationRevision: _revision, ...legacy } = current;
			state = { ...legacy, principalGrants: [grant] };
			await expect(
				management.resolveAgentAccess(query, actor),
			).resolves.toEqual({ outcome: "denied" });
		}
		state = { ...current, authorizationRevision: "new-agent-revision" };
		await expect(
			management.executeManagementCommand(
				{
					schemaVersion: 1,
					command: "stop_agent",
					agentId: state.agentId,
					expectedRevision: state.revision,
					idempotencyKey: "stale-grant-stop",
					requestId: "stale-grant-stop",
					traceId: "stale-grant-stop",
				},
				actor,
			),
		).resolves.toEqual({ outcome: "denied", writePlan: null });
		const {
			authorizationRevision: _revision,
			principalGrants: _grants,
			...legacy
		} = current;
		state = legacy;
		const { principal: _principal, ...browserActor } = actor;
		await expect(
			management.resolveAgentAccess(
				{
					schemaVersion: 1,
					agentId: state.agentId,
					intent: "manage",
				},
				browserActor,
			),
		).resolves.toMatchObject({ outcome: "allowed" });
		state = { ...current, authorizationRevision: "" };
		await expect(
			management.resolveAgentAccess(
				{ schemaVersion: 1, agentId: state.agentId, intent: "manage" },
				actor,
			),
		).rejects.toMatchObject({ code: "unavailable" });
	},
);

it("snapshots management plans without reading hostile accessors or Proxy traps", async () => {
	const state: AgentManagementStateV1 = {
		schemaVersion: 1,
		applicationId: "application_snapshot",
		agentId: "agent_snapshot",
		applicantId: "owner_snapshot",
		status: "pending_approval",
		revision: 1,
		approvalRevision: null,
		decisionReason: null,
		serviceAvailability: null,
		desiredState: "stopped",
		workloadRevision: 0,
		fence: 0,
		ownerIds: ["owner_snapshot"],
		availability: [],
		failureCode: null,
	};
	const decision = await new FakeAgentManagementV1({
		states: [state],
	}).executeManagementCommand(
		{
			schemaVersion: 1,
			command: "update_application",
			applicationId: state.applicationId,
			expectedRevision: state.revision,
			idempotencyKey: "snapshot-plan",
			requestId: "request_snapshot",
			traceId: "trace_snapshot",
		},
		{
			schemaVersion: 1,
			userId: state.applicantId,
			accountStatus: "active",
			organizationIds: [],
			isAdministrator: false,
		},
	);
	if (decision.outcome !== "accepted")
		throw new Error("Expected accepted plan");

	let getterReads = 0;
	const transition = Object.defineProperty(
		{ ...decision.writePlan.transition },
		"from",
		{
			enumerable: true,
			get() {
				getterReads += 1;
				return "pending_approval";
			},
		},
	);
	expect(() =>
		snapshotAgentManagementWritePlanV1({
			...decision.writePlan,
			transition,
		}),
	).toThrow(AgentManagementError);
	expect(getterReads).toBe(0);

	let trapCalls = 0;
	expect(() =>
		snapshotAgentManagementWritePlanV1(
			new Proxy(decision.writePlan, {
				ownKeys() {
					trapCalls += 1;
					throw new Error("sensitive trap");
				},
			}),
		),
	).toThrow(AgentManagementError);
	expect(trapCalls).toBe(0);
});
