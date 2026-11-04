import { expect, it } from "vitest";
import { parseWorkspaceSnapshotInitManifestV1 } from "./workspace-snapshot-init.js";

const input = {
	schemaVersion: 1,
	allowedOrigins: ["https://objects.example.test"],
	snapshots: [
		{
			snapshotId: "snapshot-00000000-0000-4000-8000-000000000001",
			name: "repo",
			digest: `sha256:${"a".repeat(64)}`,
			sizeBytes: 10,
			objectRef: "00000000-0000-4000-8000-000000000001",
			signedUrl: "https://objects.example.test/object",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		},
	],
};
it("accepts the bounded init manifest", () => {
	expect(parseWorkspaceSnapshotInitManifestV1(input).snapshots).toHaveLength(1);
});
it.each([
	[
		"duplicate name",
		{
			...input,
			snapshots: [
				input.snapshots[0],
				{
					...input.snapshots[0],
					snapshotId: "snapshot-00000000-0000-4000-8000-000000000002",
				},
			],
		},
	],
	[
		"unapproved URL",
		{
			...input,
			snapshots: [
				{
					...input.snapshots[0],
					signedUrl: "https://other.example.test/object",
				},
			],
		},
	],
	[
		"mutable origin",
		{ ...input, allowedOrigins: ["http://objects.example.test"] },
	],
])("rejects %s", (_label, value) => {
	expect(() => parseWorkspaceSnapshotInitManifestV1(value)).toThrow(
		"WORKSPACE_SNAPSHOT_MATERIALIZATION_FAILED",
	);
});
