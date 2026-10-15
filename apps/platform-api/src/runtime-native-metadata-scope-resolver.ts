import { randomUUID } from "node:crypto";
import type { RuntimeNativeMetadataBindingResponseV1 } from "@agent-infra/contracts/runtime";
import { RuntimeNativeMetadataProofMaximumLifetimeMsV1 } from "@agent-infra/contracts/runtime";
import type {
	NativeMetadataObjectScopeResponseV1,
	PostgresConversationQueryV1,
} from "@agent-infra/platform-store";
import type { IdentityContext } from "./http/identity.js";

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
}) {
	if (typeof options.query?.readNativeMetadataObjectScopeV1 !== "function")
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
	}): Promise<RuntimeNativeMetadataBindingResponseV1 | null> => {
		try {
			if (input.identity.accountStatus !== "active") return null;
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
			if (scope?.channelId !== "web") return null;
			const originalHostScopeRef = scope.originalHostScopeRef;
			if (!originalHostScopeRef) return null;
			const { originalHostScopeRef: _originalHostScopeRef, ...publicScope } =
				scope;
			const readStartedAt = (options.now ?? Date.now)();
			if (!Number.isSafeInteger(readStartedAt) || readStartedAt < 1)
				return null;
			return {
				schemaVersion: 1,
				readId: requestId(),
				selector: input.selector,
				scope: publicScope,
				readStartedAt,
				expiresAt: readStartedAt + lifetimeMs,
				requestId: requestId(),
				traceId: requestId(),
				originalHostScopeRef,
			};
		} catch {
			return null;
		}
	};
}
