import { describe, expect, it } from "vitest";
import { createConcurrencyLimit } from "./bounded-concurrency.js";

describe("createConcurrencyLimit (#4048)", () => {
	it("runs at most the limit at once, keeps result order and frees a failed slot", async () => {
		const limit = createConcurrencyLimit(4);
		let active = 0;
		let peak = 0;
		const results = await Promise.allSettled(
			Array.from({ length: 10 }, (_, index) =>
				limit(async () => {
					active++;
					peak = Math.max(peak, active);
					await new Promise((resolve) => setTimeout(resolve, 10 - index));
					active--;
					if (index === 2) throw new Error("synthetic failure");
					return index;
				}),
			),
		);

		expect(peak).toBe(4);
		expect(active).toBe(0);
		expect(results.map((result) => result.status)).toEqual([
			"fulfilled",
			"fulfilled",
			"rejected",
			...Array.from({ length: 7 }, () => "fulfilled"),
		]);
		expect(
			results.flatMap((result) =>
				result.status === "fulfilled" ? [result.value] : [],
			),
		).toEqual([0, 1, 3, 4, 5, 6, 7, 8, 9]);
	});

	it.each([0, 1.5, Number.NaN])("rejects an invalid limit %s", (limit) => {
		expect(() => createConcurrencyLimit(limit)).toThrow(RangeError);
	});
});
