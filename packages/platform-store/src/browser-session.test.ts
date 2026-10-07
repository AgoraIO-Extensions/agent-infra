import { resolve } from "node:path";

import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresLdapSessionStoreV1 } from "./browser-session.js";
import { migratePlatformDatabase } from "./migrate.js";
import { startPostgresTestDatabase } from "./postgres-test.js";

let database: Awaited<ReturnType<typeof startPostgresTestDatabase>>;
const migrations = readMigrationFiles({
	migrationsFolder: resolve(
		import.meta.dirname,
		"../../../migrations/platform",
	),
});

beforeAll(async () => {
	database = await startPostgresTestDatabase("browser-session");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
});

afterAll(async () => {
	await database?.stop();
});

describe("PostgreSQL browser sessions", () => {
	it("shares a session across API instances and revokes it for the stable UID", async () => {
		const first = new PostgresLdapSessionStoreV1(database.databaseUrl);
		const second = new PostgresLdapSessionStoreV1(database.databaseUrl);
		const digest = "a".repeat(64);
		const expiresAt = Date.UTC(2030, 0, 1);
		const absoluteExpiresAt = Date.UTC(2030, 0, 2);
		try {
			await first.create(digest, "stable-uid-a", expiresAt, absoluteExpiresAt);
			expect(await second.find(digest, expiresAt - 1)).toEqual({
				uid: "stable-uid-a",
				expiresAt,
				absoluteExpiresAt,
			});
			await second.revokeUid("stable-uid-a");
			expect(await first.find(digest, expiresAt - 1)).toBeNull();
		} finally {
			await Promise.all([first.close(), second.close()]);
		}
	});

	it("rejects a non-digest cookie value at the Store boundary", async () => {
		const store = new PostgresLdapSessionStoreV1(database.databaseUrl);
		try {
			await expect(
				store.create(
					"synthetic-raw-cookie",
					"stable-uid-b",
					Date.UTC(2030, 0, 1),
					Date.UTC(2030, 0, 2),
				),
			).rejects.toThrow("SESSION_INPUT_INVALID");
			await expect(store.find("synthetic-raw-cookie", 0)).rejects.toThrow(
				"SESSION_INPUT_INVALID",
			);
			await expect(store.revoke("synthetic-raw-cookie")).rejects.toThrow(
				"SESSION_INPUT_INVALID",
			);
		} finally {
			await store.close();
		}
	});

	it("expires at the stored deadline and revokes a single session", async () => {
		const store = new PostgresLdapSessionStoreV1(database.databaseUrl);
		const digest = "b".repeat(64);
		const expiresAt = Date.UTC(2030, 0, 2);
		const absoluteExpiresAt = Date.UTC(2030, 0, 3);
		try {
			await store.create(digest, "stable-uid-c", expiresAt, absoluteExpiresAt);
			expect(await store.find(digest, expiresAt)).toBeNull();
			expect(await store.find(digest, expiresAt - 1)).toEqual({
				uid: "stable-uid-c",
				expiresAt,
				absoluteExpiresAt,
			});
			await store.revoke(digest);
			expect(await store.find(digest, expiresAt - 1)).toBeNull();
		} finally {
			await store.close();
		}
	});

	it("deletes expired rows on a subsequent login without removing active sessions", async () => {
		const store = new PostgresLdapSessionStoreV1(database.databaseUrl);
		const sql = postgres(database.databaseUrl);
		const expired = "c".repeat(64);
		const active = "d".repeat(64);
		try {
			await store.create(
				expired,
				"stable-uid-expired",
				Date.now() - 60_000,
				Date.now() + 60_000,
			);
			await store.create(
				active,
				"stable-uid-active",
				Date.now() + 60_000,
				Date.now() + 120_000,
			);
			const rows = await sql`
				select token_digest from platform.browser_sessions
				where token_digest in (${expired}, ${active})
			`;
			expect(rows.map((row) => String(row.token_digest).trim())).toEqual([
				active,
			]);
			expect(await store.find(active, Date.now())).toEqual({
				uid: "stable-uid-active",
				expiresAt: expect.any(Number),
				absoluteExpiresAt: expect.any(Number),
			});
		} finally {
			await Promise.all([store.close(), sql.end()]);
		}
	});

	it("renews idle expiry without crossing the absolute deadline", async () => {
		const store = new PostgresLdapSessionStoreV1(database.databaseUrl);
		const digest = "e".repeat(64);
		const now = Date.UTC(2030, 0, 1);
		const absoluteExpiresAt = now + 1_000;
		try {
			await store.create(digest, "stable-uid-e", now + 100, absoluteExpiresAt);
			expect(await store.renew(digest, now + 50, now + 5_000)).toBe(true);
			expect(await store.find(digest, now + 999)).toMatchObject({
				uid: "stable-uid-e",
				expiresAt: absoluteExpiresAt,
				absoluteExpiresAt,
			});
			expect(await store.find(digest, absoluteExpiresAt)).toBeNull();
		} finally {
			await store.close();
		}
	});

	it("backfills legacy absolute expiry without extending the session", async () => {
		const legacyDatabase = await startPostgresTestDatabase(
			"browser-session-legacy",
		);
		const sql = postgres(legacyDatabase.databaseUrl);
		const expiresAt = Date.UTC(2030, 0, 1);
		const digest = "f".repeat(64);
		try {
			await sql`create schema platform_migrations`;
			await sql`create table platform_migrations.history
				(id serial primary key, hash text not null, created_at bigint)`;
			for (const migration of migrations.slice(0, -1)) {
				for (const statement of migration.sql) await sql.unsafe(statement);
				await sql`
					insert into platform_migrations.history (hash, created_at)
					values (${migration.hash}, ${migration.folderMillis})
				`;
			}
			await sql`
				insert into platform.browser_sessions (token_digest, uid, expires_at, principal)
				values (${digest}, 'stable-uid-f', ${new Date(expiresAt)}, null)
			`;

			await migratePlatformDatabase({
				databaseUrl: legacyDatabase.databaseUrl,
			});
			const [row] = await sql`
				select expires_at, absolute_expires_at
				from platform.browser_sessions
				where token_digest = ${digest}
			`;
			if (!row) throw new Error("Expected migrated browser session");
			expect(new Date(row.expires_at).getTime()).toBe(expiresAt);
			expect(new Date(row.absolute_expires_at).getTime()).toBe(expiresAt);

			const legacyWriteExpiresAt = Date.UTC(2030, 0, 2);
			const legacyWriteDigest = "g".repeat(64);
			await sql`
				insert into platform.browser_sessions (token_digest, uid, expires_at, principal)
				values (
					${legacyWriteDigest},
					'stable-uid-g',
					${new Date(legacyWriteExpiresAt)},
					null
				)
			`;
			const [legacyWriteRow] = await sql`
				select expires_at, absolute_expires_at
				from platform.browser_sessions
				where token_digest = ${legacyWriteDigest}
			`;
			if (!legacyWriteRow)
				throw new Error("Expected legacy browser session insert");
			expect(new Date(legacyWriteRow.absolute_expires_at).getTime()).toBe(
				legacyWriteExpiresAt,
			);
		} finally {
			await sql.end();
			await legacyDatabase.stop();
		}
	}, 120_000);
});
