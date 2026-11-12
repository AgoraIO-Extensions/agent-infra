import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { prepareBootstrapInputs } from "../deploy/ack/bootstrap-inputs.ts";
import { bootstrapLogin } from "../deploy/ack/bootstrap-login.ts";
import { publishRuntimeInputs } from "../deploy/ack/runtime-inputs.ts";
import { prepareReserveInput } from "../deploy/ack/session-reserve-inputs.ts";
import { templatePreflightValidationReceipt } from "../deploy/ack/template-validation.mjs";
import { checkWorkloadCapacity } from "../deploy/ack/workload-capacity.ts";
import { standardTemplateReadinessV1 } from "../packages/model-catalog/dist/index.mjs";
import {
	sessionSandboxResourceCostsV1,
	workloadResourceConfigurationHashV1,
} from "../packages/platform-core/src/workload-resource-configuration.ts";

const source = "a".repeat(40);
const owner = "11111111-1111-4111-8111-111111111111";
const clusterUid = "22222222-2222-4222-8222-222222222222";
const ownerLabel = "agent-infra.agora.io/bootstrap-id";
const namespace = "ack-test";
const validationTarget = {
	sourceCommit: source,
	clusterUid,
	namespace,
	namespaceUid: "namespace-uid",
	installationId: owner,
};
const resources = {
	requests: { cpu: "100m", memory: "128Mi" },
	limits: { cpu: "1", memory: "2Gi" },
};

async function fixture(t, apiReplicas = 1) {
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
			validationTarget,
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
	await save(profilesFile, {
		schemaVersion: 1,
		sourceSha: source,
		profiles: [],
	});
	await save(files.capacity, capacity);
	await save(files.templates, {
		schemaVersion: 1,
		sourceSha: source,
		minValidityMs: 60_000,
		templates,
	});
	const httpCalls = [];
	const httpState = { rolledOut: false, failure: null, onFreshLogin: () => {} };
	const server = createServer(async (request, response) => {
		httpCalls.push({
			method: request.method,
			url: request.url,
			rolledOut: httpState.rolledOut,
		});
		if (request.url === "/auth/login") {
			assert.equal(
				request.headers.cookie,
				undefined,
				"fresh login must not reuse storageState",
			);
			if (httpState.rolledOut && httpState.failure === "login") {
				response.writeHead(503).end();
				return;
			}
			let body = "";
			for await (const chunk of request) body += chunk;
			const input = JSON.parse(body);
			assert.equal(input.password, " fixture-password ");
			const token = input.login === "fixture-owner" ? "A" : "B";
			if (httpState.rolledOut) httpState.onFreshLogin();
			response
				.writeHead(204, {
					"Set-Cookie": `__Host-platform-session=${token.repeat(43)}; Path=/; HttpOnly; SameSite=Lax`,
				})
				.end();
			return;
		}
		assert.equal(request.url, "/api/v1/session");
		if (httpState.rolledOut && httpState.failure === "session") {
			response.writeHead(503).end();
			return;
		}
		const digit = request.headers.cookie?.includes("B".repeat(43)) ? "2" : "1";
		response.writeHead(200, { "Content-Type": "application/json" }).end(
			JSON.stringify({
				schemaVersion: 1,
				user: {
					userId: `${digit.repeat(8)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(12)}`,
				},
			}),
		);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	});
	const origin = `http://127.0.0.1:${server.address().port}`;
	await save(files.requests, { schemaVersion: 1, origin, requests });
	const subjects = [];
	for (const name of ["owner", "other"])
		subjects.push({
			name,
			loginFile: await save(
				join(directory, `${name}.login`),
				`fixture-${name}`,
			),
			passwordFile: await save(
				join(directory, `${name}.password`),
				" fixture-password \n",
			),
			storageStateFile: join(directory, `${name}.state`),
		});
	const identityTarget = await save(
		join(directory, "deployment-identities.json"),
		{ subjects: {} },
	);
	const loginConfig = {
		schemaVersion: 1,
		origin,
		identityFile: join(directory, "identity-candidate.json"),
		subjects,
		blueprints: [],
		identitySecretRef: {
			name: "api-config",
			key: "deployment-identities.json",
		},
	};
	files.login = await save(join(directory, "login.json"), loginConfig);
	await bootstrapLogin(files.login, source, origin);
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
		if (component === "api")
			inputs["deployment-identities.json"] = identityTarget;
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
			replicas: component === "api" ? apiReplicas : 1,
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
				replicas: item.spec.replicas,
				updatedReplicas: item.spec.replicas,
				availableReplicas: item.spec.replicas,
				readyReplicas: item.spec.replicas,
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
		if (verb === "rollout") {
			httpState.rolledOut = true;
			return "success";
		}
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
		httpCalls,
		httpState,
		loginConfig,
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
		for (const expected of f.templates) {
			const bytes = Buffer.from(
				data[`template-validation-${expected.templateId}.json`],
				"base64",
			);
			const record = JSON.parse(bytes);
			assert.equal(record.schemaVersion, 2);
			assert.equal(record.kind, "adopted-template-validation");
			assert.deepEqual(
				record.candidate,
				JSON.parse(await readFile(expected.validationFile)),
			);
			assert.deepEqual(record.adoption.target, validationTarget);
			assert.deepEqual(
				bytes,
				await readFile(
					f.bootstrap.objects.find((o) => o.name === name).files[
						`template-validation-${expected.templateId}.json`
					],
				),
			);
			assert.equal(
				data[`template-validation-${expected.templateId}.json`],
				f.cluster.get("secret/api-config").data[
					`template-validation-${expected.templateId}.json`
				],
			);
		}
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
	assert.equal(repeated.mutationStatus, "not-applied");
	assert.equal(repeated.loginVerified, true);
	assert.equal(f.mutations.length, mutationCount);
});

test("executor policy rejects legacy single-container measurements before any publication", async (t) => {
	const f = await fixture(t);
	f.capacity.storageSize = "20Gi";
	f.capacity.codexSessionExecutor = {
		resources: {
			requests: { cpu: "250m", memory: "256Mi" },
			limits: { cpu: "1", memory: "512Mi" },
		},
		tmpSizeLimit: "128Mi",
		placement: { architecture: "amd64" },
	};
	await f.save(f.files.capacity, f.capacity);
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl),
		/RUNTIME_INPUTS_INVALID/,
	);
	assert.equal(f.mutations.length, 0);
});

async function executorMeasurements(f) {
	Object.assign(f.capacity, {
		resources: {
			requests: { ...resources.requests, "ephemeral-storage": "256Mi" },
			limits: { ...resources.limits, "ephemeral-storage": "1Gi" },
		},
		storageSize: "20Gi",
		storageClassName: "test-storage",
		codexSessionExecutor: {
			resources: {
				requests: { cpu: "250m", memory: "256Mi" },
				limits: { cpu: "1", memory: "512Mi" },
			},
			tmpSizeLimit: "128Mi",
		},
	});
	const resourceConfigurationHash = workloadResourceConfigurationHashV1(
		f.capacity,
	);
	for (const expected of f.templates) {
		const file = join(
			dirname(expected.validationFile),
			"runtime-capacity.receipt.json",
		);
		const measured = JSON.parse(await readFile(file));
		await f.save(file, {
			...measured,
			observedResources: f.capacity.resources,
			resourceConfigurationHash,
			codexSessionExecutor: f.capacity.codexSessionExecutor,
			storageSize: f.capacity.storageSize,
			...(expected.templateId === "codex"
				? { storageClassName: f.capacity.storageClassName }
				: {}),
			resourceCosts: sessionSandboxResourceCostsV1({
				...f.capacity,
				codexSessionExecutor:
					expected.templateId === "codex"
						? f.capacity.codexSessionExecutor
						: undefined,
			}),
			...(expected.templateId === "codex"
				? {
						observedExecutorResources:
							f.capacity.codexSessionExecutor.resources,
						observedInitResources: f.capacity.codexSessionExecutor.resources,
					}
				: {}),
		});
	}
	await f.save(f.files.capacity, f.capacity);
	return resourceConfigurationHash;
}

