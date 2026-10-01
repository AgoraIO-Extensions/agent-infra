import { randomUUID } from "node:crypto";
import {
	type PersonalApiAgentReadAuditV1,
	type PersonalApiAgentReadTransactionPortV1,
	type PersonalApiAgentReadTransactionV1,
	type PersonalApiCredentialAuditV1,
	PersonalApiCredentialErrorV1,
	type PersonalApiCredentialMetadataV1,
	type PersonalApiCredentialMutationV1,
	type PersonalApiCredentialRequestV1,
	type PersonalApiCredentialTransactionPortV1,
	type PersonalApiCredentialTransactionV1,
	parsePersonalApiCredentialScopesV1,
} from "@agent-infra/platform-core";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
	auditEvents,
	idempotencyRecords,
	platformApiCredentials,
	platformUserDisables,
} from "./schema.js";

type Transaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];
type CredentialRow = typeof platformApiCredentials.$inferSelect;

export interface PostgresPersonalApiCredentialOptionsV1 {
	readonly databaseUrl: string;
}

function metadata(row: CredentialRow): PersonalApiCredentialMetadataV1 {
	try {
		return {
			credentialId: row.id,
			scopes: parsePersonalApiCredentialScopesV1(row.scopes),
			expiresAt: row.expiresAt?.toISOString() ?? null,
			revokedAt: row.revokedAt?.toISOString() ?? null,
			createdAt: row.createdAt.toISOString(),
			lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
		};
	} catch {
		throw new PersonalApiCredentialErrorV1("unavailable");
	}
}

function idempotencyCondition(
	request: PersonalApiCredentialRequestV1,
	action: PersonalApiCredentialMutationV1,
) {
	return and(
		eq(idempotencyRecords.scopeType, "personal_api_credential"),
		eq(idempotencyRecords.scopeId, request.userId),
		eq(idempotencyRecords.actorId, request.userId),
		eq(idempotencyRecords.commandType, action),
		eq(idempotencyRecords.idempotencyKey, request.idempotencyKey),
	);
}

async function writeAudit(
	writer: Pick<Transaction, "insert">,
	event: PersonalApiCredentialAuditV1 | PersonalApiAgentReadAuditV1,
): Promise<void> {
	try {
		await writer.insert(auditEvents).values({
			id: randomUUID(),
			requestId: event.requestId,
			traceId: event.traceId,
			actorType: event.userId === null ? "unknown" : "user",
			actorId: event.userId ?? "unknown",
			action: event.action,
			targetType: "api_credential",
			targetId: event.credentialId ?? "unknown",
			outcome: event.outcome,
			details: { ...event.details },
		});
	} catch {
		console.error("personal_api_credential_audit_unavailable", {
			requestId: event.requestId,
			traceId: event.traceId,
		});
		throw new PersonalApiCredentialErrorV1("unavailable");
	}
}

