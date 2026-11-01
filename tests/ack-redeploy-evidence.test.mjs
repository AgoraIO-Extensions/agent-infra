import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import {
	normalizeRuntimeImageManifest,
	projectSnapshot,
	validateRenderedImages,
} from "../deploy/ack/redeploy-evidence.ts";

const digest = `sha256:${"a".repeat(64)}`;
const sourceSha = "a".repeat(40);
const provenance = {
	schemaVersion: 1,
	commitSha: sourceSha,
	platform: "linux/amd64",
};
const pairs = [
	["web", "agent-infra-web"],
	["platformApi", "agent-infra-api"],
	["platformWorker", "agent-infra-worker"],
	["enterpriseDirectorySync", "agent-infra-directory"],
];
function fixture() {
	const platform = {
		...provenance,
		images: Object.fromEntries(
			pairs.map(([key]) => [
				key,
				{ repository: `registry.example/${key.toLowerCase()}`, digest },
			]),
		),
	};
	const runtime = {
		...provenance,
		repository: "registry.example/runtime",
		digest,
	};
	const documents = pairs.map(([key, name]) => ({
		apiVersion: "apps/v1",
		kind: "Deployment",
		metadata: { name },
		spec: {
			template: {
				spec: {
					containers: [
						{
							name: key,
							image: `${platform.images[key].repository}@${digest}`,
							env:
								key === "platformWorker"
									? [
											{
												name: "AGENT_INFRA_RUNTIME_IMAGE_REPOSITORY",
												value: runtime.repository,
											},
											{
												name: "AGENT_INFRA_RUNTIME_IMAGE_DIGEST",
												value: runtime.digest,
											},
										]
									: [],
						},
					],
				},
			},
		},
	}));
	const render = () =>
		documents.map((document) => stringify(document)).join("---\n");
	return { platform, runtime, documents, render };
}

test("structural image binding accepts exact components and rejects swapped images or comment-only matches", () => {
	const f = fixture();
	validateRenderedImages(f.render(), f.platform, f.runtime);
	const a = f.documents[0].spec.template.spec.containers[0];
	const b = f.documents[1].spec.template.spec.containers[0];
	[a.image, b.image] = [b.image, a.image];
	assert.throws(() =>
		validateRenderedImages(f.render(), f.platform, f.runtime),
	);
	const valid = fixture();
	valid.documents[0].spec.template.spec.containers[0].image =
		"registry.example/web:latest";
	assert.throws(() =>
		validateRenderedImages(
			`${valid.render()}\n# image: registry.example/web@${digest}`,
			valid.platform,
			valid.runtime,
		),
	);
});

test("accepts the official RuntimeHost publication receipt shape and rejects invalid nested bindings", () => {
	const f = fixture();
	const published = {
		schemaVersion: 1,
		commitSha: "a".repeat(40),
		platform: "linux/amd64",
		images: { runtimeHost: f.runtime },
	};
	assert.deepEqual(normalizeRuntimeImageManifest(published, sourceSha), {
		schemaVersion: 1,
		commitSha: "a".repeat(40),
		platform: "linux/amd64",
		...f.runtime,
	});
	assert.throws(() =>
		normalizeRuntimeImageManifest(
			{ ...published, platform: "linux/arm64" },
			sourceSha,
		),
	);
	assert.throws(() =>
		normalizeRuntimeImageManifest(
			{
				...published,
				images: {
					runtimeHost: { repository: f.runtime.repository, digest: "latest" },
				},
			},
			sourceSha,
		),
	);
	assert.throws(() =>
		normalizeRuntimeImageManifest({ ...published, images: {} }, sourceSha),
	);
	assert.throws(() =>
		normalizeRuntimeImageManifest({ ...f.runtime, images: {} }, sourceSha),
	);
});

test("render rejects wrong source and invalid provenance in both RuntimeHost receipt formats", () => {
	const f = fixture();
	for (const nested of [true, false]) {
		const receipt = nested
			? {
					...provenance,
					images: { runtimeHost: { repository: f.runtime.repository, digest } },
				}
			: { ...f.runtime };
		validateRenderedImages(f.render(), f.platform, receipt);
		for (const invalid of [
			{ ...receipt, schemaVersion: 2 },
			{ ...receipt, schemaVersion: undefined },
			{ ...receipt, commitSha: "b".repeat(40) },
			{ ...receipt, platform: "linux/arm64" },
		])
			assert.throws(() =>
				validateRenderedImages(f.render(), f.platform, invalid),
			);
	}
});

