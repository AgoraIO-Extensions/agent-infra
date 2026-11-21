import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	assertSessionEciAdmissionRenderedV1,
	eciPlacementFieldsV1,
	maxEvidenceAgeMs,
	validateNetworkPolicyEnforcementV1,
} from "../deploy/ack/networkpolicy-enforcement.mjs";

// #4351 / prep §4.6: every incomplete or mismatched input fails closed.
const now = Date.parse("2026-11-21T18:00:00.000Z");
const at = (minutes) => new Date(now - minutes * 60_000).toISOString();
const uid = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const placement = eciPlacementFieldsV1("amd64");
const providerTaint = {
	key: "virtual-kubelet.io/provider",
	value: "alibabacloud",
	effect: "NoSchedule",
};
const virtualNode = (zone, n) => ({
	metadata: {
		name: `virtual-kubelet-cn-hangzhou-${zone}`,
		uid: uid(n),
		labels: { type: "virtual-kubelet", "kubernetes.io/arch": "amd64" },
	},
	spec: { taints: [providerTaint] },
});
const ecsNode = {
	metadata: {
		name: "cn-hangzhou.10.0.0.12",
		uid: uid(90),
		labels: { "kubernetes.io/arch": "amd64" },
	},
	spec: {},
};
const controller = (kind, name, n, spec, extra = {}) => ({
	kind,
	metadata: {
		name,
		uid: uid(n),
		labels: { "agent-infra.agora.io/agent": name },
	},
	spec: {
		replicas: 1,
		template: { spec: { containers: [{ name: "agent" }], ...spec } },
	},
	...extra,
});
const config = (change = {}) => ({
	schemaVersion: 1,
	kind: "ack-poseidon-config-readback",
	clusterId: "c0ffee0000",
	component: "poseidon",
	version: "v0.8.0",
	eciNetworkPolicyEnabled: true,
	readAt: at(30),
	...change,
});
const bytes = (value) => Buffer.from(JSON.stringify(value));
const sha = (value) => createHash("sha256").update(value).digest("hex");

function fixture() {
	const enforcerConfigBytes = bytes(config());
	const probe = {
		destination: {
			pod: "agent-p-0",
			uid: uid(40),
			nodeName: "virtual-kubelet-cn-hangzhou-i",
			port: 3003,
		},
		policyUid: uid(50),
		allow: { at: at(25), outcome: "connected" },
		deny: { at: at(24), outcome: "timeout", policyUid: uid(51) },
		recovery: { at: at(23), outcome: "connected" },
		nonWorker: { at: at(22), outcome: "timeout" },
	};
	const controllers = [
		controller("StatefulSet", "agent-p", 10, placement),
		controller("Deployment", "agent-m-api", 11, placement),
		controller("Deployment", "agent-m-web", 12, placement),
		controller("Job", "agent-m-migration-a", 13, placement, {
			status: { succeeded: 1 },
		}),
	];
	return {
		evidence: {
			schemaVersion: 1,
			kind: "agent-infra-networkpolicy-enforcement-evidence",
			cluster: { kubeSystemNamespaceUid: uid(1), clusterId: "c0ffee0000" },
			namespace: { name: "agent-infra", uid: uid(2) },
			enforcer: {
				runtime: "eci",
				component: "poseidon",
				version: "v0.8.0",
				configSha256: sha(enforcerConfigBytes),
			},
			placement: { architecture: "amd64", legacyUnplaced: "reject" },
			nodes: [
				{ name: "virtual-kubelet-cn-hangzhou-i", uid: uid(20) },
				{ name: "virtual-kubelet-cn-hangzhou-j", uid: uid(21) },
			],
			targets: controllers.map((item) => ({
				kind: item.kind,
				name: item.metadata.name,
				uid: item.metadata.uid,
			})),
			probes: [probe],
			observedAt: at(20),
			expiresAt: new Date(now + 24 * 60 * 60_000).toISOString(),
		},
		enforcerConfigBytes,
		observed: {
			namespace: { name: "agent-infra", uid: uid(2) },
			kubeSystemNamespaceUid: uid(1),
			nodes: [virtualNode("i", 20), virtualNode("j", 21), ecsNode],
			controllers,
		},
		now,
	};
}
const run = (input) => validateNetworkPolicyEnforcementV1(input);
const rejects = (input, code) =>
	assert.throws(
		() => run(input),
		(error) => error.code === code,
	);

