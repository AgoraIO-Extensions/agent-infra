import {
	type ConnectionGrantStatus,
	consumerActorSentinel,
	type GrantRecord,
	requireNonEmpty,
} from "./types.js";

export interface GrantInput {
	id: string;
	principalId: string;
	consumerId: string;
	consumerInstanceId: string;
	consumerActorRequired: boolean;
	actorId?: string | null;
	connectionId: string;
	credentialVersionId: string;
	actionVersionIds: readonly string[];
	principalRecoveryGeneration: number;
	consumerInstanceRecoveryGeneration: number;
	issuedAt: number;
	expiresAt: number;
}

export interface GrantUseContext {
	principalId: string;
	consumerId: string;
	consumerInstanceId: string;
	actorId?: string | null;
	connectionId: string;
	credentialVersionId: string;
	actionVersionId: string;
	principalRecoveryGeneration: number;
	now?: number;
}

function actorIdForGrant(actorId: string | null | undefined): string {
	if (actorId === consumerActorSentinel)
		throw new Error(`actorId must not be ${consumerActorSentinel}`);
	return actorId ?? consumerActorSentinel;
}

export function createGrant(input: GrantInput): GrantRecord {
	const actorId = actorIdForGrant(input.actorId);
	if (
		typeof input.consumerActorRequired !== "boolean" ||
		input.consumerActorRequired === (actorId === consumerActorSentinel)
	)
		throw new Error("Actor mode does not match Consumer");
	const actionVersionIds = [
		...new Set(
			input.actionVersionIds.map((id) =>
				requireNonEmpty(id, "actionVersionId"),
			),
		),
	];
	if (actionVersionIds.length === 0)
		throw new Error("a grant must contain an ActionVersion");
	if (
		!Number.isSafeInteger(input.principalRecoveryGeneration) ||
		input.principalRecoveryGeneration < 1
	) {
		throw new Error("principalRecoveryGeneration must be a positive integer");
	}
	if (
		!Number.isSafeInteger(input.consumerInstanceRecoveryGeneration) ||
		input.consumerInstanceRecoveryGeneration < 1
	) {
		throw new Error(
			"consumerInstanceRecoveryGeneration must be a positive integer",
		);
	}
	if (
		!Number.isSafeInteger(input.issuedAt) ||
		!Number.isSafeInteger(input.expiresAt) ||
		input.expiresAt <= input.issuedAt
	)
		throw new Error("Grant lifetime is invalid");
	return {
		id: requireNonEmpty(input.id, "grant id"),
		principalId: requireNonEmpty(input.principalId, "principalId"),
		consumerId: requireNonEmpty(input.consumerId, "consumerId"),
		consumerInstanceId: requireNonEmpty(
			input.consumerInstanceId,
			"consumerInstanceId",
		),
		actorId,
		connectionId: requireNonEmpty(input.connectionId, "connectionId"),
		credentialVersionId: requireNonEmpty(
			input.credentialVersionId,
			"credentialVersionId",
		),
		actionVersionIds,
		revision: 1,
		status: "active",
		principalRecoveryGeneration: input.principalRecoveryGeneration,
		consumerInstanceRecoveryGeneration:
			input.consumerInstanceRecoveryGeneration,
		issuedAt: input.issuedAt,
		expiresAt: input.expiresAt,
	};
}

export function revokeGrant(grant: GrantRecord): GrantRecord {
	if (grant.status === "revoked") return grant;
	return { ...grant, status: "revoked", revision: grant.revision + 1 };
}

export function assertGrantUsable(
	grant: GrantRecord,
	context: GrantUseContext,
): void {
	const actorId = actorIdForGrant(context.actorId);
	const now = context.now ?? Date.now();
	if (
		grant.status !== "active" ||
		grant.principalId !== context.principalId ||
		grant.consumerId !== context.consumerId ||
		grant.consumerInstanceId !== context.consumerInstanceId ||
		grant.actorId !== actorId ||
		grant.connectionId !== context.connectionId ||
		grant.credentialVersionId !== context.credentialVersionId ||
		grant.principalRecoveryGeneration !== context.principalRecoveryGeneration ||
		grant.expiresAt <= now ||
		!grant.actionVersionIds.includes(context.actionVersionId)
	) {
		throw new Error("Connection grant is not valid for this request");
	}
}

export function grantStatusAllowsUse(status: ConnectionGrantStatus): boolean {
	return status === "active";
}
