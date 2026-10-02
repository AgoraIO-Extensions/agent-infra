import { createHash } from "node:crypto";
import {
	type ApiAuditCredentialIdentityV1,
	PersonalApiCredentialErrorV1,
	requireApiAuditCredentialIdentityV1,
	resolveCurrentPersonalApiUserV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import type postgres from "postgres";

interface CredentialRow {
	id: string;
	credential_hash: string;
	principal_type: string;
	principal_id: string;
	scopes: unknown;
	expires_at: Date | null;
	revoked_at: Date | null;
	created_at: Date;
}

/** Call inside the query transaction, before Agent locks; no new pool or writer. */
export async function resolveApiAuditCredentialIdentityV1(
	transaction: postgres.TransactionSql,
	material: string,
	userDirectory: TaskUserDirectoryV1 | undefined,
): Promise<{
	readonly identity: ApiAuditCredentialIdentityV1;
	/** Call after the last query/audit await, before committing or returning data. */
	readonly revalidate: () => Promise<void>;
}> {
	try {
		if (
			typeof material !== "string" ||
			!/^papi_[A-Za-z0-9_-]{43}$/.test(material)
		)
			throw new PersonalApiCredentialErrorV1("authentication_required");
		const hash = createHash("sha256").update(material).digest("hex");
		const [isolation] = await transaction<{ transaction_isolation: string }[]>`
			show transaction_isolation`;
		if (isolation?.transaction_isolation !== "read committed")
			throw new PersonalApiCredentialErrorV1("unavailable");
		const references = await transaction<
			Pick<CredentialRow, "id" | "principal_type" | "principal_id">[]
		>`
			select id, principal_type, principal_id from platform.platform_api_credentials
			where credential_hash = ${hash} limit 2`;
		if (references.length > 1)
			throw new PersonalApiCredentialErrorV1("unavailable");
		const reference = references[0];
		if (!reference)
			throw new PersonalApiCredentialErrorV1("authentication_required");
		if (
			reference.principal_type !== "user" &&
			reference.principal_type !== "application"
		)
			throw new PersonalApiCredentialErrorV1("unavailable");
		const read = async (): Promise<ApiAuditCredentialIdentityV1> => {
			try {
				let disabled = false;
				if (reference.principal_type === "user") {
					await transaction`lock table platform.platform_user_disables in share mode`;
					const rows = await transaction<{ user_id: string }[]>`
						select user_id from platform.platform_user_disables
						where user_id = ${reference.principal_id}`;
					disabled = rows.length !== 0;
				}
				const rows = await transaction<CredentialRow[]>`
					select id, credential_hash, principal_type, principal_id, scopes,
						expires_at, revoked_at, created_at from platform.platform_api_credentials
					where credential_hash = ${hash} limit 2 for share`;
				if (rows.length > 1)
					throw new PersonalApiCredentialErrorV1("unavailable");
				const credential = rows[0];
				if (
					!credential ||
					credential.id !== reference.id ||
					credential.credential_hash !== hash ||
					credential.principal_type !== reference.principal_type ||
					credential.principal_id !== reference.principal_id
				)
					throw new PersonalApiCredentialErrorV1("authentication_required");
				const user =
					reference.principal_type === "user"
						? await resolveCurrentPersonalApiUserV1(
								userDirectory,
								reference.principal_id,
							)
						: undefined;
				const [application] =
					reference.principal_type === "application"
						? await transaction<
								{ id: string; status: string; authorization_revision: string }[]
							>`
						select id, status, authorization_revision from platform.platform_applications
						where id = ${reference.principal_id} for share`
						: [];
				if (reference.principal_type === "application" && !application)
					throw new PersonalApiCredentialErrorV1("forbidden");
				const [clock] = await transaction<
					{ now: Date }[]
				>`select clock_timestamp() as now`;
				return requireApiAuditCredentialIdentityV1({
					credential: {
						schemaVersion: 1,
						credentialId: credential.id,
						principal: {
							kind: reference.principal_type,
							id: reference.principal_id,
						},
						scopes: credential.scopes,
						expiresAt: credential.expires_at,
						revokedAt: credential.revoked_at,
						createdAt: credential.created_at,
					},
					...(user ? { user } : {}),
					...(application
						? {
								application: {
									applicationId: application.id,
									status: application.status,
									authorizationRevision: application.authorization_revision,
								},
							}
						: {}),
					disabled,
					now: clock?.now ?? new Date(Number.NaN),
				});
			} catch (error) {
				if (error instanceof PersonalApiCredentialErrorV1) throw error;
				throw new PersonalApiCredentialErrorV1("unavailable");
			}
		};
		const identity = await read();
		const revision = identity.identityRevision;
		return {
			identity,
			async revalidate() {
				const current = await read();
				if (current.identityRevision !== revision)
					throw new PersonalApiCredentialErrorV1("unavailable");
			},
		};
	} catch (error) {
		if (error instanceof PersonalApiCredentialErrorV1) throw error;
		throw new PersonalApiCredentialErrorV1("unavailable");
	}
}
