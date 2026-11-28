import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import {
	deriveNetworkPolicyDeploymentConfigV1,
	validateNetworkPolicyEnforcementV1,
} from "../deploy/ack/networkpolicy-enforcement.mjs";
import {
	assembleEvidenceV1,
	buildEvidenceV1,
	cleanup,
	clientSource,
	loadRun,
	parseProbeOutput,
	probeLabelKeysV1,
	probePlanV1,
	recordProbeStepV1,
	settleProbeV1,
} from "../deploy/ack/networkpolicy-probe.mjs";
import {
	networkPolicyEvidenceSha256V1,
	networkPolicySpecV1,
	networkPolicyTemplateDigestsV1,
} from "../packages/platform-core/src/workload-network-policy.ts";
import {
	networkPolicyDeploymentConfig,
	renderedEnforcementManifest,
	workerConfigurationInputs,
	workerConfigurationSource,
	workerPodLabels,
} from "./support/networkpolicy-evidence.mjs";
import {
	cluster,
	ecsNode,
	nodeNames,
	virtualNode,
} from "./support/networkpolicy-probe-cluster.mjs";

// #4351: the probe pack renders from the Worker template, records the four steps per
// ECI node, and produces evidence the production gate accepts. Synthetic cluster only.
const image = `registry.example.test/probe/node@sha256:${"a".repeat(64)}`;
const namespace = "agent-infra";
async function harness(options = {}) {
	const directory = await mkdtemp(join(tmpdir(), "np-probe-test-"));
	const config = networkPolicyDeploymentConfig();
	const { bootstrapInputsFile, renderedManifest: defaultManifest } =
		await workerConfigurationInputs(
			directory,
			workerConfigurationSource(config),
		);
	const renderedManifest = options.plan?.renderedManifest ?? defaultManifest;
	const derived = await deriveNetworkPolicyDeploymentConfigV1({
		bootstrapInputsFile,
		renderedManifest,
		namespace,
	});
	const world = cluster(options);
	world.state.workers = options.plan?.workers ?? [];
	const plan = probePlanV1({
		runId: "abc123",
		namespace,
		config: derived.config,
		workerConfigurationSha256: derived.workerConfigurationSha256,
		renderedManifest,
		nodes: world.nodes,
		workers: [],
		image,
		now: Date.now(),
		...options.plan,
	});
	const dir = join(directory, "run");
	for (const [file, content] of Object.entries(plan.files)) {
		const target = join(dir, file);
		await (await import("node:fs/promises")).mkdir(join(target, ".."), {
			recursive: true,
		});
		await writeFile(target, content);
	}
	await writeFile(join(dir, "run.json"), JSON.stringify(plan.run));
	const applyFile = async (index, file) =>
		world.apply(
			parse(await readFile(join(dir, "manifests", `n${index}`, file), "utf8")),
		);
	// A clock that moves one second per reading, ending before the real "now".
	let tick = Date.now() - 3_600_000;
	const clock = () => (tick += 1000);
	const record = (index, step, extra = {}) =>
		recordProbeStepV1({
			dir,
			index,
			step,
			kubectl: world.kubectl,
			exec: world.exec,
			namespace,
			sleep: async () => {},
			now: clock,
			intervalMs: 1,
			settleMs: 600_000,
			...extra,
		});
	const swap = (index, from, to) => {
		world.kubectl(["delete", "networkpolicy", from]);
		return applyFile(index, to);
	};
	/** The operator's whole run for one node, mirroring plan.md. */
	const runNode = async (index) => {
		const entry = loadRun(dir).nodes[index];
		await applyFile(index, "target.deployment.yaml");
		await applyFile(index, "source-worker.pod.yaml");
		await applyFile(index, "source-other.pod.yaml");
		await applyFile(index, "policy-original.yaml");
		await record(index, "allow");
		await record(index, "nonWorker");
		world.kubectl(["delete", "networkpolicy", entry.names.original]);
		await applyFile(index, "policy-deny.yaml");
		await record(index, "deny");
		world.kubectl(["delete", "networkpolicy", entry.names.deny]);
		await applyFile(index, "policy-original.yaml");
		await record(index, "recovery");
	};
	return {
		directory,
		dir,
		world,
		plan,
		config: derived.config,
		inputs: derived,
		renderedManifest,
		record,
		runNode,
		swap,
		applyFile,
		assemble: (extra = {}) =>
			assembleEvidenceV1({
				dir,
				kubectl: world.kubectl,
				namespace,
				inputs: { ...derived, renderedManifest },
				clusterId: "c0ffee0000",
				...extra,
			}),
	};
}

const code = (run) => {
	try {
		run();
	} catch (error) {
		return error.code;
	}
	return undefined;
};
const codeAsync = async (run) => {
	try {
		await run();
	} catch (error) {
		return error.code;
	}
	return undefined;
};

