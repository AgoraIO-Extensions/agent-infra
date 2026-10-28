import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareBootstrapInputs } from "../deploy/ack/bootstrap-inputs.ts";
import { publishRuntimeInputs } from "../deploy/ack/runtime-inputs.ts";
import { templatePreflightValidationReceipt } from "../deploy/ack/template-validation.mjs";
import { checkWorkloadCapacity } from "../deploy/ack/workload-capacity.ts";

const source = "a".repeat(40);
const owner = "11111111-1111-4111-8111-111111111111";
const clusterUid = "22222222-2222-4222-8222-222222222222";
const ownerLabel = "agent-infra.agora.io/bootstrap-id";
const namespace = "ack-test";
const resources = {
	requests: { cpu: "100m", memory: "128Mi" },
	limits: { cpu: "1", memory: "2Gi" },
};

async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "ack-runtime-inputs-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const save = async (path, value) => {
		await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
		await writeFile(
			path,
			typeof value === "string" ? value : `${JSON.stringify(value)}\n`,
			{ mode: 0o600 },
		);
		return path;
	};
	const files = Object.fromEntries(
		["bootstrap", "templates", "capacity", "requests"].map((name) => [
			name,
			join(directory, `${name}.json`),
		]),
	);
	const definitions = [
		["codex", "codex"],
		["claude", "claude"],
		["opencode", "acp"],
		["pi", "pi"],
	];
	const templates = [];
	const requests = [];
	const now = Date.now();
	for (const [index, [templateId, driver]] of definitions.entries()) {
		const imageDigest = `sha256:${String(index + 1).repeat(64)}`;
		const validation = {
			schemaVersion: 1,
			templateId,
			sourceCommit: source,
			imageDigest,
			driver,
			configurationRevision: `revision-${templateId}`,
			modelId: `model-${templateId}`,
			status: "passed",
			evidenceKind: "real-runtime-model",
			executionId: `execution-${templateId}`,
			validatedAt: now - 1_000,
			validUntil: now + 600_000,
		};
		const measured = {
			...validation,
			scope: "isolated-template-real-model",
			terminalStatus: "completed",
			modelFactSource: "protected-driver-journal",
			modelOperationCount: 1,
		};
		const output = join(directory, "measurements", templateId);
		const validationFile = await save(
			join(output, "candidate.json"),
			validation,
		);
		const preflightFile = await save(
			join(output, "validation.json"),
			templatePreflightValidationReceipt(measured),
		);
		await save(join(output, "runtime-capacity.receipt.json"), {
			schemaVersion: 1,
			scope: "ack-runtime-capacity",
			sourceCommit: source,
			imageDigest,
			observedResources: resources,
			maximumConcurrentExecutions: 1,
			terminalStatus: "completed",
			replyMatched: true,
			modelOperationCount: 1,
			submittedAt: now - 2_000,
			completedAt: now - 1_000,
		});
		templates.push({
			templateId,
			driver,
			imageDigest,
			configurationRevision: validation.configurationRevision,
			modelId: validation.modelId,
			validationFile,
			preflightFile,
		});
		requests.push({
			bodyFile: await save(join(directory, "requests", `${templateId}.json`), {
				source: { kind: "standard", templateId },
			}),
		});
	}
	const profilesFile = join(directory, "worker", "capacity.json");
	const capacity = {
		schemaVersion: 1,
		sourceSha: source,
		profilesFile,
		resourceProfileRef: "bounded-runtime",
		resources,
		workerSecretRef: { name: "worker-config", key: "capacity.json" },
		evidence: [],
	};
	await save(profilesFile, { schemaVersion: 1, profiles: [] });
	await save(files.capacity, capacity);
	await save(files.templates, {
		schemaVersion: 1,
		sourceSha: source,
		minValidityMs: 60_000,
		templates,
	});
	await save(files.requests, { schemaVersion: 1, requests });
	const objects = [];
	for (const component of ["api", "worker"]) {
		const inputs = {
			"configuration.mjs": await save(
				join(directory, component, "configuration.mjs"),
				"export const input = {};",
			),
			"private-input": await save(
				join(directory, component, "private-input"),
				"private-config-sentinel",
			),
		};
		for (const [templateId] of definitions) {
			const key = `template-validation-${templateId}.json`;
			inputs[key] = await save(join(directory, component, key), {
				status: "not-yet-measured",
			});
		}
		if (component === "worker") inputs["capacity.json"] = profilesFile;
		objects.push({
			kind: "Secret",
			name: `${component}-config`,
			files: inputs,
		});
	}
	const bootstrap = {
		schemaVersion: 1,
		installationId: owner,
		clusterUid,
		namespace,
		objects,
	};
	await save(files.bootstrap, bootstrap);
	const deployments = ["api", "worker"].map((component) => ({
		apiVersion: "apps/v1",
		kind: "Deployment",
		metadata: { name: `agent-infra-${component}`, namespace },
		spec: {
			template: {
				metadata: {},
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
							volumeMounts: [
								{
									name: "configuration",
									readOnly: true,
									mountPath:
										component === "api"
											? "/app/deployment"
											: "/app/dist/configuration.mjs",
									...(component === "worker"
										? { subPath: "configuration.mjs" }
										: {}),
								},
							],
						},
					],
					volumes: [
						{
							name: "configuration",
							secret: { secretName: `${component}-config` },
						},
					],
				},
			},
		},
	}));
	const rendered = deployments.map((d) => JSON.stringify(d)).join("\n---\n");
	const cluster = new Map([
		["namespace/kube-system", { metadata: { uid: clusterUid } }],
		[
			`namespace/${namespace}`,
			{ metadata: { uid: "namespace-uid", labels: { [ownerLabel]: owner } } },
		],
	]);
	for (const object of [
		...(await prepareBootstrapInputs(bootstrap, rendered)),
		...deployments,
	]) {
		const item = structuredClone(object);
		Object.assign(item.metadata, {
			uid: `${item.metadata.name}-uid`,
			resourceVersion: "1",
			generation: 1,
		});
		if (item.kind === "Deployment")
			item.status = {
				observedGeneration: 1,
				updatedReplicas: 1,
				availableReplicas: 1,
			};
		cluster.set(`${item.kind.toLowerCase()}/${item.metadata.name}`, item);
	}
	const mutations = [];
	let beforeCall = () => {};
	let afterReplace = () => {};
	const kubectl = (args, input) => {
		beforeCall(args);
		const verb = args.find((v) =>
			["get", "replace", "patch", "rollout"].includes(v),
		);
		const index = args.indexOf(verb);
		if (verb === "get")
			return JSON.stringify(
				cluster.get(`${args[index + 1]}/${args[index + 2]}`),
			);
		if (verb === "replace") {
			const object = JSON.parse(input);
			const key = `secret/${object.metadata.name}`;
			const current = cluster.get(key);
			assert.equal(object.metadata.uid, current.metadata.uid);
			assert.equal(
				object.metadata.resourceVersion,
				current.metadata.resourceVersion,
			);
			object.metadata.resourceVersion = String(
				Number(current.metadata.resourceVersion) + 1,
			);
			cluster.set(key, object);
			mutations.push(`replace:${object.metadata.name}`);
			afterReplace(object);
			return JSON.stringify(object);
		}
		if (verb === "patch") {
			const name = args[index + 2];
			const patch = JSON.parse(args[args.indexOf("-p") + 1]);
			const current = cluster.get(`deployment/${name}`);
			assert.equal(patch.metadata.uid, current.metadata.uid);
			assert.equal(
				patch.metadata.resourceVersion,
				current.metadata.resourceVersion,
			);
			current.spec.template.metadata.annotations = {
				...current.spec.template.metadata.annotations,
				...patch.spec.template.metadata.annotations,
			};
			current.metadata.resourceVersion = String(
				Number(current.metadata.resourceVersion) + 1,
			);
			current.metadata.generation += 1;
			current.status.observedGeneration = current.metadata.generation;
			mutations.push(`patch:${name}`);
			return JSON.stringify(current);
		}
		if (verb === "rollout") return "success";
		throw Error("unexpected kubectl operation");
	};
	return {
		files,
		rendered,
		capacity,
		cluster,
		mutations,
		templates,
		bootstrap,
		save,
		kubectl,
		beforeCall(fn) {
			beforeCall = fn;
		},
		afterReplace(fn) {
			afterReplace = fn;
		},
	};
}

