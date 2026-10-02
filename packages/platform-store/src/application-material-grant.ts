import { randomUUID } from "node:crypto";
import type {
	ApplicationMaterialGrantAuditV1,
	ApplicationMaterialGrantMetadataV1,
	ApplicationMaterialGrantStoreV1,
	ApplicationMaterialGrantTransactionV1,
} from "@agent-infra/platform-core";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
	apiCredentialDeliveryGrants,
	auditEvents,
	platformApplications,
	platformUserDisables,
} from "./schema.js";

type Transaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];
type GrantRow = typeof apiCredentialDeliveryGrants.$inferSelect;
export interface PostgresApplicationMaterialGrantOptionsV1 {
	readonly databaseUrl: string;
}
function metadata(row: GrantRow): ApplicationMaterialGrantMetadataV1 {
	return {
		applicationId: row.applicationId,
		principalType: row.principalType as "user" | "application",
		principalId: row.principalId,
		authorizationRevision: row.authorizationRevision,
		createdAt: row.createdAt.toISOString(),
		revokedAt: row.revokedAt?.toISOString() ?? null,
	};
}
async function writeAudit(
	writer: Pick<Transaction, "insert">,
	event: ApplicationMaterialGrantAuditV1,
): Promise<void> {
	try {
		await writer.insert(auditEvents).values({
			id: randomUUID(),
			requestId: event.requestId,
			traceId: event.traceId,
			actorType: event.userId === null ? "unknown" : "user",
			actorId: event.userId ?? "unknown",
			action: event.action,
			targetType: "api_credential_delivery_grant",
			targetId:
				event.applicationId && event.principalType && event.principalId
					? `${event.applicationId}:${event.principalType}:${event.principalId}`
					: "unknown",
			outcome: event.outcome,
			details: { ...event.details },
		});
	} catch {
		throw new Error("grant audit unavailable");
	}
}
function operations(tx: Transaction): ApplicationMaterialGrantTransactionV1 {
	return {
		async lockUserDisabled(userId) {
			await tx.execute(
				sql`lock table platform.platform_user_disables in share mode`,
			);
			const [row] = await tx
				.select({ userId: platformUserDisables.userId })
				.from(platformUserDisables)
				.where(eq(platformUserDisables.userId, userId))
				.limit(1);
			return row !== undefined;
		},
		async applicationExists(applicationId) {
			const [row] = await tx
				.select({ id: platformApplications.id })
				.from(platformApplications)
				.where(eq(platformApplications.id, applicationId))
				.limit(1);
			return row !== undefined;
		},
		async recipientEligible(principalType, principalId) {
			if (principalType === "application") {
				const [row] = await tx
					.select({ id: platformApplications.id })
					.from(platformApplications)
					.where(
						and(
							eq(platformApplications.id, principalId),
							eq(platformApplications.status, "active"),
						),
					)
					.limit(1);
				return row !== undefined;
			}
			await tx.execute(
				sql`lock table platform.platform_user_disables in share mode`,
			);
			const [row] = await tx
				.select({ userId: platformUserDisables.userId })
				.from(platformUserDisables)
				.where(eq(platformUserDisables.userId, principalId))
				.limit(1);
			return row === undefined;
		},
		async lockGrant(request) {
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["material-grant", request.applicationId, request.principalType, request.principalId])}, 0))`,
			);
			const [row] = await tx
				.select()
				.from(apiCredentialDeliveryGrants)
				.where(
					and(
						eq(
							apiCredentialDeliveryGrants.applicationId,
							request.applicationId,
						),
						eq(
							apiCredentialDeliveryGrants.principalType,
							request.principalType,
						),
						eq(apiCredentialDeliveryGrants.principalId, request.principalId),
					),
				)
				.for("update")
				.limit(1);
			return row ? metadata(row) : null;
		},
		async upsertGrant(request, revision, createdAt) {
			const [row] = await tx
				.insert(apiCredentialDeliveryGrants)
				.values({
					applicationId: request.applicationId,
					principalType: request.principalType,
					principalId: request.principalId,
					authorizationRevision: revision,
					createdAt,
					revokedAt: null,
				})
				.onConflictDoUpdate({
					target: [
						apiCredentialDeliveryGrants.applicationId,
						apiCredentialDeliveryGrants.principalType,
						apiCredentialDeliveryGrants.principalId,
					],
					set: { authorizationRevision: revision, revokedAt: null },
				})
				.returning();
			if (!row) throw new Error("grant write unavailable");
			return metadata(row);
		},
		async revokeGrant(request, revokedAt, revision) {
			const [row] = await tx
				.update(apiCredentialDeliveryGrants)
				.set({ revokedAt, authorizationRevision: revision })
				.where(
					and(
						eq(
							apiCredentialDeliveryGrants.applicationId,
							request.applicationId,
						),
						eq(
							apiCredentialDeliveryGrants.principalType,
							request.principalType,
						),
						eq(apiCredentialDeliveryGrants.principalId, request.principalId),
					),
				)
				.returning();
			return row ? metadata(row) : null;
		},
		recordAudit: (event) => writeAudit(tx, event),
	};
}
export class PostgresApplicationMaterialGrantStoreV1
	implements ApplicationMaterialGrantStoreV1
{
	readonly #client;
	readonly #database;
	constructor(options: PostgresApplicationMaterialGrantOptionsV1) {
		this.#client = postgres(options.databaseUrl, { max: 1 });
		this.#database = drizzle(this.#client);
	}
	async execute<T>(
		work: (tx: ApplicationMaterialGrantTransactionV1) => Promise<T>,
	): Promise<T> {
		return this.#database.transaction((tx) => work(operations(tx)));
	}
	async close(): Promise<void> {
		await this.#client.end();
	}
}
