import assert from "node:assert/strict";
import test from "node:test";
import {
	assertCacheReady,
	cacheName,
	cacheOwner,
	ensureCaches,
	parseCachePlan,
	planFromIndexes,
} from "../deploy/ack/image-cache.ts";

const sha = "a".repeat(40);
const ref = `ghcr.io/agoraio-extensions/agent-infra/agent-runtime-codex@sha256:${"b".repeat(64)}`;
const plan = {
	schemaVersion: 1,
	sourceSha: sha,
	platform: "linux/amd64",
	groups: [[ref]],
};
const ready = {
	name: cacheName([ref]),
	id: "imc-test123",
	phase: "Ready",
	images: [ref],
	owner: cacheOwner,
};

test("cache plans reject mutable, foreign and wrong-architecture inputs", () => {
	for (const groups of [
		[["ghcr.io/agoraio-extensions/agent-infra/agent-runtime-codex:latest"]],
		[[`evil.test/image@sha256:${"b".repeat(64)}`]],
		[],
	]) {
		assert.throws(() => parseCachePlan({ ...plan, groups }));
	}
	assert.throws(() => parseCachePlan({ ...plan, platform: "linux/arm64" }));
	assert.deepEqual(parseCachePlan({ ...plan, groups: [[ref], [ref]] }).groups, [
		[ref],
	]);
});

test("release catalog accepts only the complete source-bound architecture receipts", () => {
	const names = [
		"agent-runtime-host",
		"agent-runtime-codex",
		"agent-runtime-claude",
		"agent-runtime-opencode",
		"agent-runtime-pi",
		"custom-agent-base",
	];
	const rows = names.map((name) => ({
		commitSha: sha,
		reference: `ghcr.io/agoraio-extensions/agent-infra/${name}:release-${sha}`,
		digest: `sha256:${"c".repeat(64)}`,
		indexDigest: `sha256:${"c".repeat(64)}`,
		platformDigests: { "linux/amd64": `sha256:${"b".repeat(64)}` },
	}));
	const encode = (r) => r.map((x) => JSON.stringify(x)).join("\n");
	assert.equal(planFromIndexes(encode(rows), sha).groups.length, 6);
	assert.throws(() => planFromIndexes(encode(rows.slice(1)), sha));
	assert.throws(() => planFromIndexes(encode(rows), "d".repeat(40)));
	assert.throws(() =>
		planFromIndexes(
			encode(
				rows.map((x) => ({
					...x,
					reference: `${x.reference.split(":")[0]}:smoke-1-1`,
				})),
			),
			sha,
		),
	);
	assert.throws(() =>
		planFromIndexes(
			encode(
				rows.map((x) => ({
					...x,
					platformDigests: { "linux/arm64": `sha256:${"b".repeat(64)}` },
				})),
			),
			sha,
		),
	);
});

test("existing exact Ready cache is reused without creation", async () => {
	let creates = 0;
	const backend = { get: async () => ready, create: async () => creates++ };
	const receipt = await ensureCaches(plan, backend);
	assert.equal(creates, 0);
	assert.equal(receipt.status, "ready");
	assert.equal(receipt.businessVerified, false);
	assert.equal(receipt.caches[0].id, ready.id);
});

test("new cache is awaited and checked again after preparation", async () => {
	let cache;
	let creates = 0;
	let reads = 0;
	const backend = {
		get: async () => {
			reads++;
			return cache;
		},
		create: async () => {
			creates++;
			cache = { ...ready, phase: "Creating" };
		},
	};
	await ensureCaches(plan, backend, {
		sleep: async () => {
			cache = ready;
		},
	});
	assert.equal(creates, 1);
	assert.equal(reads, 4);
});

test("prepares independent groups concurrently within the configured pool", async () => {
	const refs = Array.from(
		{ length: 6 },
		(_, index) =>
			`ghcr.io/agoraio-extensions/agent-infra/agent-runtime-codex@sha256:${String(index + 1).repeat(64)}`,
	);
	const state = new Map();
	let active = 0;
	let peak = 0;
	const backend = {
		get: async (name) => state.get(name),
		create: async (name, images) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			state.set(name, {
				name,
				id: `imc-${name.slice(-6)}`,
				phase: "Ready",
				images,
				owner: cacheOwner,
			});
			active--;
		},
	};
	const receipt = await ensureCaches(
		{ ...plan, groups: refs.map((ref) => [ref]) },
		backend,
		{ concurrency: 3 },
	);
	assert.equal(receipt.caches.length, 6);
	assert.equal(peak, 3);
});

