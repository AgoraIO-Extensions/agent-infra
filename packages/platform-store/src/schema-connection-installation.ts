import type {
	ConnectionInstallationAuthorizationV1,
	ConnectionInstallationCommandV1,
} from "@agent-infra/contracts/runtime";
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
} from "drizzle-orm/pg-core";
import { platformSchema } from "./schema-common.js";
import { conversationExecutions } from "./schema-conversations.js";

export const connectionInstallationAuthorizations = platformSchema.table(
	"connection_installation_authorizations",
	{
		id: text("id").primaryKey(),
		executionId: text("execution_id").notNull(),
		userId: text("user_id").notNull(),
		confirmationRevision: text("confirmation_revision").notNull(),
		binding: jsonb("binding")
			.$type<
				Pick<
					ConnectionInstallationAuthorizationV1,
					"principal" | "reference" | "scope"
				>
			>()
			.notNull(),
		identityRevision: text("identity_revision").notNull(),
		agentAuthorizationRevision: text("agent_authorization_revision").notNull(),
		status: text("status").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		revision: bigint("revision", { mode: "number" }).default(1).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.executionId],
			foreignColumns: [conversationExecutions.executionId],
			name: "connection_installation_execution_fk",
		}),
		check(
			"connection_installation_status_valid",
			sql`${table.status} in ('awaiting_confirmation','confirmed','revoked','expired','unknown')`,
		),
		check(
			"connection_installation_revision_safe",
			sql`${table.revision} between 1 and 9007199254740991`,
		),
		check(
			"connection_installation_binding_user",
			sql`(${table.binding}->'principal'->>'kind' = 'user' and ${table.binding}->'principal'->>'id' = ${table.userId}) is true`,
		),
		check(
			"connection_installation_binding_execution",
			sql`(${table.binding}->'reference'->>'executionId' = ${table.executionId}) is true`,
		),
		check(
			"connection_installation_ids_nonempty",
			sql`char_length(${table.userId}) > 0 and char_length(${table.confirmationRevision}) > 0 and char_length(${table.identityRevision}) > 0 and char_length(${table.agentAuthorizationRevision}) > 0`,
		),
		index("connection_installation_user_execution_idx").on(
			table.userId,
			table.executionId,
		),
	],
);
export const connectionInstallationCommands = platformSchema.table(
	"connection_installation_commands",
	{
		id: text("id").primaryKey(),
		authorizationId: text("authorization_id").notNull(),
		command: text("command").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		requestDigest: text("request_digest").notNull(),
		status: text("status")
			.$type<ConnectionInstallationCommandV1["status"]>()
			.notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		attemptId: text("attempt_id"),
		attemptOwner: text("attempt_owner"),
		attemptExpiresAt: timestamp("attempt_expires_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [table.authorizationId],
			foreignColumns: [connectionInstallationAuthorizations.id],
			name: "connection_installation_command_authorization_fk",
		}),
		check(
			"connection_installation_command_valid",
			sql`${table.command} in ('begin','confirm','status')`,
		),
		check(
			"connection_installation_delivery_valid",
			sql`${table.status} in ('pending','sending','completed','unknown','rejected')`,
		),
		check(
			"connection_installation_digest_valid",
			sql`${table.requestDigest} ~ '^[a-f0-9]{64}$'`,
		),
		check(
			"connection_installation_attempt_binding",
			sql`(${table.attemptId} is null and ${table.attemptOwner} is null) or (${table.attemptId} is not null and ${table.attemptOwner} is not null)`,
		),
		uniqueIndex("connection_installation_command_key_unique").on(
			table.authorizationId,
			table.command,
			table.idempotencyKey,
		),
		index("connection_installation_pending_idx").on(
			table.status,
			table.authorizationId,
		),
	],
);
