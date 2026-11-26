import { paseoTemplateBinding, paseoTemplateEvidence } from "./paseo-template.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { privateBytes, privateJson } from "./private-input.ts";
import {
	piContainerResources,
	sessionSandboxResourceCostsV1,
	validateCodexSessionExecutorResourcePolicyV1,
	validateWorkloadControlResourcesV1,
	workloadControlResourcesEqualV1,
	workloadResourceConfigurationHashV1,
	workloadResourcesEqualV1,
 withoutAcsStorageDefaultV1,
} from "../../packages/platform-core/src/workload-resource-configuration.ts";

const digest = /^sha256:[a-f0-9]{64}$/u;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const resources = (value: any) => {
	for (const field of ["requests", "limits"])
		for (const key of ["cpu", "memory"])
			assert(typeof value?.[field]?.[key] === "string" && value[field][key]);
	return {
		requests: { cpu: value.requests.cpu, memory: value.requests.memory },
		limits: { cpu: value.limits.cpu, memory: value.limits.memory },
	};
};

const policyTuple = (value: any) => ({
	resourceProfileRef: value.resourceProfileRef,
	...(value.sessionRuntimePlacement === undefined ? {} : { sessionRuntimePlacement: value.sessionRuntimePlacement }),
	resources: resources(value.resources),
	...(value.codexSessionExecutor === undefined
		? {}
		: { codexSessionExecutor: value.codexSessionExecutor }),
	...(value.workspaceSnapshotEgress === undefined
		? {}
		: { workspaceSnapshotEgress: value.workspaceSnapshotEgress }),
});

const resourceHash = (value: any) =>
	workloadResourceConfigurationHashV1(policyTuple(value));

function expectedCosts(policy: any, templateId: string, transport?: string) {
	return sessionSandboxResourceCostsV1({
		resources: policy.resources,
		storageSize: policy.storageSize,
		...(policy.codexSessionExecutor === undefined || templateId !== "codex" || transport !== undefined
			? {}
			: { codexSessionExecutor: policy.codexSessionExecutor }),
	});
}

