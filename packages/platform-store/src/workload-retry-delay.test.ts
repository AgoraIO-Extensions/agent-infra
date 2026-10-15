import { describe, expect, it } from "vitest";
import { workloadRetryDelayMsV1 } from "./workload-reconciliation.js";

describe("Workload durable retry delay (#2532)", () => {
	it("backs cleanup and route closure off after five failures up to 60 s", () => {
		for (const phase of ["cleaning", "closing"] as const) {
			const delays = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 60].map(
				(attempts) => workloadRetryDelayMsV1({ phase, attempts }, 1_000),
			);
			expect(delays).toEqual([
				1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 2_000, 4_000, 8_000, 16_000,
				32_000, 60_000, 60_000, 60_000,
			]);
		}
	});

	it("keeps a fixed interval for phases that wait for readiness or spend a bounded budget", () => {
		for (const phase of [
			"preflight",
			"applying",
			"observing",
			"activating",
			"promoting",
			"ready",
			"rejected",
		] as const)
			expect(workloadRetryDelayMsV1({ phase, attempts: 40 }, 1_000)).toBe(
				1_000,
			);
	});

	it("never shortens a configured interval and keeps a zero interval at zero", () => {
		expect(
			workloadRetryDelayMsV1({ phase: "cleaning", attempts: 40 }, 120_000),
		).toBe(120_000);
		expect(workloadRetryDelayMsV1({ phase: "cleaning", attempts: 40 }, 0)).toBe(
			0,
		);
	});
});
