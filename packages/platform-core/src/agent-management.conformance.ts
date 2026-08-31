import { expect, it } from "vitest";
import type {
	AgentManagementCommandV1,
	AgentManagementInterfaceV1,
	AgentManagementOptionsV1,
	AgentManagementStateV1,
} from "./agent-management.ts";
import { decideAgentAccessUpdatePolicy } from "./agent-management-access-policy.ts";

export interface AgentManagementConformanceOptionsV1
	extends AgentManagementOptionsV1 {
	readonly states?: readonly AgentManagementStateV1[];
	readonly failure?: "transaction" | "access_read";
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

function stateFixture(
	overrides: Partial<AgentManagementStateV1> = {},
): AgentManagementStateV1 {
	const status = overrides.status ?? "available";
	const preApproval =
		status === "pending_approval" ||
		status === "rejected" ||
		status === "withdrawn";
	const stopped = status === "stopped" || status === "disabled" || preApproval;
	return {
		schemaVersion: 1,
		applicationId: "application_fixture",
		agentId: "agent_fixture",
		applicantId: applicant.userId,
		status,
		revision: 1,
		approvalRevision: preApproval ? null : 1,
		decisionReason: status === "rejected" ? "Capacity is unavailable" : null,
		serviceAvailability: status === "available" ? "ready" : null,
		desiredState: stopped ? "stopped" : "running",
		workloadRevision: preApproval ? 0 : 1,
		fence: preApproval ? 0 : 1,
		ownerIds: [applicant.userId],
		availability: [],
		failureCode: status === "creation_failed" ? "creation_not_ready" : null,
		...overrides,
	};
}

export function agentManagementV1Conformance(
	createManagement: (
		options: AgentManagementConformanceOptionsV1,
	) => Promise<AgentManagementInterfaceV1>,
): void {
	it("maps transaction, read, and clock failures to one stable unavailable error", async () => {
		const pendingState = stateFixture({
			applicationId: "application_failure_boundary",
			agentId: "agent_failure_boundary",
			status: "pending_approval",
		});
		const creatingState = stateFixture({
			applicationId: "application_observation_failure_boundary",
			agentId: "agent_observation_failure_boundary",
			status: "creating",
			revision: 2,
		});
		const command = {
			schemaVersion: 1 as const,
			command: "update_application" as const,
			applicationId: pendingState.applicationId,
			expectedRevision: 1,
			idempotencyKey: "boundary-command",
			requestId: "request_boundary_command",
			traceId: "trace_boundary_command",
		};
		const observation = {
			schemaVersion: 1 as const,
			observationId: "boundary-observation",
			agentId: creatingState.agentId,
			observation: "creation_succeeded" as const,
			expectedRevision: 2,
			workloadRevision: 1,
			fence: 1,
			requestId: "request_boundary_observation",
			traceId: "trace_boundary_observation",
		};
		const expectUnavailable = (promise: Promise<unknown>) =>
			expect(promise).rejects.toMatchObject({
				name: "AgentManagementError",
				code: "unavailable",
				message: "Agent management is temporarily unavailable",
			});

		await expectUnavailable(
			(
				await createManagement({
					states: [pendingState],
					failure: "transaction",
				})
			).executeManagementCommand(command, applicant),
		);
		await expectUnavailable(
			(
				await createManagement({
					states: [creatingState],
					failure: "transaction",
				})
			).recordWorkloadObservation(observation),
		);
		await expectUnavailable(
			(
				await createManagement({
					states: [
						stateFixture({
							applicationId: creatingState.applicationId,
							agentId: creatingState.agentId,
							status: "available",
						}),
					],
					failure: "access_read",
				})
			).resolveAgentAccess(
				{ schemaVersion: 1, agentId: creatingState.agentId, intent: "use" },
				applicant,
			),
		);
		for (const invoke of [
			async () =>
				(
					await createManagement({
						states: [pendingState],
						now: () => {
							throw new Error("clock failed");
						},
					})
				).executeManagementCommand(command, applicant),
			async () =>
				(
					await createManagement({
						states: [creatingState],
						now: () => new Date(Number.NaN),
					})
				).recordWorkloadObservation(observation),
		]) {
			await expectUnavailable(invoke());
		}
		await expectUnavailable(
			Promise.resolve().then(() =>
				decideAgentAccessUpdatePolicy(
					{
						schemaVersion: 1,
						agentId: pendingState.agentId,
						expectedRevision: pendingState.revision,
						desiredOwnerIds: [applicant.userId],
						desiredAvailability: [],
						requestId: "request_boundary_access",
						traceId: "trace_boundary_access",
					},
					pendingState,
					applicant,
					{} as never,
				),
			),
		);
	});

	it("fails closed when the Agent-management Port returns an impossible state", async () => {
		const valid = stateFixture({
			applicationId: "application_invalid_state",
			agentId: "agent_invalid_state",
			status: "available",
			revision: 4,
			workloadRevision: 2,
			fence: 3,
			availability: [{ kind: "organization", organizationId: "org_platform" }],
		});
		const invalidStates: readonly AgentManagementStateV1[] = [
			{
				...valid,
				status: "pending_approval",
				serviceAvailability: null,
				desiredState: "running",
				workloadRevision: 0,
				fence: 0,
			},
			{ ...valid, serviceAvailability: null },
			{
				...valid,
				status: "stopped",
				serviceAvailability: null,
				desiredState: "running",
			},
			{ ...valid, ownerIds: [] },
			{ ...valid, ownerIds: [applicant.userId, applicant.userId] },
			{
				...valid,
				availability: [
					{ kind: "organization", organizationId: "org_platform" },
					{ kind: "organization", organizationId: "org_platform" },
				],
			},
			{ ...valid, revision: -1 },
			{ ...valid, fence: -1 },
			stateFixture({ status: "creation_failed", failureCode: null }),
			stateFixture({
				status: "available",
				serviceAvailability: "unavailable",
				failureCode: null,
			}),
			stateFixture({
				status: "available",
				serviceAvailability: "ready",
				failureCode: "workload_unavailable",
			}),
			stateFixture({ status: "pending_approval", approvalRevision: 1 }),
			stateFixture({
				status: "pending_approval",
				workloadRevision: 1,
				fence: 1,
			}),
			stateFixture({
				status: "pending_approval",
				failureCode: "reconciliation_failed",
			}),
			stateFixture({ status: "available", approvalRevision: null }),
			stateFixture({ status: "available", workloadRevision: 0 }),
			stateFixture({ status: "available", fence: 0 }),
			stateFixture({ revision: 2, approvalRevision: 3 }),
		];
		for (const [index, invalid] of invalidStates.entries()) {
			const management = await createManagement({
				states: [
					{
						...invalid,
						applicationId: `${invalid.applicationId}_${index}`,
						agentId: `${invalid.agentId}_${index}`,
					},
				],
			});
			await expect(
				management.resolveAgentAccess(
					{
						schemaVersion: 1,
						agentId: `${invalid.agentId}_${index}`,
						intent: "use",
					},
					applicant,
				),
			).rejects.toMatchObject({ code: "unavailable" });
		}

		const invalidCommandState = {
			...valid,
			status: "pending_approval" as const,
			serviceAvailability: null,
			desiredState: "running" as const,
			workloadRevision: 0,
			fence: 0,
		};
		await expect(
			(
				await createManagement({ states: [invalidCommandState] })
			).executeManagementCommand(
				{
					schemaVersion: 1,
					command: "update_application",
					applicationId: invalidCommandState.applicationId,
					expectedRevision: invalidCommandState.revision,
					idempotencyKey: "invalid-state-command",
					requestId: "request_invalid_state_command",
					traceId: "trace_invalid_state_command",
				},
				applicant,
			),
		).rejects.toMatchObject({ code: "unavailable" });
		await expect(
			(
				await createManagement({
					states: [
						{
							...valid,
							status: "creating",
							serviceAvailability: null,
							ownerIds: [],
						},
					],
				})
			).recordWorkloadObservation({
				schemaVersion: 1,
				observationId: "invalid-state-observation",
				agentId: valid.agentId,
				observation: "creation_succeeded",
				expectedRevision: valid.revision,
				workloadRevision: valid.workloadRevision,
				fence: valid.fence,
				requestId: "request_invalid_state_observation",
				traceId: "trace_invalid_state_observation",
			}),
		).rejects.toMatchObject({ code: "unavailable" });
	});
	it("lets the applicant update, resubmit, and withdraw one application history", async () => {
		const management = await createManagement({
			now: () => new Date("2026-08-31T08:00:00.000Z"),
			states: [
				stateFixture({
					applicationId: "application_1",
					agentId: "agent_1",
					status: "rejected",
					revision: 3,
					decisionReason: "Resource request needs adjustment",
				}),
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
		const state = stateFixture({
			applicationId: "application_2",
			agentId: "agent_2",
			status: "pending_approval",
		});
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
				},
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
				},
				administrator,
			),
		).toMatchObject({
			outcome: "accepted",
			result: { status: "creating", revision: 2 },
			writePlan: {
				state: {
					status: "creating",
					approvalRevision: 2,
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
				},
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

	it("never emits an unsafe aggregate, workload, or fence counter", async () => {
		for (const state of [
			stateFixture({
				status: "pending_approval",
				revision: Number.MAX_SAFE_INTEGER,
			}),
			stateFixture({
				status: "available",
				workloadRevision: Number.MAX_SAFE_INTEGER,
			}),
			stateFixture({
				status: "available",
				fence: Number.MAX_SAFE_INTEGER,
			}),
		]) {
			const management = await createManagement({
				states: [
					{
						...state,
						applicationId: `application_overflow_${state.status}_${state.workloadRevision}_${state.fence}`,
						agentId: `agent_overflow_${state.status}_${state.workloadRevision}_${state.fence}`,
					},
				],
			});
			const seeded = {
				...state,
				applicationId: `application_overflow_${state.status}_${state.workloadRevision}_${state.fence}`,
				agentId: `agent_overflow_${state.status}_${state.workloadRevision}_${state.fence}`,
			};
			const decision = await management.executeManagementCommand(
				state.status === "pending_approval"
					? {
							schemaVersion: 1,
							command: "update_application",
							applicationId: seeded.applicationId,
							expectedRevision: seeded.revision,
							idempotencyKey: `overflow-${seeded.agentId}`,
							requestId: `request_${seeded.agentId}`,
							traceId: `trace_${seeded.agentId}`,
						}
					: {
							schemaVersion: 1,
							command: "stop_agent",
							agentId: seeded.agentId,
							expectedRevision: seeded.revision,
							idempotencyKey: `overflow-${seeded.agentId}`,
							requestId: `request_${seeded.agentId}`,
							traceId: `trace_${seeded.agentId}`,
						},
				applicant,
			);
			expect(decision).toEqual({
				outcome: "conflict",
				reason: "counter_overflow",
				writePlan: null,
			});
		}

		const observationState = stateFixture({
			status: "available",
			revision: Number.MAX_SAFE_INTEGER,
		});
		const observationManagement = await createManagement({
			states: [observationState],
		});
		expect(
			await observationManagement.recordWorkloadObservation({
				schemaVersion: 1,
				observationId: "observation_overflow",
				agentId: observationState.agentId,
				observation: "service_ready",
				expectedRevision: observationState.revision,
				workloadRevision: observationState.workloadRevision,
				fence: observationState.fence,
				requestId: "request_observation_overflow",
				traceId: "trace_observation_overflow",
			}),
		).toEqual({
			outcome: "conflict",
			reason: "counter_overflow",
			writePlan: null,
		});
	});

	it("applies Owner and administrator lifecycle authority", async () => {
		const availableState = stateFixture({
			applicationId: "application_3",
			agentId: "agent_3",
			status: "available",
			revision: 7,
			workloadRevision: 4,
			fence: 9,
			ownerIds: [applicant.userId, "user_co_owner"],
		});
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
			},
			applicant,
		);
		expect(stopped).toMatchObject({
			outcome: "accepted",
			result: { status: "stopped", revision: 8 },
			writePlan: {
				state: {
					status: "stopped",
					approvalRevision: 1,
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
			},
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

		const failedState = stateFixture({
			agentId: "agent_failed",
			applicationId: "application_failed",
			status: "creation_failed",
			revision: 7,
			workloadRevision: 4,
			fence: 9,
			ownerIds: [applicant.userId, "user_co_owner"],
		});
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
				},
				administrator,
			),
		).toMatchObject({
			outcome: "accepted",
			result: { status: "creating" },
			writePlan: {
				state: {
					status: "creating",
					failureCode: "creation_not_ready",
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
				},
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

	it("covers every management command and status pair without rejected side effects", async () => {
		const statuses = [
			"pending_approval",
			"withdrawn",
			"rejected",
			"creating",
			"available",
			"stopped",
			"creation_failed",
			"disabled",
		] as const;
		const commands = [
			"update_application",
			"withdraw_application",
			"approve_application",
			"reject_application",
			"stop_agent",
			"restart_agent",
			"retry_agent_creation",
			"disable_agent",
		] as const;
		const allowed = {
			update_application: ["pending_approval", "rejected"],
			withdraw_application: ["pending_approval"],
			approve_application: ["pending_approval"],
			reject_application: ["pending_approval"],
			stop_agent: ["available"],
			restart_agent: ["available", "stopped"],
			retry_agent_creation: ["creation_failed"],
			disable_agent: ["creating", "available", "stopped", "creation_failed"],
		} as const;
		const commandFor = (
			command: (typeof commands)[number],
			state: AgentManagementStateV1,
		): AgentManagementCommandV1 => {
			const correlation = {
				schemaVersion: 1 as const,
				expectedRevision: state.revision,
				idempotencyKey: `matrix-${command}-${state.status}`,
				requestId: `request_${command}_${state.status}`,
				traceId: `trace_${command}_${state.status}`,
			};
			switch (command) {
				case "update_application":
				case "withdraw_application":
				case "approve_application":
					return {
						...correlation,
						command,
						applicationId: state.applicationId,
					};
				case "reject_application":
					return {
						...correlation,
						command,
						applicationId: state.applicationId,
						reason: "Capacity is unavailable",
					};
				default:
					return { ...correlation, command, agentId: state.agentId };
			}
		};
		for (const command of commands) {
			for (const status of statuses) {
				const state = stateFixture({
					status,
					applicationId: `application_${command}_${status}`,
					agentId: `agent_${command}_${status}`,
				});
				const management = await createManagement({ states: [state] });
				const actor =
					command === "approve_application" ||
					command === "reject_application" ||
					command === "disable_agent"
						? administrator
						: applicant;
				const decision = await management.executeManagementCommand(
					commandFor(command, state),
					actor,
				);
				if ((allowed[command] as readonly string[]).includes(status)) {
					expect(decision).toMatchObject({ outcome: "accepted" });
				} else {
					expect(decision).toEqual({
						outcome: "conflict",
						reason: "invalid_transition",
						writePlan: null,
					});
					expect(
						await management.resolveAgentAccess(
							{ schemaVersion: 1, agentId: state.agentId, intent: "manage" },
							applicant,
						),
					).toMatchObject({
						outcome: "allowed",
						managementStatus: status,
					});
				}
			}
		}

		for (const command of commands) {
			const status = allowed[command][0];
			const state = stateFixture({
				status,
				applicationId: `application_disabled_${command}`,
				agentId: `agent_disabled_${command}`,
			});
			const management = await createManagement({ states: [state] });
			expect(
				await management.executeManagementCommand(commandFor(command, state), {
					...(command === "approve_application" ||
					command === "reject_application" ||
					command === "disable_agent"
						? administrator
						: applicant),
					accountStatus: "disabled",
				}),
			).toEqual({ outcome: "denied", writePlan: null });
			expect(
				await management.resolveAgentAccess(
					{ schemaVersion: 1, agentId: state.agentId, intent: "manage" },
					applicant,
				),
			).toMatchObject({
				outcome: "allowed",
				managementStatus: status,
			});
		}
		for (const command of ["stop_agent", "restart_agent"] as const) {
			const state = stateFixture({
				status: command === "stop_agent" ? "available" : "stopped",
				applicationId: `application_admin_prohibited_${command}`,
				agentId: `agent_admin_prohibited_${command}`,
			});
			const management = await createManagement({ states: [state] });
			expect(
				await management.executeManagementCommand(commandFor(command, state), {
					...administrator,
					organizationIds: [],
				}),
			).toEqual({ outcome: "denied", writePlan: null });
		}
	});

	it("accepts only current fenced Worker observations and replays duplicates", async () => {
		const creatingState = stateFixture({
			applicationId: "application_creating",
			agentId: "agent_creating",
			status: "creating",
			revision: 4,
			workloadRevision: 2,
			fence: 5,
			failureCode: "reconciliation_failed",
		});
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
		for (const stale of [
			{
				observationId: "observation_stale_revision",
				expectedRevision: 3,
			},
			{
				observationId: "observation_stale_workload_revision",
				workloadRevision: 1,
			},
		]) {
			expect(
				await management.recordWorkloadObservation({
					...observation,
					...stale,
				}),
			).toEqual({
				outcome: "conflict",
				reason: "stale_observation",
				writePlan: null,
			});
		}
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
			await management.recordWorkloadObservation(observation),
		).toMatchObject({
			outcome: "accepted",
			result: { status: "available", revision: 5 },
			writePlan: {
				operation: "observe_creation_succeeded",
				state: {
					status: "available",
					approvalRevision: 1,
					serviceAvailability: "ready",
					failureCode: null,
				},
				outboxIntent: null,
				auditEvent: {
					action: "agent.workload.creation_succeeded",
					actorId: "platform_worker",
				},
			},
		});
		expect(
			await management.recordWorkloadObservation(observation),
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
				failureCode: "creation_not_ready",
			}),
		).toEqual({
			outcome: "conflict",
			reason: "stale_observation",
			writePlan: null,
		});
	});

	it("maps every current Worker result without mixing service and management status", async () => {
		const base = {
			revision: 10,
			workloadRevision: 6,
			fence: 8,
		};
		const states = [
			stateFixture({
				...base,
				applicationId: "application_failure",
				agentId: "agent_failure",
				status: "creating",
			}),
			...[
				"service_starting",
				"service_ready",
				"service_updating",
				"service_unavailable",
			].map((observation) =>
				stateFixture({
					...base,
					applicationId: `application_${observation}`,
					agentId: `agent_${observation}`,
					status: "available",
					serviceAvailability: "unavailable",
					failureCode: "workload_unavailable",
				}),
			),
			stateFixture({
				...base,
				applicationId: "application_unapproved",
				agentId: "agent_unapproved",
				status: "pending_approval",
				workloadRevision: 0,
				fence: 0,
			}),
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
		await expect(
			management.recordWorkloadObservation({
				...correlation,
				observationId: "observation_free_text_failure",
				agentId: "agent_failure",
				observation: "creation_failed",
				failureCode: "creation_not_ready",
				reason: "Pod agent-0 exposed a Runtime Secret",
			} as never),
		).rejects.toMatchObject({ code: "invalid_input" });
		expect(
			await management.recordWorkloadObservation({
				...correlation,
				observationId: "observation_failure",
				agentId: "agent_failure",
				observation: "creation_failed",
				failureCode: "creation_not_ready",
			}),
		).toMatchObject({
			outcome: "accepted",
			result: { status: "creation_failed", revision: 11 },
			writePlan: {
				state: {
					status: "creation_failed",
					serviceAvailability: null,
					failureCode: "creation_not_ready",
				},
			},
		});

		for (const expected of [
			{
				observation: "service_starting" as const,
				availability: "starting",
				failureCode: "workload_unavailable",
			},
			{
				observation: "service_ready" as const,
				availability: "ready",
				failureCode: null,
			},
			{
				observation: "service_updating" as const,
				availability: "updating",
				failureCode: "workload_unavailable",
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
						failureCode: expected.failureCode,
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
				failureCode: "health_check_failed",
			}),
		).toMatchObject({
			outcome: "accepted",
			result: { status: "available" },
			writePlan: {
				state: {
					status: "available",
					serviceAvailability: "unavailable",
					failureCode: "health_check_failed",
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

	it("rejects every service observation outside the available management state", async () => {
		const statuses = [
			"pending_approval",
			"withdrawn",
			"rejected",
			"creating",
			"stopped",
			"creation_failed",
			"disabled",
		] as const;
		const states = statuses.map((status) =>
			stateFixture({
				status,
				applicationId: `application_service_observation_${status}`,
				agentId: `agent_service_observation_${status}`,
			}),
		);
		const management = await createManagement({ states });
		for (const state of states) {
			for (const observation of [
				"service_starting",
				"service_ready",
				"service_updating",
				"service_unavailable",
			] as const) {
				const correlation = {
					schemaVersion: 1 as const,
					observationId: `${observation}_${state.status}`,
					agentId: state.agentId,
					expectedRevision: state.revision,
					workloadRevision: state.workloadRevision,
					fence: state.fence,
					requestId: `request_${observation}_${state.status}`,
					traceId: `trace_${observation}_${state.status}`,
				};
				const decision =
					observation === "service_unavailable"
						? await management.recordWorkloadObservation({
								...correlation,
								observation,
								failureCode: "health_check_failed",
							})
						: await management.recordWorkloadObservation({
								...correlation,
								observation,
							});
				expect(decision).toEqual({
					outcome: "conflict",
					reason: "invalid_observation",
					writePlan: null,
				});
				expect(
					await management.resolveAgentAccess(
						{ schemaVersion: 1, agentId: state.agentId, intent: "manage" },
						applicant,
					),
				).toMatchObject({
					outcome: "allowed",
					managementStatus: state.status,
				});
			}
		}
	});

	it("resolves current Owner, direct-user, organization, and account availability", async () => {
		const state = stateFixture({
			applicationId: "application_access",
			agentId: "agent_access",
			status: "available",
			revision: 6,
			serviceAvailability: "starting",
			workloadRevision: 3,
			fence: 4,
			ownerIds: [applicant.userId, "user_co_owner"],
			availability: [
				{ kind: "user", userId: "user_direct" },
				{ kind: "organization", organizationId: "org_platform" },
			],
		});
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
		).toEqual(denial);
		expect(
			await management.resolveAgentAccess(useQuery, {
				...administrator,
				organizationIds: [],
			}),
		).toEqual(denial);
		expect(
			await management.resolveAgentAccess(
				{ ...useQuery, intent: "manage" },
				applicant,
			),
		).toMatchObject({ outcome: "allowed", serviceReady: false });
		expect(
			await management.resolveAgentAccess(
				{ ...useQuery, intent: "manage" },
				{ ...applicant, userId: "user_direct", organizationIds: [] },
			),
		).toEqual(denial);
	});

	it("produces one pure access-update plan from caller wishes and trusted authority", async () => {
		const state = stateFixture({
			applicationId: "application_access_update",
			agentId: "agent_access_update",
			status: "available",
			revision: 12,
			workloadRevision: 6,
			fence: 9,
		});
		expect(
			decideAgentAccessUpdatePolicy(
				{
					schemaVersion: 1,
					agentId: state.agentId,
					expectedRevision: 12,
					desiredOwnerIds: [applicant.userId, "user_co_owner"],
					desiredAvailability: [
						{ kind: "user", userId: "user_direct" },
						{ kind: "organization", organizationId: "org_platform" },
					],
					requestId: "request_access_update",
					traceId: "trace_access_update",
				},
				state,
				applicant,
				{
					schemaVersion: 1,
					users: [
						{ userId: applicant.userId, accountStatus: "active" },
						{ userId: "user_co_owner", accountStatus: "active" },
						{ userId: "user_direct", accountStatus: "active" },
					],
					organizationIds: ["org_platform"],
				},
			),
		).toEqual({
			outcome: "accepted",
			planFragment: {
				schemaVersion: 1,
				fragmentType: "agent_access",
				agentId: state.agentId,
				expectedRevision: 12,
				ownerIds: [applicant.userId, "user_co_owner"],
				availability: [
					{ kind: "user", userId: "user_direct" },
					{ kind: "organization", organizationId: "org_platform" },
				],
				auditEvent: {
					action: "agent.access.updated",
					actorId: applicant.userId,
					subjectType: "agent",
					subjectId: state.agentId,
					traceId: "trace_access_update",
					requestId: "request_access_update",
				},
			},
		});
	});

	it("enforces ownership, rescue, target, duplicate, stale, and no-op access policy", async () => {
		const authority = {
			schemaVersion: 1 as const,
			users: [
				{ userId: applicant.userId, accountStatus: "active" as const },
				{ userId: "user_co_owner", accountStatus: "active" as const },
				{ userId: "user_disabled", accountStatus: "disabled" as const },
				{ userId: "user_revoked", accountStatus: "revoked" as const },
				{ userId: "user_direct", accountStatus: "active" as const },
				{ userId: administrator.userId, accountStatus: "active" as const },
			],
			organizationIds: ["org_platform"],
		};
		const state = stateFixture({
			applicationId: "application_access_policy",
			agentId: "agent_access_policy",
			revision: 5,
			ownerIds: [applicant.userId, "user_co_owner"],
		});
		const command = {
			schemaVersion: 1 as const,
			agentId: state.agentId,
			expectedRevision: 5,
			desiredOwnerIds: [applicant.userId, "user_co_owner"],
			desiredAvailability: [{ kind: "user" as const, userId: "user_direct" }],
			requestId: "request_access_policy",
			traceId: "trace_access_policy",
		};

		expect(
			decideAgentAccessUpdatePolicy(
				command,
				state,
				{ ...applicant, userId: "user_co_owner" },
				authority,
			),
		).toMatchObject({ outcome: "accepted" });
		const pendingForApplicant = stateFixture({
			status: "pending_approval",
			agentId: "agent_pending_access_policy",
			ownerIds: ["user_co_owner"],
		});
		expect(
			decideAgentAccessUpdatePolicy(
				{
					...command,
					agentId: pendingForApplicant.agentId,
					expectedRevision: pendingForApplicant.revision,
				},
				pendingForApplicant,
				applicant,
				authority,
			),
		).toMatchObject({ outcome: "accepted" });

		const disabledOwnerState = stateFixture({
			agentId: "agent_disabled_owner",
			ownerIds: ["user_disabled"],
		});
		expect(
			decideAgentAccessUpdatePolicy(
				{
					...command,
					agentId: disabledOwnerState.agentId,
					expectedRevision: disabledOwnerState.revision,
					desiredOwnerIds: ["user_co_owner"],
					desiredAvailability: [],
				},
				disabledOwnerState,
				administrator,
				authority,
			),
		).toMatchObject({
			outcome: "accepted",
			planFragment: { ownerIds: ["user_co_owner"] },
		});
		expect(
			decideAgentAccessUpdatePolicy(
				{
					...command,
					agentId: disabledOwnerState.agentId,
					expectedRevision: disabledOwnerState.revision,
					desiredOwnerIds: ["user_co_owner"],
				},
				disabledOwnerState,
				administrator,
				authority,
			),
		).toEqual({
			outcome: "conflict",
			reason: "admin_rescue_owner_only",
			planFragment: null,
		});

		const denial = { outcome: "denied", planFragment: null };
		expect(
			decideAgentAccessUpdatePolicy(command, state, administrator, authority),
		).toEqual(denial);
		expect(
			decideAgentAccessUpdatePolicy(
				command,
				state,
				{ ...applicant, accountStatus: "disabled" },
				{
					...authority,
					users: authority.users.map((user) =>
						user.userId === applicant.userId
							? { ...user, accountStatus: "disabled" as const }
							: user,
					),
				},
			),
		).toEqual(denial);
		for (const [actor, inconsistentAuthority] of [
			[{ ...applicant, userId: "user_outsider" }, authority],
			[
				applicant,
				{
					...authority,
					users: authority.users.map((user) =>
						user.userId === applicant.userId
							? { ...user, accountStatus: "disabled" as const }
							: user,
					),
				},
			],
		] as const) {
			await expect(
				Promise.resolve().then(() =>
					decideAgentAccessUpdatePolicy(
						command,
						state,
						actor,
						inconsistentAuthority,
					),
				),
			).rejects.toMatchObject({ code: "unavailable" });
		}
		expect(
			decideAgentAccessUpdatePolicy(
				{ ...command, agentId: "agent_other" },
				state,
				applicant,
				authority,
			),
		).toEqual(denial);
		expect(
			decideAgentAccessUpdatePolicy(command, undefined, applicant, authority),
		).toEqual(denial);

		for (const [input, reason] of [
			[{ ...command, expectedRevision: 4 }, "stale_revision"],
			[{ ...command, desiredOwnerIds: [] }, "last_valid_owner_required"],
			[
				{ ...command, desiredOwnerIds: [applicant.userId, applicant.userId] },
				"invalid_access_update",
			],
			[
				{
					...command,
					desiredAvailability: [
						{ kind: "user" as const, userId: "user_direct" },
						{ kind: "user" as const, userId: "user_direct" },
					],
				},
				"invalid_access_update",
			],
			[{ ...command, desiredOwnerIds: ["user_unknown"] }, "invalid_target"],
			[{ ...command, desiredOwnerIds: ["user_revoked"] }, "invalid_target"],
			[
				{
					...command,
					desiredAvailability: [
						{ kind: "organization" as const, organizationId: "org_unknown" },
					],
				},
				"invalid_target",
			],
		] as const) {
			expect(
				decideAgentAccessUpdatePolicy(input, state, applicant, authority),
			).toEqual({ outcome: "conflict", reason, planFragment: null });
		}
		expect(
			decideAgentAccessUpdatePolicy(
				{
					...command,
					desiredAvailability: [],
				},
				state,
				applicant,
				authority,
			),
		).toEqual({
			outcome: "conflict",
			reason: "no_change",
			planFragment: null,
		});
	});

	it("rejects caller authority, malformed input, stale revisions, and changed replays", async () => {
		const state = stateFixture({
			applicationId: "application_negative",
			agentId: "agent_negative",
			status: "pending_approval",
			revision: 2,
		});
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
