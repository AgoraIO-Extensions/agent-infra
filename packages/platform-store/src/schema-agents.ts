import type { PlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import type {
	AgentConfigurationRecordV1,
	AgentConfigurationRecordV2,
	WorkloadReconciliationStateV1,
} from "@agent-infra/platform-core";
import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	foreignKey,
	index,
	jsonb,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import {
	agentAvailabilityTargetType,
	agentDesiredState,
	agentFailureCode,
	agentManagementOperation,
	agentManagementStatus,
	agentManagementSubjectType,
	agentServiceAvailability,
	platformSchema,
	secretKeyRotationState,
} from "./schema-common";

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
		secretActivationFence: bigint("secret_activation_fence", { mode: "number" })
			.default(0)
			.notNull(),
		secretActivationOwner: text("secret_activation_owner"),
		secretActivationLeaseExpiresAt: timestamp(
			"secret_activation_lease_expires_at",
			{ withTimezone: true },
		),
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
		check(
			"agent_secret_activation_fence_safe",
			sql`${table.secretActivationFence} between 0 and 9007199254740991`,
		),
		check(
			"agent_secret_activation_claim_valid",
			sql`(
				${table.secretActivationOwner} is null
				and ${table.secretActivationLeaseExpiresAt} is null
			) or (
				char_length(${table.secretActivationOwner}) > 0
				and ${table.secretActivationLeaseExpiresAt} is not null
				and ${table.secretActivationFence} >= 1
			)`,
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
					and ((${table.status} = 'creating' and ${table.approvalRevision} is null) or ${table.approvalRevision} is not null)
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
		configuration: jsonb("configuration").$type<
			AgentConfigurationRecordV1 | AgentConfigurationRecordV2
		>(),
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
				and ${table.configuration} ? 'schemaVersion'
                and ${table.configuration}->'schemaVersion' in ('1'::jsonb, '2'::jsonb)
                and ${table.configuration} @> jsonb_build_object(
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
		wrappingKeyVersion: text("wrapping_key_version").notNull(),
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
			sql`${table.lifecycleState} in ('pending', 'applying', 'observed', 'active', 'failed')`,
		),
		check(
			"secret_record_dek_fingerprint_format",
			sql`${table.dekFingerprint} ~ '^[a-f0-9]{64}$'`,
		),
		check(
			"secret_record_wrapping_key_version_non_empty",
			sql`char_length(${table.wrappingKeyVersion}) > 0`,
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
				'crypto', jsonb_build_object(
					'dekFingerprint', ${table.dekFingerprint},
					'wrappingKeyVersion', ${table.wrappingKeyVersion}
				)
			)`,
		),
		uniqueIndex("secret_record_dek_fingerprint_unique").on(
			table.dekFingerprint,
		),
		uniqueIndex("secret_record_agent_secret_version_unique").on(
			table.agentId,
			table.secretId,
			table.secretVersion,
		),
		index("secret_record_wrapping_key_version_idx").on(
			table.wrappingKeyVersion,
		),
	],
);

export const secretKeyRotations = platformSchema.table(
	"secret_key_rotations",
	{
		rotationId: text("rotation_id").primaryKey(),
		sourceKeyVersions: text("source_key_versions").array().notNull(),
		targetKeyVersion: text("target_key_version").notNull(),
		state: secretKeyRotationState("state").default("pending").notNull(),
		processedSecrets: bigint("processed_secrets", { mode: "number" })
			.default(0)
			.notNull(),
		remainingSecrets: bigint("remaining_secrets", { mode: "number" })
			.default(0)
			.notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check(
			"secret_key_rotation_id_non_empty",
			sql`char_length(${table.rotationId}) > 0`,
		),
		check(
			"secret_key_rotation_sources_non_empty",
			sql`cardinality(${table.sourceKeyVersions}) > 0`,
		),
		check(
			"secret_key_rotation_target_non_empty",
			sql`char_length(${table.targetKeyVersion}) > 0`,
		),
		check(
			"secret_key_rotation_counts_safe",
			sql`${table.processedSecrets} between 0 and 9007199254740991 and ${table.remainingSecrets} between 0 and 9007199254740991`,
		),
		check(
			"secret_key_rotation_completed_empty",
			sql`${table.state} <> 'completed' or ${table.remainingSecrets} = 0`,
		),
	],
);

export const retiredSecretWrappingKeys = platformSchema.table(
	"retired_secret_wrapping_keys",
	{
		keyVersion: text("key_version").primaryKey(),
		retiredAt: timestamp("retired_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check(
			"retired_secret_wrapping_key_non_empty",
			sql`char_length(${table.keyVersion}) > 0`,
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

export const workloadReconciliations = platformSchema.table(
	"workload_reconciliations",
	{
		agentId: text("agent_id")
			.primaryKey()
			.references(() => agents.id),
		revision: bigint("revision", { mode: "number" }).notNull(),
		state: jsonb("state").$type<WorkloadReconciliationStateV1>().notNull(),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check(
			"workload_reconciliation_revision_safe",
			sql`${table.revision} between 1 and 9007199254740991`,
		),
		check(
			"workload_reconciliation_identity",
			sql`jsonb_typeof(${table.state}) = 'object' and ${table.state} @> jsonb_build_object('schemaVersion', 1, 'agentId', ${table.agentId}, 'revision', ${table.revision})`,
		),
		index("workload_reconciliation_due_idx").on(table.nextAttemptAt),
	],
);
