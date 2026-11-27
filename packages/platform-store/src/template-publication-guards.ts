import type {
	AgentConfigurationRecord,
	AgentConfigurationWritePlanV1,
} from "@agent-infra/platform-core";
import { sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";

type Transaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];

export class TemplateCatalogSourceConflict extends Error {
	constructor() {
		super("TEMPLATE_CATALOG_REVISION_CONFLICT");
	}
}

/** Shared before Agent locks; activation/revocation take the exclusive lock first. */
export async function lockTemplatePublicationV1(
	transaction: Transaction,
	source: AgentConfigurationRecord["source"],
) {
	if (source.kind === "standard")
		await transaction.execute(
			sql`select pg_advisory_xact_lock_shared(hashtextextended(${`template-publication:${source.templateId}`},0))`,
		);
}

export async function assertTemplatePublicationSourceV1(
	transaction: Transaction,
	configuration: AgentConfigurationRecord,
) {
	if (configuration.source.kind !== "standard") return;
	const [row] = await transaction.execute(
		sql`select platform.permits_template_publication_source(${configuration.agentId},${configuration.revision}::bigint,${JSON.stringify(configuration)}::text::jsonb) as allowed`,
	);
	if (row?.allowed !== true) throw new TemplateCatalogSourceConflict();
}

/** Reserve an authenticated release's one configuration transition in the same transaction as the revision. */
export async function recordRegisteredAgentSourceV1(
	transaction: Transaction,
	plan: AgentConfigurationWritePlanV1,
	previous: AgentConfigurationRecord,
	assertCurrentOperator: () => Promise<void>,
) {
	const stamp = plan.manualRelease;
	const source = plan.configuration.source;
	if (
		!stamp ||
		source.kind !== "standard" ||
		previous.source.kind !== "standard"
	)
		return;
	if (
		plan.accessUpdate ||
		plan.skillBindings ||
		plan.automaticPublication ||
		plan.result.changedFields.length !== 1 ||
		plan.result.changedFields[0] !== "source" ||
		!plan.outboxIntent ||
		plan.nextRevision !== plan.baseRevision + 1
	)
		throw new TemplateCatalogSourceConflict();
	const [catalog] =
		await transaction.execute(sql`select c.publication_id,c.revision,p.binding->>'targetImageDigest' as digest
		from platform.template_publication_catalog c join platform.template_publications p on p.id=c.publication_id where c.template_id=${source.templateId}`);
	const [registration] = await transaction.execute(
		sql`select id from platform.template_publications where id=${stamp.releaseId} and binding->>'scope'='single-agent' for update`,
	);
	if (!registration) {
		if (catalog && catalog.digest !== source.imageDigest)
			throw new TemplateCatalogSourceConflict();
		return;
	}
	await assertCurrentOperator();
	const catalogPosition = catalog
		? {
				publicationId: catalog.publication_id,
				revision: Number(catalog.revision),
			}
		: null;
	const [consumed] =
		await transaction.execute(sql`insert into platform.template_publication_targets(id,publication_id,batch_ref,agent_id,target,status,configuration_revision)
		select ${"single-agent-" + stamp.releaseId},p.id,p.id,${plan.agentId},jsonb_build_object(
			'source',${JSON.stringify(source)}::text::jsonb,'workerReceipt',p.worker_receipt,'configurationHash',encode(sha256(convert_to((${JSON.stringify(plan.configuration)}::text::jsonb)::text,'UTF8')),'hex')),
			'applied',${plan.nextRevision}::bigint from platform.template_publications p
		where p.id=${stamp.releaseId} and p.status='prepared' and p.worker_ready and (p.worker_receipt->'identity'->>'expiresAt')::timestamptz>clock_timestamp() and p.approved_by=${plan.auditEvent.actorId}
		and p.template_id=${source.templateId} and p.binding->>'scope'='single-agent' and p.binding->>'deploymentRevision'=${stamp.deploymentRevision}
		and p.binding->'target'->>'agentId'=${plan.agentId} and p.binding->'target'->>'releaseId'=p.id
		and p.binding->'target'->>'templateId'=p.template_id and p.binding->'target'->>'targetImageDigest'=${source.imageDigest}
		and p.binding->'target'->>'expectedImageDigest'=${previous.source.imageDigest} and (p.binding->'target'->>'expectedConfigurationRevision')::bigint=${plan.baseRevision}
		and p.binding->'candidate'->'catalogPublication'=${JSON.stringify(catalogPosition)}::text::jsonb
		and (not(p.binding ? 'expiresAtMs') or to_timestamp((p.binding->>'expiresAtMs')::double precision/1000)>clock_timestamp())
		on conflict do nothing returning id`);
	if (!consumed) throw new TemplateCatalogSourceConflict();
}

export async function assertAutomaticTemplatePublicationCommitV1(
	transaction: Transaction,
	plan: AgentConfigurationWritePlanV1,
) {
	const stamp = plan.automaticPublication;
	if (!stamp) return;
	if (
		plan.configuration.source.kind !== "standard" ||
		plan.result.changedFields.length !== 1 ||
		plan.result.changedFields[0] !== "source" ||
		plan.auditEvent.actorId !== stamp.servicePrincipalRef ||
		plan.accessUpdate !== null
	)
		throw new Error("TEMPLATE_PUBLICATION_COMMIT_REJECTED");
	const rows =
		await transaction.execute(sql`select p.id from platform.template_publications p
		join platform.template_publication_catalog c on c.publication_id=p.id and c.template_id=p.template_id
		join platform.template_publication_targets t on t.publication_id=p.id
		join platform.outbox_items o on o.scope_id=p.id and o.scope_type='template_publication' and o.operation='standard_template.publish.v1'
		where p.id=${stamp.publicationId} and p.status in ('active','partial')
		and p.approved_by=${stamp.approvedBy} and p.binding->>'authorizationRevision'=${stamp.authorizationRevision}
		and p.binding->>'servicePrincipalRef'=${stamp.servicePrincipalRef}
		and (p.binding->>'expiresAt')::timestamptz>clock_timestamp()
		and p.template_id=${plan.configuration.source.templateId} and p.binding->>'targetImageDigest'=${plan.configuration.source.imageDigest}
		and t.id=${stamp.targetRef} and t.batch_ref=${stamp.batchRef} and t.agent_id=${plan.agentId} and t.status='unknown'
		and (t.target->>'expectedConfigurationRevision')::bigint=${plan.baseRevision}
		and o.id=${stamp.lease.itemId} and o.status='processing' and o.lease_owner=${stamp.lease.leaseOwner}
		and o.delivery_fence=${stamp.lease.deliveryFence}::bigint and o.lease_expires_at>clock_timestamp()
		for share of p,c,o for update of t`);
	if (rows.length !== 1)
		throw new Error("TEMPLATE_PUBLICATION_COMMIT_REJECTED");
}

export async function recordAutomaticTemplatePublicationResultV1(
	transaction: Transaction,
	plan: AgentConfigurationWritePlanV1,
) {
	if (!plan.automaticPublication) return;
	await transaction.execute(sql`update platform.template_publication_targets set status='applied',configuration_revision=${plan.nextRevision},
		error_code=null,updated_at=clock_timestamp() where id=${plan.automaticPublication.targetRef} and status='unknown'`);
}
