import { describe, expect, it } from "vitest";
import { createTraceParent, isTraceParent, parseTraceParent } from "./trace.js";

describe("W3C traceparent", () => {
	it("creates a valid bounded context", () => {
		const value = createTraceParent();
		expect(value).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
		expect(isTraceParent(value)).toBe(true);
		expect(parseTraceParent(value)).toMatchObject({
			traceFlags: 1,
			isRemote: true,
		});
	});

	it.each([
		"",
		"00-00000000000000000000000000000000-1234567890abcdef-01",
		"00-1234567890abcdef1234567890abcdef-0000000000000000-01",
		"00-1234567890abcdef1234567890abcdef-1234567890abcdef-ff-extra",
		"01-1234567890abcdef1234567890abcdef-1234567890abcdef-01",
	])("rejects malformed or unusable context %j", (value) => {
		expect(isTraceParent(value)).toBe(false);
		expect(parseTraceParent(value)).toBeUndefined();
	});
});
