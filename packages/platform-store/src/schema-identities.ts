import { sql } from "drizzle-orm";
import {
	check,
	foreignKey,
	index,
	jsonb,
	primaryKey,
	text,
	timestamp,
	varchar,
} from "drizzle-orm/pg-core";
import { agents } from "./schema-agents";
import { platformSchema } from "./schema-common";

export const platformApplications = platformSchema.table(
	"platform_applications",
	{
		id: text("id").primaryKey(),
		name: varchar("name", { length: 200 }).notNull(),
		responsibleUserId: text("responsible_user_id").notNull(),
		status: varchar("status", { length: 32 }).default("active").notNull(),
		authorizationRevision: text("authorization_revision").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check(
			"platform_application_id_non_empty",
			sql`char_length(${table.id}) > 0`,
		),
		check(
			"platform_application_name_non_empty",
			sql`char_length(${table.name}) > 0`,
		),
		check(
			"platform_application_responsible_non_empty",
			sql`char_length(${table.responsibleUserId}) > 0`,
		),
		check(
			"platform_application_status_valid",
			sql`${table.status} in ('active', 'disabled')`,
		),
		check(
			"platform_application_revision_non_empty",
			sql`char_length(${table.authorizationRevision}) > 0`,
		),
		index("platform_application_responsible_idx").on(table.responsibleUserId),
	],
);

export const platformApiCredentials = platformSchema.table(
	"platform_api_credentials",
	{
		id: text("id").primaryKey(),
		principalType: varchar("principal_type", { length: 32 }).notNull(),
		principalId: text("principal_id").notNull(),
		credentialHash: varchar("credential_hash", { length: 64 }).notNull(),
		scopes: jsonb("scopes").$type<readonly string[]>().notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
	},
	(table) => [
		check(
			"platform_api_credential_id_non_empty",
			sql`char_length(${table.id}) > 0`,
		),
		check(
			"platform_api_credential_principal_type_valid",
			sql`${table.principalType} in ('user', 'application')`,
		),
		check(
			"platform_api_credential_principal_id_non_empty",
			sql`char_length(${table.principalId}) > 0`,
		),
		check(
			"platform_api_credential_hash_format",
			sql`${table.credentialHash} ~ '^[a-f0-9]{64}$'`,
		),
		check(
			"platform_api_credential_scopes_array",
			sql`jsonb_typeof(${table.scopes}) = 'array'`,
		),
		index("platform_api_credential_principal_idx").on(
			table.principalType,
			table.principalId,
		),
		index("platform_api_credential_active_idx").on(
			table.credentialHash,
			table.revokedAt,
			table.expiresAt,
		),
	],
);

export const agentPrincipalGrants = platformSchema.table(
	"agent_principal_grants",
	{
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		principalType: varchar("principal_type", { length: 32 }).notNull(),
		principalId: text("principal_id").notNull(),
		grantType: varchar("grant_type", { length: 32 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		authorizationRevision: text("authorization_revision").notNull(),
	},
	(table) => [
		primaryKey({
			columns: [
				table.agentId,
				table.principalType,
				table.principalId,
				table.grantType,
			],
		}),
		check(
			"agent_principal_grant_principal_type_valid",
			sql`${table.principalType} in ('user', 'application')`,
		),
		check(
			"agent_principal_grant_type_valid",
			sql`${table.grantType} in ('manage', 'use')`,
		),
		check(
			"agent_principal_grant_principal_id_non_empty",
			sql`char_length(${table.principalId}) > 0`,
		),
		check(
			"agent_principal_grant_revision_non_empty",
			sql`char_length(${table.authorizationRevision}) > 0`,
		),
		index("agent_principal_grant_lookup_idx").on(
			table.principalType,
			table.principalId,
			table.grantType,
			table.revokedAt,
		),
	],
);

export const apiCredentialDeliveryGrants = platformSchema.table(
	"api_credential_delivery_grants",
	{
		applicationId: text("application_id").notNull(),
		principalType: varchar("principal_type", { length: 32 }).notNull(),
		principalId: text("principal_id").notNull(),
		authorizationRevision: text("authorization_revision").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
	},
	(table) => [
		primaryKey({
			columns: [table.applicationId, table.principalType, table.principalId],
		}),
		check(
			"api_credential_delivery_principal_type_valid",
			sql`${table.principalType} in ('user', 'application')`,
		),
		check(
			"api_credential_delivery_principal_id_non_empty",
			sql`char_length(${table.principalId}) > 0`,
		),
		check(
			"api_credential_delivery_revision_non_empty",
			sql`char_length(${table.authorizationRevision}) > 0`,
		),
		index("api_credential_delivery_lookup_idx").on(
			table.principalType,
			table.principalId,
			table.revokedAt,
		),
		foreignKey({
			columns: [table.applicationId],
			foreignColumns: [platformApplications.id],
			name: "api_credential_delivery_application_fk",
		}),
	],
);
