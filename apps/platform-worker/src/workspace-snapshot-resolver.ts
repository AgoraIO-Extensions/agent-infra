import {
	projectWorkspaceSnapshotMaterializerV1,
	type WorkspaceSnapshotMaterializerInputV1,
	type WorkspaceSnapshotMaterializerPolicyV1,
} from "./workspace-snapshot-materializer.js";

export interface WorkspaceSnapshotResolverRecordV1 {
	readonly snapshotId: string;
	readonly name: string;
	readonly digest: string;
	readonly sizeBytes: number;
	readonly objectRef: string;
	readonly objectVersion: string;
}

/**
 * Builds the Worker resolver from deployment-owned Store and object-storage
 * adapters. The caller supplies only persisted binding names and revisions.
 */
export function createWorkspaceSnapshotResolverV1(input: {
	readonly read: (value: {
		readonly agentId: string;
		readonly configurationRevision: number;
		readonly workloadRevision: number;
		readonly fence: number;
		readonly bindings: readonly { snapshotId: string; name: string }[];
	}) => Promise<readonly WorkspaceSnapshotResolverRecordV1[]>;
	readonly createReadUrl: (value: {
		readonly objectRef: string;
		readonly objectVersion: string;
		readonly expiresInSeconds: number;
	}) => Promise<{ readonly signedUrl: string; readonly expiresAt: string }>;
	readonly policy: WorkspaceSnapshotMaterializerPolicyV1;
	readonly allowedOrigins: readonly string[];
}) {
	return async (value: Parameters<typeof input.read>[0]) => {
		const records = await input.read(value);
		if (records.length !== value.bindings.length) throw new Error();
		const byId = new Map(
			value.bindings.map((binding) => [binding.snapshotId, binding]),
		);
		const names = new Set<string>();
		const snapshots: WorkspaceSnapshotMaterializerInputV1[] = [];
		for (const record of records) {
			const binding = byId.get(record.snapshotId);
			if (!binding || binding.name !== record.name || names.has(record.name))
				throw new Error();
			names.add(record.name);
			const { signedUrl, expiresAt } = await input.createReadUrl({
				objectRef: record.objectRef,
				objectVersion: record.objectVersion,
				expiresInSeconds: 300,
			});
			const url = new URL(signedUrl);
			if (
				url.protocol !== "https:" ||
				url.username ||
				url.password ||
				!input.allowedOrigins.includes(url.origin)
			)
				throw new Error();
			snapshots.push({
				snapshotId: record.snapshotId,
				name: record.name,
				digest: record.digest,
				sizeBytes: record.sizeBytes,
				objectRef: record.objectRef,
				signedUrl,
				expiresAt,
			});
		}
		return {
			inputs: snapshots,
			projection: projectWorkspaceSnapshotMaterializerV1(
				snapshots,
				input.policy,
			),
		};
	};
}
