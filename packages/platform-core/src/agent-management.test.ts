import { describe, expect, it } from "vitest";

import { agentManagementV1Conformance } from "./agent-management.conformance.ts";
import {
	AgentManagementError,
	type AgentManagementStateV1,
	createAgentManagementV1,
	isCurrentApiAgentManagementAuthorizedV1,
	snapshotAgentManagementWritePlanV1,
} from "./agent-management.ts";
import { FakeAgentManagementV1 } from "./fake-agent-management.ts";

describe("Fake Agent management Interface", () => {
	agentManagementV1Conformance(async (options) =>
		Promise.resolve(new FakeAgentManagementV1(options)),
	);
});

it("rejects changed credential and principal authority at management commit", () => {
	const current = {
		actorId: "api-user",
		apiAuthority: {
			credentialId: "credential-1",
			identityRevision: "identity-1",
			principal: { kind: "user" as const, id: "api-user" },
		},
		credential: {
			principalType: "user",
			principalId: "api-user",
			scopes: ["agent:manage"],
			expiresAt: new Date(2000),
			revokedAt: null,
		},
		nowMs: 1000,
		currentUser: {
			userId: "api-user",
			accountStatus: "active" as const,
			authorizationRevision: "identity-1",
		},
	};
	expect(isCurrentApiAgentManagementAuthorizedV1(current)).toBe(true);
	for (const changed of [
		{ actorId: "another-user" },
		{ credential: null },
		{ credential: { ...current.credential, scopes: ["agent:read"] } },
		{ credential: { ...current.credential, principalId: "another-user" } },
		{ credential: { ...current.credential, revokedAt: new Date(500) } },
		{ nowMs: 2000 },
		{ nowMs: Number.NaN },
		{ currentUser: null },
		{
			currentUser: {
				...current.currentUser,
				accountStatus: "disabled" as const,
			},
		},
		{
			currentUser: { ...current.currentUser, authorizationRevision: "changed" },
		},
	])
		expect(
			isCurrentApiAgentManagementAuthorizedV1({ ...current, ...changed }),
		).toBe(false);
	const application = {
		...current,
		actorId: "application-1",
		apiAuthority: {
			...current.apiAuthority,
			principal: { kind: "application" as const, id: "application-1" },
		},
		credential: {
			...current.credential,
			principalType: "application",
			principalId: "application-1",
		},
		currentApplication: {
			status: "active",
			authorizationRevision: "identity-1",
		},
	};
	expect(isCurrentApiAgentManagementAuthorizedV1(application)).toBe(true);
	for (const currentApplication of [
		null,
		{ status: "disabled", authorizationRevision: "identity-1" },
		{ status: "active", authorizationRevision: "changed" },
	])
		expect(
			isCurrentApiAgentManagementAuthorizedV1({
				...application,
				currentApplication,
			}),
		).toBe(false);
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

it("denies unsupported API lifecycle commands before opening a transaction", async () => {
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
	for (const command of ["retry_agent_creation", "disable_agent"] as const) {
		await expect(
			management.executeManagementCommand(
				{
					schemaVersion: 1,
					command,
					agentId: "agent-api",
					expectedRevision: 1,
					idempotencyKey: command,
					requestId: command,
					traceId: command,
				},
				{
					schemaVersion: 1,
					userId: "api-user",
					accountStatus: "active",
					organizationIds: [],
					isAdministrator: false,
					principal: { kind: "user", id: "api-user" },
					apiAuthority: {
						credentialId: "credential-api",
						identityRevision: "identity-1",
					},
				},
			),
		).resolves.toEqual({ outcome: "denied", writePlan: null });
	}
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
