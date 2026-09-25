import { randomUUID } from "node:crypto";
import {
	actionCallNamespaceKey,
	actionRequestDigest,
	actorNamespaceId,
	decideActionCallReplay,
	mcpRequestDigest,
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
	McpCallAttemptBinding,
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
	requiredScopes?: readonly string[];
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
	appendMcpAttemptForDirectClient(
		record: ActionCallRecord,
		binding: McpCallAttemptBinding,
		grant: GrantRecord,
		credential: DirectCredentialContext,
	): Promise<ActionCallRecord>;
}

export interface PublishedDirectActionRepository
	extends DirectActionCallRepository {
	findPublishedActionVersion(selector: {
		providerId: string;
		actionId: string;
		version: string;
	}): Promise<
		| {
				id: string;
				effect: string;
				inputSchema: Record<string, unknown>;
				requiredScopes: readonly string[];
		  }
		| undefined
	>;
}

export class InvalidDirectActionArguments extends Error {}

export async function reservePublishedDirectActionCall(
	repository: PublishedDirectActionRepository,
	input: Omit<
		Parameters<typeof reserveDirectActionCall>[1],
		"actionVersionId" | "effect" | "requiredScopes"
	> & {
		selector: { providerId: string; actionId: string; version: string };
		validateArguments: (
			schema: Record<string, unknown>,
			argumentsValue: unknown,
		) => boolean;
	},
): Promise<ActionCallRecord> {
	const version = await repository.findPublishedActionVersion(input.selector);
	if (!version) throw new ConnectionAuthorizationDenied();
	if (!input.validateArguments(version.inputSchema, input.arguments))
		throw new InvalidDirectActionArguments();
	return reserveDirectActionCall(repository, {
		...input,
		actionVersionId: version.id,
		effect: version.effect,
		requiredScopes: version.requiredScopes,
	});
}

export function reservePublishedDirectMcpActionCall(
	repository: PublishedDirectActionRepository,
	input: {
		caller: DirectAuthenticatedCaller;
		audience: string;
		selector: { providerId: string; actionId: string; version: string };
		arguments: unknown;
		meta: {
			operationNonce: string;
			attemptNonce: string;
			idempotencyKey: string;
		};
		validateArguments: (
			schema: Record<string, unknown>,
			argumentsValue: unknown,
		) => boolean;
	},
): Promise<ActionCallRecord> {
	if (input.meta.operationNonce !== input.meta.idempotencyKey)
		throw new InvalidDirectActionArguments();
	return reservePublishedDirectActionCall(repository, {
		caller: input.caller,
		audience: input.audience,
		selector: input.selector,
		arguments: input.arguments,
		requestId: input.meta.operationNonce,
		idempotencyKey: input.meta.idempotencyKey,
		traceId: input.meta.operationNonce,
		mcpBinding: {
			operationNonce: input.meta.operationNonce,
			attemptNonce: input.meta.attemptNonce,
			requestDigestVersion: "connection-request-v1",
			requestDigest: mcpRequestDigest({
				providerId: input.selector.providerId,
				actionId: input.selector.actionId,
				actionVersion: input.selector.version,
				input: input.arguments,
			}),
		},
		validateArguments: input.validateArguments,
	});
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
	requiredScopes?: readonly string[],
): DirectCredentialContext {
	return {
		credentialId: caller.credentialId,
		principalId: caller.principalId,
		consumerId: caller.consumerId,
		consumerInstanceId: caller.consumerInstanceId,
		actorId: caller.actorId,
		audience,
		requiredScopes,
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
		requiredScopes: readonly string[];
		arguments: unknown;
		mcpBinding?: McpCallAttemptBinding;
	},
): Promise<ActionCallRecord> {
	const { caller } = input;
	const requiredScope =
		input.effect === "read"
			? "action:read"
			: input.effect === "write"
				? "action:write"
				: null;
	if (
		!requiredScope ||
		![requiredScope, ...input.requiredScopes].every((scope) =>
			caller.scopes.includes(scope),
		)
	)
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
	const credential = credentialContext(caller, input.audience, [
		requiredScope,
		...input.requiredScopes,
	]);
	const replay = async (existing: ActionCallRecord) => {
		if (
			existing.requestId !== request.requestId ||
			existing.traceId !== input.traceId ||
			Boolean(existing.mcpBinding) !== Boolean(input.mcpBinding) ||
			(input.mcpBinding &&
				(existing.mcpBinding?.operationNonce !==
					input.mcpBinding.operationNonce ||
					existing.mcpBinding.requestDigestVersion !==
						input.mcpBinding.requestDigestVersion ||
					existing.mcpBinding.requestDigest !==
						input.mcpBinding.requestDigest)) ||
			decideActionCallReplay(existing, {
				...request,
				grantId: grant.id,
				connectionId: grant.connectionId,
			}).kind !== "reuse"
		)
			throw new DirectActionConflict();
		return input.mcpBinding
			? repository.appendMcpAttemptForDirectClient(
					existing,
					input.mcpBinding,
					grant,
					credential,
				)
			: existing;
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
		...(input.mcpBinding
			? {
					mcpBinding: {
						operationNonce: input.mcpBinding.operationNonce,
						requestDigestVersion: input.mcpBinding.requestDigestVersion,
						requestDigest: input.mcpBinding.requestDigest,
						attemptNonces: [input.mcpBinding.attemptNonce],
					},
				}
			: {}),
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
	requiredScope?: string,
): Promise<ActionCallRecord | undefined> {
	return repository.findByCallIdForDirectClient(
		actionCallNamespaceKey(caller),
		callId,
		credentialContext(
			caller,
			audience,
			requiredScope ? [requiredScope] : undefined,
		),
	);
}
