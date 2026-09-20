import { z } from "zod";

import {
	OpaqueCursorV1Schema,
	OpaqueIdV1Schema,
	Rfc3339TimestampV1Schema,
} from "../index.ts";
import { RuntimeEventV1Schema } from "./events.ts";

const count = z.number().int().nonnegative().safe();
const metadataId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

/** A reference to independently authorized Connection evidence, without its data. */
export const RuntimeConnectionAssociationV1Schema = z.discriminatedUnion(
	"verification",
	[
		z.strictObject({
			serviceRef: metadataId,
			verification: z.literal("verified"),
			callRef: metadataId,
		}),
		z.strictObject({
			serviceRef: metadataId,
			verification: z.literal("unverified"),
			callRef: metadataId.optional(),
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
		resultRef: OpaqueIdV1Schema.optional(),
		connection: RuntimeConnectionAssociationV1Schema.optional(),
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

/** V3 transport and durable Driver journals preserve each event's original version. */
export const RuntimeEventSchema = z.union([
	RuntimeEventV1Schema,
	RuntimeEventV2Schema,
]);
export type RuntimeOperationFactV2 = z.infer<
	typeof RuntimeOperationFactV2Schema
>;
export type RuntimeEventV2 = z.infer<typeof RuntimeEventV2Schema>;
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

export const RuntimeEventV2SchemaDefinitions = {
	RuntimeConnectionAssociationV1: RuntimeConnectionAssociationV1Schema,
	RuntimeOperationFailureV2: RuntimeOperationFailureV2Schema,
	RuntimeOperationFactV2: RuntimeOperationFactV2Schema,
	RuntimeEventV2: RuntimeEventV2Schema,
	RuntimeEvent: RuntimeEventSchema,
};
