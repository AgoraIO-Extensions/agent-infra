import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	index,
	integer,
	jsonb,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents } from "./schema-agents";
import { platformSchema } from "./schema-common";
import { conversations } from "./schema-conversations";

export const wecomReceipts = platformSchema.table(
	"wecom_receipts",
	{
		id: text("id").primaryKey(),
		requestDigest: text("request_digest").notNull(),
		scope: jsonb("scope").notNull(),
		actorId: text("actor_id").notNull(),
		taskBoundary: jsonb("task_boundary").notNull(),
		channelRevision: text("channel_revision").notNull(),
		authorizationRevision: text("authorization_revision").notNull(),
		acceptanceStatus: text("acceptance_status").notNull(),
		conversationId: text("conversation_id"),
		executionId: text("execution_id"),
		replyHandle: text("reply_handle").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		deliveryStatus: text("delivery_status").notNull().default("pending"),
		fence: integer("fence").notNull().default(0),
		leaseUntil: timestamp("lease_until", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		connectionBotId: text("connection_bot_id"),
		connectionFence: bigint("connection_fence", { mode: "number" }),
	},
	(table) => [
		check(
			"wecom_acceptance_status",
			sql`${table.acceptanceStatus} in ('accepted','busy','unavailable')`,
		),
		check(
			"wecom_delivery_status",
			sql`${table.deliveryStatus} in ('pending','claimed','sending','sent','failed','unknown','cancelled','expired','abandoned')`,
		),
		index("wecom_delivery_pending").on(table.deliveryStatus, table.createdAt),
	],
);

export const wecomConnections = platformSchema.table(
	"wecom_connections",
	{
		botId: text("bot_id").primaryKey(),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		bindingReference: text("binding_reference").notNull(),
		holderId: text("holder_id").notNull(),
		fence: bigint("fence", { mode: "number" }).notNull(),
		leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
		status: text("status").notNull(),
	},
	(table) => [
		check(
			"wecom_connection_fence_safe",
			sql`${table.fence} between 1 and 9007199254740991`,
		),
		check(
			"wecom_connection_status",
			sql`${table.status} in ('verifying','connected','disconnected','auth_failed')`,
		),
	],
);

export const wecomSetupSessions = platformSchema.table(
	"wecom_setup_sessions",
	{
		sessionId: text("session_id").primaryKey(),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		actorId: text("actor_id").notNull(),
		configurationRevision: bigint("configuration_revision", {
			mode: "number",
		}).notNull(),
		authorizationRevision: text("authorization_revision").notNull(),
		stateDigest: text("state_digest").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		status: text("status").notNull(),
		botId: text("bot_id"),
		encryptedCredential: jsonb("encrypted_credential"),
	},
	(table) => [
		check(
			"wecom_setup_status",
			sql`${table.status} in ('awaiting_input','verifying','active','auth_failed','conflict','cancelled','expired')`,
		),
		index("wecom_setup_pending").on(table.status, table.expiresAt),
	],
);

export const platformFiles = platformSchema.table(
	"files",
	{
		fileId: text("file_id").primaryKey(),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id),
		actorId: text("actor_id").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		record: jsonb("record")
			.$type<import("@agent-infra/platform-core").FileRecordV1>()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		uniqueIndex("file_actor_idempotency_unique").on(
			table.actorId,
			table.idempotencyKey,
		),
		index("file_conversation_idx").on(table.conversationId),
		uniqueIndex("file_object_ref_unique").on(
			sql`(${table.record}->>'objectRef')`,
		),
		index("file_pending_reconciliation_idx")
			.on(table.updatedAt)
			.where(sql`${table.record}->>'status' = 'pending'`),
		index("file_message_idx").on(
			table.conversationId,
			sql`(${table.record}->>'messageId')`,
		),
		check(
			"file_record_binding",
			sql`${table.record}->>'fileId' = ${table.fileId} AND ${table.record}->>'conversationId' = ${table.conversationId} AND ${table.record}->>'actorId' = ${table.actorId} AND ${table.record}->>'idempotencyKey' = ${table.idempotencyKey}`,
		),
		check(
			"file_state_valid",
			sql`${table.record}->>'status' IN ('pending','available','failed','expired','deleting','deleted')`,
		),
	],
);

export const platformFileAccesses = platformSchema.table(
	"file_accesses",
	{
		accessId: text("access_id").primaryKey(),
		operation: text("operation").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		fileId: text("file_id")
			.notNull()
			.references(() => platformFiles.fileId),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id),
		record: jsonb("record")
			.$type<import("@agent-infra/platform-core").FileAccessRecordV1>()
			.notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		index("file_access_expiry_idx").on(table.expiresAt),
		uniqueIndex("file_access_idempotency_unique").on(
			table.fileId,
			table.operation,
			table.idempotencyKey,
		),
		check(
			"file_access_record_binding",
			sql`${table.record}->>'accessId' = ${table.accessId} AND ${table.record}->>'fileId' = ${table.fileId} AND ${table.record}->>'conversationId' = ${table.conversationId}`,
		),
	],
);

export const fileReconciliation = platformSchema.table("file_reconciliation", {
	id: integer("id").primaryKey(),
	cursor: text("cursor"),
});
