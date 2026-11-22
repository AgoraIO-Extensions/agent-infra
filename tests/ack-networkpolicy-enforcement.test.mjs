import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseAllDocuments, stringify } from "yaml";
import {
	assertSessionEciAdmissionRenderedV1,
	eciPlacementFieldsV1,
	labelsSatisfySelectorV1,
	maxEvidenceAgeMs,
	networkPolicySpecSha256V1,
	placementSelectorSha256V1,
	validateNetworkPolicyEnforcementV1,
} from "../deploy/ack/networkpolicy-enforcement.mjs";
import {
	networkPolicySpecV1,
	networkPolicyTemplateDigestsV1,
} from "../packages/platform-core/src/workload-network-policy.ts";
import {
	networkPolicyDeploymentConfig,
	probeAgentKey,
	probePolicyEvidence,
	renderedEnforcementManifest,
	workerPodLabels,
} from "./support/networkpolicy-evidence.mjs";

// #4351 / #4383: every incomplete or mismatched input fails closed.
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
const record = "agent-infra.agora.io/agent-workload-placement";
const controller = (kind, name, n, spec, extra = {}) => ({
	kind,
	metadata: {
		name,
		uid: uid(n),
		labels: { "agent-infra.agora.io/agent": name },
		// The Worker records the placement it injected on each controller.
		...(spec === placement ? { annotations: { [record]: "amd64" } } : {}),
	},
	spec: {
		replicas: 1,
		template: { spec: { containers: [{ name: "agent" }], ...spec } },
	},
	...extra,
});
const render = (
	placementValue = { architecture: "amd64", legacyUnplaced: "reject" },
) => renderedEnforcementManifest("agent-infra", placementValue);

/** Recompute everything the evidence producer derives from the deployment configuration. */
function resign(f) {
	f.evidence.networkPolicy.templateSha256 = networkPolicyTemplateDigestsV1(
		f.deploymentConfig,
	);
	for (const probe of f.evidence.probes)
		probe.policy.instantiatedSha256 = networkPolicySpecSha256V1(
			networkPolicySpecV1({
				variant: probe.policy.variant,
				config: f.deploymentConfig,
				substitutions: probe.policy.substitutions,
			}),
		);
}

function fixture() {
	const deploymentConfig = networkPolicyDeploymentConfig();
	const probe = {
		destination: {
			pod: "agent-p-0",
			uid: uid(40),
			nodeName: "virtual-kubelet-cn-hangzhou-i",
			port: 3003,
			controller: { kind: "StatefulSet", name: "agent-p", uid: uid(10) },
		},
		policy: {
			name: "agent-p",
			uid: uid(50),
			...probePolicyEvidence(deploymentConfig, "self-managed", 3003),
		},
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
		controller("StatefulSet", "agent-p2", 14, placement),
	];
	return {
		deploymentConfig,
		evidence: {
			schemaVersion: 1,
			kind: "agent-infra-networkpolicy-enforcement-evidence",
			cluster: { kubeSystemNamespaceUid: uid(1), clusterId: "c0ffee0000" },
			namespace: { name: "agent-infra", uid: uid(2) },
			enforcer: {
				runtime: "eci",
				component: "poseidon",
				version: "unobservable",
			},
			placement: {
				architecture: "amd64",
				legacyUnplaced: "reject",
				selectorSha256: placementSelectorSha256V1("amd64"),
			},
			nodes: [
				{ name: "virtual-kubelet-cn-hangzhou-i", uid: uid(20) },
				{ name: "virtual-kubelet-cn-hangzhou-j", uid: uid(21) },
			],
			networkPolicy: {
				templateSha256: networkPolicyTemplateDigestsV1(deploymentConfig),
			},
			// One allow→deny→recovery result per candidate node (i and j).
			probes: [
				probe,
				{
					...structuredClone(probe),
					destination: {
						...probe.destination,
						pod: "agent-p2-0",
						uid: uid(42),
						nodeName: "virtual-kubelet-cn-hangzhou-j",
						controller: { kind: "StatefulSet", name: "agent-p2", uid: uid(14) },
					},
					policy: {
						name: "agent-p2",
						uid: uid(54),
						...probePolicyEvidence(deploymentConfig, "multi-service-entry"),
					},
				},
			],
			observedAt: at(20),
			expiresAt: new Date(now + 24 * 60 * 60_000).toISOString(),
		},
		renderedManifest: render(),
		observed: {
			namespace: { name: "agent-infra", uid: uid(2) },
			kubeSystemNamespaceUid: uid(1),
			nodes: [virtualNode("i", 20), virtualNode("j", 21), ecsNode],
			controllers,
		},
		now,
	};
}
const run = (input) =>
	validateNetworkPolicyEnforcementV1({
		...input,
		deploymentConfig: input.deploymentConfig,
	});
