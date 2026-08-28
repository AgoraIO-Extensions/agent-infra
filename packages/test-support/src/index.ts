import {
	ProtocolErrorV1Schema,
	type ProtocolErrorV1,
} from "@agent-infra/contracts";

export const validCommonFixturesV1 = {
	idempotencyKey: "message.retry_01",
	opaqueCursor: "cursor:v1:opaque-value",
	opaqueId: "agent_01JQY7K9M4",
	protocolError: {
		schemaVersion: 1,
		code: "RUNTIME_UNAVAILABLE",
		message: "Runtime is temporarily unavailable",
		retryable: true,
		traceId: "01JQY7K9M4N6P8R2T3V5W7X9ZA",
	},
	requestId: "request-01JQY7K9M4",
	retryable: true,
	rfc3339Timestamp: "2026-08-28T03:00:00Z",
	schemaVersion: 1,
	traceId: "01JQY7K9M4N6P8R2T3V5W7X9ZA",
} as const satisfies Record<string, unknown>;

export const invalidCommonFixturesV1 = {
	idempotencyKey: "contains space",
	opaqueCursor: "cursor\nvalue",
	opaqueId: "",
	protocolError: {
		...validCommonFixturesV1.protocolError,
		unexpectedField: true,
	},
	requestId: "",
	retryable: "yes",
	rfc3339Timestamp: "2026-08-28 03:00:00",
	schemaVersion: 2,
	traceId: "contains space",
} as const satisfies Record<string, unknown>;

export function buildProtocolErrorV1(
	overrides: Partial<ProtocolErrorV1> = {},
): ProtocolErrorV1 {
	return ProtocolErrorV1Schema.parse({
		...validCommonFixturesV1.protocolError,
		...overrides,
	});
}
