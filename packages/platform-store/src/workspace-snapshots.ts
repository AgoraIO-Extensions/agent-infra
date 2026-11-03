import { randomUUID } from "node:crypto";
import {
	WorkspaceSnapshotErrorV1,
	type WorkspaceSnapshotGcResultV1,
	type WorkspaceSnapshotObjectVersionDeleterV1,
	type WorkspaceSnapshotRecordV1,
	type WorkspaceSnapshotStoreV1,
} from "@agent-infra/platform-core";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "./observed-postgres.js";
import {
	auditEvents,
	workspaceSnapshotBindings,
	workspaceSnapshots,
} from "./schema.js";

type Owner = { ownerType: "user" | "application"; ownerId: string };
type Row = typeof workspaceSnapshots.$inferSelect;
function record(
	row: Row,
	bindings: WorkspaceSnapshotRecordV1["bindings"] = [],
): WorkspaceSnapshotRecordV1 {
	return {
		snapshotId: row.id,
		ownerType: row.ownerType as Owner["ownerType"],
		ownerId: row.ownerId,
		digest: row.digest,
		sizeBytes: Number(row.sizeBytes),
		unpackedSizeBytes: Number(row.unpackedSizeBytes),
		fileCount: Number(row.fileCount),
		mediaType: "application/x-tar+gzip",
		source: row.source,
		objectRef: row.objectRef,
		objectVersion: row.objectVersion,
		status: row.status as WorkspaceSnapshotRecordV1["status"],
		createdAt: row.createdAt.toISOString(),
		bindings,
	};
}
export class PostgresWorkspaceSnapshotStoreV1
	implements WorkspaceSnapshotStoreV1
{
	readonly #client;
	readonly #database;
	constructor(databaseUrl: string) {
		this.#client = postgres(databaseUrl, { max: 4 });
		this.#database = drizzle(this.#client);
	}
	async create(input: WorkspaceSnapshotRecordV1) {
		try {
			const [row] = await this.#database.transaction(async (transaction) => {
				await transaction.execute(
					sql`select pg_advisory_xact_lock(hashtextextended(${input.objectRef} || ':' || ${input.objectVersion}, 0))`,
				);
				const [retired] = await transaction
					.select({ id: workspaceSnapshots.id })
					.from(workspaceSnapshots)
					.where(
						sql`${workspaceSnapshots.objectRef} = ${input.objectRef} and ${workspaceSnapshots.objectVersion} = ${input.objectVersion} and ${workspaceSnapshots.status} in ('deleting', 'deleted')`,
					)
					.limit(1);
				if (retired) throw new WorkspaceSnapshotErrorV1("conflict");
				return transaction
					.insert(workspaceSnapshots)
					.values({
						id: input.snapshotId,
						ownerType: input.ownerType,
						ownerId: input.ownerId,
						digest: input.digest,
						sizeBytes: input.sizeBytes,
						unpackedSizeBytes: input.unpackedSizeBytes,
						fileCount: input.fileCount,
						mediaType: input.mediaType,
						source: input.source,
						objectRef: input.objectRef,
						objectVersion: input.objectVersion,
						status: input.status,
						createdAt: new Date(input.createdAt),
					})
					.returning();
			});
			if (!row) throw new WorkspaceSnapshotErrorV1("invalid_name");
			return record(row);
		} catch (error) {
			if (error instanceof WorkspaceSnapshotErrorV1) throw error;
			throw new WorkspaceSnapshotErrorV1("invalid_name");
		}
	}
	async list(owner: Owner) {
		const rows = await this.#database
			.select()
			.from(workspaceSnapshots)
			.where(
				and(
					eq(workspaceSnapshots.ownerType, owner.ownerType),
					eq(workspaceSnapshots.ownerId, owner.ownerId),
				),
			);
		return Promise.all(
			rows.map(async (row) =>
				record(
					row,
					await this.#database
						.select({
							agentId: workspaceSnapshotBindings.agentId,
							configurationRevision:
								workspaceSnapshotBindings.configurationRevision,
							name: workspaceSnapshotBindings.name,
							digest: workspaceSnapshotBindings.digest,
							sizeBytes: workspaceSnapshotBindings.sizeBytes,
						})
						.from(workspaceSnapshotBindings)
						.where(eq(workspaceSnapshotBindings.snapshotId, row.id)),
				),
			),
		);
	}
	async get(owner: Owner, snapshotId: string) {
		const [row] = await this.#database
			.select()
			.from(workspaceSnapshots)
			.where(
				and(
					eq(workspaceSnapshots.id, snapshotId),
					eq(workspaceSnapshots.ownerType, owner.ownerType),
					eq(workspaceSnapshots.ownerId, owner.ownerId),
				),
			)
			.limit(1);
		if (!row) return null;
		const bindings = await this.#database
			.select({
				agentId: workspaceSnapshotBindings.agentId,
				configurationRevision: workspaceSnapshotBindings.configurationRevision,
				name: workspaceSnapshotBindings.name,
				digest: workspaceSnapshotBindings.digest,
				sizeBytes: workspaceSnapshotBindings.sizeBytes,
			})
			.from(workspaceSnapshotBindings)
			.where(eq(workspaceSnapshotBindings.snapshotId, row.id));
		return record(row, bindings);
	}
	async remove(owner: Owner, snapshotId: string) {
		return this.#database.transaction(async (transaction) => {
			const [row] = await transaction
				.select()
				.from(workspaceSnapshots)
				.where(
					and(
						eq(workspaceSnapshots.id, snapshotId),
						eq(workspaceSnapshots.ownerType, owner.ownerType),
						eq(workspaceSnapshots.ownerId, owner.ownerId),
						eq(workspaceSnapshots.status, "ready"),
					),
				)
				.for("update")
				.limit(1);
			if (!row) throw new WorkspaceSnapshotErrorV1("invalid_name");
			const [binding] = await transaction
				.select({ snapshotId: workspaceSnapshotBindings.snapshotId })
				.from(workspaceSnapshotBindings)
				.where(eq(workspaceSnapshotBindings.snapshotId, snapshotId))
				.for("share")
				.limit(1);
			if (binding) throw new WorkspaceSnapshotErrorV1("bound");
			const [deleted] = await transaction
				.update(workspaceSnapshots)
				.set({ status: "deleted", deletedAt: new Date() })
				.where(
					and(
						eq(workspaceSnapshots.id, snapshotId),
						eq(workspaceSnapshots.status, "ready"),
					),
				)
				.returning();
			if (!deleted) throw new WorkspaceSnapshotErrorV1("invalid_name");
			return record(deleted);
		});
	}
	/**
	 * Deletes only expired, unbound immutable objects. Row state is fenced in a
	 * transaction before object I/O and rechecked in a second transaction after
	 * exact-version deletion, so a concurrent bind cannot be silently lost.
	 */
	async collectExpired(input: {
		readonly now: Date;
		readonly retentionMs: number;
		readonly deleter: WorkspaceSnapshotObjectVersionDeleterV1;
	}): Promise<WorkspaceSnapshotGcResultV1> {
		if (!Number.isSafeInteger(input.retentionMs) || input.retentionMs < 0)
			throw new WorkspaceSnapshotErrorV1("invalid_input");
		const cutoff = new Date(input.now.getTime() - input.retentionMs);
		const candidates = await this.#database.transaction(async (transaction) => {
			const rows = await transaction
				.select({
					id: workspaceSnapshots.id,
					ownerType: workspaceSnapshots.ownerType,
					ownerId: workspaceSnapshots.ownerId,
					status: workspaceSnapshots.status,
					objectRef: workspaceSnapshots.objectRef,
					objectVersion: workspaceSnapshots.objectVersion,
				})
				.from(workspaceSnapshots)
				.where(
					and(
						inArray(workspaceSnapshots.status, ["ready", "deleting"]),
						lt(workspaceSnapshots.createdAt, cutoff),
						isNull(workspaceSnapshots.deletedAt),
						sql`not exists (select 1 from ${workspaceSnapshotBindings} b where b.snapshot_id = ${workspaceSnapshots.id})`,
					),
				)
				.for("update", { skipLocked: true });
			for (const row of rows) {
				if (row.status === "ready") {
					await transaction
						.update(workspaceSnapshots)
						.set({ status: "deleting" })
						.where(eq(workspaceSnapshots.id, row.id));
					await transaction.insert(auditEvents).values({
						id: randomUUID(),
						traceId: randomUUID(),
						actorType: "system",
						actorId: "workspace-snapshot-gc",
						action: "workspace.snapshot.gc.deletion_requested",
						targetType: "workspace_snapshot",
						targetId: row.id,
						outcome: "succeeded",
						details: { objectVersion: row.objectVersion },
					});
				}
			}
			return rows;
		});
		let deleted = 0;
		let failed = 0;
		for (const candidate of candidates) {
			try {
				const completed = await this.#database.transaction(
					async (transaction) => {
						await transaction.execute(
							sql`select pg_advisory_xact_lock(hashtextextended(${candidate.objectRef} || ':' || ${candidate.objectVersion}, 0))`,
						);
						const [row] = await transaction
							.select({ status: workspaceSnapshots.status })
							.from(workspaceSnapshots)
							.where(eq(workspaceSnapshots.id, candidate.id))
							.for("update")
							.limit(1);
						if (row?.status !== "deleting") return;
						const [binding] = await transaction
							.select({ snapshotId: workspaceSnapshotBindings.snapshotId })
							.from(workspaceSnapshotBindings)
							.where(eq(workspaceSnapshotBindings.snapshotId, candidate.id))
							.limit(1);
						if (binding) {
							await transaction
								.update(workspaceSnapshots)
								.set({ status: "ready" })
								.where(eq(workspaceSnapshots.id, candidate.id));
							return false;
						}
						const [shared] = await transaction
							.select({ id: workspaceSnapshots.id })
							.from(workspaceSnapshots)
							.where(
								sql`${workspaceSnapshots.id} <> ${candidate.id} and ${workspaceSnapshots.objectRef} = ${candidate.objectRef} and ${workspaceSnapshots.objectVersion} = ${candidate.objectVersion} and ${workspaceSnapshots.status} = 'ready'`,
							)
							.limit(1);
						if (shared) return false;
						// Keep the object lock across I/O: publication must not race the delete.
						await input.deleter.deleteObjectVersion({
							objectRef: candidate.objectRef,
							objectVersion: candidate.objectVersion,
						});
						await transaction
							.update(workspaceSnapshots)
							.set({ status: "deleted", deletedAt: input.now })
							.where(eq(workspaceSnapshots.id, candidate.id));
						await transaction.insert(auditEvents).values({
							id: randomUUID(),
							traceId: randomUUID(),
							actorType: "system",
							actorId: "workspace-snapshot-gc",
							action: "workspace.snapshot.gc.deleted",
							targetType: "workspace_snapshot",
							targetId: candidate.id,
							outcome: "succeeded",
							details: { objectVersion: candidate.objectVersion },
						});
						return true;
					},
				);
				if (completed) deleted++;
			} catch {
				failed++;
			}
		}
		return { scanned: candidates.length, deleted, failed };
	}
	async readGcMetrics(input: { now: Date; retentionMs: number }) {
		if (
			!Number.isFinite(input.now.getTime()) ||
			!Number.isSafeInteger(input.retentionMs) ||
			input.retentionMs < 0
		)
			throw new WorkspaceSnapshotErrorV1("invalid_input");
		const cutoff = new Date(input.now.getTime() - input.retentionMs);
		const [row] = await this.#database
			.select({
				storedBytes: sql<string>`coalesce(sum(${workspaceSnapshots.sizeBytes}), 0)`,
				oldestEligible: sql<
					Date | string | null
				>`min(case when ${workspaceSnapshots.createdAt} < ${cutoff.toISOString()}::timestamptz and not exists (select 1 from ${workspaceSnapshotBindings} b where b.snapshot_id = ${workspaceSnapshots.id}) then ${workspaceSnapshots.createdAt} end)`,
			})
			.from(workspaceSnapshots)
			.where(sql`${workspaceSnapshots.status} <> 'deleted'`);
		const storedBytes = Number(row?.storedBytes ?? 0);
		const oldest =
			row?.oldestEligible == null
				? null
				: new Date(row.oldestEligible).getTime();
		if (
			!Number.isSafeInteger(storedBytes) ||
			storedBytes < 0 ||
			(oldest !== null && !Number.isFinite(oldest))
		)
			throw new WorkspaceSnapshotErrorV1("unavailable");
		return {
			storedBytes,
			oldestEligibleDelayMs:
				oldest === null ? 0 : Math.max(0, cutoff.getTime() - oldest),
		};
	}
	async close() {
		await this.#client.end();
	}
}
