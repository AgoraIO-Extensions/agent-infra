import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresConnectionManualAssociationReaderV1 } from "./connection-manual-association-reader.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let reader: PostgresConnectionManualAssociationReaderV1;

async function agent(agentId: string, ...owners: string[]) {
	await sql`insert into platform.agents(id,authorization_revision) values (${agentId},'agent-r1')`;
	for (const owner of owners)
		await sql`insert into platform.agent_owners(agent_id,owner_id,created_at) values (${agentId},${owner},now())`;
}

async function associate(agentId: string, ownerId: string, n: number) {
	await sql`insert into platform.connection_association_generations(agent_id,last_revision) values (${agentId},1)`;
	await sql`insert into platform.connection_manual_associations(agent_id,connection_agent_id,credential_fingerprint,association_revision,owner_id,credential_ciphertext,verified_at) values (${agentId},${`connection-${agentId}`},${String(n).repeat(64)},1,${ownerId},${sql.json({ schemaVersion: 1, agentId, ownerId, secretVersion: 1, crypto: { dekFingerprint: String(n + 1).repeat(64) } })},now())`;
}

beforeAll(async () => {
	database = await startPostgresTestDatabase("4199-manual-association-owner");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 2, onnotice: () => {} });
	reader = new PostgresConnectionManualAssociationReaderV1({
		databaseUrl: database.databaseUrl,
	});
}, 120_000);

beforeEach(async () => {
	await sql`truncate platform.agents, platform.platform_user_disables cascade`;
	await agent("agent-a", "alice");
	await agent("agent-b", "bob");
	await associate("agent-a", "alice", 1);
});

afterAll(async () => {
	await reader?.close();
	await sql?.end();
	await database?.stop();
});

describe("#4199 C2 current Owner manual association (real PostgreSQL)", () => {
	it("holds only for the Agent whose association Owner is a current, enabled Owner", async () => {
		expect(await reader.associated("agent-a")).toBe(true);
		// Another Agent, and an Agent nobody associated.
		expect(await reader.associated("agent-b")).toBe(false);
		expect(await reader.associated("agent-unknown")).toBe(false);
	});

	it("stops holding when the Owner is replaced, as replaceAgentAccess does", async () => {
		// plan-writes replaceAgentAccess: delete the Owner rows, insert the new set; the
		// association row is left in place.
		await sql.begin(async (tx) => {
			await tx`delete from platform.agent_owners where agent_id='agent-a'`;
			await tx`insert into platform.agent_owners(agent_id,owner_id,created_at) values ('agent-a','bob',now())`;
		});
		expect(
			await sql`select owner_id from platform.connection_manual_associations where agent_id='agent-a'`,
		).toEqual([{ owner_id: "alice" }]);
		expect(await reader.associated("agent-a")).toBe(false);
		// Adding the original Owner back as a co-Owner makes it current again.
		await sql`insert into platform.agent_owners(agent_id,owner_id,created_at) values ('agent-a','alice',now())`;
		expect(await reader.associated("agent-a")).toBe(true);
	});

	it("stops holding when the Owner is removed or disabled, or the association is deleted", async () => {
		await sql`delete from platform.agent_owners where agent_id='agent-a'`;
		expect(await reader.associated("agent-a")).toBe(false);
		await sql`insert into platform.agent_owners(agent_id,owner_id,created_at) values ('agent-a','alice',now())`;
		await sql`insert into platform.platform_user_disables(user_id) values ('alice')`;
		expect(await reader.associated("agent-a")).toBe(false);
		await sql`delete from platform.platform_user_disables`;
		expect(await reader.associated("agent-a")).toBe(true);
		await sql`delete from platform.connection_manual_associations where agent_id='agent-a'`;
		expect(await reader.associated("agent-a")).toBe(false);
	});

	it("does not take another Agent's Owner as the association's Owner", async () => {
		// bob owns agent-b; an association on agent-b recorded for alice is not current.
		await associate("agent-b", "alice", 3);
		expect(await reader.associated("agent-b")).toBe(false);
	});
});