/** Only the measured single-execution receipts used by this workflow are supported. */
function verifyMeasurement(
	bytes: Uint8Array,
	imageDigest: string,
	policy: any,
	capacity: number,
	templateId: string,
	transport?: string,
) {
	const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	const value = input.receipt ?? input;
	assert(value?.schemaVersion === 1 &&
		["ack-runtime-capacity", "isolated-custom-runtime-capacity"].includes(value.scope) &&
		value.imageDigest === imageDigest &&
		value.maximumConcurrentExecutions === 1 && capacity === 1 &&
		value.terminalStatus === "completed" && value.replyMatched === true &&
		Number.isSafeInteger(value.submittedAt) && Number.isSafeInteger(value.completedAt) &&
		value.completedAt >= value.submittedAt, "CAPACITY_EVIDENCE_NOT_MEASURED");
	const facts = value.modelFacts;
	assert(value.scope === "ack-runtime-capacity"
		? Number.isSafeInteger(value.modelOperationCount) && value.modelOperationCount >= 1
		: Array.isArray(facts) && facts.some((fact: any) => fact.phase === "completed") &&
			!facts.some((fact: any) => ["failed", "unknown"].includes(fact.phase)),
		"CAPACITY_MODEL_FACT_MISSING");
	assert(workloadControlResourcesEqualV1(policy.sessionRuntimePlacement ? withoutAcsStorageDefaultV1(value.observedResources, policy.resources) : value.observedResources, policy.resources), "CAPACITY_MEASURED_RESOURCES_DRIFT");
if (policy.sessionRuntimePlacement) {
  assert.deepEqual(value.sessionRuntimePlacement, policy.sessionRuntimePlacement, "CAPACITY_COMPUTE_DRIFT");
  assert(/^acs-[a-z0-9]{1,64}$/.test(value.computeInstanceId ?? ""), "CAPACITY_COMPUTE_DRIFT");
 }
	assert.equal(value.transport, transport, "CAPACITY_TRANSPORT_DRIFT");
	if (transport === "paseo-sdk-pod") {
		const binding = paseoTemplateBinding(templateId, transport);
		const rows=value.observedContainerResources;
		assert(Array.isArray(rows) && rows.length===2 &&
			rows[0]?.name==="runtime" && rows[1]?.name===binding.companionName &&
			workloadControlResourcesEqualV1(policy.sessionRuntimePlacement ? withoutAcsStorageDefaultV1(rows[0].resources, piContainerResources(policy.resources,"host")) : rows[0].resources,piContainerResources(policy.resources,"host")) &&
			workloadControlResourcesEqualV1(policy.sessionRuntimePlacement ? withoutAcsStorageDefaultV1(rows[1].resources, piContainerResources(policy.resources,"pi")) : rows[1].resources,piContainerResources(policy.resources,"pi")), "CAPACITY_PI_LAYOUT_DRIFT");
	}
	const executorMode = templateId === "codex" && transport === undefined && policy.codexSessionExecutor !== undefined;
	if (policy.sessionRuntimePlacement !== undefined || value.resourceConfigurationHash !== undefined || policy.codexSessionExecutor !== undefined || policy.workspaceSnapshotEgress !== undefined)
		assert.equal(value.resourceConfigurationHash, resourceHash(policy), "CAPACITY_RESOURCE_HASH_MISMATCH");
	if (policy.codexSessionExecutor !== undefined) {
		validateCodexSessionExecutorResourcePolicyV1(policy.codexSessionExecutor);
		assert.deepEqual(value.codexSessionExecutor, policy.codexSessionExecutor, "CAPACITY_EXECUTOR_POLICY_DRIFT");
		assert.equal(value.storageSize, policy.storageSize, "CAPACITY_STORAGE_SIZE_DRIFT");
		assert.deepEqual(value.resourceCosts, expectedCosts(policy, templateId, transport), "CAPACITY_RESOURCE_COST_DRIFT");
		if (executorMode) {
			assert(typeof policy.storageClassName === "string" && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(policy.storageClassName), "CAPACITY_STORAGE_CLASS_MISSING");
			assert.equal(value.storageClassName, policy.storageClassName, "CAPACITY_STORAGE_CLASS_DRIFT");
			assert(workloadControlResourcesEqualV1(policy.sessionRuntimePlacement ? withoutAcsStorageDefaultV1(value.observedExecutorResources) : value.observedExecutorResources, policy.codexSessionExecutor.resources), "CAPACITY_EXECUTOR_RESOURCES_DRIFT");
			assert(workloadControlResourcesEqualV1(policy.sessionRuntimePlacement ? withoutAcsStorageDefaultV1(value.observedInitResources) : value.observedInitResources, policy.codexSessionExecutor.resources), "CAPACITY_INIT_RESOURCES_DRIFT");
		} else {
			assert(value.observedExecutorResources === undefined && value.observedInitResources === undefined, "CAPACITY_EXECUTOR_LAYOUT_UNEXPECTED");
		}
	}
}

