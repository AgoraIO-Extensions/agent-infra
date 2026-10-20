import { z } from "zod";
import { OpaqueIdV1Schema, SchemaVersionV1Schema } from "../index.ts";
import {
	AgentConfigurationProjectionV2Schema,
	AgentProjectionV2Schema,
} from "./browser.ts";
import {
	PilotInternalErrorV1Schema,
	PilotProtocolErrorV1Schema,
} from "./errors.ts";

// Agent 详情投影（#2910）：Owner 附带服务端当次解析的有效状态。
// 已发布的 AgentProjectionV2、Agent 列表与命令响应保持不变。

/**
 * active：LDAP、Platform 禁用记录与适用的目录快照均确认有效；
 * disabled：LDAP 停用或 Platform 管理员禁用；departed：LDAP 中已查不到该账号；
 * unavailable：任一依赖无法确认，不推断为其他状态。
 */
export const AgentOwnerStatusV1Schema = z.enum([
	"active",
	"disabled",
	"departed",
	"unavailable",
]);

export const AgentOwnerProjectionV1Schema = z.strictObject({
	userId: OpaqueIdV1Schema,
	/** 当前账号的显示名；账号已不存在或无法读取时为 null，不回退到 ID。 */
	displayName: z.string().min(1).nullable(),
	status: AgentOwnerStatusV1Schema,
});

export const AgentDetailConfigurationProjectionV1Schema =
	AgentConfigurationProjectionV2Schema.extend({
		owners: z.array(AgentOwnerProjectionV1Schema).min(1),
	});

export const AgentDetailProjectionV1Schema = AgentProjectionV2Schema.extend({
	schemaVersion: SchemaVersionV1Schema,
	configuration: AgentDetailConfigurationProjectionV1Schema,
});

export type AgentOwnerProjectionV1 = z.infer<
	typeof AgentOwnerProjectionV1Schema
>;
export type AgentDetailProjectionV1 = z.infer<
	typeof AgentDetailProjectionV1Schema
>;

const response = (description: string, schema: z.ZodType) => ({
	description,
	content: { "application/json": { schema } },
});

export const agentDetailOpenApiPathsV1 = {
	"/api/v2/agents/{agentId}/detail": {
		get: {
			operationId: "getAgentDetailV1",
			summary: "Read one visible Agent with each Owner's current status",
			description:
				"Browser session only; no Authorization header or query. Visibility matches getAgentV2 and an invisible Agent is indistinguishable from a missing one. Owner status is resolved from the current LDAP account, Platform disable record and directory snapshot. Responses are no-store.",
			security: [{ PlatformSession: [] }],
			requestParams: {
				path: z.strictObject({ agentId: OpaqueIdV1Schema }),
			},
			responses: {
				"200": response(
					"Agent detail with Owner status",
					AgentDetailProjectionV1Schema,
				),
				"400": response("Invalid request", PilotProtocolErrorV1Schema),
				"401": response("Authentication required", PilotProtocolErrorV1Schema),
				"403": response(
					"Authorization is no longer valid",
					PilotProtocolErrorV1Schema,
				),
				"404": response("Resource is unavailable", PilotProtocolErrorV1Schema),
				"503": response(
					"Dependency is temporarily unavailable",
					PilotProtocolErrorV1Schema,
				),
				"500": response("Internal error", PilotInternalErrorV1Schema),
			},
		},
	},
} as const;

export const agentDetailSchemasV1 = {
	AgentOwnerProjectionV1: AgentOwnerProjectionV1Schema,
	AgentDetailConfigurationProjectionV1:
		AgentDetailConfigurationProjectionV1Schema,
	AgentDetailProjectionV1: AgentDetailProjectionV1Schema,
};
