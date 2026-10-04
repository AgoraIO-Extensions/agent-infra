import type { AgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import type { KubernetesWorkloadPolicyV1 } from "./kubernetes-runtime-adapter.js";
import { workloadResourceNameV1 } from "./kubernetes-runtime-comparison.js";

/** Deployment-owned Agent bindings, never supplied by workload env or metadata. */
export interface AgentRuntimeTlsBindingV1 {
	readonly agentId: string;
	readonly namespace: string;
	readonly serviceDnsNames: readonly string[];
	readonly serverSecretRef: { readonly name: string };
}

export function validateRuntimeTlsPolicyV1(policy: KubernetesWorkloadPolicyV1) {
	if (policy.runtimeTls === undefined) return;
	try {
		if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(policy.namespace))
			throw new Error();
		if (!Array.isArray(policy.runtimeTls)) throw new Error();
		const agents = new Set<string>();
		const secrets = new Set<string>();
		for (const binding of policy.runtimeTls) {
			if (
				!binding ||
				Object.keys(binding).sort().join(",") !==
					"agentId,namespace,serverSecretRef,serviceDnsNames" ||
				typeof binding.agentId !== "string" ||
				!binding.agentId.trim() ||
				binding.namespace !== policy.namespace ||
				!binding.serverSecretRef ||
				Object.keys(binding.serverSecretRef).join(",") !== "name" ||
				typeof binding.serverSecretRef.name !== "string" ||
				binding.serverSecretRef.name === policy.tlsSecretName ||
				binding.serverSecretRef.name.length > 253 ||
				!binding.serverSecretRef.name
					.split(".")
					.every((part: string) =>
						/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(part),
					) ||
				agents.has(binding.agentId) ||
				secrets.has(binding.serverSecretRef.name)
			)
				throw new Error();
			const name = workloadResourceNameV1(binding.agentId);
			const expected = [
				`${name}.${policy.namespace}.svc`,
				`${name}-probe.${policy.namespace}.svc`,
			];
			if (
				!Array.isArray(binding.serviceDnsNames) ||
				binding.serviceDnsNames.length !== 2 ||
				!expected.every((dns) => binding.serviceDnsNames.includes(dns))
			)
				throw new Error();
			agents.add(binding.agentId);
			secrets.add(binding.serverSecretRef.name);
		}
	} catch {
		throw new WorkloadKubernetesError("policy");
	}
}

export function runtimeTlsBindingV1(
	policy: KubernetesWorkloadPolicyV1,
	value: AgentWorkloadDesiredV1,
) {
	if (value.runtimeManifest.interactionMode === "self-managed")
		return undefined;
	validateRuntimeTlsPolicyV1(policy);
	const binding = policy.runtimeTls?.find(
		(entry) => entry.agentId === value.agentId,
	);
	if (
		!binding ||
		Object.hasOwn(value.env, "AGENT_INFRA_RUNTIME_TLS_BINDING") ||
		value.secretRefs.some((ref) => ref.name === binding.serverSecretRef.name)
	) {
		throw new WorkloadKubernetesError("policy");
	}
	return binding;
}

export function runtimeTlsEnvironmentV1(
	binding: AgentRuntimeTlsBindingV1 | undefined,
) {
	return binding
		? [
				{
					name: "AGENT_INFRA_RUNTIME_TLS_BINDING",
					value: JSON.stringify({
						agentId: binding.agentId,
						namespace: binding.namespace,
						serviceDnsNames: binding.serviceDnsNames,
					}),
				},
			]
		: [];
}
