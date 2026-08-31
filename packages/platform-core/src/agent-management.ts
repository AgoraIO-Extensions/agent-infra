import {
	AgentManagementError,
	agentAccessTargetKey,
	isAgentManagementText as capturedText,
	invalidAgentManagementInput as invalidInput,
	isAgentManagementNonNegativeInteger as nonNegativeInteger,
	parseAgentManagementActorContext as parseActorContext,
	parseAgentAccessTargets,
	parseAgentManagementStringArray,
	requireAgentManagementExactKeys as requireExactKeys,
	snapshotAgentManagementDataObject as snapshotDataObject,
} from "./agent-management-input.js";
import { platformIdempotencyV1 } from "./idempotency.js";

function stringArray(input: unknown): readonly string[] {
	return parseAgentManagementStringArray(input, true);
}

export { AgentManagementError } from "./agent-management-input.js";

export type AgentManagementStatusV1 =
	| "pending_approval"
	| "withdrawn"
	| "rejected"
	| "creating"
	| "available"
	| "stopped"
	| "creation_failed"
	| "disabled";

export type AgentServiceAvailabilityV1 =
	| "ready"
	| "starting"
	| "updating"
	| "unavailable";

export type AgentFailureCodeV1 =
	| "creation_not_ready"
	| "health_check_failed"
	| "workload_unavailable"
	| "reconciliation_failed";

const failureCodes: readonly AgentFailureCodeV1[] = [
	"creation_not_ready",
	"health_check_failed",
	"workload_unavailable",
	"reconciliation_failed",
];

export interface AgentManagementActorContextV1 {
	readonly schemaVersion: 1;
	readonly userId: string;
	readonly accountStatus: "active" | "disabled";
	readonly organizationIds: readonly string[];
	readonly isAdministrator: boolean;
}

interface AgentManagementCommandBaseV1 {
	readonly schemaVersion: 1;
	readonly expectedRevision: number;
	readonly idempotencyKey: string;
	readonly requestId: string;
	readonly traceId: string;
}

export type AgentManagementCommandV1 =
	| (AgentManagementCommandBaseV1 & {
			readonly command: "update_application";
			readonly applicationId: string;
	  })
	| (AgentManagementCommandBaseV1 & {
			readonly command: "withdraw_application";
			readonly applicationId: string;
	  })
	| (AgentManagementCommandBaseV1 & {
			readonly command: "approve_application";
			readonly applicationId: string;
	  })
	| (AgentManagementCommandBaseV1 & {
			readonly command: "reject_application";
			readonly applicationId: string;
			readonly reason: string;
	  })
	| (AgentManagementCommandBaseV1 & {
			readonly command:
				| "stop_agent"
				| "restart_agent"
				| "retry_agent_creation"
				| "disable_agent";
			readonly agentId: string;
	  });

interface AgentManagementObservationBaseV1 {
	readonly schemaVersion: 1;
	readonly observationId: string;
	readonly agentId: string;
	readonly expectedRevision: number;
	readonly workloadRevision: number;
	readonly fence: number;
	readonly requestId: string;
	readonly traceId: string;
}

export type AgentManagementWorkloadObservationV1 =
	| (AgentManagementObservationBaseV1 & {
			readonly observation: "creation_succeeded";
	  })
	| (AgentManagementObservationBaseV1 & {
			readonly observation: "creation_failed" | "service_unavailable";
			readonly failureCode: AgentFailureCodeV1;
	  })
	| (AgentManagementObservationBaseV1 & {
			readonly observation:
				| "service_starting"
				| "service_ready"
				| "service_updating";
	  });

export type AgentManagementOperationV1 =
	| AgentManagementCommandV1["command"]
	| `observe_${AgentManagementWorkloadObservationV1["observation"]}`;

export interface AgentAccessQueryV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly intent: "discover" | "use" | "manage";
}

