export interface RelayStageObservationV1 {
	readonly stage: "billing" | "catalog" | "models" | "responses" | "messages";
	readonly outcome: "completed" | "rejected" | "failed";
	readonly durationMs: number;
	readonly upstreamStatus?: number;
	readonly termination?: "timeout" | "aborted";
}

export type RelayStageObserverV1 = (event: RelayStageObservationV1) => void;

/** Observe the full operation, including decoding the upstream body. */
export async function observeRelayStageV1<T>(
	observer: RelayStageObserverV1 | undefined,
	stage: RelayStageObservationV1["stage"],
	signal: AbortSignal,
	operation: (captureStatus: (status: number) => void) => Promise<T>,
	classify: (value: T) => RelayStageObservationV1["outcome"] = () =>
		"completed",
): Promise<T> {
	const began = performance.now();
	let outcome: RelayStageObservationV1["outcome"] = "failed";
	let upstreamStatus: number | undefined;
	let timedOut = false;
	try {
		const value = await operation((status) => {
			upstreamStatus = status;
		});
		outcome = classify(value);
		return value;
	} catch (error) {
		timedOut = error instanceof DOMException && error.name === "TimeoutError";
		throw error;
	} finally {
		try {
			const termination =
				outcome !== "failed"
					? undefined
					: timedOut ||
							(signal.reason instanceof DOMException &&
								signal.reason.name === "TimeoutError")
						? "timeout"
						: signal.aborted
							? "aborted"
							: undefined;
			observer?.({
				stage,
				outcome,
				durationMs: performance.now() - began,
				...(upstreamStatus === undefined ? {} : { upstreamStatus }),
				...(termination === undefined ? {} : { termination }),
			});
		} catch {
			// Telemetry must not change admission or its errors.
		}
	}
}