test("the plan renders from the Worker template for every ECI node and nothing else", async () => {
	const { plan, config, directory } = await harness();
	assert.deepEqual(
		plan.run.nodes.map((entry) => entry.node.name),
		nodeNames,
		"ECS nodes are not probe scope",
	);
	for (const entry of plan.run.nodes) {
		const original = parse(
			plan.files[`manifests/n${entry.index}/policy-original.yaml`],
		);
		assert.deepEqual(
			original.spec,
			networkPolicySpecV1({
				variant: "internal-only",
				config,
				substitutions: entry.substitutions,
			}),
		);
		assert.equal(
			entry.expectedPolicySha256,
			networkPolicyEvidenceSha256V1(original.spec, config),
		);
		const target = parse(
			plan.files[`manifests/n${entry.index}/target.deployment.yaml`],
		);
		assert.equal(target.metadata.namespace, namespace);
		assert.equal(
			target.spec.template.spec.nodeSelector["kubernetes.io/hostname"],
			entry.node.hostname,
		);
		assert.equal(
			target.spec.template.spec.nodeSelector.type,
			"virtual-kubelet",
		);
		assert.equal(target.spec.template.spec.automountServiceAccountToken, false);
		assert.equal(target.spec.template.spec.containers[0].image, image);
		// No manifest may carry a production label, and probe names stay in the run.
		for (const [file, text] of Object.entries(plan.files)) {
			assert.doesNotMatch(text, /&a\d|\*a\d/u, "no YAML aliases");
			const object = parse(text);
			assert.equal(
				JSON.stringify(object).includes('"agent-infra.agora.io/agent"'),
				false,
				`${file} carries the production owner label`,
			);
			assert.equal(object.metadata.labels[probeLabelKeysV1.run], "abc123");
			assert.match(object.metadata.name, /^np-probe-abc123-n\d-/u);
		}
	}
});

test("the plan refuses unpinned images, unsupported variants and unknown inputs", async () => {
	const rejected = async (plan) =>
		code(() =>
			probePlanV1({
				runId: "abc123",
				namespace,
				config: networkPolicyDeploymentConfig(),
				workerConfigurationSha256: "0".repeat(64),
				renderedManifest: "x",
				nodes: [],
				image,
				...plan,
			}),
		);
	assert.equal(await rejected({ image: "node:24" }), "PROBE_IMAGE_NOT_PINNED");
	assert.equal(await rejected({ runId: "ABC" }), "RUN_ID_INVALID");
	assert.equal(await rejected({ port: 80 }), "PROBE_PORT_INVALID");
	assert.equal(
		await rejected({ pullSecret: "Bad Name" }),
		"PULL_SECRET_INVALID",
	);
	assert.equal(await rejected({ variant: "nope" }), "PROBE_VARIANT_INVALID");
	for (const variant of ["multi-service-entry", "multi-service-migration"])
		assert.equal(await rejected({ variant }), "PROBE_VARIANT_UNSUPPORTED");
	const { directory } = await harness();
	const { renderedManifest } = await workerConfigurationInputs(
		directory,
		workerConfigurationSource(networkPolicyDeploymentConfig()),
	);
	const noNodes = code(() =>
		probePlanV1({
			runId: "abc123",
			namespace,
			config: networkPolicyDeploymentConfig(),
			workerConfigurationSha256: "0".repeat(64),
			renderedManifest,
			nodes: [ecsNode],
			image,
		}),
	);
	assert.equal(noNodes, "NO_CANDIDATE_NODE");
	const noHostname = structuredClone(virtualNode(nodeNames[0], 1));
	delete noHostname.metadata.labels["kubernetes.io/hostname"];
	assert.equal(
		code(() =>
			probePlanV1({
				runId: "abc123",
				namespace,
				config: networkPolicyDeploymentConfig(),
				workerConfigurationSha256: "0".repeat(64),
				renderedManifest,
				nodes: [noHostname],
				workers: [],
				image,
			}),
		),
		"NODE_HOSTNAME_LABEL_MISSING",
	);
});

test("a full run on every node assembles evidence the production gate accepts", async () => {
	const h = await harness();
	for (const index of [0, 1]) await h.runNode(index);
	const result = h.assemble();
	assert.equal(result.gate, "passed");
	assert.equal(result.probes, 2);
	assert.equal(result.candidateNodes, 2);
	const evidence = JSON.parse(
		await readFile(join(h.dir, "evidence.json"), "utf8"),
	);
	assert.equal(evidence.enforcer.version, "unobservable");
	assert.deepEqual(
		evidence.networkPolicy.templateSha256,
		networkPolicyTemplateDigestsV1(h.config),
	);
	// Labels come from the live Pods (the controller adds pod-template-hash).
	assert.equal(
		evidence.probes[0].policy.podLabels.target["pod-template-hash"],
		"abc",
	);
	assert.equal(evidence.probes[0].destination.controller.kind, "Deployment");
	assert.ok(
		Date.parse(evidence.probes[0].allow.at) <
			Date.parse(evidence.probes[0].deny.at),
	);
	assert.notEqual(
		evidence.probes[0].deny.policyUid,
		evidence.probes[0].policy.uid,
	);
	// The evidence carries no probe image, token or pod IP.
	const text = JSON.stringify(evidence);
	assert.doesNotMatch(text, /np-probe-ok|registry\.example/u);
});

