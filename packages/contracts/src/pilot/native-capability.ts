import { z } from "zod";
import {
	IdempotencyKeyV1Schema,
	OpaqueIdV1Schema,
	RequestIdV1Schema,
	TraceIdV1Schema,
} from "../index.ts";

const nativeCapabilityId = z.string().regex(/^[a-f0-9]{64}$/u);
const boundedParameters = z.string().max(16 * 1024);
const capabilityKind = z.enum(["command", "skill"]);

export const NativeCapabilityInvocationRequestV1Schema = z.strictObject({
	capabilityId: nativeCapabilityId,
	directoryRevision: nativeCapabilityId,
	parameters: boundedParameters,
	idempotencyKey: IdempotencyKeyV1Schema,
	requestId: RequestIdV1Schema.max(256),
	traceId: TraceIdV1Schema.max(256),
});

export const NativeCapabilityInvocationResultV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	status: z.literal("submitted"),
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	capabilityId: nativeCapabilityId,
	capabilityKind,
	directoryRevision: nativeCapabilityId,
});

const accepted = z.strictObject({
	outcome: z.enum(["accepted", "replayed"]),
	result: NativeCapabilityInvocationResultV1Schema,
});

const rejected = z.strictObject({
	outcome: z.enum([
		"busy",
		"denied",
		"stale",
		"unknown",
		"disabled",
		"invalid_parameters",
		"unsupported",
		"unavailable",
		"conflict",
	]),
	reason: z
		.enum([
			"authorization_lost",
			"conversation_unavailable",
			"metadata_unavailable",
			"idempotency_in_progress",
			"idempotency_conflict",
		])
		.optional(),
});

export const NativeCapabilityInvocationResponseV1Schema = z.union([
	accepted,
	rejected,
]);

const response = (description: string, schema: z.ZodType) => ({
	description,
	content: { "application/json": { schema } },
});
const body = (schema: z.ZodType) => ({
	required: true,
	content: { "application/json": { schema } },
});

export const nativeCapabilityInvocationOpenApiPathsV1 = {
	"/api/v2/conversations/{conversationId}/native-capability/invoke": {
		post: {
			operationId: "invokeNativeCapabilityV1",
			security: [{ PlatformSession: [] }],
			requestParams: {
				path: z.strictObject({ conversationId: OpaqueIdV1Schema }),
			},
			requestBody: body(NativeCapabilityInvocationRequestV1Schema),
			responses: {
				"202": response(
					"Native capability admission accepted or replayed",
					accepted,
				),
				"400": response("Invalid native capability request", rejected),
				"403": response("Native capability admission denied", rejected),
				"409": response(
					"Native capability admission conflicts with current state",
					rejected,
				),
				"503": response("Native capability admission is unavailable", rejected),
			},
		},
	},
} as const;

export const nativeCapabilityInvocationSchemasV1 = {
	NativeCapabilityInvocationRequestV1:
		NativeCapabilityInvocationRequestV1Schema,
	NativeCapabilityInvocationResultV1: NativeCapabilityInvocationResultV1Schema,
	NativeCapabilityInvocationResponseV1:
		NativeCapabilityInvocationResponseV1Schema,
};

export type NativeCapabilityInvocationRequestV1 = z.infer<
	typeof NativeCapabilityInvocationRequestV1Schema
>;
export type NativeCapabilityInvocationResponseV1 = z.infer<
	typeof NativeCapabilityInvocationResponseV1Schema
>;
