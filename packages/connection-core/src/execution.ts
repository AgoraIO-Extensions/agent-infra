import { randomBytes, randomUUID } from "node:crypto";

import {
	actionCallNamespaceKey,
	actionRequestDigest,
	decideActionCallReplay,
} from "./calls.js";
import {
	type ActionCallRepository,
	type ActiveGrantRepository,
	type AuditEventStore,
	authorizeActionCall,
} from "./ports.js";
import type {
	ActionCallRecord,
	ActionCallRequest,
	DispatchRecord,
	EffectRecord,
	GrantRecord,
} from "./types.js";
import { consumerActorSentinel } from "./types.js";

export interface ActionExecutionRepository
	extends ActiveGrantRepository,
		ActionCallRepository {
	reserveExecution(input: {
		actionCall: ActionCallRecord;
		dispatch: DispatchRecord;
		effect?: EffectRecord;
	}): Promise<void>;
	claimDispatch(
		id: string,
		leaseOwner: string,
		leaseExpiresAt: number,
	): Promise<boolean>;
	transitionDispatch(
		id: string,
		from: DispatchRecord["status"],
		to: DispatchRecord["status"],
	): Promise<boolean>;
	transitionEffect(
		id: string,
		from: EffectRecord["status"],
		to: EffectRecord["status"],
		result?: Record<string, unknown> | null,
	): Promise<boolean>;
	recordProviderOutcome(input: {
		actionCallId: string;
		dispatchId: string;
		effectId?: string;
		outcome: Extract<
			ProviderOutcome,
			{ kind: "succeeded" | "failed" | "unknown" }
		>;
	}): Promise<boolean>;
}

export type ProviderOutcome =
	| { kind: "succeeded"; result: Record<string, unknown> | null }
	| { kind: "failed"; result?: Record<string, unknown> | null }
	| { kind: "unknown"; reason?: string };

export interface ProviderActionExecutor {
	execute(input: {
		actionCall: ActionCallRecord;
		arguments: unknown;
		providerRequestKey: string;
	}): Promise<ProviderOutcome>;
}

export interface ExecuteActionCallInput {
	request: ActionCallRequest;
	principalRecoveryGeneration: number;
	requestId: string;
	traceId: string;
	effect: "read" | "write";
	provider: ProviderActionExecutor;
	audit: AuditEventStore;
	now?: () => number;
}

export type ActionExecutionResult =
	| { kind: "reused"; actionCall: ActionCallRecord }
	| {
			kind: "completed";
			actionCall: ActionCallRecord;
			outcome: ProviderOutcome;
	  };

function recordFor(
	request: ActionCallRequest,
	grant: GrantRecord,
	input: ExecuteActionCallInput,
): ActionCallRecord {
	return {
		id: randomUUID(),
		requestId: input.requestId,
		traceId: input.traceId,
		callId: randomUUID(),
		idempotencyKey: request.idempotencyKey,
		namespaceKey: actionCallNamespaceKey(request),
		principalId: request.principalId,
		consumerId: request.consumerId,
		consumerInstanceId: request.consumerInstanceId,
		actorId: request.actorId ?? consumerActorSentinel,
		grantId: grant.id,
		connectionId: request.connectionId,
		credentialVersionId: grant.credentialVersionId,
		actionVersionId: request.actionVersionId,
		requestDigest: actionRequestDigest(request),
		status: "created",
	};
}

function assertTransition(ok: boolean, label: string): void {
	if (!ok) throw new Error(`${label} transition lost its compare-and-set race`);
}

/**
 * Reserve and execute one provider action. The provider receives only a
 * credential version reference; decrypting credentials belongs to its
 * Connection-owned adapter.
 */
