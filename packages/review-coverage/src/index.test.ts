import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildGitInventory,
	CoverageError,
	recordChunk,
	serializeMetadata,
	startRecordingProxy,
	verifyShadowMetadata,
} from "./index";

async function repo() {
	const path = await mkdtemp(join(tmpdir(), "review-coverage-"));
	const run = (args: string[]) =>
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
			cwd: path,
			encoding: "utf8",
			env: { ...process.env, LEFTHOOK: "0" },
		});
	run(["init", "-q"]);
	run(["config", "user.email", "test@example.com"]);
	run(["config", "user.name", "Test"]);
	await writeFile(join(path, "a.txt"), "one\n");
	run(["add", "."]);
	run(["commit", "-qm", "base"]);
	const base = run(["rev-parse", "HEAD"]).trim();
	await writeFile(join(path, "a.txt"), "one\ntwo\n");
	await writeFile(join(path, "b.txt"), "new\n");
	run(["add", "."]);
	run(["commit", "-qm", "head"]);
	return { path, base, head: run(["rev-parse", "HEAD"]).trim() };
}

describe("trusted chunk coverage", () => {
	it("builds immutable file and hunk inventory", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		expect(inventory.files).toHaveLength(2);
		const changed = inventory.files.find((f) => f.newPath === "a.txt");
		expect(changed).toBeDefined();
		expect(changed?.hunks[0]?.lines.at(-1)?.side).toBe("new");
		expect(inventory.digest).toMatch(/^[0-9a-f]{64}$/);
	});
	it("records only complete official responses", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		const diff =
			"diff --git a/a.txt b/a.txt\n@@ -1,0 +2 @@ one\n+two\ndiff --git a/b.txt b/b.txt\n@@ -0,0 +1 @@\n+new\n";
		const result = await recordChunk(
			inventory,
			{
				chunkId: "chunk-1",
				body: JSON.stringify({ diff }),
				headers: { authorization: "secret" },
			},
			async () => ({
				status: 200,
				body: JSON.stringify({ review: { key_issues_to_review: [] } }),
			}),
		);
		expect(result.matchedFileIds).toHaveLength(2);
		expect(result.matchedHunkIds).toHaveLength(2);
		expect(result.responseSha256).toHaveLength(64);
	});
	it("fails closed for omitted hunk and metadata identity", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		await expect(
			recordChunk(
				inventory,
				{
					chunkId: "chunk-1",
					body: JSON.stringify({
						diff: "diff --git a/a.txt b/a.txt\n@@ -1 +1,2 @@\n one\n+two\n",
					}),
					headers: {},
				},
				async () => ({
					status: 200,
					body: JSON.stringify({ review: { key_issues_to_review: [] } }),
				}),
			),
		).rejects.toMatchObject({ code: "review-coverage-incomplete" });
		const metadata = {
			version: 1 as const,
			reviewer: "pr-agent" as const,
			runtimeKind: "official" as const,
			repositoryId: 1,
			repositoryName: "org/repo",
			pullRequest: 2,
			baseSha: r.base,
			headSha: r.head,
			mergeBaseSha: inventory.mergeBaseSha,
			workflowRunId: 3,
			runAttempt: 1,
			analysisJobId: "job",
			provider: "pr-agent",
			imageDigest: `sha256:${"a".repeat(64)}`,
			recorderVersion: "v1",
			templateVersion: "v1",
			transportVersion: "v1",
			tokenCap: 300000,
			inventory,
			plannedChunkIds: ["chunk-1"],
			failedChunks: [],
			chunks: [
				{
					chunkId: "chunk-1",
					requestSha256: "r",
					matchedFileIds: inventory.files.map((file) => file.id),
					matchedHunkIds: inventory.files.flatMap((file) =>
						file.hunks.map((hunk) => hunk.id),
					),
					responseSha256: "s".repeat(64),
					attempts: 1,
					callStatus: "succeeded" as const,
					responseStatus: 200,
					response: { review: { key_issues_to_review: [] } },
				},
			],
			mergedOutputSha256: "a".repeat(64),
			successfulResponseSha256: ["s".repeat(64)],
		};
		const serializedMetadata = serializeMetadata(metadata);
		expect(serializedMetadata).not.toContain('"response"');
		expect(() => serializeMetadata(metadata)).not.toThrow();
		expect(() =>
			verifyShadowMetadata(
				JSON.stringify(metadata),
				{
					repositoryId: 1,
					pullRequest: 2,
					baseSha: r.base,
					headSha: r.head,
					mergeBaseSha: inventory.mergeBaseSha,
					workflowRunId: 3,
					runAttempt: 2,
					analysisJobId: "job",
					reviewer: "pr-agent",
					runtimeKind: "official",
					recorderVersion: "v1",
					templateVersion: "v1",
					transportVersion: "v1",
					tokenCap: 300000,
					provider: "pr-agent",
					imageDigest: `sha256:${"a".repeat(64)}`,
				},
				inventory,
			),
		).toThrowError(CoverageError);
	});
});

