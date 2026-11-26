import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	assertWorkerMount,
	checkWorkloadCapacity,
	currentCapacityEvidence,
	parseRetainedTemplateMeasurements,
	validateCapacityBindings,
	validateRetainedTemplateCapacity,
} from "../deploy/ack/workload-capacity.ts";
import {
	sessionSandboxResourceCostsV1,
	workloadResourceConfigurationHashV1,
} from "../packages/platform-core/src/workload-resource-configuration.ts";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const imageDigest = `sha256:${"a".repeat(64)}`;
const policy = {
	resourceProfileRef: "small",
	resources: {
		requests: { cpu: "100m", memory: "128Mi" },
		limits: { cpu: "1", memory: "2Gi" },
	},
};
const measurement = {
	schemaVersion: 1,
	scope: "ack-runtime-capacity",
	imageDigest,
	maximumConcurrentExecutions: 1,
	observedResources: policy.resources,
	terminalStatus: "completed",
	replyMatched: true,
	modelOperationCount: 1,
	submittedAt: 1000,
	completedAt: 2000,
};
const evidenceBytes = Buffer.from(JSON.stringify(measurement));
const evidence = new Map([[imageDigest, evidenceBytes]]);
const profile = {
	schemaVersion: 1,
	imageDigest,
	resourceProfileRef: policy.resourceProfileRef,
	resourceConfigurationHash: hash(
		JSON.stringify({
			resourceProfileRef: policy.resourceProfileRef,
			...policy.resources,
		}),
	),
	maximumConcurrentExecutions: 1,
	conformanceEvidenceHash: hash(evidenceBytes),
};
const templates = [{ templateId: "codex", imageDigest }];
const standard = { source: { kind: "standard", templateId: "codex" } };
const custom = {
	source: {
		kind: "custom",
		interactionMode: "platform-adapter",
		imageReference: `registry.example.test/custom@${imageDigest}`,
	},
};
const check = (profiles, other = {}) =>
	validateCapacityBindings(
		other.requests ?? [standard, custom],
		other.templates ?? templates,
		other.policy ?? policy,
		profiles,
		other.evidence ?? evidence,
	);

test("one current measured binding covers a selected standard and custom digest", () => {
	assert.equal(check([profile]).imageCount, 1);
});

test("Codex SDK capacity binds the actual shared companion and both measured resource shares", () => {
	const half = {
		requests: { cpu: "50m", memory: "64Mi" },
		limits: { cpu: "500m", memory: "1Gi" },
	};
	const receipt = {
		...measurement,
		transport: "paseo-sdk-pod",
		observedContainerResources: [
			{ name: "runtime", resources: half },
			{ name: "pi-paseo", resources: half },
		],
	};
	const verify = (
		value = receipt,
		selected = { templateId: "codex", imageDigest, transport: "paseo-sdk-pod" },
	) => {
		const bytes = Buffer.from(JSON.stringify(value));
		return check([{ ...profile, conformanceEvidenceHash: hash(bytes) }], {
			requests: [standard],
			templates: [selected],
			evidence: new Map([[imageDigest, bytes]]),
		});
	};
	assert.equal(verify().imageCount, 1);
	for (const rows of [
		undefined,
		[{ name: "runtime", resources: half }],
		[
			{ name: "runtime", resources: half },
			{ name: "codex-paseo", resources: half },
		],
		[
			{ name: "runtime", resources: half },
			{
				name: "pi-paseo",
				resources: { ...half, limits: { ...half.limits, memory: "2Gi" } },
			},
		],
	])
		assert.throws(
			() => verify({ ...receipt, observedContainerResources: rows }),
			/CAPACITY_PI_LAYOUT_DRIFT/u,
		);
	assert.throws(
		() => verify({ ...receipt, transport: undefined }),
		/CAPACITY_TRANSPORT_DRIFT/u,
	);
	assert.throws(
		() => verify(receipt, { templateId: "codex", imageDigest }),
		/CAPACITY_TRANSPORT_DRIFT/u,
	);
});

