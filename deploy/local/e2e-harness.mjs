#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
	corefileWithForwardZones,
	fingerprint,
	harnessOwner,
	isUsableCa,
	ownerLabel,
	parseDnsForward,
	selectPlatformManifest,
} from "./runtime-material.mjs";
import {
	assertWorkerReadback,
	cachedWorkerDigest,
	componentWorkspacePaths,
	workerInputHash,
} from "./harness-image-cache.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const stateRoot = resolve(
	process.env.PLATFORM_LOCAL_STATE_DIRECTORY ??
		join(
			process.env.XDG_STATE_HOME ??
				join(process.env.HOME ?? tmpdir(), ".local/state"),
			"agent-infra/e2e-harness",
		),
);
const ghcrPrefix =
	process.env.AGENT_INFRA_GHCR_PREFIX ??
	"ghcr.io/agoraio-extensions/agent-infra";
const infrastructureImages = [
	["platformWorker", "platform-worker"],
	["enterpriseDirectorySync", "enterprise-directory-sync"],
	["runtimeHost", "agent-runtime-host"],
	["customBase", "custom-agent-base"],
];

function fail(message) {
	throw new Error(message);
}

function command(file, args, options = {}) {
	return execFileSync(file, args, {
		cwd: options.cwd ?? repositoryRoot,
		env: { ...process.env, ...(options.env ?? {}) },
		encoding: options.encoding ?? "utf8",
		input: options.input,
		stdio: options.stdio ?? [
			options.input === undefined ? "ignore" : "pipe",
			"pipe",
			"pipe",
		],
		timeout: options.timeout ?? 15 * 60_000,
		killSignal: "SIGTERM",
		maxBuffer: 16 * 1024 * 1024,
	});
}

function tryCommand(file, args, options = {}) {
	const result = spawnSync(file, args, {
		cwd: options.cwd ?? repositoryRoot,
		env: { ...process.env, ...(options.env ?? {}) },
		encoding: "utf8",
		stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
		timeout: options.timeout ?? 30_000,
	});
	return result.status === 0 ? result.stdout : null;
}

function git(args, options = {}) {
	return command(process.env.GIT_BIN ?? "git", args, options).trim();
}

function currentUpstream() {
	const branch = git(["branch", "--show-current"]);
	if (!branch) fail("E2E Harness requires a named branch, not detached HEAD");
	const upstream = git([
		"rev-parse",
		"--abbrev-ref",
		"--symbolic-full-name",
		"@{upstream}",
	]);
	const separator = upstream.indexOf("/");
	if (separator < 1 || separator === upstream.length - 1) {
		fail(`Current branch ${branch} has no usable upstream`);
	}
	return {
		branch,
		remote: upstream.slice(0, separator),
		ref: upstream.slice(separator + 1),
		upstream,
	};
}

function trackedChanges() {
	return git(["status", "--porcelain", "--untracked-files=all"])
		.split("\n")
		.filter(Boolean)
		.filter((line) => !line.startsWith("?? "));
}

function syncSource() {
	const upstream = currentUpstream();
	if (trackedChanges().length > 0) {
		fail("Tracked worktree changes must be committed before E2E Harness sync");
	}
	if (process.env.E2E_HARNESS_OFFLINE !== "true") {
		try {
			command(
				process.env.GIT_BIN ?? "git",
				["fetch", upstream.remote, upstream.ref],
				{ timeout: 30_000 },
			);
		} catch {
			fail(`Git fetch timed out or failed for ${upstream.upstream}`);
		}
	}
	const before = git(["rev-parse", "HEAD"]);
	const after = git(["rev-parse", upstream.upstream]);
	if (before !== after) {
		const beforeIsAncestor = tryCommand(process.env.GIT_BIN ?? "git", [
			"merge-base",
			"--is-ancestor",
			before,
			after,
		]);
		if (beforeIsAncestor === null) {
			const upstreamIsAncestor = tryCommand(process.env.GIT_BIN ?? "git", [
				"merge-base",
				"--is-ancestor",
				after,
				before,
			]);
			if (upstreamIsAncestor === null)
				fail(`Current worktree diverged from ${upstream.upstream}`);
		} else {
			command(process.env.GIT_BIN ?? "git", [
				"merge",
				"--ff-only",
				upstream.upstream,
			]);
		}
	}
	const sha = git(["rev-parse", "HEAD"]);
	const remoteTip = git(["rev-parse", upstream.upstream]);
	if (
		sha !== remoteTip &&
		tryCommand(process.env.GIT_BIN ?? "git", [
			"merge-base",
			"--is-ancestor",
			remoteTip,
			sha,
		]) === null
	)
		fail("Worktree is neither at nor ahead of its upstream tip");
	return { ...upstream, sha };
}

