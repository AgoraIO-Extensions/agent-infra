import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
	bigint,
	boolean,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import { connectionSchema } from "./schema-common.js";

const nonEmpty = (name: string, column: AnyPgColumn) =>
	check(`${name}_non_empty`, sql`char_length(${column}) > 0`);

export const principals = connectionSchema.table(
	"principals",
	{
		id: text("id").primaryKey(),
		issuer: varchar("issuer", { length: 255 }).notNull(),
		uid: varchar("uid", { length: 255 }).notNull(),
		status: varchar("status", { length: 32 }).default("active").notNull(),
		recoveryGeneration: bigint("recovery_generation", { mode: "number" })
			.default(1)
			.notNull(),
		directoryCheckedAt: timestamp("directory_checked_at", {
			withTimezone: true,
		}),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("principals_issuer_uid_unique").on(table.issuer, table.uid),
		check(
			"principals_status_check",
			sql`${table.status} IN ('active', 'disabled', 'revoked')`,
		),
		check(
			"principals_recovery_generation_positive",
			sql`${table.recoveryGeneration} > 0`,
		),
		nonEmpty("principal_id", table.id),
		nonEmpty("principal_issuer", table.issuer),
		nonEmpty("principal_uid", table.uid),
	],
);

export const browserSessions = connectionSchema.table(
	"browser_sessions",
	{
		id: text("id").primaryKey(),
		tokenHash: varchar("token_hash", { length: 64 }).notNull(),
		principalId: text("principal_id").notNull(),
		issuer: varchar("issuer", { length: 255 }).notNull(),
		uid: varchar("uid", { length: 255 }).notNull(),
		recoveryGeneration: bigint("recovery_generation", {
			mode: "number",
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [table.principalId],
			foreignColumns: [principals.id],
			name: "browser_sessions_principal_fk",
		}),
		uniqueIndex("browser_sessions_token_hash_unique").on(table.tokenHash),
		index("browser_sessions_principal_idx").on(table.principalId),
		check(
			"browser_sessions_token_hash_check",
			sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"browser_sessions_generation_positive",
			sql`${table.recoveryGeneration} > 0`,
		),
		check(
			"browser_sessions_expiry_after_creation",
			sql`${table.expiresAt} > ${table.createdAt}`,
		),
		nonEmpty("browser_session_id", table.id),
		nonEmpty("browser_session_issuer", table.issuer),
		nonEmpty("browser_session_uid", table.uid),
	],
);

export const consumers = connectionSchema.table(
	"consumers",
	{
		id: text("id").primaryKey(),
		name: varchar("name", { length: 200 }).notNull(),
		actorRequired: boolean("actor_required").notNull(),
		status: varchar("status", { length: 32 }).default("active").notNull(),
		redirectUris: text("redirect_uris").array().default([]).notNull(),
		allowedScopes: text("allowed_scopes").array().default([]).notNull(),
		patApproved: boolean("pat_approved").default(false).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check(
			"consumers_status_check",
			sql`${table.status} IN ('active', 'disabled')`,
		),
		nonEmpty("consumer_id", table.id),
		nonEmpty("consumer_name", table.name),
	],
);

