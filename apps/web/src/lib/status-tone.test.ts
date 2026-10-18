import { describe, expect, it } from "vitest";
import { statusTone } from "./status-tone.js";

describe("statusTone", () => {
	it.each([
		["ready", "green"],
		["available", "green"],
		["succeeded", "green"],
		["starting", "amber"],
		["updating", "amber"],
		["pending_approval", "amber"],
		["creating", "amber"],
		["unavailable", "red"],
		["creation_failed", "red"],
		["disabled", "red"],
		["rejected", "red"],
		["failed", "red"],
	] as const)("maps %s to %s", (value, tone) => {
		expect(statusTone(value)).toBe(tone);
	});

	it.each([
		"withdrawn",
		"stopped",
		"not_configured",
		"binding",
		"constructor",
		"",
		null,
		undefined,
	])("defaults %s to gray", (value) => {
		expect(statusTone(value)).toBe("gray");
	});
});