test("executor measurements publish canonical capacity and verify the full mounted Worker policy", async (t) => {
	const f = await fixture(t);
	const resourceConfigurationHash = await executorMeasurements(f);
	const result = await publishRuntimeInputs(
		f.files,
		f.rendered,
		source,
		f.kubectl,
		true,
	);
	assert.equal(result.status, "passed");
	const readWorker = (secretRef) => {
		const bytes = Buffer.from(
			f.cluster.get(`secret/${secretRef.name}`).data[secretRef.key],
			"base64",
		);
		const profiles = JSON.parse(bytes).profiles;
		assert.equal(profiles.length, 4);
		assert(
			profiles.every(
				(profile) =>
					profile.resourceConfigurationHash === resourceConfigurationHash,
			),
		);
		return { ...f.capacity, bytes, profiles, secretRef };
	};
	const checked = await checkWorkloadCapacity(
		f.files.capacity,
		f.files.requests,
		f.files.templates,
		source,
		readWorker,
	);
	assert.equal(checked.resourceConfigurationHash, resourceConfigurationHash);
	assert.equal(checked.imageCount, 4);
	for (const limits of [
		resources.limits,
		{ ...f.capacity.resources.limits, "ephemeral-storage": "1025Mi" },
		{ ...f.capacity.resources.limits, gpu: "1" },
	]) {
		const changed = { ...f.capacity.resources, limits };
		assert.equal(
			workloadResourceConfigurationHashV1({
				...f.capacity,
				resources: changed,
			}),
			resourceConfigurationHash,
		);
		await assert.rejects(
			checkWorkloadCapacity(
				f.files.capacity,
				f.files.requests,
				f.files.templates,
				source,
				(ref) => ({ ...readWorker(ref), resources: changed }),
			),
			/CAPACITY_WORKER_POLICY_DRIFT/u,
		);
	}
	assert.equal(
		(
			await checkWorkloadCapacity(
				f.files.capacity,
				f.files.requests,
				f.files.templates,
				source,
				(ref) => ({
					...readWorker(ref),
					resources: {
						requests: {
							...f.capacity.resources.requests,
							"ephemeral-storage": "0.25Gi",
						},
						limits: {
							...f.capacity.resources.limits,
							"ephemeral-storage": "1024Mi",
						},
					},
				}),
			)
		).mountedInputVerified,
		true,
	);
	for (const [key, value] of [
		["codexSessionExecutor", undefined],
		[
			"codexSessionExecutor",
			{ ...f.capacity.codexSessionExecutor, tmpSizeLimit: "256Mi" },
		],
		["workspaceSnapshotEgress", { changed: true }],
		["storageSize", "40Gi"],
		["storageClassName", "other-storage"],
	])
		await assert.rejects(
			checkWorkloadCapacity(
				f.files.capacity,
				f.files.requests,
				f.files.templates,
				source,
				(ref) => ({ ...readWorker(ref), [key]: value }),
			),
			/CAPACITY_WORKER_.*DRIFT/,
		);
});

for (const templateId of ["codex", "claude", "opencode", "pi"])
	test(`runtime-inputs rejects ${templateId} ephemeral drift before publishing`, async (t) => {
		const f = await fixture(t);
		const approvedHash = await executorMeasurements(f);
		const expected = f.templates.find(
			(entry) => entry.templateId === templateId,
		);
		const file = join(
			dirname(expected.validationFile),
			"runtime-capacity.receipt.json",
		);
		const measured = JSON.parse(await readFile(file));
		measured.observedResources.limits["ephemeral-storage"] = "1025Mi";
		assert.equal(measured.resourceConfigurationHash, approvedHash);
		await f.save(file, measured);
		await assert.rejects(
			publishRuntimeInputs(f.files, f.rendered, source, f.kubectl),
			/RUNTIME_INPUTS_INVALID/u,
		);
		assert.equal(f.mutations.length, 0);
	});

test("first executor adoption keeps historical costs with cold allocation and rejects mixed warm profiles", async (t) => {
	const f = await fixture(t);
	const resourceConfigurationHash = await executorMeasurements(f);
	await publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true);
	const costs = sessionSandboxResourceCostsV1(f.capacity);
	const historicalCost = {
		resourceConfigurationHash: "e".repeat(64),
		resources: sessionSandboxResourceCostsV1({
			resources,
			storageSize: "20Gi",
		}),
	};
	const input = {
		schemaVersion: 1,
		sourceSha: source,
		enabled: true,
		revision: 2,
		namespace,
		totalBudget: {
			cpuMillis: 4000,
			memoryBytes: 8 * 1024 ** 3,
			storageBytes: 40 * 1024 ** 3,
		},
		resourceCosts: [
			historicalCost,
			{ resourceConfigurationHash, resources: costs },
		],
		maximumReserves: 1,
		maximumConcurrentCreates: 1,
		ttlMs: 1000,
		cooldownMs: 1000,
		failureBackoffMs: 1000,
		profiles: [],
	};
	const actual = {
		sourceSha: source,
		configuration: structuredClone({
			...input,
			revision: 1,
			resourceCosts: [historicalCost],
		}),
		policy: {
			namespace,
			resourceProfileRef: f.capacity.resourceProfileRef,
			resources,
			storageSize: "20Gi",
		},
		resourceCosts: historicalCost.resources,
	};
	const original = structuredClone(actual);
	const environment = {
		ACK_NAMESPACE: namespace,
		ACK_SESSION_RESERVES_FILE: "candidate-reserves",
		ACK_BOOTSTRAP_INPUTS_FILE: "bootstrap-reserves",
		ACK_WORKLOAD_CAPACITY_FILE: f.files.capacity,
		ACK_TEMPLATE_VALIDATIONS_FILE: f.files.templates,
	};
	const options = {
		readJson: async (file) =>
			file === "candidate-reserves"
				? input
				: file === "bootstrap-reserves"
					? {
							namespace,
							objects: ["worker", "api"].map((component) => ({
								kind: "Secret",
								name: `test-${component}-configuration`,
								files: {},
							})),
						}
					: JSON.parse(await readFile(file)),
		readWorker: () => actual,
	};
	const cold = await prepareReserveInput(environment, source, options);
	assert.equal(cold.receipt.enabled, true);
	assert.equal(cold.receipt.revision, 2);
	assert.deepEqual(input.resourceCosts, [
		historicalCost,
		{ resourceConfigurationHash, resources: costs },
	]);
	assert.deepEqual(actual, original);
	input.profiles.push({
		agentId: "fixture-agent",
		templateId: "codex",
		imageDigest: f.templates[0].imageDigest,
		resourceConfigurationHash,
		resources: costs,
		storageConfigurationVersion: "v1",
		networkPolicyVersion: "v1",
		signingConfigurationVersion: "v1",
		transportConfigurationVersion: "v1",
		connectionConfigurationVersion: "v1",
		minimum: 1,
		maximum: 1,
	});
	await assert.rejects(
		prepareReserveInput(environment, source, options),
		/CAPSULE_RESERVE_RESOURCE_HASH_MISMATCH/u,
	);
	assert.deepEqual(actual, original);
});

