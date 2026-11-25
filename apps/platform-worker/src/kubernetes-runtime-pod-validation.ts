import { isIP } from "node:net";
import type { AgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import type { StandardTemplateModelBindingV1 } from "@agent-infra/model-catalog";
import type {
	V1EnvVar,
	V1Pod,
	V1PodSpec,
	V1StatefulSet,
} from "@kubernetes/client-node";
import {
	acceptsAdoptedAgentWorkloadPlacementV1,
	acsPodMetadataV1,
	agentWorkloadPlacementAnnotationV1,
	isProviderPodAnnotationV1,
	validateAgentWorkloadPlacementV1,
	withoutAcsStorageDefaultV1,
} from "./agent-workload-placement.js";
import {
	runtimeConnectionConsumerControlPodV1,
	runtimeConnectionConsumerProjectionV1,
	runtimeConnectionConsumerSnapshotForAgentV1,
	runtimeConnectionInstallationOAuthPublicationForAgentV1,
	runtimeConnectionInstallationRevisionForAgentV1,
} from "./connection-consumer-projection.js";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import type { KubernetesWorkloadPolicyV1 } from "./kubernetes-runtime-adapter.js";
import {
	agentContainerSecurityContext,
	agentPodSecurityContext,
	hasSameStructure,
	matchesResources,
	ownerLabel,
	quantityRatio,
	revisionLabel,
	workloadResourceNameV1,
} from "./kubernetes-runtime-comparison.js";
import {
	skillHubRuntimeBindingV1,
	skillHubRuntimeDataSubPathV1,
	skillHubVolumeMountV1,
} from "./kubernetes-runtime-skill-mount.js";
import { skillHubDeliveryProjectionV1 } from "./skill-hub-delivery.js";
import {
	type WorkspaceSnapshotPodProjectionV1,
	withoutVerifiedWorkspaceSnapshotProjectionV1,
	workspaceSnapshotWorkloadProjectionV1,
} from "./workspace-snapshot-materializer.js";
export function createKubernetesPodValidationV1(dependencies: {
	readonly connectionConsumerControl?: boolean;
	readonly workspaceSnapshotProjection?: WorkspaceSnapshotPodProjectionV1;
	readonly policy: KubernetesWorkloadPolicyV1;
	/** Exact pull repository selected by the trusted standard-template binding. */
	readonly imageRepository: string;
	readonly standardTemplateBinding?: StandardTemplateModelBindingV1;
	readonly workloadEnvironment: (value: AgentWorkloadDesiredV1) => V1EnvVar[];
	readonly environmentSecrets: (
		value: AgentWorkloadDesiredV1,
	) => AgentWorkloadDesiredV1["secretRefs"];
}) {
	const { policy, imageRepository, workloadEnvironment, environmentSecrets } =
		dependencies;
	try {
		validateAgentWorkloadPlacementV1(policy.agentWorkloadPlacement);
	} catch {
		throw new WorkloadKubernetesError("policy");
	}
	const placementRecord = (controller: V1StatefulSet | undefined) =>
		controller?.metadata?.annotations?.[agentWorkloadPlacementAnnotationV1];
	const withoutSkillDelivery = (
		value: AgentWorkloadDesiredV1,
		spec: V1PodSpec | undefined,
	) =>
		withoutVerifiedWorkspaceSnapshotProjectionV1(
			spec,
			skillHubDeliveryProjectionV1(
				skillHubRuntimeBindingV1(value),
				value.skillDeliveryImage,
			),
		);
	const topologyLabelValues = structuredClone(
		policy.allowedPodTopologyLabelValues ?? {},
	);
	for (const [key, values] of Object.entries(topologyLabelValues)) {
		if (
			![
				"topology.kubernetes.io/region",
				"topology.kubernetes.io/zone",
			].includes(key) ||
			!Array.isArray(values) ||
			values.length === 0 ||
			values.length > 64 ||
			!values.every(
				(value) =>
					typeof value === "string" &&
					/^[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/.test(value),
			)
		)
			throw new WorkloadKubernetesError("policy");
	}
	const connectionFor = (agentId: string) =>
		runtimeConnectionConsumerProjectionV1(
			dependencies.connectionConsumerControl
				? undefined
				: runtimeConnectionConsumerSnapshotForAgentV1(
						policy.connectionConsumerSnapshot,
						policy.connectionConsumerSnapshotsByAgent,
						agentId,
					),
			dependencies.connectionConsumerControl
				? undefined
				: runtimeConnectionInstallationRevisionForAgentV1(
						policy.connectionInstallationRevision,
						policy.connectionInstallationRevisionsByAgent,
						agentId,
					),
			dependencies.standardTemplateBinding,
			dependencies.connectionConsumerControl
				? undefined
				: runtimeConnectionInstallationOAuthPublicationForAgentV1(
						policy.connectionInstallationOAuthPublication,
						policy.connectionInstallationOAuthPublicationsByAgent,
						agentId,
					),
		);
	function hasSafePodMetadata(
		value: AgentWorkloadDesiredV1,
		metadataInput: V1Pod["metadata"],
		live?: { pod: V1Pod; workload: V1StatefulSet },
		record?: string,
	) {
		const actual = dependencies.connectionConsumerControl
			? runtimeConnectionConsumerControlPodV1({ metadata: metadataInput })
					.metadata
			: metadataInput;
		const name = workloadResourceNameV1(value.agentId);
		const connection = connectionFor(value.agentId);
		const acs =
			(live ? placementRecord(live.workload) : record) === "acs:amd64";
		const computeMetadata = acsPodMetadataV1(acs ? "acs" : undefined);
		const expectedAnnotations = {
			...connection.annotations,
			...computeMetadata.annotations,
		};
		const expectedLabels: Record<string, string> = {
			[ownerLabel]: name,
			[revisionLabel]: String(value.workloadRevision),
			...computeMetadata.labels,
		};
		if (live) {
			for (const [key, values] of Object.entries(topologyLabelValues)) {
				const actualValue = actual?.labels?.[key];
				if (actualValue !== undefined) {
					if (!values.includes(actualValue)) return false;
					expectedLabels[key] = actualValue;
				}
			}
			const injected = {
				"statefulset.kubernetes.io/pod-name": `${name}-0`,
				"apps.kubernetes.io/pod-index": "0",
				"controller-revision-hash":
					live.workload.status?.updateRevision ??
					live.workload.status?.currentRevision,
			};
			for (const [key, expected] of Object.entries(injected)) {
				if (actual?.labels?.[key] !== undefined) {
					if (expected === undefined || actual.labels[key] !== expected)
						return false;
					expectedLabels[key] = expected;
				}
			}
		}
		if (!hasSameStructure(actual?.labels, expectedLabels)) return false;
		if (
			Object.entries(expectedAnnotations).some(
				([key, value]) => actual?.annotations?.[key] !== value,
			)
		)
			return false;
		const annotations = Object.entries(actual?.annotations ?? {});
		if (!live)
			return hasSameStructure(actual?.annotations ?? {}, expectedAnnotations);
		if (
			acs &&
			live.pod.status?.phase === "Running" &&
			!/^acs-[a-z0-9]{1,64}$/.test(
				actual?.annotations?.["alibabacloud.com/instance-id"] ?? "",
			)
		)
			return false;
		const podIPs =
			live.pod.status?.podIPs?.map((entry) => entry.ip) ??
			(live.pod.status?.podIP ? [live.pod.status.podIP] : []);
		const cidrs = podIPs.map((ip) => `${ip}/${isIP(ip) === 6 ? 128 : 32}`);
		const validCidr = (value: string) => {
			const parts = value.split("/");
			if (parts.length !== 2) return false;
			const [ip = "", prefix] = parts;
			return (
				value.length <= 48 &&
				((isIP(ip) === 4 && prefix === "32") ||
					(isIP(ip) === 6 && prefix === "128"))
			);
		};
		return annotations.every(([key, content]) => {
			if (Object.hasOwn(expectedAnnotations, key))
				return content === expectedAnnotations[key];
			if (
				acs &&
				(key === "topology.kubernetes.io/region" ||
					key === "topology.kubernetes.io/zone")
			)
				return content === actual?.labels?.[key];
			if (key === "cni.projectcalico.org/containerID")
				return /^[a-f0-9]{64}$/.test(content);
			if (key === "cni.projectcalico.org/podIP")
				return (
					content === "" ||
					(validCidr(content) &&
						(cidrs.length === 0 || cidrs.includes(content)))
				);
			if (key === "cni.projectcalico.org/podIPs")
				return (
					content === "" ||
					(content.length <= 97 &&
						content.split(",").every(validCidr) &&
						(cidrs.length === 0 || content === cidrs.join(",")))
				);
			if (
				isProviderPodAnnotationV1(
					placementRecord(live.workload),
					live.pod.spec,
					key,
					content,
					actual,
				)
			)
				return true;
			return false;
		});
	}

	function hasUnsafePodSpec(
		value: AgentWorkloadDesiredV1,
		podInput: V1PodSpec | undefined,
		expectedIdentity:
			| {
					readonly hostname: string;
					readonly subdomain: string;
			  }
			| undefined,
		/** Controller's recorded placement (Spec §10.1: adopted per lifecycle). */
		record: string | undefined,
	) {
		const projectedPod = withoutVerifiedWorkspaceSnapshotProjectionV1(
			withoutSkillDelivery(value, podInput),
			workspaceSnapshotWorkloadProjectionV1(
				value,
				dependencies.workspaceSnapshotProjection,
			),
		);
		if (!projectedPod) return true;
		const pod = projectedPod;

		const hasUnexpectedIdentity = expectedIdentity
			? pod?.hostname !== expectedIdentity.hostname ||
				pod?.subdomain !== expectedIdentity.subdomain
			: pod?.hostname !== undefined || pod?.subdomain !== undefined;
		return (
			Object.entries(pod ?? {}).some(
				([key, value]) =>
					value !== undefined &&
					![
						"containers",
						"volumes",
						"serviceAccountName",
						"serviceAccount",
						"automountServiceAccountToken",
						"securityContext",
						"restartPolicy",
						"terminationGracePeriodSeconds",
						"enableServiceLinks",
						"dnsPolicy",
						"schedulerName",
						"priorityClassName",
						"priority",
						"preemptionPolicy",
						"nodeSelector",
						"nodeName",
						"hostname",
						"subdomain",
						"tolerations",
						"hostNetwork",
						"hostPID",
						"hostIPC",
						"shareProcessNamespace",
						"hostAliases",
						"imagePullSecrets",
						"initContainers",
						"ephemeralContainers",
						"overhead",
						"resourceClaims",
						"schedulingGates",
						"topologySpreadConstraints",
					].includes(key),
			) ||
			(pod?.restartPolicy !== undefined && pod.restartPolicy !== "Always") ||
			(pod?.terminationGracePeriodSeconds !== undefined &&
				pod.terminationGracePeriodSeconds !== 30) ||
			(pod?.enableServiceLinks !== undefined &&
				pod.enableServiceLinks !== true) ||
			(pod?.serviceAccount !== undefined &&
				pod.serviceAccount !== pod.serviceAccountName) ||
			(pod?.containers.length ?? 0) !== 1 ||
			pod?.containers[0]?.name !== "agent" ||
			pod?.hostNetwork === true ||
			pod?.hostPID === true ||
			pod?.hostIPC === true ||
			pod?.shareProcessNamespace === true ||
			(pod?.hostAliases?.length ?? 0) > 0 ||
			pod?.dnsConfig !== undefined ||
			(pod?.dnsPolicy !== undefined && pod.dnsPolicy !== "ClusterFirst") ||
			(pod?.schedulerName !== undefined &&
				pod.schedulerName !== "default-scheduler") ||
			(pod?.priorityClassName !== undefined && pod.priorityClassName !== "") ||
			(pod?.priority !== undefined && pod.priority !== 0) ||
			(pod?.preemptionPolicy !== undefined &&
				pod.preemptionPolicy !== "PreemptLowerPriority") ||
			// Only the deployment placement (or a retained pre-placement object) is
			// accepted; a live Pod additionally carries API-server default tolerations.
			!acceptsAdoptedAgentWorkloadPlacementV1(
				policy.agentWorkloadPlacement,
				record,
				pod,
				expectedIdentity !== undefined,
			) ||
			Object.keys(pod?.overhead ?? {}).length > 0 ||
			(pod?.resourceClaims?.length ?? 0) > 0 ||
			(pod?.schedulingGates?.length ?? 0) > 0 ||
			(pod?.topologySpreadConstraints?.length ?? 0) > 0 ||
			hasUnexpectedIdentity ||
			!hasSameStructure(pod?.securityContext, agentPodSecurityContext()) ||
			!hasSameStructure(
				pod?.imagePullSecrets ?? [],
				policy.imagePullSecretName
					? [{ name: policy.imagePullSecretName }]
					: [],
			) ||
			(pod?.initContainers?.length ?? 0) > 0 ||
			(pod?.ephemeralContainers?.length ?? 0) > 0 ||
			pod?.containers.some((container) => {
				const securityContext = container.securityContext;
				return (
					Object.entries(container).some(
						([key, value]) =>
							value !== undefined &&
							![
								"name",
								"image",
								"imagePullPolicy",
								"ports",
								"env",
								"envFrom",
								"resources",
								"readinessProbe",
								"securityContext",
								"volumeMounts",
								"terminationMessagePath",
								"terminationMessagePolicy",
								"command",
								"args",
								"lifecycle",
								"workingDir",
								"stdin",
								"stdinOnce",
								"tty",
								"volumeDevices",
							].includes(key),
					) ||
					(container.imagePullPolicy !== undefined &&
						container.imagePullPolicy !== "IfNotPresent") ||
					(container.terminationMessagePath !== undefined &&
						container.terminationMessagePath !== "/dev/termination-log") ||
					(container.terminationMessagePolicy !== undefined &&
						container.terminationMessagePolicy !== "File") ||
					(container.command?.length ?? 0) > 0 ||
					(container.args?.length ?? 0) > 0 ||
					Object.keys(container.lifecycle ?? {}).length > 0 ||
					container.workingDir !== undefined ||
					container.stdin === true ||
					container.stdinOnce === true ||
					container.tty === true ||
					(container.volumeDevices?.length ?? 0) > 0 ||
					!hasSameStructure(securityContext, agentContainerSecurityContext()) ||
					securityContext?.privileged === true ||
					(securityContext?.capabilities?.add?.length ?? 0) > 0
				);
			}) === true
		);
	}
	function hasDriftedImmutableStatefulSetSpec(
		value: AgentWorkloadDesiredV1,
		spec: V1StatefulSet["spec"],
	) {
		return (
			!spec ||
			spec.serviceName !== workloadResourceNameV1(value.agentId) ||
			(spec.podManagementPolicy ?? "OrderedReady") !== "OrderedReady" ||
			!hasSameStructure(spec.volumeClaimTemplates ?? [], []) ||
			!hasSameStructure(
				{ matchExpressions: [], ...spec.selector },
				{
					matchLabels: { [ownerLabel]: workloadResourceNameV1(value.agentId) },
					matchExpressions: [],
				},
			)
		);
	}
	function hasDriftedStatefulSetSpec(
		value: AgentWorkloadDesiredV1,
		spec: V1StatefulSet["spec"],
		record: string | undefined,
	) {
		if (!spec) return true;
		const { template, ...controller } = spec;
		return (
			hasDriftedStatefulSetTemplate(value, template, record) ||
			!hasSameStructure(
				{
					...controller,
					podManagementPolicy: controller.podManagementPolicy ?? "OrderedReady",
					revisionHistoryLimit: controller.revisionHistoryLimit ?? 10,
					minReadySeconds: controller.minReadySeconds ?? 0,
					ordinals: { start: 0, ...controller.ordinals },
					volumeClaimTemplates: controller.volumeClaimTemplates ?? [],
					persistentVolumeClaimRetentionPolicy: {
						whenDeleted: "Retain",
						whenScaled: "Retain",
						...controller.persistentVolumeClaimRetentionPolicy,
					},
					selector: { matchExpressions: [], ...controller.selector },
					updateStrategy: {
						...controller.updateStrategy,
						rollingUpdate: {
							partition: 0,
							maxUnavailable: 1,
							...controller.updateStrategy?.rollingUpdate,
						},
					},
				},
				{
					serviceName: workloadResourceNameV1(value.agentId),
					replicas: value.replicas,
					selector: {
						matchLabels: {
							[ownerLabel]: workloadResourceNameV1(value.agentId),
						},
						matchExpressions: [],
					},
					podManagementPolicy: "OrderedReady",
					revisionHistoryLimit: 10,
					minReadySeconds: 0,
					ordinals: { start: 0 },
					volumeClaimTemplates: [],
					persistentVolumeClaimRetentionPolicy: {
						whenDeleted: "Retain",
						whenScaled: "Retain",
					},
					updateStrategy: {
						type: "RollingUpdate",
						rollingUpdate: { partition: 0, maxUnavailable: 1 },
					},
				},
			)
		);
	}
	function normalizeStatefulSetSpecRevision(
		spec: V1StatefulSet["spec"],
		revision: number,
	) {
		return spec?.template
			? {
					...spec,
					template: {
						...spec.template,
						metadata: {
							...spec.template.metadata,
							labels: {
								...spec.template.metadata?.labels,
								[revisionLabel]: String(revision),
							},
						},
					},
				}
			: spec;
	}
	function canResumeScaledDownStatefulSet(
		value: AgentWorkloadDesiredV1,
		spec: V1StatefulSet["spec"],
		record: string | undefined,
	) {
		return Boolean(
			spec?.replicas === 0 &&
				value.replicas === 1 &&
				!hasDriftedStatefulSetSpec(
					value,
					normalizeStatefulSetSpecRevision(spec, value.workloadRevision),
					record,
				),
		);
	}
	function hasDriftedStatefulSetTemplate(
		value: AgentWorkloadDesiredV1,
		template: NonNullable<V1StatefulSet["spec"]>["template"] | undefined,
		record: string | undefined,
	) {
		const pod = template?.spec;
		const container = pod?.containers.find((entry) => entry.name === "agent");
		return (
			!hasSafePodMetadata(value, template?.metadata, undefined, record) ||
			hasDriftedPodSpec(value, pod, undefined, record) ||
			!hasSameStructure(
				pod?.imagePullSecrets ?? [],
				policy.imagePullSecretName
					? [{ name: policy.imagePullSecretName }]
					: [],
			) ||
			!acceptsAdoptedAgentWorkloadPlacementV1(
				policy.agentWorkloadPlacement,
				record,
				pod,
				false,
			) ||
			container?.image !== `${imageRepository}@${value.imageDigest}` ||
			pod?.automountServiceAccountToken !== false
		);
	}
	function hasDriftedPodSpec(
		value: AgentWorkloadDesiredV1,
		specInput: V1PodSpec | undefined,
		expectedIdentity:
			| {
					readonly hostname: string;
					readonly subdomain: string;
			  }
			| undefined,
		record: string | undefined,
	) {
		const projectedPod = dependencies.connectionConsumerControl
			? runtimeConnectionConsumerControlPodV1({ spec: specInput }).spec
			: specInput;
		if (hasUnsafePodSpec(value, projectedPod, expectedIdentity, record))
			return true;
		const pod = withoutVerifiedWorkspaceSnapshotProjectionV1(
			withoutSkillDelivery(value, projectedPod),
			workspaceSnapshotWorkloadProjectionV1(
				value,
				dependencies.workspaceSnapshotProjection,
			),
		);
		const skillHubMount = value.skillDeliveryImage
			? null
			: skillHubVolumeMountV1(value);
		const container = pod?.containers.find((entry) => entry.name === "agent");
		const connection = connectionFor(value.agentId);
		const probe = container?.readinessProbe;
		const ports = container?.ports?.map((port) => ({
			...port,
			protocol: port.protocol ?? "TCP",
		}));
		// API-server defaults and legacy cadence are allowed; other probe fields stay exact.
		const expectedProbe = {
			httpGet: {
				path: value.health.path,
				port: value.service.port,
				scheme: "HTTP",
			},
			timeoutSeconds: value.health.timeoutSeconds,
			failureThreshold: value.health.failureThreshold,
			initialDelaySeconds: 0,
			periodSeconds: (probe?.periodSeconds ?? 10) === 10 ? 10 : 1,
			successThreshold: 1,
		};
		return (
			!hasSameStructure(ports, [
				{ name: "runtime", containerPort: value.service.port, protocol: "TCP" },
			]) ||
			!matchesResources(
				record === "acs:amd64"
					? withoutAcsStorageDefaultV1(container?.resources)
					: container?.resources,
				policy.resources,
			) ||
			!hasSameStructure(
				{
					...probe,
					initialDelaySeconds: probe?.initialDelaySeconds ?? 0,
					periodSeconds: probe?.periodSeconds ?? 10,
					successThreshold: probe?.successThreshold ?? 1,
					httpGet: {
						...probe?.httpGet,
						scheme: probe?.httpGet?.scheme ?? "HTTP",
					},
				},
				expectedProbe,
			) ||
			!hasSameStructure(
				(container?.env ?? []).map((entry) => ({
					...entry,
					value: entry.value ?? "",
				})),
				workloadEnvironment(value).map((entry) => ({
					...entry,
					value: "value" in entry ? entry.value : "",
				})),
			) ||
			!hasSameStructure(
				(container?.envFrom ?? []).map((entry) => ({
					...entry,
					prefix: entry.prefix ?? "",
					secretRef: {
						...entry.secretRef,
						optional: entry.secretRef?.optional ?? false,
					},
				})),
				environmentSecrets(value).map((ref) => ({
					prefix: "",
					secretRef: { name: ref.name, optional: false },
				})),
			) ||
			!hasSameStructure(
				container?.volumeMounts?.map((mount) => ({
					...mount,
					readOnly: mount.readOnly ?? false,
					subPath: mount.subPath ?? "",
					subPathExpr: mount.subPathExpr ?? "",
					mountPropagation: mount.mountPropagation ?? "None",
				})),
				[
					...connection.volumeMounts.map((mount) => ({
						...mount,
						subPath: "",
						subPathExpr: "",
						mountPropagation: "None",
					})),
					{
						name: "data",
						mountPath: value.persistentVolume.mountPath,
						readOnly: false,
						subPath: skillHubMount ? skillHubRuntimeDataSubPathV1 : "",
						subPathExpr: "",
						mountPropagation: "None",
					},
					{
						name: "runtime-tmp",
						mountPath: "/tmp",
						readOnly: false,
						subPath: "",
						subPathExpr: "",
						mountPropagation: "None",
					},
					...(skillHubMount
						? [{ ...skillHubMount, subPathExpr: "", mountPropagation: "None" }]
						: []),
				],
			) ||
			pod?.serviceAccountName !== workloadResourceNameV1(value.agentId) ||
			!hasSameStructure(
				pod?.volumes?.map((volume) => {
					const size = volume.emptyDir?.sizeLimit;
					const observed =
						typeof size === "string" ? quantityRatio(size) : undefined;
					const expected = quantityRatio("128Mi");
					return {
						...volume,
						...(volume.secret
							? {
									secret: {
										...volume.secret,
										optional: volume.secret.optional ?? false,
									},
								}
							: {}),
						...(observed &&
						expected &&
						observed[0] * expected[1] === expected[0] * observed[1]
							? { emptyDir: { ...volume.emptyDir, sizeLimit: "128Mi" } }
							: {}),
						...(volume.persistentVolumeClaim
							? {
									persistentVolumeClaim: {
										...volume.persistentVolumeClaim,
										readOnly: volume.persistentVolumeClaim.readOnly ?? false,
									},
								}
							: {}),
					};
				}),
				[
					...connection.volumes,
					{
						name: "data",
						persistentVolumeClaim: {
							claimName: value.persistentVolume.name,
							readOnly: false,
						},
					},
					{
						name: "runtime-tmp",
						emptyDir: { medium: "Memory", sizeLimit: "128Mi" },
					},
				],
			)
		);
	}
	return {
		placementRecord,
		hasSafePodMetadata,
		hasUnsafePodSpec,
		hasDriftedImmutableStatefulSetSpec,
		hasDriftedStatefulSetSpec,
		normalizeStatefulSetSpecRevision,
		canResumeScaledDownStatefulSet,
		hasDriftedPodSpec,
	};
}
