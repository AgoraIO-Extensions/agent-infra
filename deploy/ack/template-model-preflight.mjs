#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, createHmac, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { CODEX_SESSION_EXECUTOR_ATTESTATION_ENV, CODEX_SESSION_EXECUTOR_BINDING_ENV, codexSessionExecutorAttestationV1, createCodexSessionExecutorBindingV1 } from "../../packages/agent-runtime/src/codex-session-executor-binding.ts";
import { workloadResourceConfigurationHashV1, validateCodexSessionExecutorResourcePolicyV1, validateWorkloadControlResourcesV1, sessionSandboxResourceCostsV1, resourceQuantityEqualsV1, workloadResourcesEqualV1, workloadControlResourcesEqualV1 } from "../../packages/platform-core/src/workload-resource-configuration.ts";
import { templatePreflightValidationReceipt } from "./template-validation.mjs";
import { templateValidationContextV1Schema } from "../../packages/model-catalog/dist/index.mjs";

const runner = join(import.meta.dirname, "template-model-preflight-runner.mts");
const templates = new Set(["codex", "claude", "opencode", "pi"]);
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const sourcePattern = /^[a-f0-9]{40}$/u;
const namePattern = /^(?:ack-preflight-|sandbox-preflight-)[a-z0-9-]+$/u;
const controlResources = (job) => job.resources ?? { requests: { cpu: "100m", memory: "128Mi" }, limits: job.expectedResourceLimits };
const usesExecutor = (job) => job.templateId === "codex" && job.codexSessionExecutor !== undefined;
const inheritsPlacement = (job) => job.codexSessionExecutor !== undefined && job.codexSessionExecutor.placement === undefined && job.placement === undefined;
const isDefaultNodeToleration = (entry) => ["node.kubernetes.io/not-ready", "node.kubernetes.io/unreachable"].includes(entry.key) && entry.operator === "Exists" && entry.effect === "NoExecute" && (entry.tolerationSeconds === undefined || entry.tolerationSeconds === 300) && Object.keys(entry).every((key) => ["key", "operator", "effect", "tolerationSeconds"].includes(key));
const startupEventReasons = new Set([
	"Pulling", "Pulled", "SuccessfulHitImageCache", "ImageCacheNotFullMatch",
	"ImageCacheAutoCreated", "ImageCacheAutoEliminated",
]);
const timestampMs = (value) => {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && parsed >= 0 && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19) ? parsed : null;
};
const iso = (value) => value === null ? null : new Date(value).toISOString();
const durationSeconds = (from, to, maximum) =>
	from === null || to === null || to < from || to - from > maximum * 1000 ? null : (to - from) / 1000;

export function projectPodStartupReceipt({ job: input, expectedPod, pod, events }) {
	const job = validateTemplatePreflightJob(input);
	const uid = pod?.metadata?.uid;
	if (!expectedPod || pod?.metadata?.name !== expectedPod.name || pod?.metadata?.namespace !== job.namespace ||
		pod?.metadata?.labels?.["agent-infra.validation-owner"] !== expectedPod.owner ||
		pod?.metadata?.labels?.["agent-infra.validation-source"] !== job.sourceCommit ||
		pod?.metadata?.labels?.["agent-infra.validation-scope"] !== job.scope ||
		pod?.spec?.containers?.length !== (usesExecutor(job) ? 2 : 1) || pod.spec.containers[0].name !== "runtime" ||
		pod.spec.containers.some((container) => container.image !== job.imageReference) || typeof uid !== "string" || !uid)
		throw new Error("STARTUP_RECEIPT_BINDING_INVALID");
	const maximum = job.podReadyTimeoutSeconds + 60;
	const created = timestampMs(pod.metadata.creationTimestamp);
	const runtime = pod.status?.containerStatuses?.find((container) => container.name === "runtime");
	const started = timestampMs(runtime?.state?.running?.startedAt);
	const ready = timestampMs(pod.status?.conditions?.find((condition) => condition.type === "Ready" && condition.status === "True")?.lastTransitionTime);
	const timingsKnown = durationSeconds(created, started, maximum) !== null && durationSeconds(started, ready, maximum) !== null && durationSeconds(created, ready, maximum) !== null;
	const matching = Array.isArray(events) && events.length <= 256 ? events.filter((event) =>
		event?.involvedObject?.uid === uid && event.involvedObject.kind === "Pod" &&
		startupEventReasons.has(event.reason) && ["Normal", "Warning"].includes(event.type)) : [];
	const timedEvents = matching.map((event) => {
		const first = timestampMs(event.firstTimestamp ?? event.eventTime);
		const last = timestampMs(event.lastTimestamp ?? event.series?.lastObservedTime ?? event.eventTime ?? event.firstTimestamp);
		const times = [event.firstTimestamp, event.lastTimestamp, event.eventTime, event.series?.lastObservedTime]
			.filter((value) => value !== undefined && value !== null).map(timestampMs);
		const valid = created !== null && ready !== null && first !== null && last !== null && last >= first &&
			times.every((time) => time !== null && time >= created && time <= ready);
		return { event, valid, first, last };
	});
	const eventRead = !Array.isArray(events) ? "unavailable" : matching.length === 0 || timedEvents.some((event) => !event.valid) ? "unknown" : "observed";
	const projected = timedEvents.filter(({ valid }) => valid).map(({ event, first, last }) =>
		({ reason: event.reason, type: event.type, firstAt: iso(first), lastAt: iso(last) }));
	const hasReason = (reason) => eventRead === "observed" ? projected.some((event) => event.reason === reason) : null;
	const pulling = projected.filter((event) => event.reason === "Pulling");
	const pulled = projected.filter((event) => event.reason === "Pulled");
	const pullStart = pulling.length === 1 ? timestampMs(pulling[0].firstAt) : null;
	const pullEnd = pulled.length === 1 ? timestampMs(pulled[0].lastAt) : null;
	// A cache-hit event can coexist with an image download; only the exact Pulled message proves presence.
	const alreadyPresent = eventRead === "observed" && timedEvents.some(({ event }) => event.reason === "Pulled" && event.message === `Container image "${job.imageReference}" already present on machine`);
	const pullSeconds = eventRead === "observed" ? durationSeconds(pullStart, pullEnd, maximum) : null;
	return {
		schemaVersion: 1, kind: "ack-template-pod-startup", sourceCommit: job.sourceCommit,
		templateId: job.templateId, imageDigest: job.imageDigest,
		podUidSha256: createHash("sha256").update(uid).digest("hex"),
		timingReadback: timingsKnown ? "observed" : "unknown",
		timestamps: { createdAt: iso(created), containerStartedAt: iso(started), readyAt: iso(ready) },
		durationsSeconds: {
			createToContainer: timingsKnown ? durationSeconds(created, started, maximum) : null,
			createToReady: timingsKnown ? durationSeconds(created, ready, maximum) : null,
			containerToReady: timingsKnown ? durationSeconds(started, ready, maximum) : null,
		},
		eventRead, events: projected,
		cache: {
			hit: hasReason("SuccessfulHitImageCache"), partialMatch: hasReason("ImageCacheNotFullMatch"),
			autoCreated: hasReason("ImageCacheAutoCreated"), autoEvicted: hasReason("ImageCacheAutoEliminated"),
			imageAlreadyPresent: alreadyPresent ? true : pullSeconds !== null ? false : null,
		},
		pull: { status: pullSeconds !== null ? "observed" : "unknown", seconds: pullSeconds },
	};
}

