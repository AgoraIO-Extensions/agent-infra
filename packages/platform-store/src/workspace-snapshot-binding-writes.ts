import {
	type AgentConfigurationRecord,
	assertWorkspaceSnapshotBindingQuotaV1,
} from "@agent-infra/platform-core";
import { and, eq, inArray, or } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import {
	agentOwners,
	workspaceSnapshotBindings,
	workspaceSnapshots,
} from "./schema.js";

type Transaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];

/** Persist the snapshot projection for a configuration revision in its owning transaction. */
export async function insertWorkspaceSnapshotBindingsV1(
	transaction: Transaction,
	input: {
		readonly agentId: string;
		readonly configurationRevision: number;
		readonly ownerId: string;
		readonly configuration: AgentConfigurationRecord;
	},
): Promise<void> {
	const bindings =
		input.configuration.source.kind === "custom"
			? (input.configuration.source.workspaceSnapshots ?? [])
			: [];
	if (bindings.length === 0) return;

	const [owner] = await transaction
		.select({ ownerId: agentOwners.ownerId })
		.from(agentOwners)
		.where(
			and(
				eq(agentOwners.agentId, input.agentId),
				eq(agentOwners.ownerId, input.ownerId),
			),
		)
		.for("share")
		.limit(1);
	if (!owner) throw new Error("workspace snapshot target owner is unavailable");

	const ids = bindings.map(({ snapshotId }) => snapshotId);
	if (new Set(ids).size !== ids.length)
		throw new Error("workspace snapshot id is duplicated");
	const snapshots = await transaction
		.select({
			id: workspaceSnapshots.id,
			digest: workspaceSnapshots.digest,
			sizeBytes: workspaceSnapshots.unpackedSizeBytes,
		})
		.from(workspaceSnapshots)
		.where(
			and(
				eq(workspaceSnapshots.ownerId, input.ownerId),
				or(
					eq(workspaceSnapshots.ownerType, "user"),
					eq(workspaceSnapshots.ownerType, "application"),
				),
				eq(workspaceSnapshots.status, "ready"),
				inArray(workspaceSnapshots.id, ids),
			),
		)
		.for("share");
	const byId = new Map(
		snapshots.map((snapshot) => [snapshot.id, snapshot] as const),
	);
	if (byId.size !== new Set(ids).size)
		throw new Error("workspace snapshot is unavailable to the owner");

	const existingNames = new Set<string>();
	let totalBytes = 0;
	for (const binding of bindings) {
		if (existingNames.has(binding.name))
			throw new Error("workspace snapshot binding name is duplicated");
		existingNames.add(binding.name);
		const snapshot = byId.get(binding.snapshotId);
		if (!snapshot)
			throw new Error("workspace snapshot is unavailable to the owner");
		totalBytes += snapshot.sizeBytes;
	}
	assertWorkspaceSnapshotBindingQuotaV1({
		existingCount: 0,
		existingBytes: 0,
		nextBytes: totalBytes,
	});
	for (const binding of bindings) {
		const snapshot = byId.get(binding.snapshotId);
		if (!snapshot)
			throw new Error("workspace snapshot is unavailable to the owner");
		await transaction.insert(workspaceSnapshotBindings).values({
			snapshotId: snapshot.id,
			agentId: input.agentId,
			configurationRevision: input.configurationRevision,
			name: binding.name,
			digest: snapshot.digest,
			sizeBytes: snapshot.sizeBytes,
		});
	}
}
