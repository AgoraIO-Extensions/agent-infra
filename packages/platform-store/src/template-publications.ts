import { createHash, randomUUID } from "node:crypto";
import {
	type standardTemplateRegistrationActions,
	type TemplatePublicationBindingV1,
	TemplatePublicationBindingV1Schema,
	type TemplatePublicationLeaseV1,
	TemplatePublicationLeaseV1Schema,
	type TemplatePublicationServiceIdentityV1,
	TemplatePublicationStatusV1Schema,
} from "@agent-infra/contracts/pilot";
import type { TemplateValidationContextV1 } from "@agent-infra/model-catalog";
import {
	parseStandardTemplateReleaseTargetV1,
	type StandardTemplateReleaseTargetV1,
} from "@agent-infra/platform-core";
import postgres from "./observed-postgres.js";

export class TemplatePublicationStoreError extends Error {
	constructor(
		readonly code:
			| "conflict"
			| "unavailable"
			| "not_authorized" = "unavailable",
	) {
		super("Template publication unavailable");
	}
}

export type SingleAgentReleaseRegistrationV1 = {
	readonly schemaVersion: 1;
	readonly scope: "single-agent";
	readonly target: StandardTemplateReleaseTargetV1;
	readonly operatorId: string;
	readonly deploymentRevision: string;
	readonly expiresAtMs?: number;
	readonly candidate: {
		readonly validationContext: TemplateValidationContextV1;
		readonly configurationRevision: string;
		readonly modelId: string;
		readonly catalogPublication: {
			readonly publicationId: string;
			readonly revision: number;
		} | null;
		readonly catalogReadinessRevision: string;
		readonly adoptedReadinessRevision: string;
	};
};

