import { expect, it } from "vitest";
import type {
	AgentAccessQueryV1,
	AgentManagementActorContextV1,
	AgentManagementCommandV1,
	AgentManagementDecisionV1,
	AgentManagementInterfaceV1,
	AgentManagementOptionsV1,
	AgentManagementStateV1,
	AgentManagementWorkloadObservationV1,
} from "./agent-management.ts";
import {
	type AgentAccessAuthorityContextV1,
	type AgentAccessUpdatePolicyCommandV1,
	type AgentAccessUpdatePolicyDecisionV1,
	decideAgentAccessUpdatePolicy,
} from "./agent-management-access-policy.ts";

export interface AgentManagementConformanceOptionsV1
	extends AgentManagementOptionsV1 {
	readonly states?: readonly AgentManagementStateV1[];
	readonly failure?: "transaction" | "access_read";
	readonly faultyStateOnce?: AgentManagementStateV1;
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

type ManagementCommand = AgentManagementCommandV1["command"];
type WorkloadObservation = AgentManagementWorkloadObservationV1["observation"];

interface CorrelationFixture {
	readonly expectedRevision?: number;
	readonly idempotencyKey?: string;
	readonly requestId?: string;
	readonly traceId?: string;
	readonly reason?: string;
}

function commandFixture(
	command: ManagementCommand,
	state: AgentManagementStateV1,
	overrides: CorrelationFixture = {},
): AgentManagementCommandV1 {
	const correlation = {
		schemaVersion: 1 as const,
		expectedRevision: overrides.expectedRevision ?? state.revision,
		idempotencyKey:
			overrides.idempotencyKey ??
			`${command}-${state.applicationId}-${state.agentId}`,
		requestId: overrides.requestId ?? `request_${command}`,
		traceId: overrides.traceId ?? `trace_${command}`,
	};
	if (command === "reject_application") {
		return {
			...correlation,
			command,
			applicationId: state.applicationId,
			reason: overrides.reason ?? "Capacity is unavailable",
		};
	}
	if (
		command === "update_application" ||
		command === "withdraw_application" ||
		command === "approve_application"
	) {
		return { ...correlation, command, applicationId: state.applicationId };
	}
	return { ...correlation, command, agentId: state.agentId };
}

interface ObservationFixture {
	readonly observationId?: string;
	readonly expectedRevision?: number;
	readonly workloadRevision?: number;
	readonly fence?: number;
	readonly requestId?: string;
	readonly traceId?: string;
	readonly failureCode?:
		| "creation_not_ready"
		| "health_check_failed"
		| "workload_unavailable"
		| "reconciliation_failed";
}

function observationFixture(
	observation: WorkloadObservation,
	state: AgentManagementStateV1,
	overrides: ObservationFixture = {},
): AgentManagementWorkloadObservationV1 {
	const correlation = {
		schemaVersion: 1 as const,
		observationId: overrides.observationId ?? `${observation}-${state.agentId}`,
		agentId: state.agentId,
		expectedRevision: overrides.expectedRevision ?? state.revision,
		workloadRevision: overrides.workloadRevision ?? state.workloadRevision,
		fence: overrides.fence ?? state.fence,
		requestId: overrides.requestId ?? `request_${observation}`,
		traceId: overrides.traceId ?? `trace_${observation}`,
	};
	if (
		observation === "creation_failed" ||
		observation === "service_unavailable"
	) {
		return {
			...correlation,
			observation,
			failureCode:
				overrides.failureCode ??
				(observation === "creation_failed"
					? "creation_not_ready"
					: "health_check_failed"),
		};
	}
	return { ...correlation, observation };
}

function accessQuery(
	state: AgentManagementStateV1,
	intent: AgentAccessQueryV1["intent"] = "manage",
): AgentAccessQueryV1 {
	return { schemaVersion: 1, agentId: state.agentId, intent };
}

function conflict(
	reason: Extract<AgentManagementDecisionV1, { outcome: "conflict" }>["reason"],
): AgentManagementDecisionV1 {
	return { outcome: "conflict", reason, writePlan: null };
}

const denied = { outcome: "denied", writePlan: null } as const;
const accessDenied = { outcome: "denied" } as const;
const policyDenied = { outcome: "denied", planFragment: null } as const;

function policyCommand(
	state: AgentManagementStateV1,
	overrides: Partial<AgentAccessUpdatePolicyCommandV1> = {},
): AgentAccessUpdatePolicyCommandV1 {
	return {
		schemaVersion: 1,
		agentId: state.agentId,
		expectedRevision: state.revision,
		desiredOwnerIds: state.ownerIds,
		desiredAvailability: state.availability,
		requestId: "request_access_policy",
		traceId: "trace_access_policy",
		...overrides,
	};
}

function policyConflict(
	reason: Extract<
		AgentAccessUpdatePolicyDecisionV1,
		{ outcome: "conflict" }
	>["reason"],
): AgentAccessUpdatePolicyDecisionV1 {
	return { outcome: "conflict", reason, planFragment: null };
}

async function expectUnavailable(promise: Promise<unknown>): Promise<void> {
	await expect(promise).rejects.toMatchObject({
		name: "AgentManagementError",
		code: "unavailable",
	});
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
		const command = commandFixture("update_application", pendingState, {
			idempotencyKey: "boundary-command",
			requestId: "request_boundary_command",
			traceId: "trace_boundary_command",
		});
		const observation = observationFixture(
			"creation_succeeded",
			creatingState,
			{
				observationId: "boundary-observation",
				requestId: "request_boundary_observation",
				traceId: "trace_boundary_observation",
			},
		);

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
			).resolveAgentAccess(accessQuery(creatingState, "use"), applicant),
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
					policyCommand(pendingState),
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
			const seeded = {
				...invalid,
				applicationId: `${invalid.applicationId}_${index}`,
				agentId: `${invalid.agentId}_${index}`,
			};
			const management = await createManagement({
				states: [seeded],
			});
			await expectUnavailable(
				management.resolveAgentAccess(accessQuery(seeded, "use"), applicant),
			);
		}

		const invalidCommandState = {
			...valid,
			status: "pending_approval" as const,
			serviceAvailability: null,
			desiredState: "running" as const,
			workloadRevision: 0,
			fence: 0,
		};
		await expectUnavailable(
			(
				await createManagement({ states: [invalidCommandState] })
			).executeManagementCommand(
				commandFixture("update_application", invalidCommandState),
				applicant,
			),
		);
		const invalidObservationState = {
			...valid,
			status: "creating" as const,
			serviceAvailability: null,
			ownerIds: [],
		};
		await expectUnavailable(
			(
				await createManagement({ states: [invalidObservationState] })
			).recordWorkloadObservation(
				observationFixture("creation_succeeded", invalidObservationState),
			),
		);
	});

	it("binds every valid Port aggregate to the requested application or Agent", async () => {
		const applicationState = stateFixture({
			status: "pending_approval",
			applicationId: "application_identity_target",
			agentId: "agent_application_identity_target",
		});
		const applicationManagement = await createManagement({
			states: [applicationState],
			faultyStateOnce: {
				...applicationState,
				applicationId: "application_identity_wrong",
			},
		});
		await expectUnavailable(
			applicationManagement.executeManagementCommand(
				commandFixture("update_application", applicationState),
				applicant,
			),
		);
		expect(
			await applicationManagement.resolveAgentAccess(
				accessQuery(applicationState),
				applicant,
			),
		).toMatchObject({
			outcome: "allowed",
			managementStatus: "pending_approval",
		});

		const agentState = stateFixture({
			agentId: "agent_command_identity_target",
		});
		const agentManagement = await createManagement({
			states: [agentState],
			faultyStateOnce: {
				...agentState,
				agentId: "agent_command_identity_wrong",
			},
		});
		await expectUnavailable(
			agentManagement.executeManagementCommand(
				commandFixture("stop_agent", agentState),
				applicant,
			),
		);
		expect(
			await agentManagement.resolveAgentAccess(
				accessQuery(agentState),
				applicant,
			),
		).toMatchObject({ outcome: "allowed", managementStatus: "available" });

		const observationState = stateFixture({
			status: "creating",
			agentId: "agent_observation_identity_target",
		});
		const observationManagement = await createManagement({
			states: [observationState],
			faultyStateOnce: {
				...observationState,
				agentId: "agent_observation_identity_wrong",
			},
		});
		await expectUnavailable(
			observationManagement.recordWorkloadObservation(
				observationFixture("creation_succeeded", observationState),
			),
		);
		expect(
			await observationManagement.resolveAgentAccess(
				accessQuery(observationState),
				applicant,
			),
		).toMatchObject({ outcome: "allowed", managementStatus: "creating" });

		const accessState = stateFixture({
			agentId: "agent_access_identity_target",
		});
		const accessManagement = await createManagement({
			states: [accessState],
			faultyStateOnce: {
				...accessState,
				agentId: "agent_access_identity_wrong",
			},
		});
		await expectUnavailable(
			accessManagement.resolveAgentAccess(
				accessQuery(accessState, "use"),
				applicant,
			),
		);
		expect(
			await accessManagement.resolveAgentAccess(
				accessQuery(accessState, "use"),
				applicant,
			),
		).toMatchObject({ outcome: "allowed", managementStatus: "available" });
	});
	it("lets the applicant update, resubmit, and withdraw one application history", async () => {
		const application = stateFixture({
			applicationId: "application_1",
			agentId: "agent_1",
			status: "rejected",
			revision: 3,
			decisionReason: "Resource request needs adjustment",
		});
		const management = await createManagement({
			now: () => new Date("2026-08-31T08:00:00.000Z"),
			states: [application],
		});

		const resubmitted = await management.executeManagementCommand(
			commandFixture("update_application", application, {
				idempotencyKey: "application-update-1",
				requestId: "request_1",
				traceId: "trace_1",
			}),
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
			commandFixture("update_application", application, {
				expectedRevision: 4,
				idempotencyKey: "application-update-2",
				requestId: "request_update_2",
				traceId: "trace_update_2",
			}),
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
			commandFixture("withdraw_application", application, {
				expectedRevision: 5,
				idempotencyKey: "application-withdraw-1",
				requestId: "request_2",
				traceId: "trace_2",
			}),
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
				commandFixture("approve_application", state),
				applicant,
			),
		).toEqual({ outcome: "denied", writePlan: null });

		const approved = await createManagement({
			now: () => new Date("2026-08-31T08:05:00.000Z"),
			states: [state],
		});
		expect(
			await approved.executeManagementCommand(
				commandFixture("approve_application", state),
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
				commandFixture("reject_application", state),
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
			const seeded = {
				...state,
				applicationId: `application_overflow_${state.status}_${state.workloadRevision}_${state.fence}`,
				agentId: `agent_overflow_${state.status}_${state.workloadRevision}_${state.fence}`,
			};
			const management = await createManagement({ states: [seeded] });
			const command =
				state.status === "pending_approval"
					? "update_application"
					: "stop_agent";
			const decision = await management.executeManagementCommand(
				commandFixture(command, seeded),
				applicant,
			);
			expect(decision).toEqual(conflict("counter_overflow"));
		}

		const observationState = stateFixture({
			status: "available",
			revision: Number.MAX_SAFE_INTEGER,
		});
		const observationManagement = await createManagement({
			states: [observationState],
		});
		expect(
			await observationManagement.recordWorkloadObservation(
				observationFixture("service_ready", observationState, {
					observationId: "observation_overflow",
					requestId: "request_observation_overflow",
					traceId: "trace_observation_overflow",
				}),
			),
		).toEqual(conflict("counter_overflow"));
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
				commandFixture("stop_agent", availableState),
				{ ...applicant, userId: "user_outsider" },
			),
		).toEqual(denied);

		const stopped = await management.executeManagementCommand(
			commandFixture("stop_agent", availableState),
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
			commandFixture("restart_agent", availableState, {
				expectedRevision: 8,
			}),
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
				commandFixture("retry_agent_creation", failedState),
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
				commandFixture("disable_agent", availableState),
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
					commandFixture(command, state),
					actor,
				);
				if ((allowed[command] as readonly string[]).includes(status)) {
					expect(decision).toMatchObject({ outcome: "accepted" });
				} else {
					expect(decision).toEqual(conflict("invalid_transition"));
					expect(
						await management.resolveAgentAccess(accessQuery(state), applicant),
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
				await management.executeManagementCommand(
					commandFixture(command, state),
					{
						...(command === "approve_application" ||
						command === "reject_application" ||
						command === "disable_agent"
							? administrator
							: applicant),
						accountStatus: "disabled",
					},
				),
			).toEqual({ outcome: "denied", writePlan: null });
			expect(
				await management.resolveAgentAccess(accessQuery(state), applicant),
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
				await management.executeManagementCommand(
					commandFixture(command, state),
					{
						...administrator,
						organizationIds: [],
					},
				),
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
		const observation = observationFixture(
			"creation_succeeded",
			creatingState,
			{
				observationId: "observation_1",
				requestId: "request_observe",
				traceId: "trace_observe",
			},
		);
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
			).toEqual(conflict("stale_observation"));
		}
		expect(
			await management.recordWorkloadObservation({
				...observation,
				observationId: "observation_stale_fence",
				fence: 4,
			}),
		).toEqual(conflict("stale_observation"));

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
			await management.recordWorkloadObservation(
				observationFixture("creation_failed", creatingState, {
					observationId: "observation_stale",
				}),
			),
		).toEqual(conflict("stale_observation"));
	});

	it("maps every current Worker result without mixing service and management status", async () => {
		const base = {
			revision: 10,
			workloadRevision: 6,
			fence: 8,
		};
		const failureState = stateFixture({
			...base,
			applicationId: "application_failure",
			agentId: "agent_failure",
			status: "creating",
		});
		const unapprovedState = stateFixture({
			...base,
			applicationId: "application_unapproved",
			agentId: "agent_unapproved",
			status: "pending_approval",
			workloadRevision: 0,
			fence: 0,
		});
		const serviceStates = [
			"service_starting",
			"service_ready",
			"service_updating",
			"service_unavailable",
		].map((observation) =>
			stateFixture({
				...base,
				applicationId: `application_${observation}`,
				agentId: `agent_${observation}`,
				serviceAvailability: "unavailable",
				failureCode: "workload_unavailable",
			}),
		);
		const management = await createManagement({
			states: [failureState, ...serviceStates, unapprovedState],
		});
		await expect(
			management.recordWorkloadObservation({
				...observationFixture("creation_failed", failureState, {
					observationId: "observation_free_text_failure",
				}),
				reason: "Pod agent-0 exposed a Runtime Secret",
			} as never),
		).rejects.toMatchObject({ code: "invalid_input" });
		expect(
			await management.recordWorkloadObservation(
				observationFixture("creation_failed", failureState, {
					observationId: "observation_failure",
				}),
			),
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
			const state = stateFixture({
				...base,
				agentId: `agent_${expected.observation}`,
				serviceAvailability: "unavailable",
				failureCode: "workload_unavailable",
			});
			expect(
				await management.recordWorkloadObservation(
					observationFixture(expected.observation, state, {
						observationId: `observation_${expected.observation}`,
					}),
				),
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
		const unavailableState = serviceStates.find(
			({ agentId }) => agentId === "agent_service_unavailable",
		);
		if (!unavailableState) throw new Error("Missing unavailable fixture");
		expect(
			await management.recordWorkloadObservation(
				observationFixture("service_unavailable", unavailableState, {
					observationId: "observation_service_unavailable",
				}),
			),
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
			await management.recordWorkloadObservation(
				observationFixture("creation_succeeded", unapprovedState, {
					observationId: "observation_unapproved",
					expectedRevision: 10,
				}),
			),
		).toEqual(conflict("invalid_observation"));
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
				const decision = await management.recordWorkloadObservation(
					observationFixture(observation, state, {
						observationId: `${observation}_${state.status}`,
						requestId: `request_${observation}_${state.status}`,
						traceId: `trace_${observation}_${state.status}`,
					}),
				);
				expect(decision).toEqual(conflict("invalid_observation"));
				expect(
					await management.resolveAgentAccess(accessQuery(state), applicant),
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
		const useQuery = accessQuery(state, "use");

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

		expect(
			await management.resolveAgentAccess(useQuery, {
				...applicant,
				userId: "user_org",
				organizationIds: ["org_transferred"],
			}),
		).toEqual(accessDenied);
		expect(
			await management.resolveAgentAccess(useQuery, {
				...applicant,
				userId: applicant.userId,
				accountStatus: "disabled",
				organizationIds: [],
			}),
		).toEqual(accessDenied);
		expect(
			await management.resolveAgentAccess(
				{ ...useQuery, agentId: "agent_missing" },
				{ ...applicant, userId: "user_unknown", organizationIds: [] },
			),
		).toEqual(accessDenied);

		expect(
			await management.resolveAgentAccess(accessQuery(state), administrator),
		).toEqual(accessDenied);
		expect(
			await management.resolveAgentAccess(useQuery, {
				...administrator,
				organizationIds: [],
			}),
		).toEqual(accessDenied);
		expect(
			await management.resolveAgentAccess(accessQuery(state), applicant),
		).toMatchObject({ outcome: "allowed", serviceReady: false });
		expect(
			await management.resolveAgentAccess(accessQuery(state), {
				...applicant,
				userId: "user_direct",
				organizationIds: [],
			}),
		).toEqual(accessDenied);
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
				policyCommand(state, {
					desiredOwnerIds: [applicant.userId, "user_co_owner"],
					desiredAvailability: [
						{ kind: "user", userId: "user_direct" },
						{ kind: "organization", organizationId: "org_platform" },
					],
					requestId: "request_access_update",
					traceId: "trace_access_update",
				}),
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

	it("uses the Core 1024-byte bound for every access-policy domain identifier", async () => {
		const state = stateFixture({ agentId: "agent_bounded_policy" });
		const authority = {
			schemaVersion: 1 as const,
			users: [{ userId: applicant.userId, accountStatus: "active" as const }],
			organizationIds: ["org_platform"],
		};
		const command = policyCommand(state);
		for (const invalid of [
			{ ...command, agentId: "a".repeat(1025) },
			{ ...command, desiredOwnerIds: ["o".repeat(1025)] },
			{
				...command,
				desiredAvailability: [
					{ kind: "organization" as const, organizationId: "g".repeat(1025) },
				],
			},
		]) {
			await expect(
				Promise.resolve().then(() =>
					decideAgentAccessUpdatePolicy(invalid, state, applicant, authority),
				),
			).rejects.toMatchObject({ code: "invalid_input" });
		}
	});

	it("fails closed on every impossible aggregate at the internal access-policy seam", async () => {
		const state = stateFixture({ agentId: "agent_invalid_policy_state" });
		const command = policyCommand(state, {
			desiredOwnerIds: [applicant.userId, "user_co_owner"],
		});
		const authority = {
			schemaVersion: 1 as const,
			users: [
				{ userId: applicant.userId, accountStatus: "active" as const },
				{ userId: "user_co_owner", accountStatus: "active" as const },
			],
			organizationIds: [],
		};
		for (const invalidState of [
			{ ...state, schemaVersion: 2 },
			{ ...state, status: "corrupted" },
			{ ...state, desiredState: "stopped" },
		]) {
			await expectUnavailable(
				Promise.resolve().then(() =>
					decideAgentAccessUpdatePolicy(
						command,
						invalidState as never,
						applicant,
						authority,
					),
				),
			);
		}
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
		const command = policyCommand(state, {
			desiredOwnerIds: [applicant.userId, "user_co_owner"],
			desiredAvailability: [{ kind: "user" as const, userId: "user_direct" }],
		});
		const decide = (
			input: AgentAccessUpdatePolicyCommandV1 = command,
			...args: [
				current?: AgentManagementStateV1,
				actor?: AgentManagementActorContextV1,
				context?: AgentAccessAuthorityContextV1,
			]
		) =>
			decideAgentAccessUpdatePolicy(
				input,
				args.length ? args[0] : state,
				args[1] ?? applicant,
				args[2] ?? authority,
			);

		expect(
			decide(command, state, { ...applicant, userId: "user_co_owner" }),
		).toMatchObject({ outcome: "accepted" });
		const pendingForApplicant = stateFixture({
			status: "pending_approval",
			agentId: "agent_pending_access_policy",
			ownerIds: ["user_co_owner"],
		});
		expect(
			decide(
				{
					...command,
					agentId: pendingForApplicant.agentId,
					expectedRevision: pendingForApplicant.revision,
				},
				pendingForApplicant,
			),
		).toMatchObject({ outcome: "accepted" });

		const disabledOwnerState = stateFixture({
			agentId: "agent_disabled_owner",
			ownerIds: ["user_disabled"],
			availability: [
				{ kind: "user", userId: "user_disabled" },
				{ kind: "organization", organizationId: "org_removed" },
			],
		});
		expect(
			decide(
				{
					...command,
					agentId: disabledOwnerState.agentId,
					expectedRevision: disabledOwnerState.revision,
					desiredOwnerIds: ["user_co_owner"],
					desiredAvailability: disabledOwnerState.availability,
				},
				disabledOwnerState,
				administrator,
			),
		).toMatchObject({
			outcome: "accepted",
			planFragment: {
				ownerIds: ["user_co_owner"],
				availability: disabledOwnerState.availability,
			},
		});
		expect(
			decide(
				{
					...command,
					agentId: disabledOwnerState.agentId,
					expectedRevision: disabledOwnerState.revision,
					desiredOwnerIds: ["user_co_owner"],
				},
				disabledOwnerState,
				administrator,
			),
		).toEqual(policyConflict("admin_rescue_owner_only"));

		expect(decide(command, state, administrator)).toEqual(policyDenied);
		expect(
			decide(
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
		).toEqual(policyDenied);
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
					decide(command, state, actor, inconsistentAuthority),
				),
			).rejects.toMatchObject({ code: "unavailable" });
		}
		expect(decide({ ...command, agentId: "agent_other" }, state)).toEqual(
			policyDenied,
		);
		expect(decide(command, undefined)).toEqual(policyDenied);

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
			expect(decide(input)).toEqual(policyConflict(reason));
		}
		expect(
			decide(
				{
					...command,
					desiredAvailability: [],
				},
				state,
			),
		).toEqual(policyConflict("no_change"));
	});

	it("rejects caller authority, malformed input, stale revisions, and changed replays", async () => {
		const state = stateFixture({
			applicationId: "application_negative",
			agentId: "agent_negative",
			status: "pending_approval",
			revision: 2,
		});
		const management = await createManagement({ states: [state] });
		const update = commandFixture("update_application", state, {
			idempotencyKey: "negative-update",
			requestId: "request_negative",
			traceId: "trace_negative",
		});

		await expect(
			management.executeManagementCommand(
				{ ...update, actorId: applicant.userId } as never,
				{ ...applicant, userId: "user_attacker" },
			),
		).rejects.toMatchObject({
			name: "AgentManagementError",
			code: "invalid_input",
		});
		expect(
			await management.executeManagementCommand(update, {
				...applicant,
				userId: "user_other",
			}),
		).toEqual(denied);
		expect(
			await management.executeManagementCommand(
				commandFixture("update_application", {
					...state,
					applicationId: "application_missing",
				}),
				applicant,
			),
		).toEqual(denied);
		expect(
			await management.executeManagementCommand(
				commandFixture("update_application", state, { expectedRevision: 1 }),
				applicant,
			),
		).toEqual(conflict("stale_revision"));

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
				commandFixture("update_application", state, {
					idempotencyKey: "negative-update",
					requestId: "changed_request",
				}),
				applicant,
			),
		).toEqual(conflict("idempotency_conflict"));

		await expect(
			management.executeManagementCommand(
				commandFixture("reject_application", state, {
					reason: "",
					expectedRevision: 3,
					idempotencyKey: "empty-reason",
					requestId: "request_reject_empty",
					traceId: "trace_reject_empty",
				}),
				administrator,
			),
		).rejects.toMatchObject({ code: "invalid_input" });
	});

	it("binds idempotency to subject, actor, and key across operations", async () => {
		const applicationState = stateFixture({
			status: "pending_approval",
			applicationId: "application_cross_command_key",
			agentId: "agent_cross_command_key",
		});
		const applicationManagement = await createManagement({
			states: [applicationState],
		});
		expect(
			await applicationManagement.executeManagementCommand(
				commandFixture("update_application", applicationState, {
					idempotencyKey: "cross-command-key",
				}),
				applicant,
			),
		).toMatchObject({ outcome: "accepted", result: { revision: 2 } });
		expect(
			await applicationManagement.executeManagementCommand(
				commandFixture("withdraw_application", applicationState, {
					expectedRevision: 2,
					idempotencyKey: "cross-command-key",
				}),
				applicant,
			),
		).toEqual(conflict("idempotency_conflict"));
		expect(
			await applicationManagement.executeManagementCommand(
				commandFixture("withdraw_application", applicationState, {
					expectedRevision: 2,
					idempotencyKey: "fresh-withdraw-key",
				}),
				applicant,
			),
		).toMatchObject({ outcome: "accepted", result: { status: "withdrawn" } });

		const observationState = stateFixture({
			agentId: "agent_cross_observation_id",
		});
		const observationManagement = await createManagement({
			states: [observationState],
		});
		expect(
			await observationManagement.recordWorkloadObservation(
				observationFixture("service_starting", observationState, {
					observationId: "cross-observation-id",
				}),
			),
		).toMatchObject({ outcome: "accepted", result: { revision: 2 } });
		expect(
			await observationManagement.recordWorkloadObservation(
				observationFixture("service_ready", observationState, {
					observationId: "cross-observation-id",
					expectedRevision: 2,
				}),
			),
		).toEqual(conflict("idempotency_conflict"));
		expect(
			await observationManagement.recordWorkloadObservation(
				observationFixture("service_ready", observationState, {
					observationId: "fresh-observation-id",
					expectedRevision: 2,
				}),
			),
		).toMatchObject({ outcome: "accepted", result: { revision: 3 } });

		const actorState = stateFixture({
			agentId: "agent_actor_key_scope",
			ownerIds: [applicant.userId, "user_co_owner"],
		});
		const actorManagement = await createManagement({ states: [actorState] });
		expect(
			await actorManagement.executeManagementCommand(
				commandFixture("stop_agent", actorState, {
					idempotencyKey: "actor-independent-key",
				}),
				applicant,
			),
		).toMatchObject({ outcome: "accepted", result: { status: "stopped" } });
		expect(
			await actorManagement.executeManagementCommand(
				commandFixture("restart_agent", actorState, {
					expectedRevision: 2,
					idempotencyKey: "actor-independent-key",
				}),
				{ ...applicant, userId: "user_co_owner" },
			),
		).toMatchObject({ outcome: "accepted", result: { status: "available" } });

		const sharedSubject = "shared_subject_id";
		const applicationResource = stateFixture({
			status: "pending_approval",
			applicationId: sharedSubject,
			agentId: "agent_for_shared_application",
		});
		const agentResource = stateFixture({
			applicationId: "application_for_shared_agent",
			agentId: sharedSubject,
		});
		const resourceManagement = await createManagement({
			states: [applicationResource, agentResource],
		});
		expect(
			await resourceManagement.executeManagementCommand(
				commandFixture("update_application", applicationResource, {
					idempotencyKey: "resource-independent-key",
				}),
				applicant,
			),
		).toMatchObject({ outcome: "accepted" });
		expect(
			await resourceManagement.executeManagementCommand(
				commandFixture("stop_agent", agentResource, {
					idempotencyKey: "resource-independent-key",
				}),
				applicant,
			),
		).toMatchObject({ outcome: "accepted" });
	});
}
