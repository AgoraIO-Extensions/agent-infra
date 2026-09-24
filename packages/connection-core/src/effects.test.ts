import { describe, expect, it } from "vitest";

import { assertDispatchTransition, assertEffectTransition } from "./effects.js";

describe("Connection Effect and Dispatch invariants", () => {
	it("allows only forward provider-result transitions", () => {
		expect(() => assertEffectTransition("planned", "submitted")).not.toThrow();
		expect(() => assertEffectTransition("submitted", "unknown")).not.toThrow();
		expect(() => assertEffectTransition("unknown", "succeeded")).not.toThrow();
		expect(() => assertEffectTransition("succeeded", "failed")).toThrow(
			/invalid Effect/,
		);
	});

	it("keeps a claimed dispatch from being replayed after a terminal result", () => {
		expect(() => assertDispatchTransition("pending", "claimed")).not.toThrow();
		expect(() =>
			assertDispatchTransition("claimed", "completed"),
		).not.toThrow();
		expect(() => assertDispatchTransition("completed", "claimed")).toThrow(
			/invalid Dispatch/,
		);
		expect(() => assertDispatchTransition("failed", "completed")).toThrow(
			/invalid Dispatch/,
		);
		expect(() =>
			assertDispatchTransition("unknown", "completed"),
		).not.toThrow();
	});
});
