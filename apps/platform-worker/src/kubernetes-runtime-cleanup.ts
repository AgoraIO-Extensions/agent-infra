import type { AgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import type {
	KubernetesObject,
	V1Ingress,
	V1PersistentVolumeClaim,
	V1Pod,
	V1Service,
	V1StatefulSet,
} from "@kubernetes/client-node";
import {
	type WorkerKubernetesClientV1,
	WorkloadKubernetesError,
	type WorkloadResourceKind,
} from "./kubernetes-client.js";
import {
	agentAnnotation,
	fingerprintAnnotation,
	hasClosedSelectorCollision,
	hasSameStructure,
	matchesServiceSpec,
	ownerLabel,
	revisionLabel,
	routeSelector,
	secretConfigRevisionAnnotation,
	workloadResourceNameV1,
} from "./kubernetes-runtime-comparison.js";
import type { createKubernetesWorkloadPolicyHelpersV1 } from "./kubernetes-runtime-policy.js";

export function createKubernetesWorkloadCleanupV1(
	dependencies: { readonly client: WorkerKubernetesClientV1 } & Pick<
		ReturnType<typeof createKubernetesWorkloadPolicyHelpersV1>,
		"own" | "desired" | "selector" | "serviceSpec"
	>,
) {
	const { client, own, desired, selector, serviceSpec } = dependencies;
	async function remove(
		kind: WorkloadResourceKind,
		name: string,
		value: { agentId: string; workloadRevision: number; fence: number },
	): Promise<boolean> {
		const current = await client.read(kind, name);
		if (!current) return true;
		own(current, value.agentId, value.workloadRevision, value.fence);
		if (!current.metadata?.deletionTimestamp) await client.delete(current);
		return (await client.read(kind, name)) === null;
	}
	async function closeRoute(input: unknown): Promise<boolean> {
		const value = desired(input);
		const current = await client.read<V1StatefulSet>(
			"StatefulSet",
			workloadResourceNameV1(value.agentId),
		);
		if (current)
			own(current, value.agentId, value.workloadRevision, value.fence);
		return closeAgentAtFence(value);
	}
	function hasOnlyControllerRoutingMetadata(resource: KubernetesObject) {
		return (
			Object.keys(resource.metadata?.labels ?? {}).every(
				(key) => key === ownerLabel || key === revisionLabel,
			) &&
			Object.keys(resource.metadata?.annotations ?? {}).every((key) =>
				[
					agentAnnotation,
					secretConfigRevisionAnnotation,
					"agent-infra.agora.io/fence",
					fingerprintAnnotation,
				].includes(key),
			)
		);
	}
	async function closeAgentAtFence(value: {
		agentId: string;
		workloadRevision: number;
		fence: number;
	}): Promise<boolean> {
		const name = workloadResourceNameV1(value.agentId);
		// Probe Services must never retain an alternate externally reachable route.
		const probeName = `${name}-probe`;
		const [probe, service, routeIngress] = await Promise.all([
			client.read<V1Service>("Service", probeName),
			client.read<V1Service>("Service", name),
			client.read<V1Ingress>("Ingress", name),
		]);
		for (const resource of [probe, service, routeIngress]) {
			if (resource)
				own(resource, value.agentId, value.workloadRevision, value.fence);
		}
		const outcomes = await Promise.allSettled([
			(async () => {
				let resourcesClosed = true;
				if (probe) {
					own(probe, value.agentId, value.workloadRevision, value.fence);
					const expectedProbeSpec = {
						type: "ClusterIP",
						selector: {
							[ownerLabel]: name,
							[revisionLabel]:
								probe.metadata?.labels?.[revisionLabel] ?? "closed",
						},
						ports: probe.spec?.ports?.map((port) => ({
							name: port.name,
							port: port.port,
							targetPort: port.targetPort,
						})),
					};
					if (
						(!matchesServiceSpec(probe.spec, expectedProbeSpec) ||
							!hasOnlyControllerRoutingMetadata(probe)) &&
						!(await remove("Service", probeName, value))
					)
						resourcesClosed = false;
				}
				return resourcesClosed;
			})(),
			(async () => {
				let resourcesClosed = true;
				// Remove the selected route's backend before any candidate Pod can start.
				if (service) {
					own(service, value.agentId, value.workloadRevision, value.fence);
					const safeServiceSpec = {
						type: "ClusterIP",
						selector: service.spec?.selector,
						ports: service.spec?.ports?.map((port) => ({
							name: port.name,
							port: port.port,
							targetPort: port.targetPort,
						})),
					};
					if (
						!matchesServiceSpec(service.spec, safeServiceSpec) ||
						!hasOnlyControllerRoutingMetadata(service)
					) {
						return remove("Service", name, value);
					}
					const pods = await client.list<V1Pod>("Pod", selector(value.agentId));
					if (hasClosedSelectorCollision(pods, name))
						return remove("Service", name, value);
					if (
						!hasSameStructure(service.spec?.selector, {
							[ownerLabel]: name,
							[revisionLabel]: "closed",
						}) ||
						service.metadata?.labels?.[revisionLabel] !==
							String(value.workloadRevision) ||
						service.metadata?.annotations?.["agent-infra.agora.io/fence"] !==
							String(value.fence)
					) {
						await client.replace({
							...service,
							metadata: {
								...service.metadata,
								labels: {
									...service.metadata?.labels,
									[revisionLabel]: String(value.workloadRevision),
								},
								annotations: {
									...service.metadata?.annotations,
									"agent-infra.agora.io/fence": String(value.fence),
									[fingerprintAnnotation]: "",
								},
							},
							spec: {
								...service.spec,
								selector: { [ownerLabel]: name, [revisionLabel]: "closed" },
							},
						});
					}
					const closed = await client.read<V1Service>("Service", name);
					if (closed) {
						own(closed, value.agentId, value.workloadRevision, value.fence);
						if (
							!hasOnlyControllerRoutingMetadata(closed) ||
							closed.metadata?.labels?.[revisionLabel] !==
								String(value.workloadRevision) ||
							closed.metadata?.annotations?.["agent-infra.agora.io/fence"] !==
								String(value.fence) ||
							!matchesServiceSpec(closed.spec, {
								...safeServiceSpec,
								selector: { [ownerLabel]: name, [revisionLabel]: "closed" },
							})
						)
							resourcesClosed = false;
					}
				}
				return resourcesClosed;
			})(),
			remove("Ingress", name, value),
		]);
		const failure = outcomes.find(
			(outcome): outcome is PromiseRejectedResult =>
				outcome.status === "rejected",
		);
		if (failure) throw failure.reason;
		return outcomes.every(
			(outcome) => outcome.status === "fulfilled" && outcome.value,
		);
	}
	async function closeAgent(
		agentId: string,
		workloadRevision: number,
		fence: number,
	): Promise<boolean> {
		return closeAgentAtFence({ agentId, workloadRevision, fence });
	}
	async function cleanupAgentAtFence(
		value: { agentId: string; workloadRevision: number; fence: number },
		deleteNewVolume: boolean,
	) {
		const name = workloadResourceNameV1(value.agentId);
		const pvc = await client.read<V1PersistentVolumeClaim>(
			"PersistentVolumeClaim",
			`${name}-data`,
		);
		// Reject a stale cleanup before advancing even the durable PVC fence.
		const existingResources = await Promise.all([
			client.read("StatefulSet", name),
			client.read("Service", name),
			client.read("Service", `${name}-probe`),
			client.read("ServiceAccount", name),
			client.read("NetworkPolicy", name),
			client.read("Ingress", name),
		]);
		for (const resource of [pvc, ...existingResources]) {
			if (resource)
				own(resource, value.agentId, value.workloadRevision, value.fence);
		}
		if (pvc) {
			own(pvc, value.agentId, value.workloadRevision, value.fence);
			if (
				!pvc.metadata?.deletionTimestamp &&
				(pvc.metadata?.labels?.[revisionLabel] !==
					String(value.workloadRevision) ||
					pvc.metadata?.annotations?.["agent-infra.agora.io/fence"] !==
						String(value.fence))
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
		if (!(await closeAgentAtFence(value))) return false;
		if (
			!(await remove("StatefulSet", name, value)) ||
			(await client.list("Pod", selector(value.agentId))).length > 0
		)
			return false;
		for (const kind of ["Service", "ServiceAccount", "NetworkPolicy"] as const)
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
	}
	function validateRecoveryCreation(
		value: AgentWorkloadDesiredV1,
		creation: { revision: number; fence: number },
	) {
		if (
			!Number.isSafeInteger(creation.revision) ||
			creation.revision < 1 ||
			creation.revision > value.workloadRevision ||
			!Number.isSafeInteger(creation.fence) ||
			creation.fence < 1 ||
			creation.fence > value.fence
		)
			throw new WorkloadKubernetesError("policy");
	}
	async function recoveryManagementResources(value: AgentWorkloadDesiredV1) {
		const name = workloadResourceNameV1(value.agentId);
		const resources = await Promise.all([
			client.read<V1Service>("Service", name),
			client.read("Ingress", name),
			client.read("Service", `${name}-probe`),
			client.read("ServiceAccount", name),
			client.read("NetworkPolicy", name),
			client.read("PersistentVolumeClaim", value.persistentVolume.name),
		]);
		// A newer management fence on any retained resource invalidates this
		// cleanup, including retries after the candidate StatefulSet disappeared.
		for (const resource of resources)
			if (resource)
				own(resource, value.agentId, value.workloadRevision, value.fence);
		return resources;
	}
	async function recoveryCleanupIsClosed(value: AgentWorkloadDesiredV1) {
		const name = workloadResourceNameV1(value.agentId);
		const [service, ingress] = await recoveryManagementResources(value);
		return (
			ingress === null &&
			(service === null ||
				(hasOnlyControllerRoutingMetadata(service) &&
					service.metadata?.labels?.[revisionLabel] ===
						String(value.workloadRevision) &&
					service.metadata?.annotations?.["agent-infra.agora.io/fence"] ===
						String(value.fence) &&
					matchesServiceSpec(
						service.spec,
						serviceSpec(
							value,
							routeSelector(name, value.workloadRevision, "closed"),
						),
					)))
		);
	}

	async function statefulSet(value: AgentWorkloadDesiredV1) {
		const current = await client.read<V1StatefulSet>(
			"StatefulSet",
			workloadResourceNameV1(value.agentId),
		);
		if (current) {
			own(current, value.agentId, value.workloadRevision, value.fence);
			if (
				value.expectedWorkload.state === "present" &&
				current.metadata?.uid !== value.expectedWorkload.workloadUid
			)
				throw new WorkloadKubernetesError("conflict");
		}
		return current;
	}
	return {
		remove,
		closeRoute,
		closeAgentAtFence,
		closeAgent,
		cleanupAgentAtFence,
		validateRecoveryCreation,
		recoveryManagementResources,
		recoveryCleanupIsClosed,
		statefulSet,
	};
}
