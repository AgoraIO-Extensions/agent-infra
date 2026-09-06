import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
if (args[0] === "push") process.exit(0);
if (args[0] === "manifest" && args[1] === "inspect") {
  const digest = process.env.FAKE_REMOTE_DIGEST ?? "sha256:" + createHash("sha256").update(args.at(-1) + ":published").digest("hex");
  console.log(JSON.stringify({ Descriptor: { digest } }));
  process.exit(0);
}
if (args[0] === "run") {
  if (args.includes("--entrypoint")) console.log(process.env.FAKE_RUNTIME_UID ?? "1000");
  process.exit(0);
}
process.exit(1);`,
	);
	return { docker, git };
}

function build(
	manifestPath,
	directory,
	environment = {},
	repositoryPrefix = "registry.example/agent-infra",
) {
	const childEnvironment = {
		...process.env,
		DOCKER_BIN: join(directory, "docker.mjs"),
		FAKE_DOCKER_LOG: join(directory, "docker.log"),
		FAKE_DOCKER_STATE: join(directory, "docker-state.json"),
		FAKE_GIT_DRIFT_MARKER: join(directory, "git-drift"),
		GIT_BIN: join(directory, "git.mjs"),
		PLATFORM: "linux/amd64",
		...environment,
	};
	delete childEnvironment.IMAGE_REPOSITORY_PREFIX;
	if (repositoryPrefix !== null) {
		childEnvironment.IMAGE_REPOSITORY_PREFIX = repositoryPrefix;
	}
	return spawnSync(process.execPath, [builder, manifestPath], {
		cwd: repositoryRoot,
		encoding: "utf8",
		env: childEnvironment,
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
			assert.equal(
				image.digest,
				`sha256:${createHash("sha256")
					.update(`${image.repository}:${commitSha}:published`)
					.digest("hex")}`,
			);
		}

		const calls = (await readFile(join(directory, "docker.log"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const builds = calls.filter(
			(args) => args[0] === "buildx" && args[1] === "build",
		);
		assert.equal(builds.length, 8);
		for (const args of builds) {
			assert.ok(args.includes("--no-cache"));
			assert.deepEqual(
				args.flatMap((argument, index) =>
					argument === "--build-arg" ? [args[index + 1]] : [],
				),
				["SOURCE_DATE_EPOCH=1700000000"],
			);
			assert.ok(args.includes("--provenance=false"));
			assert.ok(args.includes("--sbom=false"));
			assert.match(
				args[args.indexOf("--output") + 1],
				/^type=oci,dest=.+,rewrite-timestamp=true$/,
			);
		}
		const firstMetadata = builds[0][builds[0].indexOf("--metadata-file") + 1];
		await assert.rejects(access(resolve(firstMetadata, "..")));
		assert.equal(
			calls.filter((args) => args[0] === "load" && args[1] === "--input")
				.length,
			8,
		);
		const pushes = calls.filter((args) => args[0] === "push");
		const readbacks = calls.filter(
			(args) => args[0] === "manifest" && args[1] === "inspect",
		);
		assert.equal(pushes.length, 4);
		assert.equal(readbacks.length, 4);
		assert.ok(
			calls.indexOf(pushes[0]) >
				calls.findLastIndex(
					(args) => args[0] === "buildx" && args[1] === "build",
				),
			"publication must start only after every reproducibility build passes",
		);
		const probes = calls.filter(
			(args) => args[0] === "run" && !args.includes("--entrypoint"),
		);
		const userProbes = calls.filter(
			(args) => args[0] === "run" && args.includes("--entrypoint"),
		);
		assert.equal(probes.length, 4);
		assert.equal(userProbes.length, 4);
		for (const args of userProbes) {
			assert.ok(args.includes("--read-only"));
			assert.deepEqual(args.slice(args.indexOf("--entrypoint")), [
				"--entrypoint",
				"id",
				args.at(-2),
				"-u",
			]);
		}
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
					args[referenceIndex].includes("/platform-worker:") ||
					args[referenceIndex].includes("/agent-runtime-host:")
				) {
					assert.match(args.at(-1), /package\.json/);
					assert.match(args.at(-1), /dist\/index\.mjs/);
					assert.match(args.at(-1), /TypeScript declarations found/);
					assert.match(args.at(-1), /pnpm-lock\.yaml/);
					assert.match(args.at(-1), /pnpm-workspace\.yaml/);
					assert.match(args.at(-1), /\.package-map\.json/);
				}
			}
		}
		assert.ok(
			calls.indexOf(pushes[0]) >
				calls.findLastIndex((args) => args[0] === "run"),
			"publication must start only after every runtime probe passes",
		);

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
		await writeFile(join(directory, "docker.log"), "");
		const drifted = build(join(directory, "drifted.json"), directory, {
			FAKE_DOCKER_DRIFT: "platform-worker",
		});
		assert.notEqual(drifted.status, 0);
		assert.match(drifted.stderr, /platformWorker image is not reproducible/);
		const driftCalls = (await readFile(join(directory, "docker.log"), "utf8"))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		assert.equal(driftCalls.filter((args) => args[0] === "push").length, 0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("image publication requires an explicit repository prefix", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-infra-images-prefix-"));
	try {
		await fakes(directory);
		await writeFile(join(directory, "docker-state.json"), "{}");
		const manifestPath = join(directory, "images.json");
		const result = build(manifestPath, directory, {}, null);

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /image repository prefix is required/);
		await assert.rejects(access(manifestPath));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("image publication rejects an invalid remote digest", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-infra-images-remote-"));
	try {
		await fakes(directory);
		await writeFile(join(directory, "docker-state.json"), "{}");
		const manifestPath = join(directory, "images.json");
		const result = build(manifestPath, directory, {
			FAKE_REMOTE_DIGEST: "mutable-tag",
		});

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /published image digest is invalid/);
		await assert.rejects(access(manifestPath));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("image build rejects an effective root runtime user", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-infra-images-root-"));
	try {
		await fakes(directory);
		await writeFile(join(directory, "docker-state.json"), "{}");
		const manifestPath = join(directory, "images.json");
		const result = build(manifestPath, directory, { FAKE_RUNTIME_UID: "0" });

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /effective UID must be non-root/);
		await assert.rejects(access(manifestPath));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
