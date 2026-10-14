import { createHash } from "node:crypto";
import type { AgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import type {
	KubernetesObject,
	V1Container,
	V1Deployment,
	V1Ingress,
	V1NetworkPolicy,
	V1PersistentVolumeClaim,
	V1PodSpec,
	V1Service,
	V1ServiceAccount,
	V1StatefulSet,
} from "@kubernetes/client-node";
import type { WorkerKubernetesClientV1 } from "./kubernetes-client.js";
import {
	agentAnnotation,
	desiredAnnotation,
	fingerprintAnnotation,
	ownerLabel,
	revisionLabel,
	workloadResourceNameV1,
} from "./kubernetes-runtime-comparison.js";

export type MultiServiceDesired = AgentWorkloadDesiredV1 & {
	multiService: NonNullable<AgentWorkloadDesiredV1["multiService"]>;
};

export interface MultiServiceRuntimePolicyV1 {
	readonly namespace: string;
	/** The only repository admitted for user supplied digest-only images. */
	readonly imageRepository?: string;
	/** Platform storage tier. Manifest PVC sizing and class are never authoritative. */
	readonly storageSize?: string;
	readonly storageClassName?: string;
	readonly routeHostSuffix: string;
	readonly ingressClassName: string;
	readonly tlsSecretName: string;
	readonly routeSelector: Readonly<Record<string, string>>;
}

export function isMultiService(
	value: AgentWorkloadDesiredV1,
): value is MultiServiceDesired {
	return (
		value.multiService !== undefined &&
		value.runtimeManifest.interactionMode === "self-managed"
	);
}

function serviceResourceName(agentId: string, name: string): string {
	const prefix = `${workloadResourceNameV1(agentId)}-`;
	const suffix = name.slice(0, Math.max(1, 63 - prefix.length));
	return `${prefix}${suffix}`.replace(/[^a-z0-9-]/g, "-").replace(/-+$/g, "");
}

function serviceLabel(name: string): string {
	return name.length <= 63 ? name : name.slice(0, 63);
}

function imageReference(policy: MultiServiceRuntimePolicyV1, digest: string) {
	return policy.imageRepository
		? `${policy.imageRepository}@${digest}`
		: digest;
}

function fingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function metadata(value: MultiServiceDesired, name: string, service?: string) {
	const labels = {
		[ownerLabel]: workloadResourceNameV1(value.agentId),
		[revisionLabel]: String(value.workloadRevision),
		...(service
			? { "agent-infra.agora.io/service": serviceLabel(service) }
			: {}),
	};
	return {
		name,
		namespace: value.namespaceRef,
		labels,
		annotations: {
			[agentAnnotation]: value.agentId,
			[desiredAnnotation]: JSON.stringify(value.multiService),
			[fingerprintAnnotation]: fingerprint(value.multiService),
			"agent-infra.agora.io/fence": String(value.fence),
		},
	};
}

function owned(resource: KubernetesObject, value: MultiServiceDesired) {
	return (
		resource.metadata?.labels?.[ownerLabel] ===
			workloadResourceNameV1(value.agentId) &&
		resource.metadata?.annotations?.[agentAnnotation] === value.agentId &&
		resource.metadata?.annotations?.[fingerprintAnnotation] ===
			fingerprint(value.multiService)
	);
}

function deployment(
	value: MultiServiceDesired,
	resource: Extract<
		MultiServiceDesired["multiService"]["resources"][number],
		{ kind: "Deployment" }
	>,
	policy: MultiServiceRuntimePolicyV1,
): V1Deployment {
	const name = serviceResourceName(value.agentId, resource.metadata.name);
	const service = serviceLabel(resource.metadata.name);
	const labels = {
		...resource.spec.template.metadata.labels,
		[ownerLabel]: workloadResourceNameV1(value.agentId),
		"agent-infra.agora.io/service": service,
	};
	const selector = {
		...resource.spec.selector.matchLabels,
		[ownerLabel]: workloadResourceNameV1(value.agentId),
		"agent-infra.agora.io/service": service,
	};
	return {
		apiVersion: "apps/v1",
		kind: "Deployment",
		metadata: metadata(value, name, resource.metadata.name),
		spec: {
			replicas: value.replicas,
			selector: { matchLabels: selector },
			template: {
				metadata: { labels },
				spec: {
					...resource.spec.template.spec,
					containers: resource.spec.template.spec.containers.map(
						(container) => ({
							...container,
							image: imageReference(policy, container.image),
							ports: container.ports?.map((port) => ({
								name: port.name,
								containerPort: port.targetPort,
							})),
						}),
					),
					serviceAccountName: workloadResourceNameV1(value.agentId),
					automountServiceAccountToken: false,
				},
			},
		},
	};
}

function statefulSet(
	value: MultiServiceDesired,
	resource: Extract<
		MultiServiceDesired["multiService"]["resources"][number],
		{ kind: "StatefulSet" }
	>,
	policy: MultiServiceRuntimePolicyV1,
	persistentVolumeClaim?: V1PersistentVolumeClaim,
): V1StatefulSet {
	const name = serviceResourceName(value.agentId, resource.metadata.name);
	const serviceName = serviceResourceName(
		value.agentId,
		resource.spec.serviceName,
	);
	const service = serviceLabel(resource.metadata.name);
	const labels = {
		...resource.spec.template.metadata.labels,
		[ownerLabel]: workloadResourceNameV1(value.agentId),
		"agent-infra.agora.io/service": service,
	};
	const selector = {
		...resource.spec.selector.matchLabels,
		[ownerLabel]: workloadResourceNameV1(value.agentId),
		"agent-infra.agora.io/service": service,
	};
	const claimName = persistentVolumeClaim?.metadata?.name
		? serviceResourceName(value.agentId, persistentVolumeClaim.metadata.name)
		: undefined;
	const volumeMount = claimName
		? { name: "data", mountPath: "/data" }
		: undefined;
	const podSpecWithVolumes = resource.spec.template
		.spec as typeof resource.spec.template.spec & Pick<V1PodSpec, "volumes">;
	return {
		apiVersion: "apps/v1",
		kind: "StatefulSet",
		metadata: metadata(value, name, resource.metadata.name),
		spec: {
			replicas: value.replicas,
			serviceName,
			selector: { matchLabels: selector },
			// Retain the claim on scale-down and controller deletion. Agent deletion
			// explicitly decides whether this PVC is removed below.
			persistentVolumeClaimRetentionPolicy: {
				whenDeleted: "Retain",
				whenScaled: "Retain",
			},
			template: {
				metadata: { labels },
				spec: {
					...resource.spec.template.spec,
					containers: resource.spec.template.spec.containers.map(
						(container) => ({
							...container,
							image: imageReference(policy, container.image),
							ports: container.ports?.map((port) => ({
								name: port.name,
								containerPort: port.targetPort,
							})),
							...(volumeMount
								? {
										volumeMounts: [
											...(
												(
													container as typeof container &
														Pick<V1Container, "volumeMounts">
												).volumeMounts ?? []
											).filter((mount) => mount.name !== volumeMount.name),
											volumeMount,
										],
									}
								: {}),
						}),
					),
					...(claimName
						? {
								volumes: [
									...(podSpecWithVolumes.volumes ?? []).filter(
										(volume) => volume.name !== "data",
									),
									{
										name: "data",
										persistentVolumeClaim: { claimName },
									},
								],
							}
						: {}),
					serviceAccountName: workloadResourceNameV1(value.agentId),
					automountServiceAccountToken: false,
				},
			},
		},
	};
}

function persistentVolumeClaim(
	value: MultiServiceDesired,
	resource: Extract<
		MultiServiceDesired["multiService"]["resources"][number],
		{ kind: "PersistentVolumeClaim" }
	>,
	policy: MultiServiceRuntimePolicyV1,
): V1PersistentVolumeClaim {
	if (!policy.storageSize)
		throw new Error("multi-service storage policy missing");
	const spec: NonNullable<V1PersistentVolumeClaim["spec"]> = {
		accessModes: ["ReadWriteOnce"],
		...(policy.storageClassName
			? { storageClassName: policy.storageClassName }
			: {}),
		resources: {
			requests: {
				// The manifest's request is deliberately ignored. Storage is a
				// deployment policy input, just like the single-image workload PVC.
				storage: policy.storageSize,
			},
		},
	};
	return {
		apiVersion: "v1",
		kind: "PersistentVolumeClaim",
		metadata: metadata(
			value,
			serviceResourceName(value.agentId, resource.metadata.name),
		),
		spec,
	};
}

function storageMatchesPolicy(
	current: V1PersistentVolumeClaim,
	policy: MultiServiceRuntimePolicyV1,
) {
	const expectedStorage = policy.storageSize;
	const actual = current.spec?.resources?.requests?.storage;
	return (
		Array.isArray(current.spec?.accessModes) &&
		current.spec.accessModes.length === 1 &&
		current.spec.accessModes[0] === "ReadWriteOnce" &&
		policy.storageSize !== undefined &&
		actual === expectedStorage &&
		(policy.storageClassName === undefined ||
			current.spec.storageClassName === policy.storageClassName) &&
		(current.spec.volumeMode === undefined ||
			current.spec.volumeMode === "Filesystem") &&
		current.spec.selector === undefined &&
		current.spec.dataSource === undefined &&
		current.spec.dataSourceRef === undefined &&
		Object.keys(current.spec ?? {}).every((key) =>
			[
				"accessModes",
				"resources",
				"storageClassName",
				"volumeMode",
				"volumeName",
			].includes(key),
		)
	);
}

function service(
	value: MultiServiceDesired,
	resource: Extract<
		MultiServiceDesired["multiService"]["resources"][number],
		{ kind: "Service" }
	>,
): V1Service {
	const name = serviceResourceName(value.agentId, resource.metadata.name);
	const selector = {
		...resource.spec.selector,
		[ownerLabel]: workloadResourceNameV1(value.agentId),
		"agent-infra.agora.io/service": serviceLabel(resource.metadata.name),
	};
	return {
		apiVersion: "v1",
		kind: "Service",
		metadata: metadata(value, name, resource.metadata.name),
		spec: { ...resource.spec, selector },
	};
}

function serviceAccount(value: MultiServiceDesired): V1ServiceAccount {
	return {
		apiVersion: "v1",
		kind: "ServiceAccount",
		metadata: metadata(value, workloadResourceNameV1(value.agentId)),
		automountServiceAccountToken: false,
	};
}

function networkPolicy(
	value: MultiServiceDesired,
	resource: Extract<
		MultiServiceDesired["multiService"]["resources"][number],
		{ kind: "Deployment" | "StatefulSet" }
	>,
	policy: MultiServiceRuntimePolicyV1,
): V1NetworkPolicy {
	const name = serviceResourceName(value.agentId, resource.metadata.name);
	const entry = value.multiService.entryServiceName === resource.metadata.name;
	return {
		apiVersion: "networking.k8s.io/v1",
		kind: "NetworkPolicy",
		metadata: metadata(value, `${name}-network`),
		spec: {
			podSelector: {
				matchLabels: {
					[ownerLabel]: workloadResourceNameV1(value.agentId),
					"agent-infra.agora.io/service": serviceLabel(resource.metadata.name),
				},
			},
			policyTypes: ["Ingress"],
			ingress: [
				{
					_from: [
						{
							podSelector: {
								matchLabels: {
									[ownerLabel]: workloadResourceNameV1(value.agentId),
								},
							},
						},
						...(entry
							? [{ podSelector: { matchLabels: policy.routeSelector } }]
							: []),
					],
				},
			],
		},
	};
}

function ingress(
	value: MultiServiceDesired,
	policy: MultiServiceRuntimePolicyV1,
): V1Ingress {
	const entry = value.multiService.entryServiceName;
	const resource = value.multiService.resources.find(
		(item) => item.kind === "Service" && item.metadata.name === entry,
	);
	if (resource?.kind !== "Service" || resource.spec.ports[0] === undefined)
		throw new Error("Multi-service entry Service is invalid");
	const name = workloadResourceNameV1(value.agentId);
	const host = `${name}.${policy.routeHostSuffix}`;
	return {
		apiVersion: "networking.k8s.io/v1",
		kind: "Ingress",
		metadata: metadata(value, name),
		spec: {
			ingressClassName: policy.ingressClassName,
			tls: [{ hosts: [host], secretName: policy.tlsSecretName }],
			rules: [
				{
					host,
					http: {
						paths: [
							{
								path: "/",
								pathType: "Prefix",
								backend: {
									service: {
										name: serviceResourceName(value.agentId, entry),
										port: { number: resource.spec.ports[0].port },
									},
								},
							},
						],
					},
				},
			],
		},
	};
}

export function createMultiServiceRuntimeOperations(options: {
	readonly client: WorkerKubernetesClientV1;
	readonly policy: MultiServiceRuntimePolicyV1;
}) {
	const { client } = options;
	function resourceName(value: MultiServiceDesired, name: string) {
		return serviceResourceName(value.agentId, name);
	}
	function manifestPvc(value: MultiServiceDesired, name: string) {
		return value.multiService.resources.find(
			(resource) =>
				resource.kind === "PersistentVolumeClaim" &&
				resourceName(value, resource.metadata.name) === name,
		);
	}
	async function put<T extends KubernetesObject>(
		object: T,
		value: MultiServiceDesired,
	) {
		const current = await client.read<T>(
			object.kind as never,
			object.metadata?.name ?? "",
		);
		if (!current) return client.create(object);
		if (!owned(current, value))
			throw new Error("multi-service resource drifted");
		if (current.kind === "PersistentVolumeClaim") {
			const source = manifestPvc(value, current.metadata?.name ?? "");
			if (
				!source ||
				!storageMatchesPolicy(
					current as V1PersistentVolumeClaim,
					options.policy,
				)
			)
				throw new Error("multi-service PVC drifted");
		}
		if (current.metadata?.resourceVersion && current.metadata.uid) {
			const currentPvc =
				current.kind === "PersistentVolumeClaim"
					? (current as unknown as V1PersistentVolumeClaim)
					: undefined;
			const replacement = {
				...object,
				...(currentPvc
					? {
							spec: {
								...(object as V1PersistentVolumeClaim).spec,
								...(currentPvc.spec?.volumeName
									? { volumeName: currentPvc.spec.volumeName }
									: {}),
								...(currentPvc.spec?.volumeMode
									? { volumeMode: currentPvc.spec.volumeMode }
									: {}),
								...(currentPvc.spec?.storageClassName
									? { storageClassName: currentPvc.spec.storageClassName }
									: {}),
							},
						}
					: {}),
				metadata: {
					...object.metadata,
					resourceVersion: current.metadata.resourceVersion,
					uid: current.metadata.uid,
				},
			};
			return client.replace(replacement);
		}
		return current;
	}
	async function remove(
		kind:
			| "Deployment"
			| "StatefulSet"
			| "Service"
			| "ServiceAccount"
			| "NetworkPolicy"
			| "Ingress"
			| "PersistentVolumeClaim",
		name: string,
		value: MultiServiceDesired,
	) {
		const current = await client.read(kind, name);
		if (!current) return true;
		if (!owned(current, value))
			throw new Error("multi-service resource drifted");
		await client.delete(current);
		return (await client.read(kind, name)) === null;
	}
	async function scaleDown(value: MultiServiceDesired) {
		let pending = false;
		for (const resource of value.multiService.resources) {
			if (resource.kind !== "Deployment" && resource.kind !== "StatefulSet")
				continue;
			const current = await client.read<V1Deployment | V1StatefulSet>(
				resource.kind,
				resourceName(value, resource.metadata.name),
			);
			if (!current) continue;
			if (!owned(current, value))
				throw new Error("multi-service resource drifted");
			if (current.spec?.replicas !== 0) {
				if (!current.metadata?.resourceVersion || !current.metadata.uid)
					throw new Error("multi-service resource cannot be fenced");
				await client.replace({
					...current,
					metadata: {
						...current.metadata,
						labels: {
							...current.metadata.labels,
							[revisionLabel]: String(value.workloadRevision),
						},
						annotations: {
							...current.metadata.annotations,
							"agent-infra.agora.io/fence": String(value.fence),
						},
						resourceVersion: current.metadata.resourceVersion,
						uid: current.metadata.uid,
					},
					spec: { ...current.spec, replicas: 0 },
				} as V1Deployment | V1StatefulSet);
				pending = true;
			}
		}
		const pods = await client.list(
			"Pod",
			`agent-infra.agora.io/agent=${workloadResourceNameV1(value.agentId)}`,
		);
		return pending || pods.length > 0 ? ("pending" as const) : null;
	}
	return {
		isMultiService,
		async apply(value: MultiServiceDesired) {
			// PVCs are created first and use only the platform storage policy.
			for (const resource of value.multiService.resources) {
				if (resource.kind === "PersistentVolumeClaim")
					await put(
						persistentVolumeClaim(value, resource, options.policy),
						value,
					);
			}
			for (const resource of value.multiService.resources) {
				if (resource.kind === "Service")
					await put(service(value, resource), value);
			}
			for (const resource of value.multiService.resources) {
				if (resource.kind === "Deployment")
					await put(deployment(value, resource, options.policy), value);
				if (resource.kind === "StatefulSet") {
					const pvc = value.multiService.resources.find(
						(candidate) => candidate.kind === "PersistentVolumeClaim",
					);
					await put(
						statefulSet(
							value,
							resource,
							options.policy,
							pvc
								? persistentVolumeClaim(value, pvc, options.policy)
								: undefined,
						),
						value,
					);
				}
			}
			for (const resource of value.multiService.resources) {
				if (resource.kind === "Deployment" || resource.kind === "StatefulSet")
					await put(networkPolicy(value, resource, options.policy), value);
			}
			await put(serviceAccount(value), value);
			return {
				uid: workloadResourceNameV1(value.agentId),
				generation: value.workloadRevision,
			};
		},
		async observe(
			value: MultiServiceDesired,
			_identity: { uid: string; generation: number },
		) {
			for (const resource of value.multiService.resources) {
				if (resource.kind !== "Deployment" && resource.kind !== "StatefulSet")
					continue;
				const current = await client.read<V1Deployment | V1StatefulSet>(
					resource.kind,
					resourceName(value, resource.metadata.name),
				);
				if (
					!current ||
					!owned(current, value) ||
					(resource.kind === "Deployment"
						? (current.status?.availableReplicas ?? 0) < 1
						: (current.status?.readyReplicas ?? 0) < 1)
				)
					return "unhealthy" as const;
			}
			for (const resource of value.multiService.resources) {
				if (resource.kind !== "PersistentVolumeClaim") continue;
				const current = await client.read<V1PersistentVolumeClaim>(
					"PersistentVolumeClaim",
					resourceName(value, resource.metadata.name),
				);
				if (
					!current ||
					!owned(current, value) ||
					!storageMatchesPolicy(current, options.policy)
				)
					return "unhealthy" as const;
			}
			return "healthy" as const;
		},
		async promote(value: MultiServiceDesired) {
			await put(ingress(value, options.policy), value);
		},
		async closeRoute(value: MultiServiceDesired) {
			return remove("Ingress", workloadResourceNameV1(value.agentId), value);
		},
		scaleDown,
		async cleanupAgent(value: MultiServiceDesired, deleteVolume = false) {
			let complete = await remove(
				"Ingress",
				workloadResourceNameV1(value.agentId),
				value,
			);
			for (const resource of value.multiService.resources) {
				if (resource.kind === "Deployment" || resource.kind === "StatefulSet") {
					complete =
						(await remove(
							"NetworkPolicy",
							`${resourceName(value, resource.metadata.name)}-network`,
							value,
						)) && complete;
					complete =
						(await remove(
							resource.kind,
							resourceName(value, resource.metadata.name),
							value,
						)) && complete;
				}
				if (resource.kind === "Service")
					complete =
						(await remove(
							"Service",
							resourceName(value, resource.metadata.name),
							value,
						)) && complete;
			}
			complete =
				(await remove(
					"ServiceAccount",
					workloadResourceNameV1(value.agentId),
					value,
				)) && complete;
			if (
				(
					await client.list(
						"Pod",
						`agent-infra.agora.io/agent=${workloadResourceNameV1(value.agentId)}`,
					)
				).length > 0
			)
				complete = false;
			if (complete && deleteVolume)
				for (const resource of value.multiService.resources) {
					if (resource.kind !== "PersistentVolumeClaim") continue;
					complete =
						(await remove(
							"PersistentVolumeClaim",
							resourceName(value, resource.metadata.name),
							value,
						)) && complete;
				}
			return complete;
		},
	};
}