/** Read-only gate: Agent readiness does not prove that a Session can be allocated. */
export function validateCapacityBindings(requests: any[], templates: any[], policy: any, profiles: any[], evidence: Map<string, Uint8Array>) {
	assert(Array.isArray(requests) && requests.length > 0 && requests.length <= 20);
	assert(Array.isArray(templates) && Array.isArray(profiles));
	assert(typeof policy.resourceProfileRef === "string" && policy.resourceProfileRef);
	if (policy.codexSessionExecutor !== undefined) {
		assert(typeof policy.storageSize === "string" && policy.storageSize, "CAPACITY_STORAGE_SIZE_MISSING");
		validateWorkloadControlResourcesV1(policy.resources);
		validateCodexSessionExecutorResourcePolicyV1(policy.codexSessionExecutor);
	}
	const resourcesHash = resourceHash(policy);
	const checked = new Set<string>();
	for (const request of requests) {
		const source = request.source;
		assert(source && ["standard", "custom"].includes(source.kind));
		if (source.kind === "custom" && source.interactionMode === "self-managed") continue;
		const matches = source.kind === "standard" ? templates.filter((entry) => entry.templateId === source.templateId) : [];
		if (source.kind === "standard") assert(matches.length === 1);
		const imageDigest = source.kind === "standard" ? matches[0].imageDigest : source.imageReference?.split("@")[1];
		assert(typeof imageDigest === "string" && digest.test(imageDigest));
		const matchesCapacity = profiles.filter((p) => p.imageDigest === imageDigest && p.resourceProfileRef === policy.resourceProfileRef && p.resourceConfigurationHash === resourcesHash);
		assert(matchesCapacity.length === 1, "CAPACITY_BINDING_MISSING_OR_AMBIGUOUS");
		const profile = matchesCapacity[0];
		// The current preflight contract measures one bounded execution. Do not
		// accept a larger declared limit without a receipt that measured it.
		assert(profile.schemaVersion === 1 && profile.maximumConcurrentExecutions === 1 && /^[a-f0-9]{64}$/u.test(profile.conformanceEvidenceHash) && !/^0+$/u.test(profile.conformanceEvidenceHash), "CAPACITY_PROFILE_UNMEASURED");
		const bytes = evidence.get(imageDigest);
		assert(bytes && hash(bytes) === profile.conformanceEvidenceHash, "CAPACITY_EVIDENCE_MISMATCH");
		verifyMeasurement(bytes, imageDigest, policy, profile.maximumConcurrentExecutions, source.kind === "standard" ? source.templateId : "custom", matches[0]?.transport);
		checked.add(imageDigest);
	}
	return { schemaVersion: 1, kind: "ack-workload-capacity", imageCount: checked.size, resourceConfigurationHash: resourcesHash, businessVerified: false };
}

export type RetainedTemplateMeasurement = { templateId: string; imageDigest: string; measurementDirectory: string; transport?: string };

/**
 * Standard images still bound by existing Agents need their own measured
 * approval under the current policy. Current template images stay on the
 * template validation path; this does not prove which Agents use an image.
 */
export function parseRetainedTemplateMeasurements(value: unknown, templates: any[], codexOnly = false): RetainedTemplateMeasurement[] {
	if (value === undefined) return [];
	assert(Array.isArray(value) && value.length > 0 && value.length <= 16 && Array.isArray(templates), "CAPACITY_RETAINED_TEMPLATE_INVALID");
	const seen = new Set<string>();
	return value.map((entry: any) => {
		assert(entry && typeof entry === "object" && !Array.isArray(entry) &&
			Object.keys(entry).sort().join() === (entry.transport === undefined ? "imageDigest,measurementDirectory,templateId" : "imageDigest,measurementDirectory,templateId,transport") &&
			(entry.transport === undefined || paseoTemplateEvidence(entry.templateId,entry.transport)) &&
			["codex", "claude", "opencode", "pi"].includes(entry.templateId) &&
			(codexOnly && entry.templateId !== "codex" || templates.filter((template) => template.templateId === entry.templateId).length === 1) &&
			typeof entry.imageDigest === "string" && digest.test(entry.imageDigest) && !seen.has(entry.imageDigest) &&
			typeof entry.measurementDirectory === "string" && isAbsolute(entry.measurementDirectory) &&
			!/[\r\n\0]/u.test(entry.measurementDirectory), "CAPACITY_RETAINED_TEMPLATE_INVALID");
		assert(!templates.some((template) => template.imageDigest === entry.imageDigest), "CAPACITY_RETAINED_TEMPLATE_CURRENT");
		seen.add(entry.imageDigest);
		return { templateId: entry.templateId, imageDigest: entry.imageDigest, measurementDirectory: entry.measurementDirectory, ...(entry.transport ? {transport:entry.transport} : {}) };
	}).filter(entry => !codexOnly || entry.templateId === "codex");
}

/** Each retained image needs exactly one full-key profile backed by its measured receipt bytes. */
export function validateRetainedTemplateCapacity(retained: readonly RetainedTemplateMeasurement[], policy: any, profiles: any[], evidence: Map<string, Uint8Array>) {
	for (const { templateId, imageDigest, transport } of retained)
		validateCapacityBindings([{ source: { kind: "standard", templateId } }], [{ templateId, imageDigest, transport }], policy, profiles, evidence);
	return retained.length;
}