function transactionOperations(
	transaction: Transaction,
): PersonalApiCredentialTransactionV1 {
	return {
		async lockUserDisabled(userId) {
			// A missing row cannot be row-locked. SHARE orders disable INSERT/UPDATE/
			// DELETE with the entire sensitive transaction, including identity calls.
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
		async databaseTime() {
			const rows = await transaction.execute<{ now: unknown }>(
				sql`select clock_timestamp() as now`,
			);
			const rawNow = rows[0]?.now;
			const now =
				typeof rawNow === "string"
					? platformApiCredentials.createdAt.mapFromDriverValue(rawNow)
					: rawNow;
			if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
				throw new PersonalApiCredentialErrorV1("unavailable");
			}
			return now;
		},
		async lockIdempotency(request, action) {
			await transaction.execute(
				sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
					"personal_api_credential",
					request.userId,
					action,
					request.idempotencyKey,
				])}, 0))`,
			);
			const [row] = await transaction
				.select({
					requestDigest: idempotencyRecords.requestDigest,
					status: idempotencyRecords.status,
					result: idempotencyRecords.result,
				})
				.from(idempotencyRecords)
				.where(idempotencyCondition(request, action))
				.limit(1);
			return row ?? null;
		},
		async lockCredential(credentialId, userId) {
			const [row] = await transaction
				.select()
				.from(platformApiCredentials)
				.where(
					and(
						eq(platformApiCredentials.id, credentialId),
						eq(platformApiCredentials.principalType, "user"),
						eq(platformApiCredentials.principalId, userId),
					),
				)
				.for("update")
				.limit(1);
			return row ? metadata(row) : null;
		},
		async insertCredential(input) {
			const [row] = await transaction
				.insert(platformApiCredentials)
				.values({
					id: input.credentialId,
					principalType: "user",
					principalId: input.userId,
					credentialHash: input.credentialHash,
					scopes: [...input.scopes],
					expiresAt:
						input.expiresAt === null ? null : new Date(input.expiresAt),
				})
				.returning();
			if (!row) throw new PersonalApiCredentialErrorV1("unavailable");
			return metadata(row);
		},
		async revokeCredential(credentialId, revokedAt) {
			const [row] = await transaction
				.update(platformApiCredentials)
				.set({ revokedAt: new Date(revokedAt) })
				.where(eq(platformApiCredentials.id, credentialId))
				.returning();
			if (!row) throw new PersonalApiCredentialErrorV1("unavailable");
			return metadata(row);
		},
		async completeIdempotency(request, action, requestDigest, credentialId) {
			await transaction.insert(idempotencyRecords).values({
				id: randomUUID(),
				scopeType: "personal_api_credential",
				scopeId: request.userId,
				actorId: request.userId,
				commandType: action,
				idempotencyKey: request.idempotencyKey,
				requestDigest,
				status: "completed",
				// No first-delivery material crosses this persistence seam.
				result: { credentialId },
			});
		},
		recordAudit: (event) => writeAudit(transaction, event),
	};
}

/** Transaction Adapter for the Core personal credential use case. */
export class PostgresPersonalApiCredentialStoreV1
	implements
		PersonalApiCredentialTransactionPortV1,
		PersonalApiAgentReadTransactionPortV1
{
	readonly #client;
	readonly #database;

	constructor(options: PostgresPersonalApiCredentialOptionsV1) {
		this.#client = postgres(options.databaseUrl, { max: 1 });
		this.#database = drizzle(this.#client);
	}

	async execute<T>(
		work: (transaction: PersonalApiCredentialTransactionV1) => Promise<T>,
	): Promise<T> {
		return this.#database.transaction((transaction) =>
			work(transactionOperations(transaction)),
		);
	}

	async recordAudit(event: PersonalApiCredentialAuditV1): Promise<void> {
		await writeAudit(this.#database, event);
	}

	async executeAgentRead<T>(
		work: (transaction: PersonalApiAgentReadTransactionV1) => Promise<T>,
	): Promise<T> {
		return this.#database.transaction(async (transaction) => {
			const operations = transactionOperations(transaction);
			return work({
				lockUserDisabled: operations.lockUserDisabled,
				databaseTime: operations.databaseTime,
				async lockUsedCredential(credentialHash) {
					const rows = await transaction
						.select()
						.from(platformApiCredentials)
						.where(eq(platformApiCredentials.credentialHash, credentialHash))
						.for("update")
						.limit(2);
					if (rows.length > 1)
						throw new PersonalApiCredentialErrorV1("unavailable");
					const row = rows[0];
					if (!row) return null;
					if (
						row.principalType !== "user" &&
						row.principalType !== "application"
					) {
						throw new PersonalApiCredentialErrorV1("unavailable");
					}
					return {
						...metadata(row),
						principalType: row.principalType,
						principalId: row.principalId,
					};
				},
				async lockAgentGrants() {
					// Covers missing rows as well as existing grants during projection and audit.
					await transaction.execute(
						sql`lock table platform.agent_principal_grants in share mode`,
					);
				},
				async markCredentialUsed(credentialId, usedAt) {
					const rows = await transaction
						.update(platformApiCredentials)
						.set({ lastUsedAt: usedAt })
						.where(eq(platformApiCredentials.id, credentialId))
						.returning({ id: platformApiCredentials.id });
					if (rows.length !== 1)
						throw new PersonalApiCredentialErrorV1("unavailable");
				},
				recordAudit: (event) => writeAudit(transaction, event),
			});
		});
	}

	async recordAgentReadAudit(
		event: PersonalApiAgentReadAuditV1,
	): Promise<void> {
		await writeAudit(this.#database, event);
	}

	async close(): Promise<void> {
		await this.#client.end();
	}
}
