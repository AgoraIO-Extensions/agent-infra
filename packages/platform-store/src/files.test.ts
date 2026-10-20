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

it("reads the persisted delivery fence and task authorization facts", async () => {
	const sql = postgres(db.databaseUrl);
	const boundary = {
		schemaVersion: 1,
		principal: { kind: "user", id: "alice" },
		agentId: "agent",
		channelId: "web",
		identityRevision: "auth",
		agentAuthorizationRevision: "auth",
		accessSources: [{ kind: "user", userId: "alice" }],
	};
	try {
		await sql`insert into platform.conversations (id, agent_id, actor_id, channel_id, status, session_generation, authorization_revision) values ('conversation-auth','agent','alice','web','active',1,'auth')`;
		await sql`insert into platform.conversation_executions (execution_id, conversation_id, agent_id, actor_id, channel_id, turn_id, status, session_generation, delivery_fence, authorization_revision, created_at, updated_at) values ('execution-auth','conversation-auth','agent','alice','web','turn-auth','processing',1,3,'auth',now(),now())`;
		await sql`insert into platform.task_authorization_records (id, execution_id, boundary) values ('authorization-auth','execution-auth',${sql.json(boundary)})`;
		const store = new PostgresFileStoreV1(db.databaseUrl);
		try {
			const execution = await store.transaction("conversation-auth", (tx) =>
				tx.getExecution("execution-auth"),
			);
			expect(execution).toMatchObject({
				deliveryFence: 3,
				authorizationRevision: "auth",
				status: "processing",
				stopPending: false,
			});
			expect(
				await store.transaction("conversation-auth", (tx) =>
					tx.getTaskAuthorization("authorization-auth", "execution-auth"),
				),
			).toEqual({
				id: "authorization-auth",
				executionId: "execution-auth",
				revoked: false,
				boundary,
			});
			expect(
				await store.transaction("conversation-auth", (tx) =>
					tx.getTaskAuthorization("authorization-auth", "other-execution"),
				),
			).toBeNull();
		} finally {
			await store.close();
		}
	} finally {
		await sql.end();
	}
});
