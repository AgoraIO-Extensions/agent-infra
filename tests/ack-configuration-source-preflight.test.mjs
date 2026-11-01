import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateConfigurationSourceBindings } from "../deploy/ack/configuration-source-preflight.ts";

const sourceSha = "a".repeat(40);
const digests = {
	codex: `sha256:${"1".repeat(64)}`,
	claude: `sha256:${"2".repeat(64)}`,
	opencode: `sha256:${"3".repeat(64)}`,
	pi: `sha256:${"4".repeat(64)}`,
};

async function fixture(t, { custom = true, apiEntrypointEnabled = true } = {}) {
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
	const customDigest = `sha256:${"5".repeat(64)}`;
	const worker = await save(
		"worker.mjs",
		`const runtimeDigest=process.env.AGENT_INFRA_RUNTIME_IMAGE_DIGEST;if(runtimeDigest!=="${`sha256:${"9".repeat(64)}`}")throw Error();const templateModelBindings:[${templateBindings}],`,
	);
	if (custom)
		await writeFile(
			worker,
			`${await readFile(worker, "utf8")}const customDigests=["${customDigest}"];\n`,
			{ mode: 0o600 },
		);
	const api = await save("api.mjs", `const templates: [${templateBindings}],`);
	const apiEntrypoint = apiEntrypointEnabled
		? await save(
				"api-entrypoint.mjs",
				`const customDigests=["${customDigest}"];`,
			)
		: undefined;
	const bootstrap = await save("bootstrap.json", {
		schemaVersion: 1,
		objects: [
			{
				kind: "Secret",
				name: "agent-infra-worker-configuration",
				files: { "configuration.mjs": worker },
			},
			{
				kind: "Secret",
				name: "agent-infra-api-configuration",
				files: {
					"configuration.mjs": api,
					...(apiEntrypoint ? { "api-configuration.mjs": apiEntrypoint } : {}),
				},
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
		apiEntrypoint,
		customDigest,
	};
}

test("source configuration preflight accepts active runtime/template bindings", async (t) => {
	const f = await fixture(t);
	const receipt = await validateConfigurationSourceBindings(
		f.bootstrap,
		f.runtime,
		f.templates,
		sourceSha,
	);
	assert.equal(receipt.status, "passed");
	assert.equal(receipt.templateCount, 4);
});

test("source configuration preflight rejects a RuntimeHost digest drift", async (t) => {
	const f = await fixture(t);
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
	);
	assert.equal(receipt.status, "failed");
	assert.equal(receipt.failureCode, "CONFIG_RUNTIME_DIGEST_MISMATCH");
});

test("source configuration preflight rejects an active template digest drift", async (t) => {
	const f = await fixture(t);
	const api = await readFile(f.api, "utf8");
	await writeFile(f.api, api.replace(digests.pi, `sha256:${"8".repeat(64)}`), {
		mode: 0o600,
	});
	const receipt = await validateConfigurationSourceBindings(
		f.bootstrap,
		f.runtime,
		f.templates,
		sourceSha,
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
	);
	assert.equal(receipt.status, "failed");
	assert.equal(receipt.failureCode, "CONFIG_RUNTIME_DIGEST_MISMATCH");
});

test("source configuration preflight rejects stale API custom admission digests", async (t) => {
	const f = await fixture(t);
	await writeFile(f.apiEntrypoint, "const customDigests=[];\n", {
		mode: 0o600,
	});
	const receipt = await validateConfigurationSourceBindings(
		f.bootstrap,
		f.runtime,
		f.templates,
		sourceSha,
	);
	assert.equal(receipt.status, "failed");
	assert.equal(receipt.failureCode, "CONFIG_CUSTOM_DIGEST_MISMATCH");
});

test("source configuration preflight rejects API custom admission extras", async (t) => {
	const f = await fixture(t);
	await writeFile(
		f.apiEntrypoint,
		`const customDigests=["${f.customDigest}","sha256:${"6".repeat(64)}"];\n`,
		{ mode: 0o600 },
	);
	const receipt = await validateConfigurationSourceBindings(
		f.bootstrap,
		f.runtime,
		f.templates,
		sourceSha,
	);
	assert.equal(receipt.status, "failed");
	assert.equal(receipt.failureCode, "CONFIG_CUSTOM_DIGEST_MISMATCH");
});

test("source configuration preflight accepts legacy inputs without custom admission", async (t) => {
	const f = await fixture(t, { custom: false, apiEntrypointEnabled: false });
	const receipt = await validateConfigurationSourceBindings(
		f.bootstrap,
		f.runtime,
		f.templates,
		sourceSha,
	);
	assert.equal(receipt.status, "passed");
});

test("source configuration preflight rejects a missing API entrypoint when Worker admits custom images", async (t) => {
	const f = await fixture(t, { apiEntrypointEnabled: false });
	const receipt = await validateConfigurationSourceBindings(
		f.bootstrap,
		f.runtime,
		f.templates,
		sourceSha,
	);
	assert.equal(receipt.status, "failed");
	assert.equal(receipt.failureCode, "CONFIG_CUSTOM_DIGEST_MISMATCH");
});
