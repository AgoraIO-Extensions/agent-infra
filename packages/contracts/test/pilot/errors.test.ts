import { describe, expect, it } from "vitest";

import { PilotProtocolErrorV1Schema } from "../../src/pilot/errors.js";

describe("Pilot stable errors", () => {
	it("binds transient and terminal codes to stable retryability", () => {
		expect(
			PilotProtocolErrorV1Schema.parse({
				schemaVersion: 1,
				code: "AGENT_BUSY",
				message: "The conversation is busy",
				retryable: true,
				traceId: "trace-busy",
			}),
		).toMatchObject({ code: "AGENT_BUSY", retryable: true });
		expect(
			PilotProtocolErrorV1Schema.parse({
				schemaVersion: 1,
				code: "AUTHORIZATION_REVOKED",
				message: "Access is no longer available",
				retryable: false,
				traceId: "trace-authorization",
			}),
		).toMatchObject({ code: "AUTHORIZATION_REVOKED", retryable: false });
		for (const code of [
			"ORIGINAL_RESPONSE_NOT_STARTED",
			"ORIGINAL_RESPONSE_ALREADY_FINISHED",
		] as const) {
			expect(
				PilotProtocolErrorV1Schema.parse({
					schemaVersion: 1,
					code,
					message: "The supplementary message could not be delivered",
					retryable: false,
					traceId: "trace-message",
				}),
			).toMatchObject({ code, retryable: false });
		}
		expect(
			PilotProtocolErrorV1Schema.parse({
				schemaVersion: 1,
				code: "INTERNAL_ERROR",
				message: "The request could not be completed",
				retryable: true,
				traceId: "trace-internal",
			}),
		).toMatchObject({ code: "INTERNAL_ERROR", retryable: true });
	});

	it("rejects unknown codes and contradictory retryability", () => {
		expect(
			PilotProtocolErrorV1Schema.safeParse({
				schemaVersion: 1,
				code: "VENDOR_NATIVE_FAILURE",
				message: "Not a public error",
				retryable: false,
				traceId: "trace-vendor",
			}).success,
		).toBe(false);
		expect(
			PilotProtocolErrorV1Schema.safeParse({
				schemaVersion: 1,
				code: "AGENT_BUSY",
				message: "The conversation is busy",
				retryable: false,
				traceId: "trace-busy",
			}).success,
		).toBe(false);
		expect(
			PilotProtocolErrorV1Schema.safeParse({
				schemaVersion: 1,
				code: "INTERNAL_ERROR",
				message: "The request could not be completed",
				retryable: false,
				traceId: "trace-internal",
			}).success,
		).toBe(false);
	});
});
