import type {
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
