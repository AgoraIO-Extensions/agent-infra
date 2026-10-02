import { randomUUID } from "node:crypto";
import type {
	ApplicationMetadataV1,
	ApplicationRegistrationAuditV1,
	ApplicationRegistrationRequestV1,
	ApplicationRegistrationStoreV1,
	ApplicationRegistrationTransactionV1,
} from "@agent-infra/platform-core";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
	auditEvents,
	idempotencyRecords,
	platformApplications,
	platformUserDisables,
} from "./schema.js";

type Transaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];
function metadata(
	row: typeof platformApplications.$inferSelect,
): ApplicationMetadataV1 {
	if (row.status !== "active" && row.status !== "disabled") throw new Error();
	return {
		applicationId: row.id,
		name: row.name,
		responsibleUserId: row.responsibleUserId,
		status: row.status,
		authorizationRevision: row.authorizationRevision,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}
function idempotencyCondition(
	request: ApplicationRegistrationRequestV1,
	key: string,
) {
	return and(
		eq(idempotencyRecords.scopeType, "application_registration"),
		eq(idempotencyRecords.scopeId, request.userId),
		eq(idempotencyRecords.actorId, request.userId),
		eq(idempotencyRecords.commandType, "application.registered"),
		eq(idempotencyRecords.idempotencyKey, key),
	);
}
async function writeAudit(
	writer: Pick<Transaction, "insert">,
	event: ApplicationRegistrationAuditV1,
): Promise<void> {
	try {
		await writer.insert(auditEvents).values({
			id: randomUUID(),
			requestId: event.requestId,
			traceId: event.traceId,
			actorType: event.userId === null ? "unknown" : "user",
			actorId: event.userId ?? "unknown",
			action: event.action,
			targetType: "application",
			targetId: event.applicationId ?? "unknown",
			outcome: event.outcome,
			details: { ...event.details },
		});
	} catch {
		console.error("application_governance_audit_unavailable", {
			requestId: event.requestId,
			traceId: event.traceId,
		});
		throw new Error("Application audit unavailable");
	}
}
/** One owned pool; assembly closes it with the other Platform adapters. */
export class PostgresApplicationRegistrationStoreV1
	implements ApplicationRegistrationStoreV1
{
	readonly #client;
	readonly #database;
	constructor(options: { readonly databaseUrl: string }) {
		this.#client = postgres(options.databaseUrl, { max: 1 });
		this.#database = drizzle(this.#client);
	}
	execute<T>(
		work: (transaction: ApplicationRegistrationTransactionV1) => Promise<T>,
	): Promise<T> {
		return this.#database.transaction((transaction) =>
			work({
				async lockUserDisabled(userId) {
					// SHARE also protects the absent disable row until commit.
					await transaction.execute(
						sql`lock table platform.platform_user_disables in share mode`,
					);
					const [row] = await transaction
						.select({ userId: platformUserDisables.userId })
						.from(platformUserDisables)
						.where(eq(platformUserDisables.userId, userId))
						.limit(1);
					return row !== undefined;
				},
				async lockIdempotency(request, key) {
					await transaction.execute(
						sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["application_registration", request.userId, "application.registered", key])}, 0))`,
					);
					const [row] = await transaction
						.select({
							requestDigest: idempotencyRecords.requestDigest,
							status: idempotencyRecords.status,
							result: idempotencyRecords.result,
						})
						.from(idempotencyRecords)
						.where(idempotencyCondition(request, key))
						.limit(1);
					return row ?? null;
				},
				async readOwn(applicationId, userId) {
					const [row] = await transaction
						.select()
						.from(platformApplications)
						.where(
							and(
								eq(platformApplications.id, applicationId),
								eq(platformApplications.responsibleUserId, userId),
							),
						)
						.for("share")
						.limit(1);
					return row ? metadata(row) : null;
				},
				async insert(input) {
					const [row] = await transaction
						.insert(platformApplications)
						.values({
							id: input.applicationId,
							name: input.name,
							responsibleUserId: input.responsibleUserId,
							status: "active",
							authorizationRevision: input.authorizationRevision,
						})
						.returning();
					if (!row) throw new Error();
					return metadata(row);
				},
				async completeIdempotency(request, key, digest, result) {
					await transaction.insert(idempotencyRecords).values({
						id: randomUUID(),
						scopeType: "application_registration",
						scopeId: request.userId,
						actorId: request.userId,
						commandType: "application.registered",
						idempotencyKey: key,
						requestDigest: digest,
						status: "completed",
						result: { ...result },
					});
				},
				recordAudit: (event) => writeAudit(transaction, event),
			}),
		);
	}
	recordAudit(event: ApplicationRegistrationAuditV1): Promise<void> {
		return writeAudit(this.#database, event);
	}
	async close(): Promise<void> {
		await this.#client.end();
	}
}