function executorFixture(
	templateId = "codex",
	controlResources = policy.resources,
) {
	const executorPolicy = {
		resources: {
			requests: { cpu: "250m", memory: "256Mi" },
			limits: { cpu: "1", memory: "512Mi" },
		},
		tmpSizeLimit: "128Mi",
		placement: { architecture: "amd64" },
	};
	const input = {
		...policy,
		resources: controlResources,
		storageSize: "20Gi",
		storageClassName: "test-storage",
		codexSessionExecutor: executorPolicy,
	};
	const measured = {
		...measurement,
		observedResources: controlResources,
		resourceConfigurationHash: workloadResourceConfigurationHashV1(input),
		codexSessionExecutor: executorPolicy,
		...(templateId === "codex"
			? {
					observedExecutorResources: executorPolicy.resources,
					observedInitResources: executorPolicy.resources,
				}
			: {}),
		storageSize: input.storageSize,
		...(templateId === "codex"
			? { storageClassName: input.storageClassName }
			: {}),
		resourceCosts: sessionSandboxResourceCostsV1({
			...input,
			codexSessionExecutor:
				templateId === "codex" ? input.codexSessionExecutor : undefined,
		}),
	};
	const checkReceipt = (
		receipt = measured,
		requestList = [{ source: { kind: "standard", templateId } }],
	) => {
		const bytes = Buffer.from(JSON.stringify(receipt));
		return check(
			[
				{
					...profile,
					resourceConfigurationHash: workloadResourceConfigurationHashV1(input),
					conformanceEvidenceHash: hash(bytes),
				},
			],
			{
				requests: requestList,
				templates: [{ templateId, imageDigest }],
				policy: input,
				evidence: new Map([[imageDigest, bytes]]),
			},
		);
	};
	return { input, measured, checkReceipt };
}

test("Codex executor capacity binds both containers to the canonical policy and measured costs", () => {
	const f = executorFixture();
	assert.equal(f.checkReceipt().imageCount, 1);
});

test("native capacity rejects SDK transport evidence", () => {
	const f = executorFixture();
	assert.throws(
		() => f.checkReceipt({ ...f.measured, transport: "paseo-sdk" }),
		/CAPACITY_TRANSPORT_DRIFT/u,
	);
});

test("Codex SDK capacity keeps legacy executor policy but charges only its SDK containers", () => {
	const f = executorFixture();
	const half = {
		requests: { cpu: "50m", memory: "64Mi" },
		limits: { cpu: "500m", memory: "1Gi" },
	};
	const receipt = {
		...f.measured,
		transport: "paseo-sdk-pod",
		observedExecutorResources: undefined,
		observedInitResources: undefined,
		observedContainerResources: [
			{ name: "runtime", resources: half },
			{ name: "pi-paseo", resources: half },
		],
		resourceCosts: sessionSandboxResourceCostsV1({
			resources: policy.resources,
			storageSize: f.input.storageSize,
		}),
	};
	const verify = (value = receipt) => {
		const bytes = Buffer.from(JSON.stringify(value));
		return check(
			[
				{
					...profile,
					resourceConfigurationHash: workloadResourceConfigurationHashV1(
						f.input,
					),
					conformanceEvidenceHash: hash(bytes),
				},
			],
			{
				requests: [standard],
				templates: [
					{ templateId: "codex", imageDigest, transport: "paseo-sdk-pod" },
				],
				policy: f.input,
				evidence: new Map([[imageDigest, bytes]]),
			},
		);
	};
	assert.equal(verify().imageCount, 1);
	assert.throws(
		() =>
			verify({
				...receipt,
				observedExecutorResources: f.input.codexSessionExecutor.resources,
			}),
		/CAPACITY_EXECUTOR_LAYOUT_UNEXPECTED/u,
	);
	assert.equal(f.checkReceipt().imageCount, 1);
});

const completeControlResources = {
	requests: { ...policy.resources.requests, "ephemeral-storage": "256Mi" },
	limits: { ...policy.resources.limits, "ephemeral-storage": "1Gi" },
};

for (const templateId of ["codex", "claude", "opencode", "pi"])
	test(`${templateId} capacity checks full control resources under the unchanged portable hash`, () => {
		const f = executorFixture(templateId, completeControlResources);
		assert.equal(
			workloadResourceConfigurationHashV1(f.input),
			workloadResourceConfigurationHashV1(executorFixture(templateId).input),
		);
		const receipt = structuredClone(f.measured);
		receipt.observedResources.requests["ephemeral-storage"] = "0.25Gi";
		receipt.observedResources.limits["ephemeral-storage"] = "1024Mi";
		assert.equal(f.checkReceipt(receipt).imageCount, 1);
		for (const changed of [
			{ ...completeControlResources.limits, "ephemeral-storage": "1025Mi" },
			policy.resources.limits,
			{ ...completeControlResources.limits, gpu: "1" },
		])
			assert.throws(
				() =>
					f.checkReceipt({
						...receipt,
						observedResources: { ...completeControlResources, limits: changed },
					}),
				/CAPACITY_MEASURED_RESOURCES_DRIFT/u,
			);
	});