export class PostgresTemplatePublicationsV1 {
	readonly sql;
	constructor(input: { databaseUrl: string }) {
		this.sql = postgres(input.databaseUrl, { max: 2 });
	}
	async close() {
		await this.sql.end();
	}
	async agentRegistration(
		action: (typeof standardTemplateRegistrationActions)[number],
		registration: SingleAgentReleaseRegistrationV1,
		stillAuthorized: () => Promise<boolean>,
		metadata: { readonly traceId: string; readonly requestId: string },
	) {
		const target = parseStandardTemplateReleaseTargetV1(registration.target);
		const { releaseId, agentId, templateId } = target;
		const operator = registration.operatorId;
		const json = JSON.stringify(registration);
		const deadline =
			registration.expiresAtMs === undefined
				? null
				: new Date(registration.expiresAtMs).toISOString();
		return this.sql.begin(async (sql) => {
			await sql`select pg_advisory_xact_lock(hashtextextended(${`template-publication:${templateId}`},0))`;
			const [row] =
				await sql`select status, binding=${json}::text::jsonb and approved_by=${operator} as matches
				from platform.template_publications where id=${releaseId} for update`;
			if (
				row &&
				(!row.matches || !["prepared", "revoked"].includes(row.status))
			)
				throw new TemplatePublicationStoreError("conflict");
			if (!row && action !== "register")
				throw new TemplatePublicationStoreError("not_authorized");

			let state =
				row?.status === "revoked"
					? ("revoked" as const)
					: ("registered" as const);
			let auditAction: string | undefined;
			if (action === "register") {
				if (state === "revoked")
					throw new TemplatePublicationStoreError("conflict");
				if (!row) {
					const [baseline] =
						await sql`select a.id from platform.agents a join platform.agent_configuration_revisions c
						on c.agent_id=a.id and c.revision=a.current_configuration_revision
						where a.id=${agentId} and a.current_configuration_revision=${target.expectedConfigurationRevision}
						and c.configuration->'source'->>'kind'='standard' and c.configuration->'source'->>'templateId'=${templateId}
						and c.configuration->'source'->>'imageDigest'=${target.expectedImageDigest} for share of a`;
					if (!baseline) throw new TemplatePublicationStoreError("conflict");
					const digest = createHash("sha256").update(json).digest("hex");
					const inserted =
						await sql`insert into platform.template_publications(id,template_id,binding,request_digest,approved_by)
						values(${releaseId},${templateId},${json}::text::jsonb,${digest},${operator}) on conflict do nothing returning id`;
					if (!inserted.length)
						throw new TemplatePublicationStoreError("conflict");
					auditAction = "standard_template.agent_release.registered";
				}
			} else if (action === "revoke-registration" && state === "registered") {
				await sql`update platform.template_publications set status='revoked',updated_at=clock_timestamp() where id=${releaseId}`;
				state = "revoked";
				auditAction = "standard_template.agent_release.revoked";
			}
			if (auditAction)
				await sql`insert into platform.audit_events(id,trace_id,request_id,actor_type,actor_id,action,target_type,target_id,agent_id,outcome)
				values(${randomUUID()},${metadata.traceId},${metadata.requestId},'user',${operator},${auditAction},'template_publication',${releaseId},${agentId},'succeeded')`;
			if (!(await stillAuthorized()))
				throw new TemplatePublicationStoreError("not_authorized");
			if (deadline !== null) {
				const [clock] =
					await sql`select clock_timestamp()<${deadline}::timestamptz as permitted`;
				if (!clock?.permitted)
					throw new TemplatePublicationStoreError("not_authorized");
			}
			const {
				clusterUid,
				namespace,
				namespaceUid,
				installationId,
				sourceCommit,
			} = registration.candidate.validationContext;
			return {
				...target,
				state,
				operatorId: operator,
				installation: installationId,
				clusterUid,
				namespace,
				namespaceUid,
				sourceCommit,
				expiresAt: deadline,
			};
		});
	}
	async confirmAgentWorkerReady(
		target: StandardTemplateReleaseTargetV1,
		candidate: SingleAgentReleaseRegistrationV1["candidate"],
		operator: string | undefined,
		identity: TemplatePublicationServiceIdentityV1,
		proof: {
			readonly ready: boolean;
			readonly validation: unknown;
			readonly catalogBinding: unknown;
		},
	) {
		if (
			!operator ||
			identity.purpose !== "agent_ready" ||
			identity.publicationId !== target.releaseId ||
			identity.deploymentRef !== candidate.validationContext.installationId
		)
			return null;
		const receipt = {
			identity,
			ready: proof.ready,
			catalogBinding: proof.catalogBinding,
			validation: proof.validation,
		};
		return this.sql.begin(async (sql) => {
			const [registered] =
				await sql`select p.id, exists(select 1 from platform.template_publication_targets t where t.publication_id=p.id and t.status='applied') as committed
				from platform.template_publications p where p.id=${target.releaseId} and p.template_id=${target.templateId} and p.status='prepared' and p.approved_by=${operator}
				and p.binding->>'scope'='single-agent' and p.binding->'target'=${JSON.stringify(target)}::text::jsonb
				and p.binding->'candidate'=${JSON.stringify(candidate)}::text::jsonb
				and (not (p.binding ? 'expiresAtMs') or to_timestamp((p.binding->>'expiresAtMs')::double precision/1000)>clock_timestamp())
				and ${identity.expiresAt}::timestamptz>clock_timestamp() for update of p`;
			if (!registered) return null;
			if (registered.committed) return "committed" as const;
			const rows =
				await sql`update platform.template_publications set worker_ready=${proof.ready},worker_receipt=${JSON.stringify(receipt)}::text::jsonb,updated_at=clock_timestamp()
				where id=${target.releaseId} and (worker_receipt is null or (worker_receipt->'identity'->>'issuedAt')::timestamptz<${identity.issuedAt}::timestamptz
				or ((worker_receipt->'identity'->>'issuedAt')::timestamptz=${identity.issuedAt}::timestamptz and not ${proof.ready})) returning id`;
			return rows.length ? ("recorded" as const) : null;
		});
	}

	async consumeNonce(identity: TemplatePublicationServiceIdentityV1) {
		const rows = await this
			.sql`insert into platform.template_publication_nonces(id,publication_id,expires_at)
			values(${identity.requestRef},${identity.publicationId},${identity.expiresAt}) on conflict do nothing returning id`;
		await this.sql`delete from platform.template_publication_nonces where id in
			(select id from platform.template_publication_nonces where expires_at<clock_timestamp() order by expires_at limit 256)`;
		return rows.length === 1;
	}

