import { describe, expect, it } from "vitest";

import {
	parseAgentConfigurationChangesV1,
	parseAvailabilityScope,
} from "./agent-configuration-input.ts";
import {
	type AgentManagementStateV1,
	isAgentAccessAllowedV1,
} from "./agent-management.ts";
import { decideAgentAccessUpdatePolicy } from "./agent-management-access-policy.ts";

const state: AgentManagementStateV1 = {
	schemaVersion: 1,
	applicationId: "application_01",
	agentId: "agent_01",
	applicantId: "owner_01",
	status: "available",
	revision: 3,
	approvalRevision: 1,
	decisionReason: null,
	serviceAvailability: "ready",
	desiredState: "running",
	workloadRevision: 1,
	fence: 1,
	ownerIds: ["owner_01"],
	availability: [{ kind: "application", applicationId: "shared_01" }],
	failureCode: null,
};
const owner = {
	schemaVersion: 1 as const,
	userId: "owner_01",
	accountStatus: "active" as const,
	organizationIds: [],
	isAdministrator: false,
};
const authority = {
	schemaVersion: 1 as const,
	users: [
		{ userId: "owner_01", accountStatus: "active" as const },
		{ userId: "shared_01", accountStatus: "active" as const },
	],
	organizationIds: ["shared_01"],
};

function decide(availability: AgentManagementStateV1["availability"]) {
	return decideAgentAccessUpdatePolicy(
		{
			schemaVersion: 1,
			agentId: "agent_01",
			expectedRevision: 3,
			desiredOwnerIds: ["owner_01"],
			desiredAvailability: availability,
			requestId: "request_01",
			traceId: "trace_01",
		},
		state,
		owner,
		authority,
	);
}

describe("Agent availability application entries (#4283)", () => {
	it("never admits the user or organization member with the same bare ID", () => {
		const member = {
			...owner,
			userId: "shared_01",
			organizationIds: ["shared_01"],
		};
		for (const intent of ["discover", "use", "manage"] as const) {
			expect(isAgentAccessAllowedV1(state, member, intent)).toBe(false);
		}
		expect(
			isAgentAccessAllowedV1(
				{
					...state,
					availability: [
						...state.availability,
						{ kind: "user", userId: "shared_01" },
					],
				},
				member,
				"discover",
			),
		).toBe(true);
	});

	it("keeps an existing application entry and fails closed on an unconfirmed new one", () => {
		expect(
			decide([
				{ kind: "application", applicationId: "shared_01" },
				{ kind: "user", userId: "shared_01" },
			]),
		).toMatchObject({
			outcome: "accepted",
			planFragment: {
				availability: [
					{ kind: "application", applicationId: "shared_01" },
					{ kind: "user", userId: "shared_01" },
				],
			},
		});
		expect(
			decide([
				{ kind: "application", applicationId: "shared_01" },
				{ kind: "application", applicationId: "application_new" },
			]),
		).toEqual({
			outcome: "conflict",
			reason: "invalid_target",
			planFragment: null,
		});
	});

	it("adds only Access-confirmed applications and keeps the people part apart (#4283)", () => {
		const added = [
			{ kind: "application" as const, applicationId: "application_new" },
			{ kind: "application" as const, applicationId: "shared_01" },
		];
		expect(
			decideAgentAccessUpdatePolicy(
				{
					schemaVersion: 1,
					agentId: "agent_01",
					expectedRevision: 3,
					desiredOwnerIds: ["owner_01"],
					desiredAvailability: added,
					requestId: "request_01",
					traceId: "trace_01",
				},
				state,
				owner,
				authority,
				["application_new"],
			),
		).toMatchObject({
			outcome: "accepted",
			planFragment: { availability: added },
		});
		// A user confirmation never stands in for an application with the same ID.
		expect(
			decideAgentAccessUpdatePolicy(
				{
					schemaVersion: 1,
					agentId: "agent_01",
					expectedRevision: 3,
					desiredOwnerIds: ["owner_01"],
					desiredAvailability: [
						{ kind: "application", applicationId: "owner_01" },
					],
					requestId: "request_01",
					traceId: "trace_01",
				},
				state,
				owner,
				authority,
			),
		).toEqual({
			outcome: "conflict",
			reason: "invalid_target",
			planFragment: null,
		});
		expect(
			parseAgentConfigurationChangesV1({
				applicationAvailability: ["b_app", "a_app"],
			}),
		).toEqual({ applicationAvailability: ["a_app", "b_app"] });
		for (const applicationAvailability of [["a_app", "a_app"], [""], [1]])
			expect(() =>
				parseAgentConfigurationChangesV1({ applicationAvailability }),
			).toThrow();
	});

	it("rejects application entries in current command versions and types the persisted scope", () => {
		expect(() =>
			parseAgentConfigurationChangesV1({
				availability: [{ kind: "application", applicationId: "shared_01" }],
			}),
		).toThrow();
		expect(() =>
			parseAgentConfigurationChangesV1({
				availability: [
					{ kind: "user", userId: "shared_01", applicationId: "shared_01" },
				],
			}),
		).toThrow();
		expect(
			parseAvailabilityScope([
				{ kind: "user", userId: "shared_01" },
				{ kind: "application", applicationId: "shared_01" },
				{ kind: "organization", organizationId: "shared_01" },
			]),
		).toEqual([
			{ kind: "application", applicationId: "shared_01" },
			{ kind: "organization", organizationId: "shared_01" },
			{ kind: "user", userId: "shared_01" },
		]);
		expect(() =>
			parseAvailabilityScope([
				{ kind: "application", organizationId: "shared_01" },
			]),
		).toThrow();
	});
});