test("measured Kubernetes quantity aliases preserve the approved raw policy hash", () => {
	const f = executorFixture();
	f.input.resources = {
		requests: { cpu: "0.1", memory: "0.125Gi" },
		limits: { cpu: "1000m", memory: "2048Mi" },
	};
	f.input.codexSessionExecutor.resources = {
		requests: { cpu: "0.25", memory: "0.25Gi" },
		limits: { cpu: "1000m", memory: "0.5Gi" },
	};
	const receipt = {
		...f.measured,
		codexSessionExecutor: f.input.codexSessionExecutor,
		resourceConfigurationHash: workloadResourceConfigurationHashV1(f.input),
		resourceCosts: sessionSandboxResourceCostsV1(f.input),
		observedResources: {
			requests: { cpu: "100m", memory: "128Mi" },
			limits: { cpu: "1", memory: "2Gi" },
		},
		observedExecutorResources: {
			requests: { cpu: "250m", memory: "256Mi" },
			limits: { cpu: "1", memory: "512Mi" },
		},
		observedInitResources: {
			requests: { cpu: "250m", memory: "256Mi" },
			limits: { cpu: "1", memory: "512Mi" },
		},
	};
	assert.equal(f.checkReceipt(receipt).imageCount, 1);
});

for (const field of [
	"observedResources",
	"observedExecutorResources",
	"observedInitResources",
])
	test(`measured ${field} rejects undeclared resource keys`, () => {
		const f = executorFixture();
		const receipt = structuredClone(f.measured);
		receipt[field] = structuredClone(receipt[field]);
		receipt[field].limits.gpu = "1";
		assert.throws(() => f.checkReceipt(receipt));
		delete receipt[field].limits.gpu;
		receipt[field].extra = {};
		assert.throws(() => f.checkReceipt(receipt));
	});

for (const field of [
	"observedResources",
	"observedExecutorResources",
	"observedInitResources",
])
	test(`measured ${field} rejects changed quantity amounts`, () => {
		const f = executorFixture();
		const receipt = structuredClone(f.measured);
		receipt[field] = structuredClone(receipt[field]);
		receipt[field].limits.memory =
			field === "observedResources" ? "2049Mi" : "513Mi";
		assert.throws(() => f.checkReceipt(receipt));
	});

test("Codex executor rejects a legacy single-container receipt", () => {
	assert.throws(
		() => executorFixture().checkReceipt(measurement),
		/CAPACITY_RESOURCE_HASH_MISMATCH/,
	);
});

test("snapshot egress requires its canonical measured policy hash", () => {
	const input = {
		...policy,
		workspaceSnapshotEgress: [
			{
				destination: {
					namespace: "test",
					podLabels: { app: "snapshot-storage" },
				},
				port: 9000,
			},
		],
	};
	const canonicalHash = workloadResourceConfigurationHashV1(input);
	const verify = (receipt) => {
		const bytes = Buffer.from(JSON.stringify(receipt));
		return check(
			[
				{
					...profile,
					resourceConfigurationHash: canonicalHash,
					conformanceEvidenceHash: hash(bytes),
				},
			],
			{
				requests: [standard],
				policy: input,
				evidence: new Map([[imageDigest, bytes]]),
			},
		);
	};
	assert.throws(() => verify(measurement), /CAPACITY_RESOURCE_HASH_MISMATCH/);
	assert.equal(
		verify({ ...measurement, resourceConfigurationHash: canonicalHash })
			.imageCount,
		1,
	);
});

for (const missing of [
	"observedExecutorResources",
	"observedInitResources",
	"codexSessionExecutor",
	"resourceCosts",
	"storageSize",
	"storageClassName",
])
	test(`Codex executor rejects missing ${missing} evidence`, () => {
		const f = executorFixture();
		const receipt = structuredClone(f.measured);
		delete receipt[missing];
		assert.throws(() => f.checkReceipt(receipt));
	});