	async prepare(
		bindingInput: TemplatePublicationBindingV1,
		approvedBy: string,
	) {
		const binding = TemplatePublicationBindingV1Schema.parse(bindingInput);
		const requestDigest = createHash("sha256")
			.update(JSON.stringify({ binding, approvedBy }))
			.digest("hex");
		await this.sql.begin(async (sql) => {
			await sql`select pg_advisory_xact_lock(hashtextextended(${`template-publication:${binding.templateId}`},0))`;
			const [existing] =
				await sql`select request_digest from platform.template_publications where id=${binding.publicationId}`;
			if (existing) {
				if (existing.request_digest !== requestDigest)
					throw new TemplatePublicationStoreError("conflict");
				return;
			}
			await sql`insert into platform.template_publications(id,template_id,binding,request_digest,approved_by)
				values(${binding.publicationId},${binding.templateId},${sql.json(binding)},${requestDigest},${approvedBy})`;
			await sql`insert into platform.audit_events(id,trace_id,actor_type,actor_id,action,target_type,target_id,outcome,details)
				values(${randomUUID()},${binding.publicationId},'user',${approvedBy},'standard_template.publication.prepared',
				'template_publication',${binding.publicationId},'succeeded',${sql.json({ authorizationRevision: binding.authorizationRevision, templateId: binding.templateId, targetImageDigest: binding.targetImageDigest })})`;
		});
		return this.read(binding.publicationId);
	}

	async binding(publicationId: string) {
		const [row] = await this
			.sql`select binding,approved_by,status from platform.template_publications where id=${publicationId}`;
		if (!row) throw new TemplatePublicationStoreError();
		return {
			binding: TemplatePublicationBindingV1Schema.parse(row.binding),
			approvedBy: String(row.approved_by),
			status: String(row.status),
		};
	}

	async ready(binding: TemplatePublicationBindingV1) {
		const updated = await this
			.sql`update platform.template_publications set worker_ready=true,updated_at=clock_timestamp()
			where id=${binding.publicationId} and binding=${this.sql.json(binding)} and status='prepared' returning id`;
		if (!updated.length) throw new TemplatePublicationStoreError("conflict");
		return this.read(binding.publicationId);
	}

	async activate(binding: TemplatePublicationBindingV1) {
		await this.sql.begin(async (sql) => {
			await sql`select pg_advisory_xact_lock(hashtextextended(${`template-publication:${binding.templateId}`},0))`;
			const [row] =
				await sql`select status,worker_ready,binding from platform.template_publications where id=${binding.publicationId} for update`;
			if (
				!row ||
				JSON.stringify(
					TemplatePublicationBindingV1Schema.parse(row.binding),
				) !== JSON.stringify(binding)
			)
				throw new TemplatePublicationStoreError("conflict");
			if (["active", "partial", "completed"].includes(row.status)) return;
			if (row.status !== "prepared" || !row.worker_ready)
				throw new TemplatePublicationStoreError("conflict");
			const [current] =
				await sql`select publication_id,revision from platform.template_publication_catalog where template_id=${binding.templateId}`;
			if (
				(current?.publication_id ?? null) !==
				binding.expectedPreviousPublicationId
			)
				throw new TemplatePublicationStoreError("conflict");
			if (current) {
				await sql`update platform.template_publications set status='superseded',updated_at=clock_timestamp() where id=${current.publication_id}`;
				await sql`update platform.template_publication_catalog set publication_id=${binding.publicationId},revision=revision+1 where template_id=${binding.templateId}`;
			} else
				await sql`insert into platform.template_publication_catalog(template_id,publication_id,revision) values(${binding.templateId},${binding.publicationId},1)`;
			await sql`update platform.template_publications set status='active',updated_at=clock_timestamp() where id=${binding.publicationId}`;
			await sql`insert into platform.outbox_items(id,scope_type,scope_id,operation,payload,trace_id)
				values(${`publication-${binding.publicationId}`},'template_publication',${binding.publicationId},'standard_template.publish.v1',${sql.json({ schemaVersion: 1, publicationId: binding.publicationId })},${binding.publicationId})`;
			await sql`insert into platform.audit_events(id,trace_id,actor_type,actor_id,action,target_type,target_id,outcome,details)
				values(${randomUUID()},${binding.publicationId},'service',${binding.servicePrincipalRef},'standard_template.publication.activated','template_publication',${binding.publicationId},'succeeded',${sql.json({ authorizationRevision: binding.authorizationRevision })})`;
		});
		return this.read(binding.publicationId);
	}

