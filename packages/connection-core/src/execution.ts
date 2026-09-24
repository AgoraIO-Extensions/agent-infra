import type {
	ActionCallRepository,
	ActiveGrantRepository,
	ConnectionAuditEvent,
} from "./ports.js";
import type {
	ActionCallRecord,
	ActionCallStatus,
	DispatchRecord,
	DispatchStatus,
	EffectRecord,
	EffectStatus,
} from "./types.js";

/** Persistence contract for the state baseline. Provider dispatch belongs to #392. */
export interface ActionExecutionRepository
	extends ActiveGrantRepository,
		ActionCallRepository {
	reserveExecution(input: {
		actionCall: ActionCallRecord;
		dispatch: DispatchRecord;
		effect?: EffectRecord;
		audit: ConnectionAuditEvent;
	}): Promise<void>;
	/** State claim only. #392 must add repository policy and deadline before Provider access. */
	claimCurrentDispatchState(input: {
		actionCallId: string;
		dispatchId: string;
		effectId?: string;
		grantRevision: number;
		principalRecoveryGeneration: number;
		leaseOwner: string;
		leaseExpiresAt: number;
		audit: ConnectionAuditEvent;
	}): Promise<boolean>;
	failPendingDispatch(
		id: string,
		audit: ConnectionAuditEvent,
	): Promise<boolean>;
	recordProviderOutcome(input: {
		actionCallId: string;
		dispatchId: string;
		effectId?: string;
		outcome: ProviderOutcome;
		audit: ConnectionAuditEvent;
	}): Promise<boolean>;
}

export type ProviderOutcome =
	| { kind: "succeeded"; result: Record<string, unknown> | null }
	| { kind: "failed"; result?: Record<string, unknown> | null }
	| { kind: "unknown"; reason?: string };

export function outcomeStatuses(outcome: ProviderOutcome): {
	action: ActionCallStatus;
	dispatch: DispatchStatus;
	effect: EffectStatus;
} {
	switch (outcome.kind) {
		case "succeeded":
			return {
				action: "provider_succeeded",
				dispatch: "completed",
				effect: "succeeded",
			};
		case "failed":
			return {
				action: "provider_failed",
				dispatch: "failed",
				effect: "failed",
			};
		case "unknown":
			return {
				action: "result_pending",
				dispatch: "unknown",
				effect: "unknown",
			};
	}
}