for (const changed of [
	"resourceConfigurationHash",
	"observedExecutorResources",
	"observedInitResources",
	"tmpSizeLimit",
	"placement",
	"resourceCosts",
	"storageSize",
	"storageClassName",
])
	test(`Codex executor rejects drifted ${changed} evidence`, () => {
		const f = executorFixture();
		const receipt = structuredClone(f.measured);
		if (changed === "resourceConfigurationHash")
			receipt[changed] = "f".repeat(64);
		else if (changed === "tmpSizeLimit")
			receipt.codexSessionExecutor.tmpSizeLimit = "256Mi";
		else if (changed === "placement")
			receipt.codexSessionExecutor.placement.architecture = "arm64";
		else if (changed === "resourceCosts")
			receipt.resourceCosts.memoryBytes -= 1;
		else if (changed === "storageSize") receipt.storageSize = "10Gi";
		else if (changed === "storageClassName")
			receipt.storageClassName = "other-storage";
		else receipt[changed].limits.cpu = "2";
		assert.throws(() => f.checkReceipt(receipt));
	});

test("a non-Codex measurement binds the global policy without claiming a second container", () => {
	const f = executorFixture("claude");
	assert.equal(f.checkReceipt().imageCount, 1);
	assert.throws(
		() =>
			f.checkReceipt({
				...f.measured,
				observedExecutorResources: f.input.codexSessionExecutor.resources,
			}),
		/CAPACITY_EXECUTOR_LAYOUT_UNEXPECTED/,
	);
});

test("a duplicate image under a preceding custom request cannot skip Codex executor layout checks", () => {
	const f = executorFixture();
	const receipt = structuredClone(f.measured);
	delete receipt.observedExecutorResources;
	delete receipt.observedInitResources;
	assert.throws(() => f.checkReceipt(receipt, [custom, standard]));
});

test("a custom source cannot select executor evidence by supplying templateId", () => {
	const f = executorFixture();
	assert.throws(
		() =>
			f.checkReceipt(f.measured, [
				{ source: { ...custom.source, templateId: "codex" } },
			]),
		/CAPACITY_RESOURCE_COST_DRIFT/,
	);
});

test("current templates without matching capacity fail instead of passing Agent readiness", () => {
	assert.throws(() => check([]), /CAPACITY_BINDING/);
	assert.throws(
		() => check([{ ...profile, imageDigest: `sha256:${"b".repeat(64)}` }]),
		/CAPACITY_BINDING/,
	);
});

test("ambiguous capacity and changed requests or limits fail closed", () => {
	assert.throws(() => check([profile, profile]), /CAPACITY_BINDING/);
	for (const field of ["requests", "limits"]) {
		const changed = structuredClone(policy);
		changed.resources[field].memory = "3Gi";
		assert.throws(
			() => check([profile], { policy: changed }),
			/CAPACITY_BINDING/,
		);
	}
});

test("placeholder hashes, missing evidence, changed evidence and invalid capacity fail", () => {
	assert.throws(() =>
		check([{ ...profile, conformanceEvidenceHash: "0".repeat(64) }]),
	);
	assert.throws(
		() => check([profile], { evidence: new Map() }),
		/CAPACITY_EVIDENCE/,
	);
	assert.throws(
		() =>
			check([profile], {
				evidence: new Map([[imageDigest, Buffer.from("changed")]]),
			}),
		/CAPACITY_EVIDENCE/,
	);
	assert.throws(() => check([{ ...profile, maximumConcurrentExecutions: 0 }]));
});

test("custom tags and ambiguous template identities cannot select a capacity profile", () => {
	assert.throws(() =>
		check([profile], {
			requests: [
				{
					source: {
						...custom.source,
						imageReference: "registry.example.test/custom:latest",
					},
				},
			],
		}),
	);
	assert.throws(() =>
		check([profile], { templates: [...templates, ...templates] }),
	);
});

test("self-managed entrypoints do not require a Platform Session capacity profile", () => {
	assert.equal(
		check([], {
			requests: [
				{ source: { kind: "custom", interactionMode: "self-managed" } },
			],
		}).imageCount,
		0,
	);
});

