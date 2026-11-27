#!/usr/bin/env node
import { acsPodMetadataV1, observedComputeInstanceIdV1 } from "../../packages/platform-core/src/workload-resource-configuration.ts";
// NetworkPolicy enforcement probe pack (Engineering Spec §10.1, ADR-0049, #4351).
// It renders the probe objects from the Worker's own NetworkPolicy template, records
// allow -> deny -> recovery and non-Worker results per candidate ECI node, and
// assembles the evidence file that deploy/ack/networkpolicy-enforcement.mjs checks.
//
// Cluster writes are limited to what the operator applies from `render` output and
// the UID-checked `cleanup`; every other command only runs `kubectl get` or
// `kubectl exec` into probe Pods. Run it only in an approved window, with the
// reviewed plan, from a pinned checkout.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import {
	canonicalJsonValueV1,
	networkPolicyEvidenceSha256V1,
	networkPolicySpecV1,
	networkPolicyTemplateDigestsV1,
	networkPolicyVariantsV1,
	splitNetworkPolicyVariantV1,
} from "../../packages/platform-core/src/workload-network-policy.ts";
import {
	collectNetworkPolicyObservedV1,
	deriveNetworkPolicyDeploymentConfigV1,
	eciCandidateNodesV1,
	eciPlacementFieldsV1,
	matchesComputeLabelsV1,
	maxEvidenceAgeMs,
	placementSelectorSha256V1,
	renderedWorkloadPlacementV1,
	validateNetworkPolicyEnforcementV1,
} from "./networkpolicy-enforcement.mjs";

export class NetworkPolicyProbeError extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}
const fail = (code) => {
	throw new NetworkPolicyProbeError(code);
};