async function writePodStartupReceipt(job, expectedPod, pod) {
	let events;
	try {
		const value = JSON.parse(run([
			"--kubeconfig", job.kubeconfig, "-n", job.namespace, "get", "events",
			"--field-selector", `involvedObject.uid=${pod.metadata.uid}`, "-o", "json",
		], undefined, 5_000));
		if (Array.isArray(value.items)) events = value.items;
	} catch {}
	await writeFile(join(job.outputDirectory, "pod-startup.receipt.json"), `${JSON.stringify(
		projectPodStartupReceipt({ job, expectedPod, pod, events }), null, 2,
	)}\n`, { mode: 0o600, flag: "wx" });
}

const privateFile = async (path, label) => {
	if (!isAbsolute(path)) throw new Error(`${label}_PATH_INVALID`);
	const stat = await lstat(path);
	if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
		throw new Error(`${label}_FILE_INVALID`);
	return readFile(path);
};
const run = (args, input, timeout) =>
	execFileSync("kubectl", args, {
		input,
		timeout,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
	});

export function validateTemplatePreflightJob(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JOB_INVALID");
	const allowed = new Set([
		"schemaVersion", "scope", "kubeconfig", "namespace", "sourceCommit", "templateId", "driver",
		"protocol", "operatorApprovalRef", "worktree", "outputDirectory", "imageReference", "imageDigest",
		"modelId", "modelOptionId", "reasoningLevel", "configurationRevision", "runtimeConfigVersion",
		"approvedRelayOrigin", "grantPrivateKeyFile", "runtimeServiceTokenFile", "relayKeyFile",
		"expectedResourceLimits", "expectedNodePrefix", "expectedReply", "placement", "imagePullSecret",
		"podReadyTimeoutSeconds", "resourceProfileRef", "resources", "codexSessionExecutor", "workspaceSnapshotEgress", "storageSize", "storageClassName", "modelEgress", "dnsEgress", "allowedPodTopologyLabelValues", "validationContext",
	]);
	if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("JOB_UNBOUNDED");
	if (value.validationContext !== undefined) {
		const target = templateValidationContextV1Schema.parse(value.validationContext);
		if (target.sourceCommit !== value.sourceCommit || target.namespace !== value.namespace) throw new Error("PREFLIGHT_TARGET_INVALID");
	}
	if (
		value.schemaVersion !== 1 || value.scope !== "isolated-template-real-model" ||
		!isAbsolute(value.kubeconfig) || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.namespace) ||
		!sourcePattern.test(value.sourceCommit) || !templates.has(value.templateId) ||
		!new Set(["codex", "claude", "acp", "pi"]).has(value.driver) ||
		!new Set(["openai-responses-v1", "anthropic-messages-v1"]).has(value.protocol) ||
		!isAbsolute(value.worktree) || !isAbsolute(value.outputDirectory) ||
		!digestPattern.test(value.imageDigest) || !value.imageReference.endsWith(`@${value.imageDigest}`) ||
		typeof value.operatorApprovalRef !== "string" || !value.operatorApprovalRef ||
		typeof value.modelId !== "string" || !value.modelId || typeof value.modelOptionId !== "string" ||
		!value.modelOptionId || typeof value.reasoningLevel !== "string" || !value.reasoningLevel ||
		typeof value.configurationRevision !== "string" || !value.configurationRevision ||
		typeof value.runtimeConfigVersion !== "string" || !value.runtimeConfigVersion ||
		typeof value.approvedRelayOrigin !== "string" || !isAbsolute(value.grantPrivateKeyFile) ||
		!isAbsolute(value.runtimeServiceTokenFile) || !isAbsolute(value.relayKeyFile) ||
		!value.expectedResourceLimits || value.expectedResourceLimits.cpu !== "1" || value.expectedResourceLimits.memory !== "2Gi"
	)
		throw new Error("JOB_INVALID");
	if (value.codexSessionExecutor !== undefined) {
		validateCodexSessionExecutorResourcePolicyV1(value.codexSessionExecutor);
		if (typeof value.resourceProfileRef !== "string" || !value.resourceProfileRef || typeof value.storageSize !== "string" || !value.storageSize ||
			typeof value.storageClassName !== "string" || !/^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/.test(value.storageClassName))
			throw new Error("EXECUTOR_CAPACITY_INPUT_INVALID");
		if (usesExecutor(value) && (value.driver !== "codex" || value.protocol !== "openai-responses-v1" ||
			value.imageReference.split("@")[0] !== "ghcr.io/agoraio-extensions/agent-infra/agent-runtime-codex"))
			throw new Error("EXECUTOR_CAPACITY_IMAGE_INVALID");
	}
	if (value.resourceProfileRef !== undefined) {
		if (typeof value.resourceProfileRef !== "string" || !value.resourceProfileRef || typeof value.storageSize !== "string" || typeof value.storageClassName !== "string" || !/^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/.test(value.storageClassName)) throw new Error("CAPACITY_INPUT_INVALID");
		const resources = controlResources(value);
		if (value.codexSessionExecutor === undefined) validateCodexSessionExecutorResourcePolicyV1({ resources });
		else validateWorkloadControlResourcesV1(resources);
		assert.deepEqual(resources.limits, value.expectedResourceLimits);
		preflightNetworkEgress(value);
		const topology = value.allowedPodTopologyLabelValues ?? {};
		if (!topology || typeof topology !== "object" || Array.isArray(topology) || Object.entries(topology).some(([key, values]) => !["topology.kubernetes.io/region", "topology.kubernetes.io/zone"].includes(key) || !Array.isArray(values) || !values.length || values.length > 16 || values.some((label) => typeof label !== "string" || !/^[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/.test(label)))) throw new Error("PREFLIGHT_TOPOLOGY_INVALID");
		sessionSandboxResourceCostsV1({ resources, storageSize: value.storageSize, codexSessionExecutor: value.codexSessionExecutor });
	} else if (value.resources !== undefined || value.workspaceSnapshotEgress !== undefined || value.storageSize !== undefined || value.storageClassName !== undefined || value.modelEgress !== undefined || value.dnsEgress !== undefined || value.allowedPodTopologyLabelValues !== undefined) throw new Error("CAPACITY_INPUT_INVALID");
	const relay = new URL(value.approvedRelayOrigin);
	if (relay.protocol !== "https:" || relay.username || relay.password || relay.search || relay.hash)
		throw new Error("RELAY_ORIGIN_INVALID");
	const nodeSelector = value.placement?.nodeSelector;
	const hostname = nodeSelector?.["kubernetes.io/hostname"];
	const pinnedEcs = nodeSelector?.type === undefined &&
		nodeSelector?.["kubernetes.io/arch"] === "amd64" &&
		nodeSelector?.["kubernetes.io/os"] === "linux" &&
		typeof hostname === "string" && /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/.test(hostname) &&
		!hostname.startsWith("virtual-kubelet-") && value.expectedNodePrefix === hostname;
	const inherited = inheritsPlacement(value);
	if (inherited && (typeof value.expectedNodePrefix !== "string" || !/^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/.test(value.expectedNodePrefix) || value.expectedNodePrefix.startsWith("virtual-kubelet-")))
		throw new Error("TEMPLATE_PLACEMENT_INVALID");
	if (!inherited && (!nodeSelector || (nodeSelector.type !== "virtual-kubelet" && !pinnedEcs)))
		throw new Error("TEMPLATE_PLACEMENT_INVALID");
	if (usesExecutor(value) && !inherited) {
		const placement = value.codexSessionExecutor.placement;
		if (!placement || placement.architecture !== "amd64" || placement.runtimeClassName || nodeSelector.type !== "virtual-kubelet" ||
			Object.keys(nodeSelector).some((key) => key !== "type" && key !== "kubernetes.io/arch") || nodeSelector["kubernetes.io/arch"] !== "amd64")
			throw new Error("EXECUTOR_CAPACITY_PLACEMENT_INVALID");
		assert.deepEqual(value.placement.tolerations, [{ key: "virtual-kubelet.io/provider", operator: "Equal", value: "alibabacloud", effect: "NoSchedule" }]);
	}
	const podReadyTimeoutSeconds = value.podReadyTimeoutSeconds ?? 900;
	if (!Number.isSafeInteger(podReadyTimeoutSeconds) || podReadyTimeoutSeconds < 60 || podReadyTimeoutSeconds > 1800 || value.podReadyTimeoutSeconds === null)
		throw new Error("POD_READY_TIMEOUT_INVALID");
	return { ...value, podReadyTimeoutSeconds };
}

