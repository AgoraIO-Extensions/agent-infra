import { randomUUID } from "node:crypto";
import {
	type AgentConfigurationRecord,
	assertWorkspaceSnapshotBindingQuotaV1,
	WorkspaceSnapshotBindingErrorV1,
	workspaceSnapshotMountPathV1,
} from "@agent-infra/platform-core";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import {
	agentApplications,
	agentOwners,
	agents,
	auditEvents,
	workspaceSnapshotBindings,
	workspaceSnapshots,
} from "./schema.js";

type Transaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];
type Owner = {
	readonly ownerType: "user" | "application";
	readonly ownerId: string;
};

/** The Agent lock serializes attachment quota and owner handoff with configuration writes. */
export async function assertWorkspaceSnapshotTargetOwnerV1(
	transaction: Transaction,
	input: Owner & { readonly agentId: string },
): Promise<void> {
	const [agent] = await transaction
		.select({ id: agents.id })
		.from(agents)
		.where(eq(agents.id, input.agentId))
		.for("update")
		.limit(1);
	if (!agent) throw new WorkspaceSnapshotBindingErrorV1("not_found");
	const [owner] =
		input.ownerType === "user"
			? await transaction
					.select({ id: agentOwners.ownerId })
					.from(agentOwners)
					.where(
						and(
							eq(agentOwners.agentId, input.agentId),
							eq(agentOwners.ownerId, input.ownerId),
						),
					)
					.for("share")
					.limit(1)
			: await transaction
					.select({ id: agentApplications.creatorPrincipalId })
					.from(agentApplications)
					.where(
						and(
							eq(agentApplications.agentId, input.agentId),
							eq(agentApplications.creationChannel, "api"),
							eq(agentApplications.creatorPrincipalType, "application"),
							eq(agentApplications.creatorPrincipalId, input.ownerId),
						),
					)
					.for("share")
					.limit(1);
	if (!owner) throw new WorkspaceSnapshotBindingErrorV1("forbidden");
}

/** Snapshot rows are copied with the configuration revision; only new attachments use caller ownership. */
export async function insertWorkspaceSnapshotBindingsV1(
	transaction: Transaction,
	input: Owner & {
		readonly agentId: string;
		readonly configurationRevision: number;
		readonly previousConfigurationRevision?: number;
		readonly configuration: AgentConfigurationRecord;
	},
): Promise<void> {
	if (input.configurationRevision === input.previousConfigurationRevision)
		return;
	const bindings =
		input.configuration.source.kind === "custom"
			? (input.configuration.source.workspaceSnapshots ?? [])
			: [];
	const previous =
		input.previousConfigurationRevision === undefined
			? []
			: await transaction
					.select()
					.from(workspaceSnapshotBindings)
					.where(
						and(
							eq(workspaceSnapshotBindings.agentId, input.agentId),
							eq(
								workspaceSnapshotBindings.configurationRevision,
								input.previousConfigurationRevision,
							),
						),
					)
					.for("share");
	if (bindings.length === 0) {
		for (const row of previous) {
			await transaction.insert(auditEvents).values({
				id: randomUUID(),
				traceId: randomUUID(),
				requestId: randomUUID(),
				actorType: input.ownerType,
				actorId: input.ownerId,
				action: "workspace.snapshot.unbound",
				targetType: "workspace_snapshot",
				targetId: row.snapshotId,
				outcome: "succeeded",
				details: {
					agentId: row.agentId,
					configurationRevision: input.configurationRevision,
					name: row.name,
					digest: row.digest,
				},
			});
		}
		return;
	}
	const names = new Set<string>();
	const ids = new Set<string>();
	for (const binding of bindings) {
		workspaceSnapshotMountPathV1(binding.name);
		if (names.has(binding.name) || ids.has(binding.snapshotId))
			throw new WorkspaceSnapshotBindingErrorV1("conflict");
		names.add(binding.name);
		ids.add(binding.snapshotId);
	}
	const retained = new Map(previous.map((row) => [row.snapshotId, row]));
	const added = bindings.filter(
		({ snapshotId, name }) => retained.get(snapshotId)?.name !== name,
	);
	if (added.length)
		await assertWorkspaceSnapshotTargetOwnerV1(transaction, input);
	const snapshots = added.length
		? await transaction
				.select({
					id: workspaceSnapshots.id,
					digest: workspaceSnapshots.digest,
					sizeBytes: workspaceSnapshots.unpackedSizeBytes,
				})
				.from(workspaceSnapshots)
				.where(
					and(
						eq(workspaceSnapshots.ownerType, input.ownerType),
						eq(workspaceSnapshots.ownerId, input.ownerId),
						eq(workspaceSnapshots.status, "ready"),
						inArray(
							workspaceSnapshots.id,
							added.map(({ snapshotId }) => snapshotId),
						),
					),
				)
				.orderBy(asc(workspaceSnapshots.id))
				.for("share")
		: [];
	const newById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
	if (newById.size !== added.length)
		throw new WorkspaceSnapshotBindingErrorV1("not_found");
	let count = 0;
	let totalBytes = 0;
	const rows = bindings.map(({ snapshotId, name }) => {
		const old = retained.get(snapshotId);
		const snapshot = old?.name === name ? old : newById.get(snapshotId);
		if (!snapshot) throw new WorkspaceSnapshotBindingErrorV1("not_found");
		assertWorkspaceSnapshotBindingQuotaV1({
			existingCount: count,
			existingBytes: totalBytes,
			nextBytes: snapshot.sizeBytes,
		});
		count++;
		totalBytes += snapshot.sizeBytes;
		return {
			snapshotId,
			agentId: input.agentId,
			configurationRevision: input.configurationRevision,
			name,
			digest: snapshot.digest,
			sizeBytes: snapshot.sizeBytes,
		};
	});
	await transaction.insert(workspaceSnapshotBindings).values(rows);
	for (const row of previous) {
		const next = bindings.find(
			(binding) =>
				binding.snapshotId === row.snapshotId && binding.name === row.name,
		);
		if (next) continue;
		await transaction.insert(auditEvents).values({
			id: randomUUID(),
			traceId: randomUUID(),
			requestId: randomUUID(),
			actorType: input.ownerType,
			actorId: input.ownerId,
			action: "workspace.snapshot.unbound",
			targetType: "workspace_snapshot",
			targetId: row.snapshotId,
			outcome: "succeeded",
			details: {
				agentId: row.agentId,
				configurationRevision: input.configurationRevision,
				name: row.name,
				digest: row.digest,
			},
		});
	}
	for (const row of rows) {
		await transaction.insert(auditEvents).values({
			id: randomUUID(),
			traceId: randomUUID(),
			requestId: randomUUID(),
			actorType: input.ownerType,
			actorId: input.ownerId,
			action: "workspace.snapshot.bound",
			targetType: "workspace_snapshot",
			targetId: row.snapshotId,
			outcome: "succeeded",
			details: {
				agentId: row.agentId,
				configurationRevision: row.configurationRevision,
				name: row.name,
				digest: row.digest,
			},
		});
	}
}
