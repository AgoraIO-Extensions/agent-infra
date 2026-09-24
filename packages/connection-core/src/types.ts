export const connectionPrincipalStatus = [
	"active",
	"disabled",
	"revoked",
] as const;
export type ConnectionPrincipalStatus =
	(typeof connectionPrincipalStatus)[number];

export const connectionGrantStatus = ["active", "revoked"] as const;
export type ConnectionGrantStatus = (typeof connectionGrantStatus)[number];

export const actionCallStatus = [
	"created",
	"submission_started",
	"provider_succeeded",
	"provider_failed",
	"result_pending",
	"needs_manual_review",
	"unresolved",
] as const;
export type ActionCallStatus = (typeof actionCallStatus)[number];

export const effectStatus = [
	"planned",
	"submitted",
	"succeeded",
	"failed",
	"unknown",
] as const;
export type EffectStatus = (typeof effectStatus)[number];

export const dispatchStatus = [
	"pending",
	"claimed",
	"completed",
	"failed",
	"unknown",
] as const;
export type DispatchStatus = (typeof dispatchStatus)[number];

export interface PrincipalRecord {
	id: string;
	issuer: string;
	uid: string;
	status: ConnectionPrincipalStatus;
	recoveryGeneration: number;
}

export interface ConsumerRecord {
	id: string;
	status: "active" | "disabled";
	actorRequired: boolean;
}

export interface ConsumerInstanceRecord {
	id: string;
	consumerId: string;
	principalId: string;
	status: "active" | "revoked";
	recoveryGeneration: number;
}

export interface ActorRecord {
	id: string;
	consumerInstanceId: string;
	status: "active" | "revoked";
}

export interface GrantRecord {
	id: string;
	principalId: string;
	consumerId: string;
	consumerInstanceId: string;
	actorId: string;
	connectionId: string;
	credentialVersionId: string;
	actionVersionIds: readonly string[];
	revision: number;
	status: ConnectionGrantStatus;
	principalRecoveryGeneration: number;
	issuedAt: number;
	expiresAt: number;
}

export interface ActionCallRecord {
	id: string;
	requestId: string;
	traceId: string;
	callId: string;
	idempotencyKey: string;
	namespaceKey: string;
	principalId: string;
	consumerId: string;
	consumerInstanceId: string;
	actorId: string;
	grantId: string;
	connectionId: string;
	credentialVersionId: string;
	actionVersionId: string;
	requestDigest: string;
	status: ActionCallStatus;
}

export interface ActionCallRequest {
	requestId: string;
	idempotencyKey: string;
	principalId: string;
	consumerId: string;
	consumerInstanceId: string;
	actorId: string | null;
	actionVersionId: string;
	arguments: unknown;
}

/** Bound only after Connection resolves one current Grant. */
export interface ResolvedActionCallRequest extends ActionCallRequest {
	grantId: string;
	connectionId: string;
}

export interface EffectRecord {
	id: string;
	actionCallId: string;
	status: EffectStatus;
	providerRequestKey: string;
	result: Record<string, unknown> | null;
}

export interface DispatchRecord {
	id: string;
	actionCallId: string;
	status: DispatchStatus;
	attemptCount: number;
	leaseOwner: string | null;
	leaseExpiresAt: number | null;
}

export const consumerActorSentinel = "__consumer_actor__";

export function requireNonEmpty(value: string, field: string): string {
	if (value.trim().length === 0) throw new Error(`${field} must not be empty`);
	return value;
}
