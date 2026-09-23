import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	foreignKey,
	index,
	jsonb,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import {
	conversationExecutionStatus,
	conversationMessageStatus,
	conversationStatus,
	conversationStopStatus,
	platformSchema,
} from "./schema-common";

export const conversations = platformSchema.table(
	"conversations",
	{
		id: text("id").primaryKey(),
		agentId: text("agent_id").notNull(),
		actorId: text("actor_id").notNull(),
		channelId: text("channel_id").notNull(),
		status: conversationStatus("status").notNull(),
		sessionGeneration: bigint("session_generation", {
			mode: "number",
		}).notNull(),
		hostSessionRef: text("host_session_ref"),
		authorizationRevision: text("authorization_revision").notNull(),
		lastConversationCursor: bigint("last_conversation_cursor", {
			mode: "number",
		})
			.default(0)
			.notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		selectedModelOptionId: text("selected_model_option_id"),
		selectedReasoningLevel: text("selected_reasoning_level"),
	},
	(table) => [
		check("conversation_id_non_empty", sql`char_length(${table.id}) > 0`),
		check(
			"conversation_agent_id_non_empty",
			sql`char_length(${table.agentId}) > 0`,
		),
		check(
			"conversation_actor_id_non_empty",
			sql`char_length(${table.actorId}) > 0`,
		),
		check(
			"conversation_channel_id_non_empty",
			sql`char_length(${table.channelId}) > 0`,
		),
		check(
			"conversation_session_generation_safe",
			sql`${table.sessionGeneration} between 1 and 9007199254740991`,
		),
		check(
			"conversation_host_session_ref_non_empty",
			sql`${table.hostSessionRef} IS NULL OR char_length(${table.hostSessionRef}) > 0`,
		),
		check(
			"conversation_authorization_revision_non_empty",
			sql`char_length(${table.authorizationRevision}) > 0`,
		),
		check(
			"conversation_cursor_non_negative",
			sql`${table.lastConversationCursor} between 0 and 9007199254740991`,
		),
		check(
			"conversation_model_selection_pair",
			sql`(${table.selectedModelOptionId} IS NULL AND ${table.selectedReasoningLevel} IS NULL)
				OR (${table.selectedModelOptionId} IS NOT NULL
					AND ${table.selectedReasoningLevel} IS NOT NULL
					AND char_length(${table.selectedModelOptionId}) > 0
					AND char_length(${table.selectedReasoningLevel}) > 0)`,
		),
		index("conversation_actor_lookup_idx").on(
			table.actorId,
			table.agentId,
			table.channelId,
		),
	],
);

export const conversationExecutions = platformSchema.table(
	"conversation_executions",
	{
		executionId: text("execution_id").primaryKey(),
		conversationId: text("conversation_id").notNull(),
		agentId: text("agent_id").notNull(),
		actorId: text("actor_id").notNull(),
		channelId: text("channel_id").notNull(),
		turnId: text("turn_id").notNull(),
		status: conversationExecutionStatus("status").notNull(),
		sessionGeneration: bigint("session_generation", {
			mode: "number",
		}).notNull(),
		deliveryFence: bigint("delivery_fence", { mode: "number" })
			.default(0)
			.notNull(),
		authorizationRevision: text("authorization_revision").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		lastEventSequence: bigint("last_event_sequence", { mode: "number" })
			.default(0)
			.notNull(),
		lastRuntimeCursor: text("last_runtime_cursor"),
		modelConfigurationRevision: bigint("model_configuration_revision", {
			mode: "number",
		}),
		modelOptionId: text("model_option_id"),
		reasoningLevel: text("reasoning_level"),
	},
	(table) => [
		foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "conversation_execution_conversation_fk",
		}),
		check(
			"conversation_execution_id_non_empty",
			sql`char_length(${table.executionId}) > 0`,
		),
		check(
			"conversation_execution_agent_id_non_empty",
			sql`char_length(${table.agentId}) > 0`,
		),
		check(
			"conversation_execution_actor_id_non_empty",
			sql`char_length(${table.actorId}) > 0`,
		),
		check(
			"conversation_execution_channel_id_non_empty",
			sql`char_length(${table.channelId}) > 0`,
		),
		check(
			"conversation_execution_turn_id_non_empty",
			sql`char_length(${table.turnId}) > 0`,
		),
		check(
			"conversation_execution_session_generation_safe",
			sql`${table.sessionGeneration} between 1 and 9007199254740991`,
		),
		check(
			"conversation_execution_delivery_fence_safe",
			sql`${table.deliveryFence} between 0 and 9007199254740991`,
		),
		check(
			"conversation_execution_last_event_sequence_safe",
			sql`${table.lastEventSequence} between 0 and 9007199254740991`,
		),
		check(
			"conversation_execution_last_runtime_cursor_non_empty",
			sql`${table.lastRuntimeCursor} IS NULL OR char_length(${table.lastRuntimeCursor}) > 0`,
		),
		check(
			"conversation_execution_authorization_revision_non_empty",
			sql`char_length(${table.authorizationRevision}) > 0`,
		),
		check(
			"conversation_execution_model_selection",
			sql`(
				${table.modelConfigurationRevision} IS NULL
				AND ${table.modelOptionId} IS NULL
				AND ${table.reasoningLevel} IS NULL
			) OR (
				${table.modelConfigurationRevision} IS NOT NULL
				AND ${table.modelOptionId} IS NOT NULL
				AND ${table.reasoningLevel} IS NOT NULL
				AND ${table.modelConfigurationRevision} between 1 and 9007199254740991
				AND char_length(${table.modelOptionId}) > 0
				AND char_length(${table.reasoningLevel}) > 0
			)`,
		),
		uniqueIndex("conversation_execution_id_conversation_unique").on(
			table.executionId,
			table.conversationId,
		),
		uniqueIndex("conversation_active_execution_unique")
			.on(table.conversationId)
			.where(sql`${table.status} in ('submitted', 'processing', 'unknown')`),
		index("conversation_execution_conversation_idx").on(
			table.conversationId,
			table.createdAt,
		),
	],
);

