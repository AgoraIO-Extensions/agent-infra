import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildCoverageMetadata,
	buildGitInventory,
	CoverageError,
	JobLocalRecorder,
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
	const head = run(["rev-parse", "HEAD"]).trim();
	const patch = run([
		"diff",
		"--unified=0",
		"--full-index",
		"--no-abbrev",
		`${base}..${head}`,
		"--",
	]);
	return { path, base, head, patch };
}

function prAgentDiff(patch: string): string {
	return patch
		.split(/(?=diff --git )/)
		.filter((section) => section.startsWith("diff --git "))
		.map((section) => {
			const path = /^diff --git a\/(.+) b\/.+$/m.exec(section)?.[1];
			if (!path) throw new Error("fixture path missing");
			const lines = section.split(/\r?\n/);
			const output = [`## File: '${path}'`];
			let newLine = 0;
			for (let index = 0; index < lines.length; index += 1) {
				const line = lines[index];
				const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(
					line ?? "",
				);
				if (!header) continue;
				newLine = Number(header[2]);
				const body: string[] = [];
				const oldBody: string[] = [];
				for (const hunkLine of lines.slice(index + 1)) {
					if (hunkLine.startsWith("@@ ")) break;
					if (hunkLine.startsWith("\\ No newline")) continue;
					if (hunkLine.startsWith("+")) {
						body.push(`${newLine} ${hunkLine}`);
						newLine += 1;
					} else if (hunkLine.startsWith("-")) {
						oldBody.push(hunkLine);
					} else if (hunkLine.startsWith(" ")) {
						body.push(`${newLine} ${hunkLine}`);
						oldBody.push(hunkLine);
						newLine += 1;
					}
				}
				output.push(line ?? "", "__new hunk__", ...body);
				if (oldBody.length > 0) output.push("__old hunk__", ...oldBody);
			}
			return output.join("\n");
		})
		.join("\n\n");
}

function responsesBody(
	review = { review: { key_issues_to_review: [] } },
): string {
	return JSON.stringify({
		object: "response",
		status: "completed",
		output: [
			{
				type: "message",
				content: [{ type: "output_text", text: JSON.stringify(review) }],
			},
		],
	});
}

function responsesRequest(diff: string): string {
	return JSON.stringify({
		input: [
			{
				role: "user",
				content: [
					{
						type: "input_text",
						text: `The PR code diff:\n======\n${prAgentDiff(diff)}\n======`,
					},
				],
			},
		],
	});
}