test("serializes progress snapshots while concurrent workers settle together", async () => {
	const refs = ["a", "b", "c", "d"].map(
		(value) =>
			`ghcr.io/agoraio-extensions/agent-infra/agent-runtime-codex@sha256:${value.repeat(64)}`,
	);
	const state = new Map();
	const snapshots = [];
	let activeWrites = 0;
	const receipt = await ensureCaches(
		{ ...plan, groups: refs.map((ref) => [ref]) },
		{
			get: async (name) => state.get(name),
			create: async (name, images) =>
				state.set(name, {
					name,
					id: `imc-${name.slice(-6)}`,
					phase: "Ready",
					images,
					owner: cacheOwner,
				}),
		},
		{
			concurrency: 3,
			onProgress: async (progress) => {
				activeWrites++;
				assert.equal(activeWrites, 1);
				await new Promise((resolve) => setTimeout(resolve, 2));
				snapshots.push(progress.length);
				activeWrites--;
			},
		},
	);
	assert.equal(receipt.caches.length, 4);
	assert.deepEqual(
		snapshots,
		[...snapshots].sort((a, b) => a - b),
	);
	assert.equal(activeWrites, 0);
});

test("waits for other workers before returning the first preparation failure", async () => {
	const refs = ["a", "b"].map(
		(value) =>
			`ghcr.io/agoraio-extensions/agent-infra/agent-runtime-codex@sha256:${value.repeat(64)}`,
	);
	let settled = false;
	const state = new Map();
	await assert.rejects(
		ensureCaches(
			{ ...plan, groups: refs.map((ref) => [ref]) },
			{
				get: async (name) => state.get(name),
				create: async (name, images) => {
					if (images[0].includes("a".repeat(64))) {
						await new Promise((resolve) => setTimeout(resolve, 5));
						throw new Error("CACHE_PREPARATION_FAILED");
					}
					await new Promise((resolve) => setTimeout(resolve, 25));
					state.set(name, {
						name,
						id: "imc-other",
						phase: "Ready",
						images,
						owner: cacheOwner,
					});
					settled = true;
				},
			},
			{ concurrency: 2 },
		),
		/CACHE_PREPARATION_FAILED/,
	);
	assert.equal(settled, true);
});

test("foreign, partial, failed, expired and missing caches never satisfy the gate", async () => {
	for (const cache of [
		undefined,
		{ ...ready, owner: "someone-else" },
		{ ...ready, images: [] },
		{ ...ready, phase: "Failed" },
		{ ...ready, phase: "Expired" },
		{ ...ready, deleting: true },
		{ ...ready, expiresAt: new Date(0).toISOString() },
	]) {
		await assert.rejects(
			ensureCaches(
				plan,
				{
					get: async () => cache,
					create: async () => assert.fail("check mode must not create"),
				},
				{ checkOnly: true },
			),
		);
	}
	assert.throws(() => assertCacheReady({ ...ready, id: undefined }, [ref]));
});

test("waits are bounded and an earlier cache disappearing aborts final validation", async () => {
	let now = 0;
	await assert.rejects(
		ensureCaches(
			plan,
			{
				get: async () => ({ ...ready, phase: "Creating" }),
				create: async () => {},
			},
			{
				timeoutMs: 20,
				now: () => now,
				sleep: async (ms) => {
					now += ms;
				},
			},
		),
		/CACHE_TIMEOUT/,
	);
	let reads = 0;
	await assert.rejects(
		ensureCaches(plan, {
			get: async () => (++reads < 3 ? ready : undefined),
			create: async () => {},
		}),
		/CACHE_IDENTITY_MISMATCH/,
	);
});

import { deploymentCachePlan } from "../deploy/ack/image-cache-deployment.ts";

test("deployment cache plan covers the final custom image and complete multi-container Pod set", () => {
	const entry = { repository: ref.split("@")[0], digest: ref.split("@")[1] };
	const manifest = (images) => ({
		schemaVersion: 1,
		commitSha: sha,
		platform: "linux/amd64",
		images,
	});
	const runtime = manifest({ runtimeHost: entry });
	const templates = manifest(
		Object.fromEntries(
			["codex", "claude", "opencode", "pi"].map((n) => [
				n,
				{ ...entry, repository: entry.repository.replace("codex", n) },
			]),
		),
	);
	const custom = ref.replace("agent-runtime-codex", "custom-agent-base");
	const result = deploymentCachePlan(sha, runtime, templates, [
		{ source: { kind: "custom", imageReference: custom } },
		{
			source: {
				kind: "custom",
				manifest: `kind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n        - image: ${custom}\n      initContainers:\n        - image: ${ref}\n`,
			},
		},
	]);
	assert(result.groups.some((g) => g.length === 1 && g[0] === custom));
	assert(
		result.groups.some(
			(g) => g.length === 2 && g.includes(custom) && g.includes(ref),
		),
	);
	assert.throws(() =>
		deploymentCachePlan("d".repeat(40), runtime, templates, []),
	);
	assert.throws(() =>
		deploymentCachePlan(sha, runtime, templates, [
			{
				source: {
					kind: "custom",
					imageReference: `${custom.split("@")[0]}:latest`,
				},
			},
		]),
	);
});

