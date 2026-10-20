import {
	SkillHubOwnedVersionPageV1Schema,
	SkillHubOwnedVersionQueryV1Schema,
	SkillHubVersionDetailV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	type pageSkillHubOwnedVersionsV1,
	parseSkillHubIdV1,
	type projectSkillHubVersionDetailV1,
	type SkillHubRequestV1,
} from "@agent-infra/platform-core";
import type { Context, Hono } from "hono";
import { HttpProtocolError, requestMetadata } from "./common.js";
import { mapCoreError } from "./core-errors.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";
import type { SkillHubReadRoutesDependenciesV1 } from "./skill-hub-read-routes.js";

export interface SkillHubVersionDetailRoutesDependenciesV1 {
	readonly identity: IdentityAdapter;
	/** 主体与可见性由 Store 在事务内按当前身份解析，不信任调用方字段。 */
	readonly listOwned: (
		request: Request,
		trusted: SkillHubRequestV1,
		query: { cursor?: string; limit?: number },
	) => Promise<ReturnType<typeof pageSkillHubOwnedVersionsV1>>;
	readonly readDetail: (
		request: Request,
		trusted: SkillHubRequestV1,
		versionId: string,
	) => Promise<ReturnType<typeof projectSkillHubVersionDetailV1>>;
	readonly recordRefusal: SkillHubReadRoutesDependenciesV1["recordRefusal"];
}

export function registerSkillHubVersionDetailRoutesV1(
	app: Hono,
	dependencies: SkillHubVersionDetailRoutesDependenciesV1,
) {
	async function handle(context: Context, detail: boolean) {
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
						detail ||
						!["cursor", "limit"].includes(key) ||
						search.getAll(key).length !== 1,
				)
			)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			if (detail) {
				const versionId = parseSkillHubIdV1(
					context.req.param("skillVersionId"),
				);
				// 之后的拒绝（含不可见版本）由 Store 事务写入拒绝审计。
				submitted = true;
				const result = SkillHubVersionDetailV1Schema.safeParse(
					await dependencies.readDetail(request, trusted, versionId),
				);
				if (!result.success || result.data.skillVersionId !== versionId)
					throw new HttpProtocolError(
						"DEPENDENCY_UNAVAILABLE",
						metadata.traceId,
					);
				return context.json(result.data);
			}
			const query = SkillHubOwnedVersionQueryV1Schema.safeParse(
				Object.fromEntries(search),
			);
			if (!query.success)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			submitted = true;
			const result = SkillHubOwnedVersionPageV1Schema.safeParse(
				await dependencies.listOwned(request, trusted, query.data),
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
	app.get("/api/v2/skills/owned-versions", (context) => handle(context, false));
	app.get("/api/v2/skills/versions/:skillVersionId/detail", (context) =>
		handle(context, true),
	);
}
