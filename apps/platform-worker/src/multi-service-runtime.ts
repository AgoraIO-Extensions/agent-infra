import { createHash } from "node:crypto";
import type { AgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import type {
	KubernetesObject,
	V1Deployment,
	V1Ingress,
	V1NetworkPolicy,
	V1Service,
	V1ServiceAccount,
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
		{ kind: "Deployment" }
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
		if (current.metadata?.resourceVersion && current.metadata.uid)
			return client.replace({
				...object,
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
			| "Service"
			| "ServiceAccount"
			| "NetworkPolicy"
			| "Ingress",
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
	return {
		isMultiService,
		async apply(value: MultiServiceDesired) {
			for (const resource of value.multiService.resources) {
				if (resource.kind === "Deployment")
					await put(deployment(value, resource), value);
				if (resource.kind === "Service")
					await put(service(value, resource), value);
			}
			for (const resource of value.multiService.resources) {
				if (resource.kind === "Deployment")
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
				if (resource.kind !== "Deployment") continue;
				const current = await client.read<V1Deployment>(
					"Deployment",
					serviceResourceName(value.agentId, resource.metadata.name),
				);
				if (
					!current ||
					!owned(current, value) ||
					(current.status?.availableReplicas ?? 0) < 1
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
		async cleanupAgent(value: MultiServiceDesired) {
			let complete = await remove(
				"Ingress",
				workloadResourceNameV1(value.agentId),
				value,
			);
			for (const resource of value.multiService.resources) {
				if (resource.kind === "Deployment") {
					complete =
						(await remove(
							"NetworkPolicy",
							`${serviceResourceName(value.agentId, resource.metadata.name)}-network`,
							value,
						)) && complete;
					complete =
						(await remove(
							"Deployment",
							serviceResourceName(value.agentId, resource.metadata.name),
							value,
						)) && complete;
				}
				if (resource.kind === "Service")
					complete =
						(await remove(
							"Service",
							serviceResourceName(value.agentId, resource.metadata.name),
							value,
						)) && complete;
			}
			complete =
				(await remove(
					"ServiceAccount",
					workloadResourceNameV1(value.agentId),
					value,
				)) && complete;
			return complete;
		},
	};
}
