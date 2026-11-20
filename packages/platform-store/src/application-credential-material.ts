import { randomUUID } from "node:crypto";
import { ApplicationCredentialMaterialMetadataV1Schema } from "@agent-infra/contracts/pilot";
import {
	ApplicationApiCredentialErrorV1,
	type ApplicationApiCredentialRequestV1,
	type ApplicationCredentialMaterialRecordV1,
	type ApplicationCredentialMaterialStoreV1,
	type ApplicationCredentialMaterialTransactionV1,
	applicationCredentialMaterialMetadataV1,
	PersonalApiCredentialErrorV1,
} from "@agent-infra/platform-core";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { applicationApiCredentialTransactionV1 } from "./application-api-credentials.js";
import postgres from "./observed-postgres.js";
import { auditEvents, idempotencyRecords } from "./schema.js";

type Transaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];
const scopeType = "application_api_credential";
const commandType = "application.credential.material.v1";
const baseWhere = (applicationId: string) =>
	and(
		eq(idempotencyRecords.scopeType, scopeType),
		eq(idempotencyRecords.scopeId, applicationId),
		eq(idempotencyRecords.commandType, commandType),
	);
function decode(
	row: typeof idempotencyRecords.$inferSelect | undefined,
): ApplicationCredentialMaterialRecordV1 | null {
	if (!row) return null;
	try {
		const record =
			row.result as unknown as ApplicationCredentialMaterialRecordV1;
		if (
			row.status !== "completed" ||
			record.schemaVersion !== 1 ||
			(record.failureReason != null &&
				![
					"deadline_exceeded",
					"authorization_changed",
					"credential_changed",
					"request_aborted",
					"dependency_unavailable",
					"claim_commit_unconfirmed",
					"generation_failed",
					"generation_commit_unconfirmed",
					"transport_failed",
					"transmission_failed",
					"transmission_commit_unconfirmed",
					"confirmation_failed",
					"confirmation_commit_unconfirmed",
				].includes(record.failureReason)) ||
			record.managerUserId !== row.actorId ||
			record.requestDigest !== row.requestDigest ||
			record.idempotencyKey !== row.idempotencyKey ||
			record.result.metadata.applicationId !== row.scopeId ||
			!Number.isFinite(Date.parse(record.expiresAt))
		)
			throw new Error();
		ApplicationCredentialMaterialMetadataV1Schema.parse(
			applicationCredentialMaterialMetadataV1(record),
		);
		return record;
	} catch {
		throw new ApplicationApiCredentialErrorV1("unavailable");
	}
}
function operations(
	tx: Transaction,
): ApplicationCredentialMaterialTransactionV1 {
	return {
		...applicationApiCredentialTransactionV1(tx),
		async lockByKey(request: ApplicationApiCredentialRequestV1) {
			const [row] = await tx
				.select()
				.from(idempotencyRecords)
				.where(
					and(
						baseWhere(request.applicationId),
						eq(idempotencyRecords.actorId, request.userId),
						eq(idempotencyRecords.idempotencyKey, request.idempotencyKey),
					),
				)
				.for("update")
				.limit(1);
			return decode(row);
		},
		async lockByAttempt(applicationId, attemptId) {
			if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(attemptId))
				return null;
			const [row] = await tx
				.select()
				.from(idempotencyRecords)
				.where(
					and(baseWhere(applicationId), eq(idempotencyRecords.id, attemptId)),
				)
				.for("update")
				.limit(1);
			return decode(row);
		},
		async save(record) {
			await tx
				.insert(idempotencyRecords)
				.values({
					id: record.result.delivery.attemptId,
					scopeType,
					scopeId: record.result.metadata.applicationId,
					actorId: record.managerUserId,
					commandType,
					idempotencyKey: record.idempotencyKey,
					requestDigest: record.requestDigest,
					status: "completed",
					result: { ...record },
				})
				.onConflictDoUpdate({
					target: [
						idempotencyRecords.scopeType,
						idempotencyRecords.scopeId,
						idempotencyRecords.actorId,
						idempotencyRecords.commandType,
						idempotencyRecords.idempotencyKey,
					],
					set: { result: { ...record }, updatedAt: new Date() },
				});
		},
		async audit(request, record, phase, outcome) {
			await tx.insert(auditEvents).values({
				id: randomUUID(),
				requestId: request.requestId,
				traceId: request.traceId,
				actorType: "user",
				actorId: request.userId,
				action: `application.credential.material.${phase}`,
				targetType: "application",
				targetId: record.result.metadata.applicationId,
				outcome,
				details: {
					managerId: record.managerUserId,
					credentialId: record.result.metadata.credentialId,
					attemptId: record.result.delivery.attemptId,
					recipient: record.result.delivery.recipient,
					grantRevision: record.result.delivery.grantRevision,
					deliveryStatus: record.result.delivery.status,
					phase: record.result.metadata.phase,
					fence: record.result.metadata.fence,
					containsMaterial: false,
					failureReason: record.failureReason ?? null,
				},
			});
		},
	};
}
export class PostgresApplicationCredentialMaterialStoreV1
	implements ApplicationCredentialMaterialStoreV1
{
	readonly #client;
	readonly #database;
	constructor(input: { readonly databaseUrl: string }) {
		this.#client = postgres(input.databaseUrl, { max: 2 });
		this.#database = drizzle(this.#client);
	}
	execute<T>(
		work: (tx: ApplicationCredentialMaterialTransactionV1) => Promise<T>,
	): Promise<T> {
		return this.#database
			.transaction(async (tx) => {
				await tx.execute(sql`set local lock_timeout = '2s'`);
				await tx.execute(sql`set local statement_timeout = '5s'`);
				return work(operations(tx));
			})
			.catch((error) => {
				if (
					error instanceof ApplicationApiCredentialErrorV1 ||
					error instanceof PersonalApiCredentialErrorV1
				)
					throw error;
				throw new ApplicationApiCredentialErrorV1("unavailable");
			});
	}
	async inspect(applicationId: string, attemptId: string) {
		if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(attemptId))
			return null;
		const [row] = await this.#database
			.select()
			.from(idempotencyRecords)
			.where(
				and(baseWhere(applicationId), eq(idempotencyRecords.id, attemptId)),
			)
			.limit(1)
			.catch(() => {
				throw new ApplicationApiCredentialErrorV1("unavailable");
			});
		return decode(row);
	}
	async close() {
		await this.#client.end();
	}
}
