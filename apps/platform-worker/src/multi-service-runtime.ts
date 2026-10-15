import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	calculateMultiServiceResourceCapacityV1,
	type MultiServiceProfiledWorkloadV1,
	type MultiServiceResourceCapV1,
	type MultiServiceResourceConfigurationV1,
	type MultiServiceResourceProfileV1,
	multiServiceWorkloadProfileRefV1,
	parseMultiServiceResourceConfigurationV1,
} from "@agent-infra/contracts/pilot";
import type { AgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import type {
	KubernetesObject,
	V1ConfigMap,
	V1Container,
	V1Deployment,
	V1Ingress,
	V1Job,
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
	readonly imageRepository?: string;
	readonly storageSize?: string;
	readonly storageClassName?: string;
	readonly routeHostSuffix: string;
	readonly ingressClassName: string;
	readonly tlsSecretName: string;
	readonly routeSelector: Readonly<Record<string, string>>;
	/** 必须与 API `apiInput` 中的同名配置一致；省略时使用合约默认值。 */
	readonly multiServiceResourceProfiles?: readonly MultiServiceResourceProfileV1[];
	readonly multiServiceResourceCap?: MultiServiceResourceCapV1;
}

/** 启动期解析部署档位与上限；非法配置使 Worker 装配失败（fail closed）。 */
export function resolveMultiServiceResourceConfigurationV1(
	policy: MultiServiceRuntimePolicyV1,
): MultiServiceResourceConfigurationV1 {
	try {
		return parseMultiServiceResourceConfigurationV1({
			profiles: policy.multiServiceResourceProfiles,
			cap: policy.multiServiceResourceCap,
		});
	} catch {
		throw new Error("multi-service resource policy invalid");
	}
}

function imageReference(policy: MultiServiceRuntimePolicyV1, digest: string) {
	return policy.imageRepository
		? `${policy.imageRepository}@${digest}`
		: digest;
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

function fingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function profileForWorkload(
	value: MultiServiceDesired,
	workload: MultiServiceProfiledWorkloadV1,
	resources: MultiServiceResourceConfigurationV1,
) {
	const ref = multiServiceWorkloadProfileRefV1(value.multiService, workload);
	const profile = resources.profiles.find(
		(candidate) => candidate.profileId === ref,
	);
	if (!profile) throw new Error("multi-service resource profile unavailable");
	return profile;
}

/** 首次 Kubernetes 写入前校验全部工作负载（含迁移 Job）的估算总量。 */
export function validateMultiServiceResourceCapacityV1(
	value: MultiServiceDesired,
	resources: MultiServiceResourceConfigurationV1,
) {
	const capacity = calculateMultiServiceResourceCapacityV1({
		manifest: value.multiService,
		configuration: resources,
	});
	if (!capacity.ok)
		throw new Error(
			capacity.reason === "cap_exceeded"
				? "MULTI_SERVICE_RESOURCE_CAP_EXCEEDED"
				: "multi-service resource profile unavailable",
		);
	return { total: capacity.total, cap: capacity.cap };
}

/**
 * PVC 由唯一的 StatefulSet 挂载（API 拓扑准入保证）。PVC 大小取该 StatefulSet 档位的
 * storageSize，档位未声明时沿用部署的全局 storageSize；用户 PVC 中的大小不生效。
 */
function multiServiceStorageSize(
	value: MultiServiceDesired,
	policy: MultiServiceRuntimePolicyV1,
	resources: MultiServiceResourceConfigurationV1,
) {
	const statefulSet = value.multiService.resources.find(
		(resource) => resource.kind === "StatefulSet",
	);
	const size =
		(statefulSet
			? profileForWorkload(value, statefulSet, resources).storageSize
			: undefined) ?? policy.storageSize;
	if (!size) throw new Error("multi-service storage policy missing");
	return size;
}

function migrationJobName(value: MultiServiceDesired): string {
	return serviceResourceName(
		value.agentId,
		`migration-${fingerprint(value.multiService).slice(0, 12)}`,
	);
}

function migrationResource(value: MultiServiceDesired) {
	return value.multiService.resources.find(
		(resource) => resource.kind === "Job",
	);
}

function jobSucceeded(job: V1Job): boolean {
	return (
		(job.status?.succeeded ?? 0) > 0 ||
		job.status?.conditions?.some(
			(condition) =>
				condition.type === "Complete" && condition.status === "True",
		) === true
	);
}

function jobFailed(job: V1Job): boolean {
	return (
		job.status?.conditions?.some(
			(condition) => condition.type === "Failed" && condition.status === "True",
		) === true
	);
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

function ownedByAgent(resource: KubernetesObject, value: MultiServiceDesired) {
	if (
		resource.metadata?.labels?.[ownerLabel] !==
			workloadResourceNameV1(value.agentId) ||
		resource.metadata?.annotations?.[agentAnnotation] !== value.agentId
	)
		return false;
	const fence = Number(
		resource.metadata?.annotations?.["agent-infra.agora.io/fence"],
	);
	return Number.isSafeInteger(fence) && fence <= value.fence;
}

interface MultiServiceOwnershipOptionsV1 {
	readonly allowOwnershipTransition?: boolean;
}

function deployment(
	value: MultiServiceDesired,
	resource: Extract<
		MultiServiceDesired["multiService"]["resources"][number],
		{ kind: "Deployment" | "StatefulSet" }
	>,
	policy: MultiServiceRuntimePolicyV1,
	resources: MultiServiceResourceConfigurationV1,
): V1Deployment {
	const profile = profileForWorkload(value, resource, resources);
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
	const configMapNames = new Set(
		value.multiService.resources
			.filter((item) => item.kind === "ConfigMap")
			.map((item) => item.metadata.name),
	);
	const volumes = resource.spec.template.spec.volumes?.map((volume) => {
		if (!configMapNames.has(volume.configMap.name))
			throw new Error("Multi-service volume ConfigMap is undeclared");
		return {
			name: volume.name,
			configMap: {
				name: serviceResourceName(value.agentId, volume.configMap.name),
				optional: false,
			},
		};
	});
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
					...(volumes ? { volumes } : {}),
					containers: resource.spec.template.spec.containers.map(
						(container) => ({
							...container,
							image: imageReference(policy, container.image),
							resources: profile.resources,
							ports: container.ports?.map((port) => ({
								name: port.name,
								containerPort: port.targetPort,
							})),
							volumeMounts: container.volumeMounts?.map((mount) => ({
								name: mount.name,
								mountPath: mount.mountPath,
								readOnly: true,
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

function configMap(
	value: MultiServiceDesired,
	resource: Extract<
		MultiServiceDesired["multiService"]["resources"][number],
		{ kind: "ConfigMap" }
	>,
): V1ConfigMap {
	return {
		apiVersion: "v1",
		kind: "ConfigMap",
		metadata: metadata(
			value,
			serviceResourceName(value.agentId, resource.metadata.name),
			resource.metadata.name,
		),
		immutable: true,
		data: { ...resource.spec.data },
	};
}

function statefulSet(
	value: MultiServiceDesired,
	resource: Extract<
		MultiServiceDesired["multiService"]["resources"][number],
		{ kind: "StatefulSet" }
	>,
	policy: MultiServiceRuntimePolicyV1,
	resources: MultiServiceResourceConfigurationV1,
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
	const profile = profileForWorkload(value, resource, resources);
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
							resources: profile.resources,
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
									{ name: "data", persistentVolumeClaim: { claimName } },
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
	resources: MultiServiceResourceConfigurationV1,
): V1PersistentVolumeClaim {
	const storage = multiServiceStorageSize(value, policy, resources);
	return {
		apiVersion: "v1",
		kind: "PersistentVolumeClaim",
		metadata: metadata(
			value,
			serviceResourceName(value.agentId, resource.metadata.name),
		),
		spec: {
			accessModes: ["ReadWriteOnce"],
			...(policy.storageClassName
				? { storageClassName: policy.storageClassName }
				: {}),
			resources: { requests: { storage } },
		},
	};
}

function storageMatchesPolicy(
	current: V1PersistentVolumeClaim,
	value: MultiServiceDesired,
	policy: MultiServiceRuntimePolicyV1,
	resources: MultiServiceResourceConfigurationV1,
) {
	return (
		current.spec?.accessModes?.length === 1 &&
		current.spec.accessModes[0] === "ReadWriteOnce" &&
		current.spec.resources?.requests?.storage ===
			multiServiceStorageSize(value, policy, resources) &&
		(policy.storageClassName === undefined ||
			current.spec.storageClassName === policy.storageClassName)
	);
}

function migrationJob(
	value: MultiServiceDesired,
	resource: Extract<
		MultiServiceDesired["multiService"]["resources"][number],
		{ kind: "Job" }
	>,
	resources: MultiServiceResourceConfigurationV1,
): V1Job {
	const profile = profileForWorkload(value, resource, resources);
	const labels = {
		...resource.spec.template.metadata.labels,
		[ownerLabel]: workloadResourceNameV1(value.agentId),
		"agent-infra.agora.io/service": "migration",
	};
	return {
		apiVersion: "batch/v1",
		kind: "Job",
		metadata: metadata(value, migrationJobName(value), "migration"),
		spec: {
			backoffLimit: resource.spec.backoffLimit,
			activeDeadlineSeconds: resource.spec.activeDeadlineSeconds,
			template: {
				metadata: { labels },
				spec: {
					...resource.spec.template.spec,
					restartPolicy: "Never",
					serviceAccountName: workloadResourceNameV1(value.agentId),
					automountServiceAccountToken: false,
					containers: resource.spec.template.spec.containers.map(
						(container) => ({
							...container,
							resources: profile.resources,
							ports: container.ports?.map((port) => ({
								name: port.name,
								containerPort: port.targetPort,
							})),
						}),
					),
				},
			},
		},
	};
}

function migrationNetworkPolicy(value: MultiServiceDesired): V1NetworkPolicy {
	const name = migrationJobName(value);
	return {
		apiVersion: "networking.k8s.io/v1",
		kind: "NetworkPolicy",
		metadata: metadata(value, `${name}-network`, "migration"),
		spec: {
			podSelector: {
				matchLabels: {
					[ownerLabel]: workloadResourceNameV1(value.agentId),
					"agent-infra.agora.io/service": "migration",
				},
			},
			policyTypes: ["Ingress"],
			ingress: [],
		},
	};
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
	const resources = resolveMultiServiceResourceConfigurationV1(options.policy);
	const resourceName = (value: MultiServiceDesired, name: string) =>
		serviceResourceName(value.agentId, name);
	const manifestPvc = (value: MultiServiceDesired, name: string) =>
		value.multiService.resources.find(
			(resource) =>
				resource.kind === "PersistentVolumeClaim" &&
				resourceName(value, resource.metadata.name) === name,
		);
	async function put<T extends KubernetesObject>(
		object: T,
		value: MultiServiceDesired,
		ownership: MultiServiceOwnershipOptionsV1 = {},
	) {
		const current = await client.read<T>(
			object.kind as never,
			object.metadata?.name ?? "",
		);
		if (!current) return client.create(object);
		const transitioned =
			ownership.allowOwnershipTransition === true &&
			ownedByAgent(current, value);
		if (!owned(current, value) && !transitioned)
			throw new Error("multi-service resource drifted");
		if (object.kind === "ConfigMap") {
			if (
				(current as V1ConfigMap).immutable !== true ||
				!isDeepStrictEqual(
					(current as V1ConfigMap).data ?? {},
					(object as V1ConfigMap).data ?? {},
				)
			) {
				if (!transitioned)
					throw new Error("multi-service ConfigMap is immutable and drifted");
				await client.delete(current);
				return client.create(object);
			}
			return current;
		}
		if (object.kind === "Job") return current;
		if (current.kind === "PersistentVolumeClaim") {
			const currentPvc = current as unknown as V1PersistentVolumeClaim;
			if (
				!manifestPvc(value, current.metadata?.name ?? "") ||
				!storageMatchesPolicy(currentPvc, value, options.policy, resources)
			)
				throw new Error("multi-service PVC drifted");
		}
		const currentPvc =
			current.kind === "PersistentVolumeClaim"
				? (current as unknown as V1PersistentVolumeClaim)
				: undefined;
		if (current.metadata?.resourceVersion && current.metadata.uid)
			return client.replace({
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
			});
		return current;
	}
	async function remove(
		kind:
			| "Deployment"
			| "StatefulSet"
			| "Service"
			| "ConfigMap"
			| "Job"
			| "ServiceAccount"
			| "NetworkPolicy"
			| "Ingress"
			| "PersistentVolumeClaim",
		name: string,
		value: MultiServiceDesired,
		ownership: MultiServiceOwnershipOptionsV1 = {},
	) {
		const current = await client.read(kind, name);
		if (!current) return true;
		if (
			!owned(current, value) &&
			!(
				ownership.allowOwnershipTransition === true &&
				ownedByAgent(current, value)
			)
		)
			throw new Error("multi-service resource drifted");
		await client.delete(current);
		return (await client.read(kind, name)) === null;
	}
	async function cleanupMigration(
		value: MultiServiceDesired,
		ownership: MultiServiceOwnershipOptionsV1 = {},
	) {
		let complete = await remove(
			"NetworkPolicy",
			`${migrationJobName(value)}-network`,
			value,
			ownership,
		);
		complete =
			(await remove("Job", migrationJobName(value), value, ownership)) &&
			complete;
		return complete;
	}
	async function pruneStaleResources(
		value: MultiServiceDesired,
		ownership: MultiServiceOwnershipOptionsV1,
	) {
		if (!ownership.allowOwnershipTransition) return;
		const desiredNames = new Map<string, Set<string>>();
		const add = (kind: string, name: string) => {
			const names = desiredNames.get(kind) ?? new Set<string>();
			names.add(name);
			desiredNames.set(kind, names);
		};
		add("ServiceAccount", workloadResourceNameV1(value.agentId));
		add("Ingress", workloadResourceNameV1(value.agentId));
		for (const resource of value.multiService.resources) {
			if (
				resource.kind === "Deployment" ||
				resource.kind === "StatefulSet" ||
				resource.kind === "Service" ||
				resource.kind === "ConfigMap" ||
				resource.kind === "PersistentVolumeClaim"
			)
				add(resource.kind, resourceName(value, resource.metadata.name));
			if (resource.kind === "Job") {
				add("Job", migrationJobName(value));
				add("NetworkPolicy", `${migrationJobName(value)}-network`);
			}
			if (resource.kind === "Deployment" || resource.kind === "StatefulSet")
				add(
					"NetworkPolicy",
					`${resourceName(value, resource.metadata.name)}-network`,
				);
		}
		const kinds = [
			"Deployment",
			"StatefulSet",
			"Service",
			"ConfigMap",
			"Job",
			"ServiceAccount",
			"NetworkPolicy",
			"Ingress",
		] as const;
		for (const kind of kinds) {
			const current = await client.list(
				kind,
				`${ownerLabel}=${workloadResourceNameV1(value.agentId)}`,
			);
			for (const resource of current) {
				const name = resource.metadata?.name;
				if (
					!name ||
					desiredNames.get(kind)?.has(name) ||
					!ownedByAgent(resource, value)
				)
					continue;
				await client.delete(resource);
			}
		}
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
		async apply(
			value: MultiServiceDesired,
			ownership: MultiServiceOwnershipOptionsV1 = {},
		) {
			// 总量上限必须在任何 Kubernetes 写入（含清理旧版本资源）之前校验，
			// 被拒绝的 Agent 不能留下半安装或被部分清理的多服务资源。
			validateMultiServiceResourceCapacityV1(value, resources);
			await pruneStaleResources(value, ownership);
			await put(serviceAccount(value), value, ownership);
			const migration = migrationResource(value);
			if (migration?.kind === "Job") {
				await put(migrationNetworkPolicy(value), value, ownership);
				const job = await put(
					migrationJob(value, migration, resources),
					value,
					ownership,
				);
				if (!jobSucceeded(job as V1Job))
					return {
						uid: workloadResourceNameV1(value.agentId),
						generation: value.workloadRevision,
					};
			}
			for (const resource of value.multiService.resources) {
				if (resource.kind === "PersistentVolumeClaim")
					await put(
						persistentVolumeClaim(value, resource, options.policy, resources),
						value,
						ownership,
					);
			}
			for (const resource of value.multiService.resources) {
				if (resource.kind === "ConfigMap")
					await put(configMap(value, resource), value, ownership);
			}
			for (const resource of value.multiService.resources) {
				if (resource.kind === "Deployment")
					await put(
						deployment(value, resource, options.policy, resources),
						value,
						ownership,
					);
				if (resource.kind === "StatefulSet") {
					const pvc = value.multiService.resources.find(
						(candidate) => candidate.kind === "PersistentVolumeClaim",
					);
					await put(
						statefulSet(
							value,
							resource,
							options.policy,
							resources,
							pvc
								? persistentVolumeClaim(value, pvc, options.policy, resources)
								: undefined,
						),
						value,
						ownership,
					);
				}
				if (resource.kind === "Service")
					await put(service(value, resource), value, ownership);
			}
			for (const resource of value.multiService.resources) {
				if (resource.kind === "Deployment" || resource.kind === "StatefulSet")
					await put(
						networkPolicy(value, resource, options.policy),
						value,
						ownership,
					);
			}
			return {
				uid: workloadResourceNameV1(value.agentId),
				generation: value.workloadRevision,
			};
		},
		async observe(
			value: MultiServiceDesired,
			_identity: { uid: string; generation: number },
		) {
			const migration = migrationResource(value);
			if (migration?.kind === "Job") {
				const job = await client.read<V1Job>("Job", migrationJobName(value));
				if (!job) return "unreachable" as const;
				if (jobFailed(job)) return "unhealthy" as const;
				if (!jobSucceeded(job)) return "unreachable" as const;
			}
			for (const resource of value.multiService.resources) {
				if (resource.kind !== "Deployment" && resource.kind !== "StatefulSet")
					continue;
				const current = await client.read<V1Deployment | V1StatefulSet>(
					resource.kind,
					serviceResourceName(value.agentId, resource.metadata.name),
				);
				if (!current || !owned(current, value)) return "drifted" as const;
				if (
					(resource.kind === "Deployment"
						? (current.status?.availableReplicas ?? 0)
						: (current.status?.readyReplicas ?? 0)) < 1
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
					!storageMatchesPolicy(current, value, options.policy, resources)
				)
					return "unhealthy" as const;
			}
			return "healthy" as const;
		},
		async promote(value: MultiServiceDesired) {
			await put(ingress(value, options.policy), value);
		},
		async closeRoute(
			value: MultiServiceDesired,
			ownership: MultiServiceOwnershipOptionsV1 = {},
		) {
			return remove(
				"Ingress",
				workloadResourceNameV1(value.agentId),
				value,
				ownership,
			);
		},
		scaleDown,
		async cleanupAgent(
			value: MultiServiceDesired,
			deleteVolume = false,
			ownership: MultiServiceOwnershipOptionsV1 = {},
		) {
			let complete = await remove(
				"Ingress",
				workloadResourceNameV1(value.agentId),
				value,
				ownership,
			);
			complete = (await cleanupMigration(value, ownership)) && complete;
			for (const resource of value.multiService.resources) {
				if (resource.kind === "ConfigMap")
					complete =
						(await remove(
							"ConfigMap",
							serviceResourceName(value.agentId, resource.metadata.name),
							value,
							ownership,
						)) && complete;
				if (resource.kind === "Deployment" || resource.kind === "StatefulSet") {
					complete =
						(await remove(
							"NetworkPolicy",
							`${serviceResourceName(value.agentId, resource.metadata.name)}-network`,
							value,
							ownership,
						)) && complete;
					complete =
						(await remove(
							resource.kind,
							serviceResourceName(value.agentId, resource.metadata.name),
							value,
							ownership,
						)) && complete;
				}
				if (resource.kind === "Service")
					complete =
						(await remove(
							"Service",
							serviceResourceName(value.agentId, resource.metadata.name),
							value,
							ownership,
						)) && complete;
				if (resource.kind === "PersistentVolumeClaim" && deleteVolume)
					complete =
						(await remove(
							"PersistentVolumeClaim",
							resourceName(value, resource.metadata.name),
							value,
							ownership,
						)) && complete;
			}
			complete =
				(await remove(
					"ServiceAccount",
					workloadResourceNameV1(value.agentId),
					value,
					ownership,
				)) && complete;
			return complete;
		},
		cleanupMigration,
	};
}