test("steps must run in order, once, with the policy state they require", async () => {
	const h = await harness();
	const entry = loadRun(h.dir).nodes[0];
	await h.applyFile(0, "target.deployment.yaml");
	await h.applyFile(0, "source-worker.pod.yaml");
	await h.applyFile(0, "source-other.pod.yaml");
	await h.applyFile(0, "policy-original.yaml");
	assert.equal(await codeAsync(() => h.record(0, "deny")), "STEP_OUT_OF_ORDER");
	await h.record(0, "allow");
	assert.equal(
		await codeAsync(() => h.record(0, "allow")),
		"STEP_OUT_OF_ORDER",
	);
	await h.record(0, "nonWorker");
	// Deny without swapping the policies: the original still admits the Worker source.
	assert.equal(
		await codeAsync(() => h.record(0, "deny")),
		"PROBE_POLICY_STATE_INVALID",
	);
	h.world.kubectl(["delete", "networkpolicy", entry.names.original]);
	await h.applyFile(0, "policy-deny.yaml");
	await h.record(0, "deny");
	// Recovery with the deny-all still in place.
	assert.equal(
		await codeAsync(() => h.record(0, "recovery")),
		"PROBE_POLICY_STATE_INVALID",
	);
});

test("a live policy that differs from the rendered spec stops the step", async () => {
	const h = await harness();
	await h.applyFile(0, "target.deployment.yaml");
	await h.applyFile(0, "source-worker.pod.yaml");
	await h.applyFile(0, "source-other.pod.yaml");
	const policy = await h.applyFile(0, "policy-original.yaml");
	policy.spec.ingress[0].from[0].podSelector.matchLabels = { app: "widened" };
	assert.equal(
		await codeAsync(() => h.record(0, "allow")),
		"PROBE_POLICY_READBACK_MISMATCH",
	);
});

test("deny that never blocks, a leaking non-Worker source and exec failures stop the run", async () => {
	const noEnforcement = await harness({ enforce: false });
	await noEnforcement.applyFile(0, "target.deployment.yaml");
	await noEnforcement.applyFile(0, "source-worker.pod.yaml");
	await noEnforcement.applyFile(0, "source-other.pod.yaml");
	await noEnforcement.applyFile(0, "policy-original.yaml");
	await noEnforcement.record(0, "allow");
	assert.equal(
		await codeAsync(() => noEnforcement.record(0, "nonWorker")),
		"PROBE_NOT_BLOCKED",
	);
	const saved = JSON.parse(
		await readFile(join(noEnforcement.dir, "results", "n0.json"), "utf8"),
	);
	assert.equal(saved.failed.step, "nonWorker");
	assert.equal(saved.steps.nonWorker, undefined);
	assert.equal(
		code(() =>
			buildEvidenceV1({
				run: loadRun(noEnforcement.dir),
				resultsByIndex: new Map([[0, saved]]),
				live: {},
				config: noEnforcement.config,
				clusterId: "c0ffee0000",
			}),
		),
		"RESULTS_INCOMPLETE",
	);

	const broken = await harness();
	broken.world.state.failProbeExec = true;
	await broken.applyFile(0, "target.deployment.yaml");
	await broken.applyFile(0, "source-worker.pod.yaml");
	await broken.applyFile(0, "source-other.pod.yaml");
	await broken.applyFile(0, "policy-original.yaml");
	assert.equal(
		await codeAsync(() => broken.record(0, "allow")),
		"PROBE_EXEC_FAILED",
	);
});

test("a changed or restarted target Pod invalidates the run", async () => {
	const h = await harness();
	await h.applyFile(0, "target.deployment.yaml");
	await h.applyFile(0, "source-worker.pod.yaml");
	await h.applyFile(0, "source-other.pod.yaml");
	await h.applyFile(0, "policy-original.yaml");
	await h.record(0, "allow");
	const pod = [...h.world.objects.values()].find(
		(item) => item.metadata.name === "np-probe-abc123-n0-target-pod",
	);
	pod.status.containerStatuses[0].restartCount = 1;
	assert.equal(
		await codeAsync(() => h.record(0, "nonWorker")),
		"PROBE_TARGET_CHANGED",
	);
});

test("assembly refuses incomplete nodes, a changed node set and changed Worker inputs", async () => {
	const h = await harness();
	await h.runNode(0);
	assert.equal(
		code(() => h.assemble()),
		"RESULTS_INCOMPLETE",
	);
	await h.runNode(1);
	assert.equal(
		code(() =>
			h.assemble({
				inputs: {
					...h.inputs,
					renderedManifest: h.renderedManifest,
					workerConfigurationSha256: "f".repeat(64),
				},
			}),
		),
		"INPUTS_CHANGED_SINCE_RENDER",
	);
	assert.equal(
		code(() => h.assemble({ clusterId: "bad id" })),
		"CLUSTER_ID_INVALID",
	);
	assert.equal(
		code(() => h.assemble({ validForMs: 8 * 24 * 3_600_000 })),
		"VALIDITY_INVALID",
	);
	h.world.nodes.push(virtualNode("virtual-kubelet-cn-hangzhou-k", 3));
	assert.equal(
		code(() => h.assemble()),
		"NODE_SET_CHANGED",
	);
	assert.equal(
		await readdir(h.dir).then((files) => files.includes("evidence.json")),
		false,
		"no evidence file is written when the gate or the build refuses",
	);
});