const sourcePinPath = join(stateRoot, "source-pin.json");

async function saveSourcePin(source) {
	await mkdir(stateRoot, { recursive: true });
	await writeFile(
		sourcePinPath,
		`${JSON.stringify({ ...source, repositoryRoot }, null, 2)}\n`,
	);
}

async function readSourcePin() {
	let pin;
	try {
		pin = JSON.parse(await readFile(sourcePinPath, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") fail("Source pin is missing; run sync first");
		fail("Source pin is unreadable or invalid");
	}
	if (
		pin.repositoryRoot !== repositoryRoot ||
		!/^[a-f0-9]{40}$/.test(pin.sha ?? "") ||
		!pin.branch ||
		!pin.upstream
	)
		fail("Source pin is invalid or belongs to another worktree");
	if (trackedChanges().length || git(["rev-parse", "HEAD"]) !== pin.sha)
		fail("Source changed after sync; commit changes and sync again");
	return pin;
}

async function resolveSource(action) {
	if (action !== "sync" && action !== "all") return readSourcePin();
	const source = syncSource();
	await saveSourcePin(source);
	return { ...source, repositoryRoot };
}

async function cleanContext(sha) {
	await mkdir(stateRoot, { recursive: true });
	const directory = await mkdtemp(join(stateRoot, "context-"));
	const archive = join(directory, "source.tar");
	const bytes = command(process.env.GIT_BIN ?? "git", [
		"archive",
		"--format=tar",
		`--output=${archive}`,
		sha,
	]);
	void bytes;
	command(process.env.TAR_BIN ?? "tar", ["-xf", archive, "-C", directory]);
	await rm(archive, { force: true });
	return directory;
}

function docker(args, options = {}) {
	const context = process.env.PLATFORM_LOCAL_DOCKER_CONTEXT;
	if (!context) fail("PLATFORM_LOCAL_DOCKER_CONTEXT is required");
	return command(
		process.env.DOCKER_BIN ?? "docker",
		["--context", context, ...args],
		options,
	);
}

function tryDocker(args) {
	const context = process.env.PLATFORM_LOCAL_DOCKER_CONTEXT;
	if (!context) fail("PLATFORM_LOCAL_DOCKER_CONTEXT is required");
	return tryCommand(process.env.DOCKER_BIN ?? "docker", [
		"--context",
		context,
		...args,
	]);
}

function platformScript(action, env = {}) {
	return command(
		"bash",
		[join(repositoryRoot, "deploy/local/platform.sh"), action],
		{ env },
	);
}

function imageTag(repository, sha) {
	return `${repository}:sha-${sha}`;
}

function readImageDigest(reference) {
	const output = tryDocker(["buildx", "imagetools", "inspect", reference]);
	if (!output) return null;
	const match = output.match(/Digest:\s+(sha256:[a-f0-9]{64})/);
	return match?.[1] ?? null;
}

function pullDigest(repository, sha) {
	const tag = imageTag(repository, sha);
	const digest =
		readImageDigest(tag) ?? readImageDigest(`${repository}:${sha}`);
	if (!digest) return null;
	if (!tryDocker(["image", "inspect", `${repository}@${digest}`])) {
		docker(["pull", `${repository}@${digest}`]);
	} else {
		console.log(`Image cache hit ${repository}@${digest}`);
	}
	return { repository, digest };
}

function dockerPlatform() {
	const platform = docker(["info", "--format", "{{.Architecture}}"]).trim();
	return platform === "aarch64"
		? "linux/arm64"
		: platform === "x86_64"
			? "linux/amd64"
			: `linux/${platform}`;
}

async function buildInfrastructureLocally(sha) {
	const worktree = await mkdtemp(join(stateRoot, "image-worktree-"));
	try {
		command(process.env.GIT_BIN ?? "git", [
			"worktree",
			"add",
			"--detach",
			worktree,
			sha,
		]);
		const manifestPath = join(stateRoot, `runtime-images-${sha}.json`);
		const customBaseManifestPath = join(stateRoot, `custom-base-${sha}.json`);
		const normalizedPlatform = dockerPlatform();
		const env = {
			IMAGE_REPOSITORY_PREFIX: ghcrPrefix,
			PLATFORM: normalizedPlatform,
			GIT_BIN: process.env.GIT_BIN ?? "git",
		};
		command(
			process.execPath,
			[
				join(worktree, "deploy/release/build-images.mjs"),
				manifestPath,
				"--images=platformWorker,enterpriseDirectorySync,runtimeHost",
			],
			{
				cwd: worktree,
				env,
				stdio: "inherit",
			},
		);
		command(
			process.execPath,
			[
				join(worktree, "deploy/release/build-images.mjs"),
				customBaseManifestPath,
				"--custom-base-image",
			],
			{ cwd: worktree, env, stdio: "inherit" },
		);
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		const customBase = JSON.parse(
			await readFile(customBaseManifestPath, "utf8"),
		);
		return { ...manifest.images, customBase: customBase.images.customBase };
	} finally {
		tryCommand(process.env.GIT_BIN ?? "git", [
			"worktree",
			"remove",
			"--force",
			worktree,
		]);
		await rm(worktree, { recursive: true, force: true });
	}
}

async function resolveInfrastructureImages(source) {
	const images = {};
	for (const [key, name] of infrastructureImages) {
		const resolved = pullDigest(`${ghcrPrefix}/${name}`, source.sha);
		if (resolved) images[key] = resolved;
	}
	if (
		images.runtimeHost === undefined ||
		infrastructureImages.some(([key]) => !images[key])
	) {
		const context = await cleanContext(source.sha);
		try {
			Object.assign(images, await buildInfrastructureLocally(source.sha));
		} finally {
			await rm(context, { recursive: true, force: true });
		}
	}
	const missing = infrastructureImages
		.filter(([key]) => !images[key])
		.map(([key]) => key);
	if (missing.length)
		fail(`Infrastructure image resolution failed: ${missing.join(", ")}`);
	const manifest = { schemaVersion: 1, sourceRevision: source.sha, images };
	await mkdir(stateRoot, { recursive: true });
	const path = join(stateRoot, `infrastructure-${source.sha}.json`);
	await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, {
		flag: "w",
	});
	return { path, manifest };
}

function applyRuntimeBinding(manifest) {
	const binding = manifest?.images?.runtimeHost;
	if (!binding?.repository || !binding?.digest) {
		fail("Infrastructure manifest has no Runtime Host binding");
	}
	// Admission accepts only an OCI image manifest; local kind is one platform.
	const raw = tryDocker([
		"buildx",
		"imagetools",
		"inspect",
		"--raw",
		`${binding.repository}@${binding.digest}`,
	]);
	let digest = binding.digest;
	if (raw) {
		try {
			digest =
				selectPlatformManifest(JSON.parse(raw), dockerPlatform()) ?? digest;
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error));
		}
	} else {
		console.log(
			"Runtime binding was not re-read; Worker admission remains the gate",
		);
	}
	process.env.AGENT_INFRA_RUNTIME_IMAGE_REPOSITORY = binding.repository;
	process.env.AGENT_INFRA_RUNTIME_IMAGE_DIGEST = digest;
}

