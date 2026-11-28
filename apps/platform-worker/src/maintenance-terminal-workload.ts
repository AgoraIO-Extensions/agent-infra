import { setTimeout as delay } from "node:timers/promises";
import type {
	KubernetesObject,
	V1NetworkPolicy,
	V1PersistentVolumeClaim,
	V1Pod,
} from "@kubernetes/client-node";
import {
	type AgentWorkloadPlacementV1,
	agentWorkloadPlacementShapeV1,
	agentWorkloadPodPlacementV1,
	isEciProviderPodAnnotationV1,
} from "./agent-workload-placement.js";
import {
	type WorkerKubernetesClientV1,
	WorkloadKubernetesError,
	type WorkloadResourceKind,
} from "./kubernetes-client.js";
import { workloadImagePullSpecV1 } from "./kubernetes-runtime-comparison.js";

const component = "agent-maintenance";
const directoryLabel = "agent-infra.agora.io/maintenance-directory";
export interface MaintenanceWorkloadOptions {
	directoryId: string;
	namespace: string;
	image: string;
	storageClass: string;
	placement?: AgentWorkloadPlacementV1;
	idleMs?: number | null;
	imagePullSecretName?: string;
	release?: string;
}
export function maintenanceWorkload(options: MaintenanceWorkloadOptions) {
	if (
		!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
			options.directoryId,
		) ||
		!/^[a-z0-9.:-]+(?:\/[a-z0-9._-]+)+@sha256:[a-f0-9]{64}$/.test(
			options.image,
		) ||
		!/^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$|^[a-z0-9]$/.test(
			options.storageClass,
		) ||
		(options.idleMs != null &&
			(!Number.isSafeInteger(options.idleMs) || options.idleMs < 1))
	)
		throw new Error("Invalid maintenance deployment");
	const name = `maint-${options.directoryId}`;
	const labels = {
		"app.kubernetes.io/instance": options.release ?? "agent-infra",
		"app.kubernetes.io/component": component,
		...(options.placement
			? { "agent-infra.agora.io/agent": options.directoryId }
			: {}),
		[directoryLabel]: options.directoryId,
	};
	const metadata = { namespace: options.namespace, name, labels };
	const claim: V1PersistentVolumeClaim = {
		apiVersion: "v1",
		kind: "PersistentVolumeClaim",
		metadata,
		spec: {
			accessModes: ["ReadWriteMany"],
			storageClassName: options.storageClass,
			resources: { requests: { storage: "1Gi" } },
		},
	};
	const policy: V1NetworkPolicy = {
		apiVersion: "networking.k8s.io/v1",
		kind: "NetworkPolicy",
		metadata,
		spec: {
			podSelector: { matchLabels: labels },
			policyTypes: ["Ingress", "Egress"],
			ingress: [],
			egress: [],
		},
	};
	const pod: V1Pod = {
		apiVersion: "v1",
		kind: "Pod",
		metadata,
		spec: {
			automountServiceAccountToken: false,
			enableServiceLinks: false,
			restartPolicy: "Never",
			...agentWorkloadPodPlacementV1(options.placement),
			...workloadImagePullSpecV1(options.imagePullSecretName),
			securityContext: {
				runAsNonRoot: true,
				runAsUser: 1000,
				runAsGroup: 1000,
				seccompProfile: { type: "RuntimeDefault" },
			},
			containers: [
				{
					name: "maintenance",
					image: options.image,
					command: ["node", "/app/dist/maintenance-idle.mjs"],
					args: [
						String(options.idleMs === null ? 0 : (options.idleMs ?? 1_800_000)),
					],
					workingDir: "/deployment",
					env: [
						{ name: "HOME", value: "/deployment" },
						{ name: "TERM", value: "xterm-256color" },
					],
					securityContext: {
						allowPrivilegeEscalation: false,
						readOnlyRootFilesystem: true,
						capabilities: { drop: ["ALL"] },
					},
					resources: {
						requests: { cpu: "250m", memory: "256Mi" },
						limits: { cpu: "1", memory: "512Mi" },
					},
					volumeMounts: [
						{ name: "deployment", mountPath: "/deployment" },
						{ name: "tmp", mountPath: "/tmp" },
					],
				},
			],
			volumes: [
				{ name: "deployment", persistentVolumeClaim: { claimName: name } },
				{ name: "tmp", emptyDir: {} },
			],
		},
	};
	return { pod, policy, claim };
}