test("fresh measured outputs reach both consumers and pass the capacity gate; reruns do not rewrite or restart", async (t) => {
	const f = await fixture(t);
	const before = JSON.parse(
		Buffer.from(
			f.cluster.get("secret/api-config").data["template-validation-codex.json"],
			"base64",
		),
	);
	assert.equal(before.status, "not-yet-measured");
	const plan = await publishRuntimeInputs(
		f.files,
		f.rendered,
		source,
		f.kubectl,
	);
	assert.equal(plan.changedSecretCount, 2);
	assert.equal(f.mutations.length, 0);
	const result = await publishRuntimeInputs(
		f.files,
		f.rendered,
		source,
		f.kubectl,
		true,
	);
	assert.equal(result.rolloutCount, 2);
	assert(
		f.mutations.findIndex((e) => e.startsWith("patch:")) >
			f.mutations.findLastIndex((e) => e.startsWith("replace:")),
	);
	for (const name of ["api-config", "worker-config"]) {
		const data = f.cluster.get(`secret/${name}`).data;
		assert.equal(
			Buffer.from(data["private-input"], "base64").toString(),
			"private-config-sentinel",
		);
		for (const expected of f.templates)
			assert.deepEqual(
				Buffer.from(
					data[`template-validation-${expected.templateId}.json`],
					"base64",
				),
				await readFile(expected.validationFile),
			);
	}
	const readWorker = (secretRef) => {
		const bytes = Buffer.from(
			f.cluster.get(`secret/${secretRef.name}`).data[secretRef.key],
			"base64",
		);
		return {
			...f.capacity,
			bytes,
			profiles: JSON.parse(bytes).profiles,
			secretRef,
		};
	};
	assert.equal(
		(
			await checkWorkloadCapacity(
				f.files.capacity,
				f.files.requests,
				f.files.templates,
				source,
				readWorker,
			)
		).imageCount,
		4,
	);
	const mutationCount = f.mutations.length;
	const repeated = await publishRuntimeInputs(
		f.files,
		f.rendered,
		source,
		f.kubectl,
		true,
	);
	assert.equal(repeated.changedSecretCount, 0);
	assert.equal(repeated.rolloutCount, 0);
	assert.equal(f.mutations.length, mutationCount);
});

