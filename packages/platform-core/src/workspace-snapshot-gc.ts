import {
	isWorkspaceSnapshotGcEligibleV1,
	type WorkspaceSnapshotGcCandidateV1,
} from "./workspace-snapshot-security.js";

type SnapshotGcCandidateV1 = WorkspaceSnapshotGcCandidateV1 & {
	readonly objectRef: string;
	readonly objectVersion: string;
};

export type WorkspaceSnapshotGcPlanV1 = {
	readonly snapshotId: string;
	readonly objectRef: string;
	readonly objectVersion: string;
};

/** Select immutable objects that may be deleted by the deployment-owned GC worker. */
export function planWorkspaceSnapshotGcV1(input: {
	readonly candidates: readonly SnapshotGcCandidateV1[];
	readonly now: Date;
	readonly retentionMs: number;
}): readonly WorkspaceSnapshotGcPlanV1[] {
	if (!Number.isSafeInteger(input.retentionMs) || input.retentionMs < 0)
		throw new Error("workspace snapshot retention is invalid");
	return input.candidates
		.filter((candidate) =>
			isWorkspaceSnapshotGcEligibleV1({
				candidate,
				now: input.now,
				retentionMs: input.retentionMs,
			}),
		)
		.map(({ snapshotId, objectRef, objectVersion }) => ({
			snapshotId,
			objectRef,
			objectVersion,
		}))
		.toSorted((left, right) => left.snapshotId.localeCompare(right.snapshotId));
}
