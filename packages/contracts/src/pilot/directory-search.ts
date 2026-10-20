import { z } from "zod";
import { OpaqueIdV1Schema } from "../index.ts";
import { PilotProtocolErrorV1Schema } from "./errors.ts";

// 浏览器目录搜索（#3035）：申请表单、Owner 配置与 Agent 管理等页面的人员/组织选择器和名称回显。
// 把既有的 GET /api/v2/directory/search 纳入契约；响应形状、目录来源与可见范围保持不变。

/** 目录记录类型：请求与每条记录使用同一组取值。 */
export const DirectorySearchKindV1Schema = z.enum(["user", "organization"]);

/** 单次按 canonical ID 反查的上限，与 limit 上限相同；浏览器按此分批读取。 */
export const directorySearchMaxIdsV1 = 50;

/**
 * 查询参数。ids 为逗号分隔的 canonical ID，空段忽略，最多 50 段；
 * 未声明或重复的参数由服务端拒绝，身份与组织只由服务端按当前会话解析。
 */
export const DirectorySearchQueryV1Schema = z.strictObject({
	kind: DirectorySearchKindV1Schema,
	q: z.string().trim().max(120).default(""),
	limit: z.coerce.number().int().min(1).max(50).default(20),
	ids: z
		.string()
		.regex(/^[^,]*(?:,[^,]*){0,49}$/u)
		.optional(),
});

/** 一条当前目录记录；用户附邮箱，组织附路径，用户也可附所属组织路径。 */
export const DirectorySearchItemV1Schema = z.strictObject({
	kind: DirectorySearchKindV1Schema,
	canonicalId: OpaqueIdV1Schema,
	displayName: z.string(),
	email: z.string().optional(),
	organizationPath: z.string().optional(),
});

/** 搜索结果；query 与 kind 回显服务端实际使用的查询（q 已去除首尾空白）。 */
export const DirectorySearchResponseV1Schema = z.strictObject({
	items: z.array(DirectorySearchItemV1Schema),
	query: z.string().max(120),
	kind: DirectorySearchKindV1Schema,
});

export type DirectorySearchKindV1 = z.infer<typeof DirectorySearchKindV1Schema>;
export type DirectorySearchQueryV1 = z.infer<
	typeof DirectorySearchQueryV1Schema
>;
export type DirectorySearchItemV1 = z.infer<typeof DirectorySearchItemV1Schema>;
export type DirectorySearchResponseV1 = z.infer<
	typeof DirectorySearchResponseV1Schema
>;

const response = (description: string, schema: z.ZodType) => ({
	description,
	content: { "application/json": { schema } },
});

export const directorySearchOpenApiPathsV1 = {
	"/api/v2/directory/search": {
		get: {
			operationId: "searchDirectoryV2",
			summary: "Search current user or organization directory records",
			description:
				"Active browser session only; the server resolves the current account and refuses disabled accounts. Returns current directory records of the requested kind for pickers and name display; records never grant access. ids looks up at most 50 comma-separated canonical IDs. Undeclared or repeated query parameters are rejected. Directory dependency failures return 503.",
			security: [{ PlatformSession: [] }],
			requestParams: { query: DirectorySearchQueryV1Schema },
			responses: {
				"200": response(
					"Current directory records",
					DirectorySearchResponseV1Schema,
				),
				"400": response("Invalid request", PilotProtocolErrorV1Schema),
				"401": response("Authentication required", PilotProtocolErrorV1Schema),
				"403": response(
					"Authorization is no longer valid",
					PilotProtocolErrorV1Schema,
				),
				"503": response(
					"Directory is temporarily unavailable",
					PilotProtocolErrorV1Schema,
				),
			},
		},
	},
} as const;

export const directorySearchSchemasV1 = {
	DirectorySearchItemV1: DirectorySearchItemV1Schema,
	DirectorySearchResponseV1: DirectorySearchResponseV1Schema,
};
