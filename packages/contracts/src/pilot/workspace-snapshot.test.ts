import { describe, expect, it } from "vitest";
import {
	WorkspaceSnapshotBindingV1Schema,
	WorkspaceSnapshotMetadataV1Schema,
	WorkspaceSnapshotSourceV1Schema,
	WorkspaceSnapshotUploadRequestV1Schema,
} from "./index.ts";

const digest = `sha256:${"a".repeat(64)}`;
const metadata = {
	snapshotId: "snapshot-1",
	digest,
	sizeBytes: 10,
	unpackedSizeBytes: 20,
	fileCount: 1,
	mediaType: "application/x-tar+gzip" as const,
	source: { kind: "direct-upload" as const },
	createdAt: "2026-11-02T00:00:00.000Z",
	status: "ready" as const,
	bindings: [{ snapshotId: "snapshot-1", name: "repo" }],
};

describe("workspace snapshot contract", () => {
	it("accepts metadata-only projections and bindings", () => {
		expect(WorkspaceSnapshotMetadataV1Schema.parse(metadata)).toEqual(metadata);
		expect(
			WorkspaceSnapshotBindingV1Schema.parse({
				snapshotId: "snapshot-1",
				name: "repo",
			}),
		).toEqual({ snapshotId: "snapshot-1", name: "repo" });
	});

	it("rejects unsafe names, bad digests, and untrusted builder claims", () => {
		expect(
			WorkspaceSnapshotBindingV1Schema.safeParse({
				snapshotId: "snapshot-1",
				name: "../repo",
			}).success,
		).toBe(false);
		expect(
			WorkspaceSnapshotMetadataV1Schema.safeParse({
				...metadata,
				digest: "sha256:not-a-digest",
			}).success,
		).toBe(false);
		expect(
			WorkspaceSnapshotSourceV1Schema.safeParse({
				kind: "builder-connection",
				repository: "https://example.test/repo",
				commitSha: "a".repeat(40),
			}).success,
		).toBe(false);
	});

	it("defaults uploads to direct platform API provenance", () => {
		expect(
			WorkspaceSnapshotUploadRequestV1Schema.parse({ schemaVersion: 1 }),
		).toEqual({ schemaVersion: 1, source: { kind: "direct-upload" } });
	});
});
