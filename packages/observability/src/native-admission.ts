import {
	currentNativeAdmissionObservationV1,
	type NativeAdmissionObservationV1,
	type NativeAdmissionObserverV1,
} from "@agent-infra/platform-core";

const stages = new Set([
	"UNKNOWN",
	"identity.initial",
	"identity.revalidate",
	"authorization.initial",
	"authorization.recheck",
	"store.transaction",
	"store.lock",
	"store.query",
	"metadata.first",
	"metadata.second",
	"metadata.scope",
	"metadata.commands",
	"metadata.skills",
	"precommit",
	"delivery",
]);
const reasons = new Set([
	"ok",
	"completed_after_cancel",
	"client_abort",
	"internal_deadline",
	"dependency",
	"store",
	"UNKNOWN",
]);
const sqlStates = new Set([
	"55P03",
	"57014",
	"53300",
	"08001",
	"08006",
	"57P03",
	"40001",
	"40P01",
]);

/** Re-project at the log/Trace boundary; no arbitrary error properties survive. */
export function projectNativeAdmission(value: unknown) {
	if (!value || typeof value !== "object") return undefined;
	const v = value as Record<string, unknown>;
	if (
		!stages.has(v.stage as string) ||
		!["started", "completed", "failed"].includes(v.phase as string) ||
		!reasons.has(v.reason as string) ||
		!reasons.has(v.cancelSource as string) ||
		v.cancelSource === "ok" ||
		v.cancelSource === "completed_after_cancel" ||
		(v.reason === "completed_after_cancel" &&
			(v.phase !== "completed" ||
				!["client_abort", "internal_deadline"].includes(
					v.cancelSource as string,
				))) ||
		![1, 2, 3, 6, "UNKNOWN"].includes(v.protocolVersion as number) ||
		!Number.isSafeInteger(v.elapsedMs) ||
		(v.elapsedMs as number) < 0
	)
		return undefined;
	return {
		nativeAdmissionStage: v.stage as string,
		nativeAdmissionPhase: v.phase as string,
		protocolVersion: v.protocolVersion as number | "UNKNOWN",
		reason: v.reason as string,
		elapsedMs: v.elapsedMs as number,
		cancelSource: v.cancelSource as string,
		...(sqlStates.has(v.sqlState as string)
			? { sqlState: v.sqlState as string }
			: {}),
	};
}

export function createNativeAdmissionTelemetry(
	record: (value: unknown) => void,
) {
	let protocolVersion: number | "UNKNOWN" = "UNKNOWN";
	const began = performance.now();
	const pending = new Map<
		number,
		{ stage: NativeAdmissionObservationV1["stage"]; began: number }
	>();
	const failPending = (error?: unknown, sharedCancellation = false) => {
		const source = sharedCancellation
			? undefined
			: currentNativeAdmissionObservationV1();
		const match = source === undefined ? undefined : pending.get(source);
		const entry =
			match && source !== undefined
				? ([source, match] as const)
				: source === undefined && pending.size === 1
					? pending.entries().next().value
					: undefined;
		if (!entry) {
			observe({
				stage: "UNKNOWN",
				phase: "failed",
				elapsedMs: Math.max(0, Math.round(performance.now() - began)),
				error,
			});
			return;
		}
		const [observationId, { stage, began: stageBegan }] = entry;
		observe({
			stage,
			phase: "failed",
			elapsedMs: Math.max(0, Math.round(performance.now() - stageBegan)),
			observationId,
			error,
		});
	};
	let cancelSource = "UNKNOWN";
	let first: { reason: string; sqlState?: string } | undefined;
	const failure = (error: unknown, stage?: string) => {
		try {
			let current = error;
			let sqlState: string | undefined;
			let authorizationRejected = false;
			for (
				let depth = 0;
				depth < 4 && current && typeof current === "object";
				depth++
			) {
				const e = current as {
					status?: unknown;
					code?: unknown;
					sqlState?: unknown;
					cause?: unknown;
				};
				if (e.status === 401 || e.status === 403) authorizationRejected = true;
				for (const code of [e.sqlState, e.code]) {
					if (typeof code === "string" && sqlStates.has(code))
						sqlState ??= code;
				}
				current = e.cause;
			}
			const reason =
				cancelSource !== "UNKNOWN"
					? cancelSource
					: sqlState ||
							(error !== undefined &&
								(stage === "store.lock" || stage === "store.query"))
						? "store"
						: !authorizationRejected &&
								error !== undefined &&
								(stage?.startsWith("metadata.") ||
									stage?.startsWith("identity."))
							? "dependency"
							: "UNKNOWN";
			if (!first || first.reason === "UNKNOWN")
				first = { reason, ...(sqlState ? { sqlState } : {}) };
		} catch {
			/* Uninspectable errors remain UNKNOWN. */
		}
	};
	const observe: NativeAdmissionObserverV1 = (
		event: NativeAdmissionObservationV1,
	) => {
		try {
			if (event.observationId !== undefined) {
				if (event.phase === "started")
					pending.set(event.observationId, {
						stage: event.stage,
						began: performance.now(),
					});
				else pending.delete(event.observationId);
			}
			if (event.phase === "failed") failure(event.error, event.stage);
			record({
				stage: event.stage,
				phase: event.phase,
				elapsedMs: event.elapsedMs,
				protocolVersion,
				cancelSource,
				reason:
					event.phase === "failed"
						? (first?.reason ?? "UNKNOWN")
						: event.phase === "completed" && cancelSource !== "UNKNOWN"
							? "completed_after_cancel"
							: "ok",
				...(event.phase === "failed" ? first : {}),
			});
		} catch {
			// Diagnostics cannot change admission or cleanup.
		}
	};
	return {
		observe,
		failure: failPending,
		protocol(version: number) {
			if ([1, 2, 3, 6].includes(version)) protocolVersion = version;
		},
		cancel(source: "client_abort" | "internal_deadline") {
			if (cancelSource === "UNKNOWN") cancelSource = source;
			failure(undefined);
			failPending(undefined, true);
		},
	};
}
