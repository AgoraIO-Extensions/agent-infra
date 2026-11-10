import {
	CODEX_SESSION_EXECUTOR_BINDING_ENV,
	type CodexSessionExecutorBindingV1,
} from "@agent-infra/agent-runtime";
import type { SessionSandboxReserveConfigurationV1 } from "@agent-infra/platform-core";
import type { V1Container, V1EnvVar, V1Volume } from "@kubernetes/client-node";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import {
	agentContainerSecurityContext,
	quantityRatio,
} from "./kubernetes-runtime-comparison.js";

/** Independent deployment approval; the legacy container-boundary flag cannot enable it. */
export interface CodexSessionExecutorPolicyV1 {
	readonly resources: {
		readonly requests: { readonly cpu: string; readonly memory: string };
		readonly limits: { readonly cpu: string; readonly memory: string };
	};
	readonly tmpSizeLimit?: string;
}

export function validateCodexSessionExecutorPolicyV1(
	policy: CodexSessionExecutorPolicyV1,
): void {
	if (
		!policy ||
		Object.keys(policy).some(
			(key) => key !== "resources" && key !== "tmpSizeLimit",
		) ||
		!policy.resources ||
		Object.keys(policy.resources).sort().join(",") !== "limits,requests"
	)
		throw new WorkloadKubernetesError("policy");
	for (const level of ["requests", "limits"] as const) {
		const resources = policy.resources[level];
		if (!resources || Object.keys(resources).sort().join(",") !== "cpu,memory")
			throw new WorkloadKubernetesError("policy");
	}
	for (const name of ["cpu", "memory"] as const) {
		if (
			typeof policy.resources.requests[name] !== "string" ||
			typeof policy.resources.limits[name] !== "string"
		)
			throw new WorkloadKubernetesError("policy");
		const request = quantityRatio(policy.resources.requests[name]);
		const limit = quantityRatio(policy.resources.limits[name]);
		if (
			!request ||
			!limit ||
			request[0] <= 0n ||
			limit[0] <= 0n ||
			request[0] * limit[1] > limit[0] * request[1]
		)
			throw new WorkloadKubernetesError("policy");
	}
	if (
		policy.tmpSizeLimit !== undefined &&
		typeof policy.tmpSizeLimit !== "string"
	)
		throw new WorkloadKubernetesError("policy");
	const tmp = quantityRatio(policy.tmpSizeLimit ?? "128Mi");
	if (!tmp || tmp[0] <= 0n) throw new WorkloadKubernetesError("policy");
}

export const sessionExecutorContainerNameV1 = "codex-session-executor";
export const sessionExecutorInitContainerNameV1 =
	"codex-session-workspace-init";
export const sessionExecutorBindingSecretKeyV1 = "session-executor-binding";
export const sessionExecutorAttestationSecretKeyV1 =
	"session-executor-attestation";
export const sessionExecutorPodUidEnvironmentV1 = "AGENT_INFRA_RUNTIME_POD_UID";

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
	return { init, executor, volume };
}

/** Store budgets charge concurrent containers; the init uses no more than the executor. */
export function sessionSandboxResourceCostsV1(policy: {
	readonly resources: CodexSessionExecutorPolicyV1["resources"];
	readonly storageSize: string;
	readonly codexSessionExecutor?: CodexSessionExecutorPolicyV1;
}) {
	if (policy.codexSessionExecutor)
		validateCodexSessionExecutorPolicyV1(policy.codexSessionExecutor);
	const quantity = (values: readonly string[], scale: bigint) => {
		let numerator = 0n;
		let denominator = 1n;
		for (const value of values) {
			const ratio = quantityRatio(value);
			if (!ratio || ratio[0] <= 0n) throw new WorkloadKubernetesError("policy");
			numerator = numerator * ratio[1] + ratio[0] * denominator;
			denominator *= ratio[1];
		}
		const count = (numerator * scale + denominator - 1n) / denominator;
		if (count > BigInt(Number.MAX_SAFE_INTEGER))
			throw new WorkloadKubernetesError("policy");
		return Number(count);
	};
	const limits = policy.codexSessionExecutor?.resources.limits;
	return {
		cpuMillis: quantity(
			[policy.resources.limits.cpu, ...(limits ? [limits.cpu] : [])],
			1000n,
		),
		memoryBytes: quantity(
			[policy.resources.limits.memory, ...(limits ? [limits.memory] : [])],
			1n,
		),
		storageBytes: quantity([policy.storageSize], 1n),
	};
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
