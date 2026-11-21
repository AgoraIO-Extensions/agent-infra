#!/usr/bin/env node
// Read-only NetworkPolicy enforcement gate (Engineering Spec §10.1, ADR-0049, #4351).
// It never creates probes or writes to the cluster; it only checks approved evidence.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseAllDocuments } from "yaml";

export const maxEvidenceAgeMs = 7 * 24 * 60 * 60 * 1000;
const ownerLabel = "agent-infra.agora.io/agent";
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
const canonical = (value) =>
	Array.isArray(value)
		? value.map(canonical)
		: value && typeof value === "object"
			? Object.fromEntries(
					Object.keys(value)
						.sort()
						.map((key) => [key, canonical(value[key])]),
				)
			: value;
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
			"targets",
			"probes",
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
	record(
		evidence.enforcer,
		["runtime", "component", "version", "configSha256"],
		"EVIDENCE_INVALID",
	);
	text(evidence.enforcer.version, /^v?[0-9]+(?:\.[0-9]+){1,3}$/, "EVIDENCE_INVALID");
	text(evidence.enforcer.configSha256, /^[a-f0-9]{64}$/, "EVIDENCE_INVALID");
	record(evidence.placement, ["architecture", "legacyUnplaced"], "EVIDENCE_INVALID");
	if (
		!["amd64", "arm64"].includes(evidence.placement.architecture) ||
		!["retain-until-lifecycle", "reject"].includes(
			evidence.placement.legacyUnplaced,
		)
	)
		fail("EVIDENCE_INVALID");
	for (const list of [evidence.nodes, evidence.targets, evidence.probes])
		if (!Array.isArray(list) || list.length > 512) fail("EVIDENCE_INVALID");
	for (const node of evidence.nodes) {
		record(node, ["name", "uid"], "EVIDENCE_INVALID");
		text(node.name, namePattern, "EVIDENCE_INVALID");
		text(node.uid, uidPattern, "EVIDENCE_INVALID");
	}
	for (const target of evidence.targets) {
		record(target, ["kind", "name", "uid"], "EVIDENCE_INVALID");
		if (!["StatefulSet", "Deployment", "Job"].includes(target.kind))
			fail("EVIDENCE_INVALID");
		text(target.name, namePattern, "EVIDENCE_INVALID");
		text(target.uid, uidPattern, "EVIDENCE_INVALID");
	}
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
		record(probe.policy, ["name", "uid", "specSha256"], "EVIDENCE_INVALID");
		text(probe.policy.name, namePattern, "EVIDENCE_INVALID");
		text(probe.policy.uid, uidPattern, "EVIDENCE_INVALID");
		text(probe.policy.specSha256, /^[a-f0-9]{64}$/, "EVIDENCE_INVALID");
		for (const step of ["allow", "recovery", "nonWorker"])
			if (probe[step] !== null) record(probe[step], ["at", "outcome"], "EVIDENCE_INVALID");
		if (probe.deny !== null)
			record(probe.deny, ["at", "outcome", "policyUid"], "EVIDENCE_INVALID");
	}
	return evidence;
}

function parseEnforcerConfig(bytes) {
	let config;
	try {
		config = JSON.parse(Buffer.from(bytes).toString("utf8"));
	} catch {
		fail("ENFORCER_CONFIG_UNREADABLE");
	}
	record(
		config,
		[
			"schemaVersion",
			"kind",
			"clusterId",
			"component",
			"version",
			"eciNetworkPolicyEnabled",
			"readAt",
		],
		"ENFORCER_CONFIG_UNREADABLE",
	);
	if (config.schemaVersion !== 1 || config.kind !== "ack-poseidon-config-readback")
		fail("ENFORCER_CONFIG_UNREADABLE");
	return config;
}

/**
 * Pure gate. `observed` comes from read-only `kubectl get`; any failure to read it
 * is reported by the caller as READ_FAILED. Returns a credential-free summary.
 */