const rejects = (input, code) =>
	assert.throws(
		() => run(input),
		(error) => error.code === code,
	);

test("complete current evidence passes without signing field acceptance", () => {
	const summary = run(fixture());
	assert.equal(summary.status, "passed");
	assert.equal(summary.candidateNodes, 2);
	assert.equal(summary.placedTargets, 5);
	assert.equal(summary.probes, 2);
	assert.equal(summary.allAgentWorkloadsOnEnforcedForm, true);
	assert.equal(summary.fieldAcceptanceSigned, false);
	assert(!JSON.stringify(summary).includes(uid(2)));
	assert.deepEqual(Object.keys(summary.networkPolicyTemplates).sort(), [
		"internal-only",
		"multi-service-entry",
		"multi-service-migration",
		"multi-service-service",
		"platform-auth",
		"self-managed",
	]);
});

test("the Poseidon configuration readback and the full controller list are no longer required", () => {
	const f = fixture();
	// An Agent accepted after the probes is not in the evidence and may exist.
	f.observed.controllers.push(
		controller("StatefulSet", "agent-new", 15, placement),
	);
	assert.equal(run(f).status, "passed");
	// The probe Pods and original policies are not read, so nothing about them is observed.
	assert.equal(f.observed.probeTargets, undefined);
});

