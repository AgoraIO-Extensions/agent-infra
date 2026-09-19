import assert from "node:assert/strict";
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
import { join } from "node:path";
import test from "node:test";

import {
	assertCleanRuntimeProbeSource,
	probeRuntimeImage,
	runtimeImageFromScanBuild,
	validateRuntimeProbe,
} from "../deploy/release/runtime-probe.mjs";

const provenance = {
	protocolVersion: 2,
	codexVersion: "0.153.0",
	upstreamTag: "rust-v0.153.0",
	upstreamCommit: "1".repeat(40),
	schemaSha256: `sha256:${"2".repeat(64)}`,
};
const officialReleaseBytes = Buffer.from(JSON.stringify({ provenance }));
const sha256 = (bytes) =>
	`sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const evidence = {
	schemaVersion: 1,
	status: "passed",
	codexVersion: "0.153.0",
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
		"native-sandboxed-tool-execution",
		"native-sibling-conversation-denied",
		"recursive-native-storage-redacted",
		"personal-configuration-isolated",
	],
};

test("runtime image evidence requires the complete pinned native probe", () => {
	assert.deepEqual(
		validateRuntimeProbe(evidence, officialReleaseBytes),
		evidence,
	);
	for (const value of [
		null,
		{},
		{ ...evidence, status: "failed" },
		{ ...evidence, codexVersion: "other" },
		{ ...evidence, configurationSchemaVersion: 1 },
		{ ...evidence, checks: ["healthz"] },
		{ ...evidence, checks: [...evidence.checks.slice(1), evidence.checks[1]] },
		{ ...evidence, rawOutput: "synthetic-private-value" },
	])
		assert.throws(
			() => validateRuntimeProbe(value, officialReleaseBytes),
			/evidence is invalid/,
		);
});

async function derivedFixture(directory) {
	const binaries = {};
	for (const name of [
		"codex",
		"codex-code-mode-host",
		"codex-responses-api-proxy",
		"bwrap",
	]) {
		const path = join(directory, name);
		await writeFile(path, `synthetic installed ${name} bytes\n`);
		binaries[name] = sha256(await readFile(path));
	}
	const candidatePath = join(directory, "candidate.json");
	await writeFile(candidatePath, `${JSON.stringify({ binaries })}\n`);
	const candidateManifestSha256 = sha256(await readFile(candidatePath));
	const release = {
		schemaVersion: 2,
		provenance,
		distribution: {
			kind: "derived",
			buildId: "synthetic-derived-build",
			sourceTree: "3".repeat(40),
			buildInputSha256: sha256("synthetic build input"),
		},
		artifacts: {
			arm64: {
				target: "aarch64-unknown-linux-musl",
				archiveSha256: sha256("synthetic archive"),
				candidateManifestSha256,
				executableSha256: binaries.codex,
				binaries,
			},
		},
	};
	const sourceDirectory = join(directory, "packages/agent-runtime/src");
	await mkdir(sourceDirectory, { recursive: true });
	const releasePath = join(sourceDirectory, "codex-release.json");
	await writeFile(releasePath, `${JSON.stringify(release, null, 2)}\n`);
	const releaseBytes = await readFile(releasePath);
	const report = {
		...evidence,
		schemaVersion: 2,
		protocolVersion: provenance.protocolVersion,
		distribution: {
			...release.distribution,
			target: release.artifacts.arm64.target,
			releaseSha256: sha256(releaseBytes),
			candidateManifestSha256,
			binaries,
		},
	};
	return { release, releasePath, releaseBytes, report, candidatePath };
}

test("derived evidence binds source pin, raw manifests and every installed binary", async () => {
	const directory = await mkdtemp(join(tmpdir(), "codex-derived-evidence-"));
	try {
		const { releaseBytes, report, candidatePath } =
			await derivedFixture(directory);
		assert.equal(validateRuntimeProbe(report, releaseBytes), report);
		const invalid = [
			evidence,
			{ ...report, schemaVersion: 1 },
			{ ...report, protocolVersion: 1 },
			{ ...report, codexVersion: "old-official-version" },
			{ ...report, distribution: undefined },
			...[
				"kind",
				"buildId",
				"sourceTree",
				"buildInputSha256",
				"target",
				"releaseSha256",
				"candidateManifestSha256",
			].map((field) => ({
				...report,
				distribution: { ...report.distribution, [field]: "wrong" },
			})),
			...Object.keys(report.distribution.binaries).map((name) => ({
				...report,
				distribution: {
					...report.distribution,
					binaries: {
						...report.distribution.binaries,
						[name]: sha256(`substituted ${name}`),
					},
				},
			})),
			{
				...report,
				distribution: {
					...report.distribution,
					binaries: { codex: report.distribution.binaries.codex },
				},
			},
		];
		for (const value of invalid)
			assert.throws(
				() => validateRuntimeProbe(value, releaseBytes),
				/evidence is invalid/,
			);
		assert.throws(
			() => validateRuntimeProbe(report, officialReleaseBytes),
			/evidence is invalid/,
		);
		assert.throws(
			() =>
				validateRuntimeProbe(
					report,
					Buffer.concat([releaseBytes, Buffer.from("\n")]),
				),
			/evidence is invalid/,
		);
		await writeFile(candidatePath, " ", { flag: "a" });
		const changedCandidateSha256 = sha256(await readFile(candidatePath));
		assert.throws(
			() =>
				validateRuntimeProbe(
					{
						...report,
						distribution: {
							...report.distribution,
							candidateManifestSha256: changedCandidateSha256,
						},
					},
					releaseBytes,
				),
			/evidence is invalid/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("image probe consumes its clean source context pin and inspected digest", async () => {
	const directory = await mkdtemp(join(tmpdir(), "codex-source-probe-"));
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: This test replaces and restores its own Docker fixture, not a cached input.
	const previousDocker = process.env.DOCKER_BIN;
	try {
		const { report } = await derivedFixture(directory);
		const commitSha = "1".repeat(40);
		const imageId = `sha256:${"a".repeat(64)}`;
		const imageDigest = `sha256:${"b".repeat(64)}`;
		const reportPath = join(directory, "report.json");
		await writeFile(reportPath, JSON.stringify(report));
		const docker = join(directory, "docker.mjs");
		await writeFile(
			docker,
			`#!/usr/bin/env node
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "image") console.log(JSON.stringify(${JSON.stringify({ Id: imageId, Descriptor: { digest: imageDigest }, Config: { Labels: { "org.opencontainers.image.revision": commitSha } } })}));
else if (args.includes("--provenance-rejection")) console.log(JSON.stringify({status:"passed",check:"provenance-fail-closed"}));
else console.log(readFileSync(${JSON.stringify(reportPath)}, "utf8"));
`,
		);
		await chmod(docker, 0o755);
		process.env.DOCKER_BIN = docker;
		const options = {
			image: "synthetic:image",
			source: { commitSha, sourceDirty: false },
			imageDigest,
			contextPath: directory,
		};
		const result = await probeRuntimeImage(options);
		assert.equal(result.imageId, imageId);
		assert.equal(result.imageDigest, imageDigest);
		assert.deepEqual(result.probe, report);
		await assert.rejects(
			probeRuntimeImage({
				...options,
				imageDigest: `sha256:${"c".repeat(64)}`,
			}),
			/digest does not match/,
		);
		await writeFile(reportPath, JSON.stringify(evidence));
		await assert.rejects(probeRuntimeImage(options), /image probe failed/);
	} finally {
		// biome-ignore lint/suspicious/noUndeclaredEnvVars: Restore the test-owned override without changing the caller's environment.
		if (previousDocker === undefined) delete process.env.DOCKER_BIN;
		else process.env.DOCKER_BIN = previousDocker;
		await rm(directory, { recursive: true, force: true });
	}
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
