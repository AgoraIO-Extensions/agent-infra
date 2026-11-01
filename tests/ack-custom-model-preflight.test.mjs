import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { runInNewContext } from "node:vm";
import {
	buildCustomMeasurementPod,
	CUSTOM_CAPACITY_SCOPE,
	capacityEvidenceHash,
	capacityProfile,
	evidenceBytes,
	runtimeReadbackScript,
	validateCustomCapacityJob,
	validateCustomEnvironment,
	verifyCustomImageEvidence,
} from "../deploy/ack/custom-model-preflight.mts";
import { validateCapacityBindings } from "../deploy/ack/workload-capacity.ts";

const source = "62125de98b71413831b493a283f2b39359b8da9d";
const cli = fileURLToPath(
	new URL("../deploy/ack/custom-model-preflight.mts", import.meta.url),
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const descriptor = (
	content,
	mediaType = "application/vnd.oci.image.layer.v1.tar+gzip",
) => ({
	mediaType,
	size: Buffer.byteLength(content),
	digest: `sha256:${hash(content)}`,
});
const manifestType = "application/vnd.oci.image.manifest.v1+json";
const configType = "application/vnd.oci.image.config.v1+json";

function fixture(change = () => {}) {
	const runtime = {
		schemaVersion: 1,
		interactionMode: "platform-adapter",
		protocol: "acp",
		service: { port: 3003 },
		health: { path: "/healthz" },
	};
	const config = {
		os: "linux",
		architecture: "amd64",
		config: {
			User: "1000:1000",
			Entrypoint: ["node", "/opt/custom-agent/main.mjs"],
			Labels: {
				"org.opencontainers.image.revision": source,
				"io.agora.agent.runtime.manifest": JSON.stringify(runtime),
			},
		},
	};
	const parent = {
		schemaVersion: 2,
		mediaType: manifestType,
		config: descriptor("parent-config", configType),
		layers: [descriptor("parent-layer")],
	};
	const child = {
		schemaVersion: 2,
		mediaType: manifestType,
		config: {},
		layers: [...structuredClone(parent.layers), descriptor("custom-layer")],
	};
	change({ config, parent, child, runtime });
	const imageConfig = bytes(config);
	child.config = {
		mediaType: configType,
		size: imageConfig.byteLength,
		digest: `sha256:${hash(imageConfig)}`,
	};
	const raw = {
		config: imageConfig,
		parent: bytes(parent),
		child: bytes(child),
		recipe: Buffer.from(
			"FROM synthetic-parent\nCOPY custom /opt/custom-agent\n",
		),
	};
	const job = {
		schemaVersion: 1,
		scope: CUSTOM_CAPACITY_SCOPE,
		sourceCommit: source,
		sourceWorktree: "/synthetic/application",
		imageReference: `registry.example/custom@sha256:${hash(raw.child)}`,
		imageDigest: `sha256:${hash(raw.child)}`,
		parentImageReference: `registry.example/runtime@sha256:${hash(raw.parent)}`,
		platform: "linux/amd64",
		childManifestFile: "/synthetic/child.json",
		imageConfigFile: "/synthetic/config.json",
		parentManifestFile: "/synthetic/parent.json",
		recipeFile: "/synthetic/Dockerfile",
		recipeSha256: hash(raw.recipe),
		runtimeModuleSha256: "b".repeat(64),
		modelConfigurationSha256: "c".repeat(64),
		modelConfigurationPath: "/opt/custom-agent/configuration.json",
		customEnvironmentFile: "/synthetic/custom-env.json",
		kubeconfig: "/synthetic/kubeconfig",
		namespace: "agent-infra",
		outputDirectory: "/synthetic/output",
		operatorApprovalRef: "test-approval",
		resourceProfileRef: "ack-small",
		resources: {
			requests: { cpu: "100m", memory: "128Mi" },
			limits: { cpu: "1", memory: "2Gi" },
		},
		modelOptionId: "custom:model",
		reasoningLevel: "medium",
		runtimeConfigVersion: "custom-v1",
		expectedModelId: "actual-model",
		timeoutSeconds: 60,
		placement: {
			nodeSelector: { "kubernetes.io/arch": "amd64", "node-role": "isolated" },
			tolerations: [
				{
					key: "dedicated",
					operator: "Equal",
					value: "runtime",
					effect: "NoSchedule",
				},
			],
		},
	};
	return { job, raw, config, parent, child };
}

test("valid input is copied and binds the exact approved amd64/source/resource tuple", () => {
	const { job } = fixture();
	const checked = validateCustomCapacityJob(job);
	assert.deepEqual(checked, job);
	checked.resources.limits.cpu = "2";
	assert.equal(job.resources.limits.cpu, "1");
});

for (const [label, change, code] of [
	[
		"V4 executionSource",
		(j) => {
			j.executionSource = "eval";
		},
		"JOB_INVALID",
	],
	[
		"Relay keyBinding",
		(j) => {
			j.keyBinding = {};
		},
		"JOB_INVALID",
	],
	[
		"supplied user principal",
		(j) => {
			j.principal = { kind: "user", id: "other" };
		},
		"JOB_INVALID",
	],
	[
		"arm64",
		(j) => {
			j.platform = "linux/arm64";
		},
		"JOB_INVALID",
	],
	[
		"tagged image",
		(j) => {
			j.imageReference = "registry.example/custom:latest";
		},
		"IMAGE_INVALID",
	],
	[
		"digest suffix on URL",
		(j) => {
			j.imageReference = `https://registry.example/custom@${j.imageDigest}`;
		},
		"IMAGE_INVALID",
	],
	[
		"wrong digest",
		(j) => {
			j.imageDigest = `sha256:${"d".repeat(64)}`;
		},
		"IMAGE_INVALID",
	],
	[
		"tagged parent",
		(j) => {
			j.parentImageReference = "registry.example/runtime:latest";
		},
		"IMAGE_INVALID",
	],
	[
		"wrong source",
		(j) => {
			j.sourceCommit = "main";
		},
		"SOURCE_INVALID",
	],
	[
		"relative artifact",
		(j) => {
			j.recipeFile = "Dockerfile";
		},
		"PATH_INVALID",
	],
	[
		"path traversal",
		(j) => {
			j.modelConfigurationPath = "/opt/custom-agent/../private.json";
		},
		"PATH_INVALID",
	],
	[
		"runtime overlay path",
		(j) => {
			j.modelConfigurationPath = "/app/configuration.json";
		},
		"CONFIGURATION_PATH_INVALID",
	],
	[
		"extra resource",
		(j) => {
			j.resources.limits["nvidia.com/gpu"] = "1";
		},
		"RESOURCES_INVALID",
	],
	[
		"CPU inflation",
		(j) => {
			j.resources.limits.cpu = "2";
		},
		"RESOURCES_INVALID",
	],
	[
		"memory drift",
		(j) => {
			j.resources.requests.memory = "256Mi";
		},
		"RESOURCES_INVALID",
	],
	[
		"short deadline",
		(j) => {
			j.timeoutSeconds = 59;
		},
		"TIMEOUT_INVALID",
	],
	[
		"unbounded deadline",
		(j) => {
			j.timeoutSeconds = 1801;
		},
		"TIMEOUT_INVALID",
	],
	[
		"unbounded placement",
		(j) => {
			j.placement.tolerations = Array(13).fill(j.placement.tolerations[0]);
		},
		"PLACEMENT_INVALID",
	],
	[
		"wrong node architecture",
		(j) => {
			j.placement.nodeSelector["kubernetes.io/arch"] = "arm64";
		},
		"PLACEMENT_INVALID",
	],
	[
		"unknown placement flag",
		(j) => {
			j.placement.hostNetwork = true;
		},
		"PLACEMENT_INVALID",
	],
	[
		"invalid namespace",
		(j) => {
			j.namespace = "../other";
		},
		"NAMESPACE_INVALID",
	],
	[
		"missing namespace",
		(j) => {
			delete j.namespace;
		},
		"NAMESPACE_INVALID",
	],
	[
		"unapproved reasoning",
		(j) => {
			j.reasoningLevel = "unbounded";
		},
		"REASONING_INVALID",
	],
])
	test(`rejects ${label} before transport`, () => {
		const { job } = fixture();
		change(job);
		assert.throws(
			() => validateCustomCapacityJob(job),
			new RegExp(`CUSTOM_CAPACITY_${code}`),
		);
	});

test("OCI verifier hashes raw child/config/parent/recipe bytes and reads the config source label", () => {
	const { job, raw } = fixture();
	assert.deepEqual(
		verifyCustomImageEvidence(validateCustomCapacityJob(job), raw),
		{
			imageDigest: job.imageDigest,
			parentDigest: `sha256:${hash(raw.parent)}`,
			imageConfigDigest: `sha256:${hash(raw.config)}`,
			sourceCommit: source,
			platform: "linux/amd64",
			entrypoint: ["node", "/opt/custom-agent/main.mjs"],
			recipeSha256: hash(raw.recipe),
		},
	);
	for (const field of ["child", "parent", "config", "recipe"])
		assert.throws(
			() =>
				verifyCustomImageEvidence(job, {
					...raw,
					[field]: Buffer.concat([raw[field], Buffer.from("\n")]),
				}),
			/CUSTOM_CAPACITY_(MANIFEST_DIGEST|CONFIG_DIGEST|RECIPE)_MISMATCH/,
		);
	const compactChild = Buffer.from(JSON.stringify(JSON.parse(raw.child)));
	assert.notEqual(hash(compactChild), hash(raw.child));
	assert.throws(
		() => verifyCustomImageEvidence(job, { ...raw, child: compactChild }),
		/MANIFEST_DIGEST_MISMATCH/,
	);
});

for (const [name, label] of [
	[
		"duplicate JSON keys",
		(runtime) =>
			JSON.stringify(runtime).replace(
				'"schemaVersion":1',
				'"schemaVersion":0,"schemaVersion":1',
			),
	],
	[
		"more than 64 KiB of UTF-8 label bytes",
		(runtime) => `${JSON.stringify(runtime)}${" ".repeat(65_537)}`,
	],
	[
		"JSON nesting deeper than eight levels",
		(runtime) =>
			JSON.stringify({
				...runtime,
				deep: Array.from({ length: 9 }).reduce(
					(value) => ({ nested: value }),
					true,
				),
			}),
	],
])
	test(`shared Runtime Manifest parser rejects ${name} inside otherwise hash-valid OCI evidence`, () => {
		const { job, raw, child } = fixture(({ config, runtime }) => {
			config.config.Labels["io.agora.agent.runtime.manifest"] = label(runtime);
		});
		assert.equal(job.imageDigest, `sha256:${hash(raw.child)}`);
		assert.equal(child.config.digest, `sha256:${hash(raw.config)}`);
		assert.equal(child.config.size, raw.config.byteLength);
		assert.throws(
			() => verifyCustomImageEvidence(job, raw),
			/Image registry Runtime Manifest is invalid/,
		);
	});

for (const [label, change, code] of [
	[
		"arm64 config",
		({ config }) => {
			config.architecture = "arm64";
		},
		"ARCHITECTURE_MISMATCH",
	],
	[
		"architecture variant",
		({ config }) => {
			config.variant = "v8";
		},
		"ARCHITECTURE_MISMATCH",
	],
	[
		"wrong source label",
		({ config }) => {
			config.config.Labels["org.opencontainers.image.revision"] = "d".repeat(
				40,
			);
		},
		"SOURCE_MISMATCH",
	],
	[
		"root image",
		({ config }) => {
			config.config.User = "0";
		},
		"ROOT_IMAGE_REJECTED",
	],
	[
		"missing entrypoint",
		({ config }) => {
			config.config.Entrypoint = [];
		},
		"ENTRYPOINT_INVALID",
	],
	[
		"self-managed role",
		({ config }) => {
			config.config.Labels["io.agora.agent.runtime.manifest"] = JSON.stringify({
				schemaVersion: 1,
				interactionMode: "self-managed",
				service: { port: 3003 },
				health: { path: "/healthz" },
			});
		},
		"ROLE_MISMATCH",
	],
	[
		"wrong service port",
		({ config, runtime }) => {
			runtime.service.port = 8080;
			config.config.Labels["io.agora.agent.runtime.manifest"] =
				JSON.stringify(runtime);
		},
		"ROLE_MISMATCH",
	],
	[
		"wrong health endpoint",
		({ config, runtime }) => {
			runtime.health.path = "/other";
			config.config.Labels["io.agora.agent.runtime.manifest"] =
				JSON.stringify(runtime);
		},
		"ROLE_MISMATCH",
	],
	[
		"index in place of child",
		({ child }) => {
			child.manifests = [];
		},
		"MANIFEST_INVALID",
	],
	[
		"empty layer list",
		({ child }) => {
			child.layers = [];
		},
		"MANIFEST_INVALID",
	],
	[
		"parent with same layer count",
		({ parent, child }) => {
			parent.layers = structuredClone(child.layers);
		},
		"PARENT_MISMATCH",
	],
	[
		"non-prefix parent digest",
		({ child }) => {
			child.layers[0].digest = `sha256:${"d".repeat(64)}`;
		},
		"PARENT_MISMATCH",
	],
	[
		"non-prefix parent size",
		({ child }) => {
			child.layers[0].size++;
		},
		"PARENT_MISMATCH",
	],
	[
		"non-prefix parent mediaType",
		({ child }) => {
			child.layers[0].mediaType = "application/vnd.oci.image.layer.v1.tar";
		},
		"PARENT_MISMATCH",
	],
])
	test(`content-addressed but invalid OCI ${label} is rejected`, () => {
		const { job, raw } = fixture(change);
		assert.throws(
			() => verifyCustomImageEvidence(job, raw),
			new RegExp(`CUSTOM_CAPACITY_${code}`),
		);
	});

test("config descriptor size is checked independently from its digest", () => {
	const { job, raw, child } = fixture();
	child.config.size++;
	raw.child = bytes(child);
	job.imageDigest = `sha256:${hash(raw.child)}`;
	job.imageReference = `registry.example/custom@${job.imageDigest}`;
	assert.throws(
		() => verifyCustomImageEvidence(job, raw),
		/CONFIG_DIGEST_MISMATCH/,
	);
});

test("custom environment cannot override Runtime authorization, loader or service configuration", () => {
	const input = {
		CUSTOM_MODEL_TOKEN: "synthetic-only",
		CUSTOM_MODEL_ORIGIN: "https://example.invalid",
	};
	const result = validateCustomEnvironment(input);
	assert.deepEqual(result, input);
	result.CUSTOM_MODEL_TOKEN = "changed";
	assert.equal(input.CUSTOM_MODEL_TOKEN, "synthetic-only");
	for (const invalid of [
		{},
		[],
		{ AGENT_INFRA_RUNTIME_SERVICE_TOKEN: "synthetic" },
		{ NODE_OPTIONS: "--require /x" },
		{ LD_PRELOAD: "/x" },
		{ CUSTOM_TOKEN: "" },
		{ CUSTOM_TOKEN: "x\0y" },
		{ CUSTOM_TOKEN: "x".repeat(8193) },
		Object.fromEntries(
			Array.from({ length: 33 }, (_, n) => [`CUSTOM_${n}`, "synthetic"]),
		),
	])
		assert.throws(
			() => validateCustomEnvironment(invalid),
			/CUSTOM_CAPACITY_ENV_INVALID/,
		);
});

test("Pod only mounts writable scratch directories and references private env through the owned Secret", () => {
	const { job } = fixture();
	job.imagePullSecret = "approved-registry";
	const env = validateCustomEnvironment({
		CUSTOM_MODEL_TOKEN: "synthetic-not-in-pod",
		CUSTOM_MODEL_ORIGIN: "https://example.invalid",
	});
	const owner = "12345678-1234-1234-1234-123456789abc";
	const pod = buildCustomMeasurementPod(
		validateCustomCapacityJob(job),
		owner,
		"owned-auth",
		"synthetic-public-key",
		Object.keys(env),
	);
	const container = pod.spec.containers[0];
	assert.equal(pod.kind, "Pod");
	assert.equal(pod.metadata.namespace, job.namespace);
	assert.deepEqual(pod.metadata.labels, {
		"agent-infra.validation-owner": owner,
		"agent-infra.validation-source": source,
		"agent-infra.validation-scope": CUSTOM_CAPACITY_SCOPE,
	});
	assert.equal(pod.spec.automountServiceAccountToken, false);
	assert.equal(pod.spec.restartPolicy, "Never");
	assert.equal(pod.spec.containers.length, 1);
	assert.deepEqual(pod.spec.nodeSelector, job.placement.nodeSelector);
	assert.deepEqual(pod.spec.tolerations, job.placement.tolerations);
	assert.deepEqual(pod.spec.imagePullSecrets, [{ name: "approved-registry" }]);
	assert.deepEqual(pod.spec.securityContext, {
		runAsNonRoot: true,
		runAsUser: 1000,
		runAsGroup: 1000,
		fsGroup: 1000,
		seccompProfile: { type: "RuntimeDefault" },
	});
	assert.deepEqual(container.securityContext, {
		allowPrivilegeEscalation: false,
		readOnlyRootFilesystem: true,
		capabilities: { drop: ["ALL"] },
	});
	assert.equal(container.image, job.imageReference);
	assert.deepEqual(container.resources, job.resources);
	assert.deepEqual(
		container.volumeMounts.map((m) => m.mountPath),
		["/var/lib/agent-runtime", "/workspace", "/tmp"],
	);
	assert.deepEqual(
		pod.spec.volumes,
		["data", "workspace", "tmp"].map((name) => ({ name, emptyDir: {} })),
	);
	assert.deepEqual(
		container.env
			.filter((e) => e.valueFrom)
			.map((e) => [e.name, e.valueFrom.secretKeyRef]),
		[
			[
				"AGENT_INFRA_RUNTIME_SERVICE_TOKEN",
				{ name: "owned-auth", key: "service-token" },
			],
			["CUSTOM_MODEL_TOKEN", { name: "owned-auth", key: "CUSTOM_MODEL_TOKEN" }],
			[
				"CUSTOM_MODEL_ORIGIN",
				{ name: "owned-auth", key: "CUSTOM_MODEL_ORIGIN" },
			],
		],
	);
	assert.equal(
		new Set(container.env.map((e) => e.name)).size,
		container.env.length,
	);
	assert.ok(
		container.env.every(
			(entry) =>
				entry.name !== "AGENT_INFRA_RUNTIME_ISOLATION_MODE" &&
				!entry.name.startsWith("AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_"),
		),
	);
	assert.doesNotMatch(
		JSON.stringify(pod),
		/synthetic-not-in-pod|PRIVATE KEY|keyBinding|executionSource|hostPath|hostNetwork|serviceAccountName|Ingress|container-boundary|attestation/,
	);
	assert.equal("service" in pod, false);
	assert.equal("ingress" in pod, false);
});

function measurement(job) {
	return {
		schemaVersion: 1,
		scope: CUSTOM_CAPACITY_SCOPE,
		sourceCommit: source,
		imageDigest: job.imageDigest,
		observedResources: structuredClone(job.resources),
		maximumConcurrentExecutions: 1,
		terminalStatus: "completed",
		replyMatched: true,
		submittedAt: 1_800_000_000_000,
		completedAt: 1_800_000_000_005,
		modelFacts: ["started", "completed"].map((phase) => ({
			kind: "model",
			phase,
			executionId: "execution",
			operationRef: "model-operation",
			attemptRef: "attempt",
			model: {
				configVersion: job.runtimeConfigVersion,
				modelOptionId: job.modelOptionId,
				modelId: job.expectedModelId,
				reasoningLevel: job.reasoningLevel,
			},
		})),
	};
}
function consumer(job, raw, profile = capacityProfile(job, raw)) {
	return validateCapacityBindings(
		[
			{
				source: {
					kind: "custom",
					interactionMode: "platform-adapter",
					imageReference: job.imageReference,
				},
			},
		],
		[],
		{ resourceProfileRef: job.resourceProfileRef, resources: job.resources },
		[profile],
		new Map([[job.imageDigest, raw]]),
	);
}

test("capacity profile hashes the exact receipt file bytes consumed by the unchanged capacity gate", async (t) => {
	const { job } = fixture();
	const dir = await temporary(t);
	const raw = evidenceBytes(measurement(job));
	assert.equal(raw.at(-1), 10);
	assert.ok(raw.includes(Buffer.from("\n  ")));
	const file = join(dir, "receipt.json");
	await writeFile(file, raw, { mode: 0o600 });
	const persisted = await readFile(file);
	const profile = capacityProfile(job, raw);
	assert.equal(profile.maximumConcurrentExecutions, 1);
	assert.equal(profile.conformanceEvidenceHash, hash(persisted));
	assert.equal(capacityEvidenceHash(persisted), hash(raw));
	assert.equal(
		profile.resourceConfigurationHash,
		hash(
			JSON.stringify({
				resourceProfileRef: job.resourceProfileRef,
				...job.resources,
			}),
		),
	);
	assert.equal(consumer(job, persisted, profile).imageCount, 1);
	assert.throws(
		() => consumer(job, Buffer.from(JSON.stringify(JSON.parse(raw))), profile),
		/CAPACITY_EVIDENCE_MISMATCH/,
	);
	assert.throws(
		() => consumer(job, Buffer.concat([persisted, Buffer.from("\n")]), profile),
		/CAPACITY_EVIDENCE_MISMATCH/,
	);
	assert.throws(
		() =>
			consumer(job, persisted, { ...profile, maximumConcurrentExecutions: 2 }),
		/CAPACITY_PROFILE_UNMEASURED/,
	);
});

for (const [name, change, code] of [
	[
		"ISO string timestamps",
		(r) => {
			r.submittedAt = new Date(r.submittedAt).toISOString();
			r.completedAt = new Date(r.completedAt).toISOString();
		},
		"CAPACITY_EVIDENCE_NOT_MEASURED",
	],
	[
		"unknown terminal",
		(r) => {
			r.terminalStatus = "unknown";
		},
		"CAPACITY_EVIDENCE_NOT_MEASURED",
	],
	[
		"capacity inflation",
		(r) => {
			r.maximumConcurrentExecutions = 2;
		},
		"CAPACITY_EVIDENCE_NOT_MEASURED",
	],
	[
		"missing model completion",
		(r) => {
			r.modelFacts.pop();
		},
		"CAPACITY_MODEL_FACT_MISSING",
	],
	[
		"unknown model fact",
		(r) => {
			r.modelFacts.push({ phase: "unknown" });
		},
		"CAPACITY_MODEL_FACT_MISSING",
	],
	[
		"changed observed resources",
		(r) => {
			r.observedResources.limits.cpu = "2";
		},
		"CAPACITY_MEASURED_RESOURCES_DRIFT",
	],
])
	test(`freshly hashed ${name} evidence still fails the real consumer`, () => {
		const { job } = fixture();
		const receipt = measurement(job);
		change(receipt);
		assert.throws(
			() => consumer(job, evidenceBytes(receipt)),
			new RegExp(code),
		);
	});

async function temporary(t) {
	const dir = await mkdtemp(join(tmpdir(), "ack-custom-capacity-test-"));
	await chmod(dir, 0o700);
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}
async function cliFixture(t) {
	const dir = await temporary(t);
	const bin = join(dir, "bin");
	const output = join(dir, "output");
	const foreign = join(dir, "application");
	for (const path of [bin, output, foreign]) await mkdir(path, { mode: 0o700 });
	const marker = join(dir, "cluster-command-was-called");
	await writeFile(
		join(bin, "kubectl"),
		'#!/bin/sh\n: > "$CUSTOM_CAPACITY_CLUSTER_MARKER"\nexit 99\n',
		{ mode: 0o700 },
	);
	const git = (...args) =>
		execFileSync("git", ["-C", foreign, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	git("init", "--initial-branch=main");
	git(
		"-c",
		"commit.gpgsign=false",
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"user.name=Capacity Test",
		"-c",
		"user.email=capacity@example.invalid",
		"commit",
		"--allow-empty",
		"-m",
		"test: synthetic source",
	);
	const { job } = fixture();
	job.sourceWorktree = foreign;
	job.sourceCommit = git("rev-parse", "HEAD");
	job.outputDirectory = output;
	const jobPath = join(dir, "job.json");
	await writeFile(jobPath, bytes(job), { mode: 0o600 });
	const run = (path = jobPath) =>
		spawnSync(process.execPath, [cli, path], {
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 128 * 1024,
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				CUSTOM_CAPACITY_CLUSTER_MARKER: marker,
			},
		});
	const noCluster = async () =>
		assert.rejects(readFile(marker), { code: "ENOENT" });
	return { dir, output, foreign, jobPath, job, run, noCluster };
}

for (const kind of ["world-readable", "symlink", "oversized", "relative"])
	test(`CLI rejects ${kind} job before source or cluster access`, async (t) => {
		const f = await cliFixture(t);
		let path = f.jobPath;
		if (kind === "world-readable") await chmod(path, 0o644);
		if (kind === "symlink") {
			path = join(f.dir, "linked.json");
			await symlink(f.jobPath, path);
		}
		if (kind === "oversized")
			await writeFile(path, "x".repeat(1024 * 1024 + 1));
		if (kind === "relative") path = "job.json";
		const result = f.run(path);
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /^CUSTOM_CAPACITY_MEASUREMENT_FAILED\n$/);
		assert.deepEqual(await readdir(f.output), []);
		await f.noCluster();
	});

test("CLI rejects public output permissions before creating an attempt", async (t) => {
	const f = await cliFixture(t);
	await chmod(f.output, 0o755);
	const result = f.run();
	assert.equal(result.status, 1);
	assert.equal(result.stderr, "CUSTOM_CAPACITY_OUTPUT_INVALID\n");
	assert.deepEqual(await readdir(f.output), []);
	await f.noCluster();
});

test("CLI refuses a symlink output directory before writing an attempt", async (t) => {
	const f = await cliFixture(t);
	f.job.outputDirectory = join(f.dir, "linked-output");
	await symlink(f.output, f.job.outputDirectory);
	await writeFile(f.jobPath, bytes(f.job));
	const result = f.run();
	assert.equal(result.status, 1);
	assert.equal(result.stderr, "CUSTOM_CAPACITY_OUTPUT_INVALID\n");
	assert.deepEqual(await readdir(f.output), []);
	await f.noCluster();
});

test("CLI rejects a clean foreign Git source and preserves only its private failure attempt", async (t) => {
	const f = await cliFixture(t);
	const result = f.run();
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, "CUSTOM_CAPACITY_FOREIGN_SOURCE\n");
	const runDirectory = join(f.output, "measurement");
	const failureFile = join(runDirectory, "failure.json");
	assert.deepEqual(await readdir(runDirectory), ["failure.json"]);
	const original = await readFile(failureFile);
	assert.deepEqual(JSON.parse(original), {
		schemaVersion: 1,
		scope: CUSTOM_CAPACITY_SCOPE,
		status: "failed",
		stage: "input-verification",
		code: "CUSTOM_CAPACITY_FOREIGN_SOURCE",
		sourceCommit: f.job.sourceCommit,
		imageDigest: f.job.imageDigest,
		cleanup: { status: "cleaned", resources: [] },
		businessVerified: false,
	});
	assert.equal((await stat(failureFile)).mode & 0o777, 0o600);
	assert.equal((await stat(runDirectory)).mode & 0o777, 0o700);
	assert.doesNotMatch(
		original.toString(),
		/synthetic\/kubeconfig|sourceWorktree|PRIVATE KEY/,
	);
	assert.equal(f.run().status, 1);
	assert.deepEqual(await readFile(failureFile), original);
	assert.deepEqual(await readdir(runDirectory), ["failure.json"]);
	await f.noCluster();
});

