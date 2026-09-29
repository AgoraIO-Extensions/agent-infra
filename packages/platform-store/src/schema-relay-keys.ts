import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	foreignKey,
	jsonb,
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex,
} from "drizzle-orm/pg-core";

import { platformSchema } from "./schema-common";

// The subject row serializes replacements and retains the high-water mark after
// revocation. Clearing currentVersion must never make an old version current.
export const relayKeySubjects = platformSchema.table(
	"relay_key_subjects",
	{
		purpose: text("purpose").notNull(),
		subjectId: text("subject_id").notNull(),
		lastVersion: bigint("last_version", { mode: "number" })
			.default(0)
			.notNull(),
		currentVersion: bigint("current_version", { mode: "number" }),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.purpose, table.subjectId] }),
		check(
			"relay_key_subject_purpose",
			sql`${table.purpose} in ('personal', 'agent-default')`,
		),
		check(
			"relay_key_subject_id",
			sql`char_length(${table.subjectId}) between 1 and 1024`,
		),
		check(
			"relay_key_subject_last_version",
			sql`${table.lastVersion} between 0 and 9007199254740991`,
		),
		check(
			"relay_key_subject_current_version",
			sql`${table.currentVersion} is null or ${table.currentVersion} between 1 and ${table.lastVersion}`,
		),
	],
);

// A version is inserted once. Accepted Executions refer to the exact row even
// after the subject's current pointer moves or is revoked.
export const relayKeyVersions = platformSchema.table(
	"relay_key_versions",
	{
		purpose: text("purpose").notNull(),
		subjectId: text("subject_id").notNull(),
		keyVersion: bigint("key_version", { mode: "number" }).notNull(),
		keyId: text("key_id").notNull(),
		ciphertext: jsonb("ciphertext").$type<Record<string, unknown>>().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.purpose, table.subjectId, table.keyVersion] }),
		foreignKey({
			columns: [table.purpose, table.subjectId],
			foreignColumns: [relayKeySubjects.purpose, relayKeySubjects.subjectId],
			name: "relay_key_version_subject_fk",
		}),
		unique("relay_key_version_identity_unique").on(
			table.purpose,
			table.subjectId,
			table.keyVersion,
			table.keyId,
		),
		uniqueIndex("relay_key_version_key_id_unique").on(table.keyId),
		check(
			"relay_key_version_purpose",
			sql`${table.purpose} in ('personal', 'agent-default')`,
		),
		check(
			"relay_key_version_subject_id",
			sql`char_length(${table.subjectId}) between 1 and 1024`,
		),
		check(
			"relay_key_version_key_id",
			sql`char_length(${table.keyId}) between 1 and 1024`,
		),
		check(
			"relay_key_version_safe",
			sql`${table.keyVersion} between 1 and 9007199254740991`,
		),
		check(
			"relay_key_version_ciphertext_binding",
			sql`(${table.ciphertext}->>'purpose' = ${table.purpose}
				and ${table.ciphertext}->>'subjectId' = ${table.subjectId}
				and ${table.ciphertext}->>'keyId' = ${table.keyId}
				and ${table.ciphertext}->>'keyVersion' = ${table.keyVersion}::text) is true`,
		),
	],
);
