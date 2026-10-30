import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
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
const pairs = [
	["web", "agent-infra-web"],
	["platformApi", "agent-infra-api"],
	["platformWorker", "agent-infra-worker"],
	["enterpriseDirectorySync", "agent-infra-directory"],
];
function fixture() {
	const platform = {
		images: Object.fromEntries(
			pairs.map(([key]) => [
				key,
				{ repository: `registry.example/${key.toLowerCase()}`, digest },
			]),
		),
	};
	const runtime = { repository: "registry.example/runtime", digest };
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
	assert.deepEqual(normalizeRuntimeImageManifest(published), {
		schemaVersion: 1,
		commitSha: "a".repeat(40),
		platform: "linux/amd64",
		...f.runtime,
	});
	assert.throws(() =>
		normalizeRuntimeImageManifest({ ...published, platform: "linux/arm64" }),
	);
	assert.throws(() =>
		normalizeRuntimeImageManifest({
			...published,
			images: {
				runtimeHost: { repository: f.runtime.repository, digest: "latest" },
			},
		}),
	);
	assert.throws(() =>
		normalizeRuntimeImageManifest({ ...published, images: {} }),
	);
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

test("plan does not report success on cluster failure or retain raw rendered values as evidence", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ack-plan-"));
	const f = fixture();
	const root = join(import.meta.dirname, "..");
	const source = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	const platform = join(directory, "platform.json");
	const runtime = join(directory, "runtime.json");
	const values = join(directory, "values.yaml");
	const rendered = join(directory, "input-rendered.yaml");
	await writeFile(
		platform,
		JSON.stringify({
			...f.platform,
			schemaVersion: 1,
			commitSha: source,
			platform: "linux/amd64",
		}),
	);
	await writeFile(
		runtime,
		JSON.stringify({
			schemaVersion: 1,
			commitSha: source,
			platform: "linux/amd64",
			images: { runtimeHost: f.runtime },
		}),
	);
	await writeFile(values, "{}");
	await writeFile(rendered, f.render());
	await writeFile(
		join(directory, "helm"),
		'#!/bin/sh\ncase "$1" in\ntemplate) /bin/cat "$ACK_TEST_RENDER";;\nlint) exit 0;;\n*) echo "TOKEN=private-canary" >&2; exit 1;;\nesac\n',
		{ mode: 0o700 },
	);
	const evidence = join(directory, "evidence");
	const result = spawnSync("bash", ["deploy/ack/redeploy.sh", "plan"], {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${directory}:${process.env.PATH}`,
			ACK_TEST_RENDER: rendered,
			ACK_KUBECONFIG: "/dev/null",
			ACK_VALUES_FILE: values,
			ACK_SOURCE_SHA: source,
			ACK_IMAGE_MANIFEST: platform,
			ACK_RUNTIME_IMAGE_MANIFEST: runtime,
			ACK_EVIDENCE_DIR: evidence,
		},
	});
	assert.notEqual(result.status, 0);
	assert(!result.stdout.includes("plan passed"));
	assert(!result.stderr.includes("private-canary"));
	let entries = [];
	try {
		entries = await readdir(evidence);
	} catch (error) {
		assert.equal(error.code, "ENOENT");
	}
	assert(!entries.includes("rendered.yaml"));
});
