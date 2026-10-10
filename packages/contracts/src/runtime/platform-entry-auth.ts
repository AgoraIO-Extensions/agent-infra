import { z } from "zod";

import { OpaqueIdV1Schema } from "../index.ts";

/** The short-lived identity envelope sent from the platform gateway to a custom Agent. */
export const PlatformEntryContextClaimsV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	issuer: OpaqueIdV1Schema,
	audience: z.literal("custom_agent"),
	issuedAt: z.number().int().nonnegative().safe(),
	expiresAt: z.number().int().positive().safe(),
	contextId: OpaqueIdV1Schema,
	keyVersion: OpaqueIdV1Schema,
	userId: OpaqueIdV1Schema,
	organizationIds: z.array(OpaqueIdV1Schema),
	roles: z.array(z.enum(["employee", "system_admin"])).min(1),
	authorizationRevision: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema,
});

export const PlatformEntryContextV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	format: z.literal("platform-entry-jws"),
	token: z
		.string()
		.max(16_384)
		.regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
});

export const PlatformEntryContextMaximumLifetimeMsV1 = 60_000;

export type PlatformEntryContextClaimsV1 = z.infer<
	typeof PlatformEntryContextClaimsV1Schema
>;
export type PlatformEntryContextV1 = z.infer<
	typeof PlatformEntryContextV1Schema
>;
