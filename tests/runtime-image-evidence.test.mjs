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
import { pathToFileURL } from "node:url";

import {
	assertCleanRuntimeProbeSource,
	fileBridgeQualificationArguments,
	probeRuntimeImage,
	qualifyRuntimeImageFileBridge,
	runtimeImageFromBuildManifest,
	validateRuntimeProbe,
} from "../deploy/release/runtime-probe.mjs";

const root = resolve(import.meta.dirname, "..");
const releasePath = "packages/agent-runtime/src/codex-release.json";
const releaseBytes = await readFile(join(root, releasePath));
const release = JSON.parse(releaseBytes);
const evidenceSupport = pathToFileURL(
	join(root, "tests/support/runtime-file-bridge-evidence.mjs"),
).href;
const runtimeManifest = JSON.stringify({
	schemaVersion: 1,
	interactionMode: "platform-adapter",
	protocol: "acp",
	service: { port: 3003 },
	health: { path: "/healthz" },
	capabilities: {
		modelSelection: true,
		attachments: true,
		resultFiles: true,
		connection: false,
		supplementaryInstruction: false,
	},
});
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
		"native-shell-sandboxed-within-conversation",
		"native-code-mode-sandboxed-within-conversation",
		"native-apply-patch-no-outside-effects",
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
				check === "native-shell-sandboxed-within-conversation"
					? "native-sandboxed-tool-execution"
					: check,
			),
		},
		{ ...evidence, codexVersion: "other" },
		{ ...evidence, configurationSchemaVersion: 1 },
		{ ...evidence, checks: ["healthz"] },
		{
			...evidence,
			checks: evidence.checks.filter(
				(check) => check !== "native-code-mode-sandboxed-within-conversation",
			),
		},
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

