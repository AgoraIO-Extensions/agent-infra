import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
	assertCleanRuntimeProbeSource,
	probeRuntimeImage,
	runtimeImageFromScanBuild,
	validateRuntimeProbe,
} from "../deploy/release/runtime-probe.mjs";

const root = resolve(import.meta.dirname, "..");
const releasePath = "packages/agent-runtime/src/codex-release.json";
const releaseBytes = await readFile(join(root, releasePath));
const release = JSON.parse(releaseBytes);
const sha256 = (value) =>
	`sha256:${createHash("sha256").update(value).digest("hex")}`;
const installation = (architecture) => ({
	platform: "linux",
	architecture,
	releaseSha256: sha256(releaseBytes),
	archiveSha256: release.artifacts[architecture].archiveSha256,
	executableSha256: release.artifacts[architecture].executableSha256,
});
const evidence = {
	schemaVersion: 1,
	status: "passed",
	capability: "official-model-only",
	codexVersion: release.provenance.codexVersion,
	installation: installation("amd64"),
	configurationSchemaVersion: 2,
	configVersion: "synthetic-active-v2",
	checks: [
		"configuration-fail-closed",
		"native-active-default-model",
		"native-execution-selection",
		"submit-idempotency",
		"selection-conflict",
		"grant-and-agent-binding",
		"persistent-runtime-restart",
		"http-failures-redacted",
		"stream-failures-redacted",
		"cancellation-aborts-upstream",
		"native-shell-rejected-without-side-effects",
		"native-apply-patch-rejected-without-side-effects",
		"recursive-native-storage-redacted",
		"personal-configuration-isolated",
	],
};

test("runtime image evidence requires the complete pinned native probe", () => {
	assert.deepEqual(
		validateRuntimeProbe(evidence, releaseBytes, "amd64"),
		evidence,
	);
	for (const value of [
		null,
		{},
		{ ...evidence, status: "failed" },
		{ ...evidence, capability: undefined },
		{ ...evidence, capability: "private-native-tools" },
		{
			...evidence,
			checks: evidence.checks.map((check) =>
				check === "native-shell-rejected-without-side-effects"
					? "native-sandboxed-tool-execution"
					: check,
			),
		},
		{ ...evidence, codexVersion: "other" },
		{ ...evidence, configurationSchemaVersion: 1 },
		{ ...evidence, checks: ["healthz"] },
		{ ...evidence, checks: [...evidence.checks.slice(1), evidence.checks[1]] },
		{ ...evidence, rawOutput: "synthetic-private-value" },
	])
		assert.throws(
			() => validateRuntimeProbe(value, releaseBytes, "amd64"),
			/evidence is invalid/,
		);
});

test("runtime probe refuses evidence from a dirty checkout", () => {
	const commitSha = "1".repeat(40);
	assert.deepEqual(assertCleanRuntimeProbeSource("", commitSha), {
		commitSha,
		sourceDirty: false,
	});
	assert.throws(
		() =>
			assertCleanRuntimeProbeSource(
				" M packages/agent-runtime/src/index.ts",
				commitSha,
			),
		/requires a clean checkout/,
	);
	assert.throws(
		() => assertCleanRuntimeProbeSource("", "not-a-commit"),
		/source is invalid/,
	);
});

test("runtime probe selects the scanner's exact current-commit image", () => {
	const commit = "1".repeat(40);
	const image = {
		name: "agent-runtime-host",
		imageId: `sha256:${"a".repeat(64)}`,
	};
	const build = { schemaVersion: 1, source: { commit }, images: [image] };
	assert.equal(runtimeImageFromScanBuild(build, commit), image.imageId);
	for (const value of [
		null,
		{ ...build, images: {} },
		{ ...build, source: { commit: "2".repeat(40) } },
		{ ...build, images: [] },
		{ ...build, images: [image, image] },
		{ ...build, images: [{ ...image, imageId: "mutable:tag" }] },
	])
		assert.throws(
			() => runtimeImageFromScanBuild(value, commit),
			/reference is invalid/,
		);
});

test("runtime evidence binds the exact official release bytes and installed architecture", () => {
	for (const architecture of ["amd64", "arm64"]) {
		const value = { ...evidence, installation: installation(architecture) };
		assert.deepEqual(
			validateRuntimeProbe(value, releaseBytes, architecture),
			value,
		);
		for (const field of [
			"releaseSha256",
			"archiveSha256",
			"executableSha256",
		]) {
			assert.throws(
				() =>
					validateRuntimeProbe(
						{
							...value,
							installation: {
								...value.installation,
								[field]: `sha256:${"0".repeat(64)}`,
							},
						},
						releaseBytes,
						architecture,
					),
				/evidence is invalid/,
			);
		}
	}
	for (const value of [
		{ ...evidence, installation: undefined },
		{
			...evidence,
			installation: { ...installation("amd64"), architecture: "arm64" },
		},
		{
			...evidence,
			installation: { ...installation("amd64"), platform: "darwin" },
		},
		{
			...evidence,
			installation: { ...installation("amd64"), buildId: "retired" },
		},
	])
		assert.throws(
			() => validateRuntimeProbe(value, releaseBytes, "amd64"),
			/evidence is invalid/,
		);
	const updatedRelease = {
		...release,
		provenance: {
			...release.provenance,
			codexVersion: "0.154.0",
			upstreamTag: "rust-v0.154.0",
		},
	};
	const updatedBytes = Buffer.from(JSON.stringify(updatedRelease));
	const updatedEvidence = {
		...evidence,
		codexVersion: updatedRelease.provenance.codexVersion,
		installation: {
			...installation("amd64"),
			releaseSha256: sha256(updatedBytes),
		},
	};
	assert.deepEqual(
		validateRuntimeProbe(updatedEvidence, updatedBytes, "amd64"),
		updatedEvidence,
	);
	assert.throws(
		() => validateRuntimeProbe(updatedEvidence, releaseBytes, "amd64"),
		/evidence is invalid/,
	);
	const reformatted = Buffer.from(JSON.stringify(release));
	assert.notEqual(sha256(reformatted), sha256(releaseBytes));
	assert.throws(
		() => validateRuntimeProbe(evidence, reformatted, "amd64"),
		/evidence is invalid/,
	);
	assert.throws(
		() => validateRuntimeProbe(evidence, releaseBytes, "unsupported"),
		/evidence is invalid/,
	);
	for (const invalid of [
		"not-json",
		JSON.stringify({ ...release, distribution: { kind: "derived" } }),
		JSON.stringify({
			...release,
			artifacts: {
				...release.artifacts,
				amd64: { ...release.artifacts.amd64, archiveSha256: "untrusted" },
			},
		}),
		JSON.stringify({
			...release,
			provenance: { ...release.provenance, upstreamCommit: "mutable" },
		}),
	])
		assert.throws(
			() => validateRuntimeProbe(evidence, Buffer.from(invalid), "amd64"),
			/evidence is invalid/,
		);
});

