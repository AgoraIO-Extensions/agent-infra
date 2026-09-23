import {
	type AgentWorkloadDesiredV1,
	type SecretActivationFenceV1,
	validateKubernetesReconcileResultV1,
	validateWorkloadCleanupResultV1,
	validateWorkloadRouteSwitchRequestV1,
	validateWorkloadRouteSwitchResultV1,
	WorkloadCleanupRequestV1Schema,
} from "@agent-infra/contracts/workload";
import {
	type RuntimeModelProjectionV1,
	runtimeModelInjectionV1,
	validateRuntimeModelProjectionV1,
} from "@agent-infra/model-catalog";
import type {
	KubernetesObject,
	V1Ingress,
	V1NetworkPolicy,
	V1PersistentVolumeClaim,
	V1Pod,
	V1Secret,
	V1Service,
	V1ServiceAccount,
	V1StatefulSet,
} from "@kubernetes/client-node";
import {
	type WorkerKubernetesClientV1,
	WorkloadKubernetesError,
	type WorkloadResourceKind,
} from "./kubernetes-client.js";
import { createKubernetesWorkloadCleanupV1 } from "./kubernetes-runtime-cleanup.js";
import {
	agentAnnotation,
	agentContainerSecurityContext,
	containsDesired,
	controllerAnnotationPrefix,
	desiredAnnotation,
	fingerprintAnnotation,
	hasClosedSelectorCollision,
	hasSameStructure,
	matchesIngress,
	matchesNetworkPolicySpec,
	matchesServiceSpec,
	modelFingerprintAnnotation,
	ownerLabel,
	type RouteSelectorMode,
	resourceFingerprint,
	revisionLabel,
	routeSelector,
	secretConfigRevisionAnnotation,
	secretFenceAnnotation,
	secretIdAnnotation,
	secretUidAnnotation,
	secretVersionAnnotation,
	workloadResourceNameV1,
} from "./kubernetes-runtime-comparison.js";
import { createKubernetesWorkloadPolicyHelpersV1 } from "./kubernetes-runtime-policy.js";
import {
	type WorkloadEgressPolicyV1,
	workloadEgressRulesV1,
} from "./workload-network.js";
import {
	validateWorkloadRuntimeAuthV1,
	type WorkloadRuntimeAuthV1,
} from "./workload-runtime-auth.js";

export { workloadResourceNameV1 } from "./kubernetes-runtime-comparison.js";

export interface KubernetesWorkloadPolicyV1 extends WorkloadEgressPolicyV1 {
	readonly namespace: string;
	readonly namespaceRef: string;
	readonly resourceProfileRef: string;
	readonly storageProfileRef: string;
	readonly networkPolicyRef: string;
	readonly resources: {
		readonly requests: { readonly cpu: string; readonly memory: string };
		readonly limits: { readonly cpu: string; readonly memory: string };
	};
	readonly storageSize: string;
	readonly storageClassName?: string;
	readonly imageRepository: string;
	readonly workerSelector: Readonly<Record<string, string>>;
	readonly routeNamespace: string;
	readonly routeSelector: Readonly<Record<string, string>>;
	readonly ingressClassName: string;
	readonly routeHostSuffix: string;
	readonly tlsSecretName: string;
	/** Trusted deployment auth integration; applied only to platform-auth routes. */
	readonly platformAuthAnnotations: Readonly<Record<string, string>>;
	readonly runtimeAuth?: WorkloadRuntimeAuthV1;
}

