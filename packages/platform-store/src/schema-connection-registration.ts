import type {
	ConnectionConsumerDisableIntentV1,
	ConnectionConsumerDisableReceiptV1,
	ConnectionConsumerDisableStatusV1,
	ConnectionConsumerRegistrationIntentV1,
	ConnectionConsumerRegistrationReceiptV1,
	ConnectionConsumerRegistrationStatusV1,
} from "@agent-infra/platform-core";
import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	index,
	jsonb,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import { agents } from "./schema-agents.js";
import { platformSchema } from "./schema-common.js";

/** Platform delivery facts only. Credentials and remote Grant authority stay in Connection. */
export const connectionConsumerRegistrations = platformSchema.table(
	"connection_consumer_registrations",
	{
		operationId: text("operation_id").primaryKey(),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		sourceNamespace: varchar("source_namespace", { length: 128 }).notNull(),
		sourceKey: text("source_key").notNull(),
		requestDigest: varchar("request_digest", { length: 64 }).notNull(),
		idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
		request: jsonb("request")
			.$type<ConnectionConsumerRegistrationIntentV1>()
			.notNull(),
		status: varchar("status", { length: 16 })
			.$type<ConnectionConsumerRegistrationStatusV1>()
			.default("pending")
			.notNull(),
		consumerId: text("consumer_id"),
		receipt: jsonb("receipt").$type<ConnectionConsumerRegistrationReceiptV1>(),
		consumerRevision: text("consumer_revision"),
		associationRevision: bigint("association_revision", { mode: "number" })
			.default(0)
			.notNull(),
		failureCode: varchar("failure_code", { length: 64 }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		sendingAt: timestamp("sending_at", { withTimezone: true }),
		registeredAt: timestamp("registered_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("connection_consumer_registration_agent_unique").on(
			table.agentId,
		),
		uniqueIndex("connection_consumer_registration_source_unique").on(
			table.sourceNamespace,
			table.sourceKey,
		),
		uniqueIndex("connection_consumer_registration_consumer_unique").on(
			table.consumerId,
		),
		check(
			"connection_consumer_registration_source",
			sql`${table.sourceNamespace} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.sourceKey} = ${table.agentId}`,
		),
		check(
			"connection_consumer_registration_digest",
			sql`${table.requestDigest} ~ '^[a-f0-9]{64}$' and ${table.idempotencyKey} ~ '^ccr-v1[.][a-f0-9]{64}$'`,
		),
		check(
			"connection_consumer_registration_status",
			sql`${table.status} in ('pending','sending','registered','failed','unknown')`,
		),
		check(
			"connection_consumer_registration_request",
			sql`jsonb_typeof(${table.request}) = 'object'
				and ${table.request} @> jsonb_build_object('schemaVersion', 1,
					'operationId', ${table.operationId}, 'platformAgentId', ${table.agentId},
					'sourceNamespace', ${table.sourceNamespace}, 'sourceKey', ${table.sourceKey},
					'requestDigest', ${table.requestDigest}, 'idempotencyKey', ${table.idempotencyKey})
				and ${table.request} ?& array['platformOwnerId','consumerName','policyRevision','callbackUrl','resource','scope']
				and (${table.request} - array['schemaVersion','operationId','sourceNamespace','sourceKey','platformAgentId','platformOwnerId','consumerName','policyRevision','callbackUrl','resource','scope','requestDigest','idempotencyKey']) = '{}'::jsonb`,
		),
		check(
			"connection_consumer_registration_receipt",
			sql`(${table.status} = 'registered') = (${table.consumerId} is not null and ${table.receipt} is not null and ${table.consumerRevision} is not null and ${table.registeredAt} is not null)
				and (${table.receipt} is null or (jsonb_typeof(${table.receipt}) = 'object'
					and ${table.receipt} @> jsonb_build_object('schemaVersion', 1,
						'operationId', ${table.operationId}, 'sourceNamespace', ${table.sourceNamespace},
						'sourceKey', ${table.sourceKey}, 'consumerId', ${table.consumerId},
						'consumerRevision', ${table.consumerRevision}, 'requestDigest', ${table.requestDigest})
					and ${table.receipt} ? 'registrationId'
					and (${table.receipt} - array['schemaVersion','operationId','sourceNamespace','sourceKey','consumerId','consumerRevision','registrationId','requestDigest']) = '{}'::jsonb))`,
		),
		check(
			"connection_consumer_registration_revision",
			sql`${table.associationRevision} between 0 and 9007199254740991 and (${table.status} = 'registered') = (${table.associationRevision} > 0)`,
		),
		check(
			"connection_consumer_registration_failure",
			sql`${table.failureCode} is null or ${table.failureCode} ~ '^[A-Z][A-Z0-9_]{0,63}$'`,
		),
		index("connection_consumer_registration_status_idx").on(
			table.status,
			table.updatedAt,
		),
	],
);

/**
 * Spec §13.5.7 Consumer disable: one row per disabled Agent, selected only from that Agent's own
 * registration. The request exists only once it is about to be or has been sent. There is
 * deliberately no foreign key to the registration row: its FOR KEY SHARE would invert the
 * registration worker's registration→Agent lock order. Readers join on operation and Agent.
 */
export const connectionConsumerDisables = platformSchema.table(
	"connection_consumer_disables",
	{
		operationId: text("operation_id").primaryKey(),
		registrationOperationId: text("registration_operation_id").notNull(),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		sourceNamespace: varchar("source_namespace", { length: 128 }).notNull(),
		idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
		status: varchar("status", { length: 16 })
			.$type<ConnectionConsumerDisableStatusV1>()
			.default("waiting")
			.notNull(),
		request: jsonb("request").$type<ConnectionConsumerDisableIntentV1>(),
		requestDigest: varchar("request_digest", { length: 64 }),
		receipt: jsonb("receipt").$type<ConnectionConsumerDisableReceiptV1>(),
		resultRevision: text("result_revision"),
		failureCode: varchar("failure_code", { length: 64 }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		sendingAt: timestamp("sending_at", { withTimezone: true }),
		disabledAt: timestamp("disabled_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("connection_consumer_disable_agent_unique").on(table.agentId),
		uniqueIndex("connection_consumer_disable_registration_unique").on(
			table.registrationOperationId,
		),
		check(
			"connection_consumer_disable_identity",
			sql`${table.sourceNamespace} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
				and ${table.idempotencyKey} ~ '^ccd-v1[.][a-f0-9]{64}$'
				and ${table.operationId} = 'connection-consumer-disable:' || substr(${table.idempotencyKey}, 8)`,
		),
		check(
			"connection_consumer_disable_status",
			sql`${table.status} in ('waiting','pending','sending','disabled','failed','unknown','not_required')`,
		),
		check(
			"connection_consumer_disable_request",
			sql`(${table.request} is null) = (${table.status} in ('waiting','pending','not_required'))
				and (${table.request} is null) = (${table.requestDigest} is null)
				and (${table.request} is null or (jsonb_typeof(${table.request}) = 'object'
					and ${table.requestDigest} ~ '^[a-f0-9]{64}$'
					and ${table.request} @> jsonb_build_object('schemaVersion', 1,
						'operationId', ${table.operationId}, 'registrationOperationId', ${table.registrationOperationId},
						'platformAgentId', ${table.agentId}, 'sourceNamespace', ${table.sourceNamespace},
						'idempotencyKey', ${table.idempotencyKey}, 'requestDigest', ${table.requestDigest})
					and ${table.request} ?& array['consumerId','registrationId','registrationKeyHash','policyRevision','expectedRevision']
					and (${table.request} - array['schemaVersion','operationId','registrationOperationId','sourceNamespace','platformAgentId','consumerId','registrationId','registrationKeyHash','policyRevision','expectedRevision','idempotencyKey','requestDigest']) = '{}'::jsonb))`,
		),
		check(
			"connection_consumer_disable_receipt",
			sql`(${table.status} = 'disabled') = (${table.receipt} is not null and ${table.resultRevision} is not null and ${table.disabledAt} is not null)
				and (${table.receipt} is null or (jsonb_typeof(${table.receipt}) = 'object'
					and ${table.receipt} @> jsonb_build_object('schemaVersion', 1,
						'operationId', ${table.operationId}, 'resultRevision', ${table.resultRevision},
						'requestDigest', ${table.requestDigest})
					and ${table.receipt} ?& array['consumerId','registrationId']
					and (${table.receipt} - array['schemaVersion','operationId','consumerId','registrationId','resultRevision','requestDigest']) = '{}'::jsonb))`,
		),
		check(
			"connection_consumer_disable_failure",
			sql`${table.failureCode} is null or ${table.failureCode} ~ '^[A-Z][A-Z0-9_]{0,63}$'`,
		),
		index("connection_consumer_disable_status_idx").on(
			table.status,
			table.updatedAt,
		),
	],
);

/**
 * Spec §13.5.7 Owner manual association: one row per Agent, written only after a
 * read-only Connection verification. The service credential is stored only as
 * ADR 0002 application ciphertext; the fingerprint only rejects reuse across Agents.
 */
export const connectionManualAssociations = platformSchema.table(
	"connection_manual_associations",
	{
		agentId: text("agent_id")
			.primaryKey()
			.references(() => agents.id),
		connectionAgentId: varchar("connection_agent_id", { length: 80 }).notNull(),
		credentialFingerprint: varchar("credential_fingerprint", {
			length: 64,
		}).notNull(),
		associationRevision: bigint("association_revision", {
			mode: "number",
		}).notNull(),
		ownerId: text("owner_id").notNull(),
		credentialCiphertext: jsonb("credential_ciphertext").notNull(),
		verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("connection_manual_association_agent_unique").on(
			table.connectionAgentId,
		),
		uniqueIndex("connection_manual_association_credential_unique").on(
			table.credentialFingerprint,
		),
		uniqueIndex("connection_manual_association_dek_unique").on(
			sql`(${table.credentialCiphertext}->'crypto'->>'dekFingerprint')`,
		),
		check(
			"connection_manual_association_identity",
			sql`${table.connectionAgentId} ~ '^[a-z0-9][a-z0-9-]{2,79}$'
				and ${table.credentialFingerprint} ~ '^[a-f0-9]{64}$'
				and ${table.associationRevision} between 1 and 9007199254740991`,
		),
		check(
			"connection_manual_association_ciphertext",
			sql`jsonb_typeof(${table.credentialCiphertext}) = 'object'
				and ${table.credentialCiphertext} @> jsonb_build_object('schemaVersion', 1,
					'agentId', ${table.agentId}, 'ownerId', ${table.ownerId},
					'secretVersion', ${table.associationRevision})
				and ${table.credentialCiphertext}->'crypto'->>'dekFingerprint' ~ '^[a-f0-9]{64}$'`,
		),
	],
);

/** Non-secret EP-1060 machine-client binding for one Owner association revision. */
export const connectionMachineClientBindings = platformSchema.table(
	"connection_machine_client_bindings",
	{
		agentId: text("agent_id")
			.primaryKey()
			.references(() => agents.id),
		associationRevision: bigint("association_revision", {
			mode: "number",
		}).notNull(),
		clientId: varchar("client_id", { length: 128 }).notNull(),
		callbackUrl: text("callback_url").notNull(),
		profileFingerprint: varchar("profile_fingerprint", {
			length: 64,
		}).notNull(),
		sourceRef: text("source_ref").notNull(),
		sourceRevision: varchar("source_revision", { length: 128 }).notNull(),
		registrationKeyHash: varchar("registration_key_hash", { length: 64 }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("connection_machine_client_binding_client_unique").on(
			table.clientId,
		),
		uniqueIndex(
			"connection_machine_client_binding_registration_hash_unique",
		).on(table.registrationKeyHash),
		check(
			"connection_machine_client_binding_identity",
			sql`${table.associationRevision} between 1 and 9007199254740991
				and ${table.clientId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
				and ${table.profileFingerprint} ~ '^[a-f0-9]{64}$'
				and ${table.sourceRevision} <> ''
				and (${table.registrationKeyHash} is null or ${table.registrationKeyHash} ~ '^[a-f0-9]{64}$')`,
		),
	],
);

/**
 * Durable per-Agent association generation (Spec §13.5.7). It survives disconnect so a
 * reassociation never reuses an earlier association revision as its CAS identity.
 */
export const connectionAssociationGenerations = platformSchema.table(
	"connection_association_generations",
	{
		agentId: text("agent_id")
			.primaryKey()
			.references(() => agents.id),
		lastRevision: bigint("last_revision", { mode: "number" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check(
			"connection_association_generation_revision",
			sql`${table.lastRevision} between 1 and 9007199254740991`,
		),
	],
);

/** Records Host supply delivery and local cleanup, separate from OAuth client state. */
export const connectionHostSupplies = platformSchema.table(
	"connection_host_supplies",
	{
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		associationRevision: bigint("association_revision", {
			mode: "number",
		}).notNull(),
		systemFingerprint: varchar("system_fingerprint", { length: 64 }).notNull(),
		state: text("state").notNull(),
		ref: varchar("ref", { length: 128 }),
		revision: varchar("revision", { length: 128 }),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.agentId, table.associationRevision] }),
		check(
			"connection_host_supply_state",
			sql`
			${table.state} in ('writing', 'available', 'cleanup_pending', 'cleanup_unknown', 'closed')
			and (${table.state} <> 'available' or (${table.ref} is not null and ${table.revision} is not null))
		`,
		),
	],
);