test("negative evidence is refused by the production gate with the documented code", async () => {
	const h = await harness();
	for (const index of [0, 1]) await h.runNode(index);
	h.assemble();
	const evidence = JSON.parse(
		await readFile(join(h.dir, "evidence.json"), "utf8"),
	);
	const observed = {
		workers: [],
		kubeSystemNamespaceUid: h.world.state.kubeSystemUid,
		namespace: { name: namespace, uid: h.world.state.namespaceUid },
		nodes: h.world.nodes,
		controllers: [],
	};
	const judge = (mutate, now = Date.now()) => {
		const copy = structuredClone(evidence);
		mutate(copy);
		return code(() =>
			validateNetworkPolicyEnforcementV1({
				evidence: copy,
				deploymentConfig: h.config,
				renderedManifest: h.renderedManifest,
				observed,
				now,
			}),
		);
	};
	assert.equal(
		judge(() => {}),
		undefined,
	);
	assert.equal(
		judge((e) => (e.probes[0].recovery = null)),
		"PROBE_POSITIVE_MISSING",
	);
	assert.equal(
		judge((e) => (e.probes[0].deny.outcome = "connected")),
		"ENFORCEMENT_NOT_OBSERVED",
	);
	assert.equal(
		judge((e) => (e.probes[0].nonWorker.outcome = "connected")),
		"NON_WORKER_REACHABLE",
	);
	assert.equal(
		judge((e) => (e.probes[1].deny.outcome = "error")),
		"EVIDENCE_INVALID",
	);
	assert.equal(
		judge((e) => e.probes.pop()),
		"CANDIDATE_NODE_UNPROBED",
	);
	assert.equal(
		judge((e) => (e.probes[0].policy.podLabels.workerSource = { x: "y" })),
		"PROBE_LABELS_INCONSISTENT",
	);
	assert.equal(
		judge(
			(e) =>
				(e.probes[0].policy.podLabels.nonWorkerSource = {
					...e.probes[0].policy.podLabels.workerSource,
				}),
		),
		"PROBE_LABELS_INCONSISTENT",
	);
	assert.equal(
		judge(
			(e) =>
				(e.probes[0].policy.podLabels.workerSource[
					"agent-infra.agora.io/agent"
				] = "a"),
		),
		"PROBE_LABELS_FORBIDDEN",
	);
	assert.equal(
		judge((e) => (e.probes[0].policy.instantiatedSha256 = "0".repeat(64))),
		"PROBE_POLICY_MISMATCH",
	);
	assert.equal(
		judge(
			(e) => (e.networkPolicy.templateSha256["internal-only"] = "0".repeat(64)),
		),
		"NETWORKPOLICY_TEMPLATE_MISMATCH",
	);
	assert.equal(
		judge((e) => (e.probes[0].recovery.at = e.probes[0].allow.at)),
		"PROBE_ORDER_INVALID",
	);
	assert.equal(
		judge(() => {}, Date.now() + 8 * 24 * 3_600_000),
		"EVIDENCE_EXPIRED",
	);
	assert.equal(
		judge((e) => (e.nodes = e.nodes.slice(1))),
		"CANDIDATE_NODE_UNPROVEN",
	);
});

test("cleanup deletes only this run's objects, checks UIDs and reads absence back", async () => {
	const h = await harness();
	await h.runNode(0);
	const stray = h.world.apply({
		apiVersion: "networking.k8s.io/v1",
		kind: "NetworkPolicy",
		metadata: {
			name: "np-probe-abc123-stray",
			labels: { [probeLabelKeysV1.run]: "abc123" },
		},
		spec: { podSelector: {} },
	});
	assert.equal(
		code(() => cleanup({ dir: h.dir, kubectl: h.world.kubectl, namespace })),
		"CLEANUP_UNEXPECTED_OBJECT",
	);
	h.world.kubectl(["delete", "networkpolicy", stray.metadata.name]);
	const before = [...h.world.objects.values()].map((item) => item.metadata.uid);
	const mark = h.world.state.calls.length;
	const receipt = cleanup({ dir: h.dir, kubectl: h.world.kubectl, namespace });
	assert.equal(receipt.status, "cleaned");
	assert.equal(h.world.objects.size, 0);
	assert.deepEqual(receipt.deleted.map((item) => item.kind).sort(), [
		"deployment",
		"networkpolicy",
		"pod",
		"pod",
	]);
	for (const item of receipt.deleted) assert.ok(before.includes(item.uid));
	for (const call of h.world.state.calls
		.slice(mark)
		.filter((c) => c[0] === "delete"))
		assert.match(call[2], /^np-probe-abc123-n0-/u);
});