export interface AgentManagementStateV1 {
	readonly schemaVersion: 1;
	readonly applicationId: string;
	readonly agentId: string;
	readonly applicantId: string;
	readonly status: AgentManagementStatusV1;
	readonly revision: number;
	readonly approvalRevision: number | null;
	readonly decisionReason: string | null;
	readonly serviceAvailability: AgentServiceAvailabilityV1 | null;
	readonly desiredState: "running" | "stopped";
	readonly workloadRevision: number;
	readonly fence: number;
	readonly ownerIds: readonly string[];
	readonly availability: readonly (
		| { readonly kind: "user"; readonly userId: string }
		| { readonly kind: "organization"; readonly organizationId: string }
	)[];
	readonly failureCode: AgentFailureCodeV1 | null;
}

function portState(input: AgentManagementStateV1): AgentManagementStateV1 {
	try {
		const values = snapshotDataObject(input);
		requireExactKeys(values, [
			"schemaVersion",
			"applicationId",
			"agentId",
			"applicantId",
			"status",
			"revision",
			"approvalRevision",
			"decisionReason",
			"serviceAvailability",
			"desiredState",
			"workloadRevision",
			"fence",
			"ownerIds",
			"availability",
			"failureCode",
		]);
		const statuses: readonly AgentManagementStatusV1[] = [
			"pending_approval",
			"withdrawn",
			"rejected",
			"creating",
			"available",
			"stopped",
			"creation_failed",
			"disabled",
		];
		const serviceAvailabilities: readonly AgentServiceAvailabilityV1[] = [
			"ready",
			"starting",
			"updating",
			"unavailable",
		];
		if (
			values.schemaVersion !== 1 ||
			!capturedText(values.applicationId) ||
			!capturedText(values.agentId) ||
			!capturedText(values.applicantId) ||
			!statuses.includes(values.status as AgentManagementStatusV1) ||
			!nonNegativeInteger(values.revision) ||
			(values.approvalRevision !== null &&
				(!Number.isSafeInteger(values.approvalRevision) ||
					(values.approvalRevision as number) < 1)) ||
			(values.decisionReason !== null &&
				!capturedText(values.decisionReason, 4096)) ||
			(values.serviceAvailability !== null &&
				!serviceAvailabilities.includes(
					values.serviceAvailability as AgentServiceAvailabilityV1,
				)) ||
			(values.desiredState !== "running" &&
				values.desiredState !== "stopped") ||
			!nonNegativeInteger(values.workloadRevision) ||
			!nonNegativeInteger(values.fence) ||
			(values.failureCode !== null &&
				!failureCodes.includes(values.failureCode as AgentFailureCodeV1))
		) {
			invalidInput();
		}
		const status = values.status as AgentManagementStatusV1;
		const serviceAvailability =
			values.serviceAvailability as AgentServiceAvailabilityV1 | null;
		const preApproval =
			status === "pending_approval" ||
			status === "rejected" ||
			status === "withdrawn";
		if (
			(preApproval &&
				(values.desiredState !== "stopped" ||
					serviceAvailability !== null ||
					values.approvalRevision !== null ||
					values.workloadRevision !== 0 ||
					values.fence !== 0 ||
					values.failureCode !== null)) ||
			(!preApproval &&
				(values.approvalRevision === null ||
					(values.approvalRevision as number) > (values.revision as number) ||
					(values.workloadRevision as number) < 1 ||
					(values.fence as number) < 1)) ||
			((status === "creating" || status === "creation_failed") &&
				(values.desiredState !== "running" || serviceAvailability !== null)) ||
			(status === "available" &&
				(values.desiredState !== "running" || serviceAvailability === null)) ||
			((status === "stopped" || status === "disabled") &&
				(values.desiredState !== "stopped" || serviceAvailability !== null)) ||
			(status === "rejected" && values.decisionReason === null) ||
			(status !== "rejected" && values.decisionReason !== null) ||
			(status === "creation_failed" && values.failureCode === null) ||
			(status === "available" &&
				serviceAvailability === "unavailable" &&
				values.failureCode === null) ||
			(status === "available" &&
				serviceAvailability === "ready" &&
				values.failureCode !== null)
		) {
			invalidInput();
		}
		const ownerIds = stringArray(values.ownerIds);
		if (ownerIds.length === 0) invalidInput();
		const availability = parseAgentAccessTargets(values.availability);
		if (
			new Set(availability.map(agentAccessTargetKey)).size !==
			availability.length
		) {
			invalidInput();
		}
		return {
			schemaVersion: 1,
			applicationId: values.applicationId,
			agentId: values.agentId,
			applicantId: values.applicantId,
			status,
			revision: values.revision,
			approvalRevision: values.approvalRevision as number | null,
			decisionReason: values.decisionReason as string | null,
			serviceAvailability,
			desiredState: values.desiredState,
			workloadRevision: values.workloadRevision,
			fence: values.fence,
			ownerIds,
			availability,
			failureCode: values.failureCode as AgentFailureCodeV1 | null,
		};
	} catch {
		throw new AgentManagementError("unavailable");
	}
}

