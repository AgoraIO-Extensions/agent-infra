import type {
	AgentConfigurationAuthorityContextV1,
	AgentConfigurationAuthorizationAdmissionPortV1,
} from "@agent-infra/platform-core";
import type { PostgresAgentConfigurationQueryV1 } from "@agent-infra/platform-store";

import {
	allocateDeploymentApplicationIds,
	type createDeploymentIdentityScope,
} from "./deployment-identity.js";
import { parseIdempotencyKey } from "./http/common.js";

export function createDeploymentAuthorizationAdmission(input: {
	readonly identityScope: ReturnType<typeof createDeploymentIdentityScope>;
	readonly configurationQuery: Pick<
		PostgresAgentConfigurationQueryV1,
		"readAuthority"
	>;
	/** Deployment-owned current directory; Core validates all referenced subjects. */
	readonly loadAuthorityContext: () => Promise<AgentConfigurationAuthorityContextV1>;
	/** Platform-owned application IDs for initial availability admission. */
	readonly loadApplicationIds?: () => Promise<readonly string[]>;
}): AgentConfigurationAuthorizationAdmissionPortV1 {
	return {
		async authorize(request) {
			const rejected = {
				schemaVersion: 1 as const,
				status: "rejected" as const,
				agentId: request.agentId,
				actorId: request.actorId,
			};
			const identity = await input.identityScope.currentIdentity(
				request.traceId,
			);
			if (identity.userId !== request.actorId) return rejected;
			const currentRequest = input.identityScope.currentRequest();
			const authorityContext = await input.loadAuthorityContext();
			const currentAuthorityContext = input.loadApplicationIds
				? {
						...authorityContext,
						applicationIds: await input.loadApplicationIds(),
					}
				: authorityContext;
			if (
				currentRequest.method === "POST" &&
				new URL(currentRequest.url).pathname === "/api/v2/agent-applications"
			) {
				const ids = await allocateDeploymentApplicationIds({
					identity,
					idempotencyKey: parseIdempotencyKey(currentRequest, request.traceId),
				});
				if (ids.agentId !== request.agentId) return rejected;
				return {
					...rejected,
					status: "admitted",
					authorizationRevision: identity.authorizationRevision,
					authorityContext: currentAuthorityContext,
				};
			}
			const current = await input.configurationQuery.readAuthority({
				agentId: request.agentId,
				actorId: identity.userId,
				organizationIds: identity.organizationIds,
				isAdministrator: identity.roles.includes("system_admin"),
			});
			if (current.outcome !== "found") return rejected;
			return {
				...rejected,
				status: "admitted",
				authorizationRevision: current.authorizationRevision,
				authorityContext: currentAuthorityContext,
				accessAuthority: {
					state: current.management,
					actorContext: {
						schemaVersion: 1,
						userId: identity.userId,
						accountStatus: identity.accountStatus,
						organizationIds: identity.organizationIds,
						isAdministrator: identity.roles.includes("system_admin"),
					},
					authorityContext,
				},
			};
		},
	};
}
