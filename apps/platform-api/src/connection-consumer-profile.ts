import { createHash } from "node:crypto";

import type { ConnectionCapabilityProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { z } from "zod";

const approvalSchema = z.strictObject({
	schemaVersion: z.literal(1),
	configFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
	egressEnforced: z.literal(true),
	source: z.strictObject({
		ref: z.string().min(1),
		revision: z.string().min(1),
	}),
});

const profileSchema = z.strictObject({
	schemaVersion: z.literal(1),
	publicOrigin: z.string(),
	mcpPath: z.string(),
	consumerId: z.string().min(1),
	audience: z.string().min(1),
	egressProfile: z.strictObject({
		ref: z.string().min(1),
		revision: z.string().min(1),
	}),
});

export type ConnectionConsumerProfileV1 = z.infer<typeof profileSchema>;
export type ConnectionCapabilityV1 = z.infer<
	typeof ConnectionCapabilityProjectionV1Schema
>;

function validOrigin(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.origin === value;
	} catch {
		return false;
	}
}

function validPath(value: string): boolean {
	return (
		value.startsWith("/") &&
		!value.startsWith("//") &&
		!/[\s\p{Cc}\\?#]/u.test(value) &&
		!/%(?:2f|2e|5c)/i.test(value) &&
		!value.split("/").some((part) => part === "." || part === "..")
	);
}

export function createConnectionCapability(
	input: unknown,
	approval: unknown,
): ConnectionCapabilityV1 {
	if (input === undefined || input === null) {
		return { status: "unavailable", schemaVersion: 1, reason: "missing" };
	}
	const parsed = profileSchema.safeParse(input);
	if (!parsed.success) {
		return { status: "unavailable", schemaVersion: 1, reason: "invalid" };
	}
	const approved = approvalSchema.safeParse(approval);
	if (!approved.success) {
		return { status: "unavailable", schemaVersion: 1, reason: "unapproved" };
	}
	if (
		!validOrigin(parsed.data.publicOrigin) ||
		!validPath(parsed.data.mcpPath)
	) {
		return { status: "unavailable", schemaVersion: 1, reason: "invalid" };
	}
	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify([
				parsed.data.schemaVersion,
				parsed.data.publicOrigin,
				parsed.data.mcpPath,
				parsed.data.consumerId,
				parsed.data.audience,
				parsed.data.egressProfile.ref,
				parsed.data.egressProfile.revision,
			]),
			"utf8",
		)
		.digest("hex");
	if (fingerprint !== approved.data.configFingerprint) {
		return { status: "unavailable", schemaVersion: 1, reason: "invalid" };
	}
	return {
		status: "available",
		schemaVersion: 1,
		publicOrigin: parsed.data.publicOrigin,
		mcpPath: parsed.data.mcpPath,
		configFingerprint: fingerprint,
	};
}
