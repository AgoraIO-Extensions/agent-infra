import { z } from "zod";
import { OpaqueIdV1Schema, Rfc3339TimestampV1Schema } from "../index.ts";
import {
	RuntimeExecutionGrantV2Schema,
	RuntimeOperationBindingV2Schema,
	RuntimePrincipalV1Schema,
} from "./grant-v2.ts";

export const RuntimeBrowserHandoffReasonV1Schema = z.enum([
	"login",
	"mfa",
	"captcha",
	"human_judgment",
]);

export const RuntimeBrowserHandoffRuntimeSnapshotV1Schema = z.strictObject({
	browserAlive: z.boolean(),
	authorized: z.boolean(),
	subjectId: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	sessionGeneration: z.number().int().positive().safe(),
	resourceFence: z.number().int().positive().safe(),
	workloadRevision: z.number().int().positive().safe(),
	imageDigest: z.string().regex(/^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/u),
	capabilityVersion: z.number().int().positive().safe(),
	pageRevision: z.number().int().positive().safe(),
});

const context = {
	schemaVersion: z.literal(3),
	requestId: OpaqueIdV1Schema,
	traceId: OpaqueIdV1Schema,
	principal: RuntimePrincipalV1Schema,
	channelId: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	turnId: OpaqueIdV1Schema,
	sessionGeneration: z.number().int().positive().safe(),
	hostSessionRef: OpaqueIdV1Schema,
	operation: RuntimeOperationBindingV2Schema,
	grant: RuntimeExecutionGrantV2Schema,
};

const runtime = RuntimeBrowserHandoffRuntimeSnapshotV1Schema;

export const RuntimeBrowserHandoffRequestV3Schema = z.strictObject({
	...context,
	handoff: z.discriminatedUnion("kind", [
		z.strictObject({
			kind: z.literal("request"),
			reason: RuntimeBrowserHandoffReasonV1Schema,
			runtime,
		}),
		z.strictObject({
			kind: z.literal("take-over"),
			handoffId: OpaqueIdV1Schema,
			operatorId: OpaqueIdV1Schema,
			subjectId: OpaqueIdV1Schema,
			runtime,
		}),
		z.strictObject({
			kind: z.literal("return-to-agent"),
			handoffId: OpaqueIdV1Schema,
			operatorId: OpaqueIdV1Schema,
			runtime,
		}),
		z.strictObject({
			kind: z.literal("revoke"),
			reason: z
				.enum([
					"BROWSER_HANDOFF_REVOKED",
					"BROWSER_HANDOFF_AUTHORIZATION_REVOKED",
					"BROWSER_HANDOFF_OPERATOR_CHANGED",
				])
				.optional(),
			runtime,
		}),
		z.strictObject({ kind: z.literal("browser-crashed"), runtime }),
	]),
});

export const RuntimeBrowserHandoffRecordV3Schema = z.strictObject({
	handoffId: OpaqueIdV1Schema,
	status: z.enum([
		"requested",
		"active",
		"returning",
		"completed",
		"revoked",
		"expired",
		"crashed",
		"unknown",
	]),
	reason: RuntimeBrowserHandoffReasonV1Schema,
	requestedAt: Rfc3339TimestampV1Schema,
	expiresAt: Rfc3339TimestampV1Schema,
	operatorId: OpaqueIdV1Schema.optional(),
	terminalReason: z.string().min(1).max(256).optional(),
});

export const RuntimeBrowserHandoffResponseV3Schema = z.strictObject({
	schemaVersion: z.literal(3),
	hostSessionRef: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	outcome: z.literal("accepted"),
	record: RuntimeBrowserHandoffRecordV3Schema.nullable(),
});

export type RuntimeBrowserHandoffReasonV1 = z.infer<
	typeof RuntimeBrowserHandoffReasonV1Schema
>;
export type RuntimeBrowserHandoffRuntimeSnapshotV1 = z.infer<
	typeof RuntimeBrowserHandoffRuntimeSnapshotV1Schema
>;
export type RuntimeBrowserHandoffRequestV3 = z.infer<
	typeof RuntimeBrowserHandoffRequestV3Schema
>;
export type RuntimeBrowserHandoffRecordV3 = z.infer<
	typeof RuntimeBrowserHandoffRecordV3Schema
>;
export type RuntimeBrowserHandoffResponseV3 = z.infer<
	typeof RuntimeBrowserHandoffResponseV3Schema
>;
