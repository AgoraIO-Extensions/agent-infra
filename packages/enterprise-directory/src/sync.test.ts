import { describe, expect, it } from "vitest";
import type { DirectorySnapshot } from "./snapshot.js";
import { summarizeSnapshotChange } from "./snapshot.js";
import type { DirectoryStore } from "./store.js";
import { createDirectorySynchronizer, nextSyncDelay } from "./sync.js";
import type { createWeComSource } from "./wecom.js";

const hour = 60 * 60_000;
const initial = Date.UTC(2026, 8, 28);

describe("directory synchronization", () => {
	it("preserves independent source provenance through publication and wire readback", async () => {
		const { fromDirectorySnapshot, toDirectorySnapshot } = await import(
			"./wire.js"
		);
		let current: DirectorySnapshot | null = null;
		const store: DirectoryStore = {
			beginScan: async () => 1n,
			publish: async (snapshot) => {
				current = snapshot;
				return {
					status: "published",
					summary: summarizeSnapshotChange(snapshot, null),
				};
			},
			latest: async () => current,
			close: async () => {},
		};
		const sync = createDirectorySynchronizer({
			store,
			sourceId: "enterprise-tools",
			rootDepartmentId: 1,
			now: () => initial,
			source: {
				fetchComplete: async () => ({
					departments: [{ id: 1, name: "Company", parentId: 0 }],
					members: [],
				}),
			},
		});
		expect((await sync.syncOnce()).status).toBe("published");
		const published = await store.latest();
		if (!published) throw new Error("missing snapshot");
		expect(fromDirectorySnapshot(toDirectorySnapshot(published)).source).toBe(
			"enterprise-tools",
		);
		const invalid = createDirectorySynchronizer({
			store,
			sourceId: "https://source.test",
			rootDepartmentId: 1,
			source: {
				fetchComplete: async () => ({
					departments: [{ id: 1, name: "Company", parentId: 0 }],
					members: [],
				}),
			},
		});
		await expect(invalid.syncOnce()).rejects.toMatchObject({
			reason: "invalid_snapshot",
		});
		expect(await store.latest()).toEqual(published);
	});
	it("starts the next full scan before a slow prior snapshot expires", async () => {
		let clock = initial;
		let generation = 0n;
		let current: DirectorySnapshot | null = null;
		const delays = [2 * hour, hour];
		const store: DirectoryStore = {
			beginScan: async () => ++generation,
			publish: async (snapshot) => {
				const summary = summarizeSnapshotChange(snapshot, current);
				current = snapshot;
				return { status: "published", summary };
			},
			latest: async () => current,
			close: async () => {},
		};
		const source = {
			async fetchComplete() {
				clock += delays.shift() ?? 0;
				return {
					departments: [{ id: 1, name: "Company", parentId: 0 }],
					members: [],
				};
			},
		} as ReturnType<typeof createWeComSource>;
		const sync = createDirectorySynchronizer({
			store,
			source,
			rootDepartmentId: 1,
			now: () => clock,
		});
		const first = await sync.syncOnce();
		expect(first.status).toBe("published");
		if (first.status !== "published") throw new Error("first scan missing");
		expect(first.summary.baselineRevision).toBeNull();
		clock += nextSyncDelay(first.validUntil, clock);
		const second = await sync.syncOnce();
		expect(second.status).toBe("published");
		if (second.status !== "published") throw new Error("second scan missing");
		expect(second.fetchedAt).toBeLessThan(first.validUntil);
		expect(second.revision).not.toBe(first.revision);
		expect(second.summary.baselineRevision).toBe(first.revision);
		expect(nextSyncDelay(second.validUntil, second.validUntil - hour)).toBe(0);
	});

	it("keeps superseded scans distinct from published authority", async () => {
		const store: DirectoryStore = {
			beginScan: async () => 1n,
			publish: async () => ({ status: "superseded" }),
			latest: async () => null,
			close: async () => {},
		};
		const source = {
			fetchComplete: async () => ({
				departments: [{ id: 1, name: "Company", parentId: 0 }],
				members: [],
			}),
		} as ReturnType<typeof createWeComSource>;
		const sync = createDirectorySynchronizer({
			store,
			source,
			rootDepartmentId: 1,
			now: () => initial,
		});
		await expect(sync.syncOnce()).resolves.toEqual({ status: "superseded" });
	});
});
