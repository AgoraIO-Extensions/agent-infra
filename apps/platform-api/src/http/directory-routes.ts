import {
	type DirectorySearchItemV1,
	type DirectorySearchKindV1,
	DirectorySearchQueryV1Schema,
	DirectorySearchResponseV1Schema,
} from "@agent-infra/contracts/pilot";
import { recordHttpFailureContext } from "@agent-infra/observability/http";
import type { Hono } from "hono";
import { HttpProtocolError, requestMetadata } from "./common.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

/** 部署目录返回的一条记录；路由只把契约声明的字段写入响应。 */
export type DirectorySearchItem = DirectorySearchItemV1;

export type DirectoryRouteDependencies = {
	readonly identity: IdentityAdapter;
	readonly search: (input: {
		readonly kind: DirectorySearchKindV1;
		readonly query: string;
		readonly ids: readonly string[];
		readonly limit: number;
	}) => Promise<readonly DirectorySearchItem[]>;
};

const declaredQueryKeys = new Set(["kind", "q", "limit", "ids"]);

/** 只取契约字段，部署目录多给的字段（如电话）不进入响应；类型错误由响应 Schema 拒绝。 */
function projectItem(item: unknown): unknown {
	if (!item || typeof item !== "object") return item;
	const { kind, canonicalId, displayName, email, organizationPath } =
		item as Record<string, unknown>;
	return {
		kind,
		canonicalId,
		displayName,
		...(email === undefined ? {} : { email }),
		...(organizationPath === undefined ? {} : { organizationPath }),
	};
}

/**
 * 浏览器目录搜索（#3035）：按契约校验请求与响应。身份只由服务端按当前会话解析，
 * 目录来源与可见范围仍由部署提供的 search 决定；任何依赖异常都返回契约内的 503。
 */
export function registerDirectoryRoutes(
	app: Hono,
	dependencies: DirectoryRouteDependencies,
) {
	app.get("/api/v2/directory/search", async (context) => {
		const request = context.req.raw;
		const { traceId } = requestMetadata(request);
		try {
			await resolveIdentity(dependencies.identity, request, traceId);
			const search = new URL(request.url).searchParams;
			if (
				[...search.keys()].some(
					(key) => !declaredQueryKeys.has(key) || search.getAll(key).length > 1,
				)
			)
				throw new HttpProtocolError("INVALID_REQUEST", traceId);
			const query = DirectorySearchQueryV1Schema.safeParse(
				Object.fromEntries(search),
			);
			if (!query.success)
				throw new HttpProtocolError("INVALID_REQUEST", traceId);
			let items: unknown;
			try {
				items = await dependencies.search({
					kind: query.data.kind,
					query: query.data.q,
					ids: (query.data.ids ?? "")
						.split(",")
						.map((id) => id.trim())
						.filter(Boolean),
					limit: query.data.limit,
				});
			} catch (error) {
				recordHttpFailureContext({ failureStep: "directory.search", error });
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
			}
			const body = DirectorySearchResponseV1Schema.safeParse({
				items: Array.isArray(items) ? items.map(projectItem) : items,
				query: query.data.q,
				kind: query.data.kind,
			});
			if (!body.success) {
				recordHttpFailureContext({ failureStep: "directory.search" });
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
			}
			return context.json(body.data);
		} catch (error) {
			// 本路由不声明 500：身份与目录依赖的异常已在上面映射，其余异常同样按依赖不可用返回。
			const protocol =
				error instanceof HttpProtocolError
					? error
					: new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
			return context.json(protocol.body, protocol.status);
		}
	});
}
