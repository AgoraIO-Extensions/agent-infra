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

export class WorkspaceSnapshotBindingErrorV1 extends Error {
	constructor(
		readonly code: "forbidden" | "conflict" | "quota_exceeded" | "not_found",
	) {
		super(code);
		this.name = "WorkspaceSnapshotBindingErrorV1";
	}
}

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

export interface WorkspaceSnapshotPrincipalV1 {
	readonly kind: "user" | "application";
	readonly id: string;
	readonly scopes: readonly string[];
}

export interface WorkspaceSnapshotUploadStoreV1 {
	findIdempotency(
		owner: WorkspaceSnapshotPrincipalV1,
		key: string,
	): Promise<{
		readonly requestDigest: string;
		readonly record: WorkspaceSnapshotRecordV1;
	} | null>;
	create(
		record: WorkspaceSnapshotRecordV1,
		owner: WorkspaceSnapshotPrincipalV1,
		idempotencyKey: string,
		requestDigest: string,
	): Promise<WorkspaceSnapshotRecordV1>;
	list(
		owner: WorkspaceSnapshotPrincipalV1,
	): Promise<readonly WorkspaceSnapshotRecordV1[]>;
	get(
		owner: WorkspaceSnapshotPrincipalV1,
		snapshotId: string,
	): Promise<WorkspaceSnapshotRecordV1 | null>;
	remove(
		owner: WorkspaceSnapshotPrincipalV1,
		snapshotId: string,
	): Promise<WorkspaceSnapshotRecordV1>;
}

export interface WorkspaceSnapshotQuotaReaderV1 {
	read(owner: WorkspaceSnapshotPrincipalV1): Promise<{
		readonly ownerStoredBytes: number;
		readonly agentArchiveBytes: number;
		readonly agentUnpackedBytes: number;
		readonly agentBindingCount: number;
	}>;
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

export interface WorkspaceSnapshotBindingStoreV1 {
	bind(input: {
		readonly ownerType: "user" | "application";
		readonly ownerId: string;
		readonly snapshotId: string;
		readonly agentId: string;
		readonly configurationRevision: number;
		readonly name: string;
	}): Promise<WorkspaceSnapshotRecordV1["bindings"][number]>;
	unbind(input: {
		readonly ownerType: "user" | "application";
		readonly ownerId: string;
		readonly snapshotId: string;
		readonly agentId: string;
		readonly configurationRevision: number;
	}): Promise<void>;
}

export function assertWorkspaceSnapshotBindingQuotaV1(input: {
	readonly existingCount: number;
	readonly existingBytes: number;
	readonly nextBytes: number;
}): void {
	if (
		!Number.isSafeInteger(input.existingCount) ||
		!Number.isSafeInteger(input.existingBytes) ||
		!Number.isSafeInteger(input.nextBytes) ||
		input.existingCount < 0 ||
		input.existingBytes < 0 ||
		input.nextBytes <= 0 ||
		input.existingCount >= workspaceSnapshotLimitsV1.maxSnapshotsPerAgent ||
		input.existingBytes + input.nextBytes >
			workspaceSnapshotLimitsV1.maxUnpackedBytes
	)
		throw new WorkspaceSnapshotBindingErrorV1("quota_exceeded");
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
