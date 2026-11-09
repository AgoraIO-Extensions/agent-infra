import { randomUUID } from "node:crypto";
import {
	PersonalApiCredentialErrorV1,
	type TaskUserDirectoryV1,
	WorkspaceSnapshotErrorV1,
	type WorkspaceSnapshotPrincipalV1,
	type WorkspaceSnapshotQuotaReaderV1,
	type WorkspaceSnapshotRecordV1,
	type WorkspaceSnapshotUploadPolicyV1,
	type WorkspaceSnapshotUploadReservationV1,
	type WorkspaceSnapshotUploadStoreV1,
	workspaceSnapshotLimitsV1,
} from "@agent-infra/platform-core";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { resolveAgentApiIdentityV1 } from "./agent-api-identity.js";
import postgres from "./observed-postgres.js";
import {
	auditEvents,
	idempotencyRecords,
	platformApiCredentials,
	workspaceSnapshotBindings,
	workspaceSnapshots,
	workspaceSnapshotUploadReservations,
} from "./schema.js";
import {
	admitWorkspaceSnapshotUploadV1,
	releaseWorkspaceSnapshotUploadAdmissionV1,
} from "./workspace-snapshot-upload-admission.js";

type Transaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];
type Reader = Pick<Transaction, "select">;
type Row = typeof workspaceSnapshots.$inferSelect;
type Scope = "agent:create" | "agent:read" | "agent:manage";
type Authorization = {
	material: string;
	directory?: TaskUserDirectoryV1;
	requestId: string;
	traceId: string;
};
const scopeType = "workspace_snapshot_upload";
const commandType = "workspace_snapshot.upload.v1";
const validText = (value: unknown): value is string =>
	typeof value === "string" &&
	value.length > 0 &&
	value.length <= 1024 &&
	!value.includes("\0") &&
	value.isWellFormed();
function ownerKey(owner: WorkspaceSnapshotPrincipalV1) {
	if (!["user", "application"].includes(owner.kind) || !validText(owner.id))
		throw new WorkspaceSnapshotErrorV1("invalid_input");
	return JSON.stringify([owner.kind, owner.id]);
}
function owned(owner: WorkspaceSnapshotPrincipalV1) {
	return and(
		eq(workspaceSnapshots.ownerType, owner.kind),
		eq(workspaceSnapshots.ownerId, owner.id),
	);
}
function replayWhere(owner: WorkspaceSnapshotPrincipalV1, key: string) {
	if (!/^[A-Za-z0-9._~-]{1,128}$/.test(key))
		throw new WorkspaceSnapshotErrorV1("invalid_input");
	return and(
		eq(idempotencyRecords.scopeType, scopeType),
		eq(idempotencyRecords.scopeId, ownerKey(owner)),
		eq(idempotencyRecords.actorId, owner.id),
		eq(idempotencyRecords.commandType, commandType),
		eq(idempotencyRecords.idempotencyKey, key),
	);
}
async function record(
	database: Reader,
	row: Row,
): Promise<WorkspaceSnapshotRecordV1> {
	const bindings = await database
		.select({
			agentId: workspaceSnapshotBindings.agentId,
			configurationRevision: workspaceSnapshotBindings.configurationRevision,
			name: workspaceSnapshotBindings.name,
			digest: workspaceSnapshotBindings.digest,
			sizeBytes: workspaceSnapshotBindings.sizeBytes,
		})
		.from(workspaceSnapshotBindings)
		.where(eq(workspaceSnapshotBindings.snapshotId, row.id))
		.orderBy(
			asc(workspaceSnapshotBindings.agentId),
			asc(workspaceSnapshotBindings.configurationRevision),
			asc(workspaceSnapshotBindings.name),
		);
	return {
		snapshotId: row.id,
		ownerType: row.ownerType as "user" | "application",
		ownerId: row.ownerId,
		digest: row.digest,
		sizeBytes: row.sizeBytes,
		unpackedSizeBytes: row.unpackedSizeBytes,
		fileCount: row.fileCount,
		mediaType: "application/x-tar+gzip",
		source: row.source,
		objectRef: row.objectRef,
		objectVersion: row.objectVersion,
		status: row.status as WorkspaceSnapshotRecordV1["status"],
		createdAt: row.createdAt.toISOString(),
		bindings,
	};
}
async function usage(database: Reader, owner: WorkspaceSnapshotPrincipalV1) {
	const [row] = await database
		.select({
			total: sql<string>`coalesce(sum(${workspaceSnapshots.sizeBytes}), 0)`,
		})
		.from(workspaceSnapshots)
		.where(and(owned(owner), ne(workspaceSnapshots.status, "deleted")));
	const total = Number(row?.total);
	if (!Number.isSafeInteger(total) || total < 0)
		throw new WorkspaceSnapshotErrorV1("unavailable");
	return total;
}

