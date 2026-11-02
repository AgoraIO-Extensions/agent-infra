import { describe, expect, it } from "vitest";
import { projectWorkspaceSnapshotMaterializerV1 } from "./workspace-snapshot-materializer.js";

const digest = `sha256:${"a".repeat(64)}`;
describe("workspace snapshot materializer projection", () => {
	it("uses a platform immutable init image and read-only child mounts", () => {
		const result = projectWorkspaceSnapshotMaterializerV1([{ snapshotId: "snap-1", name: "repo", digest, sizeBytes: 10 }], { imageDigest: digest, cacheSizeLimit: "2Gi", credentialSecretName: "snapshot-credentials" });
		expect(result.initContainers[0]).toMatchObject({ name: "workspace-snapshot-materializer", image: digest });
		expect(result.containerMounts.get("repo")).toContainEqual({ name: "workspace-snapshots", mountPath: "/opt/agent/workspaces/repo", subPath: "repo", readOnly: true });
	});
	it("rejects mutable images and duplicate names", () => {
		expect(() => projectWorkspaceSnapshotMaterializerV1([], { imageDigest: "latest", cacheSizeLimit: "2Gi", credentialSecretName: "x" })).toThrow();
		expect(() => projectWorkspaceSnapshotMaterializerV1([{ snapshotId: "a", name: "repo", digest, sizeBytes: 1 }, { snapshotId: "b", name: "repo", digest, sizeBytes: 1 }], { imageDigest: digest, cacheSizeLimit: "2Gi", credentialSecretName: "x" })).toThrow();
	});
});