test("probe output and settling treat only known outcomes as results", async () => {
	assert.equal(
		parseProbeOutput('noise\n{"outcome":"connected"}\n'),
		"connected",
	);
	for (const bad of [
		"",
		"{}",
		'{"outcome":"ok"}',
		'{"outcome":"timeout","x":1}',
	])
		assert.equal(
			code(() => parseProbeOutput(bad)),
			"PROBE_OUTPUT_INVALID",
		);
	const run = (expect, outcomes) => {
		let n = 0;
		let clock = 0;
		return settleProbeV1({
			expect,
			sample: async () => outcomes[Math.min(n++, outcomes.length - 1)],
			sleep: async () => {
				clock += 5;
			},
			now: () => clock,
			intervalMs: 5,
			settleMs: 100,
		});
	};
	// Blocked needs three in a row; a connection in between restarts the count.
	assert.equal(
		(
			await run("blocked", [
				"timeout",
				"connected",
				"timeout",
				"refused",
				"reset",
			])
		).samples.length,
		5,
	);
	// An error is not blocked, so a step that only ever errors never settles as denied.
	assert.equal(
		await codeAsync(() => run("blocked", ["error"])),
		"PROBE_NOT_BLOCKED",
	);
	assert.equal(
		await codeAsync(() => run("connected", ["timeout"])),
		"PROBE_NOT_CONNECTED",
	);
	assert.equal(
		(await run("connected", ["timeout", "connected"])).outcome,
		"connected",
	);
});

test("render writes the plan through the CLI without touching the cluster", async () => {
	const directory = await mkdtemp(join(tmpdir(), "np-probe-cli-"));
	const config = networkPolicyDeploymentConfig();
	const { bootstrapInputsFile, renderedManifest } =
		await workerConfigurationInputs(
			directory,
			workerConfigurationSource(config),
		);
	const renderedFile = join(directory, "rendered.yaml");
	await writeFile(renderedFile, renderedManifest);
	const calls = join(directory, "calls.log");
	const kubectl = join(directory, "kubectl.cjs");
	await writeFile(
		kubectl,
		`#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(JSON.stringify({ items: process.argv.includes("nodes") ? ${JSON.stringify([virtualNode(nodeNames[0], 1), ecsNode])} : [] }));
`,
		{ mode: 0o700 },
	);
	const dir = join(directory, "out");
	const env = {
		...process.env,
		ACK_NAMESPACE: namespace,
		ACK_BOOTSTRAP_INPUTS_FILE: bootstrapInputsFile,
		ACK_RENDERED_MANIFEST_FILE: renderedFile,
		KUBECTL_BIN: kubectl,
		NP_PROBE_IMAGE: image,
	};
	const script = join(
		import.meta.dirname,
		"../deploy/ack/networkpolicy-probe.mjs",
	);
	const result = spawnSync(
		process.execPath,
		[script, "render", "--dir", dir, "--run-id", "abc123"],
		{ encoding: "utf8", env },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).files, 5);
	for (const line of (await readFile(calls, "utf8")).trim().split("\n"))
		assert.equal(JSON.parse(line).includes("get"), true, line);
	assert.equal(loadRun(dir).nodes.length, 1);
	const again = spawnSync(
		process.execPath,
		[script, "render", "--dir", dir, "--run-id", "abc123"],
		{ encoding: "utf8", env },
	);
	assert.equal(again.status, 2);
	assert.equal(JSON.parse(again.stderr).code, "RUN_EXISTS");
	const unpinned = spawnSync(
		process.execPath,
		[script, "render", "--dir", join(directory, "out2"), "--run-id", "abc123"],
		{ encoding: "utf8", env: { ...env, NP_PROBE_IMAGE: "node:24" } },
	);
	assert.equal(JSON.parse(unpinned.stderr).code, "PROBE_IMAGE_NOT_PINNED");
});

// The client runs inside a source Pod. Once the TCP handshake has completed the
// connection was not blocked, so nothing after it may be recorded as blocked.
async function withServer(onConnection, run) {
	const sockets = new Set();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
		onConnection(socket);
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	try {
		return await run(server.address().port);
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise((done) => server.close(done));
	}
}
// For reset fixtures, notify the server only after Node delivers the client's
// connect event. An immediate server-side RST can win that event on Linux.
const signalClientConnect = `{
	const net = require("node:net");
	const connect = net.connect;
	net.connect = (...args) => {
		const socket = connect(...args);
		socket.once("connect", () => socket.write("ready"));
		return socket;
	};
}
`;
async function clientAgainst(behavior, options) {
	const directory = await mkdtemp(join(tmpdir(), "np-client-"));
	const serverFile = join(directory, "server.cjs");
	await writeFile(
		serverFile,
		`const net=require("net");
const behavior=${JSON.stringify(behavior)};
const server=net.createServer((s)=>{
	s.on("error",()=>{});
	if(behavior==="silent")return;
	if(behavior==="reset")return s.once("data",()=>s.resetAndDestroy());
	if(behavior==="partial-then-reset")return s.once("data",()=>{s.write("np-probe-");setTimeout(()=>s.resetAndDestroy(),50);});
	if(behavior==="wrong")return s.end("something else");
	if(behavior==="empty-close")return s.end();
	if(behavior==="token")return s.end("np-probe-ok:t");
});
server.listen(0,"127.0.0.1",()=>process.stdout.write(String(server.address().port)+"\\n"));
`,
	);
	const { spawn } = await import("node:child_process");
	const source =
		behavior === "reset" || behavior === "partial-then-reset"
			? signalClientConnect + clientSource
			: clientSource;
	const child = spawn(process.execPath, [serverFile], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	const port = await new Promise((resolve) =>
		child.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim()))),
	);
	try {
		return await new Promise((resolve) => {
			const client = spawn(
				process.execPath,
				[
					...(options?.preload ? ["-r", options.preload] : []),
					"-e",
					source,
					"127.0.0.1",
					String(options?.port ?? port),
					"np-probe-ok:t",
					String(options?.timeoutMs ?? 400),
				],
				{ stdio: ["ignore", "pipe", "ignore"] },
			);
			let out = "";
			client.stdout.on("data", (chunk) => (out += chunk));
			client.on("close", () => resolve(JSON.parse(out.trim()).outcome));
		});
	} finally {
		child.kill();
	}
}