	async revoke(binding: TemplatePublicationBindingV1, actorId: string) {
		await this.sql.begin(async (sql) => {
			await sql`select pg_advisory_xact_lock(hashtextextended(${`template-publication:${binding.templateId}`},0))`;
			const revoked =
				await sql`update platform.template_publications set status='revoked',updated_at=clock_timestamp()
				where id=${binding.publicationId} and template_id=${binding.templateId} and binding->>'deploymentRef'=${binding.deploymentRef}
				and binding->>'publicationId'=${binding.publicationId} and not (binding ? 'scope') returning id`;
			if (!revoked.length) throw new TemplatePublicationStoreError("conflict");
			await sql`insert into platform.audit_events(id,trace_id,actor_type,actor_id,action,target_type,target_id,outcome)
				values(${randomUUID()},${binding.publicationId},'user',${actorId},'standard_template.publication.revoked','template_publication',${binding.publicationId},'succeeded')`;
		});
		return this.read(binding.publicationId);
	}

	async read(publicationId: string, cursor = "") {
		const [row] = await this
			.sql`select status from platform.template_publications where id=${publicationId}`;
		if (!row) throw new TemplatePublicationStoreError();
		const totals = await this
			.sql`select status,count(*)::int as count from (select distinct on (agent_id) status from platform.template_publication_targets where publication_id=${publicationId} order by agent_id,attempt desc) latest group by status`;
		const counts = { pending: 0, unknown: 0, applied: 0, rejected: 0 };
		for (const total of totals) {
			if (Object.hasOwn(counts, total.status))
				counts[total.status as keyof typeof counts] = total.count;
		}
		const rows = await this
			.sql`select id,batch_ref,agent_id,attempt,status,configuration_revision,error_code from platform.template_publication_targets
			where publication_id=${publicationId} and id>${cursor} order by id limit 257`;
		return TemplatePublicationStatusV1Schema.parse({
			schemaVersion: 1,
			publicationId,
			status: row.status,
			counts,
			targets: rows.slice(0, 256).map((target) => ({
				batchRef: target.batch_ref,
				attempt: Number(target.attempt),
				targetRef: target.id,
				agentId: target.agent_id,
				status: target.status,
				configurationRevision:
					target.configuration_revision === null
						? null
						: Number(target.configuration_revision),
				errorCode: target.error_code,
			})),
			nextCursor: rows.length > 256 ? rows[255]?.id : null,
		});
	}

