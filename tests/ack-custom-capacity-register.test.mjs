import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	capacityProfile,
	customCapacityJobDefinitionHash,
	evidenceBytes,
	sha256,
} from "../deploy/ack/custom-capacity-inputs.mts";
import {
	registerCustomCapacity,
	runCustomCapacityPreflight,
} from "../deploy/ack/custom-capacity-register.mts";
import { parseInput as parseProvisionInput } from "../deploy/ack/provision-agents.ts";
import { runCapsule } from "../deploy/ack/run-capsule.ts";

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "custom-capacity-register-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const save = async (file, value) => {
		await writeFile(
			file,
			Buffer.isBuffer(value) ? value : evidenceBytes(value),
			{ mode: 0o600 },
		);
		return file;
	};
	const source = "1".repeat(40);
	const digest = `sha256:${"a".repeat(64)}`;
	const resources = {
		requests: { cpu: "100m", memory: "128Mi" },
		limits: { cpu: "1", memory: "2Gi" },
	};
	const job = {
		schemaVersion: 1,
		scope: "isolated-custom-runtime-capacity",
		sourceCommit: source,
		sourceWorktree: root,
		imageReference: `registry.example.test/custom@${digest}`,
		imageDigest: digest,
		parentImageReference: `registry.example.test/base@sha256:${"b".repeat(64)}`,
		platform: "linux/amd64",
		childManifestFile: join(root, "child.json"),
		imageConfigFile: join(root, "config.json"),
		parentManifestFile: join(root, "parent.json"),
		recipeFile: join(root, "recipe"),
		recipeSha256: "c".repeat(64),
		runtimeModuleSha256: "d".repeat(64),
		modelConfigurationSha256: "e".repeat(64),
		modelConfigurationPath: "/opt/custom-agent/config.json",
		customEnvironmentFile: join(root, "environment.json"),
		kubeconfig: join(root, "kubeconfig"),
		namespace: "test",
		outputDirectory: join(root, "attempt"),
		operatorApprovalRef: "approved-test",
		resourceProfileRef: "small",
		resources,
		modelOptionId: "model",
		reasoningLevel: "medium",
		runtimeConfigVersion: "v1",
		expectedModelId: "native-model",
		timeoutSeconds: 60,
		placement: {
			nodeSelector: { "kubernetes.io/arch": "amd64" },
			tolerations: [],
		},
	};
	await mkdir(job.outputDirectory, { mode: 0o700 });
	await save(job.customEnvironmentFile, { CUSTOM_MODEL_TOKEN: "fixture-only" });
	await save(
		job.kubeconfig,
		Buffer.from("apiVersion: v1\nkind: Config\nclusters: []\n"),
	);
	const jobFile = await save(join(root, "job.json"), job);
	const otherProfile = {
		imageDigest: `sha256:${"f".repeat(64)}`,
		marker: "preserved",
	};
	const profilesFile = await save(join(root, "profiles.json"), {
		schemaVersion: 1,
		profiles: [otherProfile],
	});
	const otherEvidence = {
		imageDigest: otherProfile.imageDigest,
		file: join(root, "other-receipt.json"),
	};
	const capacity = {
		schemaVersion: 1,
		sourceSha: source,
		resourceProfileRef: "small",
		resources,
		profilesFile,
		evidence: [otherEvidence],
	};
	const capacityFile = await save(join(root, "capacity.json"), capacity);
	const bodyFile = await save(join(root, "request.json"), {
		schemaVersion: 1,
		name: "custom-capacity-fixture",
		description: "Controlled custom capacity fixture",
		source: {
			kind: "custom",
			interactionMode: "platform-adapter",
			imageReference: job.imageReference,
		},
		coOwnerIds: [],
		availability: [],
		actions: [],
		environment: [],
		secrets: [],
	});
	const credentialFile = await save(
		join(root, "credential"),
		Buffer.from("fixture-only"),
	);
	const requestsFile = await save(join(root, "requests.json"), {
		schemaVersion: 1,
		origin: "https://platform.example.test",
		waitSeconds: 0,
		requests: [
			{
				name: "custom-capacity",
				bodyFile,
				credentialFile,
				idempotencyKey: "custom-capacity-fixture",
			},
		],
	});
	const input = {
		jobFile,
		capacityFile,
		requestsFile,
		sourceSha: source,
		kubeconfig: job.kubeconfig,
		namespace: job.namespace,
	};
	const measurement = join(job.outputDirectory, "measurement");
	const produce = async () => {
		await mkdir(measurement, { mode: 0o700 });
		const receipt = {
			schemaVersion: 1,
			scope: job.scope,
			sourceCommit: source,
			imageDigest: digest,
			source: {
				applicationSource: source,
				jobSha256: sha256(await readFile(jobFile)),
				jobDefinitionSha256: customCapacityJobDefinitionHash(job),
			},
			cleanup: { status: "cleaned" },
			runtimeModuleSha256: job.runtimeModuleSha256,
			modelConfigurationSha256: job.modelConfigurationSha256,
			customEnvironmentSha256: sha256(
				await readFile(job.customEnvironmentFile),
			),
			kubeconfigSha256: sha256(await readFile(job.kubeconfig)),
			recipeSha256: job.recipeSha256,
			nativeModelId: job.expectedModelId,
			businessVerified: false,
			maximumConcurrentExecutions: 1,
			observedResources: resources,
			terminalStatus: "completed",
			replyMatched: true,
			submittedAt: 1000,
			completedAt: 2000,
			modelFacts: [{ phase: "completed" }],
		};
		const bytes = evidenceBytes(receipt);
		await save(join(measurement, "runtime-capacity.receipt.json"), bytes);
		await save(join(measurement, "capacity-profile.json"), {
			schemaVersion: 1,
			profiles: [capacityProfile(job, bytes)],
		});
		return receipt;
	};
	return {
		root,
		save,
		job,
		input,
		capacity,
		profilesFile,
		otherProfile,
		otherEvidence,
		measurement,
		produce,
	};
}

