import type { PlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import type { AgentConfigurationRecordV1 } from "@agent-infra/platform-core";
import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	pgSchema,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";

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
	agentAvailabilityTargetType: ["user", "organization"],
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

export const agents = platformSchema.table(
	"agents",
	{
		id: text("id").primaryKey(),
		currentConfigurationRevision: bigint("current_configuration_revision", {
			mode: "number",
		})
			.default(1)
			.notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		authorizationRevision: text("authorization_revision"),
	},
	(table) => [
		check("agent_id_non_empty", sql`char_length(${table.id}) > 0`),
		check(
			"agent_configuration_revision_safe",
			sql`${table.currentConfigurationRevision} between 1 and 9007199254740991`,
		),
		check(
			"agent_authorization_revision_non_empty",
			sql`${table.authorizationRevision} IS NULL OR char_length(${table.authorizationRevision}) > 0`,
		),
	],
);

export const agentApplications = platformSchema.table(
	"agent_applications",
	{
		id: text("id").primaryKey(),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		applicantId: text("applicant_id").notNull(),
		name: varchar("name", { length: 200 }).notNull(),
		description: text("description").notNull(),
		status: agentManagementStatus("status")
			.default("pending_approval")
			.notNull(),
		traceId: text("trace_id").notNull(),
		requestId: text("request_id").notNull(),
		submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull(),
		managementRevision: bigint("management_revision", { mode: "number" })
			.default(0)
			.notNull(),
		approvalRevision: bigint("approval_revision", { mode: "number" }),
		decisionReason: text("decision_reason"),
		serviceAvailability: agentServiceAvailability("service_availability"),
		desiredState: agentDesiredState("desired_state")
			.default("stopped")
			.notNull(),
		workloadRevision: bigint("workload_revision", { mode: "number" })
			.default(0)
			.notNull(),
		fence: bigint("fence", { mode: "number" }).default(0).notNull(),
		failureCode: agentFailureCode("failure_code"),
	},
	(table) => [
		check("agent_application_id_non_empty", sql`char_length(${table.id}) > 0`),
		check(
			"agent_application_applicant_non_empty",
			sql`char_length(${table.applicantId}) > 0`,
		),
		check(
			"agent_application_name_non_empty",
			sql`char_length(${table.name}) > 0`,
		),
		check(
			"agent_application_description_non_empty",
			sql`char_length(${table.description}) > 0`,
		),
		check(
			"agent_application_trace_id_non_empty",
			sql`char_length(${table.traceId}) > 0`,
		),
		check(
			"agent_application_request_id_non_empty",
			sql`char_length(${table.requestId}) > 0`,
		),
		check(
			"agent_application_management_revision_safe",
			sql`${table.managementRevision} between 0 and 9007199254740991`,
		),
		check(
			"agent_application_approval_revision_safe",
			sql`${table.approvalRevision} IS NULL OR ${table.approvalRevision} between 1 and least(${table.managementRevision}, 9007199254740991)`,
		),
		check(
			"agent_application_workload_revision_safe",
			sql`${table.workloadRevision} between 0 and 9007199254740991`,
		),
		check(
			"agent_application_fence_safe",
			sql`${table.fence} between 0 and 9007199254740991`,
		),
		check(
			"agent_application_decision_reason_bounded",
			sql`${table.decisionReason} IS NULL OR (char_length(${table.decisionReason}) > 0 AND octet_length(${table.decisionReason}) <= 4096)`,
		),
		check(
			"agent_application_management_state_valid",
			sql`(
				${table.status} in ('pending_approval', 'withdrawn', 'rejected')
				and ${table.approvalRevision} is null
				and ${table.desiredState} = 'stopped'
				and ${table.serviceAvailability} is null
				and ${table.workloadRevision} = 0
				and ${table.fence} = 0
				and ${table.failureCode} is null
			) or (
				${table.status} not in ('pending_approval', 'withdrawn', 'rejected')
				and ${table.approvalRevision} is not null
				and ${table.workloadRevision} >= 1
				and ${table.fence} >= 1
				and (
					(${table.status} in ('creating', 'creation_failed') and ${table.desiredState} = 'running' and ${table.serviceAvailability} is null)
					or (${table.status} = 'available' and ${table.desiredState} = 'running' and ${table.serviceAvailability} is not null)
					or (${table.status} in ('stopped', 'disabled') and ${table.desiredState} = 'stopped' and ${table.serviceAvailability} is null)
				)
			)`,
		),
		check(
			"agent_application_decision_reason_state",
			sql`(${table.status} = 'rejected') = (${table.decisionReason} IS NOT NULL)`,
		),
		check(
			"agent_application_failure_code_state",
			sql`(${table.status} <> 'creation_failed' OR ${table.failureCode} IS NOT NULL)
				AND (${table.status} <> 'available' OR ${table.serviceAvailability} <> 'unavailable' OR ${table.failureCode} IS NOT NULL)
				AND (${table.status} <> 'available' OR ${table.serviceAvailability} <> 'ready' OR ${table.failureCode} IS NULL)`,
		),
		uniqueIndex("agent_application_agent_unique").on(table.agentId),
		index("agent_application_applicant_status_idx").on(
			table.applicantId,
			table.status,
		),
		index("agent_application_agent_status_idx").on(table.agentId, table.status),
	],
);

export const agentConfigurationRevisions = platformSchema.table(
	"agent_configuration_revisions",
	{
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		revision: bigint("revision", { mode: "number" }).notNull(),
		sourceReference: text("source_reference").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		configuration: jsonb("configuration").$type<AgentConfigurationRecordV1>(),
	},
	(table) => [
		primaryKey({ columns: [table.agentId, table.revision] }),
		check(
			"agent_configuration_revision_number_safe",
			sql`${table.revision} between 1 and 9007199254740991`,
		),
		check(
			"agent_configuration_source_reference_non_empty",
			sql`char_length(${table.sourceReference}) > 0`,
		),
		check(
			"agent_configuration_identity_matches",
			sql`${table.configuration} IS NULL OR (
				jsonb_typeof(${table.configuration}) = 'object'
				and ${table.configuration} @> jsonb_build_object(
					'schemaVersion', 1,
					'agentId', ${table.agentId},
					'revision', ${table.revision}
				)
			)`,
		),
	],
);

export const platformSecretRecords = platformSchema.table(
	"secret_records",
	{
		agentId: text("agent_id").notNull(),
		secretId: text("secret_id").notNull(),
		secretVersion: bigint("secret_version", { mode: "number" }).notNull(),
		configurationRevision: bigint("configuration_revision", {
			mode: "number",
		}).notNull(),
		ownerType: varchar("owner_type", { length: 32 }).notNull(),
		ownerId: text("owner_id").notNull(),
		name: text("name").notNull(),
		lifecycleState: varchar("lifecycle_state", { length: 32 })
			.default("pending")
			.notNull(),
		dekFingerprint: varchar("dek_fingerprint", { length: 64 }).notNull(),
		record: jsonb("record").$type<PlatformSecretRecordV1>().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		primaryKey({
			columns: [
				table.agentId,
				table.secretId,
				table.secretVersion,
				table.configurationRevision,
			],
		}),
		foreignKey({
			columns: [table.agentId, table.configurationRevision],
			foreignColumns: [
				agentConfigurationRevisions.agentId,
				agentConfigurationRevisions.revision,
			],
			name: "secret_record_configuration_revision_fk",
		}),
		check(
			"secret_record_agent_id_non_empty",
			sql`char_length(${table.agentId}) > 0`,
		),
		check(
			"secret_record_id_non_empty",
			sql`char_length(${table.secretId}) > 0`,
		),
		check(
			"secret_record_owner_id_non_empty",
			sql`char_length(${table.ownerId}) > 0`,
		),
		check("secret_record_name_non_empty", sql`char_length(${table.name}) > 0`),
		check(
			"secret_record_version_safe",
			sql`${table.secretVersion} between 1 and 9007199254740991`,
		),
		check(
			"secret_record_configuration_revision_safe",
			sql`${table.configurationRevision} between 1 and 9007199254740991`,
		),
		check(
			"secret_record_owner_type",
			sql`${table.ownerType} in ('agent-owner', 'platform')`,
		),
		check(
			"secret_record_lifecycle_state",
			sql`${table.lifecycleState} = 'pending'`,
		),
		check(
			"secret_record_dek_fingerprint_format",
			sql`${table.dekFingerprint} ~ '^[a-f0-9]{64}$'`,
		),
		check(
			"secret_record_identity_matches",
			sql`jsonb_typeof(${table.record}) = 'object' and ${table.record} @> jsonb_build_object(
				'schemaVersion', 1,
				'agentId', ${table.agentId},
				'secretId', ${table.secretId},
				'secretVersion', ${table.secretVersion},
				'configRevision', ${table.configurationRevision},
				'ownerType', ${table.ownerType},
				'ownerId', ${table.ownerId},
				'name', ${table.name},
				'lifecycleState', ${table.lifecycleState},
				'crypto', jsonb_build_object('dekFingerprint', ${table.dekFingerprint})
			)`,
		),
		uniqueIndex("secret_record_dek_fingerprint_unique").on(
			table.dekFingerprint,
		),
	],
);

export const agentOwners = platformSchema.table(
	"agent_owners",
	{
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		ownerId: text("owner_id").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.agentId, table.ownerId] }),
		check("agent_owner_id_non_empty", sql`char_length(${table.ownerId}) > 0`),
		index("agent_owner_lookup_idx").on(table.ownerId, table.agentId),
	],
);

