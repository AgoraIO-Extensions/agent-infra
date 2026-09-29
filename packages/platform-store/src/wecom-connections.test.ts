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
		expect(
			await sql`select action,outcome,details from platform.audit_events where action='wecom.connection_auth_failed'`,
		).toMatchObject([
			{
				action: "wecom.connection_auth_failed",
				outcome: "failed",
				details: null,
			},
		]);
		await store.release(second);
		expect(
			(
				await sql`select status from platform.wecom_connections where bot_id='bot'`
			)[0]?.status,
		).toBe("auth_failed");
		await sql`update platform.agent_configuration_revisions set configuration=${sql.json({ schemaVersion: 2, agentId: "agent", revision: 1, channels: [] })} where agent_id='agent'`;
		expect(await store.current(second)).toBe(false);
		expect(await store.status(second, "connected")).toBe(false);
	} finally {
		await store.close();
		await sql.end();
		await db.stop();
	}
}, 30_000);

it("does not transfer an expired bot lease while another Agent still binds it", async () => {
	const db = await startPostgresTestDatabase("wecom-cross-agent-lease");
	const sql = postgres(db.databaseUrl);
	const store = new PostgresWecomConnectionsV1(db);
	try {
		await migratePlatformDatabase(db);
		await sql`insert into platform.agents (id,current_configuration_revision,authorization_revision) values ('agent-a',1,'revision'),('agent-b',1,'revision')`;
		for (const agentId of ["agent-a", "agent-b"]) {
			await sql`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,created_at,configuration) values (${agentId},1,'fixture',now(),${sql.json({ schemaVersion: 2, agentId, revision: 1, channels: [{ kind: "wecom_bot", bindingReference: `binding-${agentId}` }] })})`;
		}
		const first = await store.claim({
			agentId: "agent-a",
			bindingReference: "binding-agent-a",
			botId: "shared-bot",
			holderId: "worker-a",
		});
		if (!first) throw new Error("Missing first lease");
		await sql`update platform.wecom_connections set lease_until=now()-interval '1 second' where bot_id='shared-bot'`;
		const other = {
			agentId: "agent-b",
			bindingReference: "binding-agent-b",
			botId: "shared-bot",
			holderId: "worker-b",
		};
		expect(await store.claim(other)).toBeNull();
		expect(
			(
				await sql`select agent_id from platform.wecom_connections where bot_id='shared-bot'`
			)[0]?.agent_id,
		).toBe("agent-a");
		await sql`update platform.agent_configuration_revisions set configuration=jsonb_set(configuration,'{channels}','[]'::jsonb) where agent_id='agent-a'`;
		expect(await store.claim(other)).not.toBeNull();
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

it("keeps an active binding connected while replacement credentials are verifying", async () => {
	const db = await startPostgresTestDatabase("wecom-replacement-lease");
	const sql = postgres(db.databaseUrl);
	const leases = new PostgresWecomConnectionsV1(db);
	const setup = new PostgresWecomSetupV1(db);
	try {
		await migratePlatformDatabase(db);
		await sql`insert into platform.agents (id,current_configuration_revision,authorization_revision) values ('agent',1,'revision')`;
		await sql`insert into platform.agent_owners (agent_id,owner_id,created_at) values ('agent','owner',now())`;
		await sql`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,created_at,configuration) values ('agent',1,'fixture',now(),${sql.json({ schemaVersion: 2, agentId: "agent", revision: 1, channels: [{ kind: "wecom_bot", bindingReference: "active" }] })})`;
		const active = await leases.claim({
			agentId: "agent",
			bindingReference: "active",
			botId: "bot",
			holderId: "worker",
		});
		if (!active) throw new Error("Missing active connection");
		expect(await leases.status(active, "connected")).toBe(true);
		await sql`insert into platform.wecom_setup_sessions (session_id,agent_id,actor_id,configuration_revision,authorization_revision,state_digest,expires_at,status,bot_id) values ('active','agent','owner',1,'revision','old',now()+interval '1 day','active','bot')`;
		await sql`insert into platform.wecom_setup_sessions (session_id,agent_id,actor_id,configuration_revision,authorization_revision,state_digest,expires_at,status,bot_id) values ('replacement','agent','owner',1,'revision',${"a".repeat(64)},now()+interval '5 minutes','verifying','bot')`;
		expect(await leases.current(active)).toBe(true);
		expect(await leases.renew(active)).toBe(true);
		expect(
			await leases.claim({
				agentId: "agent",
				bindingReference: "replacement",
				botId: "bot",
				holderId: "probe",
			}),
		).toBeNull();
		const replacement = await setup.read("replacement");
		if (!replacement) throw new Error("Missing replacement session");
		await sql`insert into platform.agents (id,current_configuration_revision,authorization_revision) values ('other-agent',1,'revision')`;
		await sql`insert into platform.agent_owners (agent_id,owner_id,created_at) values ('other-agent','other-owner',now())`;
		await sql`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,created_at,configuration) values ('other-agent',1,'fixture',now(),${sql.json({ schemaVersion: 2, agentId: "other-agent", revision: 1, channels: [] })})`;
		await sql`insert into platform.wecom_setup_sessions (session_id,agent_id,actor_id,configuration_revision,authorization_revision,state_digest,expires_at,status,bot_id) values ('other-agent-replacement','other-agent','other-owner',1,'revision',${"b".repeat(64)},now()+interval '5 minutes','verifying','bot')`;
		await sql`insert into platform.wecom_setup_sessions (session_id,agent_id,actor_id,configuration_revision,authorization_revision,state_digest,expires_at,status,bot_id) values ('other-owner-replacement','agent','other-owner',1,'revision',${"c".repeat(64)},now()+interval '5 minutes','verifying','bot')`;
		const otherAgent = await setup.read("other-agent-replacement");
		const otherOwner = await setup.read("other-owner-replacement");
		if (!otherAgent || !otherOwner) throw new Error("Missing denied sessions");
		expect(
			await setup.claimReplacementProbe(otherAgent, "cross-agent"),
		).toBeNull();
		expect(
			await setup.claimReplacementProbe(otherOwner, "cross-owner"),
		).toBeNull();
		expect(
			await setup.claimReplacementProbe(
				{ ...replacement, agentId: "other-agent" },
				"forged-agent",
			),
		).toBeNull();
		const first = await setup.claimReplacementProbe(replacement, "probe-one");
		if (!first) throw new Error("Missing replacement probe");
		expect(
			await setup.claimReplacementProbe(replacement, "probe-two"),
		).toBeNull();
		await sql`update platform.wecom_setup_sessions set probe_lease_until=now()-interval '1 second' where session_id='replacement'`;
		const second = await setup.claimReplacementProbe(replacement, "probe-two");
		if (!second) throw new Error("Missing replacement probe takeover");
		expect(second.fence).toBeGreaterThan(first.fence);
		expect(await setup.currentReplacementProbe(first)).toBe(false);
		expect(await setup.verifyReplacementProbe(first)).toBe(false);
		await setup.failReplacementProbe(first, "auth_failed");
		expect((await setup.read("replacement"))?.status).toBe("verifying");
		expect(await setup.currentReplacementProbe(second)).toBe(true);
		expect(await setup.verifyReplacementProbe(second)).toBe(true);
		await setup.failReplacementProbe(second, "auth_failed");
		expect((await setup.read("replacement"))?.status).toBe("auth_failed");
		expect(await leases.current(active)).toBe(true);
	} finally {
		await setup.close();
		await leases.close();
		await sql.end();
		await db.stop();
	}
}, 30_000);
