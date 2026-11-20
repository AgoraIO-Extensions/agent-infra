import {
	CODEX_SESSION_EXECUTOR_BINDING_ENV,
	type CodexSessionExecutorBindingV1,
	executorIdentityFileRootV1,
	executorIdentityInputRootV1,
} from "@agent-infra/agent-runtime";
import {
	type CodexSessionExecutorResourcePolicyV1,
	type SessionSandboxReserveConfigurationV1,
	sessionSandboxResourceCostsV1 as sharedSessionSandboxResourceCostsV1,
	validateCodexSessionExecutorResourcePolicyV1,
} from "@agent-infra/platform-core";
import type {
	V1Container,
	V1EnvVar,
	V1PodSpec,
	V1Volume,
} from "@kubernetes/client-node";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import { agentContainerSecurityContext } from "./kubernetes-runtime-comparison.js";

/** Independent deployment approval; the legacy container-boundary flag cannot enable it. */
export type CodexSessionExecutorPolicyV1 = CodexSessionExecutorResourcePolicyV1;

export function validateCodexSessionExecutorPolicyV1(
	policy: CodexSessionExecutorPolicyV1,
): void {
	try {
		validateCodexSessionExecutorResourcePolicyV1(policy);
	} catch {
		throw new WorkloadKubernetesError("policy");
	}
}

export const sessionExecutorContainerNameV1 = "codex-session-executor";
export const sessionExecutorInitContainerNameV1 =
	"codex-session-workspace-init";
export const sessionExecutorBindingSecretKeyV1 = "session-executor-binding";
export const sessionExecutorAttestationSecretKeyV1 =
	"session-executor-attestation";
export const sessionExecutorPodUidEnvironmentV1 = "AGENT_INFRA_RUNTIME_POD_UID";
export const executorStartupDeadlineAnnotationV1 =
	"agent-infra.agora.io/executor-startup-deadline";

export function executorStartupRefV1(binding: CodexSessionExecutorBindingV1) {
	return `${binding.podName}-executor-${binding.resourceFence}`;
}

export function executorStartupPodProjectionV1(
	binding: CodexSessionExecutorBindingV1,
	issuerPublicKey: string,
	init: V1Container,
	host: V1Container,
	runner: V1Container,
	startupRef?: string,
) {
	const ref = startupRef ?? executorStartupRefV1(binding);
	const podUid = sessionExecutorPodEnvironmentV1()[0];
	if (!podUid) throw new WorkloadKubernetesError("policy");
	const common: V1EnvVar[] = [
		{ name: "AGENT_INFRA_EXECUTOR_STARTUP_REF", value: ref },
		{
			name: "AGENT_INFRA_EXECUTOR_STARTUP_DEADLINE",
			valueFrom: {
				fieldRef: {
					apiVersion: "v1",
					fieldPath: `metadata.annotations['${executorStartupDeadlineAnnotationV1}']`,
				},
			},
		},
	];
	const issuer = {
		name: "AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY",
		value: issuerPublicKey,
	};
	init.env = [...(init.env ?? []), ...common, podUid, issuer];
	runner.env = [...(runner.env ?? []), ...common, issuer];
	host.env = [...(host.env ?? []), ...common];
	const volumes: V1Volume[] = [
		{ name: "executor-bootstrap", secret: { secretName: ref } },
	];
	for (const [role, container] of [
		["host", host],
		["runner", runner],
	] as const) {
		const name = `executor-identity-${role}`;
		volumes.push({ name, emptyDir: { medium: "Memory", sizeLimit: "1Mi" } });
		init.volumeMounts = [
			...(init.volumeMounts ?? []),
			{
				name: "executor-bootstrap",
				mountPath: `${executorIdentityInputRootV1}/${role}`,
				subPath: role,
				readOnly: true,
			},
			{ name, mountPath: `${executorIdentityFileRootV1}/${role}` },
		];
		container.volumeMounts = [
			...(container.volumeMounts ?? []),
			{ name, mountPath: executorIdentityFileRootV1 },
		];
	}
	return volumes;
}

