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
const appliedReceiptMigrationIndex = migrations.findIndex((entry) =>
	entry.sql.some((statement) =>
		statement.includes("skill_hub_agent_binding_receipt_binding"),
	),
);

let database: PostgresTestDatabase | undefined;
let client: ReturnType<typeof postgres>;

beforeAll(async () => {
	database = await startPostgresTestDatabase(
		"skill-hub-applied-receipt-migration",
	);
	client = postgres(database.databaseUrl, { max: 1 });
}, 120_000);

afterAll(async () => {
	await client?.end();
	await database?.stop();
});

describe("Skill Hub Applied receipt migration", () => {
	it("returns legacy synced bindings to pending_sync before adding the receipt check", async () => {
		await client`create schema platform_migrations`;
		await client`
			create table platform_migrations.history (
				id serial primary key,
				hash text not null,
				created_at bigint
			)
		`;
		const legacyMigrations = migrations.slice(0, appliedReceiptMigrationIndex);
		for (const migration of legacyMigrations) {
			await client`
				insert into platform_migrations.history (hash, created_at)
				values (${migration.hash}, ${migration.folderMillis})
			`;
		}
		for (const migration of legacyMigrations) {
			for (const statement of migration.sql) {
				if (statement.trim()) await client.unsafe(statement);
			}
		}
		await client`
			insert into platform.agents (id, current_configuration_revision)
			values ('legacy-agent', 1)
		`;
		await client`
			insert into platform.agent_configuration_revisions
				(agent_id, revision, source_reference, created_at)
			values ('legacy-agent', 1, 'legacy-template', now())
		`;
		await client`
			insert into platform.skill_hub_skills
				(id, name, owner_id, status, created_at, updated_at)
			values ('legacy-skill', 'legacy-skill', 'legacy-owner', 'active', now(), now())
		`;
		await client`
			insert into platform.skill_hub_versions
				(id, skill_id, owner_id, version, provider, visibility, state,
				 package_object_version, package_digest, manifest_digest, signature_digest,
				 reviewed_by, created_at)
			values ('legacy-skill-version', 'legacy-skill', 'legacy-owner', '1.0.0',
				 'my_library', 'PRIVATE', 'published', 'legacy-object',
				 ${"a".repeat(64)}, ${"b".repeat(64)}, ${"c".repeat(64)},
				 'legacy-owner', now())
		`;
		await client`
			insert into platform.skill_hub_agent_bindings
				(agent_id, agent_version, skill_version_id, "grant", sync_revision, state,
				 failure_reason, created_at, updated_at, configuration_revision)
			values ('legacy-agent', 'legacy-version', 'legacy-skill-version', ${client.json({})},
				 1, 'synced', null, now(), now(), 1)
		`;

		const migration = migrations[appliedReceiptMigrationIndex];
		if (!migration) throw new Error("Missing Applied receipt migration");
		for (const statement of migration.sql) {
			if (statement.trim()) await client.unsafe(statement);
		}

		expect(
			await client`
				select state, failure_reason, applied_receipt
				from platform.skill_hub_agent_bindings
			`,
		).toEqual([
			{ state: "pending_sync", failure_reason: null, applied_receipt: null },
		]);
	});
});
