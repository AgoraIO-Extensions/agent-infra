import postgres from "./observed-postgres.js";

export interface WorkspaceSnapshotMaterializationReadV1 {
	readonly agentId: string;
	readonly configurationRevision: number;
	readonly workloadRevision: number;
	readonly fence: number;
	readonly bindings: readonly { snapshotId: string; name: string }[];
}
export interface WorkspaceSnapshotMaterializationRecordV1 {
	readonly snapshotId: string;
	readonly name: string;
	readonly digest: string;
	readonly sizeBytes: number;
	readonly objectRef: string;
	readonly objectVersion: string;
}
type Row = {
	snapshot_id: string;
	name: string;
	binding_digest: string;
	binding_size: string | number;
	digest: string;
	size_bytes: string | number;
	unpacked_size_bytes: string | number;
	object_ref: string;
	object_version: string;
	status: string;
	revision: string | number;
	state: unknown;
};

/** Reads immutable binding metadata; signing credentials stay outside Store. */
export function openPostgresWorkspaceSnapshotMaterializationReaderV1(
	databaseUrl: string,
) {
	const client = postgres(databaseUrl, {
		max: 2,
		connect_timeout: 5,
		idle_timeout: 10,
	});
	return {
		async read(
			value: WorkspaceSnapshotMaterializationReadV1,
		): Promise<readonly WorkspaceSnapshotMaterializationRecordV1[]> {
			const rows = await client<Row[]>`
				select b.snapshot_id, b.name, b.digest as binding_digest,
				       b.size_bytes as binding_size, s.digest, s.size_bytes, s.unpacked_size_bytes,
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
					Number(row.binding_size) !== Number(row.unpacked_size_bytes)
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
		close: () => client.end({ timeout: 5 }),
	};
}
