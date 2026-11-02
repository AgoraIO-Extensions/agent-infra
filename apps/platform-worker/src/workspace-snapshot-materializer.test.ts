import { describe, expect, it } from "vitest";
import {
	applyWorkspaceSnapshotProjectionV1,
	projectWorkspaceSnapshotMaterializerV1,
	workspaceSnapshotPodSpecMatchesV1,
} from "./workspace-snapshot-materializer.js";

const digest = `sha256:${"a".repeat(64)}`;
const snapshot = {
	snapshotId: "snap-1",
	name: "repo",
	digest,
	sizeBytes: 10,
	objectRef: "object-1",
	signedUrl: "https://objects.example.test/signed/object-1",
	expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
};
const policy = {
	imageDigest: digest,
	cacheSizeLimit: "2Gi",
	credentialSecretName: "snapshot-credentials",
};

describe("workspace snapshot materializer projection", () => {
	it("uses a platform immutable init image and read-only child mounts", () => {
		const result = projectWorkspaceSnapshotMaterializerV1([snapshot], policy);
		expect(result.initContainers[0]).toMatchObject({
			name: "workspace-snapshot-materializer",
			image: digest,
			args: ["--manifest=/run/workspace-snapshots/manifest.json"],
		});
		expect(result.containerMounts.get("repo")).toContainEqual({
			name: "workspace-snapshots",
			mountPath: "/opt/agent/workspaces/repo",
			subPath: "repo",
			readOnly: true,
		});
		expect(JSON.parse(result.manifest)).toMatchObject({
			snapshots: [{ objectRef: "object-1", signedUrl: snapshot.signedUrl }],
		});
	});

	it("applies exact init, volume and read-only mount shape to every container", () => {
		const projection = projectWorkspaceSnapshotMaterializerV1(
			[snapshot],
			policy,
		);
		const spec = applyWorkspaceSnapshotProjectionV1(
			{
				containers: [
					{ name: "agent", image: digest },
					{ name: "sidecar", image: digest },
				],
			},
			projection,
		);
		expect(spec.initContainers).toHaveLength(1);
		expect(spec.volumes).toHaveLength(2);
		expect(
			spec.containers.every((container) =>
				container.volumeMounts?.some(
					(mount) =>
						mount.mountPath === "/opt/agent/workspaces/repo" &&
						mount.readOnly === true,
				),
			),
		).toBe(true);
		expect(workspaceSnapshotPodSpecMatchesV1(spec, projection)).toBe(true);
		const drifted = structuredClone(spec);
		const mount = drifted.containers[0]?.volumeMounts?.find(
			(value) => value.mountPath === "/opt/agent/workspaces/repo",
		);
		if (mount) mount.readOnly = false;
		expect(workspaceSnapshotPodSpecMatchesV1(drifted, projection)).toBe(false);
	});

	it("rejects mutable images, duplicate names and invalid signed URL expiry", () => {
		expect(() =>
			projectWorkspaceSnapshotMaterializerV1([], {
				...policy,
				imageDigest: "latest",
			}),
		).toThrow();
		expect(() =>
			projectWorkspaceSnapshotMaterializerV1(
				[snapshot, { ...snapshot, snapshotId: "snap-2" }],
				policy,
			),
		).toThrow();
		expect(() =>
			projectWorkspaceSnapshotMaterializerV1(
				[{ ...snapshot, signedUrl: "http://objects.example.test/object-1" }],
				policy,
			),
		).toThrow();
	});
});
