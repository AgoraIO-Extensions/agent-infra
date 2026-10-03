import { z } from "zod";

import { SchemaVersionV1Schema, TraceIdV1Schema } from "../index.ts";

export const PilotRetryableErrorCodeV1Schema = z.enum([
	"AGENT_BUSY",
	"AGENT_STARTING",
	"AGENT_UPDATING",
	"RUNTIME_UNAVAILABLE",
	"CONNECTION_UNAVAILABLE",
	"PROVIDER_RATE_LIMITED",
	"DEPENDENCY_UNAVAILABLE",
	"INTERNAL_ERROR",
]);

export const PilotTerminalErrorCodeV1Schema = z.enum([
	"INVALID_REQUEST",
	"AUTHENTICATION_REQUIRED",
	"RESOURCE_UNAVAILABLE",
	"AUTHORIZATION_REVOKED",
	"CONVERSATION_UNAVAILABLE",
	"EXECUTION_FAILED",
	"MODEL_SELECTION_INVALID",
	"CONNECTION_AUTHORIZATION_REQUIRED",
	"ACTION_UNAVAILABLE",
	"PROVIDER_REJECTED",
	"DELEGATED_RESULT_REJECTED",
	"ORIGINAL_RESPONSE_NOT_STARTED",
	"ORIGINAL_RESPONSE_ALREADY_FINISHED",
]);

const errorShape = {
	schemaVersion: SchemaVersionV1Schema,
	message: z.string().min(1),
	traceId: TraceIdV1Schema,
};

export const PilotProtocolErrorV1Schema = z.union([
	z.strictObject({
		...errorShape,
		code: PilotRetryableErrorCodeV1Schema,
		retryable: z.literal(true),
	}),
	z.strictObject({
		...errorShape,
		code: PilotTerminalErrorCodeV1Schema,
		retryable: z.literal(false),
	}),
]);

export const PilotAuthorizationRevokedErrorV1Schema = z.strictObject({
	...errorShape,
	code: z.literal("AUTHORIZATION_REVOKED"),
	retryable: z.literal(false),
});

export const PilotInternalErrorV1Schema = z.strictObject({
	...errorShape,
	code: z.literal("INTERNAL_ERROR"),
	retryable: z.literal(true),
});

export type PilotProtocolErrorV1 = z.infer<typeof PilotProtocolErrorV1Schema>;