async function refreshMeasurements(f, { sourceSha = source, codexImage } = {}) {
	const templates = [];
	for (const expected of f.templates) {
		const old = JSON.parse(await readFile(expected.validationFile));
		const imageDigest =
			expected.templateId === "codex" && codexImage
				? codexImage
				: expected.imageDigest;
		const validation = {
			...old,
			sourceCommit: sourceSha,
			imageDigest,
			executionId: `refreshed-${old.executionId}`,
			validatedAt: old.validatedAt + 1,
		};
		const output = join(
			dirname(f.files.templates),
			"refreshed",
			expected.templateId,
		);
		const validationFile = await f.save(
			join(output, "candidate.json"),
			validation,
		);
		const preflightFile = await f.save(
			join(output, "validation.json"),
			templatePreflightValidationReceipt({
				...validation,
				validationTarget: { ...validationTarget, sourceCommit: sourceSha },
				scope: "isolated-template-real-model",
				terminalStatus: "completed",
				modelFactSource: "protected-driver-journal",
				modelOperationCount: 1,
			}),
		);
		const previous = JSON.parse(
			await readFile(
				join(dirname(expected.validationFile), "runtime-capacity.receipt.json"),
			),
		);
		await f.save(join(output, "runtime-capacity.receipt.json"), {
			...previous,
			sourceCommit: sourceSha,
			imageDigest,
			submittedAt: previous.submittedAt + 1,
			completedAt: validation.validatedAt,
		});
		templates.push({ ...expected, imageDigest, validationFile, preflightFile });
	}
	await f.save(f.files.templates, {
		schemaVersion: 1,
		sourceSha,
		minValidityMs: 60_000,
		templates,
	});
	return templates;
}

test("only actual apply adopts; all consumers retain the exact adopted bytes after the candidate TTL", async (t) => {
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const f = await fixture(t);
	await publishRuntimeInputs(f.files, f.rendered, source, f.kubectl);
	for (const name of ["api-config", "worker-config"])
		assert.equal(
			JSON.parse(
				Buffer.from(
					f.cluster.get(`secret/${name}`).data[
						"template-validation-codex.json"
					],
					"base64",
				),
			).status,
			"not-yet-measured",
		);
	assert(
		!(await readdir(dirname(f.files.templates))).some((n) =>
			n.startsWith(".template-adoption-"),
		),
	);
	await publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true);
	const adoptedBytes = Object.fromEntries(
		f.templates.map((expected) => [
			expected.templateId,
			f.cluster.get("secret/api-config").data[
				`template-validation-${expected.templateId}.json`
			],
		]),
	);
	now += 3_600_001;
	for (const expected of f.templates) {
		const record = JSON.parse(
			Buffer.from(adoptedBytes[expected.templateId], "base64"),
		);
		assert.equal(
			standardTemplateReadinessV1({
				templateId: expected.templateId,
				imageDigest: expected.imageDigest,
				binding: {
					templateId: expected.templateId,
					imageDigest: expected.imageDigest,
					driver: expected.driver,
					protocol:
						expected.templateId === "codex"
							? "openai-responses-v1"
							: "anthropic-messages-v1",
				},
				configurationRevision: expected.configurationRevision,
				validationContext: validationTarget,
				validation: record,
				now,
			}).state,
			"ready",
		);
	}
	await bootstrapLogin(f.files.login, source, f.loginConfig.origin);
	await publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true);
	for (const name of ["api-config", "worker-config"])
		for (const expected of f.templates)
			assert.equal(
				f.cluster.get(`secret/${name}`).data[
					`template-validation-${expected.templateId}.json`
				],
				adoptedBytes[expected.templateId],
			);
});

test("an expired candidate cannot be adopted and expiry at the first write boundary mutates no Secret", async (t) => {
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const f = await fixture(t);
	let reads = 0;
	f.beforeCall((args) => {
		if (
			args.includes("get") &&
			args.includes("secret") &&
			args.includes("api-config") &&
			++reads === 2
		)
			now += 3_600_001;
	});
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		/RUNTIME_INPUT_TEMPLATE_VALIDATION_FAILED/,
	);
	assert.equal(f.mutations.length, 0);
	f.beforeCall(() => {});
	await bootstrapLogin(f.files.login, source, f.loginConfig.origin);
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		/RUNTIME_INPUT_TEMPLATE_VALIDATION_FAILED/,
	);
	assert.equal(f.mutations.length, 0);
});

test("partial or unknown publication is not completed with a new adoption time after expiry", async (t) => {
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const f = await fixture(t);
	f.afterReplace(() => {
		throw Error("synthetic unknown response after original replace");
	});
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
	);
	assert.equal(f.mutations.length, 1);
	const bytes = f.cluster.get("secret/worker-config").data[
		"template-validation-codex.json"
	];
	assert.equal(JSON.parse(Buffer.from(bytes, "base64")).schemaVersion, 2);
	now += 3_600_001;
	f.afterReplace(() => {});
	await bootstrapLogin(f.files.login, source, f.loginConfig.origin);
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		/RUNTIME_INPUT_TEMPLATE_VALIDATION_FAILED/,
	);
	assert.equal(f.mutations.length, 1);
	assert.equal(
		f.cluster.get("secret/worker-config").data[
			"template-validation-codex.json"
		],
		bytes,
	);
	assert.equal(
		JSON.parse(
			Buffer.from(
				f.cluster.get("secret/api-config").data[
					"template-validation-codex.json"
				],
				"base64",
			),
		).status,
		"not-yet-measured",
	);
});

test("directory adoption is not published before the Worker receives its matching evidence", async (t) => {
	const f = await fixture(t);
	f.afterReplace(() => {
		throw Error("synthetic response lost at the first consumer write");
	});
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
	);
	assert.deepEqual(f.mutations, ["replace:worker-config"]);
	assert.equal(
		JSON.parse(
			Buffer.from(
				f.cluster.get("secret/worker-config").data[
					"template-validation-codex.json"
				],
				"base64",
			),
		).schemaVersion,
		2,
	);
	assert.equal(
		JSON.parse(
			Buffer.from(
				f.cluster.get("secret/api-config").data[
					"template-validation-codex.json"
				],
				"base64",
			),
		).status,
		"not-yet-measured",
	);
});

