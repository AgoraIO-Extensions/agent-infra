import { expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn() }));
vi.mock("./observed-postgres.js", () => ({
	default: () => Object.assign(database.query, { end: database.end }),
}));

import { openPostgresWorkspaceSnapshotMaterializationReaderV1 } from "./workspace-snapshot-materialization-reader.js";

const request = {
	agentId: "agent-a",
	configurationRevision: 6,
	workloadRevision: 16,
	fence: 5,
	bindings: [{ snapshotId: "snapshot-a", name: "repo" }],
};
const row = {
	snapshot_id: "snapshot-a",
	name: "repo",
	binding_digest: `sha256:${"a".repeat(64)}`,
	binding_size: "139",
	digest: `sha256:${"a".repeat(64)}`,
	size_bytes: "274",
	unpacked_size_bytes: "139",
	object_ref: "object-a",
	object_version: "version-a",
	status: "ready",
	revision: "16",
	state: { fence: 5 },
};
it("validates unpacked binding size and returns compressed bytes for download", async () => {
	database.query.mockResolvedValueOnce([row]);
	const reader = openPostgresWorkspaceSnapshotMaterializationReaderV1(
		"postgresql://synthetic",
	);
	const result = await reader.read(request);
	expect(result).toEqual([
		{
			snapshotId: "snapshot-a",
			name: "repo",
			digest: row.digest,
			sizeBytes: 274,
			objectRef: "object-a",
			objectVersion: "version-a",
		},
	]);
	const call = database.query.mock.calls.at(-1);
	if (!call) throw new Error("Missing Store query");
	const [sql, ...parameters] = call;
	expect(sql.join("?")).toContain("s.unpacked_size_bytes");
	expect(parameters).toEqual(["agent-a", 6, 16]);
});
it.each([
	{ binding_size: "274" },
	{ digest: `sha256:${"b".repeat(64)}` },
	{ state: { fence: 4 } },
	{ revision: "15" },
	{ status: "deleted" },
])("rejects mismatched persisted metadata (%j)", async (change) => {
	database.query.mockResolvedValueOnce([{ ...row, ...change }]);
	const reader = openPostgresWorkspaceSnapshotMaterializationReaderV1(
		"postgresql://synthetic",
	);
	await expect(reader.read(request)).rejects.toThrow();
});
it("rejects missing persisted bindings", async () => {
	database.query.mockResolvedValueOnce([]);
	const reader = openPostgresWorkspaceSnapshotMaterializationReaderV1(
		"postgresql://synthetic",
	);
	await expect(reader.read(request)).rejects.toThrow();
});

it.each([{ snapshot_id: "snapshot-other" }, { name: "other" }])(
	"rejects same-count binding substitutions (%j)",
	async (change) => {
		database.query.mockResolvedValueOnce([{ ...row, ...change }]);
		const reader = openPostgresWorkspaceSnapshotMaterializationReaderV1(
			"postgresql://synthetic",
		);
		await expect(reader.read(request)).rejects.toThrow();
	},
);
it("rejects duplicate requested or returned bindings", async () => {
	const reader = openPostgresWorkspaceSnapshotMaterializationReaderV1(
		"postgresql://synthetic",
	);
	database.query.mockResolvedValueOnce([row, row]);
	await expect(
		reader.read({
			...request,
			bindings: [...request.bindings, ...request.bindings],
		}),
	).rejects.toThrow();
	database.query.mockResolvedValueOnce([row, row]);
	await expect(
		reader.read({
			...request,
			bindings: [
				...request.bindings,
				{ snapshotId: "snapshot-b", name: "environment" },
			],
		}),
	).rejects.toThrow();
});
