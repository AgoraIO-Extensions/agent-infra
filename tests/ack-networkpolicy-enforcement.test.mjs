import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseAllDocuments, stringify } from "yaml";
import {
	assertSessionEciAdmissionRenderedV1,
	deriveNetworkPolicyDeploymentConfigV1,
	eciPlacementFieldsV1,
	labelsSatisfySelectorV1,
	maxEvidenceAgeMs,
	placementSelectorSha256V1,
	validateNetworkPolicyEnforcementV1,
} from "../deploy/ack/networkpolicy-enforcement.mjs";
import {
	networkPolicyEvidenceSha256V1,
	networkPolicySpecV1,
	networkPolicyTemplateDigestsV1,
} from "../packages/platform-core/src/workload-network-policy.ts";
import { acsPodMetadataV1 } from "../packages/platform-core/src/workload-resource-configuration.ts";
import {
	networkPolicyDeploymentConfig,
	probeAgentKey,
	probePolicyEvidence,
	renderedEnforcementManifest,
	workerConfigurationInputs,
	workerConfigurationSource,
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
		probe.policy.instantiatedSha256 = networkPolicyEvidenceSha256V1(
			networkPolicySpecV1({
				variant: probe.policy.variant,
				config: f.deploymentConfig,
				substitutions: probe.policy.substitutions,
			}),
			f.deploymentConfig,
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
				networkPolicyEvidenceSha256V1(
					networkPolicySpecV1({
						variant: "self-managed",
						config: f.deploymentConfig,
						substitutions: f.evidence.probes[0].policy.substitutions,
					}),
					f.deploymentConfig,
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
			delete policy.spec.matchConditions;
		}),
		variant((policy) => {
			policy.spec.matchConditions[0].expression = "true";
		}),
		variant((policy) => {
			expression(policy).expression +=
				' + [JSONPatch{op:"add",path:"/metadata/labels/alibabacloud.com~1acs",value:"true"}]';
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
	const configFile = join(directory, "configuration.mjs");
	const bootstrapFile = join(directory, "bootstrap-inputs.json");
	const renderedFile = join(directory, "rendered.yaml");
	const calls = join(directory, "calls.log");
	await writeFile(evidenceFile, JSON.stringify(f.evidence));
	await writeFile(configFile, workerConfigurationSource(f.deploymentConfig), {
		mode: 0o600,
	});
	await writeFile(
		bootstrapFile,
		JSON.stringify({
			schemaVersion: 1,
			objects: [
				{
					kind: "Secret",
					name: "np-gate-worker-config",
					files: { "configuration.mjs": configFile },
				},
			],
		}),
		{ mode: 0o600 },
	);
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
		ACK_BOOTSTRAP_INPUTS_FILE: bootstrapFile,
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
	failing({ ACK_BOOTSTRAP_INPUTS_FILE: "" }, "WORKER_CONFIGURATION_REQUIRED");
	failing(
		{ ACK_BOOTSTRAP_INPUTS_FILE: join(directory, "absent") },
		"WORKER_CONFIGURATION_UNVERIFIABLE",
	);
	// #4385 M1: the configuration is derived from the Worker module the render mounts,
	// so a stale copy of an older configuration can no longer pass.
	const original = await readFile(configFile, "utf8");
	const widened = structuredClone(f.deploymentConfig);
	widened.egress.modelEgress = [
		{ destination: { cidr: "8.8.0.0/16" }, port: 443 },
	];
	await writeFile(configFile, workerConfigurationSource(widened), {
		mode: 0o600,
	});
	failing({}, "NETWORKPOLICY_TEMPLATE_MISMATCH");
	for (const source of [
		"export const unrelated = 1;\n",
		'import "./absent-sibling.mjs";\nexport const workloadInput = { policy: {} };\n',
		'import { readFileSync } from "node:fs";\nreadFileSync("/etc/hosts");\n' +
			original,
		'import { execSync } from "node:child_process";\nexecSync("true");\n' +
			original,
		'await fetch("http://127.0.0.1:9");\n' + original,
		"throw new Error('boom');\n",
	]) {
		await writeFile(configFile, source, { mode: 0o600 });
		failing({}, "WORKER_CONFIGURATION_UNVERIFIABLE");
	}
	await writeFile(configFile, original, { mode: 0o600 });
	assert.equal(
		JSON.parse(
			spawnSync(process.execPath, [script], { encoding: "utf8", env }).stdout,
		).status,
		"passed",
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

// ---- #4385 review MUST 2: probe Pods are judged against the instantiated policy ----
const extraProbe = (f, variant, node = "j") => {
	const base = f.evidence.probes[1];
	const probe = structuredClone(base);
	probe.policy = {
		...base.policy,
		...probePolicyEvidence(f.deploymentConfig, variant),
	};
	f.evidence.probes.push({
		...probe,
		destination: {
			...probe.destination,
			pod: `x-${node}-0`,
			uid: uid(60),
			nodeName: `virtual-kubelet-cn-hangzhou-${node}`,
			controller: { kind: "StatefulSet", name: "agent-p2", uid: uid(14) },
		},
	});
	return f.evidence.probes.at(-1);
};
const inconsistent = (name, mutate, variant = "multi-service-entry") =>
	test(`fails closed on ${name}`, () => {
		const f = fixture();
		const probe =
			variant === "multi-service-entry"
				? f.evidence.probes[1]
				: extraProbe(f, variant);
		mutate(probe.policy.podLabels);
		rejects(f, "PROBE_LABELS_INCONSISTENT");
	});
const serviceLabel = "agent-infra.agora.io/service";
inconsistent(
	"a multi-service target that lacks the service label",
	(labels) => {
		delete labels.target[serviceLabel];
	},
);
inconsistent("a multi-service target with another service value", (labels) => {
	labels.target[serviceLabel] = "other-svc";
});
inconsistent(
	"a multi-service target not carrying the probe agent label",
	(labels) => {
		labels.target = { [serviceLabel]: "probe-svc" };
	},
);
inconsistent(
	"a multi-service allowed source that is not a sibling of the target",
	(labels) => {
		labels.workerSource = { "np-probe/source": "worker" };
	},
);
inconsistent(
	"a multi-service non-allowed source that is a sibling of the target",
	(labels) => {
		labels.nonWorkerSource = { [probeAgentKey]: "probe-a" };
	},
);
test("a migration probe is rejected even with fully correct labels: its policy admits no source (R2-M2)", () => {
	const f = fixture();
	const probe = extraProbe(f, "multi-service-migration");
	assert.equal(probe.policy.podLabels.target[serviceLabel], "migration");
	rejects(f, "PROBE_VARIANT_NO_INGRESS");
	// The same shape on a variant that does admit a sibling source is accepted.
	const g = fixture();
	extraProbe(g, "multi-service-service");
	assert.equal(run(g).status, "passed");
});

// ---- #4385 review MUST 3: protected networks are bound into every digest ----
const nativeEgress = (platformDatabase) => ({
	destinations: [{ destination: { ip: "8.8.8.8" }, port: 443 }],
	protectedNetworks: {
		platformDatabase: [platformDatabase],
		connectionDatabase: ["10.1.0.0/24"],
		kubernetesApi: ["9.9.9.9"],
		sandboxPodNetworks: ["10.2.0.0/16"],
	},
});
const withNative = (f) => {
	f.deploymentConfig.egress.nativeEgress = nativeEgress("10.0.0.0/24");
	f.evidence.probes.forEach((probe) => {
		probe.policy.podLabels = probePolicyEvidence(
			f.deploymentConfig,
			probe.policy.variant,
		).podLabels;
	});
	resign(f);
};
test("evidence with native egress passes and lists the no-native forms", () => {
	const f = fixture();
	withNative(f);
	const summary = run(f);
	assert.equal(summary.status, "passed");
	assert(
		Object.hasOwn(summary.networkPolicyTemplates, "self-managed+no-native"),
	);
});
test("fails closed when only the protected networks change", () => {
	const f = fixture();
	withNative(f);
	const before = networkPolicyTemplateDigestsV1(f.deploymentConfig);
	f.deploymentConfig.egress.nativeEgress = nativeEgress("10.5.0.0/16");
	// The effective specs are byte-identical; the protected input is what changed.
	assert.deepEqual(
		networkPolicySpecV1({
			variant: "self-managed",
			config: f.deploymentConfig,
		}),
		networkPolicySpecV1({
			variant: "self-managed",
			config: {
				...f.deploymentConfig,
				egress: {
					...f.deploymentConfig.egress,
					nativeEgress: nativeEgress("10.0.0.0/24"),
				},
			},
		}),
	);
	assert.notDeepEqual(
		networkPolicyTemplateDigestsV1(f.deploymentConfig),
		before,
	);
	rejects(f, "NETWORKPOLICY_TEMPLATE_MISMATCH");
	// Templates re-signed but the probe policy digest left old: the probe is rejected.
	f.evidence.networkPolicy.templateSha256 = networkPolicyTemplateDigestsV1(
		f.deploymentConfig,
	);
	rejects(f, "PROBE_POLICY_MISMATCH");
	resign(f);
	assert.equal(run(f).status, "passed");
});

// ---- #4385 review MUST 4: Agents without a template binding have their own forms ----
test("fails closed when evidence omits the no-native forms of a native deployment", () => {
	const f = fixture();
	withNative(f);
	for (const variant of Object.keys(f.evidence.networkPolicy.templateSha256))
		if (variant.endsWith("+no-native"))
			delete f.evidence.networkPolicy.templateSha256[variant];
	rejects(f, "NETWORKPOLICY_TEMPLATE_MISMATCH");
});
test("a probe for the no-native form is accepted and its digest is checked", () => {
	const f = fixture();
	withNative(f);
	f.evidence.probes[0].policy = {
		...f.evidence.probes[0].policy,
		...probePolicyEvidence(f.deploymentConfig, "self-managed+no-native", 3003),
	};
	assert.equal(run(f).status, "passed");
	f.evidence.probes[0].policy.instantiatedSha256 = "0".repeat(64);
	rejects(f, "PROBE_POLICY_MISMATCH");
});
test("a no-native form is not offered by a deployment without native egress", () => {
	const f = fixture();
	f.evidence.probes[0].policy = {
		...f.evidence.probes[0].policy,
		...probePolicyEvidence(f.deploymentConfig, "self-managed+no-native", 3003),
	};
	rejects(f, "PROBE_POLICY_MISMATCH");
});

// ---- #4385 round 2: the Worker's final network configuration ----
const configurationModule = (config) =>
	workerConfigurationSource(config).replace(
		"policy: {",
		"policy: { runtimeAuth: {},",
	);
const envEntry = (name, value) => ({ name, value });
const digestsFor = async (directory, source, workerEnvironment = []) => {
	const inputs = await workerConfigurationInputs(directory, source, {
		workerEnvironment,
	});
	const { config } = await deriveNetworkPolicyDeploymentConfigV1({
		...inputs,
		namespace: "agent-infra",
	});
	return networkPolicyTemplateDigestsV1(config);
};

test("the derived configuration follows the Worker's file exchange and gateway environment (R2-M1)", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ack-np-effective-"));
	const source = configurationModule(networkPolicyDeploymentConfig());
	const exchange = (ip) => [
		envEntry(
			"PLATFORM_WORKER_FILE_EXCHANGE_ORIGIN",
			"https://files.example.test",
		),
		envEntry("PLATFORM_WORKER_FILE_EXCHANGE_EGRESS", JSON.stringify({ ip })),
	];
	const plain = await digestsFor(directory, source);
	const seven = await digestsFor(directory, source, exchange("198.51.100.7"));
	const eight = await digestsFor(directory, source, exchange("198.51.100.8"));
	// Same module bytes; only the rendered Worker environment changes.
	assert.notDeepEqual(plain, seven);
	assert.notDeepEqual(seven, eight);
	// Module-level gateway port, with the release name from the environment.
	const gateway = (port) =>
		digestsFor(
			directory,
			`${source}export const nativeMetadataGateway = { port: ${port} };\n`,
			[
				envEntry("PLATFORM_WORKER_NAMESPACE", "agent-infra"),
				envEntry("PLATFORM_WORKER_RELEASE_NAME", "agent-infra-ack"),
			],
		);
	assert.notDeepEqual(await gateway(3005), await gateway(3006));
	assert.notDeepEqual(await gateway(3005), plain);
	// The ACK chart's namespace fieldRef resolves to the deployment namespace.
	const viaFieldRef = await workerConfigurationInputs(directory, source, {
		workerEnvironment: [
			{
				name: "PLATFORM_WORKER_NAMESPACE",
				valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } },
			},
		],
	});
	await deriveNetworkPolicyDeploymentConfigV1({
		...viaFieldRef,
		namespace: "agent-infra",
	});
	// Anything the preflight cannot read from the render, or the Worker rejects, is refused.
	for (const workerEnvironment of [
		[
			{
				name: "PLATFORM_WORKER_FILE_EXCHANGE_EGRESS",
				valueFrom: { secretKeyRef: { name: "x", key: "y" } },
			},
		],
		[
			envEntry(
				"PLATFORM_WORKER_FILE_EXCHANGE_EGRESS",
				JSON.stringify({ ip: "198.51.100.7" }),
			),
		],
		[envEntry("PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_ENABLED", "true")],
	]) {
		const inputs = await workerConfigurationInputs(directory, source, {
			workerEnvironment,
		});
		await assert.rejects(
			deriveNetworkPolicyDeploymentConfigV1({
				...inputs,
				namespace: "agent-infra",
			}),
			(error) =>
				[
					"WORKER_CONFIGURATION_UNVERIFIABLE",
					"NETWORKPOLICY_CONFIG_INVALID",
				].includes(error.code),
		);
	}
});

// ---- #4385 round 3: module evaluation environment (R3-1) ----
test("the module is evaluated with the Worker's rendered network environment (R3-1)", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ack-np-moduleenv-"));
	const source = `${configurationModule(networkPolicyDeploymentConfig())}export const nativeMetadataGateway = { port: Number(process.env.PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_PORT ?? "3004") };\n`;
	const port = (value) => [
		envEntry("PLATFORM_WORKER_NAMESPACE", "agent-infra"),
		envEntry("PLATFORM_WORKER_RELEASE_NAME", "agent-infra-ack"),
		envEntry("PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_PORT", value),
	];
	const p3004 = await digestsFor(directory, source, port("3004"));
	const p3005 = await digestsFor(directory, source, port("3005"));
	assert.notDeepEqual(p3004, p3005);
	// Static module (no environment read) is unaffected by the isolation.
	await digestsFor(
		directory,
		configurationModule(networkPolicyDeploymentConfig()),
	);
	// An environment read the preflight cannot reproduce is refused, not evaluated as unset.
	for (const read of [
		"process.env.HOME",
		"process.env.SECRET_TOKEN",
		"Object.keys(process.env)",
		// Reflective reads, and writes/deletes/redefinitions (even if the module
		// catches the error), cannot be reproduced by the final merge (#4385 round 4).
		'Object.getOwnPropertyDescriptor(process.env, "PLATFORM_WORKER_WECOM_ENABLED")?.value',
		'Reflect.get(process.env, "PLATFORM_WORKER_WECOM_ENABLED")',
		'(process.env.PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_PORT = "3005")',
		"(delete process.env.PLATFORM_WORKER_NAMESPACE)",
		'Object.defineProperty(process.env, "PLATFORM_WORKER_NAMESPACE", { value: "x" })',
		'(() => { try { process.env.PLATFORM_WORKER_NAMESPACE = "x"; } catch {} })()',
		"(() => { try { return process.env.HOME; } catch {} })()",
	]) {
		const inputs = await workerConfigurationInputs(
			directory,
			`${configurationModule(networkPolicyDeploymentConfig())}export const probe = ${read};\n`,
		);
		await assert.rejects(
			deriveNetworkPolicyDeploymentConfigV1({
				...inputs,
				namespace: "agent-infra",
			}),
			(error) => error.code === "WORKER_CONFIGURATION_UNVERIFIABLE",
		);
	}
});