describe("trusted chunk coverage", () => {
	it("keeps immutable inventory independent of local config and working attributes", async () => {
		const r = await repo();
		try {
			const before = await buildGitInventory(r.path, r.base, r.head);
			for (const [key, value] of [
				["diff.noprefix", "true"],
				["diff.mnemonicPrefix", "true"],
				["diff.algorithm", "minimal"],
				["color.ui", "always"],
			] as const)
				execFileSync("git", ["config", key, value], { cwd: r.path });
			await writeFile(join(r.path, ".gitattributes"), "*.txt -diff\n");
			await writeFile(join(r.path, ".git/info/attributes"), "*.txt -diff\n");
			const after = await buildGitInventory(r.path, r.base, r.head);
			expect(after.digest).toBe(before.digest);
			expect(after.files).toEqual(before.files);
			await writeFile(join(r.path, ".git/config"), "[invalid config\n");
			expect((await buildGitInventory(r.path, r.base, r.head)).digest).toBe(
				before.digest,
			);
		} finally {
			await rm(r.path, { recursive: true, force: true });
		}
	});
	it("resolves a linked worktree without copying its config or attributes", async () => {
		const r = await repo();
		const linked = await mkdtemp(join(tmpdir(), "review-coverage-linked-"));
		try {
			const before = await buildGitInventory(r.path, r.base, r.head);
			execFileSync(
				"git",
				[
					"-c",
					"core.hooksPath=/dev/null",
					"worktree",
					"add",
					"--detach",
					linked,
					r.head,
				],
				{ cwd: r.path, stdio: "pipe" },
			);
			await writeFile(join(linked, ".gitattributes"), "*.txt -diff\n");
			expect((await buildGitInventory(linked, r.base, r.head)).digest).toBe(
				before.digest,
			);
		} finally {
			await rm(linked, { recursive: true, force: true });
			await rm(r.path, { recursive: true, force: true });
		}
	});
	it("does not let repository configuration hide a changed submodule", async () => {
		const r = await repo();
		try {
			const run = (args: string[]) =>
				execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
					cwd: r.path,
					encoding: "utf8",
				}).trim();
			run(["update-index", "--add", "--cacheinfo", "160000", r.base, "module"]);
			run(["commit", "-qm", "submodule base"]);
			const base = run(["rev-parse", "HEAD"]);
			run(["update-index", "--cacheinfo", "160000", r.head, "module"]);
			await writeFile(join(r.path, "a.txt"), "one\ntwo\nthree\n");
			run(["add", "a.txt"]);
			run(["commit", "-qm", "submodule and text changes"]);
			const head = run(["rev-parse", "HEAD"]);
			run(["config", "diff.ignoreSubmodules", "all"]);
			await expect(buildGitInventory(r.path, base, head)).rejects.toMatchObject(
				{ code: "unsupported-input" },
			);
		} finally {
			await rm(r.path, { recursive: true, force: true });
		}
	});
	it("rejects an unmatched Git-quoted path instead of inventing empty hunks", async () => {
		const r = await repo();
		try {
			await writeFile(join(r.path, "a\tb.txt"), "quoted path change\n");
			execFileSync("git", ["add", "."], { cwd: r.path });
			execFileSync(
				"git",
				["-c", "core.hooksPath=/dev/null", "commit", "-qm", "quoted path"],
				{ cwd: r.path },
			);
			const head = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: r.path,
				encoding: "utf8",
			}).trim();
			await expect(
				buildGitInventory(r.path, r.base, head),
			).rejects.toMatchObject({ code: "unsupported-input" });
		} finally {
			await rm(r.path, { recursive: true, force: true });
		}
	});
	it("builds immutable file and hunk inventory", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		expect(inventory.files).toHaveLength(2);
		const changed = inventory.files.find((f) => f.newPath === "a.txt");
		expect(changed).toBeDefined();
		expect(changed?.hunks[0]?.lines.at(-1)?.side).toBe("new");
		expect(inventory.digest).toMatch(/^[0-9a-f]{64}$/);
	});
	it("neutralizes repository-local diff hooks and textconv attributes", async () => {
		const r = await repo();
		const marker = join(r.path, "diff-hook-ran");
		const hook = join(r.path, "diff-hook.sh");
		await writeFile(hook, `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
		await chmod(hook, 0o755);
		await writeFile(join(r.path, ".gitattributes"), "*.txt diff=evil\n");
		const run = (args: string[]) =>
			execFileSync("git", args, { cwd: r.path, encoding: "utf8" });
		run(["config", "diff.external", hook]);
		run(["config", "diff.evil.textconv", hook]);
		run(["config", "diff.renames", "false"]);
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		expect(inventory.files).toHaveLength(2);
		await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("records only complete official responses", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		const diff = r.patch;
		const result = await recordChunk(
			inventory,
			{
				chunkId: "chunk-1",
				body: responsesRequest(diff),
				headers: { authorization: "secret" },
			},
			async () => ({
				status: 200,
				body: responsesBody(),
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
						diff: (
							r.patch
								.split(/(?=diff --git )/)
								.find((part) => part.includes("a/a.txt b/a.txt")) ?? r.patch
						).replace("+two\n", ""),
					}),
					headers: {},
				},
				async () => ({
					status: 200,
					body: responsesBody(),
				}),
			),
		).rejects.toMatchObject({ code: "invalid-diff" });
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
			diffSha256: "a".repeat(64),
			diffBytes: 1,
			inventory,
			plannedChunkIds: ["chunk-1"],
			failedChunks: [],
			chunks: [
				{
					chunkId: "chunk-1",
					requestSha256: "b".repeat(64),
					matchedFileIds: inventory.files.map((file) => file.id),
					matchedHunkIds: inventory.files.flatMap((file) =>
						file.hunks.map((hunk) => hunk.id),
					),
					responseSha256: "a".repeat(64),
					attempts: 1,
					callStatus: "succeeded" as const,
					responseStatus: 200,
					response: { review: { key_issues_to_review: [] } },
				},
			],
			mergedOutputSha256: "a".repeat(64),
			successfulResponseSha256: ["a".repeat(64)],
		};
		const serializedMetadata = serializeMetadata(metadata);
		expect(serializedMetadata).not.toContain('"response"');
		expect(JSON.parse(serializedMetadata).chunks[0].parsedResult).toMatchObject(
			{
				schema: "pr-agent-review",
				findingCount: 0,
			},
		);
		expect(() => serializeMetadata(metadata)).not.toThrow();
		expect(() =>
			verifyShadowMetadata(
				JSON.stringify(metadata),
				{
					repositoryId: 1,
					repositoryName: "org/repo",
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
					diffSha256: "a".repeat(64),
					diffBytes: 1,
					provider: "pr-agent",
					imageDigest: `sha256:${"a".repeat(64)}`,
					mergedOutputSha256: "a".repeat(64),
					successfulResponseSha256: ["a".repeat(64)],
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
		const diff = r.patch;
		let calls = 0;
		const recorder = new JobLocalRecorder({
			inventory,
			maxRetries: 1,
			transport: async () => {
				calls += 1;
				if (calls === 1) throw new Error("transient");
				return {
					status: 200,
					body: responsesBody(),
				};
			},
		});
		await recorder.record({
			chunkId: "chunk-1",
			body: responsesRequest(diff),
			headers: {},
		});
		expect(calls).toBe(2);
		await recorder.record({
			chunkId: "chunk-2",
			body: responsesRequest(diff),
			headers: {},
		});
		await recorder.record({
			chunkId: "chunk-3",
			body: responsesRequest(diff),
			headers: {},
		});
		await expect(
			recorder.record({
				chunkId: "chunk-4",
				body: responsesRequest(diff),
				headers: {},
			}),
		).rejects.toMatchObject({ code: "review-coverage-incomplete" });
	});

	it("retains failed logical chunks for fail-closed metadata", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		const diff = r.patch;
		const recorder = new JobLocalRecorder({
			inventory,
			maxRetries: 1,
			transport: async () => {
				throw new Error("upstream unavailable");
			},
		});
		await expect(
			recorder.record({
				chunkId: "chunk-1",
				body: responsesRequest(diff),
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
			diffSha256: "a".repeat(64),
			diffBytes: 1,
			inventory,
			plannedChunkIds: ["chunk-1"],
			failedChunks: [],
			chunks: [
				{
					chunkId: "chunk-1",
					requestSha256: "b".repeat(64),
					matchedFileIds: inventory.files.map((file) => file.id),
					matchedHunkIds: inventory.files.flatMap((file) =>
						file.hunks.map((hunk) => hunk.id),
					),
					responseSha256: "a".repeat(64),
					attempts: 1,
					callStatus: "succeeded" as const,
					responseStatus: 200,
					response: { review: { key_issues_to_review: [] } },
				},
			],
			mergedOutputSha256: "b".repeat(64),
			successfulResponseSha256: ["a".repeat(64)],
		};
		const serialized = serializeMetadata(metadata);
		expect(serialized).not.toContain(r.path);
		expect(() =>
			verifyShadowMetadata(
				serialized,
				{
					repositoryId: 1,
					repositoryName: "org/repo",
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
					diffSha256: "a".repeat(64),
					diffBytes: 1,
					provider: "plain-diff-derived",
					imageDigest: `sha256:${"d".repeat(64)}`,
					mergedOutputSha256: "b".repeat(64),
					successfulResponseSha256: ["a".repeat(64)],
				},
				inventory,
			),
		).toThrowError(CoverageError);
		expect(() =>
			verifyShadowMetadata(
				serialized,
				{
					repositoryId: 1,
					repositoryName: "org/repo",
					pullRequest: 2,
					baseSha: r.base,
					headSha: r.head,
					mergeBaseSha: inventory.mergeBaseSha,
					workflowRunId: 3,
					runAttempt: 1,
					analysisJobId: "job",
					reviewer: "pr-agent",
					runtimeKind: "derived",
					recorderVersion: "v1",
					templateVersion: "v1",
					transportVersion: "v1",
					tokenCap: 300000,
					diffSha256: "a".repeat(64),
					diffBytes: 1,
					provider: "plain-diff-derived",
					imageDigest: `sha256:${"c".repeat(64)}`,
					mergedOutputSha256: "b".repeat(64),
					successfulResponseSha256: ["a".repeat(64)],
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
				body: responsesBody(),
			}),
		);
		expect(result.matchedFileIds).toHaveLength(1);
		expect(result.matchedHunkIds).toHaveLength(0);
	});
});

describe("job-local HTTP boundary", () => {
	it("keeps the latest dispatched response when native retries finish out of order", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		let calls = 0;
		let latestResponse = "";
		let releaseFirst: () => void = () => {};
		let firstArrived: () => void = () => {};
		const waiting = new Promise<void>((resolve) => {
			firstArrived = resolve;
		});
		const upstream = createServer((_request, response) => {
			calls++;
			const body = JSON.stringify({
				...JSON.parse(responsesBody()),
				id: `resp-${calls}`,
			});
			latestResponse = body;
			const finish = () => {
				if (!response.writableEnded)
					response
						.writeHead(200, { "content-type": "application/json" })
						.end(body);
			};
			if (calls === 1) {
				releaseFirst = finish;
				firstArrived();
			} else finish();
		});
		await new Promise<void>((resolve) =>
			upstream.listen(0, "127.0.0.1", resolve),
		);
		const address = upstream.address();
		if (!address || typeof address === "string") throw new Error("no port");
		const proxy = await startRecordingProxy({
			inventory,
			observationOnly: true,
			upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
		});
		const call = () =>
			fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, {
				method: "POST",
				headers: { "x-review-chunk-id": "chunk-one" },
				body: responsesRequest(r.patch),
			});
		try {
			const first = call();
			await waiting;
			expect((await call()).status).toBe(200);
			releaseFirst();
			expect((await first).status).toBe(200);
			expect(calls).toBe(2);
			expect(proxy.results()[0]?.responseSha256).toBe(
				createHash("sha256").update(latestResponse).digest("hex"),
			);
			expect(proxy.results().map((result) => result.attempts)).toEqual([2]);
			expect(proxy.observationFailure()).toBeUndefined();
		} finally {
			releaseFirst();
			await proxy.close();
			await new Promise<void>((resolve) => upstream.close(() => resolve()));
			await rm(r.path, { recursive: true, force: true });
		}
	});

	it("observation forwards invalid evidence once and preserves request budgets", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		let calls = 0;
		const raw = '{"review":{"key_issues_to_review":[]}}';
		const upstream = createServer((_request, response) => {
			calls++;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(raw);
		});
		await new Promise<void>((resolve) =>
			upstream.listen(0, "127.0.0.1", resolve),
		);
		const address = upstream.address();
		if (!address || typeof address === "string") throw new Error("no port");
		const proxy = await startRecordingProxy({
			inventory,
			observationOnly: true,
			upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
		});
		const call = (chunkId: string, body = responsesRequest(r.patch)) =>
			fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, {
				method: "POST",
				headers: {
					"x-review-chunk-id": chunkId,
					"content-type": "application/json",
				},
				body,
			});
		try {
			for (let i = 0; i < 2; i++) {
				const response = await call("chunk-one");
				expect(response.status).toBe(200);
				expect(await response.text()).toBe(raw);
			}
			expect(calls).toBe(2);
			expect(proxy.observationFailure()).toBe("review-output-invalid");
			expect(proxy.results()).toHaveLength(0);
			expect((await call("chunk-one")).status).toBe(502);
			expect((await call("chunk-one", "changed")).status).toBe(502);
			expect(calls).toBe(2);
			expect(proxy.transportFailure()).toBe("review-coverage-incomplete");
			expect((await call("chunk-two")).status).toBe(200);
			expect((await call("chunk-three")).status).toBe(200);
			expect((await call("chunk-four")).status).toBe(502);
			expect(calls).toBe(4);
		} finally {
			await proxy.close();
			await new Promise<void>((resolve) => upstream.close(() => resolve()));
			await rm(r.path, { recursive: true, force: true });
		}
	});

	it("forwards the real request body through a bounded local proxy", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		const diff = r.patch;
		const upstream = createServer((request, response) => {
			if (request.method !== "POST") response.writeHead(405).end();
			else {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(responsesBody());
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
					body: responsesRequest(diff),
				},
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual(JSON.parse(responsesBody()));
			const missingChunkId = await fetch(
				`http://127.0.0.1:${proxy.port}/v1/responses`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: responsesRequest(diff),
				},
			);
			expect(missingChunkId.status).toBe(200);
			expect(await missingChunkId.json()).toEqual(JSON.parse(responsesBody()));
			expect(proxy.results()).toHaveLength(2);
		} finally {
			await proxy.close();
			await new Promise<void>((resolve, reject) =>
				upstream.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});

	it("preserves raw Responses SSE bytes and headers at the proxy boundary", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		const delta = JSON.stringify({ review: { key_issues_to_review: [] } });
		const rawSse = [
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { object: "response", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: delta }] }] } })}`,
			"data: [DONE]",
		].join("\n");
		const upstream = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(rawSse);
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
						"x-review-chunk-id": "chunk-sse-proxy",
						"content-type": "application/json",
					},
					body: responsesRequest(r.patch),
				},
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("text/event-stream");
			expect(await response.text()).toBe(rawSse);
		} finally {
			await proxy.close();
			await new Promise<void>((resolve, reject) =>
				upstream.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});

	it("rejects completed SSE output that differs from its streamed review", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		const delta = JSON.stringify({ review: { key_issues_to_review: [] } });
		for (const terminalText of [
			"not a review",
			JSON.stringify({
				review: {
					key_issues_to_review: [
						{
							relevant_file: "a.txt",
							issue_header: "Different",
							issue_content: "Not present in the deltas",
							start_line: 1,
							end_line: 1,
						},
					],
				},
			}),
		]) {
			const wire = `data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { object: "response", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: terminalText }] }] } })}\n\n`;
			await expect(
				recordChunk(
					inventory,
					{
						chunkId: "chunk-mismatched-sse",
						body: responsesRequest(r.patch),
						headers: {},
					},
					async () => ({ status: 200, body: wire }),
					true,
				),
			).rejects.toMatchObject({ code: "review-output-invalid" });
		}
	});

	it("rejects non-Responses request and response envelopes at the production proxy", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		let upstreamCalls = 0;
		const upstream = createServer((_request, response) => {
			upstreamCalls += 1;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ review: { key_issues_to_review: [] } }));
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
			const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, {
				method: "POST",
				body: JSON.stringify({ diff: r.patch }),
			});
			expect(response.status).toBe(502);
			expect(upstreamCalls).toBe(0);
		} finally {
			await proxy.close();
			await new Promise<void>((resolve) => upstream.close(() => resolve()));
		}
	});

	it("rejects non-finite recorder budgets", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		expect(
			() =>
				new JobLocalRecorder({
					inventory,
					transport: async () => ({ status: 200, body: "" }),
					maxRetries: Number.POSITIVE_INFINITY,
				}),
		).toThrowError(CoverageError);
	});

	it("fails closed on an oversized upstream response", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		const upstream = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("too-large");
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
			maxResponseBytes: 4,
		});
		try {
			const response = await fetch(
				`http://127.0.0.1:${proxy.port}/v1/responses`,
				{
					method: "POST",
					headers: {
						"x-review-chunk-id": "chunk-oversized-response",
						"content-type": "application/json",
					},
					body: responsesRequest(r.patch),
				},
			);
			expect(response.status).toBe(502);
			expect(await response.json()).toEqual({ error: "review-output-invalid" });
		} finally {
			await proxy.close();
			await new Promise<void>((resolve, reject) =>
				upstream.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
});

