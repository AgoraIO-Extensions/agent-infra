import { createFileAuthorityV1 } from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PostgresFileStoreV1 } from "./files.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

let db: PostgresTestDatabase;
beforeAll(async () => {
	db = await startPostgresTestDatabase("442-files");
	await migratePlatformDatabase(db);
}, 60000);
afterAll(async () => {
	await db?.stop();
});
it("retains the same immutable intent after the Store process is reopened", async () => {
	const scope = {
		actorId: "alice",
		agentId: "agent",
		conversationId: "conversation",
		channelId: "web",
	};
	const sql = postgres(db.databaseUrl);
	await sql`insert into platform.conversations (id, agent_id, actor_id, channel_id, status, session_generation, authorization_revision) values ('conversation','agent','alice','web','ready',1,'revision-1')`;
	await sql.end();
	const authorization = {
		authorize: async () => ({
			...scope,
			execution: null,
			limits: {
				revision: "limits-1",
				expiresAt: "2099-01-01T00:00:00Z",
				mediaTypes: ["text/plain"],
				maxBytes: 20,
			},
		}),
	};
	const request = {
		conversationId: "conversation",
		idempotencyKey: "upload-1",
		descriptor: {
			name: "hello.txt",
			mediaType: "text/plain",
			sizeBytes: 5,
			sha256:
				"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		},
	};
	const create = (store: PostgresFileStoreV1) =>
		createFileAuthorityV1({
			store,
			intentTtlMs: 60000,
			accessTtlMs: 10000,
			issuer: "platform",
			keyVersion: "key-1",
			storage: { inspect: async () => null },
		});
	let store = new PostgresFileStoreV1(db.databaseUrl);
	try {
		const first = await create(store).createUpload(request, authorization);
		await store.close();
		store = new PostgresFileStoreV1(db.databaseUrl);
		expect(await create(store).createUpload(request, authorization)).toEqual(
			first,
		);
		await expect(
			create(store).createUpload(
				{ ...request, descriptor: { ...request.descriptor, sizeBytes: 6 } },
				authorization,
			),
		).rejects.toMatchObject({ code: "conflict" });
	} finally {
		await store.close();
	}
});

it("persists cleanup checkpoints across reopen and rolls back a failed page", async () => {
	let store = new PostgresFileStoreV1(db.databaseUrl);
	try {
		expect(await store.checkpoint(async () => "page-1")).toBe(true);
		await store.close();
		store = new PostgresFileStoreV1(db.databaseUrl);
		await expect(
			store.checkpoint(async (cursor) => {
				expect(cursor).toBe("page-1");
				throw new Error("temporary cleanup failure");
			}),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(
			await store.checkpoint(async (cursor) => {
				expect(cursor).toBe("page-1");
				return null;
			}),
		).toBe(true);
	} finally {
		await store.close();
	}
});