test("the probe client never records a connection that completed the handshake as blocked", async () => {
	assert.equal(await clientAgainst("token"), "connected");
	// Handshake completed, then nothing, a reset, or the wrong bytes: not blocked.
	assert.equal(await clientAgainst("silent"), "error");
	assert.equal(await clientAgainst("reset"), "error");
	assert.equal(await clientAgainst("partial-then-reset"), "error");
	assert.equal(await clientAgainst("wrong"), "error");
	assert.equal(await clientAgainst("empty-close"), "error");
});

test("the probe client records only pre-handshake failures as blocked", async () => {
	// Nothing listens on the port: the handshake is refused.
	const closed = await withServer(
		() => {},
		async (port) => port,
	);
	assert.equal(await clientAgainst("token", { port: closed }), "refused");
	// A handshake that never completes times out.
	const directory = await mkdtemp(join(tmpdir(), "np-client-stub-"));
	const preload = join(directory, "never-connect.cjs");
	await writeFile(
		preload,
		// A socket whose handshake never completes: no `connect`, only its idle timer.
		`const net=require("net");const { EventEmitter }=require("events");
net.connect=()=>Object.assign(new EventEmitter(),{setTimeout(ms){setTimeout(()=>this.emit("timeout"),ms);}});\n`,
	);
	assert.equal(await clientAgainst("silent", { preload }), "timeout");
});

test("assembly stops when the gate rejects what the builder accepted, and when a live policy was changed", async () => {
	const h = await harness();
	for (const index of [0, 1]) await h.runNode(index);
	const live = (name) =>
		[...h.world.objects.values()].find((item) => item.metadata.name === name);
	// A source whose live labels contain the production Worker selector: the builder
	// reports what it read, only the gate judges it.
	const source = live("np-probe-abc123-n0-src-worker");
	const original = structuredClone(source.metadata.labels);
	Object.assign(source.metadata.labels, workerPodLabels);
	assert.equal(
		code(() => h.assemble()),
		"PROBE_LABELS_FORBIDDEN",
	);
	assert.equal(
		await readdir(h.dir).then((files) => files.includes("evidence.json")),
		false,
	);
	source.metadata.labels = original;
	// The policy that is live at assembly time differs from the rendered one.
	const policy = live("np-probe-abc123-n1-allow");
	const spec = structuredClone(policy.spec);
	policy.spec.ingress[0].ports[0].port = 18081;
	assert.equal(
		code(() => h.assemble()),
		"PROBE_POLICY_READBACK_MISMATCH",
	);
	policy.spec = spec;
	assert.equal(h.assemble().gate, "passed");
});

test("every step records the policy UID that was live; recovery runs under the re-created policy", async () => {
	const h = await harness();
	await h.runNode(0);
	const { steps } = JSON.parse(
		await readFile(join(h.dir, "results", "n0.json"), "utf8"),
	);
	assert.equal(steps.allow.policyUid, steps.nonWorker.policyUid);
	assert.notEqual(steps.deny.policyUid, steps.allow.policyUid);
	assert.notEqual(steps.recovery.policyUid, steps.allow.policyUid);
	assert.notEqual(steps.recovery.policyUid, steps.deny.policyUid);
});

test("every cluster command is bound to the namespace the run was rendered for", async () => {
	const h = await harness();
	await h.runNode(0);
	await h.runNode(1);
	const other = "other-namespace";
	assert.equal(
		code(() =>
			cleanup({ dir: h.dir, kubectl: h.world.kubectl, namespace: other }),
		),
		"RUN_NAMESPACE_MISMATCH",
	);
	assert.equal(
		await codeAsync(() => h.record(0, "allow", { namespace: other })),
		"RUN_NAMESPACE_MISMATCH",
	);
	assert.equal(
		code(() => h.assemble({ namespace: other })),
		"RUN_NAMESPACE_MISMATCH",
	);
	assert.equal(h.world.objects.size > 0, true, "nothing was deleted");
	// run.json decides what cleanup may delete, so its names are re-validated.
	const run = loadRun(h.dir);
	run.nodes[0].names.target = "np-probe-other-n0-target";
	await writeFile(join(h.dir, "run.json"), JSON.stringify(run));
	assert.equal(
		code(() => cleanup({ dir: h.dir, kubectl: h.world.kubectl, namespace })),
		"RUN_FILE_INVALID",
	);
	run.nodes[0].names.target = "kube-system";
	await writeFile(join(h.dir, "run.json"), JSON.stringify(run));
	assert.equal(
		code(() => cleanup({ dir: h.dir, kubectl: h.world.kubectl, namespace })),
		"RUN_FILE_INVALID",
	);
});

