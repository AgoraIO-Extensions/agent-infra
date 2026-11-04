import postgres from "postgres";
import {
	createWorkspaceSnapshotResolverV1,
	type WorkspaceSnapshotResolverRecordV1,
} from "./workspace-snapshot-resolver.js";

type Row = {
	snapshot_id: string;
	name: string;
	binding_digest: string;
	binding_size: string | number;
	digest: string;
	size_bytes: string | number;
	object_ref: string;
	object_version: string;
	status: string;
	revision: string | number;
	state: unknown;
};

/** Production reader: only the persisted binding/reconciliation rows can widen the input. */
export function createPostgresWorkspaceSnapshotResolverV1(input: {
	readonly databaseUrl: string;
	readonly createReadUrl: Parameters<
		typeof createWorkspaceSnapshotResolverV1
	>[0]["createReadUrl"];
	readonly policy: Parameters<
		typeof createWorkspaceSnapshotResolverV1
	>[0]["policy"];
	readonly allowedOrigins: readonly string[];
}) {
	const client = postgres(input.databaseUrl, {
		max: 2,
		connect_timeout: 5,
		idle_timeout: 10,
	});
	const resolver = createWorkspaceSnapshotResolverV1({
		policy: input.policy,
		allowedOrigins: input.allowedOrigins,
		createReadUrl: input.createReadUrl,
		read: async (
			value,
		): Promise<readonly WorkspaceSnapshotResolverRecordV1[]> => {
			const rows = await client<Row[]>`
				select b.snapshot_id, b.name, b.digest as binding_digest,
				       b.size_bytes as binding_size, s.digest, s.size_bytes,
				       s.object_ref, s.object_version, s.status,
				       r.revision, r.state
				from platform.workspace_snapshot_bindings b
				join platform.workspace_snapshots s on s.id = b.snapshot_id
				join platform.workload_reconciliations r on r.agent_id = b.agent_id
				where b.agent_id = ${value.agentId}
				  and b.configuration_revision = ${value.configurationRevision}
				  and r.revision = ${value.workloadRevision}
				  and s.status = 'ready'
				order by b.name asc
			`;
			if (rows.length !== value.bindings.length) throw new Error();
			const expectedFence = value.fence;
			return rows.map((row) => {
				const state = row.state;
				if (
					row.status !== "ready" ||
					Number(row.revision) !== value.workloadRevision ||
					!state ||
					typeof state !== "object" ||
					Array.isArray(state) ||
					(state as Record<string, unknown>).fence !== expectedFence ||
					row.binding_digest !== row.digest ||
					Number(row.binding_size) !== Number(row.size_bytes)
				)
					throw new Error();
				return {
					snapshotId: row.snapshot_id,
					name: row.name,
					digest: row.digest,
					sizeBytes: Number(row.size_bytes),
					objectRef: row.object_ref,
					objectVersion: row.object_version,
				};
			});
		},
	});
	return { resolver, close: () => client.end({ timeout: 5000 }) };
}