export async function executeActionCall(
	repository: ActionExecutionRepository,
	input: ExecuteActionCallInput,
): Promise<ActionExecutionResult> {
	const grant = await authorizeActionCall(
		repository,
		input.request,
		input.principalRecoveryGeneration,
	);
	const namespaceKey = actionCallNamespaceKey(input.request);
	const existing = await repository.findByIdempotency(
		namespaceKey,
		input.request.idempotencyKey,
	);
	if (existing) {
		const replay = decideActionCallReplay(existing, input.request);
		if (replay.kind === "reuse")
			return { kind: "reused", actionCall: replay.record };
		throw new Error("Connection authorization denied");
	}

	const actionCall = recordFor(input.request, grant, input);
	const providerRequestKey = randomBytes(24).toString("base64url");
	const dispatch: DispatchRecord = {
		id: randomUUID(),
		actionCallId: actionCall.id,
		status: "pending",
		attemptCount: 0,
		leaseOwner: null,
		leaseExpiresAt: null,
	};
	const effect =
		input.effect === "write"
			? {
					id: randomUUID(),
					actionCallId: actionCall.id,
					status: "planned" as const,
					providerRequestKey,
					result: null,
				}
			: undefined;
	try {
		await repository.reserveExecution({ actionCall, dispatch, effect });
	} catch (error) {
		// A concurrent insert may win the idempotency unique key. Re-read only
		// to distinguish that race; all other database failures remain errors.
		const raced = await repository.findByIdempotency(
			namespaceKey,
			input.request.idempotencyKey,
		);
		if (!raced) throw error;
		const replay = decideActionCallReplay(raced, input.request);
		if (replay.kind === "reuse")
			return { kind: "reused", actionCall: replay.record };
		throw new Error("Connection authorization denied");
	}
	await input.audit.insert({
		id: randomUUID(),
		traceId: input.traceId,
		principalId: actionCall.principalId,
		consumerInstanceId: actionCall.consumerInstanceId,
		actorId:
			actionCall.actorId === consumerActorSentinel
				? undefined
				: actionCall.actorId,
		action: "mcp.dispatch",
		targetType: "action_call",
		targetId: actionCall.id,
		outcome: "succeeded",
		metadata: {
			phase: "reserved",
			dispatchId: dispatch.id,
			effectId: effect?.id,
			providerRequestKey: effect ? providerRequestKey : undefined,
		},
	});

	// Re-check the grant after persistence and immediately before any provider
	// access. Revocation wins the compare-and-set race and no provider call runs.
	try {
		await authorizeActionCall(
			repository,
			input.request,
			input.principalRecoveryGeneration,
		);
	} catch {
		assertTransition(
			await repository.transitionDispatch(dispatch.id, "pending", "failed"),
			"Dispatch",
		);
		assertTransition(
			await repository.transition(actionCall.id, "created", "provider_failed"),
			"ActionCall",
		);
		throw new Error("Connection authorization denied");
	}

	const now = input.now ?? Date.now;
	assertTransition(
		await repository.claimDispatch(
			dispatch.id,
			actionCall.callId,
			now() + 60_000,
		),
		"Dispatch claim",
	);
	assertTransition(
		await repository.transition(actionCall.id, "created", "submission_started"),
		"ActionCall",
	);
	if (effect)
		assertTransition(
			await repository.transitionEffect(effect.id, "planned", "submitted"),
			"Effect",
		);

	let outcome: ProviderOutcome;
	try {
		outcome = await input.provider.execute({
			actionCall,
			arguments: input.request.arguments,
			providerRequestKey,
		});
	} catch {
		outcome = { kind: "unknown" };
	}

	assertTransition(
		await repository.recordProviderOutcome({
			actionCallId: actionCall.id,
			dispatchId: dispatch.id,
			effectId: effect?.id,
			outcome,
		}),
		"provider outcome",
	);
	await input.audit.insert({
		id: randomUUID(),
		traceId: input.traceId,
		principalId: actionCall.principalId,
		consumerInstanceId: actionCall.consumerInstanceId,
		actorId:
			actionCall.actorId === consumerActorSentinel
				? undefined
				: actionCall.actorId,
		action: "mcp.provider",
		targetType: "action_call",
		targetId: actionCall.id,
		outcome:
			outcome.kind === "succeeded"
				? "succeeded"
				: outcome.kind === "failed"
					? "failed"
					: "rejected",
		metadata: {
			phase: outcome.kind,
			dispatchId: dispatch.id,
			effectId: effect?.id,
			providerRequestKey: effect ? providerRequestKey : undefined,
			reason: outcome.kind === "unknown" ? outcome.reason : undefined,
		},
	});
	return { kind: "completed", actionCall, outcome };
}
