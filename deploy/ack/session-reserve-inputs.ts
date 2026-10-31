import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	parseSessionSandboxReserveConfigurationV1,
	sessionSandboxReserveDigestV1,
	type SessionSandboxReserveConfigurationV1,
} from "../../packages/platform-core/src/session-sandbox-reserves.ts";
import { privateBytes, privateJson } from "./private-input.ts";
import { validateCapacityBindings } from "./workload-capacity.ts";

type Json = Record<string, any>;
type ReadJson = (file: string) => Promise<Json>;
export type ReserveInputReceipt = {
	sourceSha: string;
	namespace: string;
	revision: number;
	enabled: boolean;
	configHash: string;
};
export type ReserveWorker = {
	sourceSha?: string | null;
	configuration: SessionSandboxReserveConfigurationV1 | null;
	policy: { namespace: string; resourceProfileRef: string; resources: Json; storageSize: string };
	resourceCosts: { cpuMillis: number; memoryBytes: number; storageBytes: number };
	configurationHash: string | null;
	storedReserveBytes: Uint8Array | null;
};
export type ReadReserveWorker = (environment: Record<string, string>, bootstrap: Json, secretName: string) => ReserveWorker | null;
export type ReserveKubectl = (args: string[], input?: string) => string;
export type ReserveReadbackOptions = { requireAdoption?: boolean };
const configKeys = ["schemaVersion", "enabled", "revision", "namespace", "totalBudget", "resourceCosts", "maximumReserves", "maximumConcurrentCreates", "ttlMs", "cooldownMs", "failureBackoffMs", "profiles"];
const runtimeInputsAnnotation = "agent-infra.agora.io/runtime-inputs-hash";
const profileKeys = ["agentId", "templateId", "imageDigest", "resourceConfigurationHash", "resources", "storageConfigurationVersion", "networkPolicyVersion", "signingConfigurationVersion", "transportConfigurationVersion", "connectionConfigurationVersion", "minimum", "maximum"];
function keys(value: unknown, allowed: string[]) {
	assert(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key)), "CAPSULE_RESERVE_EXTRA_FIELD");
}

function hashSecretData(data: Record<string, string> | undefined) {
	return createHash("sha256")
		.update(JSON.stringify(Object.entries(data ?? {}).sort(([a], [b]) => a.localeCompare(b))))
		.digest("hex");
}

function workerConfigurationMount(pod: Json, secretName: string) {
	const containers = [...(pod.spec?.containers ?? []), ...(pod.spec?.initContainers ?? [])];
	for (const container of containers) {
		for (const mount of container.volumeMounts ?? []) {
			if (!mount.readOnly || mount.subPath === undefined) continue;
			const volume = (pod.spec?.volumes ?? []).find((entry: Json) => entry.name === mount.name);
			if (volume?.secret?.secretName !== secretName) continue;
			const module = container.env?.find((entry: Json) => entry.name === "PLATFORM_WORKER_DEPLOYMENT_MODULE")?.value;
			if (typeof module !== "string" || !module.startsWith("file:///")) continue;
			const modulePath = decodeURIComponent(new URL(module).pathname);
			const expected = mount.mountPath.endsWith(`/${mount.subPath}`) ? mount.mountPath : (mount.mountPath.endsWith("/") ? `${mount.mountPath}${mount.subPath}` : `${mount.mountPath}/${mount.subPath}`);
			if (modulePath !== expected) continue;
			assert(typeof mount.subPath === "string" && /^[A-Za-z0-9._-]+$/u.test(mount.subPath), "CAPSULE_RESERVE_CONFIGURATION_MOUNT_INVALID");
			return { containerName: container.name, key: mount.subPath, mount, volume };
		}
	}
	throw new Error("CAPSULE_RESERVE_CONFIGURATION_MOUNT_INVALID");
}

export function parseReserveInput(input: Json, sourceSha: string, namespace: string) {
	keys(input, ["sourceSha", ...configKeys]);
	assert(input.sourceSha === sourceSha && /^[a-f0-9]{40}$/u.test(sourceSha), "CAPSULE_RESERVE_SOURCE_MISMATCH");
	const { sourceSha: _source, ...value } = input;
	keys(value.totalBudget, ["cpuMillis", "memoryBytes", "storageBytes"]);
	assert(Array.isArray(value.resourceCosts) && Array.isArray(value.profiles), "CAPSULE_RESERVE_CONFIGURATION_INVALID");
	for (const cost of value.resourceCosts) keys(cost, ["resourceConfigurationHash", "resources"]);
	for (const profile of value.profiles) keys(profile, profileKeys);
	const configuration = parseSessionSandboxReserveConfigurationV1(value as unknown as SessionSandboxReserveConfigurationV1);
	assert(configuration.namespace === namespace, "CAPSULE_RESERVE_NAMESPACE_MISMATCH");
	return configuration;
}

