import { createHash } from "node:crypto";

export const workspaceSnapshotLimitsV1 = Object.freeze({
	maxSnapshotsPerAgent: 4,
	maxArchiveBytes: 2 * 1024 ** 3,
	maxUnpackedBytes: 2 * 1024 ** 3,
	maxOwnerBytes: 10 * 1024 ** 3,
	maxFiles: 100_000,
	maxPathBytes: 1024,
});

export type WorkspaceSnapshotErrorCodeV1 =
	| "invalid_digest"
	| "invalid_name"
	| "duplicate_name"
	| "reserved_mount_path"
	| "snapshot_limit_exceeded"
	| "bound";

export class WorkspaceSnapshotErrorV1 extends Error {
	readonly code: WorkspaceSnapshotErrorCodeV1;
	constructor(code: WorkspaceSnapshotErrorCodeV1) {
		super(code);
		this.name = "WorkspaceSnapshotErrorV1";
		this.code = code;
	}
}

export interface WorkspaceSnapshotRecordV1 {
	readonly snapshotId: string;
	readonly ownerType: "user" | "application";
	readonly ownerId: string;
	readonly digest: string;
	readonly sizeBytes: number;
	readonly unpackedSizeBytes: number;
	readonly fileCount: number;
	readonly mediaType: "application/x-tar+gzip";
	readonly source: Record<string, unknown>;
	readonly objectRef: string;
	readonly objectVersion: string;
	readonly status: "ready" | "deleting" | "deleted";
	readonly createdAt: string;
	readonly bindings: readonly {
		readonly agentId: string;
		readonly configurationRevision: number;
		readonly name: string;
		readonly digest: string;
		readonly sizeBytes: number;
	}[];
}

export interface WorkspaceSnapshotStoreV1 {
	create(record: WorkspaceSnapshotRecordV1): Promise<WorkspaceSnapshotRecordV1>;
	list(owner: {
		ownerType: "user" | "application";
		ownerId: string;
	}): Promise<readonly WorkspaceSnapshotRecordV1[]>;
	get(
		owner: { ownerType: "user" | "application"; ownerId: string },
		snapshotId: string,
	): Promise<WorkspaceSnapshotRecordV1 | null>;
	remove(
		owner: { ownerType: "user" | "application"; ownerId: string },
		snapshotId: string,
	): Promise<WorkspaceSnapshotRecordV1>;
}

const snapshotName = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const reservedRoots = ["/workspace", "/tmp", "/data"];

export function workspaceSnapshotMountPathV1(name: string): string {
	if (!snapshotName.test(name) || Buffer.byteLength(name) > 63)
		throw new WorkspaceSnapshotErrorV1("invalid_name");
	const path = `/opt/agent/workspaces/${name}`;
	if (
		reservedRoots.some((root) => path === root || path.startsWith(`${root}/`))
	)
		throw new WorkspaceSnapshotErrorV1("reserved_mount_path");
	return path;
}

export function normalizeWorkspaceSnapshotBindingsV1(
	bindings: readonly { snapshotId: string; name: string }[],
) {
	if (bindings.length > workspaceSnapshotLimitsV1.maxSnapshotsPerAgent)
		throw new WorkspaceSnapshotErrorV1("snapshot_limit_exceeded");
	const names = new Set<string>();
	return bindings
		.map((binding) => {
			const mountPath = workspaceSnapshotMountPathV1(binding.name);
			if (names.has(binding.name))
				throw new WorkspaceSnapshotErrorV1("duplicate_name");
			names.add(binding.name);
			if (binding.snapshotId.length === 0)
				throw new WorkspaceSnapshotErrorV1("invalid_name");
			return Object.freeze({ ...binding, mountPath });
		})
		.toSorted((left, right) => left.name.localeCompare(right.name));
}

export function validateWorkspaceSnapshotDigestV1(
	bytes: Uint8Array,
	expected: string,
) {
	if (!digest.test(expected))
		throw new WorkspaceSnapshotErrorV1("invalid_digest");
	const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
	if (actual !== expected) throw new WorkspaceSnapshotErrorV1("invalid_digest");
	return actual;
}
