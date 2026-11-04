import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { materializeWorkspaceSnapshotV1 } from "./workspace-snapshot-executor.js";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories.map((p) => rm(p, { recursive: true, force: true })),
	);
	directories.length = 0;
});
async function fixture(content = "version-one") {
	const root = await mkdtemp(join(tmpdir(), "snapshot-executor-"));
	directories.push(root);
	const source = join(root, "source");
	const output = join(root, "output");
	await mkdir(source);
	await mkdir(output);
	await mkdir(join(source, "root"));
	await writeFile(join(source, "root", "value.txt"), content);
	const archive = execFileSync(
		"tar",
		["--format=ustar", "-czf", "-", "-C", source, "root"],
		{ env: { ...process.env, COPYFILE_DISABLE: "1" } },
	);
	const fetch = vi.fn(async () => new Response(archive));
	const snapshot = {
		snapshotId: "snapshot-a",
		name: "repo",
		digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
		sizeBytes: archive.length,
		objectRef: "object-a",
		signedUrl: "https://storage.example.test/object?signature=private",
		expiresAt: new Date(Date.now() + 60000).toISOString(),
	};
	return {
		root,
		output,
		fetch,
		snapshot,
		input: {
			snapshot,
			outputDirectory: output,
			allowedOrigins: ["https://storage.example.test"],
			signal: AbortSignal.timeout(30000),
			maxArchiveBytes: 1048576,
			maxUnpackedBytes: 1048576,
			fetch,
		},
	};
}
it("extracts a validated archive and reuses only its completed digest", async () => {
	const f = await fixture();
	expect((await materializeWorkspaceSnapshotV1(f.input)).status).toBe(
		"materialized",
	);
	expect(await readFile(join(f.output, "repo", "value.txt"), "utf8")).toBe(
		"version-one",
	);
	expect((await materializeWorkspaceSnapshotV1(f.input)).status).toBe("reused");
	expect(f.fetch).toHaveBeenCalledTimes(1);
});
it("rejects digest tampering without publishing a completion marker", async () => {
	const f = await fixture();
	await expect(
		materializeWorkspaceSnapshotV1({
			...f.input,
			snapshot: { ...f.snapshot, digest: `sha256:${"0".repeat(64)}` },
		}),
	).rejects.toThrow("WORKSPACE_SNAPSHOT_MATERIALIZATION_FAILED");
	await expect(
		readFile(join(f.output, "repo", ".snapshot-digest")),
	).rejects.toThrow();
});
it("rejects an unapproved origin before fetching", async () => {
	const f = await fixture();
	await expect(
		materializeWorkspaceSnapshotV1({ ...f.input, allowedOrigins: [] }),
	).rejects.toThrow("WORKSPACE_SNAPSHOT_MATERIALIZATION_FAILED");
	expect(f.fetch).not.toHaveBeenCalled();
});
it("rejects a symlink destination without touching its target", async () => {
	const f = await fixture();
	await symlink(f.root, join(f.output, "repo"));
	await expect(materializeWorkspaceSnapshotV1(f.input)).rejects.toThrow(
		"WORKSPACE_SNAPSHOT_MATERIALIZATION_FAILED",
	);
	expect(f.fetch).not.toHaveBeenCalled();
});

it("replaces a completed generation only after validating its replacement", async () => {
	const first = await fixture();
	await materializeWorkspaceSnapshotV1(first.input);
	const next = await fixture("version-two");
	await materializeWorkspaceSnapshotV1({
		...next.input,
		outputDirectory: first.output,
	});
	expect(await readFile(join(first.output, "repo", "value.txt"), "utf8")).toBe(
		"version-two",
	);
	expect(
		await readFile(join(first.output, "repo", ".snapshot-digest"), "utf8"),
	).toBe(`${next.snapshot.digest}\n`);
});
it("preserves the prior generation when the replacement archive fails validation", async () => {
	const first = await fixture();
	await materializeWorkspaceSnapshotV1(first.input);
	const next = await fixture("version-two");
	await expect(
		materializeWorkspaceSnapshotV1({
			...next.input,
			outputDirectory: first.output,
			snapshot: { ...next.snapshot, digest: `sha256:${"0".repeat(64)}` },
		}),
	).rejects.toThrow("WORKSPACE_SNAPSHOT_MATERIALIZATION_FAILED");
	expect(await readFile(join(first.output, "repo", "value.txt"), "utf8")).toBe(
		"version-one",
	);
	expect(
		await readFile(join(first.output, "repo", ".snapshot-digest"), "utf8"),
	).toBe(`${first.snapshot.digest}\n`);
});

it("bounds streamed archive bytes and keeps the destination unpublished", async () => {
	const f = await fixture();
	const fetch = vi.fn(
		async () => new Response(new Uint8Array(f.snapshot.sizeBytes + 1)),
	);
	await expect(
		materializeWorkspaceSnapshotV1({ ...f.input, fetch }),
	).rejects.toThrow("WORKSPACE_SNAPSHOT_MATERIALIZATION_FAILED");
	await expect(lstat(join(f.output, "repo"))).rejects.toThrow();
});
it("rejects expired authorization before network access", async () => {
	const f = await fixture();
	await expect(
		materializeWorkspaceSnapshotV1({
			...f.input,
			snapshot: { ...f.snapshot, expiresAt: new Date(0).toISOString() },
		}),
	).rejects.toThrow("WORKSPACE_SNAPSHOT_MATERIALIZATION_FAILED");
	expect(f.fetch).not.toHaveBeenCalled();
});