describe("approved Responses transport and bounded reservations", () => {
	it("parses the deployed Responses JSON request and YAML review result", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		const result = await recordChunk(
			inventory,
			{
				chunkId: "chunk-responses",
				body: JSON.stringify({
					model: "approved-model",
					input: [
						{
							role: "user",
							content: [
								{
									type: "input_text",
									text: `The PR code diff:\n======\n${prAgentDiff(r.patch)}\n======`,
								},
							],
						},
					],
				}),
				headers: {},
			},
			async () => ({
				status: 200,
				body: JSON.stringify({
					status: "completed",
					output: [
						{
							content: [
								{
									type: "output_text",
									text: "review:\n  key_issues_to_review: []\n",
								},
							],
						},
					],
				}),
			}),
		);
		expect(result.matchedFileIds).toHaveLength(2);
	});
	it("rejects malformed official findings", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		await expect(
			recordChunk(
				inventory,
				{
					chunkId: "chunk-invalid-finding",
					body: responsesRequest(r.patch),
					headers: {},
				},
				async () => ({
					status: 200,
					body: JSON.stringify({
						review: {
							key_issues_to_review: [{ issue_header: "missing fields" }],
						},
					}),
				}),
			),
		).rejects.toMatchObject({ code: "review-output-invalid" });
	});

	it("requires a completed SSE response and rejects an incomplete stream", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		const body = JSON.stringify({
			input: [
				{
					role: "user",
					content: [
						{
							type: "input_text",
							text: `The PR code diff:\n======\n${prAgentDiff(r.patch)}\n======`,
						},
					],
				},
			],
		});
		const request = { chunkId: "chunk-sse", body, headers: {} };
		const complete = [
			'data: {"type":"response.output_text.delta","delta":"{\\"review\\":{\\"key_issues_to_review\\":[]}}"}',
			'data: {"type":"response.completed","response":{"status":"completed"}}',
			"data: [DONE]",
		].join("\n");
		await expect(
			recordChunk(inventory, request, async () => ({
				status: 200,
				body: complete,
			})),
		).resolves.toBeDefined();
		await expect(
			recordChunk(
				inventory,
				{ ...request, chunkId: "chunk-sse-2" },
				async () => ({
					status: 200,
					body: complete
						.replace(/data: \{"type":"response\.completed"[^\n]*\}\n/, "")
						.replace("data: [DONE]", ""),
				}),
			),
		).rejects.toMatchObject({ code: "review-output-invalid" });
		const failedTerminal = complete.replace(
			'"status":"completed"',
			'"status":"failed"',
		);
		await expect(
			recordChunk(
				inventory,
				{ ...request, chunkId: "chunk-sse-failed" },
				async () => ({ status: 200, body: failedTerminal }),
			),
		).rejects.toMatchObject({ code: "review-output-invalid" });
	});

	it("rejects merged output with duplicated findings", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		const [file] = inventory.files;
		expect(file).toBeDefined();
		if (!file) throw new Error("expected an inventory file");
		const [hunk] = file.hunks;
		expect(hunk).toBeDefined();
		if (!hunk) throw new Error("expected an inventory hunk");
		const chunk = {
			chunkId: "chunk-duplicate-finding",
			requestSha256: "a".repeat(64),
			matchedFileIds: [file.id],
			matchedHunkIds: [hunk.id],
			responseSha256: "b".repeat(64),
			attempts: 1,
			callStatus: "succeeded" as const,
			responseStatus: 200,
			response: { review: { key_issues_to_review: [{ id: "A" }] } },
		};
		const identity = {
			reviewer: "pr-agent" as const,
			runtimeKind: "official" as const,
			repositoryId: 1,
			repositoryName: "org/repo",
			pullRequest: 1,
			baseSha: r.base,
			headSha: r.head,
			mergeBaseSha: inventory.mergeBaseSha,
			workflowRunId: 1,
			runAttempt: 1,
			analysisJobId: "job",
			provider: "pr-agent",
			imageDigest: `sha256:${"a".repeat(64)}`,
			recorderVersion: "v1",
			templateVersion: "v1",
			transportVersion: "v1",
			tokenCap: 300000,
			diffSha256: "a".repeat(64),
			diffBytes: 1,
		};
		await expect(
			Promise.resolve().then(() =>
				buildCoverageMetadata(identity, inventory, [chunk], {
					review: { key_issues_to_review: [{ id: "A" }, { id: "A" }] },
				}),
			),
		).rejects.toMatchObject({ code: "review-output-invalid" });
	});

	it("reserves three logical chunks before awaiting and keeps retry budget cumulative", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let calls = 0;
		const recorder = new JobLocalRecorder({
			inventory,
			maxRetries: 1,
			transport: async () => {
				calls += 1;
				await gate;
				return {
					status: 200,
					body: responsesBody(),
				};
			},
		});
		const requests = [1, 2, 3, 4].map((n) =>
			recorder.record({
				chunkId: `chunk-${n}`,
				body: responsesRequest(r.patch),
				headers: {},
			}),
		);
		await Promise.resolve();
		release();
		const outcomes = await Promise.allSettled(requests);
		expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
			3,
		);
		expect(calls).toBe(3);

		let failedCalls = 0;
		const failing = new JobLocalRecorder({
			inventory,
			maxRetries: 1,
			transport: async () => {
				failedCalls += 1;
				throw new Error("offline");
			},
		});
		const failedRequest = {
			chunkId: "chunk-failed",
			body: responsesRequest(r.patch),
			headers: {},
		};
		await expect(failing.record(failedRequest)).rejects.toMatchObject({
			code: "review-run-failed",
		});
		await expect(failing.record(failedRequest)).rejects.toMatchObject({
			code: "review-run-failed",
		});
		expect(failedCalls).toBe(2);
		expect(failing.failedChunks()[0]?.attempts).toBe(2);
	});
});

