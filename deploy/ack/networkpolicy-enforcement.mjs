#!/usr/bin/env node
// Read-only NetworkPolicy enforcement gate (Engineering Spec §10.1, ADR-0049, #4351).
// It never creates probes or writes to the cluster; it only checks approved evidence.
import { activeWorkerSpecs } from "./active-codex-trial.ts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseAllDocuments } from "yaml";
import { privateJson } from "./private-input.ts";
import { configurationMount, workerConfigurationBytes } from "./configuration-source-preflight.ts";
import {
	agentNetworkPolicyOwnerLabelV1,
	canonicalJsonValueV1,
	networkPolicyEvidenceSha256V1,
	networkPolicySpecSha256V1,
	networkPolicySpecV1,
	networkPolicyTemplateDigestsV1,
	networkPolicyVariantsV1,
	parseNetworkPolicyDeploymentConfigV1,
	resolveWorkerEffectiveEgressV1,
	splitNetworkPolicyVariantV1,
} from "../../packages/platform-core/src/workload-network-policy.ts";

import {
	acsPodMetadataV1,
	validateSessionRuntimePlacementV1,
} from "../../packages/platform-core/src/workload-resource-configuration.ts";

export { networkPolicySpecSha256V1 };

export function matchesComputeLabelsV1(compute, labels) {
	return Object.entries(acsPodMetadataV1("acs").labels).every(
		([key, value]) => labels?.[key] === (compute === "acs" ? value : undefined),
	);
}

