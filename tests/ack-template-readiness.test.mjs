import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as preflight from "../deploy/ack/template-model-preflight.mjs";

const {
	projectPodStartupReceipt,
	validateTemplatePreflightJob,
	renderTemplatePreflightPod,
	observeTemplatePreflightLayout,
} = preflight;

const script = new URL(
	"../deploy/ack/template-model-preflight.mjs",
	import.meta.url,
).pathname;

test("template model config binds the relay credential into the V4 option", async () => {
	const source = await readFile(script, "utf8");
	assert.match(
		source,
		/--from-file=model-credential=\$\{modelCredentialFile\}/u,
	);
	assert.match(source, /modelCredentialFile/);
	assert.match(source, /writeFile\(modelCredentialFile, modelCredential/u);
});
const baseJob = {
	schemaVersion: 1,
	scope: "isolated-template-real-model",
	kubeconfig: "/private/kubeconfig",
	namespace: "test-ack",
	sourceCommit: "a".repeat(40),
	templateId: "claude",
	driver: "claude",
	protocol: "anthropic-messages-v1",
	operatorApprovalRef: "approved-fixture",
	worktree: "/private/source",
	outputDirectory: "/private/output",
	imageReference: `registry.example.test/runtime@sha256:${"b".repeat(64)}`,
	imageDigest: `sha256:${"b".repeat(64)}`,
	modelId: "test-model",
	modelOptionId: "test:model",
	reasoningLevel: "high",
	configurationRevision: "rev-1",
	runtimeConfigVersion: "v1",
	approvedRelayOrigin: "https://relay.example.test",
	grantPrivateKeyFile: "/private/grant",
	runtimeServiceTokenFile: "/private/token",
	relayKeyFile: "/private/key",
	expectedResourceLimits: { cpu: "1", memory: "2Gi" },
	placement: { nodeSelector: { type: "virtual-kubelet" } },
};

const ecsJob = {
	...baseJob,
	expectedNodePrefix: "cn-hangzhou.10.0.1.219",
	placement: {
		nodeSelector: {
			"kubernetes.io/hostname": "cn-hangzhou.10.0.1.219",
			"kubernetes.io/arch": "amd64",
			"kubernetes.io/os": "linux",
		},
	},
};
test("accepts an explicitly pinned ECS template preflight", () => {
	assert.equal(
		validateTemplatePreflightJob(ecsJob).expectedNodePrefix,
		ecsJob.placement.nodeSelector["kubernetes.io/hostname"],
	);
});
for (const prefix of [undefined, "", "cn-hangzhou.", "other-node"]) {
	test(`rejects ECS placement without exact node evidence: ${prefix}`, () => {
		assert.throws(() =>
			validateTemplatePreflightJob({ ...ecsJob, expectedNodePrefix: prefix }),
		);
	});
}
for (const key of [
	"kubernetes.io/hostname",
	"kubernetes.io/arch",
	"kubernetes.io/os",
]) {
	test(`rejects ECS placement missing ${key}`, () => {
		const nodeSelector = { ...ecsJob.placement.nodeSelector };
		delete nodeSelector[key];
		assert.throws(() =>
			validateTemplatePreflightJob({ ...ecsJob, placement: { nodeSelector } }),
		);
	});
}

const expectedPod = {
	name: "ack-preflight-claude-fixture",
	owner: "fixture-owner",
};
const startupPod = {
	metadata: {
		name: expectedPod.name,
		namespace: baseJob.namespace,
		uid: "pod-uid-3771",
		creationTimestamp: "2026-10-30T00:00:00Z",
		labels: {
			"agent-infra.validation-source": baseJob.sourceCommit,
			"agent-infra.validation-owner": expectedPod.owner,
			"agent-infra.validation-scope": baseJob.scope,
		},
	},
	spec: { containers: [{ name: "runtime", image: baseJob.imageReference }] },
	status: {
		containerStatuses: [
			{
				name: "runtime",
				state: { running: { startedAt: "2026-10-30T00:00:10Z" } },
			},
		],
		conditions: [
			{
				type: "Ready",
				status: "True",
				lastTransitionTime: "2026-10-30T00:00:12Z",
			},
		],
	},
};
const event = (reason, at = "2026-10-30T00:00:01Z", extra = {}) => ({
	involvedObject: { kind: "Pod", uid: startupPod.metadata.uid },
	type: "Normal",
	reason,
	eventTime: at,
	...extra,
});
const project = (events, pod = startupPod, job = baseJob) =>
	projectPodStartupReceipt({ job, expectedPod, pod, events });

test("startup receipt distinguishes partial cache hits from real image presence", () => {
	const receipt = project([
		event("SuccessfulHitImageCache"),
		event("ImageCacheNotFullMatch"),
		event("ImageCacheAutoCreated"),
		event("ImageCacheAutoEliminated"),
		event("Pulling"),
		event("Pulled", "2026-10-30T00:00:05Z"),
	]);
	assert.equal(receipt.sourceCommit, baseJob.sourceCommit);
	assert.equal(receipt.imageDigest, baseJob.imageDigest);
	assert.match(receipt.podUidSha256, /^[a-f0-9]{64}$/u);
	assert.deepEqual(receipt.durationsSeconds, {
		createToContainer: 10,
		createToReady: 12,
		containerToReady: 2,
	});
	assert.deepEqual(receipt.cache, {
		hit: true,
		partialMatch: true,
		autoCreated: true,
		autoEvicted: true,
		imageAlreadyPresent: false,
	});
	assert.deepEqual(receipt.pull, { status: "observed", seconds: 4 });
	const already = project([
		event("Pulled", "2026-10-30T00:00:05Z", {
			message: `Container image "${baseJob.imageReference}" already present on machine`,
		}),
	]);
	assert.equal(already.cache.imageAlreadyPresent, true);
	assert.deepEqual(already.pull, { status: "unknown", seconds: null });
	assert.equal(
		project([event("SuccessfulHitImageCache")]).cache.imageAlreadyPresent,
		null,
	);
});

test("missing events and wrong-UID events cannot manufacture a cache miss or pull proof", () => {
	for (const events of [
		undefined,
		[],
		[
			event("Pulled", undefined, {
				involvedObject: { kind: "Pod", uid: "another-pod" },
			}),
		],
	]) {
		const receipt = project(events);
		assert.equal(
			receipt.eventRead,
			events === undefined ? "unavailable" : "unknown",
		);
		assert.deepEqual(receipt.cache, {
			hit: null,
			partialMatch: null,
			autoCreated: null,
			autoEvicted: null,
			imageAlreadyPresent: null,
		});
		assert.deepEqual(receipt.pull, { status: "unknown", seconds: null });
	}
});

test("startup binding rejects wrong owner, name, source, image, or extra containers", () => {
	for (const mutate of [
		(pod) => {
			pod.metadata.name = "ack-preflight-other";
		},
		(pod) => {
			pod.metadata.namespace = "another-namespace";
		},
		(pod) => {
			pod.metadata.labels["agent-infra.validation-owner"] = "another-owner";
		},
		(pod) => {
			pod.metadata.labels["agent-infra.validation-source"] = "f".repeat(40);
		},
		(pod) => {
			pod.spec.containers[0].image = "wrong-image";
		},
		(pod) => {
			pod.spec.containers.push({ ...pod.spec.containers[0] });
		},
		(pod) => {
			delete pod.metadata.uid;
		},
	]) {
		const pod = structuredClone(startupPod);
		mutate(pod);
		assert.throws(() => project([], pod), /STARTUP_RECEIPT_BINDING_INVALID/u);
	}
	assert.throws(
		() => project([], startupPod, { ...baseJob, sourceCommit: "f".repeat(40) }),
		/STARTUP_RECEIPT_BINDING_INVALID/u,
	);
});

test("missing, invalid, backwards, or unbounded times remain diagnostic unknown", () => {
	for (const invalid of [
		undefined,
		"private-secret-value",
		"2026-02-30T00:00:00Z",
		"2026-10-29T00:00:00Z",
		"2026-11-30T00:00:00Z",
	]) {
		const pod = structuredClone(startupPod);
		pod.status.conditions[0].lastTransitionTime = invalid;
		const receipt = project([], pod);
		assert.equal(receipt.timingReadback, "unknown");
		assert.deepEqual(receipt.durationsSeconds, {
			createToContainer: null,
			createToReady: null,
			containerToReady: null,
		});
	}
	for (const events of [
		[event("Pulling", "bad-time"), event("Pulled", "2026-10-30T00:00:05Z")],
		[
			event("Pulling", "2026-10-30T00:00:05Z"),
			event("Pulled", "2026-10-30T00:00:01Z"),
		],
		[event("Pulling"), event("Pulled", "2026-11-30T00:00:05Z")],
	])
		assert.deepEqual(project(events).pull, {
			status: "unknown",
			seconds: null,
		});
});

test("startup projection outputs only allowlisted fields even from sensitive events", () => {
	const marker = "private-secret-cache-id-message";
	const pod = structuredClone(startupPod);
	pod.spec.containers[0].env = [{ name: "TOKEN", value: marker }];
	const receipt = project(
		[
			event("SuccessfulHitImageCache", undefined, {
				message: marker,
				metadata: { name: marker },
				count: marker,
			}),
			event(marker, undefined, { message: marker }),
			event("Pulled", undefined, {
				message: `Container image "${marker}" already present on machine`,
			}),
		],
		pod,
	);
	const serialized = JSON.stringify(receipt);
	for (const raw of [
		marker,
		pod.metadata.name,
		pod.metadata.namespace,
		pod.metadata.uid,
		expectedPod.owner,
		baseJob.imageReference,
	])
		assert.equal(serialized.includes(raw), false);
	assert.equal(receipt.cache.imageAlreadyPresent, null);
});

test("an already-present message with invalid event times cannot prove cache or image state", () => {
	const message = `Container image "${baseJob.imageReference}" already present on machine`;
	for (const invalid of [
		{ eventTime: "invalid-time" },
		{ eventTime: "2026-10-29T00:00:00Z" },
		{ eventTime: "2026-10-30T00:00:13Z" },
		{
			firstTimestamp: "2026-10-30T00:00:05Z",
			lastTimestamp: "2026-10-30T00:00:01Z",
		},
		{
			firstTimestamp: "2026-10-30T00:00:01Z",
			lastTimestamp: "2026-10-30T00:00:05Z",
			eventTime: "invalid-time",
		},
	]) {
		const receipt = project([
			event("SuccessfulHitImageCache"),
			event("Pulled", undefined, { message, ...invalid }),
		]);
		assert.equal(receipt.eventRead, "unknown");
		assert.equal(receipt.cache.imageAlreadyPresent, null);
		assert.equal(receipt.cache.hit, null);
		assert.deepEqual(receipt.pull, { status: "unknown", seconds: null });
	}
});

test("template readiness budget defaults and bounds are validated without changing the input", () => {
	assert.equal(
		validateTemplatePreflightJob(baseJob).podReadyTimeoutSeconds,
		900,
	);
	assert.equal(Object.hasOwn(baseJob, "podReadyTimeoutSeconds"), false);
	for (const value of [60, 900, 1800])
		assert.equal(
			validateTemplatePreflightJob({
				...baseJob,
				podReadyTimeoutSeconds: value,
			}).podReadyTimeoutSeconds,
			value,
		);
	for (const value of [
		null,
		0,
		59,
		1801,
		60.5,
		"900",
		true,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])
		assert.throws(
			() =>
				validateTemplatePreflightJob({
					...baseJob,
					podReadyTimeoutSeconds: value,
				}),
			/POD_READY_TIMEOUT_INVALID/u,
		);
});

for (const scenario of [
	"default-wait-failed",
	"custom-wait-failed",
	"unsafe-reason",
	"readback-failed",
	"identity-drift",
	"ready-continues",
	"ready-events-unavailable",
	"ready-events-other-pod",
	"invalid-budget",
]) {
	test(`template readiness executes and cleans its owned resources: ${scenario}`, async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "ack-ready-"));
		t.after(() => rm(directory, { recursive: true, force: true }));
		const bin = join(directory, "bin");
		await mkdir(bin);
		const log = join(directory, "calls.jsonl");
		const state = join(directory, "pod.json");
		const secret = "fixture-secret-must-not-appear";
		const grant = join(directory, "grant.pem");
		const token = join(directory, "token");
		const relayKey = join(directory, "relay-key");
		const { privateKey } = generateKeyPairSync("ed25519");
		await writeFile(
			grant,
			privateKey.export({ type: "pkcs8", format: "pem" }),
			{ mode: 0o600 },
		);
		await writeFile(token, secret, { mode: 0o600 });
		await writeFile(relayKey, "synthetic-relay-credential-0123456789012345", {
			mode: 0o600,
		});
		const output = join(directory, "output");
		const job = {
			...baseJob,
			outputDirectory: output,
			grantPrivateKeyFile: grant,
			runtimeServiceTokenFile: token,
			relayKeyFile: relayKey,
			...(scenario === "custom-wait-failed"
				? { podReadyTimeoutSeconds: 1800 }
				: {}),
			...(scenario === "invalid-budget"
				? { podReadyTimeoutSeconds: 1801 }
				: {}),
		};
		const file = join(directory, "job.json");
		await writeFile(file, JSON.stringify(job), { mode: 0o600 });
		await writeFile(
			join(bin, "kubectl"),
			`#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2),scenario=${JSON.stringify(scenario)},secret=${JSON.stringify(secret)};
const log=${JSON.stringify(log)},state=${JSON.stringify(state)};
fs.appendFileSync(log,JSON.stringify(args)+'\\n');
if(args.includes('create')&&args.includes('secret')){console.log('{}');process.exit(0);}
if(args.includes('apply')){fs.readFileSync(0);process.exit(0);}
if(args.includes('create')){const pod=JSON.parse(fs.readFileSync(0));pod.metadata.uid='fixture-pod-uid';pod.metadata.creationTimestamp='2026-10-30T00:00:00Z';fs.writeFileSync(state,JSON.stringify(pod));process.exit(0);}
if(args.includes('wait')){if(scenario.startsWith('ready-'))process.exit(0);console.error(secret);process.exit(1);}
if(args.includes('events')){if(scenario==='ready-events-unavailable'){console.error(secret);process.exit(1);}console.log(JSON.stringify({items:scenario==='ready-events-other-pod'?[{involvedObject:{kind:'Pod',uid:'other-pod'},type:'Normal',reason:'Pulled',message:secret}]:[]}));process.exit(0);}
if(args.includes('get')){
 if(scenario==='readback-failed'){console.error(secret);process.exit(1);}
 const pod=JSON.parse(fs.readFileSync(state));pod.status={phase:'Pending',containerStatuses:[{state:{waiting:{reason:scenario==='unsafe-reason'?secret:'ContainerCreating',message:secret}}}]};
 if(scenario.startsWith('ready-'))pod.status={phase:'Running',containerStatuses:[{name:'runtime',imageID:'docker-pullable://runtime@sha256:'+'c'.repeat(64),state:{running:{startedAt:'2026-10-30T00:00:10Z'}}}],conditions:[{type:'Ready',status:'True',lastTransitionTime:'2026-10-30T00:00:12Z'}]};
 if(scenario==='identity-drift')pod.metadata.labels['agent-infra.validation-owner']='different-owner';
 console.log(JSON.stringify(pod));process.exit(0);
}
if(args.includes('port-forward')){console.error(secret);process.exit(1);}
`,
			{ mode: 0o700 },
		);
		const result = spawnSync(process.execPath, [script, file], {
			encoding: "utf8",
			timeout: 15_000,
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		});
		assert.equal(result.status, 1);
		assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
		if (scenario === "invalid-budget") {
			await assert.rejects(readFile(log), { code: "ENOENT" });
			assert.match(result.stderr, /POD_READY_TIMEOUT_INVALID/u);
			return;
		}
		const calls = (await readFile(log, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const wait = calls.find((args) => args.includes("wait"));
		assert.equal(
			wait.at(-1),
			scenario === "custom-wait-failed" ? "--timeout=1800s" : "--timeout=900s",
		);
		const pod = JSON.parse(await readFile(state, "utf8"));
		const deleted = calls
			.filter((args) => args.includes("delete"))
			.map((args) =>
				args.slice(args.indexOf("delete") + 1, args.indexOf("delete") + 3),
			);
		assert.deepEqual(deleted, [
			["pod", pod.metadata.name],
			["secret", pod.metadata.name],
		]);
		const receiptFile = join(output, "pod-readiness-failure.json");
		if (scenario.startsWith("ready-")) {
			assert(calls.some((args) => args.includes("port-forward")));
			const startup = JSON.parse(
				await readFile(join(output, "pod-startup.receipt.json"), "utf8"),
			);
			assert.equal(startup.sourceCommit, job.sourceCommit);
			assert.equal(startup.durationsSeconds.createToReady, 12);
			assert.equal(
				startup.eventRead,
				scenario === "ready-events-unavailable" ? "unavailable" : "unknown",
			);
			assert.equal(JSON.stringify(startup).includes(secret), false);
			assert.equal(startup.cache.imageAlreadyPresent, null);
			assert(
				calls.some((args) =>
					args.includes("involvedObject.uid=fixture-pod-uid"),
				),
			);
			await assert.rejects(readFile(receiptFile), { code: "ENOENT" });
			return;
		}
		assert.equal(
			calls.some(
				(args) => args.includes("port-forward") || args.includes("exec"),
			),
			false,
		);
		const receiptBytes = await readFile(receiptFile, "utf8");
		assert.equal(receiptBytes.includes(secret), false);
		const receipt = JSON.parse(receiptBytes);
		assert.equal(receipt.stage, "pod-ready");
		assert.equal(receipt.modelCallAttempted, false);
		assert.equal(receipt.imageDigest, job.imageDigest);
		assert.equal(receipt.sourceSha, job.sourceCommit);
		assert.equal(
			receipt.podReadyTimeoutSeconds,
			scenario === "custom-wait-failed" ? 1800 : 900,
		);
		assert.equal(
			receipt.readback,
			scenario === "readback-failed"
				? "unavailable"
				: scenario === "identity-drift"
					? "identity-mismatch"
					: "matched",
		);
		if (receipt.readback === "matched")
			assert.deepEqual(receipt.waitingReasons, [
				scenario === "unsafe-reason" ? "Unknown" : "ContainerCreating",
			]);
		assert.match(result.stderr, /TEMPLATE_POD_READINESS_FAILED/u);
	});
}

