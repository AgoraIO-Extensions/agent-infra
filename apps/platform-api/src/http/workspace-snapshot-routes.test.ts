import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerWorkspaceSnapshotRoutesV1 } from "./workspace-snapshot-routes.js";

const material = `papi_${"A".repeat(43)}`;
const digest = "a".repeat(64);
const record = {
	snapshotId: "snapshot-1",
	ownerType: "user" as const,
	ownerId: "user-1",
	digest: `sha256:${digest}`,
	sizeBytes: 10,
	unpackedSizeBytes: 20,
	fileCount: 1,
	mediaType: "application/x-tar+gzip" as const,
	source: { kind: "direct-upload" },
	objectRef: "object-1",
	objectVersion: "version-1",
	status: "ready" as const,
	createdAt: "2026-11-02T00:00:00.000Z",
};

function fixture() {
	const deps = {
		upload: vi.fn().mockResolvedValue({ record, replayed: false }),
		list: vi.fn().mockResolvedValue([record]),
		get: vi.fn().mockResolvedValue(record),
		remove: vi.fn().mockResolvedValue({ ...record, status: "deleted" }),
	};
	const app = new Hono();
	registerWorkspaceSnapshotRoutesV1(app, deps);
	return { app, deps };
}

describe("workspace snapshot HTTP boundary", () => {
	it("requires bearer credentials and returns metadata only", async () => {
		const f = fixture();
		const response = await f.app.request("/api/v2/workspace-snapshots", {
			headers: { Authorization: `Bearer ${material}` },
		});
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(JSON.parse(text)).toEqual([
			{
				snapshotId: record.snapshotId,
				digest: record.digest,
				sizeBytes: record.sizeBytes,
				unpackedSizeBytes: record.unpackedSizeBytes,
				fileCount: record.fileCount,
				mediaType: record.mediaType,
				source: record.source,
				createdAt: record.createdAt,
				status: record.status,
				bindings: [],
			},
		]);
		expect(f.deps.list).toHaveBeenCalledWith(material);
		expect(text).not.toContain("object-1");
	});

	it("rejects cookies and mixed identity headers before calling the store", async () => {
		const f = fixture();
		const response = await f.app.request("/api/v2/workspace-snapshots", {
			headers: {
				Authorization: `Bearer ${material}`,
				Cookie: "session=caller",
				"X-User-Id": "other",
			},
		});
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(f.deps.list).not.toHaveBeenCalled();
	});
});