export const conversationMessages = platformSchema.table(
	"conversation_messages",
	{
		messageId: text("message_id").primaryKey(),
		conversationId: text("conversation_id").notNull(),
		actorId: text("actor_id").notNull(),
		role: varchar("role", { length: 16 }).notNull(),
		text: text("text").notNull(),
		executionId: text("execution_id").notNull(),
		status: conversationMessageStatus("status").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		failureCode: varchar("failure_code", { length: 64 }),
	},
	(table) => [
		foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "conversation_message_conversation_fk",
		}),
		foreignKey({
			columns: [table.executionId],
			foreignColumns: [conversationExecutions.executionId],
			name: "conversation_message_execution_fk",
		}),
		check(
			"conversation_message_id_non_empty",
			sql`char_length(${table.messageId}) > 0`,
		),
		check(
			"conversation_message_actor_id_non_empty",
			sql`char_length(${table.actorId}) > 0`,
		),
		check("conversation_message_role_user", sql`${table.role} = 'user'`),
		check(
			"conversation_message_text_non_empty",
			sql`char_length(${table.text}) > 0`,
		),
		check(
			"conversation_message_failure_binding",
			sql`(${table.status}::text = 'failed') = (${table.failureCode} is not null)`,
		),
		check(
			"conversation_message_failure_code_non_empty",
			sql`${table.failureCode} is null or char_length(${table.failureCode}) > 0`,
		),
		index("conversation_message_conversation_idx").on(
			table.conversationId,
			table.createdAt,
		),
	],
);

export const conversationStops = platformSchema.table(
	"conversation_stops",
	{
		executionId: text("execution_id").primaryKey(),
		stopRequestId: text("stop_request_id").notNull(),
		status: conversationStopStatus("status").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.executionId],
			foreignColumns: [conversationExecutions.executionId],
			name: "conversation_stop_execution_fk",
		}),
		check(
			"conversation_stop_request_id_non_empty",
			sql`char_length(${table.stopRequestId}) > 0`,
		),
		uniqueIndex("conversation_stop_request_unique").on(table.stopRequestId),
	],
);

