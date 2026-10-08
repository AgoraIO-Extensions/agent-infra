import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
	bigint,
	boolean,
	char,
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
import { agents } from "./schema-agents";
import { platformSchema } from "./schema-common";

const nonEmpty = (column: AnyPgColumn, name: string) =>
	check(name, sql`char_length(${column}) > 0`);

export const skillHubSkills = platformSchema.table(
	"skill_hub_skills",
	{
		id: text("id").primaryKey(),
		name: varchar("name", { length: 63 }).notNull(),
		ownerId: text("owner_id").notNull(),
		/** Organization selected by the authenticated publisher for ORGANIZATION visibility. */
		organizationId: text("organization_id"),
		status: varchar("status", { length: 16 }).default("active").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		nonEmpty(table.id, "skill_hub_skill_id_non_empty"),
		nonEmpty(table.name, "skill_hub_skill_name_non_empty"),
		nonEmpty(table.ownerId, "skill_hub_skill_owner_non_empty"),
		check(
			"skill_hub_skill_organization_non_empty",
			sql`${table.organizationId} is null or char_length(${table.organizationId}) > 0`,
		),
		check(
			"skill_hub_skill_status_valid",
			sql`${table.status} in ('active', 'disabled')`,
		),
		uniqueIndex("skill_hub_skill_owner_name_unique").on(
			table.ownerId,
			table.name,
		),
		uniqueIndex("skill_hub_skill_id_owner_unique").on(table.id, table.ownerId),
		index("skill_hub_skill_owner_idx").on(table.ownerId),
	],
);

export const skillHubVersions = platformSchema.table(
	"skill_hub_versions",
	{
		id: text("id").primaryKey(),
		skillId: text("skill_id")
			.notNull()
			.references(() => skillHubSkills.id),
		ownerId: text("owner_id").notNull(),
		version: varchar("version", { length: 128 }).notNull(),
		provider: varchar("provider", { length: 16 }).notNull(),
		visibility: varchar("visibility", { length: 16 }).notNull(),
		state: varchar("state", { length: 16 }).notNull(),
		packageObjectVersion: text("package_object_version").notNull(),
		packageDigest: char("package_digest", { length: 64 }).notNull(),
		manifestDigest: char("manifest_digest", { length: 64 }).notNull(),
		signatureDigest: char("signature_digest", { length: 64 }).notNull(),
		needUpgrade: boolean("need_upgrade").default(false).notNull(),
		reviewedBy: text("reviewed_by"),
		reviewReason: text("review_reason"),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		nonEmpty(table.id, "skill_hub_version_id_non_empty"),
		nonEmpty(table.ownerId, "skill_hub_version_owner_non_empty"),
		nonEmpty(
			table.packageObjectVersion,
			"skill_hub_version_object_version_non_empty",
		),
		check(
			"skill_hub_version_provider_valid",
			sql`${table.provider} in ('system', 'my_library', 'market', 'clawhub', 'skillhub', 'npx', 'github')`,
		),
		check(
			"skill_hub_version_visibility_valid",
			sql`${table.visibility} in ('PRIVATE', 'MEMBER', 'ORGANIZATION', 'MARKET')`,
		),
		check(
			"skill_hub_version_state_valid",
			sql`${table.state} in ('published', 'pending_review', 'rejected', 'revoked')`,
		),
		check(
			"skill_hub_version_package_digest_hex",
			sql`${table.packageDigest} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"skill_hub_version_manifest_digest_hex",
			sql`${table.manifestDigest} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"skill_hub_version_signature_digest_hex",
			sql`${table.signatureDigest} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"skill_hub_version_review_binding",
			sql`${table.state} = 'pending_review' or (${table.state} in ('published', 'rejected') and (${table.visibility} = 'PRIVATE' or ${table.reviewedBy} is not null)) or (${table.state} = 'revoked' and ${table.revokedAt} is not null)`,
		),
		uniqueIndex("skill_hub_version_skill_version_unique").on(
			table.skillId,
			table.version,
		),
		index("skill_hub_version_state_idx").on(table.state),
		foreignKey({
			columns: [table.skillId, table.ownerId],
			foreignColumns: [skillHubSkills.id, skillHubSkills.ownerId],
			name: "skill_hub_version_skill_owner_fk",
		}),
	],
);

export const skillHubInstallations = platformSchema.table(
	"skill_hub_installations",
	{
		id: text("id").primaryKey(),
		principalType: varchar("principal_type", { length: 16 }).notNull(),
		principalId: text("principal_id").notNull(),
		skillVersionId: text("skill_version_id").notNull(),
		state: varchar("state", { length: 16 }).notNull(),
		needUpgrade: boolean("need_upgrade").default(false).notNull(),
		installedAt: timestamp("installed_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		nonEmpty(table.id, "skill_hub_installation_id_non_empty"),
		nonEmpty(table.principalId, "skill_hub_installation_principal_non_empty"),
		check(
			"skill_hub_installation_principal_type_valid",
			sql`${table.principalType} in ('user', 'organization')`,
		),
		check(
			"skill_hub_installation_state_valid",
			sql`${table.state} in ('installed', 'uninstalled', 'failed')`,
		),
		uniqueIndex("skill_hub_installation_principal_version_unique").on(
			table.principalType,
			table.principalId,
			table.skillVersionId,
		),
		index("skill_hub_installation_principal_idx").on(
			table.principalType,
			table.principalId,
		),
		foreignKey({
			columns: [table.skillVersionId],
			foreignColumns: [skillHubVersions.id],
			name: "skill_hub_installation_skill_version_fk",
		}),
	],
);

export const skillHubAgentBindings = platformSchema.table(
	"skill_hub_agent_bindings",
	{
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		agentVersion: varchar("agent_version", { length: 128 }).notNull(),
		skillVersionId: text("skill_version_id").notNull(),
		grant: jsonb("grant").notNull(),
		syncRevision: bigint("sync_revision", { mode: "number" })
			.default(1)
			.notNull(),
		state: varchar("state", { length: 16 }).notNull(),
		failureReason: text("failure_reason"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.agentId, table.agentVersion, table.skillVersionId],
			name: "skill_hub_agent_binding_pk",
		}),
		nonEmpty(table.agentVersion, "skill_hub_agent_binding_version_non_empty"),
		check(
			"skill_hub_agent_binding_sync_revision_safe",
			sql`${table.syncRevision} between 1 and 9007199254740991`,
		),
		check(
			"skill_hub_agent_binding_state_valid",
			sql`${table.state} in ('pending_sync', 'synced', 'failed', 'revoked')`,
		),
		check(
			"skill_hub_agent_binding_failure_binding",
			sql`(${table.state} = 'failed') = (${table.failureReason} is not null)`,
		),
		index("skill_hub_agent_binding_agent_idx").on(
			table.agentId,
			table.agentVersion,
		),
		foreignKey({
			columns: [table.skillVersionId],
			foreignColumns: [skillHubVersions.id],
			name: "skill_hub_agent_binding_skill_version_fk",
		}),
	],
);