describe("recorder limits and identity", () => {
	it("retries the same logical chunk and rejects a fourth chunk", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		const diff =
			"diff --git a/a.txt b/a.txt\n@@ -1,0 +2 @@ one\n+two\ndiff --git a/b.txt b/b.txt\n@@ -0,0 +1 @@\n+new\n";
		let calls = 0;
		const recorder = new (await import("./index")).JobLocalRecorder({
			inventory,
			maxRetries: 1,
			transport: async () => {
				calls += 1;
				if (calls === 1) throw new Error("transient");
				return {
					status: 200,
					body: JSON.stringify({ review: { key_issues_to_review: [] } }),
				};
			},
		});
		await recorder.record({
			chunkId: "chunk-1",
			body: JSON.stringify({ diff }),
			headers: {},
		});
		expect(calls).toBe(2);
		await recorder.record({
			chunkId: "chunk-2",
			body: JSON.stringify({ diff }),
			headers: {},
		});
		await recorder.record({
			chunkId: "chunk-3",
			body: JSON.stringify({ diff }),
			headers: {},
		});
		await expect(
			recorder.record({
				chunkId: "chunk-4",
				body: JSON.stringify({ diff }),
				headers: {},
			}),
		).rejects.toMatchObject({ code: "review-coverage-incomplete" });
	});

	it("retains failed logical chunks for fail-closed metadata", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		const diff =
			"diff --git a/a.txt b/a.txt\n@@ -1,0 +2 @@ one\n+two\ndiff --git a/b.txt b/b.txt\n@@ -0,0 +1 @@\n+new\n";
		const recorder = new (await import("./index")).JobLocalRecorder({
			inventory,
			maxRetries: 1,
			transport: async () => {
				throw new Error("upstream unavailable");
			},
		});
		await expect(
			recorder.record({
				chunkId: "chunk-1",
				body: JSON.stringify({ diff }),
				headers: {},
			}),
		).rejects.toMatchObject({ code: "review-run-failed" });
		expect(recorder.failedChunks()).toEqual([
			{ chunkId: "chunk-1", attempts: 2, reasonCode: "review-run-failed" },
		]);
	});

	it("does not persist the repository path and rejects derived provenance drift", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		const metadata = {
			version: 1 as const,
			reviewer: "pr-agent" as const,
			runtimeKind: "derived" as const,
			sourceCommit: "a".repeat(40),
			patchSha256: "b".repeat(64),
			buildProvenance: {
				baseImageDigest: "sha256:base",
				buildWorkflow: "wf",
				buildCommit: "a".repeat(40),
				patchSha256: "b".repeat(64),
				builderIdentity: "builder",
				imageDigest: `sha256:${"c".repeat(64)}`,
			},
			repositoryId: 1,
			repositoryName: "org/repo",
			pullRequest: 2,
			baseSha: r.base,
			headSha: r.head,
			mergeBaseSha: inventory.mergeBaseSha,
			workflowRunId: 3,
			runAttempt: 1,
			analysisJobId: "job",
			provider: "plain-diff-derived",
			imageDigest: `sha256:${"c".repeat(64)}`,
			recorderVersion: "v1",
			templateVersion: "v1",
			transportVersion: "v1",
			tokenCap: 300000,
			inventory,
			plannedChunkIds: ["chunk-1"],
			failedChunks: [],
			chunks: [
				{
					chunkId: "chunk-1",
					requestSha256: "r",
					matchedFileIds: inventory.files.map((file) => file.id),
					matchedHunkIds: inventory.files.flatMap((file) =>
						file.hunks.map((hunk) => hunk.id),
					),
					responseSha256: "s".repeat(64),
					attempts: 1,
					callStatus: "succeeded" as const,
					responseStatus: 200,
					response: { review: { key_issues_to_review: [] } },
				},
			],
			mergedOutputSha256: "b".repeat(64),
			successfulResponseSha256: ["s".repeat(64)],
		};
		const serialized = serializeMetadata(metadata);
		expect(serialized).not.toContain(r.path);
		expect(() =>
			verifyShadowMetadata(
				serialized,
				{
					repositoryId: 1,
					pullRequest: 2,
					baseSha: r.base,
					headSha: r.head,
					mergeBaseSha: inventory.mergeBaseSha,
					workflowRunId: 3,
					runAttempt: 1,
					analysisJobId: "job",
					reviewer: "pr-agent",
					runtimeKind: "official",
					recorderVersion: "v1",
					templateVersion: "v1",
					transportVersion: "v1",
					tokenCap: 300000,
					provider: "plain-diff-derived",
					imageDigest: `sha256:${"d".repeat(64)}`,
				},
				inventory,
			),
		).toThrowError(CoverageError);
	});
});

