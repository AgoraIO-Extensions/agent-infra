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
	});
});