test("cleanup stops when an object was replaced between listing and deletion", async () => {
	const h = await harness();
	await h.runNode(0);
	let swapped = false;
	const kubectl = (args) => {
		// The first single-object read after the listing sees a different UID.
		if (!swapped && args[0] === "get" && args[2]?.startsWith("np-probe-")) {
			swapped = true;
			const object = JSON.parse(h.world.kubectl(args));
			object.metadata.uid = "99999999-0000-4000-8000-000000000000";
			return JSON.stringify(object);
		}
		return h.world.kubectl(args);
	};
	const mark = h.world.state.calls.length;
	assert.equal(
		code(() => cleanup({ dir: h.dir, kubectl, namespace })),
		"CLEANUP_UID_CHANGED",
	);
	assert.equal(
		h.world.state.calls.slice(mark).filter((call) => call[0] === "delete")
			.length,
		0,
	);
	// A re-run after the cause is gone completes.
	assert.equal(
		cleanup({ dir: h.dir, kubectl: h.world.kubectl, namespace }).status,
		"cleaned",
	);
});

test("an ACS-only business release also qualifies ECI when the Pi maintenance terminal is enabled", async () => {
	const renderedManifest = renderedEnforcementManifest(
		namespace,
		{
			architecture: "amd64",
			legacyUnplaced: "retain-until-lifecycle",
			compute: "acs",
		},
		"amd64",
		[{ name: "PLATFORM_MAINTENANCE_CONSUMER_IMAGE", value: image }],
		"acs",
	);
	const h = await harness({ plan: { renderedManifest } });
	assert.equal(h.plan.run.nodes.length, nodeNames.length * 2);
	for (const node of h.plan.run.nodes) await h.runNode(node.index);
	assert.equal(h.assemble().gate, "passed");
	const evidence = JSON.parse(await readFile(join(h.dir, "evidence.json")));
	evidence.probes = evidence.probes.filter(
		(p) => p.destination.compute === "acs",
	);
	assert.equal(
		code(() =>
			validateNetworkPolicyEnforcementV1({
				evidence,
				deploymentConfig: h.config,
				renderedManifest,
				observed: {
					kubeSystemNamespaceUid: h.world.state.kubeSystemUid,
					namespace: { name: namespace, uid: h.world.state.namespaceUid },
					nodes: h.world.nodes,
					controllers: [],
					workers: [],
				},
			}),
		),
		"CANDIDATE_NODE_UNPROBED",
	);
});

test("a mixed release records both backends per node and rejects changed placement or compute", async () => {
	const h = await harness({
		plan: {
			renderedManifest: renderedEnforcementManifest(namespace, {
				architecture: "amd64",
				legacyUnplaced: "reject",
				compute: "acs",
			}),
		},
	});
	assert.equal(h.plan.run.nodes.length, nodeNames.length * 2);
	for (const name of nodeNames)
		assert.deepEqual(
			h.plan.run.nodes
				.filter((entry) => entry.node.name === name)
				.map((entry) => entry.compute)
				.sort(),
			["acs", "eci"],
		);
	for (const entry of h.plan.run.nodes) {
		const pod = parse(
			h.plan.files[`manifests/n${entry.index}/target.deployment.yaml`],
		).spec.template;
		assert.equal(
			pod.metadata.labels["alibabacloud.com/acs"],
			entry.compute === "acs" ? "true" : undefined,
		);
		if (entry.compute === "acs") {
			assert.equal(pod.spec.nodeSelector["kubernetes.io/hostname"], undefined);
			assert.equal(pod.spec.nodeName, entry.node.name);
			assert.equal(
				pod.metadata.annotations[
					"network.alibabacloud.com/enable-network-policy-agent"
				],
				"true",
			);
		}
	}
	for (const entry of h.plan.run.nodes) await h.runNode(entry.index);
	assert.equal(h.assemble().gate, "passed");
	for (const compute of ["eci", "acs"]) {
		const probe = h.plan.run.nodes.find((node) => node.compute === compute);
		const annotations = h.world.objects.get(`pod/${probe.names.target}-pod`)
			.metadata.annotations;
		const [key, conflicting] =
			compute === "acs"
				? ["k8s.aliyun.com/eci-instance-id", "eci-conflict"]
				: ["alibabacloud.com/instance-id", "acs-conflict"];
		const original = annotations[key];
		annotations[key] = conflicting;
		assert.equal(
			code(() => h.assemble()),
			"PROBE_COMPUTE_MISMATCH",
		);
		if (original === undefined) delete annotations[key];
		else annotations[key] = original;
	}
	const eci = h.plan.run.nodes.find((node) => node.compute === "eci");
	const eciLabels = h.world.objects.get(`pod/${eci.names.target}-pod`).metadata
		.labels;
	eciLabels["alibabacloud.com/acs"] = "true";
	assert.equal(
		code(() => h.assemble()),
		"PROBE_COMPUTE_MISMATCH",
	);
	delete eciLabels["alibabacloud.com/acs"];
	const entry = h.plan.run.nodes.find((node) => node.compute === "acs");
	const target = h.world.objects.get(`pod/${entry.names.target}-pod`);
	target.spec.nodeName = "unexpected-node";
	assert.equal(
		code(() => h.assemble()),
		"PROBE_TARGET_CHANGED",
	);
	target.spec.nodeName = entry.node.name;
	target.metadata.annotations["alibabacloud.com/instance-id"] = "eci-wrong";
	assert.equal(
		code(() => h.assemble()),
		"PROBE_COMPUTE_MISMATCH",
	);
});