async function activeReservationUsage(
	database: Reader,
	owner: WorkspaceSnapshotPrincipalV1,
	excludeId?: string,
) {
	const [row] = await database
		.select({
			total: sql<string>`coalesce(sum(${workspaceSnapshotUploadReservations.reservedBytes}), 0)`,
		})
		.from(workspaceSnapshotUploadReservations)
		.where(
			and(
				eq(workspaceSnapshotUploadReservations.ownerType, owner.kind),
				eq(workspaceSnapshotUploadReservations.ownerId, owner.id),
				sql`(${workspaceSnapshotUploadReservations.status} = 'reserved' or (${workspaceSnapshotUploadReservations.status} = 'expired' and ${workspaceSnapshotUploadReservations.objectRef} is not null))`,
				...(excludeId
					? [sql`${workspaceSnapshotUploadReservations.id} <> ${excludeId}`]
					: []),
			),
		);
	const total = Number(row?.total);
	if (!Number.isSafeInteger(total) || total < 0)
		throw new WorkspaceSnapshotErrorV1("unavailable");
	return total;
}
async function replay(
	database: Reader,
	owner: WorkspaceSnapshotPrincipalV1,
	key: string,
) {
	const [receipt] = await database
		.select()
		.from(idempotencyRecords)
		.where(replayWhere(owner, key))
		.limit(1);
	if (!receipt) return null;
	if (receipt.status !== "completed" || !validText(receipt.result?.snapshotId))
		throw new WorkspaceSnapshotErrorV1("unavailable");
	const [row] = await database
		.select()
		.from(workspaceSnapshots)
		.where(
			and(owned(owner), eq(workspaceSnapshots.id, receipt.result.snapshotId)),
		)
		.limit(1);
	if (!row) throw new WorkspaceSnapshotErrorV1("unavailable");
	return {
		requestDigest: receipt.requestDigest,
		record: await record(database, row),
	};
}
function validateUpload(
	value: WorkspaceSnapshotRecordV1,
	owner: WorkspaceSnapshotPrincipalV1,
	requestDigest: string,
) {
	if (
		value.ownerType !== owner.kind ||
		value.ownerId !== owner.id ||
		value.status !== "ready" ||
		value.bindings.length !== 0 ||
		value.mediaType !== "application/x-tar+gzip" ||
		!validText(value.snapshotId) ||
		!validText(value.objectRef) ||
		!validText(value.objectVersion) ||
		!/^sha256:[a-f0-9]{64}$/.test(value.digest) ||
		!/^[a-f0-9]{64}$/.test(requestDigest)
	)
		throw new WorkspaceSnapshotErrorV1("invalid_input");
	if (
		![value.sizeBytes, value.unpackedSizeBytes, value.fileCount].every(
			(n) => Number.isSafeInteger(n) && n > 0,
		)
	)
		throw new WorkspaceSnapshotErrorV1("invalid_input");
	if (
		value.sizeBytes > workspaceSnapshotLimitsV1.maxArchiveBytes ||
		value.unpackedSizeBytes > workspaceSnapshotLimitsV1.maxUnpackedBytes ||
		value.fileCount > workspaceSnapshotLimitsV1.maxFiles
	)
		throw new WorkspaceSnapshotErrorV1("quota_exceeded");
}