/** An inherited job observes an approved ordinary node without pinning the Pod to it. */
export function assertTemplatePreflightPlacement(job, pod, node) {
	if (!inheritsPlacement(job)) {
		assert(pod.spec.nodeName?.startsWith(job.expectedNodePrefix ?? "virtual-kubelet-"), "EXECUTOR_LAYOUT_NODE_DRIFT");
		return {};
	}
	assert.deepEqual(pod.spec.nodeSelector ?? {}, {}, "EXECUTOR_LAYOUT_DRIFT");
	assert.equal(pod.spec.runtimeClassName, undefined, "EXECUTOR_LAYOUT_DRIFT");
	assert.deepEqual((pod.spec.tolerations ?? []).filter((entry) => !isDefaultNodeToleration(entry)), [], "EXECUTOR_LAYOUT_DRIFT");
	assert.equal(pod.spec.nodeName, job.expectedNodePrefix, "EXECUTOR_LAYOUT_NODE_DRIFT");
	assert.equal(node?.metadata?.name, pod.spec.nodeName, "EXECUTOR_LAYOUT_NODE_DRIFT");
	assert(typeof node?.metadata?.uid === "string" && node.metadata.uid && !node.metadata.deletionTimestamp, "EXECUTOR_LAYOUT_NODE_DRIFT");
	assert(node.metadata.labels?.["kubernetes.io/arch"] === "amd64" && node.metadata.labels?.["kubernetes.io/os"] === "linux" && node.metadata.labels?.type !== "virtual-kubelet", "EXECUTOR_LAYOUT_NODE_DRIFT");
	return { nodeUidSha256: createHash("sha256").update(node.metadata.uid).digest("hex"), nodeArchitecture: "amd64" };
}

/** Preserve the actual preflight target; adoption cannot attach a new target to old evidence. */
export function assertTemplatePreflightTarget(job, clusterNamespace, namespace) {
	const target = templateValidationContextV1Schema.parse(job.validationContext);
	assert.equal(target.sourceCommit, job.sourceCommit, "PREFLIGHT_TARGET_INVALID");
	assert.equal(target.namespace, job.namespace, "PREFLIGHT_TARGET_INVALID");
	assert.equal(clusterNamespace?.metadata?.uid, target.clusterUid, "PREFLIGHT_TARGET_INVALID");
	assert(!clusterNamespace.metadata.deletionTimestamp, "PREFLIGHT_TARGET_INVALID");
	assert.equal(namespace?.metadata?.name, target.namespace, "PREFLIGHT_TARGET_INVALID");
	assert.equal(namespace?.metadata?.uid, target.namespaceUid, "PREFLIGHT_TARGET_INVALID");
	assert.equal(namespace?.metadata?.labels?.["agent-infra.agora.io/bootstrap-id"], target.installationId, "PREFLIGHT_TARGET_INVALID");
	assert(!namespace.metadata.deletionTimestamp, "PREFLIGHT_TARGET_INVALID");
	return target;
}

/** Bounded subset of the reviewed Worker model/DNS destinations; no CIDR or resolver fallback. */
export function preflightNetworkEgress(job) {
	const relay = new URL(job.approvedRelayOrigin);
	const relayPort = Number(relay.port || 443);
	if (!Array.isArray(job.modelEgress) || !job.modelEgress.length || job.modelEgress.length > 16 || !Array.isArray(job.dnsEgress) || !job.dnsEgress.length || job.dnsEgress.length > 8) throw new Error("PREFLIGHT_EGRESS_INVALID");
	const ipPeer = (value) => {
		if (!value || Object.keys(value).join(",") !== "ip" || typeof value.ip !== "string" || !isIP(value.ip)) throw new Error("PREFLIGHT_EGRESS_INVALID");
		return { ipBlock: { cidr: `${value.ip}/${isIP(value.ip) === 4 ? 32 : 128}` } };
	};
	const dnsPeer = (value) => {
		if (value && Object.hasOwn(value, "ip")) return ipPeer(value);
		if (!value || Object.keys(value).sort().join(",") !== "namespace,podLabels" || !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(value.namespace) || !value.podLabels || Array.isArray(value.podLabels) || !Object.keys(value.podLabels).length || Object.keys(value.podLabels).length > 16) throw new Error("PREFLIGHT_EGRESS_INVALID");
		for (const [key, label] of Object.entries(value.podLabels)) {
			const parts = key.split("/"), name = parts.at(-1);
			if (parts.length > 2 || !/^[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/.test(name) || (parts.length === 2 && (parts[0].length > 253 || !parts[0].split(".").every((part) => /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(part)))) || typeof label !== "string" || (label !== "" && !/^[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/.test(label))) throw new Error("PREFLIGHT_EGRESS_INVALID");
		}
		return { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": value.namespace } }, podSelector: { matchLabels: value.podLabels } };
	};
	return [...job.modelEgress.map((entry) => {
		if (!entry || Object.keys(entry).sort().join(",") !== "destination,port" || entry.port !== relayPort) throw new Error("PREFLIGHT_EGRESS_INVALID");
		return { to: [ipPeer(entry.destination)], ports: [{ protocol: "TCP", port: relayPort }] };
	}), ...job.dnsEgress.map((destination) => ({ to: [dnsPeer(destination)], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] }))];
}

async function waitForPort(port, process) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (process.exitCode !== null) throw new Error("PORT_FORWARD_FAILED");
		try {
			const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_000) });
			if (response.status === 200) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error("PORT_FORWARD_TIMEOUT");
}