const executorPolicy = {
	resources: {
		requests: { cpu: "250m", memory: "256Mi" },
		limits: { cpu: "1", memory: "512Mi" },
	},
	tmpSizeLimit: "128Mi",
	placement: { architecture: "amd64" },
};
const executorModelEgress = [{ destination: { ip: "192.0.2.1" }, port: 443 }];
const executorDnsEgress = [
	{ namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
];
const executorJob = {
	...baseJob,
	templateId: "codex",
	driver: "codex",
	protocol: "openai-responses-v1",
	imageReference: `ghcr.io/agoraio-extensions/agent-infra/agent-runtime-codex@${baseJob.imageDigest}`,
	resourceProfileRef: "small",
	modelEgress: executorModelEgress,
	dnsEgress: executorDnsEgress,
	resources: {
		requests: { cpu: "100m", memory: "128Mi" },
		limits: baseJob.expectedResourceLimits,
	},
	codexSessionExecutor: executorPolicy,
	storageSize: "20Gi",
	storageClassName: "test-essd",
	placement: {
		nodeSelector: { type: "virtual-kubelet", "kubernetes.io/arch": "amd64" },
		tolerations: [
			{
				key: "virtual-kubelet.io/provider",
				operator: "Equal",
				value: "alibabacloud",
				effect: "NoSchedule",
			},
		],
	},
};
function executorFixture(job = executorJob) {
	const rendered = renderTemplatePreflightPod({
		job,
		owner: "test-owner-123",
		publicKey: "synthetic-public-key",
		modelConfig: "{}",
		serviceToken: "synthetic-service-token",
	});
	rendered.pod.metadata.uid = "owned-pod";
	rendered.pvc.metadata.uid = "owned-pvc";
	rendered.serviceAccount.metadata.uid = "owned-service-account";
	rendered.networkPolicy.metadata.uid = "owned-network-policy";
	const observed = structuredClone(rendered.pod);
	observed.spec.nodeName = "virtual-kubelet-test";
	observed.status = {
		phase: "Running",
		containerStatuses: observed.spec.containers.map((container) => ({
			name: container.name,
			ready: true,
			restartCount: 0,
			imageID: `containerd://${job.imageDigest}`,
			containerID: `containerd://${container.name}`,
			state: { running: { startedAt: "2026-10-30T00:00:10Z" } },
		})),
		...(rendered.binding
			? {
					initContainerStatuses: [
						{
							name: "codex-session-workspace-init",
							restartCount: 0,
							imageID: `containerd://${job.imageDigest}`,
							state: { terminated: { exitCode: 0 } },
						},
					],
				}
			: {}),
	};
	const pvc = structuredClone(rendered.pvc);
	pvc.status = { phase: "Bound", capacity: { storage: "20Gi" } };
	const serviceAccount = structuredClone(rendered.serviceAccount);
	const networkPolicy = structuredClone(rendered.networkPolicy);
	return {
		rendered,
		observed,
		pvc,
		serviceAccount,
		networkPolicy,
		observe: () =>
			observeTemplatePreflightLayout(
				job,
				rendered,
				observed,
				pvc,
				serviceAccount,
				networkPolicy,
			),
	};
}

test("executor capacity job requires the official image and bounded matching ECI policy", () => {
	assert.equal(
		validateTemplatePreflightJob(executorJob).codexSessionExecutor,
		executorPolicy,
	);
	for (const change of [
		{ resourceProfileRef: undefined },
		{ storageSize: undefined },
		{ storageClassName: undefined },
		{ imageReference: baseJob.imageReference },
		{ driver: "claude" },
		{
			resources: {
				requests: { cpu: "invalid", memory: "128Mi" },
				limits: baseJob.expectedResourceLimits,
			},
		},
		{
			codexSessionExecutor: {
				...executorPolicy,
				placement: { architecture: "arm64" },
			},
		},
		{
			codexSessionExecutor: {
				...executorPolicy,
				placement: { architecture: "amd64", runtimeClassName: "foreign" },
			},
		},
		{
			placement: {
				...executorJob.placement,
				nodeSelector: {
					...executorJob.placement.nodeSelector,
					"kubernetes.io/hostname": "other-node",
				},
			},
		},
		{ placement: { ...executorJob.placement, tolerations: [] } },
	])
		assert.throws(() =>
			validateTemplatePreflightJob({ ...executorJob, ...change }),
		);
});

test("executor capacity rendering binds a fixed synthetic Conversation and exact credential-free subPath", () => {
	const { rendered, observe } = executorFixture();
	assert.match(rendered.pod.metadata.name, /^sandbox-preflight-/u);
	assert.equal(rendered.binding.podName, rendered.pod.metadata.name);
	assert.equal(
		rendered.binding.conversationId,
		"validation-conversation-test-owner-123",
	);
	assert.equal(rendered.pod.spec.shareProcessNamespace, false);
	assert.deepEqual(
		rendered.pod.spec.initContainers[0].resources,
		executorPolicy.resources,
	);
	assert.deepEqual(
		rendered.pod.spec.containers[1].resources,
		executorPolicy.resources,
	);
	assert.deepEqual(
		rendered.pod.spec.containers[1].env.map((item) => item.name),
		[
			"AGENT_INFRA_CODEX_SESSION_EXECUTOR_BINDING",
			"AGENT_INFRA_RUNTIME_POD_UID",
		],
	);
	assert.deepEqual(rendered.pod.spec.containers[1].volumeMounts, [
		{
			name: "workspace",
			mountPath: rendered.binding.workspaceRoot,
			subPath: rendered.binding.workspaceSubPath,
		},
		{ name: "executor-tmp", mountPath: "/tmp" },
	]);
	assert.deepEqual(observe(), {
		observedExecutorResources: executorPolicy.resources,
		observedInitResources: executorPolicy.resources,
		storageClassName: "test-essd",
		pvcUidSha256: preflightHash("owned-pvc"),
		serviceAccountUidSha256: preflightHash("owned-service-account"),
		networkPolicyUidSha256: preflightHash("owned-network-policy"),
		networkPolicySpecSha256: preflightHash(
			JSON.stringify(rendered.networkPolicy.spec),
		),
		networkDataplaneVerified: false,
	});
});
const preflightHash = (value) =>
	createHash("sha256").update(value).digest("hex");

for (const [name, mutate] of [
	[
		"retiring Pod",
		({ observed }) =>
			(observed.metadata.deletionTimestamp = "2026-10-30T00:01:00Z"),
	],
	[
		"retiring PVC",
		({ pvc }) => (pvc.metadata.deletionTimestamp = "2026-10-30T00:01:00Z"),
	],
	[
		"retiring network policy",
		({ networkPolicy }) =>
			(networkPolicy.metadata.deletionTimestamp = "2026-10-30T00:01:00Z"),
	],

	[
		"extra container",
		({ observed }) =>
			observed.spec.containers.push(
				structuredClone(observed.spec.containers[1]),
			),
	],
	["missing init", ({ observed }) => (observed.spec.initContainers = [])],
	[
		"shared PID",
		({ observed }) => (observed.spec.shareProcessNamespace = true),
	],
	["host namespace", ({ observed }) => (observed.spec.hostNetwork = true)],
	[
		"foreign RuntimeClass",
		({ observed }) => (observed.spec.runtimeClassName = "foreign"),
	],
	[
		"ephemeral container",
		({ observed }) =>
			(observed.spec.ephemeralContainers = [{ name: "foreign" }]),
	],
	["wrong node", ({ observed }) => (observed.spec.nodeName = "foreign-node")],
	[
		"service account drift",
		({ serviceAccount }) =>
			(serviceAccount.automountServiceAccountToken = true),
	],
	[
		"service account token",
		({ serviceAccount }) => (serviceAccount.secrets = [{ name: "foreign" }]),
	],
	[
		"foreign network UID",
		({ networkPolicy }) => (networkPolicy.metadata.uid = "foreign"),
	],
	[
		"network ingress widened",
		({ networkPolicy }) => (networkPolicy.spec.ingress = [{}]),
	],
	[
		"network egress widened",
		({ networkPolicy }) => networkPolicy.spec.egress.push({}),
	],

	[
		"foreign Pod UID",
		({ observed }) => (observed.metadata.uid = "foreign-pod"),
	],
	[
		"control root UID",
		({ observed }) =>
			(observed.spec.containers[0].securityContext.runAsUser = 0),
	],
	[
		"executor privilege",
		({ observed }) =>
			(observed.spec.containers[1].securityContext.privileged = true),
	],
	[
		"executor capability",
		({ observed }) =>
			(observed.spec.containers[1].securityContext.capabilities.add = [
				"SYS_ADMIN",
			]),
	],
	[
		"executor credential env",
		({ observed }) =>
			observed.spec.containers[1].env.push({
				name: "TOKEN",
				value: "synthetic",
			}),
	],
	[
		"executor full PVC",
		({ observed }) =>
			delete observed.spec.containers[1].volumeMounts[0].subPath,
	],
	[
		"executor Host mount",
		({ observed }) =>
			observed.spec.containers[1].volumeMounts.push({
				name: "workspace",
				mountPath: "/host",
			}),
	],
	[
		"executor resource drift",
		({ observed }) =>
			(observed.spec.containers[1].resources.limits.memory = "256Mi"),
	],
	[
		"init failure",
		({ observed }) =>
			(observed.status.initContainerStatuses[0].state.terminated.exitCode = 1),
	],
	[
		"executor restart",
		({ observed }) => (observed.status.containerStatuses[1].restartCount = 1),
	],
	[
		"foreign executor image",
		({ observed }) =>
			(observed.status.containerStatuses[1].imageID = "sha256:foreign"),
	],
	["foreign PVC UID", ({ pvc }) => (pvc.metadata.uid = "foreign-pvc")],
	[
		"foreign PVC owner",
		({ pvc }) =>
			(pvc.metadata.labels["agent-infra.validation-owner"] = "foreign"),
	],
	[
		"foreign storage class",
		({ pvc }) => (pvc.spec.storageClassName = "foreign"),
	],
	["unbound PVC", ({ pvc }) => (pvc.status.phase = "Pending")],
	["unmeasured disk size", ({ pvc }) => (pvc.status.capacity.storage = "40Gi")],
])
	test(`executor capacity readback rejects ${name}`, () => {
		const fixture = executorFixture();
		mutate(fixture);
		assert.throws(fixture.observe);
	});

test("executor readback permits safe API defaults without accepting security overrides", () => {
	const fixture = executorFixture();
	fixture.observed.spec.tolerations.push({
		key: "node.kubernetes.io/not-ready",
		operator: "Exists",
		effect: "NoExecute",
		tolerationSeconds: 300,
	});
	for (const container of [
		...fixture.observed.spec.containers,
		...fixture.observed.spec.initContainers,
	]) {
		container.terminationMessagePath = "/dev/termination-log";
		container.terminationMessagePolicy = "File";
		container.imagePullPolicy = "IfNotPresent";
	}
	fixture.observed.spec.volumes[0].persistentVolumeClaim.readOnly = false;
	for (const key of ["hostPID", "hostIPC", "hostNetwork"])
		delete fixture.observed.spec[key];
	fixture.networkPolicy.spec.ingress = undefined;
	assert.equal(fixture.observe().storageClassName, "test-essd");
});

test("non-Codex global executor policy measures only its real control container and PVC", () => {
	const job = {
		...executorJob,
		templateId: "claude",
		driver: "claude",
		protocol: "anthropic-messages-v1",
		imageReference: baseJob.imageReference,
	};
	const fixture = executorFixture(job);
	assert.equal(fixture.rendered.binding, undefined);
	assert.equal(fixture.rendered.pod.spec.containers.length, 1);
	assert.equal(fixture.rendered.pod.spec.initContainers, undefined);
	assert.equal(fixture.observe().observedExecutorResources, undefined);
	assert.equal(fixture.observe().observedInitResources, undefined);
	assert.equal(fixture.observe().storageClassName, "test-essd");
});

test("PVC observation accepts API canonical quantity aliases while retaining positive exact capacity", () => {
	const fixture = executorFixture({ ...executorJob, storageSize: "1.5Gi" });
	fixture.pvc.spec.resources.requests.storage = "1536Mi";
	fixture.pvc.status.capacity.storage = "1610612736";
	assert.equal(fixture.observe().storageClassName, "test-essd");
	for (const invalid of ["0", "invalid", "2Gi"]) {
		fixture.pvc.status.capacity.storage = invalid;
		assert.throws(fixture.observe, /EXECUTOR_PVC_DRIFT/u);
	}
});

for (const scenario of [
	"ready-failed",
	"foreign-pvc-cleanup",
	"foreign-secret-cleanup",
])
	test(`executor CLI creates and safely cleans owned resources: ${scenario}`, async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "ack-executor-ready-"));
		t.after(() => rm(directory, { recursive: true, force: true }));
		const bin = join(directory, "bin");
		await mkdir(bin);
		const log = join(directory, "calls.jsonl");
		const state = join(directory, "objects.json");
		const grant = join(directory, "grant.pem");
		const token = join(directory, "token");
		const relayKey = join(directory, "relay-key");
		const { privateKey } = generateKeyPairSync("ed25519");
		await writeFile(
			grant,
			privateKey.export({ type: "pkcs8", format: "pem" }),
			{ mode: 0o600 },
		);
		await writeFile(token, "synthetic-service-token-0123456789", {
			mode: 0o600,
		});
		await writeFile(relayKey, "synthetic-model-token-0123456789-0123456789", {
			mode: 0o600,
		});
		const output = join(directory, "output");
		const file = join(directory, "job.json");
		await writeFile(
			file,
			JSON.stringify({
				...executorJob,
				outputDirectory: output,
				grantPrivateKeyFile: grant,
				runtimeServiceTokenFile: token,
				relayKeyFile: relayKey,
			}),
			{ mode: 0o600 },
		);
		await writeFile(
			join(bin, "kubectl"),
			`#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2),scenario=${JSON.stringify(scenario)},log=${JSON.stringify(log)},state=${JSON.stringify(state)};
fs.appendFileSync(log,JSON.stringify(args)+'\\n');
const plural={pods:'Pod',secrets:'Secret',pvc:'PersistentVolumeClaim',persistentvolumeclaims:'PersistentVolumeClaim',serviceaccounts:'ServiceAccount',serviceaccount:'ServiceAccount',networkpolicies:'NetworkPolicy',networkpolicy:'NetworkPolicy'};
if(args.includes('create')&&args.includes('secret')){console.log(JSON.stringify({apiVersion:'v1',kind:'Secret',metadata:{}}));process.exit(0);}
if(args.includes('create')){const object=JSON.parse(fs.readFileSync(0));object.metadata.uid=object.kind+'-owned-uid';object.metadata.resourceVersion='1';const objects=fs.existsSync(state)?JSON.parse(fs.readFileSync(state)):{};objects[object.kind]=object;fs.writeFileSync(state,JSON.stringify(objects));console.log(JSON.stringify(object));process.exit(0);}
if(args.includes('wait')){process.exit(args.includes('--for=delete')?0:1);}
if(args.includes('get')){const kind=plural[args[args.indexOf('get')+1]],object=JSON.parse(fs.readFileSync(state))[kind];if(kind==='Pod')object.status={phase:'Pending',containerStatuses:[{state:{waiting:{reason:'ContainerCreating'}}}]};if((scenario==='foreign-pvc-cleanup'&&kind==='PersistentVolumeClaim')||(scenario==='foreign-secret-cleanup'&&kind==='Secret'))object.metadata.uid='foreign-uid';console.log(JSON.stringify(object));process.exit(0);}
if(args.includes('delete')){const request=JSON.parse(fs.readFileSync(0));if(!request.preconditions?.uid?.endsWith('-owned-uid'))process.exit(4);fs.appendFileSync(log,JSON.stringify({deleteUid:request.preconditions.uid})+'\\n');process.exit(0);}
process.exit(5);
`,
			{ mode: 0o700 },
		);
		const result = spawnSync(process.execPath, [script, file], {
			encoding: "utf8",
			timeout: 15000,
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		});
		assert.equal(result.status, 1);
		assert.equal(
			`${result.stdout}${result.stderr}`.includes("synthetic-service-token"),
			false,
		);
		const calls = (await readFile(log, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(
			calls.filter(
				(args) =>
					Array.isArray(args) &&
					args.includes("create") &&
					!args.includes("secret"),
			).length,
			5,
		);
		const deleted = calls
			.filter((entry) => !Array.isArray(entry))
			.map((entry) => entry.deleteUid);
		assert(deleted.includes("Pod-owned-uid"));
		assert.equal(
			deleted.includes("PersistentVolumeClaim-owned-uid"),
			scenario !== "foreign-pvc-cleanup",
		);
		assert.equal(
			deleted.includes("Secret-owned-uid"),
			scenario !== "foreign-secret-cleanup",
		);
		assert.match(
			result.stderr,
			scenario === "ready-failed"
				? /TEMPLATE_POD_READINESS_FAILED/u
				: /PREFLIGHT_CLEANUP_FAILED/u,
		);
		const identity = JSON.parse(
			await readFile(join(output, "owned-resource-identities.json")),
		);
		assert.equal(identity.resources.length, 5);
		assert.equal(identity.sourceCommit, executorJob.sourceCommit);
		assert.equal(
			identity.resources.every((resource) =>
				resource.uid.endsWith("-owned-uid"),
			),
			true,
		);
		assert.equal(
			JSON.stringify(identity).includes("synthetic-service-token"),
			false,
		);
		const outputs = await readdir(output);
		assert.equal(
			outputs.some(
				(name) =>
					name.startsWith(".attestation-") ||
					name.startsWith(".model-credential-"),
			),
			false,
		);
	});