export const probeLabelKeysV1 = {
	agent: "np-probe.agent-infra.agora.io/agent",
	source: "np-probe.agent-infra.agora.io/source",
	run: "np-probe.agent-infra.agora.io/run",
	role: "np-probe.agent-infra.agora.io/role",
};
export const probeSteps = ["allow", "nonWorker", "deny", "recovery"];
export const blockedOutcomes = new Set(["timeout", "refused", "reset"]);
export const probeOutcomes = new Set([
	"connected",
	"timeout",
	"refused",
	"reset",
	"error",
]);
const runIdPattern = /^[a-z0-9]{6,12}$/;
const imagePattern = /^[a-z0-9][a-z0-9./_:-]*@sha256:[a-f0-9]{64}$/;
const secretNamePattern = /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/;
const clusterIdPattern = /^[A-Za-z0-9-]{1,64}$/;
const singleServiceVariants = new Set([
	"internal-only",
	"self-managed",
	"platform-auth",
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = canonicalJsonValueV1;
const same = (a, b) =>
	JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// ---------------------------------------------------------------------------
// Rendering (pure)
// ---------------------------------------------------------------------------

// Runs inside the target Pod: answers every connection with a fixed token.
const serverSource = `const net=require("net");const [port,token]=process.argv.slice(1);
net.createServer((s)=>{s.on("error",()=>{});s.end(token);}).listen(Number(port),"0.0.0.0");`;
// Sleeps inside a source Pod so `kubectl exec` has a container to run in.
const idleSource = "setInterval(()=>{},1<<30);";
// Runs through `kubectl exec` in a source Pod. Only a reply carrying the expected
// token counts as connected: a completed TCP handshake alone does not.
export const clientSource = `const net=require("net");const [host,port,token,timeoutMs]=process.argv.slice(1);
let done=false;
let handshake=false;
const finish=(outcome)=>{if(done)return;done=true;process.stdout.write(JSON.stringify({outcome})+"\\n");process.exit(0);};
const socket=net.connect({host,port:Number(port)});
let data="";
socket.setTimeout(Number(timeoutMs)||5000);
// A completed handshake means the policy did not block this connection. Whatever
// happens after it (idle, reset, wrong bytes) is a client or target fault: "error",
// never "timeout" or "reset", so it cannot count as blocked.
socket.on("connect",()=>{handshake=true;});
socket.on("timeout",()=>finish(handshake?"error":"timeout"));
socket.on("data",(chunk)=>{data+=chunk;});
socket.on("end",()=>finish(data===token?"connected":"error"));
socket.on("close",()=>finish(data===token?"connected":"error"));
socket.on("error",(error)=>{
	if(handshake)finish("error");
	else if(error.code==="ECONNREFUSED")finish("refused");
	else if(error.code==="ECONNRESET"||error.code==="EPIPE")finish("reset");
	else if(error.code==="ETIMEDOUT")finish("timeout");
	else finish("error");
});`;

const names = (runId, index) => {
	const base = `np-probe-${runId}-n${index}`;
	return {
		base,
		target: `${base}-target`,
		original: `${base}-allow`,
		deny: `${base}-deny`,
		sourceWorker: `${base}-src-worker`,
		sourceOther: `${base}-src-other`,
	};
};

function hardenedPod({ placement, hostname, image, pullSecret, command }) {
	return {
		automountServiceAccountToken: false,
		enableServiceLinks: false,
		nodeSelector: {
			...structuredClone(placement.nodeSelector),
			...(hostname === undefined ? {} : { "kubernetes.io/hostname": hostname }),
		},
		tolerations: structuredClone(placement.tolerations),
		securityContext: {
			runAsNonRoot: true,
			runAsUser: 65532,
			runAsGroup: 65532,
			seccompProfile: { type: "RuntimeDefault" },
		},
		...(pullSecret ? { imagePullSecrets: [{ name: pullSecret }] } : {}),
		containers: [
			{
				name: "probe",
				image,
				command,
				securityContext: {
					allowPrivilegeEscalation: false,
					readOnlyRootFilesystem: true,
					capabilities: { drop: ["ALL"] },
				},
				resources: {
					requests: { cpu: "250m", memory: "512Mi" },
					limits: { cpu: "250m", memory: "512Mi" },
				},
			},
		],
	};
}

/** Expected effective spec of the temporary deny-all of one probe target. */
export const denyAllSpecV1 = (agentSelector) => ({
	podSelector: { matchLabels: { [agentSelector.key]: agentSelector.value } },
	policyTypes: ["Ingress"],
});

/**
 * Everything the operator applies for one node, plus the expectations later steps
 * check against. The original NetworkPolicy is the Worker template instantiated with
 * the probe substitution table; nothing is hand-written.
 */
export function probeNodePlanV1({
	runId,
	index,
	node,
	namespace,
	config,
	variant,
	port,
	image,
	pullSecret,
	architecture,
	compute,
}) {
	const id = names(runId, index);
	const hostname = node.metadata?.labels?.["kubernetes.io/hostname"];
	if (typeof hostname !== "string" || !hostname)
		fail("NODE_HOSTNAME_LABEL_MISSING");
	const agentSelector = {
		key: probeLabelKeysV1.agent,
		value: `${runId}-n${index}`,
	};
	const substitutions = {
		agentSelector,
		workerSource: { [probeLabelKeysV1.source]: "worker" },
		port,
	};
	let spec;
	try {
		spec = networkPolicySpecV1({ variant, config, substitutions });
	} catch {
		fail("PROBE_SUBSTITUTION_INVALID");
	}
	const placement = eciPlacementFieldsV1(architecture);
	const computeMetadata = acsPodMetadataV1(compute);
	const runLabel = { [probeLabelKeysV1.run]: runId };
	const targetLabels = {
		...runLabel,
		[agentSelector.key]: agentSelector.value,
		[probeLabelKeysV1.role]: "target",
	};
	const token = `np-probe-ok:${runId}-n${index}`;
	const meta = (name, labels) => ({ name, namespace, labels });
	const objects = {
		target: {
			apiVersion: "apps/v1",
			kind: "Deployment",
			metadata: meta(id.target, { ...runLabel }),
			spec: {
				replicas: 1,
				selector: { matchLabels: { ...targetLabels } },
				template: {
					metadata: {
						labels: { ...targetLabels, ...computeMetadata.labels },
						...(compute === "acs"
							? { annotations: computeMetadata.annotations }
							: {}),
					},
					spec: {
						// The ACK ACS label path may ignore selectors; bind only this probe to its node.
						...(compute === "acs" ? { nodeName: node.metadata.name } : {}),
						...hardenedPod({
							placement,
							hostname: compute === "acs" ? undefined : hostname,
							image,
							pullSecret,
							command: ["node", "-e", serverSource, String(port), token],
						}),
					},
				},
			},
		},
		original: {
			apiVersion: "networking.k8s.io/v1",
			kind: "NetworkPolicy",
			metadata: meta(id.original, { ...runLabel }),
			spec,
		},
		deny: {
			apiVersion: "networking.k8s.io/v1",
			kind: "NetworkPolicy",
			metadata: meta(id.deny, { ...runLabel }),
			spec: denyAllSpecV1(agentSelector),
		},
		sourceWorker: sourcePod(id.sourceWorker, "worker"),
		sourceOther: sourcePod(id.sourceOther, "other"),
	};
	function sourcePod(name, source) {
		return {
			apiVersion: "v1",
			kind: "Pod",
			metadata: {
				...meta(name, {
					...runLabel,
					...computeMetadata.labels,
					[probeLabelKeysV1.source]: source,
					[probeLabelKeysV1.role]: "source",
				}),
				...(compute === "acs"
					? { annotations: computeMetadata.annotations }
					: {}),
			},
			spec: {
				...hardenedPod({
					placement,
					hostname: undefined,
					image,
					pullSecret,
					command: ["node", "-e", idleSource],
				}),
				restartPolicy: "Always",
			},
		};
	}
	return {
		entry: {
			index,
			...(compute === undefined ? {} : { compute }),
			node: { name: node.metadata.name, uid: node.metadata.uid, hostname },
			names: id,
			agentSelector,
			substitutions,
			token,
			port,
			variant,
			expectedPolicySha256: networkPolicyEvidenceSha256V1(spec, config),
		},
		objects,
		files: {
			"target.deployment.yaml": objects.target,
			"policy-original.yaml": objects.original,
			"policy-deny.yaml": objects.deny,
			"source-worker.pod.yaml": objects.sourceWorker,
			"source-other.pod.yaml": objects.sourceOther,
		},
	};
}

/** The full plan: run description plus every manifest file, keyed by relative path. */
export function probePlanV1({
	runId,
	namespace,
	config,
	workerConfigurationSha256,
	renderedManifest,
	nodes,
	controllers = [],
	variant = "internal-only",
	port = 18080,
	image,
	pullSecret,
	now = Date.now(),
}) {
	if (!runIdPattern.test(runId ?? "")) fail("RUN_ID_INVALID");
	if (!imagePattern.test(image ?? "")) fail("PROBE_IMAGE_NOT_PINNED");
	if (pullSecret !== undefined && !secretNamePattern.test(pullSecret))
		fail("PULL_SECRET_INVALID");
	if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535)
		fail("PROBE_PORT_INVALID");
	let split;
	try {
		split = splitNetworkPolicyVariantV1(variant);
	} catch {
		fail("PROBE_VARIANT_INVALID");
	}
	// Multi-service variants need sibling Pods of one Agent and have no Worker source.
	if (!singleServiceVariants.has(split.base)) fail("PROBE_VARIANT_UNSUPPORTED");
	if (!networkPolicyVariantsV1(config).includes(variant))
		fail("PROBE_VARIANT_INVALID");
	const rendered = renderedWorkloadPlacementV1(renderedManifest, namespace);
	const { placement } = rendered;
	const candidates = eciCandidateNodesV1(nodes, placement.architecture);
	if (candidates.length === 0) fail("NO_CANDIDATE_NODE");
	const retained = controllers
		.map(
			(item) =>
				item.metadata?.annotations?.[
					"agent-infra.agora.io/agent-workload-placement"
				],
		)
		.filter((record) => ["amd64", "arm64", "acs:amd64"].includes(record))
		.map((record) => (record === "acs:amd64" ? "acs" : "eci"));
	const computes = [...Object.values(rendered.computes), ...retained].includes(
		"acs",
	)
		? rendered.computes
		: undefined;
	const backends = computes
		? [...new Set([...Object.values(computes), ...retained])]
		: [undefined];
	const plans = candidates
		.slice()
		.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
		.flatMap((node) => backends.map((compute) => ({ node, compute })))
		.map(({ node, compute }, index) =>
			probeNodePlanV1({
				compute,
				runId,
				index,
				node,
				namespace,
				config,
				variant,
				port,
				image,
				pullSecret,
				architecture: placement.architecture,
			}),
		);
	const files = {};
	for (const plan of plans)
		for (const [file, object] of Object.entries(plan.files))
			files[`manifests/n${plan.entry.index}/${file}`] = stringify(object, {
				aliasDuplicateObjects: false,
			});
	return {
		run: {
			schemaVersion: 1,
			kind: "agent-infra-networkpolicy-probe-run",
			runId,
			namespace,
			image,
			variant,
			port,
			placement,
			...(computes === undefined ? {} : { computes }),
			workerConfigurationSha256,
			renderedManifestSha256: sha256(renderedManifest),
			createdAt: new Date(now).toISOString(),
			nodes: plans.map((plan) => plan.entry),
		},
		files,
	};
}

// ---------------------------------------------------------------------------
// Step recording
// ---------------------------------------------------------------------------

/** One `kubectl exec` answer; anything but a known outcome is a probe failure. */
export function parseProbeOutput(stdout) {
	let value;
	try {
		value = JSON.parse(String(stdout).trim().split("\n").at(-1));
	} catch {
		fail("PROBE_OUTPUT_INVALID");
	}
	if (
		!value ||
		typeof value !== "object" ||
		Object.keys(value).join(",") !== "outcome" ||
		!probeOutcomes.has(value.outcome)
	)
		fail("PROBE_OUTPUT_INVALID");
	return value.outcome;
}

/**
 * Samples until the step settles. Positive steps stop at the first `connected`.
 * Negative steps need `stable` consecutive blocked samples (an `error` is never
 * blocked, and a `connected` resets the count): policy programming is
 * asynchronous, so a settle window is allowed, and every sample is kept.
 */
export async function settleProbeV1({
	expect,
	sample,
	sleep,
	now = Date.now,
	intervalMs = 5000,
	settleMs = 120_000,
	stable = 3,
}) {
	const samples = [];
	const deadline = now() + settleMs;
	let streak = 0;
	for (;;) {
		const outcome = await sample();
		const at = new Date(now()).toISOString();
		samples.push({ at, outcome });
		if (expect === "connected") {
			if (outcome === "connected") return { at, outcome, samples };
		} else if (blockedOutcomes.has(outcome)) {
			streak += 1;
			if (streak >= stable) return { at, outcome, samples };
		} else streak = 0;
		if (now() + intervalMs > deadline) {
			const error = new NetworkPolicyProbeError(
				expect === "connected" ? "PROBE_NOT_CONNECTED" : "PROBE_NOT_BLOCKED",
			);
			error.samples = samples;
			throw error;
		}
		await sleep(intervalMs);
	}
}

const expectations = {
	allow: { source: "sourceWorker", expect: "connected" },
	nonWorker: { source: "sourceOther", expect: "blocked" },
	deny: { source: "sourceWorker", expect: "blocked" },
	recovery: { source: "sourceWorker", expect: "connected" },
};

function readJson(file, code) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		fail(code);
	}
}
function writeJson(file, value, mode = 0o600) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

