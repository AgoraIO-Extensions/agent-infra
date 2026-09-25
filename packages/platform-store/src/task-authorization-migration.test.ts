import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgresConversationQueryV1 } from "./conversation-query.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";
import {
	type LegacyTaskMetadataV1,
	type LegacyTaskProducerEvidenceV1,
	PostgresLegacyTaskAuthorizationMigrationV1,
	PostgresLegacyTaskRecoveryReaderV1,
} from "./task-authorization-migration.ts";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let migration: PostgresLegacyTaskAuthorizationMigrationV1;
let query: PostgresConversationQueryV1;
const acceptedAt = new Date("2026-09-05T09:00:00.000Z");
const bodySentinel = "legacy-private-task-body-sentinel";
const fixtures = new Map<
	string,
	{
		metadata: LegacyTaskMetadataV1;
		evidence: LegacyTaskProducerEvidenceV1 | null;
	}
>();
const verify = vi.fn(
	async (input: {
		evidenceReference: string;
		metadata: LegacyTaskMetadataV1;
		metadataDigest: string;
	}) => {
		const fixture = fixtures.get(input.evidenceReference);
		if (!fixture) return null;
		// Controlled historical producer archive, authored before the incremental upgrade.
		expect(input.metadata).toEqual(fixture.metadata);
		expect(JSON.stringify(input)).not.toContain(bodySentinel);
		return structuredClone(fixture.evidence);
	},
);

function digest(input: unknown): string {
	function canonical(value: unknown): unknown {
		if (Array.isArray(value)) return value.map(canonical);
		if (!value || typeof value !== "object") return value;
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, canonical(item)]),
		);
	}
	return createHash("sha256")
		.update(JSON.stringify(canonical(input)))
		.digest("hex");
}

