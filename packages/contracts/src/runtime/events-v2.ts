import { z } from "zod";

import {
	OpaqueCursorV1Schema,
	OpaqueIdV1Schema,
	Rfc3339TimestampV1Schema,
} from "../index.ts";
import { SandboxWorkspaceReferenceV1Schema } from "../workspace-reference.ts";
import { RuntimeEventV1Schema } from "./events.ts";

const count = z.number().int().safe().nonnegative();
const metadataId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const rpcRequestId = z.union([
	z.string().min(1).max(128),
	z.number().int().safe(),
]);
const requestDigest = z.string().regex(/^[a-f0-9]{64}$/);

/** A reference to independently authorized Connection evidence, without its data. */
export const RuntimeConnectionAssociationV1Schema = z.discriminatedUnion(
	"verification",
	[
		z.strictObject({
			serviceRef: metadataId,
			verification: z.literal("verified"),
			callRef: metadataId,
			consumerId: metadataId.optional(),
			instanceRef: metadataId.optional(),
			credentialRevision: metadataId.optional(),
		}),
		z.strictObject({
			serviceRef: metadataId,
			verification: z.literal("unverified"),
			callRef: metadataId.optional(),
			consumerId: metadataId.optional(),
			instanceRef: metadataId.optional(),
			credentialRevision: metadataId.optional(),
			reason: z.enum([
				"receipt_missing",
				"record_unavailable",
				"authorization_unavailable",
				"binding_mismatch",
				"response_unconfirmed",
			]),
		}),
	],
);
export type RuntimeConnectionAssociationV1 = z.infer<
	typeof RuntimeConnectionAssociationV1Schema
>;

/** Browser action identity; parameters and page contents never cross this fact boundary. */
export const RuntimeBrowserActionBindingV1Schema = z.strictObject({
	actionId: OpaqueIdV1Schema,
	capabilityVersion: z.number().int().positive().safe(),
	pageRevision: z.number().int().positive().safe(),
	sessionGeneration: z.number().int().positive().safe(),
	resourceFence: z.number().int().positive().safe(),
	/** Added after V2 journals shipped; absent on legacy facts and treated as untrusted for replay. */
	workloadRevision: z.number().int().positive().safe().optional(),
	imageDigest: z
		.string()
		.regex(/^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/u)
		.optional(),
	sideEffect: z.boolean(),
});
export type RuntimeBrowserActionBindingV1 = z.infer<
	typeof RuntimeBrowserActionBindingV1Schema
>;

/** Actual transport/tool boundary facts. No request, response, or credential text. */
export const RuntimeOperationFailureV2Schema = z.enum([
	"authorization_denied",
	"authorization_unavailable",
	"dependency_unavailable",
	"request_rejected",
	"response_incomplete",
	"operation_failed",
	"persistence_unavailable",
	"interrupted",
	"recovery_unconfirmed",
]);

const operation = {
	operationRef: OpaqueIdV1Schema,
	attemptRef: OpaqueIdV1Schema,
	parentOperationRef: OpaqueIdV1Schema.optional(),
	phase: z.enum(["intent", "started", "completed", "failed", "unknown"]),
	startedAt: Rfc3339TimestampV1Schema.optional(),
	finishedAt: Rfc3339TimestampV1Schema.optional(),
	durationMs: count.optional(),
	failureCode: RuntimeOperationFailureV2Schema.optional(),
};

export const RuntimeOperationFactV2Schema = z.discriminatedUnion("kind", [
	z.strictObject({
		...operation,
		kind: z.literal("model"),
		model: z.strictObject({
			configVersion: metadataId,
			modelOptionId: metadataId,
			modelId: metadataId,
			reasoningLevel: metadataId.optional(),
		}),
		usage: z
			.strictObject({
				inputTokens: count.optional(),
				outputTokens: count.optional(),
				cachedInputTokens: count.optional(),
			})
			.optional(),
	}),
	z.strictObject({
		...operation,
		kind: z.literal("tool"),
		toolId: metadataId,
		/** JSON-RPC identity and parameter digest persisted before dispatch. */
		rpcRequestId: rpcRequestId.optional(),
		requestDigest: requestDigest.optional(),
		resultRef: OpaqueIdV1Schema.optional(),
		connection: RuntimeConnectionAssociationV1Schema.optional(),
		browser: RuntimeBrowserActionBindingV1Schema.optional(),
	}),
]);

export const RuntimeEventV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	adapterEventKey: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	cursor: OpaqueCursorV1Schema,
	occurredAt: Rfc3339TimestampV1Schema,
	type: z.literal("operation"),
	payload: RuntimeOperationFactV2Schema,
});

/**
 * #2979：模型以明文提供的思考过程增量，`raw` 为原始推理、`summary` 为推理摘要。
 * 属于会话正文，与正文增量共用游标与确认；加密推理、签名或被隐藏的思考不进入该事件。
 */
export const RuntimeReasoningEventV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	adapterEventKey: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	cursor: OpaqueCursorV1Schema,
	occurredAt: Rfc3339TimestampV1Schema,
	type: z.literal("reasoning"),
	payload: z.strictObject({
		kind: z.enum(["raw", "summary"]),
		delta: z.string().min(1),
	}),
});

/**
 * #3226：结果文件事件 V2 在 V1 `file` payload 之外携带规范化的工作区相对路径
 * `workspaceReference`；回答内 `sandbox:` 引用发布的文件为该路径，ACP image 块等其他来源为
 * null。V1 `file` 事件保持不变。
 */
export const RuntimeFileEventV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	adapterEventKey: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	cursor: OpaqueCursorV1Schema,
	occurredAt: Rfc3339TimestampV1Schema,
	type: z.literal("file"),
	payload: z.strictObject({
		fileId: OpaqueIdV1Schema,
		name: z.string().min(1),
		mimeType: z.string().min(1),
		sizeBytes: z.number().int().nonnegative(),
		workspaceReference: SandboxWorkspaceReferenceV1Schema.nullable(),
	}),
});

/** V3 transport and durable Driver journals preserve each event's original version. */
export const RuntimeEventSchema = z.union([
	RuntimeEventV1Schema,
	RuntimeEventV2Schema,
	RuntimeReasoningEventV2Schema,
	RuntimeFileEventV2Schema,
]);
export type RuntimeOperationFactV2 = z.infer<
	typeof RuntimeOperationFactV2Schema
>;
export type RuntimeEventV2 = z.infer<typeof RuntimeEventV2Schema>;
export type RuntimeReasoningEventV2 = z.infer<
	typeof RuntimeReasoningEventV2Schema
>;
export type RuntimeFileEventV2 = z.infer<typeof RuntimeFileEventV2Schema>;
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

export const RuntimeEventV2SchemaDefinitions = {
	RuntimeConnectionAssociationV1: RuntimeConnectionAssociationV1Schema,
	RuntimeBrowserActionBindingV1: RuntimeBrowserActionBindingV1Schema,
	RuntimeOperationFailureV2: RuntimeOperationFailureV2Schema,
	RuntimeOperationFactV2: RuntimeOperationFactV2Schema,
	RuntimeEventV2: RuntimeEventV2Schema,
	RuntimeReasoningEventV2: RuntimeReasoningEventV2Schema,
	RuntimeFileEventV2: RuntimeFileEventV2Schema,
	RuntimeEvent: RuntimeEventSchema,
};
