import {
	actionCallNamespaceKey,
	actionRequestDigest,
	actorNamespaceId,
	assertActionCallTransition,
	decideActionCallReplay,
} from "./calls.js";
import { assertGrantUsable } from "./grants.js";
import type {
	ActionCallRecord,
	ActionCallRequest,
	ActionCallStatus,
	GrantRecord,
} from "./types.js";

export interface ConnectionAuditEvent {
	id: string;
	traceId: string;
	principalId?: string;
	consumerInstanceId?: string;
	actorId?: string;
	action: string;
	targetType: string;
	targetId: string;
	outcome: "succeeded" | "rejected" | "failed";
	metadata: Record<string, unknown>;
	occurredAt?: number;
}

export interface AuditEventStore {
	insert(event: ConnectionAuditEvent): Promise<void>;
}

/**
 * The repository receives a fully resolved server-side context. It must not
 * accept a caller-selected Principal, Connection or Credential selector as a
 * substitute for this context.
 */
export interface ActiveGrantRepository {
	findActiveGrant(context: {
		principalId: string;
		consumerId: string;
		consumerInstanceId: string;
		actorId: string | null;
		connectionId: string;
		actionVersionId: string;
		principalRecoveryGeneration: number;
	}): Promise<GrantRecord | undefined>;
}

export interface ActionCallRepository {
	findByIdempotency(
		namespaceKey: string,
		idempotencyKey: string,
	): Promise<ActionCallRecord | undefined>;
	insert(record: ActionCallRecord): Promise<void>;
	transition(
		id: string,
		from: ActionCallStatus,
		to: ActionCallStatus,
	): Promise<boolean>;
}

export interface ConnectionAuthorityRepository
	extends ActiveGrantRepository,
		ActionCallRepository {}

export class ConnectionAuthorizationDenied extends Error {
	constructor() {
		super("Connection authorization denied");
		this.name = "ConnectionAuthorizationDenied";
	}
}

/** Resolve authorization without exposing whether another subject's record exists. */
export async function authorizeActionCall(
	repository: ActiveGrantRepository,
	request: ActionCallRequest,
	principalRecoveryGeneration: number,
): Promise<GrantRecord> {
	const grant = await repository.findActiveGrant({
		principalId: request.principalId,
		consumerId: request.consumerId,
		consumerInstanceId: request.consumerInstanceId,
		actorId: request.actorId,
		connectionId: request.connectionId,
		actionVersionId: request.actionVersionId,
		principalRecoveryGeneration,
	});
	if (!grant) throw new ConnectionAuthorizationDenied();
	try {
		assertGrantUsable(grant, {
			principalId: request.principalId,
			consumerId: request.consumerId,
			consumerInstanceId: request.consumerInstanceId,
			actorId: request.actorId,
			connectionId: request.connectionId,
			actionVersionId: request.actionVersionId,
			principalRecoveryGeneration,
			credentialVersionId: grant.credentialVersionId,
		});
	} catch {
		throw new ConnectionAuthorizationDenied();
	}
	return grant;
}

/** Reserve/reuse a call while keeping idempotency conflicts indistinguishable. */
export async function reserveActionCall(
	repository: ActionCallRepository,
	record: ActionCallRecord,
	request: ActionCallRequest,
	grant: GrantRecord,
): Promise<ActionCallRecord> {
	const expectedActorId = actorNamespaceId(request.actorId);
	if (
		record.namespaceKey !== actionCallNamespaceKey(request) ||
		record.idempotencyKey !== request.idempotencyKey ||
		record.requestDigest !== actionRequestDigest(request) ||
		record.principalId !== request.principalId ||
		record.consumerId !== request.consumerId ||
		record.consumerInstanceId !== request.consumerInstanceId ||
		record.actorId !== expectedActorId ||
		record.grantId !== grant.id ||
		record.connectionId !== request.connectionId ||
		record.actionVersionId !== request.actionVersionId ||
		record.credentialVersionId !== grant.credentialVersionId ||
		request.grantId !== grant.id ||
		!grant.actionVersionIds.includes(request.actionVersionId)
	) {
		throw new ConnectionAuthorizationDenied();
	}
	const existing = await repository.findByIdempotency(
		record.namespaceKey,
		request.idempotencyKey,
	);
	if (existing) {
		const replay = decideActionCallReplay(existing, request);
		if (replay.kind === "reuse") return replay.record;
		throw new ConnectionAuthorizationDenied();
	}
	await repository.insert(record);
	return record;
}

export async function transitionActionCall(
	repository: ActionCallRepository,
	id: string,
	from: ActionCallStatus,
	to: ActionCallStatus,
): Promise<void> {
	try {
		assertActionCallTransition(from, to);
	} catch {
		throw new Error("invalid ActionCall transition");
	}
	if (!(await repository.transition(id, from, to)))
		throw new Error("ActionCall transition lost its compare-and-set race");
}
