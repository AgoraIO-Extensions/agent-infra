import { describe, expect, it } from "vitest";

import {
	IdempotencyKeyV1Schema,
	OpaqueCursorV1Schema,
	OpaqueIdV1Schema,
	ProtocolErrorV1Schema,
	RequestIdV1Schema,
	RetryableV1Schema,
	Rfc3339TimestampV1Schema,
	SchemaVersionV1Schema,
	TraceIdV1Schema,
} from "./index.js";

const validProtocolError = {
	schemaVersion: 1,
	code: "RUNTIME_UNAVAILABLE",
	message: "Runtime is temporarily unavailable",
	retryable: true,
	traceId: "01JQY7K9M4N6P8R2T3V5W7X9ZA",
};

describe("common wire schemas", () => {
	it("accepts the fixed V1 primitives and ProtocolErrorV1", () => {
		expect(SchemaVersionV1Schema.parse(1)).toBe(1);
		expect(OpaqueIdV1Schema.parse("agent_01JQY7K9M4")).toBe("agent_01JQY7K9M4");
		expect(Rfc3339TimestampV1Schema.parse("2026-08-28T03:00:00Z")).toBe(
			"2026-08-28T03:00:00Z",
		);
		expect(TraceIdV1Schema.parse(validProtocolError.traceId)).toBe(
			validProtocolError.traceId,
		);
		expect(RequestIdV1Schema.parse("request-01JQY7K9M4")).toBe(
			"request-01JQY7K9M4",
		);
		expect(IdempotencyKeyV1Schema.parse("message.retry_01")).toBe(
			"message.retry_01",
		);
		expect(OpaqueCursorV1Schema.parse("cursor:v1:opaque-value")).toBe(
			"cursor:v1:opaque-value",
		);
		expect(RetryableV1Schema.parse(true)).toBe(true);
		expect(ProtocolErrorV1Schema.parse(validProtocolError)).toEqual(
			validProtocolError,
		);
	});

	it("rejects malformed or expanded wire values", () => {
		expect(SchemaVersionV1Schema.safeParse(2).success).toBe(false);
		expect(OpaqueIdV1Schema.safeParse("").success).toBe(false);
		expect(
			Rfc3339TimestampV1Schema.safeParse("2026-08-28 03:00:00").success,
		).toBe(false);
		expect(IdempotencyKeyV1Schema.safeParse("contains space").success).toBe(
			false,
		);
		expect(OpaqueCursorV1Schema.safeParse("").success).toBe(false);
		expect(
			ProtocolErrorV1Schema.safeParse({
				...validProtocolError,
				unexpectedField: true,
			}).success,
		).toBe(false);
	});

	it("keeps opaque values and safe messages protocol-neutral", () => {
		expect(OpaqueIdV1Schema.parse("agent:租户/01")).toBe("agent:租户/01");
		expect(TraceIdV1Schema.parse("trace:供应商/01")).toBe("trace:供应商/01");
		expect(RequestIdV1Schema.parse("request:调用/01")).toBe("request:调用/01");
		expect(OpaqueCursorV1Schema.parse("cursor:游标/01")).toBe("cursor:游标/01");
		expect(
			ProtocolErrorV1Schema.parse({
				...validProtocolError,
				code: "runtime.unavailable",
				message: "运行时暂时不可用",
			}),
		).toMatchObject({
			code: "runtime.unavailable",
			message: "运行时暂时不可用",
		});
	});
});
