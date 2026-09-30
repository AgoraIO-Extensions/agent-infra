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
	);
	expect(journal.entries.at(-1)).toMatchObject({
		idx: 29,
		tag: "0029_platform_user_disables",
	});
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
	it("upgrades fresh main without rewriting its history and remains repeatable", async () => {
		const originalHistory = await history();
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		const upgradedHistory = await history();
		expect(upgradedHistory).toHaveLength(prefixLength + 1);
		expect(upgradedHistory.slice(0, prefixLength)).toEqual(originalHistory);
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
		expect(upgradedHistory).toHaveLength(originalHistory.length + 1);
		expect(upgradedHistory.slice(0, originalHistory.length)).toEqual(
			originalHistory,
		);
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