describe("metadata-only diff boundaries", () => {
	it("covers a pure rename through path metadata without inventing a hunk", async () => {
		const path = await mkdtemp(join(tmpdir(), "review-coverage-rename-"));
		const run = (args: string[]) =>
			execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
				cwd: path,
				encoding: "utf8",
				env: { ...process.env, LEFTHOOK: "0" },
			});
		run(["init", "-q"]);
		run(["config", "user.email", "test@example.com"]);
		run(["config", "user.name", "Test"]);
		await writeFile(join(path, "old.txt"), "same\n");
		run(["add", "."]);
		run(["commit", "-qm", "base"]);
		const base = run(["rev-parse", "HEAD"]).trim();
		run(["mv", "old.txt", "new.txt"]);
		run(["commit", "-qm", "rename"]);
		const head = run(["rev-parse", "HEAD"]).trim();
		const inventory = await buildGitInventory(path, base, head);
		expect(inventory.files[0]?.hunks).toHaveLength(0);
		const diff = run(["diff", "--unified=0", `${base}..${head}`, "--"]);
		const result = await recordChunk(
			inventory,
			{ chunkId: "chunk-1", body: JSON.stringify({ diff }), headers: {} },
			async () => ({
				status: 200,
				body: JSON.stringify({ review: { key_issues_to_review: [] } }),
			}),
		);
		expect(result.matchedFileIds).toHaveLength(1);
		expect(result.matchedHunkIds).toHaveLength(0);
	});
});

describe("job-local HTTP boundary", () => {
	it("forwards the real request body through a bounded local proxy", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		const diff =
			"diff --git a/a.txt b/a.txt\n@@ -1,0 +2 @@ one\n+two\ndiff --git a/b.txt b/b.txt\n@@ -0,0 +1 @@\n+new\n";
		const upstream = createServer((request, response) => {
			if (request.method !== "POST") response.writeHead(405).end();
			else {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ review: { key_issues_to_review: [] } }));
			}
		});
		await new Promise<void>((resolve) =>
			upstream.listen(0, "127.0.0.1", resolve),
		);
		const address = upstream.address();
		if (!address || typeof address === "string")
			throw new Error("upstream did not bind");
		const proxy = await startRecordingProxy({
			inventory,
			upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
		});
		try {
			const response = await fetch(
				`http://127.0.0.1:${proxy.port}/v1/responses`,
				{
					method: "POST",
					headers: {
						"x-review-chunk-id": "chunk-1",
						"content-type": "application/json",
					},
					body: JSON.stringify({ diff }),
				},
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				review: { key_issues_to_review: [] },
			});
		} finally {
			await proxy.close();
			await new Promise<void>((resolve, reject) =>
				upstream.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
});
