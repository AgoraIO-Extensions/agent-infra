import type { StandardTemplateModelBindingV1 } from "@agent-infra/model-catalog";
import { WorkloadKubernetesError } from "./kubernetes-client.js";

export const runtimeTextOnlyEnv = "AGENT_INFRA_RUNTIME_TEXT_ONLY";

export function sigCoreSdkTrialImageFromDeployment(
	image: string | undefined,
	namespace: string | undefined,
): string | undefined {
	if (!image) return undefined;
	if (
		namespace !== "ack-community-m1-4405" ||
		!/^ghcr\.io\/agoraio-extensions\/agent-infra\/agent-runtime-codex@sha256:[a-f0-9]{64}$/.test(
			image,
		)
	)
		throw new WorkloadKubernetesError("policy");
	return image;
}

export function matchesSigCoreSdkTrialBinding(
	image: string,
	imageRepository: string,
	binding: StandardTemplateModelBindingV1 | undefined,
): boolean {
	return (
		binding?.templateId === "codex" &&
		binding.driver === "codex" &&
		binding.protocol === "openai-responses-v1" &&
		binding.transport === "paseo-sdk-pod" &&
		`${binding.imageRepository ?? imageRepository}@${binding.imageDigest}` ===
			image
	);
}
