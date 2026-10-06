import { createHash } from "node:crypto";
import { z } from "zod";

const sourceSchema = z
	.strictObject({
		ref: z.string().min(1),
		revision: z.string().min(1),
	})
	.readonly();

const approvalSchema = z.strictObject({
	schemaVersion: z.literal(1),
	configFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
	egressEnforced: z.literal(true),
	source: sourceSchema,
});

const profileSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		publicOrigin: z.string(),
		mcpPath: z.string(),
		consumerId: z.string().min(1),
		audience: z.string().min(1),
		egressProfile: sourceSchema,
	})
	.readonly();

export type ConnectionConsumerProfileV1 = z.infer<typeof profileSchema>;
export type ApprovedConnectionConsumerProfileV1 =
	| {
			readonly status: "unavailable";
			readonly schemaVersion: 1;
			readonly reason: "missing" | "invalid" | "unapproved";
	  }
	| {
			readonly status: "available";
			readonly schemaVersion: 1;
			readonly profile: ConnectionConsumerProfileV1;
			readonly configFingerprint: string;
			readonly source: z.infer<typeof sourceSchema>;
	  };

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

/** Validates trusted deployment input; it does not attest egress or authorize MCP calls. */
export function resolveApprovedConnectionConsumerProfileV1(
	input: unknown,
	approval: unknown,
): ApprovedConnectionConsumerProfileV1 {
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
		profile: parsed.data,
		configFingerprint: fingerprint,
		source: approved.data.source,
	};
}