test("complete current evidence passes without signing field acceptance", () => {
	const summary = run(fixture());
	assert.equal(summary.status, "passed");
	assert.equal(summary.candidateNodes, 2);
	assert.equal(summary.placedTargets, 4);
	assert.equal(summary.allAgentWorkloadsOnEnforcedForm, true);
	assert.equal(summary.fieldAcceptanceSigned, false);
	assert(!JSON.stringify(summary).includes(uid(2)));
});

test("retained pre-placement Hosts pass only in the transition mode and stay unisolated", () => {
	const f = fixture();
	f.evidence.placement.legacyUnplaced = "retain-until-lifecycle";
	f.observed.controllers[0] = controller("StatefulSet", "agent-p", 10, {});
	const summary = run(f);
	assert.equal(summary.legacyUnplacedActiveTargets, 1);
	assert.equal(summary.allAgentWorkloadsOnEnforcedForm, false);
	f.evidence.placement.legacyUnplaced = "reject";
	rejects(f, "LEGACY_UNPLACED_REMAINS");
	// A finished legacy Job has no running Pod.
	const g = fixture();
	g.observed.controllers[3] = controller(
		"Job",
		"agent-m-migration-a",
		13,
		{},
		{
			status: { succeeded: 1 },
		},
	);
	assert.equal(run(g).legacyUnplacedActiveTargets, 0);
	g.observed.controllers[3].status = {};
	rejects(g, "LEGACY_UNPLACED_REMAINS");
});

