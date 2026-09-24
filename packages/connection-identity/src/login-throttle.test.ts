import { expect, it } from "vitest";
import { LoginRateLimitedError, LoginThrottle } from "./login-throttle.js";

it("bounds concurrent login and recovers automatically from short account backoff", () => {
	let now = 1_000;
	const throttle = new LoginThrottle(() => now);
	const input = {
		environment: "pilot",
		source: "127.0.0.1",
		username: " Alice ",
	};
	const first = throttle.begin(input);
	const second = throttle.begin({ ...input, username: "alice" });
	expect(() => throttle.begin(input)).toThrow(LoginRateLimitedError);
	first(false);
	second(false);
	const third = throttle.begin(input);
	third(false);
	expect(() => throttle.begin(input)).toThrow(LoginRateLimitedError);
	now += 251;
	throttle.begin(input)(true);
	throttle.begin(input)(true);
	const last = throttle.begin(input);
	last(true);
});
