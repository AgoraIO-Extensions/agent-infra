#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { runCommand } from "./run-command.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const timeoutMs = {
	build: 15 * 60_000,
	git: 30_000,
	inspect: 30_000,
	load: 5 * 60_000,
	probe: 60_000,
};
const repositoryPattern = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const assertInjectedRuntime =
	"const {access,readdir}=await import('node:fs/promises');" +
	"await Promise.all([access('./package.json'),access('./dist/index.mjs')]);" +
	"const visit=async(path)=>{for(const entry of await readdir(path,{withFileTypes:true})){const child=path+'/'+entry.name;if(entry.isDirectory())await visit(child);else if(entry.isFile()&&/\\.d\\.(?:[cm]?ts)(?:\\.map)?$/.test(entry.name))throw new Error('TypeScript declarations found')}};" +
	"await visit('.');";
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
			`${assertInjectedRuntime}await import('./dist/index.mjs')`,
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
			`${assertInjectedRuntime}const {startPlatformWorker}=await import('./dist/index.mjs');const worker=startPlatformWorker({log(){}});worker.stop()`,
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
			`${assertInjectedRuntime}await import('./dist/index.mjs')`,
		],
	},
];

function fail(message) {
	throw new Error(message);
}

async function unavailable(path) {
	try {
		await access(path);
		return false;
	} catch {
		return true;
	}
}

function assertCheckout(git, commitSha) {
	const head = runCommand(git, ["rev-parse", "HEAD"], {
		cwd: repositoryRoot,
		name: "Git HEAD check",
		timeoutMs: timeoutMs.git,
	});
	const status = runCommand(
		git,
		["status", "--porcelain", "--untracked-files=all"],
		{
			cwd: repositoryRoot,
			name: "Git status check",
			timeoutMs: timeoutMs.git,
		},
	);
	if (head !== commitSha || status) {
		fail("Git checkout changed during image build");
	}
}

async function buildImage({
	image,
	commitSha,
	epoch,
	platform,
	prefix,
	temp,
	buildIdentity,
	git,
}) {
	const docker = process.env.DOCKER_BIN ?? "docker";
	const repository = `${prefix}/${image.name}`;
	const reference = `${repository}:${commitSha}`;
	const digests = [];
	let archivePath;
	for (const pass of [1, 2]) {
		assertCheckout(git, commitSha);
		const metadataPath = join(temp, `${image.name}-${pass}.json`);
		archivePath = join(temp, `${image.name}-${pass}.oci.tar`);
		const storeDirectory = `/tmp/agent-infra-pnpm-store-${buildIdentity}-${image.name}-${pass}`;
		runCommand(
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
				"--build-arg",
				`PNPM_STORE_DIR=${storeDirectory}`,
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
			{
				cwd: repositoryRoot,
				env: { ...process.env, BUILDX_GIT_INFO: "false" },
				name: `${image.key} image build ${pass}`,
				timeoutMs: timeoutMs.build,
			},
		);
		assertCheckout(git, commitSha);
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
	runCommand(
		docker,
		["load", "--input", archivePath],
		{
			cwd: repositoryRoot,
			name: `${image.key} image load`,
			timeoutMs: timeoutMs.load,
		},
	);
	const user = runCommand(
		docker,
		["image", "inspect", "--format", "{{.Config.User}}", reference],
		{
			cwd: repositoryRoot,
			name: `${image.key} image user inspection`,
			timeoutMs: timeoutMs.inspect,
		},
	);
	const runtimeUser = user.split(":", 1)[0];
	if (!runtimeUser || runtimeUser === "root" || /^0+$/.test(runtimeUser)) {
		fail(`${image.key} image runtime user must be non-root`);
	}
	runCommand(
		docker,
		[
			"run",
			"--rm",
			"--read-only",
			...(image.runOptions ?? []),
			reference,
			...image.command,
		],
		{
			cwd: repositoryRoot,
			name: `${image.key} read-only runtime probe`,
			timeoutMs: timeoutMs.probe,
		},
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
	if (
		runCommand(git, ["status", "--porcelain", "--untracked-files=all"], {
			cwd: repositoryRoot,
			name: "Git status",
			timeoutMs: timeoutMs.git,
		})
	) {
		fail("image builds require a clean Git worktree");
	}
	const commitSha = runCommand(git, ["rev-parse", "HEAD"], {
		cwd: repositoryRoot,
		name: "Git HEAD",
		timeoutMs: timeoutMs.git,
	});
	if (!/^[a-f0-9]{40}$/.test(commitSha)) fail("Git HEAD is invalid");
	const epoch = runCommand(git, ["show", "-s", "--format=%ct", "HEAD"], {
		cwd: repositoryRoot,
		name: "Git epoch",
		timeoutMs: timeoutMs.git,
	});
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
	const buildIdentity = randomUUID();
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
				buildIdentity,
				git,
			});
		}
		assertCheckout(git, commitSha);
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
