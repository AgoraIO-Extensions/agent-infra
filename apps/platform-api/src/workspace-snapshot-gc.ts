import type { ObjectStorageDataV1 } from "@agent-infra/object-storage";
import type { WorkspaceSnapshotGcResultV1 } from "@agent-infra/platform-core";
import { PostgresWorkspaceSnapshotStoreV1 } from "@agent-infra/platform-store";

export interface WorkspaceSnapshotGcDeploymentV1 {
	readonly retentionMs: number;
	readonly intervalMs: number;
	/** Only bounded counters/timing are supplied; never storage errors or object identities. */
	readonly observe: (
		result: WorkspaceSnapshotGcResultV1 & {
			durationMs: number;
			outcome: "completed" | "unavailable";
		},
	) => void;
}

export function startWorkspaceSnapshotGcV1(input: {
	databaseUrl: string;
	storage: Pick<ObjectStorageDataV1, "remove">;
	policy: WorkspaceSnapshotGcDeploymentV1;
}) {
	const { policy } = input;
	if (
		!Number.isSafeInteger(policy.retentionMs) ||
		policy.retentionMs < 0 ||
		!Number.isSafeInteger(policy.intervalMs) ||
		policy.intervalMs < 1000 ||
		policy.intervalMs > 2147483647 ||
		typeof policy.observe !== "function"
	)
		throw new Error("WORKSPACE_SNAPSHOT_GC_CONFIGURATION_INVALID");
	const store = new PostgresWorkspaceSnapshotStoreV1(input.databaseUrl);
	let closed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let running: Promise<void> = Promise.resolve();
	async function run() {
		const start = Date.now();
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
		try {
			policy.observe({ ...result, durationMs: Date.now() - start });
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
			await store.close();
		},
	};
}
