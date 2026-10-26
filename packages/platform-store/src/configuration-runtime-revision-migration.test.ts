import { resolve } from "node:path";

import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

const migrations = readMigrationFiles({
	migrationsFolder: resolve(
		import.meta.dirname,
		"../../../migrations/platform",
	),
});
const runtimeRevisionMigrationIndex = migrations.findIndex((entry) =>
	entry.sql.some((statement) =>
		statement.includes("agent_configuration_runtime_revision_range"),
	),
);

let database: PostgresTestDatabase | undefined;
let client: ReturnType<typeof postgres>;

beforeAll(async () => {
	database = await startPostgresTestDatabase(
		"configuration-runtime-revision-migration",
	);
	client = postgres(database.databaseUrl, { max: 1, onnotice: () => {} });
}, 120_000);

afterAll(async () => {
	await client?.end();
	await database?.stop();
});

async function apply(migration: (typeof migrations)[number]) {
	for (const statement of migration.sql)
		if (statement.trim()) await client.unsafe(statement);
}

describe("Configuration Runtime revision migration (ADR-0028)", () => {
	it("backfills each revision as its own Runtime revision and defaults writers that omit it", async () => {
		expect(runtimeRevisionMigrationIndex).toBeGreaterThan(0);
		await client`create schema platform_migrations`;
		await client`
			create table platform_migrations.history (
				id serial primary key,
				hash text not null,
				created_at bigint
			)
		`;
		const legacyMigrations = migrations.slice(0, runtimeRevisionMigrationIndex);
		for (const migration of legacyMigrations)
			await client`
				insert into platform_migrations.history (hash, created_at)
				values (${migration.hash}, ${migration.folderMillis})
			`;
		for (const migration of legacyMigrations) await apply(migration);
		await client`insert into platform.agents (id, current_configuration_revision) values ('legacy-agent', 3)`;
		for (const revision of [1, 2, 3])
			await client`insert into platform.agent_configuration_revisions
				(agent_id, revision, source_reference, created_at)
				values ('legacy-agent', ${revision}, 'legacy-template', now())`;

		const migration = migrations[runtimeRevisionMigrationIndex];
		if (!migration) throw new Error("Missing Runtime revision migration");
		await apply(migration);

		// Existing Workloads, Sandbox policies and Executions keep the same numbers.
		expect(
			await client`select revision::int, runtime_revision::int
				from platform.agent_configuration_revisions order by revision`,
		).toEqual([
			{ revision: 1, runtime_revision: 1 },
			{ revision: 2, runtime_revision: 2 },
			{ revision: 3, runtime_revision: 3 },
		]);
		// A writer that predates the column conservatively changes Runtime inputs.
		await client`insert into platform.agent_configuration_revisions
			(agent_id, revision, source_reference, created_at)
			values ('legacy-agent', 4, 'legacy-template', now())`;
		// A channel-only revision inherits an earlier Runtime revision.
		await client`insert into platform.agent_configuration_revisions
			(agent_id, revision, runtime_revision, source_reference, created_at)
			values ('legacy-agent', 5, 4, 'legacy-template', now())`;
		expect(
			await client`select revision::int, runtime_revision::int
				from platform.agent_configuration_revisions where revision >= 4 order by revision`,
		).toEqual([
			{ revision: 4, runtime_revision: 4 },
			{ revision: 5, runtime_revision: 4 },
		]);
		// The Runtime revision is never later than its row and always exists.
		await expect(
			client`insert into platform.agent_configuration_revisions
				(agent_id, revision, runtime_revision, source_reference, created_at)
				values ('legacy-agent', 6, 7, 'legacy-template', now())`,
		).rejects.toMatchObject({
			constraint_name: "agent_configuration_runtime_revision_range",
		});
		await client`insert into platform.agents (id, current_configuration_revision) values ('other-agent', 1)`;
		await expect(
			client`insert into platform.agent_configuration_revisions
				(agent_id, revision, runtime_revision, source_reference, created_at)
				values ('other-agent', 2, 1, 'other-template', now())`,
		).rejects.toMatchObject({
			constraint_name: "agent_configuration_runtime_revision_fk",
		});
	}, 60_000);
});
