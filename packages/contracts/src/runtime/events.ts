import { z } from "zod";

import {
	OpaqueCursorV1Schema,
	OpaqueIdV1Schema,
	Rfc3339TimestampV1Schema,
	SchemaVersionV1Schema,
} from "../index.ts";

export const RuntimeStatusV1Schema = z.enum([
	"idle",
	"running",
	"completed",
	"failed",
	"cancelled",
	"unavailable",
	"unknown",
]);

export const RuntimeCapabilitiesV1Schema = z.strictObject({
	modelSelection: z.boolean(),
	attachments: z.boolean(),
	resultFiles: z.boolean(),
	connection: z.boolean(),
	supplementaryInstruction: z.boolean(),
});

const runtimeEventBase = {
	schemaVersion: SchemaVersionV1Schema,
	adapterEventKey: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	cursor: OpaqueCursorV1Schema,
	occurredAt: Rfc3339TimestampV1Schema,
};

const runtimeErrorEventPayloadV1Schema = z.discriminatedUnion("code", [
	z.strictObject({
		code: z.literal("RUNTIME_EXECUTION_FAILED"),
		message: z.literal("Runtime execution failed"),
		retryable: z.literal(false),
	}),
	z.strictObject({
		code: z.literal("RUNTIME_DEPENDENCY_UNAVAILABLE"),
		message: z.literal("Runtime dependency is unavailable"),
		retryable: z.literal(true),
	}),
]);

export const RuntimeEventV1Schema = z.discriminatedUnion("type", [
	z.strictObject({
		...runtimeEventBase,
		type: z.literal("text"),
		payload: z.strictObject({ delta: z.string().min(1) }),
	}),
	z.strictObject({
		...runtimeEventBase,
		type: z.literal("status"),
		payload: z.strictObject({ status: RuntimeStatusV1Schema }),
	}),
	z.strictObject({
		...runtimeEventBase,
		type: z.literal("tool"),
		payload: z.strictObject({
			toolCallId: OpaqueIdV1Schema,
			name: z.string().min(1),
			phase: z.enum(["started", "completed", "failed"]),
		}),
	}),
	z.strictObject({
		...runtimeEventBase,
		type: z.literal("file"),
		payload: z.strictObject({
			fileId: OpaqueIdV1Schema,
			name: z.string().min(1),
			mimeType: z.string().min(1),
			sizeBytes: z.number().int().nonnegative(),
		}),
	}),
	z.strictObject({
		...runtimeEventBase,
		type: z.literal("completed"),
		payload: z.strictObject({
			status: z.enum(["completed", "failed", "cancelled"]),
		}),
	}),
	z.strictObject({
		...runtimeEventBase,
		type: z.literal("error"),
		payload: runtimeErrorEventPayloadV1Schema,
	}),
]);

export type RuntimeStatusV1 = z.infer<typeof RuntimeStatusV1Schema>;
export type RuntimeCapabilitiesV1 = z.infer<typeof RuntimeCapabilitiesV1Schema>;
export type RuntimeEventV1 = z.infer<typeof RuntimeEventV1Schema>;
