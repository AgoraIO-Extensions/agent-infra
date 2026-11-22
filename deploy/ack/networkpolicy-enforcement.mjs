#!/usr/bin/env node
// Read-only NetworkPolicy enforcement gate (Engineering Spec §10.1, ADR-0049, #4351).
// It never creates probes or writes to the cluster; it only checks approved evidence.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseAllDocuments } from "yaml";
import {
	agentNetworkPolicyOwnerLabelV1,
	canonicalJsonValueV1,
	networkPolicySpecSha256V1,
	networkPolicySpecV1,
	networkPolicyTemplateDigestsV1,
	networkPolicyVariantsV1,
	parseNetworkPolicyDeploymentConfigV1,
	splitNetworkPolicyVariantV1,
} from "../../packages/platform-core/src/workload-network-policy.ts";

export { networkPolicySpecSha256V1 };

export const maxEvidenceAgeMs = 7 * 24 * 60 * 60 * 1000;
const ownerLabel = agentNetworkPolicyOwnerLabelV1;
// Written by the Worker with the placement it injected (apps/platform-worker agent-workload-placement.ts).
const placementAnnotation = "agent-infra.agora.io/agent-workload-placement";
const placementEnvironment = "AGENT_INFRA_AGENT_WORKLOAD_PLACEMENT";
const uidPattern =
	/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const namePattern = /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/;
const providerToleration = {
	key: "virtual-kubelet.io/provider",
	operator: "Equal",
	value: "alibabacloud",
	effect: "NoSchedule",
};
const blocked = new Set(["timeout", "refused", "reset"]);

export class NetworkPolicyEnforcementError extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}
const fail = (code) => {
	throw new NetworkPolicyEnforcementError(code);
};
const record = (value, keys, code) => {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
	)
		fail(code);
	return value;
};
const text = (value, pattern, code) => {
	if (typeof value !== "string" || !pattern.test(value)) fail(code);
	return value;
};
const instant = (value, code) => {
	const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
	if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
		fail(code);
	return time;
};
const canonical = canonicalJsonValueV1;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** The only Agent-level placement the Worker accepts (same as Session ECI admission). */
export function eciPlacementFieldsV1(architecture) {
	return {
		nodeSelector: { type: "virtual-kubelet", "kubernetes.io/arch": architecture },
		tolerations: [{ ...providerToleration }],
	};
}

/** Same rule as the Worker: a controller is judged by the placement recorded on it. */
function templateShape(item) {
	const spec = item.spec?.template?.spec;
	const record = item.metadata?.annotations?.[placementAnnotation];
	if (
		spec?.affinity !== undefined ||
		spec?.runtimeClassName !== undefined ||
		spec?.nodeName !== undefined
	)
		return { shape: "foreign" };
	const selector = spec?.nodeSelector ?? {};
	const tolerations = spec?.tolerations ?? [];
	if (record === undefined)
		return {
			shape:
				Object.keys(selector).length === 0 && tolerations.length === 0
					? "unplaced"
					: "foreign",
		};
	if (!["amd64", "arm64"].includes(record)) return { shape: "foreign" };
	const fields = eciPlacementFieldsV1(record);
	return same(selector, fields.nodeSelector) &&
		same(tolerations, fields.tolerations)
		? { shape: "placed", architecture: record }
		: { shape: "foreign" };
}

function tolerated(taint, tolerations) {
	return tolerations.some(
		(entry) =>
			entry.key === taint.key &&
			(entry.operator === "Exists" || entry.value === taint.value) &&
			(entry.effect === undefined || entry.effect === taint.effect),
	);
}

function renderedDocuments(renderedManifest) {
	if (typeof renderedManifest !== "string" || !renderedManifest)
		fail("RENDERED_MANIFEST_REQUIRED");
	try {
		return parseAllDocuments(renderedManifest).map((document) => {
			if (document.errors.length) throw new Error();
			return document.toJS();
		}).filter(Boolean);
	} catch {
		fail("RENDERED_MANIFEST_INVALID");
	}
}

/**
 * The placement the release will hand the Worker: its chart-rendered env, the
 * Worker's only placement source (it refuses a module-supplied one at startup).
 */
