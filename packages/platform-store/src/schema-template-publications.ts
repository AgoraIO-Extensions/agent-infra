import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	index,
	integer,
	jsonb,
	text,
	timestamp,
	unique,
} from "drizzle-orm/pg-core";
import { agents } from "./schema-agents";
import { platformSchema } from "./schema-common";

export const templatePublications = platformSchema.table(
	"template_publications",
	{
		id: text("id").primaryKey(),
		templateId: text("template_id").notNull(),
		binding: jsonb("binding").notNull(),
		requestDigest: text("request_digest").notNull(),
		approvedBy: text("approved_by").notNull(),
		status: text("status").default("prepared").notNull(),
		workerReady: boolean("worker_ready").default(false).notNull(),
		cursor: text("cursor"),
		discoveryComplete: boolean("discovery_complete").default(false).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		workerReceipt: jsonb("worker_receipt"),
	},
	(t) => [
		check(
			"template_publication_state",
			sql`${t.status} in ('prepared','active','partial','blocked','completed','revoked','superseded')`,
		),
		check(
			"template_publication_digest",
			sql`${t.requestDigest} ~ '^[a-f0-9]{64}$'`,
		),
		check(
			"template_publication_binding",
			sql`(${t.binding}->>'schemaVersion' = '1') is true`,
		),
		index("template_publication_template").on(t.templateId),
	],
);

export const templatePublicationNonces = platformSchema.table(
	"template_publication_nonces",
	{
		id: text("id").primaryKey(),
		publicationId: text("publication_id")
			.notNull()
			.references(() => templatePublications.id),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(t) => [index("template_publication_nonce_expiry").on(t.expiresAt)],
);

export const templatePublicationCatalog = platformSchema.table(
	"template_publication_catalog",
	{
		templateId: text("template_id").primaryKey(),
		publicationId: text("publication_id")
			.notNull()
			.references(() => templatePublications.id),
		revision: bigint("revision", { mode: "number" }).notNull(),
	},
	(t) => [
		check(
			"template_publication_catalog_revision",
			sql`${t.revision} between 1 and 9007199254740991`,
		),
	],
);

export const templatePublicationTargets = platformSchema.table(
	"template_publication_targets",
	{
		id: text("id").primaryKey(),
		publicationId: text("publication_id")
			.notNull()
			.references(() => templatePublications.id),
		batchRef: text("batch_ref").notNull(),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		attempt: integer("attempt").default(1).notNull(),
		target: jsonb("target").notNull(),
		status: text("status").default("pending").notNull(),
		configurationRevision: bigint("configuration_revision", { mode: "number" }),
		errorCode: text("error_code"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [
		unique("template_publication_target_attempt").on(
			t.publicationId,
			t.agentId,
			t.attempt,
		),
		check(
			"template_publication_target_state",
			sql`${t.status} in ('pending','unknown','applied','rejected')`,
		),
		check(
			"template_publication_target_attempt_positive",
			sql`${t.attempt} between 1 and 2147483647`,
		),
		index("template_publication_target_pending").on(
			t.publicationId,
			t.status,
			t.id,
		),
	],
);
