import type {
	KubernetesObject,
	V1NetworkPolicy,
	V1PersistentVolumeClaim,
	V1Pod,
	V1Service,
	V1ServiceAccount,
} from "@kubernetes/client-node";
import type { WorkerKubernetesClientV1 } from "./kubernetes-client.js";
import { WorkloadKubernetesError } from "./kubernetes-client.js";

/**
 * Typed handoff for #1250. Until its Store schema is merged, the Worker consumes
 * this boundary only; it does not read or recreate allocation tables.
 */
export interface SessionSandboxAllocationV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly sessionId: string;
	readonly sandboxId: string;
	readonly generation: number;
	readonly fence: number;
	readonly namespace: string;
	readonly podName: string;
	readonly serviceName: string;
	readonly serviceAccountName: string;
	readonly pvcName: string;
	readonly networkPolicyName: string;
	readonly imageDigest: string;
	readonly authorizedIngressSelector: Readonly<Record<string, string>>;
	readonly containerPort: number;
	readonly workspaceMountPath: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly desiredState: "running" | "stopped";
}

export type SessionSandboxResourceSetV1 = readonly [
	V1ServiceAccount,
	V1PersistentVolumeClaim,
	V1NetworkPolicy,
	V1Service,
	V1Pod,
];

const labels = (allocation: SessionSandboxAllocationV1) => ({
	"agent-infra.agora.io/agent-id": allocation.agentId,
	"agent-infra.agora.io/session-id": allocation.sessionId,
	"agent-infra.agora.io/sandbox-id": allocation.sandboxId,
	"agent-infra.agora.io/generation": String(allocation.generation),
});

function metadata(allocation: SessionSandboxAllocationV1, name: string) {
	return {
		namespace: allocation.namespace,
		name,
		labels: labels(allocation),
		annotations: {
			"agent-infra.agora.io/fence": String(allocation.fence),
			"agent-infra.agora.io/managed": "session-sandbox-v1",
		},
	};
}

function validateAllocation(value: SessionSandboxAllocationV1) {
	if (
		value.schemaVersion !== 1 ||
		!value.agentId ||
		!value.sessionId ||
		!value.sandboxId ||
		!Number.isSafeInteger(value.generation) ||
		value.generation < 1 ||
		!Number.isSafeInteger(value.fence) ||
		value.fence < 1 ||
		!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(value.namespace) ||
		!value.podName ||
		!value.serviceName ||
		!value.serviceAccountName ||
		!value.pvcName ||
		!value.networkPolicyName ||
		!/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(value.imageDigest) ||
		Object.keys(value.authorizedIngressSelector).length === 0 ||
		Object.values(value.authorizedIngressSelector).some((item) => !item) ||
		!Number.isSafeInteger(value.containerPort) ||
		value.containerPort < 1 ||
		value.containerPort > 65535 ||
		!value.workspaceMountPath.startsWith("/")
	)
		throw new WorkloadKubernetesError("policy");
}

