import { randomUUID } from "node:crypto";
import {
	WorkspaceSnapshotErrorV1,
	type WorkspaceSnapshotPrincipalV1,
	type WorkspaceSnapshotQuotaReaderV1,
	type WorkspaceSnapshotRecordV1,
	type WorkspaceSnapshotUploadStoreV1,
} from "@agent-infra/platform-core";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "./observed-postgres.js";
import {
	idempotencyRecords,
	workspaceSnapshotBindings,
	workspaceSnapshots,
} from "./schema.js";

const scopeType = "workspace_snapshot_upload";
const commandType = "workspace_snapshot.upload.v1";

type Row = typeof workspaceSnapshots.$inferSelect;
function record(
	row: Row,
	bindings: WorkspaceSnapshotRecordV1["bindings"] = [],
): WorkspaceSnapshotRecordV1 {
	return {
		snapshotId: row.id,
		ownerType: row.ownerType as "user" | "application",
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

export class PostgresWorkspaceSnapshotUploadStoreV1
	implements WorkspaceSnapshotUploadStoreV1, WorkspaceSnapshotQuotaReaderV1
{
	readonly #client;
	readonly #database;
	constructor(databaseUrl: string) {
		this.#client = postgres(databaseUrl, { max: 4 });
		this.#database = drizzle(this.#client);
	}
	async findIdempotency(owner: WorkspaceSnapshotPrincipalV1, key: string) {
		const [row] = await this.#database
			.select({
				requestDigest: idempotencyRecords.requestDigest,
				result: idempotencyRecords.result,
			})
			.from(idempotencyRecords)
			.where(
				and(
					eq(idempotencyRecords.scopeType, scopeType),
					eq(idempotencyRecords.scopeId, owner.id),
					eq(idempotencyRecords.actorId, owner.id),
					eq(idempotencyRecords.commandType, commandType),
					eq(idempotencyRecords.idempotencyKey, key),
					eq(idempotencyRecords.status, "completed"),
				),
			)
			.limit(1);
		const result = row?.result;
		const snapshot =
			result && typeof result === "object" && !Array.isArray(result)
				? (result as Record<string, unknown>).record
				: undefined;
		if (
			!row ||
			!snapshot ||
			typeof snapshot !== "object" ||
			Array.isArray(snapshot)
		)
			return null;
		return {
			requestDigest: row.requestDigest,
			record: snapshot as WorkspaceSnapshotRecordV1,
		};
	}
	async create(
		recordInput: WorkspaceSnapshotRecordV1,
		owner: WorkspaceSnapshotPrincipalV1,
		idempotencyKey: string,
		requestDigest: string,
	) {
		try {
			return await this.#database.transaction(async (transaction) => {
				const [row] = await transaction
					.insert(workspaceSnapshots)
					.values({
						id: recordInput.snapshotId,
						ownerType: owner.kind,
						ownerId: owner.id,
						digest: recordInput.digest,
						sizeBytes: recordInput.sizeBytes,
						unpackedSizeBytes: recordInput.unpackedSizeBytes,
						fileCount: recordInput.fileCount,
						mediaType: recordInput.mediaType,
						source: recordInput.source,
						objectRef: recordInput.objectRef,
						objectVersion: recordInput.objectVersion,
						status: recordInput.status,
						createdAt: new Date(recordInput.createdAt),
					})
					.returning();
				if (!row) throw new WorkspaceSnapshotErrorV1("invalid_name");
				await transaction.insert(idempotencyRecords).values({
					id: randomUUID(),
					scopeType,
					scopeId: owner.id,
					actorId: owner.id,
					commandType,
					idempotencyKey,
					requestDigest,
					status: "completed",
					result: { record: recordInput },
				});
				return record(row);
			});
		} catch (error) {
			if (error instanceof WorkspaceSnapshotErrorV1) throw error;
			const replay = await this.findIdempotency(owner, idempotencyKey);
			if (replay?.requestDigest === requestDigest) return replay.record;
			throw new WorkspaceSnapshotErrorV1("invalid_name");
		}
	}
	async list(owner: WorkspaceSnapshotPrincipalV1) {
		const rows = await this.#database
			.select()
			.from(workspaceSnapshots)
			.where(
				and(
					eq(workspaceSnapshots.ownerType, owner.kind),
					eq(workspaceSnapshots.ownerId, owner.id),
				),
			);
		return rows.map((row) => record(row));
	}
	async get(owner: WorkspaceSnapshotPrincipalV1, snapshotId: string) {
		const [row] = await this.#database
			.select()
			.from(workspaceSnapshots)
			.where(
				and(
					eq(workspaceSnapshots.id, snapshotId),
					eq(workspaceSnapshots.ownerType, owner.kind),
					eq(workspaceSnapshots.ownerId, owner.id),
				),
			)
			.limit(1);
		return row ? record(row) : null;
	}
	async remove(owner: WorkspaceSnapshotPrincipalV1, snapshotId: string) {
		const bindings = await this.#database
			.select({ id: workspaceSnapshotBindings.snapshotId })
			.from(workspaceSnapshotBindings)
			.where(eq(workspaceSnapshotBindings.snapshotId, snapshotId))
			.limit(1);
		if (bindings.length) throw new WorkspaceSnapshotErrorV1("bound");
		const [row] = await this.#database
			.update(workspaceSnapshots)
			.set({ status: "deleted", deletedAt: new Date() })
			.where(
				and(
					eq(workspaceSnapshots.id, snapshotId),
					eq(workspaceSnapshots.ownerType, owner.kind),
					eq(workspaceSnapshots.ownerId, owner.id),
					eq(workspaceSnapshots.status, "ready"),
				),
			)
			.returning();
		if (!row) throw new WorkspaceSnapshotErrorV1("invalid_name");
		return record(row);
	}
	async read(owner: WorkspaceSnapshotPrincipalV1) {
		const snapshots = await this.#database
			.select({ sizeBytes: workspaceSnapshots.sizeBytes })
			.from(workspaceSnapshots)
			.where(
				and(
					eq(workspaceSnapshots.ownerType, owner.kind),
					eq(workspaceSnapshots.ownerId, owner.id),
					eq(workspaceSnapshots.status, "ready"),
				),
			);
		const bindings = await this.#database
			.select({ sizeBytes: workspaceSnapshotBindings.sizeBytes })
			.from(workspaceSnapshotBindings)
			.where(eq(workspaceSnapshotBindings.agentId, owner.id));
		return {
			ownerStoredBytes: snapshots.reduce(
				(sum, row) => sum + Number(row.sizeBytes),
				0,
			),
			agentArchiveBytes: bindings.reduce(
				(sum, row) => sum + Number(row.sizeBytes),
				0,
			),
			agentUnpackedBytes: bindings.reduce(
				(sum, row) => sum + Number(row.sizeBytes),
				0,
			),
			agentBindingCount: bindings.length,
		};
	}
	async close() {
		await this.#client.end();
	}
}