/** Read only: the existing mount/Pod restart checks bind the loaded policy to its Secret. */
export function readReserveWorker(environment: Record<string, string>, bootstrap: Json, secretName: string, execute?: ReserveKubectl, options: ReserveReadbackOptions | boolean = {}): ReserveWorker | null {
	const requireAdoption = typeof options === "boolean" ? options : options.requireAdoption !== false;
	const { ACK_KUBECONFIG: kubeconfig, ACK_NAMESPACE: namespace } = environment;
	assert(kubeconfig && namespace);
	const kubectl = execute ?? ((args: string[], input?: string) => execFileSync("kubectl", ["--kubeconfig", kubeconfig, "--request-timeout=20s", "-n", namespace, ...args], { input, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }));
	const namespaceBytes = kubectl(["get", "namespace", namespace, "--ignore-not-found", "-o", "json"]);
	if (!namespaceBytes.trim()) return null;
	const ns = JSON.parse(namespaceBytes);
	const clusterBytes = kubectl(["get", "namespace", "kube-system", "--ignore-not-found", "-o", "json"]);
	assert(clusterBytes.trim(), "CAPSULE_RESERVE_CLUSTER_MISSING");
	const cluster = JSON.parse(clusterBytes);
	assert(cluster.metadata?.uid === bootstrap.clusterUid, "CAPSULE_RESERVE_CLUSTER_MISMATCH");
	assert(ns.metadata?.labels?.["agent-infra.agora.io/bootstrap-id"] === bootstrap.installationId, "CAPSULE_RESERVE_NAMESPACE_OWNER_MISMATCH");
	const namespaceUid = ns.metadata?.uid;
	assert(typeof namespaceUid === "string" && namespaceUid.length > 0, "CAPSULE_RESERVE_NAMESPACE_UID_MISSING");
	const workerBytes = kubectl(["get", "deployment", "agent-infra-worker", "--ignore-not-found", "-o", "json"]);
	if (!workerBytes.trim()) return null;
	const deployment = JSON.parse(workerBytes);
	assert(deployment.status?.observedGeneration === deployment.metadata.generation && deployment.status.updatedReplicas === 1 && deployment.status.availableReplicas === 1, "CAPSULE_RESERVE_WORKER_NOT_READY");
	const pods = JSON.parse(kubectl(["get", "pods", "-l", "app.kubernetes.io/name=agent-infra,app.kubernetes.io/component=platform-worker", "-o", "json"])).items.filter((pod: any) => !pod.metadata.deletionTimestamp);
	assert(pods.length === 1 && pods[0].metadata.namespace === namespace, "CAPSULE_RESERVE_WORKER_AMBIGUOUS");
	const pod = pods[0];
	const owner = pod.metadata.ownerReferences?.find((entry: any) => entry.kind === "ReplicaSet" && entry.controller);
	assert(owner);
	const replicaSet = JSON.parse(kubectl(["get", "replicaset", owner.name, "-o", "json"]));
	assert(replicaSet.metadata.uid === owner.uid && replicaSet.metadata.ownerReferences?.some((entry: any) => entry.kind === "Deployment" && entry.controller && entry.uid === deployment.metadata.uid));
	const secret = JSON.parse(kubectl(["get", "secret", secretName, "-o", "json", "--show-managed-fields=true"]));
	assert(secret.metadata.labels?.["agent-infra.agora.io/bootstrap-id"] === bootstrap.installationId);
	const mount = workerConfigurationMount(pod, secretName);
	const reserveMount = pod.spec.containers?.find((container: any) => container.name === mount.containerName)?.volumeMounts?.find((entry: any) => entry.mountPath === "/var/run/agent-infra/deployment");
	assert(reserveMount?.readOnly && reserveMount.subPath === undefined && pod.spec.volumes?.some((volume: any) => volume.name === reserveMount.name && volume.secret?.secretName === secretName), "CAPSULE_RESERVE_MOUNT_INVALID");
	const secretHash = hashSecretData(secret.data);
	const script = `const entry=await import(process.env.PLATFORM_WORKER_DEPLOYMENT_MODULE); if(typeof entry.readPlatformSessionReserveDeploymentV1!=="function") throw Error("RESERVE_READBACK_UNAVAILABLE"); console.log(JSON.stringify(entry.readPlatformSessionReserveDeploymentV1()));process.exit(0);`;
	const actual = JSON.parse(kubectl(["exec", pod.metadata.name, "-c", mount.containerName, "--", "node", "--input-type=module", "-e", script]));
	assert(actual.policy?.namespace === namespace && (actual.configuration === null || actual.configuration?.namespace === namespace), "CAPSULE_RESERVE_NAMESPACE_READBACK_MISMATCH");
	if (environment.ACK_SOURCE_SHA !== undefined) assert(actual.sourceSha === environment.ACK_SOURCE_SHA, "CAPSULE_RESERVE_SOURCE_READBACK_MISMATCH");
	if (!requireAdoption) {
		const storedReserveBytes = secret.data?.["session-reserves.json"] ? Buffer.from(secret.data["session-reserves.json"], "base64") : null;
		return { ...actual, storedReserveBytes };
	}
	assert(deployment.spec.template.metadata?.annotations?.[runtimeInputsAnnotation] === secretHash, "CAPSULE_RESERVE_TEMPLATE_SECRET_HASH_MISMATCH");
	assert(replicaSet.spec?.template?.metadata?.annotations?.[runtimeInputsAnnotation] === secretHash, "CAPSULE_RESERVE_REPLICASET_SECRET_HASH_MISMATCH");
	assert(pod.metadata?.annotations?.[runtimeInputsAnnotation] === secretHash, "CAPSULE_RESERVE_POD_SECRET_HASH_MISMATCH");
	const current = JSON.parse(kubectl(["get", "pod", pod.metadata.name, "-o", "json"]));
	const currentDeployment = JSON.parse(kubectl(["get", "deployment", "agent-infra-worker", "-o", "json"]));
	const currentReplicaSet = JSON.parse(kubectl(["get", "replicaset", owner.name, "-o", "json"]));
	const currentSecret = JSON.parse(kubectl(["get", "secret", secretName, "-o", "json"]));
	const endNamespace = JSON.parse(kubectl(["get", "namespace", namespace, "--ignore-not-found", "-o", "json"]));
	assert(endNamespace.metadata?.uid === namespaceUid && !endNamespace.metadata?.deletionTimestamp, "CAPSULE_RESERVE_NAMESPACE_REPLACED");
	assert(current.metadata.uid === pod.metadata.uid && !current.metadata.deletionTimestamp && current.status?.startTime && pod.status?.startTime === current.status.startTime && currentDeployment.metadata.uid === deployment.metadata.uid && currentReplicaSet.metadata.uid === replicaSet.metadata.uid && currentSecret.metadata.uid === secret.metadata.uid && currentSecret.metadata.resourceVersion === secret.metadata.resourceVersion && !currentSecret.metadata.deletionTimestamp, "CAPSULE_RESERVE_READBACK_DRIFT");
	assert(currentDeployment.spec.template.metadata?.annotations?.[runtimeInputsAnnotation] === secretHash && currentReplicaSet.spec?.template?.metadata?.annotations?.[runtimeInputsAnnotation] === secretHash && current.metadata?.annotations?.[runtimeInputsAnnotation] === secretHash, "CAPSULE_RESERVE_TEMPLATE_SECRET_HASH_CHANGED");
	const storedReserveBytes = secret.data?.["session-reserves.json"] ? Buffer.from(secret.data["session-reserves.json"], "base64") : null;
	if (storedReserveBytes) assert(actual.configurationHash === sessionSandboxReserveDigestV1(JSON.parse(storedReserveBytes.toString("utf8"))), "CAPSULE_RESERVE_MOUNT_DRIFT");
	return { ...actual, storedReserveBytes };
}

