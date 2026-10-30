import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as preflight from "../deploy/ack/template-model-preflight.mjs";

const { projectPodStartupReceipt, validateTemplatePreflightJob } = preflight;

const script = new URL(
	"../deploy/ack/template-model-preflight.mjs",
	import.meta.url,
).pathname;
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
		const { privateKey } = generateKeyPairSync("ed25519");
		await writeFile(
			grant,
			privateKey.export({ type: "pkcs8", format: "pem" }),
			{ mode: 0o600 },
		);
		await writeFile(token, secret, { mode: 0o600 });
		const output = join(directory, "output");
		const job = {
			...baseJob,
			outputDirectory: output,
			grantPrivateKeyFile: grant,
			runtimeServiceTokenFile: token,
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