test("fresh custom measurement registers raw bytes and preserves prior profiles/evidence; retry reuses without submission", async (t) => {
	const f = await fixture(t);
	let submissions = 0;
	const measure = async () => {
		submissions++;
		await f.produce();
	};
	assert.equal(
		(await runCustomCapacityPreflight(f.input, measure)).status,
		"registered",
	);
	const capacity = JSON.parse(await readFile(f.input.capacityFile));
	const profiles = JSON.parse(await readFile(f.profilesFile));
	assert.deepEqual(capacity.evidence[0], f.otherEvidence);
	assert.deepEqual(profiles.profiles[0], f.otherProfile);
	assert.equal(
		profiles.profiles[1].conformanceEvidenceHash,
		sha256(await readFile(capacity.evidence[1].file)),
	);
	const before = await Promise.all([
		readFile(f.input.capacityFile),
		readFile(f.profilesFile),
	]);
	assert.equal(
		(await runCustomCapacityPreflight(f.input, measure)).status,
		"reused",
	);
	assert.deepEqual(
		await Promise.all([
			readFile(f.input.capacityFile),
			readFile(f.profilesFile),
		]),
		before,
	);
	assert.equal(submissions, 1);
});

test("a complete unregistered receipt is registered without a second model request", async (t) => {
	const f = await fixture(t);
	await f.produce();
	assert.equal(
		(
			await runCustomCapacityPreflight(f.input, () =>
				assert.fail("resubmitted"),
			)
		).status,
		"registered",
	);
});

test("the same canonical request file passes provisioning configuration validation and capacity registration", async (t) => {
	const f = await fixture(t);
	const bytes = await readFile(f.input.requestsFile);
	const requests = JSON.parse(bytes);
	assert.equal(Object.hasOwn(requests, "sourceSha"), false);
	const planned = parseProvisionInput(requests);
	assert.equal(planned.origin, requests.origin);
	assert.deepEqual(planned.requests, requests.requests);
	assert.throws(
		() => parseProvisionInput({ ...requests, sourceSha: f.input.sourceSha }),
		/CONFIGURATION_INVALID/,
	);
	await f.produce();
	assert.equal(
		(await runCustomCapacityPreflight(f.input, () => assert.fail("submitted")))
			.status,
		"registered",
	);
	assert.deepEqual(await readFile(f.input.requestsFile), bytes);
});

