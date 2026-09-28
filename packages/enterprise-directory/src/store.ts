import type { DirectorySnapshot } from "./snapshot.js";

export interface DirectoryStore {
	publish(snapshot: DirectorySnapshot): Promise<void>;
	latest(): Promise<DirectorySnapshot | null>;
	close(): Promise<void>;
}