async function seed(
	name: string,
	status: "completed" | "unknown" | "processing",
	scope: "full" | "principal" | "unproven" = "full",
) {
	const executionId = `execution-${name}`;
	const conversationId = `conversation-${name}`;
	const actorId = `original-user-${name}`;
	const agentId = `agent-${name}`;
	const metadata: LegacyTaskMetadataV1 = {
		executionId,
		conversationId,
		agentId,
		actorId,
		channelId: "web",
		turnId: `turn-${name}`,
		sessionGeneration: 3,
		agentAuthorizationRevision: "historical-agent-revision",
		modelConfigurationRevision: 7,
		modelOptionId: "original-model",
		reasoningLevel: "medium",
		acceptedAt: acceptedAt.toISOString(),
		acceptanceAuditId: `acceptance-${name}`,
		traceId: `trace-${name}`,
		requestId: `request-${name}`,
		idempotencyRecordId: `idempotency-${name}`,
		commandType: "message",
		requestDigest: createHash("sha256")
			.update(`original-request-${name}`)
			.digest("hex"),
	};
	const boundary = {
		schemaVersion: 1 as const,
		principal: { kind: "user" as const, id: actorId },
		agentId,
		channelId: "web",
		identityRevision: "historical-identity-revision",
		agentAuthorizationRevision: metadata.agentAuthorizationRevision,
		accessSources: [
			{
				kind: "organization" as const,
				organizationId: "historical-organization",
			},
		],
	};
	const evidence: LegacyTaskProducerEvidenceV1 = {
		schemaVersion: 1,
		evidenceReference: `archive-${name}`,
		producerRevision: "controlled-old-platform-producer-v1",
		metadataDigest: digest(metadata),
		principal: { kind: "user", id: actorId },
		originalBoundary: scope === "full" ? boundary : null,
		originalOperationDigest: createHash("sha256")
			.update(`original-host-operation-${name}`)
			.digest("base64url"),
		hostSessionRef: `original-host-${name}`,
	};
	fixtures.set(evidence.evidenceReference, {
		metadata,
		evidence: scope === "unproven" ? null : evidence,
	});
	await sql`insert into platform.agents (id, authorization_revision) values (${agentId}, 'current-unrelated-revision')`;
	await sql`insert into platform.agent_owners (agent_id, owner_id, created_at) values (${agentId}, ${actorId}, now())`;
	await sql`insert into platform.conversations (id, agent_id, actor_id, channel_id, status, session_generation, host_session_ref, authorization_revision, last_conversation_cursor, created_at, updated_at, selected_model_option_id, selected_reasoning_level)
		values (${conversationId}, ${agentId}, ${actorId}, 'web', 'active', 3, ${evidence.hostSessionRef}, 'historical-agent-revision', 1, ${acceptedAt}, ${acceptedAt}, 'original-model', 'medium')`;
	await sql`insert into platform.conversation_executions (execution_id, conversation_id, agent_id, actor_id, channel_id, turn_id, status, session_generation, delivery_fence, authorization_revision, created_at, updated_at, last_event_sequence, last_runtime_cursor, model_configuration_revision, model_option_id, reasoning_level)
		values (${executionId}, ${conversationId}, ${agentId}, ${actorId}, 'web', ${metadata.turnId}, ${status}, 3, 9, 'historical-agent-revision', ${acceptedAt}, ${acceptedAt}, 1, ${`original-cursor-${name}`}, 7, 'original-model', 'medium')`;
	await sql`insert into platform.conversation_messages (message_id, conversation_id, actor_id, role, text, execution_id, status, created_at, updated_at)
		values (${`message-${name}`}, ${conversationId}, ${actorId}, 'user', ${bodySentinel}, ${executionId}, 'submitted', ${acceptedAt}, ${acceptedAt})`;
	await sql`insert into platform.conversation_events (event_id, conversation_id, execution_id, adapter_event_key, sequence, conversation_cursor, event_type, event_payload, event_digest, runtime_cursor, occurred_at, source, persisted_at)
		values (${`event-${name}`}, ${conversationId}, ${executionId}, ${`adapter-${name}`}, 1, 1, 'text.delta', ${sql.json({ type: "text.delta", text: bodySentinel })}, ${"b".repeat(64)}, ${`original-cursor-${name}`}, ${acceptedAt}, 'runtime', ${acceptedAt})`;
	await sql`insert into platform.conversation_audit_events (id, conversation_id, execution_id, agent_id, actor_id, action, trace_id, request_id, occurred_at)
		values (${metadata.acceptanceAuditId}, ${conversationId}, ${executionId}, ${agentId}, ${actorId}, 'conversation.message.accepted', ${metadata.traceId}, ${metadata.requestId}, ${acceptedAt})`;
	await sql`insert into platform.idempotency_records (id, scope_type, scope_id, actor_id, command_type, idempotency_key, request_digest, status, result, created_at, updated_at)
		values (${metadata.idempotencyRecordId}, 'conversation', ${conversationId}, ${actorId}, 'message', ${`key-${name}`}, ${metadata.requestDigest}, 'completed', ${sql.json({ schemaVersion: 1, status: "submitted", messageId: `message-${name}`, executionId })}, ${acceptedAt}, ${acceptedAt})`;
	await sql`insert into platform.outbox_items (id, scope_type, scope_id, operation, payload, trace_id, request_id)
		values (${`conversation:turn:${executionId}`}, 'conversation', ${conversationId}, 'conversation.turn.submit.v1', ${sql.json({ schemaVersion: 1, conversationId, executionId, messageId: `message-${name}`, turnId: metadata.turnId, sessionGeneration: 3, modelConfigurationRevision: 7, modelOptionId: "original-model", reasoningLevel: "medium" })}, ${metadata.traceId}, ${metadata.requestId})`;
}

async function snapshotHistory() {
	const snapshots: unknown[] = [];
	for (const table of [
		"agents",
		"agent_owners",
		"conversations",
		"conversation_executions",
		"conversation_messages",
		"conversation_events",
		"conversation_audit_events",
		"idempotency_records",
		"outbox_items",
	]) {
		const record =
			table === "conversation_executions"
				? "to_jsonb(record) - 'task_wait_order' - 'task_wait_deadline'"
				: "to_jsonb(record)";
		snapshots.push(
			await sql.unsafe(
				`select ${record}::text as value from platform.${table} record order by ${record}::text`,
			),
		);
	}
	return snapshots;
}

function input(name: string) {
	return {
		executionId: `execution-${name}`,
		evidenceReference: `archive-${name}`,
		migrationId: "upgrade-508-controlled",
	};
}

