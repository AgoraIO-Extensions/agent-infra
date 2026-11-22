import { sql } from "drizzle-orm";
import {
	check,
	index,
	jsonb,
	text,
	timestamp,
	unique,
} from "drizzle-orm/pg-core";

import { platformSchema } from "./schema-common";

// Engineering Spec §18.5.1 载体与版本: persisted Runtime safety evidence. Rows are only
// appended after the Worker re-checked the window and the original execution scope; the
// trigger in the migration rejects every UPDATE and DELETE. Not a business fact, not an
// event, and never joined into conversation history or SSE.
export const runtimeSafetyEvidence = platformSchema.table(
	"runtime_safety_evidence",
	{
		evidenceId: text("evidence_id").primaryKey(),
		kind: text("kind").notNull(),
		code: text("code").notNull(),
		agentId: text("agent_id").notNull(),
		conversationId: text("conversation_id").notNull(),
		executionId: text("execution_id").notNull(),
		challengeRef: text("challenge_ref").notNull(),
		record: jsonb("record").notNull(),
		recordSha256: text("record_sha256").notNull(),
		recordedAt: timestamp("recorded_at", { withTimezone: true })
			.default(sql`clock_timestamp()`)
			.notNull(),
	},
	(table) => [
		// A challenge is single-use: a second record for it is a replay, not new evidence.
		unique("runtime_safety_evidence_challenge").on(
			table.kind,
			table.challengeRef,
		),
		index("runtime_safety_evidence_execution").on(
			table.conversationId,
			table.executionId,
		),
		check(
			"runtime_safety_evidence_kind",
			sql`${table.kind} in ('isolation_observation', 'original_admission_check')`,
		),
		check(
			"runtime_safety_evidence_code",
			sql`(${table.kind} = 'isolation_observation' and ${table.code} = 'RUNTIME_ISOLATION_EVIDENCE_V1')
				or (${table.kind} = 'original_admission_check' and ${table.code} = 'RUNTIME_ORIGINAL_ADMISSION_CHECK_V1')`,
		),
		check(
			"runtime_safety_evidence_references",
			sql`char_length(${table.evidenceId}) between 1 and 128
				and char_length(${table.challengeRef}) between 1 and 128
				and char_length(${table.agentId}) between 1 and 1024
				and char_length(${table.conversationId}) between 1 and 1024
				and char_length(${table.executionId}) between 1 and 1024`,
		),
		check(
			"runtime_safety_evidence_digest",
			sql`${table.recordSha256} ~ '^[a-f0-9]{64}$'`,
		),
		check(
			"runtime_safety_evidence_record_object",
			sql`jsonb_typeof(${table.record}) = 'object'`,
		),
	],
);
