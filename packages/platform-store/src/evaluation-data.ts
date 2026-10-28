import { createHash, randomUUID } from "node:crypto";
import {
	EvaluationDataErrorV1,
	type EvaluationDataStoreV1,
	type EvaluationDataTransactionV1,
	type EvaluationPolicyV1,
	type EvaluationRequestV1,
	type EvaluationVersionV1,
	PersonalApiCredentialErrorV1,
	parseEvaluationDatasetV1,
	parseEvaluationGrantV1,
	parseEvaluationVersionV1,
	requireApiCredentialIdentityV1,
	resolveCurrentPersonalApiUserV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "./observed-postgres.js";
import {
	auditEvents,
	idempotencyRecords,
	outboxItems,
	platformApiCredentials,
	platformApplications,
	platformUserDisables,
} from "./schema.js";
import {
	evaluationDatasets,
	evaluationGrants,
	evaluationPolicies,
	evaluationVersions,
} from "./schema-evaluation.js";

type Tx = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];
const unavailable = () => new EvaluationDataErrorV1("unavailable");
async function clock(tx: Tx) {
	const result = await tx.execute<{ time: string }>(
		sql`select clock_timestamp()::text as time`,
	);
	return new Date(result[0]?.time ?? "");
}
async function lock(tx: Tx) {
	await tx.execute(
		sql`select pg_advisory_xact_lock(hashtextextended('evaluation-data-v1',0))`,
	);
}
function decodeDataset(row: typeof evaluationDatasets.$inferSelect) {
	try {
		const value = parseEvaluationDatasetV1(row.data);
		if (value.datasetId !== row.id || value.scope !== row.scope)
			throw unavailable();
		return value;
	} catch {
		throw unavailable();
	}
}
function decodeVersion(row: typeof evaluationVersions.$inferSelect) {
	try {
		const value = parseEvaluationVersionV1(row.data);
		if (
			value.versionId !== row.id ||
			value.datasetId !== row.datasetId ||
			value.status !== row.status ||
			value.expiresAt !== row.expiresAt.toISOString() ||
			value.metadataExpiresAt !== row.metadataExpiresAt.toISOString()
		)
			throw unavailable();
		return value;
	} catch {
		throw unavailable();
	}
}
function decodeGrant(row: typeof evaluationGrants.$inferSelect) {
	try {
		const value = parseEvaluationGrantV1(row.data);
		if (value.grantId !== row.id || value.datasetId !== row.datasetId)
			throw unavailable();
		return value;
	} catch {
		throw unavailable();
	}
}
function boundedRows<T, R>(rows: T[], decode: (row: T) => R): R[] {
	if (rows.length > 1000) throw unavailable();
	return rows.map(decode);
}
async function saveVersion(tx: Tx, v: EvaluationVersionV1) {
	await tx
		.insert(evaluationVersions)
		.values({
			id: v.versionId,
			datasetId: v.datasetId,
			status: v.status,
			expiresAt: new Date(v.expiresAt),
			metadataExpiresAt: new Date(v.metadataExpiresAt),
			data: v,
		})
		.onConflictDoUpdate({
			target: evaluationVersions.id,
			set: {
				status: v.status,
				expiresAt: new Date(v.expiresAt),
				metadataExpiresAt: new Date(v.metadataExpiresAt),
				data: v,
			},
		});
}
async function enqueueDelete(tx: Tx, v: EvaluationVersionV1, traceId: string) {
	await tx
		.insert(outboxItems)
		.values({
			id: `evaluation-delete:${v.versionId}`,
			scopeType: "evaluation",
			scopeId: v.versionId,
			operation: "evaluation.content.delete.v1",
			traceId,
			payload: { versionId: v.versionId, objectRef: v.objectRef },
			availableAt: new Date(),
		})
		.onConflictDoNothing();
}
export class PostgresEvaluationDataStoreV1 implements EvaluationDataStoreV1 {
	private readonly client;
	private readonly db;
	constructor(
		private readonly options: {
			databaseUrl: string;
			directory?: TaskUserDirectoryV1;
		},
	) {
		this.client = postgres(options.databaseUrl, { max: 4 });
		this.db = drizzle(this.client);
	}
	async close() {
		await this.client.end();
	}
	async transaction<T>(
		request: EvaluationRequestV1,
		work: (tx: EvaluationDataTransactionV1) => Promise<T>,
	): Promise<T> {
		try {
			return await this.db.transaction(async (tx) => {
				await tx.execute(sql`set local statement_timeout='10s'`);
				await tx.execute(sql`set local lock_timeout='5s'`);
				// A short metadata transaction; external object transfer never holds this lock.
				await lock(tx);
				const now = await clock(tx);
				if (!Number.isFinite(+now)) throw unavailable();
				let revalidate: () => Promise<void>;
				let principal: EvaluationDataTransactionV1["principal"];
				if (request.authentication.kind === "browser") {
					const userId = request.authentication.userId;
					await tx.execute(
						sql`lock table platform.platform_user_disables in share mode`,
					);
					const check = async () => {
						const disabled = await tx
							.select()
							.from(platformUserDisables)
							.where(eq(platformUserDisables.userId, userId));
						const user = await resolveCurrentPersonalApiUserV1(
							this.options.directory,
							userId,
						);
						if (disabled.length || !user || user.accountStatus !== "active")
							throw new EvaluationDataErrorV1("denied");
						return user.authorizationRevision;
					};
					const revision = await check();
					revalidate = async () => {
						if ((await check()) !== revision) throw unavailable();
					};
					principal = { kind: "user", id: userId };
				} else {
					const material = request.authentication.material;
					if (!/^papi_[A-Za-z0-9_-]{43}$/.test(material))
						throw new EvaluationDataErrorV1("denied");
					const hash = createHash("sha256").update(material).digest("hex");
					const [reference] = await tx
						.select()
						.from(platformApiCredentials)
						.where(eq(platformApiCredentials.credentialHash, hash));
					if (!reference) throw new EvaluationDataErrorV1("denied");
					await tx.execute(
						sql`lock table platform.platform_user_disables in share mode`,
					);
					const check = async () => {
						const [application] =
							reference.principalType === "application"
								? await tx
										.select()
										.from(platformApplications)
										.where(eq(platformApplications.id, reference.principalId))
										.for("share")
								: [];
						const [credential] = await tx
							.select()
							.from(platformApiCredentials)
							.where(eq(platformApiCredentials.credentialHash, hash))
							.for("update");
						if (!credential) throw new EvaluationDataErrorV1("denied");
						const user =
							reference.principalType === "user"
								? await resolveCurrentPersonalApiUserV1(
										this.options.directory,
										reference.principalId,
									)
								: undefined;
						const disabled =
							reference.principalType === "user"
								? (
										await tx
											.select()
											.from(platformUserDisables)
											.where(
												eq(platformUserDisables.userId, reference.principalId),
											)
									).length > 0
								: false;
						// Explicit credential envelope; existing Agent scopes grant no Eval access.
						return requireApiCredentialIdentityV1(
							{
								credential: {
									schemaVersion: 1,
									credentialId: credential.id,
									principal: {
										kind: credential.principalType,
										id: credential.principalId,
									},
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
												authorizationRevision:
													application.authorizationRevision,
											},
										}
									: {}),
								disabled,
								now: await clock(tx),
							},
							"eval:data",
						);
					};
					const identity = await check();
					principal = identity.principal;
					revalidate = async () => {
						if ((await check()).identityRevision !== identity.identityRevision)
							throw unavailable();
					};
				}
				const directory = this.options.directory;
				const operations: EvaluationDataTransactionV1 = {
					async principalExists(principal) {
						if (principal.kind === "application") {
							const [a] = await tx
								.select()
								.from(platformApplications)
								.where(eq(platformApplications.id, principal.id))
								.for("share");
							return a?.status === "active";
						}
						const user = await resolveCurrentPersonalApiUserV1(
							directory,
							principal.id,
						);
						const disabled = await tx
							.select()
							.from(platformUserDisables)
							.where(eq(platformUserDisables.userId, principal.id));
						return user?.accountStatus === "active" && disabled.length === 0;
					},
					now,
					receiptExpiresAt: now.toISOString(),
					authorizationExpiresAt: now.toISOString(),
					principal,
					async bindPolicy(p: EvaluationPolicyV1) {
						const digest = createHash("sha256")
							.update(JSON.stringify(p))
							.digest("hex");
						const [current] = await tx
							.select()
							.from(evaluationPolicies)
							.where(eq(evaluationPolicies.id, "active"))
							.for("update");
						if (
							current &&
							(current.revision > p.revision ||
								(current.revision === p.revision && current.digest !== digest))
						)
							throw unavailable();
						await tx
							.insert(evaluationPolicies)
							.values({ id: "active", revision: p.revision, digest })
							.onConflictDoUpdate({
								target: evaluationPolicies.id,
								set: { revision: p.revision, digest },
							});
					},
					async dataset(id) {
						const [v] = await tx
							.select()
							.from(evaluationDatasets)
							.where(eq(evaluationDatasets.id, id))
							.for("update");
						return v ? decodeDataset(v) : null;
					},
					async datasets() {
						return boundedRows(
							await tx
								.select()
								.from(evaluationDatasets)
								.orderBy(evaluationDatasets.id)
								.limit(1001),
							decodeDataset,
						);
					},
					async saveDataset(v) {
						await tx
							.insert(evaluationDatasets)
							.values({ id: v.datasetId, scope: v.scope, data: v })
							.onConflictDoUpdate({
								target: evaluationDatasets.id,
								set: { data: v },
							});
					},
					async version(id) {
						const [v] = await tx
							.select()
							.from(evaluationVersions)
							.where(eq(evaluationVersions.id, id))
							.for("update");
						return v ? decodeVersion(v) : null;
					},
					async versions(id) {
						return boundedRows(
							await tx
								.select()
								.from(evaluationVersions)
								.where(eq(evaluationVersions.datasetId, id))
								.orderBy(evaluationVersions.id)
								.limit(1001),
							decodeVersion,
						);
					},
					saveVersion: (v) => saveVersion(tx, v),
					async grants(id) {
						return boundedRows(
							await tx
								.select()
								.from(evaluationGrants)
								.where(eq(evaluationGrants.datasetId, id))
								.orderBy(evaluationGrants.id)
								.limit(1001),
							decodeGrant,
						);
					},
					async grant(id) {
						const [v] = await tx
							.select()
							.from(evaluationGrants)
							.where(eq(evaluationGrants.id, id))
							.for("update");
						return v ? decodeGrant(v) : null;
					},
					async saveGrant(v) {
						await tx
							.insert(evaluationGrants)
							.values({ id: v.grantId, datasetId: v.datasetId, data: v })
							.onConflictDoUpdate({
								target: evaluationGrants.id,
								set: { data: v },
							});
					},
					async receipt(key) {
						const [v] = await tx
							.select()
							.from(idempotencyRecords)
							.where(
								eq(
									idempotencyRecords.id,
									`eval:${createHash("sha256").update(key).digest("hex")}`,
								),
							);
						if (!v) return null;
						if (
							v.scopeType !== "evaluation" ||
							v.scopeId !== JSON.stringify(principal) ||
							v.actorId !== principal.id ||
							v.commandType !== "evaluation.command" ||
							v.status !== "completed" ||
							!/^[a-f0-9]{64}$/.test(v.requestDigest)
						)
							throw unavailable();
						const value = v.result as {
							result?: unknown;
							expiresAt?: unknown;
						} | null;
						if (
							!value ||
							typeof value.expiresAt !== "string" ||
							!Number.isFinite(Date.parse(value.expiresAt))
						)
							throw unavailable();
						return {
							digest: v.requestDigest,
							result: value.result,
							expiresAt: value.expiresAt,
						};
					},
					async saveReceipt(key, v) {
						await tx.insert(idempotencyRecords).values({
							id: `eval:${createHash("sha256").update(key).digest("hex")}`,
							scopeType: "evaluation",
							scopeId: JSON.stringify(principal),
							actorId: principal.id,
							commandType: "evaluation.command",
							idempotencyKey: createHash("sha256").update(key).digest("hex"),
							requestDigest: v.digest,
							status: "completed",
							result: { result: v.result, expiresAt: v.expiresAt },
						});
					},
					async audit(action, targetId) {
						await tx.insert(auditEvents).values({
							id: randomUUID(),
							requestId: request.requestId,
							traceId: request.traceId,
							actorType: principal.kind,
							actorId: principal.id,
							action,
							targetType: "evaluation_dataset",
							targetId,
							outcome: "succeeded",
							details: { purpose: "eval", returnedMaterial: false },
						});
					},
					deleteIntent: (v) => enqueueDelete(tx, v, request.traceId),
				};
				const result = await work(operations);
				await revalidate();
				if (Date.parse(operations.authorizationExpiresAt) <= +(await clock(tx)))
					throw new EvaluationDataErrorV1("denied");
				return result;
			});
		} catch (error) {
			if (error instanceof EvaluationDataErrorV1) throw error;
			if (
				error instanceof PersonalApiCredentialErrorV1 &&
				(error.code === "authentication_required" || error.code === "forbidden")
			)
				throw new EvaluationDataErrorV1("denied");
			throw unavailable();
		}
	}
	/** Worker-only metadata sweep; no policy or content authority is needed to fulfill existing expiry. */
	async expired(limit: number) {
		return this.db.transaction(async (tx) => {
			await lock(tx);
			const now = await clock(tx);
			const rows = await tx
				.select()
				.from(evaluationVersions)
				.where(
					sql`${evaluationVersions.expiresAt} <= ${now.toISOString()}::timestamptz and ${evaluationVersions.status} not in ('deleting','deleted')`,
				)
				.limit(limit)
				.for("update");
			for (const row of rows) {
				const v = decodeVersion(row);
				v.status = "deleting";
				v.revision++;
				await saveVersion(tx, v);
				await enqueueDelete(tx, v, `evaluation-expiry:${v.versionId}`);
			}
			// Retain a non-replayable digest tombstone without deleted metadata.
			await tx.execute(
				sql`update platform.idempotency_records set result = jsonb_build_object('expiresAt', result->>'expiresAt') where scope_type='evaluation' and (result->>'expiresAt')::timestamptz <= clock_timestamp()`,
			);
			const retired = await tx
				.select()
				.from(evaluationVersions)
				.where(
					and(
						eq(evaluationVersions.status, "deleted"),
						sql`${evaluationVersions.metadataExpiresAt} <= clock_timestamp()`,
						sql`exists(select 1 from platform.outbox_items o where o.id = 'evaluation-delete:' || ${evaluationVersions.id}::text and o.status = 'succeeded')`,
					),
				)
				.limit(limit)
				.for("update");
			for (const row of retired) {
				await tx
					.update(outboxItems)
					.set({ payload: { versionId: row.id } })
					.where(
						and(
							eq(outboxItems.id, `evaluation-delete:${row.id}`),
							eq(outboxItems.status, "succeeded"),
						),
					);

				for (const grantRow of await tx
					.select()
					.from(evaluationGrants)
					.where(eq(evaluationGrants.datasetId, row.datasetId))
					.for("update")) {
					const grant = decodeGrant(grantRow);
					if (!grant.versionIds.includes(row.id)) continue;
					const versionIds = grant.versionIds.filter((id) => id !== row.id);
					if (!versionIds.length)
						await tx
							.delete(evaluationGrants)
							.where(eq(evaluationGrants.id, grantRow.id));
					else
						await tx
							.update(evaluationGrants)
							.set({
								data: { ...grant, versionIds, revision: grant.revision + 1 },
							})
							.where(eq(evaluationGrants.id, grantRow.id));
				}
				await tx
					.delete(evaluationVersions)
					.where(eq(evaluationVersions.id, row.id));
			}
			await tx.execute(
				sql`delete from platform.evaluation_datasets d where (d.data->>'metadataExpiresAt')::timestamptz <= clock_timestamp() and not exists(select 1 from platform.evaluation_versions v where v.dataset_id=d.id)`,
			);
			const intents = await tx
				.select({ id: outboxItems.id })
				.from(outboxItems)
				.where(
					and(
						eq(outboxItems.operation, "evaluation.content.delete.v1"),
						sql`${outboxItems.status} not in ('succeeded','failed')`,
					),
				)
				.limit(limit);
			return intents.map((v) => v.id);
		});
	}

	async cleanupVersion(
		lease: {
			itemId: string;
			leaseOwner: string;
			deliveryFence: bigint;
			versionId: string;
			objectRef: string;
		},
		work: (v: EvaluationVersionV1) => Promise<void>,
	) {
		const check = async (tx: Tx) => {
			const [item] = await tx
				.select()
				.from(outboxItems)
				.where(eq(outboxItems.id, lease.itemId))
				.for("update");
			const now = await clock(tx);
			if (
				item?.status !== "processing" ||
				item.leaseOwner !== lease.leaseOwner ||
				item.deliveryFence !== lease.deliveryFence ||
				!item.leaseExpiresAt ||
				item.leaseExpiresAt <= now ||
				item.scopeId !== lease.versionId ||
				item.operation !== "evaluation.content.delete.v1" ||
				item.payload.objectRef !== lease.objectRef
			)
				throw unavailable();
			const [row] = await tx
				.select()
				.from(evaluationVersions)
				.where(eq(evaluationVersions.id, lease.versionId))
				.for("update");
			if (!row) throw unavailable();
			const v = decodeVersion(row);
			if (
				v.objectRef !== lease.objectRef ||
				(v.status !== "deleting" && v.status !== "deleted")
			)
				throw unavailable();
			if (v.transferUntil !== null && Date.parse(v.transferUntil) > +now)
				throw unavailable();
			return v;
		};
		const original = await this.db.transaction(async (tx) => {
			await lock(tx);
			return check(tx);
		});
		if (original.status === "deleted") return;
		await work(original);
		await this.db.transaction(async (tx) => {
			await lock(tx);
			const v = await check(tx);
			if (v.revision !== original.revision) throw unavailable();
			v.status = "deleted";
			v.revision++;
			v.descriptor = null;
			v.stored = null;
			v.uploadActor = null;
			v.uploadGrantId = null;
			v.uploadGrantRevision = null;
			v.transferUntil = null;
			await saveVersion(tx, v);
		});
	}
}
