import {
	type RuntimeIsolationEvidenceV1,
	RuntimePersistedSafetyEvidenceV1Schema,
} from "@agent-infra/contracts/runtime";
import { ingestRuntimeSafetyEvidenceBatchV1 } from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";
import { PostgresRuntimeSafetyEvidenceStoreV1 } from "./runtime-safety-evidence.js";

const sandboxId = "0a0b0c0d-1111-4222-8333-444455556666";
const podUid = "11111111-2222-4333-8444-555555555555";
const imageDigest = `sha256:${"a".repeat(64)}`;

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
			authorization: { recordId: "auth-1", revision: "identity-8" },
			sessionGeneration: 1,
			executionDeliveryFence: 1,
			sandbox: { ref: sandboxId, podUid, resourceFence: 1 },
			host: {
				instanceRef: "host-1",
				startRef: "start-1",
				configurationRevision: "7",
				imageDigest,
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

/**
 * The Execution's committed original binding. Foreign keys to the Conversation and Agent
 * fixtures are skipped; the evidence store only reads these rows.
 */
async function seedOriginalBinding() {
	await sql.begin(async (transaction) => {
		await transaction`set local session_replication_role = replica`;
		await transaction`delete from platform.task_authorization_records where execution_id = 'execution-1'`;
		await transaction`delete from platform.conversation_executions where execution_id = 'execution-1'`;
		await transaction`delete from platform.session_sandbox_allocations where sandbox_id = ${sandboxId}`;
		await transaction`
			insert into platform.conversation_executions (
				execution_id, conversation_id, agent_id, actor_id, channel_id, turn_id, status,
				session_generation, delivery_fence, authorization_revision, created_at, sandbox_id
			) values (
				'execution-1', 'conversation-1', 'agent-1', 'user-1', 'web', 'turn-1', 'processing',
				1, 1, 'identity-8', now(), ${sandboxId}
			)`;
		await transaction`
			insert into platform.task_authorization_records (id, execution_id, boundary)
			values ('auth-1', 'execution-1', ${transaction.json({
				schemaVersion: 1,
				principal: { kind: "user", id: "user-1" },
			})})`;
		await transaction`
			insert into platform.session_sandbox_allocations (
				sandbox_id, conversation_id, agent_id, actor_id, principal_type, channel_id,
				session_generation, resource_name, workspace_scope, status, created_at, updated_at,
				resource_fence, resource_policy, resource_observation
			) values (
				${sandboxId}, 'conversation-1', 'agent-1', 'user-1', 'user', 'web', 1,
				${`sandbox-${sandboxId}`}, ${sandboxId}, 'ready', now(), now(), 1,
				${transaction.json({ configurationRevision: 7, imageDigest })},
				${transaction.json({
					status: "ready",
					resources: [
						{
							kind: "Pod",
							namespace: "agents",
							name: `sandbox-${sandboxId}-0`,
							uid: podUid,
							resourceVersion: "1",
						},
					],
				})}
			)`;
	});
}

beforeEach(async () => {
	await sql`truncate platform.runtime_safety_evidence`;
	await seedOriginalBinding();
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

it("reads the original operation/attempt pairs of one Execution from its committed Runtime facts", async () => {
	const rows = [
		[
			"event-1",
			"execution-1",
			"operation-1",
			"attempt-1",
			"runtime",
			"execution.operation",
		],
		[
			"event-2",
			"execution-1",
			"operation-1",
			"attempt-1",
			"runtime",
			"execution.operation",
		],
		[
			"event-3",
			"execution-1",
			"operation-1",
			"attempt-2",
			"runtime",
			"execution.operation",
		],
		[
			"event-4",
			"execution-2",
			"operation-9",
			"attempt-9",
			"runtime",
			"execution.operation",
		],
		[
			"event-6",
			"execution-1",
			"operation-7",
			"attempt-7",
			"runtime",
			"message.delta",
		],
	] as const;
	// Only the evidence query is under test, so the Conversation and Execution fixtures are
	// skipped by disabling the foreign-key triggers for this transaction.
	await sql.begin(async (transaction) => {
		await transaction`set local session_replication_role = replica`;
		await transaction`delete from platform.conversation_events where conversation_id = 'conversation-1'`;
		for (const [
			index,
			[eventId, executionId, operationRef, attemptRef, source, eventType],
		] of rows.entries())
			await transaction`
				insert into platform.conversation_events (
					event_id, conversation_id, execution_id, adapter_event_key, sequence,
					conversation_cursor, event_type, event_payload, event_digest, runtime_cursor,
					occurred_at, source
				) values (
					${eventId}, 'conversation-1', ${executionId}, ${eventId}, ${index + 1},
					${index + 1}, ${eventType},
					${transaction.json({ fact: { operationRef, attemptRef } })}, ${"d".repeat(64)},
					${eventId}, now(), ${source}
				)`;
	});
	const pairs = await store.readExecutionOperationAttempts({
		conversationId: "conversation-1",
		executionId: "execution-1",
	});
	expect(
		[...pairs].sort((a, b) => a.attemptRef.localeCompare(b.attemptRef)),
	).toEqual([
		{ ref: "operation-1", attemptRef: "attempt-1" },
		{ ref: "operation-1", attemptRef: "attempt-2" },
	]);
	expect(
		await store.readExecutionOperationAttempts({
			conversationId: "conversation-2",
			executionId: "execution-1",
		}),
	).toEqual([]);
});

/** Worker ingest exactly as wired: the scope was read, then the original binding moves. */
async function ingestAfterScopeRead(change: () => Promise<void>) {
	const window = {
		windowRef: "window-1",
		opensAt: "2026-11-21T00:00:00.000Z",
		closesAt: "2026-11-22T12:00:00.000Z",
		agentIds: ["agent-1"],
		principalRefs: ["principal-1"],
		scenarios: [
			{
				id: "u1-file",
				version: 1,
				resourceClasses: ["file" as const],
				actionClasses: ["write" as const],
			},
		],
		producers: [{ kind: "native_helper" as const, version: "u1-helper-1" }],
	};
	return ingestRuntimeSafetyEvidenceBatchV1({
		entries: [{ cursor: "se1-1", record: record() }],
		parse: (value) => RuntimePersistedSafetyEvidenceV1Schema.parse(value),
		window,
		resolveScope: async (value) => {
			const scope = {
				agentId: "agent-1",
				conversationId: "conversation-1",
				executionId: "execution-1",
				principalRef: "principal-1",
				purposeRef: "purpose-business",
				authorization: { recordId: "auth-1", revision: "identity-8" },
				sessionGeneration: 1,
				executionDeliveryFence: 1,
				operations: [{ ref: "operation-1", attemptRef: "attempt-1" }],
				sandbox: { ref: sandboxId, podUid, resourceFence: 1 },
				host: { ...value.binding.host },
				revoked: false,
			};
			await change();
			return scope;
		},
		store,
		now: () => new Date("2026-11-22T00:10:00.000Z"),
	});
}

it.each([
	[
		"the subject's permission is revoked",
		() =>
			sql`update platform.task_authorization_records set revoked_at = now() where id = 'auth-1'`,
		"revoked",
	],
	[
		"the Execution delivery fence advances",
		() =>
			sql`update platform.conversation_executions set delivery_fence = 2 where execution_id = 'execution-1'`,
		"stale_binding",
	],
	[
		"the Session generation advances",
		() =>
			sql`update platform.conversation_executions set session_generation = 2 where execution_id = 'execution-1'`,
		"stale_binding",
	],
	[
		"the Sandbox resource fence advances",
		() =>
			sql`update platform.session_sandbox_allocations set resource_fence = 2 where sandbox_id = ${sandboxId}`,
		"stale_binding",
	],
	[
		"the Sandbox is recreated with another Pod",
		() =>
			sql`update platform.session_sandbox_allocations set resource_observation = jsonb_set(resource_observation, '{resources,0,uid}', '"99999999-2222-4333-8444-555555555555"') where sandbox_id = ${sandboxId}`,
		"stale_binding",
	],
	[
		"the Sandbox runs another image",
		() =>
			sql`update platform.session_sandbox_allocations set resource_policy = jsonb_set(resource_policy, '{imageDigest}', ${JSON.stringify(`sha256:${"b".repeat(64)}`)}::jsonb) where sandbox_id = ${sandboxId}`,
		"stale_binding",
	],
	[
		"the authorization revision changes",
		() =>
			sql`update platform.conversation_executions set authorization_revision = 'identity-9' where execution_id = 'execution-1'`,
		"scope_mismatch",
	],
])(
	"does not store evidence when %s after the scope was read (S1)",
	async (_name, change, reason) => {
		const result = await ingestAfterScopeRead(async () => {
			await change();
		});
		expect(result).toMatchObject({
			ackCursor: "se1-1",
			recorded: 0,
			rejected: [{ cursor: "se1-1", reason }],
		});
		const rows = await sql<{ count: string }[]>`
		select count(*)::text as count from platform.runtime_safety_evidence`;
		expect(rows[0]?.count).toBe("0");
	},
);

it("stores the evidence when the original binding is unchanged (S1)", async () => {
	expect(await ingestAfterScopeRead(async () => {})).toMatchObject({
		recorded: 1,
		rejected: [],
	});
});

it("reads the committed original binding of one Execution for its own scope (#4367)", async () => {
	expect(
		await store.readOriginalScope({
			conversationId: "conversation-1",
			executionId: "execution-1",
		}),
	).toEqual({
		agentId: "agent-1",
		conversationId: "conversation-1",
		executionId: "execution-1",
		principal: { kind: "user", id: "user-1" },
		authorizationRecordId: "auth-1",
		authorizationRevision: "identity-8",
		revoked: false,
		sessionGeneration: 1,
		executionDeliveryFence: 1,
		sandbox: {
			ref: sandboxId,
			resourceFence: 1,
			podUid,
			configurationRevision: 7,
			imageDigest,
		},
		// The operation facts of this Execution, as read by readExecutionOperationAttempts.
		operations: expect.any(Array),
	});
	for (const other of [
		{ conversationId: "conversation-1", executionId: "execution-9" },
		{ conversationId: "conversation-2", executionId: "execution-1" },
	])
		expect(await store.readOriginalScope(other)).toBeUndefined();
	await sql`update platform.session_sandbox_allocations set resource_observation = null where sandbox_id = ${sandboxId}`;
	expect(
		await store.readOriginalScope({
			conversationId: "conversation-1",
			executionId: "execution-1",
		}),
	).toBeUndefined();
});

it("gives up the evidence write instead of waiting on a business lock (#4367 S1)", async () => {
	await sql.begin(async (business) => {
		await business`select execution_id from platform.conversation_executions where execution_id = 'execution-1' for update`;
		const startedAt = Date.now();
		await expect(store.recordOnce(record())).rejects.toThrow();
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});
	expect(await store.recordOnce(record())).toBe("recorded");
});
