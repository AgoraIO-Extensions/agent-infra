import { randomUUID } from "node:crypto";
import type { WecomConnectionFenceV1 } from "@agent-infra/platform-core";
import postgres from "postgres";
export interface WecomConnectionClaimV1 extends WecomConnectionFenceV1 {
	readonly agentId: string;
	readonly bindingReference: string;
	leaseUntil: Date;
}
function admissible(
	sql: postgres.ISql,
	input: { agentId: string; bindingReference: string; botId: string },
) {
	return sql`((c.configuration->'channels' @> ${sql.json([{ kind: "wecom_bot", bindingReference: input.bindingReference }])}::jsonb
 and not exists(select 1 from jsonb_array_elements(c.configuration->'channels') channel where channel->>'kind'='wecom_bot' and channel->>'bindingReference'=${input.bindingReference} and channel->>'enabled'='false')
 and not exists(select 1 from platform.wecom_setup_sessions pending where pending.bot_id=${input.botId} and pending.agent_id=a.id and pending.status='verifying' and pending.expires_at>clock_timestamp() and pending.configuration_revision=a.current_configuration_revision and pending.authorization_revision=a.authorization_revision))
 or exists(select 1 from platform.wecom_setup_sessions candidate where candidate.session_id=${input.bindingReference} and candidate.agent_id=a.id and candidate.bot_id=${input.botId} and candidate.status='verifying' and candidate.expires_at>clock_timestamp() and candidate.configuration_revision=a.current_configuration_revision and candidate.authorization_revision=a.authorization_revision and exists(select 1 from platform.agent_owners o where o.agent_id=a.id and o.owner_id=candidate.actor_id)))`;
}
type Status = "verifying" | "connected" | "disconnected" | "auth_failed";
/** One lease per provider bot, regardless of how many Agents or Workers contend for it. */
export class PostgresWecomConnectionsV1 {
	readonly #sql: ReturnType<typeof postgres>;
	constructor(options: { readonly databaseUrl: string }) {
		this.#sql = postgres(options.databaseUrl, { max: 3 });
	}
	close() {
		return this.#sql.end();
	}
	async claim(
		input: Omit<WecomConnectionClaimV1, "fence" | "leaseUntil">,
	): Promise<WecomConnectionClaimV1 | null> {
		const rows = await this.#sql<{ fence: string; lease_until: Date }[]>`
   insert into platform.wecom_connections (bot_id,agent_id,binding_reference,holder_id,fence,lease_until,status)
   select ${input.botId},a.id,${input.bindingReference},${input.holderId},1,clock_timestamp()+interval '30 seconds','verifying'
   from platform.agents a join platform.agent_configuration_revisions c on c.agent_id=a.id and c.revision=a.current_configuration_revision
   where a.id=${input.agentId} and ${admissible(this.#sql, input)}
   on conflict (bot_id) do update set agent_id=excluded.agent_id,binding_reference=excluded.binding_reference,holder_id=excluded.holder_id,fence=platform.wecom_connections.fence+1,lease_until=excluded.lease_until,status='verifying'
   where platform.wecom_connections.lease_until<=clock_timestamp() and platform.wecom_connections.fence<9007199254740991
   returning fence,lease_until`;
		const row = rows[0];
		return row
			? { ...input, fence: Number(row.fence), leaseUntil: row.lease_until }
			: null;
	}
	async current(claim: WecomConnectionClaimV1): Promise<boolean> {
		const rows = await this.#sql`
   select 1 from platform.wecom_connections w join platform.agents a on a.id=w.agent_id
   join platform.agent_configuration_revisions c on c.agent_id=a.id and c.revision=a.current_configuration_revision
   where w.bot_id=${claim.botId} and w.agent_id=${claim.agentId} and w.binding_reference=${claim.bindingReference} and w.holder_id=${claim.holderId} and w.fence=${claim.fence} and w.lease_until>clock_timestamp()
   and ${admissible(this.#sql, claim)}`;
		return rows.length === 1;
	}
	async renew(claim: WecomConnectionClaimV1): Promise<boolean> {
		const rows = await this.#sql<{ lease_until: Date }[]>`
   update platform.wecom_connections w set lease_until=clock_timestamp()+interval '30 seconds'
   from platform.agents a join platform.agent_configuration_revisions c on c.agent_id=a.id and c.revision=a.current_configuration_revision
   where w.bot_id=${claim.botId} and w.agent_id=${claim.agentId} and w.binding_reference=${claim.bindingReference} and a.id=w.agent_id and w.holder_id=${claim.holderId} and w.fence=${claim.fence} and w.lease_until>clock_timestamp()
   and ${admissible(this.#sql, claim)} returning w.lease_until`;
		if (!rows[0]) return false;
		// This is a local deadline hint; every inbound commit additionally checks DB ownership.
		claim.leaseUntil = rows[0].lease_until;
		return true;
	}
	async status(
		claim: WecomConnectionClaimV1,
		status: Status,
	): Promise<boolean> {
		return this.#sql.begin(async (sql) => {
			const rows = await sql`update platform.wecom_connections w
					set status=${status}
					from platform.agents a
					join platform.agent_configuration_revisions c
						on c.agent_id=a.id and c.revision=a.current_configuration_revision
					where w.bot_id=${claim.botId}
						and w.agent_id=${claim.agentId}
						and w.binding_reference=${claim.bindingReference}
						and a.id=w.agent_id
						and w.holder_id=${claim.holderId}
						and w.fence=${claim.fence}
						and w.lease_until>clock_timestamp()
						and ${admissible(sql, claim)}
						returning w.agent_id`;
			if (!rows.length) return false;
			const eventId = randomUUID();
			await sql`insert into platform.audit_events (id,trace_id,actor_type,actor_id,action,target_type,target_id,outcome,request_id,agent_id,details)
    values (${eventId},${eventId},'system','platform-worker',${`wecom.connection_${status}`},'agent',${claim.agentId},'succeeded',${eventId},${claim.agentId},NULL)`;
			return true;
		});
	}

	async release(claim: WecomConnectionClaimV1) {
		await this
			.#sql`update platform.wecom_connections set lease_until=clock_timestamp(),status=case when status='auth_failed' then status else 'disconnected' end where bot_id=${claim.botId} and holder_id=${claim.holderId} and fence=${claim.fence}`;
	}
}
