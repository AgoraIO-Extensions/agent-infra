import { sql } from "drizzle-orm";
import {
	bigint,
	char,
	check,
	index,
	integer,
	jsonb,
	primaryKey,
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
		connectionAuthorizationFact: jsonb("connection_authorization_fact"),
		// #3227：入站媒体拒绝的原因与生效上限；不保存下载地址、aeskey 或媒体内容。
		mediaRejectionReason: text("media_rejection_reason"),
		mediaRejectionMaxBytes: bigint("media_rejection_max_bytes", {
			mode: "number",
		}),
		// #3377：长连接流式进度已持久化的最后一帧序号（工程 Spec §14.2.4）。每帧发送前在当前连接
		// 持有者租约与隔离令牌下递增；持有者切换后新持有者从这里之后继续，旧持有者的迟到帧不被采用。
		streamFrameSeq: integer("stream_frame_seq").notNull().default(0),
	},
	(table) => [
		check(
			"wecom_acceptance_status",
			sql`${table.acceptanceStatus} in ('accepted','busy','unavailable','new_conversation','media_rejected')`,
		),
		// 只有媒体拒绝回执带原因；只有超限带正的字节上限。
		check(
			"wecom_media_rejection",
			sql`(${table.acceptanceStatus} = 'media_rejected') = (${table.mediaRejectionReason} is not null) and (${table.mediaRejectionReason} is null or ${table.mediaRejectionReason} in ('unsupported_channel','unsupported_type','too_large','expired','failed')) and (${table.mediaRejectionReason} is not distinct from 'too_large') = (${table.mediaRejectionMaxBytes} is not null) and (${table.mediaRejectionMaxBytes} is null or ${table.mediaRejectionMaxBytes} between 1 and 9007199254740991)`,
		),
		check("wecom_stream_frame_seq", sql`${table.streamFrameSeq} >= 0`),
		check(
			"wecom_delivery_status",
			sql`${table.deliveryStatus} in ('pending','claimed','sending','sent','failed','unknown','cancelled','expired','abandoned')`,
		),
		index("wecom_delivery_pending").on(table.deliveryStatus, table.createdAt),
	],
);

/**
 * #3229：长连接回复中每个结果文件的发送进度（工程 Spec §14.2.3）。领取后推进到 sending 的同一事务
 * 按发送顺序写入，之后只能 pending → sending → sent/failed/unknown 前进，已开始的媒体不会再次发送。
 * 只保存文件引用、消息类型与进度，不保存 media_id、File Grant 或文件内容。
 */
export const wecomReceiptMedia = platformSchema.table(
	"wecom_receipt_media",
	{
		receiptId: text("receipt_id")
			.notNull()
			.references(() => wecomReceipts.id),
		ordinal: integer("ordinal").notNull(),
		fileId: text("file_id").notNull(),
		kind: text("kind").notNull(),
		status: text("status").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.receiptId, table.ordinal] }),
		uniqueIndex("wecom_receipt_media_file").on(table.receiptId, table.fileId),
		check("wecom_receipt_media_ordinal", sql`${table.ordinal} between 0 and 9`),
		check(
			"wecom_receipt_media_kind",
			sql`${table.kind} in ('image','video','file')`,
		),
		check(
			"wecom_receipt_media_status",
			sql`${table.status} in ('pending','sending','sent','failed','unknown')`,
		),
	],
);

/**
 * 企微会话映射的当前轮次（#3184）。没有行即轮次 0，沿用原映射；发送者每发一次 `/new` 加一，
 * 之后的消息按新轮次创建新的 Conversation。映射键是 Core 计算的不透明摘要，不含企微标识原文。
 */
export const wecomConversationRotations = platformSchema.table(
	"wecom_conversation_rotations",
	{
		mappingKey: text("mapping_key").primaryKey(),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		rotation: integer("rotation").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		check(
			"wecom_conversation_rotation_positive",
			sql`${table.rotation} between 1 and 2147483647`,
		),
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
		kind: text("kind").notNull().default("wecom_bot"),
		application: jsonb("application"),
		encryptedCallback: jsonb("encrypted_callback"),
		callbackVerifiedAt: timestamp("callback_verified_at", {
			withTimezone: true,
		}),
		probeHolderId: text("probe_holder_id"),
		probeFence: bigint("probe_fence", { mode: "number" }).notNull().default(0),
		probeLeaseUntil: timestamp("probe_lease_until", { withTimezone: true }),
		botVerifiedAt: timestamp("bot_verified_at", { withTimezone: true }),
	},
	(table) => [
		check("wecom_setup_kind", sql`${table.kind} in ('wecom_bot','wecom_app')`),
		check(
			"wecom_probe_fence_safe",
			sql`${table.probeFence} between 0 and 9007199254740991`,
		),
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

export const fileLimitDeclarations = platformSchema.table(
	"file_limit_declarations",
	{
		scope: text("scope").notNull(),
		agentId: text("agent_id").notNull(),
		/** Empty for deployment and Agent declarations; the channel id for channel scope. */
		channelId: text("channel_id").notNull().default(""),
		revision: bigint("revision", { mode: "number" }).notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		maxBytes: bigint("max_bytes", { mode: "number" }).notNull(),
		mediaTypes: jsonb("media_types").$type<readonly string[]>().notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		requestDigest: char("request_digest", { length: 64 }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		updatedBy: text("updated_by").notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.scope, table.agentId, table.channelId],
		}),
		check(
			"file_limit_declaration_scope_valid",
			sql`${table.scope} in ('deployment','agent','channel')`,
		),
		check(
			"file_limit_declaration_binding",
			sql`(${table.scope} = 'deployment' AND ${table.agentId} = '' AND ${table.channelId} = '') OR (${table.scope} = 'agent' AND ${table.agentId} <> '' AND ${table.channelId} = '') OR (${table.scope} = 'channel' AND ${table.agentId} <> '' AND ${table.channelId} <> '')`,
		),
		check(
			"file_limit_declaration_revision_safe",
			sql`${table.revision} between 1 and 9007199254740991`,
		),
		check(
			"file_limit_declaration_max_bytes_safe",
			sql`${table.maxBytes} between 1 and 9007199254740991`,
		),
		check(
			"file_limit_declaration_media_types_array",
			sql`jsonb_typeof(${table.mediaTypes}) = 'array' AND jsonb_array_length(${table.mediaTypes}) between 1 and 128`,
		),
		check(
			"file_limit_declaration_idempotency_key_non_empty",
			sql`char_length(${table.idempotencyKey}) between 1 and 128`,
		),
		check(
			"file_limit_declaration_request_digest_hex",
			sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"file_limit_declaration_updated_by_non_empty",
			sql`char_length(${table.updatedBy}) > 0`,
		),
	],
);
