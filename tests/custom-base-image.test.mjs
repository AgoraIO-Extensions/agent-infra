import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const verifier = resolve(
	import.meta.dirname,
	"../deploy/release/custom-base-image.mjs",
);
const config = "{}";
const configDigest =
	"sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
const manifest = JSON.stringify({ config: { digest: configDigest } });
const manifestDigest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;

async function verify({ published = false, mode = "classic" } = {}) {
	const rawManifest = mode === "whitespace" ? ` \n${manifest}\n` : manifest;
	const manifestDigest = `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`;
	const directory = await mkdtemp(join(tmpdir(), "agent-infra-base-metadata-"));
	try {
		const docker = join(directory, "docker.mjs");
		await writeFile(
			join(directory, `${configDigest.slice(7)}.json`),
			mode === "oci-missing-config-tampered" ? '{"tampered":true}' : config,
		);
		await writeFile(
			join(directory, "manifest.json"),
			JSON.stringify([{ Config: `${configDigest.slice(7)}.json` }]),
		);
		await writeFile(
			docker,
			`#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const configDigest = ${JSON.stringify(configDigest)};
const manifestDigest = ${JSON.stringify(manifestDigest)};
const mode = ${JSON.stringify(mode)};
if (args[0] === "buildx" && args[1] === "imagetools") process.stdout.write(${JSON.stringify(rawManifest)});
else if (args[0] === "buildx" && args[1] === "build") {
  writeFileSync(args[args.indexOf("--metadata-file") + 1], JSON.stringify({
    "containerimage.digest": mode === "classic" ? configDigest : manifestDigest,
    ...(mode.startsWith("oci-missing-config") ? {} : { "containerimage.config.digest": mode === "bad-config" ? "sha256:" + "b".repeat(64) : configDigest }),
  }));
} else if (args[0] === "image" && args[1] === "inspect") {
  const child = args.at(-1).startsWith("agent-infra-verification/");
  console.log(JSON.stringify({
    Id: configDigest, Os: "linux", Architecture: "amd64",
    ...(child && mode !== "classic" ? { Descriptor: { digest: mode === "bad-descriptor" ? configDigest : manifestDigest } } : {}),
    Config: { User: "node", WorkingDir: "/workspace", Env: ["NODE_VERSION=24", "PATH=/usr/bin", "YARN_VERSION=1"] },
  }));
} else if (args[0] === "image" && args[1] === "save") {
  const result = spawnSync("tar", ["-cf", args[args.indexOf("--output") + 1], "-C", import.meta.dirname, "manifest.json", configDigest.slice(7) + ".json"]);
  process.exit(result.status ?? 1);
} else if (args[0] === "run") console.log(JSON.stringify({ status: "passed" }));
else if (args[0] !== "pull" && !(args[0] === "image" && args[1] === "rm")) process.exit(1);
`,
		);
		await chmod(docker, 0o755);
		const report = join(directory, "report.json");
		const result = spawnSync(
			process.execPath,
			[
				verifier,
				`registry.example/base@${manifestDigest}`,
				report,
				...(published ? ["--published"] : []),
			],
			{
				encoding: "utf8",
				env: { ...process.env, DOCKER_BIN: docker },
			},
		);
		return {
			...result,
			report: await readFile(report, "utf8")
				.then(JSON.parse)
				.catch(() => null),
		};
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("local classic Docker evidence does not label the config ID as a manifest Digest", async () => {
	const result = await verify();
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.report.childDigest, null);
	assert.equal(result.report.childConfigDigest, configDigest);
});

test("published acceptance rejects a config ID in place of the child manifest Digest", async () => {
	const result = await verify({ published: true });
	assert.notEqual(result.status, 0);
	assert.equal(result.report, null);
	assert.match(
		result.stderr,
		/published acceptance requires a child manifest Digest/,
	);
});

test("published acceptance records a distinct child manifest and verified config Digest", async () => {
	const result = await verify({ published: true, mode: "oci" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.report.childDigest, manifestDigest);
	assert.equal(result.report.childConfigDigest, configDigest);
});

test("OCI metadata without the optional config Digest still verifies exported config bytes", async () => {
	const result = await verify({ published: true, mode: "oci-missing-config" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.report.childDigest, manifestDigest);
	assert.equal(result.report.childConfigDigest, configDigest);
});

test("missing OCI config metadata cannot accept config bytes with a mismatched archive Digest", async () => {
	const result = await verify({ mode: "oci-missing-config-tampered" });
	assert.notEqual(result.status, 0);
	assert.equal(result.report, null);
	assert.match(result.stderr, /exported config bytes differ/);
});

test("published acceptance hashes the exact manifest bytes including surrounding whitespace", async () => {
	const result = await verify({ published: true, mode: "whitespace" });
	assert.equal(result.status, 0, result.stderr);
	assert.notEqual(result.report.baseDigest, manifestDigest);
});

for (const mode of ["bad-config", "bad-descriptor"]) {
	test(`inconsistent child ${mode} evidence fails without writing a report`, async () => {
		const result = await verify({ mode });
		assert.notEqual(result.status, 0);
		assert.equal(result.report, null);
	});
}
