import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
	cachedWorkerDigest,
	workerInputHash,
} from "../deploy/local/harness-image-cache.mjs";
import {
	corefileWithForwardZones,
	isUsableCa,
	parseDnsForward,
	selectPlatformManifest,
} from "../deploy/local/runtime-material.mjs";

const execFileAsync = promisify(execFile);
const digest = (character) => `sha256:${character.repeat(64)}`;

test("Worker input hash ignores entry order and changes when an input changes", () => {
	const first = workerInputHash([
		{ path: "apps/platform-worker/Dockerfile", content: "worker" },
		{ path: "pnpm-lock.yaml", content: "lock" },
	]);
	assert.equal(
		first,
		workerInputHash([
			{ path: "pnpm-lock.yaml", content: "lock" },
			{ path: "apps/platform-worker/Dockerfile", content: "worker" },
		]),
	);
	assert.notEqual(
		first,
		workerInputHash([
			{ path: "apps/platform-worker/Dockerfile", content: "worker-v2" },
			{ path: "pnpm-lock.yaml", content: "lock" },
		]),
	);
});

test("Worker cache accepts only a valid immutable digest for the input hash", () => {
	const inputHash = "abc";
	const entry = { repository: "registry.example/worker", digest: digest("a") };
	assert.deepEqual(
		cachedWorkerDigest({ worker: { [inputHash]: entry } }, inputHash),
		entry,
	);
	assert.equal(
		cachedWorkerDigest(
			{ worker: { [inputHash]: { ...entry, digest: "latest" } } },
			inputHash,
		),
		null,
	);
});

test("local E2E Harness exposes the staged lifecycle without environment access", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "harness-help-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const { stdout } = await execFileAsync(
		process.execPath,
		["deploy/local/e2e-harness.mjs", "help"],
		{
			env: {
				...process.env,
				PLATFORM_LOCAL_STATE_DIRECTORY: join(directory, "state"),
				XDG_STATE_HOME: join(directory, "xdg"),
			},
		},
	);
	assert.match(
		stdout,
		/sync\|images\|build\|deploy\|runtime\|verify\|all\|reset/,
	);
});

