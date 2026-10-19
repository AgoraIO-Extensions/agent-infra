import { readdir, readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readAgentManagementState } from "./agent-management.ts";
import { agentManagementStateJsonSql } from "./agent-management-state-sql.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
	database = await startPostgresTestDatabase("agent-management-state-sql");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 1, onnotice: () => {} });
	for (const [agentId, channel] of [
		["agent-web", "web"],
		["agent-api", "api"],
	] as const) {
		await sql`insert into platform.agents (id, current_configuration_revision, authorization_revision)
			values (${agentId}, 1, 'authorization')`;
		await sql`insert into platform.agent_applications
			(id, agent_id, applicant_id, name, description, status, trace_id, request_id, submitted_at,
			 management_revision, approval_revision, desired_state, service_availability, workload_revision, fence,
			 creation_channel, creator_principal_type, creator_principal_id)
			values (${`application-${agentId}`}, ${agentId}, 'owner-b', 'Agent', 'Fixture', 'available',
			 'trace', 'request', now(), 7, ${channel === "web" ? 3 : null}, 'running', 'ready', 5, 4,
			 ${channel}, ${channel === "api" ? "user" : null}, ${channel === "api" ? "owner-b" : null})`;
		for (const owner of ["owner-b", "owner-a"])
			await sql`insert into platform.agent_owners (agent_id, owner_id, created_at)
				values (${agentId}, ${owner}, now())`;
		await sql`insert into platform.agent_availability (agent_id, target_type, target_id)
			values (${agentId}, 'user', 'user-1'), (${agentId}, 'organization', 'org-1')`;
	}
}, 120_000);

afterAll(async () => {
	await sql?.end();
	await database?.stop();
});

describe("shared Agent management state SQL (#2775)", () => {
	it.each(["agent-web", "agent-api"])(
		"builds exactly the state that readAgentManagementState reads for %s",
		async (agentId) => {
			// drizzle 会改写客户端的类型解析与序列化：用独立客户端读取对照值。
			const reader = postgres(database.databaseUrl, { max: 1 });
			const expected = await readAgentManagementState(
				drizzle(reader) as unknown as Parameters<
					typeof readAgentManagementState
				>[0],
				agentId,
			).finally(() => reader.end());
			const [row] = await sql<{ management: unknown }[]>`
				select ${sql.unsafe(agentManagementStateJsonSql("a"))} as management
				from platform.agent_applications a where a.agent_id = ${agentId}`;
			expect(row?.management).toEqual(expected);
			expect(Object.hasOwn(row?.management as object, "creationChannel")).toBe(
				agentId === "agent-api",
			);
		},
	);

	it("rejects an alias that is not a plain identifier", () => {
		expect(() => agentManagementStateJsonSql("a; drop table x")).toThrow(
			TypeError,
		);
	});

	it("is the only place where read SQL assembles an Agent management state", async () => {
		// 回归保护：#2775 的四处手工拼装都漏了 creationChannel。新的读取需要管理状态时复用这个片段。
		const directory = new URL(".", import.meta.url);
		const sources = (await readdir(directory)).filter(
			(name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
		);
		const assembling: string[] = [];
		for (const name of sources) {
			const text = await readFile(new URL(name, directory), "utf8");
			if (/'approvalRevision',/.test(text)) assembling.push(name);
		}
		expect(assembling).toEqual(["agent-management-state-sql.ts"]);
	});
});
