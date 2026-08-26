import { z } from "zod";

const opaqueId = z.string().min(1).max(512);

export const idempotencyKeySchema = z
	.string()
	.min(8)
	.max(200)
	.regex(/^[\x21-\x7e]+$/);

export const loginRequestSchema = z.strictObject({
	password: z.string().min(1).max(1_024),
	username: z.string().trim().min(1).max(256),
});

export const issueTokenRequestSchema = z.strictObject({
	name: z.string().trim().min(1).max(100),
});

export const oauthTransactionRequestSchema = z.strictObject({
	sharedScopeId: opaqueId.optional(),
});

export const authorizationPreviewRequestSchema = z.strictObject({
	connectionId: opaqueId,
	consumerId: opaqueId,
});

export const authorizationConsentRequestSchema = z.strictObject({
	confirmationToken: opaqueId,
	previewId: opaqueId,
});

export const sharedScopeNameSchema = z.strictObject({
	displayName: z.string().trim().min(1).max(120),
});
