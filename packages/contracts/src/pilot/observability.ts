import { z } from "zod";
import { PilotProtocolErrorV1Schema } from "./errors.ts";

const count = z.number().int().safe().nonnegative();

/** Redacted, bounded observability process status for the administrator Ops view. */
export const ObservabilityStatusProjectionV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	service: z.literal("platform-api"),
	enabled: z.boolean(),
	state: z.enum(["active", "closing", "closed"]),
	captureFailures: count,
	exportFailures: count,
	droppedLogs: count,
	invalidRecords: count,
	lastExportFailureAt: z.string().datetime({ offset: true }).optional(),
});

export type ObservabilityStatusProjectionV1 = z.infer<
	typeof ObservabilityStatusProjectionV1Schema
>;

// 运维观测查询（#3058）：把既有的 GET /api/v1/ops/observability 纳入浏览器 V1 契约；
// 路径、系统管理员权限、数据来源与投影内容保持不变。

const response = (description: string, schema: z.ZodType) => ({
	description,
	content: { "application/json": { schema } },
});

export const observabilityOpenApiPathsV1 = {
	"/api/v1/ops/observability": {
		get: {
			operationId: "getObservabilityStatus",
			summary: "Read the Platform API observability collection status",
			description:
				"System administrators only, resolved by the server from the current browser session; caller-supplied identity fields are ignored. Returns only the redacted capture and export health of Platform API observability. A signed-out session returns 401; a non-administrator or disabled account returns 403. Observability that is not assembled or cannot report its status returns 503. A deployment that does not provide this query answers 404 without a protocol body.",
			security: [{ PlatformSession: [] }],
			responses: {
				"200": response(
					"Observability collection status",
					ObservabilityStatusProjectionV1Schema,
				),
				"401": response("Authentication required", PilotProtocolErrorV1Schema),
				"403": response(
					"Not a system administrator, or authorization is no longer valid",
					PilotProtocolErrorV1Schema,
				),
				"404": {
					description: "This deployment does not provide the query",
				},
				"503": response(
					"Observability is not assembled or temporarily unavailable",
					PilotProtocolErrorV1Schema,
				),
			},
		},
	},
} as const;

export const observabilitySchemasV1 = {
	ObservabilityStatusProjectionV1: ObservabilityStatusProjectionV1Schema,
};