const objectNamePattern = (runId) =>
	new RegExp(
		`^np-probe-${runId}-n\\d{1,3}(?:-(?:target|allow|deny|src-worker|src-other))?$`,
		"u",
	);
/**
 * Reads `run.json`. Every command that touches the cluster passes the namespace it
 * is about to act in; it must be the one the run was rendered for, and the run id
 * and object names are re-validated because they decide what `cleanup` may delete.
 */
export function loadRun(dir, namespace) {
	const run = readJson(join(dir, "run.json"), "RUN_FILE_INVALID");
	if (
		run?.kind !== "agent-infra-networkpolicy-probe-run" ||
		run.schemaVersion !== 1
	)
		fail("RUN_FILE_INVALID");
	if (namespace !== undefined && run.namespace !== namespace)
		fail("RUN_NAMESPACE_MISMATCH");
	if (!runIdPattern.test(run.runId ?? "") || !Array.isArray(run.nodes))
		fail("RUN_FILE_INVALID");
	const pattern = objectNamePattern(run.runId);
	for (const entry of run.nodes)
		for (const name of Object.values(entry?.names ?? {}))
			if (typeof name !== "string" || !pattern.test(name))
				fail("RUN_FILE_INVALID");
	return run;
}
const resultsFile = (dir, index) => join(dir, "results", `n${index}.json`);
const loadResults = (dir, index) =>
	existsSync(resultsFile(dir, index))
		? readJson(resultsFile(dir, index), "RESULTS_INVALID")
		: { index, steps: {} };