export const consumerInstances = connectionSchema.table(
	"consumer_instances",
	{
		id: text("id").primaryKey(),
		consumerId: text("consumer_id").notNull(),
		principalId: text("principal_id").notNull(),
		installationKey: text("installation_key").notNull(),
		installationKeyThumbprint: varchar("installation_key_thumbprint", {
			length: 64,
		}),
		status: varchar("status", { length: 32 }).default("active").notNull(),
		recoveryGeneration: bigint("recovery_generation", { mode: "number" })
			.default(1)
			.notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.consumerId],
			foreignColumns: [consumers.id],
			name: "consumer_instances_consumer_fk",
		}),
		foreignKey({
			columns: [table.principalId],
			foreignColumns: [principals.id],
			name: "consumer_instances_principal_fk",
		}),
		uniqueIndex("consumer_instances_binding_unique").on(
			table.id,
			table.consumerId,
			table.principalId,
		),
		uniqueIndex("consumer_instances_installation_unique").on(
			table.installationKey,
		),
		uniqueIndex("consumer_instances_key_thumbprint_unique")
			.on(table.installationKeyThumbprint)
			.where(sql`${table.installationKeyThumbprint} IS NOT NULL`),
		check(
			"consumer_instances_status_check",
			sql`${table.status} IN ('active', 'revoked')`,
		),
		check(
			"consumer_instances_recovery_generation_positive",
			sql`${table.recoveryGeneration} > 0`,
		),
		nonEmpty("consumer_instance_id", table.id),
		nonEmpty("consumer_instance_installation_key", table.installationKey),
	],
);

export const actors = connectionSchema.table(
	"actors",
	{
		id: text("id").primaryKey(),
		consumerInstanceId: text("consumer_instance_id").notNull(),
		status: varchar("status", { length: 32 }).default("active").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.consumerInstanceId],
			foreignColumns: [consumerInstances.id],
			name: "actors_consumer_instance_fk",
		}),
		uniqueIndex("actors_instance_binding_unique").on(
			table.id,
			table.consumerInstanceId,
		),
		check("actors_status_check", sql`${table.status} IN ('active', 'revoked')`),
		check(
			"actors_id_not_consumer_sentinel",
			sql`${table.id} <> '__consumer_actor__'`,
		),
		nonEmpty("actor_id", table.id),
	],
);

export const dpopProofs = connectionSchema.table(
	"dpop_proofs",
	{
		keyThumbprint: varchar("key_thumbprint", { length: 64 }).notNull(),
		jti: varchar("jti", { length: 128 }).notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		primaryKey({
			name: "dpop_proofs_pk",
			columns: [table.keyThumbprint, table.jti],
		}),
		index("dpop_proofs_expires_at_idx").on(table.expiresAt),
	],
);

export const oauthInstallationRequests = connectionSchema.table(
	"oauth_installation_requests",
	{
		id: text("id").primaryKey(),
		consumerId: text("consumer_id")
			.notNull()
			.references(() => consumers.id),
		redirectUri: text("redirect_uri").notNull(),
		clientState: text("client_state").notNull(),
		codeChallenge: varchar("code_challenge", { length: 128 }).notNull(),
		audience: text("audience").notNull(),
		scopes: text("scopes").array().notNull(),
		installationKey: jsonb("installation_key")
			.$type<{ kty: "EC"; crv: "P-256"; x: string; y: string }>()
			.notNull(),
		keyThumbprint: varchar("key_thumbprint", { length: 64 }).notNull(),
		browserSessionHash: varchar("browser_session_hash", { length: 64 }),
		principalId: text("principal_id").references(() => principals.id),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		consumedAt: timestamp("consumed_at", { withTimezone: true }),
	},
	(table) => [
		index("oauth_installation_requests_expires_at_idx").on(table.expiresAt),
		check(
			"oauth_installation_requests_lifetime",
			sql`${table.expiresAt} > ${table.createdAt}`,
		),
	],
);

