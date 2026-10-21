import { z } from "zod";
import { OpaqueIdV1Schema, SchemaVersionV1Schema } from "../index.ts";
import {
	PilotInternalErrorV1Schema,
	PilotProtocolErrorV1Schema,
} from "./errors.ts";

// 创建失败类别投影（#3034）：只给当前 Owner 与系统管理员读取。已发布的 Agent、
// 申请与命令响应保持不变；类别不携带原因码、尝试次数或 Kubernetes 细节。

/**
 * configuration_rejected：来源或配置与当前部署不兼容，调整前重试不会成功；
 * health_check_failed：Agent 已启动但没有通过健康检查；
 * deployment_unavailable：部署资源暂不可用或没有及时就绪，可以稍后重试。
 */
export const AgentCreationFailureCategoryV1Schema = z.enum([
	"configuration_rejected",
	"health_check_failed",
	"deployment_unavailable",
]);

export const AgentCreationFailureProjectionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	agentId: OpaqueIdV1Schema,
	category: AgentCreationFailureCategoryV1Schema,
});

export type AgentCreationFailureCategoryV1 = z.infer<
	typeof AgentCreationFailureCategoryV1Schema
>;
export type AgentCreationFailureProjectionV1 = z.infer<
	typeof AgentCreationFailureProjectionV1Schema
>;

const response = (description: string, schema: z.ZodType) => ({
	description,
	content: { "application/json": { schema } },
});

export const agentCreationFailureOpenApiPathsV1 = {
	"/api/v2/agents/{agentId}/creation-failure": {
		get: {
			operationId: "getAgentCreationFailureV1",
			summary: "Read the bounded creation failure category of one Agent",
			description:
				"Browser session only; no Authorization header or query. Only a current Owner or a system administrator can read it, and only while the Agent is creation_failed; any other caller, state or a missing Agent is RESOURCE_UNAVAILABLE. The category never carries reason codes, attempts or Kubernetes details. Responses are no-store.",
			security: [{ PlatformSession: [] }],
			requestParams: {
				path: z.strictObject({ agentId: OpaqueIdV1Schema }),
			},
			responses: {
				"200": response(
					"Creation failure category",
					AgentCreationFailureProjectionV1Schema,
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

export const agentCreationFailureSchemasV1 = {
	AgentCreationFailureCategoryV1: AgentCreationFailureCategoryV1Schema,
	AgentCreationFailureProjectionV1: AgentCreationFailureProjectionV1Schema,
};