const defaultComputes = { agent: "eci", session: "eci" };
export function probedRuntime(probes) {
	const providers = new Set(probes.map((probe) => probe.destination.compute ?? "eci"));
	return providers.size > 1 ? "mixed" : [...providers][0];
}
function validateComputes(value) {
	record(value, ["agent", "session"], "EVIDENCE_INVALID");
	if (Object.values(value).some((compute) => !["eci", "acs"].includes(compute)))
		fail("EVIDENCE_INVALID");
	return value;
}

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
	constructor(code, facts) {
		super(code);
		this.code = code;
		this.facts = facts;
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
const same = (a, b) =>
	JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** The only Agent-level placement the Worker accepts (same as Session ECI admission). */
export function eciPlacementFieldsV1(architecture) {
	return {
		nodeSelector: {
			type: "virtual-kubelet",
			"kubernetes.io/arch": architecture,
		},
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
	const compute = record === "acs:amd64" ? "acs" : "eci";
	const architecture = compute === "acs" ? "amd64" : record;
	if (!["amd64", "arm64"].includes(architecture)) return { shape: "foreign" };
	const metadata = item.spec?.template?.metadata;
	if (
		!matchesComputeLabelsV1(compute, metadata?.labels) ||
		Object.entries(acsPodMetadataV1(compute).annotations).some(
			([key, value]) => metadata?.annotations?.[key] !== value,
		)
	)
		return { shape: "foreign" };
	const fields = eciPlacementFieldsV1(architecture);
	return same(selector, fields.nodeSelector) &&
		same(tolerations, fields.tolerations)
		? { shape: "placed", architecture, compute }
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

/** Nodes the Worker's Agent-level placement can land on (the probes' scope). */
export function eciCandidateNodesV1(nodes, architecture) {
	const fields = eciPlacementFieldsV1(architecture);
	return nodes.filter((node) => {
		const labels = node.metadata?.labels ?? {};
		return (
			Object.entries(fields.nodeSelector).every(
				([key, value]) => labels[key] === value,
			) &&
			(node.spec?.taints ?? [])
				.filter(
					(taint) =>
						taint.effect === "NoSchedule" || taint.effect === "NoExecute",
				)
				.every((taint) => tolerated(taint, fields.tolerations))
		);
	});
}

function renderedDocuments(renderedManifest) {
	if (typeof renderedManifest !== "string" || !renderedManifest)
		fail("RENDERED_MANIFEST_REQUIRED");
	try {
		return parseAllDocuments(renderedManifest)
			.map((document) => {
				if (document.errors.length) throw new Error();
				return document.toJS();
			})
			.filter(Boolean);
	} catch {
		fail("RENDERED_MANIFEST_INVALID");
	}
}

/** Read only the deployment-owned values that the named Worker receives. */
function workerComputePlacementV1(spec) {
	const containers = spec?.containers?.filter((entry) => entry.name === "platform-worker");
	if (containers?.length !== 1) fail("WORKER_PLACEMENT_INVALID");
	const container = containers[0];
	const env = (container.env ?? []).filter((entry) => entry.name === placementEnvironment);
	let placement;
	if (env.length) {
		if (
			env.length !== 1 ||
			typeof env[0].value !== "string" ||
			env[0].valueFrom !== undefined
		)
			fail("WORKER_PLACEMENT_INVALID");
		try {
			placement = JSON.parse(env[0].value);
		} catch {
			fail("WORKER_PLACEMENT_INVALID");
		}
		record(
			placement,
			[
				"architecture",
				"legacyUnplaced",
				...(placement.compute === undefined ? [] : ["compute"]),
			],
			"WORKER_PLACEMENT_INVALID",
		);
		if (
			!["amd64", "arm64"].includes(placement.architecture) ||
			(placement.compute !== undefined &&
				!["eci", "acs"].includes(placement.compute)) ||
			(placement.compute === "acs" && placement.architecture !== "amd64") ||
			!["retain-until-lifecycle", "reject"].includes(placement.legacyUnplaced)
		)
			fail("WORKER_PLACEMENT_INVALID");
	}
	const sessionEnv = (container?.env ?? []).filter(
		(entry) => entry.name === "AGENT_INFRA_SESSION_RUNTIME_PLACEMENT",
	);
	if (sessionEnv.length > 1) fail("SESSION_PLACEMENT_UNPROVEN");
	let sessionPlacement;
	if (sessionEnv.length) {
		try {
			if (typeof sessionEnv[0].value !== "string" || sessionEnv[0].valueFrom)
				throw new Error();
			sessionPlacement = JSON.parse(sessionEnv[0].value);
			validateSessionRuntimePlacementV1(sessionPlacement);
			if (!sessionPlacement) throw new Error();
		} catch {
			fail("SESSION_PLACEMENT_UNPROVEN");
		}
	}
	return { placement, sessionPlacement };
}

/** ACS supports new standard Codex SDK workloads only. Legacy deployments still qualify all templates. */
export function renderedCodexAcsPlacementV1(renderedManifest, namespace) {
	const documents = renderedDocuments(renderedManifest);
	const workers = documents.filter((item) =>
		item.kind === "Deployment" && item.metadata?.name === "agent-infra-worker");
	if (workers.length !== 1) fail("RENDERED_MANIFEST_INVALID");
	const compute = codexAcsPlacementV1(workers[0], namespace);
	if (compute) {
		if (assertSessionEciAdmissionRenderedV1(documents, namespace, compute.session) !== "amd64") fail("SESSION_PLACEMENT_UNPROVEN");
		const name = namespace + "-agent-workload-eci";
		for (const kind of ["ValidatingAdmissionPolicy", "ValidatingAdmissionPolicyBinding"])
			if (documents.filter(d => d.kind === kind && d.metadata?.name === name).length !== 1) fail("WORKER_PLACEMENT_INVALID");
	}
	return compute;
}

export function codexAcsPlacementV1(worker, namespace) {
	const { placement, sessionPlacement } = workerComputePlacementV1(worker.spec?.template?.spec);
	if (placement?.compute !== "acs" && !sessionPlacement) return undefined;
	if (!placement || placement.architecture !== "amd64" || (worker.metadata.namespace && worker.metadata.namespace !== namespace) ||
		importsEnvironment(worker.spec.template.spec.containers.find((c) => c.name === "platform-worker"), [placementEnvironment, "AGENT_INFRA_SESSION_RUNTIME_PLACEMENT"]))
		fail("WORKER_PLACEMENT_INVALID");
	return { agent: placement?.compute ?? "eci", session: sessionPlacement?.compute ?? "eci" };
}

// Ordinary releases enforce this set on CREATE, including re-creation from a
// persisted allocation whose Session Pod no longer exists.
export function admittedSessionComputes(documents, namespace) {
	const name = `${namespace}-session-network-compute`;
	const one = (kind) => {
		const found = documents.filter((doc) => doc.kind === kind && doc.metadata?.name === name);
		return found.length === 1 ? found[0].spec : undefined;
	};
	const policy = one("ValidatingAdmissionPolicy");
	const binding = one("ValidatingAdmissionPolicyBinding");
	const scope = {
		namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": namespace } },
		objectSelector: { matchLabels: { "agent-infra.agora.io/managed": "session-sandbox-v1" } },
	};
	const rules = [{ apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE"], resources: ["pods"] }];
	if (!policy && !binding) return undefined;
	if (policy?.failurePolicy !== "Fail" || policy.matchConditions?.length || binding?.policyName !== name ||
		!same(binding.validationActions, ["Deny"]) || !same(binding.matchResources, scope) ||
		!same(policy.matchConstraints, { ...scope, resourceRules: rules }) || policy.validations?.length !== 1)
		fail("SESSION_COMPUTE_ADMISSION_UNPROVEN");
	for (const computes of [["eci"], ["acs"], ["eci", "acs"]]) {
		const expression = '(("alibabacloud.com/acs" in object.metadata.labels && object.metadata.labels["alibabacloud.com/acs"] == "true") ? "acs" : "eci") in ' + JSON.stringify(computes);
		if (policy.validations[0].expression === expression) return computes;
	}
	fail("SESSION_COMPUTE_ADMISSION_UNPROVEN");
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
	const { placement, sessionPlacement } = workerComputePlacementV1(workers[0].spec.template.spec);
	if (!placement) fail("WORKER_PLACEMENT_MISSING");
	const computes = {
		agent: placement.compute ?? "eci",
		session: sessionPlacement?.compute ?? "eci",
	};
	const sessionArchitecture = assertSessionEciAdmissionRenderedV1(
		documents,
		namespace,
		computes.session,
	);
	if (sessionPlacement && sessionPlacement.architecture !== sessionArchitecture)
		fail("SESSION_PLACEMENT_UNPROVEN");
	return {
		placement,
		computes,
		sessionAdmission: admittedSessionComputes(documents, namespace),
		requiredComputes: workerBackends(workers[0].spec.template.spec, computes),
		sessionArchitecture,
		deployment: workers[0].metadata?.name,
		worker: workers[0],
		documents,
	};
}

// Retained Pi maintenance work uses ECI even when both Codex roles select ACS.
function workerBackends(spec, computes) {
	const worker = spec.containers.find((container) => container.name === "platform-worker");
	const maintenance = worker.env?.some((entry) =>
		["PLATFORM_MAINTENANCE_IMAGE", "PLATFORM_MAINTENANCE_CONSUMER_IMAGE"].includes(entry.name) &&
		(entry.valueFrom !== undefined || Boolean(entry.value)));
	return [...new Set([...Object.values(computes), ...(maintenance ? ["eci"] : [])])];
}

function liveRolloutWorkerSpecs(writers) {
	if (!Array.isArray(writers)) fail("ACS_WORKER_OBSERVATION_REQUIRED");
	// The candidate Deployment is checked separately. A fully drained Deployment
	// is no longer a writer, while its terminating Pods or ReplicaSets still count.
	return activeWorkerSpecs(writers.filter((item) =>
		item.kind !== "Deployment" || item.spec?.replicas !== 0 || (item.status?.replicas ?? 0) > 0));
}

/** Include writers that can still create workloads during an ACS rollout. */
export function acsRolloutBackends(rendered, writers, sessions = []) {
	const active = liveRolloutWorkerSpecs(writers);
	const placements = active.map((spec) => {
		const { placement, sessionPlacement } = workerComputePlacementV1(spec);
		const worker = spec.containers.find((container) => container.name === "platform-worker");
		if (importsEnvironment(worker, [placementEnvironment, "AGENT_INFRA_SESSION_RUNTIME_PLACEMENT", "PLATFORM_MAINTENANCE_IMAGE", "PLATFORM_MAINTENANCE_CONSUMER_IMAGE"]))
			fail("ACS_WORKER_PLACEMENT_UNPROVEN");
		return { spec, placement, sessionPlacement };
	});
	const backends = new Set([...rendered.requiredComputes, ...(rendered.sessionAdmission ?? [])]);
	for (const { spec, placement, sessionPlacement } of placements) {
		for (const compute of workerBackends(spec, {
			agent: placement?.compute ?? "eci",
			session: sessionPlacement?.compute ?? "eci",
		})) backends.add(compute);
	}
	for (const resource of sessions) {
		if (resource.kind === "Pod" && ["Succeeded", "Failed"].includes(resource.status?.phase)) continue;
		const metadata = resource.kind === "Pod" ? resource.metadata : resource.spec?.template?.metadata;
		const labels = metadata?.labels;
		if (labels?.["agent-infra.agora.io/managed"] !== "session-sandbox-v1") fail("SESSION_PLACEMENT_UNPROVEN");
		const compute = labels["alibabacloud.com/acs"] === "true" ? "acs" : "eci";
		if (!matchesComputeLabelsV1(compute, labels)) fail("SESSION_PLACEMENT_UNPROVEN");
		backends.add(compute);
	}
	if (backends.has("acs") && placements.some(({ placement, sessionPlacement }) =>
		!placement || placement.architecture !== rendered.placement.architecture ||
		(sessionPlacement && sessionPlacement.architecture !== rendered.sessionArchitecture)))
		fail("ACS_WORKER_PLACEMENT_UNPROVEN");
	return [...backends];
}

// The running image and the bytes mounted at process start must support the
// same network template. A mutable Secret cannot attest an old subPath mount.
function checkRolloutWorkerSources(rendered, observed, workerConfigurationSha256, namespace) {
	const spec = rendered.worker.spec.template.spec;
	const candidate = spec.containers.find((c) => c.name === "platform-worker");
	const env = workerNetworkEnvironmentV1(candidate, namespace);
	for (const item of observed.workers) {
		const [active] = liveRolloutWorkerSpecs([item]);
		if (!active) continue;
		const worker = active.containers.find((c) => c.name === "platform-worker");
		let mount;
		try { mount = configurationMount(active, "worker"); } catch { fail("ACS_WORKER_SOURCE_UNPROVEN"); }
		const source = observed.workerSources?.get(mount.name);
		if (!/^[^@]+@sha256:[a-f0-9]{64}$/u.test(candidate.image) ||
			worker.image !== candidate.image || !same(worker.command ?? [], candidate.command ?? []) ||
			!same(worker.args ?? [], candidate.args ?? []) || !same(env, workerNetworkEnvironmentV1(worker, namespace)) ||
			mount.directory || !source || source.digest !== workerConfigurationSha256 ||
			worker.volumeMounts?.some((volume) => volume.mountPath === "/app/dist/deployment.mjs" || volume.mountPath === "/app/dist" || volume.mountPath === "/app") ||
			(item.kind === "Pod" && !(Date.parse(item.metadata?.creationTimestamp) >= Date.parse(source.createdAt))))
			fail("ACS_WORKER_SOURCE_UNPROVEN");
	}
}

/** The chart must render the Session ECI admission, not a RuntimeClass branch. */
export function assertSessionEciAdmissionRenderedV1(
	input,
	namespace,
	compute = "eci",
) {
	const documents =
		typeof input === "string" ? renderedDocuments(input) : input;
	const name = `${namespace}-session-eci`;
	const policies = documents.filter(
		(item) =>
			item.kind === "MutatingAdmissionPolicy" && item.metadata?.name === name,
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
		selector?.namespaceSelector?.matchLabels?.[
			"kubernetes.io/metadata.name"
		] === namespace;
	if (
		policies.length !== 1 ||
		bindings.length !== 1 ||
		policy.spec?.failurePolicy !== "Fail" ||
		policy.spec?.matchConditions?.length !== 1 ||
		policy.spec.matchConditions[0]?.name !== "eci-session" ||
		policy.spec.matchConditions[0]?.expression !==
			'!has(object.metadata.labels) || !("alibabacloud.com/acs" in object.metadata.labels) || object.metadata.labels["alibabacloud.com/acs"] != "true"' ||
		!scoped(policy.spec?.matchConstraints) ||
		!scoped(bindings[0].spec?.matchResources) ||
		expressions.length !== 1 ||
		!expressions[0].includes(
			'path:"/spec/nodeSelector/type",value:"virtual-kubelet"',
		) ||
		!expressions[0].includes('"key":"virtual-kubelet.io/provider"') ||
		expressions[0].includes('path:"/spec/runtimeClassName"')
	)
		fail("SESSION_PLACEMENT_UNPROVEN");
	const architectures = [
		...expressions[0].matchAll(
			/path:"\/spec\/nodeSelector\/kubernetes\.io~1arch",value:"([a-z0-9]+)"/gu,
		),
	].map((match) => match[1]);
	if (
		architectures.length !== 1 ||
		!["amd64", "arm64"].includes(architectures[0])
	)
		fail("SESSION_PLACEMENT_UNPROVEN");
	if (
		(compute === "acs" && architectures[0] !== "amd64") ||
		expressions[0].includes('path:"/metadata/labels')
	)
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
export function placementSelectorSha256V1(
	architecture,
	computes = defaultComputes,
) {
	return sha256(
		JSON.stringify(
			canonical({
				...eciPlacementFieldsV1(architecture),
				...(Object.values(computes).includes("acs")
					? { computes, acsMetadata: acsPodMetadataV1("acs") }
					: {}),
			}),
		),
	);
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
		if (
			!matchLabels ||
			typeof matchLabels !== "object" ||
			Array.isArray(matchLabels)
		)
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
	record(
		evidence.cluster,
		["kubeSystemNamespaceUid", "clusterId"],
		"EVIDENCE_INVALID",
	);
	text(evidence.cluster.kubeSystemNamespaceUid, uidPattern, "EVIDENCE_INVALID");
	text(evidence.cluster.clusterId, /^[A-Za-z0-9-]{1,64}$/, "EVIDENCE_INVALID");
	record(evidence.namespace, ["name", "uid"], "EVIDENCE_INVALID");
	text(
		evidence.namespace.name,
		/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/,
		"EVIDENCE_INVALID",
	);
	text(evidence.namespace.uid, uidPattern, "EVIDENCE_INVALID");
	// The managed Poseidon configuration is unobservable; there is no readback to bind.
	record(
		evidence.enforcer,
		["runtime", "component", "version"],
		"EVIDENCE_INVALID",
	);
	if (evidence.enforcer.version !== "unobservable") fail("EVIDENCE_INVALID");
	record(
		evidence.placement,
		[
			"architecture",
			"legacyUnplaced",
			"selectorSha256",
			...(evidence.placement?.computes === undefined ? [] : ["computes"]),
		],
		"EVIDENCE_INVALID",
	);
	text(evidence.placement.selectorSha256, hex64, "EVIDENCE_INVALID");
	if (evidence.placement.computes !== undefined)
		validateComputes(evidence.placement.computes);
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
			[
				"pod",
				"uid",
				"nodeName",
				"port",
				"controller",
				...(evidence.placement.computes === undefined
					? []
					: ["compute", "instanceId"]),
			],
			"EVIDENCE_INVALID",
		);
		if (evidence.placement.computes !== undefined) {
			if (!["eci", "acs"].includes(probe.destination.compute))
				fail("EVIDENCE_INVALID");
			text(
				probe.destination.instanceId,
				new RegExp(`^${probe.destination.compute}-[a-z0-9]{1,64}$`),
				"EVIDENCE_INVALID",
			);
			if (
				!matchesComputeLabelsV1(
					probe.destination.compute,
					probe.policy?.podLabels?.target,
				)
			)
				fail("PROBE_COMPUTE_MISMATCH");
		}
		text(probe.destination.pod, namePattern, "EVIDENCE_INVALID");
		text(probe.destination.uid, uidPattern, "EVIDENCE_INVALID");
		text(probe.destination.nodeName, namePattern, "EVIDENCE_INVALID");
		if (
			!Number.isSafeInteger(probe.destination.port) ||
			probe.destination.port < 1 ||
			probe.destination.port > 65_535
		)
			fail("EVIDENCE_INVALID");
		record(
			probe.destination.controller,
			["kind", "name", "uid"],
			"EVIDENCE_INVALID",
		);
		if (
			!["StatefulSet", "Deployment", "Job"].includes(
				probe.destination.controller.kind,
			)
		)
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
		record(
			substitutions.agentSelector,
			["key", "value"],
			"PROBE_SUBSTITUTION_INVALID",
		);
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
			if (probe[step] !== null)
				record(probe[step], ["at", "outcome"], "EVIDENCE_INVALID");
		if (probe.deny !== null)
			record(probe.deny, ["at", "outcome", "policyUid"], "EVIDENCE_INVALID");
	}
	return evidence;
}

const egressKeys = [
	"nativeEgress",
	"modelEgress",
	"connectionEgress",
	"nativeMetadataWorkerEgress",
	"fileExchangeEgress",
	"workspaceSnapshotEgress",
	"dnsEgress",
];
// Runs in an isolated child: no network, no child processes, only the copied module readable.
const projectionScript = (file) => `
// Node 24's permission model has no network switch, and the loaded module is
// deployment code: close every network entry point before importing it. Native
// bindings, addons, child processes and workers are already denied by --permission.
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const refuse = () => { throw new Error("NETWORK_DENIED"); };
const lock = (target, key) => {
	if (target && typeof target[key] === "function")
		Object.defineProperty(target, key, { value: refuse, writable: false, configurable: false });
};
const net = require("node:net");
lock(net.Socket.prototype, "connect");
for (const key of ["listen", "listenFd"]) lock(net.Server.prototype, key);
for (const key of ["connect", "createConnection"]) lock(net, key);
const dgram = require("node:dgram");
for (const key of ["bind", "connect", "send", "constructor"]) lock(dgram.Socket.prototype, key);
// A socket's native handle (_handle) sends without the JS methods above: no socket may be created.
for (const key of ["createSocket", "Socket"]) lock(dgram, key);
for (const name of ["node:dns", "node:dns/promises"]) {
	const dns = require(name);
	for (const key of Object.keys(dns)) lock(dns, key);
	for (const key of Object.getOwnPropertyNames(dns.Resolver?.prototype ?? {})) lock(dns.Resolver.prototype, key);
}
for (const name of ["connect"]) { lock(require("node:tls"), name); lock(require("node:http2"), name); }
for (const name of ["fetch", "WebSocket", "EventSource"]) {
	if (name in globalThis) Object.defineProperty(globalThis, name, { value: refuse, writable: false, configurable: false });
}
// The module sees exactly the Worker's rendered network environment. A read of any
// other variable cannot be evaluated equivalently to the real Worker, so it is refused.
// WATCH_REPORT_DEPENDENCIES is read by Node's own module loader and is never set.
const visible = [...${JSON.stringify(workerNetworkEnvironment)}, "WATCH_REPORT_DEPENDENCIES"];
const environment = { ...process.env };
// Any read of another variable, and any write, delete or redefinition, cannot be
// reproduced by the parent's final merge. It is remembered so a module that catches
// the error still cannot pass.
let violated = false;
const deny = () => { violated = true; throw new Error("ENVIRONMENT_UNVERIFIABLE"); };
const known = (key) => typeof key !== "string" || visible.includes(key);
Object.defineProperty(process, "env", {
	value: new Proxy(environment, {
		get: (target, key) => (known(key) ? target[key] : deny()),
		has: (target, key) => (known(key) ? key in target : deny()),
		getOwnPropertyDescriptor: (target, key) =>
			known(key) ? Reflect.getOwnPropertyDescriptor(target, key) : deny(),
		ownKeys: deny,
		set: deny,
		defineProperty: deny,
		deleteProperty: deny,
		setPrototypeOf: deny,
	}),
	writable: false,
	configurable: false,
});
const module = await import(${JSON.stringify(pathToFileURL(file).href)});
if (violated) process.exit(4);
const policy = module.workloadInput?.policy;
if (!policy || typeof policy !== "object") process.exit(3);
const egress = {};
for (const key of ${JSON.stringify(egressKeys)}) if (policy[key] !== undefined) egress[key] = policy[key];
const gateway = module.nativeMetadataGateway;
process.stdout.write(JSON.stringify({
	workerSelector: policy.workerSelector,
	routeNamespace: policy.routeNamespace,
	routeSelector: policy.routeSelector,
	platformApiSelector: policy.platformApiSelector,
	workspaceSnapshotProjection: typeof module.workloadInput?.workspaceSnapshotResolver?.project === "function",
	egress,
	runtimeAuth: policy.runtimeAuth === undefined ? undefined : { fileExchangeOrigin: policy.runtimeAuth.fileExchangeOrigin },
	nativeMetadataGateway: gateway === undefined || gateway === null ? undefined : { port: gateway.port },
}));
process.exit(0);
`;

// Environment names the Worker's final network configuration reads (resolveWorkerEffectiveEgressV1).
const workerNetworkEnvironment = [
	"PLATFORM_WORKER_FILE_EXCHANGE_ORIGIN",
	"PLATFORM_WORKER_FILE_EXCHANGE_EGRESS",
	"PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_ENABLED",
	"PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_PORT",
	"PLATFORM_WORKER_NAMESPACE",
	"PLATFORM_WORKER_RELEASE_NAME",
];
function importsEnvironment(container, keys) {
	const explicit = new Set(container.env?.map((entry) => entry.name));
	return container.envFrom?.some((source) => keys.some((key) =>
		!explicit.has(key) && key.startsWith(source.prefix ?? "")));
}
function workerNetworkEnvironmentV1(container, namespace) {
	if (!container || importsEnvironment(container, workerNetworkEnvironment))
		fail("WORKER_CONFIGURATION_UNVERIFIABLE");
	const environment = {};
	for (const entry of container.env ?? []) {
		if (!workerNetworkEnvironment.includes(entry.name)) continue;
		if (Object.hasOwn(environment, entry.name))
			fail("WORKER_CONFIGURATION_UNVERIFIABLE");
		if (typeof entry.value === "string" && entry.valueFrom === undefined)
			environment[entry.name] = entry.value;
		else if (
			entry.valueFrom?.fieldRef?.fieldPath === "metadata.namespace" &&
			entry.value === undefined
		)
			environment[entry.name] = namespace;
		else fail("WORKER_CONFIGURATION_UNVERIFIABLE");
	}
	return environment;
}

/**
 * Derives the NetworkPolicy deployment configuration from the Worker
 * `configuration.mjs` the rendered chart mounts, i.e. the exact bytes the deployment
 * is about to run (Spec §10.1). There is no independently authored copy to go
 * stale. Anything that cannot be read or evaluated is rejected.
 */
export async function deriveNetworkPolicyDeploymentConfigV1({
	bootstrapInputsFile,
	renderedManifest,
	namespace,
}) {
	if (!bootstrapInputsFile) fail("WORKER_CONFIGURATION_REQUIRED");
	let bytes;
	try {
		bytes = Buffer.from(
			await workerConfigurationBytes(bootstrapInputsFile, renderedManifest),
		);
	} catch {
		fail("WORKER_CONFIGURATION_UNVERIFIABLE");
	}
	const rendered = renderedWorkloadPlacementV1(renderedManifest, namespace);
	const environment = workerNetworkEnvironmentV1(rendered.worker.spec.template.spec.containers.find((c) => c.name === "platform-worker"), namespace);
	const directory = mkdtempSync(
		join(realpathSync(tmpdir()), "agent-infra-np-config-"),
	);
	let projected;
	try {
		chmodSync(directory, 0o700);
		const file = join(directory, "configuration.mjs");
		writeFileSync(file, bytes, { mode: 0o600 });
		projected = JSON.parse(
			execFileSync(
				process.execPath,
				[
					"--permission",
					`--allow-fs-read=${directory}`,
					"--input-type=module",
					"-e",
					projectionScript(file),
				],
				{
					encoding: "utf8",
					timeout: 20_000,
					maxBuffer: 4 * 1024 * 1024,
					stdio: ["ignore", "pipe", "ignore"],
					env: environment,
				},
			),
		);
	} catch {
		fail("WORKER_CONFIGURATION_UNVERIFIABLE");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
	// Merge the file exchange and native metadata gateway egress exactly as the Worker
	// does: same function, and the rendered Worker container environment.
	let config;
	try {
		const { runtimeAuth, nativeMetadataGateway, ...base } = projected;
		const effective = resolveWorkerEffectiveEgressV1({
			policy: { ...base.egress, ...(runtimeAuth ? { runtimeAuth } : {}) },
			nativeMetadataGateway,
			environment,
		});
		const { runtimeAuth: _runtimeAuth, ...egress } = effective.policy;
		config = parseNetworkPolicyDeploymentConfigV1({ ...base, egress });
	} catch {
		fail("NETWORKPOLICY_CONFIG_INVALID");
	}
	return { config, workerConfigurationSha256: sha256(bytes) };
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
	workerConfigurationSha256,
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
	const computes = evidence.placement.computes ?? defaultComputes;
	if (!same(rendered.computes, computes)) fail("COMPUTE_PLACEMENT_MISMATCH");
	// The selector and toleration digest must match what the Worker injects.
	if (
		placementSelectorSha256V1(rendered.placement.architecture, computes) !==
		evidence.placement.selectorSha256
	)
		fail("PLACEMENT_SELECTOR_MISMATCH");
	// Session Sandboxes use the same selector and toleration; with the same
	// architecture their candidate nodes are exactly the proven Agent candidates.
	if (rendered.sessionArchitecture !== evidence.placement.architecture)
		fail("SESSION_PLACEMENT_MISMATCH");
	if (evidence.enforcer.component !== "poseidon" || !["eci", "acs", "mixed"].includes(evidence.enforcer.runtime))
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
		observed.kubeSystemNamespaceUid !==
			evidence.cluster.kubeSystemNamespaceUid ||
		observed.namespace?.name !== evidence.namespace.name ||
		observed.namespace?.uid !== evidence.namespace.uid
	)
		fail("EVIDENCE_SCOPE_MISMATCH");

	const candidates = eciCandidateNodesV1(
		observed.nodes ?? [],
		evidence.placement.architecture,
	);
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
		Object.entries(templates).some(
			([variant, digest]) => recorded[variant] !== digest,
		)
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
		if (!candidateNames.has(probe.destination.nodeName))
			fail("PROBE_SCOPE_MISMATCH");
		const { variant, substitutions, podLabels } = probe.policy;
		if (!variants.has(variant)) fail("PROBE_POLICY_MISMATCH");
		// The probe policy must not select, or be selected through, production labels.
		if (substitutions.agentSelector.key === ownerLabel)
			fail("PROBE_SUBSTITUTION_INVALID");
		if (
			"port" in substitutions &&
			substitutions.port !== probe.destination.port
		)
			fail("PROBE_SUBSTITUTION_INVALID");
		let spec;
		try {
			spec = networkPolicySpecV1({ variant, config, substitutions });
		} catch {
			fail("PROBE_SUBSTITUTION_INVALID");
		}
		// The digest also binds the protected networks the compiler checked the spec against.
		if (
			networkPolicyEvidenceSha256V1(spec, config) !==
			probe.policy.instantiatedSha256
		)
			fail("PROBE_POLICY_MISMATCH");
		for (const labels of Object.values(podLabels))
			if (forbiddenLabels(labels)) fail("PROBE_LABELS_FORBIDDEN");
		const { agentSelector } = substitutions;
		// Judge sources and target against the instantiated policy itself: the target
		// must be selected by the full podSelector (including the service label) and
		// the sources by the variant's real same-namespace ingress peers.
		const allPeers = (spec.ingress ?? []).flatMap((rule) => rule.from ?? []);
		// A policy that admits no ingress source (migration) cannot show an allowed
		// source connecting before deny-all or after recovery, so it is no probe.
		if (allPeers.length === 0) fail("PROBE_VARIANT_NO_INGRESS");
		const peers = allPeers.filter(
			(peer) => peer.namespaceSelector === undefined,
		);
		const selectsSource = (labels) =>
			peers.some((peer) => labelsSatisfySelectorV1(labels, peer.podSelector));
		if (
			podLabels.target[agentSelector.key] !== agentSelector.value ||
			!labelsSatisfySelectorV1(podLabels.target, spec.podSelector) ||
			!selectsSource(podLabels.workerSource) ||
			selectsSource(podLabels.nonWorkerSource) ||
			("workerSource" in substitutions &&
				(!labelsSatisfySelectorV1(
					podLabels.workerSource,
					substitutions.workerSource,
				) ||
					labelsSatisfySelectorV1(
						podLabels.nonWorkerSource,
						substitutions.workerSource,
					)))
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
	const probedNodes = new Set(
		evidence.probes.map(
			(probe) =>
				`${probe.destination.nodeName}/${probe.destination.compute ?? "eci"}`,
		),
	);
	const requiredComputes = acsRolloutBackends(rendered, observed.workers, observed.sessions);
	if (requiredComputes.includes("acs"))
		checkRolloutWorkerSources(rendered, observed, workerConfigurationSha256, evidence.namespace.name);
	if (
		[...candidateNames].some((name) =>
			requiredComputes.some(
				(compute) => !probedNodes.has(`${name}/${compute}`),
			),
		)
	)
		fail("CANDIDATE_NODE_UNPROBED");

	const isolatedEciTrial = evidence.namespace.name === "ack-community-m1-4405" &&
		rendered.worker.spec.template.spec.containers.some((c) => c.name === "platform-worker" &&
			c.env?.some((entry) => entry.name === "AGENT_INFRA_SIG_CORE_SDK_TRIAL_IMAGE" && entry.value));
	if (!rendered.sessionAdmission && !isolatedEciTrial && probedRuntime(evidence.probes) !== "mixed")
		fail("SESSION_COMPUTE_ADMISSION_UNPROVEN");
	if (rendered.sessionAdmission && !rendered.sessionAdmission.includes(rendered.computes.session)) fail("SESSION_COMPUTE_ADMISSION_UNPROVEN");
	if (evidence.enforcer.runtime !== probedRuntime(evidence.probes)) fail("ENFORCER_UNSUPPORTED");

	// The live Agent-level controllers are checked statically; they need not be
	// listed in the evidence, and the probe Pods are gone by now.
	const controllers = observed.controllers ?? [];
	let placed = 0;
	let legacyActive = 0;
	for (const item of controllers) {
		const { kind } = item;
		const { shape, architecture, compute } = templateShape(item);
		if (shape === "foreign") fail("FOREIGN_PLACEMENT");
		if (shape === "placed") {
			// Its candidate nodes are only proven for the evidence architecture.
			if (
				architecture !== evidence.placement.architecture ||
				[...candidateNames].some(
					(name) => !probedNodes.has(`${name}/${compute}`),
				)
			)
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
			runtime: evidence.enforcer.runtime,
			component: "poseidon",
			version: evidence.enforcer.version,
		},
		placement: evidence.placement,
		...(rendered.sessionAdmission ? { sessionRecoveryComputes: rendered.sessionAdmission } : {}),
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

/** Scope of a first-message trial before any candidate or Session workload is running. */
export function validateCodexTrialNetworkScope({
	namespace, source, target, bootstrap, image, workerImage, rendered, observed,
}) {
	const reject = () => fail("CODEX_TRIAL_SCOPE_UNPROVEN");
	if (namespace !== "ack-community-m1-4405" || !/^[a-f0-9]{40}$/u.test(source) ||
		target?.sourceCommit !== source || target.namespace !== namespace || bootstrap?.namespace !== namespace ||
		!uidPattern.test(target.clusterUid) || !uidPattern.test(target.namespaceUid) || !uidPattern.test(target.installationId) ||
		bootstrap.clusterUid !== target.clusterUid || bootstrap.installationId !== target.installationId ||
		observed.clusterUid !== target.clusterUid || observed.namespace?.metadata?.uid !== target.namespaceUid ||
		observed.namespace.metadata.name !== namespace || observed.namespace.metadata.deletionTimestamp ||
		observed.namespace.metadata.labels?.["agent-infra.agora.io/bootstrap-id"] !== target.installationId ||
		!/^ghcr\.io\/agoraio-extensions\/agent-infra\/agent-runtime-codex@sha256:[a-f0-9]{64}$/u.test(image) ||
		!/^ghcr\.io\/agoraio-extensions\/agent-infra\/platform-worker@sha256:[a-f0-9]{64}$/u.test(workerImage) ||
		rendered.placement?.architecture !== "amd64" || rendered.sessionArchitecture !== "amd64" ||
		!same(rendered.computes, defaultComputes)) reject();
	// Old writers continue processing persisted work during a rollout. The desired
	// Deployment alone cannot attest that the running Worker already enforces this scope.
	const desired = rendered.worker.spec.template.spec;
	const placementEnv = (worker) => worker.env.filter(entry =>
		entry.name === placementEnvironment || entry.name === "AGENT_INFRA_SESSION_RUNTIME_PLACEMENT");
	const desiredWorker = desired.containers.find(container => container.name === "platform-worker");
	for (const spec of [desired, ...observed.workers]) {
		const workers = spec?.containers?.filter(c => c.name === "platform-worker");
		const binding = workers?.[0]?.env?.filter(e => e.name === "AGENT_INFRA_SIG_CORE_SDK_TRIAL_IMAGE");
		if (workers?.length !== 1 || workers[0].image !== workerImage || binding?.length !== 1 ||
			binding[0].value !== image || binding[0].valueFrom || workers[0].envFrom?.length ||
			!same(placementEnv(workers[0]), placementEnv(desiredWorker))) reject();
	}
	if (!Array.isArray(observed.workloads) || observed.workloads.length) reject();
	return { schemaVersion: 1, scope: "4405-codex-sdk-first-message", source, target,
		image, workerImage, networkDataplaneVerified: false, fieldAcceptanceSigned: false };
}

async function readCodexTrialScope(namespace, renderedManifest, kubectl) {
	const source = process.env.ACK_SOURCE_SHA;
	if (source !== execFileSync("git", ["rev-parse", "HEAD"], {cwd: import.meta.dirname, encoding:"utf8"}).trim())
		fail("CODEX_TRIAL_SOURCE_MISMATCH");
	const [target, bootstrap, platform, templates] = await Promise.all([
		process.env.ACK_TRUSTED_TRIAL_TARGET_FILE, process.env.ACK_BOOTSTRAP_INPUTS_FILE,
		process.env.ACK_IMAGE_MANIFEST, process.env.ACK_TEMPLATE_IMAGE_MANIFEST,
	].map(file => privateJson(file)));
	const imageRef = (manifest, key) => {
		const entry = manifest.images?.[key];
		if (manifest.schemaVersion !== 1 || manifest.platform !== "linux/amd64" ||
			manifest.commitSha !== source || !entry) fail("CODEX_TRIAL_SCOPE_UNPROVEN");
		return entry.repository + "@" + entry.digest;
	};
	record(target, ["namespace", "sourceCommit", "installationId", "clusterUid", "namespaceUid"], "CODEX_TRIAL_SCOPE_UNPROVEN");
	const get = (...args) => JSON.parse(kubectl(["get", ...args, "-o", "json"]));
	const list = (resources, selector) => {
		const {items} = get(resources, ...(selector ? ["-l",selector] : []));
		if (!Array.isArray(items)) fail("READ_FAILED");
		return items;
	};
	const writers = list("pods,deployments,replicasets", "app.kubernetes.io/component=platform-worker");
	const workers = activeWorkerSpecs(writers);
	const workloads = [
		...list("pods,statefulsets,deployments,replicasets,jobs", ownerLabel),
		...list("pods,statefulsets", "agent-infra.agora.io/managed=session-sandbox-v1"),
		...list("pods", "agent-infra.validation-owner"),
		...list("sandboxes.agents.x-k8s.io"),
	];
	const rendered = renderedWorkloadPlacementV1(renderedManifest, namespace);
	const api = rendered.documents.filter(doc => doc.kind === "Deployment" && doc.metadata?.name === "agent-infra-api");
	const pilot = api[0]?.spec?.template?.spec?.containers?.find(c => c.name === "platform-api")?.env
		?.filter(entry => entry.name === "PLATFORM_SIG_CORE_NEW_SESSIONS_NAMESPACE");
	if (api.length !== 1 || pilot?.length !== 1 || pilot[0].value !== namespace || pilot[0].valueFrom)
		fail("CODEX_TRIAL_SCOPE_UNPROVEN");
	return validateCodexTrialNetworkScope({
		namespace, source, target, bootstrap, image: imageRef(templates, "codex"),
		workerImage: imageRef(platform, "platformWorker"), rendered,
		observed: { namespace: get("namespace", namespace), clusterUid: get("namespace", "kube-system").metadata?.uid, workers, workloads },
	});
}

/** Read-only `kubectl get` observation the gate judges the evidence against. */
export function collectNetworkPolicyObservedV1(namespace, kubectl, rendered, readSources = false) {
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
	const workers = read(["get", "pods,deployments,replicasets", "-l",
		"app.kubernetes.io/component=platform-worker", "-o", "json"])?.items;
	if (!Array.isArray(workers)) fail("ACS_WORKER_OBSERVATION_REQUIRED");
	const sessions = read(["get", "pods,statefulsets", "-l", "agent-infra.agora.io/managed=session-sandbox-v1", "-o", "json"])?.items;
	if (!Array.isArray(sessions)) fail("SESSION_PLACEMENT_UNPROVEN");
	const workerSources = new Map();
	if (readSources && acsRolloutBackends(rendered, workers, sessions).includes("acs")) {
		for (const spec of liveRolloutWorkerSpecs(workers)) {
			let name;
			try { name = configurationMount(spec, "worker").name; } catch { fail("ACS_WORKER_SOURCE_UNPROVEN"); }
			if (workerSources.has(name)) continue;
			const secret = read(["get", "secret", name, "-o", "json"]);
			if (secret.immutable !== true || secret.metadata?.name !== name || secret.metadata?.namespace !== namespace ||
				typeof secret.data?.["configuration.mjs"] !== "string") fail("ACS_WORKER_SOURCE_UNPROVEN");
			workerSources.set(name, {
				digest: sha256(Buffer.from(secret.data["configuration.mjs"], "base64")),
				createdAt: secret.metadata.creationTimestamp,
			});
		}
	}
	return {
		namespace: {
			name: namespaceObject?.metadata?.name,
			uid: namespaceObject?.metadata?.uid,
		},
		kubeSystemNamespaceUid: kubeSystem?.metadata?.uid,
		nodes: nodes.items,
		controllers: controllers.items,
		workers, sessions, workerSources,
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const namespace = process.env.ACK_NAMESPACE ?? "agent-infra";
	try {
		const evidenceFile = process.env.ACK_NETWORKPOLICY_EVIDENCE_FILE;
		const args = process.argv.slice(2);
		const trial = args.length === 1 && args[0] === "--codex-trial" && namespace === "ack-community-m1-4405";
		if (args.length && !trial) fail("CODEX_TRIAL_SCOPE_UNPROVEN");

		let evidence;
		try {
			if (evidenceFile) evidence = JSON.parse(readFileSync(evidenceFile, "utf8"));
		} catch {
			fail("EVIDENCE_INVALID");
		}
		const kubectl = (args) =>
			execFileSync(
				process.env.KUBECTL_BIN ?? "kubectl",
				["--request-timeout=20s", "--namespace", namespace, ...args],
				{
					encoding: "utf8",
					timeout: 30_000,
					maxBuffer: 64 * 1024 * 1024,
					stdio: ["ignore", "pipe", "ignore"],
				},
			);
		let renderedManifest;
		try {
			renderedManifest = process.env.ACK_RENDERED_MANIFEST_FILE
				? readFileSync(process.env.ACK_RENDERED_MANIFEST_FILE, "utf8")
				: undefined;
		} catch {
			fail("RENDERED_MANIFEST_REQUIRED");
		}
		if (!evidenceFile && !trial) {
			let rendered;
			try {
				rendered = renderedWorkloadPlacementV1(renderedManifest, namespace);
			} catch {
				fail("EVIDENCE_REQUIRED");
			}

			const facts = { networkPolicy: "unknown", computes: rendered.computes,
				renderedManifestSha256: sha256(renderedManifest), fieldAcceptanceSigned: false };
			try {
				const observed = collectNetworkPolicyObservedV1(namespace, kubectl);
				facts.namespaceUidSha256 = sha256(text(observed.namespace.uid, uidPattern, "READ_FAILED"));
				facts.activeWorkerSpecs = liveRolloutWorkerSpecs(observed.workers).length;
				facts.agentControllers = observed.controllers.length;
				facts.sessionResources = observed.sessions.length;
				facts.requiredComputes = acsRolloutBackends(rendered, observed.workers, observed.sessions);
			} catch (error) {
				facts.observationError = error instanceof NetworkPolicyEnforcementError ? error.code : "READ_FAILED";
			}
			throw new NetworkPolicyEnforcementError("EVIDENCE_REQUIRED", facts);
		}
		if (!renderedManifest) fail("RENDERED_MANIFEST_REQUIRED");
		const { config: deploymentConfig, workerConfigurationSha256 } =
			await deriveNetworkPolicyDeploymentConfigV1({
				bootstrapInputsFile: process.env.ACK_BOOTSTRAP_INPUTS_FILE,
				renderedManifest,
				namespace,
			});

		const scope = trial && !evidenceFile ? await readCodexTrialScope(namespace, renderedManifest, kubectl) : undefined;
		const summary = !evidenceFile && scope ? scope : validateNetworkPolicyEnforcementV1({
			evidence,
			deploymentConfig,
			renderedManifest,
			workerConfigurationSha256,
			observed: collectNetworkPolicyObservedV1(namespace, kubectl, renderedWorkloadPlacementV1(renderedManifest, namespace), true),
		});
		process.stdout.write(
			`${JSON.stringify({ ...summary, workerConfigurationSha256 })}\n`,
		);
	} catch (error) {
		const code =
			error instanceof NetworkPolicyEnforcementError
				? error.code
				: "READ_FAILED";
		process.stderr.write(
			`${JSON.stringify({ status: "failed", scope: "networkpolicy-enforcement", code, ...(error instanceof NetworkPolicyEnforcementError ? error.facts : undefined) })}\n`,
		);
		process.exitCode = 2;
	}
}