describe("complementary coverage and metadata tamper resistance", () => {
	it("accepts a complete mode-only change without fabricated path headers", async () => {
		const path = await mkdtemp(join(tmpdir(), "review-coverage-mode-"));
		const run = (args: string[]) =>
			execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
				cwd: path,
				encoding: "utf8",
				env: { ...process.env, LEFTHOOK: "0" },
			});
		run(["init", "-q"]);
		run(["config", "user.email", "test@example.com"]);
		run(["config", "user.name", "Test"]);
		await writeFile(join(path, "mode.txt"), "same\n");
		await chmod(join(path, "mode.txt"), 0o755);
		run(["add", "."]);
		run(["commit", "-qm", "base"]);
		const base = run(["rev-parse", "HEAD"]).trim();
		await chmod(join(path, "mode.txt"), 0o644);
		run(["add", "."]);
		run(["commit", "-qm", "mode"]);
		const head = run(["rev-parse", "HEAD"]).trim();
		const inventory = await buildGitInventory(path, base, head);
		const diff = run([
			"diff",
			"--unified=0",
			"--full-index",
			"--no-abbrev",
			`${base}..${head}`,
			"--",
		]);
		await expect(
			recordChunk(
				inventory,
				{ chunkId: "chunk-mode", body: JSON.stringify({ diff }), headers: {} },
				async () => ({
					status: 200,
					body: responsesBody(),
				}),
			),
		).resolves.toBeDefined();
	});

	it("unions complete file chunks and rejects path-only rename metadata", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		const sections = r.patch.split(/(?=diff --git )/).filter(Boolean);
		const response = async () => ({
			status: 200,
			body: responsesBody(),
		});
		const first = await recordChunk(
			inventory,
			{
				chunkId: "chunk-a",
				body: JSON.stringify({ diff: sections[0] }),
				headers: {},
			},
			response,
		);
		const second = await recordChunk(
			inventory,
			{
				chunkId: "chunk-b",
				body: JSON.stringify({ diff: sections[1] }),
				headers: {},
			},
			response,
		);
		await expect(
			recordChunk(
				inventory,
				{
					chunkId: "chunk-duplicate",
					body: JSON.stringify({ diff: `${sections[0]}${sections[0]}` }),
					headers: {},
				},
				response,
			),
		).rejects.toMatchObject({ code: "review-coverage-incomplete" });
		const merged = { review: { key_issues_to_review: [] } };
		const metadata = buildCoverageMetadata(
			{
				reviewer: "pr-agent",
				runtimeKind: "official",
				repositoryId: 1,
				repositoryName: "org/repo",
				pullRequest: 1,
				baseSha: r.base,
				headSha: r.head,
				mergeBaseSha: inventory.mergeBaseSha,
				workflowRunId: 1,
				runAttempt: 1,
				analysisJobId: "job",
				provider: "pr-agent",
				imageDigest: `sha256:${"a".repeat(64)}`,
				recorderVersion: "v1",
				templateVersion: "v1",
				transportVersion: "v1",
				tokenCap: 300000,
				diffSha256: "a".repeat(64),
				diffBytes: 1,
			},
			inventory,
			[first, second],
			merged,
		);
		expect(
			metadata.chunks.flatMap((chunk) => chunk.matchedFileIds),
		).toHaveLength(2);
		const serialized = serializeMetadata(metadata);
		const expected = {
			repositoryId: 1,
			repositoryName: "org/repo",
			pullRequest: 1,
			baseSha: r.base,
			headSha: r.head,
			mergeBaseSha: inventory.mergeBaseSha,
			workflowRunId: 1,
			runAttempt: 1,
			analysisJobId: "job",
			reviewer: "pr-agent" as const,
			runtimeKind: "official" as const,
			recorderVersion: "v1",
			templateVersion: "v1",
			transportVersion: "v1",
			tokenCap: 300000,
			diffSha256: "a".repeat(64),
			diffBytes: 1,
			provider: "pr-agent",
			imageDigest: `sha256:${"a".repeat(64)}`,
			mergedOutputSha256: metadata.mergedOutputSha256,
			successfulResponseSha256: metadata.successfulResponseSha256,
		};
		expect(verifyShadowMetadata(serialized, expected, inventory)).toBeDefined();
		const tamperedRequest = JSON.parse(serialized) as Record<string, unknown>;
		const tamperedChunks = tamperedRequest.chunks as Array<
			Record<string, unknown>
		>;
		const firstChunk = tamperedChunks[0];
		expect(firstChunk).toBeDefined();
		if (!firstChunk) throw new Error("expected a reserved chunk");
		firstChunk.requestSha256 = "bad";
		await expect(
			Promise.resolve().then(() =>
				verifyShadowMetadata(
					JSON.stringify(tamperedRequest),
					expected,
					inventory,
				),
			),
		).rejects.toMatchObject({ code: "review-output-invalid" });
		expect(() =>
			verifyShadowMetadata(
				serialized,
				{ ...expected, repositoryName: "evil/repo" },
				inventory,
			),
		).toThrowError(CoverageError);
		expect(() =>
			verifyShadowMetadata(
				serialized,
				{ ...expected, mergedOutputSha256: "f".repeat(64) },
				inventory,
			),
		).toThrowError(CoverageError);
		const rename = r.patch.replace(
			/diff --git a\/a\.txt b\/a\.txt[\s\S]*?(?=diff --git |$)/,
			"diff --git a/a.txt b/z.txt\n",
		);
		await expect(
			recordChunk(
				inventory,
				{
					chunkId: "chunk-rename-spoof",
					body: JSON.stringify({ diff: rename }),
					headers: {},
				},
				response,
			),
		).rejects.toMatchObject({ code: "review-coverage-incomplete" });
	});
});

