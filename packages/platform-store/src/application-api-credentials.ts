import { randomUUID } from "node:crypto";
import { ApplicationApiCredentialResponseV1Schema } from "@agent-infra/contracts/pilot";
import {
	ApplicationApiCredentialErrorV1,
	type ApplicationApiCredentialRequestV1,
	type ApplicationApiCredentialStoreV1,
	type ApplicationApiCredentialTransactionV1,
	type ApplicationCredentialSavedReceiptV1,
	type PersonalApiCredentialMetadataV1,
} from "@agent-infra/platform-core";
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { applicationMaterialGrantTransactionV1 } from "./application-material-grant.js";
import {
	auditEvents,
	idempotencyRecords,
	platformApiCredentials,
	platformApplications,
} from "./schema.js";

type Transaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];
const scopeType = "application_api_credential";
const commandType = "application.credential.issue_or_rotate";
function receiptWhere(request: ApplicationApiCredentialRequestV1) {
	return and(
		eq(idempotencyRecords.scopeType, scopeType),
		eq(idempotencyRecords.scopeId, request.applicationId),
		eq(idempotencyRecords.actorId, request.userId),
		eq(idempotencyRecords.commandType, commandType),
		eq(idempotencyRecords.idempotencyKey, request.idempotencyKey),
	);
}
function metadata(
	row: typeof platformApiCredentials.$inferSelect,
): PersonalApiCredentialMetadataV1 {
	return {
		credentialId: row.id,
		scopes: row.scopes as PersonalApiCredentialMetadataV1["scopes"],
		expiresAt: row.expiresAt?.toISOString() ?? null,
		revokedAt: row.revokedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
	};
}
function operations(tx: Transaction): ApplicationApiCredentialTransactionV1 {
	const grants = applicationMaterialGrantTransactionV1(tx);
	return {
		lockUserDisabled: grants.lockUserDisabled,
		async databaseTime() {
			const result = await tx.execute(sql`select clock_timestamp() as now`);
			return new Date(result[0]?.now as string);
		},
		async lockApplication(applicationId) {
			// Serialize issuance across keys and recipients without changing governance's app lock order.
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([scopeType, applicationId])}, 0))`,
			);
			const [row] = await tx
				.select({
					responsibleUserId: platformApplications.responsibleUserId,
					status: platformApplications.status,
				})
				.from(platformApplications)
				.where(eq(platformApplications.id, applicationId))
				.for("share")
				.limit(1);
			return row ?? null;
		},
		lockGrant: (applicationId, recipient) =>
			grants.lockGrant({ applicationId, ...recipient }),
		async lockReceipt(request) {
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([scopeType, request.applicationId, request.userId, commandType, request.idempotencyKey])}, 0))`,
			);
			const [row] = await tx
				.select()
				.from(idempotencyRecords)
				.where(receiptWhere(request))
				.for("update")
				.limit(1);
			if (!row) return null;
			const saved =
				row.result as unknown as ApplicationCredentialSavedReceiptV1 | null;
			if (
				row.status !== "completed" ||
				!saved ||
				saved.requestDigest !== row.requestDigest ||
				!saved.result?.metadata?.credentialId ||
				!Number.isFinite(Date.parse(saved.expiresAt))
			)
				throw new ApplicationApiCredentialErrorV1("unavailable");
			const parsed = ApplicationApiCredentialResponseV1Schema.safeParse(
				saved.result,
			);
			if (
				!parsed.success ||
				parsed.data.metadata.applicationId !== request.applicationId
			)
				throw new ApplicationApiCredentialErrorV1("unavailable");
			const [credential] = await tx
				.select()
				.from(platformApiCredentials)
				.where(
					and(
						eq(platformApiCredentials.id, saved.result.metadata.credentialId),
						eq(platformApiCredentials.principalType, "application"),
						eq(platformApiCredentials.principalId, request.applicationId),
					),
				)
				.limit(1);
			if (!credential) throw new ApplicationApiCredentialErrorV1("unavailable");
			return {
				...saved,
				result: {
					...saved.result,
					metadata: {
						...metadata(credential),
						applicationId: request.applicationId,
					},
				},
			};
		},
		async lockActiveCredential(applicationId) {
			const rows = await tx
				.select()
				.from(platformApiCredentials)
				.where(
					and(
						eq(platformApiCredentials.principalType, "application"),
						eq(platformApiCredentials.principalId, applicationId),
						isNull(platformApiCredentials.revokedAt),
					),
				)
				.for("update")
				.limit(2);
			if (rows.length > 1)
				throw new ApplicationApiCredentialErrorV1("idempotency_conflict");
			return rows[0] ? metadata(rows[0]) : null;
		},
		async insertCredential(
			applicationId,
			credentialId,
			credentialHash,
			command,
		) {
			const [row] = await tx
				.insert(platformApiCredentials)
				.values({
					id: credentialId,
					principalType: "application",
					principalId: applicationId,
					credentialHash,
					scopes: command.scopes,
					expiresAt: command.expiresAt ? new Date(command.expiresAt) : null,
				})
				.returning();
			if (!row) throw new ApplicationApiCredentialErrorV1("unavailable");
			return metadata(row);
		},
		async revokeCredential(credentialId, revokedAt) {
			await tx
				.update(platformApiCredentials)
				.set({ revokedAt: new Date(revokedAt) })
				.where(eq(platformApiCredentials.id, credentialId));
		},
		async saveReceipt(request, receipt) {
			await tx
				.insert(idempotencyRecords)
				.values({
					id: randomUUID(),
					scopeType,
					scopeId: request.applicationId,
					actorId: request.userId,
					commandType,
					idempotencyKey: request.idempotencyKey,
					requestDigest: receipt.requestDigest,
					status: "completed",
					result: { ...receipt },
				})
				.onConflictDoUpdate({
					target: [
						idempotencyRecords.scopeType,
						idempotencyRecords.scopeId,
						idempotencyRecords.actorId,
						idempotencyRecords.commandType,
						idempotencyRecords.idempotencyKey,
					],
					set: { result: { ...receipt }, updatedAt: new Date() },
				});
		},
		async recordAudit(request, result, event) {
			await tx.insert(auditEvents).values({
				id: randomUUID(),
				requestId: request.requestId,
				traceId: request.traceId,
				actorType: "user",
				actorId: request.userId,
				action: event.action,
				targetType: "application",
				targetId: request.applicationId,
				outcome: event.outcome,
				details: {
					credentialId: result.metadata.credentialId,
					recipient: result.delivery.recipient,
					attemptId: result.delivery.attemptId,
					grantRevision: result.delivery.grantRevision,
					deliveryStatus: result.delivery.status,
					returnedMaterial: false,
					...(event.previousCredentialId
						? { previousCredentialId: event.previousCredentialId }
						: {}),
				},
			});
		},
	};
}
export class PostgresApplicationApiCredentialIssuerStoreV1
	implements ApplicationApiCredentialStoreV1
{
	readonly #client;
	readonly #database;
	constructor(input: { readonly databaseUrl: string }) {
		this.#client = postgres(input.databaseUrl, { max: 2 });
		this.#database = drizzle(this.#client);
	}
	execute<T>(
		work: (tx: ApplicationApiCredentialTransactionV1) => Promise<T>,
	): Promise<T> {
		return this.#database.transaction((tx) => work(operations(tx)));
	}
	async close(): Promise<void> {
		await this.#client.end();
	}
}
