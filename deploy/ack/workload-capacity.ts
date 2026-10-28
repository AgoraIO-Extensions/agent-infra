import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { privateBytes, privateJson } from "./private-input.ts";

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

/** Only the measured single-execution receipts used by this workflow are supported. */
function verifyMeasurement(bytes: Uint8Array, imageDigest: string, policy: any, capacity: number) {
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
	assert.deepEqual(resources(value.observedResources), resources(policy.resources), "CAPACITY_MEASURED_RESOURCES_DRIFT");
}

/** Read-only gate: Agent readiness does not prove that a Session can be allocated. */
export function validateCapacityBindings(requests: any[], templates: any[], policy: any, profiles: any[], evidence: Map<string, Uint8Array>) {
	assert(Array.isArray(requests) && requests.length > 0 && requests.length <= 20);
	assert(Array.isArray(templates) && Array.isArray(profiles));
	assert(typeof policy.resourceProfileRef === "string" && policy.resourceProfileRef);
	const resourcesHash = hash(JSON.stringify({ resourceProfileRef: policy.resourceProfileRef, ...resources(policy.resources) }));
	const checked = new Set<string>();
	for (const request of requests) {
		const source = request.source;
		assert(source && ["standard", "custom"].includes(source.kind));
		if (source.kind === "custom" && source.interactionMode === "self-managed") continue;
		const matches = source.kind === "standard" ? templates.filter((entry) => entry.templateId === source.templateId) : [];
		if (source.kind === "standard") assert(matches.length === 1);
		const imageDigest = source.kind === "standard" ? matches[0].imageDigest : source.imageReference?.split("@")[1];
		assert(typeof imageDigest === "string" && digest.test(imageDigest));
		if (checked.has(imageDigest)) continue;
		const matchesCapacity = profiles.filter((p) => p.imageDigest === imageDigest && p.resourceProfileRef === policy.resourceProfileRef && p.resourceConfigurationHash === resourcesHash);
		assert(matchesCapacity.length === 1, "CAPACITY_BINDING_MISSING_OR_AMBIGUOUS");
		const profile = matchesCapacity[0];
		// The current preflight contract measures one bounded execution. Do not
		// accept a larger declared limit without a receipt that measured it.
		assert(profile.schemaVersion === 1 && profile.maximumConcurrentExecutions === 1 && /^[a-f0-9]{64}$/u.test(profile.conformanceEvidenceHash) && !/^0+$/u.test(profile.conformanceEvidenceHash), "CAPACITY_PROFILE_UNMEASURED");
		const bytes = evidence.get(imageDigest);
		assert(bytes && hash(bytes) === profile.conformanceEvidenceHash, "CAPACITY_EVIDENCE_MISMATCH");
		verifyMeasurement(bytes, imageDigest, policy, profile.maximumConcurrentExecutions);
		checked.add(imageDigest);
	}
	return { schemaVersion: 1, kind: "ack-workload-capacity", imageCount: checked.size, resourceConfigurationHash: resourcesHash, businessVerified: false };
}

type WorkerInput = { bytes: Uint8Array; resourceProfileRef: string; resources: unknown; profiles: unknown; secretRef: SecretRef };
type SecretRef = { name: string; key: string };

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
	const evidence = new Map<string, Uint8Array>();
	for (const entry of input.evidence) {
		assert(digest.test(entry.imageDigest) && !evidence.has(entry.imageDigest));
		evidence.set(entry.imageDigest, await privateBytes(entry.file));
	}
	const bodies = await Promise.all(requests.requests.map((request: { bodyFile: string }) => privateJson(request.bodyFile)));
	const receipt = validateCapacityBindings(bodies, templates.templates, input, profiles.profiles, evidence);
	const ref = input.workerSecretRef;
	assert(ref && /^[a-z0-9][a-z0-9.-]{0,252}$/u.test(ref.name) && /^[A-Za-z0-9._-]{1,253}$/u.test(ref.key));
	const actual = readWorker(ref);
	assert.deepEqual(actual.secretRef, ref, "CAPACITY_WORKER_SECRET_BINDING_DRIFT");
	assert.deepEqual(Buffer.from(actual.bytes), bytes, "CAPACITY_SECRET_DRIFT");
	assert.equal(actual.resourceProfileRef, input.resourceProfileRef, "CAPACITY_WORKER_POLICY_DRIFT");
	assert.deepEqual(resources(actual.resources), resources(input.resources), "CAPACITY_WORKER_POLICY_DRIFT");
	assert.deepEqual(actual.profiles, profiles.profiles, "CAPACITY_WORKER_PROFILES_DRIFT");
	return { ...receipt, profilesHash: hash(bytes), mountedInputVerified: true };
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
		const kubectl = (args: string[]) => execFileSync("kubectl", ["--kubeconfig", kubeconfig, "--request-timeout=20s", "-n", namespace, ...args], { encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
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
			const script = `const {workloadInput:w}=await import(${JSON.stringify(pathToFileURL(mount.configPath).href)}); console.log(JSON.stringify({namespace:w.policy.namespace,resourceProfileRef:w.policy.resourceProfileRef,resources:w.policy.resources,profiles:w.executionCapacityProfiles}));process.exit(0);`;
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
