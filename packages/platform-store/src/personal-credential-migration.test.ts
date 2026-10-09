import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const migrationsFolder = resolve(
	import.meta.dirname,
	"../../../migrations/platform",
);
const legacyAuthority = await readFile(
	new URL("../test/fixtures/0026_ldap_identity_authority.sql", import.meta.url),
	"utf8",
);
const legacyHash =
	"714286ee36c08852ec532462e180ab83539af6b7619eed38c8f37e0d0ee665f7";
const legacyWhen = 1790724095107;
let database: PostgresTestDatabase;
let client: ReturnType<typeof postgres>;
let temporaryRoot: string;
let prefixFolder: string;
let prefixLength: number;
let appendedHistory: { hash: string; created_at: string }[];

interface SourceConstraint {
	columns?: string[];
	columnsFrom?: string[];
	columnsTo?: string[];
	tableTo?: string;
}
interface SourceSchemaDelta {
	columns: Record<string, { type: string; notNull: boolean }>;
	constraints: {
		compositePrimaryKeys: Record<string, SourceConstraint>;
		foreignKeys: Record<string, SourceConstraint>;
		uniqueConstraints: Record<string, SourceConstraint>;
		checkConstraints: Record<string, { value: string }>;
		indexes: Record<
			string,
			{
				isUnique: boolean;
				method: string;
				columns: { expression: string }[];
				where?: string;
			}
		>;
	};
}

async function checkpointSchema() {
	const columns =
		await client`select c.relname as table_name, a.attname as name,
		format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
		pg_get_expr(d.adbin, d.adrelid) as default_expression
		from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid=a.attrelid
		join pg_catalog.pg_namespace n on n.oid=c.relnamespace
		left join pg_catalog.pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
		where n.nspname='platform' and c.relkind='r' and a.attnum>0 and not a.attisdropped
		order by c.relname, a.attnum`;
	const constraints =
		await client`select c.relname as table_name, k.conname as name,
		k.contype as kind, k.convalidated as validated, pg_get_constraintdef(k.oid) as definition,
		array(select a.attname from unnest(k.conkey) with ordinality key(attnum, ord)
			join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attnum=key.attnum order by key.ord) as columns,
		f.relname as foreign_table,
		array(select a.attname from unnest(k.confkey) with ordinality key(attnum, ord)
			join pg_catalog.pg_attribute a on a.attrelid=f.oid and a.attnum=key.attnum order by key.ord) as foreign_columns
		from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid=k.conrelid
		join pg_catalog.pg_namespace n on n.oid=c.relnamespace
		left join pg_catalog.pg_class f on f.oid=k.confrelid
		where n.nspname='platform' order by c.relname, k.conname`;
	const indexes =
		await client`select c.relname as table_name, i.relname as name,
		ix.indisunique as is_unique, m.amname as method,
		array(select a.attname from unnest(ix.indkey) with ordinality key(attnum, ord)
			join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attnum=key.attnum order by key.ord) as columns,
		pg_get_expr(ix.indpred, ix.indrelid) as predicate, pg_get_indexdef(i.oid) as definition
		from pg_catalog.pg_index ix join pg_catalog.pg_class c on c.oid=ix.indrelid
		join pg_catalog.pg_namespace n on n.oid=c.relnamespace
		join pg_catalog.pg_class i on i.oid=ix.indexrelid
		join pg_catalog.pg_am m on m.oid=i.relam
		where n.nspname='platform' order by c.relname, i.relname`;
	const enums = await client`select t.typname as name,
		array_agg(e.enumlabel order by e.enumsortorder) as values
		from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid=t.typnamespace
		join pg_catalog.pg_enum e on e.enumtypid=t.oid
		where n.nspname='platform' group by t.typname order by t.typname`;
	return { columns, constraints, indexes, enums };
}

async function history() {
	return client`select id, hash, created_at::text as created_at
		from platform_migrations.history order by id`;
}

