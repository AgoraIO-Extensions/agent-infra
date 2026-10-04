import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	foreignKey,
	jsonb,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import { platformSchema } from "./schema-common";
import { conversations } from "./schema-conversations";

export const sessionSandboxAllocations = platformSchema.table(
	"session_sandbox_allocations",
	{
		sandboxId: text("sandbox_id").primaryKey(),
		conversationId: text("conversation_id").notNull(),
		agentId: text("agent_id").notNull(),
		actorId: text("actor_id").notNull(),
		principalType: varchar("principal_type", { length: 16 }).notNull(),
		channelId: text("channel_id").notNull(),
		sessionGeneration: bigint("session_generation", {
			mode: "number",
		}).notNull(),
		resourceName: text("resource_name").notNull(),
		workspaceScope: text("workspace_scope").notNull(),
		status: varchar("status", { length: 16 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		resourceFence: bigint("resource_fence", { mode: "number" })
			.notNull()
			.default(0),
		desiredState: varchar("desired_state", { length: 16 })
			.notNull()
			.default("running"),
		resourcePolicy: jsonb("resource_policy"),
		resourceObservation: jsonb("resource_observation"),
	},
	(table) => [
		uniqueIndex("session_sandbox_conversation_unique").on(table.conversationId),
		uniqueIndex("session_sandbox_resource_unique").on(table.resourceName),
		uniqueIndex("session_sandbox_workspace_unique").on(table.workspaceScope),
		foreignKey({
			columns: [
				table.conversationId,
				table.agentId,
				table.actorId,
				table.principalType,
				table.channelId,
			],
			foreignColumns: [
				conversations.id,
				conversations.agentId,
				conversations.actorId,
				conversations.principalType,
				conversations.channelId,
			],
			name: "session_sandbox_conversation_binding_fk",
		}),
		check(
			"session_sandbox_id_uuid",
			sql`${table.sandboxId} ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'`,
		),
		check(
			"session_sandbox_generation_safe",
			sql`${table.sessionGeneration} between 1 and 9007199254740991`,
		),
		check(
			"session_sandbox_resource_binding",
			sql`${table.resourceName} = 'sandbox-' || ${table.sandboxId}`,
		),
		check(
			"session_sandbox_workspace_binding",
			sql`${table.workspaceScope} = ${table.sandboxId}`,
		),
		check(
			"session_sandbox_status_valid",
			sql`${table.status} in ('allocated', 'applying', 'observed', 'ready', 'stopped', 'unknown', 'unavailable')`,
		),
		check(
			"session_sandbox_resource_fence_safe",
			sql`${table.resourceFence} between 0 and 9007199254740991`,
		),
		check(
			"session_sandbox_desired_state_valid",
			sql`${table.desiredState} in ('running', 'stopped')`,
		),
	],
);