export const oauthAuthorizationCodes = connectionSchema.table(
	"oauth_authorization_codes",
	{
		codeHash: varchar("code_hash", { length: 64 }).primaryKey(),
		principalId: text("principal_id")
			.notNull()
			.references(() => principals.id),
		consumerId: text("consumer_id")
			.notNull()
			.references(() => consumers.id),
		consumerInstanceId: text("consumer_instance_id")
			.notNull()
			.references(() => consumerInstances.id),
		actorId: text("actor_id").notNull(),
		redirectUri: text("redirect_uri").notNull(),
		codeChallenge: varchar("code_challenge", { length: 128 }).notNull(),
		audience: text("audience").notNull(),
		scopes: text("scopes").array().notNull(),
		keyThumbprint: varchar("key_thumbprint", { length: 64 }).notNull(),
		principalGeneration: bigint("principal_generation", {
			mode: "number",
		}).notNull(),
		instanceGeneration: bigint("instance_generation", {
			mode: "number",
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		consumedAt: timestamp("consumed_at", { withTimezone: true }),
	},
	(table) => [
		index("oauth_authorization_codes_expires_at_idx").on(table.expiresAt),
		check(
			"oauth_authorization_codes_lifetime",
			sql`${table.expiresAt} > ${table.createdAt}`,
		),
	],
);

export const clientTokenFamilies = connectionSchema.table(
	"client_token_families",
	{
		id: text("id").primaryKey(),
		status: varchar("status", { length: 32 }).default("active").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
	},
	(table) => [
		check(
			"client_token_families_status",
			sql`${table.status} IN ('active', 'revoked')`,
		),
	],
);

export const clientCredentials = connectionSchema.table(
	"client_credentials",
	{
		id: text("id").primaryKey(),
		tokenHash: varchar("token_hash", { length: 64 }).notNull(),
		kind: varchar("kind", { length: 16 }).notNull(),
		familyId: text("family_id").references(() => clientTokenFamilies.id),
		principalId: text("principal_id")
			.notNull()
			.references(() => principals.id),
		consumerId: text("consumer_id")
			.notNull()
			.references(() => consumers.id),
		consumerInstanceId: text("consumer_instance_id")
			.notNull()
			.references(() => consumerInstances.id),
		actorId: text("actor_id").notNull(),
		audience: text("audience").notNull(),
		scopes: text("scopes").array().notNull(),
		keyThumbprint: varchar("key_thumbprint", { length: 64 }).notNull(),
		principalGeneration: bigint("principal_generation", {
			mode: "number",
		}).notNull(),
		instanceGeneration: bigint("instance_generation", {
			mode: "number",
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		consumedAt: timestamp("consumed_at", { withTimezone: true }),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("client_credentials_token_hash_unique").on(table.tokenHash),
		index("client_credentials_family_idx").on(table.familyId),
		index("client_credentials_instance_idx").on(table.consumerInstanceId),
		check(
			"client_credentials_kind",
			sql`${table.kind} IN ('access', 'refresh', 'pat')`,
		),
		check(
			"client_credentials_family",
			sql`(${table.kind} = 'pat') = (${table.familyId} IS NULL)`,
		),
		check(
			"client_credentials_lifetime",
			sql`${table.expiresAt} > ${table.createdAt}`,
		),
	],
);

export const providers = connectionSchema.table(
	"providers",
	{
		id: text("id").primaryKey(),
		name: varchar("name", { length: 200 }).notNull(),
		status: varchar("status", { length: 32 }).default("active").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check(
			"providers_status_check",
			sql`${table.status} IN ('active', 'disabled')`,
		),
		nonEmpty("provider_id", table.id),
		nonEmpty("provider_name", table.name),
	],
);

export const providerReleases = connectionSchema.table(
	"provider_releases",
	{
		id: text("id").primaryKey(),
		providerId: text("provider_id").notNull(),
		version: varchar("version", { length: 64 }).notNull(),
		status: varchar("status", { length: 32 }).default("disabled").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.providerId],
			foreignColumns: [providers.id],
			name: "provider_releases_provider_fk",
		}),
		uniqueIndex("provider_releases_provider_version_unique").on(
			table.providerId,
			table.version,
		),
		uniqueIndex("provider_releases_binding_unique").on(
			table.id,
			table.providerId,
		),
		check(
			"provider_releases_status_check",
			sql`${table.status} IN ('active', 'disabled')`,
		),
		nonEmpty("provider_release_id", table.id),
		nonEmpty("provider_release_version", table.version),
	],
);

export const actionVersions = connectionSchema.table(
	"action_versions",
	{
		id: text("id").primaryKey(),
		providerId: text("provider_id").notNull(),
		providerReleaseId: text("provider_release_id").notNull(),
		actionId: text("action_id").notNull(),
		version: varchar("version", { length: 64 }).notNull(),
		effect: varchar("effect", { length: 16 }).notNull(),
		inputSchema: jsonb("input_schema")
			.$type<Record<string, unknown>>()
			.notNull(),
		outputSchema: jsonb("output_schema")
			.$type<Record<string, unknown>>()
			.notNull(),
		requiredScopes: jsonb("required_scopes")
			.$type<readonly string[]>()
			.notNull(),
		status: varchar("status", { length: 32 }).default("disabled").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.providerId],
			foreignColumns: [providers.id],
			name: "action_versions_provider_fk",
		}),
		foreignKey({
			columns: [table.providerReleaseId, table.providerId],
			foreignColumns: [providerReleases.id, providerReleases.providerId],
			name: "action_versions_release_binding_fk",
		}),
		uniqueIndex("action_versions_provider_action_version_unique").on(
			table.providerId,
			table.actionId,
			table.version,
		),
		check(
			"action_versions_effect_check",
			sql`${table.effect} IN ('read', 'write')`,
		),
		check(
			"action_versions_status_check",
			sql`${table.status} IN ('published', 'disabled')`,
		),
		nonEmpty("action_version_id", table.id),
		nonEmpty("action_version_action_id", table.actionId),
		nonEmpty("action_version_version", table.version),
	],
);