export function renderedWorkloadPlacementV1(renderedManifest, namespace) {
	const documents = renderedDocuments(renderedManifest);
	const workers = documents.filter(
		(item) =>
			item.kind === "Deployment" &&
			item.spec?.template?.metadata?.labels?.["app.kubernetes.io/component"] ===
				"platform-worker",
	);
	if (workers.length !== 1) fail("RENDERED_MANIFEST_INVALID");
	const container = workers[0].spec.template.spec?.containers?.find(
		(entry) => entry.name === "platform-worker",
	);
	const env = (container?.env ?? []).filter((entry) => entry.name === placementEnvironment);
	if (env.length === 0) fail("WORKER_PLACEMENT_MISSING");
	if (env.length !== 1 || typeof env[0].value !== "string" || env[0].valueFrom !== undefined)
		fail("WORKER_PLACEMENT_INVALID");
	let placement;
	try {
		placement = JSON.parse(env[0].value);
	} catch {
		fail("WORKER_PLACEMENT_INVALID");
	}
	record(placement, ["architecture", "legacyUnplaced"], "WORKER_PLACEMENT_INVALID");
	if (
		!["amd64", "arm64"].includes(placement.architecture) ||
		!["retain-until-lifecycle", "reject"].includes(placement.legacyUnplaced)
	)
		fail("WORKER_PLACEMENT_INVALID");
	const sessionArchitecture = assertSessionEciAdmissionRenderedV1(documents, namespace);
	return {
		placement,
		sessionArchitecture,
		deployment: workers[0].metadata?.name,
		worker: workers[0],
		documents,
	};
}

/** The chart must render the Session ECI admission, not a RuntimeClass branch. */
export function assertSessionEciAdmissionRenderedV1(input, namespace) {
	const documents = typeof input === "string" ? renderedDocuments(input) : input;
	const name = `${namespace}-session-eci`;
	const policies = documents.filter(
		(item) => item.kind === "MutatingAdmissionPolicy" && item.metadata?.name === name,
	);
	const bindings = documents.filter(
		(item) =>
			item.kind === "MutatingAdmissionPolicyBinding" &&
			item.spec?.policyName === name,
	);
	const policy = policies[0];
	const expressions = (policy?.spec?.mutations ?? []).map(
		(mutation) => mutation?.jsonPatch?.expression ?? "",
	);
	const scoped = (selector) =>
		selector?.objectSelector?.matchLabels?.["agent-infra.agora.io/managed"] ===
			"session-sandbox-v1" &&
		selector?.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] ===
			namespace;
	if (
		policies.length !== 1 ||
		bindings.length !== 1 ||
		policy.spec?.failurePolicy !== "Fail" ||
		!scoped(policy.spec?.matchConstraints) ||
		!scoped(bindings[0].spec?.matchResources) ||
		expressions.length !== 1 ||
		!expressions[0].includes('path:"/spec/nodeSelector/type",value:"virtual-kubelet"') ||
		!expressions[0].includes('"key":"virtual-kubelet.io/provider"') ||
		expressions[0].includes('path:"/spec/runtimeClassName"')
	)
		fail("SESSION_PLACEMENT_UNPROVEN");
	const architectures = [
		...expressions[0].matchAll(
			/path:"\/spec\/nodeSelector\/kubernetes\.io~1arch",value:"([a-z0-9]+)"/gu,
		),
	].map((match) => match[1]);
	if (architectures.length !== 1 || !["amd64", "arm64"].includes(architectures[0]))
		fail("SESSION_PLACEMENT_UNPROVEN");
	return architectures[0];
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hex64 = /^[a-f0-9]{64}$/;
const labelMap = (value, code) => {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length > 64 ||
		Object.values(value).some((label) => typeof label !== "string")
	)
		fail(code);
	return value;
};

/** SHA-256 of the normalized Worker placement fields (`placement.selectorSha256`). */
export function placementSelectorSha256V1(architecture) {
	return sha256(JSON.stringify(canonical(eciPlacementFieldsV1(architecture))));
}

/**
 * Full Kubernetes LabelSelector semantics (matchLabels and matchExpressions) over a
 * label set. A selector this code cannot judge counts as satisfied, so the probe
 * labels are rejected rather than waved through (#4383 R4 S3).
 */
