import { createHash, randomUUID } from "node:crypto";
import {
	decideSessionSandboxDrainObservationV1,
	type SessionSandboxDeletionProgressV1,
	type SessionSandboxLifecycleV1,
	type SessionSandboxObservationV1,
	type SessionSandboxResourceIdentityV1,
	type SessionSandboxStopReceiptV1,
	type TaskPrincipalV1,
} from "@agent-infra/platform-core";
import type {
	KubernetesObject,
	V1Container,
	V1NetworkPolicy,
	V1PersistentVolumeClaim,
	V1Pod,
	V1Service,
	V1ServiceAccount,
} from "@kubernetes/client-node";
import {
	isRuntimeConnectionEnvironmentV1,
	runtimeConnectionConsumerAnnotation,
	runtimeConnectionConsumerControlPodV1,
	runtimeConnectionConsumerProjectionV1,
} from "./connection-consumer-projection.js";
import type { WorkerKubernetesClientV1 } from "./kubernetes-client.js";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import {
	type WorkloadEgressPolicyV1,
	workloadEgressRulesV1,
} from "./workload-network.js";

/** Typed handoff for the #1250 Store allocation authority. */
export interface SessionSandboxAllocationV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly sessionId: string;
	readonly sandboxId: string;
	readonly principal: SessionSandboxPrincipalV1;
	readonly channelId: string;
	readonly resourceName: string;
	readonly workspaceScope: string;
	readonly generation: number;
	readonly resourceFence: number;
	readonly namespace: string;
	readonly podName: string;
	readonly serviceName: string;
	readonly serviceAccountName: string;
	readonly pvcName: string;
	readonly networkPolicyName: string;
	/**
	 * Deployment-approved egress (Spec §10.1.1), assembled by the Worker from its
	 * reviewed policy; never from Store claims, requests or Runtime replies.
	 */
	readonly egress: WorkloadEgressPolicyV1;
	readonly imageDigest: string;
	readonly authorizedIngressSelector: Readonly<Record<string, string>>;
	readonly containerPort: number;
	readonly workspaceMountPath: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly connectionConsumerSnapshot?: string | null;
	readonly connectionInstallationRevision?: string | null;
	readonly resources: {
		readonly requests: { readonly cpu: string; readonly memory: string };
		readonly limits: { readonly cpu: string; readonly memory: string };
	};
	readonly storageSize: string;
	readonly storageClassName?: string;
	readonly desiredState: "running" | "stopped";
}

export type SessionSandboxResourceSetV1 = readonly [
	V1ServiceAccount,
	V1PersistentVolumeClaim,
	V1NetworkPolicy,
	V1Service,
	V1Pod,
];

export type SessionSandboxPrincipalV1 = TaskPrincipalV1;

interface SessionSandboxLabelIdentityV1 {
	readonly agentId: string;
	readonly sessionId: string;
	readonly sandboxId: string;
	readonly generation: number;
}