export function assertMaintenanceResourceOwnership(
	value: KubernetesObject,
	expected: KubernetesObject,
) {
	if (
		!value.metadata?.uid ||
		value.metadata.namespace !== expected.metadata?.namespace ||
		value.metadata.name !== expected.metadata?.name ||
		value.metadata.labels?.[directoryLabel] !==
			expected.metadata?.labels?.[directoryLabel] ||
		value.metadata.labels?.["app.kubernetes.io/instance"] !==
			expected.metadata?.labels?.["app.kubernetes.io/instance"] ||
		value.metadata.labels?.["app.kubernetes.io/component"] !==
			expected.metadata?.labels?.["app.kubernetes.io/component"] ||
		value.metadata.ownerReferences?.length
	)
		throw new Error("Maintenance resource ownership mismatch");
}

export async function ensureMaintenanceResource<T extends KubernetesObject>(
	client: WorkerKubernetesClientV1,
	object: T,
): Promise<T> {
	const name = object.metadata?.name;
	if (!name) throw new Error("Missing maintenance resource name");
	const read = () => client.read<T>(object.kind as WorkloadResourceKind, name);
	let current = await read();
	if (!current) {
		try {
			current = await client.create(object);
		} catch (error) {
			if (
				!(error instanceof WorkloadKubernetesError && error.code === "conflict")
			)
				throw error;
			current = await read();
		}
	}
	if (!current) throw new Error("Maintenance resource unavailable");
	assertMaintenanceResourceOwnership(current, object);
	return current;
}

// Reject admission sidecars, credentials or alternate volumes before attaching a terminal.
function verifyPod(pod: V1Pod, expected: V1Pod) {
	const spec = pod.spec;
	const wanted = expected.spec;
	if (!wanted) throw new Error("Missing maintenance Pod specification");
	const c = spec?.containers[0];
	const w = wanted.containers[0];
	if (!w) throw new Error("Missing maintenance container");
	if (
		!spec ||
		!c ||
		spec.automountServiceAccountToken !== false ||
		spec.enableServiceLinks !== false ||
		spec.hostPID ||
		spec.hostIPC ||
		spec.hostNetwork ||
		spec.shareProcessNamespace ||
		spec.initContainers?.length ||
		spec.ephemeralContainers?.length ||
		spec.containers.length !== 1 ||
		spec.volumes?.length !== 2 ||
		c.volumeMounts?.length !== 2 ||
		!spec.volumes.some(
			(v) =>
				v.name === "deployment" &&
				v.persistentVolumeClaim?.claimName === expected.metadata?.name &&
				!v.persistentVolumeClaim?.readOnly,
		) ||
		!spec.volumes.some((v) => v.name === "tmp" && v.emptyDir != null) ||
		!w.volumeMounts?.every((m) =>
			c.volumeMounts?.some(
				(a) =>
					a.name === m.name &&
					a.mountPath === m.mountPath &&
					!a.subPath &&
					!a.subPathExpr &&
					!a.readOnly &&
					(!a.mountPropagation || a.mountPropagation === "None"),
			),
		) ||
		spec.securityContext?.runAsUser !== 1000 ||
		spec.securityContext.runAsNonRoot !== true ||
		spec.securityContext.runAsGroup !== 1000 ||
		spec.securityContext.seccompProfile?.type !== "RuntimeDefault" ||
		c.image !== w.image ||
		c.name !== w.name ||
		c.workingDir !== w.workingDir ||
		JSON.stringify(c.command) !== JSON.stringify(w.command) ||
		JSON.stringify(c.args) !== JSON.stringify(w.args) ||
		c.lifecycle ||
		c.volumeDevices?.length ||
		c.envFrom?.length ||
		c.env?.length !== 2 ||
		!w.env?.every((e) =>
			c.env?.some(
				(a) => e.name === a.name && e.value === a.value && !a.valueFrom,
			),
		) ||
		c.securityContext?.privileged ||
		c.securityContext?.allowPrivilegeEscalation !== false ||
		c.securityContext.readOnlyRootFilesystem !== true ||
		c.securityContext.capabilities?.add?.length ||
		!c.securityContext.capabilities?.drop?.includes("ALL") ||
		(c.securityContext.runAsUser !== undefined &&
			c.securityContext.runAsUser !== 1000) ||
		(c.securityContext.runAsGroup !== undefined &&
			c.securityContext.runAsGroup !== 1000)
	)
		throw new Error("Maintenance Pod differs from its deployment");
}

