import { OpaqueIdV1Schema } from "@agent-infra/contracts";
import {
	AgentUserUseRevokeRequestV1Schema,
	AgentUserUseRevokeResponseV1Schema,
} from "@agent-infra/contracts/pilot";
import type {
	AgentUserUseRevokeCommandV1,
	AgentUserUseRevokeResultV1,
} from "@agent-infra/platform-core";
import type { Context, Hono } from "hono";
import {
	type ApiManagementRefusalRecorderV1,
	apiManagementFailure,
} from "./agent-api-management-support.js";
import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	requestMetadata,
} from "./common.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface AgentUserUseGrantRouteDependencies {
	readonly identity: IdentityAdapter;
	readonly revoke: (
		input: AgentUserUseRevokeCommandV1,
	) => Promise<AgentUserUseRevokeResultV1>;
	readonly recordRefusal: ApiManagementRefusalRecorderV1;
}

export function registerAgentUserUseGrantRoutes(
	app: Hono,
	dependencies: AgentUserUseGrantRouteDependencies,
) {
	app.delete(
		"/api/v2/agents/:agentId/api-use-grants/:userId",
		async (context: Context) => {
			const request = context.req.raw;
			const metadata = requestMetadata(request);
			context.header("Cache-Control", "no-store");
			try {
				if (request.headers.has("Authorization"))
					throw new HttpProtocolError(
						"AUTHENTICATION_REQUIRED",
						metadata.traceId,
					);
				if (new URL(request.url).search)
					throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
				const identity = await resolveIdentity(
					dependencies.identity,
					request,
					metadata.traceId,
				);
				const agentId = OpaqueIdV1Schema.safeParse(
					context.req.param("agentId"),
				);
				const userId = OpaqueIdV1Schema.safeParse(context.req.param("userId"));
				if (!agentId.success || !userId.success)
					throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
				const { value: body } = await parseJson(
					request,
					AgentUserUseRevokeRequestV1Schema,
					metadata.traceId,
				);
				const result = await dependencies.revoke({
					schemaVersion: 1,
					...metadata,
					agentId: agentId.data,
					userId: userId.data,
					expectedRevision: body.expectedRevision,
					actorId: identity.userId,
					idempotencyKey: parseIdempotencyKey(request, metadata.traceId),
				});
				return context.json(AgentUserUseRevokeResponseV1Schema.parse(result));
			} catch (error) {
				return apiManagementFailure(
					context,
					error,
					metadata,
					"use",
					dependencies.recordRefusal,
				);
			}
		},
	);
}
