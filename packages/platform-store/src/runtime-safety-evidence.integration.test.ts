import {
	type RuntimeIsolationEvidenceV1,
	RuntimePersistedSafetyEvidenceV1Schema,
} from "@agent-infra/contracts/runtime";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";
import { PostgresRuntimeSafetyEvidenceStoreV1 } from "./runtime-safety-evidence.js";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let store: PostgresRuntimeSafetyEvidenceStoreV1;

const record = (
	change: (value: Record<string, any>) => void = () => {},
): RuntimeIsolationEvidenceV1 => {
	const value: Record<string, any> = {
		schemaVersion: 1,
		code: "RUNTIME_ISOLATION_EVIDENCE_V1",
		kind: "isolation_observation",
		binding: {
			evidenceId: "evidence-1",
			scenario: { id: "u1-file", version: 1 },
			windowRef: "window-1",
			challengeRef: "challenge-1",
			agentId: "agent-1",
			conversationId: "conversation-1",
			executionId: "execution-1",
			operation: { ref: "operation-1", attemptRef: "attempt-1" },
			principalRef: "principal-1",
			purposeRef: "purpose-business",
			sessionGeneration: 1,
			executionDeliveryFence: 1,
			sandbox: {
				ref: "sandbox-1",
				podUid: "11111111-2222-4333-8444-555555555555",
				resourceFence: 1,
			},
			host: {
				instanceRef: "host-1",
				startRef: "start-1",
				configurationRevision: "config-1",
				imageDigest: `sha256:${"a".repeat(64)}`,
			},
			producer: { kind: "native_helper", version: "u1-helper-1" },
			observedAt: "2026-11-22T00:00:00.000Z",
			clockId: "clock-1",
			sequence: 1,
		},
		resourceClass: "file",
		actionClass: "write",
		targetScope: "self",
		resultClass: "allowed",
		nativeObserved: true,
		syntheticFile: { byteLength: 12, sha256: "b".repeat(64) },
	};
	change(value);
	return RuntimePersistedSafetyEvidenceV1Schema.parse(value);
};

beforeAll(async () => {
	database = await startPostgresTestDatabase("runtime-safety-evidence");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 2, onnotice: () => {} });
	store = new PostgresRuntimeSafetyEvidenceStoreV1({
		databaseUrl: database.databaseUrl,
	});
}, 120_000);

beforeEach(async () => {
	await sql`truncate platform.runtime_safety_evidence`;
});

afterAll(async () => {
	await store?.close();
	await sql?.end({ timeout: 5 });
	await database?.stop();
});

it("stores a record once, returns the original for a duplicate and reads it back for the same Execution only", async () => {
	expect(await store.recordOnce(record())).toBe("recorded");
	// Key order of a redelivered record does not matter.
	const reordered = JSON.parse(JSON.stringify(record()));
	expect(
		await store.recordOnce(
			RuntimePersistedSafetyEvidenceV1Schema.parse({ ...reordered }),
		),
	).toBe("duplicate");
	expect(
		await store.read({
			conversationId: "conversation-1",
			executionId: "execution-1",
			evidenceId: "evidence-1",
		}),
	).toEqual(record());
	for (const other of [
		{ conversationId: "conversation-2", executionId: "execution-1" },
		{ conversationId: "conversation-1", executionId: "execution-2" },
	])
		expect(
			await store.read({ ...other, evidenceId: "evidence-1" }),
		).toBeUndefined();
	const rows = await sql<
		{ count: string }[]
	>`select count(*)::text as count from platform.runtime_safety_evidence`;
	expect(rows[0]?.count).toBe("1");
});

it("rejects a replayed challenge and a different record under the same ID without writing", async () => {
	await store.recordOnce(record());
	expect(
		await store.recordOnce(
			record((v) => {
				v.binding.evidenceId = "evidence-2";
			}),
		),
	).toBe("challenge_replay");
	expect(
		await store.recordOnce(
			record((v) => {
				v.syntheticFile.byteLength = 13;
			}),
		),
	).toBe("evidence_conflict");
	const rows = await sql<
		{ evidence_id: string; record: { syntheticFile: { byteLength: number } } }[]
	>`
		select evidence_id, record from platform.runtime_safety_evidence`;
	expect(
		rows.map((row) => [row.evidence_id, row.record.syntheticFile.byteLength]),
	).toEqual([["evidence-1", 12]]);
});