export function validateNetworkPolicyEnforcementV1({
	evidence: input,
	enforcerConfigBytes,
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
	// Session Sandboxes use the same selector and toleration; with the same
	// architecture their candidate nodes are exactly the proven Agent candidates.
	if (rendered.sessionArchitecture !== evidence.placement.architecture)
		fail("SESSION_PLACEMENT_MISMATCH");
	if (evidence.enforcer.runtime !== "eci" || evidence.enforcer.component !== "poseidon")
		fail("ENFORCER_UNSUPPORTED");
	if (!enforcerConfigBytes) fail("ENFORCER_CONFIG_UNREADABLE");
	if (
		createHash("sha256").update(enforcerConfigBytes).digest("hex") !==
		evidence.enforcer.configSha256
	)
		fail("ENFORCER_CONFIG_UNREADABLE");
	const config = parseEnforcerConfig(enforcerConfigBytes);
	if (
		config.clusterId !== evidence.cluster.clusterId ||
		config.component !== "poseidon" ||
		config.version !== evidence.enforcer.version
	)
		fail("ENFORCER_CONFIG_MISMATCH");
	if (config.eciNetworkPolicyEnabled !== true) fail("ENFORCER_DISABLED");

	const observedAt = instant(evidence.observedAt, "EVIDENCE_INVALID");
	const expiresAt = instant(evidence.expiresAt, "EVIDENCE_INVALID");
	const readAt = instant(config.readAt, "ENFORCER_CONFIG_UNREADABLE");
	if (observedAt > now || readAt > now || expiresAt <= observedAt)
		fail("EVIDENCE_INVALID");
	if (
		now >= expiresAt ||
		now - observedAt > maxEvidenceAgeMs ||
		now - readAt > maxEvidenceAgeMs ||
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

	if (evidence.probes.length === 0) fail("PROBE_POSITIVE_MISSING");
	const candidateNames = new Set(candidates.map((node) => node.metadata?.name));
	for (const [index, probe] of evidence.probes.entries()) {
		if (!candidateNames.has(probe.destination.nodeName)) fail("PROBE_SCOPE_MISMATCH");
		assertProbeTargetCurrent(probe, observed.probeTargets?.[index], evidence.namespace.name);
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

	const key = (kind, name, uid) => `${kind}/${name}/${uid}`;
	const controllers = (observed.controllers ?? []).map((item) => ({
		kind: item.kind,
		name: item.metadata?.name,
		uid: item.metadata?.uid,
		item,
	}));
	const expected = new Set(evidence.targets.map((t) => key(t.kind, t.name, t.uid)));
	const actual = new Set(controllers.map((c) => key(c.kind, c.name, c.uid)));
	if (
		expected.size !== evidence.targets.length ||
		actual.size !== controllers.length ||
		expected.size !== actual.size ||
		[...actual].some((entry) => !expected.has(entry))
	)
		fail("TARGET_SET_MISMATCH");

	let placed = 0;
	let legacyActive = 0;
	for (const { kind, item } of controllers) {
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
		namespaceUidSha256: createHash("sha256").update(evidence.namespace.uid).digest("hex"),
		enforcer: { runtime: "eci", component: "poseidon", version: evidence.enforcer.version },
		placement: evidence.placement,
		workerPlacementSource: {
			deployment: rendered.deployment,
			env: placementEnvironment,
			renderedManifestSha256: createHash("sha256")
				.update(renderedManifest)
				.digest("hex"),
		},
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
	return { placement, sessionArchitecture, deployment: workers[0].metadata?.name };
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

/** Hash of a NetworkPolicy's effective spec, as recorded by the evidence producer. */
export function networkPolicySpecSha256V1(spec) {
	return sha256(JSON.stringify(canonical(spec ?? {})));
}

/**
 * The probed Pod and its original NetworkPolicy must still be the very objects
 * the evidence observed: same Pod UID, namespace, node, controller and declared
 * port, and the same policy UID and effective spec selecting that Pod. The
 * temporary deny-all policy may already be gone.
 */
function assertProbeTargetCurrent(probe, live, namespace) {
	const pod = live?.pod;
	if (!pod) fail("PROBE_TARGET_MISSING");
	const destination = probe.destination;
	const owners = (pod.metadata?.ownerReferences ?? []).filter(
		(owner) => owner.controller === true,
	);
	const owner = owners[0];
	let controller = owner;
	if (owner?.kind === "ReplicaSet") {
		const parents = (live.replicaSet?.metadata?.ownerReferences ?? []).filter(
			(parent) => parent.controller === true,
		);
		controller =
			live.replicaSet?.metadata?.uid === owner.uid &&
			live.replicaSet?.metadata?.name === owner.name &&
			parents.length === 1
				? parents[0]
				: undefined;
	}
	if (
		pod.metadata?.name !== destination.pod ||
		pod.metadata?.uid !== destination.uid ||
		pod.metadata?.namespace !== namespace ||
		pod.metadata?.deletionTimestamp !== undefined ||
		pod.spec?.nodeName !== destination.nodeName ||
		pod.status?.phase !== "Running" ||
		owners.length !== 1 ||
		controller?.kind !== destination.controller.kind ||
		controller?.name !== destination.controller.name ||
		controller?.uid !== destination.controller.uid ||
		!(pod.spec?.containers ?? []).some((container) =>
			(container.ports ?? []).some(
				(port) =>
					port.containerPort === destination.port &&
					(port.protocol ?? "TCP") === "TCP",
			),
		)
	)
		fail("PROBE_TARGET_MISMATCH");
	const policy = live.policy;
	const selector = policy?.spec?.podSelector ?? {};
	const labels = pod.metadata?.labels ?? {};
	if (
		!policy ||
		policy.metadata?.name !== probe.policy.name ||
		policy.metadata?.uid !== probe.policy.uid ||
		policy.metadata?.namespace !== namespace ||
		policy.metadata?.deletionTimestamp !== undefined ||
		networkPolicySpecSha256V1(policy.spec) !== probe.policy.specSha256 ||
		(selector.matchExpressions?.length ?? 0) > 0 ||
		!Object.entries(selector.matchLabels ?? {}).every(
			([key, value]) => labels[key] === value,
		)
	)
		fail("PROBE_POLICY_MISMATCH");
}

function collect(namespace, kubectl, evidence) {
	const read = (args) => {
		try {
			return JSON.parse(kubectl(args));
		} catch {
			fail("READ_FAILED");
		}
	};
	// NotFound is an empty answer (the target is gone); any other failure is READ_FAILED.
	const readOptional = (kind, name) => {
		let raw;
		try {
			raw = kubectl(["get", kind, name, "--ignore-not-found", "-o", "json"]);
		} catch {
			fail("READ_FAILED");
		}
		if (!raw.trim()) return undefined;
		try {
			return JSON.parse(raw);
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
	const names = (value) =>
		typeof value === "string" && namePattern.test(value) ? value : fail("EVIDENCE_INVALID");
	const probeTargets = (Array.isArray(evidence?.probes) ? evidence.probes : []).map((probe) => {
		const pod = readOptional("pod", names(probe?.destination?.pod));
		const owner = (pod?.metadata?.ownerReferences ?? []).find(
			(entry) => entry.controller === true && entry.kind === "ReplicaSet",
		);
		return {
			pod,
			replicaSet: owner ? readOptional("replicaset", names(owner.name)) : undefined,
			policy: readOptional("networkpolicy", names(probe?.policy?.name)),
		};
	});
	return {
		probeTargets,
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
		const configFile = process.env.ACK_NETWORKPOLICY_ENFORCER_CONFIG_FILE;
		if (!evidenceFile) fail("EVIDENCE_REQUIRED");
		let evidence;
		try {
			evidence = JSON.parse(readFileSync(evidenceFile, "utf8"));
		} catch {
			fail("EVIDENCE_INVALID");
		}
		let enforcerConfigBytes;
		try {
			enforcerConfigBytes = configFile ? readFileSync(configFile) : undefined;
		} catch {
			fail("ENFORCER_CONFIG_UNREADABLE");
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
			enforcerConfigBytes,
			renderedManifest,
			observed: collect(namespace, kubectl, evidence),
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