export function sessionSandboxResourcesV1(
	allocation: SessionSandboxAllocationV1,
): SessionSandboxResourceSetV1 {
	validateAllocation(allocation);
	const resourceLabels = labels(allocation);
	const account: V1ServiceAccount = {
		apiVersion: "v1",
		kind: "ServiceAccount",
		metadata: metadata(allocation, allocation.serviceAccountName),
		automountServiceAccountToken: false,
	};
	const pvc: V1PersistentVolumeClaim = {
		apiVersion: "v1",
		kind: "PersistentVolumeClaim",
		metadata: metadata(allocation, allocation.pvcName),
		spec: {
			accessModes: ["ReadWriteOnce"],
			resources: { requests: { storage: "1Gi" } },
		},
	};
	const policy: V1NetworkPolicy = {
		apiVersion: "networking.k8s.io/v1",
		kind: "NetworkPolicy",
		metadata: metadata(allocation, allocation.networkPolicyName),
		spec: {
			podSelector: { matchLabels: resourceLabels },
			policyTypes: ["Ingress", "Egress"],
			ingress: [
				{
					_from: [
						{
							podSelector: {
								matchLabels: allocation.authorizedIngressSelector,
							},
						},
					],
					ports: [{ protocol: "TCP", port: allocation.containerPort }],
				},
			],
			egress: [],
		},
	};
	const pod: V1Pod = {
		apiVersion: "v1",
		kind: "Pod",
		metadata: metadata(allocation, allocation.podName),
		spec: {
			serviceAccountName: allocation.serviceAccountName,
			automountServiceAccountToken: false,
			restartPolicy: "Always",
			containers: [
				{
					name: "runtime",
					image: allocation.imageDigest,
					imagePullPolicy: "IfNotPresent",
					ports: [{ containerPort: allocation.containerPort }],
					env: Object.entries(allocation.env ?? {}).map(([name, value]) => ({
						name,
						value,
					})),
					workingDir: allocation.workspaceMountPath,
					volumeMounts: [
						{ name: "workspace", mountPath: allocation.workspaceMountPath },
					],
					readinessProbe: {
						httpGet: { path: "/healthz", port: allocation.containerPort },
						periodSeconds: 5,
					},
					securityContext: {
						allowPrivilegeEscalation: false,
						readOnlyRootFilesystem: false,
						runAsNonRoot: true,
					},
				},
			],
			volumes: [
				{
					name: "workspace",
					persistentVolumeClaim: { claimName: allocation.pvcName },
				},
			],
		},
	};
	const service: V1Service = {
		apiVersion: "v1",
		kind: "Service",
		metadata: metadata(allocation, allocation.serviceName),
		spec: {
			type: "ClusterIP",
			selector: resourceLabels,
			ports: [
				{
					name: "runtime",
					port: allocation.containerPort,
					targetPort: allocation.containerPort,
				},
			],
		},
	};
	return [account, pvc, policy, service, pod];
}

function pvcSpecMatches(
	current: KubernetesObject,
	expected: V1PersistentVolumeClaim,
) {
	const spec = (current as V1PersistentVolumeClaim).spec;
	return (
		JSON.stringify(spec?.accessModes ?? []) ===
			JSON.stringify(expected.spec?.accessModes ?? []) &&
		spec?.resources?.requests?.storage ===
			expected.spec?.resources?.requests?.storage
	);
}

function podSpecMatches(current: KubernetesObject, expected: V1Pod) {
	const currentSpec = (current as V1Pod).spec;
	const expectedSpec = expected.spec;
	const currentContainer = currentSpec?.containers?.[0];
	const expectedContainer = expectedSpec?.containers?.[0];
	if (!currentSpec || !expectedSpec || !currentContainer || !expectedContainer)
		return false;
	if (
		currentSpec.containers.length !== expectedSpec.containers.length ||
		(currentSpec.initContainers?.length ?? 0) !==
			(expectedSpec.initContainers?.length ?? 0) ||
		(currentSpec.ephemeralContainers?.length ?? 0) !==
			(expectedSpec.ephemeralContainers?.length ?? 0)
	)
		return false;
	const normalizeEnv = (env: typeof expectedContainer.env) =>
		(env ?? [])
			.map(({ name, value, valueFrom }) => ({ name, value, valueFrom }))
			.sort((left, right) => left.name.localeCompare(right.name));
	return (
		currentSpec.serviceAccountName === expectedSpec.serviceAccountName &&
		currentSpec.automountServiceAccountToken ===
			expectedSpec.automountServiceAccountToken &&
		currentSpec.restartPolicy === expectedSpec.restartPolicy &&
		currentSpec.hostNetwork === expectedSpec.hostNetwork &&
		currentSpec.hostPID === expectedSpec.hostPID &&
		currentSpec.hostIPC === expectedSpec.hostIPC &&
		currentContainer.name === expectedContainer.name &&
		currentContainer.image === expectedContainer.image &&
		currentContainer.imagePullPolicy === expectedContainer.imagePullPolicy &&
		currentContainer.workingDir === expectedContainer.workingDir &&
		JSON.stringify(currentContainer.ports ?? []) ===
			JSON.stringify(expectedContainer.ports ?? []) &&
		JSON.stringify(normalizeEnv(currentContainer.env)) ===
			JSON.stringify(normalizeEnv(expectedContainer.env)) &&
		JSON.stringify(currentContainer.volumeMounts ?? []) ===
			JSON.stringify(expectedContainer.volumeMounts ?? []) &&
		JSON.stringify(currentContainer.securityContext ?? {}) ===
			JSON.stringify(expectedContainer.securityContext ?? {}) &&
		JSON.stringify(currentContainer.readinessProbe ?? {}) ===
			JSON.stringify(expectedContainer.readinessProbe ?? {}) &&
		JSON.stringify(currentSpec.volumes ?? []) ===
			JSON.stringify(expectedSpec.volumes ?? [])
	);
}

