import { AsyncLocalStorage } from "node:async_hooks";
export type NativeAdmissionStageV1 =
	| "UNKNOWN"
	| "identity.initial"
	| "identity.revalidate"
	| "authorization.initial"
	| "authorization.recheck"
	| "store.transaction"
	| "store.lock"
	| "store.query"
	| "metadata.first"
	| "metadata.second"
	| "metadata.scope"
	| "metadata.commands"
	| "metadata.skills"
	| "precommit"
	| "delivery";

export interface NativeAdmissionObservationV1 {
	readonly stage: NativeAdmissionStageV1;
	readonly phase: "started" | "completed" | "failed";
	readonly elapsedMs: number;
	/** Request-local observation correlation, discarded by the output projector. */
	readonly observationId?: number;
	/** Transient input to the safe projector, never a log field. */
	readonly error?: unknown;
}
export type NativeAdmissionObserverV1 = (
	event: NativeAdmissionObservationV1,
) => void;

let observationSequence = 0;
const observationContext = new AsyncLocalStorage<number>();

/** Diagnostic correlation only; never an authorization or request identity. */
export function currentNativeAdmissionObservationV1() {
	return observationContext.getStore();
}

/** Observation failures must not change the work, its result or its exception. */
export async function observeNativeAdmissionV1<T>(
	observer: NativeAdmissionObserverV1 | undefined,
	stage: NativeAdmissionStageV1,
	work: () => Promise<T>,
): Promise<T> {
	if (!observer) return work();
	const began = performance.now();
	const observationId = ++observationSequence;
	const record = (
		phase: NativeAdmissionObservationV1["phase"],
		error?: unknown,
	) => {
		try {
			observer({
				stage,
				phase,
				observationId,
				elapsedMs: Math.max(0, Math.round(performance.now() - began)),
				...(phase === "failed" ? { error } : {}),
			});
		} catch {
			// Best-effort telemetry is independent of admission.
		}
	};
	record("started");
	try {
		const result = await observationContext.run(observationId, work);
		let phase: "failed" | "completed" = "completed";
		try {
			if (
				result &&
				typeof result === "object" &&
				"outcome" in result &&
				result.outcome === "unavailable"
			)
				phase = "failed";
		} catch {
			/* Uninspectable results remain unmodified. */
		}
		record(phase);
		return result;
	} catch (error) {
		record("failed", error);
		throw error;
	}
}