test("stable releases validate latest promotions without treating them as extra cache inputs", () => {
	const names = [
		"agent-runtime-host",
		"agent-runtime-codex",
		"agent-runtime-claude",
		"agent-runtime-opencode",
		"agent-runtime-pi",
		"custom-agent-base",
	];
	const rows = names.map((name) => ({
		commitSha: sha,
		reference: `ghcr.io/agoraio-extensions/agent-infra/${name}:v1.2.3`,
		digest: `sha256:${"c".repeat(64)}`,
		indexDigest: `sha256:${"c".repeat(64)}`,
		platformDigests: { "linux/amd64": `sha256:${"b".repeat(64)}` },
	}));
	const promotions = rows.map((r) => ({
		commitSha: sha,
		sourceTag: "v1.2.3",
		reference: r.reference.replace(":v1.2.3", ":latest"),
		digest: r.digest,
	}));
	const encode = (rs) => rs.map((r) => JSON.stringify(r)).join("\n");
	assert.equal(
		planFromIndexes(encode([...rows, ...promotions]), sha).groups.length,
		6,
	);
	promotions[0].digest = `sha256:${"d".repeat(64)}`;
	assert.throws(() => planFromIndexes(encode([...rows, ...promotions]), sha));
});

test("owned failed caches use one bounded recovery generation without deleting the original", async () => {
	const store = new Map([[cacheName([ref]), { ...ready, phase: "Failed" }]]);
	const created = [];
	const backend = {
		get: async (name) => store.get(name),
		create: async (name, images) => {
			created.push(name);
			store.set(name, { ...ready, name, images });
		},
	};
	const receipt = await ensureCaches(plan, backend);
	assert.deepEqual(created, [`${cacheName([ref])}-retry1`]);
	assert.equal(receipt.caches[0].name, created[0]);
	await ensureCaches(plan, backend);
	assert.equal(created.length, 1);
	store.set(created[0], { ...ready, phase: "Failed" });
	await assert.rejects(ensureCaches(plan, backend), /CACHE_PREPARATION_FAILED/);
});

import { cacheWorkerReady } from "../deploy/ack/image-cache-worker.ts";

test("cache activation waits for the exact Worker digest and every old Worker to exit", () => {
	const worker = `ghcr.io/agoraio-extensions/agent-infra/platform-worker@sha256:${"a".repeat(64)}`;
	const deployment = {
		metadata: { generation: 3 },
		spec: {
			replicas: 1,
			template: { spec: { containers: [{ image: worker }] } },
		},
		status: { observedGeneration: 3, updatedReplicas: 1, availableReplicas: 1 },
	};
	const pod = {
		metadata: {},
		spec: { containers: [{ image: worker }] },
		status: {
			conditions: [{ type: "Ready", status: "True" }],
			containerStatuses: [{ ready: true, imageID: worker }],
		},
	};
	assert.equal(cacheWorkerReady(deployment, [pod], worker), true);
	assert.equal(
		cacheWorkerReady(
			deployment,
			[
				{
					...pod,
					status: {
						...pod.status,
						conditions: [{ type: "Ready", status: "False" }],
					},
				},
			],
			worker,
		),
		false,
	);
	assert.equal(
		cacheWorkerReady(
			deployment,
			[pod, { ...pod, metadata: { deletionTimestamp: "now" } }],
			worker,
		),
		false,
	);
	assert.equal(
		cacheWorkerReady(
			deployment,
			[
				{
					...pod,
					status: {
						containerStatuses: [
							{
								ready: true,
								imageID: worker.replace("a".repeat(64), "b".repeat(64)),
							},
						],
					},
				},
			],
			worker,
		),
		false,
	);
	assert.equal(
		cacheWorkerReady(
			{
				...deployment,
				status: { ...deployment.status, observedGeneration: 2 },
			},
			[pod],
			worker,
		),
		false,
	);
});

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