async function readInfrastructureManifest(source) {
	try {
		return JSON.parse(
			await readFile(
				join(stateRoot, `infrastructure-${source.sha}.json`),
				"utf8",
			),
		);
	} catch {
		fail(
			`Infrastructure manifest is missing for ${source.sha}; run images first`,
		);
	}
}

async function readCache(path, fallback) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return fallback;
		fail(`Image cache is unreadable or invalid: ${basename(path)}`);
	}
}

function targetProfile() {
	return fingerprint([
		process.env.PLATFORM_LOCAL_DOCKER_CONTEXT ?? "",
		process.env.PLATFORM_LOCAL_KUBE_CONTEXT ?? "",
		process.env.PLATFORM_LOCAL_PROJECT ?? "",
		process.env.PLATFORM_LOCAL_NAMESPACE ?? "",
	]);
}

function workspaceInputs(source, service) {
	const manifests = git([
		"ls-tree",
		"-r",
		"--name-only",
		source.sha,
		"apps",
		"packages",
	])
		.split("\n")
		.filter((path) => /^(apps|packages)\/[^/]+\/package\.json$/.test(path));
	const workspaces = manifests.map((path) => ({
		path: path.slice(0, -"/package.json".length),
		manifest: JSON.parse(git(["show", `${source.sha}:${path}`])),
	}));
	const paths = componentWorkspacePaths(workspaces, `apps/${service}`);
	// Shared build policy and lockfile remain conservative invalidators.
	const shared = git(["ls-tree", "--name-only", source.sha])
		.split("\n")
		.filter((path) =>
			/^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig[^/]*\.json|\.npmrc|\.dockerignore)$/.test(
				path,
			),
		);
	return [...paths, ...shared].map((path) => ({
		path,
		content: git(["rev-parse", `${source.sha}:${path}`]),
	}));
}