for (const failurePoint of [
	"after-both-secret-writes",
	"first-consumer-patch",
	"worker-rollout",
]) {
	test(`an incomplete publication cannot finish after expiry (${failurePoint})`, async (t) => {
		let now = Date.now();
		t.mock.method(Date, "now", () => now);
		const f = await fixture(t);
		if (failurePoint === "after-both-secret-writes")
			f.afterReplace((object) => {
				if (object.metadata.name === "api-config")
					throw Error("synthetic response lost after both Secret writes");
			});
		else
			f.beforeCall((args) => {
				if (failurePoint === "first-consumer-patch" && args.includes("patch"))
					throw Error("synthetic failure at the first consumer patch");
				if (
					failurePoint === "worker-rollout" &&
					args.includes("rollout") &&
					args.includes("deployment/agent-infra-worker")
				) {
					const worker = f.cluster.get("deployment/agent-infra-worker");
					worker.status.readyReplicas = 0;
					worker.status.availableReplicas = 0;
					throw Error("synthetic incomplete Worker rollout");
				}
			});
		await assert.rejects(
			publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		);
		assert.deepEqual(f.mutations.slice(0, 2), [
			"replace:worker-config",
			"replace:api-config",
		]);
		const before = [...f.mutations];
		const records = ["api-config", "worker-config"].map((name) =>
			structuredClone(f.cluster.get(`secret/${name}`).data),
		);
		now += 3_600_001;
		f.beforeCall(() => {});
		f.afterReplace(() => {});
		await bootstrapLogin(f.files.login, source, f.loginConfig.origin);
		await assert.rejects(
			publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
			/RUNTIME_INPUT_TEMPLATE_VALIDATION_FAILED/,
		);
		assert.deepEqual(f.mutations, before);
		assert.deepEqual(
			["api-config", "worker-config"].map(
				(name) => f.cluster.get(`secret/${name}`).data,
			),
			records,
		);
	});
}

test("a still-fresh original attempt resumes with its frozen bytes rather than minting another adoption", async (t) => {
	const f = await fixture(t);
	f.afterReplace(() => {
		throw Error("synthetic response lost after the first replace");
	});
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
	);
	const original = f.cluster.get("secret/worker-config").data[
		"template-validation-codex.json"
	];
	f.afterReplace(() => {});
	await publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true);
	assert.equal(
		f.cluster.get("secret/api-config").data["template-validation-codex.json"],
		original,
	);
	assert.equal(
		f.cluster.get("secret/worker-config").data[
			"template-validation-codex.json"
		],
		original,
	);
});

test("target provenance drift, source input bytes drift and a deleting namespace cannot authorize adoption", async (t) => {
	const f = await fixture(t);
	const expected = f.templates[0];
	const originalPreflight = await readFile(expected.preflightFile);
	const preflight = JSON.parse(originalPreflight);
	preflight.validationTarget.namespaceUid = "foreign-namespace";
	await f.save(expected.preflightFile, preflight);
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
	);
	assert.equal(f.mutations.length, 0);
	await writeFile(expected.preflightFile, originalPreflight, { mode: 0o600 });
	const originalCandidate = await readFile(expected.validationFile);
	let changed = false;
	f.beforeCall((args) => {
		if (!changed && args.includes("get") && args.includes("secret")) {
			changed = true;
			// The exact input changes after its preflight was read; the payload remains equal.
			writeFileSync(
				expected.validationFile,
				JSON.stringify(JSON.parse(originalCandidate), null, 4),
				{ mode: 0o600 },
			);
		}
	});
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		/RUNTIME_INPUT_LOCAL_DRIFT/,
	);
	assert.equal(f.mutations.length, 0);
	f.beforeCall(() => {});
	await writeFile(expected.validationFile, originalCandidate, { mode: 0o600 });
	f.cluster.get(`namespace/${namespace}`).metadata.deletionTimestamp =
		"2026-11-11T00:00:00Z";
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		/RUNTIME_INPUT_NAMESPACE_OWNER_INVALID/,
	);
	assert.equal(f.mutations.length, 0);
});

test("the formal adoption attempt is never written into a Git worktree", async (t) => {
	const f = await fixture(t);
	const controlDirectory = join(dirname(f.files.templates), "git-controls");
	await mkdir(controlDirectory, { mode: 0o700 });
	execFileSync("git", ["init", "-q", controlDirectory]);
	const original = JSON.parse(await readFile(f.files.templates));
	f.files.templates = await f.save(
		join(controlDirectory, "templates.json"),
		original,
	);
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		/RUNTIME_INPUT_FILE_INSIDE_WORKTREE/,
	);
	assert.equal(f.mutations.length, 0);
	assert(
		!(await readdir(controlDirectory)).some((name) =>
			name.startsWith(".template-adoption-"),
		),
	);
});

test("a new template validation preserves the approved capacity bytes and evidence references", async (t) => {
	const f = await fixture(t);
	await publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true);
	const approved = await readFile(f.capacity.profilesFile);
	const capacityBefore = await readFile(f.files.capacity);
	const templates = await refreshMeasurements(f);
	const result = await publishRuntimeInputs(
		f.files,
		f.rendered,
		source,
		f.kubectl,
		true,
	);
	assert.equal(result.status, "passed");
	assert.deepEqual(await readFile(f.capacity.profilesFile), approved);
	assert.deepEqual(await readFile(f.files.capacity), capacityBefore);
	assert.deepEqual(
		Buffer.from(
			f.cluster.get("secret/worker-config").data["capacity.json"],
			"base64",
		),
		approved,
	);
	for (const template of templates) {
		for (const component of ["api", "worker"]) {
			const bytes = f.cluster.get(`secret/${component}-config`).data[
				`template-validation-${template.templateId}.json`
			];
			const record = JSON.parse(Buffer.from(bytes, "base64"));
			assert.equal(record.schemaVersion, 2);
			assert.deepEqual(
				record.candidate,
				JSON.parse(await readFile(template.validationFile)),
			);
			assert.equal(
				bytes,
				f.cluster.get("secret/api-config").data[
					`template-validation-${template.templateId}.json`
				],
			);
		}
	}
});

test("a new template image receives a new capacity approval without replacing other approvals", async (t) => {
	const f = await fixture(t);
	await publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true);
	const approved = JSON.parse(await readFile(f.capacity.profilesFile)).profiles;
	const codexImage = `sha256:${"b".repeat(64)}`;
	const templates = await refreshMeasurements(f, { codexImage });
	await publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true);
	const profiles = JSON.parse(await readFile(f.capacity.profilesFile)).profiles;
	assert.equal(profiles.length, 5);
	for (const profile of approved)
		assert(profiles.some((p) => JSON.stringify(p) === JSON.stringify(profile)));
	const file = join(
		dirname(templates[0].validationFile),
		"runtime-capacity.receipt.json",
	);
	assert.equal(
		profiles.find((p) => p.imageDigest === codexImage).conformanceEvidenceHash,
		createHash("sha256")
			.update(await readFile(file))
			.digest("hex"),
	);
});