// ---- #4385 round 2: loading deployment code must not reach the network (R2-N1) ----
test("the module loader reaches no listener over any network API", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ack-np-network-"));
	let connections = 0;
	const server = createServer((socket) => {
		connections++;
		socket.destroy();
	});
	let datagrams = 0;
	const { createSocket } = await import("node:dgram");
	const udp = createSocket("udp4");
	udp.on("message", () => datagrams++);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	await new Promise((resolve) => udp.bind(0, "127.0.0.1", resolve));
	const { port } = server.address();
	const udpPort = udp.address().port;
	const attempts = `
import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import http2 from "node:http2";
import dgram from "node:dgram";
const attempt = async (run) => { try { await run(); } catch {} };
await attempt(() => net.connect(${port}, "127.0.0.1"));
await attempt(() => net.createConnection({ port: ${port}, host: "127.0.0.1" }));
await attempt(() => new net.Socket().connect(${port}, "127.0.0.1"));
await attempt(() => http.get("http://127.0.0.1:${port}/").on("error", () => {}));
await attempt(() => https.get("https://127.0.0.1:${port}/").on("error", () => {}));
await attempt(() => tls.connect(${port}, "127.0.0.1").on("error", () => {}));
await attempt(() => http2.connect("http://127.0.0.1:${port}/").on("error", () => {}));
await attempt(() => fetch("http://127.0.0.1:${port}/"));
await attempt(() => new WebSocket("ws://127.0.0.1:${port}/"));
await attempt(() => dgram.createSocket("udp4").send("x", ${udpPort}, "127.0.0.1"));
await attempt(() => new dgram.Socket("udp4").send("x", ${udpPort}, "127.0.0.1"));
await attempt(() => new (Object.getPrototypeOf(dgram.createSocket).constructor)("return 0"));
await attempt(() => {
	// Native handle path (#4385 round 3): bypasses the JS send/bind methods.
	const handle = dgram.createSocket("udp4")._handle;
	handle.bind("127.0.0.1", 0, 0);
	handle.send({ length: 1 }, [Buffer.from("x")], 1, ${udpPort}, "127.0.0.1", false);
});
await new Promise((resolve) => setTimeout(resolve, 200));
`;
	// Positive control: the same module still yields its configuration.
	const config = networkPolicyDeploymentConfig();
	const accepted = await workerConfigurationInputs(
		directory,
		`${attempts}${workerConfigurationSource(config)}`,
	);
	const derived = await deriveNetworkPolicyDeploymentConfigV1({
		...accepted,
		namespace: "agent-infra",
	});
	assert.deepEqual(
		networkPolicyTemplateDigestsV1(derived.config),
		networkPolicyTemplateDigestsV1(config),
	);
	await new Promise((resolve) => setTimeout(resolve, 300));
	server.close();
	udp.close();
	assert.equal(connections, 0);
	assert.equal(datagrams, 0);
});

