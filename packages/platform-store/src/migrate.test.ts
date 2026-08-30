import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { getTableConfig } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { platformDatabaseUrlFromEnvironment } from "./migrate.ts";
import {
	platformInfrastructureTables,
	platformStatusValues,
} from "./schema.ts";

const execFile = promisify(execFileCallback);
const postgresImage =
	"postgres@sha256:20edbde7749f822887a1a022ad526fde0a47d6b2be9a8364433605cf65099416";
const username = "platform_test";
const password = "platform_test_password";
const database = "platform_test";
type PostgresClient = ReturnType<typeof postgres>;
const builtStore: typeof import("./index.ts") = await import(
	new URL("../dist/index.mjs", import.meta.url).href
);

let containerName = "";
let databaseUrl = "";

async function removeContainer(): Promise<void> {
	if (containerName) {
		await execFile("docker", ["rm", "--force", containerName]).catch(() => {});
	}
}

async function startPostgres(): Promise<string> {
	containerName = `agent-infra-platform-store-${randomUUID()}`;
	await execFile("docker", [
		"run",
		"--detach",
		"--rm",
		"--name",
		containerName,
		"--env",
		`POSTGRES_USER=${username}`,
		"--env",
		`POSTGRES_PASSWORD=${password}`,
		"--env",
		`POSTGRES_DB=${database}`,
		"--publish",
		"127.0.0.1::5432",
		postgresImage,
	]);
	const { stdout } = await execFile("docker", [
		"port",
		containerName,
		"5432/tcp",
	]);
	const port = stdout.trim().match(/:(\d+)$/)?.[1];
	if (!port)
		throw new Error("PostgreSQL test container did not publish a port");
	const url = `postgres://${username}:${password}@127.0.0.1:${port}/${database}`;

	for (let attempt = 0; attempt < 80; attempt += 1) {
		const client = postgres(url, { connect_timeout: 1, max: 1 });
		try {
			await client`select 1`;
			await client.end();
			return url;
		} catch {
			await client.end({ timeout: 0 });
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw new Error("PostgreSQL test container did not become ready");
}

async function expectConstraintFailure(
	operation: PromiseLike<unknown>,
	constraint: string,
): Promise<void> {
	try {
		await operation;
		expect.fail(`Expected ${constraint} to reject the write`);
	} catch (error) {
		expect(error).toMatchObject({ constraint_name: constraint });
	}
}

async function readPlatformCatalog(client: PostgresClient) {
	const columns = await client`
		select table_name, column_name, ordinal_position, data_type, udt_schema,
			udt_name, is_nullable, column_default
		from information_schema.columns
		where table_schema = 'platform'
		order by table_name, ordinal_position
	`;
	const checks = await client`
		select t.relname as table_name, c.conname as constraint_name,
			pg_get_constraintdef(c.oid, true) as definition
		from pg_constraint c
		join pg_class t on t.oid = c.conrelid
		join pg_namespace n on n.oid = t.relnamespace
		where n.nspname = 'platform' and c.contype = 'c'
		order by t.relname, c.conname
	`;
	const indexes = await client`
		select tablename, indexname, indexdef
		from pg_indexes
		where schemaname = 'platform'
		order by tablename, indexname
	`;
	const enums = await client`
		select t.typname, e.enumlabel, e.enumsortorder
		from pg_type t
		join pg_enum e on e.enumtypid = t.oid
		join pg_namespace n on n.oid = t.typnamespace
		where n.nspname = 'platform'
		order by t.typname, e.enumsortorder
	`;
	return {
		columns: [...columns],
		checks: [...checks],
		indexes: [...indexes],
		enums: [...enums],
	};
}

beforeAll(async () => {
	databaseUrl = await startPostgres().catch(async (error) => {
		await removeContainer();
		throw error;
	});
}, 120_000);

afterAll(removeContainer);

describe("Platform PostgreSQL migration foundation", () => {
	it("accepts only the dedicated Platform database setting", () => {
		expect(
			platformDatabaseUrlFromEnvironment({
				PLATFORM_DATABASE_URL: databaseUrl,
			}),
		).toBe(databaseUrl);
		expect(() =>
			platformDatabaseUrlFromEnvironment({
				CONNECTION_DATABASE_URL: databaseUrl,
			}),
		).toThrow("PLATFORM_DATABASE_URL is required");
		expect(() =>
			platformDatabaseUrlFromEnvironment({
				PLATFORM_DATABASE_URL: "https://db",
			}),
		).toThrow("PLATFORM_DATABASE_URL must be a PostgreSQL URL");
	});

	it("applies, replays, and enforces the authored infrastructure schema", async () => {
		await builtStore.migratePlatformDatabase({ databaseUrl });
		const client = postgres(databaseUrl, { max: 1 });
		try {
			const serverVersion = await client`show server_version`;
			expect(String(serverVersion[0]?.server_version ?? "")).toMatch(/^16\./);

			const migrationHistory = await client`
					select id, hash, created_at
					from platform_migrations.history
					order by id
				`;
			expect(migrationHistory).toHaveLength(1);

			const migratedColumns = await client`
					select table_name, array_agg(column_name order by ordinal_position) as columns
					from information_schema.columns
					where table_schema = 'platform'
					group by table_name
					order by table_name
				`;
			const actualTables = Object.fromEntries(
				migratedColumns.map((row) => [row.table_name, row.columns]),
			);
			const authoredTables = Object.fromEntries(
				platformInfrastructureTables.map((table) => {
					const config = getTableConfig(table);
					return [config.name, config.columns.map((column) => column.name)];
				}),
			);
			expect(actualTables).toEqual(authoredTables);

			const authoredChecks = platformInfrastructureTables
				.flatMap((table) =>
					getTableConfig(table).checks.map((check) => check.name),
				)
				.toSorted();
			const migratedChecks = await client`
					select c.conname as constraint_name
					from pg_constraint c
					join pg_class t on t.oid = c.conrelid
					join pg_namespace n on n.oid = t.relnamespace
					where n.nspname = 'platform' and c.contype = 'c'
					order by c.conname
				`;
			expect(migratedChecks.map((row) => row.constraint_name)).toEqual(
				authoredChecks,
			);

			const authoredIndexes = platformInfrastructureTables
				.flatMap((table) =>
					getTableConfig(table).indexes.map((index) => index.config.name),
				)
				.toSorted();
			const migratedIndexes = await client`
					select indexname
					from pg_indexes
					where schemaname = 'platform' and indexname not like '%_pkey'
					order by indexname
				`;
			expect(migratedIndexes.map((row) => row.indexname)).toEqual(
				authoredIndexes,
			);

			const migratedEnumValues = await client`
					select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as values
					from pg_type t
					join pg_enum e on e.enumtypid = t.oid
					join pg_namespace n on n.oid = t.typnamespace
					where n.nspname = 'platform'
					group by t.typname
					order by t.typname
				`;
			expect(
				Object.fromEntries(
					migratedEnumValues.map((row) => [row.typname, row.values]),
				),
			).toEqual({
				audit_outcome: [...platformStatusValues.auditOutcome],
				idempotency_status: [...platformStatusValues.idempotencyStatus],
				outbox_status: [...platformStatusValues.outboxStatus],
			});

			const catalogBeforeReplay = await readPlatformCatalog(client);
			await builtStore.migratePlatformDatabase({ databaseUrl });
			const catalogAfterReplay = await readPlatformCatalog(client);
			expect(catalogAfterReplay).toEqual(catalogBeforeReplay);
			const replayedHistory = await client`
					select id, hash, created_at
					from platform_migrations.history
					order by id
				`;
			expect(replayedHistory).toEqual(migrationHistory);

			const connectionObjects = await client`
					select table_schema, table_name
					from information_schema.tables
					where table_schema like 'connection%'
				`;
			expect(connectionObjects).toEqual([]);

			const auditColumns = actualTables.audit_events as string[];
			expect(auditColumns).toEqual([
				"id",
				"trace_id",
				"actor_type",
				"actor_id",
				"action",
				"target_type",
				"target_id",
				"outcome",
				"occurred_at",
			]);

			await expectConstraintFailure(
				client`
						insert into platform.outbox_items
							(id, scope_type, scope_id, operation, payload, delivery_fence, trace_id)
						values
							('', 'agent', 'agent_01', 'reconcile', '{}', 0, 'trace_01')
					`,
				"outbox_id_non_empty",
			);
			await expectConstraintFailure(
				client`
						insert into platform.outbox_items
							(id, scope_type, scope_id, operation, payload, delivery_fence, trace_id)
						values
							('outbox_01', 'agent', 'agent_01', 'reconcile', '{}', -1, 'trace_01')
					`,
				"outbox_delivery_fence_non_negative",
			);
			await expectConstraintFailure(
				client`
						insert into platform.idempotency_records
							(id, scope_type, scope_id, actor_id, command_type, idempotency_key, request_digest)
						values
							('idem_01', 'agent', 'agent_01', 'user_01', 'create', 'invalid key', ${"a".repeat(64)})
					`,
				"idempotency_key_format",
			);

			await client`
					insert into platform.persisted_events
						(event_id, stream_id, sequence, stream_cursor, event_type, payload, trace_id)
					values
						('event_01', 'stream_01', 0, 0, 'started', '{}', 'trace_01')
				`;
			await expectConstraintFailure(
				client`
						insert into platform.persisted_events
							(event_id, stream_id, sequence, stream_cursor, event_type, payload, trace_id)
						values
							('event_02', 'stream_01', 1, 0, 'progress', '{}', 'trace_01')
					`,
				"persisted_event_stream_cursor_unique",
			);
		} finally {
			await client.end();
		}
	}, 120_000);
});
