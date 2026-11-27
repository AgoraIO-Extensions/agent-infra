import { piPodPaths } from "@agent-infra/agent-runtime";
import {
	piContainerResources,
	type WorkloadControlResourcesV1,
} from "@agent-infra/platform-core";
import type { V1Container, V1PodSpec } from "@kubernetes/client-node";

export const piCompanionName = "pi-paseo";

export function piCompanionImage(
	image: string,
	provider: "pi" | "codex" | "opencode" = "pi",
) {
	return {
		name: provider === "opencode" ? "opencode-paseo" : piCompanionName,
		image,
		...(provider === "codex"
			? { env: [{ name: "AGENT_INFRA_PASEO_PROVIDER", value: provider }] }
			: {}),
		command: [
			"/usr/bin/tini",
			"-s",
			"--",
			"/usr/local/bin/node",
			"--disable-sigusr1",
			"/opt/paseo/companion.mjs",
			...(provider === "opencode" ? ["opencode"] : []),
		],
	};
}

export function isOpenCodePaseoPodBinding(binding?: {
	readonly templateId: string;
	readonly driver: string;
	readonly transport?: string;
}): boolean {
	return (
		binding?.templateId === "opencode" &&
		binding.driver === "acp" &&
		binding.transport === "paseo-sdk-pod"
	);
}

/** The provider receives its own state, session workspaces and read-only launch permits. */
export function addPiCompanion(
	spec: V1PodSpec,
	volume: string,
	total: WorkloadControlResourcesV1,
	provider: "pi" | "codex" | "opencode" = "pi",
	companionCpuLimitPercent?: 80,
) {
	const host = spec.containers[0];
	if (
		(companionCpuLimitPercent !== undefined &&
			(provider !== "opencode" || companionCpuLimitPercent !== 80)) ||
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
	host.resources = piContainerResources(
		total,
		"host",
		companionCpuLimitPercent,
	);
	for (const name of ["pi-requests", "pi-sockets", "pi-tmp"])
		spec.volumes.push({
			name,
			emptyDir: {
				medium: "Memory",
				sizeLimit: name === "pi-tmp" ? "128Mi" : "1Mi",
			},
		});
	const companion: V1Container = {
		...piCompanionImage(host.image, provider),
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
		resources: piContainerResources(total, "pi", companionCpuLimitPercent),
		readinessProbe: {
			exec: {
				command: [
					"/usr/local/bin/node",
					"-e",
					'const s=require("node:net").connect(37651,"127.0.0.1",()=>s.write("?"));s.setTimeout(1000,()=>process.exit(1));s.on("error",()=>process.exit(1));s.once("data",b=>process.exit(b.toString()==="R"?0:1))',
				],
			},
			periodSeconds: 3,
			timeoutSeconds: 2,
		},
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
	return companion;
}
