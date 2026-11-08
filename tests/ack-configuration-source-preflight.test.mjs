import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { validateConfigurationSourceBindings } from "../deploy/ack/configuration-source-preflight.ts";

const sourceSha = "a".repeat(40);
const digests = {
	codex: `sha256:${"1".repeat(64)}`,
	claude: `sha256:${"2".repeat(64)}`,
	opencode: `sha256:${"3".repeat(64)}`,
	pi: `sha256:${"4".repeat(64)}`,
};

async function fixture(t, versioned = false) {
	const root = await mkdtemp(join(tmpdir(), "ack-config-source-"));
	t.after(() =>
		import("node:fs/promises").then(({ rm }) =>
			rm(root, { recursive: true, force: true }),
		),
	);
	const save = async (name, value) => {
		const file = join(root, name);
		await writeFile(
			file,
			typeof value === "string" ? value : JSON.stringify(value),
			{ mode: 0o600 },
		);
		return file;
	};
	const templateBindings = Object.values(digests)
		.map(
			(digest, index) =>
				`{"templateId":"${Object.keys(digests)[index]}","imageDigest":"${digest}"}`,
		)
		.join(",");
	const worker = await save(
		"worker.mjs",
		`const runtimeDigest=process.env.AGENT_INFRA_RUNTIME_IMAGE_DIGEST;if(runtimeDigest!=="${`sha256:${"9".repeat(64)}`}")throw Error();const templateModelBindings:[${templateBindings}],`,
	);
	const api = await save("api.mjs", `const templates: [${templateBindings}],`);
	const secretNames = Object.fromEntries(
		["api", "worker"].map((component) => [
			component,
			`agent-infra-${component}-configuration${versioned ? "-release-v2" : ""}`,
		]),
	);
	const documents = ["api", "worker"].map((component) => ({
		kind: "Deployment",
		metadata: { name: `agent-infra-${component}` },
		spec: {
			template: {
				spec: {
					containers: [
						{
							name: `platform-${component}`,
							env: [
								{
									name:
										component === "api"
											? "PLATFORM_API_CONFIGURATION_MODULE"
											: "PLATFORM_WORKER_DEPLOYMENT_MODULE",
									value:
										component === "api"
											? "file:///app/deployment/configuration.mjs"
											: "file:///app/dist/deployment.mjs",
								},
							],
							volumeMounts:
								component === "api"
									? [
											{
												name: "configuration",
												mountPath: "/app/deployment",
												readOnly: true,
											},
										]
									: [
											{
												name: "configuration",
												mountPath: "/app/dist/configuration.mjs",
												subPath: "configuration.mjs",
												readOnly: true,
											},
										],
						},
					],
					volumes: [
						{
							name: "configuration",
							secret: { secretName: secretNames[component] },
						},
					],
				},
			},
		},
	}));
	const render = () =>
		documents.map((document) => stringify(document)).join("---\n");
	const bootstrap = await save("bootstrap.json", {
		schemaVersion: 1,
		objects: [
			{
				kind: "Secret",
				name: secretNames.worker,
				files: { "configuration.mjs": worker },
			},
			{
				kind: "Secret",
				name: secretNames.api,
				files: { "configuration.mjs": api },
			},
		],
	});
	const runtime = await save("runtime.json", {
		schemaVersion: 1,
		commitSha: sourceSha,
		platform: "linux/amd64",
		images: {
			runtimeHost: {
				repository: "runtime",
				digest: `sha256:${"9".repeat(64)}`,
			},
		},
	});
	const templates = await save("templates.json", {
		schemaVersion: 1,
		commitSha: sourceSha,
		platform: "linux/amd64",
		images: Object.fromEntries(
			Object.entries(digests).map(([key, digest]) => [
				key,
				{ repository: key, digest },
			]),
		),
	});
	return {
		root,
		bootstrap,
		runtime,
		templates,
		worker,
		api,
		documents,
		render,
	};
}

test("source configuration preflight accepts active runtime/template bindings", async (t) => {
	const f = await fixture(t);
	const receipt = await validateConfigurationSourceBindings(
		f.bootstrap,
		f.runtime,
		f.templates,
		sourceSha,
		f.render(),
	);
	assert.equal(receipt.status, "passed");
	assert.equal(receipt.templateCount, 4);
});

test("source configuration preflight accepts versioned Secrets from the rendered consumers", async (t) => {
	const f = await fixture(t, true);
	const receipt = await validateConfigurationSourceBindings(
		f.bootstrap,
		f.runtime,
		f.templates,
		sourceSha,
		f.render(),
	);
	assert.equal(receipt.status, "passed");
});

for (const missingEntrypoint of [false, true]) {
	test(`source configuration preflight checks directory mounted worker entrypoint (missing=${missingEntrypoint})`, async (t) => {
		const f = await fixture(t, true);
		const container = f.documents[1].spec.template.spec.containers[0];
		container.env[0].value = "file:///app/deployment/deployment.mjs";
		container.volumeMounts = [
			{ name: "configuration", mountPath: "/app/deployment", readOnly: true },
		];
		if (!missingEntrypoint) {
			const deployment = join(f.root, "deployment.mjs");
			await writeFile(deployment, 'export * from "./configuration.mjs";', {
				mode: 0o600,
			});
			const bootstrap = JSON.parse(await readFile(f.bootstrap, "utf8"));
			bootstrap.objects[0].files["deployment.mjs"] = deployment;
			await writeFile(f.bootstrap, JSON.stringify(bootstrap), { mode: 0o600 });
		}
		const receipt = await validateConfigurationSourceBindings(
			f.bootstrap,
			f.runtime,
			f.templates,
			sourceSha,
			f.render(),
		);
		assert.equal(receipt.status, missingEntrypoint ? "failed" : "passed");
		if (missingEntrypoint)
			assert.equal(receipt.failureCode, "CONFIG_SOURCE_INPUT_INVALID");
	});
}