// The reverse current-credential FK is installed by the migration after both
// tables exist; keeping it there avoids a module initialization cycle here.
export const connections = connectionSchema.table(
	"connections",
	{
		id: text("id").primaryKey(),
		providerId: text("provider_id").notNull(),
		externalAccountId: text("external_account_id").notNull(),
		status: varchar("status", { length: 32 }).default("active").notNull(),
		revocationRevision: bigint("revocation_revision", { mode: "number" })
			.default(0)
			.notNull(),
		currentCredentialVersionId: text("current_credential_version_id"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.providerId],
			foreignColumns: [providers.id],
			name: "connections_provider_fk",
		}),
		uniqueIndex("connections_provider_external_account_unique").on(
			table.providerId,
			table.externalAccountId,
		),
		check(
			"connections_status_check",
			sql`${table.status} IN ('active', 'disabled', 'revoked')`,
		),
		check(
			"connections_revocation_revision_non_negative",
			sql`${table.revocationRevision} >= 0`,
		),
		nonEmpty("connection_id", table.id),
		nonEmpty("connection_external_account_id", table.externalAccountId),
	],
);

export const credentialVersions = connectionSchema.table(
	"credential_versions",
	{
		id: text("id").primaryKey(),
		connectionId: text("connection_id").notNull(),
		version: integer("version").notNull(),
		ciphertext: text("ciphertext").notNull(),
		status: varchar("status", { length: 32 }).default("active").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [table.connectionId],
			foreignColumns: [connections.id],
			name: "credential_versions_connection_fk",
		}),
		uniqueIndex("credential_versions_binding_unique").on(
			table.id,
			table.connectionId,
		),
		uniqueIndex("credential_versions_connection_version_unique").on(
			table.connectionId,
			table.version,
		),
		check(
			"credential_versions_status_check",
			sql`${table.status} IN ('active', 'revoked')`,
		),
		check("credential_versions_version_positive", sql`${table.version} > 0`),
		nonEmpty("credential_version_id", table.id),
		nonEmpty("credential_version_ciphertext", table.ciphertext),
	],
);

