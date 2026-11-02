import { describe, expect, it } from "vitest";
import { normalizeWorkspaceSnapshotBindingsV1, validateWorkspaceSnapshotDigestV1, WorkspaceSnapshotErrorV1 } from "./workspace-snapshot.js";
describe("workspace snapshot core rules", () => {
	it("derives stable isolated mount paths", () => {
		expect(normalizeWorkspaceSnapshotBindingsV1([{ snapshotId: "snap-b", name: "venv" }, { snapshotId: "snap-a", name: "repo" }])).toEqual([
			{ snapshotId: "snap-a", name: "repo", mountPath: "/opt/agent/workspaces/repo" },
			{ snapshotId: "snap-b", name: "venv", mountPath: "/opt/agent/workspaces/venv" },
		]);
	});
	it("rejects duplicate, reserved and digest-mismatched inputs", () => {
		expect(() => normalizeWorkspaceSnapshotBindingsV1([{ snapshotId: "a", name: "repo" }, { snapshotId: "b", name: "repo" }])).toThrow(WorkspaceSnapshotErrorV1);
		expect(() => normalizeWorkspaceSnapshotBindingsV1([{ snapshotId: "a", name: "../tmp" }])).toThrow(WorkspaceSnapshotErrorV1);
		expect(() => validateWorkspaceSnapshotDigestV1(new Uint8Array([1]), "sha256:" + "0".repeat(64))).toThrow(WorkspaceSnapshotErrorV1);
	});
});