test("cache failure prevents bootstrap configuration writes and restarts, including all", () => {
	const script = readFileSync(
		new URL("../deploy/ack/redeploy.sh", import.meta.url),
		"utf8",
	);
	const bootstrap = script.slice(
		script.indexOf("bootstrap_inputs() {"),
		script.indexOf("restart_config_consumers() {"),
	);
	const all = script.slice(
		script.indexOf("\tall)") + 6,
		script.indexOf("\n\t\t;;", script.indexOf("\tall)")),
	);
	const setup = `set -euo pipefail
require_source_tuple(){ :; }
require_file(){ :; }
prepare_evidence(){ :; }
render_manifest(){ :; }
configuration_source_preflight(){ :; }
preflight_agent_requests(){ :; }
reserve_plan_preflight(){ :; }
image_cache_gate(){ exit 42; }
node(){ echo WRITE; }
restart_config_consumers(){ echo RESTART; }
bootstrap_database(){ echo WRITE; }
repo_root=/synthetic
ACK_BOOTSTRAP_INPUTS_FILE=/synthetic/input
evidence_dir=/tmp
`;
	for (const code of [`${bootstrap}\nbootstrap_inputs apply`, all]) {
		const result = spawnSync("bash", ["-c", `${setup}\n${code}`], {
			encoding: "utf8",
			env: { ...process.env, BASH_ENV: "/dev/null" },
		});
		assert.equal(result.status, 42, result.stderr);
		assert.doesNotMatch(result.stdout, /WRITE|RESTART/);
	}
});

test("an existing strict policy cannot be silently disabled by omitting the environment flag", () => {
	const script = readFileSync(
		new URL("../deploy/ack/redeploy.sh", import.meta.url),
		"utf8",
	);
	const gate = script.slice(
		script.indexOf("image_cache_gate() {"),
		script.indexOf("activate_cache_admission() {"),
	);
	const result = spawnSync(
		"bash",
		[
			"-c",
			`set -euo pipefail
kubectl(){ echo validatingadmissionpolicy/agent-infra-session-image-cache; }
die(){ echo "$1"; exit 42; }
namespace=agent-infra
ACK_KUBECONFIG=/synthetic/kubeconfig
ACK_IMAGE_CACHE_REQUIRED=false
${gate}
image_cache_gate
`,
		],
		{ encoding: "utf8", env: { ...process.env, BASH_ENV: "/dev/null" } },
	);
	assert.equal(result.status, 42, result.stderr);
	assert.match(result.stdout, /strict cache admission is already enabled/);
});

import { validateReleaseRun } from "../deploy/ack/image-cache-release.ts";

test("image-cache CLI forwards the bounded concurrency setting", () => {
	const source = readFileSync(
		new URL("../deploy/ack/image-cache.ts", import.meta.url),
		"utf8",
	);
	assert.match(source, /ACK_IMAGE_CACHE_CONCURRENCY/);
});