test("publishing standard measurements preserves a separately measured custom image", async (t) => {
	const f = await fixture(t);
	const imageDigest = `sha256:${"e".repeat(64)}`;
	const receiptFile = join(
		f.capacity.profilesFile,
		"..",
		"custom-measurement.json",
	);
	const now = Date.now();
	await f.save(receiptFile, {
		schemaVersion: 1,
		scope: "isolated-custom-runtime-capacity",
		imageDigest,
		maximumConcurrentExecutions: 1,
		terminalStatus: "completed",
		replyMatched: true,
		submittedAt: now - 2_000,
		completedAt: now - 1_000,
		observedResources: resources,
		modelFacts: [{ kind: "model", phase: "completed" }],
	});
	const hash = (value) => createHash("sha256").update(value).digest("hex");
	const profile = {
		schemaVersion: 1,
		imageDigest,
		resourceProfileRef: f.capacity.resourceProfileRef,
		resourceConfigurationHash: hash(
			JSON.stringify({
				resourceProfileRef: f.capacity.resourceProfileRef,
				...resources,
			}),
		),
		maximumConcurrentExecutions: 1,
		conformanceEvidenceHash: hash(await readFile(receiptFile)),
	};
	await f.save(f.capacity.profilesFile, {
		schemaVersion: 1,
		profiles: [profile],
	});
	f.cluster.get("secret/worker-config").data["capacity.json"] = (
		await readFile(f.capacity.profilesFile)
	).toString("base64");
	f.capacity.evidence.push({ imageDigest, file: receiptFile });
	await f.save(f.files.capacity, f.capacity);
	const requests = JSON.parse(await readFile(f.files.requests));
	requests.requests.push({
		bodyFile: await f.save(join(receiptFile, "..", "custom-request.json"), {
			source: {
				kind: "custom",
				interactionMode: "platform-adapter",
				imageReference: `registry.example.test/custom@${imageDigest}`,
			},
		}),
	});
	await f.save(f.files.requests, requests);
	await publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true);
	const after = JSON.parse(await readFile(f.capacity.profilesFile));
	assert.equal(after.profiles.length, 5);
	assert.deepEqual(
		after.profiles.find((p) => p.imageDigest === imageDigest),
		profile,
	);
	const capacity = JSON.parse(await readFile(f.files.capacity));
	assert.equal(
		capacity.evidence.find((e) => e.imageDigest === imageDigest).file,
		receiptFile,
	);
});

