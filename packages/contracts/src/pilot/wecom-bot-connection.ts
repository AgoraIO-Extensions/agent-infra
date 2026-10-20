import { z } from "zod";
import { OpaqueIdV1Schema } from "../index.ts";
import {
	PilotInternalErrorV1Schema,
	PilotProtocolErrorV1Schema,
} from "./errors.ts";

// 企微机器人状态投影 V2（#2911、O-08）：Owner 读取连接状态时一并拿到扫码是否可用，
// 首次点击「扫码授权」前即可门控，不必先建立再取消配置会话。
// 已发布的 GET /api/v1/agents/{agentId}/wecom-bot 是 strict schema，保持不变。

/** 与 V1 状态响应相同的连接状态取值。 */
const WecomBotConnectionStatusV2Schema = z.enum([
	"not_configured",
	"callback",
	"verifying",
	"connected",
	"disconnected",
	"auth_failed",
]);

/** 扫码不可用的原因；取值与 beginWecomSetup 响应的 qrUnavailableReason 相同。 */
export const WecomBotQrUnavailableReasonV1Schema = z.enum([
	"authorization_correlation_unverified",
]);

/**
 * 扫码能力只在当前 Owner 通过服务端权限校验后返回；判定与 beginWecomSetup 使用同一份部署配置。
 * 可用时不附授权地址或 state，二者仍只由建立配置会话的响应给出。
 */
export const WecomBotConnectionProjectionV2Schema = z.discriminatedUnion(
	"qrAvailable",
	[
		z.strictObject({
			status: WecomBotConnectionStatusV2Schema,
			qrAvailable: z.literal(false),
			qrUnavailableReason: WecomBotQrUnavailableReasonV1Schema,
		}),
		z.strictObject({
			status: WecomBotConnectionStatusV2Schema,
			qrAvailable: z.literal(true),
		}),
	],
);

export type WecomBotConnectionProjectionV2 = z.infer<
	typeof WecomBotConnectionProjectionV2Schema
>;

const response = (description: string, schema: z.ZodType) => ({
	description,
	content: { "application/json": { schema } },
});

export const wecomBotConnectionOpenApiPathsV2 = {
	"/api/v2/agents/{agentId}/wecom-bot": {
		get: {
			operationId: "getWecomBotConnectionV2",
			summary: "Read the Owner's bot connection status with QR availability",
			description:
				"Owner only, resolved by the server for the current account; a non-Owner, another Agent and a missing Agent are indistinguishable. QR availability uses the same deployment decision as beginWecomSetup and carries no authorization URL or state. The V1 status response is unchanged.",
			requestParams: {
				path: z.strictObject({ agentId: OpaqueIdV1Schema }),
			},
			responses: {
				"200": response(
					"Owner bot connection status with QR availability",
					WecomBotConnectionProjectionV2Schema,
				),
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

export const wecomBotConnectionSchemasV2 = {
	WecomBotConnectionProjectionV2: WecomBotConnectionProjectionV2Schema,
};
