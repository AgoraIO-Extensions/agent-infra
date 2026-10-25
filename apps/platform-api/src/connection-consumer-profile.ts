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
	webPath: unknown,
): ConnectionCapabilityV1 {
	const resolved = resolveApprovedConnectionConsumerProfileV1(input, approval);
	if (resolved.status === "unavailable") return resolved;
	if (
		typeof webPath !== "string" ||
		!webPath.startsWith("/") ||
		webPath.startsWith("//") ||
		/[\s\p{Cc}\\?#]/u.test(webPath) ||
		!webPath.split("/").every((part) => part !== "." && part !== "..") ||
		/%(?:2f|2e|5c)/i.test(webPath)
	)
		return { status: "unavailable", schemaVersion: 1, reason: "invalid" };
	return {
		status: "available",
		schemaVersion: resolved.schemaVersion,
		publicOrigin: resolved.profile.publicOrigin,
		mcpPath: resolved.profile.mcpPath,
		webPath,
		configFingerprint: resolved.configFingerprint,
	};
}