export interface AgentManagementWritePlanV1 {
	readonly schemaVersion: 1;
	readonly operation: AgentManagementOperationV1;
	readonly subjectType: "agent_application" | "agent";
	readonly subjectId: string;
	readonly expectedRevision: number;
	readonly state: AgentManagementStateV1;
	readonly transition: {
		readonly from: AgentManagementStatusV1;
		readonly to: AgentManagementStatusV1;
		readonly occurredAt: Date;
	};
	readonly outboxIntent: null | {
		readonly operation: "agent.workload.reconcile.v1";
		readonly payload: {
			readonly schemaVersion: 1;
			readonly agentId: string;
			readonly revision: number;
			readonly workloadRevision: number;
			readonly fence: number;
			readonly desiredState: "running" | "stopped";
		};
		readonly traceId: string;
		readonly requestId: string;
		readonly occurredAt: Date;
	};
	readonly auditEvent: {
		readonly action:
			| "agent.application.updated"
			| "agent.application.resubmitted"
			| "agent.application.withdrawn"
			| "agent.application.approved"
			| "agent.application.rejected"
			| "agent.lifecycle.stopped"
			| "agent.lifecycle.restarted"
			| "agent.lifecycle.creation_retried"
			| "agent.lifecycle.disabled"
			| "agent.workload.creation_succeeded"
			| "agent.workload.creation_failed"
			| "agent.workload.service_starting"
			| "agent.workload.service_ready"
			| "agent.workload.service_updating"
			| "agent.workload.service_unavailable";
		readonly actorId: string;
		readonly subjectType: "agent_application" | "agent";
		readonly subjectId: string;
		readonly traceId: string;
		readonly requestId: string;
		readonly occurredAt: Date;
	};
	readonly idempotency: {
		readonly key: string;
		readonly requestDigest: string;
	};
}

export interface AgentManagementAcceptedResultV1 {
	readonly schemaVersion: 1;
	readonly applicationId: string;
	readonly agentId: string;
	readonly status: AgentManagementStatusV1;
	readonly revision: number;
}

export type AgentManagementDecisionV1 =
	| {
			readonly outcome: "accepted";
			readonly result: AgentManagementAcceptedResultV1;
			readonly writePlan: AgentManagementWritePlanV1;
	  }
	| {
			readonly outcome: "replayed";
			readonly result: AgentManagementAcceptedResultV1;
			readonly writePlan: null;
	  }
	| { readonly outcome: "denied"; readonly writePlan: null }
	| {
			readonly outcome: "conflict";
			readonly reason:
				| "idempotency_conflict"
				| "counter_overflow"
				| "invalid_transition"
				| "stale_revision"
				| "invalid_observation"
				| "stale_observation";
			readonly writePlan: null;
	  };

