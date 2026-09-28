import type {
	DirectorySnapshot,
	DirectorySnapshotSummary,
} from "./snapshot.js";

export type DirectoryPublishResult =
	| { status: "published"; summary: DirectorySnapshotSummary }
	| { status: "superseded" };

export interface DirectoryStore {
	beginScan(): Promise<bigint>;
	publish(
		snapshot: DirectorySnapshot,
		generation: bigint,
	): Promise<DirectoryPublishResult>;
	latest(): Promise<DirectorySnapshot | null>;
	close(): Promise<void>;
}
