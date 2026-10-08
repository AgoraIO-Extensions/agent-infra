import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeAgentConfigurationRecordV3 } from "@agent-infra/platform-core";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { expect, it } from "vitest";
import { agentConfigurationConformanceRecordV1 } from "../../platform-core/src/agent-configuration.conformance.js";
import {
	decodeAgentConfigurationRecord,
	decodeVersionedAgentConfigurationRecord,
} from "./agent-configuration-record.js";
import { migratePlatformDatabase } from "./migrate.js";
import { startPostgresTestDatabase } from "./postgres-test.js";

const migrationsFolder = resolve(
	import.meta.dirname,
	"../../../migrations/platform",
);
const migrations = readMigrationFiles({ migrationsFolder });
const journal = JSON.parse(
	readFileSync(resolve(migrationsFolder, "meta/_journal.json"), "utf8"),
) as {
	entries: { idx: number; when: number }[];
};

it.each([30, 35, 39])(
	"upgrades checkpoint %s to V3 without rewriting historical configurations or Task rows",
	async (checkpointIndex) => {
		const checkpoint = journal.entries.find(
			({ idx }) => idx === checkpointIndex,
		)?.when;
		if (!checkpoint) throw new Error("Missing migration checkpoint");
		const database = await startPostgresTestDatabase(
			"configuration-v3-migration",
		);
		const sql = postgres(database.databaseUrl, {
			max: 1,
			onnotice: () => undefined,
		});
		try {
			await sql`create schema platform_migrations`;
			await sql`create table platform_migrations.history (id serial primary key, hash text not null, created_at bigint)`;
			for (const migration of migrations.filter(
				({ folderMillis }) => folderMillis <= checkpoint,
			)) {
				for (const statement of migration.sql)
					if (statement.trim()) await sql.unsafe(statement);
				await sql`insert into platform_migrations.history(hash,created_at) values(${migration.hash},${migration.folderMillis})`;
			}
			await sql`insert into platform.agents(id,current_configuration_revision) values('agent_01',8)`;
			for (const [schemaVersion, revision] of [
				[1, 7],
				[2, 8],
			] as const) {
				const record = {
					...agentConfigurationConformanceRecordV1,
					schemaVersion,
					revision,
					...(schemaVersion === 1
						? {
								actions: [
									{
										providerId: "github",
										actionId: "issues.read",
										actionVersion: "v3",
									},
								],
								actionSetRevision: "legacy-policy",
							}
						: {}),
				};
				await sql`insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,configuration,created_at) values('agent_01',${revision},'template_01',${sql.json(record as unknown as postgres.JSONValue)},now())`;
			}
			await sql`insert into platform.conversations(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision) values('conversation','agent_01','user','web','ready',1,'authorization')`;
			await sql`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,authorization_revision,created_at) values('execution','conversation','agent_01','user','web','turn','completed',1,'authorization','2026-01-01T00:00:00Z')`;
			const records = () =>
				sql`select configuration::text,revision,source_reference,created_at from platform.agent_configuration_revisions order by revision`;
			const tasks = () =>
				sql`select execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,authorization_revision,created_at from platform.conversation_executions`;
			const before = await records();
			const tasksBefore = await tasks();
			await sql`insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,management_revision,approval_revision,desired_state,workload_revision,fence,trace_id,request_id,submitted_at) values('legacy-application','agent_01','legacy-owner','Legacy Agent','Preserved approved Web Agent','stopped',2,1,'stopped',1,1,'legacy-trace','legacy-request','2026-01-01T00:00:00Z')`;
			await sql`insert into platform.agent_owners(agent_id,owner_id,created_at) values('agent_01','legacy-owner','2026-01-01T00:00:00Z')`;
			await sql`insert into platform.audit_events(id,agent_id,actor_type,actor_id,action,target_type,target_id,outcome,trace_id,request_id) values('legacy-audit','agent_01','user','legacy-owner','agent.application.approved','agent_application','legacy-application','succeeded','legacy-trace','legacy-request')`;
			const managementBefore = await sql`
				select id,agent_id,applicant_id,name,description,status,trace_id,request_id,
					submitted_at,management_revision,approval_revision,decision_reason,
					service_availability,desired_state,workload_revision,fence,failure_code
				from platform.agent_applications`;
			const ownersBefore = await sql`select * from platform.agent_owners`;
			const auditBefore = await sql`select * from platform.audit_events`;
			const historyBefore =
				await sql`select * from platform_migrations.history order by id`;
			await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
			expect(await records()).toEqual(before);
			for (const record of await records()) {
				expect(
					decodeAgentConfigurationRecord(JSON.parse(record.configuration)),
				).toEqual({
					...agentConfigurationConformanceRecordV1,
					revision: Number(record.revision),
				});
			}
			expect(await tasks()).toEqual(tasksBefore);
			expect(await sql`select * from platform.agent_applications`).toEqual(
				managementBefore,
			);
			expect(await sql`select * from platform.agent_owners`).toEqual(
				ownersBefore,
			);
			expect(await sql`select * from platform.audit_events`).toEqual(
				auditBefore,
			);
			expect(
				await sql`select to_regclass('platform.session_sandbox_allocations') as relation`,
			).toEqual([{ relation: "platform.session_sandbox_allocations" }]);
			const historyAfter =
				await sql`select * from platform_migrations.history order by id`;
			expect(historyAfter.slice(0, historyBefore.length)).toEqual(
				historyBefore,
			);
			await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
			expect(
				await sql`select * from platform_migrations.history order by id`,
			).toEqual(historyAfter);
			const model = agentConfigurationConformanceRecordV1.modelConfiguration;
			if (!model) throw new Error("Missing model fixture");
			const current = {
				...agentConfigurationConformanceRecordV1,
				schemaVersion: 3,
				revision: 9,
				modelConfiguration: {
					...model,
					options: model.options.map(
						({ credential: _credential, ...option }) => option,
					),
				},
			};
			expect(decodeAgentConfigurationRecordV3(current)).toEqual(current);
			await sql`insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,configuration,created_at) values('agent_01',9,'template_01',${sql.json(current as unknown as postgres.JSONValue)},now())`;
			const persisted = (
				await sql`select configuration from platform.agent_configuration_revisions where agent_id='agent_01' and revision=9`
			)[0]?.configuration;
			expect(decodeVersionedAgentConfigurationRecord(persisted)).toEqual(
				current,
			);
			expect(() => decodeAgentConfigurationRecord(persisted)).toThrow();
			expect(JSON.stringify(persisted)).not.toContain("credential");
			const firstOption = current.modelConfiguration.options[0];
			if (!firstOption) throw Error("Missing model option");
			for (const field of ["credential", "keyReference"]) {
				const malformed = {
					...current,
					modelConfiguration: {
						...current.modelConfiguration,
						options: [{ ...firstOption, [field]: "forbidden" }],
					},
				};
				expect(() =>
					decodeVersionedAgentConfigurationRecord(malformed),
				).toThrow();
			}
			for (const invalid of [
				{ ...current, revision: 10, schemaVersion: 4 },
				{ ...current, revision: 10, agentId: "other-agent" },
				{ ...current, revision: 11 },
			]) {
				await expect(
					sql`insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,configuration,created_at) values('agent_01',10,'template_01',${sql.json(invalid as unknown as postgres.JSONValue)},now())`,
				).rejects.toMatchObject({ code: "23514" });
			}
			expect((await records()).slice(0, 2)).toEqual(before);
		} finally {
			await sql.end();
			await database.stop();
		}
	},
	120_000,
);
