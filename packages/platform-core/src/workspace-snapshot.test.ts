import { describe, expect, it } from "vitest";
import {
	assertWorkspaceSnapshotBindingQuotaV1,
	normalizeWorkspaceSnapshotBindingsV1,
	validateWorkspaceSnapshotDigestV1,
	WorkspaceSnapshotBindingErrorV1,
	WorkspaceSnapshotErrorV1,
} from "./workspace-snapshot.js";

describe("workspace snapshot core rules", () => {
	it("derives stable isolated mount paths", () => {
		expect(
			normalizeWorkspaceSnapshotBindingsV1([
				{ snapshotId: "snap-b", name: "venv" },
				{ snapshotId: "snap-a", name: "repo" },
			]),
		).toEqual([
			{
				snapshotId: "snap-a",
				name: "repo",
				mountPath: "/opt/agent/workspaces/repo",
			},
			{
				snapshotId: "snap-b",
				name: "venv",
				mountPath: "/opt/agent/workspaces/venv",
			},
		]);
	});
	it("rejects duplicate, reserved and digest-mismatched inputs", () => {
		expect(() =>
			normalizeWorkspaceSnapshotBindingsV1([
				{ snapshotId: "a", name: "repo" },
				{ snapshotId: "b", name: "repo" },
			]),
		).toThrow(WorkspaceSnapshotErrorV1);
		expect(() =>
			normalizeWorkspaceSnapshotBindingsV1([
				{ snapshotId: "a", name: "../tmp" },
			]),
		).toThrow(WorkspaceSnapshotErrorV1);
		expect(() =>
			validateWorkspaceSnapshotDigestV1(
				new Uint8Array([1]),
				`sha256:${"0".repeat(64)}`,
			),
		).toThrow(WorkspaceSnapshotErrorV1);
	});

	it("bounds configuration-revision binding aggregation", () => {
		expect(() =>
			assertWorkspaceSnapshotBindingQuotaV1({
				existingCount: 4,
				existingBytes: 0,
				nextBytes: 1,
			}),
		).toThrow(WorkspaceSnapshotBindingErrorV1);
		expect(() =>
			assertWorkspaceSnapshotBindingQuotaV1({
				existingCount: 1,
				existingBytes: 2 * 1024 ** 3,
				nextBytes: 1,
			}),
		).toThrow(WorkspaceSnapshotBindingErrorV1);
	});
});
