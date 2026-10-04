import { pgSchema } from "drizzle-orm/pg-core";

export const platformSchema = pgSchema("platform");

export const platformStatusValues = {
	outboxStatus: [
		"pending",
		"processing",
		"retry_scheduled",
		"succeeded",
		"failed",
	],
	auditOutcome: ["succeeded", "rejected", "failed"],
	idempotencyStatus: ["reserved", "completed"],
	conversationStatus: ["ready", "active", "unavailable"],
	conversationExecutionStatus: [
		"waiting",
		"submitted",
		"processing",
		"unknown",
		"completed",
		"failed",
		"cancelled",
	],
	conversationMessageStatus: ["submitted", "failed"],
	conversationStopStatus: ["submitted", "completed"],
	agentManagementStatus: [
		"pending_approval",
		"withdrawn",
		"rejected",
		"creating",
		"available",
		"stopped",
		"creation_failed",
		"disabled",
	],
	agentServiceAvailability: ["ready", "starting", "updating", "unavailable"],
	agentDesiredState: ["running", "stopped"],
	agentFailureCode: [
		"creation_not_ready",
		"health_check_failed",
		"workload_unavailable",
		"reconciliation_failed",
	],
	agentAvailabilityTargetType: ["user", "organization", "application"],
	agentManagementSubjectType: ["agent_application", "agent"],
	agentManagementOperation: [
		"update_application",
		"withdraw_application",
		"approve_application",
		"reject_application",
		"stop_agent",
		"restart_agent",
		"retry_agent_creation",
		"disable_agent",
		"observe_creation_succeeded",
		"observe_creation_failed",
		"observe_service_starting",
		"observe_service_ready",
		"observe_service_updating",
		"observe_service_unavailable",
	],
	secretKeyRotationState: [
		"pending",
		"rewrapping",
		"verifying",
		"completed",
		"failed",
	],
} as const;

export const outboxStatus = platformSchema.enum("outbox_status", [
	...platformStatusValues.outboxStatus,
]);

export const auditOutcome = platformSchema.enum("audit_outcome", [
	...platformStatusValues.auditOutcome,
]);

export const idempotencyStatus = platformSchema.enum("idempotency_status", [
	...platformStatusValues.idempotencyStatus,
]);

export const conversationStatus = platformSchema.enum("conversation_status", [
	...platformStatusValues.conversationStatus,
]);

export const conversationExecutionStatus = platformSchema.enum(
	"conversation_execution_status",
	[...platformStatusValues.conversationExecutionStatus],
);

export const conversationMessageStatus = platformSchema.enum(
	"conversation_message_status",
	[...platformStatusValues.conversationMessageStatus],
);

export const conversationStopStatus = platformSchema.enum(
	"conversation_stop_status",
	[...platformStatusValues.conversationStopStatus],
);

export const agentManagementStatus = platformSchema.enum(
	"agent_management_status",
	[...platformStatusValues.agentManagementStatus],
);

export const agentServiceAvailability = platformSchema.enum(
	"agent_service_availability",
	[...platformStatusValues.agentServiceAvailability],
);

export const agentDesiredState = platformSchema.enum("agent_desired_state", [
	...platformStatusValues.agentDesiredState,
]);

export const agentFailureCode = platformSchema.enum("agent_failure_code", [
	...platformStatusValues.agentFailureCode,
]);

export const agentAvailabilityTargetType = platformSchema.enum(
	"agent_availability_target_type",
	[...platformStatusValues.agentAvailabilityTargetType],
);

export const agentManagementSubjectType = platformSchema.enum(
	"agent_management_subject_type",
	[...platformStatusValues.agentManagementSubjectType],
);

export const agentManagementOperation = platformSchema.enum(
	"agent_management_operation",
	[...platformStatusValues.agentManagementOperation],
);

export const secretKeyRotationState = platformSchema.enum(
	"secret_key_rotation_state",
	[...platformStatusValues.secretKeyRotationState],
);