const cases = [
	["no enforcer", (f) => delete f.evidence.enforcer, "EVIDENCE_INVALID"],
	[
		"flannel on ECS",
		(f) =>
			Object.assign(f.evidence.enforcer, {
				runtime: "ecs",
				component: "flannel",
			}),
		"ENFORCER_UNSUPPORTED",
	],
	[
		"Terway claimed for ECI",
		(f) => Object.assign(f.evidence.enforcer, { component: "terway" }),
		"ENFORCER_UNSUPPORTED",
	],
	[
		"ECI NetworkPolicy switch off",
		(f) => {
			f.enforcerConfigBytes = bytes(config({ eciNetworkPolicyEnabled: false }));
			f.evidence.enforcer.configSha256 = sha(f.enforcerConfigBytes);
		},
		"ENFORCER_DISABLED",
	],
	[
		"unreadable ECI config",
		(f) => delete f.enforcerConfigBytes,
		"ENFORCER_CONFIG_UNREADABLE",
	],
	[
		"config bytes changed",
		(f) => {
			f.enforcerConfigBytes = bytes(config({ version: "v0.8.1" }));
		},
		"ENFORCER_CONFIG_UNREADABLE",
	],
	[
		"malformed config",
		(f) => {
			f.enforcerConfigBytes = Buffer.from("{");
			f.evidence.enforcer.configSha256 = sha(f.enforcerConfigBytes);
		},
		"ENFORCER_CONFIG_UNREADABLE",
	],
	[
		"config from another cluster",
		(f) => {
			f.enforcerConfigBytes = bytes(config({ clusterId: "other" }));
			f.evidence.enforcer.configSha256 = sha(f.enforcerConfigBytes);
		},
		"ENFORCER_CONFIG_MISMATCH",
	],
	[
		"wrong cluster",
		(f) => {
			f.observed.kubeSystemNamespaceUid = uid(3);
		},
		"EVIDENCE_SCOPE_MISMATCH",
	],
	[
		"old namespace name",
		(f) => {
			f.observed.namespace.name = "agent-infra-m2-1102";
		},
		"EVIDENCE_SCOPE_MISMATCH",
	],
	[
		"recreated namespace",
		(f) => {
			f.observed.namespace.uid = uid(4);
		},
		"EVIDENCE_SCOPE_MISMATCH",
	],
	[
		"old node UID",
		(f) => {
			f.observed.nodes[0].metadata.uid = uid(29);
		},
		"CANDIDATE_NODE_DRIFT",
	],
	[
		"proven node gone",
		(f) => {
			f.observed.nodes.splice(1, 1);
		},
		"CANDIDATE_NODE_DRIFT",
	],
	[
		"mixed candidate node without provider taint",
		(f) => {
			f.observed.nodes.push({
				...ecsNode,
				metadata: {
					...ecsNode.metadata,
					labels: { type: "virtual-kubelet", "kubernetes.io/arch": "amd64" },
				},
			});
		},
		"CANDIDATE_NODE_UNPROVEN",
	],
	[
		"proven node lost provider taint",
		(f) => {
			f.observed.nodes[0].spec.taints = [];
		},
		"CANDIDATE_NODE_UNPROVEN",
	],
	[
		"new unproven virtual node",
		(f) => {
			f.observed.nodes.push(virtualNode("h", 22));
		},
		"CANDIDATE_NODE_UNPROVEN",
	],
	[
		"no candidate node",
		(f) => {
			f.observed.nodes = [ecsNode];
		},
		"NO_CANDIDATE_NODE",
	],
	[
		"expired",
		(f) => {
			f.now = Date.parse(f.evidence.expiresAt);
		},
		"EVIDENCE_EXPIRED",
	],
	[
		"stale observation",
		(f) => {
			f.evidence.observedAt = new Date(
				now - maxEvidenceAgeMs - 1,
			).toISOString();
		},
		"EVIDENCE_EXPIRED",
	],
	[
		"stale config readback",
		(f) => {
			f.enforcerConfigBytes = bytes(
				config({ readAt: new Date(now - maxEvidenceAgeMs - 1).toISOString() }),
			);
			f.evidence.enforcer.configSha256 = sha(f.enforcerConfigBytes);
		},
		"EVIDENCE_EXPIRED",
	],
	[
		"no probes",
		(f) => {
			f.evidence.probes = [];
		},
		"PROBE_POSITIVE_MISSING",
	],
	[
		"missing positive allow",
		(f) => {
			f.evidence.probes[0].allow = null;
		},
		"PROBE_POSITIVE_MISSING",
	],
	[
		"recovery not restored",
		(f) => {
			f.evidence.probes[0].recovery.outcome = "timeout";
		},
		"PROBE_POSITIVE_MISSING",
	],
	[
		"timeout only",
		(f) => {
			Object.assign(f.evidence.probes[0], { allow: null, recovery: null });
		},
		"PROBE_POSITIVE_MISSING",
	],
	[
		"deny still connected",
		(f) => {
			f.evidence.probes[0].deny.outcome = "connected";
		},
		"ENFORCEMENT_NOT_OBSERVED",
	],
	[
		"non-Worker reachable",
		(f) => {
			f.evidence.probes[0].nonWorker.outcome = "connected";
		},
		"NON_WORKER_REACHABLE",
	],
	[
		"non-Worker negative missing",
		(f) => {
			f.evidence.probes[0].nonWorker = null;
		},
		"PROBE_NEGATIVE_MISSING",
	],
	[
		"probe on ECS node",
		(f) => {
			f.evidence.probes[0].destination.nodeName = ecsNode.metadata.name;
		},
		"PROBE_SCOPE_MISMATCH",
	],
	[
		"deny before allow",
		(f) => {
			f.evidence.probes[0].deny.at = at(26);
		},
		"PROBE_ORDER_INVALID",
	],
	[
		"one service missing",
		(f) => {
			f.evidence.targets.splice(1, 1);
		},
		"TARGET_SET_MISMATCH",
	],
	[
		"migration Job missing",
		(f) => {
			f.evidence.targets.splice(3, 1);
		},
		"TARGET_SET_MISMATCH",
	],
	[
		"recreated controller",
		(f) => {
			f.observed.controllers[0].metadata.uid = uid(19);
		},
		"TARGET_SET_MISMATCH",
	],
	[
		"Owner selector on a member",
		(f) => {
			f.observed.controllers[1].spec.template.spec.nodeSelector = {
				...placement.nodeSelector,
				pool: "owner",
			};
		},
		"FOREIGN_PLACEMENT",
	],
	[
		"affinity on a member",
		(f) => {
			f.observed.controllers[2].spec.template.spec.affinity = {
				nodeAffinity: {},
			};
		},
		"FOREIGN_PLACEMENT",
	],
	[
		"runtimeClass on the Job",
		(f) => {
			f.observed.controllers[3].spec.template.spec.runtimeClassName = "runc";
		},
		"FOREIGN_PLACEMENT",
	],
	[
		"unknown evidence field",
		(f) => {
			f.evidence.note = "x";
		},
		"EVIDENCE_INVALID",
	],
];
for (const [name, mutate, code] of cases)
	test(`fails closed on ${name}`, () => {
		const f = fixture();
		mutate(f);
		rejects(f, code);
	});