/** The independent capacity probe shares the production binding and fixed image entrypoint. */
export function renderTemplatePreflightPod({ job: input, owner, publicKey, modelConfig, serviceToken }) {
	const job = validateTemplatePreflightJob(input);
	if (!/^[a-z0-9-]{1,64}$/.test(owner)) throw new Error("PREFLIGHT_OWNER_INVALID");
	const name = usesExecutor(job) ? `sandbox-preflight-${owner}` : `ack-preflight-${job.templateId}-${owner.slice(0, 8)}`;
	const secretName = name;
	const pod = {
		apiVersion: "v1",
		kind: "Pod",
		metadata: { name, namespace: job.namespace, labels: {
			"agent-infra.validation-owner": owner,
			"agent-infra.validation-scope": job.scope,
			"agent-infra.validation-source": job.sourceCommit,
		} },
		spec: {
			automountServiceAccountToken: false,
			restartPolicy: "Never",
			imagePullSecrets: job.imagePullSecret ? [{ name: job.imagePullSecret }] : [],
			...(job.placement === undefined ? {} : { nodeSelector: job.placement.nodeSelector, tolerations: job.placement.tolerations ?? [] }),
			securityContext: { fsGroup: 1000, runAsGroup: 1000, runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: "RuntimeDefault" } },
			containers: [{
				name: "runtime",
				image: job.imageReference,
				ports: [{ containerPort: 3003, protocol: "TCP" }],
				resources: structuredClone(controlResources(job)),
				securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] }, readOnlyRootFilesystem: true },
				readinessProbe: { httpGet: { path: "/healthz", port: 3003 }, initialDelaySeconds: 2, periodSeconds: 3 },
				env: [
					{ name: "PORT", value: "3003" },
					{ name: "AGENT_INFRA_RUNTIME_DATA_DIR", value: "/var/lib/agent-runtime" },
					{ name: "AGENT_INFRA_RUNTIME_DRIVER", value: job.driver },
					{ name: "AGENT_INFRA_RUNTIME_AGENT_ID", value: `template-validation-agent-${job.templateId}-${owner.slice(0, 8)}` },
					{ name: "AGENT_INFRA_RUNTIME_WORKER_ID", value: "ack-template-validator" },
					{ name: "AGENT_INFRA_RUNTIME_GRANT_ISSUER", value: "ack-template-validation" },
					{ name: "AGENT_INFRA_RUNTIME_GRANT_KEY_ID", value: "ack-validation-v1" },
					{ name: "AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY", value: publicKey },
					{ name: "AGENT_INFRA_RUNTIME_MODEL_CONFIG", value: modelConfig },
					{ name: "AGENT_INFRA_RUNTIME_ISOLATION_MODE", value: "container-boundary" },
					{ name: "AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_ENABLED", value: "worker-v1" },
					{ name: "AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_SCOPE", value: name },
					{ name: "AGENT_INFRA_RUNTIME_SERVICE_TOKEN", valueFrom: { secretKeyRef: { name: secretName, key: "service-token" } } },
					{ name: "AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_ATTESTATION", valueFrom: { secretKeyRef: { name: secretName, key: "attestation" } } },
				],
				volumeMounts: [{ name: "data", mountPath: "/var/lib/agent-runtime" }, { name: "tmp", mountPath: "/tmp" }],
			}],
			volumes: [{ name: "data", emptyDir: {} }, { name: "tmp", emptyDir: {} }],
		},
	};

	let binding;
	let pvc;
	let serviceAccount;
	let networkPolicy;
	if (job.resourceProfileRef !== undefined) {
		pod.spec.enableServiceLinks = false;
		pod.spec.serviceAccountName = name;
		serviceAccount = { apiVersion: "v1", kind: "ServiceAccount", metadata: structuredClone(pod.metadata), automountServiceAccountToken: false };
		networkPolicy = { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: structuredClone(pod.metadata), spec: {
			podSelector: { matchLabels: structuredClone(pod.metadata.labels) }, policyTypes: ["Ingress", "Egress"], ingress: [], egress: preflightNetworkEgress(job),
		} };
		pod.spec.shareProcessNamespace = false;
		pod.spec.hostPID = false;
		pod.spec.hostIPC = false;
		pod.spec.hostNetwork = false;
		pod.spec.securityContext.fsGroupChangePolicy = "OnRootMismatch";
		Object.assign(pod.spec.containers[0].securityContext, { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: "RuntimeDefault" }, procMount: "Default" });
	}
	if (usesExecutor(job)) {
		binding = createCodexSessionExecutorBindingV1({ namespace: job.namespace, podName: name,
			agentId: `template-validation-agent-codex-${owner.slice(0, 8)}`, conversationId: `validation-conversation-${owner}`,
			sessionGeneration: 1, sandboxId: `preflight-${owner}`, resourceFence: 1, imageDigest: job.imageReference });
		const control = pod.spec.containers[0];
		control.env = control.env.filter((entry) => !entry.name.startsWith("AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_") && entry.name !== "AGENT_INFRA_RUNTIME_ISOLATION_MODE" && entry.name !== "AGENT_INFRA_RUNTIME_DATA_DIR");
		control.env.push({ name: "AGENT_INFRA_RUNTIME_DATA_DIR", value: "/workspace/runtime" },
			{ name: "AGENT_INFRA_RUNTIME_ISOLATION_MODE", value: "session-executor" },
			{ name: CODEX_SESSION_EXECUTOR_BINDING_ENV, value: JSON.stringify(binding) },
			{ name: CODEX_SESSION_EXECUTOR_ATTESTATION_ENV, valueFrom: { secretKeyRef: { name: secretName, key: "attestation" } } },
			...[["AGENT_INFRA_RUNTIME_POD_UID", "metadata.uid"], ["AGENT_INFRA_RUNTIME_POD_NAME", "metadata.name"], ["AGENT_INFRA_RUNTIME_NAMESPACE", "metadata.namespace"]].map(([name, fieldPath]) => ({ name, valueFrom: { fieldRef: { apiVersion: "v1", fieldPath } } })));
		control.volumeMounts = [{ name: "workspace", mountPath: "/workspace" }, { name: "tmp", mountPath: "/tmp" }];
		const base = { image: job.imageReference, imagePullPolicy: "IfNotPresent", resources: structuredClone(job.codexSessionExecutor.resources), securityContext: structuredClone(control.securityContext), command: ["/bin/sh", "/app/start-runtime-host.sh"] };
		pod.spec.shareProcessNamespace = false;
		pod.spec.initContainers = [{ ...base, name: "codex-session-workspace-init", args: ["--session-executor", "init"], env: [{ name: CODEX_SESSION_EXECUTOR_BINDING_ENV, value: JSON.stringify(binding) }], volumeMounts: [{ name: "workspace", mountPath: "/workspace" }] }];
		pod.spec.containers.push({ ...structuredClone(base), name: "codex-session-executor", args: ["--session-executor", "run"], env: [
			{ name: CODEX_SESSION_EXECUTOR_BINDING_ENV, value: JSON.stringify(binding) },
			{ name: "AGENT_INFRA_RUNTIME_POD_UID", valueFrom: { fieldRef: { apiVersion: "v1", fieldPath: "metadata.uid" } } }],
			volumeMounts: [{ name: "workspace", mountPath: binding.workspaceRoot, subPath: binding.workspaceSubPath }, { name: "executor-tmp", mountPath: "/tmp" }] });
		pod.spec.volumes = [{ name: "workspace", persistentVolumeClaim: { claimName: name } },
			{ name: "tmp", emptyDir: { medium: "Memory", sizeLimit: "128Mi" } },
			{ name: "executor-tmp", emptyDir: { medium: "Memory", sizeLimit: job.codexSessionExecutor.tmpSizeLimit ?? "128Mi" } }];
		pvc = { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: structuredClone(pod.metadata),
			spec: { accessModes: ["ReadWriteOnce"], storageClassName: job.storageClassName, resources: { requests: { storage: job.storageSize } } } };
		codexSessionExecutorAttestationV1(binding, serviceToken);
	}
	if (!pvc && job.resourceProfileRef !== undefined) {
		pod.spec.volumes[0] = { name: "data", persistentVolumeClaim: { claimName: name } };
		pvc = { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: structuredClone(pod.metadata),
			spec: { accessModes: ["ReadWriteOnce"], storageClassName: job.storageClassName, resources: { requests: { storage: job.storageSize } } } };
	}
	return { pod, binding, pvc, serviceAccount, networkPolicy };
}

