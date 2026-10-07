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
};

export function sessionSandboxTemplateBindingFixture(
	imageDigest: string,
): StandardTemplateModelBindingV1 {
	return {
		templateId: "codex-standard",
		imageDigest,
		driver: "codex",
		protocol: "openai-responses-v1",
	};
}

/** A keyless V4 projection with the same field order the validator hashes. */
export function sessionSandboxModelProjectionFixture(input: {
	readonly agentId: string;
	readonly configurationRevision: number;
	readonly imageDigest: string;
}): RuntimeModelProjectionV4 {
	const content = {
		schemaVersion: 4 as const,
		agentId: input.agentId,
		configurationRevision: input.configurationRevision,
		catalogRevision: "catalog-1",
		defaultOptionId: "default",
		defaultReasoningLevel: "medium",
		standardTemplateBinding: sessionSandboxTemplateBindingFixture(
			input.imageDigest,
		),
		options: [
			{
				optionId: "default",
				endpoint: {
					endpointId: "relay",
					baseUrl: "https://relay.example.test/v1",
					origin: "https://relay.example.test",
					protocol: "openai-responses-v1" as const,
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
	readonly imageDigest?: string;
}): SessionSandboxRuntimeInputV1 {
	const projection = sessionSandboxModelProjectionFixture({
		agentId: input.agentId,
		configurationRevision: 1,
		imageDigest: input.imageDigest ?? `sha256:${"b".repeat(64)}`,
	});
	return {
		driver: "codex",
		modelConfiguration: runtimeModelInjectionV4(projection).configuration,
		workerId: sessionSandboxRuntimeAuthFixture.workerId,
		grantKeyId: sessionSandboxRuntimeAuthFixture.grantKeyId,
		grantPublicKey: sessionSandboxRuntimeAuthFixture.grantPublicKey,
		grantIssuer: sessionSandboxRuntimeAuthFixture.grantIssuer,
		serviceToken: sessionSandboxServiceTokenV1(
			sessionSandboxDeploymentTokenFixture,
			input.namespace,
			input.sandboxId,
		),
	};
}
