export class LoginRateLimitedError extends Error {
	constructor() {
		super("Login temporarily unavailable");
		this.name = "LoginRateLimitedError";
	}
}

export function normalizeLoginAccount(username: string): string {
	return username.normalize("NFKC").trim().toLowerCase();
}

export const loginThrottlePolicy = {
	windowMs: 15 * 60_000,
	leaseMs: 30_000,
	sourceConcurrency: 4,
	accountConcurrency: 2,
	environmentConcurrency: 50,
	environmentBackoffThreshold: 1_000,
} as const;

export function loginBackoffMs(failures: number, threshold = 3): number {
	return failures < threshold
		? 0
		: Math.min(30_000, 250 * 2 ** Math.min(failures - threshold, 7));
}

export function assertLoginAdmission(
	input: {
		sourceNextAllowedAt?: number;
		accountNextAllowedAt?: number;
		environmentNextAllowedAt?: number;
		sourceInFlight: number;
		accountInFlight: number;
		environmentInFlight: number;
	},
	now: number,
): void {
	if (
		(input.sourceNextAllowedAt ?? 0) > now ||
		(input.accountNextAllowedAt ?? 0) > now ||
		(input.environmentNextAllowedAt ?? 0) > now ||
		input.sourceInFlight >= loginThrottlePolicy.sourceConcurrency ||
		input.accountInFlight >= loginThrottlePolicy.accountConcurrency ||
		input.environmentInFlight >= loginThrottlePolicy.environmentConcurrency
	)
		throw new LoginRateLimitedError();
}

export function nextLoginFailure(
	previous: { failures: number; windowUntil: number } | undefined,
	now: number,
	threshold = 3,
): { failures: number; windowUntil: number; nextAllowedAt: number | null } {
	const active = previous && previous.windowUntil > now ? previous : undefined;
	const failures = (active?.failures ?? 0) + 1;
	const backoff = loginBackoffMs(failures, threshold);
	return {
		failures,
		windowUntil: active?.windowUntil ?? now + loginThrottlePolicy.windowMs,
		nextAllowedAt: backoff > 0 ? now + backoff : null,
	};
}

export type LoginThrottleOutcome = "succeeded" | "rejected" | "unavailable";