const labelValuePattern = /^[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const boundedRef = (prefix: string, value: string) =>
	`${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;

/**
 * Selector labels for one Session Sandbox. Kubernetes label values are at most
 * 63 characters, so Agent and Session IDs are bounded hashes; the exact IDs live
 * in {@link sessionSandboxIdentityAnnotationsV1}. The key differs from the
 * Agent Workload's `agent-infra.agora.io/agent` so Agent selectors never match.
 */
export function sessionSandboxLabelsV1(
	identity: SessionSandboxLabelIdentityV1,
): Readonly<Record<string, string>> {
	const labels = {
		"agent-infra.agora.io/agent-ref": boundedRef("agent", identity.agentId),
		"agent-infra.agora.io/session-ref": boundedRef(
			"session",
			identity.sessionId,
		),
		"agent-infra.agora.io/sandbox-id": identity.sandboxId,
		"agent-infra.agora.io/generation": String(identity.generation),
	};
	if (Object.values(labels).some((value) => !labelValuePattern.test(value)))
		throw new WorkloadKubernetesError("policy");
	return labels;
}

/** Exact identity verified alongside the bounded selector labels. */
export function sessionSandboxIdentityAnnotationsV1(
	identity: Pick<SessionSandboxLabelIdentityV1, "agentId" | "sessionId">,
): Readonly<Record<string, string>> {
	return {
		"agent-infra.agora.io/agent-id": identity.agentId,
		"agent-infra.agora.io/session-id": identity.sessionId,
	};
}

/** True when an object carries this Sandbox's labels and exact identity. */
export function hasSessionSandboxIdentityV1(
	object: KubernetesObject | null | undefined,
	identity: SessionSandboxLabelIdentityV1,
): boolean {
	const labels = object?.metadata?.labels ?? {};
	const annotations = object?.metadata?.annotations ?? {};
	return (
		Object.entries(sessionSandboxLabelsV1(identity)).every(
			([key, value]) => labels[key] === value,
		) &&
		Object.entries(sessionSandboxIdentityAnnotationsV1(identity)).every(
			([key, value]) => annotations[key] === value,
		)
	);
}

const labels = (allocation: SessionSandboxAllocationV1) =>
	sessionSandboxLabelsV1(allocation);

function metadata(allocation: SessionSandboxAllocationV1, name: string) {
	return {
		namespace: allocation.namespace,
		name,
		labels: { ...labels(allocation) },
		annotations: {
			...sessionSandboxIdentityAnnotationsV1(allocation),
			"agent-infra.agora.io/fence": String(allocation.resourceFence),
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
		!value.principal?.id ||
		(value.principal.kind !== "user" &&
			value.principal.kind !== "application") ||
		!value.channelId ||
		value.resourceName !== `sandbox-${value.sandboxId}` ||
		value.workspaceScope !== value.sandboxId ||
		!Number.isSafeInteger(value.generation) ||
		value.generation < 1 ||
		!Number.isSafeInteger(value.resourceFence) ||
		value.resourceFence < 1 ||
		!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(value.namespace) ||
		!value.podName ||
		!value.serviceName ||
		!value.serviceAccountName ||
		!value.pvcName ||
		!value.networkPolicyName ||
		[
			value.podName,
			value.serviceName,
			value.serviceAccountName,
			value.pvcName,
			value.networkPolicyName,
		].some((name) => name !== value.resourceName) ||
		!/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(value.imageDigest) ||
		Object.keys(value.authorizedIngressSelector).length === 0 ||
		Object.values(value.authorizedIngressSelector).some((item) => !item) ||
		!Number.isSafeInteger(value.containerPort) ||
		value.containerPort < 1 ||
		value.containerPort > 65535 ||
		!value.workspaceMountPath.startsWith("/") ||
		!value.egress ||
		typeof value.egress !== "object" ||
		Array.isArray(value.egress) ||
		Object.keys(value.egress).some(
			(key) => !["modelEgress", "connectionEgress", "dnsEgress"].includes(key),
		)
	)
		throw new WorkloadKubernetesError("policy");
	// Rejects any destination the shared Agent-level compiler would reject.
	workloadEgressRulesV1(value.egress);
}

export function sessionSandboxResourcesV1(
	allocation: SessionSandboxAllocationV1,
): SessionSandboxResourceSetV1 {
	validateAllocation(allocation);
	if (
		allocation.desiredState === "running" &&
		(allocation.connectionConsumerSnapshot === null ||
			allocation.connectionInstallationRevision === null ||
			Object.keys(allocation.env ?? {}).some(isRuntimeConnectionEnvironmentV1))
	)
		throw new WorkloadKubernetesError("policy");
	const connection = runtimeConnectionConsumerProjectionV1(
		allocation.desiredState === "running"
			? allocation.connectionConsumerSnapshot
			: undefined,
		allocation.desiredState === "running"
			? allocation.connectionInstallationRevision
			: undefined,
	);
	const resourceLabels = { ...labels(allocation) };
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
			resources: { requests: { storage: allocation.storageSize } },
			storageClassName: allocation.storageClassName,
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
			// Same compiled allowlist as the Agent-level Workload; empty denies all.
			egress: workloadEgressRulesV1(allocation.egress),
		},
	};
	const pod: V1Pod = {
		apiVersion: "v1",
		kind: "Pod",
		metadata: {
			...metadata(allocation, allocation.podName),
			annotations: {
				...metadata(allocation, allocation.podName).annotations,
				...connection.annotations,
			},
		},
		spec: {
			serviceAccountName: allocation.serviceAccountName,
			automountServiceAccountToken: false,
			restartPolicy: "Always",
			containers: [
				{
					name: "runtime",
					image: allocation.imageDigest,
					imagePullPolicy: "IfNotPresent",
					resources: structuredClone(allocation.resources),
					ports: [{ containerPort: allocation.containerPort }],
					env: [
						...Object.entries(allocation.env ?? {}).map(([name, value]) => ({
							name,
							value,
						})),
						...connection.env,
					],
					workingDir: allocation.workspaceMountPath,
					volumeMounts: [
						...connection.volumeMounts,
						{ name: "workspace", mountPath: allocation.workspaceMountPath },
					],
					// In-cluster plaintext (ADR-0020); NetworkPolicy admits only the Worker.
					readinessProbe: {
						httpGet: {
							scheme: "HTTP",
							path: "/healthz",
							port: allocation.containerPort,
						},
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
				...connection.volumes,
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
	const expectedStorageClass = expected.spec?.storageClassName;
	return (
		JSON.stringify(spec?.accessModes ?? []) ===
			JSON.stringify(expected.spec?.accessModes ?? []) &&
		spec?.resources?.requests?.storage ===
			expected.spec?.resources?.requests?.storage &&
		(expectedStorageClass === undefined ||
			spec?.storageClassName === expectedStorageClass)
	);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function podSpecMatches(current: KubernetesObject, expected: V1Pod) {
	if (
		current.metadata?.annotations?.[runtimeConnectionConsumerAnnotation] !==
		expected.metadata?.annotations?.[runtimeConnectionConsumerAnnotation]
	)
		return false;
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
		stableJson(currentContainer.resources) ===
			stableJson(expectedContainer.resources) &&
		currentContainer.workingDir === expectedContainer.workingDir &&
		stableJson(
			(currentContainer.ports ?? []).map((port) => ({
				...port,
				protocol: port.protocol ?? "TCP",
			})),
		) ===
			stableJson(
				(expectedContainer.ports ?? []).map((port) => ({
					...port,
					protocol: port.protocol ?? "TCP",
				})),
			) &&
		stableJson(normalizeEnv(currentContainer.env)) ===
			stableJson(normalizeEnv(expectedContainer.env)) &&
		stableJson(currentContainer.volumeMounts ?? []) ===
			stableJson(expectedContainer.volumeMounts ?? []) &&
		stableJson(currentContainer.securityContext ?? {}) ===
			stableJson(expectedContainer.securityContext ?? {}) &&
		stableJson(readinessProbeShape(currentContainer.readinessProbe)) ===
			stableJson(readinessProbeShape(expectedContainer.readinessProbe)) &&
		stableJson(currentSpec.volumes ?? []) ===
			stableJson(expectedSpec.volumes ?? [])
	);
}

function readinessProbeShape(probe: V1Container["readinessProbe"]) {
	return probe
		? {
				...probe,
				httpGet: probe.httpGet
					? {
							...probe.httpGet,
							scheme: probe.httpGet.scheme ?? "HTTP",
						}
					: undefined,
				initialDelaySeconds: probe.initialDelaySeconds ?? 0,
				timeoutSeconds: probe.timeoutSeconds ?? 1,
				periodSeconds: probe.periodSeconds ?? 10,
				successThreshold: probe.successThreshold ?? 1,
				failureThreshold: probe.failureThreshold ?? 3,
			}
		: undefined;
}

function resourceSpecMatches(
	current: KubernetesObject,
	expected: KubernetesObject,
) {
	switch (expected.kind) {
		case "Pod":
			return podSpecMatches(current, expected as V1Pod);
		case "PersistentVolumeClaim":
			return pvcSpecMatches(current, expected as V1PersistentVolumeClaim);
		case "ServiceAccount":
			return (
				(current as V1ServiceAccount).automountServiceAccountToken === false
			);
		case "NetworkPolicy":
			return (
				stableJson(
					normalizeNetworkPolicySpec((current as V1NetworkPolicy).spec),
				) ===
				stableJson(
					normalizeNetworkPolicySpec((expected as V1NetworkPolicy).spec),
				)
			);
		case "Service": {
			const actual = (current as V1Service).spec;
			const wanted = (expected as V1Service).spec;
			const ports = (spec: V1Service["spec"]) =>
				spec?.ports?.map((port) => ({
					name: port.name,
					port: port.port,
					targetPort: port.targetPort,
					protocol: port.protocol ?? "TCP",
				}));
			return (
				actual?.type === wanted?.type &&
				stableJson(actual?.selector) === stableJson(wanted?.selector) &&
				stableJson(ports(actual)) === stableJson(ports(wanted)) &&
				!actual?.externalIPs?.length &&
				!actual?.externalName
			);
		}
		default:
			return false;
	}
}

function normalizeNetworkPolicySpec(spec: V1NetworkPolicy["spec"]) {
	return {
		...spec,
		egress: (spec?.egress ?? []).map((rule) => ({
			...rule,
			ports: rule.ports?.map((port) => ({ protocol: "TCP", ...port })),
		})),
		ingress: spec?.ingress?.map((rule) => ({
			...rule,
			_from:
				rule._from ?? (rule as typeof rule & { from?: typeof rule._from }).from,
			from: undefined,
		})),
	};
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
		hasSessionSandboxIdentityV1(current, allocation) &&
		currentFence === String(allocation.resourceFence)
	);
}

export function createSessionSandboxWorkloadAdapterV1(options: {
	readonly client: WorkerKubernetesClientV1;
}) {
	return {
		async prepareRetainedPVC(
			allocation: SessionSandboxAllocationV1,
			lifecycle: SessionSandboxLifecycleV1,
			previous: readonly SessionSandboxResourceIdentityV1[],
		) {
			validateAllocation(allocation);
			const { source, stopReceipt: receipt, preparation } = lifecycle;
			const prior = previous.find(
				(resource) => resource.kind === "PersistentVolumeClaim",
			);
			if (
				options.client.namespace !== allocation.namespace ||
				allocation.desiredState !== "running" ||
				lifecycle.authority.targetDesiredState !== "running" ||
				!receipt ||
				!preparation ||
				preparation.generation !== allocation.generation ||
				preparation.resourceFence !== allocation.resourceFence ||
				source.sandbox.sandboxId !== allocation.sandboxId ||
				source.sandbox.sessionId !== allocation.sessionId ||
				source.sandbox.agentId !== allocation.agentId ||
				source.sandbox.channelId !== allocation.channelId ||
				source.sandbox.principal.kind !== allocation.principal.kind ||
				source.sandbox.principal.id !== allocation.principal.id ||
				source.sandbox.resourceName !== allocation.resourceName ||
				source.sandbox.workspaceScope !== allocation.workspaceScope ||
				source.sandbox.generation > allocation.generation ||
				source.resourceFence >= allocation.resourceFence ||
				receipt.targetGeneration > allocation.generation ||
				receipt.targetResourceFence > allocation.resourceFence ||
				!decideSessionSandboxDrainObservationV1({
					sandbox: { ...source.sandbox, generation: receipt.targetGeneration },
					resourceFence: receipt.targetResourceFence,
					lifecycle,
					observation: {
						status: "stopped",
						resources: [receipt.retainedPVC],
						sourceStop: receipt,
					},
				}).finished ||
				!prior ||
				prior.uid !== receipt.retainedPVC.uid ||
				prior.namespace !== allocation.namespace ||
				prior.name !== allocation.pvcName ||
				prior.namespace !== receipt.retainedPVC.namespace ||
				prior.name !== receipt.retainedPVC.name
			)
				throw new WorkloadKubernetesError("conflict");
			const expected = sessionSandboxResourcesV1(allocation).find(
				(resource): resource is V1PersistentVolumeClaim =>
					resource.kind === "PersistentVolumeClaim",
			);
			if (!expected) throw new WorkloadKubernetesError("policy");
			const current = await options.client.read<V1PersistentVolumeClaim>(
				"PersistentVolumeClaim",
				allocation.pvcName,
			);
			if (
				!current ||
				current.metadata?.uid !== prior.uid ||
				!current.metadata.resourceVersion ||
				current.metadata.deletionTimestamp ||
				current.metadata.name !== prior.name ||
				current.metadata.namespace !== prior.namespace ||
				!pvcSpecMatches(current, expected)
			)
				throw new WorkloadKubernetesError("conflict");
			if (owned(current, expected, allocation)) return;
			const sourceAllocation = {
				...allocation,
				generation: source.sandbox.generation,
				resourceFence: source.resourceFence,
			};
			const sourceExpected = sessionSandboxResourcesV1(sourceAllocation).find(
				(resource): resource is V1PersistentVolumeClaim =>
					resource.kind === "PersistentVolumeClaim",
			);
			if (!sourceExpected) throw new WorkloadKubernetesError("policy");
			if (!owned(current, sourceExpected, sourceAllocation))
				throw new WorkloadKubernetesError("conflict");
			// Preserve the volume and use the observed UID/resourceVersion for this
			// single Store-authorized ownership transition, never an unfenced adoption.
			await options.client.replace({
				...current,
				metadata: {
					...current.metadata,
					labels: { ...current.metadata.labels, ...expected.metadata?.labels },
					annotations: {
						...current.metadata.annotations,
						...expected.metadata?.annotations,
					},
				},
			});
			const rebound = await options.client.read(
				"PersistentVolumeClaim",
				allocation.pvcName,
			);
			if (
				!rebound ||
				rebound.metadata?.uid !== prior.uid ||
				!rebound.metadata.resourceVersion ||
				!owned(rebound, expected, allocation) ||
				!pvcSpecMatches(rebound, expected)
			)
				throw new WorkloadKubernetesError("conflict");
		},
		async apply(
			allocation: SessionSandboxAllocationV1,
			previous: readonly SessionSandboxResourceIdentityV1[] = [],
		) {
			if (options.client.namespace !== allocation.namespace)
				throw new WorkloadKubernetesError("policy");
			const resources = sessionSandboxResourcesV1(allocation);
			// Check the complete previous set before any write. A vanished or replaced
			// instance needs Store-authorized recovery, not implicit allocation here.
			for (const prior of previous) {
				const expected = resources.find(
					(resource) => resource.kind === prior.kind,
				);
				if (
					!expected ||
					prior.namespace !== allocation.namespace ||
					prior.name !== expected.metadata?.name
				)
					throw new WorkloadKubernetesError("conflict");
				const current = await options.client.read(prior.kind, prior.name);
				if (
					!current ||
					current.metadata?.uid !== prior.uid ||
					!owned(current, expected, allocation)
				)
					throw new WorkloadKubernetesError("conflict");
			}
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
				const kind = expected.kind as SessionSandboxResourceIdentityV1["kind"];
				const current = await options.client.read(
					kind,
					expected.metadata?.name ?? "",
				);
				// observation deliberately validates every owned resource before readiness.
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
				} else if (expected.kind === "Service") {
					// Keep the API-assigned address and version on lawful retries.
					// An owned Service with a different route is drift, not an update.
					if (!resourceSpecMatches(current, expected))
						throw new WorkloadKubernetesError("conflict");
				} else if (
					expected.kind === "ServiceAccount" ||
					expected.kind === "NetworkPolicy"
				) {
					// Kube may add defaulted fields to these owned resources. A
					// matching object is already converged; replacing it can turn a
					// harmless retry into a 409 on immutable/defaulted fields.
					if (!resourceSpecMatches(current, expected))
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
				resourceFence: allocation.resourceFence,
			};
		},
		async observe(
			allocation: SessionSandboxAllocationV1,
			previous: readonly SessionSandboxResourceIdentityV1[] = [],
			purpose: "business" | "control" = "business",
		): Promise<SessionSandboxObservationV1> {
			if (options.client.namespace !== allocation.namespace)
				throw new WorkloadKubernetesError("policy");
			validateAllocation(allocation);
			const resources: SessionSandboxResourceIdentityV1[] = [];
			let status: SessionSandboxObservationV1["status"] =
				allocation.desiredState === "stopped" ? "stopped" : "ready";
			const expectedResources = sessionSandboxResourcesV1(
				purpose === "control"
					? { ...allocation, desiredState: "stopped" }
					: allocation,
			);
			for (const expected of expectedResources) {
				const kind = expected.kind as SessionSandboxResourceIdentityV1["kind"];
				const name = expected.metadata?.name ?? "";
				const current = await options.client.read(kind, name);
				if (
					allocation.desiredState === "stopped" &&
					(kind === "Pod" || kind === "Service")
				) {
					if (current) status = "unknown";
					continue;
				}
				if (
					!current ||
					!owned(current, expected, allocation) ||
					!current.metadata?.uid ||
					!current.metadata.resourceVersion ||
					current.metadata.deletionTimestamp ||
					current.metadata.namespace !== allocation.namespace ||
					current.metadata.name !== name
				) {
					status = "unknown";
					continue;
				}
				const identity = {
					kind,
					namespace: allocation.namespace,
					name,
					uid: current.metadata.uid,
					resourceVersion: current.metadata.resourceVersion,
				};
				resources.push(identity);
				const prior = previous.find((resource) => resource.kind === kind);
				// resourceVersion changes on legitimate writes; UID must retain instance identity.
				if (
					prior &&
					(prior.namespace !== identity.namespace ||
						prior.name !== name ||
						prior.uid !== identity.uid)
				)
					status = "unknown";
				const matches =
					purpose === "control" && kind === "Pod"
						? podSpecMatches(
								runtimeConnectionConsumerControlPodV1(current as V1Pod),
								runtimeConnectionConsumerControlPodV1(expected as V1Pod),
							)
						: resourceSpecMatches(current, expected);
				if (!matches) status = "unknown";
				if (kind === "Pod") {
					const pod = current as V1Pod;
					if (
						status === "ready" &&
						(pod.status?.phase !== "Running" ||
							!pod.status.conditions?.some(
								(condition) =>
									condition.type === "Ready" && condition.status === "True",
							))
					)
						status = "observed";
				}
			}
			return {
				status:
					purpose === "control" && status === "ready" ? "observed" : status,
				resources,
			};
		},
		async cleanup(
			allocation: SessionSandboxAllocationV1,
			previous: readonly SessionSandboxResourceIdentityV1[] = [],
			context: {
				readonly sourceGeneration?: number;
				readonly sourceResourceFence?: number;
				readonly targetGeneration?: number;
				readonly targetResourceFence?: number;
				readonly managementFence?: number;
				readonly deletionProgress?: readonly SessionSandboxDeletionProgressV1[];
				readonly recordDeletionProgress?: (
					progress: SessionSandboxDeletionProgressV1,
				) => Promise<"committed" | "stale" | "unknown">;
			} = {},
		): Promise<SessionSandboxStopReceiptV1> {
			if (options.client.namespace !== allocation.namespace)
				throw new WorkloadKubernetesError("policy");
			const recordDeletionProgress = context.recordDeletionProgress;
			if (!recordDeletionProgress)
				throw new WorkloadKubernetesError("unavailable");
			const expectedResources = sessionSandboxResourcesV1({
				...allocation,
				desiredState: "stopped",
			});
			const previousByKind = new Map(
				previous.map((resource) => [resource.kind, resource]),
			);
			const deletedResources: Array<
				SessionSandboxStopReceiptV1["removed"][number]
			> = [];
			const progressByKind = new Map(
				(context.deletionProgress ?? []).map((entry) => [
					entry.resource.kind,
					entry,
				]),
			);
			const record = async (
				resource: SessionSandboxResourceIdentityV1,
				state: SessionSandboxDeletionProgressV1["state"],
				result: SessionSandboxDeletionProgressV1["deleteCallResult"],
				absence?: SessionSandboxDeletionProgressV1["absence"],
			) => {
				const previousProgress = progressByKind.get(resource.kind);
				const progress: SessionSandboxDeletionProgressV1 = {
					schemaVersion: 1,
					state,
					deleteAttemptId: previousProgress?.deleteAttemptId ?? randomUUID(),
					deleteAttempted: result !== "not-attempted",
					deleteCallResult: result,
					sourceGeneration: context.sourceGeneration ?? allocation.generation,
					resourceFence:
						context.sourceResourceFence ?? allocation.resourceFence,
					managementFence:
						previousProgress?.managementFence ?? context.managementFence ?? 0,
					resource,
					preconditions: {
						uid: resource.uid,
						resourceVersion: resource.resourceVersion,
					},
					...(absence ? { absence } : {}),
				};
				const status = await recordDeletionProgress(progress);
				if (status !== "committed")
					throw new WorkloadKubernetesError("unavailable");
				progressByKind.set(resource.kind, progress);
			};
			const terminatingRetry = (
				current: KubernetesObject,
				existing: SessionSandboxDeletionProgressV1 | undefined,
			) =>
				!!existing?.deleteAttempted &&
				existing.deleteCallResult !== "failed" &&
				current.metadata?.uid === existing.resource.uid &&
				!!current.metadata.deletionTimestamp;
			const resources = expectedResources
				.filter((resource) => resource.kind !== "PersistentVolumeClaim")
				.reverse();
			for (const expected of resources) {
				const kind = expected.kind as SessionSandboxResourceIdentityV1["kind"];
				const existing = progressByKind.get(kind);
				const current = await options.client.read(
					kind,
					expected.metadata?.name ?? "",
				);
				if (!current && existing?.deleteAttempted) {
					const absence = existing.absence ?? {
						kind: existing.resource.kind,
						namespace: existing.resource.namespace,
						name: existing.resource.name,
					};
					await record(
						existing.resource,
						"absent",
						existing.deleteCallResult,
						absence,
					);
					deletedResources.push({
						resource: existing.resource,
						preconditions: existing.preconditions,
						absence,
					});
					continue;
				}
				if (!current) throw new WorkloadKubernetesError("unavailable");
				if (!owned(current, expected, allocation))
					throw new WorkloadKubernetesError("conflict");
				const prior = previousByKind.get(kind);
				if (
					!prior ||
					prior.uid !== current.metadata?.uid ||
					prior.name !== current.metadata?.name
				)
					throw new WorkloadKubernetesError("conflict");
				const currentResourceVersion = current.metadata?.resourceVersion;
				if (
					existing &&
					(existing.resource.uid !== current.metadata?.uid ||
						(!terminatingRetry(current, existing) &&
							existing.preconditions.resourceVersion !==
								currentResourceVersion))
				)
					throw new WorkloadKubernetesError("conflict");
				const identity = existing
					? existing.resource
					: {
							...prior,
							resourceVersion: currentResourceVersion ?? prior.resourceVersion,
						};
				if (!existing?.deleteAttempted)
					await record(identity, "delete-requested", "not-attempted");
				if (terminatingRetry(current, existing))
					throw new WorkloadKubernetesError("unavailable");
				let callResult: SessionSandboxDeletionProgressV1["deleteCallResult"];
				try {
					if (!options.client.deleteResult)
						throw new WorkloadKubernetesError("unavailable");
					const result = await options.client.deleteResult(current);
					callResult = result === "absent" ? "unknown" : result;
				} catch (error) {
					if (existing?.deleteCallResult !== "acknowledged")
						await record(
							identity,
							"unknown",
							error instanceof WorkloadKubernetesError &&
								error.code !== "unavailable"
								? "failed"
								: "unknown",
						);
					throw error;
				}
				await record(identity, "delete-requested", callResult);
				if (await options.client.read(kind, expected.metadata?.name ?? ""))
					throw new WorkloadKubernetesError("unavailable");
				await record(identity, "absent", callResult, {
					kind,
					namespace: identity.namespace,
					name: identity.name,
				});
				deletedResources.push({
					resource: {
						...prior,
						resourceVersion:
							current.metadata?.resourceVersion ?? prior.resourceVersion,
					},
					preconditions: {
						uid: current.metadata?.uid ?? prior.uid,
						resourceVersion:
							current.metadata?.resourceVersion ?? prior.resourceVersion,
					},
					absence: {
						kind: prior.kind,
						namespace: prior.namespace,
						name: prior.name,
					},
				});
			}
			const expectedKinds = new Set(
				expectedResources.map((resource) => resource.kind),
			);
			for (const prior of previous) {
				if (
					prior.kind === "PersistentVolumeClaim" ||
					expectedKinds.has(prior.kind)
				)
					continue;
				const expected: KubernetesObject = {
					apiVersion: prior.kind === "StatefulSet" ? "apps/v1" : undefined,
					kind: prior.kind,
					metadata: {
						namespace: prior.namespace,
						name: prior.name,
						labels: { ...labels(allocation) },
						annotations: {
							...sessionSandboxIdentityAnnotationsV1(allocation),
							"agent-infra.agora.io/fence": String(allocation.resourceFence),
							"agent-infra.agora.io/managed": "session-sandbox-v1",
						},
					},
				};
				const existing = progressByKind.get(prior.kind);
				const current = await options.client.read(prior.kind, prior.name);
				if (!current && existing?.deleteAttempted) {
					const absence = existing.absence ?? {
						kind: existing.resource.kind,
						namespace: existing.resource.namespace,
						name: existing.resource.name,
					};
					await record(
						existing.resource,
						"absent",
						existing.deleteCallResult,
						absence,
					);
					deletedResources.push({
						resource: existing.resource,
						preconditions: existing.preconditions,
						absence,
					});
					continue;
				}
				if (
					!current ||
					!owned(current, expected, allocation) ||
					current.metadata?.uid !== prior.uid ||
					!current.metadata.resourceVersion
				)
					throw new WorkloadKubernetesError("conflict");
				if (
					existing &&
					(existing.resource.uid !== current.metadata?.uid ||
						(!terminatingRetry(current, existing) &&
							existing.preconditions.resourceVersion !==
								current.metadata.resourceVersion))
				)
					throw new WorkloadKubernetesError("conflict");
				const identity = existing
					? existing.resource
					: {
							...prior,
							resourceVersion: current.metadata.resourceVersion,
						};
				if (!existing?.deleteAttempted)
					await record(identity, "delete-requested", "not-attempted");
				if (terminatingRetry(current, existing))
					throw new WorkloadKubernetesError("unavailable");
				let callResult: SessionSandboxDeletionProgressV1["deleteCallResult"];
				try {
					if (!options.client.deleteResult)
						throw new WorkloadKubernetesError("unavailable");
					const result = await options.client.deleteResult(current);
					callResult = result === "absent" ? "unknown" : result;
				} catch (error) {
					if (existing?.deleteCallResult !== "acknowledged")
						await record(
							identity,
							"unknown",
							error instanceof WorkloadKubernetesError &&
								error.code !== "unavailable"
								? "failed"
								: "unknown",
						);
					throw error;
				}
				await record(identity, "delete-requested", callResult);
				if (await options.client.read(prior.kind, prior.name))
					throw new WorkloadKubernetesError("unavailable");
				await record(identity, "absent", callResult, {
					kind: prior.kind,
					namespace: identity.namespace,
					name: identity.name,
				});
				deletedResources.push({
					resource: {
						...prior,
						resourceVersion: current.metadata.resourceVersion,
					},
					preconditions: {
						uid: prior.uid,
						resourceVersion: current.metadata.resourceVersion,
					},
					absence: {
						kind: prior.kind,
						namespace: prior.namespace,
						name: prior.name,
					},
				});
			}

			const pvcExpected = expectedResources.find(
				(resource) => resource.kind === "PersistentVolumeClaim",
			);
			if (!pvcExpected) throw new WorkloadKubernetesError("policy");
			const pvc = await options.client.read(
				"PersistentVolumeClaim",
				pvcExpected.metadata?.name ?? "",
			);
			const pvcPrior = previousByKind.get("PersistentVolumeClaim");
			if (
				!pvc ||
				!pvcPrior ||
				!owned(pvc, pvcExpected, allocation) ||
				pvc.metadata?.uid !== pvcPrior.uid ||
				!pvc.metadata.resourceVersion
			)
				throw new WorkloadKubernetesError("conflict");
			return {
				schemaVersion: 1,
				sandboxId: allocation.sandboxId,
				sessionId: allocation.sessionId,
				sourceGeneration: context.sourceGeneration ?? allocation.generation,
				sourceResourceFence:
					context.sourceResourceFence ?? allocation.resourceFence,
				targetGeneration: context.targetGeneration ?? allocation.generation,
				targetResourceFence:
					context.targetResourceFence ?? allocation.resourceFence,
				removed: deletedResources,
				retainedPVC: {
					...pvcPrior,
					resourceVersion: pvc.metadata.resourceVersion,
				},
			};
		},
	};
}
