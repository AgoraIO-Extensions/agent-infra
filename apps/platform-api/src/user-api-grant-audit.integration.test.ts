import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import {
	ScopedPlatformAuditPageV1Schema,
	ScopedPlatformAuditProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agentConfigurationConformanceRecordV1 } from "../../../packages/platform-core/src/agent-configuration.conformance.ts";
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.ts";
import {
	grantAgentUserApiUseV1,
	revokeAgentUserApiUseV1,
} from "../../web/src/pilot/generated-v2/sdk.gen.ts";
import {
	createPlatformApiShutdown,
	startPlatformApiFromDeployment,
} from "./index.ts";

// Controlled current identities; actual deployment loader, Core, SQL and HTTP.
const moduleSpecifier = new URL(
	"../../../tests/fixtures/personal-agent-read-deployment.ts",
	import.meta.url,
).href;
const deployment: typeof import("../../../tests/fixtures/personal-agent-read-deployment.ts") =
	await import(moduleSpecifier);
let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let shutdown: (() => Promise<void>) | undefined;
let baseUrl: string;
const cookie = (user: string) => ({
	Cookie: `__Host-platform-session=session_${user}`,
});
beforeAll(async () => {
	database = await startPostgresTestDatabase("user-api-grant-audit");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 1 });
	deployment.state.databaseUrl = database.databaseUrl;
	deployment.state.directoryMode = "active";
	deployment.state.directoryCalls = 0;
	const record = {
		...structuredClone(agentConfigurationConformanceRecordV1),
		agentId: "grant-agent",
	};
	await sql`insert into platform.agents(id,current_configuration_revision) values ('grant-agent',${record.revision})`;
	await sql`insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence)
 values ('grant-application','grant-agent','user_alice','Grant audit','Controlled fixture','available','seed','seed',now(),1,1,'ready','running',1,1)`;
	await sql`insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,configuration,created_at)
 values ('grant-agent',${record.revision},${record.source.kind === "standard" ? record.source.templateId : record.source.imageDigest},${sql.json(record as never)},now())`;
	await sql`insert into platform.agent_owners(agent_id,owner_id,created_at) values ('grant-agent','user_alice',now())`;
	const output = new PassThrough();
	output.resume();
	const running = await startPlatformApiFromDeployment({
		moduleSpecifier,
		port: 0,
		log: () => {},
		observabilityOptions: { output },
	});
	shutdown = createPlatformApiShutdown(running);
	const address = running.server.address();
	if (!address || typeof address === "string") throw new Error("No listener");
	baseUrl = `http://127.0.0.1:${address.port}`;
}, 120_000);
afterAll(async () => {
	await shutdown?.();
	await sql?.end();
	await database?.stop();
});

it("reads actual Owner grant, revoke and replay history without leaking it to execution scopes", async () => {
	const common = {
		baseUrl,
		path: { agentId: "grant-agent", userId: "user_bob" },
		body: { schemaVersion: 1 as const, expectedRevision: 1 },
	};
	const grant = {
		...common,
		headers: { ...cookie("alice"), "Idempotency-Key": randomUUID() },
	};
	expect((await grantAgentUserApiUseV1(grant)).response?.status).toBe(200);
	expect((await grantAgentUserApiUseV1(grant)).response?.status).toBe(200);
	const revoke = {
		...common,
		headers: { ...cookie("alice"), "Idempotency-Key": randomUUID() },
	};
	expect((await revokeAgentUserApiUseV1(revoke)).response?.status).toBe(200);
	expect((await revokeAgentUserApiUseV1(revoke)).response?.status).toBe(200);
	const rows = await sql<
		{ id: string; action: string }[]
	>`select id,action from platform.audit_events where action like 'api.agent.use.%' and outcome='succeeded'`;
	expect(rows.map((x) => x.action).sort()).toEqual(
		[
			"api.agent.use.granted",
			"api.agent.use.revoked",
			"api.agent.use.replayed",
			"api.agent.use.replayed",
		].sort(),
	);
	const request = async (
		path: string,
		headers = cookie("admin"),
		status = 200,
	) => {
		const response = await fetch(baseUrl + path, { headers });
		expect(response.status).toBe(status);
		return response.json();
	};
	const page = ScopedPlatformAuditPageV1Schema.parse(
		await request("/api/v3/admin/audit?limit=100"),
	);
	expect(page.items.map((x) => x.auditId)).toEqual(
		expect.arrayContaining(rows.map((x) => x.id)),
	);
	for (const row of rows) {
		const record = ScopedPlatformAuditProjectionV1Schema.parse(
			await request(`/api/v3/admin/audit/${row.id}`),
		);
		expect(record).toMatchObject({
			action: row.action,
			summary: row.action,
			result: "succeeded",
			actor: { kind: "user", actorId: "user_alice" },
			subject: { kind: "agent", subjectId: "grant-agent" },
			executionId: null,
		});
		expect(record).not.toHaveProperty("details");
		expect(JSON.stringify(record)).not.toContain("user_bob");
		const filtered = ScopedPlatformAuditPageV1Schema.parse(
			await request(`/api/v3/admin/audit?action=${row.action}`),
		);
		expect(filtered.items.map((x) => x.auditId)).toContain(row.id);
		for (const user of ["alice", "bob"]) {
			await request(`/api/v1/audit/${row.id}`, cookie(user), 404);
			await request(`/api/v3/admin/audit/${row.id}`, cookie(user), 404);
		}
	}
}, 30_000);
