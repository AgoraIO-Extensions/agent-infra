import { createPublicKey } from "node:crypto";
import type { AgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import type { RuntimeModelProjectionV1 } from "@agent-infra/model-catalog";
import type { V1EnvVar } from "@kubernetes/client-node";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import {
	validateWorkloadNativeMetadataAuthV1,
	type WorkloadNativeMetadataAuthV1,
	workloadNativeMetadataEnvironmentV1,
} from "./workload-native-metadata-auth.js";

/** Public verification material and a deployment-provisioned transport token reference only. */
export interface WorkloadRuntimeAuthV1 {
	readonly nativeMetadata?: WorkloadNativeMetadataAuthV1;
	readonly workerId: string;
	readonly grantKeyId: string;
	readonly grantPublicKey: string;
	readonly grantIssuer: string;
	readonly serviceTokenSecret: { readonly name: string; readonly key: string };
}

export function validateWorkloadRuntimeAuthV1(
	input: WorkloadRuntimeAuthV1,
): void {
	try {
		if (
			Object.keys(input).sort().join(",") !==
				(input.nativeMetadata
					? "grantIssuer,grantKeyId,grantPublicKey,nativeMetadata,serviceTokenSecret,workerId"
					: "grantIssuer,grantKeyId,grantPublicKey,serviceTokenSecret,workerId") ||
			![input.grantKeyId, input.grantIssuer, input.workerId].every(
				(value) =>
					typeof value === "string" && /^[\x21-\x7e]{1,256}$/.test(value),
			) ||
			typeof input.grantPublicKey !== "string" ||
			!input.grantPublicKey.startsWith("-----BEGIN PUBLIC KEY-----") ||
			createPublicKey(input.grantPublicKey).asymmetricKeyType !== "ed25519" ||
			createPublicKey(input.grantPublicKey)
				.export({ type: "spki", format: "pem" })
				.toString()
				.trim() !== input.grantPublicKey.trim() ||
			Object.keys(input.serviceTokenSecret).sort().join(",") !== "key,name" ||
			!input.serviceTokenSecret.name
				.split(".")
				.every((part) => /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(part)) ||
			input.serviceTokenSecret.name.length > 253 ||
			!/^[-A-Za-z0-9_.]{1,253}$/.test(input.serviceTokenSecret.key)
		)
			throw new Error();
		validateWorkloadNativeMetadataAuthV1(input);
	} catch {
		throw new WorkloadKubernetesError("policy");
	}
}

export function workloadRuntimeAuthEnvironmentV1(
	auth: WorkloadRuntimeAuthV1,
	desired: AgentWorkloadDesiredV1,
	binding?: RuntimeModelProjectionV1["standardTemplateBinding"],
): V1EnvVar[] {
	return [
		...workloadNativeMetadataEnvironmentV1(auth, desired, binding),
		{
			name: "AGENT_INFRA_RUNTIME_READINESS_BINDING",
			value: JSON.stringify({
				workerId: auth.workerId,
				agentId: desired.agentId,
				workloadRevision: desired.workloadRevision,
				fence: desired.fence,
				imageDigest: desired.imageDigest,
			}),
		},
		{ name: "AGENT_INFRA_RUNTIME_AGENT_ID", value: desired.agentId },
		{
			name: "AGENT_INFRA_RUNTIME_DATA_DIR",
			value: `${desired.persistentVolume.mountPath}/runtime`,
		},
		{ name: "PORT", value: String(desired.service.port) },
		{ name: "AGENT_INFRA_RUNTIME_GRANT_KEY_ID", value: auth.grantKeyId },
		{
			name: "AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY",
			value: auth.grantPublicKey,
		},
		{ name: "AGENT_INFRA_RUNTIME_GRANT_ISSUER", value: auth.grantIssuer },
		{
			name: "AGENT_INFRA_RUNTIME_SERVICE_TOKEN",
			valueFrom: {
				secretKeyRef: { ...auth.serviceTokenSecret, optional: false },
			},
		},
	];
}
