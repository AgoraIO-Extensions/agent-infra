import { expect, it } from "vitest";
import { evaluateAlerts } from "./alerts.js";

it("requires sustained observed backlog and resets after missing or recovered samples", () => {
	const limits = { pending: 2, errors: 2, sustainMs: 1000 };
	const sample = (
		at: number,
		pending: number | undefined,
		errors = 0,
		serviceAvailable = true,
	) => ({ at, pending, errors, serviceAvailable });
	expect(
		evaluateAlerts([sample(0, 3), sample(999, 3)], limits).persistentBacklog,
	).toBe(false);
	expect(
		evaluateAlerts([sample(0, 3), sample(1001, 3)], limits).persistentBacklog,
	).toBe(true);
	expect(
		evaluateAlerts(
			[sample(0, 3), sample(1001, undefined), sample(2000, 3)],
			limits,
		).persistentBacklog,
	).toBe(false);
	expect(
		evaluateAlerts([sample(0, 3), sample(1001, 0)], limits).persistentBacklog,
	).toBe(false);
	expect(evaluateAlerts([sample(0, 0, 2, false)], limits)).toEqual({
		serviceUnavailable: true,
		persistentBacklog: false,
		abnormalErrors: true,
	});
	expect(evaluateAlerts([sample(0, 0, 0, true)], limits)).toEqual({
		serviceUnavailable: false,
		persistentBacklog: false,
		abnormalErrors: false,
	});
});
