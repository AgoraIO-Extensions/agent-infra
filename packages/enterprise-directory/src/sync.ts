import { createSnapshot, type DirectorySnapshot } from "./snapshot.js";
import type { DirectoryStore } from "./store.js";
import type { createWeComSource } from "./wecom.js";

const SCAN_HEADROOM_MS = 4 * 60 * 60_000;

export interface DirectorySyncInput {
	store: DirectoryStore;
	source: ReturnType<typeof createWeComSource>;
	rootDepartmentId: number;
	now?: () => number;
}

export class DirectorySyncError extends Error {
	constructor(
		readonly reason:
			| "source_unavailable"
			| "invalid_snapshot"
			| "store_unavailable",
	) {
		super("Enterprise directory sync failed");
	}
}

export function nextSyncDelay(validUntil: number, now: number): number {
	return Math.max(0, validUntil - SCAN_HEADROOM_MS - now);
}

export function createDirectorySynchronizer(input: DirectorySyncInput) {
	const now = input.now ?? Date.now;
	return {
		async syncOnce() {
			let generation: bigint;
			try {
				generation = await input.store.beginScan();
			} catch {
				throw new DirectorySyncError("store_unavailable");
			}
			const startedAt = now();
			let complete: Awaited<ReturnType<typeof input.source.fetchComplete>>;
			try {
				complete = await input.source.fetchComplete();
			} catch {
				throw new DirectorySyncError("source_unavailable");
			}
			let snapshot: DirectorySnapshot;
			try {
				snapshot = createSnapshot({
					...complete,
					rootDepartmentId: input.rootDepartmentId,
					startedAt,
					completedAt: now(),
				});
			} catch {
				throw new DirectorySyncError("invalid_snapshot");
			}
			let status: "published" | "superseded";
			try {
				status = await input.store.publish(snapshot, generation);
			} catch {
				throw new DirectorySyncError("store_unavailable");
			}
			return status === "published"
				? {
						status,
						revision: snapshot.revision,
						fetchedAt: snapshot.fetchedAt,
						validUntil: snapshot.validUntil,
					}
				: { status };
		},
	};
}
