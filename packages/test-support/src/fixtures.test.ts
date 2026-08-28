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
} from "@agent-infra/contracts";
import { describe, expect, it } from "vitest";

import {
	buildProtocolErrorV1,
	invalidCommonFixturesV1,
	validCommonFixturesV1,
} from "./index.js";

const schemas = {
	idempotencyKey: IdempotencyKeyV1Schema,
	opaqueCursor: OpaqueCursorV1Schema,
	opaqueId: OpaqueIdV1Schema,
	protocolError: ProtocolErrorV1Schema,
	requestId: RequestIdV1Schema,
	retryable: RetryableV1Schema,
	rfc3339Timestamp: Rfc3339TimestampV1Schema,
	schemaVersion: SchemaVersionV1Schema,
	traceId: TraceIdV1Schema,
};

describe("common contract test support", () => {
	it("keeps every positive fixture valid against its canonical schema", () => {
		for (const name of Object.keys(schemas) as Array<keyof typeof schemas>) {
			const schema = schemas[name];
			expect(schema.safeParse(validCommonFixturesV1[name]).success).toBe(true);
		}
	});

	it("keeps every negative fixture invalid against its canonical schema", () => {
		for (const name of Object.keys(schemas) as Array<keyof typeof schemas>) {
			const schema = schemas[name];
			expect(schema.safeParse(invalidCommonFixturesV1[name]).success).toBe(
				false,
			);
		}
	});

	it("builds a valid ProtocolErrorV1 without hiding explicit overrides", () => {
		const error = buildProtocolErrorV1({
			code: "REQUEST_REJECTED",
			retryable: false,
		});
		expect(ProtocolErrorV1Schema.parse(error)).toEqual({
			...validCommonFixturesV1.protocolError,
			code: "REQUEST_REJECTED",
			retryable: false,
		});
	});

	it("rejects overrides that violate the canonical ProtocolErrorV1 schema", () => {
		expect(() => buildProtocolErrorV1({ code: "invalid-code" })).toThrow();
	});
});