async function overlayInputs(directory, prefix = "") {
	let entries;
	try {
		entries = await readdir(join(directory, prefix), { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT" && !prefix) return [];
		throw error;
	}
	const inputs = [];
	for (const entry of entries) {
		const path = join(prefix, entry.name);
		if (entry.isSymbolicLink())
			fail("Deployment overlay must not contain symlinks");
		if (entry.isDirectory())
			inputs.push(...(await overlayInputs(directory, path)));
		else if (entry.isFile())
			inputs.push({
				path: `overlay/${path}`,
				content: await readFile(join(directory, path)),
			});
		else fail("Deployment overlay contains an unsupported file");
	}
	return inputs;
}

async function componentInputForSource(source, service, platform) {
	const overlayDirectory =
		service === "platform-api"
			? join(stateRoot, "api-overlay")
			: service === "platform-worker"
				? join(stateRoot, "worker-overlay")
				: null;
	const overlays = overlayDirectory
		? await overlayInputs(overlayDirectory)
		: [];
	const buildArgs =
		service === "web"
			? [
					"VITE_PLATFORM_LOGIN_URL=/auth/login",
					"VITE_PLATFORM_LOGOUT_URL=/auth/logout",
				]
			: [];
	return {
		inputHash: workerInputHash([
			...workspaceInputs(source, service),
			...overlays,
			{ path: "target-platform", content: platform },
			{ path: "build-args", content: JSON.stringify(buildArgs) },
		]),
		overlayDirectory: overlays.length ? overlayDirectory : null,
		buildArgs,
	};
}

function inspectLocalImage(reference) {
	const raw = tryDocker(["image", "inspect", reference]);
	if (!raw) return null;
	const image = JSON.parse(raw)?.[0];
	if (!/^sha256:[a-f0-9]{64}$/.test(image?.Id))
		fail("Local image has no immutable image ID");
	return image;
}

async function buildPlatformImages(source) {
	const platform = dockerPlatform();
	const profile = targetProfile();
	const cachePath = join(stateRoot, "component-image-cache.json");
	const cache = await readCache(cachePath, {
		schemaVersion: 1,
		components: {},
	});
	if (cache.schemaVersion !== 1 || !cache.components)
		fail("Component image cache schema is invalid");
	let context;
	let workerBinding;
	try {
		for (const service of [
			"web",
			"platform-api",
			"platform-worker",
			"enterprise-directory-sync",
		]) {
			const input = await componentInputForSource(source, service, platform);
			const key = `${service}:${input.inputHash}`;
			const tag = `agent-infra-e2e-${service}:${input.inputHash}`;
			const alias = `agent-infra-e2e-${service}`;
			const previous = cache.components[key];
			let image = inspectLocalImage(tag);
			if (previous && image && image.Id !== previous.imageId)
				fail(`Component cache image changed: ${service}`);
			if (!previous || !image) {
				context ??= await cleanContext(source.sha);
				docker(
					[
						"build",
						"--platform",
						platform,
						...input.buildArgs.flatMap((arg) => ["--build-arg", arg]),
						"--file",
						join(context, `apps/${service}/Dockerfile`),
						"--tag",
						alias,
						context,
					],
					{ stdio: "inherit" },
				);
				if (input.overlayDirectory) {
					docker(
						[
							"build",
							"--platform",
							platform,
							"--file",
							join(input.overlayDirectory, "Dockerfile"),
							"--tag",
							alias,
							input.overlayDirectory,
						],
						{ stdio: "inherit" },
					);
				}
				image = inspectLocalImage(alias);
				if (!image) fail(`Built image is unavailable: ${service}`);
				if (previous && previous.imageId !== image.Id)
					fail(
						`Component image is not reproducible for input ${input.inputHash}`,
					);
				docker(["tag", image.Id, tag]);
			} else {
				console.log(`Component image cache hit service=${service}`);
				docker(["tag", image.Id, alias]);
			}
			cache.components[key] = {
				inputHash: input.inputHash,
				imageId: image.Id,
				tag,
				buildSourceSha: previous?.buildSourceSha ?? source.sha,
				platform,
			};
			await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, {
				mode: 0o600,
			});
			if (service === "platform-worker")
				workerBinding = await resolveWorkerBinding(
					image,
					cache.components[key],
					profile,
				);
		}
		await writeWorkerValuesOverlay(source, workerBinding, profile);
	} finally {
		if (context) await rm(context, { recursive: true, force: true });
	}
}

async function readWorkerValues() {
	const path = requiredAbsoluteEnv("PLATFORM_LOCAL_WORKER_VALUES");
	const { parse } = await import("yaml");
	const values = parse(await readFile(path, "utf8"));
	const repository = values?.images?.platformWorker?.repository;
	if (
		typeof repository !== "string" ||
		!/^[a-z0-9][a-z0-9._:/-]*$/.test(repository) ||
		repository.includes("@")
	)
		fail("Worker values must name an image repository");
	return { repository };
}

async function resolveWorkerBinding(image, component, profile) {
	const { repository } = await readWorkerValues();
	const expectedPrefix = `${repository}@`;
	const existing = (image.RepoDigests ?? []).find((value) =>
		value.startsWith(expectedPrefix),
	);
	let digest = existing?.slice(expectedPrefix.length);
	if (!digest) {
		// Publishing is restricted to a separately declared local-registry destination.
		if (process.env.E2E_HARNESS_LOCAL_WORKER_REPOSITORY !== repository)
			fail(
				"Worker image needs a digest; declare E2E_HARNESS_LOCAL_WORKER_REPOSITORY before publishing to the local registry",
			);
		const tag = `${repository}:e2e-${component.inputHash}`;
		docker(["tag", component.imageId, tag]);
		docker(["push", tag], { stdio: "inherit" });
		digest = readImageDigest(tag);
	}
	if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? ""))
		fail("Worker image has no immutable registry digest");
	const raw = tryDocker([
		"buildx",
		"imagetools",
		"inspect",
		"--raw",
		`${repository}@${digest}`,
	]);
	if (!raw) fail("Worker image digest cannot be read back from its registry");
	const manifest = JSON.parse(raw);
	if (
		manifest.mediaType !== "application/vnd.oci.image.manifest.v1+json" &&
		manifest.mediaType !==
			"application/vnd.docker.distribution.manifest.v2+json"
	)
		fail("Worker binding must use a single-platform manifest");
	if (manifest.config?.digest !== component.imageId)
		fail("Worker registry manifest does not match the built image");
	const cachePath = join(stateRoot, "worker-image-cache.json");
	const cache = await readCache(cachePath, { schemaVersion: 1, worker: {} });
	const key = `${profile}:${repository}:${component.inputHash}`;
	const previous = cachedWorkerDigest(cache, key);
	if (previous && previous.digest !== digest)
		fail("Worker digest changed for identical build inputs");
	const binding = {
		repository,
		digest,
		inputHash: component.inputHash,
		imageId: component.imageId,
		buildSourceSha: component.buildSourceSha,
		platform: component.platform,
	};
	cache.worker[key] = binding;
	await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, {
		mode: 0o600,
	});
	return binding;
}

