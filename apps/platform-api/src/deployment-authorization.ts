import { recordHttpFailureContext } from "@agent-infra/observability/http";
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
	/**
	 * 按版本读取授权事实：带默认 Relay Key 的 Agent 持久化为 V3，授权规则与 V2
	 * 完全相同，只是不再因为配置版本而把 Owner 判成无权（#2401）。
	 */
	readonly configurationQuery: Pick<
		PostgresAgentConfigurationQueryV1,
		"readVersionedAuthority"
	>;
	/** Deployment-owned current directory; Core validates all referenced subjects. */
	readonly loadAuthorityContext: () => Promise<AgentConfigurationAuthorityContextV1>;
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
			let authorityContext: AgentConfigurationAuthorityContextV1;
			try {
				authorityContext = await input.loadAuthorityContext();
			} catch (error) {
				// Core 会把这里的任何异常都变成 dependency_unavailable，先记下有界的失败步骤与
				// 错误类名（不含消息和目录内容），否则 503 的日志看不出是哪个依赖失败（#2696）。
				recordHttpFailureContext({ failureStep: "authority.load", error });
				throw error;
			}
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
					authorityContext,
				};
			}
			const current = await input.configurationQuery.readVersionedAuthority({
				agentId: request.agentId,
				actorId: identity.userId,
				organizationIds: identity.organizationIds,
				isAdministrator: identity.roles.includes("system_admin"),
				...(request.accessOnly === true &&
				identity.roles.includes("system_admin")
					? { allowAdministratorRescue: true }
					: {}),
			});
			if (current.outcome !== "found") return rejected;
			return {
				...rejected,
				status: "admitted",
				authorizationRevision: current.authorizationRevision,
				authorityContext,
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
