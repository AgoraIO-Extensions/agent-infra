import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
	ExternalRuntimeDirectoryReceipt,
	type ExternalServiceCommand,
	ExternalServiceReceipt,
	type PersonalRuntimeBindingUpdate,
	PersonalRuntimeBindingView,
} from "@agent-infra/contracts/pilot";
import type { JSONValue, TransactionSql } from "postgres";
import postgres from "./observed-postgres.js";

type Actor = { actorId: string; traceId: string };
export class ExternalServiceConflict extends Error {}
export class PersonalRuntimeForbidden extends Error {}
export function isPersonalRuntimeScopeConflict(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	if (
		"constraint_name" in error &&
		error.constraint_name === "personal_runtime_owner_scope"
	)
		return true;
	return (
		error instanceof Error &&
		error.cause !== error &&
		isPersonalRuntimeScopeConflict(error.cause)
	);
}
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
	async tested(
		id: string,
		revision: number,
		ok: boolean,
		actor: Actor,
		runtimeDiscovery?: boolean,
	) {
		return this.sql.begin(async (tx) => {
			const result =
				await tx`update platform.external_services set verified=${ok ? revision : null} where id=${id} and revision=${revision}`;
			if (!result.count) throw new ExternalServiceConflict();
			if (ok && runtimeDiscovery !== undefined)
				await tx`update platform.external_service_versions set runtime_discovery=${runtimeDiscovery} where id=${id} and revision=${revision}`;
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
		return ExternalServiceReceipt.parse(
			await this.enqueueQuery(command, actor, signal),
		);
	}
	async runtimeTargets(
		id: string,
		revision: number,
		actor: Actor,
		signal: AbortSignal,
	) {
		const receipt = ExternalRuntimeDirectoryReceipt.parse(
			await this.enqueueQuery(
				{ action: "targets", id, revision },
				actor,
				signal,
			),
		);
		if (
			receipt.revision !== revision ||
			receipt.directory.instanceId !== id ||
			receipt.directory.subjectId !== actor.actorId
		)
			throw new Error("Invalid runtime directory scope");
		return receipt;
	}
	async personalBinding(agentId: string, actor: Actor) {
		return this.sql.begin((tx) => this.readBinding(tx, agentId, actor));
	}
	private async readBinding(tx: TransactionSql, agentId: string, actor: Actor) {
		const [row] = await tx<{ revision: number; target: unknown }[]>`
			select coalesce(b.revision,0) as revision,
				case when b.target is not null then b.target || jsonb_build_object('serviceId',b.service_id) end as target
			from platform.agent_owners o left join platform.agent_personal_runtime_bindings b on b.agent_id=o.agent_id
			where o.agent_id=${agentId} and o.owner_id=${actor.actorId}
				and (b.owner_id is null or b.owner_id=o.owner_id)
				and not exists(select 1 from platform.platform_user_disables where user_id=o.owner_id)`;
		if (!row) throw new PersonalRuntimeForbidden();
		const services = await tx<{ id: string }[]>`
			select s.id from platform.external_services s join platform.external_service_versions v
			on (v.id,v.revision)=(s.id,s.active) where v.runtime_discovery order by s.id`;
		return PersonalRuntimeBindingView.parse({
			...row,
			services: services.map((item) => item.id),
		});
	}
	async savePersonalBinding(
		agentId: string,
		change: ReturnType<typeof PersonalRuntimeBindingUpdate.parse>,
		actor: Actor,
		signal: AbortSignal,
	) {
		const current = await this.personalBinding(agentId, actor);
		if (current.revision !== change.expectedRevision)
			throw new ExternalServiceConflict();
		const requested = change.target;
		let providerRevision: number | null = null;
		let selection: {
			deviceRef: string;
			runtimeRef: string;
			deviceName: string;
			runtimeName: string;
		} | null = null;
		if (requested) {
			providerRevision = await this.activeRevision(requested.serviceId);
			if (!providerRevision || !current.services.includes(requested.serviceId))
				throw new ExternalServiceConflict();
			const { directory } = await this.runtimeTargets(
				requested.serviceId,
				providerRevision,
				actor,
				signal,
			);
			const device = directory.devices.find(
				(item) => item.ref === requested.deviceRef,
			);
			const runtime = device?.runtimes.find(
				(item) => item.ref === requested.runtimeRef,
			);
			if (!device || !runtime || !runtime.capabilities.includes("execute"))
				throw new PersonalRuntimeForbidden();
			selection = {
				deviceRef: device.ref,
				runtimeRef: runtime.ref,
				deviceName: device.displayName,
				runtimeName: runtime.displayName,
			};
		}
		try {
			return await this.sql.begin(async (tx) => {
				await tx`select pg_advisory_xact_lock_shared(hashtextextended(${`platform_user_disable:${actor.actorId}`},0))`;
				await tx`select id from platform.agents where id=${agentId} for update`;
				const locked = await this.readBinding(tx, agentId, actor);
				if (locked.revision !== change.expectedRevision)
					throw new ExternalServiceConflict();
				if (requested) {
					const [service] =
						await tx`select id from platform.external_services where id=${requested.serviceId} and active=${providerRevision} for share`;
					if (!service) throw new ExternalServiceConflict();
				}
				if (!requested && !locked.target) return locked;
				await tx`insert into platform.agent_personal_runtime_bindings (agent_id,revision,owner_id,service_id,target)
					values (${agentId},${locked.revision + 1},${selection ? actor.actorId : null},${requested?.serviceId ?? null},${selection ? tx.json(selection) : null})
					on conflict (agent_id) do update set revision=excluded.revision, owner_id=excluded.owner_id, service_id=excluded.service_id, target=excluded.target`;
				await tx`insert into platform.audit_events(id,trace_id,agent_id,actor_type,actor_id,action,target_type,target_id,outcome,details)
					values(${randomUUID()},${actor.traceId},${agentId},'user',${actor.actorId},${requested ? "personal_runtime.bind" : "personal_runtime.unbind"},'configuration',${agentId},'succeeded',${tx.json({ revision: locked.revision + 1 })})`;
				return this.readBinding(tx, agentId, actor);
			});
		} catch (error) {
			if (isPersonalRuntimeScopeConflict(error))
				throw new ExternalServiceConflict();
			throw error;
		}
	}
	private async enqueueQuery(
		command: { id: string; revision: number; action: string },
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
			if (row) return row.receipt;
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
			version: Version & { modelEndpointId: string | null },
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
				(Version & { modelEndpointId: string | null })[]
			>`select v.*, s.model_endpoint_id as "modelEndpointId"
			  from platform.external_service_versions v
			  join platform.external_services s on s.id = v.id
			  where v.id = ${job.id} and v.revision = ${job.revision}`;
			let receipt: unknown = null;
			try {
				if (disabled) throw new Error("EXTERNAL_SERVICE_ACTOR_REVOKED");
				if (!version) throw new Error();
				const result = await run(job, version);
				receipt =
					job.action === "targets"
						? ExternalRuntimeDirectoryReceipt.parse(result)
						: ExternalServiceReceipt.parse(result);
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