/** Metadata publication, quota and audit share a short transaction; object I/O stays outside it. */
export class PostgresWorkspaceSnapshotUploadStoreV1
	implements WorkspaceSnapshotUploadStoreV1, WorkspaceSnapshotQuotaReaderV1
{
	readonly #client;
	readonly #database;
	constructor(databaseUrl: string) {
		this.#client = postgres(databaseUrl, { max: 4 });
		this.#database = drizzle(this.#client);
	}
	admitUpload(
		owner: WorkspaceSnapshotPrincipalV1,
		policy: WorkspaceSnapshotUploadPolicyV1,
	) {
		return this.#admitUpload(owner, policy);
	}
	releaseUploadAdmission(owner: WorkspaceSnapshotPrincipalV1, leaseId: string) {
		return this.#releaseUploadAdmission(owner, leaseId);
	}
	#admitUpload(
		owner: WorkspaceSnapshotPrincipalV1,
		policy: WorkspaceSnapshotUploadPolicyV1,
		auth?: Authorization,
	) {
		return this.#run(owner, "agent:create", auth, (tx) =>
			admitWorkspaceSnapshotUploadV1(tx, owner, policy),
		);
	}
	#releaseUploadAdmission(
		owner: WorkspaceSnapshotPrincipalV1,
		leaseId: string,
	) {
		// A server-held lease only releases accounting; revoked credentials cannot block cleanup.
		return this.#run(owner, "agent:create", undefined, (tx) =>
			releaseWorkspaceSnapshotUploadAdmissionV1(tx, owner, leaseId),
		);
	}
	reserveUpload(
		owner: WorkspaceSnapshotPrincipalV1,
		key: string,
		digest: string,
		bytes: number,
		expiresAt: string,
	) {
		return this.#reserveUpload(owner, key, digest, bytes, expiresAt);
	}
	releaseUploadReservation(
		owner: WorkspaceSnapshotPrincipalV1,
		reservationId: string,
	) {
		return this.#releaseUploadReservation(owner, reservationId);
	}
	attachUploadObject(
		owner: WorkspaceSnapshotPrincipalV1,
		reservationId: string,
		objectRef: string,
		objectVersion: string,
	) {
		return this.#attachUploadObject(
			owner,
			reservationId,
			objectRef,
			objectVersion,
		);
	}
	async collectExpiredUploadReservations(input: {
		now: Date;
		limit?: number;
		deleter: {
			deleteObjectVersion(input: {
				objectRef: string;
				objectVersion: string;
			}): Promise<void>;
		};
	}) {
		const limit = input.limit ?? 100;
		if (
			!Number.isFinite(input.now.getTime()) ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 1000
		)
			throw new WorkspaceSnapshotErrorV1("invalid_input");
		const candidates = await this.#database
			.select()
			.from(workspaceSnapshotUploadReservations)
			.where(
				sql`${workspaceSnapshotUploadReservations.status} in ('reserved','expired') and ${workspaceSnapshotUploadReservations.expiresAt} <= ${input.now.toISOString()} and ${workspaceSnapshotUploadReservations.releasedAt} is null`,
			)
			.orderBy(
				asc(workspaceSnapshotUploadReservations.updatedAt),
				asc(workspaceSnapshotUploadReservations.expiresAt),
				asc(workspaceSnapshotUploadReservations.id),
			)
			.limit(limit);
		const result = {
			scanned: candidates.length,
			released: 0,
			reconciled: 0,
			failed: 0,
		};
		for (const candidate of candidates) {
			try {
				const outcome = await this.#run(
					{
						kind: candidate.ownerType as WorkspaceSnapshotPrincipalV1["kind"],
						id: candidate.ownerId,
						scopes: [],
					},
					"agent:create",
					undefined,
					async (tx) => {
						const [current] = await tx
							.select()
							.from(workspaceSnapshotUploadReservations)
							.where(
								and(
									eq(workspaceSnapshotUploadReservations.id, candidate.id),
									sql`${workspaceSnapshotUploadReservations.status} in ('reserved','expired')`,
									sql`${workspaceSnapshotUploadReservations.expiresAt} <= ${input.now.toISOString()} and ${workspaceSnapshotUploadReservations.expiresAt} <= clock_timestamp()`,
								),
							)
							.for("update")
							.limit(1);
						if (!current) return "skipped";
						if (current.objectRef && current.objectVersion) {
							await tx.execute(
								sql`select pg_advisory_xact_lock(hashtextextended(${current.objectRef} || ':' || ${current.objectVersion}, 0))`,
							);
							const [published] = await tx
								.select({ id: workspaceSnapshots.id })
								.from(workspaceSnapshots)
								.where(
									and(
										eq(workspaceSnapshots.objectRef, current.objectRef),
										eq(workspaceSnapshots.objectVersion, current.objectVersion),
										ne(workspaceSnapshots.status, "deleted"),
									),
								)
								.limit(1);
							if (published) {
								const completed = await replay(
									tx,
									{
										kind: current.ownerType as WorkspaceSnapshotPrincipalV1["kind"],
										id: current.ownerId,
										scopes: [],
									},
									current.idempotencyKey,
								);
								if (
									!completed ||
									completed.requestDigest !== current.requestDigest ||
									completed.record.objectRef !== current.objectRef ||
									completed.record.objectVersion !== current.objectVersion
								)
									throw new WorkspaceSnapshotErrorV1("conflict");
								await tx
									.update(workspaceSnapshotUploadReservations)
									.set({
										status: "completed",
										snapshotId: completed.record.snapshotId,
										updatedAt: new Date(),
									})
									.where(
										eq(workspaceSnapshotUploadReservations.id, current.id),
									);
								return "reconciled";
							}
							await input.deleter.deleteObjectVersion({
								objectRef: current.objectRef,
								objectVersion: current.objectVersion,
							});
						}
						await tx
							.update(workspaceSnapshotUploadReservations)
							.set({
								status: "expired",
								objectRef: null,
								objectVersion: null,
								releasedAt: new Date(),
								updatedAt: new Date(),
							})
							.where(eq(workspaceSnapshotUploadReservations.id, current.id));
						return "released";
					},
				);
				if (outcome === "released") result.released++;
				if (outcome === "reconciled") result.reconciled++;
			} catch {
				result.failed++;
				try {
					await this.#run(
						{
							kind: candidate.ownerType as WorkspaceSnapshotPrincipalV1["kind"],
							id: candidate.ownerId,
							scopes: [],
						},
						"agent:create",
						undefined,
						async (tx) => {
							await tx
								.update(workspaceSnapshotUploadReservations)
								.set({ updatedAt: sql`clock_timestamp()` })
								.where(
									and(
										eq(workspaceSnapshotUploadReservations.id, candidate.id),
										sql`${workspaceSnapshotUploadReservations.status} in ('reserved','expired')`,
									),
								);
						},
					);
				} catch {
					// A database outage keeps the original quota and retries next tick.
				}
			}
		}
		return result;
	}

	/** Captures request authentication in closures, never in metadata/records or persisted payloads. */
	forCredential(
		material: string,
		directory?: TaskUserDirectoryV1,
		metadata: { requestId: string; traceId: string } = {
			requestId: randomUUID(),
			traceId: randomUUID(),
		},
	) {
		const auth: Authorization = { material, directory, ...metadata };
		return {
			credentials: {
				resolve: async (_material: string, scope: Scope = "agent:create") =>
					this.#resolve(auth, scope),
			},
			store: {
				admitUpload: (
					owner: WorkspaceSnapshotPrincipalV1,
					policy: WorkspaceSnapshotUploadPolicyV1,
				) => this.#admitUpload(owner, policy, auth),
				releaseUploadAdmission: (
					owner: WorkspaceSnapshotPrincipalV1,
					leaseId: string,
				) => this.#releaseUploadAdmission(owner, leaseId),
				reserveUpload: (
					owner: WorkspaceSnapshotPrincipalV1,
					key: string,
					digest: string,
					bytes: number,
					expiresAt: string,
				) => this.#reserveUpload(owner, key, digest, bytes, expiresAt, auth),
				releaseUploadReservation: (
					owner: WorkspaceSnapshotPrincipalV1,
					reservationId: string,
				) => this.#releaseUploadReservation(owner, reservationId),
				attachUploadObject: (
					owner: WorkspaceSnapshotPrincipalV1,
					reservationId: string,
					objectRef: string,
					objectVersion: string,
				) =>
					this.#attachUploadObject(
						owner,
						reservationId,
						objectRef,
						objectVersion,
						auth,
					),
				findIdempotency: (owner: WorkspaceSnapshotPrincipalV1, key: string) =>
					this.#find(owner, key, auth),
				create: (
					value: WorkspaceSnapshotRecordV1,
					owner: WorkspaceSnapshotPrincipalV1,
					key: string,
					digest: string,
					reservationId?: string,
				) => this.#create(value, owner, key, digest, auth, reservationId),
				list: (owner: WorkspaceSnapshotPrincipalV1) => this.#list(owner, auth),
				get: (owner: WorkspaceSnapshotPrincipalV1, id: string) =>
					this.#get(owner, id, auth),
				remove: (owner: WorkspaceSnapshotPrincipalV1, id: string) =>
					this.#remove(owner, id, auth),
				finishDeletion: (
					owner: WorkspaceSnapshotPrincipalV1,
					id: string,
					version: string,
				) => this.#finishDeletion(owner, id, version, auth),
			},
			quota: {
				read: (owner: WorkspaceSnapshotPrincipalV1) => this.#usage(owner, auth),
			},
		};
	}
	async #resolve(
		auth: Authorization,
		scope: Scope,
	): Promise<WorkspaceSnapshotPrincipalV1> {
		return this.#database.transaction(async (tx) => {
			const current = await resolveAgentApiIdentityV1(
				tx,
				auth.material,
				auth.directory,
				scope,
			);
			await current.revalidate();
			return {
				...current.identity.principal,
				scopes: current.identity.credential.scopes,
			};
		});
	}
	async #run<T>(
		owner: WorkspaceSnapshotPrincipalV1,
		scope: Scope,
		auth: Authorization | undefined,
		work: (tx: Transaction) => Promise<T>,
	): Promise<T> {
		ownerKey(owner);
		try {
			return await this.#database.transaction(async (tx) => {
				await tx.execute(sql`set local lock_timeout = '5s'`);
				await tx.execute(sql`set local statement_timeout = '30s'`);
				const current = auth
					? await resolveAgentApiIdentityV1(
							tx,
							auth.material,
							auth.directory,
							scope,
						)
					: undefined;
				if (
					current &&
					(current.identity.principal.kind !== owner.kind ||
						current.identity.principal.id !== owner.id)
				)
					throw new WorkspaceSnapshotErrorV1("not_found");
				await tx.execute(
					sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["workspace_snapshot", owner.kind, owner.id])}, 0))`,
				);
				const result = await work(tx);
				if (current) {
					await tx
						.update(platformApiCredentials)
						.set({ lastUsedAt: new Date() })
						.where(
							eq(
								platformApiCredentials.id,
								current.identity.credential.credentialId,
							),
						);
					await current.revalidate();
				}
				return result;
			});
		} catch (error) {
			if (
				error instanceof WorkspaceSnapshotErrorV1 ||
				error instanceof PersonalApiCredentialErrorV1
			)
				throw error;
			throw new WorkspaceSnapshotErrorV1("unavailable");
		}
	}
	async #audit(
		tx: Transaction,
		owner: WorkspaceSnapshotPrincipalV1,
		action: string,
		id: string,
		auth?: Authorization,
		details: Record<string, unknown> = {},
	) {
		await tx.insert(auditEvents).values({
			id: randomUUID(),
			traceId: auth?.traceId ?? randomUUID(),
			requestId: auth?.requestId ?? randomUUID(),
			actorType: owner.kind,
			actorId: owner.id,
			action,
			targetType: "workspace_snapshot",
			targetId: id,
			outcome: "succeeded",
			details,
		});
	}
	findIdempotency(owner: WorkspaceSnapshotPrincipalV1, key: string) {
		return this.#find(owner, key);
	}
	#find(
		owner: WorkspaceSnapshotPrincipalV1,
		key: string,
		auth?: Authorization,
	) {
		return this.#run(owner, "agent:create", auth, (tx) =>
			replay(tx, owner, key),
		);
	}
	create(
		value: WorkspaceSnapshotRecordV1,
		owner: WorkspaceSnapshotPrincipalV1,
		key: string,
		digest: string,
		reservationId?: string,
	) {
		return this.#create(value, owner, key, digest, undefined, reservationId);
	}
	async #reserveUpload(
		owner: WorkspaceSnapshotPrincipalV1,
		key: string,
		digest: string,
		bytes: number,
		expiresAt: string,
		auth?: Authorization,
	): Promise<WorkspaceSnapshotUploadReservationV1> {
		if (
			!/^[A-Za-z0-9._~-]{1,128}$/.test(key) ||
			!/^[a-f0-9]{64}$/.test(digest) ||
			!Number.isSafeInteger(bytes) ||
			bytes <= 0 ||
			bytes > workspaceSnapshotLimitsV1.maxArchiveBytes ||
			!Number.isFinite(Date.parse(expiresAt))
		)
			throw new WorkspaceSnapshotErrorV1("invalid_input");
		return this.#run(owner, "agent:create", auth, async (tx) => {
			const clock = await tx.execute<{ now: string }>(
				sql`select clock_timestamp() as now`,
			);
			const currentTime = new Date(clock[0]?.now ?? "").getTime();
			if (!Number.isFinite(currentTime))
				throw new WorkspaceSnapshotErrorV1("unavailable");
			const currentTimeIso = new Date(currentTime).toISOString();
			if (Date.parse(expiresAt) <= currentTime)
				throw new WorkspaceSnapshotErrorV1("invalid_input");
			await tx
				.update(workspaceSnapshotUploadReservations)
				.set({
					status: "expired",
					releasedAt: sql`case when ${workspaceSnapshotUploadReservations.objectRef} is null then clock_timestamp() else null end`,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(workspaceSnapshotUploadReservations.ownerType, owner.kind),
						eq(workspaceSnapshotUploadReservations.ownerId, owner.id),
						eq(workspaceSnapshotUploadReservations.status, "reserved"),
						sql`${workspaceSnapshotUploadReservations.expiresAt} <= ${currentTimeIso}`,
					),
				);
			const [existing] = await tx
				.select()
				.from(workspaceSnapshotUploadReservations)
				.where(
					and(
						eq(workspaceSnapshotUploadReservations.ownerType, owner.kind),
						eq(workspaceSnapshotUploadReservations.ownerId, owner.id),
						eq(workspaceSnapshotUploadReservations.idempotencyKey, key),
					),
				)
				.for("update")
				.limit(1);
			const completed = await replay(tx, owner, key);
			if (completed) {
				if (completed.requestDigest !== digest) return { state: "conflict" };
				return { state: "completed" };
			}
			if (existing) {
				if (existing.requestDigest !== digest) return { state: "conflict" };
				if (existing.status === "completed") return { state: "completed" };
				if (existing.status === "reserved") return { state: "in_progress" };
				if (existing.objectRef) return { state: "conflict" };
				const total =
					(await usage(tx, owner)) +
					(await activeReservationUsage(tx, owner, existing.id)) +
					bytes;
				if (total > workspaceSnapshotLimitsV1.maxOwnerBytes)
					throw new WorkspaceSnapshotErrorV1("quota_exceeded");
				const reservationId = randomUUID();
				await tx
					.update(workspaceSnapshotUploadReservations)
					.set({
						id: reservationId,
						reservedBytes: bytes,
						status: "reserved",
						createdAt: new Date(),
						expiresAt: new Date(expiresAt),
						updatedAt: new Date(),
						releasedAt: null,
					})
					.where(eq(workspaceSnapshotUploadReservations.id, existing.id));
				return { state: "reserved", reservationId };
			}
			const total =
				(await usage(tx, owner)) +
				(await activeReservationUsage(tx, owner)) +
				bytes;
			if (total > workspaceSnapshotLimitsV1.maxOwnerBytes)
				throw new WorkspaceSnapshotErrorV1("quota_exceeded");
			const id = randomUUID();
			await tx.insert(workspaceSnapshotUploadReservations).values({
				id,
				ownerType: owner.kind,
				ownerId: owner.id,
				idempotencyKey: key,
				requestDigest: digest,
				reservedBytes: bytes,
				status: "reserved",
				expiresAt: new Date(expiresAt),
			});
			return { state: "reserved", reservationId: id };
		});
	}
	#releaseUploadReservation(
		owner: WorkspaceSnapshotPrincipalV1,
		reservationId: string,
	) {
		// The server-held lease permits cleanup after revocation, never publication.
		return this.#run(owner, "agent:create", undefined, async (tx) => {
			await tx
				.update(workspaceSnapshotUploadReservations)
				.set({
					status: "released",
					releasedAt: new Date(),
					updatedAt: new Date(),
					objectRef: null,
					objectVersion: null,
				})
				.where(
					and(
						eq(workspaceSnapshotUploadReservations.id, reservationId),
						eq(workspaceSnapshotUploadReservations.ownerType, owner.kind),
						eq(workspaceSnapshotUploadReservations.ownerId, owner.id),
						sql`${workspaceSnapshotUploadReservations.status} in ('reserved','expired')`,
					),
				);
		});
	}
	#attachUploadObject(
		owner: WorkspaceSnapshotPrincipalV1,
		reservationId: string,
		objectRef: string,
		objectVersion: string,
		auth?: Authorization,
	) {
		if (!validText(objectRef) || !validText(objectVersion))
			throw new WorkspaceSnapshotErrorV1("invalid_input");
		return this.#run(owner, "agent:create", auth, async (tx) => {
			const updated = await tx
				.update(workspaceSnapshotUploadReservations)
				.set({ objectRef, objectVersion, updatedAt: new Date() })
				.where(
					and(
						eq(workspaceSnapshotUploadReservations.id, reservationId),
						eq(workspaceSnapshotUploadReservations.ownerType, owner.kind),
						eq(workspaceSnapshotUploadReservations.ownerId, owner.id),
						eq(workspaceSnapshotUploadReservations.status, "reserved"),
						sql`${workspaceSnapshotUploadReservations.expiresAt} > clock_timestamp()`,
						sql`(${workspaceSnapshotUploadReservations.objectRef} is null or (${workspaceSnapshotUploadReservations.objectRef} = ${objectRef} and ${workspaceSnapshotUploadReservations.objectVersion} = ${objectVersion}))`,
					),
				)
				.returning({ id: workspaceSnapshotUploadReservations.id });
			if (!updated[0]) throw new WorkspaceSnapshotErrorV1("unavailable");
		});
	}
	#create(
		value: WorkspaceSnapshotRecordV1,
		owner: WorkspaceSnapshotPrincipalV1,
		key: string,
		digest: string,
		auth?: Authorization,
		reservationId?: string,
	) {
		validateUpload(value, owner, digest);
		return this.#run(owner, "agent:create", auth, async (tx) => {
			const existing = await replay(tx, owner, key);
			if (existing) {
				if (existing.requestDigest !== digest)
					throw new WorkspaceSnapshotErrorV1("conflict");
				return existing.record;
			}
			if (
				!reservationId &&
				(await usage(tx, owner)) +
					(await activeReservationUsage(tx, owner)) +
					value.sizeBytes >
					workspaceSnapshotLimitsV1.maxOwnerBytes
			)
				throw new WorkspaceSnapshotErrorV1("quota_exceeded");
			if (reservationId) {
				const [reservation] = await tx
					.select()
					.from(workspaceSnapshotUploadReservations)
					.where(
						and(
							eq(workspaceSnapshotUploadReservations.id, reservationId),
							eq(workspaceSnapshotUploadReservations.ownerType, owner.kind),
							eq(workspaceSnapshotUploadReservations.ownerId, owner.id),
							eq(workspaceSnapshotUploadReservations.idempotencyKey, key),
							eq(workspaceSnapshotUploadReservations.status, "reserved"),
							eq(workspaceSnapshotUploadReservations.requestDigest, digest),
							sql`${workspaceSnapshotUploadReservations.expiresAt} > clock_timestamp()`,
							eq(
								workspaceSnapshotUploadReservations.objectRef,
								value.objectRef,
							),
							eq(
								workspaceSnapshotUploadReservations.objectVersion,
								value.objectVersion,
							),
						),
					)
					.for("update")
					.limit(1);
				if (!reservation) throw new WorkspaceSnapshotErrorV1("conflict");
				if (value.sizeBytes > reservation.reservedBytes)
					throw new WorkspaceSnapshotErrorV1("quota_exceeded");
			}
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtextextended(${value.objectRef} || ':' || ${value.objectVersion}, 0))`,
			);
			const [retired] = await tx
				.select({ id: workspaceSnapshots.id })
				.from(workspaceSnapshots)
				.where(
					sql`${workspaceSnapshots.objectRef} = ${value.objectRef} and ${workspaceSnapshots.objectVersion} = ${value.objectVersion} and ${workspaceSnapshots.status} in ('deleting', 'deleted')`,
				)
				.limit(1);
			if (retired) throw new WorkspaceSnapshotErrorV1("conflict");
			const [row] = await tx
				.insert(workspaceSnapshots)
				.values({
					id: value.snapshotId,
					ownerType: owner.kind,
					ownerId: owner.id,
					digest: value.digest,
					sizeBytes: value.sizeBytes,
					unpackedSizeBytes: value.unpackedSizeBytes,
					fileCount: value.fileCount,
					mediaType: value.mediaType,
					source: value.source,
					objectRef: value.objectRef,
					objectVersion: value.objectVersion,
					status: "ready",
				})
				.returning();
			if (!row) throw new WorkspaceSnapshotErrorV1("unavailable");
			await tx.insert(idempotencyRecords).values({
				id: randomUUID(),
				scopeType,
				scopeId: ownerKey(owner),
				actorId: owner.id,
				commandType,
				idempotencyKey: key,
				requestDigest: digest,
				status: "completed",
				result: { snapshotId: row.id },
			});
			await this.#audit(
				tx,
				owner,
				"workspace.snapshot.uploaded",
				row.id,
				auth,
				{
					digest: row.digest,
					sizeBytes: row.sizeBytes,
					source: row.source,
				},
			);
			if (reservationId)
				await tx
					.update(workspaceSnapshotUploadReservations)
					.set({
						status: "completed",
						snapshotId: row.id,
						updatedAt: new Date(),
					})
					.where(eq(workspaceSnapshotUploadReservations.id, reservationId));
			return record(tx, row);
		});
	}
	list(owner: WorkspaceSnapshotPrincipalV1) {
		return this.#list(owner);
	}
	#list(owner: WorkspaceSnapshotPrincipalV1, auth?: Authorization) {
		return this.#run(owner, "agent:read", auth, async (tx) => {
			const rows = await tx
				.select()
				.from(workspaceSnapshots)
				.where(and(owned(owner), ne(workspaceSnapshots.status, "deleted")))
				.orderBy(asc(workspaceSnapshots.id));
			await this.#audit(
				tx,
				owner,
				"workspace.snapshot.metadata.read",
				ownerKey(owner),
				auth,
				{ count: rows.length },
			);
			return Promise.all(rows.map((row) => record(tx, row)));
		});
	}
	get(owner: WorkspaceSnapshotPrincipalV1, id: string) {
		return this.#get(owner, id);
	}
	#get(owner: WorkspaceSnapshotPrincipalV1, id: string, auth?: Authorization) {
		return this.#run(owner, "agent:read", auth, async (tx) => {
			const [row] = await tx
				.select()
				.from(workspaceSnapshots)
				.where(and(owned(owner), eq(workspaceSnapshots.id, id)))
				.limit(1);
			if (!row) return null;
			await this.#audit(
				tx,
				owner,
				"workspace.snapshot.metadata.read",
				row.id,
				auth,
			);
			return record(tx, row);
		});
	}
	remove(owner: WorkspaceSnapshotPrincipalV1, id: string) {
		return this.#remove(owner, id);
	}
	#remove(
		owner: WorkspaceSnapshotPrincipalV1,
		id: string,
		auth?: Authorization,
	) {
		return this.#run(owner, "agent:manage", auth, async (tx) => {
			// Authorize before inspecting references, avoiding an existence oracle for foreign IDs.
			const [row] = await tx
				.select()
				.from(workspaceSnapshots)
				.where(and(owned(owner), eq(workspaceSnapshots.id, id)))
				.for("update")
				.limit(1);
			if (!row) throw new WorkspaceSnapshotErrorV1("not_found");
			if (row.status !== "ready") return record(tx, row);
			const [binding] = await tx
				.select({ id: workspaceSnapshotBindings.snapshotId })
				.from(workspaceSnapshotBindings)
				.where(eq(workspaceSnapshotBindings.snapshotId, id))
				.limit(1);
			if (binding) throw new WorkspaceSnapshotErrorV1("bound");
			const [updated] = await tx
				.update(workspaceSnapshots)
				.set({ status: "deleting" })
				.where(eq(workspaceSnapshots.id, id))
				.returning();
			if (!updated) throw new WorkspaceSnapshotErrorV1("unavailable");
			await this.#audit(
				tx,
				owner,
				"workspace.snapshot.deletion_requested",
				id,
				auth,
				{ digest: row.digest },
			);
			return record(tx, updated);
		});
	}
	read(owner: WorkspaceSnapshotPrincipalV1) {
		return this.#usage(owner);
	}
	finishDeletion(
		owner: WorkspaceSnapshotPrincipalV1,
		id: string,
		version: string,
	) {
		return this.#finishDeletion(owner, id, version);
	}
	#finishDeletion(
		owner: WorkspaceSnapshotPrincipalV1,
		id: string,
		version: string,
		auth?: Authorization,
	) {
		return this.#run(owner, "agent:manage", auth, async (tx) => {
			const [row] = await tx
				.select()
				.from(workspaceSnapshots)
				.where(and(owned(owner), eq(workspaceSnapshots.id, id)))
				.for("update")
				.limit(1);
			if (!row) throw new WorkspaceSnapshotErrorV1("not_found");
			if (row.objectVersion !== version || row.status === "ready")
				throw new WorkspaceSnapshotErrorV1("conflict");
			if (row.status === "deleted") return record(tx, row);
			const [binding] = await tx
				.select({ id: workspaceSnapshotBindings.snapshotId })
				.from(workspaceSnapshotBindings)
				.where(eq(workspaceSnapshotBindings.snapshotId, id))
				.limit(1);
			if (binding) throw new WorkspaceSnapshotErrorV1("bound");
			const [updated] = await tx
				.update(workspaceSnapshots)
				.set({ status: "deleted", deletedAt: new Date() })
				.where(eq(workspaceSnapshots.id, id))
				.returning();
			if (!updated) throw new WorkspaceSnapshotErrorV1("unavailable");
			await this.#audit(tx, owner, "workspace.snapshot.deleted", id, auth, {
				digest: row.digest,
			});
			return record(tx, updated);
		});
	}
	#usage(owner: WorkspaceSnapshotPrincipalV1, auth?: Authorization) {
		return this.#run(owner, "agent:create", auth, async (tx) => ({
			ownerStoredBytes: await usage(tx, owner),
			agentArchiveBytes: 0,
			agentUnpackedBytes: 0,
			agentBindingCount: 0,
		}));
	}
	async close() {
		await this.#client.end();
	}
}
