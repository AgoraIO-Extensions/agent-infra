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
import { WorkloadPreflightRejectedErrorV1 } from "@agent-infra/platform-core";
import type {
	KubernetesObject,
	V1ConfigMap,
	V1Container,
	V1Deployment,
	V1Endpoints,
	V1Ingress,
	V1Job,
	V1NetworkPolicy,
	V1PersistentVolumeClaim,
	V1Pod,
	V1PodSpec,
	V1ReplicaSet,
	V1Secret,
	V1Service,
	V1ServiceAccount,
	V1StatefulSet,
} from "@kubernetes/client-node";
import {
	type WorkerKubernetesClientV1,
	WorkloadKubernetesError,
} from "./kubernetes-client.js";
import {
	agentAnnotation,
	agentContainerSecurityContext,
	agentPodSecurityContext,
	desiredAnnotation,
	fingerprintAnnotation,
	hasSameStructure,
	matchesNetworkPolicySpec,
	ownerLabel,
	revisionLabel,
	secretConfigRevisionAnnotation,
	secretFenceAnnotation,
	secretIdAnnotation,
	secretUidAnnotation,
	secretVersionAnnotation,
	workloadImagePullSpecV1,
	workloadResourceNameV1,
} from "./kubernetes-runtime-comparison.js";
import {
	hasAdditionalEgressPolicyV1,
	requireWorkspaceSnapshotEgressV1,
	type WorkloadEgressPolicyV1,
	workloadEgressRulesV1,
} from "./workload-network.js";
import {
	applyWorkspaceSnapshotProjectionV1,
	type WorkspaceSnapshotPodProjectionV1,
	workspaceSnapshotPodSpecMatchesV1,
} from "./workspace-snapshot-materializer.js";
import {
	type WorkspaceSnapshotObservationCallbackV1,
	workspaceSnapshotPodObservationV1,
} from "./workspace-snapshot-observation.js";
import { writeWorkspaceSnapshotSecretV1 } from "./workspace-snapshot-secret.js";

export type MultiServiceDesired = AgentWorkloadDesiredV1 & {
	multiService: NonNullable<AgentWorkloadDesiredV1["multiService"]>;
};

const memberIdentityAnnotation = "agent-infra.agora.io/multi-service-members";

export interface MultiServiceRuntimePolicyV1 {
	readonly namespace: string;
	readonly imageRepository?: string;
	readonly imagePullSecretName?: string;
	readonly storageSize?: string;
	readonly storageClassName?: string;
	readonly routeHostSuffix: string;
	readonly ingressClassName: string;
	readonly tlsSecretName: string;
	/** Optional namespace of the ingress controller; omitted keeps same-namespace behavior. */
	readonly routeNamespace?: string;
	readonly routeSelector: Readonly<Record<string, string>>;
	/** 必须与 API `apiInput` 中的同名配置一致；省略时使用合约默认值。 */
	readonly multiServiceResourceProfiles?: readonly MultiServiceResourceProfileV1[];
	readonly multiServiceResourceCap?: MultiServiceResourceCapV1;
	readonly workspaceSnapshotProjection?: WorkspaceSnapshotPodProjectionV1;
	readonly workspaceSnapshotEgress?: WorkloadEgressPolicyV1["workspaceSnapshotEgress"];
	readonly modelEgress?: WorkloadEgressPolicyV1["modelEgress"];
	readonly connectionEgress?: WorkloadEgressPolicyV1["connectionEgress"];
	readonly nativeMetadataWorkerEgress?: WorkloadEgressPolicyV1["nativeMetadataWorkerEgress"];
	readonly fileExchangeEgress?: WorkloadEgressPolicyV1["fileExchangeEgress"];
	readonly dnsEgress?: WorkloadEgressPolicyV1["dnsEgress"];
}

function applyWorkspaceSnapshotToPodSpecV1(
	spec: V1PodSpec,
	policy: MultiServiceRuntimePolicyV1,
	enabled: boolean,
): V1PodSpec {
	return enabled && policy.workspaceSnapshotProjection
		? applyWorkspaceSnapshotProjectionV1(
				spec,
				policy.workspaceSnapshotProjection,
			)
		: spec;
}

export type MultiServiceHealthDiagnosticV1 = {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly workloadRevision: number;
	readonly stage:
		| "healthy"
		| "migration_missing"
		| "migration_pending"
		| "migration_failed"
		| "workload_not_ready"
		| "service_no_endpoints"
		| "workload_drifted"
		| "health_check_failed";
	readonly workloads: readonly {
		readonly kind: "Deployment" | "StatefulSet";
		readonly name: string;
		readonly desiredReplicas: number;
		readonly readyReplicas: number | null;
		readonly availableReplicas: number | null;
	}[];
	readonly services: readonly {
		readonly name: string;
		readonly ports: number | null;
		readonly endpointAddresses: number | null;
	}[];
};