type WorkerInput = {
	bytes: Uint8Array;
	resourceProfileRef: string;
	resources: unknown;
	agentRuntimeCompute?: string;
	sessionRuntimePlacement?: unknown;
	profiles: unknown;
	codexSessionExecutor?: unknown;
	workspaceSnapshotEgress?: unknown;
	storageSize?: string;
	storageClassName?: string;
	secretRef: SecretRef;
};
type SecretRef = { name: string; key: string };

export function assertWorkerCapacityPolicy(actual: Omit<WorkerInput, "secretRef" | "bytes" | "profiles">, input: any, expectedHash: string) {
	assert.equal(actual.resourceProfileRef, input.resourceProfileRef, "CAPACITY_WORKER_POLICY_DRIFT");
	assert(workloadControlResourcesEqualV1(actual.resources, input.resources), "CAPACITY_WORKER_POLICY_DRIFT");
	assert.deepEqual(actual.sessionRuntimePlacement, input.sessionRuntimePlacement, "CAPACITY_WORKER_COMPUTE_DRIFT");
	assert.deepEqual(actual.codexSessionExecutor, input.codexSessionExecutor, "CAPACITY_WORKER_EXECUTOR_POLICY_DRIFT");
	assert.deepEqual(actual.workspaceSnapshotEgress, input.workspaceSnapshotEgress, "CAPACITY_WORKER_SNAPSHOT_POLICY_DRIFT");
	if (input.codexSessionExecutor !== undefined || input.storageSize !== undefined)
		assert.equal(actual.storageSize, input.storageSize, "CAPACITY_WORKER_STORAGE_SIZE_DRIFT");
	if (input.codexSessionExecutor !== undefined || input.storageClassName !== undefined)
		assert.equal(actual.storageClassName, input.storageClassName, "CAPACITY_WORKER_STORAGE_CLASS_DRIFT");
	assert.equal(resourceHash(actual), expectedHash, "CAPACITY_WORKER_POLICY_DRIFT");
}

/** An image can retain different measured approvals on ECI and ACS. Select its receipt by the approved hash. */
export async function currentCapacityEvidence(entries: {imageDigest: string; file: string}[], profiles: any[], policy: any) {
	assert(Array.isArray(entries) && entries.length <= 64);
	const selected = new Map<string, Buffer>();
	const currentHash = resourceHash(policy);
	const seen = new Set<string>();
	const indexed = new Set<string>();
	for (const entry of entries) {
		indexed.add(entry.imageDigest);
		assert(digest.test(entry.imageDigest));
		const bytes = await privateBytes(entry.file);
		const evidenceHash = hash(bytes);
		const key = entry.imageDigest + "/" + evidenceHash;
		assert(!seen.has(key), "CAPACITY_EVIDENCE_MISMATCH");
		seen.add(key);
		const approved = profiles.filter(p => p.imageDigest === entry.imageDigest && p.conformanceEvidenceHash === evidenceHash);
		if (approved.length && !approved.some(p => p.resourceProfileRef === policy.resourceProfileRef && p.resourceConfigurationHash === currentHash)) continue;
		assert(!selected.has(entry.imageDigest), "CAPACITY_EVIDENCE_MISMATCH");
		selected.set(entry.imageDigest, bytes);
	}
	for (const profile of profiles) {
		if (indexed.has(profile.imageDigest) && (profile.resourceConfigurationHash !== currentHash || profile.resourceProfileRef !== policy.resourceProfileRef))
			assert(seen.has(profile.imageDigest + "/" + profile.conformanceEvidenceHash), "CAPACITY_EVIDENCE_MISMATCH");
	}
	return selected;
}