export type AgentManagementCommandDecisionV1 = AgentManagementDecisionV1;
export type AgentManagementObservationDecisionV1 = AgentManagementDecisionV1;

export type AgentAccessDecisionV1 =
	| {
			readonly outcome: "allowed";
			readonly managementStatus: AgentManagementStatusV1;
			readonly serviceAvailability: AgentServiceAvailabilityV1 | null;
			readonly serviceReady: boolean;
	  }
	| { readonly outcome: "denied" };

export interface AgentManagementInterfaceV1 {
	executeManagementCommand(
		command: AgentManagementCommandV1,
		actorContext: AgentManagementActorContextV1,
	): Promise<AgentManagementCommandDecisionV1>;
	recordWorkloadObservation(
		observation: AgentManagementWorkloadObservationV1,
	): Promise<AgentManagementObservationDecisionV1>;
	resolveAgentAccess(
		query: AgentAccessQueryV1,
		actorContext: AgentManagementActorContextV1,
	): Promise<AgentAccessDecisionV1>;
}

export interface AgentManagementTransactionRequestV1 {
	readonly operation: AgentManagementOperationV1;
	readonly subjectType: "agent_application" | "agent";
	readonly subjectId: string;
	readonly actorId: string;
	readonly idempotencyKey: string;
	readonly requestDigest: string;
}

export interface AgentManagementTransactionPortV1 {
	executeAgentManagementTransaction(
		request: AgentManagementTransactionRequestV1,
		decide: (
			state: AgentManagementStateV1 | undefined,
		) => AgentManagementDecisionV1,
	): Promise<AgentManagementDecisionV1>;
	resolveAgentAccessState(
		agentId: string,
	): Promise<AgentManagementStateV1 | undefined>;
}

export interface AgentManagementOptionsV1 {
	readonly now?: () => Date;
}

const commandBaseKeys = [
	"schemaVersion",
	"command",
	"expectedRevision",
	"idempotencyKey",
	"requestId",
	"traceId",
] as const;

function parseCommand(input: unknown): AgentManagementCommandV1 {
	const values = snapshotDataObject(input);
	const command = values.command;
	const applicationCommands = [
		"update_application",
		"withdraw_application",
		"approve_application",
		"reject_application",
	] as const;
	const agentCommands = [
		"stop_agent",
		"restart_agent",
		"retry_agent_creation",
		"disable_agent",
	] as const;
	const isApplicationCommand = applicationCommands.some(
		(candidate) => candidate === command,
	);
	const isAgentCommand = agentCommands.some(
		(candidate) => candidate === command,
	);
	if (!isApplicationCommand && !isAgentCommand) invalidInput();
	requireExactKeys(values, [
		...commandBaseKeys,
		isApplicationCommand ? "applicationId" : "agentId",
		...(command === "reject_application" ? ["reason"] : []),
	]);
	if (
		values.schemaVersion !== 1 ||
		!nonNegativeInteger(values.expectedRevision) ||
		!capturedText(values.idempotencyKey, 128) ||
		!/^[A-Za-z0-9._~-]{1,128}$/.test(values.idempotencyKey) ||
		!capturedText(values.requestId) ||
		!capturedText(values.traceId) ||
		!capturedText(isApplicationCommand ? values.applicationId : values.agentId)
	) {
		invalidInput();
	}
	if (command === "reject_application" && !capturedText(values.reason, 4096)) {
		invalidInput();
	}
	return structuredClone(values) as unknown as AgentManagementCommandV1;
}

