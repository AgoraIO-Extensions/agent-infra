import { describe, expect, it } from "vitest";
import { isTraceParentV1 } from "./trace-context.js";

describe("durable trace context contract", () => {
	it("accepts only bounded W3C traceparent values", () => {
		expect(
			isTraceParentV1(
				"00-1234567890abcdef1234567890abcdef-1234567890abcdef-01",
			),
		).toBe(true);
	});

	it.each([
		undefined,
		"",
		"00-00000000000000000000000000000000-1234567890abcdef-01",
		"00-1234567890abcdef1234567890abcdef-0000000000000000-01",
		"01-1234567890abcdef1234567890abcdef-1234567890abcdef-01",
	])("rejects %j without throwing", (value) => {
		expect(isTraceParentV1(value)).toBe(false);
	});
});
