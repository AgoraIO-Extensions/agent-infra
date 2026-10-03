import { createPublicKey } from "node:crypto";
import type { AgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import type { RuntimeModelProjectionV1 } from "@agent-infra/model-catalog";
import type { V1EnvVar } from "@kubernetes/client-node";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import type { WorkloadRuntimeAuthV1 } from "./workload-runtime-auth.js";

type SecretReference = WorkloadRuntimeAuthV1["serviceTokenSecret"];
export interface WorkloadNativeMetadataAuthV1 {
	readonly issuer: string;
	readonly keyVersion: string;
	readonly publicKeyDerBase64: string;
	readonly maxActiveReads: number;
	readonly workerOrigin: string;
	readonly agents: ReadonlyMap<
		string,
		{
			readonly workerToHostTokenSecret: SecretReference;
			readonly hostToWorkerTokenSecret: SecretReference;
		}
	>;
}

export function validateWorkloadNativeMetadataAuthV1(
	auth: WorkloadRuntimeAuthV1,
): void {
	const value = auth.nativeMetadata;
	if (!value) return;
	try {
		const key = createPublicKey({
			key: Buffer.from(value.publicKeyDerBase64, "base64"),
			format: "der",
			type: "spki",
		});
		const origin = new URL(value.workerOrigin);
		if (
			key.asymmetricKeyType !== "ed25519" ||
			key.export({ format: "der", type: "spki" }).toString("base64") !==
				value.publicKeyDerBase64 ||
			key.export({ format: "der", type: "spki" }).equals(
				createPublicKey(auth.grantPublicKey).export({
					format: "der",
					type: "spki",
				}),
			) ||
			value.keyVersion === auth.grantKeyId ||
			![value.issuer, value.keyVersion].every(
				(name) =>
					typeof name === "string" &&
					/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(name),
			) ||
			!Number.isSafeInteger(value.maxActiveReads) ||
			value.maxActiveReads < 1 ||
			!["http:", "https:"].includes(origin.protocol) ||
			origin.username ||
			origin.password ||
			origin.pathname !== "/" ||
			origin.search ||
			origin.hash ||
			value.agents.size === 0
		)
			throw new Error();
		const references = new Set([
			`${auth.serviceTokenSecret.name}/${auth.serviceTokenSecret.key}`,
		]);
		for (const [agentId, tokens] of value.agents) {
			if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(agentId))
				throw new Error();
			for (const ref of [
				tokens.workerToHostTokenSecret,
				tokens.hostToWorkerTokenSecret,
			]) {
				if (
					Object.keys(ref).sort().join(",") !== "key,name" ||
					ref.name.length > 253 ||
					!ref.name
						.split(".")
						.every((part) =>
							/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(part),
						) ||
					!/^[-A-Za-z0-9_.]{1,253}$/.test(ref.key)
				)
					throw new Error();
				const id = `${ref.name}/${ref.key}`;
				if (references.has(id)) throw new Error();
				references.add(id);
			}
		}
	} catch {
		throw new WorkloadKubernetesError("policy");
	}
}

export function workloadNativeMetadataEnvironmentV1(
	auth: WorkloadRuntimeAuthV1,
	desired: AgentWorkloadDesiredV1,
	binding: RuntimeModelProjectionV1["standardTemplateBinding"],
): V1EnvVar[] {
	const value = auth.nativeMetadata;
	if (!value || binding?.driver !== "codex") return [];
	if (binding.imageDigest !== desired.imageDigest)
		throw new WorkloadKubernetesError("policy");
	const tokens = value.agents.get(desired.agentId);
	if (!tokens) throw new WorkloadKubernetesError("policy");
	return [
		{
			name: "AGENT_INFRA_RUNTIME_NATIVE_METADATA_CONFIG",
			value: JSON.stringify({
				schemaVersion: 1,
				workerId: auth.workerId,
				issuer: value.issuer,
				keyVersion: value.keyVersion,
				publicKeyDerBase64: value.publicKeyDerBase64,
				maxActiveReads: value.maxActiveReads,
				workerOrigin: value.workerOrigin,
			}),
		},
		{
			name: "AGENT_INFRA_RUNTIME_METADATA_WORKER_TOKEN",
			valueFrom: {
				secretKeyRef: { ...tokens.workerToHostTokenSecret, optional: false },
			},
		},
		{
			name: "AGENT_INFRA_RUNTIME_METADATA_HOST_TOKEN",
			valueFrom: {
				secretKeyRef: { ...tokens.hostToWorkerTokenSecret, optional: false },
			},
		},
	];
}