function owned(
	current: KubernetesObject,
	expected: KubernetesObject,
	allocation: SessionSandboxAllocationV1,
) {
	const currentLabels = current.metadata?.labels ?? {};
	const expectedLabels = expected.metadata?.labels ?? {};
	const currentFence =
		current.metadata?.annotations?.["agent-infra.agora.io/fence"];
	const managed =
		current.metadata?.annotations?.["agent-infra.agora.io/managed"];
	return (
		managed === "session-sandbox-v1" &&
		Object.entries(expectedLabels).every(
			([key, value]) => currentLabels[key] === value,
		) &&
		currentFence === String(allocation.fence)
	);
}

export function createSessionSandboxWorkloadAdapterV1(options: {
	readonly client: WorkerKubernetesClientV1;
}) {
	return {
		async apply(allocation: SessionSandboxAllocationV1) {
			if (options.client.namespace !== allocation.namespace)
				throw new WorkloadKubernetesError("policy");
			const resources = sessionSandboxResourcesV1(allocation);
			for (const expected of resources) {
				if (
					allocation.desiredState === "stopped" &&
					(expected.kind === "Pod" || expected.kind === "Service")
				) {
					const current = await options.client.read(
						expected.kind,
						expected.metadata?.name ?? "",
					);
					if (current) {
						if (!owned(current, expected, allocation))
							throw new WorkloadKubernetesError("conflict");
						await options.client.delete(current);
						if (
							await options.client.read(
								expected.kind,
								expected.metadata?.name ?? "",
							)
						)
							throw new WorkloadKubernetesError("unavailable");
					}
					continue;
				}
				const kind = expected.kind as Parameters<
					WorkerKubernetesClientV1["read"]
				>[0];
				const current = await options.client.read(
					kind,
					expected.metadata?.name ?? "",
				);
				if (current && !owned(current, expected, allocation))
					throw new WorkloadKubernetesError("conflict");
				if (!current) await options.client.create(expected);
				else if (expected.kind === "PersistentVolumeClaim") {
					if (
						!pvcSpecMatches(
							current as V1PersistentVolumeClaim,
							expected as V1PersistentVolumeClaim,
						)
					)
						throw new WorkloadKubernetesError("conflict");
				} else if (expected.kind === "Pod") {
					if (!podSpecMatches(current, expected as V1Pod))
						throw new WorkloadKubernetesError("conflict");
				} else
					await options.client.replace({
						...expected,
						metadata: {
							...expected.metadata,
							resourceVersion: current.metadata?.resourceVersion,
							uid: current.metadata?.uid,
						},
					});
			}
			return {
				sandboxId: allocation.sandboxId,
				generation: allocation.generation,
				fence: allocation.fence,
			};
		},
		async cleanup(allocation: SessionSandboxAllocationV1) {
			if (options.client.namespace !== allocation.namespace)
				throw new WorkloadKubernetesError("policy");
			const resources = sessionSandboxResourcesV1(allocation)
				.filter((resource) => resource.kind !== "PersistentVolumeClaim")
				.reverse();
			for (const expected of resources) {
				const kind = expected.kind as Parameters<
					WorkerKubernetesClientV1["read"]
				>[0];
				const current = await options.client.read(
					kind,
					expected.metadata?.name ?? "",
				);
				if (!current) continue;
				if (!owned(current, expected, allocation))
					throw new WorkloadKubernetesError("conflict");
				await options.client.delete(current);
			}
		},
	};
}