for (const sourceInput of ["job", "capacity", "cli"]) {
	test(`wrong ${sourceInput} source is rejected before submission or registration`, async (t) => {
		const f = await fixture(t);
		const foreignSource = "2".repeat(40);
		if (sourceInput === "job")
			await f.save(f.input.jobFile, { ...f.job, sourceCommit: foreignSource });
		if (sourceInput === "capacity")
			await f.save(f.input.capacityFile, {
				...f.capacity,
				sourceSha: foreignSource,
			});
		const before = await Promise.all([
			readFile(f.input.capacityFile),
			readFile(f.profilesFile),
		]);
		await assert.rejects(
			runCustomCapacityPreflight(
				sourceInput === "cli"
					? { ...f.input, sourceSha: foreignSource }
					: f.input,
				() => assert.fail("submitted"),
			),
			/CUSTOM_CAPACITY_(?:TARGET|SOURCE)_MISMATCH/,
		);
		assert.deepEqual(
			await Promise.all([
				readFile(f.input.capacityFile),
				readFile(f.profilesFile),
			]),
			before,
		);
	});
}

test("rematerializing local paths preserves an approved measurement without resubmission", async (t) => {
	const f = await fixture(t);
	await runCustomCapacityPreflight(f.input, f.produce);
	const resolved = join(f.root, ".resolved-next");
	await mkdir(resolved, { mode: 0o700 });
	const relocated = { ...f.job };
	for (const key of [
		"sourceWorktree",
		"childManifestFile",
		"imageConfigFile",
		"parentManifestFile",
		"recipeFile",
		"customEnvironmentFile",
		"kubeconfig",
		"outputDirectory",
	])
		relocated[key] = join(resolved, key);
	for (const key of ["customEnvironmentFile", "kubeconfig"])
		await f.save(relocated[key], await readFile(f.job[key]));
	const jobFile = await f.save(join(resolved, "job.json"), relocated);
	const before = await readFile(f.input.capacityFile);
	assert.equal(
		(
			await runCustomCapacityPreflight(
				{ ...f.input, jobFile, kubeconfig: relocated.kubeconfig },
				() => assert.fail("resubmitted"),
			)
		).status,
		"reused",
	);
	assert.deepEqual(await readFile(f.input.capacityFile), before);
	await f.save(jobFile, {
		...relocated,
		modelConfigurationSha256: "f".repeat(64),
	});
	await assert.rejects(
		runCustomCapacityPreflight(
			{ ...f.input, jobFile, kubeconfig: relocated.kubeconfig },
			() => assert.fail("resubmitted"),
		),
		/CUSTOM_CAPACITY_RECEIPT_BINDING_MISMATCH/,
	);
});

test("profile-only interrupted registration resumes from the same successful bytes", async (t) => {
	const f = await fixture(t);
	await f.produce();
	const measured = JSON.parse(
		await readFile(join(f.measurement, "capacity-profile.json")),
	);
	await f.save(f.profilesFile, {
		schemaVersion: 1,
		profiles: [f.otherProfile, ...measured.profiles],
	});
	assert.equal(
		(
			await runCustomCapacityPreflight(f.input, () =>
				assert.fail("resubmitted"),
			)
		).status,
		"registered",
	);
});

for (const state of ["empty", "checkpoint", "failed", "receipt-only"]) {
	test(`${state} measurement requires recovery and never resubmits`, async (t) => {
		const f = await fixture(t);
		await mkdir(f.measurement, { mode: 0o700 });
		if (state !== "empty")
			await f.save(
				join(
					f.measurement,
					state === "failed"
						? "failure.json"
						: state === "checkpoint"
							? "checkpoint.json"
							: "runtime-capacity.receipt.json",
				),
				{},
			);
		const before = await readFile(f.input.capacityFile);
		await assert.rejects(
			runCustomCapacityPreflight(f.input, () => assert.fail("resubmitted")),
			/CUSTOM_CAPACITY_RECOVERY_REQUIRED/,
		);
		assert.deepEqual(await readFile(f.input.capacityFile), before);
	});
}