beforeAll(async () => {
	database = await startPostgresTestDatabase("task-authorization-upgrade");
	sql = postgres(database.databaseUrl, { max: 2, onnotice: () => undefined });
	const migrations = readMigrationFiles({
		migrationsFolder: resolve(
			import.meta.dirname,
			"../../../migrations/platform",
		),
	});
	const previous = migrations.slice(0, 14);
	expect(previous).toHaveLength(14);
	for (const entry of previous)
		for (const statement of entry.sql)
			if (statement.trim()) await sql.unsafe(statement);
	for (const name of [
		"complete",
		"bad-actor",
		"bad-scope",
		"bad-digest",
		"bad-host",
		"audit-fail",
		"no-audit",
		"ambiguous",
		"changed",
		"read-tamper",
		"replay-audit",
		"read-isolation",
	])
		await seed(name, "completed");
	await seed("recovery", "unknown", "principal");
	await seed("unproven", "processing", "unproven");
	const before = await snapshotHistory();
	await sql`create schema platform_migrations`;
	await sql`create table platform_migrations.history (id serial primary key, hash text not null, created_at bigint)`;
	for (const entry of previous)
		await sql`insert into platform_migrations.history (hash, created_at) values (${entry.hash}, ${entry.folderMillis})`;
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	expect(await snapshotHistory()).toEqual(before);
	expect(
		await sql`select count(*)::int as count from platform.conversation_executions
			where task_wait_order is not null or task_wait_deadline is not null`,
	).toEqual([{ count: 0 }]);
	const history =
		await sql`select * from platform_migrations.history order by id`;
	expect(history).toHaveLength(migrations.length);
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	expect(
		await sql`select * from platform_migrations.history order by id`,
	).toEqual(history);
	expect(
		await sql`select * from platform.task_authorization_records`,
	).toHaveLength(0);
	// The migration process cannot read prompt/messages or event bodies at the SQL permission layer.
	await sql`create role legacy_task_migrator login password 'controlled_local_migration_test'`;
	await sql`grant usage on schema platform to legacy_task_migrator`;
	await sql`grant select on platform.conversations, platform.conversation_executions, platform.conversation_audit_events, platform.idempotency_records, platform.audit_events, platform.task_authorization_records, platform.agents, platform.workload_reconciliations to legacy_task_migrator`;
	await sql`grant update (id) on platform.conversations, platform.conversation_audit_events, platform.idempotency_records to legacy_task_migrator`;
	await sql`grant update (execution_id) on platform.conversation_executions to legacy_task_migrator`;
	await sql`grant insert on platform.audit_events, platform.task_authorization_records to legacy_task_migrator`;
	const restrictedUrl = new URL(database.databaseUrl);
	restrictedUrl.username = "legacy_task_migrator";
	restrictedUrl.password = "controlled_local_migration_test";
	const restricted = postgres(restrictedUrl.toString(), { max: 1 });
	try {
		await expect(
			restricted`select text from platform.conversation_messages`,
		).rejects.toMatchObject({ code: "42501" });
	} finally {
		await restricted.end();
	}
	migration = new PostgresLegacyTaskAuthorizationMigrationV1({
		databaseUrl: restrictedUrl.toString(),
		verifyProducerEvidence: verify,
	});
	query = new PostgresConversationQueryV1({
		databaseUrl: database.databaseUrl,
	});
}, 120_000);

afterAll(async () => {
	await migration?.close();
	await query?.close();
	await sql?.end();
	await database?.stop();
});

