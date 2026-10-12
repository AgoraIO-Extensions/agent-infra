import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentConfigurationConformanceRecordV1 } from "../../platform-core/src/agent-configuration.conformance.ts";
import { PostgresAgentConfigurationQueryV1 } from "./agent-configuration.query.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

const occurredAt = new Date("2026-10-12T00:00:00.000Z");
const oldDigest = agentConfigurationConformanceRecordV1.source.imageDigest;
const newDigest = `sha256:${"b".repeat(64)}`;
let testDatabase: PostgresTestDatabase;
let admin: ReturnType<typeof postgres>;
let databaseUrl: string;

async function seed(agentId: string, revision: number, digest = oldDigest) {
	const configuration = {
		...structuredClone(agentConfigurationConformanceRecordV1),
		agentId,
		revision,
		source: {
			...agentConfigurationConformanceRecordV1.source,
			imageDigest: digest,
		},
	};
	await admin`
		insert into platform.agents
			(id, current_configuration_revision, created_at, authorization_revision)
		values (${agentId}, ${revision}, ${occurredAt}, 'authorization_9')`;
	await admin`
		insert into platform.agent_applications
			(id, agent_id, applicant_id, name, description, status, trace_id,
			 request_id, submitted_at, management_revision, approval_revision,
			 service_availability, desired_state, workload_revision, fence)
		values (${`application_${agentId}`}, ${agentId}, 'owner_01', 'Agent',
			'Agent description', 'available', 'trace_seed', 'request_seed',
			${occurredAt}, 11, 1, 'ready', 'running', 1, 1)`;
	await admin`
		insert into platform.agent_configuration_revisions
			(agent_id, revision, source_reference, created_at, configuration)
		values (${agentId}, ${revision}, ${configuration.source.kind === "standard" ? configuration.source.templateId : configuration.source.imageDigest}, ${occurredAt},
			${admin.json(configuration as never)})`;
}

beforeAll(async () => {
	testDatabase = await startPostgresTestDatabase("standard-template-upgrade");
	databaseUrl = testDatabase.databaseUrl;
	await migratePlatformDatabase({ databaseUrl });
	admin = postgres(databaseUrl, { max: 4 });
});

afterAll(async () => {
	await admin.end();
	await testDatabase.stop();
});

describe("standard template upgrade discovery", () => {
	it("enumerates every Agent on the old template digest in stable order", async () => {
		await admin`truncate platform.agent_configuration_revisions, platform.agent_applications, platform.agents cascade`;
		await seed("agent_02", 9);
		await seed("agent_01", 7);
		await seed("agent_custom", 4, `sha256:${"c".repeat(64)}`);
		const query = new PostgresAgentConfigurationQueryV1({ databaseUrl });
		try {
			expect(
				await query.listStandardTemplateReleaseTargets({
					releaseId: "release_01",
					templateId: "template_01",
					expectedImageDigest: oldDigest,
					targetImageDigest: newDigest,
				}),
			).toEqual([
				{
					schemaVersion: 1,
					releaseId: "release_01",
					agentId: "agent_01",
					templateId: "template_01",
					expectedConfigurationRevision: 7,
					expectedImageDigest: oldDigest,
					targetImageDigest: newDigest,
				},
				{
					schemaVersion: 1,
					releaseId: "release_01",
					agentId: "agent_02",
					templateId: "template_01",
					expectedConfigurationRevision: 9,
					expectedImageDigest: oldDigest,
					targetImageDigest: newDigest,
				},
			]);
		} finally {
			await query.close();
		}
	});

	it("fails closed when the old and new digests are equal", async () => {
		const query = new PostgresAgentConfigurationQueryV1({ databaseUrl });
		try {
			await expect(
				query.listStandardTemplateReleaseTargets({
					releaseId: "release_01",
					templateId: "template_01",
					expectedImageDigest: oldDigest,
					targetImageDigest: oldDigest,
				}),
			).rejects.toMatchObject({ name: "AgentConfigurationStoreError" });
		} finally {
			await query.close();
		}
	});
});