function parseObservation(
	input: unknown,
): AgentManagementWorkloadObservationV1 {
	const values = snapshotDataObject(input);
	const observation = values.observation;
	const observations = [
		"creation_succeeded",
		"creation_failed",
		"service_starting",
		"service_ready",
		"service_updating",
		"service_unavailable",
	] as const;
	if (!observations.some((candidate) => candidate === observation)) {
		invalidInput();
	}
	const requiresReason =
		observation === "creation_failed" || observation === "service_unavailable";
	requireExactKeys(values, [
		"schemaVersion",
		"observationId",
		"agentId",
		"observation",
		"expectedRevision",
		"workloadRevision",
		"fence",
		"requestId",
		"traceId",
		...(requiresReason ? ["failureCode"] : []),
	]);
	if (
		values.schemaVersion !== 1 ||
		!capturedText(values.observationId) ||
		!capturedText(values.agentId) ||
		!nonNegativeInteger(values.expectedRevision) ||
		!nonNegativeInteger(values.workloadRevision) ||
		!nonNegativeInteger(values.fence) ||
		!capturedText(values.requestId) ||
		!capturedText(values.traceId) ||
		(requiresReason &&
			!failureCodes.includes(values.failureCode as AgentFailureCodeV1))
	) {
		invalidInput();
	}
	return structuredClone(
		values,
	) as unknown as AgentManagementWorkloadObservationV1;
}

function parseAccessQuery(input: unknown): AgentAccessQueryV1 {
	const values = snapshotDataObject(input);
	requireExactKeys(values, ["schemaVersion", "agentId", "intent"]);
	if (
		values.schemaVersion !== 1 ||
		!capturedText(values.agentId) ||
		(values.intent !== "discover" &&
			values.intent !== "use" &&
			values.intent !== "manage")
	) {
		invalidInput();
	}
	return {
		schemaVersion: 1,
		agentId: values.agentId,
		intent: values.intent,
	};
}

const systemNow = () => new Date();

function capturedNow(now: () => Date): Date {
	try {
		const milliseconds = Date.prototype.getTime.call(now());
		if (!Number.isFinite(milliseconds)) throw new Error();
		return new Date(milliseconds);
	} catch {
		throw new AgentManagementError("unavailable");
	}
}

async function adapterResult<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch {
		throw new AgentManagementError("unavailable");
	}
}

function requireAggregateIdentity(actual: string, expected: string): void {
	if (actual !== expected) throw new AgentManagementError("unavailable");
}

function accepted(
	state: AgentManagementStateV1,
	command: AgentManagementCommandV1,
	actor: AgentManagementActorContextV1,
	nextStateInput: AgentManagementStateV1,
	action: AgentManagementWritePlanV1["auditEvent"]["action"],
	outboxDesiredState: "running" | "stopped" | null,
	requestDigest: string,
	now: () => Date,
): AgentManagementCommandDecisionV1 {
	const occurredAt = capturedNow(now);
	const nextState = nextStateInput;
	const subjectType =
		"applicationId" in command ? "agent_application" : "agent";
	const subjectId =
		subjectType === "agent_application" ? state.applicationId : state.agentId;
	const result: AgentManagementAcceptedResultV1 = {
		schemaVersion: 1,
		applicationId: state.applicationId,
		agentId: state.agentId,
		status: nextState.status,
		revision: nextState.revision,
	};
	return {
		outcome: "accepted",
		result,
		writePlan: {
			schemaVersion: 1,
			operation: command.command,
			subjectType,
			subjectId,
			expectedRevision: command.expectedRevision,
			state: nextState,
			transition: { from: state.status, to: nextState.status, occurredAt },
			outboxIntent:
				outboxDesiredState === null
					? null
					: {
							operation: "agent.workload.reconcile.v1",
							payload: {
								schemaVersion: 1,
								agentId: state.agentId,
								revision: nextState.revision,
								workloadRevision: nextState.workloadRevision,
								fence: nextState.fence,
								desiredState: outboxDesiredState,
							},
							traceId: command.traceId,
							requestId: command.requestId,
							occurredAt,
						},
			auditEvent: {
				action,
				actorId: actor.userId,
				subjectType,
				subjectId,
				traceId: command.traceId,
				requestId: command.requestId,
				occurredAt,
			},
			idempotency: {
				key: command.idempotencyKey,
				requestDigest,
			},
		},
	};
}