for (const scenario of [
	"missing-reference",
	"missing-file",
	"changed-bytes",
	"wrong-source",
	"wrong-resources",
	"unmeasured",
	"new-source",
	"fresh-expired",
	"fresh-resources",
	"fresh-failed",
	"fresh-source",
]) {
	test(`template refresh rejects ${scenario} evidence before writes`, async (t) => {
		const f = await fixture(t);
		await publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true);
		const sourceSha = scenario === "new-source" ? "b".repeat(40) : source;
		const templates = await refreshMeasurements(f, { sourceSha });
		const capacity = JSON.parse(await readFile(f.files.capacity));
		const original = capacity.evidence[0].file;
		if (scenario === "missing-reference") {
			capacity.evidence.shift();
			await f.save(f.files.capacity, capacity);
		} else if (scenario === "missing-file") {
			await rm(original);
		} else if (scenario === "changed-bytes") {
			await writeFile(original, `${await readFile(original, "utf8")} `);
		} else if (
			["wrong-source", "wrong-resources", "unmeasured"].includes(scenario)
		) {
			const measured = JSON.parse(await readFile(original));
			if (scenario === "wrong-source") measured.sourceCommit = "b".repeat(40);
			if (scenario === "wrong-resources")
				measured.observedResources.limits.cpu = "2";
			if (scenario === "unmeasured") measured.modelOperationCount = 0;
			await f.save(original, measured);
			const profiles = JSON.parse(await readFile(f.capacity.profilesFile));
			profiles.profiles[0].conformanceEvidenceHash = createHash("sha256")
				.update(await readFile(original))
				.digest("hex");
			await f.save(f.capacity.profilesFile, profiles);
			f.cluster.get("secret/worker-config").data["capacity.json"] = (
				await readFile(f.capacity.profilesFile)
			).toString("base64");
		} else if (scenario === "new-source") {
			await f.save(f.files.capacity, { ...capacity, sourceSha });
			await bootstrapLogin(f.files.login, sourceSha, f.loginConfig.origin);
		} else if (scenario === "fresh-expired") {
			const validation = JSON.parse(
				await readFile(templates[0].validationFile),
			);
			await f.save(templates[0].validationFile, {
				...validation,
				validUntil: Date.now() - 1,
			});
		} else {
			const file = join(
				dirname(templates[0].validationFile),
				"runtime-capacity.receipt.json",
			);
			const measured = JSON.parse(await readFile(file));
			if (scenario === "fresh-resources")
				measured.observedResources.limits.cpu = "2";
			if (scenario === "fresh-failed") measured.terminalStatus = "failed";
			if (scenario === "fresh-source") measured.sourceCommit = "b".repeat(40);
			await f.save(file, measured);
		}
		const before = await Promise.all(
			[
				f.capacity.profilesFile,
				f.files.capacity,
				...f.bootstrap.objects.flatMap((o) => Object.values(o.files)),
			].map((p) => readFile(p)),
		);
		const mutationCount = f.mutations.length;
		await assert.rejects(
			publishRuntimeInputs(f.files, f.rendered, sourceSha, f.kubectl, true),
		);
		assert.equal(f.mutations.length, mutationCount);
		assert.deepEqual(
			await Promise.all(
				[
					f.capacity.profilesFile,
					f.files.capacity,
					...f.bootstrap.objects.flatMap((o) => Object.values(o.files)),
				].map((p) => readFile(p)),
			),
			before,
		);
	});
}

test("runtime-inputs with reserves uses its configured executor and namespace before applying", async (t) => {
	const f = await fixture(t);
	f.files.reserves = await f.save(join(f.files.bootstrap, "../reserves.json"), {
		schemaVersion: 1,
		sourceSha: source,
		namespace,
		enabled: false,
		revision: 1,
		totalBudget: { cpuMillis: 0, memoryBytes: 0, storageBytes: 0 },
		resourceCosts: [],
		profiles: [],
		maximumReserves: 0,
		maximumConcurrentCreates: 0,
		ttlMs: 1000,
		cooldownMs: 1000,
		failureBackoffMs: 1000,
	});
	const deployment = f.cluster.get("deployment/agent-infra-worker");
	const pod = {
		metadata: {
			name: "worker-pod",
			uid: "pod-uid",
			namespace,
			ownerReferences: [
				{
					kind: "ReplicaSet",
					name: "worker-rs",
					uid: "rs-uid",
					controller: true,
				},
			],
		},
		spec: structuredClone(deployment.spec.template.spec),
	};
	pod.spec.containers[0].volumeMounts.push({
		name: "configuration",
		readOnly: true,
		mountPath: "/var/run/agent-infra/deployment",
	});
	f.cluster.set("replicaset/worker-rs", {
		metadata: {
			uid: "rs-uid",
			ownerReferences: [
				{ kind: "Deployment", controller: true, uid: deployment.metadata.uid },
			],
		},
	});
	let executions = 0;
	const kubectl = (args, input) => {
		if (!args.includes("namespace"))
			assert.deepEqual(args.slice(0, 2), ["-n", namespace]);
		if (args.includes("pods")) return JSON.stringify({ items: [pod] });
		if (args.includes("exec")) {
			executions++;
			return JSON.stringify({
				sourceSha: source,
				configuration: null,
				configurationHash: null,
				policy: { namespace, resources },
				resourceCosts: {},
			});
		}
		return f.kubectl(args, input);
	};
	const plan = await publishRuntimeInputs(f.files, f.rendered, source, kubectl);
	assert.equal(plan.status, "passed");
	assert.equal(executions, 1);
	assert.deepEqual(f.mutations, []);
	const applied = await publishRuntimeInputs(
		f.files,
		f.rendered,
		source,
		kubectl,
		true,
	);
	assert.equal(applied.status, "passed");
	assert.equal(applied.loginVerified, true);
	assert.equal(executions, 2);
	assert.equal(
		JSON.parse(
			Buffer.from(
				f.cluster.get("secret/worker-config").data["session-reserves.json"],
				"base64",
			),
		).enabled,
		false,
	);
	assert.equal(
		f.cluster.get("secret/api-config").data["session-reserves.json"],
		f.cluster.get("secret/worker-config").data["session-reserves.json"],
	);
});

for (const separateCandidate of [false, true])
	test(`publishing standard measurements preserves custom capacity (separate candidate=${separateCandidate})`, async (t) => {
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
		const baselineFile = f.capacity.profilesFile;
		const candidateFile = separateCandidate
			? join(dirname(baselineFile), "candidate.json")
			: baselineFile;
		if (separateCandidate) f.capacity.candidateProfilesFile = candidateFile;
		await f.save(candidateFile, {
			schemaVersion: 1,
			profiles: [profile],
		});
		if (!separateCandidate)
			f.cluster.get("secret/worker-config").data["capacity.json"] = (
				await readFile(baselineFile)
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
			await readFile(candidateFile),
			await readFile(baselineFile),
		);
		assert.deepEqual(
			Buffer.from(
				f.cluster.get("secret/worker-config").data["capacity.json"],
				"base64",
			),
			await readFile(baselineFile),
		);
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
	"candidate-control-file-alias",
	"candidate-bound-key-alias",
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
		if (scenario === "candidate-control-file-alias") {
			f.capacity.candidateProfilesFile = f.files.capacity;
			await f.save(f.files.capacity, { ...f.capacity, profiles: [] });
		}
		if (scenario === "candidate-bound-key-alias") {
			const other = await f.save(
				join(dirname(f.capacity.profilesFile), "other.json"),
				{ schemaVersion: 1, profiles: [] },
			);
			f.bootstrap.objects.find((o) => o.name === "worker-config").files[
				"other.json"
			] = other;
			f.cluster.get("secret/worker-config").data["other.json"] = (
				await readFile(other)
			).toString("base64");
			f.capacity.candidateProfilesFile = other;
			await f.save(f.files.capacity, f.capacity);
			await f.save(f.files.bootstrap, f.bootstrap);
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

test("a missing configuration Secret fails closed before any write", async (t) => {
	const f = await fixture(t);
	f.cluster.delete("secret/api-config");
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		/RUNTIME_INPUT_SECRET_MISSING/,
	);
	assert.equal(f.mutations.length, 0);
});

test("a configuration Secret UID replacement fails closed before replacement", async (t) => {
	const f = await fixture(t);
	let apiReads = 0;
	f.beforeCall((args) => {
		if (
			args.includes("get") &&
			args.includes("secret") &&
			args.includes("api-config") &&
			++apiReads === 2
		)
			f.cluster.get("secret/api-config").metadata.uid =
				"replacement-secret-uid";
	});
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		(error) => {
			assert.equal(
				error.receipt.failureCode,
				"RUNTIME_INPUT_SECRET_VERSION_DRIFT",
			);
			assert.equal(error.receipt.mutationStatus, "not-applied");
			assert.equal(error.receipt.recoveryRequired, false);
			return true;
		},
	);
	assert.equal(f.mutations.length, 0);
});

test("apply without login inputs fails before cluster access", async (t) => {
	const f = await fixture(t);
	delete f.files.login;
	let reads = 0;
	f.beforeCall(() => {
		reads++;
	});
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		/RUNTIME_INPUT_LOGIN_REQUIRED/,
	);
	assert.equal(reads, 0);
	assert.equal(f.mutations.length, 0);
});

