import { Buffer } from "node:buffer";
import {
	type CurrentTaskApiUseGrantV1,
	type CurrentTaskApplicationV1,
	parseCurrentTaskApiUseGrantV1,
	parseCurrentTaskApplicationV1,
	parseTaskPrincipalV1,
	type TaskPrincipalV1,
} from "@agent-infra/platform-core";
import type postgres from "postgres";

export class TaskCurrentAuthorityUnavailableErrorV1 extends Error {
	constructor() {
		super("Task current authority is unavailable");
	}
}

function agentId(value: string) {
	if (
		!value ||
		value.includes("\0") ||
		!String.prototype.isWellFormed.call(value) ||
		Buffer.byteLength(value, "utf8") > 1024
	)
		throw new TaskCurrentAuthorityUnavailableErrorV1();
}

async function requireReadCommitted(transaction: postgres.TransactionSql) {
	const [row] = await transaction<
		{ transaction_isolation: string }[]
	>`show transaction_isolation`;
	if (row?.transaction_isolation !== "read committed")
		throw new TaskCurrentAuthorityUnavailableErrorV1();
}

/** Caller-owned current transaction; metadata only, no pool, begin or credentials. */
export async function readCurrentTaskApplicationV1(
	transaction: postgres.TransactionSql,
	input: { readonly applicationId: string; readonly agentId: string },
): Promise<CurrentTaskApplicationV1 | null> {
	try {
		const principal = parseTaskPrincipalV1({
			kind: "application",
			id: input.applicationId,
		});
		agentId(input.agentId);
		await requireReadCommitted(transaction);
		const [row] = await transaction<{ application: unknown }[]>`
			select jsonb_build_object(
				'schemaVersion', 1, 'applicationId', application.id,
				'status', application.status, 'authorizationRevision', application.authorization_revision,
				'useGrant', case when use_grant.principal_id is null then null else jsonb_build_object(
					'principal', jsonb_build_object('kind', use_grant.principal_type, 'id', use_grant.principal_id),
					'agentId', use_grant.agent_id, 'grantType', use_grant.grant_type, 'authorizationRevision', use_grant.authorization_revision,
					'revoked', use_grant.revoked_at is not null) end) as application
			from platform.platform_applications application
			left join platform.agent_principal_grants use_grant on
				use_grant.principal_type = 'application' and use_grant.principal_id = application.id
				and use_grant.agent_id = ${input.agentId} and use_grant.grant_type = 'use'
			where application.id = ${principal.id}
		`;
		if (!row) return null;
		const application = parseCurrentTaskApplicationV1(row.application);
		if (
			application.applicationId !== principal.id ||
			(application.useGrant && application.useGrant.agentId !== input.agentId)
		)
			throw new TaskCurrentAuthorityUnavailableErrorV1();
		return application;
	} catch {
		throw new TaskCurrentAuthorityUnavailableErrorV1();
	}
}

/** Personal API tasks also consume their explicit original use grant, not Web roles. */
export async function readCurrentTaskApiUseGrantV1(
	transaction: postgres.TransactionSql,
	input: { readonly principal: TaskPrincipalV1; readonly agentId: string },
): Promise<CurrentTaskApiUseGrantV1 | null> {
	try {
		const principal = parseTaskPrincipalV1(input.principal);
		agentId(input.agentId);
		await requireReadCommitted(transaction);
		const [row] = await transaction<{ use_grant: unknown }[]>`
			select jsonb_build_object(
				'principal', jsonb_build_object('kind', principal_type, 'id', principal_id),
				'agentId', agent_id, 'grantType', grant_type, 'authorizationRevision', authorization_revision,
				'revoked', revoked_at is not null) as use_grant
			from platform.agent_principal_grants
			where principal_type = ${principal.kind} and principal_id = ${principal.id}
				and agent_id = ${input.agentId} and grant_type = 'use'
		`;
		if (!row) return null;
		const grant = parseCurrentTaskApiUseGrantV1(row.use_grant);
		if (
			grant.principal.kind !== principal.kind ||
			grant.principal.id !== principal.id ||
			grant.agentId !== input.agentId
		)
			throw new TaskCurrentAuthorityUnavailableErrorV1();
		return grant;
	} catch {
		throw new TaskCurrentAuthorityUnavailableErrorV1();
	}
}