test("source configuration preflight rejects a RuntimeHost digest drift", async (t) => {
	const f = await fixture(t, true);
	const changed = await readFile(f.worker, "utf8");
	await writeFile(
		f.worker,
		changed.replace(`sha256:${"9".repeat(64)}`, `sha256:${"8".repeat(64)}`),
		{ mode: 0o600 },
	);
	const receipt = await validateConfigurationSourceBindings(
		f.bootstrap,
		f.runtime,
		f.templates,
		sourceSha,
		f.render(),
	);
	assert.equal(receipt.status, "failed");
	assert.equal(receipt.failureCode, "CONFIG_RUNTIME_DIGEST_MISMATCH");
});

test("source configuration preflight rejects an active template digest drift", async (t) => {
	const f = await fixture(t, true);
	const bootstrap = JSON.parse(await readFile(f.bootstrap, "utf8"));
	const decoy = join(f.root, "decoy.mjs");
	await writeFile(decoy, await readFile(f.api), { mode: 0o600 });
	bootstrap.objects.push({
		kind: "Secret",
		name: "agent-infra-api-configuration",
		files: { "configuration.mjs": decoy },
	});
	await writeFile(f.bootstrap, JSON.stringify(bootstrap), { mode: 0o600 });
	const api = await readFile(f.api, "utf8");
	await writeFile(f.api, api.replace(digests.pi, `sha256:${"8".repeat(64)}`), {
		mode: 0o600,
	});
	const receipt = await validateConfigurationSourceBindings(
		f.bootstrap,
		f.runtime,
		f.templates,
		sourceSha,
		f.render(),
	);
	assert.equal(receipt.status, "failed");
	assert.equal(receipt.failureCode, "CONFIG_TEMPLATE_DIGEST_MISMATCH");
});

test("source configuration preflight rejects an API RuntimeHost reference drift", async (t) => {
	const f = await fixture(t);
	const api = await readFile(f.api, "utf8");
	await writeFile(
		f.api,
		`${api}\nconst runtimeHost = "ghcr.io/example/agent-runtime-host@sha256:${"8".repeat(64)}";\n`,
		{ mode: 0o600 },
	);
	const receipt = await validateConfigurationSourceBindings(
		f.bootstrap,
		f.runtime,
		f.templates,
		sourceSha,
		f.render(),
	);
	assert.equal(receipt.status, "failed");
	assert.equal(receipt.failureCode, "CONFIG_RUNTIME_DIGEST_MISMATCH");
});

for (const [name, change] of [
	["missing consumer", (f) => f.documents.pop()],
	[
		"duplicate consumer",
		(f) => f.documents.push(structuredClone(f.documents[0])),
	],
	[
		"wrong module path",
		(f) => {
			f.documents[0].spec.template.spec.containers[0].env[0].value =
				"file:///app/other/entry.mjs";
		},
	],
	[
		"duplicate module environment",
		(f) => {
			const c = f.documents[0].spec.template.spec.containers[0];
			c.env.push({ ...c.env[0] });
		},
	],
	[
		"writable mount",
		(f) => {
			f.documents[0].spec.template.spec.containers[0].volumeMounts[0].readOnly = false;
		},
	],
	[
		"overlapping mount",
		(f) => {
			f.documents[0].spec.template.spec.containers[0].volumeMounts.push({
				name: "other",
				mountPath: "/app/deployment/configuration.mjs",
			});
		},
	],
	[
		"subPath mount",
		(f) => {
			f.documents[0].spec.template.spec.containers[0].volumeMounts[0].subPath =
				"other";
		},
	],
	[
		"remapped Secret keys",
		(f) => {
			f.documents[0].spec.template.spec.volumes[0].secret.items = [
				{ key: "other.mjs", path: "configuration.mjs" },
			];
		},
	],
	[
		"unbound Secret",
		(f) => {
			f.documents[0].spec.template.spec.volumes[0].secret.secretName =
				"not-in-bootstrap";
		},
	],
]) {
	test(`source configuration preflight rejects ${name}`, async (t) => {
		const f = await fixture(t, true);
		change(f);
		const receipt = await validateConfigurationSourceBindings(
			f.bootstrap,
			f.runtime,
			f.templates,
			sourceSha,
			f.render(),
		);
		assert.equal(receipt.status, "failed");
		assert.equal(receipt.failureCode, "CONFIG_SOURCE_INPUT_INVALID");
	});
}

for (const [component, entry] of [
	["api", "wrong.mjs"],
	["worker", "configuration.mjs"],
]) {
	test(`source configuration preflight rejects wrong ${component} entry basename`, async (t) => {
		const f = await fixture(t, true);
		const index = component === "api" ? 0 : 1;
		const container = f.documents[index].spec.template.spec.containers[0];
		container.env[0].value =
			component === "api"
				? `file:///app/deployment/${entry}`
				: `file:///app/dist/${entry}`;
		const receipt = await validateConfigurationSourceBindings(
			f.bootstrap,
			f.runtime,
			f.templates,
			sourceSha,
			f.render(),
		);
		assert.equal(receipt.status, "failed");
		assert.equal(receipt.failureCode, "CONFIG_SOURCE_INPUT_INVALID");
	});
}
