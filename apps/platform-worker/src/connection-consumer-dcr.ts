import { registerStandardOAuthClient } from "@agent-infra/agent-runtime";
import {
	type ConnectionConsumerProfileV1,
	connectionConsumerProfileFingerprintV1,
} from "@agent-infra/contracts/connection-consumer-profile";

const agentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ConnectionConsumerOAuthClientBindingV1 {
	readonly clientId: string;
	readonly callbackUrl: string;
	readonly profileFingerprint: string;
	readonly source: { readonly ref: string; readonly revision: string };
}

type ConnectionConsumerOAuthClientBindingProjectionV1 = Omit<
	ConnectionConsumerOAuthClientBindingV1,
	"callbackUrl"
>;

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
	/** Optional deployment-approved DCR client mapping; returned IDs must match it. */
	readonly approvedOAuthClientIdForAgent?: (agentId: string) => string;
	/** Load a previously persisted nonsecret client binding for this Agent. */
	readonly loadOAuthClientBindingForAgent?: (
		agentId: string,
		signal: AbortSignal,
	) => Promise<ConnectionConsumerOAuthClientBindingV1 | undefined>;
	/** Persist a newly registered nonsecret client binding before returning it. */
	readonly persistOAuthClientBindingForAgent?: (
		agentId: string,
		binding: ConnectionConsumerOAuthClientBindingV1,
		signal: AbortSignal,
	) => Promise<void>;
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
		const hasLoader = options.loadOAuthClientBindingForAgent !== undefined;
		const hasPersister =
			options.persistOAuthClientBindingForAgent !== undefined;
		if (hasLoader !== hasPersister)
			throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
		if (!options.approvedOAuthClientIdForAgent && !hasLoader)
			throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
		const result: Record<
			string,
			{
				readonly profile: ConnectionConsumerProfileV1;
				readonly oauthClientBinding: ConnectionConsumerOAuthClientBindingProjectionV1;
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
			const profile = {
				schemaVersion: 1 as const,
				publicOrigin: options.publicOrigin,
				mcpPath: options.mcpPath,
				consumerId,
				audience: options.audience,
				egressProfile: { ...options.egressProfile },
			};
			const profileFingerprint =
				connectionConsumerProfileFingerprintV1(profile);
			const expectedClientId = options.approvedOAuthClientIdForAgent?.(agentId);
			if (
				expectedClientId !== undefined &&
				!agentIdPattern.test(expectedClientId)
			)
				throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
			let binding = await options.loadOAuthClientBindingForAgent?.(
				agentId,
				signal,
			);
			if (binding !== undefined) {
				if (
					typeof binding.clientId !== "string" ||
					binding.clientId.length === 0 ||
					binding.callbackUrl !== callbackUrl ||
					binding.profileFingerprint !== profileFingerprint ||
					!binding.source ||
					typeof binding.source !== "object" ||
					Array.isArray(binding.source) ||
					binding.source.ref !== options.approvalSource.ref ||
					binding.source.revision !== options.approvalSource.revision ||
					(expectedClientId !== undefined &&
						binding.clientId !== expectedClientId)
				)
					throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
			} else {
				const clientId = await registerStandardOAuthClient({
					issuer: options.issuer,
					registrationEndpoint: options.registrationEndpoint,
					redirectUri: callbackUrl,
					scope: "mcp",
					signal,
					assertCurrent: () => signal.throwIfAborted(),
					...(options.fetch ? { fetch: options.fetch } : {}),
				});
				if (expectedClientId !== undefined && clientId !== expectedClientId)
					throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
				binding = {
					clientId,
					callbackUrl,
					profileFingerprint,
					source: { ...options.approvalSource },
				};
				await options.persistOAuthClientBindingForAgent?.(
					agentId,
					binding,
					signal,
				);
			}
			if (!binding) throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
			result[agentId] = {
				profile,
				oauthClientBinding: {
					clientId: binding.clientId,
					profileFingerprint: binding.profileFingerprint,
					source: { ...binding.source },
				},
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
