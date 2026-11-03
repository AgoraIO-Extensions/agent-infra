import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	collect: vi.fn(),
	close: vi.fn(),
	metrics: vi.fn(),
}));
vi.mock("@agent-infra/platform-store", () => ({
	PostgresWorkspaceSnapshotStoreV1: class {
		collectExpired = mocks.collect;
		readGcMetrics = mocks.metrics;
		close = mocks.close;
	},
}));

import { startWorkspaceSnapshotGcV1 } from "./workspace-snapshot-gc.js";

beforeEach(() => {
	mocks.metrics.mockResolvedValue({ storedBytes: 0, oldestEligibleDelayMs: 0 });
});

afterEach(() => {
	vi.useRealTimers();
	vi.resetAllMocks();
});
it("uses exact object versions, avoids overlap, and drains before closing", async () => {
	vi.useFakeTimers();
	let release: () => void = () => {};
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const remove = vi.fn(async () => {});
	const observe = vi.fn();
	mocks.collect.mockImplementation(async (input) => {
		await input.deleter.deleteObjectVersion({
			objectRef: "ref",
			objectVersion: "v1",
		});
		await pending;
		return { scanned: 1, deleted: 1, failed: 0 };
	});
	const gc = startWorkspaceSnapshotGcV1({
		databaseUrl: "unused",
		storage: { remove },
		policy: { retentionMs: 1000, intervalMs: 1000, observe },
	});
	await vi.advanceTimersByTimeAsync(1000);
	expect(remove).toHaveBeenCalledWith("ref", "v1");
	await vi.advanceTimersByTimeAsync(5000);
	expect(mocks.collect).toHaveBeenCalledTimes(1);
	const closing = gc.close();
	expect(mocks.close).not.toHaveBeenCalled();
	release();
	await closing;
	expect(mocks.close).toHaveBeenCalledTimes(1);
	expect(observe).toHaveBeenCalledWith({
		scanned: 1,
		deleted: 1,
		failed: 0,
		outcome: "completed",
		durationMs: 5000,
		storedBytes: 0,
		oldestEligibleDelayMs: 0,
	});
	await vi.advanceTimersByTimeAsync(10000);
	expect(mocks.collect).toHaveBeenCalledTimes(1);
});
it("retries after failure and does not expose the storage error", async () => {
	vi.useFakeTimers();
	const observe = vi.fn();
	mocks.collect
		.mockRejectedValueOnce(new Error("private-storage-detail"))
		.mockResolvedValue({ scanned: 0, deleted: 0, failed: 0 });
	const gc = startWorkspaceSnapshotGcV1({
		databaseUrl: "unused",
		storage: { remove: vi.fn() },
		policy: { retentionMs: 0, intervalMs: 1000, observe },
	});
	await vi.advanceTimersByTimeAsync(2000);
	expect(mocks.collect).toHaveBeenCalledTimes(2);
	expect(JSON.stringify(observe.mock.calls)).not.toContain(
		"private-storage-detail",
	);
	expect(observe.mock.calls[0]?.[0]).toMatchObject({
		outcome: "unavailable",
		failed: 1,
	});
	await gc.close();
});

it.each([
	{ retentionMs: -1, intervalMs: 1000 },
	{ retentionMs: Number.NaN, intervalMs: 1000 },
	{ retentionMs: 1000, intervalMs: 999 },
	{ retentionMs: 1000, intervalMs: 2147483648 },
])("rejects invalid deployment policy before scheduling: %j", (policy) => {
	vi.useFakeTimers();
	expect(() =>
		startWorkspaceSnapshotGcV1({
			databaseUrl: "unused",
			storage: { remove: vi.fn() },
			policy: { ...policy, observe: vi.fn() },
		}),
	).toThrow("WORKSPACE_SNAPSHOT_GC_CONFIGURATION_INVALID");
	expect(vi.getTimerCount()).toBe(0);
	expect(mocks.collect).not.toHaveBeenCalled();
});

it("continues scheduling when telemetry throws", async () => {
	vi.useFakeTimers();
	mocks.collect.mockResolvedValue({ scanned: 0, deleted: 0, failed: 0 });
	const gc = startWorkspaceSnapshotGcV1({
		databaseUrl: "unused",
		storage: { remove: vi.fn() },
		policy: {
			retentionMs: 1000,
			intervalMs: 1000,
			observe: () => {
				throw new Error("synthetic telemetry failure");
			},
		},
	});
	await vi.advanceTimersByTimeAsync(2000);
	expect(mocks.collect).toHaveBeenCalledTimes(2);
	await gc.close();
	expect(vi.getTimerCount()).toBe(0);
});

it("contains a rejected async telemetry callback", async () => {
	vi.useFakeTimers();
	mocks.collect.mockResolvedValue({ scanned: 0, deleted: 0, failed: 0 });
	const gc = startWorkspaceSnapshotGcV1({
		databaseUrl: "unused",
		storage: { remove: vi.fn() },
		policy: {
			retentionMs: 1000,
			intervalMs: 1000,
			observe: async () => {
				throw new Error("async telemetry failure");
			},
		},
	});
	await vi.advanceTimersByTimeAsync(1000);
	expect(mocks.collect).toHaveBeenCalledTimes(1);
	await gc.close();
});

it("reports unknown metrics and resumes collection after a metrics read failure", async () => {
	vi.useFakeTimers();
	mocks.collect.mockResolvedValue({ scanned: 2, deleted: 1, failed: 0 });
	mocks.metrics
		.mockRejectedValueOnce(new Error("private-database-detail"))
		.mockResolvedValue({ storedBytes: 32, oldestEligibleDelayMs: 100 });
	const observe = vi.fn();
	const gc = startWorkspaceSnapshotGcV1({
		databaseUrl: "unused",
		storage: { remove: vi.fn() },
		policy: { retentionMs: 1000, intervalMs: 1000, observe },
	});
	await vi.advanceTimersByTimeAsync(1000);
	expect(observe.mock.calls[0]?.[0]).toMatchObject({
		scanned: 2,
		deleted: 1,
		storedBytes: null,
		oldestEligibleDelayMs: null,
		outcome: "unavailable",
	});
	expect(JSON.stringify(observe.mock.calls)).not.toContain(
		"private-database-detail",
	);
	await vi.advanceTimersByTimeAsync(1000);
	expect(mocks.collect).toHaveBeenCalledTimes(2);
	expect(observe.mock.calls[1]?.[0]).toMatchObject({
		storedBytes: 32,
		oldestEligibleDelayMs: 100,
		outcome: "completed",
	});
	await gc.close();
});
