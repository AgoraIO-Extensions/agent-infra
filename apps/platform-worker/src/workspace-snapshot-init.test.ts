import { open } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import {
	materializeWorkspaceSnapshotV1,
	pruneWorkspaceSnapshotCacheV1,
} from "./workspace-snapshot-executor.js";
import {
	parseWorkspaceSnapshotInitManifestV1,
	runWorkspaceSnapshotInitV1,
} from "./workspace-snapshot-init.js";

vi.mock("node:fs/promises", async (original) => ({
	...(await original<typeof import("node:fs/promises")>()),
	open: vi.fn(),
}));
vi.mock("./workspace-snapshot-executor.js", async (original) => ({
	...(await original<typeof import("./workspace-snapshot-executor.js")>()),
	materializeWorkspaceSnapshotV1: vi.fn(),
	pruneWorkspaceSnapshotCacheV1: vi.fn(),
}));

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

it("clears interrupted cache stages before starting the next download", async () => {
	const bytes = Buffer.from(JSON.stringify(input));
	vi.mocked(open).mockResolvedValue({
		stat: async () => ({ isFile: () => true, size: bytes.length }),
		read: async (buffer: Buffer) => {
			bytes.copy(buffer);
			return { bytesRead: bytes.length };
		},
		close: async () => {},
	} as unknown as Awaited<ReturnType<typeof open>>);
	const pruned = vi
		.mocked(pruneWorkspaceSnapshotCacheV1)
		.mockResolvedValue(undefined);
	const downloaded = vi
		.mocked(materializeWorkspaceSnapshotV1)
		.mockImplementation(async () => {
			expect(pruned).toHaveBeenCalledWith("/materialized", ["repo"]);
			return { status: "materialized", digest: input.snapshots[0]!.digest };
		});
	await runWorkspaceSnapshotInitV1();
	expect(pruned.mock.invocationCallOrder[0]).toBeLessThan(
		downloaded.mock.invocationCallOrder[0]!,
	);
	expect(pruned).toHaveBeenCalledTimes(2);
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
