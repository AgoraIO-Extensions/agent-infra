import type { SessionSandboxBindingV1 } from "@agent-infra/platform-core";
import type { SessionSandboxOAuthProvisioningV1 } from "./session-workload-adapter.js";

/** Same optional input for allocation and image inventory; invalid delivery adds no init. */
export function selectSessionOAuthProvisioningV1(
	binding: SessionSandboxBindingV1,
	namespace: string,
	desiredState: "running" | "stopped",
	provisioning: SessionSandboxOAuthProvisioningV1 | undefined,
) {
	try {
		if (
			provisioning &&
			desiredState === "running" &&
			binding.agentId === provisioning.agentId &&
			binding.sessionId === provisioning.sessionId &&
			binding.sandboxId === provisioning.sandboxId &&
			binding.generation === provisioning.sessionGeneration &&
			binding.principal.kind === "user" &&
			provisioning.principal.kind === "user" &&
			binding.principal.id === provisioning.principal.id &&
			new URL(provisioning.configuration.runtimeOrigin).hostname ===
				`${binding.resourceName}.${namespace}.svc`
		)
			return provisioning;
	} catch {
		/* Invalid optional delivery leaves the ordinary Session available. */
	}
	return undefined;
}
