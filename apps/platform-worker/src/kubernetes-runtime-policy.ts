import {
	type AgentWorkloadDesiredV1,
	validateAgentWorkloadDesiredV1,
} from "@agent-infra/contracts/workload";
import type {
	RuntimeModelProjectionV1,
	runtimeModelInjectionV1,
} from "@agent-infra/model-catalog";
import type {
	KubernetesObject,
	V1Ingress,
	V1NetworkPolicy,
	V1PersistentVolumeClaim,
	V1Pod,
	V1PodSpec,
	V1Secret,
	V1Service,
	V1ServiceAccount,
	V1StatefulSet,
} from "@kubernetes/client-node";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import type { KubernetesWorkloadPolicyV1 } from "./kubernetes-runtime-adapter.js";
import {
	agentAnnotation,
	containsDesired,
	fingerprintAnnotation,
	hasSameStructure,
	ownerLabel,
	quantityRatio,
	revisionLabel,
	secretConfigRevisionAnnotation,
	secretIdAnnotation,
	secretVersionAnnotation,
	workloadResourceNameV1,
} from "./kubernetes-runtime-comparison.js";
import { createKubernetesPodValidationV1 } from "./kubernetes-runtime-pod-validation.js";
import type { workloadEgressRulesV1 } from "./workload-network.js";
import { workloadRuntimeAuthEnvironmentV1 } from "./workload-runtime-auth.js";
export function createKubernetesWorkloadPolicyHelpersV1(dependencies: {
	readonly policy: KubernetesWorkloadPolicyV1;
	readonly modelProjection: RuntimeModelProjectionV1 | undefined;
	readonly modelInjection:
		| ReturnType<typeof runtimeModelInjectionV1>
		| undefined;
	readonly egress: ReturnType<typeof workloadEgressRulesV1>;
}) {
	const { policy, modelProjection, modelInjection, egress } = dependencies;
	function modelBindings(value: AgentWorkloadDesiredV1) {
		if (!modelProjection || !modelInjection) return undefined;
		if (
			value.agentId !== modelProjection.agentId ||
			value.configRevision !== modelProjection.configurationRevision ||
			Object.keys(value.env).some((name) => name.startsWith("AGENT_INFRA_")) ||
			modelProjection.options.some(
				(option) =>
					!value.secretRefs.some(
						(ref) =>
							ref.name === option.secretRef.name &&
							ref.secretId === option.secretRef.secretId &&
							ref.secretVersion === option.secretRef.secretVersion &&
							ref.configRevision === option.secretRef.configRevision,
					),
			)
		)
			throw new WorkloadKubernetesError("policy");
		return modelInjection;
	}
	function workloadEnvironment(value: AgentWorkloadDesiredV1) {
		const injection = modelBindings(value);
		const runtimeAuth =
			injection && policy.runtimeAuth
				? workloadRuntimeAuthEnvironmentV1(policy.runtimeAuth, value)
				: [];
		if (runtimeAuth.some((entry) => Object.hasOwn(value.env, entry.name)))
			throw new WorkloadKubernetesError("policy");
		return [
			...Object.entries(value.env).map(([name, value]) => ({ name, value })),
			...(injection?.env ?? []),
			...runtimeAuth,
		];
	}
	function environmentSecrets(value: AgentWorkloadDesiredV1) {
		modelBindings(value);
		return value.secretRefs.filter(
			(ref) =>
				!modelProjection?.options.some(
					(option) => option.secretRef.name === ref.name,
				),
		);
	}
	function podReferencesSecret(
		pod: V1PodSpec | undefined,
		name: string,
	): boolean {
		return (
			!!pod &&
			([
				...pod.containers,
				...(pod.initContainers ?? []),
				...(pod.ephemeralContainers ?? []),
			].some(
				(container) =>
					container.env?.some(
						(entry) => entry.valueFrom?.secretKeyRef?.name === name,
					) ||
					container.envFrom?.some((entry) => entry.secretRef?.name === name),
			) ||
				(pod.volumes ?? []).some(
					(volume) =>
						volume.secret?.secretName === name ||
						volume.projected?.sources?.some(
							(source) => source.secret?.name === name,
						),
				) ||
				(pod.imagePullSecrets ?? []).some((secret) => secret.name === name))
		);
	}
	function matchesModelSecret(
		value: AgentWorkloadDesiredV1,
		secret: V1Secret | null,
	) {
		const injection = modelBindings(value);
		if (!injection) return true;
		if (!secret) return false;
		own(secret, value.agentId, value.workloadRevision, value.fence);
		return (
			!secret.metadata?.deletionTimestamp &&
			secret.immutable === true &&
			secret.type === "Opaque" &&
			secret.stringData === undefined &&
			hasSameStructure(secret.data, {
				configuration: Buffer.from(injection.configuration).toString("base64"),
			})
		);
	}
	const selector = (agentId: string) =>
		`${ownerLabel}=${workloadResourceNameV1(agentId)}`;
	const isOwnedSecret = (
		secret: V1Secret,
		value: AgentWorkloadDesiredV1,
		ref: AgentWorkloadDesiredV1["secretRefs"][number],
	) =>
		secret.metadata?.name === ref.name &&
		secret.metadata?.annotations?.[agentAnnotation] === value.agentId &&
		secret.metadata?.labels?.[ownerLabel] ===
			workloadResourceNameV1(value.agentId) &&
		secret.metadata?.annotations?.[secretIdAnnotation] === ref.secretId &&
		secret.metadata?.annotations?.[secretVersionAnnotation] ===
			String(ref.secretVersion) &&
		secret.metadata?.annotations?.[secretConfigRevisionAnnotation] ===
			String(ref.configRevision);
	const isLiveOwnedImmutableSecret = (
		secret: V1Secret,
		value: AgentWorkloadDesiredV1,
		ref: AgentWorkloadDesiredV1["secretRefs"][number],
	) =>
		!secret.metadata?.deletionTimestamp &&
		isOwnedSecret(secret, value, ref) &&
		secret.immutable === true &&
		secret.type === "Opaque";
	function desired(input: unknown) {
		const value = validateAgentWorkloadDesiredV1(input);
		const name = workloadResourceNameV1(value.agentId);
		if (
			value.namespaceRef !== policy.namespaceRef ||
			value.resourceProfileRef !== policy.resourceProfileRef ||
			value.persistentVolume.storageProfileRef !== policy.storageProfileRef ||
			value.networkPolicy.deploymentPolicyRef !== policy.networkPolicyRef ||
			value.service.name !== name ||
			value.serviceAccount.name !== name ||
			value.persistentVolume.name !== `${name}-data` ||
			value.route.name !== name ||
			(value.route.exposure === "platform-auth" &&
				!Object.keys(policy.platformAuthAnnotations).length)
		)
			throw new WorkloadKubernetesError("policy");
		return value;
	}
	function metadata(
		value: AgentWorkloadDesiredV1,
		name = workloadResourceNameV1(value.agentId),
	) {
		return {
			name,
			namespace: policy.namespace,
			labels: {
				[ownerLabel]: workloadResourceNameV1(value.agentId),
				[revisionLabel]: String(value.workloadRevision),
			},
			annotations: {
				[agentAnnotation]: value.agentId,
				"agent-infra.agora.io/config-revision": String(value.configRevision),
				"agent-infra.agora.io/fence": String(value.fence),
			},
		};
	}
	function own(
		object: KubernetesObject,
		agentId: string,
		revision: number,
		fence: number,
	) {
		if (
			object.metadata?.annotations?.[agentAnnotation] !== agentId ||
			object.metadata.labels?.[ownerLabel] !== workloadResourceNameV1(agentId)
		)
			throw new WorkloadKubernetesError("policy");
		const revisionValue = object.metadata.labels[revisionLabel];
		const fenceValue =
			object.metadata.annotations["agent-infra.agora.io/fence"];
		if (
			!/^[1-9][0-9]*$/.test(revisionValue ?? "") ||
			!/^[1-9][0-9]*$/.test(fenceValue ?? "")
		)
			throw new WorkloadKubernetesError("conflict");
		const currentRevision = Number(object.metadata.labels[revisionLabel]);
		const currentFence = Number(
			object.metadata.annotations["agent-infra.agora.io/fence"],
		);
		if (
			!Number.isSafeInteger(currentRevision) ||
			currentRevision < 1 ||
			currentRevision > revision ||
			!Number.isSafeInteger(currentFence) ||
			currentFence < 1 ||
			currentFence > fence
		)
			throw new WorkloadKubernetesError("conflict");
	}
	function hasCurrentMetadata(
		object: KubernetesObject,
		value: AgentWorkloadDesiredV1,
	) {
		return (
			object.metadata?.labels?.[revisionLabel] ===
				String(value.workloadRevision) &&
			object.metadata?.annotations?.[secretConfigRevisionAnnotation] ===
				String(value.configRevision) &&
			object.metadata?.annotations?.["agent-infra.agora.io/fence"] ===
				String(value.fence)
		);
	}
	function hasRecoveryMetadata(
		object: KubernetesObject,
		value: AgentWorkloadDesiredV1,
	) {
		const revision = Number(object.metadata?.labels?.[revisionLabel]);
		return (
			Number.isSafeInteger(revision) &&
			revision >= 1 &&
			revision <= value.workloadRevision &&
			object.metadata?.labels?.[ownerLabel] ===
				workloadResourceNameV1(value.agentId) &&
			object.metadata?.annotations?.[agentAnnotation] === value.agentId &&
			object.metadata?.annotations?.[secretConfigRevisionAnnotation] ===
				String(value.configRevision) &&
			object.metadata?.annotations?.["agent-infra.agora.io/fence"] ===
				String(value.fence)
		);
	}
	function hasSafeRoutingMetadata(
		value: AgentWorkloadDesiredV1,
		object: KubernetesObject,
	) {
		const expected = metadata(value);
		return (
			hasSameStructure(object.metadata?.labels, expected.labels) &&
			containsDesired(object.metadata?.annotations, expected.annotations) &&
			Object.keys(object.metadata?.annotations ?? {}).every(
				(key) =>
					key === fingerprintAnnotation ||
					Object.hasOwn(expected.annotations, key),
			)
		);
	}
	function hasSafeServiceAccount(
		value: AgentWorkloadDesiredV1,
		account: V1ServiceAccount,
	) {
		const expected = metadata(value);
		return (
			Object.keys(account).every((key) =>
				[
					"apiVersion",
					"kind",
					"metadata",
					"automountServiceAccountToken",
					"secrets",
					"imagePullSecrets",
				].includes(key),
			) &&
			account.apiVersion === "v1" &&
			account.kind === "ServiceAccount" &&
			account.automountServiceAccountToken === false &&
			(account.secrets?.length ?? 0) === 0 &&
			(account.imagePullSecrets?.length ?? 0) === 0 &&
			hasSameStructure(account.metadata?.labels, expected.labels) &&
			containsDesired(account.metadata?.annotations, expected.annotations) &&
			Object.keys(account.metadata?.annotations ?? {}).every(
				(key) =>
					key === fingerprintAnnotation ||
					Object.hasOwn(expected.annotations, key),
			)
		);
	}

	function hasControllingWorkloadOwner(
		pod: V1Pod,
		workload: V1StatefulSet,
	): boolean {
		return Boolean(
			workload.metadata?.uid &&
				workload.metadata.name &&
				pod.metadata?.ownerReferences?.some(
					(owner) =>
						owner.apiVersion === "apps/v1" &&
						owner.kind === "StatefulSet" &&
						owner.name === workload.metadata?.name &&
						owner.uid === workload.metadata?.uid &&
						owner.controller === true,
				),
		);
	}
	const {
		hasSafePodMetadata,
		hasUnsafePodSpec,
		hasDriftedImmutableStatefulSetSpec,
		hasDriftedStatefulSetSpec,
		normalizeStatefulSetSpecRevision,
		canResumeScaledDownStatefulSet,
		hasDriftedPodSpec,
	} = createKubernetesPodValidationV1({
		policy,
		workloadEnvironment,
		environmentSecrets,
	});

	function serviceSpec(
		value: AgentWorkloadDesiredV1,
		selector: Readonly<Record<string, string>>,
	): NonNullable<V1Service["spec"]> {
		return {
			type: "ClusterIP",
			selector,
			ports: [
				{
					name: "runtime",
					port: value.service.port,
					targetPort: value.service.port,
				},
			],
		};
	}
	function persistentVolumeClaimSpec(): NonNullable<
		V1PersistentVolumeClaim["spec"]
	> {
		return {
			accessModes: ["ReadWriteOnce"],
			...(policy.storageClassName
				? { storageClassName: policy.storageClassName }
				: {}),
			resources: { requests: { storage: policy.storageSize } },
		};
	}
	function matchesPersistentVolumeClaimSpec(
		actual: V1PersistentVolumeClaim["spec"] | undefined,
	): boolean {
		const allowedFields = [
			"accessModes",
			"resources",
			"storageClassName",
			"volumeMode",
			"volumeName",
		];
		if (
			!actual ||
			Object.entries(actual).some(
				([key, value]) => value !== undefined && !allowedFields.includes(key),
			)
		)
			return false;
		const storage = actual?.resources?.requests?.storage;
		const observed =
			typeof storage === "string" ? quantityRatio(storage) : undefined;
		const expected = quantityRatio(policy.storageSize);
		return (
			observed !== undefined &&
			expected !== undefined &&
			observed[0] * expected[1] === expected[0] * observed[1] &&
			containsDesired(
				{
					...actual,
					resources: {
						...actual?.resources,
						requests: {
							...actual?.resources?.requests,
							storage: policy.storageSize,
						},
					},
				},
				persistentVolumeClaimSpec(),
			) &&
			(actual?.volumeMode === undefined ||
				actual.volumeMode === "Filesystem") &&
			actual?.selector === undefined &&
			actual?.dataSource === undefined &&
			actual?.dataSourceRef === undefined
		);
	}
	function ingress(value: AgentWorkloadDesiredV1): V1Ingress {
		const name = workloadResourceNameV1(value.agentId);
		const host = `${name}.${policy.routeHostSuffix}`;
		return {
			apiVersion: "networking.k8s.io/v1",
			kind: "Ingress",
			metadata: {
				...metadata(value),
				annotations: {
					...metadata(value).annotations,
					...(value.route.exposure === "platform-auth"
						? policy.platformAuthAnnotations
						: {}),
				},
			},
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
											name,
											port: { number: value.service.port },
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
	function networkPolicy(value: AgentWorkloadDesiredV1): V1NetworkPolicy {
		const peer = (
			namespace: string,
			labels: Readonly<Record<string, string>>,
		) => ({
			namespaceSelector: {
				matchLabels: { "kubernetes.io/metadata.name": namespace },
			},
			podSelector: { matchLabels: { ...labels } },
		});
		return {
			apiVersion: "networking.k8s.io/v1",
			kind: "NetworkPolicy",
			metadata: metadata(value),
			spec: {
				podSelector: {
					matchLabels: { [ownerLabel]: workloadResourceNameV1(value.agentId) },
				},
				policyTypes: ["Ingress", "Egress"],
				ingress: [
					{
						_from: [
							{ podSelector: { matchLabels: { ...policy.workerSelector } } },
						],
						ports: [{ protocol: "TCP", port: value.service.port }],
					},
					...(value.route.exposure === "internal-only"
						? []
						: [
								{
									_from: [peer(policy.routeNamespace, policy.routeSelector)],
									ports: [{ protocol: "TCP", port: value.service.port }],
								},
							]),
				],
				egress: structuredClone(egress),
			},
		};
	}
	return {
		modelBindings,
		workloadEnvironment,
		environmentSecrets,
		podReferencesSecret,
		matchesModelSecret,
		selector,
		isOwnedSecret,
		isLiveOwnedImmutableSecret,
		desired,
		metadata,
		own,
		hasCurrentMetadata,
		hasRecoveryMetadata,
		hasSafeRoutingMetadata,
		hasSafeServiceAccount,
		hasControllingWorkloadOwner,
		hasSafePodMetadata,
		hasUnsafePodSpec,
		hasDriftedImmutableStatefulSetSpec,
		hasDriftedStatefulSetSpec,
		normalizeStatefulSetSpecRevision,
		canResumeScaledDownStatefulSet,
		serviceSpec,
		persistentVolumeClaimSpec,
		matchesPersistentVolumeClaimSpec,
		ingress,
		hasDriftedPodSpec,
		networkPolicy,
	};
}
