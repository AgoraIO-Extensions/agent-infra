import {
	SkillHubInstallationPageV1Schema,
	SkillHubInstallationQueryV1Schema,
} from "@agent-infra/contracts/pilot";
import type {
	pageSkillHubInstallationsV1,
	SkillHubRequestV1,
} from "@agent-infra/platform-core";
import type { Context, Hono } from "hono";
import { HttpProtocolError, requestMetadata } from "./common.js";
import { mapCoreError } from "./core-errors.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";
import type { SkillHubReadRoutesDependenciesV1 } from "./skill-hub-read-routes.js";

export interface SkillHubInstallationListRoutesDependenciesV1 {
	readonly identity: IdentityAdapter;
	/** 主体只取会话用户，由 Store 在事务内按当前身份过滤，不接受调用方提交的主体。 */
	readonly list: (
		request: Request,
		trusted: SkillHubRequestV1,
		query: { cursor?: string; limit?: number },
	) => Promise<ReturnType<typeof pageSkillHubInstallationsV1>>;
	readonly recordRefusal: SkillHubReadRoutesDependenciesV1["recordRefusal"];
}

/** 「我的安装」只读入口（#2953）；安装与移除命令仍由 skill-hub-installation-routes 注册。 */
export function registerSkillHubInstallationListRoutesV1(
	app: Hono,
	dependencies: SkillHubInstallationListRoutesDependenciesV1,
) {
	async function handle(context: Context) {
		const request = context.req.raw;
		const metadata = requestMetadata(request);
		let userId: string | null = null;
		let submitted = false;
		context.header("Cache-Control", "no-store");
		context.header("Referrer-Policy", "no-referrer");
		try {
			if (request.headers.has("Authorization"))
				throw new HttpProtocolError(
					"AUTHENTICATION_REQUIRED",
					metadata.traceId,
				);
			const identity = await resolveIdentity(
				dependencies.identity,
				request,
				metadata.traceId,
			);
			userId = identity.userId;
			const trusted = { ...metadata, userId };
			const search = new URL(request.url).searchParams;
			if (
				request.body !== null ||
				[...search.keys()].some(
					(key) =>
						!["cursor", "limit"].includes(key) ||
						search.getAll(key).length !== 1,
				)
			)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			const query = SkillHubInstallationQueryV1Schema.safeParse(
				Object.fromEntries(search),
			);
			if (!query.success)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			// 之后的拒绝由 Store 事务写入拒绝审计。
			submitted = true;
			const result = SkillHubInstallationPageV1Schema.safeParse(
				await dependencies.list(request, trusted, query.data),
			);
			if (!result.success)
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			return context.json(result.data);
		} catch (error) {
			let protocol = mapCoreError(error, metadata.traceId);
			if (!submitted) {
				try {
					await dependencies.recordRefusal(
						metadata,
						userId,
						protocol.status === 401
							? "authentication_required"
							: protocol.status === 403
								? "forbidden"
								: protocol.status >= 500
									? "unavailable"
									: "invalid_input",
					);
				} catch {
					protocol = new HttpProtocolError(
						"DEPENDENCY_UNAVAILABLE",
						metadata.traceId,
					);
				}
			}
			return context.json(protocol.body, protocol.status);
		}
	}
	app.get("/api/v2/skills/installations", (context) => handle(context));
}