export function labelsSatisfySelectorV1(labels, selector) {
	if (!selector || typeof selector !== "object") return true;
	const hasShape = "matchLabels" in selector || "matchExpressions" in selector;
	const matchLabels = hasShape ? selector.matchLabels : selector;
	const expressions = hasShape ? selector.matchExpressions : undefined;
	if (matchLabels !== undefined) {
		if (!matchLabels || typeof matchLabels !== "object" || Array.isArray(matchLabels))
			return true;
		for (const [key, value] of Object.entries(matchLabels))
			if (labels[key] !== value) return false;
	}
	for (const expression of expressions ?? []) {
		const values = Array.isArray(expression?.values) ? expression.values : [];
		const present = Object.hasOwn(labels, expression?.key);
		switch (expression?.operator) {
			case "In":
				if (!present || !values.includes(labels[expression.key])) return false;
				break;
			case "NotIn":
				if (present && values.includes(labels[expression.key])) return false;
				break;
			case "Exists":
				if (!present) return false;
				break;
			case "DoesNotExist":
				if (present) return false;
				break;
			default:
				return true;
		}
	}
	return true;
}

const variantSubstitutionKeys = (variant) => {
	const { base } = splitNetworkPolicyVariantV1(variant);
	if (base === "multi-service-migration") return ["agentSelector"];
	if (base.startsWith("multi-service-")) return ["agentSelector", "service"];
	return ["agentSelector", "port", "workerSource"];
};

function parseEvidence(value) {
	const evidence = record(
		value,
		[
			"schemaVersion",
			"kind",
			"cluster",
			"namespace",
			"enforcer",
			"placement",
			"nodes",
			"probes",
			"networkPolicy",
			"observedAt",
			"expiresAt",
		],
		"EVIDENCE_INVALID",
	);
	if (
		evidence.schemaVersion !== 1 ||
		evidence.kind !== "agent-infra-networkpolicy-enforcement-evidence"
	)
		fail("EVIDENCE_INVALID");
	record(evidence.cluster, ["kubeSystemNamespaceUid", "clusterId"], "EVIDENCE_INVALID");
	text(evidence.cluster.kubeSystemNamespaceUid, uidPattern, "EVIDENCE_INVALID");
	text(evidence.cluster.clusterId, /^[A-Za-z0-9-]{1,64}$/, "EVIDENCE_INVALID");
	record(evidence.namespace, ["name", "uid"], "EVIDENCE_INVALID");
	text(evidence.namespace.name, /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/, "EVIDENCE_INVALID");
	text(evidence.namespace.uid, uidPattern, "EVIDENCE_INVALID");
	// The managed Poseidon configuration is unobservable; there is no readback to bind.
	record(evidence.enforcer, ["runtime", "component", "version"], "EVIDENCE_INVALID");
	if (evidence.enforcer.version !== "unobservable") fail("EVIDENCE_INVALID");
	record(
		evidence.placement,
		["architecture", "legacyUnplaced", "selectorSha256"],
		"EVIDENCE_INVALID",
	);
	text(evidence.placement.selectorSha256, hex64, "EVIDENCE_INVALID");
	if (
		!["amd64", "arm64"].includes(evidence.placement.architecture) ||
		!["retain-until-lifecycle", "reject"].includes(
			evidence.placement.legacyUnplaced,
		)
	)
		fail("EVIDENCE_INVALID");
	for (const list of [evidence.nodes, evidence.probes])
		if (!Array.isArray(list) || list.length > 512) fail("EVIDENCE_INVALID");
	for (const node of evidence.nodes) {
		record(node, ["name", "uid"], "EVIDENCE_INVALID");
		text(node.name, namePattern, "EVIDENCE_INVALID");
		text(node.uid, uidPattern, "EVIDENCE_INVALID");
	}
	record(evidence.networkPolicy, ["templateSha256"], "EVIDENCE_INVALID");
	labelMap(evidence.networkPolicy.templateSha256, "EVIDENCE_INVALID");
	for (const digest of Object.values(evidence.networkPolicy.templateSha256))
		text(digest, hex64, "EVIDENCE_INVALID");
	for (const probe of evidence.probes) {
		record(
			probe,
			["destination", "policy", "allow", "deny", "recovery", "nonWorker"],
			"EVIDENCE_INVALID",
		);
		record(
			probe.destination,
			["pod", "uid", "nodeName", "port", "controller"],
			"EVIDENCE_INVALID",
		);
		text(probe.destination.pod, namePattern, "EVIDENCE_INVALID");
		text(probe.destination.uid, uidPattern, "EVIDENCE_INVALID");
		text(probe.destination.nodeName, namePattern, "EVIDENCE_INVALID");
		if (
			!Number.isSafeInteger(probe.destination.port) ||
			probe.destination.port < 1 ||
			probe.destination.port > 65_535
		)
			fail("EVIDENCE_INVALID");
		record(probe.destination.controller, ["kind", "name", "uid"], "EVIDENCE_INVALID");
		if (!["StatefulSet", "Deployment", "Job"].includes(probe.destination.controller.kind))
			fail("EVIDENCE_INVALID");
		text(probe.destination.controller.name, namePattern, "EVIDENCE_INVALID");
		text(probe.destination.controller.uid, uidPattern, "EVIDENCE_INVALID");
		record(
			probe.policy,
			[
				"name",
				"uid",
				"variant",
				"substitutions",
				"podLabels",
				"instantiatedSha256",
			],
			"EVIDENCE_INVALID",
		);
		text(probe.policy.name, namePattern, "EVIDENCE_INVALID");
		text(probe.policy.uid, uidPattern, "EVIDENCE_INVALID");
		text(probe.policy.instantiatedSha256, hex64, "EVIDENCE_INVALID");
		if (typeof probe.policy.variant !== "string") fail("EVIDENCE_INVALID");
		try {
			splitNetworkPolicyVariantV1(probe.policy.variant);
		} catch {
			fail("PROBE_POLICY_MISMATCH");
		}
		const substitutions = record(
			probe.policy.substitutions,
			variantSubstitutionKeys(probe.policy.variant),
			"PROBE_SUBSTITUTION_INVALID",
		);
		record(substitutions.agentSelector, ["key", "value"], "PROBE_SUBSTITUTION_INVALID");
		if (
			typeof substitutions.agentSelector.key !== "string" ||
			typeof substitutions.agentSelector.value !== "string" ||
			!substitutions.agentSelector.key ||
			!substitutions.agentSelector.value
		)
			fail("PROBE_SUBSTITUTION_INVALID");
		if ("workerSource" in substitutions) {
			labelMap(substitutions.workerSource, "PROBE_SUBSTITUTION_INVALID");
			if (Object.keys(substitutions.workerSource).length === 0)
				fail("PROBE_SUBSTITUTION_INVALID");
		}
		if (
			"port" in substitutions &&
			(!Number.isSafeInteger(substitutions.port) ||
				substitutions.port < 1 ||
				substitutions.port > 65_535)
		)
			fail("PROBE_SUBSTITUTION_INVALID");
		if (
			"service" in substitutions &&
			(typeof substitutions.service !== "string" || !substitutions.service)
		)
			fail("PROBE_SUBSTITUTION_INVALID");
		record(
			probe.policy.podLabels,
			["target", "workerSource", "nonWorkerSource"],
			"EVIDENCE_INVALID",
		);
		for (const labels of Object.values(probe.policy.podLabels))
			labelMap(labels, "EVIDENCE_INVALID");
		for (const step of ["allow", "recovery", "nonWorker"])
			if (probe[step] !== null) record(probe[step], ["at", "outcome"], "EVIDENCE_INVALID");
		if (probe.deny !== null)
			record(probe.deny, ["at", "outcome", "policyUid"], "EVIDENCE_INVALID");
	}
	return evidence;
}

