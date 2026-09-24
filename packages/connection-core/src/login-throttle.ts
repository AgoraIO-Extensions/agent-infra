interface LoginBucket {
	windowUntil: number;
	failures: number;
	nextAllowedAt: number;
	inFlight: number;
}

export class LoginRateLimitedError extends Error {
	constructor() {
		super("Login temporarily unavailable");
		this.name = "LoginRateLimitedError";
	}
}

export function normalizeLoginAccount(username: string): string {
	return username.normalize("NFKC").trim().toLowerCase();
}

/** Bounded process-local admission for the Connection login entrypoint. */
export class LoginThrottle {
	private readonly buckets = new Map<string, LoginBucket>();

	constructor(private readonly now: () => number = Date.now) {}

	begin(input: {
		environment: string;
		source: string;
		username: string;
	}): (succeeded: boolean) => void {
		const account = normalizeLoginAccount(input.username);
		if (!input.environment || !input.source || !account)
			throw new LoginRateLimitedError();
		const now = this.now();
		for (const [key, bucket] of this.buckets) {
			if (bucket.windowUntil <= now && bucket.inFlight === 0)
				this.buckets.delete(key);
		}
		const keys = [
			`${input.environment}\u0000source\u0000${input.source}`,
			`${input.environment}\u0000account\u0000${account}`,
			`${input.environment}\u0000all`,
		];
		const missing = keys.filter((key) => !this.buckets.has(key)).length;
		while (this.buckets.size + missing > 10_000) {
			let victim: string | undefined;
			for (const [key, bucket] of this.buckets) {
				if (
					!keys.includes(key) &&
					!key.endsWith("\u0000all") &&
					bucket.inFlight === 0
				) {
					victim = key;
					break;
				}
			}
			if (!victim) throw new LoginRateLimitedError();
			this.buckets.delete(victim);
		}
		const buckets = keys.map((key) => {
			let bucket = this.buckets.get(key);
			if (!bucket) {
				bucket = {
					windowUntil: now + 15 * 60_000,
					failures: 0,
					nextAllowedAt: 0,
					inFlight: 0,
				};
				this.buckets.set(key, bucket);
			}
			return bucket;
		});
		const limits = [4, 2, 50];
		if (
			buckets.some(
				(bucket, index) =>
					bucket.nextAllowedAt > now || bucket.inFlight >= (limits[index] ?? 0),
			)
		)
			throw new LoginRateLimitedError();
		for (const bucket of buckets) bucket.inFlight += 1;
		let finished = false;
		return (succeeded) => {
			if (finished) return;
			finished = true;
			for (const [index, bucket] of buckets.entries()) {
				bucket.inFlight -= 1;
				if (index === 2) continue;
				if (succeeded) {
					if (index === 1) {
						bucket.failures = 0;
						bucket.nextAllowedAt = 0;
					}
				} else {
					bucket.failures += 1;
					if (bucket.failures >= 3)
						bucket.nextAllowedAt =
							this.now() +
							Math.min(30_000, 250 * 2 ** Math.min(bucket.failures - 3, 7));
				}
			}
		};
	}
}