export async function checkWorkloadCapacity(configFile: string, requestsFile: string, templatesFile: string, sourceSha: string, readWorker: (ref: SecretRef) => WorkerInput) {
	const input = await privateJson(configFile);
	const requests = await privateJson(requestsFile);
	const templates = await privateJson(templatesFile);
	assert(/^[a-f0-9]{40}$/u.test(sourceSha));
	assert(input.schemaVersion === 1 && input.sourceSha === sourceSha && templates.schemaVersion === 1 && templates.sourceSha === sourceSha && requests.schemaVersion === 1 && Array.isArray(requests.requests) && requests.requests.length > 0 && requests.requests.length <= 20);
	assert(Array.isArray(input.evidence) && input.evidence.length <= 64);
	const bytes = await privateBytes(input.profilesFile);
	const profiles = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	assert(profiles.schemaVersion === 1);
	const evidence = await currentCapacityEvidence(input.evidence, profiles.profiles, input);
	const bodies = await Promise.all(requests.requests.map((request: { bodyFile: string }) => privateJson(request.bodyFile)));
	const receipt = validateCapacityBindings(bodies, templates.templates, input, profiles.profiles, evidence);
	const codexOnly = templates.templates.length === 1 && templates.templates[0].templateId === "codex" && templates.templates[0].transport === "paseo-sdk-pod";
	const hasOtherRetained = Array.isArray(input.retainedTemplateMeasurements) && input.retainedTemplateMeasurements.some((entry: any) => entry?.templateId !== "codex");
	const needsAgentPlacement = codexOnly && hasOtherRetained && !input.sessionRuntimePlacement;
	const retainedImageCount = validateRetainedTemplateCapacity(parseRetainedTemplateMeasurements(input.retainedTemplateMeasurements, templates.templates,
		codexOnly && (input.sessionRuntimePlacement?.compute === "acs" || needsAgentPlacement)), input, profiles.profiles, evidence);
	const ref = input.workerSecretRef;
	assert(ref && /^[a-z0-9][a-z0-9.-]{0,252}$/u.test(ref.name) && /^[A-Za-z0-9._-]{1,253}$/u.test(ref.key));
	const actual = readWorker(ref);
	if (needsAgentPlacement) assert(actual.agentRuntimeCompute === "acs", "CAPACITY_WORKER_COMPUTE_DRIFT");
	assert.deepEqual(actual.secretRef, ref, "CAPACITY_WORKER_SECRET_BINDING_DRIFT");
	assert.deepEqual(Buffer.from(actual.bytes), bytes, "CAPACITY_SECRET_DRIFT");
	assertWorkerCapacityPolicy(actual, input, receipt.resourceConfigurationHash);
	assert.deepEqual(actual.profiles, profiles.profiles, "CAPACITY_WORKER_PROFILES_DRIFT");
	return { ...receipt, retainedImageCount, profilesHash: hash(bytes), mountedInputVerified: true };
}

