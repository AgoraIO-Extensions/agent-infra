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

test("foreign, partial, failed, expired and missing caches never satisfy the gate", async () => {
	for (const cache of [
		undefined,
		{ ...ready, owner: "someone-else" },
		{ ...ready, images: [] },
		{ ...ready, phase: "Failed" },
		{ ...ready, phase: "Expired" },
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

import { signedParameters } from "../deploy/ack/image-cache-cloud.ts";
import { deploymentCachePlan } from "../deploy/ack/image-cache-deployment.ts";
import { validateReleaseRun } from "../deploy/ack/image-cache-release.ts";

test("cloud credentials can only follow successful same-repository exact attempts", () => {
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

test("RPC signing canonicalizes independently of parameter insertion order and keeps secrets out of parameters", () => {
	const fields = {
		Action: "DescribeImageCaches",
		Timestamp: "2026-11-04T10:00:00Z",
		SignatureNonce: "test-nonce",
		Image: "a/b:tag with spaces*",
	};
	const first = signedParameters(fields, "test-secret");
	const second = signedParameters(
		Object.fromEntries(Object.entries(fields).reverse()),
		"test-secret",
	);
	assert.equal(first.get("Signature"), second.get("Signature"));
	assert.equal(first.get("Image"), fields.Image);
	assert(!first.toString().includes("test-secret"));
	assert.notEqual(
		first.get("Signature"),
		signedParameters(
			{ ...fields, Action: "CreateImageCache" },
			"test-secret",
		).get("Signature"),
	);
});

import { verifyDispatchedReceipt } from "../deploy/ack/image-cache-dispatch.ts";

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

test("a deployment accepts only a fresh receipt for the exact image groups", () => {
	const now = Date.now();
	const receipt = {
		schemaVersion: 1,
		kind: "ack-image-cache",
		status: "ready",
		sourceSha: sha,
		platform: plan.platform,
		checkedAt: new Date(now).toISOString(),
		caches: [{ name: ready.name, id: ready.id, images: [ref] }],
	};
	assert.equal(verifyDispatchedReceipt(receipt, plan, now), receipt);
	for (const change of [
		{ status: "failed" },
		{ sourceSha: "d".repeat(40) },
		{ checkedAt: new Date(now - 301000).toISOString() },
		{ caches: [] },
		{ caches: [{ id: ready.id, images: [ref.replace("codex", "pi")] }] },
	])
		assert.throws(() =>
			verifyDispatchedReceipt({ ...receipt, ...change }, plan, now),
		);
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