test("cache plan publication requires successful same-repository exact attempts", () => {
	const run = {
		id: 42,
		run_attempt: 2,
		status: "completed",
		conclusion: "success",
		repository: { full_name: "AgoraIO-Extensions/agent-infra" },
		head_repository: { full_name: "AgoraIO-Extensions/agent-infra" },
		path: ".github/workflows/publish-images.yml",
		event: "workflow_dispatch",
		head_branch: "main",
		display_title: `workflow_dispatch | publish-images | main | ${sha}`,
	};
	assert.equal(validateReleaseRun(run, "42", "2"), sha);
	for (const change of [
		{ conclusion: "failure" },
		{ run_attempt: 1 },
		{ head_branch: "feature" },
		{ head_repository: { full_name: "attacker/fork" } },
		{ path: ".github/workflows/ci.yml" },
		{ event: "pull_request" },
	])
		assert.throws(() => validateReleaseRun({ ...run, ...change }, "42", "2"));
});

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Execute the actual CLI against a stateful Kubernetes boundary. No gh/cloud
// executable is supplied: ready receipts must come from live CR reads.
test("deployment uses Kubernetes, retains partial failure evidence and rejects stale ready files", () => {
	const directory = mkdtempSync(join(tmpdir(), "ack-cache-cli-"));
	try {
		const fixture = join(directory, "cluster.json");
		const log = join(directory, "calls.jsonl");
		writeFileSync(
			join(directory, "kubectl"),
			`#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.CACHE_FIXTURE, "utf8"));
fs.appendFileSync(process.env.CACHE_CALLS, JSON.stringify(args) + "\\n");
if (args.includes("validatingadmissionpolicy")) process.exit(0);
if (state.denied) { console.error("private-server-token"); process.exit(1); }
if (args.includes("create")) {
 const cr = JSON.parse(fs.readFileSync(0,"utf8"));
 state.items.push({...cr, status:{phase:"Ready",imageCacheId:"imc-created"+state.items.length}});
 fs.writeFileSync(process.env.CACHE_FIXTURE, JSON.stringify(state));
} else if(args.includes("-l")) console.log(JSON.stringify({items:state.items}));
else { const name = args[args.indexOf("imagecache") + 1] === "-n" ? args[args.indexOf("imagecache") + 3] : args[args.indexOf("imagecache") + 1]; const cr = state.items.find(x=>x.metadata.name===name); if(cr) console.log(JSON.stringify(cr)); }
`,
			{ mode: 0o700 },
		);
		const entry = { repository: ref.split("@")[0], digest: ref.split("@")[1] };
		const manifest = (images) => ({
			schemaVersion: 1,
			commitSha: sha,
			platform: "linux/amd64",
			images,
		});
		const runtime = join(directory, "runtime.json");
		const templates = join(directory, "templates.json");
		writeFileSync(runtime, JSON.stringify(manifest({ runtimeHost: entry })), {
			mode: 0o600,
		});
		writeFileSync(
			templates,
			JSON.stringify(
				manifest(
					Object.fromEntries(
						["codex", "claude", "opencode", "pi"].map((n) => [
							n,
							{ ...entry, repository: entry.repository.replace("codex", n) },
						]),
					),
				),
			),
			{ mode: 0o600 },
		);
		const run = (state) => {
			writeFileSync(fixture, JSON.stringify(state));
			return spawnSync(
				process.execPath,
				["deploy/ack/image-cache-deployment.ts", directory],
				{
					encoding: "utf8",
					env: {
						PATH: directory,
						ACK_KUBECONFIG: "/fixture/kubeconfig",
						ACK_NAMESPACE: "fixture",
						ACK_SOURCE_SHA: sha,
						ACK_RUNTIME_IMAGE_MANIFEST: runtime,
						ACK_TEMPLATE_IMAGE_MANIFEST: templates,
						CACHE_FIXTURE: fixture,
						CACHE_CALLS: log,
					},
				},
			);
		};
		const success = run({ items: [] });
		assert.equal(success.status, 0, success.stderr);
		const receiptFile = join(directory, "image-cache.ready.json");
		const receipt = JSON.parse(readFileSync(receiptFile));
		assert.equal(receipt.status, "ready");
		assert.equal(receipt.caches.length, 4);
		assert(existsSync(join(directory, "image-cache.values.json")));
		const stored = JSON.parse(readFileSync(fixture));
		assert.deepEqual(stored.items[0].spec.imagePullSecrets, [
			"fixture:ack-ghcr-pull",
		]);
		for (const line of readFileSync(log, "utf8")
			.split("\n")
			.filter((line) => line.includes("imagecache"))) {
			const args = JSON.parse(line);
			assert(args.includes("-n") && args.includes("fixture"));
		}
		const count = () =>
			readFileSync(log, "utf8")
				.split("\n")
				.filter((x) => x.includes('"create"')).length;
		const created = count();
		assert.equal(run(stored).status, 0);
		assert.equal(count(), created);
		stored.items[1].metadata.labels["agent-infra.agora.io/cache-owner"] =
			"foreign";
		assert.notEqual(run(stored).status, 0);
		const failed = JSON.parse(readFileSync(receiptFile));
		assert.equal(failed.status, "failed");
		assert.equal(failed.caches.length, 1);
		assert.equal(failed.reason, "CACHE_IDENTITY_MISMATCH");
		assert(!existsSync(join(directory, "image-cache.values.json")));
		const denied = run({ denied: true, items: [] });
		assert.notEqual(denied.status, 0);
		assert.doesNotMatch(
			denied.stdout + denied.stderr + readFileSync(receiptFile),
			/private-server-token/,
		);
		assert.equal(
			JSON.parse(readFileSync(receiptFile)).reason,
			"CACHE_KUBERNETES_REQUEST_FAILED",
		);
		const budget = run({
			items: Array.from({ length: 48 }, (_, i) => ({
				metadata: { name: `old-${i}` },
			})),
		});
		assert.notEqual(budget.status, 0);
		assert.equal(
			JSON.parse(readFileSync(receiptFile)).reason,
			"CACHE_OBJECT_BUDGET_EXCEEDED",
		);
		assert.equal(count(), created);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
