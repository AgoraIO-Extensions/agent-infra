import postgres from "postgres";
import { expect, it } from "vitest";
import { migratePlatformDatabase } from "./migrate.js";
import { startPostgresTestDatabase } from "./postgres-test.js";
import { PostgresWecomSetupV1 } from "./wecom-setup.js";

it("records callback verification once and rolls back the timestamp when audit fails", async () => {
	const db = await startPostgresTestDatabase("wecom-callback-audit");
	const sql = postgres(db.databaseUrl);
	const store = new PostgresWecomSetupV1(db);
	try {
		await migratePlatformDatabase(db);
		await sql`insert into platform.agents (id,current_configuration_revision,authorization_revision) values ('agent',1,'authority')`;
		await sql`insert into platform.agent_owners (agent_id,owner_id,created_at) values ('agent','owner',now())`;
		await sql`insert into platform.wecom_setup_sessions (session_id,agent_id,actor_id,configuration_revision,authorization_revision,state_digest,expires_at,status,kind) values ('setup-1','agent','owner',1,'authority','digest',now()+interval '5 minutes','verifying','wecom_app'),('setup-2','agent','owner',1,'authority','digest',now()+interval '5 minutes','verifying','wecom_app')`;
		expect(await store.verifyCallback("setup-1")).toBe(true);
		const [verified] = await sql<
			{ callback_verified_at: Date }[]
		>`select callback_verified_at from platform.wecom_setup_sessions where session_id='setup-1'`;
		expect(verified?.callback_verified_at).toBeInstanceOf(Date);
		expect(await store.verifyCallback("setup-1")).toBe(true);
		const [unchanged] = await sql<
			{ callback_verified_at: Date }[]
		>`select callback_verified_at from platform.wecom_setup_sessions where session_id='setup-1'`;
		expect(unchanged?.callback_verified_at).toEqual(
			verified?.callback_verified_at,
		);
		expect(
			await sql`select actor_type,actor_id,action,agent_id,details from platform.audit_events where request_id='setup-1'`,
		).toEqual([
			{
				actor_type: "system",
				actor_id: "platform-api",
				action: "wecom.callback_verified",
				agent_id: "agent",
				details: null,
			},
		]);
		await sql`create function platform.reject_callback_audit() returns trigger language plpgsql as $$ begin if new.action='wecom.callback_verified' then raise exception 'blocked audit'; end if; return new; end $$`;
		await sql`create trigger reject_callback_audit before insert on platform.audit_events for each row execute function platform.reject_callback_audit()`;
		await expect(store.verifyCallback("setup-2")).rejects.toThrow(
			"blocked audit",
		);
		const [rolledBack] = await sql<
			{ callback_verified_at: Date | null }[]
		>`select callback_verified_at from platform.wecom_setup_sessions where session_id='setup-2'`;
		expect(rolledBack?.callback_verified_at).toBeNull();
	} finally {
		await store.close();
		await sql.end();
		await db.stop();
	}
});