function assertProjection(actual, expected) {
	for (const [key, value] of Object.entries(expected)) {
		if (Array.isArray(value)) {
			assert(Array.isArray(actual?.[key]) && actual[key].length === value.length, "EXECUTOR_LAYOUT_DRIFT");
			for (let index = 0; index < value.length; index++) {
				if (value[index] && typeof value[index] === "object") assertProjection(actual[key][index], value[index]);
				else assert.deepEqual(actual[key][index], value[index], "EXECUTOR_LAYOUT_DRIFT");
			}
		} else if (value && typeof value === "object") assertProjection(actual?.[key], value);
		else assert.deepEqual(actual?.[key], value, "EXECUTOR_LAYOUT_DRIFT");
	}
}

/** Only live readback of the declared executor layout can produce new-mode capacity evidence. */
export function observeTemplatePreflightLayout(job, expected, observed, pvc, serviceAccount, networkPolicy, node) {
	if (job.resourceProfileRef === undefined) return {};
	assert.equal(observed.metadata?.name, expected.pod.metadata.name, "EXECUTOR_LAYOUT_DRIFT");
	assert.equal(observed.metadata?.namespace, job.namespace, "EXECUTOR_LAYOUT_DRIFT");
	assert(!observed.metadata?.deletionTimestamp, "EXECUTOR_LAYOUT_DRIFT");
	assertProjection(observed.metadata?.labels, expected.pod.metadata.labels);
	for (const [key, value] of Object.entries(observed.metadata.labels)) {
		if (Object.hasOwn(expected.pod.metadata.labels, key)) continue;
		assert(job.allowedPodTopologyLabelValues?.[key]?.includes(value), "PREFLIGHT_TOPOLOGY_DRIFT");
	}
	if (expected.pod.metadata.uid) assert.equal(observed.metadata?.uid, expected.pod.metadata.uid, "EXECUTOR_LAYOUT_DRIFT");
	const comparison = structuredClone(observed.spec);
	// Only proven numeric aliases are normalized for comparison; receipts retain the raw readback.
	for (const key of ["containers", "initContainers"]) {
		const wanted = expected.pod.spec[key];
		if (wanted === undefined) continue;
		assert(Array.isArray(comparison[key]) && comparison[key].length === wanted.length, "EXECUTOR_LAYOUT_DRIFT");
		for (const [index, container] of comparison[key].entries()) {
			assert((container.name === "runtime" ? workloadControlResourcesEqualV1 : workloadResourcesEqualV1)(container.resources, wanted[index].resources), "EXECUTOR_LAYOUT_DRIFT");
			container.resources = structuredClone(wanted[index].resources);
		}
	}
	assert(Array.isArray(comparison.volumes) && comparison.volumes.length === expected.pod.spec.volumes.length, "EXECUTOR_LAYOUT_DRIFT");
	for (const [index, volume] of comparison.volumes.entries()) {
		const size = expected.pod.spec.volumes[index].emptyDir?.sizeLimit;
		if (size === undefined) continue;
		assert(resourceQuantityEqualsV1(volume.emptyDir?.sizeLimit, size), "EXECUTOR_LAYOUT_DRIFT");
		volume.emptyDir.sizeLimit = size;
	}
	comparison.tolerations = (comparison.tolerations ?? []).filter((entry) => !isDefaultNodeToleration(entry));
	for (const key of ["hostPID", "hostIPC", "hostNetwork", "shareProcessNamespace"]) comparison[key] ??= false;
	assertProjection(comparison, expected.pod.spec);
	const placement = assertTemplatePreflightPlacement(job, observed, node);
	assert(!observed.spec.hostPID && !observed.spec.hostIPC && !observed.spec.hostNetwork && !observed.spec.ephemeralContainers?.length && observed.spec.runtimeClassName === undefined, "EXECUTOR_LAYOUT_DRIFT");
	assert.deepEqual(observed.spec.securityContext, expected.pod.spec.securityContext, "EXECUTOR_LAYOUT_DRIFT");
	const expectedSpec = expected.pod.spec;
	for (const [index, container] of [...observed.spec.containers, ...(observed.spec.initContainers ?? [])].entries()) {
		const wanted = [...expectedSpec.containers, ...(expectedSpec.initContainers ?? [])][index];
		for (const [key, value] of Object.entries(container)) {
			if (key in wanted) continue;
			const defaults = { terminationMessagePath: "/dev/termination-log", terminationMessagePolicy: "File", imagePullPolicy: "IfNotPresent", stdin: false, stdinOnce: false, tty: false };
			assert(Object.hasOwn(defaults, key), "EXECUTOR_LAYOUT_DRIFT");
			assert.deepEqual(value, defaults[key], "EXECUTOR_LAYOUT_DRIFT");
		}
		for (const key of ["command", "args", "env", "volumeMounts", "ports", "lifecycle", "envFrom"]) {
			if (wanted[key] === undefined) assert.equal(container[key], undefined, "EXECUTOR_LAYOUT_DRIFT");
			else assert.deepEqual(container[key], wanted[key], "EXECUTOR_LAYOUT_DRIFT");
		}
		assert.equal(container.securityContext.privileged ?? false, false, "EXECUTOR_LAYOUT_DRIFT");
		assert.equal(container.securityContext.procMount ?? "Default", "Default", "EXECUTOR_LAYOUT_DRIFT");
		assert((container.name === "runtime" ? workloadControlResourcesEqualV1 : workloadResourcesEqualV1)(container.resources, wanted.resources), "EXECUTOR_LAYOUT_DRIFT");
		assert.equal(container.securityContext.capabilities.add?.length ?? 0, 0, "EXECUTOR_LAYOUT_DRIFT");
		for (const [key, value] of Object.entries(container.securityContext)) {
			if (key in wanted.securityContext) continue;
			const defaults = { privileged: false, procMount: "Default", runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } };
			assert(Object.hasOwn(defaults, key), "EXECUTOR_LAYOUT_DRIFT");
			assert.deepEqual(value, defaults[key], "EXECUTOR_LAYOUT_DRIFT");
		}
	}
	for (const [index, volume] of observed.spec.volumes.entries()) {
		const wanted = expectedSpec.volumes[index];
		assert.deepEqual(Object.keys(volume).sort(), Object.keys(wanted).sort(), "EXECUTOR_LAYOUT_DRIFT");
		if (volume.persistentVolumeClaim) assert.equal(volume.persistentVolumeClaim.readOnly ?? false, false, "EXECUTOR_LAYOUT_DRIFT");
	}
	for (const [actual, wanted] of [[serviceAccount, expected.serviceAccount], [networkPolicy, expected.networkPolicy]]) {
		assert.equal(actual?.kind, wanted.kind, "PREFLIGHT_NETWORK_DRIFT");
		assert.equal(actual?.metadata?.name, wanted.metadata.name, "PREFLIGHT_NETWORK_DRIFT");
		assert.equal(actual?.metadata?.namespace, job.namespace, "PREFLIGHT_NETWORK_DRIFT");
		assert(!actual?.metadata?.deletionTimestamp, "PREFLIGHT_NETWORK_DRIFT");
		assertProjection(actual?.metadata?.labels, wanted.metadata.labels);
		assert(typeof actual?.metadata?.uid === "string" && actual.metadata.uid, "PREFLIGHT_NETWORK_DRIFT");
		if (wanted.metadata.uid) assert.equal(actual.metadata.uid, wanted.metadata.uid, "PREFLIGHT_NETWORK_DRIFT");
	}
	assert.equal(serviceAccount.automountServiceAccountToken, false, "PREFLIGHT_NETWORK_DRIFT");
	assert(!serviceAccount.secrets?.length, "PREFLIGHT_NETWORK_DRIFT");
	const actualNetwork = { ...networkPolicy.spec, ingress: networkPolicy.spec?.ingress ?? [] };
	assert.deepEqual(actualNetwork, expected.networkPolicy.spec, "PREFLIGHT_NETWORK_DRIFT");
	const network = { ...placement, serviceAccountUidSha256: createHash("sha256").update(serviceAccount.metadata.uid).digest("hex"), networkPolicyUidSha256: createHash("sha256").update(networkPolicy.metadata.uid).digest("hex"), networkPolicySpecSha256: createHash("sha256").update(JSON.stringify(actualNetwork)).digest("hex"), networkDataplaneVerified: false };
	assert.equal(pvc?.metadata?.name, expected.pvc.metadata.name, "EXECUTOR_PVC_DRIFT");
	assert.equal(pvc?.metadata?.namespace, job.namespace, "EXECUTOR_PVC_DRIFT");
	assert(!pvc?.metadata?.deletionTimestamp, "EXECUTOR_PVC_DRIFT");
	assert.equal(pvc?.metadata?.labels?.["agent-infra.validation-owner"], expected.pvc.metadata.labels["agent-infra.validation-owner"], "EXECUTOR_PVC_DRIFT");
	assert(typeof pvc?.metadata?.uid === "string" && pvc.metadata.uid && pvc.status?.phase === "Bound", "EXECUTOR_PVC_DRIFT");
	if (expected.pvc.metadata.uid !== undefined) assert.equal(pvc.metadata.uid, expected.pvc.metadata.uid, "EXECUTOR_PVC_DRIFT");
	assert.deepEqual(pvc.spec.accessModes, expected.pvc.spec.accessModes, "EXECUTOR_PVC_DRIFT");
	assert.equal(pvc.spec.storageClassName, job.storageClassName, "EXECUTOR_PVC_DRIFT");
	assert(resourceQuantityEqualsV1(pvc.spec.resources.requests.storage, job.storageSize), "EXECUTOR_PVC_DRIFT");
	assert(resourceQuantityEqualsV1(pvc.status.capacity?.storage, job.storageSize), "EXECUTOR_PVC_DRIFT");
	assert.equal(observed.status?.phase, "Running", "EXECUTOR_LAYOUT_NOT_READY");
	assert.equal(observed.status.containerStatuses?.length, usesExecutor(job) ? 2 : 1, "EXECUTOR_LAYOUT_NOT_READY");
	for (const status of observed.status.containerStatuses) assert(status.ready === true && status.restartCount === 0 && status.state?.running && typeof status.containerID === "string" && status.containerID && status.imageID?.endsWith(job.imageDigest), "EXECUTOR_LAYOUT_NOT_READY");
	if (!usesExecutor(job)) {
		assert.equal(observed.spec.initContainers, undefined, "EXECUTOR_LAYOUT_DRIFT");
		return { ...network, storageClassName: pvc.spec.storageClassName, pvcUidSha256: createHash("sha256").update(pvc.metadata.uid).digest("hex") };
	}
	const initStatus = observed.status.initContainerStatuses;
	assert(initStatus?.length === 1 && initStatus[0].restartCount === 0 && initStatus[0].state?.terminated?.exitCode === 0 && initStatus[0].imageID?.endsWith(job.imageDigest), "EXECUTOR_LAYOUT_NOT_READY");
	return { ...network, observedExecutorResources: structuredClone(observed.spec.containers[1].resources), observedInitResources: structuredClone(observed.spec.initContainers[0].resources), storageClassName: pvc.spec.storageClassName, pvcUidSha256: createHash("sha256").update(pvc.metadata.uid).digest("hex") };
}

