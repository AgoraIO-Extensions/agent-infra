import { randomUUID } from "node:crypto";
import type { JSONValue, TransactionSql } from "postgres";
import postgres from "./observed-postgres.js";

type Actor = { actorId: string; traceId: string };
export class ExternalServiceConflict extends Error {}
type Version = {
	id: string;
	revision: number;
	url: string;
	credential: unknown;
};
type Summary = {
	id: string;
	revision: number;
	active: number | null;
	verified: number | null;
	url: string;
	activeUrl: string | null;
	modelEndpointId: string | null;
};

async function audit(
	tx: TransactionSql,
	actor: Actor,
	id: string,
	revision: number,
	action: string,
	ok: boolean,
) {
	await tx`insert into platform.audit_events (id,trace_id,actor_type,actor_id,action,target_type,target_id,outcome,details)
 values(${randomUUID()},${actor.traceId},'user',${actor.actorId},${`external_service.${action}`},'configuration',${id},${ok ? "succeeded" : "rejected"},${tx.json({ revision })})`;
}

export class ExternalServiceStore {
	private readonly sql;
	constructor(databaseUrl: string) {
		this.sql = postgres(databaseUrl, { max: 2 });
	}
	close() {
		return this.sql.end();
	}
	async view() {
		const services = await this.sql<
			Summary[]
		>`select s.id,s.revision,s.active,s.verified,s.model_endpoint_id as "modelEndpointId",c.url, a.url as "activeUrl" from platform.external_services s join platform.external_service_versions c on (c.id,c.revision)=(s.id,s.revision) left join platform.external_service_versions a on (a.id,a.revision)=(s.id,s.active) order by s.id`;
		const history = await this.sql<
			{
				actor: string;
				action: string;
				id: string;
				revision: number;
				outcome: string;
				time: string;
			}[]
		>`select actor_id as actor,action,target_id as id,(details->>'revision')::integer as revision,outcome,occurred_at::text as time from platform.audit_events where action like 'external\\_service.%' order by occurred_at desc,id desc limit 50`;
		return { services, history };
	}
	async candidate(
		id: string,
		expected: number,
		url: string,
		encrypt: (revision: number) => unknown,
		actor: Actor,
		modelEndpointId: string | null = null,
	) {
		return this.sql.begin(async (tx) => {
			await tx`insert into platform.external_services(id,model_endpoint_id) values(${id},${modelEndpointId}) on conflict do nothing`;
			const [next] = await tx<
				{ revision: number }[]
			>`update platform.external_services set revision=revision+1,verified=null where id=${id} and revision=${expected} and model_endpoint_id is not distinct from ${modelEndpointId} returning revision`;
			if (!next) throw new ExternalServiceConflict();
			await tx`insert into platform.external_service_versions(id,revision,url,credential) values(${id},${next.revision},${url},${tx.json(encrypt(next.revision) as JSONValue)})`;
			await audit(tx, actor, id, next.revision, "candidate", true);
			return next.revision;
		});
	}
	async version(id: string, revision: number) {
		const [version] = await this.sql<
			Version[]
		>`select * from platform.external_service_versions where id=${id} and revision=${revision}`;
		return version ?? null;
	}
	async activeRevision(id: string) {
		const [row] = await this.sql<
			{ active: number | null }[]
		>`select active from platform.external_services where id=${id}`;
		return row?.active ?? null;
	}
	async active(id: string) {
		const [version] = await this.sql<
			Version[]
		>`select v.* from platform.external_services s join platform.external_service_versions v on (v.id,v.revision)=(s.id,s.active) where s.id=${id}`;
		return version ?? null;
	}
	async tested(id: string, revision: number, ok: boolean, actor: Actor) {
		return this.sql.begin(async (tx) => {
			const result =
				await tx`update platform.external_services set verified=${ok ? revision : null} where id=${id} and revision=${revision}`;
			if (!result.count) throw new ExternalServiceConflict();
			await audit(tx, actor, id, revision, "test", ok);
			return true;
		});
	}
	async change(
		id: string,
		revision: number,
		action: "enable" | "disable",
		actor: Actor,
	) {
		await this.sql.begin(async (tx) => {
			const changed =
				await tx`update platform.external_services set enabled_once=enabled_once or ${action}='enable',active=${action === "enable" ? revision : null}
    where id=${id} and revision=${revision} and (${action}='disable' or verified=${revision}) returning id`;
			if (!changed.length) throw new ExternalServiceConflict();
			await audit(tx, actor, id, revision, action, true);
		});
	}
	async denied(actor: Actor) {
		await this.sql.begin((tx) =>
			audit(tx, actor, "external-services", 0, "access", false),
		);
	}
}
