import { OpaqueIdV1Schema } from "@agent-infra/contracts";
import {
	AgentUserManageGrantRequestV1Schema,
	AgentUserManageGrantResponseV1Schema,
	AgentUserManageRevokeRequestV1Schema,
	AgentUserManageRevokeResponseV1Schema,
} from "@agent-infra/contracts/pilot";
import type {
	AgentUserManageGrantCommandV1,
	AgentUserManageGrantResultV1,
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

export interface AgentUserManageGrantRouteDependencies {
	readonly identity: IdentityAdapter;
	readonly grant: (
		input: AgentUserManageGrantCommandV1,
	) => Promise<AgentUserManageGrantResultV1>;
	readonly revoke: (
		input: AgentUserManageGrantCommandV1,
	) => Promise<AgentUserManageGrantResultV1>;
	readonly recordRefusal: ApiManagementRefusalRecorderV1;
}

/**
 * 当前 Owner 经浏览器会话给用户授予 / 撤销 Agent 的 API 管理权（#2759），与 `api-use-grants`
 * 对称：只接受浏览器身份，拒绝 Bearer 凭证与查询串；授权类型由路径决定。
 */
export function registerAgentUserManageGrantRoutes(
	app: Hono,
	dependencies: AgentUserManageGrantRouteDependencies,
) {
	const handle = async (context: Context, granted: boolean) => {
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
			const agentId = OpaqueIdV1Schema.safeParse(context.req.param("agentId"));
			const userId = OpaqueIdV1Schema.safeParse(context.req.param("userId"));
			if (!agentId.success || !userId.success)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			const { value: body } = await parseJson(
				request,
				granted
					? AgentUserManageGrantRequestV1Schema
					: AgentUserManageRevokeRequestV1Schema,
				metadata.traceId,
			);
			const command: AgentUserManageGrantCommandV1 = {
				schemaVersion: 1,
				...metadata,
				agentId: agentId.data,
				userId: userId.data,
				expectedRevision: body.expectedRevision,
				actorId: identity.userId,
				idempotencyKey: parseIdempotencyKey(request, metadata.traceId),
			};
			const result = granted
				? AgentUserManageGrantResponseV1Schema.parse(
						await dependencies.grant(command),
					)
				: AgentUserManageRevokeResponseV1Schema.parse(
						await dependencies.revoke(command),
					);
			return context.json(result);
		} catch (error) {
			return apiManagementFailure(
				context,
				error,
				metadata,
				"manager",
				dependencies.recordRefusal,
			);
		}
	};
	const path = "/api/v2/agents/:agentId/api-manage-grants/:userId";
	app.put(path, (context) => handle(context, true));
	app.delete(path, (context) => handle(context, false));
}
