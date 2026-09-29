import { describe, expect, it } from "vitest";

import { agentManagementV1Conformance } from "./agent-management.conformance.ts";
import {
	AgentManagementError,
	type AgentManagementStateV1,
	createAgentManagementV1,
	snapshotAgentManagementWritePlanV1,
} from "./agent-management.ts";
import { FakeAgentManagementV1 } from "./fake-agent-management.ts";

describe("Fake Agent management Interface", () => {
	agentManagementV1Conformance(async (options) =>
		Promise.resolve(new FakeAgentManagementV1(options)),
	);
});

it("denies an API-principal management command without credential authority", async () => {
	let transactions = 0;
	const management = createAgentManagementV1({
		async executeAgentManagementTransaction() {
			transactions += 1;
			return { outcome: "denied", writePlan: null };
		},
		async resolveAgentAccessState() {
			return undefined;
		},
	});
	expect(
		await management.executeManagementCommand(
			{
				schemaVersion: 1,
				command: "stop_agent",
				agentId: "agent-api",
				expectedRevision: 1,
				idempotencyKey: "missing-credential",
				requestId: "request-missing-credential",
				traceId: "trace-missing-credential",
			},
			{
				schemaVersion: 1,
				userId: "api-user",
				accountStatus: "active",
				organizationIds: [],
				isAdministrator: false,
				principal: { kind: "user", id: "api-user" },
			},
		),
	).toEqual({ outcome: "denied", writePlan: null });
	expect(transactions).toBe(0);
});

it("denies API principals from disabling an Agent", async () => {
	const principal = { kind: "user" as const, id: "api-user" };
	const state: AgentManagementStateV1 = {
		schemaVersion: 1,
		applicationId: "application_api_disable",
		agentId: "agent_api_disable",
		applicantId: "owner_api_disable",
		status: "available",
		revision: 1,
		approvalRevision: 1,
		decisionReason: null,
		serviceAvailability: "ready",
		desiredState: "running",
		workloadRevision: 1,
		fence: 1,
		ownerIds: ["owner_api_disable"],
		availability: [],
		failureCode: null,
		principalGrants: [
			{
				principal,
				grantType: "manage",
				authorizationRevision: "agent-auth-1",
				revokedAt: null,
			},
		],
	};
	const management = createAgentManagementV1({
		async executeAgentManagementTransaction(_request, decide) {
			return decide(state);
		},
		async resolveAgentAccessState() {
			return state;
		},
	});
	expect(
		await management.executeManagementCommand(
			{
				schemaVersion: 1,
				command: "disable_agent",
				agentId: state.agentId,
				expectedRevision: state.revision,
				idempotencyKey: "api-disable",
				requestId: "request-api-disable",
				traceId: "trace-api-disable",
			},
			{
				schemaVersion: 1,
				userId: principal.id,
				accountStatus: "active",
				organizationIds: [],
				isAdministrator: false,
				principal,
				apiAuthority: {
					credentialId: "credential-api-disable",
					identityRevision: "identity-1",
				},
			},
		),
	).toEqual({ outcome: "denied", writePlan: null });
});

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