	async batch(
		binding: TemplatePublicationBindingV1,
		leaseInput: TemplatePublicationLeaseV1,
	) {
		const lease = TemplatePublicationLeaseV1Schema.parse(leaseInput);
		return this.sql.begin(async (sql) => {
			await sql`select pg_advisory_xact_lock_shared(hashtextextended(${`template-publication:${binding.templateId}`},0))`;
			const [publication] =
				await sql`select p.* from platform.template_publications p join platform.template_publication_catalog c on c.publication_id=p.id
				where p.id=${binding.publicationId} and p.status in ('active','partial','completed') and p.binding=${sql.json(binding)}
				and (p.binding->>'expiresAt')::timestamptz>clock_timestamp() for update of p`;
			if (!publication)
				throw new TemplatePublicationStoreError("not_authorized");
			const [owned] =
				await sql`select id from platform.outbox_items where id=${lease.itemId} and scope_type='template_publication' and scope_id=${binding.publicationId}
				and operation='standard_template.publish.v1' and status='processing' and lease_owner=${lease.leaseOwner}
				and delivery_fence=${lease.deliveryFence}::bigint and lease_expires_at>clock_timestamp() for update`;
			if (!owned) throw new TemplatePublicationStoreError("not_authorized");
			if (publication.status === "completed") return [];
			// Only a durable, determinate CAS refusal permits a linked new target/key.
			const rebases =
				await sql`select t.agent_id,t.batch_ref,t.attempt,c.revision,c.configuration->'source'->>'imageDigest' as digest
				from platform.template_publication_targets t join platform.agents a on a.id=t.agent_id
				join platform.agent_configuration_revisions c on c.agent_id=a.id and c.revision=a.current_configuration_revision
				where t.publication_id=${binding.publicationId} and t.agent_id not in (select agent_id from platform.scoped_agents_for_template_publication(${binding.publicationId}))
				and t.status='rejected' and t.error_code='stale_revision' and t.attempt<2147483647
				and not exists(select 1 from platform.template_publication_targets newer where newer.publication_id=t.publication_id and newer.agent_id=t.agent_id and newer.attempt>t.attempt)
				and c.revision<>(t.target->>'expectedConfigurationRevision')::bigint
				and c.configuration->'source'->>'kind'='standard' and c.configuration->'source'->>'templateId'=${binding.templateId}
				and c.configuration->'source'->>'imageDigest'<>${binding.targetImageDigest} order by t.agent_id limit 256`;
			const retryBatches = new Map<string, string>();
			for (const row of rebases) {
				const attempt = Number(row.attempt) + 1;
				const id = `target-${createHash("sha256").update(`${binding.publicationId}:${row.agent_id}:${attempt}`).digest("hex")}`;
				const target = parseStandardTemplateReleaseTargetV1({
					schemaVersion: 1,
					releaseId: binding.publicationId,
					agentId: row.agent_id,
					templateId: binding.templateId,
					expectedConfigurationRevision: Number(row.revision),
					expectedImageDigest: row.digest,
					targetImageDigest: binding.targetImageDigest,
				});
				const previous = `${row.batch_ref}:${attempt}`;
				const batchRef = retryBatches.get(previous) ?? `batch-${randomUUID()}`;
				retryBatches.set(previous, batchRef);
				await sql`insert into platform.template_publication_targets(id,publication_id,batch_ref,agent_id,attempt,target) values(${id},${binding.publicationId},${batchRef},${row.agent_id},${attempt},${sql.json({ ...target })})`;
			}
			let targets =
				await sql`select id,batch_ref,target,attempt from platform.template_publication_targets where publication_id=${binding.publicationId}
				and agent_id not in (select agent_id from platform.scoped_agents_for_template_publication(${binding.publicationId}))
				and status in ('pending','unknown') order by id limit 256`;
			if (!targets.length) {
				const cursor = publication.cursor
					? JSON.parse(String(publication.cursor))
					: null;
				if (
					cursor &&
					(typeof cursor.digest !== "string" ||
						typeof cursor.agentId !== "string")
				)
					throw new TemplatePublicationStoreError();
				const candidates =
					await sql`select a.id,c.revision,c.configuration->'source'->>'imageDigest' as digest
					from platform.agents a join platform.agent_configuration_revisions c on c.agent_id=a.id and c.revision=a.current_configuration_revision
					where c.configuration->'source'->>'kind'='standard' and c.configuration->'source'->>'templateId'=${binding.templateId}
					and c.configuration->'source'->>'imageDigest'<>${binding.targetImageDigest}
					and a.id not in (select agent_id from platform.scoped_agents_for_template_publication(${binding.publicationId}))
					and (${cursor === null} or (c.configuration->'source'->>'imageDigest',a.id)>(${cursor?.digest ?? ""},${cursor?.agentId ?? ""}))
					and not exists(select 1 from platform.template_publication_targets t where t.publication_id=${binding.publicationId} and t.agent_id=a.id)
					order by c.configuration->'source'->>'imageDigest',a.id limit 256`;
				const firstDigest = candidates[0]?.digest;
				const batchRef = `batch-${randomUUID()}`;
				for (const candidate of candidates.filter(
					(item) => item.digest === firstDigest,
				)) {
					const id = `target-${createHash("sha256").update(`${binding.publicationId}:${candidate.id}:1`).digest("hex")}`;
					const target = parseStandardTemplateReleaseTargetV1({
						schemaVersion: 1,
						releaseId: binding.publicationId,
						agentId: candidate.id,
						templateId: binding.templateId,
						expectedConfigurationRevision: Number(candidate.revision),
						expectedImageDigest: candidate.digest,
						targetImageDigest: binding.targetImageDigest,
					});
					await sql`insert into platform.template_publication_targets(id,publication_id,batch_ref,agent_id,target) values(${id},${binding.publicationId},${batchRef},${candidate.id},${sql.json({ ...target })})`;
				}
				const last = candidates
					.filter((item) => item.digest === firstDigest)
					.at(-1);
				if (last)
					await sql`update platform.template_publications set cursor=${JSON.stringify({ digest: last.digest, agentId: last.id })},updated_at=clock_timestamp() where id=${binding.publicationId}`;
				targets =
					await sql`select id,batch_ref,target,attempt from platform.template_publication_targets where publication_id=${binding.publicationId} and status='pending' and agent_id not in (select agent_id from platform.scoped_agents_for_template_publication(${binding.publicationId})) order by id limit 256`;
			}
			// A batch is one old digest so the original bounded V2 fan-out remains authoritative.
			const parsed = targets.map((row) => ({
				batchRef: String(row.batch_ref),
				targetRef: String(row.id),
				target: parseStandardTemplateReleaseTargetV1(row.target),
				attempt: Number(row.attempt),
			}));
			const batch = parsed.filter(
				(row) =>
					row.target.expectedImageDigest ===
						parsed[0]?.target.expectedImageDigest &&
					row.attempt === parsed[0]?.attempt &&
					row.batchRef === parsed[0]?.batchRef,
			);
			for (const row of batch)
				await sql`update platform.template_publication_targets set status='unknown',updated_at=clock_timestamp() where id=${row.targetRef} and status in ('pending','unknown')`;
			return batch;
		});
	}

