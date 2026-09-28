import type { DirectorySnapshot } from "./snapshot.js";

export interface DirectoryStore {
	beginScan(): Promise<bigint>;
	publish(
		snapshot: DirectorySnapshot,
		generation: bigint,
	): Promise<"published" | "superseded">;
	latest(): Promise<DirectorySnapshot | null>;
	close(): Promise<void>;
}
