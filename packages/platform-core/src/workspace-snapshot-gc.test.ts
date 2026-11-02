import { describe, expect, it } from "vitest";
import { planWorkspaceSnapshotGcV1 } from "./workspace-snapshot-gc.js";

const now = new Date("2026-11-03T00:00:00.000Z");
const candidate = {
	snapshotId: "snap-old",
	objectRef: "object-ref",
	objectVersion: "version-7",
	status: "ready" as const,
	createdAt: "2026-10-01T00:00:00.000Z",
	bindings: [],
};

describe("workspace snapshot GC plan", () => {
	it("selects only expired zero-binding records with exact object identity", () => {
		expect(
			planWorkspaceSnapshotGcV1({
				candidates: [
					candidate,
					{ ...candidate, snapshotId: "snap-bound", bindings: ["agent"] },
					{
						...candidate,
						snapshotId: "snap-new",
						createdAt: now.toISOString(),
					},
				],
				now,
				retentionMs: 7 * 24 * 60 * 60 * 1000,
			}),
		).toEqual([
			{
				snapshotId: "snap-old",
				objectRef: "object-ref",
				objectVersion: "version-7",
			},
		]);
	});

	it("rejects invalid retention and never selects deleting records", () => {
		expect(() =>
			planWorkspaceSnapshotGcV1({ candidates: [], now, retentionMs: -1 }),
		).toThrow();
		expect(
			planWorkspaceSnapshotGcV1({
				candidates: [{ ...candidate, status: "deleting" }],
				now,
				retentionMs: 0,
			}),
		).toEqual([]);
	});
});
