import { resolve } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { expect, it } from "vitest";
import { agentConfigurationConformanceRecordV1 } from "../../platform-core/src/agent-configuration.conformance.js";
import { decodeAgentConfigurationRecord } from "./agent-configuration-record.js";
import { startPostgresTestDatabase } from "./postgres-test.js";

it("upgrades an existing V1 database without rewriting historical JSONB and constrains new record versions", async () => {
	const database = await startPostgresTestDatabase("configuration-version");
	const sql = postgres(database.databaseUrl, {
		max: 1,
		onnotice: () => undefined,
	});
	try {
		const migrations = readMigrationFiles({
			migrationsFolder: resolve(
				import.meta.dirname,
				"../../../migrations/platform",
			),
		});
		const configurationMigrationIndex = 14;
		const migration = migrations[configurationMigrationIndex];
		if (!migration) throw new Error("Missing configuration migration");
		for (const previous of migrations.slice(0, configurationMigrationIndex)) {
			for (const statement of previous.sql)
				if (statement.trim()) await sql.unsafe(statement);
		}
		const legacy = {
			...agentConfigurationConformanceRecordV1,
			schemaVersion: 1,
			actions: [
				{ providerId: "github", actionId: "issues.read", actionVersion: "v3" },
			],
			actionSetRevision: "original-policy-revision",
		};
		await sql`insert into platform.agents (id, current_configuration_revision) values ('agent_01', 7)`;
		await sql`insert into platform.agent_configuration_revisions (agent_id, revision, source_reference, configuration, created_at) values ('agent_01', 7, 'template_01', ${sql.json(legacy as unknown as postgres.JSONValue)}, now())`;
		const before =
			await sql`select configuration::text, revision::text, source_reference, created_at from platform.agent_configuration_revisions`;
		for (const statement of migration.sql)
			if (statement.trim()) await sql.unsafe(statement);
		expect(
			await sql`select configuration::text, revision::text, source_reference, created_at from platform.agent_configuration_revisions`,
		).toEqual(before);
		expect(decodeAgentConfigurationRecord(legacy)).toEqual(
			agentConfigurationConformanceRecordV1,
		);
		const current = { ...agentConfigurationConformanceRecordV1, revision: 8 };
		await sql`insert into platform.agent_configuration_revisions (agent_id, revision, source_reference, configuration, created_at) values ('agent_01', 8, 'template_01', ${sql.json(current as unknown as postgres.JSONValue)}, now())`;
		const { schemaVersion: _version, ...missingVersion } = current;
		for (const invalid of [
			{ ...current, revision: 9, schemaVersion: 3 },
			{ ...missingVersion, revision: 9 },
			{ ...current, revision: 9, agentId: "other-agent" },
			{ ...current, revision: 100 },
		]) {
			await expect(
				sql`insert into platform.agent_configuration_revisions (agent_id, revision, source_reference, configuration, created_at) values ('agent_01', 9, 'template_01', ${sql.json(invalid as unknown as postgres.JSONValue)}, now())`,
			).rejects.toMatchObject({ code: "23514" });
		}
		expect(
			(
				await sql`select count(*) count from platform.agent_configuration_revisions`
			)[0]?.count,
		).toBe("2");
	} finally {
		await sql.end();
		await database.stop();
	}
}, 120_000);