describe("native context and upstream lifetime regressions", () => {
	it("preserves context whitespace and rejects forged native line numbers before transport", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		const native =
			"The PR code diff:\n======\n## File: 'a.txt'\n@@ -1 +1,2 @@\n__new hunk__\n1  one\n2 +two\n__old hunk__\n one\n======";
		let calls = 0;
		const record = (text: string) =>
			recordChunk(
				inventory,
				{
					chunkId: "chunk-native",
					body: JSON.stringify({ input: text }),
					headers: {},
				},
				async () => {
					calls += 1;
					return {
						status: 200,
						body: responsesBody(),
					};
				},
			);
		await expect(record(native)).resolves.toBeDefined();
		for (const line of ["999 +two", "1 +two", "0 +two"]) {
			await expect(
				record(native.replace("2 +two", line)),
			).rejects.toMatchObject({ code: "unsupported-transport" });
		}
		expect(calls).toBe(1);
	});

	it("bounds retries and latches excess logical chunks", async () => {
		const r = await repo();
		const inventory = await buildGitInventory(r.path, r.base, r.head);
		const options = {
			inventory,
			transport: async () => ({
				status: 200,
				body: responsesBody(),
			}),
		};
		expect(
			() => new JobLocalRecorder({ ...options, maxRetries: 1000000 }),
		).toThrowError(CoverageError);
		const recorder = new JobLocalRecorder(options);
		for (let i = 1; i <= 3; i++)
			await recorder.record({
				chunkId: `chunk-${i}`,
				body: responsesRequest(r.patch),
				headers: {},
			});
		await expect(
			recorder.record({
				chunkId: "chunk-4",
				body: responsesRequest(r.patch),
				headers: {},
			}),
		).rejects.toMatchObject({ code: "review-coverage-incomplete" });
		expect(() => recorder.results()).toThrowError(CoverageError);
		expect(() => recorder.failedChunks()).toThrowError(CoverageError);
	});

	for (const action of ["timeout", "close"] as const) {
		it(`terminates a stalled SSE body on ${action}`, async () => {
			const r = await repo();
			const inventory = await buildGitInventory(r.path, r.base, r.head);
			let started!: () => void;
			let disconnected!: () => void;
			const ready = new Promise<void>((resolve) => {
				started = resolve;
			});
			const gone = new Promise<void>((resolve) => {
				disconnected = resolve;
			});
			const upstream = createServer((_request, response) => {
				response.on("close", disconnected);
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write('data: {"type":"response.created"}\n\n');
				started();
			});
			await new Promise<void>((resolve) =>
				upstream.listen(0, "127.0.0.1", resolve),
			);
			const address = upstream.address();
			if (!address || typeof address === "string")
				throw new Error("missing upstream port");
			const proxy = await startRecordingProxy({
				inventory,
				upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
				upstreamTimeoutMs: action === "timeout" ? 100 : 60000,
			});
			const pending = fetch(`http://127.0.0.1:${proxy.port}/responses`, {
				method: "POST",
				body: responsesRequest(r.patch),
			}).then(
				(response) => response.status,
				() => 0,
			);
			try {
				await ready;
				if (action === "close") await proxy.close();
				const status = await pending;
				expect(status).toBe(action === "timeout" ? 502 : 0);
				await gone;
				expect(proxy.results()).toHaveLength(0);
			} finally {
				if (action !== "close") await proxy.close();
				upstream.closeAllConnections();
				await new Promise<void>((resolve) => upstream.close(() => resolve()));
			}
		});
	}
});