beforeAll(async () => {
	expect(createHash("sha256").update(legacyAuthority).digest("hex")).toBe(
		legacyHash,
	);
	temporaryRoot = await mkdtemp(
		resolve(tmpdir(), "agent-infra-personal-upgrade-"),
	);
	prefixFolder = resolve(temporaryRoot, "platform");
	await cp(migrationsFolder, prefixFolder, { recursive: true });
	const journal = JSON.parse(
		await readFile(resolve(prefixFolder, "meta/_journal.json"), "utf8"),
	) as { entries: { idx: number; tag: string; when: number }[] };
	const appendEntries = journal.entries.filter((entry) => entry.idx >= 29);
	expect(appendEntries.map(({ idx, tag }) => ({ idx, tag }))).toEqual([
		{ idx: 29, tag: "0029_platform_user_disables" },
		{ idx: 30, tag: "0030_relay_key_authority_compatibility" },
		{ idx: 31, tag: "0031_accepted_execution_key" },
		{ idx: 32, tag: "0032_typed_task_principal" },
		{ idx: 33, tag: "0033_typed_generation_principal" },
		{ idx: 34, tag: "0034_task_status_event_source" },
		{ idx: 35, tag: "0035_session_sandbox_allocations" },
		{ idx: 36, tag: "0036_ldap_identity_ids" },
		{ idx: 37, tag: "0037_browser_session_principal" },
		{ idx: 38, tag: "0038_browser_session_absolute_expiry" },
		{ idx: 39, tag: "0039_skill_hub" },
		{ idx: 40, tag: "0040_agent_configuration_v3" },
		{ idx: 41, tag: "0041_skill_version_integrity" },
		{ idx: 42, tag: "0042_agent_api_creation" },
		{ idx: 43, tag: "0043_platform_cancellation_event" },
		{ idx: 44, tag: "0044_platform_cancellation_status_required" },
		{ idx: 45, tag: "0045_skill_hub_organization_scope" },
		{ idx: 46, tag: "0046_commit_wakeups" },
		{ idx: 47, tag: "0047_skill_agent_binding_revision" },
		{ idx: 48, tag: "0048_skill_agent_binding_history" },
	]);
	appendedHistory = await Promise.all(
		appendEntries.map(async (entry) => ({
			hash: createHash("sha256")
				.update(
					await readFile(resolve(migrationsFolder, `${entry.tag}.sql`), "utf8"),
				)
				.digest("hex"),
			created_at: String(entry.when),
		})),
	);
	journal.entries = journal.entries.filter(
		(entry: { idx: number }) => entry.idx <= 24,
	);
	prefixLength = journal.entries.length;
	expect(prefixLength).toBe(25);
	await writeFile(
		resolve(prefixFolder, "meta/_journal.json"),
		JSON.stringify(journal),
	);
	database = await startPostgresTestDatabase("personal-credential-upgrade");
	client = postgres(database.databaseUrl, { max: 1 });
});

beforeEach(async () => {
	// This database belongs to this test, never to the retained acceptance service.
	await client`drop schema if exists platform cascade`;
	await client`drop schema if exists platform_migrations cascade`;
	await migrate(drizzle(client), {
		migrationsFolder: prefixFolder,
		migrationsSchema: "platform_migrations",
		migrationsTable: "history",
	});
});