// `actor_id` is deliberately not a direct foreign key: the reserved
// consumer-level sentinel has no row in `actors`. The migration installs one
// trigger that validates every non-sentinel actor binding for grants and calls.
export const grants = connectionSchema.table(
	"grants",
	{
		id: text("id").primaryKey(),
		principalId: text("principal_id").notNull(),
		consumerId: text("consumer_id").notNull(),
		consumerInstanceId: text("consumer_instance_id").notNull(),
		actorId: text("actor_id").notNull(),
		connectionId: text("connection_id").notNull(),
		credentialVersionId: text("credential_version_id").notNull(),
		approvedActionVersionIds: text("approved_action_version_ids")
			.array()
			.notNull(),
		revision: bigint("revision", { mode: "number" }).default(1).notNull(),
		principalRecoveryGeneration: bigint("principal_recovery_generation", {
			mode: "number",
		}).notNull(),
		status: varchar("status", { length: 32 }).default("active").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			columns: [table.principalId],
			foreignColumns: [principals.id],
			name: "grants_principal_fk",
		}),
		foreignKey({
			columns: [table.consumerId],
			foreignColumns: [consumers.id],
			name: "grants_consumer_fk",
		}),
		foreignKey({
			columns: [table.consumerInstanceId],
			foreignColumns: [consumerInstances.id],
			name: "grants_consumer_instance_fk",
		}),
		foreignKey({
			columns: [table.consumerInstanceId, table.consumerId, table.principalId],
			foreignColumns: [
				consumerInstances.id,
				consumerInstances.consumerId,
				consumerInstances.principalId,
			],
			name: "grants_instance_binding_fk",
		}),
		foreignKey({
			columns: [table.connectionId],
			foreignColumns: [connections.id],
			name: "grants_connection_fk",
		}),
		foreignKey({
			columns: [table.credentialVersionId],
			foreignColumns: [credentialVersions.id],
			name: "grants_credential_version_fk",
		}),
		foreignKey({
			columns: [table.credentialVersionId, table.connectionId],
			foreignColumns: [credentialVersions.id, credentialVersions.connectionId],
			name: "grants_credential_connection_fk",
		}),
		uniqueIndex("grants_binding_unique").on(
			table.id,
			table.principalId,
			table.consumerId,
			table.consumerInstanceId,
			table.actorId,
			table.connectionId,
			table.credentialVersionId,
		),
		uniqueIndex("grants_current_binding_unique")
			.on(
				table.principalId,
				table.consumerId,
				table.consumerInstanceId,
				table.actorId,
				table.connectionId,
			)
			.where(sql`${table.status} = 'active'`),
		check("grants_status_check", sql`${table.status} IN ('active', 'revoked')`),
		check(
			"grants_approved_actions_nonempty",
			sql`cardinality(${table.approvedActionVersionIds}) > 0`,
		),
		check("grants_revision_positive", sql`${table.revision} > 0`),
		check(
			"grants_lifetime_check",
			sql`${table.expiresAt} > ${table.createdAt}`,
		),
		check(
			"grants_principal_generation_positive",
			sql`${table.principalRecoveryGeneration} > 0`,
		),
		nonEmpty("grant_id", table.id),
		nonEmpty("grant_credential_version_id", table.credentialVersionId),
	],
);

export const grantActions = connectionSchema.table(
	"grant_actions",
	{
		grantId: text("grant_id").notNull(),
		actionVersionId: text("action_version_id").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.grantId, table.actionVersionId],
			name: "grant_actions_pk",
		}),
		foreignKey({
			columns: [table.grantId],
			foreignColumns: [grants.id],
			name: "grant_actions_grant_fk",
		}),
		foreignKey({
			columns: [table.actionVersionId],
			foreignColumns: [actionVersions.id],
			name: "grant_actions_action_version_fk",
		}),
	],
);

export const currentGrantActions = connectionSchema.table(
	"current_grant_actions",
	{
		grantId: text("grant_id").notNull(),
		principalId: text("principal_id").notNull(),
		consumerId: text("consumer_id").notNull(),
		consumerInstanceId: text("consumer_instance_id").notNull(),
		actorId: text("actor_id").notNull(),
		actionVersionId: text("action_version_id").notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.grantId, table.actionVersionId],
			name: "current_grant_actions_pk",
		}),
		foreignKey({
			columns: [table.grantId],
			foreignColumns: [grants.id],
			name: "current_grant_actions_grant_fk",
		}),
		foreignKey({
			columns: [table.actionVersionId],
			foreignColumns: [actionVersions.id],
			name: "current_grant_actions_action_fk",
		}),
		uniqueIndex("current_grant_actions_subject_action_unique").on(
			table.principalId,
			table.consumerId,
			table.consumerInstanceId,
			table.actorId,
			table.actionVersionId,
		),
	],
);

