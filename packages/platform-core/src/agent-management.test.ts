import { describe, expect, it } from "vitest";

import { agentManagementV1Conformance } from "./agent-management.conformance.ts";
import {
	AgentManagementError,
	type AgentManagementStateV1,
	isAdministratorAgentReadAllowedV1,
	isAgentAccessAllowedV1,
	snapshotAgentManagementWritePlanV1,
} from "./agent-management.ts";
import { FakeAgentManagementV1 } from "./fake-agent-management.ts";

describe("Fake Agent management Interface", () => {
	agentManagementV1Conformance(async (options) =>
		Promise.resolve(new FakeAgentManagementV1(options)),
	);
});

it("keeps administrator listing separate from ordinary Agent access", () => {
	const administrator = {
		schemaVersion: 1 as const,
		userId: "administrator",
		accountStatus: "active" as const,
		organizationIds: [],
		isAdministrator: true,
	};
	expect(isAdministratorAgentReadAllowedV1(administrator)).toBe(true);
	expect(
		isAdministratorAgentReadAllowedV1({
			...administrator,
			accountStatus: "disabled",
		}),
	).toBe(false);
	expect(
		isAdministratorAgentReadAllowedV1({
			...administrator,
			isAdministrator: false,
		}),
	).toBe(false);
	const state: AgentManagementStateV1 = {
		schemaVersion: 1,
		applicationId: "other-application",
		agentId: "other-agent",
		applicantId: "other-owner",
		status: "available",
		revision: 2,
		approvalRevision: 1,
		decisionReason: null,
		serviceAvailability: "ready",
		desiredState: "running",
		workloadRevision: 1,
		fence: 1,
		ownerIds: ["other-owner"],
		availability: [],
		failureCode: null,
	};
	for (const intent of ["discover", "manage", "use"] as const) {
		expect(isAgentAccessAllowedV1(state, administrator, intent)).toBe(false);
	}
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