test("CLI refuses output inside a Git tree before any attempt", async (t) => {
	const f = await cliFixture(t);
	f.job.outputDirectory = join(f.foreign, "private-output");
	await mkdir(f.job.outputDirectory, { mode: 0o700 });
	await writeFile(f.jobPath, bytes(f.job));
	const result = f.run();
	assert.equal(result.status, 1);
	assert.equal(result.stderr, "CUSTOM_CAPACITY_OUTPUT_IN_GIT\n");
	assert.deepEqual(await readdir(f.job.outputDirectory), []);
	await f.noCluster();
});

function readbackFixture(change = () => {}) {
	const moduleBytes = Buffer.from(
		"synthetic module bytes which must not be printed\n",
	);
	const config = {
		schemaVersion: 3,
		configVersion: "custom-v1",
		unrelated: "synthetic-never-output",
		modelOptions: [
			{
				modelOptionId: "custom:model",
				model: "configured-model",
				reasoningLevels: ["medium"],
			},
		],
	};
	const state = {
		config,
		effective: structuredClone(config),
		candidates: ["111", "222", "self", "444"],
		command: "node\0--disable-sigusr1\0/app/dist/index.mjs\0",
		cwd: "/app",
		option: "custom:model",
		duplicateEnvironment: false,
	};
	change(state);
	const configBytes = bytes(state.config);
	const effective = JSON.stringify(state.effective);
	const entry = `AGENT_INFRA_RUNTIME_MODEL_CONFIG=${effective}\0`;
	const files = new Map([
		["/runtime.mjs", moduleBytes],
		["/config.json", configBytes],
		["/proc/111/cmdline", state.command],
		["/proc/222/cmdline", "node\0some-other-helper.mjs\0"],
		["/proc/333/cmdline", state.command],
		[
			"/proc/111/environ",
			`${entry}${state.duplicateEnvironment ? entry : ""}OTHER_TOKEN=synthetic-never-output\0`,
		],
		[
			"/proc/111/stat",
			`111 (node) ${["S", ...Array(18).fill("0"), "12345"].join(" ")}`,
		],
	]);
	let output = "";
	const fs = {
		readdirSync(path) {
			assert.equal(path, "/proc");
			return state.candidates;
		},
		readFileSync(path, encoding) {
			assert.ok(files.has(path), `unexpected fixture read ${path}`);
			const value = Buffer.from(files.get(path));
			return encoding ? value.toString(encoding) : value;
		},
		readlinkSync(path) {
			assert.equal(path, "/proc/111/cwd");
			return state.cwd;
		},
	};
	return {
		moduleBytes,
		configBytes,
		effective,
		run() {
			runInNewContext(
				runtimeReadbackScript,
				{
					require(name) {
						if (name === "node:fs") return fs;
						if (name === "node:crypto") return { createHash };
						if (name === "node:util") return { isDeepStrictEqual };
						throw new Error("UNEXPECTED_READBACK_DEPENDENCY");
					},
					process: {
						pid: 444,
						argv: ["node", "/runtime.mjs", "/config.json", state.option],
						stdout: {
							write(value) {
								output += value;
							},
						},
						exit(code) {
							throw new Error(`READBACK_EXIT_${code}`);
						},
					},
				},
				{ timeout: 1_000 },
			);
			return output;
		},
	};
}

