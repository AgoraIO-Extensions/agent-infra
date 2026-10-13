import {
	SkillHubPublicationRequestV1Schema,
	SkillHubPublicationResponseV1Schema,
	SkillHubReviewRequestV1Schema,
} from "@agent-infra/contracts/pilot";
import type {
	SkillHubRequestV1,
	SkillHubVersionV1,
} from "@agent-infra/platform-core";
import { parseSkillHubIdV1 } from "@agent-infra/platform-core";
import type { Context, Hono } from "hono";
import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	requestMetadata,
} from "./common.js";
import { mapCoreError } from "./core-errors.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface SkillHubPublicationRoutesDependenciesV1 {
	readonly identity: IdentityAdapter;
	readonly publish: (
		request: Request,
		trusted: SkillHubRequestV1,
		key: string,
		input: unknown,
	) => Promise<{ replayed: boolean; version: SkillHubVersionV1 }>;
	readonly review: (
		request: Request,
		trusted: SkillHubRequestV1,
		versionId: string,
		key: string,
		input: unknown,
	) => Promise<{ replayed: boolean; version: SkillHubVersionV1 }>;
	readonly revoke: (
		request: Request,
		trusted: SkillHubRequestV1,
		versionId: string,
		key: string,
	) => Promise<{ replayed: boolean; version: SkillHubVersionV1 }>;
}

function publicResponse(result: {
	replayed: boolean;
	version: SkillHubVersionV1;
}) {
	const {
		packageObjectVersion: _location,
		ownerId: _owner,
		...version
	} = result.version;
	const parsed = SkillHubPublicationResponseV1Schema.safeParse({
		replayed: result.replayed,
		version,
	});
	if (!parsed.success) {
		throw new Error("Invalid Skill Hub publication projection");
	}
	return parsed.data;
}

export function registerSkillHubPublicationRoutesV1(
	app: Hono,
	dependencies: SkillHubPublicationRoutesDependenciesV1,
) {
	async function handle(
		context: Context,
		action: "publish" | "review" | "revoke",
	): Promise<Response> {
		const request = context.req.raw;
		const metadata = requestMetadata(request);
		try {
			if (request.headers.has("Authorization"))
				throw new HttpProtocolError(
					"AUTHENTICATION_REQUIRED",
					metadata.traceId,
				);
			if (new URL(request.url).search !== "")
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			const identity = await resolveIdentity(
				dependencies.identity,
				request,
				metadata.traceId,
			);
			const trusted = { ...metadata, userId: identity.userId };
			const key = parseIdempotencyKey(request, metadata.traceId);
			if (action === "publish") {
				const { value } = await parseJson(
					request,
					SkillHubPublicationRequestV1Schema,
					metadata.traceId,
				);
				const result = publicResponse(
					await dependencies.publish(request, trusted, key, value),
				);
				return context.json(result, result.replayed ? 200 : 201);
			}
			const versionId = parseSkillHubIdV1(context.req.param("skillVersionId"));
			if (action === "review") {
				const { value } = await parseJson(
					request,
					SkillHubReviewRequestV1Schema,
					metadata.traceId,
				);
				return context.json(
					publicResponse(
						await dependencies.review(request, trusted, versionId, key, value),
					),
				);
			}
			if (
				Number(request.headers.get("Content-Length") ?? 0) > 0 ||
				request.headers.has("Transfer-Encoding")
			)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			return context.json(
				publicResponse(
					await dependencies.revoke(request, trusted, versionId, key),
				),
			);
		} catch (error) {
			const protocol = mapCoreError(error, metadata.traceId);
			return context.json(protocol.body, protocol.status);
		}
	}
	app.post("/api/v2/skills/versions", (context) => handle(context, "publish"));
	app.post("/api/v2/skills/versions/:skillVersionId/review", (context) =>
		handle(context, "review"),
	);
	app.post("/api/v2/skills/versions/:skillVersionId/revoke", (context) =>
		handle(context, "revoke"),
	);
}