for (const scenario of [
	"owner",
	"namespace-owner",
	"unrelated-key",
	"cluster",
	"consumer-mount",
	"undeclared-template-key",
	"capacity-target-key",
	"measured-resources",
	"unmeasured-capacity",
]) {
	test(`runtime input publication rejects ${scenario} before any write`, async (t) => {
		const f = await fixture(t);
		if (scenario === "owner")
			f.cluster.get("secret/worker-config").metadata.labels[ownerLabel] =
				"another-installation";
		if (scenario === "namespace-owner")
			f.cluster.get(`namespace/${namespace}`).metadata.labels[ownerLabel] =
				"another-installation";
		if (scenario === "unrelated-key")
			f.cluster.get("secret/worker-config").data["private-input"] = "changed";
		if (scenario === "cluster")
			f.cluster.get("namespace/kube-system").metadata.uid = "another-cluster";
		if (scenario === "consumer-mount")
			f.cluster.get(
				"deployment/agent-infra-worker",
			).spec.template.spec.volumes[0].secret.secretName = "another-secret";
		if (scenario === "undeclared-template-key") {
			delete f.bootstrap.objects[0].files["template-validation-pi.json"];
			await f.save(f.files.bootstrap, f.bootstrap);
		}
		if (scenario === "capacity-target-key") {
			f.capacity.workerSecretRef.key = "private-input";
			await f.save(f.files.capacity, f.capacity);
		}
		if (scenario.startsWith("measured") || scenario === "unmeasured-capacity") {
			const path = join(
				f.templates[0].validationFile,
				"..",
				"runtime-capacity.receipt.json",
			);
			const receipt = JSON.parse(await readFile(path));
			if (scenario === "measured-resources")
				receipt.observedResources.limits.memory = "4Gi";
			else receipt.maximumConcurrentExecutions = 100;
			await f.save(path, receipt);
		}
		await assert.rejects(
			publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		);
		assert.equal(f.mutations.length, 0);
	});
}

test("resourceVersion drift cannot overwrite a concurrently changed configuration", async (t) => {
	const f = await fixture(t);
	let apiReads = 0;
	f.beforeCall((args) => {
		if (args.includes("get") && args.includes("api-config") && ++apiReads === 2)
			f.cluster.get("secret/api-config").metadata.resourceVersion =
				"concurrent-version";
	});
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		/SECRET_VERSION_DRIFT/,
	);
	assert.equal(f.mutations.length, 0);
});

test("namespace replacement invalidates the plan before the first Secret write", async (t) => {
	const f = await fixture(t);
	let namespaceReads = 0;
	f.beforeCall((args) => {
		if (
			args.includes("get") &&
			args.includes("namespace") &&
			args.includes(namespace) &&
			++namespaceReads === 2
		)
			f.cluster.get(`namespace/${namespace}`).metadata.uid =
				"replacement-namespace";
	});
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		/NAMESPACE_DRIFT/,
	);
	assert.equal(f.mutations.length, 0);
});

