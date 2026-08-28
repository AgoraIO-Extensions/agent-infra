import { z } from "zod";

import {
	OpaqueIdV1Schema,
	Rfc3339TimestampV1Schema,
	SchemaVersionV1Schema,
} from "../index.ts";

const base64Url = z
	.string()
	.min(1)
	.regex(/^[A-Za-z0-9_-]+$/);
const nonEmptyStrings = z.array(z.string().min(1)).min(1);

export const RuntimeGrantOperationV1Schema = z.enum([
	"turn.submit",
	"turn.supplement",
	"turn.stop",
	"session.status",
	"events.replay",
	"capabilities.read",
	"generation.cancel",
]);

export const RuntimeAttachmentGrantV1Schema = z.strictObject({
	attachmentId: OpaqueIdV1Schema,
	operations: z.tuple([z.literal("read")]),
});

export const ExecutionGrantClaimsV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	issuer: z.string().min(1),
	audience: nonEmptyStrings,
	issuedAt: Rfc3339TimestampV1Schema,
	expiresAt: Rfc3339TimestampV1Schema,
	grantId: OpaqueIdV1Schema,
	actorId: OpaqueIdV1Schema,
	channelId: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	turnId: OpaqueIdV1Schema,
	sessionGeneration: z.number().int().positive(),
	operations: z.array(RuntimeGrantOperationV1Schema).min(1),
	attachments: z.array(RuntimeAttachmentGrantV1Schema),
	actionSetVersion: OpaqueIdV1Schema,
});

export const SignedExecutionGrantV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	algorithm: z.literal("Ed25519"),
	keyId: z.string().min(1),
	payload: base64Url,
	signature: base64Url,
});

export type RuntimeGrantOperationV1 = z.infer<
	typeof RuntimeGrantOperationV1Schema
>;
export type ExecutionGrantClaimsV1 = z.infer<
	typeof ExecutionGrantClaimsV1Schema
>;
export type SignedExecutionGrantV1 = z.infer<
	typeof SignedExecutionGrantV1Schema
>;
