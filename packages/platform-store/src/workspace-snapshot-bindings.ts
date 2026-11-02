import {
	assertWorkspaceSnapshotBindingQuotaV1,
	WorkspaceSnapshotBindingErrorV1,
	type WorkspaceSnapshotBindingStoreV1,
} from "@agent-infra/platform-core";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "./observed-postgres.js";
import {
	agentConfigurationRevisions,
	workspaceSnapshotBindings,
	workspaceSnapshots,
} from "./schema.js";

type BindingRow = typeof workspaceSnapshotBindings.$inferSelect;

export class PostgresWorkspaceSnapshotBindingStoreV1
	implements WorkspaceSnapshotBindingStoreV1
{
	readonly #client;
	readonly #database;
	constructor(databaseUrl: string) {
		this.#client = postgres(databaseUrl, { max: 4 });
		this.#database = drizzle(this.#client);
	}

	async bind(input: Parameters<WorkspaceSnapshotBindingStoreV1["bind"]>[0]) {
		return this.#database.transaction(async (transaction) => {
			const [snapshot] = await transaction
				.select()
				.from(workspaceSnapshots)
				.where(
					and(
						eq(workspaceSnapshots.id, input.snapshotId),
						eq(workspaceSnapshots.ownerType, input.ownerType),
						eq(workspaceSnapshots.ownerId, input.ownerId),
						eq(workspaceSnapshots.status, "ready"),
					),
				)
				.for("update")
				.limit(1);
			if (!snapshot) throw new WorkspaceSnapshotBindingErrorV1("not_found");

			const [revision] = await transaction
				.select({ agentId: agentConfigurationRevisions.agentId })
				.from(agentConfigurationRevisions)
				.where(
					and(
						eq(agentConfigurationRevisions.agentId, input.agentId),
						eq(
							agentConfigurationRevisions.revision,
							input.configurationRevision,
						),
					),
				)
				.for("share")
				.limit(1);
			if (!revision) throw new WorkspaceSnapshotBindingErrorV1("not_found");

			const existing = await transaction
				.select()
				.from(workspaceSnapshotBindings)
				.where(
					and(
						eq(workspaceSnapshotBindings.agentId, input.agentId),
						eq(
							workspaceSnapshotBindings.configurationRevision,
							input.configurationRevision,
						),
					),
				)
				.for("update");
			if (existing.some((row) => row.name === input.name))
				throw new WorkspaceSnapshotBindingErrorV1("conflict");
			assertWorkspaceSnapshotBindingQuotaV1({
				existingCount: existing.length,
				existingBytes: existing.reduce(
					(total, row) => total + Number(row.sizeBytes),
					0,
				),
				nextBytes: Number(snapshot.unpackedSizeBytes),
			});
			const [row] = await transaction
				.insert(workspaceSnapshotBindings)
				.values({
					snapshotId: snapshot.id,
					agentId: input.agentId,
					configurationRevision: input.configurationRevision,
					name: input.name,
					digest: snapshot.digest,
					sizeBytes: snapshot.unpackedSizeBytes,
				})
				.returning();
			if (!row) throw new WorkspaceSnapshotBindingErrorV1("conflict");
			return bindingProjection(row);
		});
	}

	async unbind(
		input: Parameters<WorkspaceSnapshotBindingStoreV1["unbind"]>[0],
	): Promise<void> {
		await this.#database.transaction(async (transaction) => {
			const [snapshot] = await transaction
				.select({ id: workspaceSnapshots.id })
				.from(workspaceSnapshots)
				.where(
					and(
						eq(workspaceSnapshots.id, input.snapshotId),
						eq(workspaceSnapshots.ownerType, input.ownerType),
						eq(workspaceSnapshots.ownerId, input.ownerId),
					),
				)
				.for("update")
				.limit(1);
			if (!snapshot) throw new WorkspaceSnapshotBindingErrorV1("not_found");
			const deleted = await transaction
				.delete(workspaceSnapshotBindings)
				.where(
					and(
						eq(workspaceSnapshotBindings.snapshotId, input.snapshotId),
						eq(workspaceSnapshotBindings.agentId, input.agentId),
						eq(
							workspaceSnapshotBindings.configurationRevision,
							input.configurationRevision,
						),
					),
				)
				.returning({ snapshotId: workspaceSnapshotBindings.snapshotId });
			if (!deleted.length)
				throw new WorkspaceSnapshotBindingErrorV1("not_found");
		});
	}

	async close() {
		await this.#client.end();
	}
}

function bindingProjection(row: BindingRow) {
	return {
		agentId: row.agentId,
		configurationRevision: Number(row.configurationRevision),
		name: row.name,
		digest: row.digest,
		sizeBytes: Number(row.sizeBytes),
	};
}
