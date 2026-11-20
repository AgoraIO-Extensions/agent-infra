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
	varchar,
} from "drizzle-orm/pg-core";
import { agents } from "./schema-agents.js";
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
				> &
					Partial<
						Pick<
							ConnectionInstallationAuthorizationV1,
							"authorizationUrl" | "callback"
						>
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
			sql`${table.status} in ('awaiting_confirmation','confirmed','revoked','expired','unknown','preparing')`,
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
		/** Manual install only: digest of the exact signed wire request, committed before send. */
		deliveryDigest: varchar("delivery_digest", { length: 64 }),
	},
	(table) => [
		foreignKey({
			columns: [table.authorizationId],
			foreignColumns: [connectionInstallationAuthorizations.id],
			name: "connection_installation_command_authorization_fk",
		}),
		check(
			"connection_installation_command_valid",
			sql`${table.command} in ('begin','confirm','status','prepare','revoke','begin_status','confirm_binding_readback','confirm_exchange')`,
		),
		check(
			"connection_installation_delivery_digest_valid",
			sql`${table.deliveryDigest} is null or ${table.deliveryDigest} ~ '^[a-f0-9]{64}$'`,
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

/**
 * Spec §13.5.5–§13.5.7 first manual Owner EP-1060 install. One row per original
 * installation authorization; only non-secret facts. The Worker fixes the
 * template, registration key and supply attempt in the installation transaction
 * before it decrypts the service credential; the receipt CAS binds the full
 * OAuth configuration. The credential itself never enters this table.
 */
export const connectionManualInstallations = platformSchema.table(
	"connection_manual_installations",
	{
		authorizationId: text("authorization_id").primaryKey(),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		userId: text("user_id").notNull(),
		executionId: text("execution_id").notNull(),
		associationRevision: bigint("association_revision", {
			mode: "number",
		}).notNull(),
		connectionAgentId: varchar("connection_agent_id", { length: 80 }).notNull(),
		/** Original Execution/Sandbox/Pod/Host facts captured with the intent. */
		preparation: jsonb("preparation").notNull(),
		template: jsonb("template"),
		templateDigest: varchar("template_digest", { length: 64 }),
		/** High-entropy EP-1060 idempotency key; non-secret, never an identity proof. */
		registrationKey: text("registration_key"),
		registrationKeyHash: varchar("registration_key_hash", { length: 64 }),
		supplyAttemptId: varchar("supply_attempt_id", { length: 64 }),
		supplyState: text("supply_state").default("pending").notNull(),
		registrationState: text("registration_state").default("pending").notNull(),
		receipt: jsonb("receipt"),
		consumerId: varchar("consumer_id", { length: 128 }),
		clientId: varchar("client_id", { length: 128 }),
		instanceId: varchar("instance_id", { length: 128 }),
		configuration: jsonb("configuration"),
		revokeState: text("revoke_state").default("not_required").notNull(),
		revision: bigint("revision", { mode: "number" }).default(1).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		/** §13.5.6 dynamic descriptor fixed with the configuration; the first begin binds it. */
		descriptor: jsonb("descriptor"),
		descriptorDigest: varchar("descriptor_digest", { length: 64 }),
	},
	(table) => [
		foreignKey({
			columns: [table.authorizationId],
			foreignColumns: [connectionInstallationAuthorizations.id],
			name: "connection_manual_installation_authorization_fk",
		}),
		uniqueIndex("connection_manual_installation_key_unique").on(
			table.registrationKey,
		),
		uniqueIndex("connection_manual_installation_key_hash_unique").on(
			table.registrationKeyHash,
		),
		uniqueIndex("connection_manual_installation_supply_unique").on(
			table.supplyAttemptId,
		),
		uniqueIndex("connection_manual_installation_client_unique").on(
			table.clientId,
		),
		index("connection_manual_installation_agent_idx").on(
			table.agentId,
			table.associationRevision,
		),
		check(
			"connection_manual_installation_states",
			sql`${table.supplyState} in ('pending','sending','confirmed','unknown','closed')
				and ${table.registrationState} in ('pending','sending','registered','failed','unknown','closed')
				and ${table.revokeState} in ('not_required','pending','sending','revoked','unknown')`,
		),
		check(
			"connection_manual_installation_fixed",
			sql`(${table.template} is null and ${table.templateDigest} is null and ${table.registrationKey} is null
					and ${table.registrationKeyHash} is null and ${table.supplyAttemptId} is null
					and ${table.supplyState} = 'pending' and ${table.registrationState} in ('pending','failed','closed'))
				or (${table.template} is not null and ${table.templateDigest} ~ '^[a-f0-9]{64}$'
					and ${table.registrationKey} ~ '^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$'
					and ${table.registrationKeyHash} ~ '^[a-f0-9]{64}$' and ${table.supplyAttemptId} is not null)`,
		),
		check(
			"connection_manual_installation_receipt",
			sql`(${table.registrationState} <> 'registered' or (${table.receipt} is not null and ${table.clientId} is not null
					and ${table.consumerId} is not null and ${table.instanceId} is not null))
				and (${table.configuration} is null or ${table.registrationState} in ('registered','closed'))`,
		),
		check(
			"connection_manual_installation_descriptor",
			sql`(${table.descriptor} is null) = (${table.descriptorDigest} is null)
				and (${table.descriptor} is null) = (${table.configuration} is null)
				and (${table.descriptorDigest} is null or ${table.descriptorDigest} ~ '^[a-f0-9]{64}$')`,
		),
		check(
			"connection_manual_installation_identity",
			sql`char_length(${table.userId}) > 0 and char_length(${table.executionId}) > 0
				and ${table.connectionAgentId} ~ '^[a-z0-9][a-z0-9-]{2,79}$'
				and ${table.associationRevision} between 1 and 9007199254740991
				and ${table.revision} between 1 and 9007199254740991`,
		),
	],
);

/**
 * §13.5.1 exception item 3: one Platform user per Connection issuer and
 * `principalId`, and one pinned `principalId` per user, across every Agent.
 * A pin is released only by the audited unpin operation (item 6).
 */
export const connectionPrincipalPins = platformSchema.table(
	"connection_principal_pins",
	{
		id: text("id").primaryKey(),
		issuer: text("issuer").notNull(),
		principalId: varchar("principal_id", { length: 128 }).notNull(),
		userId: text("user_id").notNull(),
		policyRef: text("policy_ref").notNull(),
		policyRevision: text("policy_revision").notNull(),
		pinnedAt: timestamp("pinned_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		releasedAt: timestamp("released_at", { withTimezone: true }),
		revision: bigint("revision", { mode: "number" }).default(1).notNull(),
	},
	(table) => [
		uniqueIndex("connection_principal_pin_principal_unique")
			.on(table.issuer, table.principalId)
			.where(sql`${table.releasedAt} is null`),
		uniqueIndex("connection_principal_pin_user_unique")
			.on(table.issuer, table.userId)
			.where(sql`${table.releasedAt} is null`),
		check(
			"connection_principal_pin_identity",
			sql`char_length(${table.issuer}) > 0 and ${table.principalId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
				and char_length(${table.userId}) > 0 and ${table.revision} between 1 and 9007199254740991`,
		),
	],
);

/**
 * §13.5.6 exception confirm, phase 1 commit receipt: this confirm's first-pin
 * check, committed in the same Store CAS as the pin and the phase result. It is
 * not an MCP permit, Grant or Connection authorization.
 */
export const connectionPrincipalPinReceipts = platformSchema.table(
	"connection_principal_pin_receipts",
	{
		id: text("id").primaryKey(),
		revision: bigint("revision", { mode: "number" }).default(1).notNull(),
		authorizationId: text("authorization_id").notNull(),
		confirmCommandId: text("confirm_command_id").notNull(),
		phaseCommandId: text("phase_command_id").notNull(),
		pinId: text("pin_id").notNull(),
		pinRevision: bigint("pin_revision", { mode: "number" }).notNull(),
		candidate: jsonb("candidate").notNull(),
		candidateDigest: varchar("candidate_digest", { length: 64 }).notNull(),
		claimOwner: text("claim_owner").notNull(),
		claimFence: bigint("claim_fence", { mode: "number" }).notNull(),
		attemptId: text("attempt_id").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.authorizationId],
			foreignColumns: [connectionInstallationAuthorizations.id],
			name: "connection_principal_pin_receipt_authorization_fk",
		}),
		foreignKey({
			columns: [table.pinId],
			foreignColumns: [connectionPrincipalPins.id],
			name: "connection_principal_pin_receipt_pin_fk",
		}),
		uniqueIndex("connection_principal_pin_receipt_confirm_unique").on(
			table.confirmCommandId,
		),
		check(
			"connection_principal_pin_receipt_digest",
			sql`${table.candidateDigest} ~ '^[a-f0-9]{64}$' and ${table.revision} between 1 and 9007199254740991`,
		),
	],
);
