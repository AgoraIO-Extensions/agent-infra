import { z } from "zod";

import {
	OpaqueCursorV1Schema,
	OpaqueIdV1Schema,
	RequestIdV1Schema,
	SchemaVersionV1Schema,
} from "../index.ts";
import {
	RuntimeCapabilitiesV1Schema,
	RuntimeEventV1Schema,
	RuntimeStatusV1Schema,
} from "./events.ts";
import { ExecutionGrantV1Schema } from "./grant.ts";

const positiveFence = z.number().int().positive();
const requestContext = {
	schemaVersion: SchemaVersionV1Schema,
	requestId: RequestIdV1Schema,
	traceId: OpaqueIdV1Schema,
	actorId: OpaqueIdV1Schema,
	channelId: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	turnId: OpaqueIdV1Schema,
	sessionGeneration: z.number().int().positive(),
	deliveryFence: positiveFence,
	grant: ExecutionGrantV1Schema,
};

export const RuntimeInputV1Schema = z.union([
	z.strictObject({
		text: z.string().min(1),
		attachments: z.array(OpaqueIdV1Schema),
	}),
	z.strictObject({ attachments: z.array(OpaqueIdV1Schema).min(1) }),
]);

export const RuntimeSubmitTurnRequestV1Schema = z.strictObject({
	...requestContext,
	hostSessionRef: OpaqueIdV1Schema.optional(),
	input: RuntimeInputV1Schema,
});

export const RuntimeSupplementRequestV1Schema = z.strictObject({
	...requestContext,
	hostSessionRef: OpaqueIdV1Schema,
	messageId: OpaqueIdV1Schema,
	executionDeliveryFence: positiveFence,
	input: RuntimeInputV1Schema,
});

export const RuntimeStopRequestV1Schema = z.strictObject({
	...requestContext,
	hostSessionRef: OpaqueIdV1Schema,
	stopRequestId: OpaqueIdV1Schema,
	executionDeliveryFence: positiveFence,
});

export const RuntimeStatusRequestV1Schema = z.strictObject({
	...requestContext,
	hostSessionRef: OpaqueIdV1Schema,
});

export const RuntimeCapabilitiesRequestV1Schema = z.strictObject({
	...requestContext,
	hostSessionRef: OpaqueIdV1Schema.optional(),
});

export const RuntimeReplayRequestV1Schema = z.strictObject({
	...requestContext,
	hostSessionRef: OpaqueIdV1Schema,
	afterCursor: OpaqueCursorV1Schema.optional(),
});

export const RuntimeGenerationCancelRequestV1Schema = z.strictObject({
	...requestContext,
	hostSessionRef: OpaqueIdV1Schema,
	tombstoneId: OpaqueIdV1Schema,
});

export const RuntimeOperationResultV1Schema = z.discriminatedUnion("outcome", [
	z.strictObject({
		outcome: z.literal("accepted"),
		status: RuntimeStatusV1Schema,
	}),
	z.strictObject({ outcome: z.literal("busy") }),
	z.strictObject({
		outcome: z.literal("rejected"),
		code: z.literal("RUNTIME_TURN_NOT_ACTIVE"),
		message: z.literal("Runtime turn is no longer active"),
		retryable: z.literal(false),
	}),
	z.strictObject({
		outcome: z.literal("unknown"),
		code: z.literal("RUNTIME_ACCEPTANCE_UNKNOWN"),
		message: z.literal("Runtime command acceptance could not be confirmed"),
	}),
]);

export const RuntimeOperationResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	hostSessionRef: OpaqueIdV1Schema,
	operationId: OpaqueIdV1Schema,
	result: RuntimeOperationResultV1Schema,
});

export const RuntimeStatusResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	hostSessionRef: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	status: RuntimeStatusV1Schema,
});

export const RuntimeCapabilitiesResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	capabilities: RuntimeCapabilitiesV1Schema,
});

export const RuntimeReplayResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	events: z.array(RuntimeEventV1Schema),
});

export type RuntimeInputV1 = z.infer<typeof RuntimeInputV1Schema>;
export type RuntimeSubmitTurnRequestV1 = z.infer<
	typeof RuntimeSubmitTurnRequestV1Schema
>;
export type RuntimeSupplementRequestV1 = z.infer<
	typeof RuntimeSupplementRequestV1Schema
>;
export type RuntimeStopRequestV1 = z.infer<typeof RuntimeStopRequestV1Schema>;
export type RuntimeStatusRequestV1 = z.infer<
	typeof RuntimeStatusRequestV1Schema
>;
export type RuntimeCapabilitiesRequestV1 = z.infer<
	typeof RuntimeCapabilitiesRequestV1Schema
>;
export type RuntimeReplayRequestV1 = z.infer<
	typeof RuntimeReplayRequestV1Schema
>;
export type RuntimeGenerationCancelRequestV1 = z.infer<
	typeof RuntimeGenerationCancelRequestV1Schema
>;
export type RuntimeOperationResultV1 = z.infer<
	typeof RuntimeOperationResultV1Schema
>;
export type RuntimeOperationResponseV1 = z.infer<
	typeof RuntimeOperationResponseV1Schema
>;
export type RuntimeStatusResponseV1 = z.infer<
	typeof RuntimeStatusResponseV1Schema
>;
export type RuntimeCapabilitiesResponseV1 = z.infer<
	typeof RuntimeCapabilitiesResponseV1Schema
>;
export type RuntimeReplayResponseV1 = z.infer<
	typeof RuntimeReplayResponseV1Schema
>;