test("mixed compute needs a matching proof on every node; ECI evidence cannot authorize ACS", () => {
	const f = fixture();
	const computes = { agent: "acs", session: "eci" };
	f.renderedManifest = render({
		architecture: "amd64",
		legacyUnplaced: "reject",
		compute: "acs",
	});
	rejects(f, "COMPUTE_PLACEMENT_MISMATCH");
	f.evidence.placement.computes = computes;
	f.evidence.placement.selectorSha256 = placementSelectorSha256V1(
		"amd64",
		computes,
	);
	f.evidence.enforcer.runtime = "mixed";
	for (const probe of f.evidence.probes)
		Object.assign(probe.destination, {
			compute: "eci",
			instanceId: "eci-synthetic01",
		});
	rejects(f, "CANDIDATE_NODE_UNPROBED");
	f.evidence.probes.push(
		...structuredClone(f.evidence.probes).map((probe) => {
			Object.assign(probe.destination, {
				compute: "acs",
				instanceId: "acs-synthetic01",
			});
			Object.assign(
				probe.policy.podLabels.target,
				acsPodMetadataV1("acs").labels,
			);
			return probe;
		}),
	);
	assert.equal(run(f).status, "passed");
	f.evidence.probes.at(-1).destination.instanceId = "eci-synthetic01";
	rejects(f, "EVIDENCE_INVALID");
});