test("unmeasured files and evidence for another image/resources cannot authorize capacity", () => {
	for (const receipt of [
		{ kind: "pod-ready-only" },
		{ ...measurement, terminalStatus: "failed" },
		{ ...measurement, modelOperationCount: 0 },
		{ ...measurement, imageDigest: `sha256:${"b".repeat(64)}` },
		{
			...measurement,
			observedResources: {
				...policy.resources,
				limits: { cpu: "2", memory: "2Gi" },
			},
		},
	]) {
		const bytes = Buffer.from(JSON.stringify(receipt));
		assert.throws(() =>
			check([{ ...profile, conformanceEvidenceHash: hash(bytes) }], {
				evidence: new Map([[imageDigest, bytes]]),
			}),
		);
	}
	assert.throws(
		() => check([{ ...profile, maximumConcurrentExecutions: 100 }]),
		/CAPACITY_PROFILE_UNMEASURED/,
	);
});

const retainedDigest = `sha256:${"c".repeat(64)}`;
const retainedEntry = {
	templateId: "codex",
	imageDigest: retainedDigest,
	measurementDirectory: "/private/ack/retained-codex",
};

function retainedFixture(receiptChanges = {}) {
	const f = executorFixture("codex", completeControlResources);
	const receipt = {
		...structuredClone(f.measured),
		imageDigest: retainedDigest,
		...receiptChanges,
	};
	const bytes = Buffer.from(JSON.stringify(receipt));
	const retainedProfile = {
		...profile,
		imageDigest: retainedDigest,
		resourceConfigurationHash: workloadResourceConfigurationHashV1(f.input),
		conformanceEvidenceHash: hash(bytes),
	};
	const entries = parseRetainedTemplateMeasurements([retainedEntry], templates);
	return {
		...f,
		receipt,
		bytes,
		retainedProfile,
		verify: (profiles = [retainedProfile], evidenceBytes = bytes) =>
			validateRetainedTemplateCapacity(
				entries,
				f.input,
				profiles,
				new Map([[retainedDigest, evidenceBytes]]),
			),
	};
}

test("a retained Codex image keeps its own full-key measured approval", () => {
	const f = retainedFixture();
	assert.equal(f.verify(), 1);
	assert.equal(
		validateRetainedTemplateCapacity([], f.input, [], new Map()),
		0,
		"no declared retained image adds no requirement",
	);
});

test("a retained image cannot reuse a legacy profile, another image or changed evidence", () => {
	const f = retainedFixture();
	const legacyHash = workloadResourceConfigurationHashV1({
		resourceProfileRef: f.input.resourceProfileRef,
		resources: f.input.resources,
	});
	assert.notEqual(legacyHash, f.retainedProfile.resourceConfigurationHash);
	for (const profiles of [
		[],
		[{ ...f.retainedProfile, resourceConfigurationHash: legacyHash }],
		[{ ...f.retainedProfile, resourceProfileRef: "legacy-small" }],
		[{ ...f.retainedProfile, imageDigest }],
		[f.retainedProfile, f.retainedProfile],
	])
		assert.throws(
			() => f.verify(profiles),
			/CAPACITY_BINDING_MISSING_OR_AMBIGUOUS/u,
		);
	assert.throws(
		() => f.verify([f.retainedProfile], Buffer.from("{}")),
		/CAPACITY_EVIDENCE_MISMATCH/u,
	);
	for (const [changes, code] of [
		[
			{ observedExecutorResources: undefined },
			/CAPACITY_EXECUTOR_RESOURCES_DRIFT/u,
		],
		[{ observedInitResources: undefined }, /CAPACITY_INIT_RESOURCES_DRIFT/u],
		[
			{ resourceConfigurationHash: legacyHash },
			/CAPACITY_RESOURCE_HASH_MISMATCH/u,
		],
		[{ imageDigest }, /CAPACITY_EVIDENCE_NOT_MEASURED/u],
		[{ modelOperationCount: 0 }, /CAPACITY_MODEL_FACT_MISSING/u],
	])
		assert.throws(() => retainedFixture(changes).verify(), code);
});

test("retained entries reject current template images, unknown templates and loose inputs", () => {
	const parse = (value, list = templates) =>
		parseRetainedTemplateMeasurements(value, list);
	assert.deepEqual(parse(undefined), []);
	assert.throws(
		() => parse([{ ...retainedEntry, imageDigest }]),
		/CAPACITY_RETAINED_TEMPLATE_CURRENT/u,
	);
	for (const value of [
		[],
		{},
		[{ ...retainedEntry, templateId: "custom" }],
		[{ ...retainedEntry, templateId: "claude" }],
		[{ ...retainedEntry, imageDigest: "sha256:abc" }],
		[{ ...retainedEntry, measurementDirectory: "relative/dir" }],
		[{ ...retainedEntry, measurementDirectory: "/private/dir\nother" }],
		[{ ...retainedEntry, extra: true }],
		[retainedEntry, retainedEntry],
		Array.from({ length: 17 }, (_, index) => ({
			...retainedEntry,
			imageDigest: `sha256:${index.toString(16).padStart(64, "d")}`,
		})),
	])
		assert.throws(() => parse(value), /CAPACITY_RETAINED_TEMPLATE_INVALID/u);
	assert.throws(
		() => parse([retainedEntry], [...templates, ...templates]),
		/CAPACITY_RETAINED_TEMPLATE_INVALID/u,
	);
});

