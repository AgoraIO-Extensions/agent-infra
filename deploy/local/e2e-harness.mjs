#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import dns from "node:dns/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
		stdio:
			options.stdio ??
			[options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		timeout: options.timeout,
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
	docker(["pull", `${repository}@${digest}`]);
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
			digest = selectPlatformManifest(JSON.parse(raw), dockerPlatform()) ?? digest;
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error));
		}
	} else {
		console.log("Runtime binding was not re-read; Worker admission remains the gate");
	}
	process.env.AGENT_INFRA_RUNTIME_IMAGE_REPOSITORY = binding.repository;
	process.env.AGENT_INFRA_RUNTIME_IMAGE_DIGEST = digest;
}

async function readInfrastructureManifest(source) {
	try {
		return JSON.parse(
			await readFile(join(stateRoot, `infrastructure-${source.sha}.json`), "utf8"),
		);
	} catch {
		fail(`Infrastructure manifest is missing for ${source.sha}; run images first`);
	}
}

async function buildPlatformImages(source) {
	const context = await cleanContext(source.sha);
	const buildHosts = [
		"registry.npmjs.org",
		"dl-cdn.alpinelinux.org",
		"github.com",
		"raw.githubusercontent.com",
		"objects.githubusercontent.com",
		"release-assets.githubusercontent.com",
	];
	const resolvedHosts = await Promise.all(
		buildHosts.map(async (host) => [host, (await dns.lookup(host)).address]),
	);
	const proxy = process.env.E2E_HARNESS_BUILD_PROXY ?? "http://host.lima.internal:7892";
	try {
		for (const [service, dockerfile] of [
			["web", "apps/web/Dockerfile"],
			["platform-api", "apps/platform-api/Dockerfile"],
			["platform-worker", "apps/platform-worker/Dockerfile"],
			["connection-api", "apps/connection-api/Dockerfile"],
			["enterprise-directory-sync", "apps/enterprise-directory-sync/Dockerfile"],
		]) {
			const args = [
				"build",
				"--network",
				"host",
				"--build-arg",
				`SOURCE_COMMIT=${source.sha}`,
				...(service === "web"
					? [
							"--build-arg",
							"VITE_PLATFORM_LOGIN_URL=/auth/login",
							"--build-arg",
							"VITE_PLATFORM_LOGOUT_URL=/auth/logout",
						]
					: []),
				...[
					"HTTP_PROXY",
					"HTTPS_PROXY",
					"ALL_PROXY",
					"http_proxy",
					"https_proxy",
					"all_proxy",
				].flatMap((name) => ["--build-arg", `${name}=${proxy}`]),
				"--add-host",
				"host.lima.internal:host-gateway",
				...resolvedHosts.flatMap(([host, address]) => [
					"--add-host",
					`${host}:${address}`,
				]),
				"--file",
				join(context, dockerfile),
				"--tag",
				`agent-infra-e2e-${service}`,
				context,
			];
			docker(args, { stdio: "inherit" });
		}
		await buildPrivateDeploymentOverlays();
	} finally {
		await rm(context, { recursive: true, force: true });
	}
}

async function buildPrivateDeploymentOverlays() {
	const overlays = [
		["agent-infra-e2e-platform-api", join(stateRoot, "api-overlay")],
		["agent-infra-e2e-platform-worker", join(stateRoot, "worker-overlay")],
	];
	for (const [tag, directory] of overlays) {
		try {
			await readFile(join(directory, "Dockerfile"));
		} catch {
			continue;
		}
		docker(
			[
				"build",
				"--network",
				"host",
				"--file",
				join(directory, "Dockerfile"),
				"--tag",
				tag,
				directory,
			],
			{ stdio: "inherit" },
		);
	}
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
	kubectl(["--namespace", "kube-system", "rollout", "restart", "deployment/coredns"]);
	kubectl(["--namespace", "kube-system", "rollout", "status", "deployment/coredns", "--timeout=2m"]);
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
	if (!moduleRef?.name || !moduleRef?.key || !authRef?.name || !authRef?.serviceTokenKey || !caRef?.name || !caRef?.key)
		fail("Worker values must name configuration, runtime-auth and trusted CA Secrets");

	ensureClusterDns();

	const bundle = await trustedCaBundle();
	applyOwnedSecret(namespace, caRef.name, "Opaque", { [caRef.key]: bundle }, readKubeObject("secret", caRef.name, namespace));

	const configuration = await readFile(requiredAbsoluteEnv("PLATFORM_LOCAL_WORKER_CONFIGURATION"), "utf8");
	// Private read-only adapter inputs (for example directory identity bindings)
	// travel in the same reviewed module Secret; values never enter Git or argv.
	const deploymentFiles = {};
	for (const file of (process.env.E2E_WORKER_DEPLOYMENT_FILES ?? "").split(":").filter(Boolean)) {
		if (!isAbsolute(file)) fail("E2E_WORKER_DEPLOYMENT_FILES must list absolute paths");
		const key = basename(file);
		if (!/^[-._a-zA-Z0-9]{1,253}$/.test(key) || key === moduleRef.key || key in deploymentFiles)
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
	const transport = process.env.E2E_RUNTIME_TRANSPORT_SECRET ?? "platform-runtime-transport";
	applyOwnedSecret(namespace, transport, "Opaque", { token }, readKubeObject("secret", transport, namespace));

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
	const material = fingerprint([configuration, bundle, ...Object.entries(deploymentFiles).flat()]);
	const live = readKubeObject("deployment", deployment, namespace)?.spec?.template?.metadata?.annotations?.[annotation];
	if (live === material) return;
	kubectl(["--namespace", namespace, "patch", "deployment", deployment, "--type", "merge", "--patch", JSON.stringify({ spec: { template: { metadata: { annotations: { [annotation]: material } } } } })]);
	kubectl(["--namespace", namespace, "rollout", "status", `deployment/${deployment}`, "--timeout=5m"]);
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
	const release = action === "sync" ? async () => {} : await acquireLock();
	try {
		const source = syncSource();
		console.log(`E2E sourceRevision=${source.sha} upstream=${source.upstream}`);
		if (action === "sync") return;
		if (["images", "all"].includes(action)) {
			const result = await resolveInfrastructureImages(source);
			applyRuntimeBinding(result.manifest);
		} else if (["deploy", "verify"].includes(action)) {
			applyRuntimeBinding(await readInfrastructureManifest(source));
		}
		if (["build", "all"].includes(action)) await buildPlatformImages(source);
		if (["deploy", "all"].includes(action)) {
			platformScript("data");
			platformScript("migrate");
			// Referenced Secrets must exist before Helm validates Worker material.
			await provisionRuntimeMaterial();
			platformScript("up");
		}
		if (["verify", "all"].includes(action)) platformScript("status");
	} finally {
		await release();
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
