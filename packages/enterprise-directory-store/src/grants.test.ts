import { resolve } from "node:path";
import { createSnapshot } from "@agent-infra/enterprise-directory";
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

it("migrates with one account and grants only snapshot read/write to another", async () => {
	const database = await startPostgresTestDatabase("directory-grants");
	const administrator = postgres(database.databaseUrl, { max: 1 });
	const runtimeRole = "directory_runtime";
	const runtimePassword = "directory-test-password";
	const runtimeUrl = new URL(database.databaseUrl);
	runtimeUrl.username = runtimeRole;
	runtimeUrl.password = runtimePassword;
	const runtime = postgres(runtimeUrl.toString(), { max: 1 });
	const store = createPostgresDirectoryStore(runtimeUrl.toString());
	try {
		await administrator`CREATE ROLE ${administrator(runtimeRole)} LOGIN PASSWORD 'directory-test-password'`;
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
		const now = Date.UTC(2026, 8, 28);
		const snapshot = createSnapshot({
			rootDepartmentId: 1,
			startedAt: now,
			completedAt: now,
			departments: [{ id: 1, name: "Company", parentId: 0 }],
			members: [
				{
					userId: "wecom-a",
					email: "a@example.test",
					active: true,
					departmentIds: [1],
				},
			],
		});
		await store.publish(snapshot);
		expect(await store.latest()).toEqual(snapshot);
		await expect(
			runtime`DELETE FROM enterprise_directory.snapshots`,
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
		await store.close();
		await runtime.end();
		await administrator.end();
		await database.stop();
	}
});