export function assertWorkerMount(pod: any, secret: any, ref: SecretRef) {
	assert(pod.status?.phase === "Running" && pod.status?.containerStatuses?.length === 1 && pod.status.containerStatuses[0].ready === true);
	const container = pod.spec.containers.find((c: any) => c.name === "platform-worker");
	assert(container);
	const url = container.env?.find((e: any) => e.name === "PLATFORM_WORKER_DEPLOYMENT_MODULE")?.value;
	assert(typeof url === "string" && url.startsWith("file:///"));
	const configPath = fileURLToPath(new URL("./configuration.mjs", url));
	const mount = container.volumeMounts?.find((m: any) => m.mountPath === configPath);
	assert(mount?.readOnly && mount.subPath === "configuration.mjs", "CAPACITY_WORKER_MOUNT_INVALID");
	const volume = pod.spec.volumes?.find((v: any) => v.name === mount.name);
	assert(volume?.secret?.secretName === ref.name, "CAPACITY_WORKER_MOUNT_INVALID");
	assert(secret.metadata?.name === ref.name && secret.metadata?.namespace === pod.metadata.namespace);
	const changed = Math.max(Date.parse(secret.metadata.creationTimestamp), ...(secret.metadata.managedFields ?? []).map((f: any) => Date.parse(f.time)));
	assert(Number.isFinite(changed) && Date.parse(pod.status.startTime) >= changed, "CAPACITY_WORKER_RESTART_REQUIRED");
	assert(typeof secret.data?.[ref.key] === "string");
	return { configPath, containerName: container.name, secretRef: { name: volume.secret.secretName, key: ref.key } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const [config, requests, templates] = process.argv.slice(2);
		const { ACK_KUBECONFIG: kubeconfig, ACK_NAMESPACE: namespace, ACK_SOURCE_SHA: source } = process.env;
		assert(kubeconfig && namespace && source && config && requests && templates);
		const kubectl = (args: string[]) => execFileSync("kubectl", ["--kubeconfig", kubeconfig, "--request-timeout=45s", "-n", namespace, ...args], { encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
		const result = await checkWorkloadCapacity(config, requests, templates, source, (ref) => {
			const deployment = JSON.parse(kubectl(["get", "deployment", "agent-infra-worker", "-o", "json"]));
			assert(deployment.status?.observedGeneration === deployment.metadata.generation && deployment.status.updatedReplicas === 1 && deployment.status.availableReplicas === 1);
			const pods = JSON.parse(kubectl(["get", "pods", "-l", "app.kubernetes.io/name=agent-infra,app.kubernetes.io/component=platform-worker", "-o", "json"])).items.filter((p: any) => !p.metadata.deletionTimestamp);
			assert(pods.length === 1 && pods[0].metadata.namespace === namespace);
			const pod = pods[0];
			const owner = pod.metadata.ownerReferences?.find((r: any) => r.kind === "ReplicaSet" && r.controller);
			assert(owner);
			const replicaSet = JSON.parse(kubectl(["get", "replicaset", owner.name, "-o", "json"]));
			assert(replicaSet.metadata.uid === owner.uid && replicaSet.metadata.ownerReferences?.some((r: any) => r.kind === "Deployment" && r.controller && r.uid === deployment.metadata.uid));
			const secret = JSON.parse(kubectl(["get", "secret", ref.name, "-o", "json", "--show-managed-fields=true"]));
			const mount = assertWorkerMount(pod, secret, ref);
			const script = `const {workloadInput:w}=await import(${JSON.stringify(pathToFileURL(mount.configPath).href)}); console.log(JSON.stringify({namespace:w.policy.namespace,resourceProfileRef:w.policy.resourceProfileRef,agentRuntimeCompute:process.env.AGENT_INFRA_AGENT_WORKLOAD_PLACEMENT?JSON.parse(process.env.AGENT_INFRA_AGENT_WORKLOAD_PLACEMENT).compute:undefined,sessionRuntimePlacement:process.env.AGENT_INFRA_SESSION_RUNTIME_PLACEMENT===undefined?undefined:JSON.parse(process.env.AGENT_INFRA_SESSION_RUNTIME_PLACEMENT),resources:w.policy.resources,codexSessionExecutor:w.policy.codexSessionExecutor,workspaceSnapshotEgress:w.policy.workspaceSnapshotEgress,storageSize:w.policy.storageSize,storageClassName:w.policy.storageClassName,profiles:w.executionCapacityProfiles}));process.exit(0);`;
			const actual = JSON.parse(kubectl(["exec", pod.metadata.name, "-c", mount.containerName, "--", "node", "--input-type=module", "-e", script]));
			assert(actual.namespace === namespace);
			const current = JSON.parse(kubectl(["get", "pod", pod.metadata.name, "-o", "json"]));
			assert(current.metadata.uid === pod.metadata.uid && !current.metadata.deletionTimestamp);
			const currentSecret = JSON.parse(kubectl(["get", "secret", ref.name, "-o", "json"]));
			assert(currentSecret.metadata.uid === secret.metadata.uid && currentSecret.metadata.resourceVersion === secret.metadata.resourceVersion);
			return { ...actual, bytes: Buffer.from(secret.data[ref.key], "base64"), secretRef: mount.secretRef };
		});
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} catch {
		process.stderr.write("ACK_WORKLOAD_CAPACITY_INVALID\n");
		process.exitCode = 1;
	}
}
