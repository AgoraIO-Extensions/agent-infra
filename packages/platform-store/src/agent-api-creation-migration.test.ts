import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { expect, it } from "vitest";
import { migratePlatformDatabase } from "./migrate.js";
import { startPostgresTestDatabase } from "./postgres-test.js";

it("0042 preserves existing Web approval, Owner and audit references and rejects missing API provenance", async () => {
	const folder = resolve(import.meta.dirname, "../../../migrations/platform");
	const journal = JSON.parse(
		readFileSync(resolve(folder, "meta/_journal.json"), "utf8"),
	) as { entries: { idx: number; when: number }[] };
	const checkpoint = journal.entries.find((entry) => entry.idx === 41)?.when;
	if (!checkpoint) throw Error("Missing 0041 checkpoint");
	const database = await startPostgresTestDatabase(
		"agent-api-create-migration",
	);
	const sql = postgres(database.databaseUrl, { max: 1, onnotice: () => {} });
	try {
		await sql`create schema platform_migrations`;
		await sql`create table platform_migrations.history(id serial primary key,hash text not null,created_at bigint)`;
		for (const migration of readMigrationFiles({
			migrationsFolder: folder,
		}).filter((migration) => migration.folderMillis <= checkpoint)) {
			for (const statement of migration.sql)
				if (statement.trim()) await sql.unsafe(statement);
			await sql`insert into platform_migrations.history(hash,created_at) values(${migration.hash},${migration.folderMillis})`;
		}
		await sql`insert into platform.agents(id,authorization_revision) values('legacy-agent','legacy-revision')`;
		await sql`insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,management_revision,approval_revision,desired_state,workload_revision,fence,trace_id,request_id,submitted_at) values('legacy-application','legacy-agent','legacy-owner','Legacy Agent','Existing Web record','stopped',2,1,'stopped',1,1,'legacy-trace','legacy-request','2026-01-01T00:00:00Z')`;
		await sql`insert into platform.agent_owners(agent_id,owner_id,created_at) values('legacy-agent','legacy-owner','2026-01-01T00:00:00Z')`;
		await sql`insert into platform.audit_events(id,agent_id,actor_type,actor_id,action,target_type,target_id,outcome,trace_id,request_id) values('legacy-audit','legacy-agent','user','legacy-owner','agent.application.approved','agent_application','legacy-application','succeeded','legacy-trace','legacy-request')`;
		const before =
			await sql`select id,agent_id,applicant_id,status,management_revision,approval_revision,desired_state,workload_revision,fence,trace_id,request_id,submitted_at from platform.agent_applications`;
		const owners = await sql`select * from platform.agent_owners`;
		const audit = await sql`select * from platform.audit_events`;
		const history =
			await sql`select * from platform_migrations.history order by id`;
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		expect(
			await sql`select id,agent_id,applicant_id,status,management_revision,approval_revision,desired_state,workload_revision,fence,trace_id,request_id,submitted_at from platform.agent_applications`,
		).toEqual(before);
		expect(await sql`select * from platform.agent_owners`).toEqual(owners);
		expect(await sql`select * from platform.audit_events`).toEqual(audit);
		expect(
			(await sql`select * from platform_migrations.history order by id`).slice(
				0,
				history.length,
			),
		).toEqual(history);
		expect(
			await sql`select creation_channel,creator_principal_type,creator_principal_id from platform.agent_applications`,
		).toEqual([
			{
				creation_channel: "web",
				creator_principal_type: null,
				creator_principal_id: null,
			},
		]);
		await expect(
			sql`update platform.agent_applications set creation_channel='api',approval_revision=null where id='legacy-application'`,
		).rejects.toMatchObject({ code: "23514" });
		await expect(
			sql`update platform.agent_applications set creation_channel='api',creator_principal_type='application',creator_principal_id='robot' where id='legacy-application'`,
		).rejects.toMatchObject({ code: "23514" });
	} finally {
		await sql.end();
		await database.stop();
	}
}, 120000);
