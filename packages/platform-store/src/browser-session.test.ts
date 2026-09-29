import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresLdapSessionStoreV1 } from "./browser-session.js";
import { migratePlatformDatabase } from "./migrate.js";
import { startPostgresTestDatabase } from "./postgres-test.js";

let database: Awaited<ReturnType<typeof startPostgresTestDatabase>>;

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
		try {
			await first.create(digest, "stable-uid-a", expiresAt);
			expect(await second.find(digest, expiresAt - 1)).toEqual({
				uid: "stable-uid-a",
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
		try {
			await store.create(digest, "stable-uid-c", expiresAt);
			expect(await store.find(digest, expiresAt)).toBeNull();
			expect(await store.find(digest, expiresAt - 1)).toEqual({
				uid: "stable-uid-c",
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
			await store.create(expired, "stable-uid-expired", Date.now() - 60_000);
			await store.create(active, "stable-uid-active", Date.now() + 60_000);
			const rows = await sql`
				select token_digest from platform.browser_sessions
				where token_digest in (${expired}, ${active})
			`;
			expect(rows.map((row) => String(row.token_digest).trim())).toEqual([
				active,
			]);
			expect(await store.find(active, Date.now())).toEqual({
				uid: "stable-uid-active",
			});
		} finally {
			await Promise.all([store.close(), sql.end()]);
		}
	});
});