export function sessionExecutorPodEnvironmentV1(): V1EnvVar[] {
	return (
		[
			[sessionExecutorPodUidEnvironmentV1, "metadata.uid"],
			["AGENT_INFRA_RUNTIME_POD_NAME", "metadata.name"],
			["AGENT_INFRA_RUNTIME_NAMESPACE", "metadata.namespace"],
		] as const
	).map(([name, fieldPath]) => ({
		name,
		valueFrom: { fieldRef: { apiVersion: "v1", fieldPath } },
	}));
}

export function sessionExecutorPodProjectionV1(input: {
	readonly binding: CodexSessionExecutorBindingV1;
	readonly policy: CodexSessionExecutorPolicyV1;
}) {
	validateCodexSessionExecutorPolicyV1(input.policy);
	const binding = {
		name: CODEX_SESSION_EXECUTOR_BINDING_ENV,
		value: JSON.stringify(input.binding),
	};
	const base = {
		image: input.binding.imageDigest,
		imagePullPolicy: "IfNotPresent",
		resources: structuredClone(input.policy.resources),
		securityContext: agentContainerSecurityContext(),
	};
	const command = ["/bin/sh", "/app/start-runtime-host.sh"];
	const init: V1Container = {
		...base,
		name: sessionExecutorInitContainerNameV1,
		command,
		args: ["--session-executor", "init"],
		env: [binding],
		volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
	};
	const executor: V1Container = {
		...base,
		name: sessionExecutorContainerNameV1,
		command,
		args: ["--session-executor", "run"],
		env: [
			binding,
			...sessionExecutorPodEnvironmentV1().filter(
				(entry) => entry.name === sessionExecutorPodUidEnvironmentV1,
			),
		],
		volumeMounts: [
			{
				name: "workspace",
				mountPath: input.binding.workspaceRoot,
				subPath: input.binding.workspaceSubPath,
			},
			{ name: "executor-tmp", mountPath: "/tmp" },
		],
	};
	const volume: V1Volume = {
		name: "executor-tmp",
		emptyDir: {
			medium: "Memory",
			sizeLimit: input.policy.tmpSizeLimit ?? "128Mi",
		},
	};
	const placement: Pick<
		V1PodSpec,
		"nodeSelector" | "runtimeClassName" | "tolerations"
	> = input.policy.placement
		? input.policy.placement.runtimeClassName
			? {
					nodeSelector: {
						"kubernetes.io/arch": input.policy.placement.architecture,
					},
					runtimeClassName: input.policy.placement.runtimeClassName,
				}
			: {
					nodeSelector: {
						type: "virtual-kubelet",
						"kubernetes.io/arch": input.policy.placement.architecture,
					},
					tolerations: [
						{
							key: "virtual-kubelet.io/provider",
							operator: "Equal",
							value: "alibabacloud",
							effect: "NoSchedule",
						},
					],
				}
		: {};
	return { init, executor, volume, placement };
}

/** Preserve the adapter error while sharing accounting with deployment verification. */
export function sessionSandboxResourceCostsV1(
	policy: Parameters<typeof sharedSessionSandboxResourceCostsV1>[0],
) {
	try {
		return sharedSessionSandboxResourceCostsV1(policy);
	} catch {
		throw new WorkloadKubernetesError("policy");
	}
}

export function validateSessionExecutorResourceCostsV1(
	policy: Parameters<typeof sessionSandboxResourceCostsV1>[0],
	resourceConfigurationHash: string,
	configuration:
		| Pick<SessionSandboxReserveConfigurationV1, "resourceCosts">
		| undefined,
): void {
	if (!policy.codexSessionExecutor) return;
	const required = sessionSandboxResourceCostsV1(policy);
	const charge = configuration?.resourceCosts.find(
		(item) => item.resourceConfigurationHash === resourceConfigurationHash,
	)?.resources;
	if (
		!charge ||
		(["cpuMillis", "memoryBytes", "storageBytes"] as const).some(
			(name) =>
				!Number.isSafeInteger(charge[name]) || charge[name] < required[name],
		)
	)
		throw new Error("CODEX_SESSION_EXECUTOR_RESOURCE_COST_INVALID");
}