/** The Worker pod labels, rendered Deployment selector and every Service that selects the Worker. */
function workerSelectors(rendered) {
	const podLabels = rendered.worker.spec?.template?.metadata?.labels ?? {};
	const selectors = [];
	const deploymentSelector = rendered.worker.spec?.selector;
	if (deploymentSelector === undefined) fail("RENDERED_MANIFEST_INVALID");
	selectors.push(deploymentSelector);
	for (const item of rendered.documents) {
		if (item.kind !== "Service") continue;
		const selector = item.spec?.selector;
		if (
			selector &&
			typeof selector === "object" &&
			Object.keys(selector).length > 0 &&
			labelsSatisfySelectorV1(podLabels, selector)
		)
			selectors.push(selector);
	}
	return { podLabels, selectors };
}

/**
 * Pure gate. `observed` comes from read-only `kubectl get`; any failure to read it
 * is reported by the caller as READ_FAILED. Returns a credential-free summary.
 */
export function validateNetworkPolicyEnforcementV1({
	evidence: input,
	deploymentConfig: configInput,
	renderedManifest,
	observed,
	now = Date.now(),
}) {
	const evidence = parseEvidence(input);
	const rendered = renderedWorkloadPlacementV1(
		renderedManifest,
		evidence.namespace.name,
	);
	if (
		rendered.placement.architecture !== evidence.placement.architecture ||
		rendered.placement.legacyUnplaced !== evidence.placement.legacyUnplaced
	)
		fail("WORKER_PLACEMENT_MISMATCH");
	// The selector and toleration digest must match what the Worker injects.
	if (
		placementSelectorSha256V1(rendered.placement.architecture) !==
		evidence.placement.selectorSha256
	)
		fail("PLACEMENT_SELECTOR_MISMATCH");
	// Session Sandboxes use the same selector and toleration; with the same
	// architecture their candidate nodes are exactly the proven Agent candidates.
	if (rendered.sessionArchitecture !== evidence.placement.architecture)
		fail("SESSION_PLACEMENT_MISMATCH");
	if (evidence.enforcer.runtime !== "eci" || evidence.enforcer.component !== "poseidon")
		fail("ENFORCER_UNSUPPORTED");

	const observedAt = instant(evidence.observedAt, "EVIDENCE_INVALID");
	const expiresAt = instant(evidence.expiresAt, "EVIDENCE_INVALID");
	if (observedAt > now || expiresAt <= observedAt) fail("EVIDENCE_INVALID");
	if (
		now >= expiresAt ||
		now - observedAt > maxEvidenceAgeMs ||
		expiresAt - observedAt > maxEvidenceAgeMs
	)
		fail("EVIDENCE_EXPIRED");

	if (
		observed.kubeSystemNamespaceUid !== evidence.cluster.kubeSystemNamespaceUid ||
		observed.namespace?.name !== evidence.namespace.name ||
		observed.namespace?.uid !== evidence.namespace.uid
	)
		fail("EVIDENCE_SCOPE_MISMATCH");

	const fields = eciPlacementFieldsV1(evidence.placement.architecture);
	const candidates = (observed.nodes ?? []).filter((node) => {
		const labels = node.metadata?.labels ?? {};
		return (
			Object.entries(fields.nodeSelector).every(([key, value]) => labels[key] === value) &&
			(node.spec?.taints ?? [])
				.filter((taint) => taint.effect === "NoSchedule" || taint.effect === "NoExecute")
				.every((taint) => tolerated(taint, fields.tolerations))
		);
	});
	if (candidates.length === 0) fail("NO_CANDIDATE_NODE");
	const proven = new Map(evidence.nodes.map((node) => [node.name, node.uid]));
	for (const node of candidates) {
		const name = node.metadata?.name;
		if (!proven.has(name)) fail("CANDIDATE_NODE_UNPROVEN");
		if (proven.get(name) !== node.metadata?.uid) fail("CANDIDATE_NODE_DRIFT");
		if (
			!(node.spec?.taints ?? []).some(
				(taint) =>
					taint.key === providerToleration.key &&
					taint.value === providerToleration.value &&
					taint.effect === providerToleration.effect,
			)
		)
			fail("CANDIDATE_NODE_UNPROVEN");
	}
	if (proven.size !== candidates.length) fail("CANDIDATE_NODE_DRIFT");

	// The NetworkPolicy deployment configuration the Worker renders from, digested
	// through the Worker's own pure function (Spec §10.1 "NetworkPolicy 规范化模板").
	if (configInput === undefined) fail("NETWORKPOLICY_CONFIG_REQUIRED");
	let config;
	try {
		config = parseNetworkPolicyDeploymentConfigV1(configInput);
	} catch {
		fail("NETWORKPOLICY_CONFIG_INVALID");
	}
	const { podLabels: workerPodLabels, selectors: workerPodSelectors } =
		workerSelectors(rendered);
	if (!labelsSatisfySelectorV1(workerPodLabels, config.workerSelector))
		fail("WORKER_SELECTOR_MISMATCH");
	const templates = networkPolicyTemplateDigestsV1(config);
	const recorded = evidence.networkPolicy.templateSha256;
	if (
		!same(Object.keys(templates).sort(), Object.keys(recorded).sort()) ||
		Object.entries(templates).some(([variant, digest]) => recorded[variant] !== digest)
	)
		fail("NETWORKPOLICY_TEMPLATE_MISMATCH");

	// Selectors no probe Pod may satisfy: production Worker selection, and every
	// same-namespace ingress source of the template (#4383 R4 S1).
	const forbidden = [
		config.workerSelector,
		...workerPodSelectors,
		config.platformApiSelector,
		...(config.routeNamespace === evidence.namespace.name
			? [config.routeSelector]
			: []),
	].filter((selector) => selector !== undefined);
	const forbiddenLabels = (labels) =>
		Object.hasOwn(labels, ownerLabel) ||
		forbidden.some((selector) => labelsSatisfySelectorV1(labels, selector));

	if (evidence.probes.length === 0) fail("PROBE_POSITIVE_MISSING");
	const variants = new Set(networkPolicyVariantsV1(config));
	const candidateNames = new Set(candidates.map((node) => node.metadata?.name));
	for (const probe of evidence.probes) {
		if (!candidateNames.has(probe.destination.nodeName)) fail("PROBE_SCOPE_MISMATCH");
		const { variant, substitutions, podLabels } = probe.policy;
		if (!variants.has(variant)) fail("PROBE_POLICY_MISMATCH");
		// The probe policy must not select, or be selected through, production labels.
		if (substitutions.agentSelector.key === ownerLabel)
			fail("PROBE_SUBSTITUTION_INVALID");
		if ("port" in substitutions && substitutions.port !== probe.destination.port)
			fail("PROBE_SUBSTITUTION_INVALID");
		let instantiated;
		try {
			instantiated = networkPolicySpecSha256V1(
				networkPolicySpecV1({ variant, config, substitutions }),
			);
		} catch {
			fail("PROBE_SUBSTITUTION_INVALID");
		}
		if (instantiated !== probe.policy.instantiatedSha256)
			fail("PROBE_POLICY_MISMATCH");
		for (const labels of Object.values(podLabels))
			if (forbiddenLabels(labels)) fail("PROBE_LABELS_FORBIDDEN");
		const { agentSelector } = substitutions;
		if (
			podLabels.target[agentSelector.key] !== agentSelector.value ||
			("workerSource" in substitutions &&
				(!labelsSatisfySelectorV1(podLabels.workerSource, substitutions.workerSource) ||
					labelsSatisfySelectorV1(podLabels.nonWorkerSource, substitutions.workerSource)))
		)
			fail("PROBE_LABELS_INCONSISTENT");
		if (
			probe.allow?.outcome !== "connected" ||
			probe.recovery?.outcome !== "connected"
		)
			fail("PROBE_POSITIVE_MISSING");
		if (!probe.deny || probe.deny.outcome === "connected")
			fail("ENFORCEMENT_NOT_OBSERVED");
		if (!blocked.has(probe.deny.outcome)) fail("EVIDENCE_INVALID");
		text(probe.deny.policyUid, uidPattern, "EVIDENCE_INVALID");
		if (!probe.nonWorker) fail("PROBE_NEGATIVE_MISSING");
		if (probe.nonWorker.outcome === "connected") fail("NON_WORKER_REACHABLE");
		if (!blocked.has(probe.nonWorker.outcome)) fail("EVIDENCE_INVALID");
		const allow = instant(probe.allow.at, "EVIDENCE_INVALID");
		const deny = instant(probe.deny.at, "EVIDENCE_INVALID");
		const recovery = instant(probe.recovery.at, "EVIDENCE_INVALID");
		const nonWorker = instant(probe.nonWorker.at, "EVIDENCE_INVALID");
		if (
			!(allow < deny && deny < recovery) ||
			[allow, deny, recovery, nonWorker].some(
				(time) => time > observedAt || observedAt - time > maxEvidenceAgeMs,
			)
		)
			fail("PROBE_ORDER_INVALID");
	}

	// Every node a target may land on needs its own allow→deny→recovery result.
	const probedNodes = new Set(evidence.probes.map((probe) => probe.destination.nodeName));
	if ([...candidateNames].some((name) => !probedNodes.has(name)))
		fail("CANDIDATE_NODE_UNPROBED");

	// The live Agent-level controllers are checked statically; they need not be
	// listed in the evidence, and the probe Pods are gone by now.
	const controllers = observed.controllers ?? [];
	let placed = 0;
	let legacyActive = 0;
	for (const item of controllers) {
		const { kind } = item;
		const { shape, architecture } = templateShape(item);
		if (shape === "foreign") fail("FOREIGN_PLACEMENT");
		if (shape === "placed") {
			// Its candidate nodes are only proven for the evidence architecture.
			if (architecture !== evidence.placement.architecture)
				fail("TARGET_PLACEMENT_UNPROVEN");
			placed++;
			continue;
		}
		const active =
			kind === "Job"
				? !((item.status?.succeeded ?? 0) > 0)
				: (item.spec?.replicas ?? 1) > 0;
		if (active) legacyActive++;
	}
	if (evidence.placement.legacyUnplaced === "reject" && legacyActive > 0)
		fail("LEGACY_UNPLACED_REMAINS");
	return {
		status: "passed",
		scope: "networkpolicy-enforcement",
		namespaceUidSha256: sha256(evidence.namespace.uid),
		enforcer: {
			runtime: "eci",
			component: "poseidon",
			version: evidence.enforcer.version,
		},
		placement: evidence.placement,
		workerPlacementSource: {
			deployment: rendered.deployment,
			env: placementEnvironment,
			renderedManifestSha256: sha256(renderedManifest),
		},
		networkPolicyTemplates: templates,
		candidateNodes: candidates.length,
		probes: evidence.probes.length,
		targets: controllers.length,
		placedTargets: placed,
		legacyUnplacedActiveTargets: legacyActive,
		allAgentWorkloadsOnEnforcedForm: legacyActive === 0,
		expiresAt: evidence.expiresAt,
		fieldAcceptanceSigned: false,
	};
}

