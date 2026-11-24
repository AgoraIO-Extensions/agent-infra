import { piPodPaths } from "@agent-infra/agent-runtime";
import {
	quantityRatioV1,
	type WorkloadControlResourcesV1,
} from "@agent-infra/platform-core";
import type { V1Container, V1PodSpec } from "@kubernetes/client-node";

export const piCompanionName = "pi-paseo";

// Kubernetes accounts both containers towards the existing Session allocation.
export function piContainerResources(
	total: WorkloadControlResourcesV1,
	role: "host" | "pi",
) {
	const result = {
		requests: { ...total.requests },
		limits: { ...total.limits },
	};
	for (const level of ["limits", "requests"] as const) {
		for (const key of ["cpu", "memory", "ephemeral-storage"] as const) {
			const value = total[level][key];
			if (value === undefined) continue;
			const ratio = quantityRatioV1(value);
			const scale = key === "cpu" ? 1000n : 1n;
			if (!ratio || (ratio[0] * scale) % ratio[1] !== 0n)
				throw new Error("PI_POD_RESOURCES_INVALID");
			const units = (ratio[0] * scale) / ratio[1];
			if (units < 2n) throw new Error("PI_POD_RESOURCES_INVALID");
			const host = units / 2n;
			result[level][key] =
				String(role === "host" ? host : units - host) +
				(key === "cpu" ? "m" : "");
		}
	}
	return result;
}

export function piCompanionImage(image: string) {
	return {
		name: piCompanionName,
		image,
		command: [
			"/usr/bin/tini",
			"-s",
			"--",
			"/usr/local/bin/node",
			"--disable-sigusr1",
			"/opt/paseo/companion.mjs",
		],
	};
}

/** The provider receives its own state, session workspaces and read-only launch permits. */
export function addPiCompanion(
	spec: V1PodSpec,
	volume: string,
	total: WorkloadControlResourcesV1,
) {
	const host = spec.containers[0];
	if (
		!host?.image ||
		spec.containers.length !== 1 ||
		!spec.volumes?.some((v) => v.name === volume)
	)
		throw new Error("PI_POD_LAYOUT_INVALID");
	const requests = { name: "pi-requests", mountPath: piPodPaths.requests };
	const sockets = { name: "pi-sockets", mountPath: piPodPaths.sockets };
	const workspace = {
		name: volume,
		subPath: "pi-paseo-workspaces",
		mountPath: piPodPaths.workspaces,
	};
	host.volumeMounts ??= [];
	host.volumeMounts.push(requests, { ...sockets, readOnly: true }, workspace);
	host.resources = piContainerResources(total, "host");
	for (const name of ["pi-requests", "pi-sockets", "pi-tmp"])
		spec.volumes.push({
			name,
			emptyDir: {
				medium: "Memory",
				sizeLimit: name === "pi-tmp" ? "128Mi" : "1Mi",
			},
		});
	const companion: V1Container = {
		...piCompanionImage(host.image),
		imagePullPolicy: "IfNotPresent",
		securityContext: {
			runAsNonRoot: true,
			runAsUser: 1000,
			runAsGroup: 1000,
			readOnlyRootFilesystem: true,
			allowPrivilegeEscalation: false,
			capabilities: { drop: ["ALL"] },
			seccompProfile: { type: "RuntimeDefault" },
		},
		resources: piContainerResources(total, "pi"),
		volumeMounts: [
			{ ...requests, readOnly: true },
			sockets,
			workspace,
			{ name: volume, subPath: "pi-paseo-state", mountPath: piPodPaths.state },
			{ name: "pi-tmp", mountPath: "/tmp" },
		],
	};
	Object.assign(spec, {
		shareProcessNamespace: false,
		hostPID: false,
		hostIPC: false,
		hostNetwork: false,
		automountServiceAccountToken: false,
		enableServiceLinks: false,
	});
	spec.containers.push(companion);
}