/** 启动期解析部署档位与上限；非法配置使 Worker 装配失败（fail closed）。 */
export function resolveMultiServiceResourceConfigurationV1(
	policy: MultiServiceRuntimePolicyV1,
): MultiServiceResourceConfigurationV1 {
	try {
		workloadImagePullSpecV1(policy.imagePullSecretName);
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

function entryWorkloadResource(value: MultiServiceDesired) {
	const service = value.multiService.resources.find(
		(resource) =>
			resource.kind === "Service" &&
			resource.metadata.name === value.multiService.entryServiceName,
	);
	if (service?.kind !== "Service")
		throw new Error("multi-service entry is unavailable");
	const matches = value.multiService.resources.filter(
		(resource) =>
			(resource.kind === "Deployment" || resource.kind === "StatefulSet") &&
			Object.entries(service.spec.selector).every(
				([key, expected]) =>
					resource.spec.template.metadata.labels[key] === expected,
			),
	);
	const resource = matches[0];
	if (
		matches.length !== 1 ||
		!resource ||
		(resource.kind !== "Deployment" && resource.kind !== "StatefulSet")
	)
		throw new Error("multi-service entry is ambiguous");
	return resource;
}

function configuredEnvironment(
	value: MultiServiceDesired,
	declared: V1Container["env"],
) {
	return [
		...(declared ?? []).filter(({ name }) => !Object.hasOwn(value.env, name)),
		...Object.entries(value.env).map(([name, value]) => ({ name, value })),
	].filter(({ name }) => name !== "AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_OWNER");
}

function environmentSecrets(value: MultiServiceDesired) {
	return value.secretRefs.map((ref) => ({
		secretRef: { name: ref.name, optional: false },
	}));
}

function matchesEnvironmentSecrets(
	value: MultiServiceDesired,
	spec: V1PodSpec | undefined,
) {
	const expected = environmentSecrets(value);
	return (spec?.containers ?? []).every((container) =>
		// Kubernetes SDK instances must compare by their wire values.
		isDeepStrictEqual(
			JSON.parse(JSON.stringify(container.envFrom ?? [])),
			expected,
		),
	);
}

function referencesSecret(spec: V1PodSpec | undefined, secretName: string) {
	return [...(spec?.initContainers ?? []), ...(spec?.containers ?? [])].some(
		(container) =>
			container.envFrom?.some(
				(entry) => entry.secretRef?.name === secretName,
			) ?? false,
	);
}

function memberResources(value: MultiServiceDesired) {
	return value.multiService.resources.filter(
		(resource) =>
			resource.kind === "Deployment" || resource.kind === "StatefulSet",
	);
}

function snapshotMemberResources(
	value: MultiServiceDesired,
	entryName: string,
) {
	return memberResources(value).filter(
		(resource) => resource.metadata.name !== entryName,
	);
}

type MemberIdentitySnapshot = Record<
	string,
	{ readonly uid: string; readonly generation: number }
>;
function serializeMemberSnapshot(identities: MemberIdentitySnapshot) {
	return JSON.stringify(
		Object.fromEntries(
			Object.entries(identities).sort(([left], [right]) =>
				left.localeCompare(right),
			),
		),
	);
}
function parseMemberSnapshot(value: unknown): MemberIdentitySnapshot | null {
	if (typeof value !== "string") return null;
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		if (!parsed || Array.isArray(parsed)) return null;
		const result: MemberIdentitySnapshot = {};
		for (const [name, item] of Object.entries(parsed)) {
			if (!item || typeof item !== "object" || Array.isArray(item)) return null;
			const { uid, generation } = item as Record<string, unknown>;
			if (
				typeof uid !== "string" ||
				!uid ||
				!Number.isSafeInteger(generation) ||
				(generation as number) < 1
			)
				return null;
			result[name] = { uid, generation: generation as number };
		}
		return result;
	} catch {
		return null;
	}
}

function memberSelector(
	value: MultiServiceDesired,
	member: MultiServiceDesired["multiService"]["resources"][number],
) {
	if (member.kind !== "Deployment" && member.kind !== "StatefulSet")
		return undefined;
	const service = value.multiService.resources.find(
		(resource) =>
			resource.kind === "Service" &&
			Object.entries(resource.spec.selector).every(
				([key, expected]) =>
					member.spec.template.metadata.labels[key] === expected,
			),
	);
	return service?.kind === "Service"
		? Object.entries(service.spec.selector)
				.map(([key, expected]) => `${key}=${expected}`)
				.join(",")
		: undefined;
}

function routePeer(policy: MultiServiceRuntimePolicyV1) {
	const podSelector = { podSelector: { matchLabels: policy.routeSelector } };
	return policy.routeNamespace
		? {
				...podSelector,
				namespaceSelector: {
					matchLabels: {
						"kubernetes.io/metadata.name": policy.routeNamespace,
					},
				},
			}
		: podSelector;
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

type MultiServicePvcResource = Extract<
	MultiServiceDesired["multiService"]["resources"][number],
	{ kind: "PersistentVolumeClaim" }
>;

/**
 * 每个 PVC 归属名为 `<StatefulSet>-data` 的 StatefulSet（API 拓扑准入保证）。PVC 大小取
 * 该 StatefulSet 档位的 storageSize，档位未声明时沿用部署的全局 storageSize；用户 PVC
 * 中的大小不生效。
 */
function multiServiceStorageSize(
	value: MultiServiceDesired,
	pvc: MultiServicePvcResource,
	policy: MultiServiceRuntimePolicyV1,
	resources: MultiServiceResourceConfigurationV1,
) {
	const statefulSet = value.multiService.resources.find(
		(
			resource,
		): resource is Extract<
			MultiServiceDesired["multiService"]["resources"][number],
			{ kind: "StatefulSet" }
		> =>
			resource.kind === "StatefulSet" &&
			`${resource.metadata.name}-data` === pvc.metadata.name,
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

// Compare only after applying known API defaults; unknown or nondefault fields still drift.
function defaultImagePullPolicy(image?: string) {
	if (image?.includes("@")) return "IfNotPresent";
	const reference = image?.slice(image.lastIndexOf("/") + 1) ?? "";
	const tagIndex = reference.lastIndexOf(":");
	const tag = tagIndex >= 0 ? reference.slice(tagIndex + 1) : undefined;
	return tag === undefined || tag === "latest" ? "Always" : "IfNotPresent";
}

function normalizedWorkloadSpec(workload: V1Deployment | V1StatefulSet) {
	const spec = workload.spec;
	if (!spec?.template.spec) return spec;
	const pod = spec.template.spec;
	const probe = (value: V1Container["readinessProbe"]) =>
		value && {
			initialDelaySeconds: 0,
			timeoutSeconds: 1,
			periodSeconds: 10,
			successThreshold: 1,
			failureThreshold: 3,
			...value,
			...(value.httpGet
				? { httpGet: { path: "/", scheme: "HTTP", ...value.httpGet } }
				: {}),
		};
	const container = (value: V1Container) => ({
		imagePullPolicy: defaultImagePullPolicy(value.image),
		terminationMessagePath: "/dev/termination-log",
		terminationMessagePolicy: "File",
		...value,
		envFrom: value.envFrom ?? [],
		ports: (value.ports ?? []).map((port) => ({ protocol: "TCP", ...port })),
		readinessProbe: probe(value.readinessProbe),
		livenessProbe: probe(value.livenessProbe),
		startupProbe: probe(value.startupProbe),
	});
	const defaults =
		workload.kind === "Deployment"
			? {
					progressDeadlineSeconds: 600,
					strategy: { type: "RollingUpdate" },
				}
			: {
					podManagementPolicy: "OrderedReady",
					updateStrategy: { type: "RollingUpdate" },
					ordinals: { start: 0 },
				};
	const normalized = {
		replicas: 1,
		revisionHistoryLimit: 10,
		...defaults,
		...spec,
		template: {
			...spec.template,
			spec: {
				dnsPolicy: "ClusterFirst",
				restartPolicy: "Always",
				schedulerName: "default-scheduler",
				terminationGracePeriodSeconds: 30,
				...pod,
				// API servers mirror serviceAccountName into the deprecated alias.
				serviceAccount: pod.serviceAccount ?? pod.serviceAccountName,
				containers: pod.containers.map(container),
				initContainers: (pod.initContainers ?? []).map(container),
				volumes: (pod.volumes ?? []).map((volume) => ({
					...volume,
					...(volume.configMap
						? { configMap: { defaultMode: 420, ...volume.configMap } }
						: {}),
					...(volume.secret
						? { secret: { defaultMode: 420, ...volume.secret } }
						: {}),
					...(volume.projected
						? { projected: { defaultMode: 420, ...volume.projected } }
						: {}),
					...(volume.downwardAPI
						? { downwardAPI: { defaultMode: 420, ...volume.downwardAPI } }
						: {}),
				})),
			},
		},
	};
	if (workload.kind === "Deployment") {
		const strategy = (spec as V1Deployment["spec"])?.strategy;
		Object.assign(normalized, {
			strategy: {
				type: "RollingUpdate",
				...strategy,
				...((strategy?.type ?? "RollingUpdate") === "RollingUpdate"
					? {
							rollingUpdate: {
								maxSurge: "25%",
								maxUnavailable: "25%",
								...strategy?.rollingUpdate,
							},
						}
					: {}),
			},
		});
	} else {
		const strategy = (spec as V1StatefulSet["spec"])?.updateStrategy;
		Object.assign(normalized, {
			updateStrategy: {
				type: "RollingUpdate",
				...strategy,
				...((strategy?.type ?? "RollingUpdate") === "RollingUpdate"
					? { rollingUpdate: { partition: 0, ...strategy?.rollingUpdate } }
					: {}),
			},
		});
	}
	// The client deserializes omitted optional fields as undefined.
	return JSON.parse(JSON.stringify(normalized)) as unknown;
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
	const result: V1Deployment = {
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
					...workloadImagePullSpecV1(policy.imagePullSecretName),
					securityContext: agentPodSecurityContext(),
					...(volumes ? { volumes } : {}),
					containers: resource.spec.template.spec.containers.map(
						(container) => ({
							...container,
							env: configuredEnvironment(value, container.env),
							envFrom: environmentSecrets(value),
							image: imageReference(policy, container.image),
							resources: profile.resources,
							securityContext: agentContainerSecurityContext(),
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
	const resultSpec = result.spec;
	const podSpec = resultSpec?.template?.spec;
	if (!resultSpec || !podSpec)
		throw new Error("multi-service pod spec missing");
	resultSpec.template.spec = applyWorkspaceSnapshotToPodSpecV1(
		podSpec,
		policy,
		Boolean(value.workspaceSnapshots?.length),
	);
	return result;
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
	// 传入的是 persistentVolumeClaim() 构造好的对象，名字已经带 Agent 前缀并按 63 个字符截断，
	// 不能再加一次前缀，否则 Pod 会引用一个不存在的 PVC 而永远 Pending。
	const claimName = persistentVolumeClaim?.metadata?.name;
	const volumeMount = claimName
		? { name: "data", mountPath: "/data" }
		: undefined;
	const profile = profileForWorkload(value, resource, resources);
	const podSpecWithVolumes = resource.spec.template
		.spec as typeof resource.spec.template.spec & Pick<V1PodSpec, "volumes">;
	const result: V1StatefulSet = {
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
					...workloadImagePullSpecV1(policy.imagePullSecretName),
					securityContext: agentPodSecurityContext(),
					containers: resource.spec.template.spec.containers.map(
						(container) => ({
							...container,
							env: configuredEnvironment(value, container.env),
							envFrom: environmentSecrets(value),
							image: imageReference(policy, container.image),
							resources: profile.resources,
							securityContext: agentContainerSecurityContext(),
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
	const resultSpec = result.spec;
	const podSpec = resultSpec?.template?.spec;
	if (!resultSpec || !podSpec)
		throw new Error("multi-service pod spec missing");
	resultSpec.template.spec = applyWorkspaceSnapshotToPodSpecV1(
		podSpec,
		policy,
		Boolean(value.workspaceSnapshots?.length),
	);
	return result;
}

function persistentVolumeClaim(
	value: MultiServiceDesired,
	resource: MultiServicePvcResource,
	policy: MultiServiceRuntimePolicyV1,
	resources: MultiServiceResourceConfigurationV1,
): V1PersistentVolumeClaim {
	const storage = multiServiceStorageSize(value, resource, policy, resources);
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
	pvc: MultiServicePvcResource,
	policy: MultiServiceRuntimePolicyV1,
	resources: MultiServiceResourceConfigurationV1,
) {
	return (
		current.spec?.accessModes?.length === 1 &&
		current.spec.accessModes[0] === "ReadWriteOnce" &&
		current.spec.resources?.requests?.storage ===
			multiServiceStorageSize(value, pvc, policy, resources) &&
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
	policy: MultiServiceRuntimePolicyV1,
): V1Job {
	const profile = profileForWorkload(value, resource, resources);
	const labels = {
		...resource.spec.template.metadata.labels,
		[ownerLabel]: workloadResourceNameV1(value.agentId),
		"agent-infra.agora.io/service": "migration",
	};
	const result: V1Job = {
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
					...workloadImagePullSpecV1(policy.imagePullSecretName),
					securityContext: agentPodSecurityContext(),
					restartPolicy: "Never",
					serviceAccountName: workloadResourceNameV1(value.agentId),
					automountServiceAccountToken: false,
					containers: resource.spec.template.spec.containers.map(
						(container) => ({
							...container,
							env: configuredEnvironment(value, container.env),
							envFrom: environmentSecrets(value),
							image: imageReference(policy, container.image),
							resources: profile.resources,
							securityContext: agentContainerSecurityContext(),
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
	const resultSpec = result.spec;
	const podSpec = resultSpec?.template?.spec;
	if (!resultSpec || !podSpec)
		throw new Error("multi-service pod spec missing");
	resultSpec.template.spec = applyWorkspaceSnapshotToPodSpecV1(
		podSpec,
		policy,
		Boolean(value.workspaceSnapshots?.length),
	);
	return result;
}

function migrationNetworkPolicy(
	value: MultiServiceDesired,
	policy?: MultiServiceRuntimePolicyV1,
): V1NetworkPolicy {
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
			...(value.workspaceSnapshots?.length &&
			policy?.workspaceSnapshotProjection &&
			policy.workspaceSnapshotEgress
				? { policyTypes: ["Ingress", "Egress"] as const }
				: { policyTypes: ["Ingress"] as const }),
			ingress: [],
			...(value.workspaceSnapshots?.length &&
			policy?.workspaceSnapshotProjection &&
			policy.workspaceSnapshotEgress
				? {
						egress: [
							...workloadEgressRulesV1({
								modelEgress: policy.modelEgress,
								connectionEgress: policy.connectionEgress,
								nativeMetadataWorkerEgress: policy.nativeMetadataWorkerEgress,
								fileExchangeEgress: policy.fileExchangeEgress,
								workspaceSnapshotEgress: policy.workspaceSnapshotEgress,
								dnsEgress: policy.dnsEgress,
							}),
							{
								to: [
									{
										podSelector: {
											matchLabels: {
												[ownerLabel]: workloadResourceNameV1(value.agentId),
											},
										},
									},
								],
							},
						],
					}
				: {}),
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
			...(value.workspaceSnapshots?.length &&
			policy.workspaceSnapshotProjection &&
			policy.workspaceSnapshotEgress
				? { policyTypes: ["Ingress", "Egress"] as const }
				: { policyTypes: ["Ingress"] as const }),
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
						...(entry ? [routePeer(policy)] : []),
					],
				},
			],
			...(value.workspaceSnapshots?.length &&
			policy.workspaceSnapshotProjection &&
			policy.workspaceSnapshotEgress
				? {
						egress: [
							...workloadEgressRulesV1({
								modelEgress: policy.modelEgress,
								connectionEgress: policy.connectionEgress,
								nativeMetadataWorkerEgress: policy.nativeMetadataWorkerEgress,
								fileExchangeEgress: policy.fileExchangeEgress,
								workspaceSnapshotEgress: policy.workspaceSnapshotEgress,
								dnsEgress: policy.dnsEgress,
							}),
							{
								to: [
									{
										podSelector: {
											matchLabels: {
												[ownerLabel]: workloadResourceNameV1(value.agentId),
											},
										},
									},
								],
							},
						],
					}
				: {}),
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
	readonly onHealthDiagnostic?: (
		diagnostic: MultiServiceHealthDiagnosticV1,
	) => void;
	readonly onWorkspaceSnapshot?: WorkspaceSnapshotObservationCallbackV1;
}) {
	const { client } = options;
	workloadEgressRulesV1(options.policy);
	if (options.policy.workspaceSnapshotProjection)
		requireWorkspaceSnapshotEgressV1(options.policy.workspaceSnapshotEgress);
	const resources = resolveMultiServiceResourceConfigurationV1(options.policy);
	type WorkloadIdentity = { uid: string; generation: number };
	const imagePullSecrets =
		workloadImagePullSpecV1(options.policy.imagePullSecretName)
			.imagePullSecrets ?? [];
	const matchesImagePullSecrets = (spec: V1PodSpec | undefined) =>
		!!spec && hasSameStructure(spec.imagePullSecrets ?? [], imagePullSecrets);
	const resourceName = (value: MultiServiceDesired, name: string) =>
		serviceResourceName(value.agentId, name);
	async function observeSnapshotPods(
		value: MultiServiceDesired,
		controller: V1Deployment | V1StatefulSet | V1Job,
	): Promise<"healthy" | "pending" | "unhealthy" | "drifted"> {
		const projection = options.policy.workspaceSnapshotProjection;
		if (!projection) return "healthy";
		if (
			!controller.metadata?.uid ||
			!workspaceSnapshotPodSpecMatchesV1(
				controller.spec?.template.spec,
				projection,
			)
		)
			return "drifted";
		const expectedLabels = controller.spec?.template.metadata?.labels ?? {};
		const pods = (
			await client.list<V1Pod>(
				"Pod",
				`${ownerLabel}=${workloadResourceNameV1(value.agentId)}`,
			)
		).filter(
			(pod) =>
				!pod.metadata?.deletionTimestamp &&
				Object.entries(expectedLabels).every(
					([key, expected]) => pod.metadata?.labels?.[key] === expected,
				),
		);
		if (!pods.length) return "pending";
		let pending = false;
		for (const pod of pods) {
			const owners =
				pod.metadata?.ownerReferences?.filter(
					(owner) => owner.controller === true,
				) ?? [];
			const owner = owners[0];
			if (
				pod.metadata?.namespace !== client.namespace ||
				!pod.metadata?.uid ||
				owners.length !== 1 ||
				!owner
			)
				return "drifted";
			if (controller.kind === "Deployment") {
				if (owner.apiVersion !== "apps/v1" || owner.kind !== "ReplicaSet")
					return "drifted";
				const replicaSet = await client.read<V1ReplicaSet>(
					"ReplicaSet",
					owner.name,
				);
				const parents =
					replicaSet?.metadata?.ownerReferences?.filter(
						(parent) => parent.controller === true,
					) ?? [];
				if (
					replicaSet?.metadata?.namespace !== client.namespace ||
					replicaSet.metadata.uid !== owner.uid ||
					replicaSet.metadata.deletionTimestamp ||
					parents.length !== 1 ||
					parents[0]?.apiVersion !== "apps/v1" ||
					parents[0]?.kind !== "Deployment" ||
					parents[0]?.name !== controller.metadata.name ||
					parents[0]?.uid !== controller.metadata.uid
				)
					return "drifted";
			} else if (
				owner.apiVersion !== controller.apiVersion ||
				owner.kind !== controller.kind ||
				owner.name !== controller.metadata.name ||
				owner.uid !== controller.metadata.uid
			)
				return "drifted";
			if (!workspaceSnapshotPodSpecMatchesV1(pod.spec, projection))
				return "drifted";
			const observation = workspaceSnapshotPodObservationV1(pod, projection);
			if (observation) {
				try {
					options.onWorkspaceSnapshot?.({
						...observation,
						agentId: value.agentId,
					});
				} catch {
					// Telemetry never changes workload readiness.
				}
			}
			if (observation?.outcome === "failed") return "unhealthy";
			if (observation?.outcome !== "completed") pending = true;
		}
		return pending ? "pending" : "healthy";
	}
	const manifestPvc = (value: MultiServiceDesired, name: string) =>
		value.multiService.resources.find(
			(resource): resource is MultiServicePvcResource =>
				resource.kind === "PersistentVolumeClaim" &&
				resourceName(value, resource.metadata.name) === name,
		);
	const sameWorkloadShape = (
		current: KubernetesObject,
		desired: KubernetesObject,
	) =>
		isDeepStrictEqual(
			current.kind === "Deployment" || current.kind === "StatefulSet"
				? normalizedWorkloadSpec(current as V1Deployment | V1StatefulSet)
				: (current as KubernetesObject & { spec?: unknown }).spec,
			desired.kind === "Deployment" || desired.kind === "StatefulSet"
				? normalizedWorkloadSpec(desired as V1Deployment | V1StatefulSet)
				: (desired as KubernetesObject & { spec?: unknown }).spec,
		) &&
		Object.entries(desired.metadata?.labels ?? {}).every(
			([key, expected]) => current.metadata?.labels?.[key] === expected,
		) &&
		Object.entries(desired.metadata?.annotations ?? {}).every(
			([key, expected]) => current.metadata?.annotations?.[key] === expected,
		);
	async function replaceWorkloadWithConflictRetry<T extends KubernetesObject>(
		desired: T,
		current: T,
		value: MultiServiceDesired,
	) {
		let live = current;
		for (let attempt = 0; attempt < 3; attempt++) {
			if (sameWorkloadShape(live, desired)) return live;
			try {
				return await client.replace({
					...desired,
					metadata: {
						...desired.metadata,
						uid: live.metadata?.uid,
						resourceVersion: live.metadata?.resourceVersion,
					},
				});
			} catch (error) {
				if (
					!(error instanceof WorkloadKubernetesError) ||
					error.code !== "conflict" ||
					attempt === 2
				)
					throw error;
				const refreshed = await client.read<T>(
					desired.kind as never,
					desired.metadata?.name ?? "",
				);
				if (!refreshed || !owned(refreshed, value)) throw error;
				live = refreshed;
			}
		}
		throw new Error("multi-service conflict retry exhausted");
	}
	async function emitHealthDiagnostic(
		value: MultiServiceDesired,
		stage: MultiServiceHealthDiagnosticV1["stage"],
	) {
		if (!options.onHealthDiagnostic) return;
		try {
			const workloads: Array<
				MultiServiceHealthDiagnosticV1["workloads"][number]
			> = [];
			const services: Array<
				MultiServiceHealthDiagnosticV1["services"][number]
			> = [];
			for (const resource of value.multiService.resources.slice(0, 64)) {
				if (resource.kind === "Deployment" || resource.kind === "StatefulSet") {
					const name = resourceName(value, resource.metadata.name);
					const current = await client
						.read<V1Deployment | V1StatefulSet>(resource.kind, name)
						.catch(() => null);
					const status =
						current && owned(current, value) ? current.status : undefined;
					workloads.push({
						kind: resource.kind,
						name,
						desiredReplicas: value.replicas,
						readyReplicas: status?.readyReplicas ?? null,
						availableReplicas: status?.availableReplicas ?? null,
					});
				}
				if (resource.kind === "Service") {
					const name = resourceName(value, resource.metadata.name);
					const service = await client
						.read<V1Service>("Service", name)
						.catch(() => null);
					const endpoints =
						service && owned(service, value)
							? await client
									.read<V1Endpoints>("Endpoints", name)
									.catch(() => null)
							: null;
					services.push({
						name,
						ports: service?.spec?.ports?.length ?? null,
						endpointAddresses: endpoints
							? Math.min(
									65_535,
									(endpoints.subsets ?? []).reduce(
										(total, subset) => total + (subset.addresses?.length ?? 0),
										0,
									),
								)
							: null,
					});
				}
			}
			const diagnosticStage =
				stage === "healthy" &&
				services.some((service) => service.endpointAddresses === 0)
					? "service_no_endpoints"
					: stage;
			options.onHealthDiagnostic({
				schemaVersion: 1,
				agentId: value.agentId,
				workloadRevision: value.workloadRevision,
				stage: diagnosticStage,
				workloads,
				services,
			});
		} catch {
			// Diagnostics are observational and never alter reconciliation.
		}
	}

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
		if (object.kind === "Job") {
			if (!matchesImagePullSecrets((current as V1Job).spec?.template.spec))
				throw new Error("multi-service migration pull policy drifted");
			return current;
		}
		if (
			(object.kind === "Deployment" || object.kind === "StatefulSet") &&
			sameWorkloadShape(current, object)
		)
			return current;
		if (current.kind === "PersistentVolumeClaim") {
			const currentPvc = current as unknown as V1PersistentVolumeClaim;
			const declaredPvc = manifestPvc(value, current.metadata?.name ?? "");
			if (
				!declaredPvc ||
				!storageMatchesPolicy(
					currentPvc,
					value,
					declaredPvc,
					options.policy,
					resources,
				)
			)
				throw new Error("multi-service PVC drifted");
		}
		const currentPvc =
			current.kind === "PersistentVolumeClaim"
				? (current as unknown as V1PersistentVolumeClaim)
				: undefined;
		if (
			(object.kind === "Deployment" || object.kind === "StatefulSet") &&
			current.metadata?.resourceVersion &&
			current.metadata.uid
		)
			return replaceWorkloadWithConflictRetry(object, current, value);
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
	async function hasAdditionalSnapshotEgress(
		value: MultiServiceDesired,
		validateExpectedPolicies = true,
	) {
		if (
			!options.policy.workspaceSnapshotProjection ||
			!value.workspaceSnapshots?.length ||
			value.replicas === 0
		)
			return false;
		const policies = await client.list<V1NetworkPolicy>("NetworkPolicy", "");
		const expectedPolicies = value.multiService.resources
			.filter(
				(resource) =>
					resource.kind === "Deployment" ||
					resource.kind === "StatefulSet" ||
					resource.kind === "Job",
			)
			.map((resource) =>
				resource.kind === "Job"
					? migrationNetworkPolicy(value, options.policy)
					: networkPolicy(value, resource, options.policy),
			);
		if (validateExpectedPolicies)
			for (const expected of expectedPolicies) {
				const current = await client.read<V1NetworkPolicy>(
					"NetworkPolicy",
					expected.metadata?.name ?? "",
				);
				if (
					!current ||
					!owned(current, value) ||
					!matchesNetworkPolicySpec(current.spec, expected.spec)
				)
					return true;
			}
		for (const resource of value.multiService.resources) {
			const expected =
				resource.kind === "Deployment" || resource.kind === "StatefulSet"
					? networkPolicy(value, resource, options.policy)
					: resource.kind === "Job"
						? migrationNetworkPolicy(value, options.policy)
						: undefined;
			if (
				expected &&
				hasAdditionalEgressPolicyV1(
					policies.filter((policy) => !ownedByAgent(policy, value)),
					{
						...expected,
						metadata: {
							...expected.metadata,
							name: `${expected.metadata?.name}-expected`,
						},
					},
				)
			)
				return true;
		}
		return false;
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
			if (await hasAdditionalSnapshotEgress(value, false))
				throw new WorkloadKubernetesError("policy");
			await pruneStaleResources(value, ownership);
			const snapshotOwner = await put(serviceAccount(value), value, ownership);
			if (options.policy.workspaceSnapshotProjection)
				await writeWorkspaceSnapshotSecretV1(
					client,
					options.policy.workspaceSnapshotProjection,
					{
						...serviceAccount(value).metadata,
						ownerReferences: [
							{
								apiVersion: "v1",
								kind: "ServiceAccount",
								name: serviceAccount(value).metadata?.name ?? "",
								uid: snapshotOwner.metadata?.uid ?? "",
								controller: true,
								blockOwnerDeletion: false,
							},
						],
					},
				);
			const migration = migrationResource(value);
			if (migration?.kind === "Job") {
				await put(
					migrationNetworkPolicy(value, options.policy),
					value,
					ownership,
				);
				const job = await put(
					migrationJob(value, migration, resources, options.policy),
					value,
					ownership,
				);
				const snapshots = await observeSnapshotPods(value, job as V1Job);
				if (snapshots === "unhealthy" || snapshots === "drifted")
					throw new WorkloadPreflightRejectedErrorV1(
						"snapshot-materialization",
					);
				if (jobFailed(job as V1Job))
					throw new WorkloadPreflightRejectedErrorV1("desired-workload");
				if (!jobSucceeded(job as V1Job) || snapshots === "pending")
					return "pending" as const;
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
						(candidate) =>
							candidate.kind === "PersistentVolumeClaim" &&
							candidate.metadata.name === `${resource.metadata.name}-data`,
					);
					const statefulPvc =
						pvc?.kind === "PersistentVolumeClaim" ? pvc : undefined;
					if (!statefulPvc)
						throw new Error("multi-service StatefulSet PVC is missing");
					await put(
						statefulSet(
							value,
							resource,
							options.policy,
							resources,
							persistentVolumeClaim(
								value,
								statefulPvc,
								options.policy,
								resources,
							),
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
			const entry = entryWorkloadResource(value);
			const current = await client.read<V1Deployment | V1StatefulSet>(
				entry.kind,
				serviceResourceName(value.agentId, entry.metadata.name),
			);
			if (
				!current ||
				!owned(current, value) ||
				current.metadata?.deletionTimestamp ||
				!current.metadata?.uid ||
				!Number.isSafeInteger(current.metadata.generation) ||
				(current.metadata.generation ?? 0) < 1
			)
				throw new Error("multi-service entry identity unavailable");
			const generation = current.metadata.generation;
			if (
				typeof generation !== "number" ||
				!Number.isSafeInteger(generation) ||
				generation < 1
			)
				throw new Error("multi-service entry generation unavailable");
			const identities: MemberIdentitySnapshot = {};
			for (const member of snapshotMemberResources(
				value,
				entry.metadata.name,
			)) {
				const currentMember = await client.read<V1Deployment | V1StatefulSet>(
					member.kind as "Deployment" | "StatefulSet",
					serviceResourceName(value.agentId, member.metadata.name),
				);
				const memberGeneration = currentMember?.metadata?.generation;
				if (
					!currentMember?.metadata?.uid ||
					typeof memberGeneration !== "number" ||
					!Number.isSafeInteger(memberGeneration) ||
					memberGeneration < 1
				)
					throw new Error("multi-service consumer generation unavailable");
				identities[member.metadata.name] = {
					uid: currentMember.metadata.uid,
					generation: memberGeneration,
				};
			}
			if (!current.metadata.resourceVersion)
				throw new Error("multi-service entry resource version unavailable");
			const memberSnapshot = serializeMemberSnapshot(identities);
			if (
				current.metadata.annotations?.[memberIdentityAnnotation] ===
				memberSnapshot
			)
				return { uid: current.metadata.uid, generation: generation as number };
			const updated = await replaceWorkloadWithConflictRetry(
				{
					...current,
					metadata: {
						...current.metadata,
						uid: current.metadata.uid,
						resourceVersion: current.metadata.resourceVersion,
						annotations: {
							...current.metadata.annotations,
							[memberIdentityAnnotation]: memberSnapshot,
						},
					},
				},
				current,
				value,
			);
			const updatedGeneration = updated.metadata?.generation;
			if (
				updated.metadata?.uid !== current.metadata.uid ||
				typeof updatedGeneration !== "number" ||
				!Number.isSafeInteger(updatedGeneration) ||
				updatedGeneration < 1
			)
				throw new Error("multi-service entry update identity unavailable");
			return { uid: updated.metadata.uid, generation: updatedGeneration };
		},
		async observe(
			value: MultiServiceDesired,
			identity: { uid: string; generation: number } | "pending",
		) {
			if (await hasAdditionalSnapshotEgress(value)) return "drifted" as const;
			const migration = migrationResource(value);
			if (migration?.kind === "Job") {
				const job = await client.read<V1Job>("Job", migrationJobName(value));
				if (!job) {
					await emitHealthDiagnostic(value, "migration_missing");
					return "unreachable" as const;
				}
				if (
					!owned(job, value) ||
					!matchesImagePullSecrets(job.spec?.template.spec)
				) {
					await emitHealthDiagnostic(value, "workload_drifted");
					return "drifted" as const;
				}
				const snapshots = await observeSnapshotPods(value, job);
				if (snapshots !== "healthy") return snapshots;
				if (jobFailed(job)) {
					await emitHealthDiagnostic(value, "migration_failed");
					return "unhealthy" as const;
				}
				if (!jobSucceeded(job)) {
					await emitHealthDiagnostic(value, "migration_pending");
					return "unreachable" as const;
				}
			}
			if (identity === "pending") return "pending" as const;
			const entry = entryWorkloadResource(value);
			const currentEntry = await client.read<V1Deployment | V1StatefulSet>(
				entry.kind,
				serviceResourceName(value.agentId, entry.metadata.name),
			);
			if (
				!currentEntry ||
				!owned(currentEntry, value) ||
				currentEntry.metadata?.deletionTimestamp ||
				currentEntry.metadata?.uid !== identity.uid ||
				currentEntry.metadata.generation !== identity.generation
			)
				return "drifted" as const;
			const snapshot = parseMemberSnapshot(
				currentEntry.metadata.annotations?.[memberIdentityAnnotation],
			);
			if (!snapshot) return "drifted" as const;
			for (const resource of value.multiService.resources) {
				if (resource.kind !== "Deployment" && resource.kind !== "StatefulSet")
					continue;
				const current = await client.read<V1Deployment | V1StatefulSet>(
					resource.kind,
					serviceResourceName(value.agentId, resource.metadata.name),
				);
				if (
					!current ||
					!owned(current, value) ||
					!matchesImagePullSecrets(current.spec?.template.spec) ||
					!matchesEnvironmentSecrets(value, current.spec?.template.spec)
				)
					return "drifted" as const;
				if (resource.metadata.name !== entry.metadata.name) {
					const memberIdentity = snapshot[resource.metadata.name];
					if (
						!memberIdentity ||
						current.metadata?.uid !== memberIdentity.uid ||
						current.metadata.generation !== memberIdentity.generation
					)
						return "drifted" as const;
				}
				const snapshots = await observeSnapshotPods(value, current);
				if (snapshots !== "healthy") return snapshots;
				// 工作负载还在启动：与单镜像路径一致返回 pending，由调谐按重试上限等待，
				// 而不是在第一次观测时就判定失败。
				if (
					(resource.kind === "Deployment"
						? (current.status?.availableReplicas ?? 0)
						: (current.status?.readyReplicas ?? 0)) < 1
				) {
					await emitHealthDiagnostic(value, "workload_not_ready");
					return "pending" as const;
				}
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
					!storageMatchesPolicy(
						current,
						value,
						resource,
						options.policy,
						resources,
					)
				) {
					await emitHealthDiagnostic(value, "health_check_failed");
					return "unhealthy" as const;
				}
			}
			await emitHealthDiagnostic(value, "healthy");
			return "healthy" as const;
		},
		async promote(value: MultiServiceDesired) {
			await put(ingress(value, options.policy), value);
		},
		async materializeSecret(
			value: MultiServiceDesired,
			name: string,
			key: string,
			plaintext: Uint8Array,
		) {
			const ref = value.secretRefs.find((entry) => entry.name === name);
			if (!ref) throw new Error("multi-service Secret reference unavailable");
			const object: V1Secret = {
				apiVersion: "v1",
				kind: "Secret",
				type: "Opaque",
				immutable: true,
				metadata: {
					...metadata(value, name),
					annotations: {
						...metadata(value, name).annotations,
						[secretIdAnnotation]: ref.secretId,
						[secretVersionAnnotation]: String(ref.secretVersion),
						[secretConfigRevisionAnnotation]: String(ref.configRevision),
					},
				},
				data: { [key]: Buffer.from(plaintext).toString("base64") },
			};
			const current = await client.read<V1Secret>("Secret", name);
			if (!current)
				return (
					(await client.create(object)).metadata?.uid ??
					(async () => {
						const live = await client.read<V1Secret>("Secret", name);
						if (!live?.metadata?.uid)
							throw new Error("multi-service Secret UID unavailable");
						return live.metadata.uid;
					})()
				);
			if (
				!current.metadata?.uid ||
				current.immutable !== true ||
				current.type !== "Opaque" ||
				current.metadata.annotations?.[agentAnnotation] !== value.agentId ||
				current.metadata.annotations?.[secretIdAnnotation] !== ref.secretId ||
				current.metadata.annotations?.[secretVersionAnnotation] !==
					String(ref.secretVersion) ||
				current.metadata.annotations?.[secretConfigRevisionAnnotation] !==
					String(ref.configRevision) ||
				!isDeepStrictEqual(current.data ?? {}, object.data)
			)
				throw new Error("multi-service Secret drifted");
			return current.metadata.uid;
		},
		async bindSecretFence(
			value: MultiServiceDesired,
			expectedEntryIdentity: { uid: string; generation: number },
			secretName: string,
			fence: number,
			secretUid: string,
		): Promise<WorkloadIdentity> {
			const entry = entryWorkloadResource(value);
			const members = snapshotMemberResources(value, entry.metadata.name);
			if (!members.length)
				throw new Error("multi-service Secret consumers unavailable");
			const identities: MemberIdentitySnapshot = {};
			for (const member of members) {
				const kind = member.kind as "Deployment" | "StatefulSet";
				const name = serviceResourceName(value.agentId, member.metadata.name);
				const current = await client.read<V1Deployment | V1StatefulSet>(
					kind,
					name,
				);
				if (
					!current?.metadata?.uid ||
					!current.metadata.resourceVersion ||
					!owned(current, value) ||
					!Number.isSafeInteger(current.metadata.generation) ||
					(current.metadata.generation ?? 0) < 1
				)
					throw new Error("multi-service consumer identity unavailable");
				const fk = secretFenceAnnotation(secretName);
				const uk = secretUidAnnotation(secretName);
				if (
					current.metadata.annotations?.[uk] &&
					current.metadata.annotations[uk] !== secretUid
				)
					throw new Error("multi-service Secret UID fence drifted");
				await replaceWorkloadWithConflictRetry(
					{
						...current,
						metadata: {
							...current.metadata,
							resourceVersion: current.metadata.resourceVersion,
							uid: current.metadata.uid,
							annotations: {
								...current.metadata.annotations,
								[fk]: String(fence),
								[uk]: secretUid,
							},
						},
					},
					current,
					value,
				);
			}
			for (const member of members) {
				const current = await client.read<V1Deployment | V1StatefulSet>(
					member.kind as "Deployment" | "StatefulSet",
					serviceResourceName(value.agentId, member.metadata.name),
				);
				if (
					!current?.metadata?.uid ||
					current.metadata.annotations?.[secretFenceAnnotation(secretName)] !==
						String(fence) ||
					current.metadata.annotations?.[secretUidAnnotation(secretName)] !==
						secretUid ||
					!matchesEnvironmentSecrets(value, current.spec?.template.spec)
				)
					throw new Error("multi-service Secret fence readback drifted");
			}
			for (const member of members) {
				const current = await client.read<V1Deployment | V1StatefulSet>(
					member.kind as "Deployment" | "StatefulSet",
					serviceResourceName(value.agentId, member.metadata.name),
				);
				if (
					!current?.metadata?.uid ||
					!Number.isSafeInteger(current.metadata.generation) ||
					(current.metadata.generation ?? 0) < 1
				)
					throw new Error("multi-service consumer generation unavailable");
				const generation = current.metadata.generation;
				if (
					typeof generation !== "number" ||
					!Number.isSafeInteger(generation) ||
					generation < 1
				)
					throw new Error("multi-service consumer generation unavailable");
				identities[member.metadata.name] = {
					uid: current.metadata.uid,
					generation: generation as number,
				};
			}
			const entryAfter = entryWorkloadResource(value);
			const currentEntryAfter = await client.read<V1Deployment | V1StatefulSet>(
				entryAfter.kind,
				serviceResourceName(value.agentId, entryAfter.metadata.name),
			);
			if (
				!currentEntryAfter?.metadata?.uid ||
				!currentEntryAfter.metadata.resourceVersion ||
				!owned(currentEntryAfter, value) ||
				currentEntryAfter.metadata.deletionTimestamp ||
				(currentEntryAfter.metadata.annotations?.[
					secretUidAnnotation(secretName)
				] !== undefined &&
					currentEntryAfter.metadata.annotations[
						secretUidAnnotation(secretName)
					] !== secretUid) ||
				currentEntryAfter.metadata.uid !== expectedEntryIdentity.uid ||
				currentEntryAfter.metadata.generation !==
					expectedEntryIdentity.generation
			)
				throw new Error("multi-service entry identity unavailable");
			const updatedEntry = await replaceWorkloadWithConflictRetry(
				{
					...currentEntryAfter,
					metadata: {
						...currentEntryAfter.metadata,
						uid: currentEntryAfter.metadata.uid,
						resourceVersion: currentEntryAfter.metadata.resourceVersion,
						annotations: {
							...currentEntryAfter.metadata.annotations,
							[memberIdentityAnnotation]: serializeMemberSnapshot(identities),
							[secretFenceAnnotation(secretName)]: String(fence),
							[secretUidAnnotation(secretName)]: secretUid,
						},
					},
				},
				currentEntryAfter,
				value,
			);
			const updatedMetadata = updatedEntry.metadata;
			if (
				!updatedMetadata ||
				updatedMetadata.uid !== expectedEntryIdentity.uid ||
				typeof updatedMetadata.generation !== "number" ||
				!Number.isSafeInteger(updatedMetadata.generation) ||
				updatedMetadata.generation < 1
			)
				throw new Error("multi-service entry update identity unavailable");
			return {
				uid: updatedMetadata.uid,
				generation: updatedMetadata.generation,
			};
		},
		async observeSecretFence(
			value: MultiServiceDesired,
			identity: { uid: string; generation: number },
			secretName: string,
			fence: number,
		) {
			const secret = await client.read<V1Secret>("Secret", secretName);
			if (!secret?.metadata?.uid || secret.metadata.deletionTimestamp)
				return false;
			const secretUid = secret.metadata.uid;
			for (const member of memberResources(value)) {
				const current = await client.read<V1Deployment | V1StatefulSet>(
					member.kind as "Deployment" | "StatefulSet",
					serviceResourceName(value.agentId, member.metadata.name),
				);
				if (
					!current?.metadata?.uid ||
					!owned(current, value) ||
					current.metadata.annotations?.[secretFenceAnnotation(secretName)] !==
						String(fence) ||
					current.metadata.annotations?.[secretUidAnnotation(secretName)] !==
						secretUid ||
					!matchesEnvironmentSecrets(value, current.spec?.template.spec)
				)
					return false;
				const selector = memberSelector(value, member);
				if (!selector) return false;
				const pods = (
					await client.list<V1Pod>(
						"Pod",
						`${ownerLabel}=${workloadResourceNameV1(value.agentId)}`,
					)
				).filter(
					(pod) =>
						pod.metadata?.labels?.["agent-infra.agora.io/service"] ===
						serviceLabel(member.metadata.name),
				);
				if (pods.length !== 1) return false;
				const pod = pods.at(0);
				if (!pod) return false;
				if (
					pod.metadata?.deletionTimestamp ||
					pod.status?.phase !== "Running" ||
					!pod.status?.containerStatuses?.every(
						(status: { ready?: boolean }) => status.ready,
					) ||
					!matchesEnvironmentSecrets(value, pod.spec)
				)
					return false;
			}
			const entry = entryWorkloadResource(value);
			const currentEntry = await client.read<V1Deployment | V1StatefulSet>(
				entry.kind,
				serviceResourceName(value.agentId, entry.metadata.name),
			);
			if (!currentEntry?.metadata?.uid || !currentEntry.metadata.generation)
				return false;
			if (
				currentEntry.metadata.uid !== identity.uid ||
				currentEntry.metadata.generation !== identity.generation
			)
				return false;
			const snapshot = parseMemberSnapshot(
				currentEntry.metadata.annotations?.[memberIdentityAnnotation],
			);
			if (!snapshot) return false;
			for (const member of snapshotMemberResources(
				value,
				entry.metadata.name,
			)) {
				const identity = snapshot[member.metadata.name];
				const current = await client.read<V1Deployment | V1StatefulSet>(
					member.kind as "Deployment" | "StatefulSet",
					serviceResourceName(value.agentId, member.metadata.name),
				);
				if (
					!identity ||
					current?.metadata?.uid !== identity.uid ||
					current.metadata.generation !== identity.generation
				)
					return false;
			}
			return true;
		},
		async observeActiveImmutableSecret(
			value: MultiServiceDesired,
			ref: AgentWorkloadDesiredV1["secretRefs"][number],
			activationFence: {
				readonly workloadUid: string;
				readonly workloadGeneration: number;
				readonly fence: number;
			},
		) {
			if (!ref.name) return false;
			const entry = entryWorkloadResource(value);
			const currentEntry = await client.read<V1Deployment | V1StatefulSet>(
				entry.kind,
				serviceResourceName(value.agentId, entry.metadata.name),
			);
			if (
				!currentEntry?.metadata?.uid ||
				currentEntry.metadata.uid !== activationFence.workloadUid ||
				currentEntry.metadata.generation !== activationFence.workloadGeneration
			)
				return false;
			return this.observeSecretFence(
				value,
				{
					uid: activationFence.workloadUid,
					generation: activationFence.workloadGeneration,
				},
				ref.name,
				activationFence.fence,
			);
		},
		async removeImmutableSecret(
			value: MultiServiceDesired,
			ref: AgentWorkloadDesiredV1["secretRefs"][number],
			activationFence?: {
				readonly workloadUid: string;
				readonly workloadGeneration: number;
				readonly fence: number;
			},
			// Trusted content verification supplies this UID after initial consumers are removed.
			verifiedSecretUid?: string,
		) {
			const secret = await client.read<V1Secret>("Secret", ref.name);
			if (!secret) return true;
			let hasCurrentConsumer = false;
			for (const member of memberResources(value)) {
				const current = await client.read<V1Deployment | V1StatefulSet>(
					member.kind as "Deployment" | "StatefulSet",
					serviceResourceName(value.agentId, member.metadata.name),
				);
				if (!current) continue;
				hasCurrentConsumer = true;
				if (
					!owned(current, value) ||
					referencesSecret(current.spec?.template.spec, ref.name)
				)
					return false;
			}
			if (
				activationFence &&
				!hasCurrentConsumer &&
				secret.metadata?.uid !== verifiedSecretUid
			)
				return false;
			if (
				activationFence &&
				hasCurrentConsumer &&
				!(await this.observeSecretFence(
					value,
					{
						uid: activationFence.workloadUid,
						generation: activationFence.workloadGeneration,
					},
					ref.name,
					activationFence.fence,
				))
			)
				return false;
			const pods = await client.list<V1Pod>(
				"Pod",
				`${ownerLabel}=${workloadResourceNameV1(value.agentId)}`,
			);
			if (pods.some((pod) => referencesSecret(pod.spec, ref.name)))
				return false;
			if (
				!secret.metadata?.uid ||
				secret.immutable !== true ||
				secret.type !== "Opaque" ||
				!owned(secret, value) ||
				!ownedByAgent(secret, value) ||
				secret.metadata.annotations?.[secretIdAnnotation] !== ref.secretId ||
				secret.metadata.annotations?.[secretVersionAnnotation] !==
					String(ref.secretVersion) ||
				secret.metadata.annotations?.[secretConfigRevisionAnnotation] !==
					String(ref.configRevision)
			)
				return false;
			await client.delete(secret);
			return (await client.read<V1Secret>("Secret", ref.name)) === null;
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