afterAll(async () => {
	await client?.end();
	await database?.stop();
	if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

describe("personal credential disable authority append", () => {
	it("appends current disable migration to a reconstructed Task28 checkpoint and preserves data on repeat", async () => {
		const checkpoint = JSON.parse(
			await readFile(
				new URL(
					"../test/fixtures/task28-source-checkpoint.json",
					import.meta.url,
				),
				"utf8",
			),
		) as {
			classification: string;
			sourceRevision: string;
			sourceSnapshotSHA256: string;
			postStateSQLSHA256: string;
			expectedHistory: {
				idx: number;
				tag: string;
				when: number;
				sha256: string;
			}[];
			expectedSchemaDelta: Record<string, SourceSchemaDelta>;
			executionStatusEnum: string[];
			seedRowCounts: Record<string, number>;
			seedReferenceIdentities: Record<string, Record<string, string>>;
			newMigration: { tag: string; when: number; sqlSHA256: string };
		};
		expect(checkpoint.classification).toContain("synthetic");
		const postStateSQL = await readFile(
			new URL("../test/fixtures/task28-post-state.sql", import.meta.url),
			"utf8",
		);
		expect(createHash("sha256").update(postStateSQL).digest("hex")).toBe(
			checkpoint.postStateSQLSHA256,
		);
		const prefixHistory = await history();
		expect(
			prefixHistory.map((row) => ({
				hash: row.hash,
				created_at: row.created_at,
			})),
		).toEqual(
			checkpoint.expectedHistory
				.slice(0, 25)
				.map((row) => ({ hash: row.sha256, created_at: String(row.when) })),
		);
		// Static final-state DDL and synthetic rows only. Each statement commits so
		// PostgreSQL's newly added enum value is usable by subsequent seed INSERTs.
		for (const statement of postStateSQL.split("--> statement-breakpoint")) {
			await client.unsafe(statement);
		}
		const schema = await checkpointSchema();
		for (const [qualifiedTable, delta] of Object.entries(
			checkpoint.expectedSchemaDelta,
		)) {
			const table = qualifiedTable.replace("platform.", "");
			for (const [name, column] of Object.entries(delta.columns)) {
				const actual = schema.columns.find(
					(row) => row.table_name === table && row.name === name,
				);
				expect(actual, `${table}.${name}`).toBeDefined();
				expect(actual?.type.replace("character varying", "varchar")).toBe(
					column.type,
				);
				expect(actual?.not_null).toBe(column.notNull);
			}
			for (const [category, kind] of [
				["compositePrimaryKeys", "p"],
				["foreignKeys", "f"],
				["uniqueConstraints", "u"],
			] as const) {
				for (const [name, expected] of Object.entries(
					delta.constraints[category],
				)) {
					const actual = schema.constraints.find(
						(row) => row.table_name === table && row.name === name,
					);
					expect(actual).toMatchObject({
						kind,
						validated: true,
						columns: expected.columns ?? expected.columnsFrom,
					});
					if (kind === "f")
						expect(actual).toMatchObject({
							foreign_table: expected.tableTo,
							foreign_columns: expected.columnsTo,
						});
				}
			}
			for (const [name, expected] of Object.entries(
				delta.constraints.checkConstraints,
			)) {
				const actual = schema.constraints.find(
					(row) => row.table_name === table && row.name === name,
				);
				expect(actual).toMatchObject({ kind: "c", validated: true });
				// Catalog deparsing changes BETWEEN/IN syntax. Keep actual definitions
				// in evidence and verify every source literal and bound column survives.
				for (const literal of expected.value.matchAll(/'([^']*)'/g))
					expect(actual?.definition).toContain(literal[1]);
				for (const column of schema.columns.filter(
					(row) => row.table_name === table,
				)) {
					if (expected.value.includes(`"${column.name}"`))
						expect(actual?.definition).toContain(column.name);
				}
			}
			for (const [name, expected] of Object.entries(
				delta.constraints.indexes,
			)) {
				const actual = schema.indexes.find(
					(row) => row.table_name === table && row.name === name,
				);
				expect(actual).toMatchObject({
					is_unique: expected.isUnique,
					method: expected.method,
					columns: expected.columns.map((column) => column.expression),
				});
				if (expected.where)
					expect(actual?.predicate).toBe("(task_wait_order IS NOT NULL)");
			}
		}
		expect(
			schema.enums.find((row) => row.name === "conversation_execution_status")
				?.values,
		).toEqual(checkpoint.executionStatusEnum);
		expect(
			schema.constraints.find(
				(row) =>
					row.table_name === "platform_user_disables" && row.kind === "p",
			)?.columns,
		).toEqual(["user_id"]);
		// These four history rows describe a synthetic checkpoint. They do not
		// claim this test executed the frozen chain or exported the original DB.
		for (const row of checkpoint.expectedHistory.slice(25)) {
			await client`insert into platform_migrations.history (hash, created_at) values (${row.sha256}, ${row.when})`;
		}
		const snapshot = async () => {
			const data: Record<string, unknown[]> = {};
			for (const table of Object.keys(checkpoint.seedRowCounts)) {
				expect(table).toMatch(/^[a-z_]+$/);
				data[table] = (
					await client.unsafe(
						`select to_jsonb(t) as row from platform.${table} t order by to_jsonb(t)::text`,
					)
				).map((row) => row.row);
			}
			return {
				history: await history(),
				schema: await checkpointSchema(),
				data,
			};
		};
		const before = await snapshot();
		expect(before.history).toHaveLength(29);
		expect(before.history.slice(0, 25)).toEqual(prefixHistory);
		expect(
			before.history.map((row) => ({
				hash: row.hash,
				created_at: row.created_at,
			})),
		).toEqual(
			checkpoint.expectedHistory.map((row) => ({
				hash: row.sha256,
				created_at: String(row.when),
			})),
		);
		for (const [table, count] of Object.entries(checkpoint.seedRowCounts)) {
			expect(before.data[table]).toHaveLength(count);
			expect(before.data[table]).toEqual(
				expect.arrayContaining([
					expect.objectContaining(checkpoint.seedReferenceIdentities[table]),
				]),
			);
		}
		const currentSQL = await readFile(
			resolve(migrationsFolder, `${checkpoint.newMigration.tag}.sql`),
			"utf8",
		);
		expect(createHash("sha256").update(currentSQL).digest("hex")).toBe(
			checkpoint.newMigration.sqlSHA256,
		);
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		const after = await snapshot();
		expect(after.history).toHaveLength(29 + appendedHistory.length);
		expect(after.history.slice(0, 29)).toEqual(before.history);
		expect(after.history[29]).toMatchObject({
			hash: checkpoint.newMigration.sqlSHA256,
			created_at: String(checkpoint.newMigration.when),
		});
		expect(
			after.history
				.slice(29)
				.map(({ hash, created_at }) => ({ hash, created_at })),
		).toEqual(appendedHistory);
		const withoutTypedPrincipal = (data: typeof before.data) =>
			Object.fromEntries(
				Object.entries(data).map(([table, rows]) => [
					table,
					rows.map((row) => {
						if (!row || typeof row !== "object") return row;
						const copy = { ...(row as Record<string, unknown>) };
						if (table === "agent_applications") {
							delete copy.creation_channel;
							delete copy.creator_principal_type;
							delete copy.creator_principal_id;
						}
						delete copy.principal_type;
						if (table === "conversation_executions") {
							if ("sandbox_id" in copy) expect(copy.sandbox_id).toBeNull();
							delete copy.sandbox_id;
						}
						return copy;
					}),
				]),
			);
		expect(withoutTypedPrincipal(after.data)).toEqual(
			withoutTypedPrincipal(before.data),
		);
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		const repeated = await snapshot();
		expect(repeated).toEqual(after);
		const evidencePath = process.env.PERSONAL_CREDENTIAL_UPGRADE_EVIDENCE;
		if (evidencePath) {
			await writeFile(
				evidencePath,
				JSON.stringify(
					{
						classification: checkpoint.classification,
						sourceRevision: checkpoint.sourceRevision,
						sourceSnapshotSHA256: checkpoint.sourceSnapshotSHA256,
						postStateSQLSHA256: checkpoint.postStateSQLSHA256,
						sourceDerivedHistoryExpectation: checkpoint.expectedHistory,
						actualNewPostgres: { before, after, repeated },
						fingerprints: [before, after, repeated].map((state) => ({
							schemaSHA256: createHash("sha256")
								.update(JSON.stringify(state.schema))
								.digest("hex"),
							dataSHA256: createHash("sha256")
								.update(JSON.stringify(state.data))
								.digest("hex"),
						})),
					},
					null,
					2,
				),
			);
		}
	});

	it("upgrades fresh main without rewriting its history and remains repeatable", async () => {
		const originalHistory = await history();
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		const upgradedHistory = await history();
		expect(upgradedHistory).toHaveLength(prefixLength + appendedHistory.length);
		expect(upgradedHistory.slice(0, prefixLength)).toEqual(originalHistory);
		expect(
			upgradedHistory
				.slice(prefixLength)
				.map(({ hash, created_at }) => ({ hash, created_at })),
		).toEqual(appendedHistory);
		await client`insert into platform.platform_user_disables (user_id) values ('user_alice')`;
		const disabled =
			await client`select * from platform.platform_user_disables`;
		expect(disabled).toHaveLength(1);
		expect(disabled[0]?.disabled_at).toBeTruthy();
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		expect(await history()).toEqual(upgradedHistory);
		expect(await client`select * from platform.platform_user_disables`).toEqual(
			disabled,
		);
	});

	it("preserves the exact historical LDAP disable authority, actor, data and executed history", async () => {
		// This portable case executes old26 itself. It does not claim the entire
		// historical 0-27 -> Task28 upgrade or replace that owner's runtime evidence.
		await client.begin(async (transaction) => {
			for (const statement of legacyAuthority.split(
				"--> statement-breakpoint",
			)) {
				await transaction.unsafe(statement);
			}
			await transaction`insert into platform_migrations.history (hash, created_at)
				values (${legacyHash}, ${legacyWhen})`;
		});
		await client`insert into platform.ldap_identity_ids (issuer, uid, user_id)
			values ('ldap://identity.test', 'alice', '11111111-1111-4111-8111-111111111111')`;
		await client`insert into platform.platform_user_disables (user_id, disabled_by, disabled_at)
			values ('user_alice', 'admin_original', '2026-09-01T12:34:56Z')`;
		const originalHistory = await history();
		const originalDisables =
			await client`select * from platform.platform_user_disables`;
		const originalIdentities =
			await client`select * from platform.ldap_identity_ids`;
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		const upgradedHistory = await history();
		expect(upgradedHistory).toHaveLength(
			originalHistory.length + appendedHistory.length,
		);
		expect(upgradedHistory.slice(0, originalHistory.length)).toEqual(
			originalHistory,
		);
		expect(
			upgradedHistory
				.slice(originalHistory.length)
				.map(({ hash, created_at }) => ({ hash, created_at })),
		).toEqual(appendedHistory);
		expect(await client`select * from platform.platform_user_disables`).toEqual(
			originalDisables,
		);
		expect(await client`select * from platform.ldap_identity_ids`).toEqual(
			originalIdentities,
		);
		await expect(
			client`insert into platform.platform_user_disables (user_id) values ('user_bob')`,
		).rejects.toThrow();
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		expect(await history()).toEqual(upgradedHistory);
		expect(await client`select * from platform.platform_user_disables`).toEqual(
			originalDisables,
		);
	});

	it.each([
		{
			name: "incorrect user ID type",
			columns:
				"user_id varchar(256) primary key, disabled_at timestamptz not null",
			userId: "user_alice",
		},
		{
			name: "missing primary key",
			columns: "user_id text not null, disabled_at timestamptz not null",
			userId: "user_alice",
		},
		{
			name: "incorrect disable time type",
			columns: "user_id text primary key, disabled_at timestamp not null",
			userId: "user_alice",
		},
		{
			name: "nullable disable time",
			columns: "user_id text primary key, disabled_at timestamptz",
			userId: "user_alice",
		},
		{
			name: "empty principal data",
			columns: "user_id text primary key, disabled_at timestamptz not null",
			userId: "",
		},
	])(
		"rejects $name without changing history or existing authority data",
		async ({ columns, userId }) => {
			await client.unsafe(
				`create table platform.platform_user_disables (${columns})`,
			);
			await client`insert into platform.platform_user_disables (user_id, disabled_at)
			values (${userId}, '2026-09-01T12:34:56Z')`;
			const originalHistory = await history();
			const originalDisables =
				await client`select * from platform.platform_user_disables`;
			await expect(
				migratePlatformDatabase({ databaseUrl: database.databaseUrl }),
			).rejects.toThrow();
			expect(await history()).toEqual(originalHistory);
			expect(
				await client`select * from platform.platform_user_disables`,
			).toEqual(originalDisables);
		},
	);
});