test("a frozen uppercase upstream error is redacted instead of treated as a protocol code", async (t) => {
	const f = await fixture(t);
	f.beforeCall(() => {
		throw Object.freeze(new Error("UPPERCASE_PRIVATE_CREDENTIAL"));
	});
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		(error) => {
			assert.equal(error.receipt.failureCode, "RUNTIME_INPUTS_INVALID");
			assert.equal(error.receipt.mutationStatus, "not-applied");
			assert(!JSON.stringify(error).includes("UPPERCASE_PRIVATE_CREDENTIAL"));
			return true;
		},
	);
});

test("an unavailable Secret read is not reported as a missing Secret", async (t) => {
	const f = await fixture(t);
	f.beforeCall((args) => {
		if (args.includes("secret")) throw new Error("PRIVATE_KUBECTL_DIAGNOSTIC");
	});
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		/RUNTIME_INPUT_SECRET_UNAVAILABLE/,
	);
	assert.equal(f.mutations.length, 0);
});

test("a rejected first replace is an attempted mutation with recovery needed", async (t) => {
	const f = await fixture(t);
	f.beforeCall((args) => {
		if (args.includes("replace")) throw new Error("upstream failed");
	});
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		(error) => {
			assert.equal(error.receipt.mutationStatus, "attempted");
			assert.equal(error.receipt.phase, "secret-write");
			assert.equal(error.receipt.recoveryRequired, true);
			return true;
		},
	);
	assert.equal(f.mutations.length, 0);
});

test("a missing Secret immediately before rollout prevents all Deployment patches", async (t) => {
	const f = await fixture(t);
	let apiReads = 0;
	f.beforeCall((args) => {
		if (
			args.includes("get") &&
			args.includes("deployment") &&
			args.includes("agent-infra-api") &&
			++apiReads === 2
		)
			f.cluster.delete("secret/api-config");
	});
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		/RUNTIME_INPUT_SECRET_MISSING/,
	);
	assert(!f.mutations.some((m) => m.startsWith("patch:")));
});

test("a Secret replacement during fresh login invalidates publication", async (t) => {
	const f = await fixture(t);
	f.httpState.onFreshLogin = () => {
		f.cluster.get("secret/api-config").metadata.uid = "changed-during-login";
	};
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		/RUNTIME_INPUT_SECRET_CHANGED_DURING_ROLLOUT/,
	);
});

test("a Secret UID change after replace is not reported as a successful rollout", async (t) => {
	const f = await fixture(t);
	f.afterReplace((object) => {
		object.metadata.uid = "replacement-secret-uid";
	});
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		/SECRET_READBACK_FAILED/,
	);
	assert(f.mutations.every((value) => value.startsWith("replace:")));
	assert(!f.mutations.some((value) => value.startsWith("patch:")));
});

test("runtime-inputs CLI emits only a bounded failure receipt", () => {
	const result = spawnSync(
		process.execPath,
		["--experimental-strip-types", "deploy/ack/runtime-inputs.ts", "invalid"],
		{ encoding: "utf8" },
	);
	assert.notEqual(result.status, 0);
	assert.equal(result.stderr.trim(), "ACK_RUNTIME_INPUTS_INVALID");
	assert.deepEqual(JSON.parse(result.stdout), {
		schemaVersion: 1,
		kind: "ack-runtime-inputs",
		status: "failed",
		failureCode: "RUNTIME_INPUTS_INVALID",
		phase: "preflight",
		mutationStatus: "not-applied",
		recoveryRequired: false,
		loginVerified: false,
		businessVerified: false,
	});
});

test("the runtime-inputs shell keeps a failed attempt when a later run succeeds", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "ack-runtime-receipts-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const script = await readFile(
		new URL("../deploy/ack/redeploy.sh", import.meta.url),
		"utf8",
	);
	const command = script.slice(
		script.indexOf("runtime_inputs() {"),
		script.indexOf("template_preflight() {"),
	);
	const receipts = [];
	for (const success of [false, true]) {
		const receipt = {
			schemaVersion: 1,
			kind: "ack-runtime-inputs",
			status: success ? "passed" : "failed",
			mutationStatus: success ? "not-applied" : "attempted",
			loginVerified: success,
		};
		receipts.push(receipt);
		const result = spawnSync(
			"bash",
			[
				"-c",
				`
set -euo pipefail
umask 077
require_source_tuple() { :; }
require_file() { :; }
prepare_evidence() { :; }
image_cache_gate() { :; }
activate_cache_admission() { :; }
render_manifest() { :; }
validate_workload_capacity() { :; }
die() { exit 2; }
node() { printf '%s\\n' "$MOCK_RECEIPT"; return "$MOCK_EXIT"; }
repo_root=/synthetic
evidence_dir=$ACK_EVIDENCE_DIR
${command}
runtime_inputs
`,
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					BASH_ENV: "/dev/null",
					ACK_EVIDENCE_DIR: directory,
					ACK_BOOTSTRAP_INPUTS_FILE: "/synthetic/bootstrap",
					ACK_LOGIN_BOOTSTRAP_FILE: "/synthetic/login",
					ACK_TEMPLATE_VALIDATIONS_FILE: "/synthetic/templates",
					ACK_WORKLOAD_CAPACITY_FILE: "/synthetic/capacity",
					ACK_AGENT_REQUESTS_FILE: "/synthetic/requests",
					MOCK_RECEIPT: JSON.stringify(receipt),
					MOCK_EXIT: success ? "0" : "1",
				},
			},
		);
		assert.equal(result.status, success ? 0 : 2, result.stderr);
	}
	const attempts = (await readdir(directory)).filter(
		(name) =>
			name.startsWith("runtime-inputs.") && name !== "runtime-inputs.json",
	);
	assert.equal(attempts.length, 2);
	const actual = await Promise.all(
		attempts.map(async (name) =>
			JSON.parse(await readFile(join(directory, name))),
		),
	);
	for (const receipt of receipts)
		assert(actual.some((r) => JSON.stringify(r) === JSON.stringify(receipt)));
	assert.deepEqual(
		JSON.parse(await readFile(join(directory, "runtime-inputs.json"))),
		receipts[1],
	);
});

