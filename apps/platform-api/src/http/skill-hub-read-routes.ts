import {
	SkillHubDirectoryPageV1Schema,
	SkillHubDirectoryQueryV1Schema,
	SkillHubVersionMetadataV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	type pageSkillHubVersionsV1,
	parseSkillHubIdV1,
	type projectSkillHubVersionMetadataV1,
	type SkillHubRequestV1,
} from "@agent-infra/platform-core";
import type { Context, Hono } from "hono";
import {
	HttpProtocolError,
	type RequestMetadata,
	requestMetadata,
} from "./common.js";
import { mapCoreError } from "./core-errors.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface SkillHubReadRoutesDependenciesV1 {
	readonly identity: IdentityAdapter;
	readonly list: (
		request: Request,
		trusted: SkillHubRequestV1,
		query: { cursor?: string; limit?: number },
	) => Promise<ReturnType<typeof pageSkillHubVersionsV1>>;
	readonly read: (
		request: Request,
		trusted: SkillHubRequestV1,
		versionId: string,
	) => Promise<ReturnType<typeof projectSkillHubVersionMetadataV1>>;
	readonly recordRefusal: (
		metadata: RequestMetadata,
		userId: string | null,
		reason:
			| "authentication_required"
			| "forbidden"
			| "invalid_input"
			| "unavailable",
	) => Promise<void>;
}

export function registerSkillHubReadRoutesV1(
	app: Hono,
	dependencies: SkillHubReadRoutesDependenciesV1,
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
				submitted = true;
				const result = SkillHubVersionMetadataV1Schema.safeParse(
					await dependencies.read(request, trusted, versionId),
				);
				if (!result.success)
					throw new HttpProtocolError(
						"DEPENDENCY_UNAVAILABLE",
						metadata.traceId,
					);
				return context.json(result.data);
			}
			const query = SkillHubDirectoryQueryV1Schema.safeParse(
				Object.fromEntries(search),
			);
			if (!query.success)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			submitted = true;
			const result = SkillHubDirectoryPageV1Schema.safeParse(
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
	app.get("/api/v2/skills", (context) => handle(context, false));
	app.get("/api/v2/skills/versions/:skillVersionId", (context) =>
		handle(context, true),
	);
}