test("Runtime readback binds the sole Host process effective config to approved bytes without exposing its environment", () => {
	const f = readbackFixture();
	const result = f.run();
	assert.deepEqual(JSON.parse(result), {
		moduleSha256: hash(f.moduleBytes),
		configurationSha256: hash(f.configBytes),
		effectiveConfigurationSha256: hash(f.effective),
		processId: 111,
		processStart: "12345",
		schemaVersion: 3,
		configVersion: "custom-v1",
		modelOptionId: "custom:model",
		modelId: "configured-model",
		reasoningLevels: ["medium"],
	});
	assert.doesNotMatch(result, /synthetic-never-output|synthetic module/);
	assert.notEqual(JSON.parse(result).modelId, fixture().job.expectedModelId);
});

for (const [name, change] of [
	[
		"configuration A/B drift",
		(s) => {
			s.effective.modelOptions[0].model = "other-model";
		},
	],
	[
		"effective config version drift",
		(s) => {
			s.effective.configVersion = "other-version";
		},
	],
	[
		"missing selected option",
		(s) => {
			s.option = "missing-option";
		},
	],
	[
		"duplicate environment binding",
		(s) => {
			s.duplicateEnvironment = true;
		},
	],
	[
		"no Host process",
		(s) => {
			s.candidates = ["222"];
		},
	],
	[
		"ambiguous Host processes",
		(s) => {
			s.candidates = ["111", "333"];
		},
	],
	[
		"missing signal hardening",
		(s) => {
			s.command = "node\0/app/dist/index.mjs\0";
		},
	],
	[
		"relative entrypoint outside /app",
		(s) => {
			s.command = "node\0--disable-sigusr1\0dist/index.mjs\0";
			s.cwd = "/other";
		},
	],
])
	test(`Runtime readback rejects ${name}`, () => {
		assert.throws(() => readbackFixture(change).run(), /READBACK_EXIT_2/);
	});