export function createKubernetesRuntimeAdapterV1(options: {
	readonly client: WorkerKubernetesClientV1;
	readonly policy: KubernetesWorkloadPolicyV1;
	/** Supplied from Worker persistent state, never restored from live annotations. */
	readonly modelProjection?: RuntimeModelProjectionV1;
	readonly probe: (input: {
		readonly desired: AgentWorkloadDesiredV1;
		readonly serviceOrigin: string;
	}) => Promise<boolean>;
}) {
	const { client, policy } = options;
	const egress = workloadEgressRulesV1(policy);
	if (policy.runtimeAuth) validateWorkloadRuntimeAuthV1(policy.runtimeAuth);
	const modelProjection =
		options.modelProjection === undefined
			? undefined
			: validateRuntimeModelProjectionV1(options.modelProjection);
	const modelInjection = modelProjection
		? runtimeModelInjectionV1(modelProjection)
		: undefined;
	if (
		client.namespace !== policy.namespace ||
		!Object.keys(policy.workerSelector).length ||
		!Object.keys(policy.routeSelector).length ||
		Object.keys(policy.platformAuthAnnotations).some((key) =>
			key.startsWith(controllerAnnotationPrefix),
		)
	)
		throw new WorkloadKubernetesError("policy");
	const {
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
	} = createKubernetesWorkloadPolicyHelpersV1({
		policy,
		modelProjection,
		modelInjection,
		egress,
	});

	async function put<T extends KubernetesObject>(
		object: T,
		value: AgentWorkloadDesiredV1,
	): Promise<T> {
		const kind = object.kind as WorkloadResourceKind;
		const current = await client.read<T>(kind, object.metadata?.name ?? "");
		if (current) {
			own(current, value.agentId, value.workloadRevision, value.fence);
			if (current.metadata?.deletionTimestamp)
				throw new WorkloadKubernetesError("conflict");
		}
		if (
			current &&
			kind === "StatefulSet" &&
			hasDriftedImmutableStatefulSetSpec(value, (current as V1StatefulSet).spec)
		)
			throw new WorkloadKubernetesError("conflict");
		const hash = resourceFingerprint(object);
		object.metadata = {
			...object.metadata,
			annotations: {
				...object.metadata?.annotations,
				[fingerprintAnnotation]: hash,
			},
		};
		if (!current) return client.create(object);
		if (
			current.metadata?.annotations?.[fingerprintAnnotation] === hash &&
			containsDesired(current, object) &&
			(!["Service", "NetworkPolicy"].includes(kind) ||
				hasSafeRoutingMetadata(value, current)) &&
			(kind !== "ServiceAccount" ||
				hasSafeServiceAccount(value, current as V1ServiceAccount)) &&
			(kind !== "Service" ||
				matchesServiceSpec(
					(current as V1Service).spec,
					(object as V1Service).spec,
				)) &&
			(kind !== "NetworkPolicy" ||
				matchesNetworkPolicySpec(
					(current as V1NetworkPolicy).spec,
					(object as V1NetworkPolicy).spec,
				)) &&
			(kind !== "StatefulSet" ||
				!hasDriftedStatefulSetSpec(value, (current as V1StatefulSet).spec)) &&
			(kind !== "Ingress" ||
				matchesIngress(current as V1Ingress, object as V1Ingress))
		)
			return current;
		const currentServiceSpec =
			kind === "Service" ? (current as V1Service).spec : undefined;
		const secretFenceAnnotations =
			kind === "StatefulSet"
				? Object.fromEntries(
						value.secretRefs.flatMap((ref) => {
							const keys = [
								secretFenceAnnotation(ref.name),
								secretUidAnnotation(ref.name),
							];
							return keys.flatMap((key) => {
								const annotation = current.metadata?.annotations?.[key];
								return annotation === undefined ? [] : [[key, annotation]];
							});
						}),
					)
				: {};
		const next = {
			...(kind === "ServiceAccount" ? {} : current),
			...object,
			metadata:
				kind === "Ingress"
					? {
							...object.metadata,
							resourceVersion: current.metadata?.resourceVersion,
							uid: current.metadata?.uid,
						}
					: {
							...current.metadata,
							...object.metadata,
							annotations: {
								...object.metadata?.annotations,
								...secretFenceAnnotations,
							},
							resourceVersion: current.metadata?.resourceVersion,
							uid: current.metadata?.uid,
						},
		};
		if (kind === "Service")
			(next as V1Service).spec = {
				...(object as V1Service).spec,
				...(currentServiceSpec?.clusterIP === undefined
					? {}
					: { clusterIP: currentServiceSpec.clusterIP }),
				...(currentServiceSpec?.clusterIPs === undefined
					? {}
					: { clusterIPs: currentServiceSpec.clusterIPs }),
				...(currentServiceSpec?.ipFamilies === undefined
					? {}
					: { ipFamilies: currentServiceSpec.ipFamilies }),
				...(currentServiceSpec?.ipFamilyPolicy === undefined
					? {}
					: { ipFamilyPolicy: currentServiceSpec.ipFamilyPolicy }),
			};
		return client.replace(next);
	}
	const {
		remove,
		closeRoute,
		closeAgentAtFence,
		closeAgent,
		cleanupAgentAtFence,
		validateRecoveryCreation,
		recoveryManagementResources,
		recoveryCleanupIsClosed,
		statefulSet,
	} = createKubernetesWorkloadCleanupV1({
		client,
		own,
		desired,
		selector,
		serviceSpec,
	});

	async function observe(
		input: unknown,
		identity: { uid: string; generation: number },
		routeMode: RouteSelectorMode = "closed",
		secretBindingMode: "activation" | "required" = "required",
	): Promise<"pending" | "healthy" | "unhealthy" | "drifted"> {
		const value = desired(input);
		const current = await statefulSet(value);
		const injection = modelBindings(value);
		if (
			injection &&
			(current?.metadata?.annotations?.[modelFingerprintAnnotation] !==
				modelProjection?.fingerprint ||
				!matchesModelSecret(
					value,
					await client.read<V1Secret>("Secret", injection.secretName),
				))
		)
			return "drifted";
		if (
			!current ||
			current.metadata?.deletionTimestamp ||
			current.metadata?.uid !== identity.uid ||
			current.metadata.generation !== identity.generation ||
			current.metadata?.annotations?.[agentAnnotation] !== value.agentId ||
			current.metadata?.annotations?.[secretConfigRevisionAnnotation] !==
				String(value.configRevision) ||
			current.metadata?.annotations?.["agent-infra.agora.io/fence"] !==
				String(value.fence) ||
			current.metadata.labels?.[revisionLabel] !==
				String(value.workloadRevision)
		)
			return "drifted";
		if (hasDriftedStatefulSetSpec(value, current.spec)) return "drifted";
		const name = workloadResourceNameV1(value.agentId);
		const serviceAccount = await client.read<V1ServiceAccount>(
			"ServiceAccount",
			name,
		);
		const network = await client.read<V1NetworkPolicy>("NetworkPolicy", name);
		const probe = await client.read<V1Service>("Service", `${name}-probe`);
		const service = await client.read<V1Service>("Service", name);
		const routeIngress = await client.read<V1Ingress>("Ingress", name);
		const pvc = await client.read<V1PersistentVolumeClaim>(
			"PersistentVolumeClaim",
			value.persistentVolume.name,
		);
		if (!serviceAccount || !network || !probe || !service || !pvc)
			return "drifted";
		if (
			pvc.metadata?.deletionTimestamp ||
			!matchesPersistentVolumeClaimSpec(pvc.spec)
		)
			return "drifted";
		own(pvc, value.agentId, value.workloadRevision, value.fence);
		if (!hasCurrentMetadata(pvc, value)) return "drifted";
		for (const ref of value.secretRefs) {
			const secret = await client.read<V1Secret>("Secret", ref.name);
			if (!secret || !isLiveOwnedImmutableSecret(secret, value, ref))
				return "drifted";
			try {
				own(secret, value.agentId, value.workloadRevision, value.fence);
			} catch {
				return "drifted";
			}
			const boundFence =
				current.metadata.annotations?.[secretFenceAnnotation(ref.name)];
			const boundUid =
				current.metadata.annotations?.[secretUidAnnotation(ref.name)];
			if (
				(secretBindingMode === "required" &&
					(boundFence === undefined || boundUid === undefined)) ||
				(boundFence === undefined) !== (boundUid === undefined) ||
				(boundFence !== undefined &&
					(!Number.isSafeInteger(Number(boundFence)) ||
						Number(boundFence) < 1 ||
						String(Number(boundFence)) !== boundFence)) ||
				(boundUid !== undefined &&
					(!boundUid || secret.metadata?.uid !== boundUid))
			)
				return "drifted";
		}
		for (const resource of [serviceAccount, network, probe, service]) {
			own(resource, value.agentId, value.workloadRevision, value.fence);
			if (!hasCurrentMetadata(resource, value)) return "drifted";
		}
		if (
			[network, probe, service].some(
				(resource) => !hasSafeRoutingMetadata(value, resource),
			)
		)
			return "drifted";
		if (
			(routeMode === "closed" && routeIngress !== null) ||
			(routeMode === "open" &&
				(value.route.exposure === "internal-only"
					? routeIngress !== null
					: !routeIngress || !matchesIngress(routeIngress, ingress(value))))
		)
			return "drifted";
		if (routeIngress) {
			own(routeIngress, value.agentId, value.workloadRevision, value.fence);
			if (!hasCurrentMetadata(routeIngress, value)) return "drifted";
		}
		const podLabels = {
			[ownerLabel]: name,
			[revisionLabel]: String(value.workloadRevision),
		};
		if (
			!hasSafeServiceAccount(value, serviceAccount) ||
			!matchesNetworkPolicySpec(network.spec, networkPolicy(value).spec) ||
			!matchesServiceSpec(probe.spec, serviceSpec(value, podLabels)) ||
			!matchesServiceSpec(
				service.spec,
				serviceSpec(
					value,
					routeSelector(name, value.workloadRevision, routeMode),
				),
			) ||
			!hasSameStructure(probe.spec?.selector, {
				[ownerLabel]: name,
				[revisionLabel]: String(value.workloadRevision),
			}) ||
			!hasSameStructure(
				service.spec?.selector,
				routeSelector(name, value.workloadRevision, routeMode),
			)
		)
			return "drifted";
		const labelledPods = await client.list<V1Pod>(
			"Pod",
			selector(value.agentId),
		);
		if (
			routeMode === "closed" &&
			hasClosedSelectorCollision(labelledPods, name)
		)
			return "drifted";
		const ownedByExpectedWorkload = (pod: V1Pod) =>
			hasControllingWorkloadOwner(pod, current);
		// Services select labels, not ownerReferences. A foreign Pod matching the
		// current revision must not be hidden by the lifecycle ownership filter.
		if (
			labelledPods.some(
				(pod) =>
					!ownedByExpectedWorkload(pod) &&
					pod.metadata?.labels?.[revisionLabel] ===
						String(value.workloadRevision),
			)
		)
			return "drifted";
		const pods = labelledPods.filter(ownedByExpectedWorkload);
		if (pods.length !== 1) return "pending";
		const pod = pods[0];
		if (
			!pod ||
			pod.metadata?.deletionTimestamp ||
			!hasControllingWorkloadOwner(pod, current) ||
			pod.metadata?.labels?.[revisionLabel] !== String(value.workloadRevision)
		)
			return "pending";
		const expectedPodIdentity = {
			hostname: `${name}-0`,
			subdomain: name,
		};
		if (
			!hasSafePodMetadata(value, pod.metadata, { pod, workload: current }) ||
			hasUnsafePodSpec(pod.spec, expectedPodIdentity)
		)
			return "drifted";
		const container = pod.spec?.containers.find(
			(entry) => entry.name === "agent",
		);
		const refs =
			container?.envFrom?.map((entry) => entry.secretRef?.name).sort() ?? [];
		if (
			container?.image !== `${policy.imageRepository}@${value.imageDigest}` ||
			!hasSameStructure(
				refs,
				environmentSecrets(value)
					.map((ref) => ref.name)
					.sort(),
			) ||
			pod.spec?.automountServiceAccountToken !== false
		)
			return "unhealthy";
		if (hasDriftedPodSpec(value, pod.spec, expectedPodIdentity))
			return "drifted";
		if (
			current.status?.observedGeneration !== identity.generation ||
			current.status.readyReplicas !== 1 ||
			!pod.status?.conditions?.some(
				(condition) =>
					condition.type === "Ready" && condition.status === "True",
			) ||
			!pod.status.podIP
		)
			return "pending";
		try {
			return (await options.probe({
				desired: value,
				serviceOrigin: `http://${workloadResourceNameV1(value.agentId)}-probe.${policy.namespace}.svc:${value.service.port}`,
			}))
				? "healthy"
				: "unhealthy";
		} catch {
			return "unhealthy";
		}
	}
	const adapter = {
		capabilities: () =>
			({
				schemaVersion: 1,
				statefulSetApiVersion: "apps/v1",
				coreApiVersion: "v1",
				networkingApiVersion: "networking.k8s.io/v1",
				routeKind: "ingress",
				namespaceScoped: true,
			}) as const,
		closeRoute,
		closeAgent,
		observe,
		/** Adoption verifies the persisted creation, independently of readiness. */
		async observeRecoveryWorkload(
			input: unknown,
			identity: { uid: string; generation: number } | null,
			management?: { revision: number; fence: number },
		) {
			const value = desired(input);
			const managementValue = management
				? desired({
						...value,
						workloadRevision: management.revision,
						fence: management.fence,
					})
				: value;
			validateRecoveryCreation(managementValue, {
				revision: value.workloadRevision,
				fence: value.fence,
			});
			await recoveryManagementResources(managementValue);
			const current = await statefulSet(value);
			const pods = await client.list<V1Pod>("Pod", selector(value.agentId));
			if (!current) {
				if (pods.length) throw new WorkloadKubernetesError("conflict");
				return null;
			}
			if (!current.metadata?.uid || !current.metadata.resourceVersion)
				throw new WorkloadKubernetesError("conflict");
			const recoveryInvalid =
				!Number.isSafeInteger(current.metadata.generation) ||
				(current.metadata.generation ?? 0) < 1 ||
				current.metadata.deletionTimestamp ||
				(!hasCurrentMetadata(current, value) &&
					(!management || !hasRecoveryMetadata(current, value))) ||
				hasDriftedImmutableStatefulSetSpec(value, current.spec) ||
				(!canResumeScaledDownStatefulSet(value, current.spec) &&
					hasDriftedStatefulSetSpec(value, {
						...normalizeStatefulSetSpecRevision(
							current.spec,
							value.workloadRevision,
						),
						replicas: value.replicas,
					} as V1StatefulSet["spec"])) ||
				(identity &&
					(!identity.uid ||
						!Number.isSafeInteger(identity.generation) ||
						identity.generation < 1 ||
						current.metadata.uid !== identity.uid ||
						(current.metadata.generation ?? 0) < identity.generation)) ||
				pods.some((pod) => !hasControllingWorkloadOwner(pod, current));
			if (recoveryInvalid) throw new WorkloadKubernetesError("conflict");
			return {
				uid: current.metadata.uid,
				generation: current.metadata.generation ?? 1,
			};
		},
		async removeRecoveryWorkload(
			input: unknown,
			identity: { uid: string; generation: number } | null,
			creation: { revision: number; fence: number },
		) {
			const value = desired(input);
			validateRecoveryCreation(value, creation);
			if (!(await recoveryCleanupIsClosed(value))) return false;
			const name = workloadResourceNameV1(value.agentId);
			const current = await client.read<V1StatefulSet>("StatefulSet", name);
			if (current) {
				// The persisted recovery creation may predate a newer management fence;
				// ownership accepts both while the exact creation labels below protect deletion.
				const ownershipRevision = Math.max(
					value.workloadRevision,
					creation.revision,
				);
				const ownershipFence = Math.max(value.fence, creation.fence);
				own(current, value.agentId, ownershipRevision, ownershipFence);
				if (
					!identity?.uid ||
					!Number.isSafeInteger(identity.generation) ||
					identity.generation < 1 ||
					current.metadata?.uid !== identity.uid ||
					!current.metadata.resourceVersion ||
					current.metadata.labels?.[revisionLabel] !==
						String(creation.revision) ||
					current.metadata.annotations?.["agent-infra.agora.io/fence"] !==
						String(creation.fence) ||
					!Number.isSafeInteger(current.metadata.generation) ||
					(current.metadata.generation ?? 0) < identity.generation ||
					hasDriftedImmutableStatefulSetSpec(value, current.spec) ||
					(current.spec?.persistentVolumeClaimRetentionPolicy?.whenDeleted ??
						"Retain") !== "Retain" ||
					(current.spec?.persistentVolumeClaimRetentionPolicy?.whenScaled ??
						"Retain") !== "Retain"
				)
					return false;
				const pods = await client.list<V1Pod>("Pod", selector(value.agentId));
				if (pods.some((pod) => !hasControllingWorkloadOwner(pod, current)))
					return false;
				// The client sends both the observed UID and resourceVersion as
				// Kubernetes deletion preconditions; PVCs are never deleted here.
				await client.delete(current);
			}
			return (
				(await client.read("StatefulSet", name)) === null &&
				(await client.list("Pod", selector(value.agentId))).length === 0
			);
		},
		async removeRecoverySecret(
			input: unknown,
			reference: AgentWorkloadDesiredV1["secretRefs"][number],
			secretUid: string,
			creation: { revision: number; fence: number },
		) {
			const value = desired(input);
			validateRecoveryCreation(value, creation);
			if (
				!value.secretRefs.some((ref) => hasSameStructure(ref, reference)) ||
				!secretUid
			)
				throw new WorkloadKubernetesError("policy");
			if (!(await recoveryCleanupIsClosed(value))) return false;
			if (
				await client.read("StatefulSet", workloadResourceNameV1(value.agentId))
			)
				return false;
			if ((await client.list("Pod", selector(value.agentId))).length)
				return false;
			const secret = await client.read<V1Secret>("Secret", reference.name);
			if (!secret) return true;
			own(secret, value.agentId, value.workloadRevision, value.fence);
			if (
				secret.metadata?.uid !== secretUid ||
				!secret.metadata.resourceVersion ||
				secret.metadata.labels?.[revisionLabel] !== String(creation.revision) ||
				secret.metadata.annotations?.["agent-infra.agora.io/fence"] !==
					String(creation.fence) ||
				!isLiveOwnedImmutableSecret(secret, value, reference)
			)
				return false;
			await client.delete(secret);
			return (await client.read("Secret", reference.name)) === null;
		},
		async scaleDownAgent(
			agentId: string,
			workloadRevision: number,
			fence: number,
		): Promise<{ uid: string; generation: number } | "pending" | null> {
			const name = workloadResourceNameV1(agentId);
			const [current, ...existingResources] = await Promise.all([
				client.read<V1StatefulSet>("StatefulSet", name),
				client.read("PersistentVolumeClaim", `${name}-data`),
				client.read("Service", name),
				client.read("Service", `${name}-probe`),
				client.read("ServiceAccount", name),
				client.read("NetworkPolicy", name),
				client.read("Ingress", name),
			]);
			for (const resource of [current, ...existingResources]) {
				if (resource) own(resource, agentId, workloadRevision, fence);
			}
			if (!current) {
				const pvc = await client.read<V1PersistentVolumeClaim>(
					"PersistentVolumeClaim",
					`${name}-data`,
				);
				if (pvc) {
					own(pvc, agentId, workloadRevision, fence);
					if (
						pvc.metadata?.labels?.[revisionLabel] !==
							String(workloadRevision) ||
						pvc.metadata?.annotations?.["agent-infra.agora.io/fence"] !==
							String(fence)
					)
						await client.replace({
							...pvc,
							metadata: {
								...pvc.metadata,
								labels: {
									...pvc.metadata?.labels,
									[revisionLabel]: String(workloadRevision),
								},
								annotations: {
									...pvc.metadata?.annotations,
									"agent-infra.agora.io/fence": String(fence),
									[fingerprintAnnotation]: "",
								},
							},
						});
				}
				return (await client.list("Pod", selector(agentId))).length
					? "pending"
					: null;
			}
			own(current, agentId, workloadRevision, fence);
			const needsScaleDown = current.spec?.replicas !== 0;
			const needsFence =
				current.metadata?.labels?.[revisionLabel] !==
					String(workloadRevision) ||
				current.metadata?.annotations?.["agent-infra.agora.io/fence"] !==
					String(fence);
			const fenced =
				needsScaleDown || needsFence
					? await client.replace({
							...current,
							metadata: {
								...current.metadata,
								labels: {
									...current.metadata?.labels,
									[revisionLabel]: String(workloadRevision),
								},
								annotations: {
									...current.metadata?.annotations,
									"agent-infra.agora.io/fence": String(fence),
									[fingerprintAnnotation]: "",
								},
							},
							spec: { ...current.spec, replicas: 0 },
						} as V1StatefulSet)
					: current;
			if (needsScaleDown) return "pending";
			if ((await client.list("Pod", selector(agentId))).length)
				return "pending";
			return fenced.metadata?.uid
				? {
						uid: fenced.metadata.uid,
						generation: fenced.metadata.generation ?? 1,
					}
				: null;
		},
		async bindSecretFence(
			input: unknown,
			identity: { uid: string; generation: number },
			secretName: string,
			fence: number,
			expectedSecretUid: string,
		) {
			const value = desired(input);
			const current = await statefulSet(value);
			const ref = value.secretRefs.find(
				(candidate) => candidate.name === secretName,
			);
			if (
				!current ||
				current.metadata?.uid !== identity.uid ||
				current.metadata.generation !== identity.generation ||
				!ref ||
				!Number.isSafeInteger(fence) ||
				fence < 1 ||
				!expectedSecretUid
			)
				throw new WorkloadKubernetesError("conflict");
			const secret = await client.read<V1Secret>("Secret", secretName);
			if (
				!secret ||
				secret.metadata?.uid !== expectedSecretUid ||
				!isLiveOwnedImmutableSecret(secret, value, ref)
			)
				throw new WorkloadKubernetesError("conflict");
			own(secret, value.agentId, value.workloadRevision, value.fence);
			const fenceKey = secretFenceAnnotation(secretName);
			const uidKey = secretUidAnnotation(secretName);
			const storedFence = current.metadata.annotations?.[fenceKey];
			const storedUid = current.metadata.annotations?.[uidKey];
			if (storedFence !== undefined) {
				const parsedFence = Number(storedFence);
				if (
					!Number.isSafeInteger(parsedFence) ||
					parsedFence < 1 ||
					parsedFence > fence
				)
					throw new WorkloadKubernetesError("conflict");
			}
			if (storedUid !== undefined && storedUid !== expectedSecretUid)
				throw new WorkloadKubernetesError("conflict");
			if (
				current.metadata.annotations?.[fenceKey] === String(fence) &&
				current.metadata.annotations?.[uidKey] === expectedSecretUid &&
				current.metadata.labels?.[revisionLabel] ===
					String(value.workloadRevision) &&
				current.metadata.annotations?.["agent-infra.agora.io/fence"] ===
					String(value.fence)
			)
				return;
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
						[fenceKey]: String(fence),
						[uidKey]: expectedSecretUid,
					},
				},
			});
		},
		async observeSecretFence(
			input: unknown,
			identity: { uid: string; generation: number },
			secretName: string,
			fence: number,
		) {
			const value = desired(input);
			const current = await statefulSet(value);
			const fenceKey = secretFenceAnnotation(secretName);
			const uidKey = secretUidAnnotation(secretName);
			const expectedSecretUid = current?.metadata?.annotations?.[uidKey];
			const ref = value.secretRefs.find(
				(candidate) => candidate.name === secretName,
			);
			const secret = ref
				? await client.read<V1Secret>("Secret", secretName)
				: null;
			return (
				current?.metadata?.annotations?.[fenceKey] === String(fence) &&
				Boolean(
					expectedSecretUid &&
						secret?.metadata?.uid === expectedSecretUid &&
						ref &&
						isLiveOwnedImmutableSecret(secret, value, ref),
				) &&
				(await observe(value, identity, "closed", "activation")) === "healthy"
			);
		},
		async observeActiveImmutableSecret(
			input: unknown,
			ref: AgentWorkloadDesiredV1["secretRefs"][number],
			activationFence: SecretActivationFenceV1,
		): Promise<boolean> {
			const value = desired(input);
			if (
				!value.secretRefs.some(
					(candidate) =>
						candidate.agentId === ref.agentId &&
						candidate.secretId === ref.secretId &&
						candidate.secretVersion === ref.secretVersion &&
						candidate.configRevision === ref.configRevision &&
						candidate.ownerType === ref.ownerType &&
						candidate.ownerId === ref.ownerId &&
						candidate.wrappingKeyVersion === ref.wrappingKeyVersion &&
						candidate.name === ref.name,
				) ||
				activationFence.agentId !== ref.agentId ||
				activationFence.secretId !== ref.secretId ||
				activationFence.secretVersion !== ref.secretVersion ||
				activationFence.configRevision !== ref.configRevision ||
				activationFence.kubernetesSecretName !== ref.name
			)
				return false;
			const current = await client.read<V1StatefulSet>(
				"StatefulSet",
				workloadResourceNameV1(value.agentId),
			);
			const fenceKey = secretFenceAnnotation(ref.name);
			const uidKey = secretUidAnnotation(ref.name);
			const expectedSecretUid = current?.metadata?.annotations?.[uidKey];
			if (
				!current ||
				current.metadata?.uid !== activationFence.workloadUid ||
				!Number.isSafeInteger(current.metadata.generation) ||
				(current.metadata.generation ?? 0) <
					activationFence.workloadGeneration ||
				current.metadata?.annotations?.[fenceKey] !==
					String(activationFence.fence) ||
				!expectedSecretUid
			)
				return false;
			try {
				own(current, value.agentId, value.workloadRevision, value.fence);
			} catch {
				return false;
			}
			const secret = await client.read<V1Secret>("Secret", ref.name);
			return Boolean(
				secret?.metadata?.uid === expectedSecretUid &&
					isLiveOwnedImmutableSecret(secret, value, ref),
			);
		},
		async applyImmutableSecret(
			input: unknown,
			name: string,
			key: string,
			plaintext: Uint8Array,
			activationFence?: SecretActivationFenceV1,
		) {
			const value = desired(input);
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
				throw new WorkloadKubernetesError("policy");
			const ref = value.secretRefs.find((entry) => entry.name === name);
			if (!ref) throw new WorkloadKubernetesError("policy");
			let activeBinding:
				| {
						readonly workload: V1StatefulSet;
						readonly uidKey: string;
				  }
				| undefined;
			if (activationFence) {
				if (
					activationFence.schemaVersion !== 1 ||
					typeof activationFence.workloadUid !== "string" ||
					!activationFence.workloadUid ||
					!Number.isSafeInteger(activationFence.workloadGeneration) ||
					activationFence.workloadGeneration < 1 ||
					!Number.isSafeInteger(activationFence.fence) ||
					activationFence.fence < 1 ||
					activationFence.agentId !== ref.agentId ||
					activationFence.secretId !== ref.secretId ||
					activationFence.secretVersion !== ref.secretVersion ||
					activationFence.configRevision !== ref.configRevision ||
					activationFence.kubernetesSecretName !== ref.name
				)
					throw new WorkloadKubernetesError("conflict");
				const workload = await statefulSet(value);
				const fenceKey = secretFenceAnnotation(ref.name);
				const uidKey = secretUidAnnotation(ref.name);
				const storedUid = workload?.metadata?.annotations?.[uidKey];
				if (
					!workload ||
					workload.metadata?.uid !== activationFence.workloadUid ||
					!workload.metadata.resourceVersion ||
					!Number.isSafeInteger(workload.metadata.generation) ||
					(workload.metadata.generation ?? 0) <
						activationFence.workloadGeneration ||
					workload.metadata.annotations?.[fenceKey] !==
						String(activationFence.fence) ||
					storedUid === ""
				)
					throw new WorkloadKubernetesError("conflict");
				activeBinding = { workload, uidKey };
			}
			const body: V1Secret = {
				apiVersion: "v1",
				kind: "Secret",
				metadata: {
					...metadata(value, ref.name),
					annotations: {
						...metadata(value, ref.name).annotations,
						[secretIdAnnotation]: ref.secretId,
						[secretVersionAnnotation]: String(ref.secretVersion),
						[secretConfigRevisionAnnotation]: String(ref.configRevision),
					},
				},
				immutable: true,
				type: "Opaque",
				data: { [key]: Buffer.from(plaintext).toString("base64") },
			};
			const bindActiveSecretUid = async (secretUid: string) => {
				if (!activeBinding) return;
				const live = await client.read<V1Secret>("Secret", ref.name);
				if (
					live?.metadata?.uid !== secretUid ||
					!isLiveOwnedImmutableSecret(live, value, ref) ||
					!hasSameStructure(live.data, body.data)
				)
					throw new WorkloadKubernetesError("conflict");
				own(live, value.agentId, value.workloadRevision, value.fence);
				if (
					activeBinding.workload.metadata?.annotations?.[
						activeBinding.uidKey
					] === secretUid
				)
					return;
				await client.replace({
					...activeBinding.workload,
					metadata: {
						...activeBinding.workload.metadata,
						annotations: {
							...activeBinding.workload.metadata?.annotations,
							[activeBinding.uidKey]: secretUid,
						},
					},
				});
			};
			const existing = await client.read<V1Secret>("Secret", ref.name);
			if (!existing) {
				const created = await client.create(body);
				const live = created.metadata?.uid
					? created
					: await client.read<V1Secret>("Secret", ref.name);
				if (
					!live?.metadata?.uid ||
					!isLiveOwnedImmutableSecret(live, value, ref) ||
					!hasSameStructure(live.data, body.data)
				)
					throw new WorkloadKubernetesError("conflict");
				await bindActiveSecretUid(live.metadata.uid);
				return live.metadata.uid;
			}
			if (
				!isLiveOwnedImmutableSecret(existing, value, ref) ||
				!hasSameStructure(existing.data, body.data)
			)
				throw new WorkloadKubernetesError("conflict");
			own(existing, value.agentId, value.workloadRevision, value.fence);
			const live =
				existing.metadata?.labels?.[revisionLabel] !==
					String(value.workloadRevision) ||
				existing.metadata?.annotations?.["agent-infra.agora.io/fence"] !==
					String(value.fence)
					? await client.replace({
							...existing,
							metadata: {
								...existing.metadata,
								labels: {
									...existing.metadata?.labels,
									[revisionLabel]: String(value.workloadRevision),
								},
								annotations: {
									...existing.metadata?.annotations,
									"agent-infra.agora.io/fence": String(value.fence),
								},
							},
						})
					: existing;
			if (!live.metadata?.uid) throw new WorkloadKubernetesError("conflict");
			await bindActiveSecretUid(live.metadata.uid);
			return live.metadata.uid;
		},
		async apply(
			input: unknown,
		): Promise<{ uid: string; generation: number } | "pending" | null> {
			const value = desired(input);
			const name = workloadResourceNameV1(value.agentId);
			const current = await statefulSet(value);
			// Reject stale work before any partial creation or scale-down. Per-write
			// ownership and resourceVersion checks still protect subsequent races.
			const existingPvc = await client.read<V1PersistentVolumeClaim>(
				"PersistentVolumeClaim",
				value.persistentVolume.name,
			);
			const existingResources = await Promise.all([
				client.read("Service", name),
				client.read("Service", `${name}-probe`),
				client.read("ServiceAccount", name),
				client.read("NetworkPolicy", name),
			]);
			for (const resource of [current, existingPvc, ...existingResources]) {
				if (!resource) continue;
				own(resource, value.agentId, value.workloadRevision, value.fence);
				if (resource.metadata?.deletionTimestamp)
					throw new WorkloadKubernetesError("conflict");
			}
			if (current && hasDriftedImmutableStatefulSetSpec(value, current.spec))
				throw new WorkloadKubernetesError("conflict");
			if (existingPvc && !matchesPersistentVolumeClaimSpec(existingPvc.spec))
				throw new WorkloadKubernetesError("conflict");
			if (!current && value.replicas === 0) {
				const pvc = await client.read<V1PersistentVolumeClaim>(
					"PersistentVolumeClaim",
					value.persistentVolume.name,
				);
				if (pvc) {
					own(pvc, value.agentId, value.workloadRevision, value.fence);
					if (
						pvc.metadata?.labels?.[revisionLabel] !==
							String(value.workloadRevision) ||
						pvc.metadata?.annotations?.["agent-infra.agora.io/fence"] !==
							String(value.fence)
					)
						await client.replace({
							...pvc,
							metadata: {
								...pvc.metadata,
								labels: {
									...pvc.metadata?.labels,
									[revisionLabel]: String(value.workloadRevision),
								},
								annotations: {
									...pvc.metadata?.annotations,
									"agent-infra.agora.io/fence": String(value.fence),
									[fingerprintAnnotation]: "",
								},
							},
						});
				}
				return null;
			}
			const pods = await client.list<V1Pod>("Pod", selector(value.agentId));
			if (hasClosedSelectorCollision(pods, name)) {
				await remove("Service", name, value);
				return "pending";
			}
			const ownedPods = current?.metadata?.uid
				? pods.filter((pod) => hasControllingWorkloadOwner(pod, current))
				: [];
			const driftedOwnedPod =
				current &&
				pods.some(
					(pod) =>
						hasControllingWorkloadOwner(pod, current) &&
						(!hasSafePodMetadata(value, pod.metadata, {
							pod,
							workload: current,
						}) ||
							hasDriftedPodSpec(value, pod.spec, {
								hostname: `${name}-0`,
								subdomain: name,
							})),
				);
			const changing =
				current &&
				current.spec?.template.metadata?.labels?.[revisionLabel] !==
					String(value.workloadRevision);
			if (
				current &&
				(changing || driftedOwnedPod || value.replicas === 0) &&
				(current.spec?.replicas !== 0 || ownedPods.length > 0)
			) {
				if (
					current.spec?.replicas !== 0 ||
					current.metadata?.labels?.[revisionLabel] !==
						String(value.workloadRevision) ||
					current.metadata?.annotations?.["agent-infra.agora.io/fence"] !==
						String(value.fence)
				)
					await client.replace({
						...current,
						metadata: {
							...current.metadata,
							labels: {
								...current.metadata?.labels,
								[revisionLabel]: String(value.workloadRevision),
							},
							annotations: {
								...current.metadata?.annotations,
								"agent-infra.agora.io/fence": String(value.fence),
								[fingerprintAnnotation]: "",
							},
						},
						spec: { ...current.spec, replicas: 0 },
					} as V1StatefulSet);
				return "pending";
			}
			if (value.replicas === 0) {
				const fenced =
					current &&
					(current.metadata?.labels?.[revisionLabel] !==
						String(value.workloadRevision) ||
						current.metadata?.annotations?.["agent-infra.agora.io/fence"] !==
							String(value.fence))
						? await client.replace({
								...current,
								metadata: {
									...current.metadata,
									labels: {
										...current.metadata?.labels,
										[revisionLabel]: String(value.workloadRevision),
									},
									annotations: {
										...current.metadata?.annotations,
										"agent-infra.agora.io/fence": String(value.fence),
										[fingerprintAnnotation]: "",
									},
								},
							} as V1StatefulSet)
						: current;
				return fenced?.metadata?.uid
					? {
							uid: fenced.metadata.uid,
							generation: fenced.metadata.generation ?? 1,
						}
					: null;
			}
			const podLabels = {
				[ownerLabel]: name,
				[revisionLabel]: String(value.workloadRevision),
			};
			const service: V1Service = {
				apiVersion: "v1",
				kind: "Service",
				metadata: metadata(value),
				spec: serviceSpec(value, {
					[ownerLabel]: name,
					[revisionLabel]: "closed",
				}),
			};
			await put(service, value);
			await put<V1Service>(
				{
					apiVersion: "v1",
					kind: "Service",
					metadata: metadata(value, `${name}-probe`),
					spec: serviceSpec(value, podLabels),
				},
				value,
			);
			await put<V1ServiceAccount>(
				{
					apiVersion: "v1",
					kind: "ServiceAccount",
					metadata: metadata(value),
					automountServiceAccountToken: false,
				},
				value,
			);
			const pvc = await client.read<V1PersistentVolumeClaim>(
				"PersistentVolumeClaim",
				value.persistentVolume.name,
			);
			if (pvc) {
				own(pvc, value.agentId, value.workloadRevision, value.fence);
				if (
					pvc.metadata?.deletionTimestamp ||
					!matchesPersistentVolumeClaimSpec(pvc.spec)
				)
					throw new WorkloadKubernetesError("conflict");
				const desiredMetadata = metadata(value, value.persistentVolume.name);
				if (
					pvc.metadata?.labels?.[revisionLabel] !==
						String(value.workloadRevision) ||
					pvc.metadata?.annotations?.["agent-infra.agora.io/fence"] !==
						String(value.fence)
				) {
					await client.replace({
						...pvc,
						metadata: {
							...pvc.metadata,
							labels: {
								...pvc.metadata?.labels,
								...desiredMetadata.labels,
							},
							annotations: {
								...pvc.metadata?.annotations,
								...desiredMetadata.annotations,
							},
						},
					});
				}
			} else
				await put<V1PersistentVolumeClaim>(
					{
						apiVersion: "v1",
						kind: "PersistentVolumeClaim",
						metadata: metadata(value, value.persistentVolume.name),
						spec: persistentVolumeClaimSpec(),
					},
					value,
				);
			await put(networkPolicy(value), value);
			const injection = modelBindings(value);
			if (injection) {
				const existing = await client.read<V1Secret>(
					"Secret",
					injection.secretName,
				);
				if (existing && !matchesModelSecret(value, existing))
					throw new WorkloadKubernetesError("conflict");
				await put<V1Secret>(
					{
						apiVersion: "v1",
						kind: "Secret",
						metadata: metadata(value, injection.secretName),
						immutable: true,
						type: "Opaque",
						data: {
							configuration: Buffer.from(injection.configuration).toString(
								"base64",
							),
						},
					},
					value,
				);
				if (
					!matchesModelSecret(
						value,
						await client.read<V1Secret>("Secret", injection.secretName),
					)
				)
					throw new WorkloadKubernetesError("conflict");
			}
			const workload: V1StatefulSet = {
				apiVersion: "apps/v1",
				kind: "StatefulSet",
				metadata: {
					...metadata(value),
					annotations: {
						...metadata(value).annotations,
						[desiredAnnotation]: JSON.stringify(value),
						...(modelProjection
							? { [modelFingerprintAnnotation]: modelProjection.fingerprint }
							: {}),
					},
				},
				spec: {
					serviceName: name,
					replicas: 1,
					selector: { matchLabels: { [ownerLabel]: name } },
					updateStrategy: { type: "RollingUpdate" },
					template: {
						metadata: { labels: podLabels },
						spec: {
							serviceAccountName: name,
							automountServiceAccountToken: false,
							securityContext: {
								runAsNonRoot: true,
								runAsUser: 1000,
								runAsGroup: 1000,
								fsGroup: 1000,
								seccompProfile: { type: "RuntimeDefault" },
							},
							containers: [
								{
									name: "agent",
									image: `${policy.imageRepository}@${value.imageDigest}`,
									resources: structuredClone(policy.resources),
									ports: [
										{ name: "runtime", containerPort: value.service.port },
									],
									env: workloadEnvironment(value),
									envFrom: environmentSecrets(value).map((ref) => ({
										secretRef: { name: ref.name },
									})),
									readinessProbe: {
										httpGet: {
											path: value.health.path,
											port: value.service.port,
										},
										timeoutSeconds: value.health.timeoutSeconds,
										failureThreshold: value.health.failureThreshold,
									},
									securityContext: agentContainerSecurityContext(),
									volumeMounts: [
										{
											name: "data",
											mountPath: value.persistentVolume.mountPath,
										},
										{ name: "runtime-tmp", mountPath: "/tmp" },
									],
								},
							],
							volumes: [
								{
									name: "data",
									persistentVolumeClaim: {
										claimName: value.persistentVolume.name,
									},
								},
								{
									name: "runtime-tmp",
									emptyDir: { medium: "Memory", sizeLimit: "128Mi" },
								},
							],
						},
					},
				},
			};
			const applied = await put(workload, value);
			if (!applied.metadata?.uid || !applied.metadata.generation)
				throw new WorkloadKubernetesError("unavailable");
			return {
				uid: applied.metadata.uid,
				generation: applied.metadata.generation,
			};
		},
		async promote(
			input: unknown,
			identity: { uid: string; generation: number },
			routeMode: RouteSelectorMode = "closed",
		) {
			const value = desired(input);
			if ((await observe(value, identity, routeMode, "required")) !== "healthy")
				throw new WorkloadKubernetesError("conflict");
			const name = workloadResourceNameV1(value.agentId);
			if (value.route.exposure === "internal-only") {
				if (!(await remove("Ingress", name, value)))
					throw new WorkloadKubernetesError("unavailable");
			} else await put(ingress(value), value);
			await put<V1Service>(
				{
					apiVersion: "v1",
					kind: "Service",
					metadata: metadata(value),
					spec: serviceSpec(
						value,
						routeSelector(name, value.workloadRevision, "open"),
					),
				},
				value,
			);
		},
		async cleanupAgent(
			agentId: string,
			workloadRevision: number,
			fence: number,
			deleteNewVolume: boolean,
		) {
			return cleanupAgentAtFence(
				{ agentId, workloadRevision, fence },
				deleteNewVolume,
			);
		},
		/** Worker authorizes only a rejected candidate, never a retained verified projection. */
		async removeModelConfiguration(input: unknown): Promise<boolean> {
			const value = desired(input);
			const injection = modelBindings(value);
			if (!injection) return true;
			const secret = await client.read<V1Secret>(
				"Secret",
				injection.secretName,
			);
			if (!secret) return true;
			if (
				!matchesModelSecret(value, secret) ||
				secret.metadata?.annotations?.[secretConfigRevisionAnnotation] !==
					String(value.configRevision)
			)
				throw new WorkloadKubernetesError("conflict");
			if (!(await closeAgentAtFence(value))) return false;
			if (
				(await adapter.scaleDownAgent(
					value.agentId,
					value.workloadRevision,
					value.fence,
				)) === "pending"
			)
				return false;
			const current = await statefulSet(value);
			if (current) {
				if (current.spec?.replicas !== 0 || !current.spec.template.spec)
					return false;
				const next = structuredClone(current);
				const pod = next.spec?.template.spec;
				if (!pod) return false;
				for (const container of pod.containers) {
					container.env = container.env?.filter(
						(entry) =>
							!(
								container.name === "agent" &&
								entry.name === "AGENT_INFRA_RUNTIME_MODEL_CONFIG" &&
								entry.valueFrom?.secretKeyRef?.name === injection.secretName
							),
					);
				}
				// Any other reference is unexpected; do not reclaim material still in use.
				if (podReferencesSecret(pod, injection.secretName)) return false;
				if (!hasSameStructure(current.spec, next.spec))
					await client.replace(next);
			}
			const live = await statefulSet(value);
			if (
				(live &&
					(live.spec?.replicas !== 0 ||
						podReferencesSecret(
							live.spec?.template.spec,
							injection.secretName,
						))) ||
				(await client.list("Pod", selector(value.agentId))).length > 0
			)
				return false;
			// client.delete supplies UID/resourceVersion preconditions from the exact read above.
			await client.delete(secret);
			return (await client.read("Secret", injection.secretName)) === null;
		},
		async removeImmutableSecret(
			input: unknown,
			ref: AgentWorkloadDesiredV1["secretRefs"][number],
			activationFence?: SecretActivationFenceV1,
		): Promise<boolean> {
			const value = desired(input);
			if (
				!value.secretRefs.some(
					(candidate) =>
						candidate.agentId === ref.agentId &&
						candidate.secretId === ref.secretId &&
						candidate.secretVersion === ref.secretVersion &&
						candidate.configRevision === ref.configRevision &&
						candidate.ownerType === ref.ownerType &&
						candidate.ownerId === ref.ownerId &&
						candidate.wrappingKeyVersion === ref.wrappingKeyVersion &&
						candidate.name === ref.name,
				)
			)
				throw new WorkloadKubernetesError("policy");
			let expectedSecretUid: string | undefined;
			if (activationFence) {
				const current = await statefulSet(value);
				const fenceKey = secretFenceAnnotation(ref.name);
				const uidKey = secretUidAnnotation(ref.name);
				expectedSecretUid = current?.metadata?.annotations?.[uidKey];
				if (
					activationFence.agentId !== ref.agentId ||
					activationFence.secretId !== ref.secretId ||
					activationFence.secretVersion !== ref.secretVersion ||
					activationFence.configRevision !== ref.configRevision ||
					activationFence.kubernetesSecretName !== ref.name ||
					!current ||
					current.metadata?.uid !== activationFence.workloadUid ||
					!Number.isSafeInteger(current.metadata.generation) ||
					(current.metadata.generation ?? 0) <
						activationFence.workloadGeneration ||
					current.metadata.annotations?.[fenceKey] !==
						String(activationFence.fence) ||
					!expectedSecretUid
				)
					return false;
			}
			const secret = await client.read<V1Secret>("Secret", ref.name);
			if (!secret) return true;
			if (
				activationFence &&
				(secret.metadata?.uid !== expectedSecretUid ||
					!isLiveOwnedImmutableSecret(secret, value, ref))
			)
				return false;
			if (
				!isOwnedSecret(secret, value, ref) ||
				secret.immutable !== true ||
				secret.type !== "Opaque"
			)
				throw new WorkloadKubernetesError("policy");
			own(secret, value.agentId, value.workloadRevision, value.fence);
			await client.delete(secret);
			return (await client.read<V1Secret>("Secret", ref.name)) === null;
		},
	};
	return {
		...adapter,
		async reconcile(input: unknown) {
			const value = desired(input);
			const correlation = {
				schemaVersion: 1,
				requestId: value.requestId,
				traceId: value.traceId,
				agentId: value.agentId,
				configRevision: value.configRevision,
				workloadRevision: value.workloadRevision,
				fence: value.fence,
			};
			try {
				if (value.replicas === 0 && !(await closeRoute(value)))
					throw new WorkloadKubernetesError("unavailable");
				const identity = await adapter.apply(value);
				if (
					identity === null &&
					value.desiredState === "stopped" &&
					value.replicas === 0
				) {
					if (
						(await statefulSet(value)) ||
						(await client.list("Pod", selector(value.agentId))).length ||
						!(await closeRoute(value))
					)
						throw new WorkloadKubernetesError("unavailable");
					return validateKubernetesReconcileResultV1(value, {
						...correlation,
						status: "absent",
						replicas: 0,
						routeClosed: true,
					});
				}
				if (!identity || identity === "pending")
					throw new WorkloadKubernetesError("unavailable");
				const applied = {
					...correlation,
					imageDigest: value.imageDigest,
					workloadUid: identity.uid,
					observedGeneration: identity.generation,
					resourceProfileRef: value.resourceProfileRef,
					service: value.service,
					healthCheck: value.health,
					routeIntent: value.route,
					persistentVolume: value.persistentVolume,
					serviceAccount: value.serviceAccount,
					networkPolicy: value.networkPolicy,
					serviceRef: value.service.name,
					serviceAccountRef: value.serviceAccount.name,
					persistentVolumeRef: value.persistentVolume.name,
					networkPolicyRef: workloadResourceNameV1(value.agentId),
					secretRefs: value.secretRefs,
					state: value.replicas === 0 ? "scaled-down" : "applying",
					desiredReplicas: value.replicas,
					readyReplicas: 0,
					route: { state: "closed" },
					health: { state: "unknown" },
					cleanupState: "not-requested",
				};
				return validateKubernetesReconcileResultV1(value, {
					...correlation,
					status: "applied",
					workloadUid: identity.uid,
					workloadGeneration: identity.generation,
					applied,
				});
			} catch {
				return validateKubernetesReconcileResultV1(value, {
					...correlation,
					status: "failed",
					error: {
						schemaVersion: 1,
						code: "KUBERNETES_APPLY_INCOMPLETE",
						message: "Kubernetes Workload did not fully converge",
						retryable: true,
						traceId: value.traceId,
					},
				});
			}
		},
		async switchRoute(
			input: unknown,
			routeMode: RouteSelectorMode = "closed",
			trustedDesired?: AgentWorkloadDesiredV1,
		) {
			const request = validateWorkloadRouteSwitchRequestV1(input);
			const correlation = {
				schemaVersion: 1,
				requestId: request.requestId,
				traceId: request.traceId,
				agentId: request.agentId,
				fence: request.fence,
				action: request.action,
			};
			const target =
				request.action === "promote"
					? request.candidateRoute
					: request.previousRoute;
			let routeValidated = false;
			try {
				const current = await client.read<V1StatefulSet>(
					"StatefulSet",
					workloadResourceNameV1(request.agentId),
				);
				if (current)
					own(current, request.agentId, target.workloadRevision, request.fence);
				if (modelProjection && !trustedDesired)
					throw new WorkloadKubernetesError("policy");
				const value = desired(
					trustedDesired ??
						JSON.parse(
							current?.metadata?.annotations?.[desiredAnnotation] ?? "null",
						),
				);
				if (
					value.agentId !== request.agentId ||
					value.fence !== request.fence ||
					value.workloadRevision !== target.workloadRevision ||
					target.routeRef !== value.route.name
				)
					throw new WorkloadKubernetesError("conflict");
				routeValidated = true;
				if (
					(await observe(
						value,
						{
							uid: target.workloadUid,
							generation: target.workloadGeneration,
						},
						routeMode,
						"required",
					)) !== "healthy"
				)
					throw new WorkloadKubernetesError("conflict");
				await adapter.promote(
					value,
					{
						uid: target.workloadUid,
						generation: target.workloadGeneration,
					},
					routeMode,
				);
				const service = await client.read<V1Service>(
					"Service",
					value.service.name,
				);
				const routeIngress = await client.read<V1Ingress>(
					"Ingress",
					value.route.name,
				);
				const expectedSelector = routeSelector(
					workloadResourceNameV1(value.agentId),
					value.workloadRevision,
					"open",
				);
				const expectedMetadata = metadata(value);
				const expectedIngress = ingress(value);
				if (
					!service ||
					!hasSafeRoutingMetadata(value, service) ||
					!matchesServiceSpec(
						service?.spec,
						serviceSpec(value, expectedSelector),
					) ||
					(value.route.exposure === "internal-only"
						? routeIngress !== null
						: !routeIngress ||
							!hasSameStructure(
								routeIngress.metadata?.labels,
								expectedMetadata.labels,
							) ||
							!matchesIngress(routeIngress, expectedIngress))
				)
					throw new WorkloadKubernetesError("conflict");
				return validateWorkloadRouteSwitchResultV1(request, {
					...correlation,
					status: "completed",
					routedWorkloads: [target],
				});
			} catch {
				if (
					routeValidated &&
					!(await closeAgentAtFence({
						agentId: request.agentId,
						workloadRevision: target.workloadRevision,
						fence: request.fence,
					}))
				)
					throw new WorkloadKubernetesError("unavailable");
				return validateWorkloadRouteSwitchResultV1(request, {
					...correlation,
					status: "failed",
					routedWorkloads: [],
					error: {
						schemaVersion: 1,
						code: "KUBERNETES_ROUTE_SWITCH_FAILED",
						message: "Kubernetes route switch did not converge",
						retryable: true,
						traceId: request.traceId,
					},
				});
			}
		},
		async cleanup(input: unknown) {
			const request = WorkloadCleanupRequestV1Schema.parse(input);
			const removed = {
				route: false,
				workload: false,
				service: false,
				serviceAccount: false,
				networkPolicy: false,
				configuration: false,
				secrets: false,
				persistentVolume: false,
			};
			let routeClosed = false;
			try {
				const current = await client.read<V1StatefulSet>(
					"StatefulSet",
					workloadResourceNameV1(request.agentId),
				);
				if (
					current &&
					(current.metadata?.uid !== request.workloadUid ||
						current.metadata.generation !== request.workloadGeneration)
				)
					throw new WorkloadKubernetesError("conflict");
				const name = workloadResourceNameV1(request.agentId);
				const resources = await Promise.all([
					client.read("PersistentVolumeClaim", `${name}-data`),
					client.read("Service", name),
					client.read("Service", `${name}-probe`),
					client.read("ServiceAccount", name),
					client.read("NetworkPolicy", name),
					client.read("Ingress", name),
				]);
				for (const resource of [current, ...resources]) {
					if (resource)
						own(
							resource,
							request.agentId,
							request.workloadRevision,
							request.fence,
						);
				}
				routeClosed = await closeAgentAtFence(request);
				if (!routeClosed)
					return validateWorkloadCleanupResultV1(request, {
						...request,
						status: "in-progress",
						phase: "closing-route",
						routeClosed,
						removed,
					});
				const completed = await cleanupAgentAtFence(
					request,
					request.persistentVolumeIntent === "delete-new",
				);
				return validateWorkloadCleanupResultV1(
					request,
					completed
						? {
								...request,
								status: "completed",
								routeClosed,
								removed: {
									route: true,
									workload: true,
									service: true,
									serviceAccount: true,
									networkPolicy: true,
									configuration: true,
									secrets: false,
									persistentVolume:
										request.persistentVolumeIntent === "delete-new",
								},
							}
						: {
								...request,
								status: "in-progress",
								phase: "removing-resources",
								routeClosed,
								removed,
							},
				);
			} catch {
				return validateWorkloadCleanupResultV1(request, {
					...request,
					status: "failed",
					phase: routeClosed ? "removing-resources" : "closing-route",
					routeClosed,
					removed,
					error: {
						schemaVersion: 1,
						code: "KUBERNETES_CLEANUP_FAILED",
						message: "Kubernetes Workload cleanup did not complete",
						retryable: true,
						traceId: request.traceId,
					},
				});
			}
		},
	};
}
