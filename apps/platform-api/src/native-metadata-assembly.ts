import { timingSafeEqual } from "node:crypto";
import { createConversationNativeMetadataReadUseCaseV1 } from "@agent-infra/platform-core";
import type {
	PostgresAgentConfigurationQueryV1,
	PostgresAgentManagementQueryV1,
	PostgresConversationQueryV1,
} from "@agent-infra/platform-store";
import { HttpProtocolError } from "./http/common.js";
import {
	type IdentityAdapter,
	resolveCurrentTaskUser,
	resolveIdentity,
} from "./http/identity.js";
import { createNativeMetadataReadApiV1 } from "./http/native-metadata-current.js";
import { createPlatformNativeMetadataWorkerClientV1 } from "./native-metadata-client.js";

export interface PlatformNativeMetadataApiDeploymentV1 {
	readonly workerId: string;
	readonly apiRequestSourceRef: string;
	readonly maxActiveReads: number;
	readonly workerOrigin: string;
	readonly apiToWorkerToken: string;
	readonly workerToApiToken: string;
	readonly fetch?: typeof fetch;
}

/** One process-owned registry serves both the public GET and its exact Worker callbacks. */
export function assemblePlatformNativeMetadataApiV1(input: {
	readonly identity: IdentityAdapter;
	readonly query: PostgresConversationQueryV1;
	readonly managementQuery: PostgresAgentManagementQueryV1;
	readonly configurationQuery: PostgresAgentConfigurationQueryV1;
	readonly deployment: PlatformNativeMetadataApiDeploymentV1;
}) {
	const config = { ...input.deployment };
	if (
		![config.workerId, config.apiRequestSourceRef].every(
			(value) =>
				typeof value === "string" && /^[\x21-\x7e]{1,256}$/.test(value),
		) ||
		![config.apiToWorkerToken, config.workerToApiToken].every(
			(value) =>
				typeof value === "string" && /^[\x21-\x7e]{1,8192}$/.test(value),
		) ||
		config.apiToWorkerToken === config.workerToApiToken
	)
		throw new Error("Native metadata API deployment is invalid");
	const submit = createPlatformNativeMetadataWorkerClientV1({
		baseUrl: config.workerOrigin,
		serviceToken: config.apiToWorkerToken,
		apiRequestSourceRef: config.apiRequestSourceRef,
		fetch: config.fetch,
	}).submit;
	const reads = createNativeMetadataReadApiV1({
		identity: input.identity,
		query: input.query,
		owningWorkerId: config.workerId,
		apiRequestSourceRef: config.apiRequestSourceRef,
		maxActiveReads: config.maxActiveReads,
		submit,
		authorizationForRequest(originalRequest) {
			let agentQueryUser: Awaited<ReturnType<typeof currentUser>> | undefined;
			async function currentUser(traceId: string, signal: AbortSignal) {
				signal.throwIfAborted();
				originalRequest.signal.throwIfAborted();
				const identity = await resolveIdentity(
					input.identity,
					originalRequest,
					traceId,
				);
				signal.throwIfAborted();
				originalRequest.signal.throwIfAborted();
				const user = await resolveCurrentTaskUser(
					input.identity,
					identity.userId,
					traceId,
				);
				signal.throwIfAborted();
				originalRequest.signal.throwIfAborted();
				if (user === null)
					throw new HttpProtocolError("AUTHORIZATION_REVOKED", traceId);
				if (user.userId !== identity.userId) throw new Error();
				return user;
			}
			return createConversationNativeMetadataReadUseCaseV1({
				async currentIdentity(metadata, signal) {
					agentQueryUser = undefined;
					try {
						const user = await currentUser(metadata.traceId, signal);
						agentQueryUser = user;
						return {
							outcome: "authenticated",
							user,
							knownAuthenticationExpiresAt: null,
						};
					} catch (error) {
						return {
							outcome:
								error instanceof HttpProtocolError && error.status === 401
									? "unauthenticated"
									: error instanceof HttpProtocolError && error.status === 403
										? "denied"
										: "unavailable",
						};
					}
				},
				async readAgentState(agentId, signal) {
					// Each API revalidation creates this port; Core refreshes identity before each Agent query.
					signal.throwIfAborted();
					originalRequest.signal.throwIfAborted();
					const user = agentQueryUser;
					if (!user) throw new Error();
					const agent = await input.managementQuery.getAgent(
						{
							kind: "user",
							userId: user.userId,
							organizationIds: user.organizationIds,
						},
						agentId,
					);
					signal.throwIfAborted();
					originalRequest.signal.throwIfAborted();
					if (!agent) return null;
					const configuration = await input.configurationQuery.read({
						agentId,
						actorId: user.userId,
						organizationIds: user.organizationIds,
						isAdministrator: false,
						intent: "discover",
					});
					signal.throwIfAborted();
					originalRequest.signal.throwIfAborted();
					if (configuration.outcome !== "found") throw new Error();
					return {
						management: agent.management,
						interactionMode:
							configuration.configuration.source.kind === "standard"
								? "platform-adapter"
								: configuration.configuration.source.interactionMode,
					};
				},
			});
		},
	});
	return {
		reads,
		async authenticateWorker(request: Request) {
			if (request.signal.aborted) return null;
			const header = request.headers.get("authorization");
			if (!header?.startsWith("Bearer ")) return null;
			const supplied = Buffer.from(header.slice(7));
			const expected = Buffer.from(config.workerToApiToken);
			return supplied.length === expected.length &&
				timingSafeEqual(supplied, expected)
				? config.workerId
				: null;
		},
		close: reads.close,
	};
}