test("cluster DNS forward block is marked, replaceable and removable", () => {
	const base = ".:53 {\n    forward . /etc/resolv.conf\n}\n";
	const zones = parseDnsForward("example.com=192.0.2.1,198.51.100.1");
	const once = corefileWithForwardZones(base, zones);
	assert.match(
		once,
		/example\.com:53 \{[\s\S]*forward \. 192\.0\.2\.1 198\.51\.100\.1/,
	);
	assert.equal(corefileWithForwardZones(once, zones), once);
	assert.equal(corefileWithForwardZones(once, []), base);
	assert.throws(() => parseDnsForward("example.com=not an ip"));
	assert.deepEqual(parseDnsForward(""), []);
});

test("Runtime binding resolves only one current-platform image manifest", () => {
	const manifest = (architecture, value) => ({
		mediaType: "application/vnd.oci.image.manifest.v1+json",
		digest: value,
		platform: {
			os: architecture ? "linux" : "unknown",
			architecture: architecture ?? "unknown",
		},
	});
	const index = {
		mediaType: "application/vnd.oci.image.index.v1+json",
		manifests: [
			manifest("arm64", digest("a")),
			manifest(undefined, digest("b")),
		],
	};
	assert.equal(selectPlatformManifest(index, "linux/arm64"), digest("a"));
	assert.throws(() => selectPlatformManifest(index, "linux/amd64"));
	assert.throws(() =>
		selectPlatformManifest(
			{
				...index,
				manifests: [
					manifest("arm64", digest("a")),
					manifest("arm64", digest("c")),
				],
			},
			"linux/arm64",
		),
	);
	assert.equal(
		selectPlatformManifest(
			{ mediaType: "application/vnd.oci.image.manifest.v1+json" },
			"linux/arm64",
		),
		null,
	);
});

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

test("Worker trusted CA bundle accepts only CA certificates", {
	skip: !hasOpenssl,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "worker-trust-test-"));
	// An explicit config keeps the extensions identical across OpenSSL versions.
	const issue = async (name, ca) => {
		await writeFile(
			join(directory, `${name}.cnf`),
			`[req]\ndistinguished_name = dn\nprompt = no\nx509_extensions = v3\n[dn]\nCN = fixture-${name}\n[v3]\nbasicConstraints = critical, CA:${ca ? "TRUE" : "FALSE"}\n`,
		);
		const result = spawnSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"60",
				"-config",
				`${name}.cnf`,
				"-keyout",
				`${name}.key`,
				"-out",
				`${name}.crt`,
			],
			{ cwd: directory, stdio: "ignore" },
		);
		assert.equal(result.status, 0);
		return readFile(join(directory, `${name}.crt`), "utf8");
	};
	try {
		const ca = await issue("ca", true);
		const leaf = await issue("leaf", false);
		assert.equal(isUsableCa(ca), true);
		assert.equal(isUsableCa(`${ca}\n${ca}`), true);
		assert.equal(isUsableCa(leaf), false);
		assert.equal(isUsableCa(`${ca}\n${leaf}`), false);
		assert.equal(
			isUsableCa(ca, { minRemainingMs: 365 * 24 * 60 * 60 * 1000 }),
			false,
		);
		assert.equal(isUsableCa("not a certificate"), false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("component inputs include transitive workspace dependencies, not unrelated apps", async () => {
	const { componentWorkspacePaths } = await import(
		"../deploy/local/harness-image-cache.mjs"
	);
	const workspaces = [
		{
			path: "apps/platform-worker",
			manifest: { name: "worker", dependencies: { core: "workspace:*" } },
		},
		{
			path: "packages/core",
			manifest: { name: "core", devDependencies: { config: "workspace:*" } },
		},
		{ path: "packages/config", manifest: { name: "config" } },
		{ path: "apps/web", manifest: { name: "web" } },
		{ path: "packages/unused", manifest: { name: "unused" } },
	];
	assert.deepEqual(
		componentWorkspacePaths(workspaces, "apps/platform-worker"),
		["apps/platform-worker", "packages/config", "packages/core"],
	);
	assert.throws(
		() =>
			componentWorkspacePaths(workspaces.slice(0, 2), "apps/platform-worker"),
		/workspace dependency/,
	);
});

test("Worker readback rejects old, missing and non-ready Worker containers", async () => {
	const { assertWorkerReadback } = await import(
		"../deploy/local/harness-image-cache.mjs"
	);
	const binding = {
		repository: "registry.example/worker",
		digest: digest("a"),
	};
	const deployment = {
		spec: {
			replicas: 1,
			template: {
				spec: {
					containers: [
						{
							name: "platform-worker",
							image: `${binding.repository}@${binding.digest}`,
						},
					],
				},
			},
		},
	};
	const pod = {
		status: {
			containerStatuses: [
				{
					name: "platform-worker",
					ready: true,
					imageID: `${binding.repository}@${binding.digest}`,
				},
			],
		},
	};
	assert.doesNotThrow(() => assertWorkerReadback(binding, [deployment], [pod]));
	assert.doesNotThrow(() =>
		assertWorkerReadback(
			binding,
			[deployment],
			[
				pod,
				{
					metadata: { deletionTimestamp: "2026-01-01T00:00:00Z" },
					status: {
						containerStatuses: [
							{
								name: "platform-worker",
								ready: true,
								imageID: `registry.example/worker@${digest("b")}`,
							},
						],
					},
				},
			],
		),
	);
	assert.throws(
		() => assertWorkerReadback(binding, [deployment], []),
		/Worker image readback/,
	);
	assert.throws(
		() =>
			assertWorkerReadback(
				binding,
				[deployment],
				[
					{
						status: {
							containerStatuses: [
								{ ...pod.status.containerStatuses[0], ready: false },
							],
						},
					},
				],
			),
		/Worker image readback/,
	);
	assert.throws(
		() => assertWorkerReadback(binding, [{ spec: { replicas: 1 } }], [pod]),
		/Worker image readback/,
	);
	assert.doesNotThrow(() =>
		assertWorkerReadback(
			binding,
			[deployment],
			[
				pod,
				{
					status: {
						containerStatuses: [
							{
								...pod.status.containerStatuses[0],
								imageID: `registry.example/worker@${digest("b")}`,
							},
						],
					},
				},
			],
		),
	);
});

test("Harness rejects unsupported lightweight lane before external commands", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "harness-lightweight-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const result = spawnSync(
		process.execPath,
		["deploy/local/e2e-harness.mjs", "deploy"],
		{
			encoding: "utf8",
			env: {
				...process.env,
				PLATFORM_LOCAL_STATE_DIRECTORY: join(directory, "state"),
				XDG_STATE_HOME: join(directory, "xdg"),
				E2E_HARNESS_LANE: "app",
				PLATFORM_LOCAL_PROJECT: "agent-infra-e2e",
				PLATFORM_LOCAL_NAMESPACE: "agent-infra-e2e",
				PLATFORM_LOCAL_KUBE_CONTEXT: "kind-agent-infra-e2e",
				E2E_HARNESS_SHARED_BASE_RECEIPT: "/missing",
				DOCKER_BIN: "/no-external-command",
			},
		},
	);
	assert.equal(result.status, 1);
	assert.match(
		result.stderr,
		/APP_BASE_UNAVAILABLE|APP_LANE_UNSAFE_CHANGE|APP_TLS_INPUT_MISSING|Source pin is missing/,
	);
});