export const actionCalls = connectionSchema.table(
	"action_calls",
	{
		id: text("id").primaryKey(),
		requestId: text("request_id").notNull(),
		traceId: text("trace_id").notNull(),
		callId: text("call_id").notNull(),
		idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
		namespaceKey: text("namespace_key").notNull(),
		principalId: text("principal_id").notNull(),
		consumerId: text("consumer_id").notNull(),
		consumerInstanceId: text("consumer_instance_id").notNull(),
		actorId: text("actor_id").notNull(),
		grantId: text("grant_id").notNull(),
		connectionId: text("connection_id").notNull(),
		credentialVersionId: text("credential_version_id").notNull(),
		actionVersionId: text("action_version_id").notNull(),
		requestDigest: varchar("request_digest", { length: 64 }).notNull(),
		status: varchar("status", { length: 32 }).default("created").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.principalId],
			foreignColumns: [principals.id],
			name: "action_calls_principal_fk",
		}),
		foreignKey({
			columns: [table.consumerId],
			foreignColumns: [consumers.id],
			name: "action_calls_consumer_fk",
		}),
		foreignKey({
			columns: [table.consumerInstanceId],
			foreignColumns: [consumerInstances.id],
			name: "action_calls_consumer_instance_fk",
		}),
		foreignKey({
			columns: [table.consumerInstanceId, table.consumerId, table.principalId],
			foreignColumns: [
				consumerInstances.id,
				consumerInstances.consumerId,
				consumerInstances.principalId,
			],
			name: "action_calls_instance_binding_fk",
		}),
		foreignKey({
			columns: [table.grantId],
			foreignColumns: [grants.id],
			name: "action_calls_grant_fk",
		}),
		foreignKey({
			columns: [
				table.grantId,
				table.principalId,
				table.consumerId,
				table.consumerInstanceId,
				table.actorId,
				table.connectionId,
				table.credentialVersionId,
			],
			foreignColumns: [
				grants.id,
				grants.principalId,
				grants.consumerId,
				grants.consumerInstanceId,
				grants.actorId,
				grants.connectionId,
				grants.credentialVersionId,
			],
			name: "action_calls_grant_binding_fk",
		}),
		foreignKey({
			columns: [table.connectionId],
			foreignColumns: [connections.id],
			name: "action_calls_connection_fk",
		}),
		foreignKey({
			columns: [table.credentialVersionId],
			foreignColumns: [credentialVersions.id],
			name: "action_calls_credential_version_fk",
		}),
		foreignKey({
			columns: [table.actionVersionId],
			foreignColumns: [actionVersions.id],
			name: "action_calls_action_version_fk",
		}),
		uniqueIndex("action_calls_namespace_key_unique").on(
			table.namespaceKey,
			table.idempotencyKey,
		),
		uniqueIndex("action_calls_call_id_unique").on(table.callId),
		check(
			"action_calls_idempotency_key_format",
			sql`${table.idempotencyKey} ~ '^[A-Za-z0-9._~-]{1,128}$'`,
		),
		check(
			"action_calls_request_digest_format",
			sql`${table.requestDigest} ~ '^[a-f0-9]{64}$'`,
		),
		check(
			"action_calls_status_check",
			sql`${table.status} IN ('created', 'submission_started', 'provider_succeeded', 'provider_failed', 'result_pending', 'needs_manual_review', 'unresolved')`,
		),
		nonEmpty("action_call_id", table.id),
		nonEmpty("action_call_request_id", table.requestId),
		nonEmpty("action_call_trace_id", table.traceId),
		nonEmpty("action_call_namespace_key", table.namespaceKey),
		nonEmpty("action_call_credential_version_id", table.credentialVersionId),
	],
);

