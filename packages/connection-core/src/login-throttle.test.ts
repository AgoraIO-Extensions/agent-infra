import { expect, it } from "vitest";
import {
	assertLoginAdmission,
	LoginRateLimitedError,
	loginBackoffMs,
	loginThrottlePolicy,
	nextLoginFailure,
} from "./login-throttle.js";

it("bounds login backoff", () => {
	expect(
		[0, 1, 2, 3, 4, 10, 100].map((failures) => loginBackoffMs(failures)),
	).toEqual([0, 0, 0, 250, 500, 30_000, 30_000]);
});

it("applies shared admission limits and resets expired failure windows", () => {
	const admitted = {
		sourceInFlight: 0,
		accountInFlight: 0,
		environmentInFlight: 0,
	};
	expect(() => assertLoginAdmission(admitted, 1_000)).not.toThrow();
	for (const blocked of [
		{ sourceInFlight: loginThrottlePolicy.sourceConcurrency },
		{ accountInFlight: loginThrottlePolicy.accountConcurrency },
		{ environmentInFlight: loginThrottlePolicy.environmentConcurrency },
		{ sourceNextAllowedAt: 1_001 },
		{ accountNextAllowedAt: 1_001 },
		{ environmentNextAllowedAt: 1_001 },
	])
		expect(() =>
			assertLoginAdmission({ ...admitted, ...blocked }, 1_000),
		).toThrow(LoginRateLimitedError);
	const first = nextLoginFailure(undefined, 1_000);
	expect(first).toEqual({
		failures: 1,
		windowUntil: 1_000 + loginThrottlePolicy.windowMs,
		nextAllowedAt: null,
	});
	expect(nextLoginFailure(first, first.windowUntil)).toEqual({
		failures: 1,
		windowUntil: first.windowUntil + loginThrottlePolicy.windowMs,
		nextAllowedAt: null,
	});
	expect(
		nextLoginFailure(
			{ failures: 999, windowUntil: first.windowUntil },
			1_000,
			loginThrottlePolicy.environmentBackoffThreshold,
		).nextAllowedAt,
	).toBe(1_250);
});