export const agentAvailability = platformSchema.table(
	"agent_availability",
	{
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		targetType: agentAvailabilityTargetType("target_type").notNull(),
		targetId: text("target_id").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.agentId, table.targetType, table.targetId] }),
		check(
			"agent_availability_target_id_non_empty",
			sql`char_length(${table.targetId}) > 0`,
		),
		index("agent_availability_target_lookup_idx").on(
			table.targetType,
			table.targetId,
			table.agentId,
		),
	],
);

export const agentManagementHistory = platformSchema.table(
	"agent_management_history",
	{
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		revision: bigint("revision", { mode: "number" }).notNull(),
		applicationId: text("application_id").notNull(),
		subjectType: agentManagementSubjectType("subject_type").notNull(),
		subjectId: text("subject_id").notNull(),
		operation: agentManagementOperation("operation").notNull(),
		fromStatus: agentManagementStatus("from_status").notNull(),
		toStatus: agentManagementStatus("to_status").notNull(),
		occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.agentId, table.revision] }),
		foreignKey({
			columns: [table.applicationId],
			foreignColumns: [agentApplications.id],
			name: "agent_management_history_application_fk",
		}),
		check(
			"agent_management_history_revision_safe",
			sql`${table.revision} between 1 and 9007199254740991`,
		),
		check(
			"agent_management_history_subject_id_non_empty",
			sql`char_length(${table.subjectId}) > 0`,
		),
		index("agent_management_history_application_idx").on(
			table.applicationId,
			table.revision,
		),
	],
);