test("split Harness stages keep the synchronized SHA and skip cached digest pulls", async (t) => {
	const { cp, mkdir, chmod } = await import("node:fs/promises");
	const directory = await mkdtemp(join(tmpdir(), "harness-command-"));
	const repository = join(directory, "repo");
	const state = join(directory, "state");
	const bin = join(directory, "docker");
	const log = join(directory, "docker.log");
	const runGit = (args) => execFileAsync("git", args, { cwd: repository });
	try {
		await mkdir(join(repository, "deploy/local"), { recursive: true });
		for (const name of [
			"e2e-harness.mjs",
			"harness-image-cache.mjs",
			"runtime-material.mjs",
		])
			await cp(
				join("deploy/local", name),
				join(repository, "deploy/local", name),
			);
		await mkdir(join(repository, "deploy/release"), { recursive: true });
		await writeFile(
			join(repository, "deploy/release/build-images.mjs"),
			`
import fs from "node:fs";
if (process.env.DOCKER_CONTEXT !== "fixture") throw new Error("FALLBACK_WRONG_DOCKER_CONTEXT");
fs.appendFileSync(process.env.TEST_FALLBACK_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const names = {runtimeHost:"agent-runtime-host", codex:"agent-runtime-codex", claude:"agent-runtime-claude", opencode:"agent-runtime-opencode", pi:"agent-runtime-pi", customBase:"custom-agent-base"};
const keys = process.argv.includes("--custom-base-image") ? ["customBase"] : process.argv.find(x => x.startsWith("--images=")).slice(9).split(",");
const images = Object.fromEntries(keys.map(key => [key, {repository:process.env.IMAGE_REPOSITORY_PREFIX + "/" + names[key], digest:"sha256:${"a".repeat(64)}"}]));
fs.writeFileSync(process.argv[2], JSON.stringify({images}));
`,
		);
		await runGit(["init", "-b", "main"]);
		await runGit(["config", "user.name", "Harness test"]);
		await runGit(["config", "user.email", "harness@example.invalid"]);
		await runGit(["add", "."]);
		await runGit(["commit", "-m", "fixture"]);
		const sha = (await runGit(["rev-parse", "HEAD"])).stdout.trim();
		await runGit(["remote", "add", "origin", "https://example.invalid/repo"]);
		await runGit(["update-ref", "refs/remotes/origin/main", sha]);
		await runGit(["branch", "--set-upstream-to=origin/main", "main"]);
		await writeFile(
			bin,
			`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_DOCKER_LOG, JSON.stringify(args) + "\\n");
if (args.includes("--raw") && process.env.TEST_INDEX_FILE) process.stdout.write(fs.readFileSync(process.env.TEST_INDEX_FILE));
else if (args.includes("--raw")) console.log(JSON.stringify({mediaType:"application/vnd.oci.image.manifest.v1+json"}));
else if (args.includes("imagetools") && process.env.TEST_NO_IMAGE_TAGS === "1") process.exit(1);
else if(args.includes("imagetools")) console.log("Digest: sha256:${"a".repeat(64)}");
else if(args.includes("info")) console.log("aarch64");
else if(args.includes("inspect")) console.log("[{}]");
else process.exit(43);
`,
		);
		await chmod(bin, 0o700);
		const env = {
			...process.env,
			E2E_HARNESS_LANE: "full",
			E2E_HARNESS_OFFLINE: "true",
			PLATFORM_LOCAL_STATE_DIRECTORY: state,
			XDG_STATE_HOME: join(directory, "xdg"),
			PLATFORM_LOCAL_PROJECT: "agent-infra-e2e",
			PLATFORM_LOCAL_NAMESPACE: "agent-infra-e2e",
			PLATFORM_LOCAL_KUBE_CONTEXT: "kind-agent-infra-e2e",
			PLATFORM_LOCAL_DOCKER_CONTEXT: "fixture",
			DOCKER_BIN: bin,
			TEST_DOCKER_LOG: log,
			TEST_FALLBACK_LOG: join(directory, "fallback.log"),
			DOCKER_CONTEXT: "foreign-default",
		};
		const cli = (action, overrides = {}) =>
			execFileAsync(
				process.execPath,
				["deploy/local/e2e-harness.mjs", action],
				{ cwd: repository, env: { ...env, ...overrides } },
			);
		await cli("sync");
		const tree = (await runGit(["rev-parse", "HEAD^{tree}"])).stdout.trim();
		const next = (
			await runGit(["commit-tree", tree, "-p", sha, "-m", "upstream advances"])
		).stdout.trim();
		await runGit(["update-ref", "refs/remotes/origin/main", next]);
		const result = await cli("images");
		assert.match(result.stdout, new RegExp(`sourceRevision=${sha}`));
		assert.equal((await runGit(["rev-parse", "HEAD"])).stdout.trim(), sha);
		const calls = (await readFile(log, "utf8"))
			.trim()
			.split("\n")
			.map(JSON.parse);
		assert.equal(
			calls.some((args) => args.includes("pull")),
			false,
		);
		const manifest = JSON.parse(
			await readFile(join(state, `infrastructure-${sha}.json`), "utf8"),
		);
		assert.equal(manifest.sourceRevision, sha);
		const names = [
			"agent-runtime-host",
			"agent-runtime-codex",
			"agent-runtime-claude",
			"agent-runtime-opencode",
			"agent-runtime-pi",
			"custom-agent-base",
		];
		const indexRaw = JSON.stringify({
			mediaType: "application/vnd.oci.image.index.v1+json",
			manifests: [
				{
					mediaType: "application/vnd.oci.image.manifest.v1+json",
					digest: digest("b"),
					platform: { os: "linux", architecture: "arm64" },
				},
			],
		});
		const indexDigest = `sha256:${createHash("sha256").update(indexRaw).digest("hex")}`;
		const receipts = names.map((name) => ({
			commitSha: sha,
			reference: `ghcr.io/agoraio-extensions/agent-infra/${name}:main`,
			digest: indexDigest,
			indexDigest,
			platformDigests: { "linux/arm64": digest("b") },
		}));
		const receiptPath = join(directory, "published-indexes.jsonl");
		const indexPath = join(directory, "index.json");
		await writeFile(indexPath, indexRaw);
		const receiptEnv = {
			E2E_HARNESS_PUBLISHED_INDEXES_FILE: receiptPath,
			TEST_INDEX_FILE: indexPath,
			TEST_NO_IMAGE_TAGS: "1",
		};
		const writeReceipts = (values) =>
			writeFile(
				receiptPath,
				`${values.map((row) => JSON.stringify(row)).join("\n")}\n`,
			);
		await t.test(
			"published receipts resolve six current-source Runtime child digests without tag lookup",
			async () => {
				await writeReceipts(receipts);
				await writeFile(log, "");
				await cli("images", receiptEnv);
				const resolved = JSON.parse(
					await readFile(join(state, `infrastructure-${sha}.json`), "utf8"),
				);
				assert.equal(Object.keys(resolved.images).length, 6);
				assert.ok(
					Object.values(resolved.images).every(
						(image) => image.digest === digest("b"),
					),
				);
				assert.equal(resolved.images.platformWorker, undefined);
				const receiptCalls = (await readFile(log, "utf8"))
					.trim()
					.split("\n")
					.map(JSON.parse);
				assert.ok(
					receiptCalls.every(
						(args) => args[0] === "--context" && args[1] === "fixture",
					),
				);
				assert.ok(
					receiptCalls
						.filter((args) => args.includes("imagetools"))
						.every((args) => args.at(-1).includes("@sha256:")),
				);
			},
		);
		for (const [name, rows] of [
			[
				"wrong source",
				receipts.map((row) => ({ ...row, commitSha: "0".repeat(40) })),
			],
			[
				"wrong repository",
				receipts.map((row) => ({
					...row,
					reference: row.reference.replace("agoraio-extensions", "foreign"),
				})),
			],
			["missing template", receipts.slice(1)],
			["duplicate template", [...receipts, receipts[0]]],
			[
				"wrong architecture",
				receipts.map((row) => ({
					...row,
					platformDigests: { "linux/amd64": digest("b") },
				})),
			],
			[
				"child mismatch",
				receipts.map((row) => ({
					...row,
					platformDigests: { "linux/arm64": digest("c") },
				})),
			],
			[
				"index mismatch",
				receipts.map((row) => ({
					...row,
					digest: digest("c"),
					indexDigest: digest("c"),
				})),
			],
		])
			await t.test(
				`published receipts reject ${name} without fallback`,
				async () => {
					await writeReceipts(rows);
					await assert.rejects(
						cli("images", receiptEnv),
						/Published image receipt/,
					);
					await assert.rejects(readFile(env.TEST_FALLBACK_LOG), {
						code: "ENOENT",
					});
				},
			);
		await t.test(
			"missing immutable tags build only Runtime images in the declared Docker context",
			async () => {
				await cli("images", { TEST_NO_IMAGE_TAGS: "1" });
				const builds = (await readFile(env.TEST_FALLBACK_LOG, "utf8"))
					.trim()
					.split("\n")
					.map(JSON.parse);
				assert.equal(builds.length, 2);
				assert.ok(
					builds[0].includes("--images=runtimeHost,codex,claude,opencode,pi"),
				);
				assert.ok(builds[1].includes("--custom-base-image"));
			},
		);
		await writeFile(join(state, "source-pin.json"), "{");
		await assert.rejects(cli("images"), /Source pin is unreadable or invalid/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("build reuses dependency-equivalent Worker and verify binds current-profile images", async () => {
	const { cp, mkdir, chmod, symlink, stat } = await import("node:fs/promises");
	const { resolve } = await import("node:path");
	const directory = await mkdtemp(join(tmpdir(), "harness-build-"));
	const repository = join(directory, "repo");
	const state = join(directory, "state");
	const bin = join(directory, "docker");
	const log = join(directory, "docker.log");
	const imageState = join(directory, "images.json");
	const values = join(directory, "private.yaml");
	const runGit = (args) => execFileAsync("git", args, { cwd: repository });
	try {
		await mkdir(join(repository, "deploy/local"), { recursive: true });
		for (const name of [
			"e2e-harness.mjs",
			"harness-image-cache.mjs",
			"runtime-material.mjs",
		])
			await cp(
				join("deploy/local", name),
				join(repository, "deploy/local", name),
			);
		await writeFile(
			join(repository, "package.json"),
			JSON.stringify({ private: true }),
		);
		await writeFile(join(repository, ".gitignore"), "node_modules/\n");
		await writeFile(
			join(repository, "deploy/local/platform.sh"),
			"#!/usr/bin/env bash\nprintf '%s\\n' fixture-component-bindings-applied >&2\nexit 17\n",
		);
		for (const service of [
			"web",
			"platform-api",
			"platform-worker",
			"enterprise-directory-sync",
		]) {
			const path = join(repository, "apps", service);
			await mkdir(path, { recursive: true });
			await writeFile(
				join(path, "package.json"),
				JSON.stringify({
					name: service,
					dependencies: { core: "workspace:*" },
				}),
			);
			await writeFile(join(path, "Dockerfile"), "FROM scratch\n");
		}
		for (const name of ["core", "unused"]) {
			const path = join(repository, "packages", name);
			await mkdir(path, { recursive: true });
			await writeFile(join(path, "package.json"), JSON.stringify({ name }));
		}
		await symlink(
			resolve("node_modules"),
			join(repository, "node_modules"),
			"dir",
		);
		await runGit(["init", "-b", "main"]);
		await runGit(["config", "user.name", "Harness test"]);
		await runGit(["config", "user.email", "harness@example.invalid"]);
		await runGit(["add", "."]);
		await runGit(["commit", "-m", "fixture"]);
		const sha = (await runGit(["rev-parse", "HEAD"])).stdout.trim();
		await runGit(["remote", "add", "origin", "https://example.invalid/repo"]);
		await runGit(["update-ref", "refs/remotes/origin/main", sha]);
		await runGit(["branch", "--set-upstream-to=origin/main", "main"]);
		await writeFile(
			values,
			"images:\n  platformWorker:\n    repository: registry.example/worker\nprivateOnly: fixture-sensitive-sentinel\n",
		);
		await writeFile(
			bin,
			`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(4);
fs.appendFileSync(process.env.TEST_DOCKER_LOG, JSON.stringify(args) + "\\n");
const statePath = process.env.TEST_IMAGE_STATE;
const images = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
const image = {Id:"sha256:${"b".repeat(64)}", RepoDigests:["registry.example/worker@sha256:${"a".repeat(64)}"]};
if(args[0] === "info") console.log("aarch64");
else if(args[0] === "image" && args[1] === "inspect") { if(!images[args[2]]) process.exit(1); console.log(JSON.stringify([images[args[2]]])); }
else if(args[0] === "build") { images[args[args.indexOf("--tag")+1]] = image; images[image.Id] = image; }
else if(args[0] === "tag") { if(!images[args[1]]) process.exit(44); images[args[2]] = images[args[1]]; }
else if(args.includes("--raw")) console.log(JSON.stringify({mediaType:"application/vnd.oci.image.manifest.v1+json", config:{digest:image.Id}}));
else process.exit(43);
fs.writeFileSync(statePath, JSON.stringify(images));
`,
		);
		await chmod(bin, 0o700);
		const env = {
			...process.env,
			E2E_HARNESS_LANE: "full",
			E2E_HARNESS_OFFLINE: "true",
			PLATFORM_LOCAL_STATE_DIRECTORY: state,
			XDG_STATE_HOME: join(directory, "xdg"),
			PLATFORM_LOCAL_PROJECT: "agent-infra-e2e",
			PLATFORM_LOCAL_NAMESPACE: "agent-infra-e2e",
			PLATFORM_LOCAL_KUBE_CONTEXT: "kind-agent-infra-e2e",
			PLATFORM_LOCAL_DOCKER_CONTEXT: "fixture",
			PLATFORM_LOCAL_WORKER_VALUES: values,
			DOCKER_BIN: bin,
			TEST_DOCKER_LOG: log,
			TEST_IMAGE_STATE: imageState,
		};
		const cli = (action) =>
			execFileAsync(
				process.execPath,
				["deploy/local/e2e-harness.mjs", action],
				{ cwd: repository, env },
			);
		await cli("sync");
		await cli("build");
		const first = JSON.parse(
			await readFile(join(state, `platform-images-${sha}.json`), "utf8"),
		);
		const overlay = await readFile(
			join(state, `worker-values-${sha}.yaml`),
			"utf8",
		);
		assert.doesNotMatch(overlay, /privateOnly|fixture-sensitive-sentinel/);
		assert.match(overlay, /repository: "registry.example\/worker"/);
		assert.equal(
			(await stat(join(state, `worker-values-${sha}.yaml`))).mode & 0o777,
			0o600,
		);
		const initialCalls = (await readFile(log, "utf8"))
			.trim()
			.split("\n")
			.map(JSON.parse);
		assert.equal(initialCalls.filter((args) => args[0] === "build").length, 4);
		assert.equal(
			initialCalls.some((args) => args[0] === "push"),
			false,
		);
		await writeFile(
			join(state, `infrastructure-${sha}.json`),
			JSON.stringify({
				images: {
					runtimeHost: {
						repository: "registry.example/runtime",
						digest: digest("a"),
					},
				},
			}),
		);
		await writeFile(log, "");
		// Stop at the platform boundary: only real CLI image rebinding is under test.
		await assert.rejects(cli("verify"), (error) => {
			assert.match(error.stderr, /fixture-component-bindings-applied/);
			return true;
		});
		const cachePath = join(state, "component-image-cache.json");
		const cache = JSON.parse(await readFile(cachePath, "utf8"));
		const bindingCalls = (await readFile(log, "utf8"))
			.trim()
			.split("\n")
			.map(JSON.parse);
		assert.deepEqual(
			bindingCalls.filter((args) => args[0] === "tag"),
			[
				"web",
				"platform-api",
				"platform-worker",
				"enterprise-directory-sync",
			].map((service) => {
				const entry = Object.entries(cache.components).find(([key]) =>
					key.startsWith(`${first.profile}:${service}:`),
				)?.[1];
				assert.ok(entry);
				return ["tag", entry.imageId, `agent-infra-e2e-${service}`];
			}),
		);
		const webKey = Object.keys(cache.components).find((key) =>
			key.startsWith(`${first.profile}:web:`),
		);
		assert.ok(webKey);
		const webEntry = cache.components[webKey];
		delete cache.components[webKey];
		cache.components[webKey.replace(first.profile, "other-profile")] = {
			...webEntry,
			profile: "other-profile",
		};
		await writeFile(cachePath, JSON.stringify(cache));
		await writeFile(log, "");
		await assert.rejects(cli("verify"), (error) => {
			assert.match(error.stderr, /Component binding is missing for web/);
			assert.doesNotMatch(error.stderr, /fixture-component-bindings-applied/);
			return true;
		});
		assert.equal(
			(await readFile(log, "utf8"))
				.split("\n")
				.filter(Boolean)
				.map(JSON.parse)
				.some((args) => args[0] === "tag"),
			false,
		);
		delete cache.components[webKey.replace(first.profile, "other-profile")];
		cache.components[webKey] = webEntry;
		await writeFile(cachePath, JSON.stringify(cache));
		const existingImages = await readFile(imageState, "utf8");
		const missingImage = JSON.parse(existingImages);
		delete missingImage[webEntry.imageId];
		await writeFile(imageState, JSON.stringify(missingImage));
		await assert.rejects(cli("verify"), (error) => {
			assert.match(error.stderr, /Component image is unavailable for web/);
			assert.doesNotMatch(error.stderr, /fixture-component-bindings-applied/);
			return true;
		});
		await writeFile(imageState, existingImages);
		await writeFile(join(repository, "apps/web/ui.txt"), "changed web");
		await writeFile(
			join(repository, "packages/unused/unused.txt"),
			"unrelated package",
		);
		await runGit(["add", "."]);
		await runGit(["commit", "-m", "web change"]);
		const nextSha = (await runGit(["rev-parse", "HEAD"])).stdout.trim();
		await cli("sync");
		await writeFile(log, "");
		await cli("build");
		const second = JSON.parse(
			await readFile(join(state, `platform-images-${nextSha}.json`), "utf8"),
		);
		assert.equal(second.sourceSha, nextSha);
		assert.equal(second.worker.inputHash, first.worker.inputHash);
		assert.equal(second.worker.digest, first.worker.digest);
		assert.equal(second.worker.buildSourceSha, sha);
		const nextCalls = (await readFile(log, "utf8"))
			.trim()
			.split("\n")
			.map(JSON.parse);
		assert.equal(nextCalls.filter((args) => args[0] === "build").length, 1);
		assert.equal(
			nextCalls
				.find((args) => args[0] === "build")
				.includes("agent-infra-e2e-web"),
			true,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