function collect(namespace, kubectl) {
	const read = (args) => {
		try {
			return JSON.parse(kubectl(args));
		} catch {
			fail("READ_FAILED");
		}
	};
	const namespaceObject = read(["get", "namespace", namespace, "-o", "json"]);
	const kubeSystem = read(["get", "namespace", "kube-system", "-o", "json"]);
	const nodes = read(["get", "nodes", "-o", "json"]);
	const controllers = read([
		"get",
		"statefulsets,deployments,jobs",
		"-l",
		ownerLabel,
		"-o",
		"json",
	]);
	if (!Array.isArray(nodes?.items) || !Array.isArray(controllers?.items))
		fail("READ_FAILED");
	return {
		namespace: { name: namespaceObject?.metadata?.name, uid: namespaceObject?.metadata?.uid },
		kubeSystemNamespaceUid: kubeSystem?.metadata?.uid,
		nodes: nodes.items,
		controllers: controllers.items,
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const namespace = process.env.ACK_NAMESPACE ?? "agent-infra";
	try {
		const evidenceFile = process.env.ACK_NETWORKPOLICY_EVIDENCE_FILE;
		const configFile = process.env.ACK_NETWORKPOLICY_DEPLOYMENT_CONFIG_FILE;
		if (!evidenceFile) fail("EVIDENCE_REQUIRED");
		let evidence;
		try {
			evidence = JSON.parse(readFileSync(evidenceFile, "utf8"));
		} catch {
			fail("EVIDENCE_INVALID");
		}
		if (!configFile) fail("NETWORKPOLICY_CONFIG_REQUIRED");
		let deploymentConfig;
		try {
			deploymentConfig = JSON.parse(readFileSync(configFile, "utf8"));
		} catch {
			fail("NETWORKPOLICY_CONFIG_INVALID");
		}
		let renderedManifest;
		try {
			renderedManifest = process.env.ACK_RENDERED_MANIFEST_FILE
				? readFileSync(process.env.ACK_RENDERED_MANIFEST_FILE, "utf8")
				: undefined;
		} catch {
			fail("RENDERED_MANIFEST_REQUIRED");
		}
		if (!renderedManifest) fail("RENDERED_MANIFEST_REQUIRED");
		const kubectl = (args) =>
			execFileSync(process.env.KUBECTL_BIN ?? "kubectl", [
				"--request-timeout=20s",
				"--namespace",
				namespace,
				...args,
			], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
		const summary = validateNetworkPolicyEnforcementV1({
			evidence,
			deploymentConfig,
			renderedManifest,
			observed: collect(namespace, kubectl),
		});
		process.stdout.write(`${JSON.stringify(summary)}\n`);
	} catch (error) {
		const code =
			error instanceof NetworkPolicyEnforcementError ? error.code : "READ_FAILED";
		process.stderr.write(
			`${JSON.stringify({ status: "failed", scope: "networkpolicy-enforcement", code })}\n`,
		);
		process.exitCode = 2;
	}
}
