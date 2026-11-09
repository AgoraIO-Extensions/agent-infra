import type { ObjectStorageDataV1 } from "@agent-infra/object-storage";
import type { WorkspaceSnapshotGcResultV1 } from "@agent-infra/platform-core";
import {
	PostgresWorkspaceSnapshotStoreV1,
	PostgresWorkspaceSnapshotUploadStoreV1,
} from "@agent-infra/platform-store";

type UploadRecoveryResult = Awaited<
	ReturnType<
		PostgresWorkspaceSnapshotUploadStoreV1["collectExpiredUploadReservations"]
	>
>;
type UploadObjectRecoveryResult = Awaited<
	ReturnType<PostgresWorkspaceSnapshotUploadStoreV1["collectUploadObjects"]>
>;

export interface WorkspaceSnapshotGcDeploymentV1 {
	readonly retentionMs: number;
	readonly intervalMs: number;
	/** Only bounded counters/timing are supplied; never storage errors or object identities. */
	readonly observe: (
		result: WorkspaceSnapshotGcResultV1 & {
			durationMs: number;
			storedBytes: number | null;
			oldestEligibleDelayMs: number | null;
			outcome: "completed" | "unavailable";
			uploadReservations: UploadRecoveryResult;
			uploadObjects: UploadObjectRecoveryResult;
		},
	) => void;
}

export function startWorkspaceSnapshotGcV1(input: {
	databaseUrl: string;
	storage: Pick<ObjectStorageDataV1, "remove" | "scan" | "fenceUpload">;
	policy: WorkspaceSnapshotGcDeploymentV1;
}) {
	const { policy } = input;
	if (
		!Number.isSafeInteger(policy.retentionMs) ||
		policy.retentionMs < 0 ||
		!Number.isSafeInteger(policy.intervalMs) ||
		policy.intervalMs < 1000 ||
		policy.intervalMs > 2147483647 ||
		typeof policy.observe !== "function" ||
		typeof input.storage.scan !== "function" ||
		typeof input.storage.fenceUpload !== "function" ||
		typeof input.storage.remove !== "function"
	)
		throw new Error("WORKSPACE_SNAPSHOT_GC_CONFIGURATION_INVALID");
	const store = new PostgresWorkspaceSnapshotStoreV1(input.databaseUrl);
	const uploads = new PostgresWorkspaceSnapshotUploadStoreV1(input.databaseUrl);
	let closed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let running: Promise<void> = Promise.resolve();
	async function run() {
		const start = Date.now();
		let uploadReservations: UploadRecoveryResult;
		let uploadObjects: UploadObjectRecoveryResult;
		try {
			uploadObjects = await uploads.collectUploadObjects({
				now: new Date(),
				storage: input.storage,
			});
		} catch {
			uploadObjects = {
				scanned: 0,
				deletedVersions: 0,
				reconciled: 0,
				released: 0,
				continued: 0,
				failed: 1,
			};
		}
		try {
			uploadReservations = await uploads.collectExpiredUploadReservations({
				now: new Date(),
				deleter: {
					deleteObjectVersion: ({ objectRef, objectVersion }) =>
						input.storage.remove(objectRef, objectVersion),
				},
			});
		} catch {
			uploadReservations = {
				scanned: 0,
				released: 0,
				reconciled: 0,
				failed: 1,
			};
		}
		let result: WorkspaceSnapshotGcResultV1 & {
			outcome: "completed" | "unavailable";
		};
		try {
			result = {
				...(await store.collectExpired({
					now: new Date(),
					retentionMs: policy.retentionMs,
					deleter: {
						deleteObjectVersion: ({ objectRef, objectVersion }) =>
							input.storage.remove(objectRef, objectVersion),
					},
				})),
				outcome: "completed",
			};
		} catch {
			result = { scanned: 0, deleted: 0, failed: 1, outcome: "unavailable" };
		}
		if (uploadReservations.failed > 0 || uploadObjects.failed > 0)
			result = { ...result, outcome: "unavailable" };
		let metrics: {
			storedBytes: number | null;
			oldestEligibleDelayMs: number | null;
		} = { storedBytes: null, oldestEligibleDelayMs: null };
		try {
			metrics = await store.readGcMetrics({
				now: new Date(),
				retentionMs: policy.retentionMs,
			});
		} catch {
			result = { ...result, outcome: "unavailable" };
		}
		try {
			await Promise.resolve(
				policy.observe({
					...result,
					...metrics,
					uploadReservations,
					uploadObjects,
					durationMs: Date.now() - start,
				}),
			);
		} catch {
			/* Telemetry failure must not stop retries. */
		}
		if (!closed) schedule();
	}
	function schedule() {
		timer = setTimeout(() => {
			running = run();
		}, policy.intervalMs);
		timer.unref();
	}
	schedule();
	return {
		async close() {
			closed = true;
			clearTimeout(timer);
			await running;
			await Promise.all([store.close(), uploads.close()]);
		},
	};
}
