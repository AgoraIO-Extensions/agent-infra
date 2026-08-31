import { expect, it } from "vitest";

import type {
	AgentManagementInterfaceV1,
	AgentManagementOptionsV1,
	AgentManagementStateV1,
} from "./agent-management.ts";

export interface AgentManagementConformanceOptionsV1
	extends AgentManagementOptionsV1 {
	readonly states?: readonly AgentManagementStateV1[];
}

const applicant = {
	schemaVersion: 1 as const,
	userId: "user_applicant",
	accountStatus: "active" as const,
	organizationIds: ["org_platform"],
	isAdministrator: false,
};

const administrator = {
	...applicant,
	userId: "user_admin",
	isAdministrator: true,
};

export function agentManagementV1Conformance(
	createManagement: (
		options: AgentManagementConformanceOptionsV1,
	) => Promise<AgentManagementInterfaceV1>,
): void {
	it("lets the applicant update, resubmit, and withdraw one application history", async () => {
		const management = await createManagement({
			now: () => new Date("2026-08-31T08:00:00.000Z"),
			states: [
				{
					schemaVersion: 1,
					applicationId: "application_1",
					agentId: "agent_1",
					applicantId: applicant.userId,
					status: "rejected",
					revision: 3,
					decisionReason: "Resource request needs adjustment",
					serviceAvailability: null,
					desiredState: "stopped",
					workloadRevision: 0,
					fence: 0,
					ownerIds: [applicant.userId],
					availability: [],
					failureReason: null,
				},
			],
		});

		const resubmitted = await management.executeManagementCommand(
			{
				schemaVersion: 1,
				command: "update_application",
				applicationId: "application_1",
				expectedRevision: 3,
				idempotencyKey: "application-update-1",
				requestId: "request_1",
				traceId: "trace_1",
			},
			applicant,
		);

		expect(resubmitted).toMatchObject({
			outcome: "accepted",
			result: {
				status: "pending_approval",
				revision: 4,
			},
			writePlan: {
				transition: {
					from: "rejected",
					to: "pending_approval",
				},
				outboxIntent: null,
				auditEvent: {
					action: "agent.application.resubmitted",
					actorId: applicant.userId,
					traceId: "trace_1",
					requestId: "request_1",
				},
			},
		});
		const updated = await management.executeManagementCommand(
			{
				schemaVersion: 1,
				command: "update_application",
				applicationId: "application_1",
				expectedRevision: 4,
				idempotencyKey: "application-update-2",
				requestId: "request_update_2",
				traceId: "trace_update_2",
			},
			applicant,
		);
		expect(updated).toMatchObject({
			outcome: "accepted",
			result: { status: "pending_approval", revision: 5 },
			writePlan: {
				transition: {
					from: "pending_approval",
					to: "pending_approval",
				},
				auditEvent: { action: "agent.application.updated" },
			},
		});

		const withdrawn = await management.executeManagementCommand(
			{
				schemaVersion: 1,
				command: "withdraw_application",
				applicationId: "application_1",
				expectedRevision: 5,
				idempotencyKey: "application-withdraw-1",
				requestId: "request_2",
				traceId: "trace_2",
			},
			applicant,
		);

		expect(withdrawn).toMatchObject({
			outcome: "accepted",
			result: { status: "withdrawn", revision: 6 },
			writePlan: {
				transition: { from: "pending_approval", to: "withdrawn" },
				outboxIntent: null,
			},
		});
	});

	it("lets only an administrator approve or reject a pending application", async () => {
		const state = {
			schemaVersion: 1 as const,
			applicationId: "application_2",
			agentId: "agent_2",
			applicantId: applicant.userId,
			status: "pending_approval" as const,
			revision: 1,
			decisionReason: null,
			serviceAvailability: null,
			desiredState: "stopped" as const,
			workloadRevision: 0,
			fence: 0,
			ownerIds: [applicant.userId],
			availability: [],
			failureReason: null,
		};
		const denied = await createManagement({ states: [state] });
		expect(
			await denied.executeManagementCommand(
				{
					schemaVersion: 1,
					command: "approve_application",
					applicationId: state.applicationId,
					expectedRevision: 1,
					idempotencyKey: "approve-denied",
					requestId: "request_denied",
					traceId: "trace_denied",
				} as never,
				applicant,
			),
		).toEqual({ outcome: "denied", writePlan: null });

		const approved = await createManagement({
			now: () => new Date("2026-08-31T08:05:00.000Z"),
			states: [state],
		});
		expect(
			await approved.executeManagementCommand(
				{
					schemaVersion: 1,
					command: "approve_application",
					applicationId: state.applicationId,
					expectedRevision: 1,
					idempotencyKey: "approve-1",
					requestId: "request_approve",
					traceId: "trace_approve",
				} as never,
				administrator,
			),
		).toMatchObject({
			outcome: "accepted",
			result: { status: "creating", revision: 2 },
			writePlan: {
				state: {
					status: "creating",
					desiredState: "running",
					workloadRevision: 1,
					fence: 1,
				},
				outboxIntent: {
					operation: "agent.workload.reconcile.v1",
					payload: {
						agentId: state.agentId,
						revision: 2,
						workloadRevision: 1,
						fence: 1,
						desiredState: "running",
					},
				},
				auditEvent: { action: "agent.application.approved" },
			},
		});

		const rejected = await createManagement({ states: [state] });
		expect(
			await rejected.executeManagementCommand(
				{
					schemaVersion: 1,
					command: "reject_application",
					applicationId: state.applicationId,
					reason: "Capacity is unavailable",
					expectedRevision: 1,
					idempotencyKey: "reject-1",
					requestId: "request_reject",
					traceId: "trace_reject",
				} as never,
				administrator,
			),
		).toMatchObject({
			outcome: "accepted",
			result: { status: "rejected", revision: 2 },
			writePlan: {
				state: { decisionReason: "Capacity is unavailable" },
				outboxIntent: null,
				auditEvent: { action: "agent.application.rejected" },
			},
		});
	});

	it("applies Owner and administrator lifecycle authority", async () => {
		const availableState = {
			schemaVersion: 1 as const,
			applicationId: "application_3",
			agentId: "agent_3",
			applicantId: applicant.userId,
			status: "available" as const,
			revision: 7,
			decisionReason: null,
			serviceAvailability: "ready" as const,
			desiredState: "running" as const,
			workloadRevision: 4,
			fence: 9,
			ownerIds: [applicant.userId, "user_co_owner"],
			availability: [],
			failureReason: null,
		};
		const management = await createManagement({ states: [availableState] });
		expect(
			await management.executeManagementCommand(
				{
					schemaVersion: 1,
					command: "stop_agent",
					agentId: availableState.agentId,
					expectedRevision: 7,
					idempotencyKey: "stop-outsider",
					requestId: "request_stop_outsider",
					traceId: "trace_stop_outsider",
				},
				{ ...applicant, userId: "user_outsider" },
			),
		).toEqual({ outcome: "denied", writePlan: null });

		const stopped = await management.executeManagementCommand(
			{
				schemaVersion: 1,
				command: "stop_agent",
				agentId: availableState.agentId,
				expectedRevision: 7,
				idempotencyKey: "stop-1",
				requestId: "request_stop",
				traceId: "trace_stop",
			} as never,
			applicant,
		);
		expect(stopped).toMatchObject({
			outcome: "accepted",
			result: { status: "stopped", revision: 8 },
			writePlan: {
				state: {
					status: "stopped",
					serviceAvailability: null,
					desiredState: "stopped",
					workloadRevision: 5,
					fence: 10,
				},
				outboxIntent: {
					operation: "agent.workload.reconcile.v1",
					payload: { desiredState: "stopped" },
				},
				auditEvent: { action: "agent.lifecycle.stopped" },
			},
		});

		const restarted = await management.executeManagementCommand(
			{
				schemaVersion: 1,
				command: "restart_agent",
				agentId: availableState.agentId,
				expectedRevision: 8,
				idempotencyKey: "restart-1",
				requestId: "request_restart",
				traceId: "trace_restart",
			} as never,
			{ ...applicant, userId: "user_co_owner" },
		);
		expect(restarted).toMatchObject({
			outcome: "accepted",
			result: { status: "available", revision: 9 },
			writePlan: {
				state: {
					status: "available",
					serviceAvailability: "starting",
					desiredState: "running",
				},
				auditEvent: { action: "agent.lifecycle.restarted" },
			},
		});

		const failedState = {
			...availableState,
			agentId: "agent_failed",
			applicationId: "application_failed",
			status: "creation_failed" as const,
			serviceAvailability: null,
			failureReason: "Agent did not become ready",
		};
		const failed = await createManagement({ states: [failedState] });
		expect(
			await failed.executeManagementCommand(
				{
					schemaVersion: 1,
					command: "retry_agent_creation",
					agentId: failedState.agentId,
					expectedRevision: 7,
					idempotencyKey: "retry-1",
					requestId: "request_retry",
					traceId: "trace_retry",
				} as never,
				administrator,
			),
		).toMatchObject({
			outcome: "accepted",
			result: { status: "creating" },
			writePlan: {
				state: {
					status: "creating",
					failureReason: "Agent did not become ready",
				},
				auditEvent: { action: "agent.lifecycle.creation_retried" },
			},
		});

		const disabled = await createManagement({ states: [availableState] });
		expect(
			await disabled.executeManagementCommand(
				{
					schemaVersion: 1,
					command: "disable_agent",
					agentId: availableState.agentId,
					expectedRevision: 7,
					idempotencyKey: "disable-1",
					requestId: "request_disable",
					traceId: "trace_disable",
				} as never,
				administrator,
			),
		).toMatchObject({
			outcome: "accepted",
			result: { status: "disabled" },
			writePlan: {
				state: {
					status: "disabled",
					serviceAvailability: null,
					desiredState: "stopped",
				},
				auditEvent: { action: "agent.lifecycle.disabled" },
			},
		});
	});

	it("accepts only current fenced Worker observations and replays duplicates", async () => {
		const creatingState = {
			schemaVersion: 1 as const,
			applicationId: "application_creating",
			agentId: "agent_creating",
			applicantId: applicant.userId,
			status: "creating" as const,
			revision: 4,
			decisionReason: null,
			serviceAvailability: null,
			desiredState: "running" as const,
			workloadRevision: 2,
			fence: 5,
			ownerIds: [applicant.userId],
			availability: [],
			failureReason: "Previous attempt timed out",
		};
		const management = await createManagement({
			now: () => new Date("2026-08-31T08:10:00.000Z"),
			states: [creatingState],
		});
		const observation = {
			schemaVersion: 1 as const,
			observationId: "observation_1",
			agentId: creatingState.agentId,
			observation: "creation_succeeded" as const,
			expectedRevision: 4,
			workloadRevision: 2,
			fence: 5,
			requestId: "request_observe",
			traceId: "trace_observe",
		};
		expect(
			await management.recordWorkloadObservation({
				...observation,
				observationId: "observation_stale_fence",
				fence: 4,
			}),
		).toEqual({
			outcome: "conflict",
			reason: "stale_observation",
			writePlan: null,
		});

		expect(
			await management.recordWorkloadObservation(observation as never),
		).toMatchObject({
			outcome: "accepted",
			result: { status: "available", revision: 5 },
			writePlan: {
				operation: "observe_creation_succeeded",
				state: {
					status: "available",
					serviceAvailability: "ready",
					failureReason: null,
				},
				outboxIntent: null,
				auditEvent: {
					action: "agent.workload.creation_succeeded",
					actorId: "platform_worker",
				},
			},
		});
		expect(
			await management.recordWorkloadObservation(observation as never),
		).toMatchObject({
			outcome: "replayed",
			result: { status: "available", revision: 5 },
			writePlan: null,
		});

		expect(
			await management.recordWorkloadObservation({
				...observation,
				observationId: "observation_stale",
				observation: "creation_failed",
				reason: "A late failed attempt",
			} as never),
		).toEqual({
			outcome: "conflict",
			reason: "stale_observation",
			writePlan: null,
		});
	});

	it("maps every current Worker result without mixing service and management status", async () => {
		const base = {
			schemaVersion: 1 as const,
			applicantId: applicant.userId,
			revision: 10,
			decisionReason: null,
			desiredState: "running" as const,
			workloadRevision: 6,
			fence: 8,
			ownerIds: [applicant.userId],
			availability: [],
		};
		const states = [
			{
				...base,
				applicationId: "application_failure",
				agentId: "agent_failure",
				status: "creating" as const,
				serviceAvailability: null,
				failureReason: null,
			},
			...[
				"service_starting",
				"service_ready",
				"service_updating",
				"service_unavailable",
			].map((observation) => ({
				...base,
				applicationId: `application_${observation}`,
				agentId: `agent_${observation}`,
				status: "available" as const,
				serviceAvailability: "unavailable" as const,
				failureReason: "Earlier failure",
			})),
			{
				...base,
				applicationId: "application_unapproved",
				agentId: "agent_unapproved",
				status: "pending_approval" as const,
				serviceAvailability: null,
				desiredState: "stopped" as const,
				workloadRevision: 0,
				fence: 0,
				failureReason: null,
			},
		];
		const management = await createManagement({ states });
		const correlation = {
			schemaVersion: 1 as const,
			expectedRevision: 10,
			workloadRevision: 6,
			fence: 8,
			requestId: "request_worker_result",
			traceId: "trace_worker_result",
		};
		expect(
			await management.recordWorkloadObservation({
				...correlation,
				observationId: "observation_failure",
				agentId: "agent_failure",
				observation: "creation_failed",
				reason: "Agent did not become ready",
			}),
		).toMatchObject({
			outcome: "accepted",
			result: { status: "creation_failed", revision: 11 },
			writePlan: {
				state: {
					status: "creation_failed",
					serviceAvailability: null,
					failureReason: "Agent did not become ready",
				},
			},
		});

		for (const expected of [
			{
				observation: "service_starting" as const,
				availability: "starting",
				failureReason: "Earlier failure",
			},
			{
				observation: "service_ready" as const,
				availability: "ready",
				failureReason: null,
			},
			{
				observation: "service_updating" as const,
				availability: "updating",
				failureReason: "Earlier failure",
			},
		]) {
			expect(
				await management.recordWorkloadObservation({
					...correlation,
					observationId: `observation_${expected.observation}`,
					agentId: `agent_${expected.observation}`,
					observation: expected.observation,
				}),
			).toMatchObject({
				outcome: "accepted",
				result: { status: "available" },
				writePlan: {
					state: {
						status: "available",
						serviceAvailability: expected.availability,
						failureReason: expected.failureReason,
					},
				},
			});
		}
		expect(
			await management.recordWorkloadObservation({
				...correlation,
				observationId: "observation_service_unavailable",
				agentId: "agent_service_unavailable",
				observation: "service_unavailable",
				reason: "Health check failed",
			}),
		).toMatchObject({
			outcome: "accepted",
			result: { status: "available" },
			writePlan: {
				state: {
					status: "available",
					serviceAvailability: "unavailable",
					failureReason: "Health check failed",
				},
			},
		});
		expect(
			await management.recordWorkloadObservation({
				...correlation,
				observationId: "observation_unapproved",
				agentId: "agent_unapproved",
				observation: "creation_succeeded",
				expectedRevision: 10,
				workloadRevision: 0,
				fence: 0,
			}),
		).toEqual({
			outcome: "conflict",
			reason: "invalid_observation",
			writePlan: null,
		});
	});

	it("resolves current Owner, direct-user, organization, and account availability", async () => {
		const state = {
			schemaVersion: 1 as const,
			applicationId: "application_access",
			agentId: "agent_access",
			applicantId: applicant.userId,
			status: "available" as const,
			revision: 6,
			decisionReason: null,
			serviceAvailability: "starting" as const,
			desiredState: "running" as const,
			workloadRevision: 3,
			fence: 4,
			ownerIds: [applicant.userId, "user_co_owner"],
			availability: [
				{ kind: "user" as const, userId: "user_direct" },
				{ kind: "organization" as const, organizationId: "org_platform" },
			],
			failureReason: null,
		};
		const management = await createManagement({ states: [state] });
		const useQuery = {
			schemaVersion: 1 as const,
			agentId: state.agentId,
			intent: "use" as const,
		};

		for (const actor of [
			{ ...applicant, userId: "user_direct", organizationIds: [] },
			{ ...applicant, userId: "user_org", organizationIds: ["org_platform"] },
			{ ...applicant, userId: "user_co_owner", organizationIds: [] },
		]) {
			expect(await management.resolveAgentAccess(useQuery, actor)).toEqual({
				outcome: "allowed",
				managementStatus: "available",
				serviceAvailability: "starting",
				serviceReady: false,
			});
		}

		const denial = { outcome: "denied" };
		expect(
			await management.resolveAgentAccess(useQuery, {
				...applicant,
				userId: "user_org",
				organizationIds: ["org_transferred"],
			}),
		).toEqual(denial);
		expect(
			await management.resolveAgentAccess(useQuery, {
				...applicant,
				userId: applicant.userId,
				accountStatus: "disabled",
				organizationIds: [],
			}),
		).toEqual(denial);
		expect(
			await management.resolveAgentAccess(
				{ ...useQuery, agentId: "agent_missing" },
				{ ...applicant, userId: "user_unknown", organizationIds: [] },
			),
		).toEqual(denial);

		expect(
			await management.resolveAgentAccess(
				{ ...useQuery, intent: "manage" },
				administrator,
			),
		).toMatchObject({ outcome: "allowed", serviceReady: false });
		expect(
			await management.resolveAgentAccess(
				{ ...useQuery, intent: "manage" },
				{ ...applicant, userId: "user_direct", organizationIds: [] },
			),
		).toEqual(denial);
	});

	it("rejects caller authority, malformed input, stale revisions, and changed replays", async () => {
		const state = {
			schemaVersion: 1 as const,
			applicationId: "application_negative",
			agentId: "agent_negative",
			applicantId: applicant.userId,
			status: "pending_approval" as const,
			revision: 2,
			decisionReason: null,
			serviceAvailability: null,
			desiredState: "stopped" as const,
			workloadRevision: 0,
			fence: 0,
			ownerIds: [applicant.userId],
			availability: [],
			failureReason: null,
		};
		const management = await createManagement({ states: [state] });
		const update = {
			schemaVersion: 1 as const,
			command: "update_application" as const,
			applicationId: state.applicationId,
			expectedRevision: 2,
			idempotencyKey: "negative-update",
			requestId: "request_negative",
			traceId: "trace_negative",
		};

		await expect(
			management.executeManagementCommand(
				{ ...update, actorId: applicant.userId } as never,
				{ ...applicant, userId: "user_attacker" },
			),
		).rejects.toMatchObject({
			name: "AgentManagementError",
			code: "invalid_input",
		});
		const inaccessible = { outcome: "denied", writePlan: null };
		expect(
			await management.executeManagementCommand(update, {
				...applicant,
				userId: "user_other",
			}),
		).toEqual(inaccessible);
		expect(
			await management.executeManagementCommand(
				{ ...update, applicationId: "application_missing" },
				applicant,
			),
		).toEqual(inaccessible);
		expect(
			await management.executeManagementCommand(
				{ ...update, expectedRevision: 1 },
				applicant,
			),
		).toEqual({
			outcome: "conflict",
			reason: "stale_revision",
			writePlan: null,
		});

		expect(
			await management.executeManagementCommand(update, applicant),
		).toMatchObject({
			outcome: "accepted",
			writePlan: { state: { revision: 3 } },
		});
		expect(
			await management.executeManagementCommand(update, applicant),
		).toMatchObject({
			outcome: "replayed",
			result: { revision: 3 },
			writePlan: null,
		});
		expect(
			await management.executeManagementCommand(
				{ ...update, requestId: "changed_request" },
				applicant,
			),
		).toEqual({
			outcome: "conflict",
			reason: "idempotency_conflict",
			writePlan: null,
		});

		await expect(
			management.executeManagementCommand(
				{
					schemaVersion: 1,
					command: "reject_application",
					applicationId: state.applicationId,
					reason: "",
					expectedRevision: 3,
					idempotencyKey: "empty-reason",
					requestId: "request_reject_empty",
					traceId: "trace_reject_empty",
				},
				administrator,
			),
		).rejects.toMatchObject({ code: "invalid_input" });
	});
}