test("requires the rendered Session ECI admission rather than a RuntimeClass branch", () => {
	const eci = [
		"kind: MutatingAdmissionPolicy",
		"metadata:",
		"  name: agent-infra-session-eci",
		'expression: JSONPatch{op:"add",path:"/spec/nodeSelector/type",value:"virtual-kubelet"}',
		"---",
		"kind: MutatingAdmissionPolicyBinding",
	].join("\n");
	assertSessionEciAdmissionRenderedV1(eci, "agent-infra");
	for (const rendered of [
		"kind: Deployment\n",
		eci.replace("agent-infra-session-eci", "other-session-eci"),
		eci.replace("kind: MutatingAdmissionPolicyBinding", ""),
		`${eci}\nJSONPatch{op:"add",path:"/spec/runtimeClassName",value:"runv"}`,
	])
		assert.throws(
			() => assertSessionEciAdmissionRenderedV1(rendered, "agent-infra"),
			(error) => error.code === "SESSION_PLACEMENT_UNPROVEN",
		);
});

test("the entry reads only with get and fails closed on missing input or read failure", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ack-np-enforcement-"));
	const f = fixture();
	// The CLI uses the real clock; keep the evidence current relative to it.
	const shift = Date.now() - now;
	const move = (value) => new Date(Date.parse(value) + shift).toISOString();
	f.evidence.observedAt = move(f.evidence.observedAt);
	f.evidence.expiresAt = move(f.evidence.expiresAt);
	for (const probe of f.evidence.probes)
		for (const step of ["allow", "deny", "recovery", "nonWorker"])
			probe[step].at = move(probe[step].at);
	const configBytes = bytes(config({ readAt: move(config().readAt) }));
	f.evidence.enforcer.configSha256 = sha(configBytes);
	const evidenceFile = join(directory, "evidence.json");
	const configFile = join(directory, "config.json");
	const calls = join(directory, "calls.log");
	await writeFile(evidenceFile, JSON.stringify(f.evidence));
	await writeFile(configFile, configBytes);
	const responses = {
		"namespace/agent-infra": { metadata: { name: "agent-infra", uid: uid(2) } },
		"namespace/kube-system": { metadata: { name: "kube-system", uid: uid(1) } },
		"nodes/-o": { items: f.observed.nodes },
		"statefulsets,deployments,jobs/-l": { items: f.observed.controllers },
	};
	const stub = (failing) => {
		const file = join(directory, failing ? "kubectl-fail" : "kubectl");
		return writeFile(
			file,
			`#!/usr/bin/env node
const fs=require("node:fs"),args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+"\\n");
const i=args.indexOf("get");const data=${JSON.stringify(responses)}[args[i+1]+"/"+args[i+2]];
if(${failing ? "args[i+1]==='nodes'" : "false"}){process.stderr.write("forbidden");process.exit(1);}
if(i>=0&&data){process.stdout.write(JSON.stringify(data));process.exit(0);}
process.exit(1);
`,
			{ mode: 0o700 },
		).then(() => file);
	};
	const script = join(
		import.meta.dirname,
		"../deploy/ack/networkpolicy-enforcement.mjs",
	);
	const env = {
		...process.env,
		ACK_NAMESPACE: "agent-infra",
		KUBECTL_BIN: await stub(false),
		ACK_NETWORKPOLICY_EVIDENCE_FILE: evidenceFile,
		ACK_NETWORKPOLICY_ENFORCER_CONFIG_FILE: configFile,
	};
	const passed = spawnSync(process.execPath, [script], {
		encoding: "utf8",
		env,
	});
	assert.equal(passed.status, 0, passed.stderr);
	assert.equal(JSON.parse(passed.stdout).status, "passed");
	const code = (result) => JSON.parse(result.stderr.trim()).code;
	const missing = spawnSync(process.execPath, [script], {
		encoding: "utf8",
		env: { ...env, ACK_NETWORKPOLICY_EVIDENCE_FILE: "" },
	});
	assert.equal(missing.status, 2);
	assert.equal(code(missing), "EVIDENCE_REQUIRED");
	const noConfig = spawnSync(process.execPath, [script], {
		encoding: "utf8",
		env: {
			...env,
			ACK_NETWORKPOLICY_ENFORCER_CONFIG_FILE: join(directory, "absent"),
		},
	});
	assert.equal(noConfig.status, 2);
	assert.equal(code(noConfig), "ENFORCER_CONFIG_UNREADABLE");
	const forbidden = spawnSync(process.execPath, [script], {
		encoding: "utf8",
		env: { ...env, KUBECTL_BIN: await stub(true) },
	});
	assert.equal(forbidden.status, 2);
	assert.equal(code(forbidden), "READ_FAILED");
	assert(!forbidden.stderr.includes("forbidden"));
	for (const args of (await readFile(calls, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))) {
		assert(args.includes("get"));
		assert(
			!args.some((word) =>
				["create", "apply", "patch", "delete", "exec", "run"].includes(word),
			),
		);
	}
});