test("Worker binding requires the actual configuration mount and a restart after Secret changes", () => {
	const ref = { name: "worker-config", key: "capacity.json" };
	const secret = {
		metadata: {
			name: ref.name,
			namespace: "test",
			creationTimestamp: "2026-01-01T00:00:00Z",
			managedFields: [{ time: "2026-01-01T01:00:00Z" }],
		},
		data: { [ref.key]: "e30=" },
	};
	const pod = {
		metadata: { namespace: "test" },
		status: {
			phase: "Running",
			startTime: "2026-01-01T02:00:00Z",
			containerStatuses: [{ ready: true }],
		},
		spec: {
			containers: [
				{
					name: "platform-worker",
					env: [
						{
							name: "PLATFORM_WORKER_DEPLOYMENT_MODULE",
							value: "file:///app/dist/deployment.mjs",
						},
					],
					volumeMounts: [
						{
							name: "configuration",
							mountPath: "/app/dist/configuration.mjs",
							subPath: "configuration.mjs",
							readOnly: true,
						},
					],
				},
			],
			volumes: [{ name: "configuration", secret: { secretName: ref.name } }],
		},
	};
	assert.equal(
		assertWorkerMount(pod, secret, ref).configPath,
		"/app/dist/configuration.mjs",
	);
	const stale = structuredClone(pod);
	stale.status.startTime = "2026-01-01T00:30:00Z";
	assert.throws(
		() => assertWorkerMount(stale, secret, ref),
		/CAPACITY_WORKER_RESTART_REQUIRED/,
	);
	const foreign = structuredClone(pod);
	foreign.spec.volumes[0].secret.secretName = "another-secret";
	assert.throws(
		() => assertWorkerMount(foreign, secret, ref),
		/CAPACITY_WORKER_MOUNT_INVALID/,
	);
});