	async target(publicationId: string, agentId: string) {
		const [row] = await this
			.sql`select id,target,status from platform.template_publication_targets where publication_id=${publicationId} and agent_id=${agentId} order by attempt desc limit 1`;
		if (!row) throw new TemplatePublicationStoreError();
		return {
			targetRef: String(row.id),
			target: parseStandardTemplateReleaseTargetV1(row.target),
			status: String(row.status),
		};
	}

	async rejected(
		targetRef: string,
		errorCode: string,
		lease: TemplatePublicationLeaseV1,
	) {
		// These are determinate pre-commit Core refusals. Dependency/transport failures stay unknown.
		const rejected = [
			"not_admitted",
			"invalid_command",
			"stale_revision",
			"idempotency_conflict",
		].includes(errorCode);
		await this
			.sql`update platform.template_publication_targets t set status=${rejected ? "rejected" : "unknown"},error_code=${errorCode},updated_at=clock_timestamp()
			where t.id=${targetRef} and t.status='unknown' and exists(select 1 from platform.outbox_items o
			where o.id=${lease.itemId} and o.scope_id=t.publication_id and o.scope_type='template_publication' and o.status='processing'
			and o.lease_owner=${lease.leaseOwner} and o.delivery_fence=${lease.deliveryFence}::bigint and o.lease_expires_at>clock_timestamp())`;
	}

	async finish(
		binding: TemplatePublicationBindingV1,
		lease: TemplatePublicationLeaseV1,
	) {
		await this.sql.begin(async (sql) => {
			await sql`select pg_advisory_xact_lock_shared(hashtextextended(${`template-publication:${binding.templateId}`},0))`;
			const [owned] =
				await sql`select p.id,p.status from platform.template_publications p join platform.template_publication_catalog c on c.publication_id=p.id
				join platform.outbox_items o on o.scope_id=p.id and o.scope_type='template_publication'
				where p.id=${binding.publicationId} and p.status in ('active','partial','completed') and o.id=${lease.itemId} and o.status='processing'
				and o.lease_owner=${lease.leaseOwner} and o.delivery_fence=${lease.deliveryFence}::bigint and o.lease_expires_at>clock_timestamp() for update of p,o`;
			if (!owned) throw new TemplatePublicationStoreError("not_authorized");
			if (owned.status === "completed") return;
			const [remaining] =
				await sql`select exists(select 1 from platform.agents a join platform.agent_configuration_revisions c on c.agent_id=a.id and c.revision=a.current_configuration_revision
				where c.configuration->'source'->>'kind'='standard' and c.configuration->'source'->>'templateId'=${binding.templateId}
				and a.id not in (select agent_id from platform.scoped_agents_for_template_publication(${binding.publicationId}))
				and c.configuration->'source'->>'imageDigest'<>${binding.targetImageDigest} and not exists(select 1 from platform.template_publication_targets t where t.publication_id=${binding.publicationId} and t.agent_id=a.id)) as missing,
				exists(select 1 from platform.template_publication_targets t where t.publication_id=${binding.publicationId} and t.status<>'applied' and t.agent_id not in (select agent_id from platform.scoped_agents_for_template_publication(${binding.publicationId})) and not exists(select 1 from platform.template_publication_targets newer where newer.publication_id=t.publication_id and newer.agent_id=t.agent_id and newer.attempt>t.attempt)) as unresolved`;
			const status = remaining?.missing
				? "active"
				: remaining?.unresolved
					? "partial"
					: "completed";
			await sql`update platform.template_publications set status=${status},discovery_complete=${!remaining?.missing},updated_at=clock_timestamp() where id=${binding.publicationId}`;
		});
		return this.read(binding.publicationId);
	}
}
