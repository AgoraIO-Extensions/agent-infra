import {
	SkillHubReviewQueuePageV1Schema,
	SkillHubReviewQueueQueryV1Schema,
} from "@agent-infra/contracts/pilot";
import type {
	pageSkillHubReviewQueueV1,
	SkillHubRequestV1,
} from "@agent-infra/platform-core";
import type { Context, Hono } from "hono";
import { HttpProtocolError, requestMetadata } from "./common.js";
import { mapCoreError } from "./core-errors.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";
import type { SkillHubReadRoutesDependenciesV1 } from "./skill-hub-read-routes.js";

export interface SkillHubReviewRoutesDependenciesV1 {
	readonly identity: IdentityAdapter;
	/** 管理员身份由 Store 在事务内按当前目录事实核对，不信任调用方字段。 */
	readonly list: (
		request: Request,
		trusted: SkillHubRequestV1,
		query: { cursor?: string; limit?: number },
	) => Promise<ReturnType<typeof pageSkillHubReviewQueueV1>>;
	readonly recordRefusal: SkillHubReadRoutesDependenciesV1["recordRefusal"];
}

export function registerSkillHubReviewRoutesV1(
	app: Hono,
	dependencies: SkillHubReviewRoutesDependenciesV1,
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
			const query = SkillHubReviewQueueQueryV1Schema.safeParse(
				Object.fromEntries(search),
			);
			if (!query.success)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			// 之后的拒绝（含非管理员）由 Store 事务写入拒绝审计。
			submitted = true;
			const result = SkillHubReviewQueuePageV1Schema.safeParse(
				await dependencies.list(request, { ...metadata, userId }, query.data),
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
	app.get("/api/v2/skills/reviews", handle);
}