test("retained pre-placement Hosts pass only in the transition mode and stay unisolated", () => {
	const f = fixture();
	const retain = {
		architecture: "amd64",
		legacyUnplaced: "retain-until-lifecycle",
	};
	f.evidence.placement.legacyUnplaced = "retain-until-lifecycle";
	f.renderedManifest = render(retain);
	f.observed.controllers[0] = controller("StatefulSet", "agent-p", 10, {});
	const summary = run(f);
	assert.equal(summary.legacyUnplacedActiveTargets, 1);
	assert.equal(summary.allAgentWorkloadsOnEnforcedForm, false);
	f.evidence.placement.legacyUnplaced = "reject";
	f.renderedManifest = render();
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

/** Rendered Worker manifest with a changed Deployment selector or extra Service. */
const withWorker = (change) => {
	const documents = parseAllDocuments(render()).map((document) =>
		document.toJS(),
	);
	change(documents);
	return documents.map((document) => stringify(document)).join("---\n");
};
const setLabels = (f, labels) => {
	f.evidence.probes[0].policy.podLabels.target = {
		...f.evidence.probes[0].policy.podLabels.target,
		...labels,
	};
};
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
		"a claimed Poseidon version",
		(f) => {
			f.evidence.enforcer.version = "v0.8.0";
		},
		"EVIDENCE_INVALID",
	],
	[
		"a leftover configuration digest",
		(f) => {
			f.evidence.enforcer.configSha256 = "a".repeat(64);
		},
		"EVIDENCE_INVALID",
	],
	[
		"the retired targets list",
		(f) => {
			f.evidence.targets = [];
		},
		"EVIDENCE_INVALID",
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
	// Every candidate node needs its own execution result.
	[
		"candidate j without its own probe",
		(f) => {
			f.evidence.probes.splice(1, 1);
		},
		"CANDIDATE_NODE_UNPROBED",
	],
	// Session Sandboxes must land on the proven candidates too.
	[
		"Session on another architecture",
		(f) => {
			f.renderedManifest = renderedEnforcementManifest(
				"agent-infra",
				{ architecture: "amd64", legacyUnplaced: "reject" },
				"arm64",
			);
		},
		"SESSION_PLACEMENT_MISMATCH",
	],
	[
		"Session admission without an architecture",
		(f) => {
			f.renderedManifest = f.renderedManifest.replace(
				',JSONPatch{op:"add",path:"/spec/nodeSelector/kubernetes.io~1arch",value:"amd64"}',
				"",
			);
		},
		"SESSION_PLACEMENT_UNPROVEN",
	],
	// The placement must be what the release hands the Worker.
	[
		"missingWorkerPlacement",
		(f) => {
			f.renderedManifest = renderedEnforcementManifest(
				"agent-infra",
				undefined,
			);
		},
		"WORKER_PLACEMENT_MISSING",
	],
	[
		"mismatchedWorkerArchitecture",
		(f) => {
			f.renderedManifest = render({
				architecture: "arm64",
				legacyUnplaced: "reject",
			});
		},
		"WORKER_PLACEMENT_MISMATCH",
	],
	[
		"mismatchedWorkerTransitionMode",
		(f) => {
			f.renderedManifest = render({
				architecture: "amd64",
				legacyUnplaced: "retain-until-lifecycle",
			});
		},
		"WORKER_PLACEMENT_MISMATCH",
	],
	[
		"malformed Worker placement",
		(f) => {
			f.renderedManifest = f.renderedManifest.replace(
				'"architecture":"amd64"',
				'"architecture":"amd64","runtimeClassName":"runv"',
			);
		},
		"WORKER_PLACEMENT_INVALID",
	],
	[
		"no rendered manifest",
		(f) => {
			delete f.renderedManifest;
		},
		"RENDERED_MANIFEST_REQUIRED",
	],
	[
		"two Worker Deployments",
		(f) => {
			f.renderedManifest = `${f.renderedManifest}---\n${f.renderedManifest}`;
		},
		"RENDERED_MANIFEST_INVALID",
	],
	// ---- #4383: placement selector digest ----
	[
		"selector digest of another architecture",
		(f) => {
			f.evidence.placement.selectorSha256 = placementSelectorSha256V1("arm64");
		},
		"PLACEMENT_SELECTOR_MISMATCH",
	],
	[
		"missing selector digest",
		(f) => {
			delete f.evidence.placement.selectorSha256;
		},
		"EVIDENCE_INVALID",
	],
	// ---- #4383: normalized NetworkPolicy template digests ----
	[
		"no networkPolicy section",
		(f) => {
			delete f.evidence.networkPolicy;
		},
		"EVIDENCE_INVALID",
	],
	[
		"one template digest differs",
		(f) => {
			f.evidence.networkPolicy.templateSha256["self-managed"] = "b".repeat(64);
		},
		"NETWORKPOLICY_TEMPLATE_MISMATCH",
	],
	[
		"a template variant is missing from the evidence",
		(f) => {
			delete f.evidence.networkPolicy.templateSha256["multi-service-migration"];
		},
		"NETWORKPOLICY_TEMPLATE_MISMATCH",
	],
	[
		"the evidence records a variant the deployment cannot render",
		(f) => {
			f.evidence.networkPolicy.templateSha256["internal-only+snapshot"] =
				"c".repeat(64);
		},
		"NETWORKPOLICY_TEMPLATE_MISMATCH",
	],
	[
		"deployment egress CIDR widened after the probes",
		(f) => {
			f.deploymentConfig.egress.modelEgress = [
				{ destination: { cidr: "8.8.0.0/16" }, port: 443 },
			];
		},
		"NETWORKPOLICY_TEMPLATE_MISMATCH",
	],
	[
		"deployment Worker source selector changed after the probes",
		(f) => {
			f.deploymentConfig.workerSelector = {
				...workerPodLabels,
				"app.kubernetes.io/instance": "other",
			};
			f.renderedManifest = withWorker((documents) => {
				const worker = documents.find((item) => item.kind === "Deployment");
				worker.spec.template.metadata.labels["app.kubernetes.io/instance"] =
					"other";
			});
		},
		"NETWORKPOLICY_TEMPLATE_MISMATCH",
	],
	[
		"snapshot egress newly deployed",
		(f) => {
			f.deploymentConfig.workspaceSnapshotProjection = true;
			f.deploymentConfig.egress.workspaceSnapshotEgress = [
				{ destination: { ip: "198.51.100.20" }, port: 9000 },
			];
		},
		"NETWORKPOLICY_TEMPLATE_MISMATCH",
	],
	[
		"missing deployment configuration",
		(f) => {
			f.deploymentConfig = undefined;
		},
		"NETWORKPOLICY_CONFIG_REQUIRED",
	],
	[
		"malformed deployment configuration",
		(f) => {
			f.deploymentConfig = { ...f.deploymentConfig, extra: true };
		},
		"NETWORKPOLICY_CONFIG_INVALID",
	],
	[
		"empty Worker selector in the deployment configuration",
		(f) => {
			f.deploymentConfig.workerSelector = {};
		},
		"NETWORKPOLICY_CONFIG_INVALID",
	],
	[
		"deployment Worker selector the rendered Worker does not satisfy",
		(f) => {
			f.deploymentConfig.workerSelector = {
				"app.kubernetes.io/name": "somebody-else",
			};
		},
		"WORKER_SELECTOR_MISMATCH",
	],
	// ---- #4383: probe policy instantiation ----
	[
		"policy without a variant",
		(f) => {
			delete f.evidence.probes[0].policy.variant;
		},
		"EVIDENCE_INVALID",
	],
	[
		"policy without substitutions",
		(f) => {
			delete f.evidence.probes[0].policy.substitutions;
		},
		"EVIDENCE_INVALID",
	],
	[
		"policy without Pod labels",
		(f) => {
			delete f.evidence.probes[0].policy.podLabels;
		},
		"EVIDENCE_INVALID",
	],
	[
		"policy without an instantiated digest",
		(f) => {
			delete f.evidence.probes[0].policy.instantiatedSha256;
		},
		"EVIDENCE_INVALID",
	],
	[
		"the retired spec digest field",
		(f) => {
			f.evidence.probes[0].policy.specSha256 = "d".repeat(64);
		},
		"EVIDENCE_INVALID",
	],
	[
		"substitution without the Agent selector",
		(f) => {
			delete f.evidence.probes[0].policy.substitutions.agentSelector;
		},
		"PROBE_SUBSTITUTION_INVALID",
	],
	[
		"single-service substitution without the Worker source",
		(f) => {
			delete f.evidence.probes[0].policy.substitutions.workerSource;
		},
		"PROBE_SUBSTITUTION_INVALID",
	],
	[
		"multi-service substitution without the service",
		(f) => {
			delete f.evidence.probes[1].policy.substitutions.service;
		},
		"PROBE_SUBSTITUTION_INVALID",
	],
	[
		"substitution port is not the probed port",
		(f) => {
			f.evidence.probes[0].policy.substitutions.port = 3004;
		},
		"PROBE_SUBSTITUTION_INVALID",
	],
	[
		"unknown variant",
		(f) => {
			f.evidence.probes[0].policy.variant = "self-managed-v2";
		},
		"PROBE_POLICY_MISMATCH",
	],
	[
		"variant the deployment cannot render (snapshot)",
		(f) => {
			f.evidence.probes[0].policy.variant = "self-managed+snapshot";
		},
		"PROBE_POLICY_MISMATCH",
	],
	[
		"instantiated digest does not match",
		(f) => {
			f.evidence.probes[0].policy.instantiatedSha256 = "e".repeat(64);
		},
		"PROBE_POLICY_MISMATCH",
	],
	[
		"substitutions changed after the digest was taken",
		(f) => {
			f.evidence.probes[0].policy.substitutions.workerSource = {
				"np-probe/source": "someone-else",
			};
			f.evidence.probes[0].policy.podLabels.workerSource = {
				"np-probe/source": "someone-else",
			};
			f.evidence.probes[0].policy.podLabels.nonWorkerSource = {
				"np-probe/source": "other",
			};
		},
		"PROBE_POLICY_MISMATCH",
	],
	[
		"digest of a different variant",
		(f) => {
			f.evidence.probes[0].policy.variant = "internal-only";
		},
		"PROBE_POLICY_MISMATCH",
	],
	[
		"probe policy uses the production Agent label key",
		(f) => {
			f.evidence.probes[0].policy.substitutions.agentSelector.key =
				"agent-infra.agora.io/agent";
			f.evidence.probes[0].policy.podLabels.target = {
				"agent-infra.agora.io/agent": "probe-a",
			};
			f.evidence.probes[0].policy.instantiatedSha256 =
				networkPolicySpecSha256V1(
					networkPolicySpecV1({
						variant: "self-managed",
						config: f.deploymentConfig,
						substitutions: f.evidence.probes[0].policy.substitutions,
					}),
				);
		},
		"PROBE_SUBSTITUTION_INVALID",
	],
	// ---- #4383: probe Pod labels judged on what the Pods actually carry ----
	[
		"target Pod carries the production Agent key",
		(f) => setLabels(f, { "agent-infra.agora.io/agent": "agent-p" }),
		"PROBE_LABELS_FORBIDDEN",
	],
	[
		"Worker source Pod carries a superset of the Worker selector",
		(f) => {
			f.evidence.probes[0].policy.podLabels.workerSource = {
				...workerPodLabels,
				"np-probe/source": "worker",
			};
		},
		"PROBE_LABELS_FORBIDDEN",
	],
	[
		"non-Worker source Pod carries a superset of the Worker selector",
		(f) => {
			f.evidence.probes[0].policy.podLabels.nonWorkerSource = {
				...workerPodLabels,
				probe: "1",
			};
		},
		"PROBE_LABELS_FORBIDDEN",
	],
	[
		"target Pod satisfies the Worker selector",
		(f) => setLabels(f, workerPodLabels),
		"PROBE_LABELS_FORBIDDEN",
	],
	[
		"Pod satisfies the Worker Deployment selector but not the configured selector",
		(f) => {
			f.renderedManifest = withWorker((documents) => {
				const worker = documents.find((item) => item.kind === "Deployment");
				worker.spec.selector = { matchLabels: { "np/deploy": "worker" } };
				worker.spec.template.metadata.labels["np/deploy"] = "worker";
			});
			setLabels(f, { "np/deploy": "worker" });
		},
		"PROBE_LABELS_FORBIDDEN",
	],
	[
		"Pod satisfies the Worker Service selector but not the configured selector",
		(f) => {
			f.renderedManifest = withWorker((documents) => {
				const worker = documents.find((item) => item.kind === "Deployment");
				worker.spec.template.metadata.labels["np/service"] = "worker";
				documents.find((item) => item.kind === "Service").spec.selector = {
					"np/service": "worker",
				};
			});
			setLabels(f, { "np/service": "worker" });
		},
		"PROBE_LABELS_FORBIDDEN",
	],
	[
		"Pod satisfies a Deployment selector written with matchExpressions",
		(f) => {
			f.renderedManifest = withWorker((documents) => {
				const worker = documents.find((item) => item.kind === "Deployment");
				worker.spec.selector = {
					matchExpressions: [
						{ key: "np/tier", operator: "In", values: ["a", "b"] },
					],
				};
				worker.spec.template.metadata.labels["np/tier"] = "a";
			});
			setLabels(f, { "np/tier": "b" });
		},
		"PROBE_LABELS_FORBIDDEN",
	],
	[
		"a selector with an operator the gate cannot judge counts as satisfied",
		(f) => {
			f.renderedManifest = withWorker((documents) => {
				const worker = documents.find((item) => item.kind === "Deployment");
				worker.spec.selector = {
					matchExpressions: [{ key: "np/tier", operator: "Gt", values: ["1"] }],
				};
			});
		},
		"PROBE_LABELS_FORBIDDEN",
	],
	[
		"Pod satisfies the Platform API source selector (same namespace)",
		(f) => setLabels(f, f.deploymentConfig.platformApiSelector),
		"PROBE_LABELS_FORBIDDEN",
	],
	[
		"Pod satisfies the route source selector when the route namespace is the Agent namespace",
		(f) => {
			f.deploymentConfig.routeNamespace = "agent-infra";
			resign(f);
			setLabels(f, f.deploymentConfig.routeSelector);
		},
		"PROBE_LABELS_FORBIDDEN",
	],
	[
		"target Pod is not selected by the instantiated policy",
		(f) => {
			f.evidence.probes[0].policy.podLabels.target = { other: "x" };
		},
		"PROBE_LABELS_INCONSISTENT",
	],
	[
		"Worker source Pod does not carry the substituted source labels",
		(f) => {
			f.evidence.probes[0].policy.podLabels.workerSource = { other: "x" };
		},
		"PROBE_LABELS_INCONSISTENT",
	],
	[
		"non-Worker source Pod carries the substituted source labels",
		(f) => {
			f.evidence.probes[0].policy.podLabels.nonWorkerSource = {
				"np-probe/source": "worker",
			};
		},
		"PROBE_LABELS_INCONSISTENT",
	],
	// A controller is judged by the placement recorded on it.
	[
		"ECI fields without the Worker record",
		(f) => {
			delete f.observed.controllers[0].metadata.annotations;
		},
		"FOREIGN_PLACEMENT",
	],
	[
		"controller adopted another architecture",
		(f) => {
			const arm = eciPlacementFieldsV1("arm64");
			Object.assign(f.observed.controllers[1].spec.template.spec, arm);
			f.observed.controllers[1].metadata.annotations[record] = "arm64";
		},
		"TARGET_PLACEMENT_UNPROVEN",
	],
];
for (const [name, mutate, code] of cases)
	test(`fails closed on ${name}`, () => {
		const f = fixture();
		mutate(f);
		rejects(f, code);
	});

test("a probe-only label set below the Worker selector is allowed", () => {
	const f = fixture();
	// Subset of the Worker labels is not the Worker: it does not satisfy the selector.
	f.evidence.probes[0].policy.podLabels.nonWorkerSource = {
		"app.kubernetes.io/name": "agent-infra",
	};
	assert.equal(run(f).status, "passed");
});

test("snapshot forms are required once the deployment enables snapshot projection and egress", () => {
	const f = fixture();
	f.deploymentConfig.workspaceSnapshotProjection = true;
	f.deploymentConfig.egress.workspaceSnapshotEgress = [
		{ destination: { ip: "198.51.100.20" }, port: 9000 },
	];
	resign(f);
	assert.equal(Object.keys(f.evidence.networkPolicy.templateSha256).length, 12);
	f.evidence.probes[0].policy.variant = "self-managed+snapshot";
	resign(f);
	assert.equal(run(f).status, "passed");
	delete f.evidence.networkPolicy.templateSha256["self-managed+snapshot"];
	rejects(f, "NETWORKPOLICY_TEMPLATE_MISMATCH");
});

test("selectors are judged with full LabelSelector semantics", () => {
	const labels = { a: "1", b: "2" };
	assert.equal(labelsSatisfySelectorV1(labels, { a: "1" }), true);
	assert.equal(labelsSatisfySelectorV1(labels, { a: "2" }), false);
	const expr = (operator, values) => ({
		matchExpressions: [{ key: "a", operator, values }],
	});
	assert.equal(labelsSatisfySelectorV1(labels, expr("In", ["1"])), true);
	assert.equal(labelsSatisfySelectorV1(labels, expr("In", ["2"])), false);
	assert.equal(labelsSatisfySelectorV1(labels, expr("NotIn", ["2"])), true);
	assert.equal(labelsSatisfySelectorV1(labels, expr("NotIn", ["1"])), false);
	assert.equal(labelsSatisfySelectorV1(labels, expr("Exists")), true);
	assert.equal(labelsSatisfySelectorV1({}, expr("Exists")), false);
	assert.equal(labelsSatisfySelectorV1({}, expr("DoesNotExist")), true);
	assert.equal(labelsSatisfySelectorV1(labels, expr("Gt", ["0"])), true);
	assert.notEqual(probeAgentKey, "agent-infra.agora.io/agent");
});

test("the temporary deny-all policy need not exist after recovery", () => {
	const f = fixture();
	f.evidence.probes[0].deny.policyUid = uid(99);
	assert.equal(run(f).status, "passed");
});

test("requires the rendered Session ECI admission rather than a RuntimeClass branch", () => {
	const valid = renderedEnforcementManifest("agent-infra", {
		architecture: "amd64",
		legacyUnplaced: "reject",
	});
	assertSessionEciAdmissionRenderedV1(valid, "agent-infra");
	const documents = () =>
		parseAllDocuments(valid).map((document) => document.toJS());
	const variant = (change) => {
		const [worker, service, policy, binding] = documents();
		change(policy, binding);
		return [worker, service, policy, binding]
			.filter(Boolean)
			.map((document) => stringify(document))
			.join("---\n");
	};
	const expression = (policy) => policy.spec.mutations[0].jsonPatch;
	for (const rendered of [
		variant((policy) => Object.assign(policy, { kind: "ConfigMap" })),
		variant((policy, binding) => {
			policy.metadata.name = "other-session-eci";
			binding.metadata.name = "other-session-eci";
			binding.spec.policyName = "other-session-eci";
		}),
		variant((_policy, binding) =>
			Object.assign(binding, { kind: "ConfigMap" }),
		),
		// The patch only in a comment-like field, an empty mutation list, or a Binding to another policy.
		variant((policy) => {
			policy.metadata.annotations = {
				note: 'path:"/spec/nodeSelector/type",value:"virtual-kubelet"',
			};
			expression(policy).expression = "[]";
		}),
		variant((policy) => {
			policy.spec.mutations = [];
		}),
		variant((_policy, binding) => {
			binding.spec.policyName = "other";
		}),
		variant((policy) => {
			expression(policy).expression =
				`[JSONPatch{op:"add",path:"/spec/runtimeClassName",value:"runv"}] + ${expression(policy).expression}`;
		}),
		variant((policy) => {
			policy.spec.failurePolicy = "Ignore";
		}),
		variant((policy) => {
			policy.spec.matchConstraints.objectSelector.matchLabels = {};
		}),
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
	const evidenceFile = join(directory, "evidence.json");
	const configFile = join(directory, "config.json");
	const renderedFile = join(directory, "rendered.yaml");
	const calls = join(directory, "calls.log");
	await writeFile(evidenceFile, JSON.stringify(f.evidence));
	await writeFile(configFile, JSON.stringify(f.deploymentConfig));
	await writeFile(renderedFile, f.renderedManifest);
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
		ACK_NETWORKPOLICY_DEPLOYMENT_CONFIG_FILE: configFile,
		ACK_RENDERED_MANIFEST_FILE: renderedFile,
	};
	const passed = spawnSync(process.execPath, [script], {
		encoding: "utf8",
		env,
	});
	assert.equal(passed.status, 0, passed.stderr);
	assert.equal(JSON.parse(passed.stdout).status, "passed");
	const code = (result) => JSON.parse(result.stderr.trim()).code;
	const failing = (override, expected) => {
		const result = spawnSync(process.execPath, [script], {
			encoding: "utf8",
			env: { ...env, ...override },
		});
		assert.equal(result.status, 2);
		assert.equal(code(result), expected);
		return result;
	};
	failing({ ACK_NETWORKPOLICY_EVIDENCE_FILE: "" }, "EVIDENCE_REQUIRED");
	failing(
		{ ACK_NETWORKPOLICY_DEPLOYMENT_CONFIG_FILE: "" },
		"NETWORKPOLICY_CONFIG_REQUIRED",
	);
	failing(
		{ ACK_NETWORKPOLICY_DEPLOYMENT_CONFIG_FILE: join(directory, "absent") },
		"NETWORKPOLICY_CONFIG_INVALID",
	);
	failing({ ACK_RENDERED_MANIFEST_FILE: "" }, "RENDERED_MANIFEST_REQUIRED");
	const forbidden = failing({ KUBECTL_BIN: await stub(true) }, "READ_FAILED");
	assert(!forbidden.stderr.includes("forbidden"));
	// The retired Poseidon readback input is ignored rather than consulted.
	const retired = spawnSync(process.execPath, [script], {
		encoding: "utf8",
		env: {
			...env,
			ACK_NETWORKPOLICY_ENFORCER_CONFIG_FILE: join(directory, "absent"),
		},
	});
	assert.equal(retired.status, 0, retired.stderr);
	const read = (await readFile(calls, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	for (const args of read) {
		assert(args.includes("get"));
		assert(
			!args.some((word) =>
				["create", "apply", "patch", "delete", "exec", "run"].includes(word),
			),
		);
		// Probe Pods and original NetworkPolicies no longer exist at deploy time.
		assert(
			!args.some((word) =>
				["pod", "replicaset", "networkpolicy"].includes(word),
			),
		);
	}
});

test("formal ACK entries run the gate before reading inputs or creating template Pods", async () => {
	const gate = "deploy/ack/networkpolicy-enforcement.mjs";
	const preflight = await readFile(
		join(import.meta.dirname, "../deploy/ack/preflight.sh"),
		"utf8",
	);
	assert(preflight.indexOf(gate) > preflight.indexOf("helm template"));
	assert(preflight.indexOf(gate) < preflight.indexOf("bootstrap-inputs.ts"));
	const redeploy = await readFile(
		join(import.meta.dirname, "../deploy/ack/redeploy.sh"),
		"utf8",
	);
	const body = redeploy.slice(
		redeploy.indexOf("template_preflight() {"),
		redeploy.indexOf("\n}\n", redeploy.indexOf("template_preflight() {")),
	);
	assert(body.includes(gate));
	assert(body.indexOf(gate) < body.indexOf("prepare-template-preflight.ts"));
	assert(body.indexOf(gate) < body.indexOf("template-model-preflight.mjs"));
	assert(redeploy.indexOf('"$repo_root/deploy/ack/preflight.sh"') > 0);
});

test("a real chart with arm64 Agents and default amd64 Sessions fails arm64-only evidence (round 2 MUST-1)", () => {
	const rendered = spawnSync(
		"helm",
		[
			"template",
			"agent-infra",
			join(import.meta.dirname, "../deploy/ack/chart"),
			"--namespace",
			"agent-infra",
			"--kube-version",
			"1.36.0",
			"--set",
			"agentWorkloadScheduling.enabled=true",
			"--set",
			"agentWorkloadScheduling.architecture=arm64",
			"--set",
			"agentWorkloadScheduling.legacyUnplaced=reject",
			"--set",
			"sessionRuntimeScheduling.enabled=true",
		],
		{ encoding: "utf8" },
	);
	assert.equal(rendered.status, 0, rendered.stderr);
	const f = fixture();
	f.evidence.placement.architecture = "arm64";
	f.evidence.placement.selectorSha256 = placementSelectorSha256V1("arm64");
	f.renderedManifest = rendered.stdout;
	rejects(f, "SESSION_PLACEMENT_MISMATCH");
});
