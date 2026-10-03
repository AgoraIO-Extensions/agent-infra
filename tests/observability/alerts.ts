/** Controlled acceptance rules; callers supply measured samples, no background loop. */
export function evaluateAlerts(
	samples: readonly {
		at: number;
		serviceAvailable: boolean;
		pending: number | undefined;
		errors: number;
	}[],
	thresholds: { pending: number; errors: number; sustainMs: number },
) {
	const current = samples.at(-1);
	if (!current) throw new Error("No observed sample");
	const lastClear = samples.findLastIndex(
		(sample) =>
			sample.pending === undefined || sample.pending < thresholds.pending,
	);
	const window = samples.slice(lastClear + 1);
	const sustained =
		window.length >= 2 &&
		current.at - (window[0]?.at ?? current.at) >= thresholds.sustainMs;
	return {
		serviceUnavailable: !current.serviceAvailable,
		persistentBacklog:
			sustained &&
			window.every(
				(sample) =>
					sample.pending !== undefined && sample.pending >= thresholds.pending,
			),
		abnormalErrors: current.errors >= thresholds.errors,
	};
}
