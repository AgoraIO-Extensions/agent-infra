import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
	bigint,
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
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.principalId],
			foreignColumns: [principals.id],
			name: "browser_sessions_principal_fk",
		}),
		uniqueIndex("browser_sessions_token_hash_unique").on(table.tokenHash),
		check(
			"browser_sessions_token_hash_format",
			sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`,
		),
		check(
			"browser_sessions_recovery_generation_positive",
			sql`${table.recoveryGeneration} > 0`,
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
		status: varchar("status", { length: 32 }).default("active").notNull(),
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
		installationPublicKey: text("installation_public_key"),
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

export const accessTokens = connectionSchema.table(
	"access_tokens",
	{
		id: text("id").primaryKey(),
		kind: varchar("kind", { length: 32 }).notNull(),
		tokenHash: varchar("token_hash", { length: 64 }).notNull(),
		principalId: text("principal_id").notNull(),
		consumerId: text("consumer_id").notNull(),
		consumerInstanceId: text("consumer_instance_id").notNull(),
		actorId: text("actor_id").notNull(),
		audience: varchar("audience", { length: 255 }).notNull(),
		scopes: jsonb("scopes").$type<readonly string[]>().notNull(),
		recoveryGeneration: bigint("recovery_generation", {
			mode: "number",
		}).notNull(),
		issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		familyId: text("family_id").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.principalId],
			foreignColumns: [principals.id],
			name: "access_tokens_principal_fk",
		}),
		foreignKey({
			columns: [table.consumerId],
			foreignColumns: [consumers.id],
			name: "access_tokens_consumer_fk",
		}),
		foreignKey({
			columns: [table.consumerInstanceId, table.consumerId, table.principalId],
			foreignColumns: [
				consumerInstances.id,
				consumerInstances.consumerId,
				consumerInstances.principalId,
			],
			name: "access_tokens_instance_binding_fk",
		}),
		uniqueIndex("access_tokens_token_hash_unique").on(table.tokenHash),
		index("access_tokens_family_idx").on(table.familyId),
		check(
			"access_tokens_kind_check",
			sql`${table.kind} IN ('pat', 'oauth_access')`,
		),
		check(
			"access_tokens_token_hash_format",
			sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`,
		),
		check(
			"access_tokens_recovery_generation_positive",
			sql`${table.recoveryGeneration} > 0`,
		),
		nonEmpty("access_token_id", table.id),
		nonEmpty("access_token_audience", table.audience),
		nonEmpty("access_token_family_id", table.familyId),
	],
);

export const authorizationCodes = connectionSchema.table(
	"authorization_codes",
	{
		id: text("id").primaryKey(),
		codeHash: varchar("code_hash", { length: 64 }).notNull(),
		clientId: text("client_id").notNull(),
		principalId: text("principal_id").notNull(),
		consumerId: text("consumer_id").notNull(),
		consumerInstanceId: text("consumer_instance_id").notNull(),
		actorId: text("actor_id").notNull(),
		redirectUri: text("redirect_uri").notNull(),
		codeChallenge: varchar("code_challenge", { length: 128 }).notNull(),
		codeChallengeMethod: varchar("code_challenge_method", {
			length: 16,
		}).notNull(),
		audience: varchar("audience", { length: 255 }).notNull(),
		scopes: jsonb("scopes").$type<readonly string[]>().notNull(),
		recoveryGeneration: bigint("recovery_generation", {
			mode: "number",
		}).notNull(),
		issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		consumedAt: timestamp("consumed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.principalId],
			foreignColumns: [principals.id],
			name: "authorization_codes_principal_fk",
		}),
		foreignKey({
			columns: [table.consumerId],
			foreignColumns: [consumers.id],
			name: "authorization_codes_consumer_fk",
		}),
		foreignKey({
			columns: [table.consumerInstanceId, table.consumerId, table.principalId],
			foreignColumns: [
				consumerInstances.id,
				consumerInstances.consumerId,
				consumerInstances.principalId,
			],
			name: "authorization_codes_instance_binding_fk",
		}),
		uniqueIndex("authorization_codes_hash_unique").on(table.codeHash),
		check(
			"authorization_codes_hash_format",
			sql`${table.codeHash} ~ '^[a-f0-9]{64}$'`,
		),
		check(
			"authorization_codes_pkce_method_check",
			sql`${table.codeChallengeMethod} = 'S256'`,
		),
		check(
			"authorization_codes_recovery_generation_positive",
			sql`${table.recoveryGeneration} > 0`,
		),
		nonEmpty("authorization_code_id", table.id),
		nonEmpty("authorization_code_client_id", table.clientId),
		nonEmpty("authorization_code_redirect_uri", table.redirectUri),
		nonEmpty("authorization_code_audience", table.audience),
	],
);