async function writeWorkerValuesOverlay(source, binding, profile) {
	const path = join(stateRoot, `worker-values-${source.sha}.yaml`);
	const overlay = `images:\n  platformWorker:\n    repository: ${JSON.stringify(binding.repository)}\n    digest: ${JSON.stringify(binding.digest)}\n`;
	await writeFile(path, overlay, { mode: 0o600 });
	await chmod(path, 0o600);
	await writeFile(
		join(stateRoot, `platform-images-${source.sha}.json`),
		`${JSON.stringify({ schemaVersion: 1, sourceSha: source.sha, profile, worker: binding }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	process.env.PLATFORM_LOCAL_WORKER_VALUES_OVERLAY = path;
}

async function applyWorkerBinding(source) {
	const manifest = JSON.parse(
		await readFile(
			join(stateRoot, `platform-images-${source.sha}.json`),
			"utf8",
		),
	);
	const platform = dockerPlatform();
	const input = await componentInputForSource(
		source,
		"platform-worker",
		platform,
	);
	const { repository } = await readWorkerValues();
	const binding = manifest.worker;
	if (
		manifest.schemaVersion !== 1 ||
		manifest.sourceSha !== source.sha ||
		manifest.profile !== targetProfile() ||
		binding?.inputHash !== input.inputHash ||
		binding.platform !== platform ||
		binding.repository !== repository ||
		!/^sha256:[a-f0-9]{64}$/.test(binding.digest)
	)
		fail("Worker binding does not match source, inputs or target profile");
	await writeWorkerValuesOverlay(source, binding, targetProfile());
	return binding;
}

function requiredAbsoluteEnv(name) {
	const value = process.env[name];
	if (!value || !isAbsolute(value)) fail(`${name} must be an absolute path`);
	return value;
}

function kubectl(args, options = {}) {
	return command(
		process.env.KUBECTL_BIN ?? "kubectl",
		[
			"--kubeconfig",
			requiredAbsoluteEnv("PLATFORM_LOCAL_KUBECONFIG"),
			"--context",
			process.env.PLATFORM_LOCAL_KUBE_CONTEXT,
			...args,
		],
		options,
	);
}

function readKubeObject(kind, name, namespace) {
	const output = kubectl([
		"--namespace",
		namespace,
		"get",
		kind,
		name,
		"--ignore-not-found",
		"--output",
		"json",
	]).trim();
	return output ? JSON.parse(output) : null;
}

function verifyWorkerImageBinding(binding) {
	const selector = `app.kubernetes.io/instance=${process.env.PLATFORM_LOCAL_PROJECT},app.kubernetes.io/component=platform-worker`;
	const read = (kind) =>
		JSON.parse(
			kubectl([
				"--namespace",
				process.env.PLATFORM_LOCAL_NAMESPACE,
				"get",
				kind,
				"--selector",
				selector,
				"--output",
				"json",
			]),
		).items ?? [];
	assertWorkerReadback(binding, read("deployment"), read("pods"));
	console.log(`Worker image readback ${binding.repository}@${binding.digest}`);
}

const isHarnessOwned = (object) =>
	object?.metadata?.labels?.[ownerLabel] === harnessOwner;

/** Writes a Secret only when it is absent or already owned by this Harness. */
function applyOwnedSecret(namespace, name, type, data, existing) {
	if (existing && !isHarnessOwned(existing))
		fail(`Secret ${namespace}/${name} exists without Harness ownership`);
	const encoded = Object.fromEntries(
		Object.entries(data).map(([key, value]) => [
			key,
			Buffer.from(value).toString("base64"),
		]),
	);
	if (
		existing?.type === type &&
		JSON.stringify(existing.data ?? {}) ===
			JSON.stringify(Object.fromEntries(Object.entries(encoded).sort()))
	)
		return;
	kubectl(["apply", "--filename", "-"], {
		input: JSON.stringify({
			apiVersion: "v1",
			kind: "Secret",
			type,
			metadata: { name, namespace, labels: { [ownerLabel]: harnessOwner } },
			data: Object.fromEntries(Object.entries(encoded).sort()),
		}),
	});
}

const decodeSecret = (secret, key) =>
	secret?.data?.[key] === undefined
		? undefined
		: Buffer.from(secret.data[key], "base64").toString("utf8");

/** Adds private forward zones to the fixed cluster's CoreDNS, then restarts it. */
function ensureClusterDns() {
	const zones = parseDnsForward(process.env.E2E_CLUSTER_DNS_FORWARD);
	const config = readKubeObject("configmap", "coredns", "kube-system");
	const current = config?.data?.Corefile;
	if (typeof current !== "string") fail("Fixed cluster CoreDNS is unavailable");
	const next = corefileWithForwardZones(current, zones);
	if (next === current) return;
	kubectl(["--namespace", "kube-system", "apply", "--filename", "-"], {
		input: JSON.stringify({
			apiVersion: "v1",
			kind: "ConfigMap",
			metadata: { name: "coredns", namespace: "kube-system" },
			data: { ...config.data, Corefile: next },
		}),
	});
	kubectl([
		"--namespace",
		"kube-system",
		"rollout",
		"restart",
		"deployment/coredns",
	]);
	kubectl([
		"--namespace",
		"kube-system",
		"rollout",
		"status",
		"deployment/coredns",
		"--timeout=2m",
	]);
	console.log(`E2E cluster DNS forward zones=${zones.length}`);
}

async function trustedCaBundle() {
	const files = (process.env.E2E_WORKER_TRUSTED_CA_FILES ?? "")
		.split(":")
		.filter(Boolean);
	const parts = [];
	for (const file of files) {
		if (!isAbsolute(file)) fail("E2E_WORKER_TRUSTED_CA_FILES must list absolute paths");
		const pem = await readFile(file, "utf8");
		if (!isUsableCa(pem, { minRemainingMs: 0 }))
			fail(`Worker trusted CA file is not a valid CA bundle: ${file}`);
		parts.push(pem.trim());
	}
	if (!parts.length) fail("E2E_WORKER_TRUSTED_CA_FILES must list at least one CA");
	return `${parts.join("\n")}\n`;
}

/**
 * Worker -> Runtime is in-cluster plaintext (ADR-0020): the deployment delivers
 * the Worker trust set (directory, Registry), private adapter inputs and the
 * Host transport token. Worker loads them once, so changes restart it.
 */
async function provisionRuntimeMaterial() {
	const { parse } = await import("yaml");
	const namespace = process.env.PLATFORM_LOCAL_NAMESPACE;
	const values = parse(
		await readFile(requiredAbsoluteEnv("PLATFORM_LOCAL_WORKER_VALUES"), "utf8"),
	);
	const worker = values?.platformWorker ?? {};
	const moduleRef = worker.configurationModuleSecretRef;
	const authRef = worker.runtimeAuthSecretRef;
	const caRef = worker.trustedCaSecretRef;
	if (
		!moduleRef?.name ||
		!moduleRef?.key ||
		!authRef?.name ||
		!authRef?.serviceTokenKey ||
		!caRef?.name ||
		!caRef?.key
	)
		fail(
			"Worker values must name configuration, runtime-auth and trusted CA Secrets",
		);

	ensureClusterDns();

	const bundle = await trustedCaBundle();
	applyOwnedSecret(
		namespace,
		caRef.name,
		"Opaque",
		{ [caRef.key]: bundle },
		readKubeObject("secret", caRef.name, namespace),
	);

	const configurationPath = requiredAbsoluteEnv(
		"PLATFORM_LOCAL_WORKER_CONFIGURATION",
	);
	try {
		command(process.execPath, ["--check", configurationPath]);
	} catch {
		fail("Worker configuration.mjs has invalid syntax");
	}
	const configuration = await readFile(configurationPath, "utf8");
	// Private read-only adapter inputs (for example directory identity bindings)
	// travel in the same reviewed module Secret; values never enter Git or argv.
	const deploymentFiles = {};
	for (const file of (process.env.E2E_WORKER_DEPLOYMENT_FILES ?? "")
		.split(":")
		.filter(Boolean)) {
		if (!isAbsolute(file))
			fail("E2E_WORKER_DEPLOYMENT_FILES must list absolute paths");
		const key = basename(file);
		if (
			!/^[-._a-zA-Z0-9]{1,253}$/.test(key) ||
			key === moduleRef.key ||
			key in deploymentFiles
		)
			fail(`Worker deployment file name is not a unique Secret key: ${key}`);
		deploymentFiles[key] = await readFile(file, "utf8");
	}
	applyOwnedSecret(
		namespace,
		moduleRef.name,
		"Opaque",
		{ ...deploymentFiles, [moduleRef.key]: configuration },
		readKubeObject("secret", moduleRef.name, namespace),
	);

	const auth = readKubeObject("secret", authRef.name, namespace);
	const token = decodeSecret(auth, authRef.serviceTokenKey);
	if (!token?.trim()) fail("Worker runtime-auth service token is unavailable");
	const transport =
		process.env.E2E_RUNTIME_TRANSPORT_SECRET ?? "platform-runtime-transport";
	applyOwnedSecret(
		namespace,
		transport,
		"Opaque",
		{ token },
		readKubeObject("secret", transport, namespace),
	);

	const deployment = kubectl([
		"--namespace",
		namespace,
		"get",
		"deployment",
		"--selector",
		`app.kubernetes.io/instance=${process.env.PLATFORM_LOCAL_PROJECT},app.kubernetes.io/component=platform-worker`,
		"--output",
		"jsonpath={.items[*].metadata.name}",
	]).trim();
	if (!deployment) return;
	if (deployment.includes(" ")) fail("Fixed Worker Deployment is ambiguous");
	const annotation = "agent-infra.agora.io/e2e-runtime-material";
	const material = fingerprint([
		configuration,
		bundle,
		...Object.entries(deploymentFiles).flat(),
	]);
	const live = readKubeObject("deployment", deployment, namespace)?.spec
		?.template?.metadata?.annotations?.[annotation];
	if (live === material) return;
	kubectl([
		"--namespace",
		namespace,
		"patch",
		"deployment",
		deployment,
		"--type",
		"merge",
		"--patch",
		JSON.stringify({
			spec: {
				template: { metadata: { annotations: { [annotation]: material } } },
			},
		}),
	]);
	kubectl([
		"--namespace",
		namespace,
		"rollout",
		"status",
		`deployment/${deployment}`,
		"--timeout=5m",
	]);
	console.log("E2E Worker restarted with current Runtime material");
}

function assertFixedEnvironment() {
	const expected = {
		PLATFORM_LOCAL_PROJECT: "agent-infra-e2e",
		PLATFORM_LOCAL_NAMESPACE: "agent-infra-e2e",
		PLATFORM_LOCAL_KUBE_CONTEXT: "kind-agent-infra-e2e",
	};
	for (const [name, value] of Object.entries(expected)) {
		if (process.env[name] !== value) fail(`${name} must be ${value}`);
	}
}

async function acquireLock() {
	await mkdir(stateRoot, { recursive: true });
	const lock = join(stateRoot, "run.lock");
	try {
		await mkdir(lock);
		await writeFile(join(lock, "pid"), `${process.pid}\n`, { flag: "wx" });
	} catch {
		fail(`Another E2E Harness run owns ${lock}`);
	}
	return async () => rm(lock, { recursive: true, force: true });
}

function assertAppLane() {
	const lane = process.env.E2E_HARNESS_LANE ?? "full";
	if (lane !== "full")
		fail(
			"APP_LANE_UNAVAILABLE: shared-state isolation is not implemented; use the full Harness",
		);
}

async function requireRealLoginValidation() {
	fail(
		"REAL_LOGIN_VALIDATION_REQUIRED: existing local-browser tests use controlled identities; run the deployment identity login and authorized API validation separately",
	);
}

function usage() {
	console.log(
		"Usage: node deploy/local/e2e-harness.mjs <sync|images|build|deploy|runtime|verify|all|reset>",
	);
}

async function main() {
	const action = process.argv[2] ?? "all";
	if (action === "help" || action === "--help") {
		usage();
		return;
	}
	if (
		![
			"sync",
			"images",
			"build",
			"deploy",
			"runtime",
			"verify",
			"all",
			"reset",
		].includes(action)
	) {
		usage();
		process.exitCode = 2;
		return;
	}
	assertAppLane();
	if (action === "reset" || action === "runtime") {
		assertFixedEnvironment();
		const release = await acquireLock();
		try {
			if (action === "runtime") await provisionRuntimeMaterial();
			else
				platformScript("reset", {
					PLATFORM_LOCAL_PROJECT: process.env.PLATFORM_LOCAL_PROJECT,
				});
		} finally {
			await release();
		}
		return;
	}
	if (action !== "sync") assertFixedEnvironment();
	const release = await acquireLock();
	try {
		const source = await resolveSource(action);
		console.log(`E2E sourceRevision=${source.sha} upstream=${source.upstream}`);
		if (action === "sync") return;
		if (["images", "all"].includes(action)) {
			const result = await resolveInfrastructureImages(source);
			applyRuntimeBinding(result.manifest);
		} else if (["deploy", "verify"].includes(action)) {
			applyRuntimeBinding(await readInfrastructureManifest(source));
		}
		if (["build", "all"].includes(action)) await buildPlatformImages(source);
		const workerBinding = ["deploy", "verify", "all"].includes(action)
			? await applyWorkerBinding(source)
			: null;
		if (["deploy", "all"].includes(action)) {
			platformScript("data");
			platformScript("migrate");
			// Referenced Secrets must exist before Helm validates Worker material.
			await provisionRuntimeMaterial();
			platformScript("up");
			verifyWorkerImageBinding(workerBinding);
		}
		if (["verify", "all"].includes(action)) {
			process.stdout.write(platformScript("status"));
			if (workerBinding) verifyWorkerImageBinding(workerBinding);
			await requireRealLoginValidation();
		}
	} finally {
		await release();
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