export const conversationAuditEvents = platformSchema.table(
	"conversation_audit_events",
	{
		id: text("id").primaryKey(),
		conversationId: text("conversation_id").notNull(),
		executionId: text("execution_id"),
		agentId: text("agent_id").notNull(),
		actorId: text("actor_id").notNull(),
		action: varchar("action", { length: 128 }).notNull(),
		traceId: text("trace_id").notNull(),
		requestId: text("request_id").notNull(),
		occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
		details: jsonb("details").$type<Record<string, unknown>>(),
	},
	(table) => [
		foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "conversation_audit_conversation_fk",
		}),
		foreignKey({
			columns: [table.executionId],
			foreignColumns: [conversationExecutions.executionId],
			name: "conversation_audit_execution_fk",
		}),
		check("conversation_audit_id_non_empty", sql`char_length(${table.id}) > 0`),
		check(
			"conversation_audit_agent_id_non_empty",
			sql`char_length(${table.agentId}) > 0`,
		),
		check(
			"conversation_audit_actor_id_non_empty",
			sql`char_length(${table.actorId}) > 0`,
		),
		check(
			"conversation_audit_action_non_empty",
			sql`char_length(${table.action}) > 0`,
		),
		check(
			"conversation_audit_execution_binding",
			sql`(
					${table.executionId} IS NULL
					AND ${table.action} = 'conversation.model_selection.updated'
				) OR (
					${table.executionId} IS NOT NULL
					AND ${table.action} <> 'conversation.model_selection.updated'
				)`,
		),
		check(
			"conversation_audit_details_binding",
			sql`(
				${table.action} in (
					'conversation.model_selection.updated',
					'conversation.model_selection.fell_back'
				)
			) = (${table.details} IS NOT NULL)`,
		),
		check(
			"conversation_audit_trace_id_non_empty",
			sql`char_length(${table.traceId}) > 0`,
		),
		check(
			"conversation_audit_request_id_non_empty",
			sql`char_length(${table.requestId}) > 0`,
		),
		index("conversation_audit_trace_idx").on(table.traceId),
		index("conversation_audit_conversation_idx").on(
			table.conversationId,
			table.occurredAt,
		),
	],
);

export const conversationEvents = platformSchema.table(
	"conversation_events",
	{
		eventId: text("event_id").primaryKey(),
		conversationId: text("conversation_id").notNull(),
		executionId: text("execution_id").notNull(),
		adapterEventKey: text("adapter_event_key").notNull(),
		sequence: bigint("sequence", { mode: "number" }).notNull(),
		conversationCursor: bigint("conversation_cursor", {
			mode: "number",
		}).notNull(),
		eventType: varchar("event_type", { length: 128 }).notNull(),
		eventPayload: jsonb("event_payload")
			.$type<Record<string, unknown>>()
			.notNull(),
		eventDigest: varchar("event_digest", { length: 64 }).notNull(),
		runtimeCursor: text("runtime_cursor"),
		occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
		source: varchar("source", { length: 16 }).notNull(),
		persistedAt: timestamp("persisted_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.executionId, table.conversationId],
			foreignColumns: [
				conversationExecutions.executionId,
				conversationExecutions.conversationId,
			],
			name: "conversation_event_execution_conversation_fk",
		}),
		check(
			"conversation_event_id_non_empty",
			sql`char_length(${table.eventId}) > 0`,
		),
		check(
			"conversation_event_adapter_key_non_empty",
			sql`char_length(${table.adapterEventKey}) > 0`,
		),
		check(
			"conversation_event_sequence_safe",
			sql`${table.sequence} between 1 and 9007199254740991`,
		),
		check(
			"conversation_event_cursor_safe",
			sql`${table.conversationCursor} between 1 and 9007199254740991`,
		),
		check(
			"conversation_event_type_non_empty",
			sql`char_length(${table.eventType}) > 0`,
		),
		check(
			"conversation_event_digest_format",
			sql`${table.eventDigest} ~ '^[a-f0-9]{64}$'`,
		),
		check(
			"conversation_event_source_binding",
			sql`(
					${table.source} = 'runtime'
					AND ${table.runtimeCursor} IS NOT NULL
					AND char_length(${table.runtimeCursor}) > 0
					AND ${table.eventType} <> 'model.selection.fell_back'
				) OR (
					${table.source} = 'platform'
					AND ${table.runtimeCursor} IS NULL
					AND ${table.eventType} = 'model.selection.fell_back'
				)`,
		),
		uniqueIndex("conversation_event_execution_adapter_key_unique")
			.on(table.executionId, table.adapterEventKey)
			.where(sql`${table.source} = 'runtime'`),
		uniqueIndex("conversation_event_execution_sequence_unique").on(
			table.executionId,
			table.sequence,
		),
		uniqueIndex("conversation_event_conversation_cursor_unique").on(
			table.conversationId,
			table.conversationCursor,
		),
		index("conversation_event_conversation_cursor_idx").on(
			table.conversationId,
			table.conversationCursor,
		),
	],
);
