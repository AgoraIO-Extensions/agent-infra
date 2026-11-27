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
	source: AgentConfigurationRecord["source"],
) {
	if (source.kind !== "standard") return;
	const rows =
		await transaction.execute(sql`select p.binding->>'targetImageDigest' as digest from platform.template_publication_catalog c
		join platform.template_publications p on p.id=c.publication_id where c.template_id=${source.templateId}`);
	if (rows.length && rows[0]?.digest !== source.imageDigest)
		throw new TemplateCatalogSourceConflict();
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
