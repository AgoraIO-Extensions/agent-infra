import { describe, expect, it } from "vitest";
import { workloadReconciliationRetryDelayMsV1 } from "./workload-reconciliation.js";

describe("Workload reconciliation retry backoff", () => {
	it("doubles from the first failed attempt and caps at one minute", () => {
		expect(
			[1, 2, 3, 4, 5, 6, 7].map((attempt) =>
				workloadReconciliationRetryDelayMsV1(attempt, 1000),
			),
		).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000]);
	});

	it("resets to the base delay after a successful step", () => {
		expect(workloadReconciliationRetryDelayMsV1(0, 1000)).toBe(1000);
		expect(workloadReconciliationRetryDelayMsV1(1, 0)).toBe(0);
	});
});
