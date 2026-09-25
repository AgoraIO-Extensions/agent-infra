import { randomUUID } from "node:crypto";
import {
	actionCallNamespaceKey,
	actionRequestDigest,
	actorNamespaceId,
	decideActionCallReplay,
} from "./calls.js";
import {
	type ActiveGrantRepository,
	authorizeActionCall,
	type ConnectionAuditEvent,
	ConnectionAuthorizationDenied,
} from "./ports.js";
import type {
	ActionCallRecord,
	ActionCallRequest,
	GrantRecord,
} from "./types.js";

export interface DirectAuthenticatedCaller {
	credentialId: string;
	principalId: string;
	consumerId: string;
	consumerInstanceId: string;
	actorId: string | null;
	principalRecoveryGeneration: number;
	scopes: readonly string[];
}

export interface DirectCredentialContext {
	credentialId: string;
	principalId: string;
	consumerId: string;
	consumerInstanceId: string;
	actorId: string | null;
	audience: string;
	requiredScope?: string;
}

export interface DirectActionCallRepository extends ActiveGrantRepository {
	findByIdempotencyForDirectClient(
		namespaceKey: string,
		idempotencyKey: string,
		credential: DirectCredentialContext,
	): Promise<ActionCallRecord | undefined>;
	findByCallIdForDirectClient(
		namespaceKey: string,
		callId: string,
		credential: DirectCredentialContext,
	): Promise<ActionCallRecord | undefined>;
	insertForDirectClient(
		record: ActionCallRecord,
		audit: ConnectionAuditEvent,
		grant: GrantRecord,
		credential: DirectCredentialContext,
	): Promise<void>;
}

export class DirectActionConflict extends Error {
	constructor() {
		super("Direct ActionCall idempotency conflict");
		this.name = "DirectActionConflict";
	}
}

function credentialContext(
	caller: DirectAuthenticatedCaller,
	audience: string,
	requiredScope?: string,
): DirectCredentialContext {
	return {
		credentialId: caller.credentialId,
		principalId: caller.principalId,
		consumerId: caller.consumerId,
		consumerInstanceId: caller.consumerInstanceId,
		actorId: caller.actorId,
		audience,
		requiredScope,
	};
}

export async function reserveDirectActionCall(
	repository: DirectActionCallRepository,
	input: {
		caller: DirectAuthenticatedCaller;
		audience: string;
		requestId: string;
		idempotencyKey: string;
		traceId: string;
		actionVersionId: string;
		effect: string;
		arguments: unknown;
	},
): Promise<ActionCallRecord> {
	const { caller } = input;
	const requiredScope =
		input.effect === "read"
			? "action:read"
			: input.effect === "write"
				? "action:write"
				: null;
	if (!requiredScope || !caller.scopes.includes(requiredScope))
		throw new ConnectionAuthorizationDenied();
	const request: ActionCallRequest = {
		requestId: input.requestId,
		idempotencyKey: input.idempotencyKey,
		principalId: caller.principalId,
		consumerId: caller.consumerId,
		consumerInstanceId: caller.consumerInstanceId,
		actorId: caller.actorId,
		actionVersionId: input.actionVersionId,
		arguments: input.arguments,
	};
	const grant = await authorizeActionCall(
		repository,
		request,
		caller.principalRecoveryGeneration,
	);
	const namespaceKey = actionCallNamespaceKey(request);
	const credential = credentialContext(caller, input.audience, requiredScope);
	const replay = (existing: ActionCallRecord) => {
		if (
			existing.requestId !== request.requestId ||
			existing.traceId !== input.traceId ||
			decideActionCallReplay(existing, {
				...request,
				grantId: grant.id,
				connectionId: grant.connectionId,
			}).kind !== "reuse"
		)
			throw new DirectActionConflict();
		return existing;
	};
	const existing = await repository.findByIdempotencyForDirectClient(
		namespaceKey,
		request.idempotencyKey,
		credential,
	);
	if (existing) return replay(existing);
	const id = randomUUID();
	const record: ActionCallRecord = {
		id,
		callId: randomUUID(),
		requestId: request.requestId,
		traceId: input.traceId,
		idempotencyKey: request.idempotencyKey,
		namespaceKey,
		principalId: caller.principalId,
		consumerId: caller.consumerId,
		consumerInstanceId: caller.consumerInstanceId,
		actorId: actorNamespaceId(caller.actorId),
		grantId: grant.id,
		connectionId: grant.connectionId,
		credentialVersionId: grant.credentialVersionId,
		actionVersionId: request.actionVersionId,
		requestDigest: actionRequestDigest({
			connectionId: grant.connectionId,
			actionVersionId: request.actionVersionId,
			arguments: request.arguments,
		}),
		status: "created",
	};
	try {
		await repository.insertForDirectClient(
			record,
			{
				id: randomUUID(),
				traceId: input.traceId,
				principalId: caller.principalId,
				consumerInstanceId: caller.consumerInstanceId,
				actorId: caller.actorId ?? undefined,
				action: "mcp.call_reserved",
				targetType: "action_call",
				targetId: id,
				outcome: "succeeded",
				metadata: {},
			},
			grant,
			credential,
		);
	} catch (error) {
		const raced = await repository.findByIdempotencyForDirectClient(
			namespaceKey,
			request.idempotencyKey,
			credential,
		);
		if (!raced) throw error;
		return replay(raced);
	}
	return record;
}

export function findDirectActionCall(
	repository: DirectActionCallRepository,
	caller: DirectAuthenticatedCaller,
	audience: string,
	callId: string,
): Promise<ActionCallRecord | undefined> {
	return repository.findByCallIdForDirectClient(
		actionCallNamespaceKey(caller),
		callId,
		credentialContext(caller, audience),
	);
}
