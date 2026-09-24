import type { DispatchStatus, EffectStatus } from "./types.js";

const effectTransitions: Record<EffectStatus, readonly EffectStatus[]> = {
	planned: ["submitted", "failed", "unknown"],
	submitted: ["succeeded", "failed", "unknown"],
	succeeded: [],
	failed: [],
	unknown: ["succeeded", "failed"],
};

const dispatchTransitions: Record<DispatchStatus, readonly DispatchStatus[]> = {
	pending: ["claimed", "failed", "unknown"],
	claimed: ["completed", "failed", "unknown"],
	completed: [],
	failed: [],
	unknown: ["completed", "failed"],
};

export function assertEffectTransition(
	from: EffectStatus,
	to: EffectStatus,
): void {
	if (!effectTransitions[from].includes(to)) {
		throw new Error(`invalid Effect transition: ${from} -> ${to}`);
	}
}

export function assertDispatchTransition(
	from: DispatchStatus,
	to: DispatchStatus,
): void {
	if (!dispatchTransitions[from].includes(to)) {
		throw new Error(`invalid Dispatch transition: ${from} -> ${to}`);
	}
}