test("capacity networking is default deny with only exact approved model and DNS destinations", () => {
	const { rendered } = executorFixture();
	assert.equal(rendered.serviceAccount.automountServiceAccountToken, false);
	assert.equal(
		rendered.pod.spec.serviceAccountName,
		rendered.serviceAccount.metadata.name,
	);
	assert.deepEqual(rendered.networkPolicy.spec.ingress, []);
	assert.deepEqual(rendered.networkPolicy.spec.policyTypes, [
		"Ingress",
		"Egress",
	]);
	assert.deepEqual(rendered.networkPolicy.spec.egress, [
		{
			to: [{ ipBlock: { cidr: "192.0.2.1/32" } }],
			ports: [{ protocol: "TCP", port: 443 }],
		},
		{
			to: [
				{
					namespaceSelector: {
						matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
					},
					podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
				},
			],
			ports: [
				{ protocol: "UDP", port: 53 },
				{ protocol: "TCP", port: 53 },
			],
		},
	]);
	for (const change of [
		{ modelEgress: [] },
		{ modelEgress: [{ destination: { cidr: "0.0.0.0/0" }, port: 443 }] },
		{ modelEgress: [{ destination: { ip: "192.0.2.1" }, port: 5432 }] },
		{
			modelEgress: [
				{
					destination: { namespace: "foreign", podLabels: { app: "database" } },
					port: 443,
				},
			],
		},
		{ dnsEgress: [] },
		{ dnsEgress: [{ cidr: "0.0.0.0/0" }] },
		{ dnsEgress: [{ namespace: "kube-system", podLabels: {} }] },
		{ dnsEgress: [{ namespace: "*", podLabels: { app: "dns" } }] },
		{
			dnsEgress: [
				{ namespace: "kube-system", podLabels: { "invalid key": "dns" } },
			],
		},
	])
		assert.throws(
			() => validateTemplatePreflightJob({ ...executorJob, ...change }),
			/PREFLIGHT_EGRESS_INVALID/u,
		);
});

test("only explicitly approved provider topology labels are accepted after scheduling", () => {
	const job = {
		...executorJob,
		allowedPodTopologyLabelValues: {
			"topology.kubernetes.io/region": ["test-region"],
			"topology.kubernetes.io/zone": ["test-zone-a"],
		},
	};
	const fixture = executorFixture(job);
	fixture.observed.metadata.labels["topology.kubernetes.io/region"] =
		"test-region";
	fixture.observed.metadata.labels["topology.kubernetes.io/zone"] =
		"test-zone-a";
	assert.equal(fixture.observe().storageClassName, "test-essd");
	fixture.observed.metadata.labels["topology.kubernetes.io/zone"] =
		"foreign-zone";
	assert.throws(fixture.observe, /PREFLIGHT_TOPOLOGY_DRIFT/u);
	for (const invalid of [
		{ "arbitrary-label": ["value"] },
		{ "topology.kubernetes.io/region": [] },
		{ "topology.kubernetes.io/zone": ["*"] },
	])
		assert.throws(
			() =>
				validateTemplatePreflightJob({
					...executorJob,
					allowedPodTopologyLabelValues: invalid,
				}),
			/PREFLIGHT_TOPOLOGY_INVALID/u,
		);
});