async function main(inputPath) {
	const job = validateTemplatePreflightJob(JSON.parse(await privateFile(inputPath, "JOB")));
	await mkdir(job.outputDirectory, { recursive: true, mode: 0o700 });
	const outputInfo = await lstat(job.outputDirectory);
	if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink() || outputInfo.uid !== process.getuid?.() || (outputInfo.mode & 0o077) !== 0) throw new Error("PREFLIGHT_OUTPUT_NOT_PRIVATE");
	const owner = randomUUID();
	const name = usesExecutor(job) ? `sandbox-preflight-${owner}` : `ack-preflight-${job.templateId}-${owner.slice(0, 8)}`;
	if (!namePattern.test(name)) throw new Error("POD_NAME_INVALID");
	const secretName = name;
	const owned = new Map();
	const identities = new Map();
	const kubeArgs = ["--kubeconfig", job.kubeconfig, "-n", job.namespace];
	const readValidationTarget = () => job.validationContext === undefined ? undefined : assertTemplatePreflightTarget(job,
		JSON.parse(run([...kubeArgs, "get", "namespace", "kube-system", "-o", "json"])),
		JSON.parse(run([...kubeArgs, "get", "namespace", job.namespace, "-o", "json"])));
	const validationTarget = readValidationTarget();
	const privateKey = createPrivateKey(await privateFile(job.grantPrivateKeyFile, "GRANT_KEY"));
	const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
	const serviceToken = (await privateFile(job.runtimeServiceTokenFile, "SERVICE_TOKEN")).toString().trim();
	if (!/^[\x21-\x7e]{1,8192}$/u.test(serviceToken) || (usesExecutor(job) && serviceToken.length < 16)) throw new Error("SERVICE_TOKEN_INVALID");
	const modelCredential = (await privateFile(job.relayKeyFile, "MODEL_CREDENTIAL")).toString().trim();
	if (!/^[\x21-\x7e]{32,4096}$/u.test(modelCredential)) throw new Error("MODEL_CREDENTIAL_INVALID");
	const attestation = createHmac("sha256", serviceToken)
		.update(`agent-infra-container-boundary-v1\0${name}`)
		.digest("base64url");
	const attestationFile = join(job.outputDirectory, `.attestation-${owner}`);
	const modelCredentialFile = join(job.outputDirectory, `.model-credential-${owner}`);
	const relayOrigin = new URL(job.approvedRelayOrigin).origin;
	const modelEndpoint = job.protocol === "openai-responses-v1" ? `${relayOrigin}/v1` : relayOrigin;
	const modelConfig = JSON.stringify({
		schemaVersion: 4,
		configVersion: job.runtimeConfigVersion,
		defaultModelOptionId: job.modelOptionId,
		defaultReasoningLevel: job.reasoningLevel,
		modelOptions: [{
			modelOptionId: job.modelOptionId,
			protocol: job.protocol,
			authentication: job.protocol === "openai-responses-v1" ? "bearer" : "api-key",
			endpoint: modelEndpoint,
			model: job.modelId,
			reasoningLevels: [job.reasoningLevel, "high"].filter((value, index, values) => values.indexOf(value) === index),
		}],
	});
	const rendered = renderTemplatePreflightPod({ job, owner, publicKey, modelConfig, serviceToken });
	const { pod, binding, pvc, serviceAccount, networkPolicy } = rendered;
	let portForward;
	const generatedJob = join(job.outputDirectory, `.runner-job-${owner}.json`);
	const identityFile = join(job.outputDirectory, "owned-resource-identities.json");
	const persistIdentities = async () => {
		const pending = `${identityFile}.${owner}.pending`;
		await writeFile(pending, JSON.stringify({ schemaVersion: 1, kind: "ack-template-owned-resources", sourceCommit: job.sourceCommit, imageDigest: job.imageDigest, namespace: job.namespace, owner, resources: [...identities.values()] }) + "\n", { mode: 0o600, flag: "wx" });
		await rename(pending, identityFile);
	};
	if (pvc) await writeFile(identityFile, "{}\n", { mode: 0o600, flag: "wx" });
	try {
		await writeFile(attestationFile, binding ? codexSessionExecutorAttestationV1(binding, serviceToken) : attestation, { mode: 0o600, flag: "wx" });
		await writeFile(modelCredentialFile, modelCredential, { mode: 0o600, flag: "wx" });
		const secret = run([...kubeArgs, "create", "secret", "generic", secretName, `--from-file=service-token=${job.runtimeServiceTokenFile}`, `--from-file=attestation=${attestationFile}`, `--from-file=model-credential=${modelCredentialFile}`, "--dry-run=client", "-o", "json"]);
		if (pvc) {
			const createOwned = async (object) => {
				identities.set(object.kind, { kind: object.kind, name, uid: null, state: "create-attempted" });
				await persistIdentities();
				const created = JSON.parse(run([...kubeArgs, "create", "-f", "-", "-o", "json"], JSON.stringify(object)));
				assert(created.metadata?.uid && created.metadata.name === name && created.metadata.labels?.["agent-infra.validation-owner"] === owner, "PREFLIGHT_RESOURCE_CREATE_INVALID");
				owned.set(object.kind, created.metadata.uid);
				identities.set(object.kind, { kind: object.kind, name, uid: created.metadata.uid, state: "created" });
				await persistIdentities();
				return created;
			};
			const secretObject = JSON.parse(secret);
			secretObject.metadata = { ...pod.metadata };
			await createOwned(secretObject);
			const createdAccount = await createOwned(serviceAccount);
			serviceAccount.metadata.uid = createdAccount.metadata.uid;
			const createdPolicy = await createOwned(networkPolicy);
			networkPolicy.metadata.uid = createdPolicy.metadata.uid;
			const createdPvc = await createOwned(pvc);
			pvc.metadata.uid = createdPvc.metadata.uid;
			const createdPod = await createOwned(pod);
			pod.metadata.uid = createdPod.metadata.uid;
		} else {
			run([...kubeArgs, "apply", "-f", "-"], secret);
			run([...kubeArgs, "create", "-f", "-"], JSON.stringify(pod));
		}
		try {
			run([...kubeArgs, "wait", "--for=condition=Ready", `pod/${name}`, `--timeout=${job.podReadyTimeoutSeconds}s`]);
		} catch {
			const phases = new Set(["Pending", "Running", "Succeeded", "Failed", "Unknown"]);
			const reasons = new Set(["ContainerCreating", "PodInitializing", "ErrImagePull", "ImagePullBackOff", "CrashLoopBackOff", "CreateContainerConfigError", "CreateContainerError", "RunContainerError", "InvalidImageName"]);
			let observation = { readback: "unavailable", phase: null, waitingReasons: [] };
			try {
				const current = JSON.parse(run([...kubeArgs, "get", "pod", name, "-o", "json"]));
				if (current.metadata?.name === name && current.metadata.labels?.["agent-infra.validation-owner"] === owner &&
					current.spec?.containers?.length === (usesExecutor(job) ? 2 : 1) && current.spec.containers[0].image === job.imageReference) {
					observation = { readback: "matched", phase: phases.has(current.status?.phase) ? current.status.phase : "Unknown",
						waitingReasons: [...new Set((current.status?.containerStatuses ?? []).slice(0, 4).flatMap((container) =>
							container.state?.waiting ? [reasons.has(container.state.waiting.reason) ? container.state.waiting.reason : "Unknown"] : []))] };
				} else observation.readback = "identity-mismatch";
			} catch {}
			await writeFile(join(job.outputDirectory, "pod-readiness-failure.json"), JSON.stringify({
				schemaVersion: 1, kind: "ack-template-preflight-failure", stage: "pod-ready", templateId: job.templateId,
				sourceSha: job.sourceCommit, imageDigest: job.imageDigest, podReadyTimeoutSeconds: job.podReadyTimeoutSeconds,
				...observation, modelCallAttempted: false,
			}) + "\n", { mode: 0o600, flag: "wx" });
			throw new Error("TEMPLATE_POD_READINESS_FAILED");
		}
		const measurementPod = JSON.parse(run([...kubeArgs, "get", "pod", name, "-o", "json"]));
		readValidationTarget();
		const readNode = (pod) => inheritsPlacement(job) ? JSON.parse(run([...kubeArgs, "get", "node", pod.spec.nodeName, "-o", "json"])) : undefined;
		const measurementNode = readNode(measurementPod);
		await writePodStartupReceipt(job, { name, owner }, measurementPod);
		if (pvc) {
			assert.equal(measurementPod.metadata.uid, owned.get("Pod"), "EXECUTOR_LAYOUT_DRIFT");
			observeTemplatePreflightLayout(job, rendered, measurementPod, JSON.parse(run([...kubeArgs, "get", "pvc", name, "-o", "json"])), JSON.parse(run([...kubeArgs, "get", "serviceaccount", name, "-o", "json"])), JSON.parse(run([...kubeArgs, "get", "networkpolicy", name, "-o", "json"])), measurementNode);
		}
		const port = 35000 + Math.floor(Math.random() * 1000);
		portForward = spawn("kubectl", [...kubeArgs, "port-forward", `pod/${name}`, `${port}:3003`], { stdio: ["ignore", "pipe", "pipe"] });
		await waitForPort(port, portForward);
		const actualModuleHash = run([...kubeArgs, "exec", name, "-c", "runtime", "--", "node", "-e", "console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('/app/node_modules/@agent-infra/agent-runtime/dist/index.mjs')).digest('hex'))"]).trim();
		const runnerJob = {
			schemaVersion: 1, scope: job.scope, kubeconfig: job.kubeconfig, namespace: job.namespace,
			templateId: job.templateId, driver: job.driver, protocol: job.protocol,
			operatorApprovalRef: job.operatorApprovalRef, worktree: job.worktree, sourceCommit: job.sourceCommit,
			containerName: name, imageReference: job.imageReference, imageDigest: job.imageDigest,
			runtimeBaseUrl: `http://127.0.0.1:${port}/`, agentId: `template-validation-agent-${job.templateId}-${owner.slice(0, 8)}`,
			approvedRelayOrigin: job.approvedRelayOrigin, modelId: job.modelId, modelOptionId: job.modelOptionId,
			reasoningLevel: job.reasoningLevel, runtimeConfigVersion: job.runtimeConfigVersion,
			configurationRevision: job.configurationRevision, grantIssuer: "ack-template-validation",
			workerId: "ack-template-validator", grantKeyId: "ack-validation-v1",
			grantPrivateKeyFile: job.grantPrivateKeyFile, runtimeServiceTokenFile: job.runtimeServiceTokenFile,
			relayKeyFile: job.relayKeyFile, outputDirectory: job.outputDirectory,
			expectedResourceLimits: job.expectedResourceLimits, expectedNodePrefix: job.expectedNodePrefix ?? "virtual-kubelet-",
			placement: job.placement, codexSessionExecutor: job.codexSessionExecutor,
			...(job.resourceProfileRef === undefined ? {} : { resources: controlResources(job) }),
			expectedReply: job.expectedReply ?? "READY", runtimeModuleSha256: actualModuleHash,
			...(binding ? { sessionExecutorBinding: binding, runtimeDataDirectory: "/workspace/runtime" } : {}),
		};
		await writeFile(generatedJob, JSON.stringify(runnerJob, null, 2), { mode: 0o600 });
		const child = spawn(process.execPath, ["--experimental-strip-types", runner, generatedJob], { stdio: "inherit" });
		const code = await new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (value) => resolve(value ?? 1));
		});
		if (code !== 0) throw new Error("TEMPLATE_PREFLIGHT_FAILED");
		const measured = JSON.parse(await privateFile(join(job.outputDirectory, "template-model-preflight.receipt.json"), "MEASUREMENT"));
		const observed = JSON.parse(run([...kubeArgs, "get", "pod", name, "-o", "json"]));
		readValidationTarget();
		if (observed.metadata.uid !== measurementPod.metadata.uid ||
			observed.metadata.labels["agent-infra.validation-owner"] !== owner ||
			observed.spec.containers[0].image !== job.imageReference ||
			observed.status.containerStatuses[0].restartCount !== 0 ||
			measured.imageDigest !== job.imageDigest || measured.sourceCommit !== job.sourceCommit ||
			measured.terminalStatus !== "completed" || measured.replyMatched !== true ||
			!Number.isSafeInteger(measured.submittedAt) || !Number.isSafeInteger(measured.validatedAt) ||
			measured.validatedAt < measured.submittedAt ||
			!Number.isSafeInteger(measured.modelOperationCount) || measured.modelOperationCount < 1)
			throw new Error("CAPACITY_MEASUREMENT_INVALID");
		await writeFile(join(job.outputDirectory, "template-model-validation.receipt.json"),
			JSON.stringify(templatePreflightValidationReceipt({ ...measured, ...(validationTarget ? { validationTarget } : {}) })) + "\n",
			{ mode: 0o600, flag: "wx" });
		if (pvc) {
			const instances = (value) => value.status.containerStatuses.map((item) => [item.name, item.containerID]).sort();
			assert.deepEqual(instances(observed), instances(measurementPod), "EXECUTOR_INSTANCE_DRIFT");
		}
		const observedNode = readNode(observed);
		if (measurementNode) assert.equal(observedNode?.metadata.uid, measurementNode.metadata.uid, "EXECUTOR_LAYOUT_NODE_DRIFT");
		const layout = pvc ? observeTemplatePreflightLayout(job, rendered, observed, JSON.parse(run([...kubeArgs, "get", "pvc", name, "-o", "json"])), JSON.parse(run([...kubeArgs, "get", "serviceaccount", name, "-o", "json"])), JSON.parse(run([...kubeArgs, "get", "networkpolicy", name, "-o", "json"])), observedNode) : {};
		await writeFile(join(job.outputDirectory, "runtime-capacity.receipt.json"), JSON.stringify({
			schemaVersion: 1, scope: "ack-runtime-capacity", sourceCommit: job.sourceCommit,
			imageDigest: job.imageDigest, observedResources: observed.spec.containers[0].resources,
			...(job.resourceProfileRef === undefined ? {} : {
				resourceConfigurationHash: workloadResourceConfigurationHashV1({ ...job, resources: controlResources(job) }),
				...(job.codexSessionExecutor === undefined ? {} : { codexSessionExecutor: job.codexSessionExecutor }),
				storageSize: job.storageSize,
				resourceCosts: sessionSandboxResourceCostsV1({ resources: observed.spec.containers[0].resources, storageSize: job.storageSize, ...(binding ? { codexSessionExecutor: { ...job.codexSessionExecutor, resources: layout.observedExecutorResources } } : {}) }),
				...layout,
			}),
			maximumConcurrentExecutions: 1, terminalStatus: "completed", replyMatched: true,
			modelOperationCount: measured.modelOperationCount,
			submittedAt: measured.submittedAt, completedAt: measured.validatedAt,
		}) + "\n", { mode: 0o600, flag: "wx" });
		process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: "ack-template-preflight", templateId: job.templateId, status: "passed" }) + "\n");
	} finally {
		portForward?.kill("SIGTERM");
		await unlink(generatedJob).catch(() => {});
		await unlink(attestationFile).catch(() => {});
		await unlink(modelCredentialFile).catch(() => {});
		if (pvc) {
			let cleanupFailed = [...identities.values()].some((entry) => entry.uid === null);
			// An unknown create response cannot justify removing the network boundary around a possibly running Pod.
			const uncertainPod = identities.has("Pod") && !owned.has("Pod");
			for (const [kind, plural] of [["Pod", "pods"], ["Secret", "secrets"], ["PersistentVolumeClaim", "persistentvolumeclaims"], ["NetworkPolicy", "networkpolicies"], ["ServiceAccount", "serviceaccounts"]]) {
				if (uncertainPod) break;
				if (!owned.has(kind)) continue;
				try {
					const raw = run([...kubeArgs, "get", plural, name, "--ignore-not-found", "-o", "json"]);
					if (!raw.trim()) { identities.get(kind).state = "absent"; await persistIdentities(); continue; }
					const object = JSON.parse(raw);
					assert.equal(object.metadata?.uid, owned.get(kind), "PREFLIGHT_CLEANUP_IDENTITY_DRIFT");
					assert.equal(object.metadata?.labels?.["agent-infra.validation-owner"], owner, "PREFLIGHT_CLEANUP_OWNER_DRIFT");
					run([...kubeArgs, "delete", "--raw", `${kind === "NetworkPolicy" ? "/apis/networking.k8s.io/v1" : "/api/v1"}/namespaces/${job.namespace}/${plural}/${name}`, "-f", "-"], JSON.stringify({ apiVersion: "v1", kind: "DeleteOptions", preconditions: { uid: object.metadata.uid, resourceVersion: object.metadata.resourceVersion } }));
					if (kind !== "Secret") run([...kubeArgs, "wait", "--for=delete", `${plural}/${name}`, "--timeout=60s"], undefined, 65_000);
					identities.get(kind).state = "deleted";
					await persistIdentities();
				} catch {
					cleanupFailed = true;
					identities.get(kind).state = "cleanup-unverified";
					await persistIdentities();
					// Keep network restrictions and all dependencies if the process boundary is not retired.
					if (kind === "Pod") break;
				}
			}
			if (cleanupFailed) throw new Error("PREFLIGHT_CLEANUP_FAILED");
		} else {
			try { run([...kubeArgs, "delete", "pod", name, "--ignore-not-found", "--wait=false"]); } catch {}
			try { run([...kubeArgs, "delete", "secret", secretName, "--ignore-not-found"]); } catch {}
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) try {
	const path = process.argv[2];
	if (!path) throw new Error("JOB_REQUIRED");
	await main(path);
} catch (error) {
	process.stderr.write(`${error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : "ACK_TEMPLATE_PREFLIGHT_FAILED"}\n`);
	process.exitCode = 1;
}