test("fresh Core SDK deployment scopes the unmeasured network capability to the installed Codex image", async () => {
	const gate = await import("../deploy/ack/networkpolicy-enforcement.mjs");
	const namespace = "ack-community-m1-4405";
	const source = "a".repeat(40);
	const digest = "sha256:" + "b".repeat(64);
	const repository =
		"ghcr.io/agoraio-extensions/agent-infra/agent-runtime-codex";
	const image = repository + "@" + digest;
	const workerImage =
		"ghcr.io/agoraio-extensions/agent-infra/platform-worker@" + digest;
	const env = [{ name: "AGENT_INFRA_SIG_CORE_SDK_TRIAL_IMAGE", value: image }];
	const rendered = renderedWorkloadPlacement(namespace, env);
	const worker = rendered.worker.spec.template.spec.containers[0];
	worker.image = workerImage;
	const target = {
		namespace,
		sourceCommit: source,
		installationId: uid(1),
		clusterUid: uid(2),
		namespaceUid: uid(3),
	};
	const observed = {
		clusterUid: uid(2),
		namespace: {
			metadata: {
				name: namespace,
				uid: uid(3),
				labels: { "agent-infra.agora.io/bootstrap-id": uid(1) },
			},
		},
		workers: [],
		workloads: [],
	};
	const input = {
		namespace,
		source,
		target,
		bootstrap: target,
		image,
		workerImage,
		rendered,
		observed,
	};
	const receipt = gate.validateCodexTrialNetworkScope(input);
	assert.equal(receipt.networkDataplaneVerified, false);
	assert.equal(receipt.fieldAcceptanceSigned, false);
	for (const change of [
		{ namespace: "another" },
		{ image: repository + "@sha256:" + "c".repeat(64) },
		{ observed: { ...observed, clusterUid: uid(4) } },
		{
			observed: {
				...observed,
				workers: [{ spec: { containers: [{ ...worker, env: [] }] } }],
			},
		},
		{
			observed: {
				...observed,
				workloads: [{ kind: "StatefulSet", metadata: { name: "unverified" } }],
			},
		},
	])
		assert.throws(() =>
			gate.validateCodexTrialNetworkScope({ ...input, ...change }),
		);
});

