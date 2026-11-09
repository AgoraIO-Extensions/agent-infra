import {
	WorkspaceSnapshotErrorV1,
	workspaceSnapshotLimitsV1,
} from "./workspace-snapshot.js";

export interface WorkspaceSnapshotUploadPolicyV1 {
	readonly maximumConcurrentUploads: number;
	readonly maximumConcurrentUploadsPerOwner: number;
	readonly maximumRequestsPerWindow: number;
	readonly maximumGlobalRequestsPerWindow: number;
	readonly rateWindowMs: number;
	readonly uploadTimeoutMs: number;
	readonly admissionLeaseMs: number;
	/** Conservative aggregate allowance for live archive spools, separate from object storage. */
	readonly maximumTemporaryBytes: number;
}

const defaults: WorkspaceSnapshotUploadPolicyV1 = Object.freeze({
	maximumConcurrentUploads: 4,
	maximumConcurrentUploadsPerOwner: 2,
	maximumRequestsPerWindow: 60,
	maximumGlobalRequestsPerWindow: 600,
	rateWindowMs: 60_000,
	uploadTimeoutMs: 300_000,
	admissionLeaseMs: 360_000,
	maximumTemporaryBytes: 8 * 1024 ** 3,
});

function parse(
	input: WorkspaceSnapshotUploadPolicyV1,
): WorkspaceSnapshotUploadPolicyV1 {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new WorkspaceSnapshotErrorV1("invalid_input");
	const keys = Object.keys(
		defaults,
	) as (keyof WorkspaceSnapshotUploadPolicyV1)[];
	if (
		Object.keys(input).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(input, key))
	)
		throw new WorkspaceSnapshotErrorV1("invalid_input");
	const policy = Object.fromEntries(
		keys.map((key) => [key, input[key]]),
	) as unknown as WorkspaceSnapshotUploadPolicyV1;
	if (
		Object.values(policy).some((n) => !Number.isSafeInteger(n) || n < 1) ||
		policy.maximumConcurrentUploads > 1000 ||
		policy.maximumConcurrentUploadsPerOwner > policy.maximumConcurrentUploads ||
		policy.maximumRequestsPerWindow > 100_000 ||
		policy.maximumGlobalRequestsPerWindow > 100_000 ||
		policy.maximumRequestsPerWindow > policy.maximumGlobalRequestsPerWindow ||
		policy.rateWindowMs > 86_400_000 ||
		policy.uploadTimeoutMs > 3_600_000 ||
		policy.admissionLeaseMs < policy.uploadTimeoutMs + 30_000 ||
		policy.admissionLeaseMs > 86_400_000 ||
		policy.maximumTemporaryBytes < workspaceSnapshotLimitsV1.maxArchiveBytes
	)
		throw new WorkspaceSnapshotErrorV1("invalid_input");
	return Object.freeze(policy);
}

function assertAdmitted(
	policy: WorkspaceSnapshotUploadPolicyV1,
	usage: {
		readonly activeUploads: number;
		readonly activeOwnerUploads: number;
		readonly ownerRequestsInWindow: number;
		readonly requestsInWindow: number;
		readonly temporaryBytes: number;
	},
) {
	if (Object.values(usage).some((n) => !Number.isSafeInteger(n) || n < 0))
		throw new WorkspaceSnapshotErrorV1("unavailable");
	if (
		usage.activeUploads >= policy.maximumConcurrentUploads ||
		usage.activeOwnerUploads >= policy.maximumConcurrentUploadsPerOwner ||
		usage.ownerRequestsInWindow >= policy.maximumRequestsPerWindow ||
		usage.requestsInWindow >= policy.maximumGlobalRequestsPerWindow ||
		usage.temporaryBytes >
			policy.maximumTemporaryBytes - workspaceSnapshotLimitsV1.maxArchiveBytes
	)
		throw new WorkspaceSnapshotErrorV1("rate_limited");
}

export const workspaceSnapshotUploadPolicyV1 = Object.freeze({
	defaults,
	parse,
	assertAdmitted,
});
