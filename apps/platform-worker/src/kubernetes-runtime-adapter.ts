import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type AgentWorkloadDesiredV1,
	type SecretActivationFenceV1,
	validateAgentWorkloadDesiredV1,
	validateKubernetesReconcileResultV1,
	validateWorkloadCleanupResultV1,
	validateWorkloadRouteSwitchRequestV1,
	validateWorkloadRouteSwitchResultV1,
	WorkloadCleanupRequestV1Schema,
} from "@agent-infra/contracts/workload";
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
import {
	type WorkerKubernetesClientV1,
	WorkloadKubernetesError,
	type WorkloadResourceKind,
} from "./kubernetes-client.js";

const ownerLabel = "agent-infra.agora.io/agent";
const revisionLabel = "agent-infra.agora.io/revision";
const agentAnnotation = "agent-infra.agora.io/agent-id";
const fingerprintAnnotation = "agent-infra.agora.io/spec-hash";
const desiredAnnotation = "agent-infra.agora.io/desired";
const controllerAnnotationPrefix = "agent-infra.agora.io/";
const secretIdAnnotation = "agent-infra.agora.io/secret-id";
const secretVersionAnnotation = "agent-infra.agora.io/secret-version";
const secretConfigRevisionAnnotation = "agent-infra.agora.io/config-revision";

type RouteSelectorMode = "closed" | "open";

function containsDesired(actual: unknown, expected: unknown): boolean {
	if (Array.isArray(expected) && expected.length === 0 && actual === undefined)
		return true;
	if (Array.isArray(expected))
		return (
			Array.isArray(actual) &&
			actual.length === expected.length &&
			expected.every((entry, index) => containsDesired(actual[index], entry))
		);
	if (expected !== null && typeof expected === "object")
		return (
			actual !== null &&
			typeof actual === "object" &&
			Object.entries(expected).every(([key, value]) =>
				containsDesired((actual as Record<string, unknown>)[key], value),
			)
		);
	return actual === expected;
}

function agentContainerSecurityContext() {
	return {
		allowPrivilegeEscalation: false,
		readOnlyRootFilesystem: true,
		capabilities: { drop: ["ALL"] },
		runAsNonRoot: true,
		runAsUser: 1000,
		runAsGroup: 1000,
		seccompProfile: { type: "RuntimeDefault" },
		procMount: "Default",
	};
}

function matchesNetworkPolicySpec(
	actual: V1NetworkPolicy["spec"] | undefined,
	expected: V1NetworkPolicy["spec"] | undefined,
) {
	return (
		containsDesired(actual, expected) &&
		![actual?.ingress, actual?.egress].some((rules) =>
			rules?.some((rule) =>
				rule.ports?.some((port) => port.endPort !== undefined),
			),
		)
	);
}

function routeSelector(
	name: string,
	workloadRevision: number,
	mode: RouteSelectorMode,
) {
	return {
		[ownerLabel]: name,
		[revisionLabel]: mode === "closed" ? "closed" : String(workloadRevision),
	};
}

export function workloadResourceNameV1(agentId: string): string {
	return `agent-${createHash("sha256").update(agentId).digest("hex").slice(0, 32)}`;
}

export interface KubernetesWorkloadPolicyV1 {
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
	/** Deployment-owned proxy enforces the permitted model/Connection destinations. */
	readonly egressProxy?: {
		readonly namespace: string;
		readonly selector: Readonly<Record<string, string>>;
		readonly port: number;
	};
}