test("an interrupted rollout resumes without replacing verified Secrets again", async (t) => {
	const f = await fixture(t);
	f.beforeCall((args) => {
		if (args.includes("rollout")) throw Error("rollout interrupted");
	});
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		/rollout interrupted/,
	);
	assert.equal(f.mutations.filter((m) => m.startsWith("replace:")).length, 2);
	f.beforeCall(() => {});
	const resumed = await publishRuntimeInputs(
		f.files,
		f.rendered,
		source,
		f.kubectl,
		true,
	);
	assert.equal(resumed.changedSecretCount, 0);
	assert.equal(resumed.rolloutCount, 1);
	assert.equal(f.mutations.filter((m) => m.startsWith("replace:")).length, 2);
});

test("a concurrent Secret edit during rollout cannot be reported as published inputs", async (t) => {
	const f = await fixture(t);
	f.beforeCall((args) => {
		if (
			args.includes("rollout") &&
			args.includes("deployment/agent-infra-worker")
		)
			f.cluster.get("secret/api-config").metadata.resourceVersion =
				"concurrent-change";
	});
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		/SECRET_CHANGED_DURING_ROLLOUT/,
	);
});

test("failed Secret readback prevents consumer rollout and local input promotion", async (t) => {
	const f = await fixture(t);
	f.afterReplace((object) => {
		object.data["template-validation-codex.json"] = "incorrect";
	});
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		/SECRET_READBACK_FAILED/,
	);
	assert(f.mutations.every((value) => value.startsWith("replace:")));
	const local = JSON.parse(
		await readFile(
			f.bootstrap.objects[0].files["template-validation-codex.json"],
		),
	);
	assert.equal(local.status, "not-yet-measured");
});

for (const fresh of [false, true]) {
	for (const failPublication of [false, true]) {
		test(`all publishes ${fresh ? "fresh" : "supplied"} receipts before provisioning (failure=${failPublication})`, async () => {
			const script = await readFile(new URL("../deploy/ack/redeploy.sh", import.meta.url), "utf8");
			const dispatch = script.slice(script.indexOf('command=${1:-help}'));
			// Run the real dispatch with observable external-stage boundaries.
			const result = spawnSync("bash", ["-c", `
set -euo pipefail
require_source_tuple() { echo source; }
require_file() { [[ -n "$2" ]]; }
bootstrap_database() { echo database; }
bootstrap_inputs() { echo bootstrap; }
deploy() { echo deploy; }
template_preflight() { echo preflight; }
runtime_inputs() { echo publish; ${failPublication ? "return 1" : "return 0"}; }
bootstrap_credential() { echo credential; }
node() { echo check-bindings; }
provision() { echo provision; }
validate() { echo validate; }
repo_root=/synthetic
source_sha=synthetic
${dispatch}
`, "workflow-test", "all"], {
				encoding: "utf8",
				env: {
					...process.env,
					BASH_ENV: "/dev/null",
					ACK_TEMPLATE_PREFLIGHT_JOBS_FILE: fresh ? "/synthetic/jobs" : "",
					ACK_TEMPLATE_VALIDATIONS_FILE: "/synthetic/receipts",
					ACK_BOOTSTRAP_INPUTS_FILE: "/synthetic/bootstrap",
					ACK_WORKLOAD_CAPACITY_FILE: "/synthetic/capacity",
					ACK_CREDENTIAL_BOOTSTRAP_FILE: "",
				},
			});
			assert.equal(result.status, failPublication ? 1 : 0, result.stderr);
			const stages = result.stdout.trim().split("\n");
			assert(stages.includes("publish"));
			assert.equal(stages.includes("preflight"), fresh);
			if (failPublication) {
				assert(!stages.includes("check-bindings"));
				assert(!stages.includes("provision"));
				assert(!stages.includes("validate"));
			} else {
				assert(stages.indexOf("deploy") < stages.indexOf("publish"));
				assert(stages.indexOf("publish") < stages.indexOf("provision"));
				assert(stages.includes("validate"));
			}
		});
	}
}