export const effects = connectionSchema.table(
	"effects",
	{
		id: text("id").primaryKey(),
		actionCallId: text("action_call_id").notNull(),
		status: varchar("status", { length: 32 }).default("planned").notNull(),
		providerRequestKey: text("provider_request_key").notNull(),
		result: jsonb("result").$type<Record<string, unknown> | null>(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.actionCallId],
			foreignColumns: [actionCalls.id],
			name: "effects_action_call_fk",
		}),
		uniqueIndex("effects_action_call_unique").on(table.actionCallId),
		check(
			"effects_status_check",
			sql`${table.status} IN ('planned', 'submitted', 'succeeded', 'failed', 'unknown')`,
		),
		nonEmpty("effect_id", table.id),
		nonEmpty("effect_provider_request_key", table.providerRequestKey),
	],
);

export const dispatches = connectionSchema.table(
	"dispatches",
	{
		id: text("id").primaryKey(),
		actionCallId: text("action_call_id").notNull(),
		status: varchar("status", { length: 32 }).default("pending").notNull(),
		attemptCount: integer("attempt_count").default(0).notNull(),
		leaseOwner: text("lease_owner"),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.actionCallId],
			foreignColumns: [actionCalls.id],
			name: "dispatches_action_call_fk",
		}),
		uniqueIndex("dispatches_action_call_unique").on(table.actionCallId),
		check(
			"dispatches_status_check",
			sql`${table.status} IN ('pending', 'claimed', 'completed', 'failed', 'unknown')`,
		),
		check(
			"dispatches_attempt_count_non_negative",
			sql`${table.attemptCount} >= 0`,
		),
		check(
			"dispatches_lease_pair",
			sql`(${table.leaseOwner} IS NULL) = (${table.leaseExpiresAt} IS NULL)`,
		),
		nonEmpty("dispatch_id", table.id),
	],
);

export const auditEvents = connectionSchema.table(
	"audit_events",
	{
		id: text("id").primaryKey(),
		traceId: text("trace_id").notNull(),
		principalId: text("principal_id"),
		consumerInstanceId: text("consumer_instance_id"),
		actorId: text("actor_id"),
		action: varchar("action", { length: 128 }).notNull(),
		targetType: varchar("target_type", { length: 64 }).notNull(),
		targetId: text("target_id").notNull(),
		outcome: varchar("outcome", { length: 32 }).notNull(),
		metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
		occurredAt: timestamp("occurred_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.principalId],
			foreignColumns: [principals.id],
			name: "audit_events_principal_fk",
		}),
		foreignKey({
			columns: [table.consumerInstanceId],
			foreignColumns: [consumerInstances.id],
			name: "audit_events_consumer_instance_fk",
		}),
		index("audit_events_trace_idx").on(table.traceId),
		check(
			"audit_events_outcome_check",
			sql`${table.outcome} IN ('succeeded', 'rejected', 'failed')`,
		),
		nonEmpty("audit_event_id", table.id),
		nonEmpty("audit_event_trace_id", table.traceId),
		nonEmpty("audit_event_action", table.action),
		nonEmpty("audit_event_target_type", table.targetType),
		nonEmpty("audit_event_target_id", table.targetId),
	],
);

export const connectionInfrastructureTables = [
	principals,
	browserSessions,
	consumers,
	consumerInstances,
	actors,
	dpopProofs,
	oauthInstallationRequests,
	oauthAuthorizationCodes,
	clientTokenFamilies,
	clientCredentials,
	providers,
	providerReleases,
	actionVersions,
	connections,
	credentialVersions,
	grants,
	grantActions,
	currentGrantActions,
	actionCalls,
	effects,
	dispatches,
	auditEvents,
] as const;