/** Normalizes API defaults so the live spec can be compared to the rendered one. */
export function normalizePolicySpecV1(spec) {
	const normalizePorts = (ports) =>
		ports?.map((port) => ({ ...port, protocol: port.protocol ?? "TCP" }));
	const rules = (list) =>
		list?.map((rule) => ({
			...rule,
			...(rule.ports ? { ports: normalizePorts(rule.ports) } : {}),
		}));
	return canonical({
		...spec,
		...(spec.ingress ? { ingress: rules(spec.ingress) } : {}),
		...(spec.egress ? { egress: rules(spec.egress) } : {}),
	});
}
const emptyAsAbsent = (spec) => {
	const { ingress, egress, ...rest } = spec;
	return {
		...rest,
		...(ingress?.length ? { ingress } : {}),
		...(egress?.length ? { egress } : {}),
	};
};
export const policySpecsMatch = (live, expected) =>
	same(
		emptyAsAbsent(normalizePolicySpecV1(live ?? {})),
		emptyAsAbsent(normalizePolicySpecV1(expected)),
	);

const notFound = (error) =>
	/NotFound|not found/i.test(String(error?.stderr ?? error));

/** `kubectl get`, or `null` for NotFound. Anything else is a read failure. */
function getOptional(kubectl, args) {
	try {
		return JSON.parse(kubectl(["get", ...args, "-o", "json"]));
	} catch (error) {
		if (notFound(error)) return null;
		fail("READ_FAILED");
	}
}
const getRequired = (kubectl, args) => {
	const value = getOptional(kubectl, args);
	if (value === null) fail("PROBE_OBJECT_MISSING");
	return value;
};