test("an ACS pair also probes adopted ECI controllers before allowing their retention", async () => {
	const h = await harness({
		plan: {
			renderedManifest: renderedEnforcementManifest(
				namespace,
				{ architecture: "amd64", legacyUnplaced: "reject", compute: "acs" },
				"amd64",
				[],
				"acs",
			),
			controllers: [
				{
					metadata: {
						annotations: {
							"agent-infra.agora.io/agent-workload-placement": "amd64",
						},
					},
				},
			],
		},
	});
	assert.equal(h.plan.run.nodes.length, nodeNames.length * 2);
});

test("a rolling ACS deployment covers the last ECI writer on each candidate node", async () => {
	const renderedManifest = renderedEnforcementManifest(
		namespace,
		{ architecture: "amd64", legacyUnplaced: "reject", compute: "acs" },
		"amd64",
		[],
		"acs",
	);
	const oldPodSpec = {
		containers: [
			{
				name: "platform-worker",
				env: [
					{
						name: "AGENT_INFRA_AGENT_WORKLOAD_PLACEMENT",
						value: JSON.stringify({
							architecture: "amd64",
							legacyUnplaced: "reject",
						}),
					},
				],
			},
		],
	};
	const old = {
		kind: "ReplicaSet",
		spec: { replicas: 0, template: { spec: oldPodSpec } },
		status: { replicas: 1 },
	};
	const h = await harness({ plan: { renderedManifest, workers: [old] } });
	assert.deepEqual(
		[...new Set(h.plan.run.nodes.map((node) => node.compute))].sort(),
		["acs", "eci"],
	);
	for (const node of h.plan.run.nodes) await h.runNode(node.index);
	assert.equal(h.assemble().gate, "passed");
	const evidence = JSON.parse(await readFile(join(h.dir, "evidence.json")));
	const observed = {
		kubeSystemNamespaceUid: h.world.state.kubeSystemUid,
		namespace: { name: namespace, uid: h.world.state.namespaceUid },
		nodes: h.world.nodes,
		controllers: [],
		workers: [old],
	};
	const verify = (input, current = observed) =>
		validateNetworkPolicyEnforcementV1({
			evidence: input,
			deploymentConfig: h.config,
			renderedManifest,
			observed: current,
		});
	assert.equal(verify(evidence).status, "passed");
	evidence.probes = evidence.probes.filter(
		(p) => p.destination.compute === "acs",
	);
	assert.equal(
		code(() => verify(evidence)),
		"CANDIDATE_NODE_UNPROBED",
	);
	assert.equal(
		verify(evidence, {
			...observed,
			workers: [{ ...old, status: { replicas: 0 } }],
		}).status,
		"passed",
	);
	assert.equal(
		code(() => verify(evidence, { ...observed, workers: undefined })),
		"ACS_WORKER_OBSERVATION_REQUIRED",
	);
	const pending = {
		kind: "Pod",
		spec: oldPodSpec,
		status: { phase: "Pending" },
	};
	assert.equal(
		code(() => verify(evidence, { ...observed, workers: [pending] })),
		"CANDIDATE_NODE_UNPROBED",
	);
	assert.equal(
		verify(evidence, {
			...observed,
			workers: [{ ...pending, status: { phase: "Succeeded" } }],
		}).status,
		"passed",
	);
	const unknown = {
		kind: "Pod",
		spec: {
			containers: [
				{
					name: "platform-worker",
					envFrom: [{ secretRef: { name: "synthetic" } }],
				},
			],
		},
	};
	assert.equal(
		code(() => verify(evidence, { ...observed, workers: [unknown] })),
		"ACS_WORKER_PLACEMENT_UNPROVEN",
	);
});

test("returning to ECI covers a still-active ACS Worker until its Pod drains", async () => {
	const old = {
		kind: "Pod",
		status: { phase: "Running" },
		spec: {
			containers: [
				{
					name: "platform-worker",
					env: [
						{
							name: "AGENT_INFRA_AGENT_WORKLOAD_PLACEMENT",
							value: JSON.stringify({
								architecture: "amd64",
								compute: "acs",
								legacyUnplaced: "reject",
							}),
						},
					],
				},
			],
		},
	};
	const h = await harness({ plan: { workers: [old] } });
	assert.deepEqual(
		[...new Set(h.plan.run.nodes.map(({ compute }) => compute))].sort(),
		["acs", "eci"],
	);
	for (const node of h.plan.run.nodes) await h.runNode(node.index);
	assert.equal(h.assemble().gate, "passed");
});
