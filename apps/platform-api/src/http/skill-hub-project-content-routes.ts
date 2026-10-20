import {
	SkillHubProjectContentSaveResponseV1Schema,
	SkillHubProjectContentUpdateV1Schema,
	SkillHubProjectContentV1Schema,
	SkillHubProjectPublicationRequestV1Schema,
	SkillHubPublicationResponseV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	parseSkillHubIdV1,
	type projectSkillHubProjectContentV1,
	type SkillHubRequestV1,
	type SkillPackagePublicationResultV1,
} from "@agent-infra/platform-core";
import type { Context, Hono } from "hono";
import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	requestMetadata,
} from "./common.js";
import { mapCoreError } from "./core-errors.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";
import type { SkillHubReadRoutesDependenciesV1 } from "./skill-hub-read-routes.js";

export interface SkillHubProjectContentRoutesDependenciesV1 {
	readonly identity: IdentityAdapter;
	/** 只有项目 Owner 能读写；主体由 Store 在事务内按当前身份解析。 */
	readonly read: (
		request: Request,
		trusted: SkillHubRequestV1,
		projectId: string,
	) => Promise<ReturnType<typeof projectSkillHubProjectContentV1>>;
	readonly save: (
		request: Request,
		trusted: SkillHubRequestV1,
		projectId: string,
		key: string,
		input: unknown,
	) => Promise<unknown>;
	/** 部署未装配 Skill 包供应时为空，网页发布返回不可用。 */
	readonly publish?: (
		request: Request,
		trusted: SkillHubRequestV1,
		projectId: string,
		key: string,
		input: unknown,
	) => Promise<SkillPackagePublicationResultV1>;
	readonly recordRefusal: SkillHubReadRoutesDependenciesV1["recordRefusal"];
}

function publicPublication(result: SkillPackagePublicationResultV1) {
	// 对象存储版本与发布者 ID 不进入浏览器响应；摘要随版本返回供回读核对。
	const {
		packageObjectVersion: _location,
		ownerId: _owner,
		...version
	} = result.version;
	const parsed = SkillHubPublicationResponseV1Schema.safeParse({
		replayed: result.replayed,
		version,
	});
	if (!parsed.success) throw new Error("Invalid Skill Hub publication");
	return parsed.data;
}

/** Skill 项目内容的读取与整体保存，以及网页发布（#2906）。 */
export function registerSkillHubProjectContentRoutesV1(
	app: Hono,
	dependencies: SkillHubProjectContentRoutesDependenciesV1,
) {
	async function handle(context: Context, action: "read" | "save" | "publish") {
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
			if (new URL(request.url).search !== "")
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			const projectId = parseSkillHubIdV1(context.req.param("projectId"));
			if (action === "read") {
				if (request.body !== null)
					throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
				submitted = true;
				const result = SkillHubProjectContentV1Schema.safeParse(
					await dependencies.read(request, trusted, projectId),
				);
				if (!result.success || result.data.projectId !== projectId)
					throw new HttpProtocolError(
						"DEPENDENCY_UNAVAILABLE",
						metadata.traceId,
					);
				return context.json(result.data);
			}
			const key = parseIdempotencyKey(request, metadata.traceId);
			if (action === "save") {
				const { value } = await parseJson(
					request,
					SkillHubProjectContentUpdateV1Schema,
					metadata.traceId,
				);
				submitted = true;
				const result = SkillHubProjectContentSaveResponseV1Schema.safeParse(
					await dependencies.save(request, trusted, projectId, key, value),
				);
				if (!result.success || result.data.projectId !== projectId)
					throw new HttpProtocolError(
						"DEPENDENCY_UNAVAILABLE",
						metadata.traceId,
					);
				return context.json(result.data, 200);
			}
			const { value } = await parseJson(
				request,
				SkillHubProjectPublicationRequestV1Schema,
				metadata.traceId,
			);
			if (!dependencies.publish)
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			submitted = true;
			const result = publicPublication(
				await dependencies.publish(request, trusted, projectId, key, value),
			);
			if (result.version.skillId !== projectId)
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			return context.json(result, result.replayed ? 200 : 201);
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
	app.get("/api/v2/skills/projects/:projectId/content", (context) =>
		handle(context, "read"),
	);
	app.put("/api/v2/skills/projects/:projectId/content", (context) =>
		handle(context, "save"),
	);
	app.post("/api/v2/skills/projects/:projectId/versions", (context) =>
		handle(context, "publish"),
	);
}
