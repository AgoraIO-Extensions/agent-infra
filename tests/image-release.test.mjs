import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	access,
	chmod,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const builder = resolve(repositoryRoot, "deploy/release/build-images.mjs");
const commitSha = "1".repeat(40);

async function executable(path, source) {
	await writeFile(path, `#!/usr/bin/env node\n${source}`);
	await chmod(path, 0o755);
}

async function fakes(directory) {
	const git = join(directory, "git.mjs");
	const docker = join(directory, "docker.mjs");
	await executable(
		git,
		`import { existsSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "status") {
  if (existsSync(process.env.FAKE_GIT_DRIFT_MARKER)) console.log(" M source");
  process.exit(0);
}
if (args[0] === "rev-parse") console.log("${commitSha}");
else if (args[0] === "show") console.log("1700000000");
else process.exit(1);`,
	);
	await executable(
		docker,
		`import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const log = process.env.FAKE_DOCKER_LOG;
writeFileSync(log, JSON.stringify(args) + "\\n", { flag: "a" });
if (args[0] === "buildx" && args[1] === "build") {
  const metadata = args[args.indexOf("--metadata-file") + 1];
  const tag = args[args.indexOf("--tag") + 1];
  const statePath = process.env.FAKE_DOCKER_STATE;
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state[tag] = (state[tag] ?? 0) + 1;
  writeFileSync(statePath, JSON.stringify(state));
  if (process.env.FAKE_GIT_DRIFT && Object.values(state).reduce((sum, count) => sum + count, 0) === 1) writeFileSync(process.env.FAKE_GIT_DRIFT_MARKER, "drift");
  const drift = process.env.FAKE_DOCKER_DRIFT && tag.includes(process.env.FAKE_DOCKER_DRIFT) && state[tag] === 2;
  const digest = createHash("sha256").update(tag + (drift ? ":drift" : ":stable")).digest("hex");
  writeFileSync(metadata, JSON.stringify({ "containerimage.digest": "sha256:" + digest }));
  process.exit(0);
}
if (args[0] === "image" && args[1] === "inspect") {
  console.log(args.at(-1).includes("/web:") ? "nginx" : "node");
  process.exit(0);
}
if (args[0] === "load" && args[1] === "--input") process.exit(0);
if (args[0] === "run") process.exit(0);
process.exit(1);`,
	);
	return { docker, git };
}

function build(manifestPath, directory, environment = {}) {
	return spawnSync(process.execPath, [builder, manifestPath], {
		cwd: repositoryRoot,
		encoding: "utf8",
		env: {
			...process.env,
			DOCKER_BIN: join(directory, "docker.mjs"),
			FAKE_DOCKER_LOG: join(directory, "docker.log"),
			FAKE_DOCKER_STATE: join(directory, "docker-state.json"),
			FAKE_GIT_DRIFT_MARKER: join(directory, "git-drift"),
			GIT_BIN: join(directory, "git.mjs"),
			IMAGE_REPOSITORY_PREFIX: "registry.example/agent-infra",
			PLATFORM: "linux/amd64",
			...environment,
		},
	});
}

test("image build validates reproducibility and read-only non-root execution", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-infra-images-"));
	try {
		await fakes(directory);
		await writeFile(join(directory, "docker-state.json"), "{}");
		const manifestPath = join(directory, "images.json");
		const result = build(manifestPath, directory);
		assert.equal(result.status, 0, result.stderr);

		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		assert.equal(manifest.schemaVersion, 1);
		assert.equal(manifest.commitSha, commitSha);
		assert.equal(manifest.platform, "linux/amd64");
		assert.deepEqual(Object.keys(manifest.images), [
			"web",
			"platformApi",
			"platformWorker",
			"runtimeHost",
		]);
		for (const image of Object.values(manifest.images)) {
			assert.match(image.digest, /^sha256:[a-f0-9]{64}$/);
		}

		const calls = (await readFile(join(directory, "docker.log"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const builds = calls.filter(
			(args) => args[0] === "buildx" && args[1] === "build",
		);
		assert.equal(builds.length, 8);
		const storeDirectories = new Set();
		for (const args of builds) {
			assert.ok(args.includes("--no-cache"));
			assert.ok(args.includes("SOURCE_DATE_EPOCH=1700000000"));
			const store = args.find((argument) =>
				argument.startsWith("PNPM_STORE_DIR="),
			);
			assert.match(
				store,
				/^PNPM_STORE_DIR=\/tmp\/agent-infra-pnpm-store-[a-f0-9-]+-[a-z-]+-[12]$/,
			);
			storeDirectories.add(store);
			assert.ok(args.includes("--provenance=false"));
			assert.ok(args.includes("--sbom=false"));
			assert.match(
				args[args.indexOf("--output") + 1],
				/^type=oci,dest=.+,rewrite-timestamp=true$/,
			);
		}
		assert.equal(storeDirectories.size, 8);
		const firstMetadata = builds[0][builds[0].indexOf("--metadata-file") + 1];
		await assert.rejects(access(resolve(firstMetadata, "..")));
		assert.equal(
			calls.filter((args) => args[0] === "load" && args[1] === "--input")
				.length,
			4,
		);
		const probes = calls.filter((args) => args[0] === "run");
		assert.equal(probes.length, 4);
		for (const args of probes) {
			assert.ok(args.includes("--read-only"));
			const referenceIndex = args.findIndex((argument) =>
				argument.startsWith("registry.example/agent-infra/"),
			);
			assert.ok(referenceIndex > args.indexOf("--read-only"));
			if (args[referenceIndex].includes("/web:")) {
				assert.deepEqual(args.slice(referenceIndex + 1), ["-t"]);
			} else {
				assert.equal(args[referenceIndex + 1], "node");
				if (
					args[referenceIndex].includes("/platform-api:") ||
					args[referenceIndex].includes("/agent-runtime-host:")
				) {
					assert.match(args.at(-1), /package\.json/);
					assert.match(args.at(-1), /dist\/index\.mjs/);
					assert.match(args.at(-1), /TypeScript declarations found/);
				}
			}
		}

		await writeFile(join(directory, "docker-state.json"), "{}");
		const checkoutDrift = build(
			join(directory, "checkout-drift.json"),
			directory,
			{ FAKE_GIT_DRIFT: "1" },
		);
		assert.notEqual(checkoutDrift.status, 0);
		assert.match(
			checkoutDrift.stderr,
			/Git checkout changed during image build/,
		);
		await assert.rejects(access(join(directory, "checkout-drift.json")));
		await rm(join(directory, "git-drift"), { force: true });

		await writeFile(join(directory, "docker-state.json"), "{}");
		const drifted = build(join(directory, "drifted.json"), directory, {
			FAKE_DOCKER_DRIFT: "platform-worker",
		});
		assert.notEqual(drifted.status, 0);
		assert.match(drifted.stderr, /platformWorker image is not reproducible/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