function targetPod(kubectl, run, entry) {
	const list = getRequired(kubectl, [
		"pods",
		"-l",
		`${probeLabelKeysV1.run}=${run.runId},${probeLabelKeysV1.agent}=${entry.agentSelector.value}`,
	]);
	if (list.items?.length !== 1) fail("PROBE_TARGET_NOT_UNIQUE");
	const pod = list.items[0];
	if (
		pod.status?.phase !== "Running" ||
		pod.spec?.nodeName !== entry.node.name ||
		typeof pod.status?.podIP !== "string" ||
		(pod.status?.containerStatuses ?? []).some((status) => !status.ready)
	)
		fail("PROBE_TARGET_NOT_READY");
	return pod;
}

/** Records one step of one node. `exec` runs the client in a source Pod. */
export async function recordProbeStepV1({
	dir,
	index,
	step,
	kubectl,
	exec,
	sleep,
	namespace,
	now = Date.now,
	settleMs,
	intervalMs,
}) {
	if (!probeSteps.includes(step)) fail("STEP_INVALID");
	const run = loadRun(dir, namespace);
	const entry = run.nodes.find((node) => node.index === index);
	if (!entry) fail("NODE_UNKNOWN");
	const results = loadResults(dir, index);
	const previous = probeSteps[probeSteps.indexOf(step) - 1];
	if (results.steps[step] || (previous && !results.steps[previous]))
		fail("STEP_OUT_OF_ORDER");

	const pod = targetPod(kubectl, run, entry);
	const snapshot = {
		pod: pod.metadata.name,
		uid: pod.metadata.uid,
		podIP: pod.status.podIP,
		restartCount: pod.status.containerStatuses?.[0]?.restartCount ?? 0,
	};
	if (snapshot.restartCount !== 0) fail("PROBE_TARGET_CHANGED");
	if (!results.target) results.target = snapshot;
	else if (results.target.uid !== snapshot.uid) fail("PROBE_TARGET_CHANGED");
	for (const source of ["sourceWorker", "sourceOther"]) {
		const live = getRequired(kubectl, ["pod", entry.names[source]]);
		if (live.status?.phase !== "Running") fail("PROBE_SOURCE_NOT_READY");
	}

	// Which policy objects must exist at this step.
	const original = getOptional(kubectl, [
		"networkpolicy",
		entry.names.original,
	]);
	const deny = getOptional(kubectl, ["networkpolicy", entry.names.deny]);
	const wantOriginal = step !== "deny";
	if ((original !== null) !== wantOriginal || (deny !== null) === wantOriginal)
		fail("PROBE_POLICY_STATE_INVALID");
	const live = wantOriginal ? original : deny;
	const expectedSpec = wantOriginal
		? readManifestSpec(dir, index, "policy-original.yaml")
		: denyAllSpecV1(entry.agentSelector);
	if (!policySpecsMatch(live.spec, expectedSpec))
		fail("PROBE_POLICY_READBACK_MISMATCH");
	// The policy UID live during each step is part of its record. The original
	// policy is re-created for recovery, so allow and nonWorker must agree and
	// recovery is expected to differ.
	const policyUid = live.metadata.uid;
	if (step === "nonWorker" && policyUid !== results.steps.allow.policyUid)
		fail("PROBE_POLICY_STATE_INVALID");

	const { source, expect } = expectations[step];
	const sourcePodName = entry.names[source];
	let settled;
	try {
		settled = await settleProbeV1({
			expect,
			sample: async () =>
				parseProbeOutput(
					await exec({
						pod: sourcePodName,
						host: snapshot.podIP,
						port: entry.port,
						token: entry.token,
					}),
				),
			sleep,
			now,
			settleMs,
			intervalMs,
		});
	} catch (error) {
		if (error instanceof NetworkPolicyProbeError && error.samples) {
			results.failed = { step, code: error.code, samples: error.samples };
			writeJson(resultsFile(dir, index), results);
		}
		throw error;
	}
	// The target must have stayed the same Pod while the probe ran.
	const after = targetPod(kubectl, run, entry);
	if (
		after.metadata.uid !== snapshot.uid ||
		(after.status.containerStatuses?.[0]?.restartCount ?? 0) !== 0
	)
		fail("PROBE_TARGET_CHANGED");
	results.steps[step] = {
		at: settled.at,
		outcome: settled.outcome,
		policyUid,
		samples: settled.samples,
	};
	delete results.failed;
	writeJson(resultsFile(dir, index), results);
	return results.steps[step];
}

function readManifestSpec(dir, index, file) {
	const text = readFileSync(join(dir, "manifests", `n${index}`, file), "utf8");
	return parseYamlSpec(text);
}
const parseYamlSpec = (text) => parse(text).spec;

// ---------------------------------------------------------------------------
// Evidence assembly
// ---------------------------------------------------------------------------

/**
 * Builds the evidence document from the recorded steps and a live read-back of the
 * probe objects (labels, UIDs, controllers come from the API, not from manifests).
 */
