import { createHash, generateKeyPairSync } from "node:crypto";
import {
	type RuntimeModelProjectionV4,
	runtimeModelInjectionV4,
	type StandardTemplateModelBindingV1,
	validateRuntimeModelProjectionV4,
} from "@agent-infra/model-catalog";
import {
	type SessionSandboxRuntimeInputV1,
	sessionSandboxServiceTokenV1,
} from "../session-workload-adapter.js";
import { containerBoundaryAttestationV1 } from "../container-boundary-attestation.js";
import type { WorkloadRuntimeAuthV1 } from "../workload-runtime-auth.js";

/** Synthetic deployment token; Sandboxes only ever receive tokens derived from it. */
export const sessionSandboxDeploymentTokenFixture =
	"synthetic-deployment-transport-proof";
const keys = generateKeyPairSync("ed25519");

export const sessionSandboxRuntimeAuthFixture: WorkloadRuntimeAuthV1 = {
	workerId: "worker-a",
	grantKeyId: "grant-key-a",
	grantPublicKey: keys.publicKey
		.export({ type: "spki", format: "pem" })
		.toString(),
	grantIssuer: "platform",
	serviceTokenSecret: { name: "platform-runtime-transport", key: "token" },
	nativeMetadataWorkerOrigin: "http://platform-worker-native-metadata",
};

export function sessionSandboxTemplateBindingFixture(
	imageDigest: string,
	driver: StandardTemplateModelBindingV1["driver"] = "codex",
): StandardTemplateModelBindingV1 {
	return {
		templateId: `${driver}-standard`,
		imageDigest,
		driver,
		protocol:
			driver === "codex" ? "openai-responses-v1" : "anthropic-messages-v1",
	};
}

/** A keyless V4 projection with the same field order the validator hashes. */
export function sessionSandboxModelProjectionFixture(input: {
	readonly agentId: string;
	readonly configurationRevision: number;
	readonly imageDigest: string;
	readonly driver?: StandardTemplateModelBindingV1["driver"];
}): RuntimeModelProjectionV4 {
	const binding = sessionSandboxTemplateBindingFixture(
		input.imageDigest,
		input.driver,
	);
	const content = {
		schemaVersion: 4 as const,
		agentId: input.agentId,
		configurationRevision: input.configurationRevision,
		catalogRevision: "catalog-1",
		defaultOptionId: "default",
		defaultReasoningLevel: "medium",
		standardTemplateBinding: binding,
		options: [
			{
				optionId: "default",
				endpoint: {
					endpointId: "relay",
					baseUrl: "https://relay.example.test/v1",
					origin: "https://relay.example.test",
					protocol: binding.protocol,
					...(binding.driver === "codex"
						? {}
						: { authentication: "api-key" as const }),
					security: {
						tls: "verify-peer" as const,
						redirects: "reject" as const,
					},
					capabilities: {
						streaming: true as const,
						tools: true as const,
						reasoningLevels: ["medium"],
					},
					allowedModels: null,
					available: true,
				},
				modelId: "gpt-test",
				reasoningLevels: ["medium"],
			},
		],
	};
	return validateRuntimeModelProjectionV4({
		...content,
		fingerprint: createHash("sha256")
			.update(JSON.stringify(content))
			.digest("hex"),
	});
}

export function sessionSandboxRuntimeInputFixture(input: {
	readonly agentId: string;
	readonly namespace: string;
	readonly sandboxId: string;
	readonly sessionId?: string;
	readonly imageDigest?: string;
	readonly codexContainerBoundaryEnabled?: boolean;
}): SessionSandboxRuntimeInputV1 {
	const projection = sessionSandboxModelProjectionFixture({
		agentId: input.agentId,
		configurationRevision: 1,
		imageDigest: input.imageDigest ?? `sha256:${"b".repeat(64)}`,
	});
	return {
		driver: "codex",
		...(input.codexContainerBoundaryEnabled === true
			? {
					codexContainerBoundaryEnabled: true,
					codexContainerBoundaryAttestation: containerBoundaryAttestationV1(
						sessionSandboxServiceTokenV1(
							sessionSandboxDeploymentTokenFixture,
							input.namespace,
							input.sandboxId,
						),
						`${input.agentId}\0${input.sessionId ?? "session-a"}`,
					),
				}
			: {}),
		modelConfiguration: runtimeModelInjectionV4(projection).configuration,
		workerId: sessionSandboxRuntimeAuthFixture.workerId,
		grantKeyId: sessionSandboxRuntimeAuthFixture.grantKeyId,
		grantPublicKey: sessionSandboxRuntimeAuthFixture.grantPublicKey,
		grantIssuer: sessionSandboxRuntimeAuthFixture.grantIssuer,
		nativeMetadataWorkerOrigin: "http://platform-worker-native-metadata",
		serviceToken: sessionSandboxServiceTokenV1(
			sessionSandboxDeploymentTokenFixture,
			input.namespace,
			input.sandboxId,
		),
	};
}