test("runtime probe selects the build manifest's exact current-commit image", () => {
	const commit = "1".repeat(40);
	const image = {
		name: "agent-runtime-host",
		imageId: `sha256:${"a".repeat(64)}`,
	};
	const build = { schemaVersion: 1, source: { commit }, images: [image] };
	assert.equal(runtimeImageFromBuildManifest(build, commit), image.imageId);
	for (const value of [
		null,
		{ ...build, images: {} },
		{ ...build, source: { commit: "2".repeat(40) } },
		{ ...build, images: [] },
		{ ...build, images: [image, image] },
		{ ...build, images: [{ ...image, imageId: "mutable:tag" }] },
	])
		assert.throws(
			() => runtimeImageFromBuildManifest(value, commit),
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
		JSON.stringify({ ...release, codeModeHostArtifacts: undefined }),
		JSON.stringify({
			...release,
			codeModeHostArtifacts: {
				...release.codeModeHostArtifacts,
				arm64: {
					...release.codeModeHostArtifacts.arm64,
					executableSha256: "untrusted",
				},
			},
		}),
		JSON.stringify({
			...release,
			provenance: {
				...release.provenance,
				schemaSha256: `sha256:${"0".repeat(64)}`,
			},
		}),
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
const { syntheticFileBridgeResult } = await import(${JSON.stringify(evidenceSupport)});
const args = process.argv.slice(2);
const mutation = ${JSON.stringify(mutation)};
const inspection = ${JSON.stringify({ Id: imageId, Architecture: "amd64", Os: "linux", Config: { Labels: { "org.opencontainers.image.revision": commitSha, "io.agora.agent.runtime.manifest": runtimeManifest } }, Descriptor: { digest: imageDigest } })};
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
 if (args.includes("--file-bridge-origin")) {
  const driver = args[args.indexOf("--file-bridge-origin") + 1];
  if (mutation === "file-bridge-failure") { console.error(JSON.stringify({ status: "failed", stage: "file-bridge-session-round-trip", httpStatus: 503, fileBridgeRequests: 2, startupCode: "synthetic-credential-do-not-log" })); process.exit(1); }
  console.log(JSON.stringify(syntheticFileBridgeResult(driver, { architecture: inspection.Architecture })));
 } else if (args.includes("--provenance-rejection")) console.log(JSON.stringify({status:"passed",check:"provenance-fail-closed"}));
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
	// Codex model-only probe, provenance rejection, then one FileBridge origin
	// qualification per Driver the shared RuntimeHost image carries.
	assert.equal(calls.length, 6);
	assert.ok(calls[1].includes("--provenance-rejection"));
	for (const args of calls) {
		assert.ok(args.includes("--read-only"));
		assert.ok(args.includes("--network=none"));
		assert.ok(args.includes("--cap-drop=ALL"));
		assert.ok(args.includes("--security-opt=no-new-privileges"));
		assert.ok(args.includes("--pull=never"));
		assert.ok(!args.some((arg) => /privileged|seccomp|apparmor/.test(arg)));
		assert.ok(args.includes(f.imageId));
		assert.ok(
			args.some((arg) =>
				arg.endsWith(
					"dst=/probe/support/runtime-file-bridge-probe.mjs,readonly",
				),
			),
		);
	}
	const bridges = calls.slice(2);
	assert.deepEqual(
		bridges.map((args) => args[args.indexOf("--file-bridge-origin") + 1]),
		["codex", "claude", "acp", "pi"],
	);
	for (const args of bridges) {
		assert.equal(
			args[args.indexOf("--add-host") + 1],
			"agent-infra-api.agent-infra-probe.svc:127.0.0.1",
		);
		assert.equal(
			args.at(-1),
			`localhost/agent-runtime-release-candidate@${f.imageDigest}`,
		);
	}
	assert.equal(result.fileBridgeOrigin.role, "runtimeHost");
	assert.equal(
		result.fileBridgeOrigin.origin,
		"http://agent-infra-api.agent-infra-probe.svc:3000",
	);
	assert.deepEqual(result.fileBridgeOrigin.nonConsumers, [
		"codex-session-workspace-init",
		"codex-session-executor",
	]);
	assert.deepEqual(
		result.fileBridgeOrigin.drivers.map(({ driver }) => driver),
		["codex", "claude", "acp", "pi"],
	);
});
test("a FileBridge origin failure blocks the evidence with a bounded diagnostic", async (t) => {
	const f = await fixture(t, "file-bridge-failure");
	await assert.rejects(probeRuntimeImage(f.options), (error) => {
		assert.match(error.message, /FileBridge origin codex image probe failed/);
		assert.match(error.message, /"stage":"file-bridge-session-round-trip"/);
		assert.match(error.message, /"fileBridgeRequests":2/);
		assert.ok(!error.message.includes("synthetic-credential-do-not-log"));
		return true;
	});
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

// #3230：已发布不可变镜像的 FileBridge origin 资格（工具来源与镜像来源分别证明）。
const fieldRepository =
	"ghcr.io/agoraio-extensions/agent-infra/agent-runtime-codex";
const fieldDigest = `sha256:${"e".repeat(64)}`;

async function retainedFixture(t, mutation = "none") {
	const directory = await mkdtemp(join(tmpdir(), "runtime-file-bridge-3230-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	const labels = {
		"org.opencontainers.image.revision":
			mutation === "source-label" ? "3".repeat(40) : commitSha,
		"org.opencontainers.image.source":
			"https://github.com/AgoraIO-Extensions/agent-infra",
		"io.agora.agent.runtime.manifest":
			mutation === "self-managed"
				? runtimeManifest.replace("platform-adapter", "self-managed")
				: runtimeManifest,
		"io.agora.agent.standard-template":
			mutation === "role-label" ? "claude" : "codex",
	};
	const inspection = {
		Id: `sha256:${"a".repeat(64)}`,
		Os: "linux",
		Architecture: mutation === "platform" ? "arm64" : "amd64",
		RepoDigests: [
			`${fieldRepository}@${mutation === "digest" ? `sha256:${"f".repeat(64)}` : fieldDigest}`,
		],
		Config: { Labels: labels },
	};
	const docker = join(directory, "docker.mjs");
	await writeFile(
		docker,
		`#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const { syntheticFileBridgeResult } = await import(${JSON.stringify(evidenceSupport)});
const args = process.argv.slice(2);
const mutation = ${JSON.stringify(mutation)};
const inspection = ${JSON.stringify(inspection)};
const marker = ${JSON.stringify(join(directory, "probed"))};
if (args[0] === "image" && args[1] === "inspect") {
 if (args.at(-1) !== ${JSON.stringify(`${fieldRepository}@${fieldDigest}`)}) process.exit(1);
 if (mutation === "identity-drift" && existsSync(marker)) inspection.Id = "sha256:" + "c".repeat(64);
 console.log(JSON.stringify(inspection));
} else if (args[0] === "run") {
 appendFileSync(${JSON.stringify(join(directory, "calls.jsonl"))}, JSON.stringify(args) + "\\n");
 writeFileSync(marker, "done");
 if (mutation === "exec-format") { console.error("exec /usr/local/bin/docker-entrypoint.sh: exec format error"); process.exit(255); }
 const driver = args[args.indexOf("--file-bridge-origin") + 1];
 const result = syntheticFileBridgeResult(driver, { architecture: "amd64", namespace: args[args.indexOf("--file-bridge-origin") + 2] });
 if (mutation === "release") result.installation.codexReleaseSha256 = "sha256:" + "d".repeat(64);
 console.log(JSON.stringify(result));
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
		commitSha,
		options: {
			reference: `${fieldRepository}@${fieldDigest}`,
			role: "codex",
			imageSource: commitSha,
			platform: "linux/amd64",
			namespace: "agent-infra-d-ws-1103",
			source: { commitSha, sourceDirty: false },
		},
	};
}

test("an immutable image qualifies its own role, source and digest without pulling", async (t) => {
	const f = await retainedFixture(t);
	const evidence = await qualifyRuntimeImageFileBridge(f.options);
	assert.equal(evidence.kind, "runtime-image-file-bridge-qualification");
	assert.equal(evidence.status, "passed");
	assert.deepEqual(evidence.image, {
		reference: f.options.reference,
		repository: fieldRepository,
		digest: fieldDigest,
		imageId: `sha256:${"a".repeat(64)}`,
		platform: "linux/amd64",
		role: "codex",
		sourceCommit: f.commitSha,
		sourceRepository: "https://github.com/AgoraIO-Extensions/agent-infra",
		codexReleaseSha256: `sha256:${createHash("sha256").update(releaseBytes).digest("hex")}`,
	});
	assert.equal(evidence.tool.commitSha, f.commitSha);
	assert.match(evidence.tool.sourceTree, /^[a-f0-9]{40}$/);
	assert.deepEqual(evidence.sourceRelation, {
		imageSourceInToolHistory: true,
		sameSource: true,
	});
	assert.equal(
		evidence.fileBridgeOrigin.origin,
		"http://agent-infra-api.agent-infra-d-ws-1103.svc:3000",
	);
	assert.deepEqual(
		evidence.fileBridgeOrigin.drivers.map(({ driver }) => driver),
		["codex"],
	);
	assert.deepEqual(evidence.boundary, {
		network: "none",
		imagePulled: false,
		externalModelRequests: 0,
		registryWrites: 0,
		clusterWorkloads: 0,
	});
	const calls = (await readFile(join(f.directory, "calls.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map(JSON.parse);
	assert.equal(calls.length, 1);
	const [args] = calls;
	assert.equal(args[args.indexOf("--platform") + 1], "linux/amd64");
	assert.equal(
		args[args.indexOf("--add-host") + 1],
		"agent-infra-api.agent-infra-d-ws-1103.svc:127.0.0.1",
	);
	for (const flag of [
		"--pull=never",
		"--network=none",
		"--read-only",
		"--cap-drop=ALL",
		"--security-opt=no-new-privileges",
	])
		assert.ok(args.includes(flag), flag);
	assert.ok(!args.some((arg) => /privileged|seccomp|apparmor/.test(arg)));
	// The container runs the inspected content ID; the exact reference only
	// feeds the executor binding inside it.
	assert.equal(args[args.indexOf("node") - 1], `sha256:${"a".repeat(64)}`);
	assert.equal(args.at(-1), f.options.reference);
});

for (const [mutation, expected] of [
	["digest", /digest does not match the input/],
	["platform", /platform does not match the input/],
	["source-label", /source does not match the input/],
	["role-label", /role does not match the input/],
	["self-managed", /not a platform FileBridge consumer/],
	["exec-format", /cannot execute amd64 on this Docker daemon/],
	["release", /release does not match its source/],
	["identity-drift", /changed during qualification/],
])
	test(`immutable FileBridge qualification rejects ${mutation}`, async (t) => {
		const f = await retainedFixture(t, mutation);
		await assert.rejects(qualifyRuntimeImageFileBridge(f.options), expected);
	});

test("immutable FileBridge qualification refuses ambiguous or unproven inputs", async (t) => {
	const f = await retainedFixture(t);
	for (const options of [
		{ ...f.options, reference: `${fieldRepository}:release-latest` },
		{ ...f.options, reference: `${fieldRepository}@sha256:${"E".repeat(64)}` },
		{ ...f.options, platform: "linux/386" },
		{ ...f.options, role: "agent-runtime-codex" },
		{ ...f.options, imageSource: "main" },
		{ ...f.options, namespace: "Bad_Namespace" },
		{ ...f.options, source: { commitSha: f.commitSha, sourceDirty: true } },
	])
		await assert.rejects(
			qualifyRuntimeImageFileBridge(options),
			/qualification input is invalid/,
		);
	await assert.rejects(
		qualifyRuntimeImageFileBridge({
			...f.options,
			imageSource: "f".repeat(40),
		}),
		/not in the probe source history/,
	);
	await assert.rejects(readFile(join(f.directory, "calls.jsonl")), {
		code: "ENOENT",
	});
});

test("the immutable qualification CLI takes approved role, source and platform explicitly", () => {
	assert.deepEqual(
		fileBridgeQualificationArguments([
			"--role",
			"codex",
			"--image-source",
			"a".repeat(40),
			"--platform",
			"linux/amd64",
			"--namespace",
			"agent-infra-d-ws-1103",
			`${fieldRepository}@${fieldDigest}`,
			"/private/evidence.json",
		]),
		{
			role: "codex",
			imageSource: "a".repeat(40),
			platform: "linux/amd64",
			namespace: "agent-infra-d-ws-1103",
			reference: `${fieldRepository}@${fieldDigest}`,
			output: "/private/evidence.json",
		},
	);
	assert.equal(
		fileBridgeQualificationArguments([
			"--role",
			"pi",
			"--image-source",
			"a".repeat(40),
			"--platform",
			"linux/amd64",
			"repository@sha256:x",
			"out.json",
		]).namespace,
		"agent-infra-probe",
	);
	for (const argv of [
		["--role", "codex", "only-one-positional"],
		["--role", "codex", "--role", "pi", "a", "b"],
		["--unknown", "x", "a", "b"],
		["--role"],
	])
		assert.throws(
			() => fileBridgeQualificationArguments(argv),
			/arguments are invalid|usage:/,
		);
});