export function buildEvidenceV1({
	run,
	resultsByIndex,
	live,
	config,
	clusterId,
	now = Date.now(),
	validForMs = maxEvidenceAgeMs,
}) {
	if (!clusterIdPattern.test(clusterId ?? "")) fail("CLUSTER_ID_INVALID");
	if (validForMs <= 0 || validForMs > maxEvidenceAgeMs)
		fail("VALIDITY_INVALID");
	const observedAt = new Date(now).toISOString();
	const probes = run.nodes.map((entry) => {
		const results = resultsByIndex.get(entry.index);
		if (!results || results.failed) fail("RESULTS_INCOMPLETE");
		for (const step of probeSteps)
			if (!results.steps?.[step]) fail("RESULTS_INCOMPLETE");
		const pods = live.pods.filter(
			(pod) =>
				pod.metadata?.labels?.[probeLabelKeysV1.agent] ===
				entry.agentSelector.value,
		);
		if (pods.length !== 1) fail("PROBE_TARGET_NOT_UNIQUE");
		const pod = pods[0];
		if (
			pod.metadata.uid !== results.target.uid ||
			pod.spec?.nodeName !== entry.node.name
		)
			fail("PROBE_TARGET_CHANGED");
		const instanceId = observedComputeInstanceIdV1(entry.compute, pod.metadata.annotations);
		if (run.computes) {
			if (!instanceId) fail("PROBE_COMPUTE_MISMATCH");
			const metadata = acsPodMetadataV1(entry.compute);
			if (
				!matchesComputeLabelsV1(entry.compute, pod.metadata.labels) ||
				Object.entries(metadata.annotations).some(
					([key, value]) => pod.metadata.annotations?.[key] !== value,
				)
			)
				fail("PROBE_COMPUTE_MISMATCH");
		}
		const replicaSet = live.replicaSets.find(
			(item) => item.metadata?.uid === pod.metadata.ownerReferences?.[0]?.uid,
		);
		const deployment = live.deployments.find(
			(item) =>
				item.metadata?.uid ===
					replicaSet?.metadata?.ownerReferences?.[0]?.uid &&
				item.metadata?.name === entry.names.target,
		);
		if (!deployment) fail("PROBE_CONTROLLER_MISSING");
		const policy = live.policies.find(
			(item) => item.metadata?.name === entry.names.original,
		);
		if (!policy) fail("PROBE_OBJECT_MISSING");
		const instantiated = networkPolicySpecV1({
			variant: entry.variant,
			config,
			substitutions: entry.substitutions,
		});
		// The Worker inputs must be the ones the probe policy was rendered from.
		if (
			networkPolicyEvidenceSha256V1(instantiated, config) !==
			entry.expectedPolicySha256
		)
			fail("INPUTS_CHANGED_SINCE_RENDER");
		if (!policySpecsMatch(policy.spec, instantiated))
			fail("PROBE_POLICY_READBACK_MISMATCH");
		const source = (name) => {
			const item = live.pods.find(
				(candidate) => candidate.metadata?.name === name,
			);
			if (!item) fail("PROBE_OBJECT_MISSING");
			return { ...item.metadata.labels };
		};
		const step = (name) => ({
			at: results.steps[name].at,
			outcome: results.steps[name].outcome,
		});
		return {
			destination: {
				pod: pod.metadata.name,
				...(run.computes ? { compute: entry.compute, instanceId } : {}),
				uid: pod.metadata.uid,
				nodeName: pod.spec.nodeName,
				port: entry.port,
				controller: {
					kind: "Deployment",
					name: deployment.metadata.name,
					uid: deployment.metadata.uid,
				},
			},
			policy: {
				name: policy.metadata.name,
				uid: policy.metadata.uid,
				variant: entry.variant,
				substitutions: entry.substitutions,
				podLabels: {
					target: { ...pod.metadata.labels },
					workerSource: source(entry.names.sourceWorker),
					nonWorkerSource: source(entry.names.sourceOther),
				},
				instantiatedSha256: networkPolicyEvidenceSha256V1(instantiated, config),
			},
			allow: step("allow"),
			deny: { ...step("deny"), policyUid: results.steps.deny.policyUid },
			recovery: step("recovery"),
			nonWorker: step("nonWorker"),
		};
	});
	return {
		schemaVersion: 1,
		kind: "agent-infra-networkpolicy-enforcement-evidence",
		cluster: {
			kubeSystemNamespaceUid: live.kubeSystemNamespaceUid,
			clusterId,
		},
		namespace: { name: live.namespace.name, uid: live.namespace.uid },
		enforcer: {
			runtime: run.computes
				? run.computes.agent === run.computes.session
					? run.computes.agent
					: "mixed"
				: "eci",
			component: "poseidon",
			version: "unobservable",
		},
		placement: {
			architecture: run.placement.architecture,
			legacyUnplaced: run.placement.legacyUnplaced,
			selectorSha256: placementSelectorSha256V1(
				run.placement.architecture,
				run.computes,
			),
			...(run.computes ? { computes: run.computes } : {}),
		},
		nodes: [
			...new Map(
				run.nodes.map((entry) => [
					entry.node.name,
					{ name: entry.node.name, uid: entry.node.uid },
				]),
			).values(),
		],
		probes,
		networkPolicy: { templateSha256: networkPolicyTemplateDigestsV1(config) },
		observedAt,
		expiresAt: new Date(now + validForMs).toISOString(),
	};
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function makeKubectl(namespace) {
	return (args) =>
		execFileSync(
			process.env.KUBECTL_BIN ?? "kubectl",
			["--request-timeout=30s", "--namespace", namespace, ...args],
			{
				encoding: "utf8",
				// Foreground deletion of an ECI Pod can take minutes; `cleanup` is safe to re-run.
				timeout: args[0] === "delete" ? 300_000 : 60_000,
				maxBuffer: 64 * 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
}

function makeExec(namespace) {
	return async ({ pod, host, port, token }) => {
		try {
			return makeKubectl(namespace)([
				"exec",
				pod,
				"-c",
				"probe",
				"--",
				"node",
				"-e",
				clientSource,
				host,
				String(port),
				token,
			]);
		} catch {
			return fail("PROBE_EXEC_FAILED");
		}
	};
}

function option(argv, name) {
	const index = argv.indexOf(`--${name}`);
	return index === -1 ? undefined : argv[index + 1];
}

async function inputs(namespace) {
	const rendered = process.env.ACK_RENDERED_MANIFEST_FILE;
	if (!rendered) fail("RENDERED_MANIFEST_REQUIRED");
	let renderedManifest;
	try {
		renderedManifest = readFileSync(rendered, "utf8");
	} catch {
		fail("RENDERED_MANIFEST_REQUIRED");
	}
	const { config, workerConfigurationSha256 } =
		await deriveNetworkPolicyDeploymentConfigV1({
			bootstrapInputsFile: process.env.ACK_BOOTSTRAP_INPUTS_FILE,
			renderedManifest,
			namespace,
		});
	return { config, workerConfigurationSha256, renderedManifest };
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

export async function main(argv) {
	const [command] = argv;
	const namespace = process.env.ACK_NAMESPACE ?? "agent-infra";
	if (!option(argv, "dir")) fail("DIR_REQUIRED");
	const dir = resolve(option(argv, "dir"));
	const kubectl = makeKubectl(namespace);
	if (command === "render") {
		if (existsSync(join(dir, "run.json"))) fail("RUN_EXISTS");
		const { config, workerConfigurationSha256, renderedManifest } =
			await inputs(namespace);
		const observed = collectNetworkPolicyObservedV1(namespace, kubectl);
		const nodes = observed.nodes;
		const plan = probePlanV1({
			runId: option(argv, "run-id"),
			namespace,
			config,
			workerConfigurationSha256,
			renderedManifest,
			nodes,
			controllers: observed.controllers,
			variant: option(argv, "variant") ?? "internal-only",
			port: Number(option(argv, "port") ?? 18080),
			image: process.env.NP_PROBE_IMAGE,
			pullSecret: process.env.NP_PROBE_PULL_SECRET || undefined,
		});
		for (const [file, content] of Object.entries(plan.files)) {
			mkdirSync(dirname(join(dir, file)), { recursive: true });
			writeFileSync(join(dir, file), content, { mode: 0o600 });
		}
		writeJson(join(dir, "run.json"), plan.run);
		return {
			status: "rendered",
			runId: plan.run.runId,
			nodes: plan.run.nodes.map((node) => ({
				index: node.index,
				name: node.node.name,
			})),
			files: Object.keys(plan.files).length,
		};
	}
	if (command === "probe") {
		const index = Number(option(argv, "node"));
		const step = option(argv, "step");
		const result = await recordProbeStepV1({
			dir,
			index,
			step,
			kubectl,
			exec: makeExec(namespace),
			namespace,
			sleep: delay,
			settleMs: option(argv, "settle-seconds")
				? Number(option(argv, "settle-seconds")) * 1000
				: undefined,
		});
		return {
			status: "recorded",
			node: index,
			step,
			outcome: result.outcome,
			at: result.at,
			samples: result.samples.length,
		};
	}
	if (command === "assemble")
		return assembleEvidenceV1({
			dir,
			kubectl,
			namespace,
			inputs: await inputs(namespace),
			clusterId: process.env.ACK_CLUSTER_ID,
			validForMs: option(argv, "valid-hours")
				? Number(option(argv, "valid-hours")) * 3_600_000
				: undefined,
		});
	if (command === "cleanup") return cleanup({ dir, kubectl, namespace });
	return fail("COMMAND_UNKNOWN");
}

/**
 * Reads the live probe objects back, builds the evidence and lets the production
 * gate's own pure function judge it before anything is cleaned up. Writes
 * `evidence.json` only when the gate passes.
 */
export function assembleEvidenceV1({
	dir,
	kubectl,
	namespace,
	inputs: { config, workerConfigurationSha256, renderedManifest },
	clusterId,
	validForMs,
	now = Date.now(),
}) {
	const run = loadRun(dir, namespace);
	if (
		workerConfigurationSha256 !== run.workerConfigurationSha256 ||
		sha256(renderedManifest) !== run.renderedManifestSha256
	)
		fail("INPUTS_CHANGED_SINCE_RENDER");
	const observed = collectNetworkPolicyObservedV1(namespace, kubectl);
	const nodes = eciCandidateNodesV1(observed.nodes, run.placement.architecture);
	if (
		!same(
			nodes.map((node) => [node.metadata.name, node.metadata.uid]).sort(),
			[
				...new Map(
					run.nodes.map((entry) => [
						entry.node.name,
						[entry.node.name, entry.node.uid],
					]),
				).values(),
			].sort(),
		)
	)
		fail("NODE_SET_CHANGED");
	const select = (kind) =>
		getRequired(kubectl, [kind, "-l", `${probeLabelKeysV1.run}=${run.runId}`])
			.items;
	const live = {
		namespace: observed.namespace,
		kubeSystemNamespaceUid: observed.kubeSystemNamespaceUid,
		pods: select("pods"),
		replicaSets: select("replicasets"),
		deployments: select("deployments"),
		policies: select("networkpolicies"),
	};
	const resultsByIndex = new Map(
		run.nodes.map((entry) => [entry.index, loadResults(dir, entry.index)]),
	);
	const evidence = buildEvidenceV1({
		run,
		resultsByIndex,
		live,
		config,
		clusterId,
		now,
		validForMs,
	});
	const summary = validateNetworkPolicyEnforcementV1({
		evidence,
		deploymentConfig: config,
		renderedManifest,
		observed,
		now,
	});
	const file = join(dir, "evidence.json");
	const bytes = `${JSON.stringify(evidence, null, 2)}\n`;
	writeFileSync(file, bytes, { mode: 0o600 });
	return {
		status: "assembled",
		evidenceFile: file,
		evidenceSha256: sha256(bytes),
		gate: summary.status,
		probes: summary.probes,
		candidateNodes: summary.candidateNodes,
		expiresAt: evidence.expiresAt,
	};
}

/**
 * Deletes exactly the objects this run created: top-level probe objects carrying the
 * run label, whose names are in `run.json`. A live object with the label but an
 * unexpected name stops the cleanup. UIDs are recorded in the receipt and checked
 * against the listing right before each delete; absence is read back afterwards.
 */
export function cleanup({ dir, kubectl, namespace }) {
	const run = loadRun(dir, namespace);
	const expected = new Set(
		run.nodes.flatMap((entry) => Object.values(entry.names)),
	);
	const selector = `${probeLabelKeysV1.run}=${run.runId}`;
	const list = (kind) => getRequired(kubectl, [kind, "-l", selector]).items;
	const owned = [
		...list("deployments").map((item) => ["deployment", item]),
		...list("networkpolicies").map((item) => ["networkpolicy", item]),
		...list("pods")
			.filter((item) => !item.metadata?.ownerReferences?.length)
			.map((item) => ["pod", item]),
	];
	for (const [, item] of owned)
		if (!expected.has(item.metadata.name)) fail("CLEANUP_UNEXPECTED_OBJECT");
	const deleted = [];
	for (const [kind, item] of owned) {
		const current = getOptional(kubectl, [kind, item.metadata.name]);
		if (current === null) continue;
		if (current.metadata.uid !== item.metadata.uid) fail("CLEANUP_UID_CHANGED");
		kubectl([
			"delete",
			kind,
			item.metadata.name,
			"--cascade=foreground",
			"--wait=true",
			"--timeout=240s",
		]);
		deleted.push({ kind, name: item.metadata.name, uid: item.metadata.uid });
	}
	for (const kind of ["deployments", "replicasets", "pods", "networkpolicies"])
		if (list(kind).length > 0) fail("CLEANUP_NOT_COMPLETE");
	const receipt = { status: "cleaned", runId: run.runId, deleted };
	writeJson(join(dir, "cleanup-receipt.json"), receipt);
	return receipt;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const result = await main(process.argv.slice(2));
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} catch (error) {
		const code =
			error instanceof NetworkPolicyProbeError
				? error.code
				: "UNEXPECTED_FAILURE";
		process.stderr.write(
			`${JSON.stringify({ status: "failed", scope: "networkpolicy-probe", code })}\n`,
		);
		process.exitCode = 2;
	}
}