export const outboxItems = platformSchema.table(
	"outbox_items",
	{
		id: text("id").primaryKey(),
		scopeType: varchar("scope_type", { length: 64 }).notNull(),
		scopeId: text("scope_id").notNull(),
		operation: varchar("operation", { length: 128 }).notNull(),
		payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
		status: outboxStatus("status").default("pending").notNull(),
		attemptCount: integer("attempt_count").default(0).notNull(),
		availableAt: timestamp("available_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		leaseOwner: text("lease_owner"),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		deliveryFence: bigint("delivery_fence", { mode: "bigint" })
			.default(sql`0`)
			.notNull(),
		traceId: text("trace_id").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		requestId: text("request_id"),
	},
	(table) => [
		check("outbox_id_non_empty", sql`char_length(${table.id}) > 0`),
		check(
			"outbox_scope_type_non_empty",
			sql`char_length(${table.scopeType}) > 0`,
		),
		check("outbox_scope_id_non_empty", sql`char_length(${table.scopeId}) > 0`),
		check(
			"outbox_operation_non_empty",
			sql`char_length(${table.operation}) > 0`,
		),
		check("outbox_trace_id_non_empty", sql`char_length(${table.traceId}) > 0`),
		check(
			"outbox_request_id_non_empty",
			sql`${table.requestId} IS NULL OR char_length(${table.requestId}) > 0`,
		),
		check("outbox_attempt_count_non_negative", sql`${table.attemptCount} >= 0`),
		check(
			"outbox_delivery_fence_non_negative",
			sql`${table.deliveryFence} >= 0`,
		),
		check(
			"outbox_lease_pair",
			sql`(${table.leaseOwner} IS NULL) = (${table.leaseExpiresAt} IS NULL)`,
		),
		check(
			"outbox_lease_owner_non_empty",
			sql`${table.leaseOwner} IS NULL OR char_length(${table.leaseOwner}) > 0`,
		),
		check(
			"outbox_processing_lease",
			sql`(${table.status} = 'processing') = (${table.leaseOwner} IS NOT NULL)`,
		),
		index("outbox_eligibility_idx").on(table.status, table.availableAt),
	],
);

export const auditEvents = platformSchema.table(
	"audit_events",
	{
		id: text("id").primaryKey(),
		traceId: text("trace_id").notNull(),
		actorType: varchar("actor_type", { length: 64 }).notNull(),
		actorId: text("actor_id").notNull(),
		action: varchar("action", { length: 128 }).notNull(),
		targetType: varchar("target_type", { length: 64 }).notNull(),
		targetId: text("target_id").notNull(),
		outcome: auditOutcome("outcome").notNull(),
		occurredAt: timestamp("occurred_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		requestId: text("request_id"),
		agentId: text("agent_id"),
		details: jsonb("details").$type<Record<string, unknown>>(),
	},
	(table) => [
		check("audit_id_non_empty", sql`char_length(${table.id}) > 0`),
		check("audit_trace_id_non_empty", sql`char_length(${table.traceId}) > 0`),
		check(
			"audit_request_id_non_empty",
			sql`${table.requestId} IS NULL OR char_length(${table.requestId}) > 0`,
		),
		check(
			"audit_agent_id_non_empty",
			sql`${table.agentId} IS NULL OR char_length(${table.agentId}) > 0`,
		),
		check(
			"audit_actor_type_non_empty",
			sql`char_length(${table.actorType}) > 0`,
		),
		check("audit_actor_id_non_empty", sql`char_length(${table.actorId}) > 0`),
		check("audit_action_non_empty", sql`char_length(${table.action}) > 0`),
		check(
			"audit_target_type_non_empty",
			sql`char_length(${table.targetType}) > 0`,
		),
		check("audit_target_id_non_empty", sql`char_length(${table.targetId}) > 0`),
		index("audit_trace_idx").on(table.traceId),
	],
);

export const idempotencyRecords = platformSchema.table(
	"idempotency_records",
	{
		id: text("id").primaryKey(),
		scopeType: varchar("scope_type", { length: 64 }).notNull(),
		scopeId: text("scope_id").notNull(),
		actorId: text("actor_id").notNull(),
		commandType: varchar("command_type", { length: 64 }).notNull(),
		idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
		requestDigest: varchar("request_digest", { length: 64 }).notNull(),
		status: idempotencyStatus("status").default("reserved").notNull(),
		result: jsonb("result").$type<Record<string, unknown>>(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check("idempotency_id_non_empty", sql`char_length(${table.id}) > 0`),
		check(
			"idempotency_scope_type_non_empty",
			sql`char_length(${table.scopeType}) > 0`,
		),
		check(
			"idempotency_scope_id_non_empty",
			sql`char_length(${table.scopeId}) > 0`,
		),
		check(
			"idempotency_actor_id_non_empty",
			sql`char_length(${table.actorId}) > 0`,
		),
		check(
			"idempotency_command_type_non_empty",
			sql`char_length(${table.commandType}) > 0`,
		),
		check(
			"idempotency_key_format",
			sql`${table.idempotencyKey} ~ '^[A-Za-z0-9._~-]{1,128}$'`,
		),
		check(
			"idempotency_digest_format",
			sql`${table.requestDigest} ~ '^[a-f0-9]{64}$'`,
		),
		check(
			"idempotency_result_state",
			sql`(${table.status} = 'reserved' AND ${table.result} IS NULL) OR (${table.status} = 'completed' AND ${table.result} IS NOT NULL)`,
		),
		uniqueIndex("idempotency_scope_key_unique").on(
			table.scopeType,
			table.scopeId,
			table.actorId,
			table.commandType,
			table.idempotencyKey,
		),
	],
);

export const persistedEvents = platformSchema.table(
	"persisted_events",
	{
		eventId: text("event_id").primaryKey(),
		streamId: text("stream_id").notNull(),
		sequence: bigint("sequence", { mode: "bigint" }).notNull(),
		streamCursor: bigint("stream_cursor", { mode: "bigint" }).notNull(),
		eventType: varchar("event_type", { length: 128 }).notNull(),
		payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
		traceId: text("trace_id").notNull(),
		occurredAt: timestamp("occurred_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check(
			"persisted_event_id_non_empty",
			sql`char_length(${table.eventId}) > 0`,
		),
		check(
			"persisted_event_stream_id_non_empty",
			sql`char_length(${table.streamId}) > 0`,
		),
		check(
			"persisted_event_trace_id_non_empty",
			sql`char_length(${table.traceId}) > 0`,
		),
		check(
			"persisted_event_type_non_empty",
			sql`char_length(${table.eventType}) > 0`,
		),
		check("persisted_event_sequence_non_negative", sql`${table.sequence} >= 0`),
		check(
			"persisted_event_cursor_non_negative",
			sql`${table.streamCursor} >= 0`,
		),
		uniqueIndex("persisted_event_stream_sequence_unique").on(
			table.streamId,
			table.sequence,
		),
		uniqueIndex("persisted_event_stream_cursor_unique").on(
			table.streamId,
			table.streamCursor,
		),
	],
);

export const platformInfrastructureTables = [
	agents,
	agentApplications,
	agentConfigurationRevisions,
	platformSecretRecords,
	agentOwners,
	agentAvailability,
	agentManagementHistory,
	outboxItems,
	auditEvents,
	idempotencyRecords,
	persistedEvents,
] as const;
