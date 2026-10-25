import { describe, expect, it } from "vitest";
import { runtimeRecoveryBudgetMs } from "./runtime-recovery-budget.js";

describe("Worker unknown recovery budget configuration (#3373)", () => {
	it("leaves the Core default in place when unset", () => {
		expect(runtimeRecoveryBudgetMs(undefined)).toBeUndefined();
		expect(runtimeRecoveryBudgetMs("")).toBeUndefined();
	});

	it.each([
		["1", 1],
		["300000", 300_000],
		["86400000", 86_400_000],
	])("accepts %s milliseconds", (value, expected) => {
		expect(runtimeRecoveryBudgetMs(value)).toBe(expected);
	});

	it.each(["0", "-1", "1.5", "5m", " 300000", "086400", "86400001", "1e6"])(
		"refuses %j",
		(value) => {
			expect(() => runtimeRecoveryBudgetMs(value)).toThrow(
				"PLATFORM_WORKER_RUNTIME_RECOVERY_BUDGET_MS",
			);
		},
	);
});
