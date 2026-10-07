import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const sha = "1".repeat(40);
const prefix = "registry.example/agent-infra";
const names = [
	"agent-runtime-codex",
	"agent-runtime-claude",
	"agent-runtime-opencode",
	"agent-runtime-pi",
	"custom-agent-base",
];

test("index publication uses same-source architecture Digests and fails closed on missing or mixed receipts", async () => {
	const temp = await mkdtemp(join(tmpdir(), "agent-infra-indexes-"));
	try {
		const receipts = ["amd64", "arm64"].map((arch, index) => ({
			schemaVersion: 1,
			commitSha: sha,
			platform: `linux/${arch}`,
			images: Object.fromEntries(
				names.map((name) => [
					name,
					{
						repository: `${prefix}/${name}`,
						digest: `sha256:${String(index + 2).repeat(64)}`,
					},
				]),
			),
		}));
		const paths = [join(temp, "amd64.json"), join(temp, "arm64.json")];
		const log = join(temp, "docker.log");
		const docker = join(temp, "docker.mjs");
		await writeFile(
			docker,
			`#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.DOCKER_LOG, JSON.stringify(args) + '\\n');
if(args[1] === 'imagetools' && args[2] === 'inspect') console.log(JSON.stringify({manifests:['amd64','arm64'].map((architecture,index)=>({digest:'sha256:'+(process.env.FAKE_WRONG_INDEX ? "9" : String(index+2)).repeat(64),platform:{os:'linux',architecture}}))}));
`,
		);
		await chmod(docker, 0o755);
		const run = (extra = {}, tag = "main") =>
			spawnSync(
				process.execPath,
				[
					join(root, "deploy/release/publish-image-indexes.mjs"),
					tag,
					names.join(","),
					...paths,
				],
				{
					encoding: "utf8",
					env: {
						...process.env,
						GITHUB_SHA: sha,
						IMAGE_REPOSITORY_PREFIX: prefix,
						DOCKER_BIN: docker,
						DOCKER_LOG: log,
						...extra,
					},
				},
			);
		for (let index = 0; index < paths.length; index++)
			await writeFile(paths[index], JSON.stringify(receipts[index]));
		const result = run();
		assert.equal(result.status, 0, result.stderr);
		const calls = (await readFile(log, "utf8"))
			.trim()
			.split("\n")
			.map(JSON.parse);
		const creates = calls.filter((args) => args[2] === "create");
		assert.equal(creates.length, 5);
		for (const [index, args] of creates.entries())
			assert.deepEqual(args, [
				"buildx",
				"imagetools",
				"create",
				"--tag",
				`${prefix}/${names[index]}:main`,
				`${prefix}/${names[index]}@sha256:${"2".repeat(64)}`,
				`${prefix}/${names[index]}@sha256:${"3".repeat(64)}`,
			]);
		const release = run({}, "v1.2.3");
		assert.equal(release.status, 0, release.stderr);
		const releaseCalls = (await readFile(log, "utf8"))
			.trim()
			.split("\n")
			.map(JSON.parse);
		assert.deepEqual(
			releaseCalls
				.filter((args) => args[2] === "create")
				.slice(-5)
				.map((args) => args[4]),
			names.map((name) => `${prefix}/${name}:v1.2.3`),
		);
		for (const mutate of [
			(value) => {
				value.commitSha = "9".repeat(40);
			},
			(value) => {
				delete value.images[names[0]];
			},
			(value) => {
				value.images[names[0]].digest = "latest";
			},
			(value) => {
				value.images.unexpected = {
					repository: `${prefix}/web`,
					digest: `sha256:${"4".repeat(64)}`,
				};
			},
			(value) => {
				value.platform = "linux/amd64";
			},
		]) {
			await rm(log, { force: true });
			const changed = structuredClone(receipts[1]);
			mutate(changed);
			await writeFile(paths[1], JSON.stringify(changed));
			const failure = run();
			assert.notEqual(failure.status, 0);
			assert.match(failure.stderr, /receipt/);
			await assert.rejects(readFile(log));
		}

		await writeFile(paths[1], JSON.stringify(receipts[1]));
		const wrongIndex = run({ FAKE_WRONG_INDEX: "true" });
		assert.notEqual(wrongIndex.status, 0);
		assert.match(
			wrongIndex.stderr,
			/published index differs from verified receipts/,
		);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});
