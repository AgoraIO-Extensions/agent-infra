import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	index,
	integer,
	jsonb,
	pgSchema,
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
	},
	(table) => [
		check("outbox_id_non_empty", sql`char_length(${table.id}) > 0`),
		check("outbox_scope_id_non_empty", sql`char_length(${table.scopeId}) > 0`),
		check("outbox_trace_id_non_empty", sql`char_length(${table.traceId}) > 0`),
		check("outbox_attempt_count_non_negative", sql`${table.attemptCount} >= 0`),
		check(
			"outbox_delivery_fence_non_negative",
			sql`${table.deliveryFence} >= 0`,
		),
		check(
			"outbox_lease_pair",
			sql`(${table.leaseOwner} IS NULL) = (${table.leaseExpiresAt} IS NULL)`,
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
	},
	(table) => [
		check("audit_id_non_empty", sql`char_length(${table.id}) > 0`),
		check("audit_trace_id_non_empty", sql`char_length(${table.traceId}) > 0`),
		check("audit_actor_id_non_empty", sql`char_length(${table.actorId}) > 0`),
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
			"idempotency_scope_id_non_empty",
			sql`char_length(${table.scopeId}) > 0`,
		),
		check(
			"idempotency_actor_id_non_empty",
			sql`char_length(${table.actorId}) > 0`,
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
	outboxItems,
	auditEvents,
	idempotencyRecords,
	persistedEvents,
] as const;
