import { createHash, randomUUID } from "node:crypto";
import {
	type EvaluationAnalysisPolicyV1,
	EvaluationDataErrorV1,
	type EvaluationDataStoreV1,
	type EvaluationDataTransactionV1,
	type EvaluationDerivedObjectV1,
	type EvaluationPolicyV1,
	type EvaluationRequestV1,
	type EvaluationVersionV1,
	PersonalApiCredentialErrorV1,
	parseEvaluationAnalysisPolicyV1,
	parseEvaluationDatasetV1,
	parseEvaluationDerivedObjectV1,
	parseEvaluationGrantV1,
	parseEvaluationScoreIntentV1,
	parseEvaluationVersionV1,
	parseTaskPrincipalV1,
	requireApiCredentialIdentityV1,
	resolveCurrentPersonalApiUserV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import { and, eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
	drizzle,
	PostgresJsSession,
	PostgresJsTransaction,
} from "drizzle-orm/postgres-js";
import type { TransactionSql } from "postgres";
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
	evaluationDerivedObjects,
	evaluationGrants,
	evaluationPolicies,
	evaluationVersions,
} from "./schema-evaluation.js";

type Tx = Pick<
	ReturnType<typeof drizzle>,
	"execute" | "select" | "insert" | "update" | "delete"
>;
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
			transaction?: TransactionSql;
			directory?: TaskUserDirectoryV1;
		},
	) {
		this.client = options.transaction
			? undefined
			: postgres(options.databaseUrl, { max: 4 });
		const connection = options.transaction ?? this.client;
		if (!connection) throw unavailable();
		if (options.transaction) {
			const dialect = new PgDialect();
			// Same transaction session adapter as workload reconciliation; no pool or nested begin.
			this.db = new PostgresJsTransaction(
				dialect,
				new PostgresJsSession(
					options.transaction as postgres.Sql & TransactionSql,
					dialect,
					undefined,
				),
				undefined,
			);
		} else this.db = drizzle(connection as postgres.Sql);
	}
	async close() {
		await this.client?.end();
	}
	async transaction<T>(
		request: EvaluationRequestV1,
		work: (tx: EvaluationDataTransactionV1) => Promise<T>,
		identityOnly = false,
	): Promise<T> {
		try {
			const workInTransaction = async (tx: Tx) => {
				await tx.execute(sql`set local statement_timeout='10s'`);
				await tx.execute(sql`set local lock_timeout='5s'`);
				// A short metadata transaction; external object transfer never holds this lock.
				await lock(tx);
				const now = await clock(tx);
				if (!Number.isFinite(+now)) throw unavailable();
				let revalidate: () => Promise<void>;
				let scoreWorkBinding:
					| { datasetId: string; versionId: string }
					| undefined;
				let principal: EvaluationDataTransactionV1["principal"];
				if (request.authentication.kind === "score_work") {
					const work = request.authentication;
					const check = async () => {
						const records = await tx.execute<{ data: unknown }>(
							sql`select s.data from platform.evaluation_score_intents s join platform.outbox_items o on o.id='evaluation-score:'||s.id::text where s.id=${work.intentId}::uuid and o.operation='evaluation.score.v1' and o.status='processing' and o.lease_owner=${work.leaseOwner} and o.delivery_fence=${work.deliveryFence}::bigint and o.lease_expires_at>clock_timestamp() for share of s,o`,
						);
						const record = records[0]?.data;
						if (
							!record ||
							typeof record !== "object" ||
							!("principal" in record)
						)
							throw unavailable();
						const score = parseEvaluationScoreIntentV1(record);
						if (score.id !== work.intentId) throw unavailable();
						scoreWorkBinding = {
							datasetId: score.datasetId,
							versionId: score.versionId,
						};
						const actor = parseTaskPrincipalV1(score.principal);
						await tx.execute(
							sql`lock table platform.platform_user_disables in share mode`,
						);
						if (actor.kind === "user") {
							const user = await resolveCurrentPersonalApiUserV1(
								this.options.directory,
								actor.id,
							);
							const disabled = await tx
								.select()
								.from(platformUserDisables)
								.where(eq(platformUserDisables.userId, actor.id));
							if (!user || disabled.length || user.accountStatus !== "active")
								throw new EvaluationDataErrorV1("denied");
							return { actor, revision: user.authorizationRevision };
						}
						const [app] = await tx
							.select()
							.from(platformApplications)
							.where(eq(platformApplications.id, actor.id))
							.for("share");
						if (!app || app.status !== "active")
							throw new EvaluationDataErrorV1("denied");
						return { actor, revision: app.authorizationRevision };
					};
					const identity = await check();
					principal = identity.actor;
					revalidate = async () => {
						const current = await check();
						if (JSON.stringify(current) !== JSON.stringify(identity))
							throw unavailable();
					};
				} else if (request.authentication.kind === "browser") {
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
							request.credentialScope ?? "eval:data",
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
					scoreWorkBinding,
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
				if (
					!identityOnly &&
					Date.parse(operations.authorizationExpiresAt) <= +(await clock(tx))
				)
					throw new EvaluationDataErrorV1("denied");
				return result;
			};
			return this.options.transaction
				? await workInTransaction(this.db)
				: await this.db.transaction(workInTransaction);
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
	async authenticate(request: EvaluationRequestV1) {
		return this.transaction(request, async (tx) => tx.principal, true);
	}

	/** Worker-only metadata sweep; no policy or content authority is needed to fulfill existing expiry. */
	async expired(limit: number, feedbackPolicy?: EvaluationAnalysisPolicyV1) {
		return this.db.transaction(async (tx) => {
			await lock(tx);
			const now = await clock(tx);
			let feedbackMetadataMs: number | undefined;
			if (feedbackPolicy) {
				try {
					const policy = parseEvaluationAnalysisPolicyV1(feedbackPolicy);
					const checkpoint = await tx.execute<{
						revision: string;
						digest: string;
					}>(
						sql`select revision,digest from platform.evaluation_policies where id='analysis' for share`,
					);
					if (
						checkpoint[0] &&
						+checkpoint[0].revision === policy.revision &&
						checkpoint[0].digest ===
							createHash("sha256")
								.update(JSON.stringify(policy))
								.digest("hex") &&
						Date.parse(policy.validUntil) > +(await clock(tx))
					)
						feedbackMetadataMs = policy.feedbackMetadataMs;
				} catch {
					/* Only previously frozen expiry remains actionable without a current policy. */
				}
			}

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

			const derived = await tx
				.select()
				.from(evaluationDerivedObjects)
				.where(
					sql`${evaluationDerivedObjects.status} not in ('deleting','deleted') and (${evaluationDerivedObjects.expiresAt}<=clock_timestamp() or exists(select 1 from platform.evaluation_versions v where v.id=${evaluationDerivedObjects.versionId} and v.status in ('deleting','deleted')))`,
				)
				.orderBy(
					evaluationDerivedObjects.expiresAt,
					evaluationDerivedObjects.id,
				)
				.limit(limit)
				.for("update");
			for (const row of derived) {
				const value = parseEvaluationDerivedObjectV1(row.data);
				value.status = "deleting";
				await tx
					.update(evaluationDerivedObjects)
					.set({ status: "deleting", data: value })
					.where(eq(evaluationDerivedObjects.id, row.id));
				await tx
					.insert(outboxItems)
					.values({
						id: `evaluation-derived-delete:${row.id}`,
						scopeType: "evaluation",
						scopeId: row.id,
						operation: "evaluation.derived.delete.v1",
						traceId: `evaluation-expiry:${row.id}`,
						payload: { objectId: row.id, objectRef: value.objectRef },
						availableAt: now,
					})
					.onConflictDoNothing();
			}
			await tx.execute(
				sql`delete from platform.idempotency_records where id in(select id from platform.idempotency_records where scope_type='task_feedback' and ((result->>'metadataExpiresAt')::timestamptz<=clock_timestamp() or (${feedbackMetadataMs ?? null}::bigint is not null and (result->>'createdAt')::timestamptz+${feedbackMetadataMs ?? 0}*interval '1 millisecond'<=clock_timestamp())) order by id limit ${limit} for update skip locked)`,
			);
			await tx.execute(
				sql`delete from platform.task_feedback where execution_id in(select execution_id from platform.task_feedback where (metadata_expires_at<=clock_timestamp() or (${feedbackMetadataMs ?? null}::bigint is not null and (data->>'createdAt')::timestamptz+${feedbackMetadataMs ?? 0}*interval '1 millisecond'<=clock_timestamp())) order by metadata_expires_at,execution_id limit ${limit} for update skip locked)`,
			);
			await tx.execute(
				sql`delete from platform.evaluation_score_reviews where (data->>'metadataExpiresAt')::timestamptz<=clock_timestamp()`,
			);
			await tx.execute(
				sql`delete from platform.outbox_items o where o.operation='evaluation.score.v1' and exists(select 1 from platform.evaluation_score_intents s where o.scope_id=s.id::text and (s.data->>'metadataExpiresAt')::timestamptz<=clock_timestamp() and not exists(select 1 from platform.evaluation_score_reviews r where r.score_id=s.id))`,
			);
			await tx.execute(
				sql`delete from platform.evaluation_score_intents s where (s.data->>'metadataExpiresAt')::timestamptz<=clock_timestamp() and not exists(select 1 from platform.evaluation_score_reviews r where r.score_id=s.id)`,
			);
			await tx.execute(
				sql`with retired as (delete from platform.evaluation_derived_objects d where d.status='deleted' and d.metadata_expires_at<=clock_timestamp() and exists(select 1 from platform.outbox_items o where o.id='evaluation-derived-delete:'||d.id::text and o.status='succeeded') returning id) delete from platform.outbox_items where id in(select 'evaluation-derived-delete:'||id::text from retired)`,
			);
			// Retire the entire Eval receipt, including principal, request digest and timestamps.
			await tx.execute(
				sql`delete from platform.idempotency_records where scope_type='evaluation' and (result->>'expiresAt')::timestamptz <= clock_timestamp()`,
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
				const children = await tx
					.select({ id: evaluationDerivedObjects.id })
					.from(evaluationDerivedObjects)
					.where(eq(evaluationDerivedObjects.versionId, row.id))
					.limit(1);
				if (children.length) continue;
				await tx.execute(
					sql`delete from platform.evaluation_sample_tasks s where exists(select 1 from platform.evaluation_experiments e where e.id=s.experiment_id and e.version_id=${row.id}) and not exists(select 1 from platform.evaluation_score_intents i where i.sample_task_id=s.id)`,
				);
				await tx.execute(
					sql`delete from platform.evaluation_experiments e where e.version_id=${row.id} and not exists(select 1 from platform.evaluation_sample_tasks s where s.experiment_id=e.id)`,
				);
				const remaining = await tx.execute(
					sql`select id from platform.evaluation_experiments where version_id=${row.id} limit 1`,
				);
				if (remaining.length) continue;
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
			const decisionAt = (await clock(tx)).toISOString();
			const intents = await tx
				.select({ id: outboxItems.id })
				.from(outboxItems)
				.where(
					and(
						sql`${outboxItems.operation} in ('evaluation.content.delete.v1','evaluation.derived.delete.v1')`,
						// Match outbox.claim eligibility before the batch limit; claim still fences atomically.
						sql`((${outboxItems.status} in ('pending','retry_scheduled') and ${outboxItems.availableAt} <= ${decisionAt}::timestamptz)
 or (${outboxItems.status} = 'processing' and ${outboxItems.leaseExpiresAt} <= ${decisionAt}::timestamptz))`,
					),
				)
				.orderBy(
					sql`case when ${outboxItems.status} = 'processing' then ${outboxItems.leaseExpiresAt} else ${outboxItems.availableAt} end`,
					outboxItems.id,
				)
				.limit(limit);
			return intents.map((v) => v.id);
		});
	}

	async cleanupDerived(
		lease: {
			itemId: string;
			leaseOwner: string;
			deliveryFence: bigint;
			versionId: string;
			objectRef: string;
		},
		work: (value: EvaluationDerivedObjectV1) => Promise<void>,
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
				item.operation !== "evaluation.derived.delete.v1" ||
				item.scopeId !== lease.versionId ||
				item.leaseOwner !== lease.leaseOwner ||
				item.deliveryFence !== lease.deliveryFence ||
				!item.leaseExpiresAt ||
				item.leaseExpiresAt <= now ||
				item.payload.objectRef !== lease.objectRef
			)
				throw unavailable();
			const [row] = await tx
				.select()
				.from(evaluationDerivedObjects)
				.where(eq(evaluationDerivedObjects.id, lease.versionId))
				.for("update");
			if (!row) throw unavailable();
			const value = parseEvaluationDerivedObjectV1(row.data);
			if (
				value.objectRef !== lease.objectRef ||
				!["deleting", "deleted"].includes(value.status) ||
				Date.parse(value.transferUntil) > +now
			)
				throw unavailable();
			return value;
		};
		const original = await this.db.transaction(check);
		if (original.status === "deleted") return;
		await work(original);
		await this.db.transaction(async (tx) => {
			const value = await check(tx);
			if (JSON.stringify(value) !== JSON.stringify(original))
				throw unavailable();
			value.status = "deleted";
			value.stored = null;
			await tx
				.update(evaluationDerivedObjects)
				.set({ status: "deleted", data: value })
				.where(eq(evaluationDerivedObjects.id, value.id));
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