function renderedWorkloadPlacement(namespace, env) {
	const manifest = renderedEnforcementManifest(
		namespace,
		{ architecture: "amd64", legacyUnplaced: "reject" },
		"amd64",
		env,
	);
	const documents = parseAllDocuments(manifest).map((document) =>
		document.toJS(),
	);
	const worker = documents.find((item) => item.kind === "Deployment");
	return {
		worker,
		placement: { architecture: "amd64" },
		sessionArchitecture: "amd64",
	};
}

test("CLI admits only the isolated SDK scope without dataplane evidence", async () => {
	const namespace = "ack-community-m1-4405";
	const directory = await mkdtemp(join(tmpdir(), "ack-sdk-network-"));
	const sourceCommit = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: import.meta.dirname,
		encoding: "utf8",
	}).stdout.trim();
	const context = {
		namespace,
		sourceCommit,
		clusterUid: uid(1),
		namespaceUid: uid(2),
		installationId: uid(3),
	};
	const files = await import("./support/networkpolicy-evidence.mjs").then(
		({ writeNetworkPolicyEvidence }) =>
			writeNetworkPolicyEvidence(directory, {
				namespace,
				namespaceUid: context.namespaceUid,
				kubeSystemNamespaceUid: context.clusterUid,
			}),
	);
	const json = async (name, value) => {
		const path = join(directory, name);
		await writeFile(path, JSON.stringify(value), { mode: 0o600 });
		return path;
	};
	const digest = "sha256:" + "b".repeat(64);
	const manifest = (name) => ({
		schemaVersion: 1,
		commitSha: context.sourceCommit,
		platform: "linux/amd64",
		images: {
			[name === "platform-worker" ? "platformWorker" : "codex"]: {
				repository: "ghcr.io/agoraio-extensions/agent-infra/" + name,
				digest,
			},
		},
	});
	const sdk = manifest("agent-runtime-codex");
	const platform = manifest("platform-worker");
	const image = sdk.images.codex.repository + "@" + digest;
	const workerImage = platform.images.platformWorker.repository + "@" + digest;
	const documents = parseAllDocuments(files.rendered).map((document) =>
		document.toJS(),
	);
	const worker = documents.find((doc) => doc.kind === "Deployment").spec
		.template.spec.containers[0];
	worker.image = workerImage;
	worker.env.push({
		name: "AGENT_INFRA_SIG_CORE_SDK_TRIAL_IMAGE",
		value: image,
	});
	documents.push({
		kind: "Deployment",
		metadata: { name: "agent-infra-api" },
		spec: {
			template: {
				spec: {
					containers: [
						{
							name: "platform-api",
							env: [
								{
									name: "PLATFORM_SIG_CORE_NEW_SESSIONS_NAMESPACE",
									value: namespace,
								},
							],
						},
					],
				},
			},
		},
	});
	const renderedPath = join(directory, "rendered.yaml");
	await writeFile(
		renderedPath,
		documents.map((doc) => stringify(doc)).join("---\n"),
	);
	const bootstrap = JSON.parse(
		await readFile(files.env.ACK_BOOTSTRAP_INPUTS_FILE),
	);
	await writeFile(
		files.env.ACK_BOOTSTRAP_INPUTS_FILE,
		JSON.stringify({ ...bootstrap, ...context }),
	);
	const responses = { ...files.responses };
	responses["namespace/" + namespace].metadata.labels = {
		"agent-infra.agora.io/bootstrap-id": context.installationId,
	};
	const stub = join(directory, "kubectl");
	await writeFile(
		stub,
		`#!/usr/bin/env node
const args=process.argv.slice(2), i=args.indexOf("get"), [kind,name]=args.slice(i+1);
if (i<0) process.exit(1);
const objects=JSON.parse(require("node:fs").readFileSync(process.env.OBSERVATIONS));
const result=objects[kind+"/"+name] ?? ((kind.includes(",") || kind === "pods" || kind === "sandboxes.agents.x-k8s.io") ? {items:[]} : undefined);
if (!result) process.exit(1); process.stdout.write(JSON.stringify(result));`,
		{ mode: 0o700 },
	);
	const env = {
		...files.env,
		PATH: process.env.PATH,
		ACK_NAMESPACE: namespace,
		ACK_SOURCE_SHA: context.sourceCommit,
		KUBECTL_BIN: stub,
		ACK_NETWORKPOLICY_EVIDENCE_FILE: "",
		ACK_RENDERED_MANIFEST_FILE: renderedPath,
		ACK_TRUSTED_TRIAL_TARGET_FILE: await json("target", context),
		ACK_IMAGE_MANIFEST: await json("platform", platform),
		ACK_TEMPLATE_IMAGE_MANIFEST: await json("templates", sdk),
		OBSERVATIONS: await json("observations", responses),
	};
	const run = (extra = {}, args = ["--codex-trial"]) =>
		spawnSync(
			process.execPath,
			[
				join(
					import.meta.dirname,
					"../deploy/ack/networkpolicy-enforcement.mjs",
				),
				...args,
			],
			{ env: { ...env, ...extra }, encoding: "utf8" },
		);
	const ok = run();
	assert.equal(ok.status, 0, ok.stderr);
	assert.equal(JSON.parse(ok.stdout).networkDataplaneVerified, false);
	assert.notEqual(run({}, []).status, 0);
	assert.notEqual(run({ ACK_NAMESPACE: "other" }).status, 0);
	assert.notEqual(
		run({
			ACK_TRUSTED_TRIAL_TARGET_FILE: await json("wrong-target", {
				...context,
				namespaceUid: uid(9),
			}),
		}).status,
		0,
	);
	assert.notEqual(
		run({ ACK_NETWORKPOLICY_EVIDENCE_FILE: await json("invalid", {}) }).status,
		0,
	);
	for (const name of ["native", "custom"]) {
		const objects = {
			...responses,
			"pods,deployments,replicasets/-l": {
				items: [
					{ kind: "Pod", spec: { containers: [{ ...worker, env: [] }] } },
				],
			},
		};
		const wrong = {
			...sdk,
			images: { codex: { ...sdk.images.codex, repository: name } },
		};
		assert.notEqual(
			run({ ACK_TEMPLATE_IMAGE_MANIFEST: await json(name, wrong) }).status,
			0,
		);
		assert.notEqual(
			run({ OBSERVATIONS: await json("old-worker", objects) }).status,
			0,
		);
	}
});
