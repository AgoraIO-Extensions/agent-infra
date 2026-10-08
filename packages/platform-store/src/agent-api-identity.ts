import { createHash } from "node:crypto";
import {
	PersonalApiCredentialErrorV1,
	requireApiCredentialIdentityV1,
	resolveCurrentPersonalApiUserV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import { eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import {
	platformApiCredentials,
	platformApplications,
	platformUserDisables,
} from "./schema.js";

type Transaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];

/** Uses the original management transaction and the shared credential policy. */
export async function resolveAgentApiIdentityV1(
	transaction: Transaction,
	material: string,
	directory: TaskUserDirectoryV1 | undefined,
	requiredScope: "agent:manage" | "agent:read" | "agent:create",
) {
	if (
		typeof material !== "string" ||
		!/^papi_[A-Za-z0-9_-]{43}$/.test(material)
	)
		throw new PersonalApiCredentialErrorV1("authentication_required");
	const hash = createHash("sha256").update(material).digest("hex");
	const isolation = await transaction.execute<{
		transaction_isolation: string;
	}>(sql`show transaction_isolation`);
	if (isolation[0]?.transaction_isolation !== "read committed")
		throw new PersonalApiCredentialErrorV1("unavailable");
	const references = await transaction
		.select({
			id: platformApiCredentials.id,
			kind: platformApiCredentials.principalType,
			principalId: platformApiCredentials.principalId,
		})
		.from(platformApiCredentials)
		.where(eq(platformApiCredentials.credentialHash, hash))
		.limit(2);
	if (references.length > 1)
		throw new PersonalApiCredentialErrorV1("unavailable");
	const reference = references[0];
	if (!reference)
		throw new PersonalApiCredentialErrorV1("authentication_required");
	if (reference.kind !== "user" && reference.kind !== "application")
		throw new PersonalApiCredentialErrorV1("unavailable");
	async function read() {
		let disabled = false;
		if (reference?.kind === "user") {
			await transaction.execute(
				sql`lock table platform.platform_user_disables in share mode`,
			);
			const records = await transaction
				.select()
				.from(platformUserDisables)
				.where(eq(platformUserDisables.userId, reference.principalId));
			disabled = records.length !== 0;
		}
		// Application governance holds the application before mutating credentials.
		const application =
			reference?.kind === "application"
				? (
						await transaction
							.select()
							.from(platformApplications)
							.where(eq(platformApplications.id, reference.principalId))
							.for("share")
					)[0]
				: undefined;
		if (reference?.kind === "application" && !application)
			throw new PersonalApiCredentialErrorV1("forbidden");
		const credentials = await transaction
			.select()
			.from(platformApiCredentials)
			.where(eq(platformApiCredentials.credentialHash, hash))
			.limit(2)
			.for("update");
		if (credentials.length > 1)
			throw new PersonalApiCredentialErrorV1("unavailable");
		const credential = credentials[0];
		if (
			!credential ||
			credential.id !== reference?.id ||
			credential.principalType !== reference.kind ||
			credential.principalId !== reference.principalId
		)
			throw new PersonalApiCredentialErrorV1("authentication_required");
		const user =
			reference.kind === "user"
				? await resolveCurrentPersonalApiUserV1(
						directory,
						reference.principalId,
					)
				: undefined;
		const clock = await transaction.execute<{ now: string }>(
			sql`select clock_timestamp() as now`,
		);
		return requireApiCredentialIdentityV1(
			{
				credential: {
					schemaVersion: 1,
					credentialId: credential.id,
					principal: { kind: reference.kind, id: reference.principalId },
					scopes: credential.scopes,
					expiresAt: credential.expiresAt,
					revokedAt: credential.revokedAt,
					createdAt: credential.createdAt,
				},
				...(user ? { user } : {}),
				...(application
					? {
							application: {
								applicationId: application.id,
								status: application.status,
								authorizationRevision: application.authorizationRevision,
							},
						}
					: {}),
				disabled,
				now: new Date(clock[0]?.now ?? Number.NaN),
			},
			requiredScope,
		);
	}
	const identity = await read();
	return {
		identity,
		async revalidate() {
			const current = await read();
			if (current.identityRevision !== identity.identityRevision)
				throw new PersonalApiCredentialErrorV1("unavailable");
		},
	};
}