test("all rejects missing login inputs before any cluster mutation", async () => {
	const script = await readFile(
		new URL("../deploy/ack/redeploy.sh", import.meta.url),
		"utf8",
	);
	const dispatch = script.slice(script.indexOf("\ncommand="));
	const result = spawnSync(
		"bash",
		[
			"-c",
			`
set -euo pipefail
require_source_tuple() { :; }
require_file() { [[ -n "$2" ]]; }
bootstrap_database() { echo mutation; }
${dispatch}
`,
			"test",
			"all",
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				BASH_ENV: "/dev/null",
				ACK_BOOTSTRAP_INPUTS_FILE: "/synthetic/bootstrap",
				ACK_WORKLOAD_CAPACITY_FILE: "/synthetic/capacity",
				ACK_LOGIN_BOOTSTRAP_FILE: "",
			},
		},
	);
	assert.notEqual(result.status, 0);
	assert.equal(result.stdout, "");
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
		/RUNTIME_INPUTS_INVALID/,
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

test("a Secret delete and recreate during rollout cannot be reported as published inputs", async (t) => {
	const f = await fixture(t);
	f.beforeCall((args) => {
		if (
			args.includes("rollout") &&
			args.includes("deployment/agent-infra-api")
		) {
			const current = f.cluster.get("secret/api-config");
			f.cluster.delete("secret/api-config");
			f.cluster.set("secret/api-config", {
				...structuredClone(current),
				metadata: {
					...current.metadata,
					uid: "recreated-secret-uid",
					resourceVersion: "99",
				},
			});
		}
	});
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		/SECRET_CHANGED_DURING_ROLLOUT/,
	);
});

