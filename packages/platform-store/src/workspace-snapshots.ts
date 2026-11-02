import {
	WorkspaceSnapshotErrorV1,
	type WorkspaceSnapshotRecordV1,
	type WorkspaceSnapshotStoreV1,
} from "@agent-infra/platform-core";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "./observed-postgres.js";
import { workspaceSnapshotBindings, workspaceSnapshots } from "./schema.js";

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
			const [row] = await this.#database
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
		const [binding] = await this.#database
			.select({ snapshotId: workspaceSnapshotBindings.snapshotId })
			.from(workspaceSnapshotBindings)
			.where(eq(workspaceSnapshotBindings.snapshotId, snapshotId))
			.limit(1);
		if (binding) throw new WorkspaceSnapshotErrorV1("bound");
		const [row] = await this.#database
			.update(workspaceSnapshots)
			.set({ status: "deleted", deletedAt: new Date() })
			.where(
				and(
					eq(workspaceSnapshots.id, snapshotId),
					eq(workspaceSnapshots.ownerType, owner.ownerType),
					eq(workspaceSnapshots.ownerId, owner.ownerId),
					eq(workspaceSnapshots.status, "ready"),
				),
			)
			.returning();
		if (!row) throw new WorkspaceSnapshotErrorV1("invalid_name");
		return record(row);
	}
	async close() {
		await this.#client.end();
	}
}
