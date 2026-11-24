import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
	type ExternalServiceCommand,
	ExternalServiceReceipt,
} from "@agent-infra/contracts/pilot";
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
			// Explicit disable engages admission checks even before the first enable.
			const changed =
				await tx`update platform.external_services set enabled_once=true,active=${action === "enable" ? revision : null}
    where id=${id} and revision=${revision} and (${action}='disable' or verified=${revision}) returning id`;
			if (!changed.length) throw new ExternalServiceConflict();
			await audit(tx, actor, id, revision, action, true);
		});
	}
	async query(
		command: ReturnType<typeof ExternalServiceCommand.parse>,
		actor: Actor,
		signal: AbortSignal,
	) {
		const operationId = randomUUID();
		const inserted = await this
			.sql`insert into platform.external_service_queries(operation_id,instance_id,revision,actor_id,action,expires_at)
    select ${operationId},id,${command.revision},${actor.actorId},${command.action},clock_timestamp()+interval '15 seconds'
    from platform.external_services where id=${command.id} and (case when ${command.action}='test' then revision else active end)=${command.revision} for share`;
		if (!inserted.count) throw new ExternalServiceConflict();
		const deadline = AbortSignal.any([signal, AbortSignal.timeout(14000)]);
		for (;;) {
			await delay(150, undefined, { signal: deadline });
			const [row] = await this.sql<
				{ receipt: unknown }[]
			>`delete from platform.external_service_queries where operation_id=${operationId} and actor_id=${actor.actorId} and receipt is not null returning receipt`;
			if (row) return ExternalServiceReceipt.parse(row.receipt);
		}
	}
	async processQuery(
		run: (
			command: {
				id: string;
				revision: number;
				actorId: string;
				action: string;
			},
			version: Version,
		) => Promise<unknown>,
	) {
		await this.sql.begin(async (tx) => {
			await tx`delete from platform.external_service_queries where expires_at < clock_timestamp()`;
			const [job] = await tx<
				{
					operationId: string;
					id: string;
					actorId: string;
					revision: number;
					action: string;
				}[]
			>`select operation_id as "operationId",instance_id as id,actor_id as "actorId",revision,action from platform.external_service_queries where receipt is null and expires_at>clock_timestamp() order by expires_at limit 1 for update skip locked`;
			if (!job) return;
			// The API identity was resolved when the query was enqueued. Re-check the
			// current Platform authorization under the same per-user fence as disable.
			// Keep the read separate: a waiting transaction must see the writer's commit.
			await tx`select pg_advisory_xact_lock_shared(hashtextextended(${`platform_user_disable:${job.actorId}`},0))`;
			const [disabled] = await tx<{ user_id: string }[]>`
				select user_id from platform.platform_user_disables
				where user_id = ${job.actorId}
			`;
			const [version] = await tx<
				Version[]
			>`select * from platform.external_service_versions where id=${job.id} and revision=${job.revision}`;
			let receipt: unknown = null;
			try {
				if (disabled) throw new Error("EXTERNAL_SERVICE_ACTOR_REVOKED");
				if (!version) throw new Error();
				receipt = ExternalServiceReceipt.parse(await run(job, version));
			} catch {
				receipt = { failed: true };
			}
			await tx`update platform.external_service_queries set receipt=${tx.json(receipt as JSONValue)} where operation_id=${job.operationId}`;
		});
	}
	async denied(actor: Actor) {
		await this.sql.begin((tx) =>
			audit(tx, actor, "external-services", 0, "access", false),
		);
	}
}
