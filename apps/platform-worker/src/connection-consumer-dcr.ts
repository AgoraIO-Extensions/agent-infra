import { registerStandardOAuthClient } from "@agent-infra/agent-runtime";
import {
	type ConnectionConsumerProfileV1,
	connectionConsumerProfileFingerprintV1,
} from "@agent-infra/contracts/connection-consumer-profile";

const agentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ConnectionConsumerDcrResolverOptionsV1 {
	readonly agentIds: readonly string[] | (() => readonly string[]);
	readonly issuer: string;
	readonly registrationEndpoint: string;
	readonly publicOrigin: string;
	readonly mcpPath: string;
	readonly audience: string;
	readonly egressProfile: { readonly ref: string; readonly revision: string };
	readonly approvalSource: { readonly ref: string; readonly revision: string };
	readonly callbackUrlForAgent: (agentId: string) => string;
	/** Deployment-approved Connection Consumer mapping; DCR client IDs are separate. */
	readonly consumerIdForAgent: (agentId: string) => string;
	/** Deployment-approved DCR client mapping; registration must match it exactly. */
	readonly approvedOAuthClientIdForAgent: (agentId: string) => string;
	readonly installationSupplyForAgent: (agentId: string) => unknown;
	readonly fetch?: typeof fetch;
}

export function createConnectionConsumerDcrResolverV1(
	options: ConnectionConsumerDcrResolverOptionsV1,
) {
	return async (signal: AbortSignal) => {
		const ids =
			typeof options.agentIds === "function"
				? options.agentIds()
				: options.agentIds;
		if (new Set(ids).size !== ids.length)
			throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
		const result: Record<
			string,
			{
				readonly profile: ConnectionConsumerProfileV1;
				readonly oauthClientId: string;
				readonly approval: {
					readonly schemaVersion: 1;
					readonly configFingerprint: string;
					readonly egressEnforced: true;
					readonly source: { readonly ref: string; readonly revision: string };
				};
				readonly installationSupply: unknown;
			}
		> = {};
		for (const agentId of ids) {
			signal.throwIfAborted();
			if (!agentIdPattern.test(agentId))
				throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
			const consumerId = options.consumerIdForAgent(agentId);
			if (!agentIdPattern.test(consumerId))
				throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
			const callbackUrl = options.callbackUrlForAgent(agentId);
			const clientId = await registerStandardOAuthClient({
				issuer: options.issuer,
				registrationEndpoint: options.registrationEndpoint,
				redirectUri: callbackUrl,
				scope: "mcp",
				signal,
				assertCurrent: () => signal.throwIfAborted(),
				...(options.fetch ? { fetch: options.fetch } : {}),
			});
			if (clientId !== options.approvedOAuthClientIdForAgent(agentId))
				throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
			const profile = {
				schemaVersion: 1 as const,
				publicOrigin: options.publicOrigin,
				mcpPath: options.mcpPath,
				consumerId,
				audience: options.audience,
				egressProfile: { ...options.egressProfile },
			};
			result[agentId] = {
				profile,
				oauthClientId: clientId,
				approval: {
					schemaVersion: 1,
					configFingerprint: connectionConsumerProfileFingerprintV1(profile),
					egressEnforced: true,
					source: { ...options.approvalSource },
				},
				installationSupply: options.installationSupplyForAgent(agentId),
			};
		}
		return result;
	};
}