function acceptedObservation(
	state: AgentManagementStateV1,
	observation: AgentManagementWorkloadObservationV1,
	nextState: AgentManagementStateV1,
	action: AgentManagementWritePlanV1["auditEvent"]["action"],
	requestDigest: string,
	now: () => Date,
): AgentManagementObservationDecisionV1 {
	const occurredAt = capturedNow(now);
	return {
		outcome: "accepted",
		result: {
			schemaVersion: 1,
			applicationId: state.applicationId,
			agentId: state.agentId,
			status: nextState.status,
			revision: nextState.revision,
		},
		writePlan: {
			schemaVersion: 1,
			operation: `observe_${observation.observation}`,
			subjectType: "agent",
			subjectId: state.agentId,
			expectedRevision: observation.expectedRevision,
			state: nextState,
			transition: {
				from: state.status,
				to: nextState.status,
				occurredAt,
			},
			outboxIntent: null,
			auditEvent: {
				action,
				actorId: "platform_worker",
				subjectType: "agent",
				subjectId: state.agentId,
				traceId: observation.traceId,
				requestId: observation.requestId,
				occurredAt,
			},
			idempotency: {
				key: observation.observationId,
				requestDigest,
			},
		},
	};
}

export function createAgentManagementV1(
	transaction: AgentManagementTransactionPortV1,
	options: AgentManagementOptionsV1 = {},
): AgentManagementInterfaceV1 {
	const now = options.now ?? systemNow;
	return {
		async executeManagementCommand(commandInput, actorContextInput) {
			const command = parseCommand(commandInput);
			const actorContext = parseActorContext(actorContextInput);
			const applicationCommand = "applicationId" in command;
			const subjectType = applicationCommand ? "agent_application" : "agent";
			const subjectId = applicationCommand
				? command.applicationId
				: command.agentId;
			const requestDigest = platformIdempotencyV1.canonicalRequestDigest({
				...command,
			});
			return adapterResult(() =>
				transaction.executeAgentManagementTransaction(
					{
						operation: command.command,
						subjectType,
						subjectId,
						actorId: actorContext.userId,
						idempotencyKey: command.idempotencyKey,
						requestDigest,
					},
					(stateInput) => {
						const state = stateInput && portState(stateInput);
						if (state) {
							requireAggregateIdentity(
								applicationCommand ? state.applicationId : state.agentId,
								applicationCommand ? command.applicationId : command.agentId,
							);
						}
						if (!state || actorContext.accountStatus !== "active") {
							return { outcome: "denied", writePlan: null };
						}
						const administratorApplicationCommand =
							command.command === "approve_application" ||
							command.command === "reject_application";
						const owner = state.ownerIds.includes(actorContext.userId);
						const authorized = applicationCommand
							? administratorApplicationCommand
								? actorContext.isAdministrator
								: state.applicantId === actorContext.userId
							: command.command === "disable_agent"
								? actorContext.isAdministrator
								: command.command === "retry_agent_creation"
									? owner || actorContext.isAdministrator
									: owner;
						if (!authorized) {
							return { outcome: "denied", writePlan: null };
						}
						if (state.revision !== command.expectedRevision) {
							return {
								outcome: "conflict",
								reason: "stale_revision",
								writePlan: null,
							};
						}
						const advancesWorkload =
							command.command === "approve_application" || !applicationCommand;
						if (
							state.revision === Number.MAX_SAFE_INTEGER ||
							(advancesWorkload &&
								(state.workloadRevision === Number.MAX_SAFE_INTEGER ||
									state.fence === Number.MAX_SAFE_INTEGER))
						) {
							return {
								outcome: "conflict",
								reason: "counter_overflow",
								writePlan: null,
							};
						}
						if (command.command === "update_application") {
							if (
								state.status !== "pending_approval" &&
								state.status !== "rejected"
							) {
								return {
									outcome: "conflict",
									reason: "invalid_transition",
									writePlan: null,
								};
							}
							return accepted(
								state,
								command,
								actorContext,
								{
									...state,
									status: "pending_approval",
									revision: state.revision + 1,
									decisionReason: null,
								},
								state.status === "rejected"
									? "agent.application.resubmitted"
									: "agent.application.updated",
								null,
								requestDigest,
								now,
							);
						}
						if (command.command === "approve_application") {
							if (state.status !== "pending_approval") {
								return {
									outcome: "conflict",
									reason: "invalid_transition",
									writePlan: null,
								};
							}
							const nextState: AgentManagementStateV1 = {
								...state,
								status: "creating",
								revision: state.revision + 1,
								approvalRevision: state.revision + 1,
								decisionReason: null,
								desiredState: "running",
								workloadRevision: state.workloadRevision + 1,
								fence: state.fence + 1,
							};
							return accepted(
								state,
								command,
								actorContext,
								nextState,
								"agent.application.approved",
								"running",
								requestDigest,
								now,
							);
						}
						if (command.command === "reject_application") {
							if (state.status !== "pending_approval") {
								return {
									outcome: "conflict",
									reason: "invalid_transition",
									writePlan: null,
								};
							}
							return accepted(
								state,
								command,
								actorContext,
								{
									...state,
									status: "rejected",
									revision: state.revision + 1,
									decisionReason: command.reason,
								},
								"agent.application.rejected",
								null,
								requestDigest,
								now,
							);
						}
						if (
							command.command === "stop_agent" ||
							command.command === "restart_agent" ||
							command.command === "retry_agent_creation" ||
							command.command === "disable_agent"
						) {
							const validTransition =
								(command.command === "stop_agent" &&
									state.status === "available") ||
								(command.command === "restart_agent" &&
									(state.status === "stopped" ||
										state.status === "available")) ||
								(command.command === "retry_agent_creation" &&
									state.status === "creation_failed") ||
								(command.command === "disable_agent" &&
									(state.status === "creating" ||
										state.status === "available" ||
										state.status === "stopped" ||
										state.status === "creation_failed"));
							if (!validTransition) {
								return {
									outcome: "conflict",
									reason: "invalid_transition",
									writePlan: null,
								};
							}
							const transition = {
								stop_agent: {
									status: "stopped",
									serviceAvailability: null,
									desiredState: "stopped",
									action: "agent.lifecycle.stopped",
								},
								restart_agent: {
									status: "available",
									serviceAvailability: "starting",
									desiredState: "running",
									action: "agent.lifecycle.restarted",
								},
								retry_agent_creation: {
									status: "creating",
									serviceAvailability: null,
									desiredState: "running",
									action: "agent.lifecycle.creation_retried",
								},
								disable_agent: {
									status: "disabled",
									serviceAvailability: null,
									desiredState: "stopped",
									action: "agent.lifecycle.disabled",
								},
							} as const;
							const selected = transition[command.command];
							return accepted(
								state,
								command,
								actorContext,
								{
									...state,
									status: selected.status,
									revision: state.revision + 1,
									serviceAvailability: selected.serviceAvailability,
									desiredState: selected.desiredState,
									workloadRevision: state.workloadRevision + 1,
									fence: state.fence + 1,
								},
								selected.action,
								selected.desiredState,
								requestDigest,
								now,
							);
						}
						if (state.status !== "pending_approval") {
							return {
								outcome: "conflict",
								reason: "invalid_transition",
								writePlan: null,
							};
						}
						return accepted(
							state,
							command,
							actorContext,
							{
								...state,
								status: "withdrawn",
								revision: state.revision + 1,
							},
							"agent.application.withdrawn",
							null,
							requestDigest,
							now,
						);
					},
				),
			);
		},
		async recordWorkloadObservation(observationInput) {
			const observation = parseObservation(observationInput);
			const operation = `observe_${observation.observation}` as const;
			const requestDigest = platformIdempotencyV1.canonicalRequestDigest({
				...observation,
			});
			return adapterResult(() =>
				transaction.executeAgentManagementTransaction(
					{
						operation,
						subjectType: "agent",
						subjectId: observation.agentId,
						actorId: "platform_worker",
						idempotencyKey: observation.observationId,
						requestDigest,
					},
					(stateInput) => {
						const state = stateInput && portState(stateInput);
						if (state)
							requireAggregateIdentity(state.agentId, observation.agentId);
						if (
							!state ||
							state.revision !== observation.expectedRevision ||
							state.workloadRevision !== observation.workloadRevision ||
							state.fence !== observation.fence
						) {
							return {
								outcome: "conflict",
								reason: "stale_observation",
								writePlan: null,
							};
						}
						if (state.revision === Number.MAX_SAFE_INTEGER) {
							return {
								outcome: "conflict",
								reason: "counter_overflow",
								writePlan: null,
							};
						}
						const creationObservation =
							observation.observation === "creation_succeeded" ||
							observation.observation === "creation_failed";
						if (
							(creationObservation && state.status !== "creating") ||
							(!creationObservation && state.status !== "available")
						) {
							return {
								outcome: "conflict",
								reason: "invalid_observation",
								writePlan: null,
							};
						}
						const transitions = {
							creation_succeeded: {
								status: "available",
								serviceAvailability: "ready",
								failureCode: null,
								action: "agent.workload.creation_succeeded",
							},
							creation_failed: {
								status: "creation_failed",
								serviceAvailability: null,
								failureCode:
									observation.observation === "creation_failed"
										? observation.failureCode
										: state.failureCode,
								action: "agent.workload.creation_failed",
							},
							service_starting: {
								status: "available",
								serviceAvailability: "starting",
								failureCode: state.failureCode,
								action: "agent.workload.service_starting",
							},
							service_ready: {
								status: "available",
								serviceAvailability: "ready",
								failureCode: null,
								action: "agent.workload.service_ready",
							},
							service_updating: {
								status: "available",
								serviceAvailability: "updating",
								failureCode: state.failureCode,
								action: "agent.workload.service_updating",
							},
							service_unavailable: {
								status: "available",
								serviceAvailability: "unavailable",
								failureCode:
									observation.observation === "service_unavailable"
										? observation.failureCode
										: state.failureCode,
								action: "agent.workload.service_unavailable",
							},
						} as const;
						const selected = transitions[observation.observation];
						return acceptedObservation(
							state,
							observation,
							{
								...state,
								status: selected.status,
								revision: state.revision + 1,
								serviceAvailability: selected.serviceAvailability,
								failureCode: selected.failureCode,
							},
							selected.action,
							requestDigest,
							now,
						);
					},
				),
			);
		},
		async resolveAgentAccess(queryInput, actorContextInput) {
			const query = parseAccessQuery(queryInput);
			const actorContext = parseActorContext(actorContextInput);
			if (actorContext.accountStatus !== "active") {
				return { outcome: "denied" };
			}
			const stateInput = await adapterResult(() =>
				transaction.resolveAgentAccessState(query.agentId),
			);
			const state = stateInput && portState(stateInput);
			if (state) requireAggregateIdentity(state.agentId, query.agentId);
			if (!state) return { outcome: "denied" };
			const owner = state.ownerIds.includes(actorContext.userId);
			const directlyAvailable = state.availability.some(
				(target) =>
					target.kind === "user" && target.userId === actorContext.userId,
			);
			const organizationAvailable = state.availability.some(
				(target) =>
					target.kind === "organization" &&
					actorContext.organizationIds.includes(target.organizationId),
			);
			const allowed =
				query.intent === "manage"
					? owner
					: owner || directlyAvailable || organizationAvailable;
			if (!allowed) return { outcome: "denied" };
			return {
				outcome: "allowed",
				managementStatus: state.status,
				serviceAvailability: state.serviceAvailability,
				serviceReady:
					state.status === "available" && state.serviceAvailability === "ready",
			};
		},
	};
}