export async function prepareReserveInput(environment: Record<string, string>, sourceSha: string, options: { readJson?: ReadJson; readWorker?: ReadReserveWorker; workerSecretName?: string; requireAdoption?: boolean; kubectl?: ReserveKubectl; baselineReserveBytes?: Uint8Array | null } = {}) {
	const readJson = options.readJson ?? privateJson;
	assert(environment.ACK_SESSION_RESERVES_FILE && environment.ACK_BOOTSTRAP_INPUTS_FILE && environment.ACK_NAMESPACE, "CAPSULE_RESERVE_INPUT_MISSING");
	const input = await readJson(environment.ACK_SESSION_RESERVES_FILE);
	const configuration = parseReserveInput(input, sourceSha, environment.ACK_NAMESPACE);
	const bootstrap = await readJson(environment.ACK_BOOTSTRAP_INPUTS_FILE);
	assert(bootstrap.namespace === configuration.namespace && Array.isArray(bootstrap.objects), "CAPSULE_RESERVE_BOOTSTRAP_INVALID");
	const workers = bootstrap.objects.filter((object: any) => object.kind === "Secret" && typeof object.name === "string" && (options.workerSecretName ? object.name === options.workerSecretName : object.name.endsWith("-worker-configuration")));
	assert(workers.length === 1 && workers[0].files && typeof workers[0].files === "object", "CAPSULE_RESERVE_WORKER_SECRET_AMBIGUOUS");
	const worker = workers[0];
	const bindings = bootstrap.objects.filter((object: any) => object.files?.["session-reserves.json"] !== undefined);
	assert(bindings.length <= 1 && (bindings.length === 0 || bindings[0] === worker), "CAPSULE_RESERVE_INPUT_DUPLICATE");
	const existingReserveBinding = worker.files["session-reserves.json"];
	if (configuration.profiles.length > 0) {
		assert(environment.ACK_WORKLOAD_CAPACITY_FILE && environment.ACK_TEMPLATE_VALIDATIONS_FILE, "CAPSULE_RESERVE_CAPACITY_INPUT_MISSING");
		const capacity = await readJson(environment.ACK_WORKLOAD_CAPACITY_FILE);
		const templates = await readJson(environment.ACK_TEMPLATE_VALIDATIONS_FILE);
		assert(capacity.sourceSha === sourceSha && templates.sourceSha === sourceSha, "CAPSULE_RESERVE_CAPACITY_SOURCE_MISMATCH");
		const profiles = await readJson(capacity.profilesFile);
		assert(profiles.schemaVersion === 1 && Array.isArray(profiles.profiles) && Array.isArray(capacity.evidence));
		const evidence = new Map<string, Uint8Array>();
		for (const entry of capacity.evidence) {
			assert(!evidence.has(entry.imageDigest));
			const bytes = await privateBytes(entry.file);
			const measured = JSON.parse(bytes.toString());
			assert((measured.receipt ?? measured).sourceCommit === sourceSha, "CAPSULE_RESERVE_MEASUREMENT_SOURCE_MISMATCH");
			evidence.set(entry.imageDigest, bytes);
		}
		const requests = configuration.profiles.map((profile) => {
			assert(templates.templates.filter((entry: any) => entry.templateId === profile.templateId && entry.imageDigest === profile.imageDigest).length === 1, "CAPSULE_RESERVE_TEMPLATE_MISMATCH");
			return { source: { kind: "standard", templateId: profile.templateId } };
		});
		const verified = validateCapacityBindings(requests, templates.templates, capacity, profiles.profiles, evidence);
		assert(configuration.resourceCosts.every((cost) => cost.resourceConfigurationHash === verified.resourceConfigurationHash), "CAPSULE_RESERVE_RESOURCE_HASH_MISMATCH");
	}
	let actual: ReserveWorker | null;
	let legacyReadbackUnavailable = false;
	try {
		actual = options.readWorker
			? options.readWorker(environment, bootstrap, worker.name)
			: readReserveWorker(environment, bootstrap, worker.name, options.kubectl, { requireAdoption: options.requireAdoption !== false });
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (!configuration.enabled && message === "RESERVE_READBACK_UNAVAILABLE") {
			actual = null;
			legacyReadbackUnavailable = true;
		} else throw error;
	}
	if (actual && options.readWorker === undefined && environment.ACK_SOURCE_SHA !== undefined)
		assert(actual.sourceSha === environment.ACK_SOURCE_SHA, "CAPSULE_RESERVE_SOURCE_READBACK_MISMATCH");
	if (configuration.enabled) assert(actual, "CAPSULE_RESERVE_APPROVED_WORKER_REQUIRED");
	if (existingReserveBinding !== undefined && existingReserveBinding !== environment.ACK_SESSION_RESERVES_FILE) {
		const baselineBytes = options.baselineReserveBytes ?? await privateBytes(existingReserveBinding);
		assert(actual?.storedReserveBytes !== undefined && Buffer.compare(Buffer.from(baselineBytes), Buffer.from(actual.storedReserveBytes ?? [])) === 0, "CAPSULE_RESERVE_INPUT_BASELINE_MISMATCH");
	}
	if (actual?.configuration) {
		assert(configuration.revision > actual.configuration.revision || (configuration.revision === actual.configuration.revision && sessionSandboxReserveDigestV1(configuration) === sessionSandboxReserveDigestV1(actual.configuration)), "CAPSULE_RESERVE_REVISION_DRIFT");
	}
	if (configuration.profiles.length > 0) {
		if (actual) {
			const capacity = await readJson(environment.ACK_WORKLOAD_CAPACITY_FILE);
			assert.deepEqual(actual.policy.resources, capacity.resources, "CAPSULE_RESERVE_RESOURCE_POLICY_DRIFT");
			assert.equal(actual.policy.resourceProfileRef, capacity.resourceProfileRef, "CAPSULE_RESERVE_RESOURCE_POLICY_DRIFT");
			for (const cost of configuration.resourceCosts) assert.deepEqual(cost.resources, actual.resourceCosts, "CAPSULE_RESERVE_COST_UNVERIFIED");
		}
	}
	const receipt: ReserveInputReceipt = { sourceSha, namespace: configuration.namespace, revision: configuration.revision, enabled: configuration.enabled, configHash: sessionSandboxReserveDigestV1(input) };
	return { receipt, workerSecretName: worker.name, actual, observed: actual, storedReserveBytes: actual?.storedReserveBytes ?? null, legacyReadbackUnavailable };
}