/** ACK virtual nodes can host both ECI and ACS. Verify the allocated instance. */
export function assertMaintenancePodCompute(
	pod: V1Pod,
	placement: AgentWorkloadPlacementV1 | undefined,
) {
	if (!placement) return;
	const annotations = pod.metadata?.annotations;
	const eciKey = "k8s.aliyun.com/eci-instance-id";
	const eci = annotations?.[eciKey] ?? "";
	const instance = annotations?.["alibabacloud.com/instance-id"];
	if (
		!isEciProviderPodAnnotationV1(
			placement.architecture,
			pod.spec,
			eciKey,
			eci,
		) ||
		(instance !== undefined && instance !== eci)
	)
		throw new Error(
			"Maintenance Pod compute does not match admitted ECI placement",
		);
}

function maintenancePolicySelector(
	network: V1NetworkPolicy,
	expected: V1NetworkPolicy,
) {
	const labels = network.spec?.podSelector?.matchLabels;
	if (
		!labels ||
		network.metadata?.deletionTimestamp ||
		network.spec?.egress?.length ||
		network.spec?.ingress?.length ||
		network.spec?.podSelector?.matchExpressions?.length ||
		JSON.stringify(Object.entries(labels).sort()) !==
			JSON.stringify(
				Object.entries(expected.spec?.podSelector?.matchLabels ?? {}).sort(),
			) ||
		!["Ingress", "Egress"].every((p) => network.spec?.policyTypes?.includes(p))
	)
		throw new Error("Maintenance network policy mismatch");
	return labels;
}

export async function prepareMaintenancePod(
	client: WorkerKubernetesClientV1,
	options: MaintenanceWorkloadOptions,
	signal: AbortSignal,
) {
	const { pod, claim, policy } = maintenanceWorkload(options);
	signal.throwIfAborted();
	const network = await ensureMaintenanceResource(client, policy);
	maintenancePolicySelector(network, policy);
	const policyName = network.metadata?.name;
	if (!policyName) throw new Error("Missing maintenance policy name");
	const disk = await ensureMaintenanceResource(client, claim);
	if (
		disk.metadata?.deletionTimestamp ||
		disk.spec?.storageClassName !== options.storageClass ||
		disk.spec.volumeMode === "Block" ||
		disk.spec.dataSource ||
		disk.spec.dataSourceRef ||
		!disk.spec.accessModes?.includes("ReadWriteMany")
	)
		throw new Error("Maintenance volume mismatch");
	for (;;) {
		signal.throwIfAborted();
		const current = await ensureMaintenanceResource(client, pod);
		verifyPod(current, pod);
		if (
			options.placement &&
			agentWorkloadPlacementShapeV1(options.placement, current.spec, true) !==
				"placed"
		)
			throw new Error("Invalid maintenance Pod placement");
		if (!current.metadata?.deletionTimestamp) {
			if (["Succeeded", "Failed"].includes(current.status?.phase ?? ""))
				await client.delete(current);
			else if (
				current.status?.phase === "Running" &&
				current.status.containerStatuses?.some(
					(c) => c.name === "maintenance" && c.ready,
				)
			) {
				assertMaintenancePodCompute(current, options.placement);
				const live = await client.read<V1NetworkPolicy>(
					"NetworkPolicy",
					policyName,
				);
				if (!live || live.metadata?.uid !== network.metadata?.uid)
					throw new Error("Maintenance network policy mismatch");
				assertMaintenanceResourceOwnership(live, policy);
				const labels = maintenancePolicySelector(live, policy);
				if (
					Object.entries(labels).some(
						([key, value]) => current.metadata?.labels?.[key] !== value,
					)
				)
					throw new Error("Maintenance network policy mismatch");
				return current;
			}
		}
		await delay(750, undefined, { signal });
	}
}
