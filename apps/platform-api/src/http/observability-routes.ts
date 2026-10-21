import {
	type ObservabilityStatusProjectionV1,
	ObservabilityStatusProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import type { Hono } from "hono";
import { HttpProtocolError, requestMetadata } from "./common.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

type ObservabilityStatusReader = {
	readonly status: () => Omit<
		ObservabilityStatusProjectionV1,
		"schemaVersion" | "service"
	>;
};

export interface ObservabilityRoutesDependencies {
	readonly identity: IdentityAdapter;
	readonly observability?: ObservabilityStatusReader;
}

/**
 * 运维观测查询（契约 getObservabilityStatus，#3058）。身份只由服务端按当前会话解析：
 * 未登录 401，停用账号 403，非系统管理员 403，观测未装配或无法报告状态 503。
 * 数据来源、权限与投影内容不变；错误只使用契约声明的状态码，不落到未声明的 500。
 */
export function registerObservabilityRoutes(
	app: Hono,
	dependencies: ObservabilityRoutesDependencies,
): void {
	app.get("/api/v1/ops/observability", async (context) => {
		const metadata = requestMetadata(context.req.raw);
		const identity = await resolveIdentity(
			dependencies.identity,
			context.req.raw,
			metadata.traceId,
		);
		if (!identity.roles.includes("system_admin"))
			throw new HttpProtocolError("FORBIDDEN", metadata.traceId);
		if (!dependencies.observability)
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
		let status: unknown;
		try {
			status = dependencies.observability.status();
		} catch {
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
		}
		// 状态不符合 strict 投影时按观测不可用处理，不把未知字段或异常细节带给浏览器。
		const projection = ObservabilityStatusProjectionV1Schema.safeParse({
			schemaVersion: 1,
			service: "platform-api",
			...(typeof status === "object" && status !== null ? status : {}),
		});
		if (!projection.success)
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
		return context.json(projection.data);
	});
}
