import type { AgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import {
	canonicalDeploymentOriginV1,
	parseWorkloadHostnameRoutesV1,
	type WorkloadHostnameRoutesV1,
} from "./hostname-route-configuration.js";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import { workloadResourceNameV1 } from "./kubernetes-runtime-comparison.js";

export type { WorkloadHostnameRoutesV1 } from "./hostname-route-configuration.js";

const routeHostSuffixPattern =
	/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Build the only public route origin accepted by the Workload contract. */
export function createWorkloadInteractionOriginV1(input: {
	readonly routeHostSuffix: string;
	readonly agentId: string;
}) {
	if (!routeHostSuffixPattern.test(input.routeHostSuffix))
		throw new WorkloadKubernetesError("policy");
	const origin = `https://${workloadResourceNameV1(input.agentId)}.${input.routeHostSuffix}`;
	try {
		const url = new URL(origin);
		if (url.origin !== origin || url.protocol !== "https:")
			throw new Error("invalid route origin");
	} catch {
		throw new WorkloadKubernetesError("policy");
	}
	return { schemaVersion: 1 as const, origin };
}

export const publicBasePathEnvironmentV1 = "AGENT_INFRA_PUBLIC_BASE_PATH";

/** Only mutually trusted, prefix-compatible images may share this origin. */
export interface WorkloadPathRoutesV1 {
	readonly origin: string;
	readonly platformOrigin: string;
	readonly tlsSecretName: string;
	readonly agentIds: readonly string[];
}

export interface WorkloadPublicRoutePolicyV1 {
	readonly routeHostSuffix: string;
	readonly tlsSecretName: string;
	readonly pathRoutes?: WorkloadPathRoutesV1;
	readonly hostnameRoutes?: WorkloadHostnameRoutesV1;
}

function publicOrigin(value: string) {
	try {
		return canonicalDeploymentOriginV1(value);
	} catch {
		throw new WorkloadKubernetesError("policy");
	}
}

function hostnamePolicy(policy: WorkloadPublicRoutePolicyV1) {
	if (policy.hostnameRoutes === undefined) return undefined;
	try {
		return parseWorkloadHostnameRoutesV1(policy.hostnameRoutes);
	} catch {
		throw new WorkloadKubernetesError("policy");
	}
}

export function workloadPublicRouteV1(
	policy: WorkloadPublicRoutePolicyV1,
	agentId: string,
) {
	const name = workloadResourceNameV1(agentId);
	const hostname = hostnamePolicy(policy);
	if (hostname?.agentIds.includes(agentId)) {
		const interactionOrigin = createWorkloadInteractionOriginV1({
			routeHostSuffix: hostname.hostSuffix,
			agentId,
		});
		const host = new URL(interactionOrigin.origin).hostname;
		if (
			host.length > 253 ||
			host === publicOrigin(hostname.platformOrigin).hostname ||
			policy.pathRoutes?.agentIds.includes(agentId)
		)
			throw new WorkloadKubernetesError("policy");
		return {
			interactionOrigin,
			interactionPath: undefined,
			host,
			path: "/",
			tlsSecretName: name + "-tls",
		};
	}
	const selected = policy.pathRoutes;
	if (selected?.agentIds.includes(agentId)) {
		const origin = publicOrigin(selected.origin);
		const platform = publicOrigin(selected.platformOrigin);
		if (
			origin.hostname === platform.hostname ||
			selected.agentIds.length > 512 ||
			!/^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/.test(selected.tlsSecretName)
		)
			throw new WorkloadKubernetesError("policy");
		return {
			interactionOrigin: { schemaVersion: 1 as const, origin: origin.origin },
			interactionPath: `/a/${name}/`,
			host: origin.hostname,
			path: `/a/${name}/`,
			tlsSecretName: selected.tlsSecretName,
		};
	}
	const interactionOrigin = createWorkloadInteractionOriginV1({
		routeHostSuffix: policy.routeHostSuffix,
		agentId,
	});
	return {
		interactionOrigin,
		interactionPath: undefined,
		host: new URL(interactionOrigin.origin).hostname,
		path: "/",
		tlsSecretName: policy.tlsSecretName,
	};
}

export function workloadInteractionRouteV1(
	policy: WorkloadPublicRoutePolicyV1,
	agentId: string,
) {
	const route = workloadPublicRouteV1(policy, agentId);
	return {
		interactionOrigin: route.interactionOrigin,
		...(route.interactionPath
			? { interactionPath: route.interactionPath }
			: {}),
	};
}

export function assertWorkloadPublicRouteV1(
	policy: WorkloadPublicRoutePolicyV1,
	value: AgentWorkloadDesiredV1,
) {
	if (hostnamePolicy(policy)?.agentIds.includes(value.agentId)) {
		const expected = workloadPublicRouteV1(policy, value.agentId);
		if (
			value.route.exposure !== "self-managed" ||
			value.route.interactionOrigin?.origin !==
				expected.interactionOrigin.origin ||
			value.route.interactionPath !== undefined
		)
			throw new WorkloadKubernetesError("policy");
		return;
	}
	if (
		value.route.exposure !== "self-managed" &&
		!policy.pathRoutes?.agentIds.includes(value.agentId)
	)
		return;
	const expected = workloadPublicRouteV1(policy, value.agentId);
	const route = value.route;
	if (
		!expected.interactionPath &&
		(route.exposure !== "self-managed" || route.interactionPath === undefined)
	)
		return;
	if (
		(expected.interactionPath && route.exposure !== "self-managed") ||
		(route.exposure === "self-managed" &&
			(route.interactionOrigin?.origin !== expected.interactionOrigin.origin ||
				route.interactionPath !== expected.interactionPath))
	)
		throw new WorkloadKubernetesError("policy");
	if (!expected.interactionPath) return;
	if (
		Object.hasOwn(value.env, publicBasePathEnvironmentV1) ||
		value.multiService?.resources.some(
			(resource) =>
				(resource.kind === "Deployment" ||
					resource.kind === "StatefulSet" ||
					resource.kind === "Job") &&
				resource.spec.template.spec.containers.some((container) =>
					container.env?.some(
						(entry) => entry.name === publicBasePathEnvironmentV1,
					),
				),
		)
	)
		throw new WorkloadKubernetesError("policy");
}

export function workloadPublicRouteEnvironmentV1(
	value: AgentWorkloadDesiredV1,
) {
	return value.route.exposure === "self-managed" && value.route.interactionPath
		? [
				{
					name: publicBasePathEnvironmentV1,
					value: value.route.interactionPath,
				},
			]
		: [];
}