for (const change of [
	"source",
	"resources",
	"hash",
	"cleanup",
	"unknown",
	"job",
	"missing-environment-hash",
	"missing-kubeconfig-hash",
]) {
	test(`registration rejects ${change} drift before changing capacity inputs`, async (t) => {
		const f = await fixture(t);
		const receipt = await f.produce();
		if (change === "source") receipt.sourceCommit = "2".repeat(40);
		if (change === "resources")
			receipt.observedResources = {
				...receipt.observedResources,
				limits: { cpu: "2", memory: "2Gi" },
			};
		if (change === "cleanup") receipt.cleanup.status = "failed";
		if (change === "unknown") receipt.modelFacts.push({ phase: "unknown" });
		if (change === "job") receipt.source.jobDefinitionSha256 = "0".repeat(64);
		if (change === "missing-environment-hash")
			delete receipt.customEnvironmentSha256;
		if (change === "missing-kubeconfig-hash") delete receipt.kubeconfigSha256;
		const bytes = evidenceBytes(receipt);
		await f.save(
			join(f.measurement, "runtime-capacity.receipt.json"),
			change === "hash" ? Buffer.concat([bytes, Buffer.from(" ")]) : bytes,
		);
		if (change !== "hash")
			await f.save(join(f.measurement, "capacity-profile.json"), {
				schemaVersion: 1,
				profiles: [capacityProfile(f.job, bytes)],
			});
		const before = await Promise.all([
			readFile(f.input.capacityFile),
			readFile(f.profilesFile),
		]);
		await assert.rejects(registerCustomCapacity(f.input));
		assert.deepEqual(
			await Promise.all([
				readFile(f.input.capacityFile),
				readFile(f.profilesFile),
			]),
			before,
		);
	});
}

for (const privateInput of ["customEnvironmentFile", "kubeconfig"]) {
	for (const registered of [false, true]) {
		test(`${privateInput} content drift rejects ${registered ? "reusing" : "registering"} a measurement without resubmission`, async (t) => {
			const f = await fixture(t);
			await f.produce();
			if (registered) await registerCustomCapacity(f.input);
			const before = await Promise.all([
				readFile(f.input.capacityFile),
				readFile(f.profilesFile),
			]);
			await f.save(
				f.job[privateInput],
				Buffer.from("changed-private-fixture\n"),
			);
			await assert.rejects(
				runCustomCapacityPreflight(f.input, () => assert.fail("resubmitted")),
				/CUSTOM_CAPACITY_RECEIPT_BINDING_MISMATCH/,
			);
			assert.deepEqual(
				await Promise.all([
					readFile(f.input.capacityFile),
					readFile(f.profilesFile),
				]),
				before,
			);
		});
	}
}

test("wrong target and changed job fail without signing success or reusing the receipt", async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		runCustomCapacityPreflight({ ...f.input, namespace: "foreign" }, () =>
			assert.fail("submitted"),
		),
		/CUSTOM_CAPACITY_TARGET_MISMATCH/,
	);
	await assert.rejects(
		runCustomCapacityPreflight(f.input, async () => {
			await f.produce();
			await f.save(f.input.jobFile, { ...f.job, expectedModelId: "different" });
		}),
		/CUSTOM_CAPACITY_JOB_DRIFT/,
	);
	await assert.rejects(
		runCustomCapacityPreflight(f.input, () => assert.fail("resubmitted")),
		/CUSTOM_CAPACITY_RECEIPT_BINDING_MISMATCH/,
	);
});

test("a registered digest is not replaced by a different receipt or enlarged profile", async (t) => {
	const f = await fixture(t);
	await runCustomCapacityPreflight(f.input, f.produce);
	const before = await readFile(f.input.capacityFile);
	await f.save(join(f.measurement, "runtime-capacity.receipt.json"), {});
	await assert.rejects(
		runCustomCapacityPreflight(f.input, () => assert.fail("resubmitted")),
	);
	assert.deepEqual(await readFile(f.input.capacityFile), before);
});

test("registration lock prevents a concurrent publisher", async (t) => {
	const f = await fixture(t);
	await f.produce();
	await f.save(`${f.input.capacityFile}.custom-capacity-lock`, {});
	await assert.rejects(
		registerCustomCapacity(f.input),
		/CUSTOM_CAPACITY_REGISTRATION_LOCKED/,
	);
});

