import { resolve } from "node:path";

import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

type PostgresClient = ReturnType<typeof postgres>;

const migrations = readMigrationFiles({
	migrationsFolder: resolve(
		import.meta.dirname,
		"../../../migrations/platform",
	),
});

let client: PostgresClient;
let databaseUrl = "";
let testDatabase: PostgresTestDatabase | undefined;

async function applyMigration(index: number): Promise<void> {
	for (const statement of migrations[index]?.sql ?? []) {
		if (statement.trim()) await client.unsafe(statement);
	}
}

beforeAll(async () => {
	testDatabase = await startPostgresTestDatabase("agent-persistence-migration");
	databaseUrl = testDatabase.databaseUrl;
	client = postgres(databaseUrl, { max: 1 });
}, 120_000);

afterAll(async () => {
	await client?.end();
	await testDatabase?.stop();
});

describe("Agent persistence migration", () => {
	it("upgrades an existing application foundation database without inventing canonical configuration", async () => {
		await applyMigration(0);
		await applyMigration(1);
		await client`
			insert into platform.agents (id, current_configuration_revision)
			values ('agent_legacy', 1)
		`;
		await client`
			insert into platform.agent_applications
				(id, agent_id, applicant_id, name, description, status, trace_id,
					request_id, submitted_at)
			values
				('application_legacy', 'agent_legacy', 'user_legacy', 'Legacy Agent',
					'Existing application', 'pending_approval', 'trace_legacy',
					'request_legacy', now())
		`;
		await client`
			insert into platform.agent_configuration_revisions
				(agent_id, revision, source_reference, created_at)
			values ('agent_legacy', 1, 'source_legacy', now())
		`;
		await client`
			insert into platform.agent_owners (agent_id, owner_id, created_at)
			values ('agent_legacy', 'user_legacy', now())
		`;

		await client`create schema platform_migrations`;
		await client`
			create table platform_migrations.history (
				id serial primary key,
				hash text not null,
				created_at bigint
			)
		`;
		for (const migration of migrations.slice(0, 2)) {
			await client`
				insert into platform_migrations.history (hash, created_at)
				values (${migration.hash}, ${migration.folderMillis})
			`;
		}

		await migratePlatformDatabase({ databaseUrl });
		const migrationHistory = await client`
			select id, hash, created_at
			from platform_migrations.history
			order by id
		`;
		expect(migrationHistory).toHaveLength(4);
		await migratePlatformDatabase({ databaseUrl });
		expect(
			await client`
				select id, hash, created_at
				from platform_migrations.history
				order by id
			`,
		).toEqual(migrationHistory);

		const [application] = await client`
			select status, management_revision, approval_revision, decision_reason,
				service_availability, desired_state, workload_revision, fence,
				failure_code
			from platform.agent_applications
			where id = 'application_legacy'
		`;
		expect(application).toEqual({
			status: "pending_approval",
			management_revision: "0",
			approval_revision: null,
			decision_reason: null,
			service_availability: null,
			desired_state: "stopped",
			workload_revision: "0",
			fence: "0",
			failure_code: null,
		});
		const [revision] = await client`
			select revision, source_reference, configuration
			from platform.agent_configuration_revisions
			where agent_id = 'agent_legacy' and revision = 1
		`;
		expect(revision).toEqual({
			revision: "1",
			source_reference: "source_legacy",
			configuration: null,
		});
		const currentRevisionColumns = await client`
			select data_type
			from information_schema.columns
			where table_schema = 'platform' and table_name = 'agents'
				and column_name = 'current_configuration_revision'
		`;
		expect(currentRevisionColumns[0]?.data_type).toBe("bigint");
	});
});