test("RuntimeHost CLI accepts original release receipts and rejects invalid shapes without leaking input", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ack-runtime-receipt-"));
	try {
		const input = join(directory, "runtime-host.json");
		const runtime = {
			...provenance,
			images: {
				runtimeHost: { repository: "registry.example/runtime", digest },
			},
		};
		const run = () =>
			spawnSync(
				process.execPath,
				[
					join(import.meta.dirname, "../deploy/ack/redeploy-evidence.ts"),
					"runtime-manifest",
					input,
					sourceSha,
				],
				{ encoding: "utf8" },
			);
		for (const valid of [runtime, fixture().runtime]) {
			await writeFile(input, JSON.stringify(valid));
			const result = run();
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.stdout, "");
		}
		for (const invalid of [
			{ ...runtime, schemaVersion: undefined },
			{ ...runtime, commitSha: "b".repeat(40) },
			{ ...runtime, platform: "linux/arm64" },
			{ ...fixture().runtime, images: {} },
			{ ...fixture().runtime, images: null },
			{
				...runtime,
				images: {
					runtimeHost: { repository: "credential-canary", digest: "latest" },
				},
			},
			null,
		]) {
			await writeFile(input, JSON.stringify(invalid));
			const result = run();
			assert.equal(result.status, 1);
			assert.equal(result.stdout, "");
			assert.equal(result.stderr, "ACK_EVIDENCE_VALIDATION_FAILED\n");
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("binding rejects duplicate components, duplicate runtime env and mutable init images", () => {
	for (const mutate of [
		(f) => f.documents.push(f.documents[0]),
		(f) =>
			f.documents[2].spec.template.spec.containers[0].env.push({
				name: "AGENT_INFRA_RUNTIME_IMAGE_DIGEST",
				value: digest,
			}),
		(f) => {
			f.documents[0].spec.template.spec.initContainers = [
				{ image: "registry.example/setup:latest" },
			];
		},
	]) {
		const f = fixture();
		mutate(f);
		assert.throws(() =>
			validateRenderedImages(f.render(), f.platform, f.runtime),
		);
	}
});

test("snapshot selects the exact release and does not emit secrets, names, IPs, annotations or messages", () => {
	const privateValue = "private-canary-not-for-output";
	const raw = {
		items: [
			{
				kind: "Pod",
				metadata: {
					name: privateValue,
					uid: privateValue,
					annotations: { privateValue },
				},
				spec: {
					nodeName: "192.0.2.1",
					containers: [
						{
							image: `registry.example/private@${digest}`,
							env: [{ name: "TOKEN", value: privateValue }],
						},
					],
				},
				status: {
					conditions: [
						{ type: "Ready", status: "True", message: privateValue },
					],
				},
			},
		],
	};
	const result = projectSnapshot(
		[
			{ name: "unrelated", revision: "77" },
			{ name: "target", revision: "2", description: privateValue },
		],
		raw,
		"target",
		privateValue,
		"a".repeat(40),
	);
	assert.equal(result.helmRevision, 2);
	assert.equal(result.resources[0].ready, true);
	assert.equal(result.businessVerified, false);
	const output = JSON.stringify(result);
	for (const forbidden of [
		privateValue,
		"192.0.2.1",
		"registry.example",
		digest,
		"TOKEN",
	])
		assert(!output.includes(forbidden));
	assert.throws(() => projectSnapshot([], {}, "target", "ns", "a".repeat(40)));
});

test("CLI refuses unavailable cluster evidence without retaining raw command errors", async () => {
	const bin = await mkdtemp(join(tmpdir(), "ack-snapshot-tools-"));
	await writeFile(join(bin, "helm"), "#!/bin/sh\nprintf '[]'\n", {
		mode: 0o700,
	});
	await writeFile(
		join(bin, "kubectl"),
		"#!/bin/sh\necho 'TOKEN=private-canary' >&2\nexit 1\n",
		{ mode: 0o700 },
	);
	const result = spawnSync(
		process.execPath,
		[
			join(import.meta.dirname, "../deploy/ack/redeploy-evidence.ts"),
			"snapshot",
			"test-ns",
			"test-release",
			"a".repeat(40),
		],
		{
			encoding: "utf8",
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		},
	);
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, "ACK_EVIDENCE_VALIDATION_FAILED\n");
});

test("plan consumes the original RuntimeHost artifact and rejects invalid input before touching the cluster", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ack-plan-"));
	try {
		const root = join(directory, "source");
		const bin = join(directory, "bin");
		await mkdir(join(root, "deploy/ack/chart"), { recursive: true });
		await mkdir(bin);
		for (const file of [
			"redeploy.sh",
			"redeploy-evidence.ts",
			"configuration-source-preflight.ts",
			"private-input.ts",
		])
			await copyFile(
				join(import.meta.dirname, "../deploy/ack", file),
				join(root, "deploy/ack", file),
			);
		await symlink(
			join(import.meta.dirname, "../node_modules"),
			join(root, "node_modules"),
		);
		await writeFile(join(root, ".gitignore"), "node_modules\n");
		await writeFile(join(root, "package.json"), '{"type":"module"}');
		const git = (args) =>
			execFileSync("git", args, {
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		git(["init", "--template=", "-q"]);
		git(["add", "."]);
		git([
			"-c",
			"user.name=fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-qm",
			"test fixture",
		]);
		const source = git(["rev-parse", "HEAD"]);
		const f = fixture();
		const platform = join(directory, "platform.json");
		const runtime = join(directory, "runtime-host.json");
		const values = join(directory, "values.yaml");
		const rendered = join(directory, "input-rendered.yaml");
		const log = join(directory, "cluster.log");
		const metadata = { ...provenance, commitSha: source };
		await writeFile(platform, JSON.stringify({ ...f.platform, ...metadata }));
		await writeFile(values, "{}");
		await writeFile(rendered, f.render());
		await writeFile(
			join(bin, "helm"),
			`#!/bin/sh
case "$1" in
template) cat "$ACK_TEST_RENDER";;
lint) exit 0;;
list) printf '[]';;
*) exit 1;;
esac
`,
			{ mode: 0o700 },
		);
		await writeFile(
			join(bin, "kubectl"),
			`#!/bin/sh
printf "called\\n" >> "$ACK_TEST_LOG"
if [ "$ACK_TEST_CLUSTER_FAIL" = 1 ]; then echo "TOKEN=private-canary" >&2; exit 1; fi
case " $* " in
*" version "*) printf '{"serverVersion":{"gitVersion":"v1.36.1"}}';;
*) printf '{"items":[]}';;
esac
`,
			{ mode: 0o700 },
		);
		const evidence = join(directory, "evidence");
		const run = (extra = {}, command = "plan") =>
			spawnSync("bash", ["deploy/ack/redeploy.sh", command], {
				cwd: root,
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					ACK_CHART_DIR: join(root, "deploy/ack/chart"),
					ACK_TEST_RENDER: rendered,
					ACK_TEST_LOG: log,
					ACK_KUBECONFIG: "/dev/null",
					ACK_VALUES_FILE: values,
					ACK_SOURCE_SHA: source,
					ACK_IMAGE_MANIFEST: platform,
					ACK_RUNTIME_IMAGE_MANIFEST: runtime,
					ACK_EVIDENCE_DIR: evidence,
					...extra,
				},
			});
		const published = {
			...metadata,
			images: { runtimeHost: { repository: f.runtime.repository, digest } },
		};
		const legacy = { ...metadata, repository: f.runtime.repository, digest };
		for (const valid of [published, legacy]) {
			await writeFile(runtime, JSON.stringify(valid));
			const result = run();
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /plan passed/);
			assert(!(await readdir(evidence)).includes("rendered.yaml"));
		}
		for (const invalid of [
			{ ...published, commitSha: "b".repeat(40) },
			{ ...published, schemaVersion: undefined },
			{ ...published, platform: "linux/arm64" },
			{ ...legacy, images: {} },
		]) {
			await rm(log, { force: true });
			await writeFile(runtime, JSON.stringify(invalid));
			const result = run();
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /ACK_RUNTIME_IMAGE_MANIFEST does not match/);
			assert(!(await readdir(directory)).includes("cluster.log"));
		}
		await writeFile(runtime, JSON.stringify(published));
		const bootstrap = join(directory, "bootstrap.json");
		const templatesFile = join(directory, "templates.json");
		const workerConfig = join(directory, "worker.mjs");
		const apiConfig = join(directory, "api.mjs");
		await writeFile(workerConfig, "private-config-sentinel", { mode: 0o600 });
		await writeFile(apiConfig, "private-config-sentinel", { mode: 0o600 });
		await writeFile(
			bootstrap,
			JSON.stringify({
				schemaVersion: 1,
				objects: [
					{
						kind: "Secret",
						name: "agent-infra-worker-configuration",
						files: { "configuration.mjs": workerConfig },
					},
					{
						kind: "Secret",
						name: "agent-infra-api-configuration",
						files: { "configuration.mjs": apiConfig },
					},
				],
			}),
			{ mode: 0o600 },
		);
		await writeFile(
			templatesFile,
			JSON.stringify({
				...metadata,
				images: Object.fromEntries(
					["codex", "claude", "opencode", "pi"].map((id) => [id, { digest }]),
				),
			}),
			{ mode: 0o600 },
		);
		await chmod(runtime, 0o600);
		const invalidConfiguration = run({
			ACK_BOOTSTRAP_INPUTS_FILE: bootstrap,
			ACK_TEMPLATE_IMAGE_MANIFEST: templatesFile,
		});
		assert.notEqual(invalidConfiguration.status, 0);
		assert.equal(
			JSON.parse(
				await readFile(join(evidence, "configuration-source-preflight.json")),
			).failureCode,
			"CONFIG_RUNTIME_DIGEST_MISMATCH",
		);
		assert(!invalidConfiguration.stderr.includes("private-config-sentinel"));
		const missingTemplateManifest = run({
			ACK_BOOTSTRAP_INPUTS_FILE: bootstrap,
			ACK_TEMPLATE_IMAGE_MANIFEST: "",
		});
		assert.notEqual(missingTemplateManifest.status, 0);
		assert.match(missingTemplateManifest.stderr, /ACK_TEMPLATE_IMAGE_MANIFEST/);
		await rm(log, { force: true });
		const rejectedAll = run(
			{
				ACK_BOOTSTRAP_INPUTS_FILE: bootstrap,
				ACK_TEMPLATE_IMAGE_MANIFEST: templatesFile,
				ACK_LOGIN_BOOTSTRAP_FILE: bootstrap,
				ACK_WORKLOAD_CAPACITY_FILE: bootstrap,
			},
			"all",
		);
		assert.notEqual(rejectedAll.status, 0);
		assert.equal(
			JSON.parse(
				await readFile(join(evidence, "configuration-source-preflight.json")),
			).failureCode,
			"CONFIG_RUNTIME_DIGEST_MISMATCH",
		);
		assert(
			!(await readdir(directory)).includes("cluster.log"),
			"all must reject configuration before any cluster call",
		);
		const failure = run({ ACK_TEST_CLUSTER_FAIL: "1" });
		assert.notEqual(failure.status, 0);
		assert.match(failure.stderr, /ACK_CLUSTER_VERSION_READ_FAILED/);
		assert(!failure.stdout.includes("plan passed"));
		assert(!failure.stderr.includes("private-canary"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("plan/deploy snapshots distinguish rendered targets from observed replica counts", () => {
	const f = fixture();
	f.documents[1].spec.replicas = 2;
	const live = structuredClone(f.documents[1]);
	live.spec.replicas = 1;
	live.metadata.generation = 4;
	live.status = {
		replicas: 1,
		updatedReplicas: 0,
		availableReplicas: 1,
		readyReplicas: 1,
		observedGeneration: 3,
	};
	const result = projectSnapshot(
		[],
		{ items: [live] },
		"target",
		"test",
		sourceSha,
		f.render(),
	);
	assert.deepEqual(result.apiReplicas, {
		desired: 2,
		declared: 1,
		observed: 1,
		updated: 0,
		available: 1,
		ready: 1,
		generation: 4,
		observedGeneration: 3,
	});
	const fresh = projectSnapshot(
		[],
		{ items: [] },
		"target",
		"test",
		sourceSha,
		f.render(),
	);
	assert.equal(fresh.apiReplicas.desired, 2);
	assert.equal(fresh.apiReplicas.observed, null);
	assert.equal(fresh.apiReplicas.ready, null);
});