describe("historical task authorization upgrade", () => {
	it("preserves completed records and reads the original identity, model, Session and cursor without current role inference", async () => {
		const before = await snapshotHistory();
		const result = await migration.migrate(input("complete"));
		if (result.outcome === "unproven")
			throw new Error("Expected migrated evidence");
		expect(result).toMatchObject({
			outcome: "migrated",
			authorizationRecordId: expect.any(String),
		});
		const fixture = fixtures.get("archive-complete");
		const [authorization] =
			await sql`select boundary from platform.task_authorization_records where execution_id = 'execution-complete'`;
		expect(authorization?.boundary).toEqual(
			fixture?.evidence?.originalBoundary,
		);
		expect(authorization?.boundary.accessSources).toEqual([
			{ kind: "organization", organizationId: "historical-organization" },
		]);
		expect(
			await migration.readLegacyControlRecovery("execution-complete"),
		).toMatchObject({
			originalPrincipal: { kind: "user", id: "original-user-complete" },
			migrationRecordId: result.migrationRecordId,
			executionStatus: "completed",
			hostSessionRef: "original-host-complete",
			runtimeCursor: "original-cursor-complete",
			sessionGeneration: 3,
			deliveryFence: 9,
			originalOperationDigest: fixture?.evidence?.originalOperationDigest,
		});
		const detail = await query.getExecution(
			{ actorId: "original-user-complete", channelId: "web" },
			"conversation-complete",
			"execution-complete",
		);
		expect(detail).toMatchObject({
			execution: { status: "completed" },
			events: [{ eventId: "event-complete", sequence: 1 }],
		});
		expect(await snapshotHistory()).toEqual(before);
		expect(await migration.migrate(input("complete"))).toEqual({
			...result,
			outcome: "replayed",
		});
		expect(await snapshotHistory()).toEqual(before);
	});

	it("permits only body-free recovery when the original principal is proven but scope is unknown", async () => {
		const before = await snapshotHistory();
		const result = await migration.migrate(input("recovery"));
		expect(result).toMatchObject({
			outcome: "migrated",
			authorizationRecordId: null,
		});
		const recovery =
			await migration.readLegacyControlRecovery("execution-recovery");
		const reader = new PostgresLegacyTaskRecoveryReaderV1({
			databaseUrl: database.databaseUrl,
		});
		try {
			expect(reader).not.toHaveProperty("migrate");
			expect(
				await reader.readLegacyControlRecovery("execution-recovery"),
			).toEqual(recovery);
		} finally {
			await reader.close();
		}
		expect(recovery).toMatchObject({
			configurationRevision: 1,
			workload: null,
		});
		expect(recovery).toMatchObject({
			originalPrincipal: { kind: "user", id: "original-user-recovery" },
			executionStatus: "unknown",
			runtimeCursor: "original-cursor-recovery",
			hostSessionRef: "original-host-recovery",
		});
		expect(JSON.stringify(recovery)).not.toContain(bodySentinel);
		expect(
			await sql`select * from platform.task_authorization_records where execution_id = 'execution-recovery'`,
		).toHaveLength(0);
		expect(
			await sql`select * from platform.audit_events where target_id = 'execution-recovery' and action = 'task.authorization.accepted'`,
		).toHaveLength(0);
		expect(
			await query.getExecution(
				{ actorId: "original-user-recovery", channelId: "web" },
				"conversation-recovery",
				"execution-recovery",
			),
		).toMatchObject({ execution: { status: "unknown" } });
		expect(await migration.migrate(input("recovery"))).toEqual({
			...result,
			outcome: "replayed",
		});
		expect(await snapshotHistory()).toEqual(before);
	});

	it("retains unproven old records and denies both business authority and original-principal recovery", async () => {
		const before = await snapshotHistory();
		expect(await migration.migrate(input("unproven"))).toEqual({
			outcome: "unproven",
		});
		expect(
			await migration.readLegacyControlRecovery("execution-unproven"),
		).toBeNull();
		expect(
			await sql`select * from platform.task_authorization_records where execution_id = 'execution-unproven'`,
		).toHaveLength(0);
		expect(
			await sql`select * from platform.audit_events where target_id = 'execution-unproven'`,
		).toHaveLength(0);
		expect(await snapshotHistory()).toEqual(before);
	});

	it("rejects wrong typed principal, historical scope binding, metadata and Host Session", async () => {
		for (const [name, change] of [
			[
				"bad-actor",
				{ principal: { kind: "application", id: "original-user-bad-actor" } },
			],
			[
				"bad-scope",
				{
					originalBoundary: {
						...fixtures.get("archive-bad-scope")?.evidence?.originalBoundary,
						agentAuthorizationRevision: "current-unrelated-revision",
					},
				},
			],
			["bad-digest", { metadataDigest: "c".repeat(64) }],
			["bad-host", { hostSessionRef: "another-host-session" }],
		] as const) {
			const fixture = fixtures.get(`archive-${name}`);
			if (!fixture?.evidence) throw new Error("Missing fixture");
			fixture.evidence = {
				...fixture.evidence,
				...change,
			} as LegacyTaskProducerEvidenceV1;
			const before = await snapshotHistory();
			await expect(migration.migrate(input(name))).rejects.toThrow(
				"Legacy task authorization evidence is unavailable",
			);
			expect(
				await sql`select * from platform.task_authorization_records where execution_id = ${`execution-${name}`}`,
			).toHaveLength(0);
			expect(
				await sql`select * from platform.audit_events where target_id = ${`execution-${name}`}`,
			).toHaveLength(0);
			expect(await snapshotHistory()).toEqual(before);
		}
	});

	it("requires matching unique original acceptance and idempotency evidence", async () => {
		await sql`delete from platform.conversation_audit_events where id = 'acceptance-no-audit'`;
		await sql`insert into platform.idempotency_records (id, scope_type, scope_id, actor_id, command_type, idempotency_key, request_digest, status, result, created_at, updated_at)
			select 'ambiguous-second', scope_type, scope_id, actor_id, command_type, 'second-key', request_digest, status, result, created_at, updated_at from platform.idempotency_records where id = 'idempotency-ambiguous'`;
		const count = verify.mock.calls.length;
		for (const name of ["no-audit", "ambiguous"])
			expect(await migration.migrate(input(name))).toEqual({
				outcome: "unproven",
			});
		expect(verify.mock.calls).toHaveLength(count);
	});

	it("rolls back new boundary and acceptance audit if the migration audit cannot be written", async () => {
		await sql.unsafe(
			`create function platform.fail_legacy_migration_audit() returns trigger as $$ begin if NEW.action = 'task.legacy_principal.migrated' then raise exception 'private-error-body-sentinel'; end if; return NEW; end; $$ language plpgsql`,
		);
		await sql.unsafe(
			"create trigger fail_legacy_migration_audit before insert on platform.audit_events for each row execute function platform.fail_legacy_migration_audit()",
		);
		const before = await snapshotHistory();
		try {
			await expect(migration.migrate(input("audit-fail"))).rejects.toThrow(
				/^Legacy task authorization evidence is unavailable$/,
			);
			expect(
				await sql`select * from platform.task_authorization_records where execution_id = 'execution-audit-fail'`,
			).toHaveLength(0);
			expect(
				await sql`select * from platform.audit_events where target_id = 'execution-audit-fail'`,
			).toHaveLength(0);
			expect(await snapshotHistory()).toEqual(before);
		} finally {
			await sql`drop trigger fail_legacy_migration_audit on platform.audit_events`;
			await sql`drop function platform.fail_legacy_migration_audit()`;
		}
		expect(await migration.migrate(input("audit-fail"))).toMatchObject({
			outcome: "migrated",
		});
	});

	it("rechecks historical metadata after verifier completion and rejects changed provenance", async () => {
		const special = new PostgresLegacyTaskAuthorizationMigrationV1({
			databaseUrl: database.databaseUrl,
			verifyProducerEvidence: async (request) => {
				const evidence = await verify(request);
				await sql`update platform.conversation_executions set turn_id = 'changed-turn' where execution_id = 'execution-changed'`;
				return evidence;
			},
		});
		try {
			await expect(special.migrate(input("changed"))).rejects.toThrow(
				"Legacy task authorization evidence is unavailable",
			);
		} finally {
			await special.close();
		}
		expect(
			await sql`select * from platform.task_authorization_records where execution_id = 'execution-changed'`,
		).toHaveLength(0);
	});

	it("fails recovery on tampered stored principal and prevents cross-user readback", async () => {
		await migration.migrate(input("read-tamper"));
		await sql`update platform.audit_events set details = jsonb_set(details, '{evidence,principal,id}', '"another-user"') where action = 'task.legacy_principal.migrated' and target_id = 'execution-read-tamper'`;
		await expect(
			migration.readLegacyControlRecovery("execution-read-tamper"),
		).rejects.toThrow("Legacy task authorization evidence is unavailable");
		await migration.migrate(input("read-isolation"));
		expect(
			await query.getExecution(
				{ actorId: "another-user", channelId: "web" },
				"conversation-read-isolation",
				"execution-read-isolation",
			),
		).toBeUndefined();
		expect(
			await query.getExecution(
				{
					actorId: "original-user-read-isolation",
					channelId: "another-channel",
				},
				"conversation-read-isolation",
				"execution-read-isolation",
			),
		).toBeUndefined();
		await sql`update platform.conversation_executions set actor_id = 'another-user' where execution_id = 'execution-read-isolation'`;
		expect(
			await migration.readLegacyControlRecovery("execution-read-isolation"),
		).toBeNull();
	});

	it("rejects replay with missing required acceptance audit or a replacement migration identity", async () => {
		await migration.migrate(input("replay-audit"));
		await sql`delete from platform.audit_events where action = 'task.authorization.accepted' and target_id = 'execution-replay-audit'`;
		await expect(migration.migrate(input("replay-audit"))).rejects.toThrow(
			"Legacy task authorization evidence is unavailable",
		);
		await expect(
			migration.migrate({ ...input("complete"), migrationId: "replacement" }),
		).rejects.toThrow("Legacy task authorization evidence is unavailable");
	});

	it("sanitizes producer failures and never installs a default verifier", async () => {
		expect(
			() =>
				new PostgresLegacyTaskAuthorizationMigrationV1({
					databaseUrl: database.databaseUrl,
					verifyProducerEvidence: undefined as never,
				}),
		).toThrow("Legacy task authorization evidence is unavailable");
		const unavailable = new PostgresLegacyTaskAuthorizationMigrationV1({
			databaseUrl: database.databaseUrl,
			verifyProducerEvidence: async () => {
				throw new Error(bodySentinel);
			},
		});
		try {
			await expect(unavailable.migrate(input("complete"))).rejects.toThrow(
				/^Legacy task authorization evidence is unavailable$/,
			);
		} finally {
			await unavailable.close();
		}
		const audits = await sql`select details from platform.audit_events`;
		expect(JSON.stringify(audits)).not.toContain(bodySentinel);
	});
});
