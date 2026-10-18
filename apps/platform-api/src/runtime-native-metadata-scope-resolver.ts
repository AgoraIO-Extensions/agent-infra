import { randomUUID } from "node:crypto";
import type { RuntimeNativeMetadataBindingResponseV1 } from "@agent-infra/contracts/runtime";
import { RuntimeNativeMetadataProofMaximumLifetimeMsV1 } from "@agent-infra/contracts/runtime";
import type {
	NativeMetadataObjectScopeResponseV1,
	PostgresConversationQueryV1,
} from "@agent-infra/platform-store";
import type { IdentityContext } from "./http/identity.js";
import type { CurrentAuthorization } from "./runtime-native-metadata-current.js";
import type { RuntimeNativeMetadataRequestContextV1 } from "./runtime-native-metadata-request-context.js";

type Selector = "status" | "commands" | "skills";

function requestId() {
	return randomUUID();
}

/**
 * Resolves the persisted original Execution scope before native metadata is
 * signed. Store owns the historical generation/revision and original Host
 * scope reference.
 */
export function createRuntimeNativeMetadataScopeResolverV1(options: {
	readonly query: Pick<
		PostgresConversationQueryV1,
		"readNativeMetadataObjectScopeV1"
	>;
	readonly now?: () => number;
	readonly lifetimeMs?: number;
	readonly authorize: (
		identity: IdentityContext,
		request: {
			readonly schemaVersion: 1;
			readonly operation: "conversation.read";
			readonly conversationId: string;
		},
	) => Promise<CurrentAuthorization>;
}) {
	if (
		typeof options.query?.readNativeMetadataObjectScopeV1 !== "function" ||
		typeof options.authorize !== "function"
	)
		throw new TypeError("Runtime native metadata scope options are invalid");
	const lifetimeMs =
		options.lifetimeMs ?? RuntimeNativeMetadataProofMaximumLifetimeMsV1;
	if (
		!Number.isSafeInteger(lifetimeMs) ||
		lifetimeMs < 1 ||
		lifetimeMs > RuntimeNativeMetadataProofMaximumLifetimeMsV1
	)
		throw new TypeError("Runtime native metadata scope lifetime is invalid");
	return async (input: {
		readonly identity: IdentityContext;
		readonly conversationId: string;
		readonly executionId: string;
		readonly selector: Selector;
		readonly signal: AbortSignal;
		readonly requestContext?: RuntimeNativeMetadataRequestContextV1;
	}): Promise<RuntimeNativeMetadataBindingResponseV1 | null> => {
		try {
			const now = options.now ?? Date.now;
			const readStartedAt = input.requestContext?.readStartedAt ?? now();
			const expiresAt = Math.min(
				input.requestContext?.expiresAt ?? Number.MAX_SAFE_INTEGER,
				readStartedAt + lifetimeMs,
			);
			if (
				input.identity.accountStatus !== "active" ||
				input.signal.aborted ||
				expiresAt <= now()
			)
				return null;
			const decision = await options.authorize(input.identity, {
				schemaVersion: 1,
				operation: "conversation.read",
				conversationId: input.conversationId,
			});
			if (
				decision.outcome !== "allowed" ||
				input.signal.aborted ||
				expiresAt <= now()
			)
				return null;
			const scope: NativeMetadataObjectScopeResponseV1 | undefined =
				await options.query.readNativeMetadataObjectScopeV1({
					scope: {
						actorId: input.identity.userId,
						channelId: "web",
						principal: { kind: "user", id: input.identity.userId },
					},
					conversationId: input.conversationId,
					executionId: input.executionId,
					signal: input.signal,
				});
			if (
				scope?.channelId !== "web" ||
				input.signal.aborted ||
				expiresAt <= now()
			)
				return null;
			if (
				decision.authority.actorId !== input.identity.userId ||
				decision.authority.agentId !== scope.agentId ||
				decision.authority.channelId !== scope.channelId
			)
				return null;
			input.requestContext?.confirmPolicy(
				decision.authority,
				input.conversationId,
			);
			const originalHostScopeRef = scope.originalHostScopeRef;
			if (!originalHostScopeRef) return null;
			const { originalHostScopeRef: _originalHostScopeRef, ...publicScope } =
				scope;
			if (!Number.isSafeInteger(readStartedAt) || readStartedAt < 1)
				return null;
			return {
				schemaVersion: 1,
				readId: requestId(),
				selector: input.selector,
				scope: publicScope,
				readStartedAt,
				expiresAt,
				requestId: requestId(),
				traceId: requestId(),
				originalHostScopeRef,
			};
		} catch {
			return null;
		}
	};
}
