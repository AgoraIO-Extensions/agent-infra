#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const repositoryPattern = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const images = [
	{
		key: "web",
		name: "web",
		dockerfile: "apps/web/Dockerfile",
		runOptions: ["--tmpfs", "/tmp:size=16m,mode=1777"],
		command: ["-t"],
	},
	{
		key: "platformApi",
		name: "platform-api",
		dockerfile: "apps/platform-api/Dockerfile",
		command: [
			"node",
			"--input-type=module",
			"-e",
			"await import('./dist/index.mjs')",
		],
	},
	{
		key: "platformWorker",
		name: "platform-worker",
		dockerfile: "apps/platform-worker/Dockerfile",
		command: [
			"node",
			"--input-type=module",
			"-e",
			"const {startPlatformWorker}=await import('./dist/index.mjs');const worker=startPlatformWorker({log(){}});worker.stop()",
		],
	},
	{
		key: "runtimeHost",
		name: "agent-runtime-host",
		dockerfile: "apps/agent-runtime-host/Dockerfile",
		command: [
			"node",
			"--input-type=module",
			"-e",
			"await import('./dist/index.mjs')",
		],
	},
];

function fail(message) {
	throw new Error(message);
}

function run(command, args, name, environment = process.env) {
	const result = spawnSync(command, args, {
		cwd: repositoryRoot,
		encoding: "utf8",
		env: environment,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) fail(`${name} could not start`);
	if (result.status !== 0) fail(`${name} failed`);
	return result.stdout.trim();
}

async function unavailable(path) {
	try {
		await access(path);
		return false;
	} catch {
		return true;
	}
}

async function buildImage({ image, commitSha, epoch, platform, prefix, temp }) {
	const docker = process.env.DOCKER_BIN ?? "docker";
	const repository = `${prefix}/${image.name}`;
	const reference = `${repository}:${commitSha}`;
	const digests = [];
	let archivePath;
	for (const pass of [1, 2]) {
		const metadataPath = join(temp, `${image.name}-${pass}.json`);
		archivePath = join(temp, `${image.name}-${pass}.oci.tar`);
		run(
			docker,
			[
				"buildx",
				"build",
				"--file",
				image.dockerfile,
				"--platform",
				platform,
				"--build-arg",
				`SOURCE_DATE_EPOCH=${epoch}`,
				"--provenance=false",
				"--sbom=false",
				"--no-cache",
				"--tag",
				reference,
				"--output",
				`type=oci,dest=${archivePath},rewrite-timestamp=true`,
				"--metadata-file",
				metadataPath,
				"--progress=quiet",
				".",
			],
			`${image.key} image build ${pass}`,
			{ ...process.env, BUILDX_GIT_INFO: "false" },
		);
		let metadata;
		try {
			metadata = JSON.parse(await readFile(metadataPath, "utf8"));
		} catch {
			fail(`${image.key} image metadata is invalid`);
		}
		const digest = metadata["containerimage.digest"];
		if (!digestPattern.test(digest)) {
			fail(`${image.key} image digest is invalid`);
		}
		digests.push(digest);
	}
	if (digests[0] !== digests[1]) {
		fail(`${image.key} image is not reproducible`);
	}
	run(
		docker,
		["load", "--input", archivePath],
		`${image.key} image load`,
	);
	const user = run(
		docker,
		["image", "inspect", "--format", "{{.Config.User}}", reference],
		`${image.key} image user inspection`,
	);
	const runtimeUser = user.split(":", 1)[0];
	if (!runtimeUser || runtimeUser === "root" || /^0+$/.test(runtimeUser)) {
		fail(`${image.key} image runtime user must be non-root`);
	}
	run(
		docker,
		[
			"run",
			"--rm",
			"--read-only",
			...(image.runOptions ?? []),
			reference,
			...image.command,
		],
		`${image.key} read-only runtime probe`,
	);
	return { repository, digest: digests[0] };
}

async function main() {
	const [manifestArgument, ...extra] = process.argv.slice(2);
	if (!manifestArgument || extra.length > 0) {
		fail("usage: build-images.mjs <image-manifest.json>");
	}
	const manifestPath = resolve(manifestArgument);
	if (!(await unavailable(manifestPath))) {
		fail("image manifest already exists");
	}
	if (await unavailable(dirname(manifestPath))) {
		fail("image manifest directory does not exist");
	}

	const git = process.env.GIT_BIN ?? "git";
	if (run(git, ["status", "--porcelain", "--untracked-files=all"], "Git status")) {
		fail("image builds require a clean Git worktree");
	}
	const commitSha = run(git, ["rev-parse", "HEAD"], "Git HEAD");
	if (!/^[a-f0-9]{40}$/.test(commitSha)) fail("Git HEAD is invalid");
	const epoch = run(git, ["show", "-s", "--format=%ct", "HEAD"], "Git epoch");
	if (!/^[1-9][0-9]*$/.test(epoch)) fail("Git commit epoch is invalid");

	const platform = process.env.PLATFORM ?? "linux/amd64";
	if (!/^linux\/(?:amd64|arm64)$/.test(platform)) fail("PLATFORM is invalid");
	const prefix =
		process.env.IMAGE_REPOSITORY_PREFIX ??
		"ghcr.io/agoraio-extensions/agent-infra";
	if (!repositoryPattern.test(prefix)) {
		fail("IMAGE_REPOSITORY_PREFIX is invalid");
	}

	const temp = await mkdtemp(join(tmpdir(), "agent-infra-image-build-"));
	try {
		const builtImages = {};
		for (const image of images) {
			builtImages[image.key] = await buildImage({
				image,
				commitSha,
				epoch,
				platform,
				prefix,
				temp,
			});
		}
		await writeFile(
			manifestPath,
			`${JSON.stringify(
				{ schemaVersion: 1, commitSha, platform, images: builtImages },
				null,
				2,
			)}\n`,
			{ flag: "wx" },
		);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
	console.info(`immutable image manifest written to ${manifestPath}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : "image build failed");
	process.exitCode = 1;
});
