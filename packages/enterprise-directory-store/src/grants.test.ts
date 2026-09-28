import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSnapshot } from "@agent-infra/enterprise-directory";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { expect, it } from "vitest";
import { startPostgresTestDatabase } from "../../platform-store/src/postgres-test.js";
import {
	createPostgresDirectoryStore,
	migrateDirectoryStore,
} from "./index.js";

const migrationsFolder = resolve(
	import.meta.dirname,
	"../../../migrations/enterprise-directory",
);

it("preserves legacy rows and fences slow scans across runtime instances", async () => {
	const database = await startPostgresTestDatabase("directory-grants");
	const legacyMigrations = await mkdtemp(
		join(tmpdir(), "directory-migrations-"),
	);
	const administrator = postgres(database.databaseUrl, { max: 1 });
	const runtimeRole = "directory_runtime";
	const runtimePassword = "directory-test-password";
	const runtimeUrl = new URL(database.databaseUrl);
	runtimeUrl.username = runtimeRole;
	runtimeUrl.password = runtimePassword;
	const runtime = postgres(runtimeUrl.toString(), { max: 1 });
	const store = createPostgresDirectoryStore(runtimeUrl.toString());
	const otherStore = createPostgresDirectoryStore(runtimeUrl.toString());
	try {
		await administrator`CREATE ROLE ${administrator(runtimeRole)} LOGIN PASSWORD 'directory-test-password'`;
		await mkdir(join(legacyMigrations, "meta"));
		await copyFile(
			join(migrationsFolder, "0000_snapshot.sql"),
			join(legacyMigrations, "0000_snapshot.sql"),
		);
		const journal = JSON.parse(
			await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"),
		);
		await writeFile(
			join(legacyMigrations, "meta/_journal.json"),
			JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }),
		);
		await migrate(drizzle(administrator), {
			migrationsFolder: legacyMigrations,
			migrationsSchema: "enterprise_directory_migrations",
			migrationsTable: "history",
		});
		const now = Date.UTC(2026, 8, 28);
		const departments = [{ id: 1, name: "Company", parentId: 0 }];
		const members = [
			{
				userId: "wecom-a",
				email: "a@example.test",
				active: true,
				departmentIds: [1],
			},
		];
		const legacy = createSnapshot({
			rootDepartmentId: 1,
			startedAt: now,
			completedAt: now,
			departments,
			members,
		});
		await administrator`
			INSERT INTO enterprise_directory.snapshots
				(revision, fetched_at, valid_until, contents)
			VALUES (
				${legacy.revision}, ${new Date(legacy.fetchedAt).toISOString()}::timestamptz,
				${new Date(legacy.validUntil).toISOString()}::timestamptz,
				${JSON.stringify(legacy)}::jsonb
			)
		`;
		const laterLegacy = createSnapshot({
			rootDepartmentId: 1,
			startedAt: now + 5 * 60_000,
			completedAt: now + 5 * 60_000,
			departments,
			members,
		});
		await administrator`
			INSERT INTO enterprise_directory.snapshots
				(revision, fetched_at, valid_until, contents)
			VALUES (
				${laterLegacy.revision}, ${new Date(laterLegacy.fetchedAt).toISOString()}::timestamptz,
				${new Date(laterLegacy.validUntil).toISOString()}::timestamptz,
				${JSON.stringify(laterLegacy)}::jsonb
			)
		`;
		await migrateDirectoryStore(
			database.databaseUrl,
			migrationsFolder,
			runtimeRole,
		);
		await migrateDirectoryStore(
			database.databaseUrl,
			migrationsFolder,
			runtimeRole,
		);
		expect(await store.latest()).toEqual(laterLegacy);
		const oldRows = await administrator`
			SELECT generation FROM enterprise_directory.snapshots
			WHERE revision = ${legacy.revision}
		`;
		expect(oldRows[0]?.generation).toBeNull();
		const slowGeneration = await store.beginScan();
		const fastGeneration = await otherStore.beginScan();
		expect(fastGeneration).toBeGreaterThan(slowGeneration);
		const fast = createSnapshot({
			rootDepartmentId: 1,
			startedAt: now + 60_000,
			completedAt: now + 2 * 60_000,
			departments,
			members: [
				{
					userId: "wecom-b",
					email: "b@example.test",
					active: true,
					departmentIds: [1],
				},
			],
		});
		const slow = createSnapshot({
			rootDepartmentId: 1,
			startedAt: now,
			completedAt: now + 3 * 60_000,
			departments,
			members,
		});
		expect(await otherStore.publish(fast, fastGeneration)).toMatchObject({
			status: "published",
			summary: {
				baselineRevision: laterLegacy.revision,
				addedMembers: 1,
				removedMembers: 1,
			},
		});
		expect(await store.publish(slow, slowGeneration)).toEqual({
			status: "superseded",
		});
		expect(await store.publish(fast, fastGeneration)).toEqual({
			status: "superseded",
		});
		expect(await store.latest()).toEqual(fast);
		expect(await otherStore.latest()).toEqual(fast);
		const published = await administrator`
			SELECT count(*)::int AS count FROM enterprise_directory.snapshots
		`;
		expect(published[0]?.count).toBe(3);
		await administrator`
			CREATE FUNCTION enterprise_directory.delay_snapshot_insert()
			RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
				PERFORM pg_sleep(2);
				RETURN NEW;
			END;
			$$
		`;
		await administrator`
			CREATE TRIGGER delay_snapshot_insert
			BEFORE INSERT ON enterprise_directory.snapshots
			FOR EACH ROW EXECUTE FUNCTION enterprise_directory.delay_snapshot_insert()
		`;
		const concurrentSlowGeneration = await store.beginScan();
		const concurrentFastGeneration = await otherStore.beginScan();
		const concurrentFast = createSnapshot({
			rootDepartmentId: 1,
			startedAt: now + 4 * 60_000,
			completedAt: now + 5 * 60_000,
			departments,
			members,
		});
		const concurrentSlow = createSnapshot({
			rootDepartmentId: 1,
			startedAt: now + 3 * 60_000,
			completedAt: now + 6 * 60_000,
			departments,
			members,
		});
		const fastPublish = otherStore.publish(
			concurrentFast,
			concurrentFastGeneration,
		);
		void fastPublish.catch(() => undefined);
		let fastInsertPaused = false;
		for (let attempt = 0; attempt < 80; attempt += 1) {
			const activity = await administrator`
				SELECT count(*)::int AS waiting FROM pg_stat_activity
				WHERE usename = ${runtimeRole} AND wait_event = 'PgSleep'
			`;
			if (activity[0]?.waiting === 1) {
				fastInsertPaused = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(fastInsertPaused).toBe(true);
		const slowPublish = store.publish(concurrentSlow, concurrentSlowGeneration);
		expect(await Promise.all([fastPublish, slowPublish])).toEqual([
			expect.objectContaining({
				status: "published",
				summary: expect.objectContaining({
					baselineRevision: fast.revision,
					addedMembers: 1,
					removedMembers: 1,
				}),
			}),
			{ status: "superseded" },
		]);
		expect(await store.latest()).toEqual(concurrentFast);
		const concurrentRows = await administrator`
			SELECT count(*)::int AS count FROM enterprise_directory.snapshots
		`;
		expect(concurrentRows[0]?.count).toBe(4);
		await expect(store.publish(fast, 0n)).rejects.toThrow(
			"Invalid directory scan generation",
		);
		await expect(
			runtime`DELETE FROM enterprise_directory.snapshots`,
		).rejects.toMatchObject({ code: "42501" });
		await expect(
			runtime`UPDATE enterprise_directory.snapshots SET generation = 0`,
		).rejects.toMatchObject({ code: "42501" });
		await expect(
			runtime`SELECT setval('enterprise_directory.scan_generation', 999)`,
		).rejects.toMatchObject({ code: "42501" });
		await expect(
			runtime`CREATE TABLE enterprise_directory.forbidden (id integer)`,
		).rejects.toMatchObject({ code: "42501" });
		await expect(
			runtime`SELECT * FROM enterprise_directory_migrations.history`,
		).rejects.toMatchObject({ code: "42501" });
		await expect(
			migrateDirectoryStore(
				database.databaseUrl,
				migrationsFolder,
				"platform_test",
			),
		).rejects.toThrow("DIRECTORY_RUNTIME_DATABASE_ROLE is invalid");
	} finally {
		await otherStore.close();
		await store.close();
		await runtime.end();
		await administrator.end();
		await database.stop();
		await rm(legacyMigrations, { recursive: true, force: true });
	}
}, 120_000);
