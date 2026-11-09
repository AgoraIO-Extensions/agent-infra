import {
	type FileReconciliationStorageV1,
	WorkspaceSnapshotErrorV1,
	type WorkspaceSnapshotPrincipalV1,
} from "@agent-infra/platform-core";
import { and, eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import {
	idempotencyRecords,
	workspaceSnapshotBindings,
	workspaceSnapshots,
	workspaceSnapshotUploadObjects,
	workspaceSnapshotUploadReservations,
} from "./schema.js";

export type SnapshotUploadTransactionV1 = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];
type Owner = Pick<WorkspaceSnapshotPrincipalV1, "kind" | "id">;
const objects = workspaceSnapshotUploadObjects;
const reservations = workspaceSnapshotUploadReservations;
const validVersion = (value: unknown): value is string =>
	typeof value === "string" &&
	value.length > 0 &&
	value.length <= 256 &&
	value !== "null" &&
	value.isWellFormed() &&
	![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

export function lockSnapshotUploadObjectV1(
	tx: SnapshotUploadTransactionV1,
	objectRef: string,
) {
	return tx.execute(
		sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["workspace_snapshot_object", objectRef])}, 0))`,
	);
}

/** Both publication paths take this ref lock before the exact-version lock. */
export async function assertSnapshotObjectPublishableV1(
	tx: SnapshotUploadTransactionV1,
	objectRef: string,
	version: string,
	reservationId?: string,
) {
	await lockSnapshotUploadObjectV1(tx, objectRef);
	const [intent] = await tx
		.select({
			state: objects.state,
			reservationId: objects.reservationId,
			version: objects.objectVersion,
			active: sql<boolean>`${objects.expiresAt} > clock_timestamp()`,
		})
		.from(objects)
		.where(eq(objects.objectRef, objectRef))
		.limit(1);
	if (
		intent &&
		(intent.state === "retired" ||
			intent.version !== version ||
			(intent.state === "pending" &&
				(!intent.active || intent.reservationId !== reservationId)))
	)
		throw new WorkspaceSnapshotErrorV1("conflict");
	await tx.execute(
		sql`select pg_advisory_xact_lock(hashtextextended(${objectRef} || ':' || ${version}, 0))`,
	);
}

export async function beginSnapshotUploadObjectV1(
	tx: SnapshotUploadTransactionV1,
	owner: Owner,
	reservationId: string,
	objectRef: string,
) {
	if (
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
			objectRef,
		)
	)
		throw new WorkspaceSnapshotErrorV1("invalid_input");
	await lockSnapshotUploadObjectV1(tx, objectRef);
	const [existing] = await tx
		.select()
		.from(objects)
		.where(eq(objects.objectRef, objectRef))
		.limit(1);
	if (
		existing &&
		(existing.reservationId !== reservationId ||
			existing.ownerType !== owner.kind ||
			existing.ownerId !== owner.id ||
			existing.state !== "pending")
	)
		throw new WorkspaceSnapshotErrorV1("conflict");
	const [published] = await tx
		.select({ id: workspaceSnapshots.id })
		.from(workspaceSnapshots)
		.where(eq(workspaceSnapshots.objectRef, objectRef))
		.limit(1);
	if (published) throw new WorkspaceSnapshotErrorV1("conflict");
	const [reservation] = await tx
		.update(reservations)
		.set({ objectRef, updatedAt: sql`clock_timestamp()` })
		.where(
			and(
				eq(reservations.id, reservationId),
				eq(reservations.ownerType, owner.kind),
				eq(reservations.ownerId, owner.id),
				eq(reservations.status, "reserved"),
				sql`${reservations.expiresAt} > clock_timestamp()`,
				sql`(${reservations.objectRef} is null or ${reservations.objectRef} = ${objectRef})`,
			),
		)
		.returning();
	if (!reservation) throw new WorkspaceSnapshotErrorV1("unavailable");
	if (!existing)
		await tx.insert(objects).values({
			objectRef,
			reservationId,
			ownerType: owner.kind,
			ownerId: owner.id,
			idempotencyKey: reservation.idempotencyKey,
			requestDigest: reservation.requestDigest,
			expiresAt: reservation.expiresAt,
			objectVersion: reservation.objectVersion,
		});
}

/** Commit this decision before calling storage: a rolled-back I/O transaction cannot reopen publication. */
export async function retireSnapshotUploadObjectV1(
	tx: SnapshotUploadTransactionV1,
	owner: Owner,
	reservationId: string,
	objectRef: string,
) {
	await lockSnapshotUploadObjectV1(tx, objectRef);
	const [intent] = await tx
		.select()
		.from(objects)
		.where(
			and(
				eq(objects.objectRef, objectRef),
				eq(objects.reservationId, reservationId),
				eq(objects.ownerType, owner.kind),
				eq(objects.ownerId, owner.id),
			),
		)
		.for("update")
		.limit(1);
	if (!intent) throw new WorkspaceSnapshotErrorV1("not_found");
	if (intent.state === "pending") {
		const [receipt] = await tx
			.select()
			.from(idempotencyRecords)
			.where(
				and(
					eq(idempotencyRecords.scopeType, "workspace_snapshot_upload"),
					eq(
						idempotencyRecords.scopeId,
						JSON.stringify([owner.kind, owner.id]),
					),
					eq(idempotencyRecords.actorId, owner.id),
					eq(idempotencyRecords.commandType, "workspace_snapshot.upload.v1"),
					eq(idempotencyRecords.idempotencyKey, intent.idempotencyKey),
				),
			)
			.limit(1);
		if (receipt) {
			if (
				receipt.status !== "completed" ||
				receipt.requestDigest !== intent.requestDigest ||
				typeof receipt.result?.snapshotId !== "string"
			)
				throw new WorkspaceSnapshotErrorV1("conflict");
			const [committed] = await tx
				.select()
				.from(workspaceSnapshots)
				.where(eq(workspaceSnapshots.id, receipt.result.snapshotId))
				.limit(1);
			if (
				!committed ||
				committed.ownerType !== owner.kind ||
				committed.ownerId !== owner.id ||
				committed.objectRef !== objectRef ||
				!intent.objectVersion ||
				committed.objectVersion !== intent.objectVersion
			)
				throw new WorkspaceSnapshotErrorV1("conflict");
			if (committed.status !== "deleted") {
				await tx
					.update(objects)
					.set({ state: "published", updatedAt: sql`clock_timestamp()` })
					.where(eq(objects.objectRef, objectRef));
				await tx
					.update(reservations)
					.set({
						status: "completed",
						snapshotId: committed.id,
						updatedAt: sql`clock_timestamp()`,
					})
					.where(
						and(
							eq(reservations.id, reservationId),
							eq(reservations.ownerType, owner.kind),
							eq(reservations.ownerId, owner.id),
							eq(reservations.idempotencyKey, intent.idempotencyKey),
							eq(reservations.requestDigest, intent.requestDigest),
							eq(reservations.objectRef, objectRef),
							eq(reservations.objectVersion, committed.objectVersion),
						),
					);
				return false;
			}
		}
	}
	const [published] = await tx
		.select({ id: workspaceSnapshots.id })
		.from(workspaceSnapshots)
		.where(sql`
		${workspaceSnapshots.objectRef} = ${objectRef} and (${workspaceSnapshots.status} <> 'deleted' or exists (
			select 1 from ${workspaceSnapshotBindings} where ${workspaceSnapshotBindings.snapshotId} = ${workspaceSnapshots.id}
		))
	`)
		.limit(1);
	if (published) throw new WorkspaceSnapshotErrorV1("conflict");
	if (intent.state !== "retired")
		await tx
			.update(objects)
			.set({
				state: "retired",
				scanCursor: null,
				updatedAt: sql`clock_timestamp()`,
			})
			.where(eq(objects.objectRef, objectRef));
	return true;
}

/** No intent can release its charge without a confirmed storage fence and completed cleanup. */
export async function releaseSnapshotUploadReservationV1(
	tx: SnapshotUploadTransactionV1,
	owner: Owner,
	reservationId: string,
	objectFence?: { readonly objectRef: string; readonly version: string },
) {
	const [intent] = await tx
		.select()
		.from(objects)
		.where(
			and(
				eq(objects.reservationId, reservationId),
				eq(objects.ownerType, owner.kind),
				eq(objects.ownerId, owner.id),
			),
		)
		.limit(1);
	if (intent) {
		if (!objectFence) return false;
		if (
			intent.objectRef !== objectFence.objectRef ||
			intent.state !== "retired" ||
			!validVersion(objectFence.version)
		)
			throw new WorkspaceSnapshotErrorV1("conflict");
		await lockSnapshotUploadObjectV1(tx, intent.objectRef);
		await tx
			.update(objects)
			.set({
				fenceVersion: objectFence.version,
				updatedAt: sql`clock_timestamp()`,
			})
			.where(eq(objects.objectRef, intent.objectRef));
	} else if (objectFence) throw new WorkspaceSnapshotErrorV1("conflict");
	const released = await tx
		.update(reservations)
		.set({
			status: "released",
			releasedAt: sql`clock_timestamp()`,
			updatedAt: sql`clock_timestamp()`,
			objectRef: null,
			objectVersion: null,
		})
		.where(
			and(
				eq(reservations.id, reservationId),
				eq(reservations.ownerType, owner.kind),
				eq(reservations.ownerId, owner.id),
				sql`${reservations.status} in ('reserved','expired')`,
				intent
					? eq(reservations.objectRef, intent.objectRef)
					: sql`${reservations.objectRef} is null`,
			),
		)
		.returning({ id: reservations.id });
	return released.length > 0;
}

export type SnapshotUploadRecoveryStorageV1 = FileReconciliationStorageV1 & {
	fenceUpload(objectRef: string): Promise<{ readonly version: string }>;
};

/** Exactly one bounded page, under the durable retired-ref fence and transaction lock. */
export async function recoverSnapshotUploadObjectPageV1(
	tx: SnapshotUploadTransactionV1,
	objectRef: string,
	storage: SnapshotUploadRecoveryStorageV1,
) {
	await lockSnapshotUploadObjectV1(tx, objectRef);
	const [intent] = await tx
		.select()
		.from(objects)
		.where(eq(objects.objectRef, objectRef))
		.for("update")
		.limit(1);
	if (intent?.state !== "retired")
		throw new WorkspaceSnapshotErrorV1("conflict");
	const [published] = await tx
		.select({ id: workspaceSnapshots.id })
		.from(workspaceSnapshots)
		.where(
			sql`${workspaceSnapshots.objectRef} = ${objectRef} and ${workspaceSnapshots.status} <> 'deleted'`,
		)
		.limit(1);
	if (published) throw new WorkspaceSnapshotErrorV1("conflict");
	const fence = await storage.fenceUpload(objectRef);
	if (!validVersion(fence.version))
		throw new WorkspaceSnapshotErrorV1("unavailable");
	const cursor =
		intent.fenceVersion === fence.version ? intent.scanCursor : null;
	const page = await storage.scan(cursor, 100, objectRef);
	if (
		page.objects.length > 100 ||
		(page.cursor !== null &&
			(typeof page.cursor !== "string" ||
				page.cursor.length === 0 ||
				page.cursor.length > 16384 ||
				page.cursor === cursor))
	)
		throw new WorkspaceSnapshotErrorV1("unavailable");
	for (const object of page.objects) {
		if (
			object.objectRef !== objectRef ||
			!validVersion(object.version) ||
			!Number.isFinite(Date.parse(object.createdAt))
		)
			throw new WorkspaceSnapshotErrorV1("unavailable");
	}
	let deletedVersions = 0;
	for (const object of page.objects) {
		if (
			object.objectRef !== objectRef ||
			!validVersion(object.version) ||
			!Number.isFinite(Date.parse(object.createdAt))
		)
			throw new WorkspaceSnapshotErrorV1("unavailable");
		if (object.version === fence.version) continue;
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${objectRef} || ':' || ${object.version}, 0))`,
		);
		const [referenced] = await tx
			.select({ id: workspaceSnapshots.id })
			.from(workspaceSnapshots)
			.where(
				sql`${workspaceSnapshots.objectRef} = ${objectRef} and ${workspaceSnapshots.objectVersion} = ${object.version} and ${workspaceSnapshots.status} <> 'deleted'`,
			)
			.limit(1);
		if (referenced) throw new WorkspaceSnapshotErrorV1("conflict");
		await storage.remove(objectRef, object.version);
		deletedVersions++;
	}
	const sawFence = page.objects.some(
		(object) => object.version === fence.version,
	);
	if (
		!sawFence &&
		((page.cursor === null && cursor === null) ||
			(page.cursor !== null && deletedVersions === 0))
	)
		throw new WorkspaceSnapshotErrorV1("unavailable");
	// A changed current fence invalidates the page checkpoint and any release claim.
	if ((await storage.fenceUpload(objectRef)).version !== fence.version)
		throw new WorkspaceSnapshotErrorV1("unavailable");
	let released = false;
	if (page.cursor === null)
		released = await releaseSnapshotUploadReservationV1(
			tx,
			{
				kind: intent.ownerType as Owner["kind"],
				id: intent.ownerId,
			},
			intent.reservationId,
			{ objectRef, version: fence.version },
		);
	// VersionIdMarker can name a just-deleted version. Restart after deleting a page.
	await tx
		.update(objects)
		.set({
			fenceVersion: fence.version,
			scanCursor: deletedVersions > 0 ? null : page.cursor,
			updatedAt: sql`clock_timestamp()`,
		})
		.where(eq(objects.objectRef, objectRef));
	return { deletedVersions, released, continued: page.cursor !== null };
}