export function createKubernetesRuntimeAdapterV1(options: {
	readonly client: WorkerKubernetesClientV1;
	readonly policy: KubernetesWorkloadPolicyV1;
	readonly probe: (input: {
		readonly desired: AgentWorkloadDesiredV1;
		readonly serviceOrigin: string;
	}) => Promise<boolean>;
}) {
	const { client, policy } = options;
	if (
		client.namespace !== policy.namespace ||
		!Object.keys(policy.workerSelector).length ||
		!Object.keys(policy.routeSelector).length ||
		Object.keys(policy.platformAuthAnnotations).some((key) =>
			key.startsWith(controllerAnnotationPrefix),
		) ||
		(policy.egressProxy &&
			(!Object.keys(policy.egressProxy.selector).length ||
				!Number.isSafeInteger(policy.egressProxy.port) ||
				policy.egressProxy.port < 1 ||
				policy.egressProxy.port > 65535))
	)
		throw new WorkloadKubernetesError("policy");
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
	function own(object: KubernetesObject, agentId: string, revision: number) {
		if (
			object.metadata?.annotations?.[agentAnnotation] !== agentId ||
			object.metadata.labels?.[ownerLabel] !== workloadResourceNameV1(agentId)
		)
			throw new WorkloadKubernetesError("policy");
		const current = Number(object.metadata.labels[revisionLabel]);
		if (!Number.isSafeInteger(current) || current < 1 || current > revision)
			throw new WorkloadKubernetesError("conflict");
	}
	function hasUnsafePodSpec(pod: V1PodSpec | undefined) {
		return (
			(pod?.containers.length ?? 0) !== 1 ||
			pod?.containers[0]?.name !== "agent" ||
			pod?.hostNetwork === true ||
			pod?.hostPID === true ||
			pod?.hostIPC === true ||
			(pod?.initContainers?.length ?? 0) > 0 ||
			(pod?.ephemeralContainers?.length ?? 0) > 0 ||
			pod?.containers.some((container) => {
				const securityContext = container.securityContext;
				return (
					(container.command?.length ?? 0) > 0 ||
					(container.args?.length ?? 0) > 0 ||
					Object.keys(container.lifecycle ?? {}).length > 0 ||
					!containsDesired(securityContext, agentContainerSecurityContext()) ||
					securityContext?.privileged === true ||
					(securityContext?.capabilities?.add?.length ?? 0) > 0
				);
			}) === true
		);
	}
	function hasDriftedPodSpec(
		value: AgentWorkloadDesiredV1,
		pod: V1PodSpec | undefined,
	) {
		if (hasUnsafePodSpec(pod)) return true;
		const container = pod?.containers.find((entry) => entry.name === "agent");
		return (
			!containsDesired(container, {
				env: Object.entries(value.env).map(([name, value]) => ({
					name,
					value,
				})),
				resources: policy.resources,
				readinessProbe: {
					httpGet: { path: value.health.path, port: value.service.port },
					timeoutSeconds: value.health.timeoutSeconds,
					failureThreshold: value.health.failureThreshold,
				},
				securityContext: agentContainerSecurityContext(),
				volumeMounts: [
					{ name: "data", mountPath: value.persistentVolume.mountPath },
				],
			}) ||
			!containsDesired(pod?.securityContext, {
				runAsNonRoot: true,
				runAsUser: 1000,
				runAsGroup: 1000,
				fsGroup: 1000,
				seccompProfile: { type: "RuntimeDefault" },
			}) ||
			pod?.serviceAccountName !== workloadResourceNameV1(value.agentId) ||
			!containsDesired(pod?.volumes, [
				{
					name: "data",
					persistentVolumeClaim: { claimName: value.persistentVolume.name },
				},
			])
		);
	}
	async function put<T extends KubernetesObject>(
		object: T,
		value: AgentWorkloadDesiredV1,
	): Promise<T> {
		const kind = object.kind as WorkloadResourceKind;
		const current = await client.read<T>(kind, object.metadata?.name ?? "");
		if (current) {
			own(current, value.agentId, value.workloadRevision);
			if (current.metadata?.deletionTimestamp)
				throw new WorkloadKubernetesError("conflict");
		}
		const hash = createHash("sha256")
			.update(JSON.stringify(object))
			.digest("hex");
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
			(kind !== "NetworkPolicy" ||
				matchesNetworkPolicySpec(
					(current as V1NetworkPolicy).spec,
					(object as V1NetworkPolicy).spec,
				)) &&
			(kind !== "StatefulSet" ||
				!hasUnsafePodSpec((current as V1StatefulSet).spec?.template.spec))
		)
			return current;
		const next = {
			...current,
			...object,
			metadata: {
				...current.metadata,
				...object.metadata,
				resourceVersion: current.metadata?.resourceVersion,
				uid: current.metadata?.uid,
			},
		};
		if (kind === "Service")
			(next as V1Service).spec = {
				...(current as V1Service).spec,
				...(object as V1Service).spec,
			};
		return client.replace(next);
	}
	async function remove(
		kind: WorkloadResourceKind,
		name: string,
		value: { agentId: string; workloadRevision: number },
	): Promise<boolean> {
		const current = await client.read(kind, name);
		if (!current) return true;
		own(current, value.agentId, value.workloadRevision);
		if (!current.metadata?.deletionTimestamp) await client.delete(current);
		return (await client.read(kind, name)) === null;
	}
	async function closeRoute(input: unknown): Promise<boolean> {
		const value = desired(input);
		return closeAgent(value.agentId, value.workloadRevision);
	}
	async function closeAgent(
		agentId: string,
		workloadRevision: number,
	): Promise<boolean> {
		const value = { agentId, workloadRevision };
		const name = workloadResourceNameV1(value.agentId);
		// Remove the selected route's backend before any candidate Pod can start.
		const service = await client.read<V1Service>("Service", name);
		if (service) {
			own(service, value.agentId, value.workloadRevision);
			if (
				!isDeepStrictEqual(service.spec?.selector, {
					[ownerLabel]: name,
					[revisionLabel]: "closed",
				})
			) {
				await client.replace({
					...service,
					metadata: {
						...service.metadata,
						labels: {
							...service.metadata?.labels,
							[revisionLabel]: String(workloadRevision),
						},
						annotations: {
							...service.metadata?.annotations,
							[fingerprintAnnotation]: "",
						},
					},
					spec: {
						...service.spec,
						selector: { [ownerLabel]: name, [revisionLabel]: "closed" },
					},
				});
			}
		}
		return remove("Ingress", name, value);
	}
	async function statefulSet(value: AgentWorkloadDesiredV1) {
		const current = await client.read<V1StatefulSet>(
			"StatefulSet",
			workloadResourceNameV1(value.agentId),
		);
		if (current) {
			own(current, value.agentId, value.workloadRevision);
			if (
				value.expectedWorkload.state === "present" &&
				current.metadata?.uid !== value.expectedWorkload.workloadUid
			)
				throw new WorkloadKubernetesError("conflict");
		}
		return current;
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
				egress: policy.egressProxy
					? [
							{
								to: [peer("kube-system", { "k8s-app": "kube-dns" })],
								ports: [
									{ protocol: "UDP", port: 53 },
									{ protocol: "TCP", port: 53 },
								],
							},
							{
								to: [
									peer(
										policy.egressProxy.namespace,
										policy.egressProxy.selector,
									),
								],
								ports: [{ protocol: "TCP", port: policy.egressProxy.port }],
							},
						]
					: [],
			},
		};
	}
	async function observe(
		input: unknown,
		identity: { uid: string; generation: number },
		routeMode: RouteSelectorMode = "closed",
	): Promise<"pending" | "healthy" | "unhealthy" | "drifted"> {
		const value = desired(input);
		const current = await statefulSet(value);
		if (
			!current ||
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
		const name = workloadResourceNameV1(value.agentId);
		const serviceAccount = await client.read<V1ServiceAccount>(
			"ServiceAccount",
			name,
		);
		const network = await client.read<V1NetworkPolicy>("NetworkPolicy", name);
		const probe = await client.read<V1Service>("Service", `${name}-probe`);
		const service = await client.read<V1Service>("Service", name);
		if (!serviceAccount || !network || !probe || !service) return "drifted";
		for (const ref of value.secretRefs) {
			const secret = await client.read<V1Secret>("Secret", ref.name);
			if (
				!secret ||
				!isOwnedSecret(secret, value, ref) ||
				secret.immutable !== true
			)
				return "drifted";
		}
		for (const resource of [serviceAccount, network, probe, service])
			own(resource, value.agentId, value.workloadRevision);
		if (
			serviceAccount.automountServiceAccountToken !== false ||
			!matchesNetworkPolicySpec(network.spec, networkPolicy(value).spec) ||
			!isDeepStrictEqual(probe.spec?.selector, {
				[ownerLabel]: name,
				[revisionLabel]: String(value.workloadRevision),
			}) ||
			!isDeepStrictEqual(
				service.spec?.selector,
				routeSelector(name, value.workloadRevision, routeMode),
			) ||
			![probe, service].every(
				(entry) =>
					entry.spec?.type === "ClusterIP" &&
					entry.spec.ports?.length === 1 &&
					entry.spec.ports[0]?.port === value.service.port &&
					entry.spec.ports[0]?.targetPort === value.service.port,
			)
		)
			return "drifted";
		const pods = await client.list<V1Pod>("Pod", selector(value.agentId));
		if (pods.length !== 1) return "pending";
		const pod = pods[0];
		if (
			!pod ||
			pod.metadata?.deletionTimestamp ||
			!pod.metadata?.ownerReferences?.some(
				(owner) => owner.uid === identity.uid,
			) ||
			pod.metadata.labels?.[revisionLabel] !== String(value.workloadRevision)
		)
			return "pending";
		if (hasUnsafePodSpec(pod.spec)) return "drifted";
		const container = pod.spec?.containers.find(
			(entry) => entry.name === "agent",
		);
		const refs =
			container?.envFrom?.map((entry) => entry.secretRef?.name).sort() ?? [];
		if (
			container?.image !== `${policy.imageRepository}@${value.imageDigest}` ||
			!isDeepStrictEqual(
				refs,
				value.secretRefs.map((ref) => ref.name).sort(),
			) ||
			pod.spec?.automountServiceAccountToken !== false
		)
			return "unhealthy";
		if (hasDriftedPodSpec(value, pod.spec)) return "drifted";
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
		return (await options.probe({
			desired: value,
			serviceOrigin: `http://${workloadResourceNameV1(value.agentId)}-probe.${policy.namespace}.svc:${value.service.port}`,
		}))
			? "healthy"
			: "unhealthy";
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
		async scaleDownAgent(
			agentId: string,
			revision: number,
		): Promise<{ uid: string; generation: number } | "pending" | null> {
			const current = await client.read<V1StatefulSet>(
				"StatefulSet",
				workloadResourceNameV1(agentId),
			);
			if (!current)
				return (await client.list("Pod", selector(agentId))).length
					? "pending"
					: null;
			own(current, agentId, revision);
			if (current.spec?.replicas !== 0) {
				await client.replace({
					...current,
					metadata: {
						...current.metadata,
						labels: {
							...current.metadata?.labels,
							[revisionLabel]: String(revision),
						},
						annotations: {
							...current.metadata?.annotations,
							[fingerprintAnnotation]: "",
						},
					},
					spec: { ...current.spec, replicas: 0 },
				} as V1StatefulSet);
				return "pending";
			}
			if ((await client.list("Pod", selector(agentId))).length)
				return "pending";
			return current.metadata?.uid
				? {
						uid: current.metadata.uid,
						generation: current.metadata.generation ?? 1,
					}
				: null;
		},
		async bindSecretFence(
			input: unknown,
			identity: { uid: string; generation: number },
			secretName: string,
			fence: number,
		) {
			const value = desired(input);
			const current = await statefulSet(value);
			if (
				!current ||
				current.metadata?.uid !== identity.uid ||
				current.metadata.generation !== identity.generation ||
				!value.secretRefs.some((ref) => ref.name === secretName) ||
				!Number.isSafeInteger(fence) ||
				fence < 1
			)
				throw new WorkloadKubernetesError("conflict");
			const key = `agent-infra.agora.io/secret-${createHash("sha256").update(secretName).digest("hex").slice(0, 32)}`;
			if (current.metadata.annotations?.[key] === String(fence)) return;
			await client.replace({
				...current,
				metadata: {
					...current.metadata,
					annotations: {
						...current.metadata.annotations,
						[key]: String(fence),
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
			const key = `agent-infra.agora.io/secret-${createHash("sha256").update(secretName).digest("hex").slice(0, 32)}`;
			return (
				current?.metadata?.annotations?.[key] === String(fence) &&
				(await observe(value, identity)) === "healthy"
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
			const key = `agent-infra.agora.io/secret-${createHash("sha256").update(ref.name).digest("hex").slice(0, 32)}`;
			if (
				!current ||
				current.metadata?.uid !== activationFence.workloadUid ||
				current.metadata.generation !== activationFence.workloadGeneration ||
				current.metadata?.annotations?.[key] !== String(activationFence.fence)
			)
				return false;
			try {
				own(current, value.agentId, value.workloadRevision);
			} catch {
				return false;
			}
			const secret = await client.read<V1Secret>("Secret", ref.name);
			return Boolean(
				secret &&
					isOwnedSecret(secret, value, ref) &&
					secret.immutable === true,
			);
		},
		async applyImmutableSecret(
			input: unknown,
			name: string,
			key: string,
			plaintext: Uint8Array,
		) {
			const value = desired(input);
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
				throw new WorkloadKubernetesError("policy");
			{
				const ref = value.secretRefs.find((entry) => entry.name === name);
				if (!ref) throw new WorkloadKubernetesError("policy");
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
				const existing = await client.read<V1Secret>("Secret", ref.name);
				if (!existing) {
					await client.create(body);
					return;
				}
				if (!isOwnedSecret(existing, value, ref))
					throw new WorkloadKubernetesError("conflict");
				if (
					existing.immutable !== true ||
					!isDeepStrictEqual(existing.data, body.data)
				)
					throw new WorkloadKubernetesError("conflict");
			}
		},
		async apply(
			input: unknown,
		): Promise<{ uid: string; generation: number } | "pending" | null> {
			const value = desired(input);
			const name = workloadResourceNameV1(value.agentId);
			const current = await statefulSet(value);
			if (!current && value.replicas === 0) return null;
			const pods = await client.list<V1Pod>("Pod", selector(value.agentId));
			const driftedOwnedPod =
				current &&
				pods.some(
					(pod) =>
						pod.metadata?.ownerReferences?.some(
							(owner) => owner.uid === current.metadata?.uid,
						) && hasDriftedPodSpec(value, pod.spec),
				);
			const changing =
				current &&
				current.spec?.template.metadata?.labels?.[revisionLabel] !==
					String(value.workloadRevision);
			if (
				current &&
				(changing || driftedOwnedPod || value.replicas === 0) &&
				(current.spec?.replicas !== 0 || pods.length > 0)
			) {
				if (current.spec?.replicas !== 0)
					await client.replace({
						...current,
						metadata: {
							...current.metadata,
							annotations: {
								...current.metadata?.annotations,
								[fingerprintAnnotation]: "",
							},
						},
						spec: { ...current.spec, replicas: 0 },
					} as V1StatefulSet);
				return "pending";
			}
			if (value.replicas === 0)
				return current?.metadata?.uid
					? {
							uid: current.metadata.uid,
							generation: current.metadata.generation ?? 1,
						}
					: null;
			const podLabels = {
				[ownerLabel]: name,
				[revisionLabel]: String(value.workloadRevision),
			};
			const service: V1Service = {
				apiVersion: "v1",
				kind: "Service",
				metadata: metadata(value),
				spec: {
					type: "ClusterIP",
					selector: { [ownerLabel]: name, [revisionLabel]: "closed" },
					ports: [
						{
							name: "runtime",
							port: value.service.port,
							targetPort: value.service.port,
						},
					],
				},
			};
			await put(service, value);
			await put<V1Service>(
				{
					apiVersion: "v1",
					kind: "Service",
					metadata: metadata(value, `${name}-probe`),
					spec: {
						type: "ClusterIP",
						selector: podLabels,
						ports: [
							{
								name: "runtime",
								port: value.service.port,
								targetPort: value.service.port,
							},
						],
					},
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
				own(pvc, value.agentId, value.workloadRevision);
				if (pvc.metadata?.deletionTimestamp)
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
						spec: {
							accessModes: ["ReadWriteOnce"],
							...(policy.storageClassName
								? { storageClassName: policy.storageClassName }
								: {}),
							resources: { requests: { storage: policy.storageSize } },
						},
					},
					value,
				);
			await put(networkPolicy(value), value);
			const workload: V1StatefulSet = {
				apiVersion: "apps/v1",
				kind: "StatefulSet",
				metadata: {
					...metadata(value),
					annotations: {
						...metadata(value).annotations,
						[desiredAnnotation]: JSON.stringify(value),
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
									env: Object.entries(value.env).map(([name, value]) => ({
										name,
										value,
									})),
									envFrom: value.secretRefs.map((ref) => ({
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
			if ((await observe(value, identity, routeMode)) !== "healthy")
				throw new WorkloadKubernetesError("conflict");
			const name = workloadResourceNameV1(value.agentId);
			if (value.route.exposure === "internal-only") {
				if (!(await remove("Ingress", name, value)))
					throw new WorkloadKubernetesError("unavailable");
			} else {
				const host = `${name}.${policy.routeHostSuffix}`;
				await put<V1Ingress>(
					{
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
					},
					value,
				);
			}
			await put<V1Service>(
				{
					apiVersion: "v1",
					kind: "Service",
					metadata: metadata(value),
					spec: {
						type: "ClusterIP",
						selector: {
							[ownerLabel]: name,
							[revisionLabel]: String(value.workloadRevision),
						},
						ports: [
							{
								name: "runtime",
								port: value.service.port,
								targetPort: value.service.port,
							},
						],
					},
				},
				value,
			);
		},
		async cleanupAgent(
			agentId: string,
			workloadRevision: number,
			deleteNewVolume: boolean,
		) {
			const value = { agentId, workloadRevision };
			if (!(await closeAgent(agentId, workloadRevision))) return false;
			const name = workloadResourceNameV1(value.agentId);
			if (
				!(await remove("StatefulSet", name, value)) ||
				(await client.list("Pod", selector(value.agentId))).length > 0
			)
				return false;
			for (const kind of [
				"Service",
				"ServiceAccount",
				"NetworkPolicy",
			] as const)
				if (!(await remove(kind, name, value))) return false;
			// Secret reclamation requires the Platform binding and rollback-retention
			// decision. This adapter only owns Kubernetes state, so it must retain
			// Agent-labelled immutable material rather than bulk-delete it.
			if (!(await remove("Service", `${name}-probe`, value))) return false;
			if (
				deleteNewVolume &&
				!(await remove("PersistentVolumeClaim", `${name}-data`, value))
			)
				return false;
			return true;
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
			if (activationFence) {
				const current = await statefulSet(value);
				const key = `agent-infra.agora.io/secret-${createHash("sha256").update(ref.name).digest("hex").slice(0, 32)}`;
				if (
					activationFence.agentId !== ref.agentId ||
					activationFence.secretId !== ref.secretId ||
					activationFence.secretVersion !== ref.secretVersion ||
					activationFence.configRevision !== ref.configRevision ||
					activationFence.kubernetesSecretName !== ref.name ||
					!current ||
					current.metadata?.uid !== activationFence.workloadUid ||
					current.metadata.generation !== activationFence.workloadGeneration ||
					current.metadata.annotations?.[key] !== String(activationFence.fence)
				)
					return false;
			}
			const secret = await client.read<V1Secret>("Secret", ref.name);
			if (!secret) return true;
			if (!isOwnedSecret(secret, value, ref) || secret.immutable !== true)
				throw new WorkloadKubernetesError("policy");
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
		async switchRoute(input: unknown, routeMode: RouteSelectorMode = "closed") {
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
				const value = desired(
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
				if (
					service?.spec?.selector?.[revisionLabel] !==
					String(target.workloadRevision)
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
					!(await closeAgent(request.agentId, target.workloadRevision))
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
				routeClosed = await closeAgent(
					request.agentId,
					request.workloadRevision,
				);
				if (!routeClosed)
					return validateWorkloadCleanupResultV1(request, {
						...request,
						status: "in-progress",
						phase: "closing-route",
						routeClosed,
						removed,
					});
				const completed = await adapter.cleanupAgent(
					request.agentId,
					request.workloadRevision,
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