export const refreshTokens = connectionSchema.table(
	"refresh_tokens",
	{
		id: text("id").primaryKey(),
		tokenHash: varchar("token_hash", { length: 64 }).notNull(),
		familyId: text("family_id").notNull(),
		principalId: text("principal_id").notNull(),
		consumerId: text("consumer_id").notNull(),
		consumerInstanceId: text("consumer_instance_id").notNull(),
		actorId: text("actor_id").notNull(),
		audience: varchar("audience", { length: 255 }).notNull(),
		scopes: jsonb("scopes").$type<readonly string[]>().notNull(),
		recoveryGeneration: bigint("recovery_generation", {
			mode: "number",
		}).notNull(),
		issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		usedAt: timestamp("used_at", { withTimezone: true }),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.principalId],
			foreignColumns: [principals.id],
			name: "refresh_tokens_principal_fk",
		}),
		foreignKey({
			columns: [table.consumerId],
			foreignColumns: [consumers.id],
			name: "refresh_tokens_consumer_fk",
		}),
		foreignKey({
			columns: [table.consumerInstanceId, table.consumerId, table.principalId],
			foreignColumns: [
				consumerInstances.id,
				consumerInstances.consumerId,
				consumerInstances.principalId,
			],
			name: "refresh_tokens_instance_binding_fk",
		}),
		uniqueIndex("refresh_tokens_hash_unique").on(table.tokenHash),
		index("refresh_tokens_family_idx").on(table.familyId),
		check(
			"refresh_tokens_hash_format",
			sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`,
		),
		check(
			"refresh_tokens_recovery_generation_positive",
			sql`${table.recoveryGeneration} > 0`,
		),
		nonEmpty("refresh_token_id", table.id),
		nonEmpty("refresh_token_family_id", table.familyId),
		nonEmpty("refresh_token_audience", table.audience),
	],
);

export const dpopReplay = connectionSchema.table(
	"dpop_replay",
	{
		jti: text("jti").primaryKey(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(table) => [nonEmpty("dpop_replay_jti", table.jti)],
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

export const actionVersions = connectionSchema.table(
	"action_versions",
	{
		id: text("id").primaryKey(),
		providerId: text("provider_id").notNull(),
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
		status: varchar("status", { length: 32 }).default("published").notNull(),
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
		revision: bigint("revision", { mode: "number" }).default(1).notNull(),
		principalRecoveryGeneration: bigint("principal_recovery_generation", {
			mode: "number",
		}).notNull(),
		status: varchar("status", { length: 32 }).default("active").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
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
		check("grants_revision_positive", sql`${table.revision} > 0`),
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

export const actionCalls = connectionSchema.table(
	"action_calls",
	{
		id: text("id").primaryKey(),
		requestId: text("request_id").notNull(),
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
	accessTokens,
	authorizationCodes,
	refreshTokens,
	dpopReplay,
	providers,
	actionVersions,
	connections,
	credentialVersions,
	grants,
	grantActions,
	actionCalls,
	effects,
	dispatches,
	auditEvents,
] as const;