for (const scenario of ["correct", "wrongTarget", "login", "session"]) {
	test(`publication requires post-rollout login and session (${scenario})`, async (t) => {
		const f = await fixture(t);
		const beforeCandidate = await readFile(f.loginConfig.identityFile);
		const beforeStates = await Promise.all(
			f.loginConfig.subjects.map((s) => readFile(s.storageStateFile)),
		);
		if (scenario === "wrongTarget") {
			f.loginConfig.identitySecretRef.name = "worker-config";
			await f.save(f.files.login, f.loginConfig);
			await assert.rejects(
				publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
				/IDENTITY_TARGET_INVALID/,
			);
			assert.equal(f.mutations.length, 0);
		} else if (scenario !== "correct") {
			f.httpState.failure = scenario;
			await assert.rejects(
				publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
				(error) => {
					assert.equal(error.receipt.phase, "login");
					assert.equal(error.receipt.recoveryRequired, true);
					assert.equal(error.receipt.loginVerified, false);
					assert.equal(
						error.receipt.failureCode,
						scenario === "login"
							? "LOGIN_AUTHENTICATION_FAILED"
							: "LOGIN_SESSION_READ_FAILED",
					);
					return true;
				},
			);
		} else {
			const result = await publishRuntimeInputs(
				f.files,
				f.rendered,
				source,
				f.kubectl,
				true,
			);
			assert.equal(result.mutationStatus, "applied");
			assert.equal(result.loginVerified, true);
			const afterRollout = f.httpCalls.filter((c) => c.rolledOut);
			assert.equal(
				afterRollout.filter(
					(c) => c.method === "POST" && c.url === "/auth/login",
				).length,
				2,
			);
			assert.equal(
				afterRollout.filter((c) => c.url === "/api/v1/session").length,
				6,
			);
			assert.deepEqual(
				Buffer.from(
					f.cluster.get("secret/api-config").data["deployment-identities.json"],
					"base64",
				),
				beforeCandidate,
			);
			assert.equal(
				f.cluster.get("secret/worker-config").data[
					"deployment-identities.json"
				],
				undefined,
			);
		}
		assert.deepEqual(
			await readFile(f.loginConfig.identityFile),
			beforeCandidate,
		);
		assert.deepEqual(
			await Promise.all(
				f.loginConfig.subjects.map((s) => readFile(s.storageStateFile)),
			),
			beforeStates,
		);
	});
}

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
	for (const failPublication of fresh ? [false, true] : [false]) {
		test(`all ${fresh ? "publishes fresh receipts before provisioning" : "rejects supplied receipts without preflight jobs"} (failure=${failPublication})`, async () => {
			const script = await readFile(
				new URL("../deploy/ack/redeploy.sh", import.meta.url),
				"utf8",
			);
			const dispatch = script.slice(script.indexOf("\ncommand="));
			// Run the real dispatch with observable external-stage boundaries.
			const result = spawnSync(
				"bash",
				[
					"-c",
					`
set -euo pipefail
require_source_tuple() { echo source; }
require_file() { [[ -n "$2" ]] || { echo "$1 is required" >&2; exit 2; }; }
prepare_evidence() { :; }
render_manifest() { :; }
configuration_source_preflight() { echo config-preflight; }
bootstrap_database() { echo database; }
preflight_agent_requests() { echo request-preflight; }
reserve_plan_preflight() { :; }
image_cache_gate() { :; }
bootstrap_inputs() { echo bootstrap; }
deploy() { echo deploy; }
template_preflight() { echo preflight; }
runtime_inputs() { echo publish; ${failPublication ? "return 1" : "return 0"}; }
bootstrap_credential() { echo credential; }
bootstrap_login() { echo login; }
node() { echo check-bindings; }
provision() { echo provision; }
validate() { echo validate; }
repo_root=/synthetic
source_sha=synthetic
${dispatch}
`,
					"workflow-test",
					"all",
				],
				{
					encoding: "utf8",
					env: {
						...process.env,
						BASH_ENV: "/dev/null",
						ACK_TEMPLATE_PREFLIGHT_JOBS_FILE: fresh ? "/synthetic/jobs" : "",
						ACK_TEMPLATE_VALIDATIONS_FILE: "/synthetic/receipts",
						ACK_BOOTSTRAP_INPUTS_FILE: "/synthetic/bootstrap",
						ACK_WORKLOAD_CAPACITY_FILE: "/synthetic/capacity",
						ACK_AGENT_REQUESTS_FILE: "/synthetic/requests",
						ACK_CREDENTIAL_BOOTSTRAP_FILE: "",
						ACK_LOGIN_BOOTSTRAP_FILE: "/synthetic/login",
					},
				},
			);
			if (!fresh) {
				assert.equal(result.status, 2, result.stderr);
				assert.match(
					result.stderr,
					/ACK_TEMPLATE_PREFLIGHT_JOBS_FILE is required/,
				);
				assert.equal(result.stdout, "");
				return;
			}
			assert.equal(result.status, failPublication ? 1 : 0, result.stderr);
			const stages = result.stdout.trim().split("\n");
			assert(stages.includes("publish"));
			assert(stages.indexOf("config-preflight") < stages.indexOf("bootstrap"));
			assert(stages.indexOf("login") < stages.indexOf("publish"));
			assert.equal(stages.includes("preflight"), fresh);
			assert(stages.indexOf("preflight") < stages.indexOf("publish"));
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

test("two-replica API runtime inputs reach readiness while Worker remains single-replica", async (t) => {
	const f = await fixture(t, 2);
	const result = await publishRuntimeInputs(
		f.files,
		f.rendered,
		source,
		f.kubectl,
		true,
	);
	assert.equal(result.status, "passed");
	assert.equal(result.loginVerified, true);
	assert.equal(f.cluster.get("deployment/agent-infra-api").spec.replicas, 2);
	assert.equal(f.cluster.get("deployment/agent-infra-worker").spec.replicas, 1);
});

for (const scenario of ["before-write", "after-rollout", "during-login"]) {
	test(`API replica drift is rejected ${scenario}`, async (t) => {
		const f = await fixture(t, 2);
		const api = f.cluster.get("deployment/agent-infra-api");
		if (scenario === "before-write") api.spec.replicas = 3;
		if (scenario === "after-rollout")
			f.beforeCall((args) => {
				if (args.includes("rollout")) api.spec.replicas = 3;
			});
		if (scenario === "during-login")
			f.httpState.onFreshLogin = () => {
				api.spec.replicas = 3;
			};
		await assert.rejects(
			publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
			/RUNTIME_INPUT_(REPLICA_DRIFT|CONSUMER_ROLLOUT_FAILED)/,
		);
		if (scenario === "before-write") assert.equal(f.mutations.length, 0);
	});
}

for (const scenario of ["missing-login", "invalid-templates"]) {
	test(`CLI apply preserves not-applied preflight receipt for ${scenario} without starting watch`, async (t) => {
		const f = await fixture(t, 2);
		if (scenario === "invalid-templates") await f.save(f.files.templates, {});
		const manifest = await f.save(
			join(f.files.bootstrap, "../rendered.json"),
			f.rendered,
		);
		const bin = join(f.files.bootstrap, "../bin");
		await mkdir(bin);
		const marker = join(bin, "called");
		await writeFile(
			join(bin, "kubectl"),
			`#!/bin/sh\ntouch '${marker}'\nexit 1\n`,
			{ mode: 0o700 },
		);
		const result = spawnSync(
			process.execPath,
			[
				"deploy/ack/runtime-inputs.ts",
				"apply",
				f.files.bootstrap,
				f.files.templates,
				f.files.capacity,
				f.files.requests,
				manifest,
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					ACK_SOURCE_SHA: source,
					ACK_NAMESPACE: namespace,
					ACK_KUBECONFIG: join(bin, "kubeconfig"),
					ACK_LOGIN_BOOTSTRAP_FILE:
						scenario === "missing-login" ? "" : f.files.login,
				},
			},
		);
		assert.equal(result.status, 1);
		const receipt = JSON.parse(result.stdout);
		assert.equal(receipt.phase, "preflight");
		assert.equal(receipt.mutationStatus, "not-applied");
		assert.equal(receipt.recoveryRequired, false);
		await assert.rejects(readFile(marker), { code: "ENOENT" });
	});
}

for (const failure of [
	"none",
	"plan",
	"initial-login",
	"initial-publication",
	"binding",
	"reserve-login",
	"reserve-publication",
	"readiness",
]) {
	test(`fresh all preserves publication and reserve ordering (${failure})`, async () => {
		const source = await readFile(
			new URL("../deploy/ack/redeploy.sh", import.meta.url),
			"utf8",
		);
		const dispatch = source.slice(source.indexOf("\ncommand="));
		const result = spawnSync(
			"bash",
			[
				"-c",
				`
set -euo pipefail
require_source_tuple() { :; }
require_file() { [[ -n "$2" ]]; }
prepare_evidence() { :; }
render_manifest() { :; }
configuration_source_preflight() { :; }
preflight_agent_requests() { :; }
reserve_plan_preflight() { echo plan; ${failure === "plan" ? "return 1" : ":"}; }
bootstrap_database() { echo database; }
image_cache_gate() { :; }
bootstrap_inputs() { echo bootstrap; }
deploy() { echo deploy; }
template_preflight() { echo templates; }
now=0
login_at=-600001
logins=0
custom_preflight() { now=$((now+600001)); echo custom; }
bootstrap_login() { logins=$((logins+1)); echo login-$logins; ${failure === "initial-login" ? '[[ "$logins" != 1 ]] || return 1' : failure === "reserve-login" ? '[[ "$logins" != 2 ]] || return 1' : ":"}; login_at=$now; }
publications=0
runtime_inputs() { [[ $((now-login_at)) -lt 600000 ]] || return 1; publications=$((publications+1)); echo publish-$publications; ${failure === "initial-publication" ? '[[ "$publications" != 1 ]]' : failure === "reserve-publication" ? '[[ "$publications" != 2 ]]' : ":"}; }
bootstrap_credential() { [[ "$publications" == 1 ]]; echo credential; }
node() { :; }
provision() { [[ "$publications" == 1 ]]; now=$((now+600001)); echo provision; }
bind_session_reserves() { echo bind; ${failure === "binding" ? "return 1" : ":"}; }
wait_session_reserves() { [[ "$publications" == 2 ]] || return 1; echo ready; ${failure === "readiness" ? "return 1" : ":"}; }
validate() { echo validate; }
repo_root=/fixture
source_sha=fixture
${dispatch}
`,
				"test",
				"all",
			],
			{
				encoding: "utf8",
				env: {
					PATH: process.env.PATH,
					BASH_ENV: "/dev/null",
					ACK_BOOTSTRAP_INPUTS_FILE: "/fixture/bootstrap",
					ACK_WORKLOAD_CAPACITY_FILE: "/fixture/capacity",
					ACK_LOGIN_BOOTSTRAP_FILE: "/fixture/login",
					ACK_CREDENTIAL_BOOTSTRAP_FILE: "/fixture/credential",
					ACK_TEMPLATE_PREFLIGHT_JOBS_FILE: "/fixture/jobs",
					ACK_CUSTOM_CAPACITY_JOB_FILE: "/fixture/custom",
					ACK_SESSION_RESERVE_PLAN_FILE: "/fixture/plan",
				},
			},
		);
		const stages = result.stdout.trim().split("\n");
		assert.equal(result.status, failure === "none" ? 0 : 1, result.stderr);
		if (failure === "none")
			assert.deepEqual(stages, [
				"plan",
				"database",
				"bootstrap",
				"database",
				"deploy",
				"templates",
				"custom",
				"login-1",
				"publish-1",
				"credential",
				"provision",
				"bind",
				"login-2",
				"publish-2",
				"ready",
				"validate",
			]);
		else assert(!stages.includes("validate"));
		if (failure === "plan") assert(!stages.includes("bootstrap"));
		if (failure === "initial-login") assert(!stages.includes("publish-1"));
		if (failure === "initial-publication")
			assert(!stages.includes("credential") && !stages.includes("provision"));
		if (failure === "binding")
			assert(stages.includes("publish-1") && !stages.includes("publish-2"));
		if (failure === "reserve-login")
			assert(stages.includes("bind") && !stages.includes("publish-2"));
		if (failure === "reserve-publication") assert(!stages.includes("ready"));
	});
}

test("a candidate cannot replace an already approved capacity profile", async (t) => {
	const f = await fixture(t);
	await publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true);
	const baseline = await readFile(f.capacity.profilesFile);
	const candidate = JSON.parse(baseline);
	candidate.profiles[0].conformanceEvidenceHash = "f".repeat(64);
	const file = await f.save(
		join(dirname(f.capacity.profilesFile), "conflicting-candidate.json"),
		candidate,
	);
	const input = JSON.parse(await readFile(f.files.capacity));
	input.candidateProfilesFile = file;
	await f.save(f.files.capacity, input);
	const mutations = f.mutations.length;
	await assert.rejects(
		publishRuntimeInputs(f.files, f.rendered, source, f.kubectl, true),
		/RUNTIME_INPUT_CAPACITY_TUPLE_INVALID/,
	);
	assert.equal(f.mutations.length, mutations);
	assert.deepEqual(await readFile(f.capacity.profilesFile), baseline);
});
