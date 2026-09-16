import postgres from "postgres";
import { expect, it } from "vitest";
import { migratePlatformDatabase } from "./migrate.ts";
import { startPostgresTestDatabase } from "./postgres-test.ts";
import { PostgresWecomConnectionsV1 } from "./wecom-connections.ts";
import { PostgresWecomSetupV1 } from "./wecom-setup.ts";

it("fences competing replicas and invalidates an owner after expiry or unbinding", async () => {
	const db = await startPostgresTestDatabase("wecom-connections");
	const sql = postgres(db.databaseUrl);
	const store = new PostgresWecomConnectionsV1(db);
	try {
		await migratePlatformDatabase(db);
		await sql`insert into platform.agents (id,current_configuration_revision,authorization_revision) values ('agent',1,'revision')`;
		await sql`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,created_at,configuration) values ('agent',1,'fixture',now(),${sql.json({ schemaVersion: 2, agentId: "agent", revision: 1, channels: [{ kind: "wecom_bot", bindingReference: "binding" }] })})`;
		const input = {
			botId: "bot",
			agentId: "agent",
			bindingReference: "binding",
		};
		const first = await store.claim({ ...input, holderId: "one" });
		expect(first).not.toBeNull();
		if (!first) throw new Error("Missing first lease");
		expect(await store.claim({ ...input, holderId: "two" })).toBeNull();
		expect(await store.current(first)).toBe(true);
		await sql`update platform.wecom_connections set lease_until=now()-interval '1 second'`;
		expect(await store.renew(first)).toBe(false);
		const second = await store.claim({ ...input, holderId: "two" });
		if (!second) throw new Error("Missing second lease");
		expect(second.fence).toBeGreaterThan(first.fence);
		expect(await store.current(first)).toBe(false);
		expect(await store.status(first, "connected")).toBe(false);
		expect(await store.status(second, "auth_failed")).toBe(true);
		await store.release(second);
		expect(
			(
				await sql`select status from platform.wecom_connections where bot_id='bot'`
			)[0]?.status,
		).toBe("auth_failed");
		await sql`update platform.agent_configuration_revisions set configuration=${sql.json({ schemaVersion: 2, agentId: "agent", revision: 1, channels: [] })} where agent_id='agent'`;
		expect(await store.current(second)).toBe(false);
	} finally {
		await store.close();
		await sql.end();
		await db.stop();
	}
}, 30_000);

it("does not let an expired setup probe terminate its replacement", async () => {
	const db = await startPostgresTestDatabase("wecom-setup-fence");
	const sql = postgres(db.databaseUrl);
	const leases = new PostgresWecomConnectionsV1(db);
	const setup = new PostgresWecomSetupV1(db);
	try {
		await migratePlatformDatabase(db);
		await sql`insert into platform.agents (id,current_configuration_revision,authorization_revision) values ('agent',1,'revision')`;
		await sql`insert into platform.agent_owners (agent_id,owner_id,created_at) values ('agent','owner',now())`;
		await sql`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,created_at,configuration) values ('agent',1,'fixture',now(),'{"schemaVersion":2,"agentId":"agent","revision":1,"channels":[]}'::jsonb)`;
		await sql`insert into platform.wecom_setup_sessions (session_id,agent_id,actor_id,configuration_revision,authorization_revision,state_digest,expires_at,status,bot_id,encrypted_credential) values ('setup','agent','owner',1,'revision',${"a".repeat(64)},now()+interval '5 minutes','verifying','bot','{"fixture":"ciphertext"}'::jsonb)`;
		const input = { agentId: "agent", bindingReference: "setup", botId: "bot" };
		const first = await leases.claim({ ...input, holderId: "one" });
		if (!first) throw new Error("Missing lease");
		await sql`update platform.wecom_connections set lease_until=now()-interval '1 second'`;
		const second = await leases.claim({ ...input, holderId: "two" });
		if (!second) throw new Error("Missing replacement");
		await setup.fail("setup", "auth_failed", first);
		expect((await setup.read("setup"))?.status).toBe("verifying");
		expect((await setup.read("setup"))?.encryptedCredential).toEqual({
			fixture: "ciphertext",
		});
		await setup.fail("setup", "auth_failed", second);
		expect((await setup.read("setup"))?.status).toBe("auth_failed");
		expect((await setup.read("setup"))?.encryptedCredential).toBeNull();
	} finally {
		await setup.close();
		await leases.close();
		await sql.end();
		await db.stop();
	}
}, 30000);
