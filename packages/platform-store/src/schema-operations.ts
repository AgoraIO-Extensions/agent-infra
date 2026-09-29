import type { TaskAuthorizationBoundaryV1 } from "@agent-infra/platform-core";
import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import {
	auditOutcome,
	idempotencyStatus,
	outboxStatus,
	platformSchema,
} from "./schema-common";
import { conversationExecutions } from "./schema-conversations";

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

export const taskAuthorizationRecords = platformSchema.table(
	"task_authorization_records",
	{
		id: text("id").primaryKey(),
		executionId: text("execution_id").notNull(),
		boundary: jsonb("boundary").$type<TaskAuthorizationBoundaryV1>().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [table.executionId],
			foreignColumns: [conversationExecutions.executionId],
			name: "task_authorization_execution_fk",
		}),
		uniqueIndex("task_authorization_execution_unique").on(table.executionId),
		uniqueIndex("task_authorization_id_execution_unique").on(
			table.id,
			table.executionId,
		),
		check("task_authorization_id_non_empty", sql`char_length(${table.id}) > 0`),
		check(
			"task_authorization_boundary_version",
			sql`(${table.boundary}->'schemaVersion' = '1'::jsonb) IS TRUE`,
		),
	],
);

export const taskControlRecords = platformSchema.table(
	"task_control_records",
	{
		id: text("id").primaryKey(),
		executionId: text("execution_id").notNull(),
		authorizationRecordId: text("authorization_record_id").notNull(),
		reason: text("reason").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.executionId],
			foreignColumns: [conversationExecutions.executionId],
			name: "task_control_execution_fk",
		}),
		foreignKey({
			columns: [table.authorizationRecordId],
			foreignColumns: [taskAuthorizationRecords.id],
			name: "task_control_authorization_fk",
		}),
		foreignKey({
			columns: [table.authorizationRecordId, table.executionId],
			foreignColumns: [
				taskAuthorizationRecords.id,
				taskAuthorizationRecords.executionId,
			],
			name: "task_control_authorization_execution_fk",
		}),
		uniqueIndex("task_control_execution_reason_unique").on(
			table.executionId,
			table.reason,
		),
		uniqueIndex("task_control_id_execution_unique").on(
			table.id,
			table.executionId,
		),
		check("task_control_id_non_empty", sql`char_length(${table.id}) > 0`),
		check(
			"task_control_reason_valid",
			sql`${table.reason} in ('stop', 'authorization_revoked', 'recovery', 'generation_isolation')`,
		),
	],
);

export const conversationGenerationTombstones = platformSchema.table(
	"conversation_generation_tombstones",
	{
		operationId: text("operation_id").primaryKey(),
		conversationId: text("conversation_id").notNull(),
		sessionGeneration: bigint("session_generation", {
			mode: "number",
		}).notNull(),
		executionId: text("execution_id").notNull(),
		itemId: text("item_id").notNull(),
		controlRecordId: text("control_record_id").notNull(),
		controlSourceId: text("control_source_id").notNull(),
		originalPrincipal: jsonb("original_principal")
			.$type<{ kind: "user"; id: string }>()
			.notNull(),
		hostSessionRef: text("host_session_ref").notNull(),
		status: text("status").notNull().default("pending"),
		failureCode: text("failure_code").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [
				table.executionId,
				table.conversationId,
				table.sessionGeneration,
			],
			foreignColumns: [
				conversationExecutions.executionId,
				conversationExecutions.conversationId,
				conversationExecutions.sessionGeneration,
			],
			name: "conversation_generation_execution_binding_fk",
		}),
		foreignKey({
			columns: [table.controlRecordId, table.executionId],
			foreignColumns: [taskControlRecords.id, taskControlRecords.executionId],
			name: "conversation_generation_control_execution_fk",
		}),
		uniqueIndex("conversation_generation_tombstone_unique").on(
			table.conversationId,
			table.sessionGeneration,
		),
		uniqueIndex("conversation_generation_control_unique").on(
			table.controlRecordId,
		),
		index("conversation_generation_pending_idx").on(table.status, table.itemId),
		check(
			"conversation_generation_tombstone_generation_safe",
			sql`${table.sessionGeneration} between 1 and 9007199254740990`,
		),
		check(
			"conversation_generation_tombstone_status_valid",
			sql`(${table.status} = 'pending' and ${table.confirmedAt} is null) or (${table.status} = 'confirmed' and ${table.confirmedAt} is not null)`,
		),
		check(
			"conversation_generation_tombstone_reason_valid",
			sql`${table.failureCode} = 'RUNTIME_SESSION_RECOVERY_FAILED'`,
		),
		check(
			"conversation_generation_tombstone_principal_valid",
			sql`${table.originalPrincipal}->>'kind' = 'user' and char_length(${table.originalPrincipal}->>'id') > 0`,
		),
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
