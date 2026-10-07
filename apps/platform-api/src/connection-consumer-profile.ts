import { resolveApprovedConnectionConsumerProfileV1 } from "@agent-infra/contracts/connection-consumer-profile";
import type { ConnectionCapabilityProjectionV1Schema } from "@agent-infra/contracts/pilot";
import type { z } from "zod";

export type { ConnectionConsumerProfileV1 } from "@agent-infra/contracts/connection-consumer-profile";
export type ConnectionCapabilityV1 = z.infer<
	typeof ConnectionCapabilityProjectionV1Schema
>;

export function createConnectionCapability(
	input: unknown,
	approval: unknown,
): ConnectionCapabilityV1 {
	const resolved = resolveApprovedConnectionConsumerProfileV1(input, approval);
	if (resolved.status === "unavailable") return resolved;
	return {
		status: "available",
		schemaVersion: resolved.schemaVersion,
		publicOrigin: resolved.profile.publicOrigin,
		mcpPath: resolved.profile.mcpPath,
		configFingerprint: resolved.configFingerprint,
	};
}