test("private input checks fail before cluster read when invalid and reject stale mounted profiles", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ack-capacity-"));
	const sourceSha = "a".repeat(40);
	const paths = Object.fromEntries(
		["config", "requests", "templates", "body", "profiles", "evidence"].map(
			(name) => [name, join(dir, `${name}.json`)],
		),
	);
	const write = (name, value) =>
		writeFile(paths[name], JSON.stringify(value), { mode: 0o600 });
	try {
		await write("config", {
			schemaVersion: 1,
			sourceSha,
			...policy,
			profilesFile: paths.profiles,
			evidence: [{ imageDigest, file: paths.evidence }],
			workerSecretRef: { name: "worker-config", key: "capacity.json" },
		});
		await write("requests", {
			schemaVersion: 1,
			requests: [{ bodyFile: paths.body }],
		});
		await write("templates", { schemaVersion: 1, sourceSha, templates });
		await write("body", standard);
		await writeFile(paths.evidence, evidenceBytes, { mode: 0o600 });
		await write("profiles", { schemaVersion: 1, profiles: [] });
		let reads = 0;
		const read = () => {
			reads++;
			return {
				...policy,
				storageSize: "20Gi",
				storageClassName: "legacy-worker-storage",
				profiles: [profile],
				secretRef: { name: "worker-config", key: "capacity.json" },
				bytes: Buffer.from(
					JSON.stringify({ schemaVersion: 1, profiles: [profile] }),
				),
			};
		};
		await assert.rejects(
			checkWorkloadCapacity(
				paths.config,
				paths.requests,
				paths.templates,
				sourceSha,
				read,
			),
			/CAPACITY_BINDING/,
		);
		assert.equal(reads, 0);
		await write("profiles", { schemaVersion: 1, profiles: [profile] });
		assert.equal(
			(
				await checkWorkloadCapacity(
					paths.config,
					paths.requests,
					paths.templates,
					sourceSha,
					read,
				)
			).mountedInputVerified,
			true,
		);
		await assert.rejects(
			checkWorkloadCapacity(
				paths.config,
				paths.requests,
				paths.templates,
				sourceSha,
				() => ({ ...read(), bytes: Buffer.from("stale") }),
			),
			/CAPACITY_SECRET_DRIFT/,
		);
		await assert.rejects(
			checkWorkloadCapacity(
				paths.config,
				paths.requests,
				paths.templates,
				sourceSha,
				() => ({
					...read(),
					secretRef: { name: "other-worker", key: "capacity.json" },
				}),
			),
			/CAPACITY_WORKER_SECRET_BINDING_DRIFT/,
		);
		await assert.rejects(
			checkWorkloadCapacity(
				paths.config,
				paths.requests,
				paths.templates,
				sourceSha,
				() => ({
					...read(),
					resources: {
						...policy.resources,
						limits: { cpu: "2", memory: "2Gi" },
					},
				}),
			),
			/CAPACITY_WORKER_POLICY_DRIFT/,
		);
		await assert.rejects(
			checkWorkloadCapacity(
				paths.config,
				paths.requests,
				paths.templates,
				sourceSha,
				() => ({ ...read(), profiles: [] }),
			),
			/CAPACITY_WORKER_PROFILES_DRIFT/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the mounted gate requires each retained image's measured profile in the actual Worker input", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ack-retained-capacity-"));
	const sourceSha = "a".repeat(40);
	const paths = Object.fromEntries(
		[
			"config",
			"requests",
			"templates",
			"body",
			"profiles",
			"evidence",
			"retained",
		].map((name) => [name, join(dir, `${name}.json`)]),
	);
	const write = (name, value) =>
		writeFile(paths[name], JSON.stringify(value), { mode: 0o600 });
	const retainedBytes = Buffer.from(
		JSON.stringify({ ...measurement, imageDigest: retainedDigest }),
	);
	const retainedProfile = {
		...profile,
		imageDigest: retainedDigest,
		conformanceEvidenceHash: hash(retainedBytes),
	};
	const document = { schemaVersion: 1, profiles: [profile, retainedProfile] };
	const secretRef = { name: "worker-config", key: "capacity.json" };
	let reads = 0;
	const read =
		(profiles = document.profiles) =>
		() => {
			reads++;
			return {
				...policy,
				profiles,
				secretRef,
				bytes: Buffer.from(JSON.stringify(document)),
			};
		};
	const gate = (reader) =>
		checkWorkloadCapacity(
			paths.config,
			paths.requests,
			paths.templates,
			sourceSha,
			reader,
		);
	try {
		await write("config", {
			schemaVersion: 1,
			sourceSha,
			...policy,
			profilesFile: paths.profiles,
			evidence: [
				{ imageDigest, file: paths.evidence },
				{ imageDigest: retainedDigest, file: paths.retained },
			],
			retainedTemplateMeasurements: [
				{ ...retainedEntry, measurementDirectory: dir },
			],
			workerSecretRef: secretRef,
		});
		await write("requests", {
			schemaVersion: 1,
			requests: [{ bodyFile: paths.body }],
		});
		await write("templates", { schemaVersion: 1, sourceSha, templates });
		await write("body", standard);
		await writeFile(paths.evidence, evidenceBytes, { mode: 0o600 });
		await writeFile(paths.retained, retainedBytes, { mode: 0o600 });
		await write("profiles", document);
		const passed = await gate(read());
		assert.equal(passed.imageCount, 1);
		assert.equal(passed.retainedImageCount, 1);
		assert.equal(passed.mountedInputVerified, true);
		await assert.rejects(
			gate(read([profile])),
			/CAPACITY_WORKER_PROFILES_DRIFT/,
		);
		reads = 0;
		await write("profiles", { schemaVersion: 1, profiles: [profile] });
		await assert.rejects(gate(read()), /CAPACITY_BINDING_MISSING_OR_AMBIGUOUS/);
		await write("profiles", document);
		await writeFile(paths.retained, Buffer.from("{}"), { mode: 0o600 });
		await assert.rejects(gate(read()), /CAPACITY_EVIDENCE_MISMATCH/);
		assert.equal(reads, 0, "local evidence failures stop before cluster reads");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("ACS capacity requires its own hash, placement and observed ACS instance", () => {
	const acs = {
		...policy,
		sessionRuntimePlacement: { architecture: "amd64", compute: "acs" },
	};
	assert.throws(
		() => check([profile], { policy: acs }),
		/CAPACITY_BINDING_MISSING/,
	);
	const measured = {
		...measurement,
		resourceConfigurationHash: workloadResourceConfigurationHashV1(acs),
		sessionRuntimePlacement: acs.sessionRuntimePlacement,
		computeInstanceId: "acs-synthetic01",
		observedResources: {
			...policy.resources,
			requests: { ...policy.resources.requests, "ephemeral-storage": "30Gi" },
		},
	};
	const verify = () => {
		const bytes = Buffer.from(JSON.stringify(measured));
		return check(
			[
				{
					...profile,
					resourceConfigurationHash: measured.resourceConfigurationHash,
					conformanceEvidenceHash: hash(bytes),
				},
			],
			{
				policy: acs,
				requests: [standard],
				evidence: new Map([[imageDigest, bytes]]),
			},
		);
	};
	assert.equal(verify().businessVerified, false);
	measured.computeInstanceId = "eci-synthetic01";
	assert.throws(verify, /CAPACITY_COMPUTE_DRIFT/);
});

test("Codex SDK ACS capacity binds both measured containers without double charging", () => {
	const acs = {
		...policy,
		sessionRuntimePlacement: { architecture: "amd64", compute: "acs" },
	};
	const containerResources = {
		requests: { cpu: "50m", memory: "67108864", "ephemeral-storage": "30Gi" },
		limits: { cpu: "500m", memory: "1073741824" },
	};
	const measured = {
		...measurement,
		transport: "paseo-sdk-pod",
		resourceConfigurationHash: workloadResourceConfigurationHashV1(acs),
		sessionRuntimePlacement: acs.sessionRuntimePlacement,
		computeInstanceId: "acs-sdk01",
		observedContainerResources: [
			{ name: "runtime", resources: structuredClone(containerResources) },
			{ name: "pi-paseo", resources: structuredClone(containerResources) },
		],
	};
	const verify = () => {
		const bytes = Buffer.from(JSON.stringify(measured));
		return check(
			[
				{
					...profile,
					resourceConfigurationHash: measured.resourceConfigurationHash,
					conformanceEvidenceHash: hash(bytes),
				},
			],
			{
				policy: acs,
				requests: [standard],
				templates: [{ ...templates[0], transport: "paseo-sdk-pod" }],
				evidence: new Map([[imageDigest, bytes]]),
			},
		);
	};
	assert.equal(verify().imageCount, 1);
	measured.observedContainerResources[1].resources.limits.cpu = "501m";
	assert.throws(verify, /CAPACITY_PI_LAYOUT_DRIFT/);
});

test("one Codex digest retains separate ECI and ACS receipts when the deployment changes compute", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "ack-capacity-compute-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const acsPolicy = {
		...policy,
		sessionRuntimePlacement: { compute: "acs", architecture: "amd64" },
	};
	const acsHash = workloadResourceConfigurationHashV1(acsPolicy);
	const acsBytes = Buffer.from(
		JSON.stringify({
			...measurement,
			resourceConfigurationHash: acsHash,
			sessionRuntimePlacement: acsPolicy.sessionRuntimePlacement,
		}),
	);
	const profiles = [
		profile,
		{
			...profile,
			resourceConfigurationHash: acsHash,
			conformanceEvidenceHash: hash(acsBytes),
		},
	];
	const entries = [];
	for (const [compute, bytes] of [
		["eci", evidenceBytes],
		["acs", acsBytes],
	]) {
		const file = join(directory, compute + ".json");
		await writeFile(file, bytes, { mode: 0o600 });
		entries.push({ imageDigest, file });
	}
	for (const [deployment, bytes] of [
		[policy, evidenceBytes],
		[acsPolicy, acsBytes],
	]) {
		assert.deepEqual(
			(await currentCapacityEvidence(entries, profiles, deployment)).get(
				imageDigest,
			),
			bytes,
		);
	}
	await assert.rejects(
		currentCapacityEvidence([...entries, entries[0]], profiles, acsPolicy),
		/CAPACITY_EVIDENCE_MISMATCH/,
	);
	await writeFile(entries[0].file, "changed measurement");
	await assert.rejects(
		currentCapacityEvidence(entries, profiles, acsPolicy),
		/CAPACITY_EVIDENCE_MISMATCH/,
	);
});
