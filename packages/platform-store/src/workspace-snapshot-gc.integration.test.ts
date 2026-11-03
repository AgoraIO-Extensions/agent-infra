import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";
import { PostgresWorkspaceSnapshotUploadStoreV1 } from "./workspace-snapshot-upload-store.js";
import { PostgresWorkspaceSnapshotStoreV1 } from "./workspace-snapshots.js";

let database: PostgresTestDatabase;
let store: PostgresWorkspaceSnapshotStoreV1;
let uploads: PostgresWorkspaceSnapshotUploadStoreV1;
let db: ReturnType<typeof postgres>;
beforeAll(async () => {
	const url = process.env.WORKSPACE_SNAPSHOT_TEST_DATABASE_URL;
	if (url) {
		const parsed = new URL(url);
		if (
			parsed.hostname !== "127.0.0.1" ||
			!/^\/snapshot_test_[a-z0-9_]+$/.test(parsed.pathname)
		)
			throw new Error("Expected isolated snapshot test database");
		database = {
			databaseUrl: url,
			containerName: "local-snapshot-test",
			stop: async () => {},
		};
	} else database = await startPostgresTestDatabase("snapshot-gc-3873");
	await migratePlatformDatabase(database);
	store = new PostgresWorkspaceSnapshotStoreV1(database.databaseUrl);
	uploads = new PostgresWorkspaceSnapshotUploadStoreV1(database.databaseUrl);
	db = postgres(database.databaseUrl);
}, 120000);
afterAll(async () => {
	await store?.close();
	await uploads?.close();
	await db?.end();
	await database?.stop();
});
const now = new Date("2026-11-03T00:00:00Z");
function snapshot() {
	return {
		snapshotId: randomUUID(),
		ownerType: "user" as const,
		ownerId: randomUUID(),
		digest: `sha256:${"a".repeat(64)}`,
		sizeBytes: 16,
		unpackedSizeBytes: 16,
		fileCount: 1,
		mediaType: "application/x-tar+gzip" as const,
		source: { kind: "direct-upload" },
		objectRef: randomUUID(),
		objectVersion: randomUUID(),
		status: "ready" as const,
		createdAt: "2026-10-01T00:00:00Z",
		bindings: [],
	};
}
it("protects a fresh reference before object I/O and does not count a skipped delete", async () => {
	const old = snapshot();
	await store.create(old);
	await store.create({
		...old,
		snapshotId: randomUUID(),
		createdAt: now.toISOString(),
	});
	const deleteObjectVersion = vi.fn(async () => {});
	const result = await store.collectExpired({
		now,
		retentionMs: 86400000,
		deleter: { deleteObjectVersion },
	});
	expect(deleteObjectVersion).not.toHaveBeenCalled();
	expect(result.deleted).toBe(0);
});
it("retries failed deletes, converges old duplicates, and fences both publication paths", async () => {
	const a = snapshot();
	const b = { ...a, snapshotId: randomUUID() };
	await store.create(a);
	await store.create(b);
	const failing = vi.fn(async () => {
		throw new Error("synthetic storage failure");
	});
	await store.collectExpired({
		now,
		retentionMs: 86400000,
		deleter: { deleteObjectVersion: failing },
	});
	const rows =
		await db`select status from platform.workspace_snapshots where id in (${a.snapshotId},${b.snapshotId})`;
	expect(rows.map((r) => r.status)).toEqual(["deleting", "deleting"]);
	const deleteObjectVersion = vi.fn(async () => {});
	await store.collectExpired({
		now,
		retentionMs: 86400000,
		deleter: { deleteObjectVersion },
	});
	const completed =
		await db`select status from platform.workspace_snapshots where id in (${a.snapshotId},${b.snapshotId})`;
	expect(completed.map((r) => r.status)).toEqual(["deleted", "deleted"]);
	expect(deleteObjectVersion).toHaveBeenCalledWith({
		objectRef: a.objectRef,
		objectVersion: a.objectVersion,
	});
	await expect(
		store.create({ ...a, snapshotId: randomUUID() }),
	).rejects.toMatchObject({ code: "conflict" });
	await expect(
		uploads.create(
			{ ...a, snapshotId: randomUUID() },
			{ kind: "user", id: a.ownerId, scopes: ["agent:create"] },
			randomUUID(),
			"b".repeat(64),
		),
	).rejects.toMatchObject({ code: "conflict" });
});

it("holds the publication lock during object deletion", async () => {
	const a = snapshot();
	await store.create(a);
	let publication: Promise<unknown> | undefined;
	let sawWaitingPublisher = false;
	await store.collectExpired({
		now,
		retentionMs: 86400000,
		deleter: {
			deleteObjectVersion: async ({ objectRef }) => {
				if (objectRef !== a.objectRef) return;
				publication = store.create({ ...a, snapshotId: randomUUID() }).then(
					() => "published",
					(error: unknown) => error,
				);
				// Observe PostgreSQL's lock wait rather than assuming a sleep proves serialization.
				for (let attempt = 0; attempt < 100; attempt++) {
					const [state] =
						await db`select count(*)::int as waiting from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event='advisory'`;
					if (state?.waiting > 0) {
						sawWaitingPublisher = true;
						break;
					}
				}
				expect(sawWaitingPublisher).toBe(true);
			},
		},
	});
	expect(publication).toBeDefined();
	expect(await publication).toMatchObject({ code: "conflict" });
});

it("reports retained bytes and eligible GC delay instead of masking unknown as zero", async () => {
	const before = await store.readGcMetrics({ now, retentionMs: 86400000 });
	const a = snapshot();
	await store.create(a);
	const after = await store.readGcMetrics({ now, retentionMs: 86400000 });
	expect(after.storedBytes).toBe(before.storedBytes + a.sizeBytes);
	expect(after.oldestEligibleDelayMs).toBeGreaterThanOrEqual(
		now.getTime() - Date.parse(a.createdAt) - 86400000,
	);
	await expect(
		store.readGcMetrics({ now: new Date("invalid"), retentionMs: 86400000 }),
	).rejects.toMatchObject({ code: "invalid_input" });
});

it("counts bound bytes without including them in GC delay and excludes deleted bytes", async () => {
	const before = await store.readGcMetrics({ now, retentionMs: 86400000 });
	const bound = { ...snapshot(), createdAt: "2000-01-01T00:00:00Z" };
	await store.create(bound);
	const agent = randomUUID();
	await db`insert into platform.agents (id) values (${agent})`;
	await db`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,created_at,runtime_revision) values (${agent},1,'synthetic',now(),1)`;
	await db`insert into platform.workspace_snapshot_bindings (snapshot_id,agent_id,configuration_revision,name,digest,size_bytes) values (${bound.snapshotId},${agent},1,'repo',${bound.digest},${bound.sizeBytes})`;
	const after = await store.readGcMetrics({ now, retentionMs: 86400000 });
	expect(after.storedBytes).toBe(before.storedBytes + bound.sizeBytes);
	expect(after.oldestEligibleDelayMs).toBe(before.oldestEligibleDelayMs);
	const deleted = { ...snapshot(), status: "deleted" as const };
	await store.create(deleted);
	expect(await store.readGcMetrics({ now, retentionMs: 86400000 })).toEqual(
		after,
	);
});
