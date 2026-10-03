import { createHash } from "node:crypto";
import {
	type CurrentTaskApplicationV1,
	PersonalApiCredentialErrorV1,
	type PersonalApiTaskAdmissionAuthorityV1,
	type PersonalApiTaskBindingV1,
	type PersonalApiTaskUseAuthorizationV1,
	parsePersonalApiTaskAdmissionAuthorityV1,
	requirePersonalApiTaskBindingV1,
	requirePersonalApiTaskUseAuthorizationV1,
	resolveCurrentPersonalApiUserV1,
	type TaskApiChannelV1,
	type TaskPrincipalV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import type postgres from "postgres";
import { readCurrentTaskApplicationV1 } from "./application-task-authorization.js";

interface CredentialRow {
	id: string;
	credential_hash: string;
	principal_type: string;
	principal_id: string;
	scopes: unknown;
	expires_at: Date | null;
	revoked_at: Date | null;
}

async function requireReadCommitted(transaction: postgres.TransactionSql) {
	const [row] = await transaction<{ transaction_isolation: string }[]>`
		show transaction_isolation
	`;
	if (row?.transaction_isolation !== "read committed") {
		throw new PersonalApiCredentialErrorV1("unavailable");
	}
}

async function currentFacts(
	transaction: postgres.TransactionSql,
	input: {
		principal: TaskPrincipalV1;
		credentialId: string;
		credentialHash: string;
		agentId: string;
	},
	userDirectory: TaskUserDirectoryV1 | undefined,
) {
	await requireReadCommitted(transaction);
	// SHARE protects missing disable/grant rows too. Governance writes are ordered
	// by PostgreSQL's table and row locks, not an entry authentication snapshot.
	let disabled = false;
	if (input.principal.kind === "user") {
		await transaction`lock table platform.platform_user_disables in share mode`;
		const rows = await transaction<{ user_id: string }[]>`
			select user_id from platform.platform_user_disables
			where user_id = ${input.principal.id}
		`;
		disabled = rows.length !== 0;
	}
	const [credential] = await transaction<CredentialRow[]>`
		select id, credential_hash, principal_type, principal_id, scopes, expires_at, revoked_at
		from platform.platform_api_credentials where id = ${input.credentialId} for update
	`;
	const matching = await transaction<{ id: string }[]>`
		select id from platform.platform_api_credentials
		where credential_hash = ${input.credentialHash} limit 2
	`;
	if (matching.length > 1) {
		throw new PersonalApiCredentialErrorV1("unavailable");
	}
	let application: CurrentTaskApplicationV1 | null = null;
	if (input.principal.kind === "application") {
		await transaction`lock table platform.platform_applications in share mode`;
	}
	await transaction`lock table platform.agent_principal_grants in share mode`;
	if (input.principal.kind === "application")
		application = await readCurrentTaskApplicationV1(transaction, {
			applicationId: input.principal.id,
			agentId: input.agentId,
		});
	const [grant] = await transaction<
		{
			agent_id: string;
			principal_type: string;
			principal_id: string;
			grant_type: string;
			authorization_revision: string;
			revoked_at: Date | null;
		}[]
	>`
		select agent_id, principal_type, principal_id, grant_type,
			authorization_revision, revoked_at from platform.agent_principal_grants
		where principal_type = ${input.principal.kind} and principal_id = ${input.principal.id}
			and agent_id = ${input.agentId} and grant_type = 'use'
	`;
	const user =
		input.principal.kind === "user"
			? await resolveCurrentPersonalApiUserV1(userDirectory, input.principal.id)
			: null;
	// Resolve external identity before taking a fresh database clock sample.
	const [clock] = await transaction<{ now: Date }[]>`
		select clock_timestamp() as now
	`;
	return {
		credential: credential
			? {
					id: credential.id,
					credentialHash: credential.credential_hash,
					principalType: credential.principal_type,
					principalId: credential.principal_id,
					scopes: credential.scopes,
					expiresAt: credential.expires_at,
					revokedAt: credential.revoked_at,
				}
			: null,
		grant: grant
			? {
					agentId: grant.agent_id,
					principalType: grant.principal_type,
					principalId: grant.principal_id,
					grantType: grant.grant_type,
					authorizationRevision: grant.authorization_revision,
					revokedAt: grant.revoked_at,
				}
			: null,
		user,
		application,
		disabled,
		now: clock?.now ?? new Date(Number.NaN),
	};
}

/** Resolve the actual Bearer inside the caller's transaction; never open a pool. */
export async function resolvePersonalApiTaskAdmissionAuthorityV1(
	transaction: postgres.TransactionSql,
	request: {
		readonly material: string;
		readonly agentId: string;
		readonly channelId?: TaskApiChannelV1;
		readonly operation?: "agent:use" | "agent:read";
	},
	userDirectory: TaskUserDirectoryV1 | undefined,
): Promise<PersonalApiTaskAdmissionAuthorityV1> {
	try {
		const material = request.material;
		if (
			typeof material !== "string" ||
			!/^papi_[A-Za-z0-9_-]{43}$/.test(material)
		) {
			throw new PersonalApiCredentialErrorV1("authentication_required");
		}
		await requireReadCommitted(transaction);
		const credentialHash = createHash("sha256").update(material).digest("hex");
		// This lookup identifies the exact reference only. All authority is checked
		// again from locked rows below; duplicate material is never picked arbitrarily.
		const rows = await transaction<
			{ id: string; principal_type: string; principal_id: string }[]
		>`
			select id, principal_type, principal_id from platform.platform_api_credentials
			where credential_hash = ${credentialHash} limit 2
		`;
		if (rows.length > 1) {
			throw new PersonalApiCredentialErrorV1("unavailable");
		}
		const reference = rows[0];
		if (
			!reference ||
			(reference.principal_type !== "user" &&
				reference.principal_type !== "application")
		) {
			throw new PersonalApiCredentialErrorV1("authentication_required");
		}
		const facts = await currentFacts(
			transaction,
			{
				principal: {
					kind: reference.principal_type,
					id: reference.principal_id,
				},
				credentialId: reference.id,
				credentialHash,
				agentId: request.agentId,
			},
			userDirectory,
		);
		// The absent-grant revision never escapes: policy first verifies the actual
		// credential/current subject, then rejects the missing explicit use grant.
		let authority: PersonalApiTaskAdmissionAuthorityV1;
		try {
			authority = parsePersonalApiTaskAdmissionAuthorityV1({
				schemaVersion: 1,
				principal: {
					kind: reference.principal_type,
					id: reference.principal_id,
				},
				credentialId: reference.id,
				credentialHash,
				agentId: request.agentId,
				channelId: request.channelId ?? "api",
				operation: request.operation ?? "agent:use",
				identityRevision:
					facts.user?.authorizationRevision ??
					facts.application?.authorizationRevision ??
					"missing",
				useGrantRevision: facts.grant?.authorizationRevision ?? "missing",
			});
		} catch {
			throw new PersonalApiCredentialErrorV1("unavailable");
		}
		requirePersonalApiTaskUseAuthorizationV1({ authority, ...facts });
		return authority;
	} catch (error) {
		if (error instanceof PersonalApiCredentialErrorV1) throw error;
		throw new PersonalApiCredentialErrorV1("unavailable");
	}
}

/** Entry and both accepted/replayed exits must call this on their original transaction. */
export async function requireCurrentPersonalApiTaskAdmissionV1(
	transaction: postgres.TransactionSql,
	input: PersonalApiTaskAdmissionAuthorityV1,
	binding: PersonalApiTaskBindingV1,
	userDirectory: TaskUserDirectoryV1 | undefined,
): Promise<PersonalApiTaskUseAuthorizationV1> {
	try {
		const authority = parsePersonalApiTaskAdmissionAuthorityV1(input);
		requirePersonalApiTaskBindingV1(authority, binding);
		const facts = await currentFacts(
			transaction,
			{
				principal: authority.principal,
				credentialId: authority.credentialId,
				credentialHash: authority.credentialHash,
				agentId: authority.agentId,
			},
			userDirectory,
		);
		return requirePersonalApiTaskUseAuthorizationV1({ authority, ...facts });
	} catch (error) {
		if (error instanceof PersonalApiCredentialErrorV1) throw error;
		throw new PersonalApiCredentialErrorV1("unavailable");
	}
}
