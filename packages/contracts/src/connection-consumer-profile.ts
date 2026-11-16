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

export interface ConnectionConsumerApprovalV1 {
	readonly schemaVersion: 1;
	readonly configFingerprint: string;
	readonly egressEnforced: true;
	readonly source: { readonly ref: string; readonly revision: string };
}

export interface ConnectionConsumerTargetV1 {
	readonly url: string;
	readonly publicOrigin: string;
	readonly mcpPath: string;
	readonly consumerId: string;
	readonly audience: string;
	readonly egressProfile: ConnectionConsumerProfileV1["egressProfile"];
	readonly schemaVersion: 1;
	readonly configFingerprint: string;
	readonly source: ConnectionConsumerApprovalV1["source"];
}

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

export type ApprovedConnectionConsumerTargetV1 = Extract<
	ApprovedConnectionConsumerProfileV1,
	{ readonly status: "available" }
> & { readonly url: string };

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

export function connectionConsumerProfileFingerprintV1(
	profile: ConnectionConsumerProfileV1,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				profile.schemaVersion,
				profile.publicOrigin,
				profile.mcpPath,
				profile.consumerId,
				profile.audience,
				profile.egressProfile.ref,
				profile.egressProfile.revision,
			]),
			"utf8",
		)
		.digest("hex");
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
	const fingerprint = connectionConsumerProfileFingerprintV1(parsed.data);
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

/**
 * Resolves the approved profile to the flattened target shape used by the
 * Worker runtime route. Invalid or stale approvals fail closed.
 */
export function validateConnectionConsumerProfileV1(
	value: unknown,
	approval: unknown,
): ConnectionConsumerTargetV1 {
	const result = resolveApprovedConnectionConsumerProfileV1(value, approval);
	if (result.status !== "available") throw unavailable();
	return {
		...result.profile,
		configFingerprint: result.configFingerprint,
		source: result.source,
		url: new URL(
			result.profile.mcpPath,
			`${result.profile.publicOrigin}/`,
		).toString(),
	};
}

export function resolveConnectionConsumerTargetV1(
	target: ConnectionConsumerTargetV1,
	overrides?: Record<string, unknown>,
): ConnectionConsumerTargetV1 {
	if (overrides && Object.keys(overrides).length > 0) throw unavailable();
	return structuredClone(target);
}

function unavailable(): never {
	throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
}

/**
 * One-time system Connection access (Spec §13.5.1, §13.5.7). It contains only the
 * deployment-wide fields shared by every Agent; it never names a Consumer, Agent or
 * credential. Each associated Agent's profile is derived from it and its association.
 */
const systemAccessSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		publicOrigin: z.string(),
		mcpPath: z.string(),
		audience: z.string().min(1),
		egressProfile: sourceSchema,
		/** OAuth issuer; its origin must equal publicOrigin. */
		issuer: z.string(),
		/** Platform OAuth callback route served behind the callback-only forward. */
		oauthCallbackUrl: z.string(),
	})
	.readonly();

export type ConnectionSystemAccessV1 = z.infer<typeof systemAccessSchema>;

export type ApprovedConnectionSystemAccessV1 =
	| {
			readonly status: "unavailable";
			readonly schemaVersion: 1;
			readonly reason: "missing" | "invalid" | "unapproved";
	  }
	| {
			readonly status: "available";
			readonly schemaVersion: 1;
			readonly system: ConnectionSystemAccessV1;
			readonly configFingerprint: string;
			readonly source: z.infer<typeof sourceSchema>;
	  };

function canonicalHttpsUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			url.href === value
		);
	} catch {
		return false;
	}
}

export function connectionSystemAccessFingerprintV1(
	system: ConnectionSystemAccessV1,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				"connection-system-access/v1",
				system.publicOrigin,
				system.mcpPath,
				system.audience,
				system.egressProfile.ref,
				system.egressProfile.revision,
				system.issuer,
				system.oauthCallbackUrl,
			]),
			"utf8",
		)
		.digest("hex");
}

/** Validates the approved one-time system access; it names no Consumer and grants nothing. */
export function resolveApprovedConnectionSystemAccessV1(
	input: unknown,
	approval: unknown,
): ApprovedConnectionSystemAccessV1 {
	if (input === undefined || input === null)
		return { status: "unavailable", schemaVersion: 1, reason: "missing" };
	const parsed = systemAccessSchema.safeParse(input);
	if (!parsed.success)
		return { status: "unavailable", schemaVersion: 1, reason: "invalid" };
	const approved = approvalSchema.safeParse(approval);
	if (!approved.success)
		return { status: "unavailable", schemaVersion: 1, reason: "unapproved" };
	const system = parsed.data;
	if (
		!validOrigin(system.publicOrigin) ||
		!validPath(system.mcpPath) ||
		!canonicalHttpsUrl(system.issuer) ||
		new URL(system.issuer).origin !== system.publicOrigin ||
		!canonicalHttpsUrl(system.oauthCallbackUrl)
	)
		return { status: "unavailable", schemaVersion: 1, reason: "invalid" };
	const fingerprint = connectionSystemAccessFingerprintV1(system);
	if (fingerprint !== approved.data.configFingerprint)
		return { status: "unavailable", schemaVersion: 1, reason: "invalid" };
	return {
		status: "available",
		schemaVersion: 1,
		system,
		configFingerprint: fingerprint,
		source: approved.data.source,
	};
}

/**
 * Derive one Agent's complete profile from approved system access and that Agent's
 * verified association (Spec §13.5.1 named source). The source names the association
 * and its never-reused revision, so a later association never matches older material.
 */
export function deriveConnectionConsumerProfileV1(
	access: Extract<ApprovedConnectionSystemAccessV1, { status: "available" }>,
	association: {
		readonly consumerId: string;
		readonly source: { readonly ref: string; readonly revision: string };
	},
): {
	readonly profile: ConnectionConsumerProfileV1;
	readonly approval: ConnectionConsumerApprovalV1;
} {
	const profile = profileSchema.parse({
		schemaVersion: 1,
		publicOrigin: access.system.publicOrigin,
		mcpPath: access.system.mcpPath,
		consumerId: association.consumerId,
		audience: access.system.audience,
		egressProfile: access.system.egressProfile,
	});
	const source = sourceSchema.parse(association.source);
	return {
		profile,
		approval: {
			schemaVersion: 1,
			configFingerprint: connectionConsumerProfileFingerprintV1(profile),
			egressEnforced: true,
			source,
		},
	};
}
