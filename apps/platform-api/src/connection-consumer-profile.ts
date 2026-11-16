import {
	resolveApprovedConnectionConsumerProfileV1,
	resolveApprovedConnectionSystemAccessV1,
} from "@agent-infra/contracts/connection-consumer-profile";
import type { ConnectionCapabilityProjectionV1Schema } from "@agent-infra/contracts/pilot";
import type { z } from "zod";

export type { ConnectionConsumerProfileV1 } from "@agent-infra/contracts/connection-consumer-profile";
export type ConnectionCapabilityV1 = z.infer<
	typeof ConnectionCapabilityProjectionV1Schema
>;

function validWebPath(webPath: unknown): webPath is string {
	return !(
		typeof webPath !== "string" ||
		!webPath.startsWith("/") ||
		webPath.startsWith("//") ||
		/[\s\p{Cc}\\?#]/u.test(webPath) ||
		!webPath.split("/").every((part) => part !== "." && part !== "..") ||
		/%(?:2f|2e|5c)/i.test(webPath)
	);
}

/** Legacy deployment-wide Consumer profile; kept only for deployments without system access. */
export function createConnectionCapability(
	input: unknown,
	approval: unknown,
	webPath: unknown,
): ConnectionCapabilityV1 {
	const resolved = resolveApprovedConnectionConsumerProfileV1(input, approval);
	if (resolved.status === "unavailable") return resolved;
	if (!validWebPath(webPath))
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

/**
 * Spec §13.5.7 one-time system access: Owner association and the Connection console entry
 * need only deployment-wide fields, never a Consumer ID or per-Agent entry.
 */
export function createConnectionSystemAccessCapability(
	input: unknown,
	approval: unknown,
	webPath: unknown,
): ConnectionCapabilityV1 {
	const resolved = resolveApprovedConnectionSystemAccessV1(input, approval);
	if (resolved.status === "unavailable") return resolved;
	if (!validWebPath(webPath))
		return { status: "unavailable", schemaVersion: 1, reason: "invalid" };
	return {
		status: "available",
		schemaVersion: resolved.schemaVersion,
		publicOrigin: resolved.system.publicOrigin,
		mcpPath: resolved.system.mcpPath,
		webPath,
		configFingerprint: resolved.configFingerprint,
	};
}