async function fixture(t, mutation = "none") {
	const directory = await mkdtemp(join(tmpdir(), "runtime-evidence-727-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await mkdir(join(directory, "packages/agent-runtime/src"), {
		recursive: true,
	});
	await writeFile(join(directory, releasePath), releaseBytes);
	const commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	const sourceTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	const docker = join(directory, "docker.mjs");
	const imageId = `sha256:${"a".repeat(64)}`;
	const imageDigest = `sha256:${"b".repeat(64)}`;
	await writeFile(
		docker,
		`#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const mutation = ${JSON.stringify(mutation)};
const inspection = ${JSON.stringify({ Id: imageId, Architecture: "amd64", Os: "linux", Config: { Labels: { "org.opencontainers.image.revision": commitSha } }, Descriptor: { digest: imageDigest } })};
const marker = ${JSON.stringify(join(directory, "probed"))};
if (args[0] === "image") {
 if (mutation === "wrong-arch") inspection.Architecture = "arm64";
 if (mutation === "wrong-os") inspection.Os = "windows";
 if (mutation === "image-drift" && existsSync(marker)) inspection.Id = "sha256:" + "c".repeat(64);
 if (mutation === "digest-drift" && existsSync(marker)) inspection.Descriptor.digest = "sha256:" + "c".repeat(64);
 if (mutation === "source-drift" && existsSync(marker)) inspection.Config.Labels["org.opencontainers.image.revision"] = "3".repeat(40);
 console.log(JSON.stringify(inspection));
} else if (args[0] === "run") {
 appendFileSync(${JSON.stringify(join(directory, "calls.jsonl"))}, JSON.stringify(args) + "\\n");
 writeFileSync(marker, "done");
 if (mutation === "pin-drift") appendFileSync(${JSON.stringify(join(directory, releasePath))}, " ");
 if (args.includes("--provenance-rejection")) console.log(JSON.stringify({status:"passed",check:"provenance-fail-closed"}));
 else console.log(JSON.stringify(${JSON.stringify(evidence)}));
} else process.exit(1);
`,
	);
	await chmod(docker, 0o755);
	const environment = process.env;
	const previous = environment.DOCKER_BIN;
	environment.DOCKER_BIN = docker;
	t.after(() => {
		if (previous === undefined) delete environment.DOCKER_BIN;
		else environment.DOCKER_BIN = previous;
	});
	return {
		directory,
		sourceTree,
		imageId,
		imageDigest,
		options: {
			image: "synthetic:probe",
			source: { commitSha, sourceDirty: false },
			imageDigest,
			contextPath: directory,
		},
	};
}

test("probe retains inspected image and Git tree identity with the complete official pin", async (t) => {
	const f = await fixture(t);
	const result = await probeRuntimeImage(f.options);
	assert.equal(result.sourceTree, f.sourceTree);
	assert.equal(result.imageId, f.imageId);
	assert.equal(result.imageDigest, f.imageDigest);
	assert.deepEqual(result.probe.installation, installation("amd64"));
	const calls = (await readFile(join(f.directory, "calls.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map(JSON.parse);
	assert.equal(calls.length, 2);
	assert.ok(calls[1].includes("--provenance-rejection"));
	for (const args of calls) {
		assert.ok(args.includes("--read-only"));
		assert.ok(args.includes("--network=none"));
		assert.ok(args.includes(f.imageId));
	}
});
for (const [mutation, expected] of [
	["wrong-arch", /HTTP\/SSE image probe failed/],
	["wrong-os", /platform is invalid/],
	["image-drift", /changed during probe/],
	["digest-drift", /changed during probe/],
	["source-drift", /changed during probe/],
	["pin-drift", /release changed during probe/],
])
	test(`probe rejects ${mutation}`, async (t) => {
		const f = await fixture(t, mutation);
		await assert.rejects(probeRuntimeImage(f.options), expected);
	});
test("probe refuses a context pin that differs from the inspected source commit", async (t) => {
	const f = await fixture(t);
	await writeFile(
		join(f.directory, releasePath),
		Buffer.concat([releaseBytes, Buffer.from(" ")]),
	);
	await assert.rejects(
		probeRuntimeImage(f.options),
		/release.*source|source.*release/,
	);
	await assert.rejects(readFile(join(f.directory, "calls.jsonl")), {
		code: "ENOENT",
	});
});
