import { createPrivateKey, X509Certificate } from "node:crypto";
import type { AgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import type { V1Secret } from "@kubernetes/client-node";
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

function isBase64(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		Buffer.from(value, "base64").toString("base64") === value
	);
}

/** Deployment-owned TLS material must be a complete Kubernetes TLS Secret. */
export function validateRuntimeTlsSecretV1(
	secret: V1Secret | null,
	name: string,
	serviceDnsNames: readonly string[],
): secret is V1Secret {
	if (
		!(
			secret &&
			secret.metadata?.name === name &&
			!secret.metadata.deletionTimestamp &&
			secret.type === "kubernetes.io/tls" &&
			secret.stringData === undefined &&
			secret.data &&
			Object.keys(secret.data).length === 2 &&
			isBase64(secret.data["tls.crt"]) &&
			isBase64(secret.data["tls.key"])
		)
	)
		return false;
	try {
		const cert = Buffer.from(secret.data["tls.crt"], "base64").toString("utf8");
		const key = Buffer.from(secret.data["tls.key"], "base64").toString("utf8");
		if (cert.length > 131_072 || key.length > 32_768) return false;
		const pattern =
			/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
		const blocks = cert.match(pattern);
		if (!blocks?.length || cert.replace(pattern, "").trim()) return false;
		const chain = blocks.map((pem) => new X509Certificate(pem));
		const leaf = chain[0];
		if (
			!leaf ||
			leaf.ca ||
			!leaf.keyUsage?.includes("1.3.6.1.5.5.7.3.1") ||
			!leaf.checkPrivateKey(createPrivateKey(key))
		)
			return false;
		const now = Date.now();
		if (
			!chain.every((certificate, index) => {
				if (
					now < certificate.validFromDate.getTime() ||
					now >= certificate.validToDate.getTime()
				)
					return false;
				if (index === 0) return true;
				const child = chain[index - 1];
				return Boolean(
					certificate.ca &&
						child?.checkIssued(certificate) &&
						child.verify(certificate.publicKey),
				);
			})
		)
			return false;
		return (
			serviceDnsNames.length > 0 &&
			serviceDnsNames.every(
				(dns) =>
					leaf.checkHost(dns, { subject: "never", wildcards: false }) === dns,
			)
		);
	} catch {
		return false;
	}
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