for (const command of ["custom-preflight", "runtime-inputs", "all"]) {
	test(`capsule ${command} promotes declared capacity profiles and portable receipt references`, async (t) => {
		const f = await fixture(t);
		const sourceRoot = join(f.root, "source");
		await mkdir(join(sourceRoot, "deploy/ack"), { recursive: true });
		await writeFile(
			join(sourceRoot, "deploy/ack/redeploy.sh"),
			`#!/usr/bin/env bash
set -euo pipefail
node - <<'NODE'
const fs = require('node:fs');
const capacity = JSON.parse(fs.readFileSync(process.env.ACK_WORKLOAD_CAPACITY_FILE));
const job = JSON.parse(fs.readFileSync(process.env.ACK_CUSTOM_CAPACITY_JOB_FILE));
fs.writeFileSync(capacity.profilesFile, JSON.stringify({schemaVersion: 1, profiles: [{imageDigest: 'custom-measured'}]}) + '\\n');
capacity.evidence = [{imageDigest: 'custom-measured', file: job.outputDirectory + '/receipt.json'}];
fs.writeFileSync(process.env.ACK_WORKLOAD_CAPACITY_FILE, JSON.stringify(capacity) + '\\n');
NODE
`,
			{ mode: 0o700 },
		);
		const git = (...args) =>
			execFileSync(
				"git",
				["-C", sourceRoot, "-c", "core.hooksPath=/dev/null", ...args],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			).trim();
		git("init", "-q");
		git("add", ".");
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.test",
			"commit",
			"-qm",
			"fixture",
		);
		await f.save(f.input.capacityFile, {
			schemaVersion: 1,
			profilesFile: "@CAPSULE_ROOT@/profiles.json",
			evidence: [],
		});
		await f.save(f.input.jobFile, {
			sourceWorktree: "@SOURCE_ROOT@",
			outputDirectory: "@CAPSULE_ROOT@/attempt",
		});
		const manifest = await f.save(join(f.root, "capsule.json"), {
			schemaVersion: 1,
			sourceSha: git("rev-parse", "HEAD"),
			inputs: ["capacity.json", "profiles.json", "job.json"],
			directories: ["attempt"],
			environment: {
				ACK_WORKLOAD_CAPACITY_FILE: "@CAPSULE_ROOT@/capacity.json",
				ACK_CUSTOM_CAPACITY_JOB_FILE: "@CAPSULE_ROOT@/job.json",
			},
		});
		const result = await runCapsule(manifest, command, sourceRoot);
		assert.equal(result.exitCode, 0);
		assert.deepEqual(result.promotedInputs.sort(), [
			"capacity.json",
			"profiles.json",
		]);
		assert.equal(
			JSON.parse(await readFile(f.profilesFile)).profiles[0].imageDigest,
			"custom-measured",
		);
		const capacity = JSON.parse(await readFile(f.input.capacityFile));
		assert.equal(capacity.profilesFile, "@CAPSULE_ROOT@/profiles.json");
		assert.equal(
			capacity.evidence[0].file,
			"@CAPSULE_ROOT@/attempt/receipt.json",
		);
	});
}

test("redeploy runs custom measurement before runtime-inputs only for an explicit job", async (t) => {
	const f = await fixture(t);
	const script = await readFile(
		new URL("../deploy/ack/redeploy.sh", import.meta.url),
		"utf8",
	);
	const split = script.indexOf('case "$command" in');
	const overrides = `
require_source_tuple() { :; }
require_file() { :; }
prepare_evidence() { :; }
configuration_source_preflight() { :; }
preflight_agent_requests() { :; }
bootstrap_database() { :; }
bootstrap_inputs() { :; }
deploy() { :; }
bootstrap_login() { :; }
provision() { :; }
validate() { :; }
runtime_inputs() { printf '%s\\n' runtime-inputs >> "$TEST_TRACE"; }
node() {
 if [[ "$*" == *custom-capacity-register.mts* ]]; then
  printf '%s\\n' custom-preflight >> "$TEST_TRACE"
  printf '%s\\n' '{"status":"registered"}'
 fi
}
`;
	for (const command of ["custom-preflight", "all"]) {
		for (const enabled of command === "all" ? [false, true] : [true]) {
			const trace = join(f.root, `${command}-${enabled}.trace`);
			await writeFile(trace, "", { mode: 0o600 });
			execFileSync(
				"bash",
				[
					"-c",
					`${script.slice(0, split)}\n${overrides}\n${script.slice(split)}`,
					"fixture",
					command,
				],
				{
					env: {
						PATH: process.env.PATH,
						ACK_SOURCE_SHA: f.input.sourceSha,
						ACK_EVIDENCE_DIR: f.root,
						ACK_KUBECONFIG: f.job.kubeconfig,
						ACK_CUSTOM_CAPACITY_JOB_FILE: enabled ? f.input.jobFile : "",
						ACK_WORKLOAD_CAPACITY_FILE: f.input.capacityFile,
						ACK_AGENT_REQUESTS_FILE: f.input.requestsFile,
						TEST_TRACE: trace,
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			assert.deepEqual(
				(await readFile(trace, "utf8")).trim().split("\n"),
				command === "custom-preflight"
					? ["custom-preflight"]
					: enabled
						? ["custom-preflight", "runtime-inputs"]
						: ["runtime-inputs"],
			);
		}
	}
});