it("refuses UPDATE and DELETE on stored evidence", async () => {
	await store.recordOnce(record());
	await expect(
		sql`update platform.runtime_safety_evidence set code = code`,
	).rejects.toThrow(/append-only/);
	await expect(
		sql`delete from platform.runtime_safety_evidence`,
	).rejects.toThrow(/append-only/);
	await expect(
		sql`insert into platform.runtime_safety_evidence (evidence_id, kind, code, agent_id, conversation_id, execution_id, challenge_ref, record, record_sha256)
			values ('e', 'control_observation', 'RUNTIME_CONTROL_EVIDENCE_V1', 'a', 'c', 'x', 'ch', '{}'::jsonb, ${"c".repeat(64)})`,
	).rejects.toThrow(/runtime_safety_evidence_(kind|code)/);
});

it("fails a read whose stored record no longer matches its digest", async () => {
	await store.recordOnce(record());
	await sql`alter table platform.runtime_safety_evidence disable trigger runtime_safety_evidence_append_only`;
	await sql`update platform.runtime_safety_evidence set record = jsonb_set(record, '{syntheticFile,byteLength}', '99')`;
	await sql`alter table platform.runtime_safety_evidence enable trigger runtime_safety_evidence_append_only`;
	await expect(
		store.read({
			conversationId: "conversation-1",
			executionId: "execution-1",
			evidenceId: "evidence-1",
		}),
	).rejects.toThrow("RUNTIME_SAFETY_EVIDENCE_DIGEST_MISMATCH");
});

it("persists the necessary read audit with the trusted subject, confirmed scope and result only", async () => {
	await sql`delete from platform.audit_events where action = 'runtime_evidence.read'`;
	await store.recordReadAudit({
		action: "runtime_evidence.read",
		traceId: "trace-1",
		requestId: "request-1",
		principal: { kind: "user", id: "user-1" },
		outcome: "succeeded",
		target: {
			evidenceRef: "evidence-1",
			agentId: "agent-1",
			conversationId: "conversation-1",
			executionId: "execution-1",
		},
	});
	await store.recordReadAudit({
		action: "runtime_evidence.read",
		traceId: "trace-2",
		requestId: "request-2",
		principal: { kind: "user", id: "user-2" },
		outcome: "rejected",
		target: null,
		reason: "RESOURCE_UNAVAILABLE",
	});
	const rows = await sql<
		{
			trace_id: string;
			request_id: string;
			actor_type: string;
			actor_id: string;
			target_type: string;
			target_id: string;
			outcome: string;
			agent_id: string | null;
			details: unknown;
		}[]
	>`
		select trace_id, request_id, actor_type, actor_id, target_type, target_id, outcome, agent_id, details
		from platform.audit_events where action = 'runtime_evidence.read' order by trace_id`;
	expect(rows).toEqual([
		{
			trace_id: "trace-1",
			request_id: "request-1",
			actor_type: "user",
			actor_id: "user-1",
			target_type: "runtime_evidence",
			target_id: "evidence-1",
			outcome: "succeeded",
			agent_id: "agent-1",
			details: {
				schemaVersion: 1,
				conversationId: "conversation-1",
				executionId: "execution-1",
			},
		},
		{
			trace_id: "trace-2",
			request_id: "request-2",
			actor_type: "user",
			actor_id: "user-2",
			target_type: "runtime_evidence",
			target_id: "unconfirmed",
			outcome: "rejected",
			agent_id: null,
			details: { schemaVersion: 1, reason: "RESOURCE_UNAVAILABLE" },
		},
	]);
	await expect(
		store.recordReadAudit({
			action: "runtime_evidence.read",
			traceId: "",
			requestId: "request-3",
			principal: { kind: "user", id: "user-1" },
			outcome: "rejected",
			target: null,
			reason: "RESOURCE_UNAVAILABLE",
		}),
	).rejects.toThrow();
});
