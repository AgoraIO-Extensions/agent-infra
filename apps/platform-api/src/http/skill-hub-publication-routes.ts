import {
	SkillHubVersionLifecycleResponseV1Schema,
	SkillHubVersionPublicationRequestV1Schema,
	SkillHubVersionReviewRequestV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	parseSkillHubIdV1,
	type SkillHubRequestV1,
	type SkillHubVersionV1,
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

type LifecycleResult = Readonly<{
	replayed: boolean;
	version: SkillHubVersionV1;
}>;

export interface SkillHubPublicationRoutesDependenciesV1 {
	readonly identity: IdentityAdapter;
	readonly publish: (
		request: Request,
		trusted: SkillHubRequestV1,
		key: string,
		input: unknown,
	) => Promise<LifecycleResult>;
	readonly review: (
		request: Request,
		trusted: SkillHubRequestV1,
		versionId: string,
		key: string,
		input: unknown,
	) => Promise<LifecycleResult>;
	readonly revoke: (
		request: Request,
		trusted: SkillHubRequestV1,
		versionId: string,
		key: string,
	) => Promise<LifecycleResult>;
}

function publicLifecycle(result: unknown) {
	if (
		typeof result !== "object" ||
		result === null ||
		!Object.hasOwn(result, "replayed") ||
		!Object.hasOwn(result, "version")
	)
		throw new Error();
	const value = result as LifecycleResult;
	const version = value.version;
	const response = SkillHubVersionLifecycleResponseV1Schema.safeParse({
		replayed: value.replayed,
		version: {
			schemaVersion: version.schemaVersion,
			skillId: version.skillId,
			skillVersionId: version.skillVersionId,
			visibility: version.visibility,
			provider: version.provider,
			version: version.version,
			packageDigest: version.packageDigest,
			manifestDigest: version.manifestDigest,
			signatureDigest: version.signatureDigest,
			state: version.state,
			needUpgrade: version.needUpgrade,
			reviewedBy: version.reviewedBy,
			reviewReason: version.reviewReason,
			revokedAt: version.revokedAt,
		},
	});
	if (!response.success) throw new Error();
	return response.data;
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
		context.header("Cache-Control", "no-store");
		context.header("Referrer-Policy", "no-referrer");
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
			let result: LifecycleResult;
			if (action === "publish") {
				const { value } = await parseJson(
					request,
					SkillHubVersionPublicationRequestV1Schema,
					metadata.traceId,
				);
				result = await dependencies.publish(request, trusted, key, value);
			} else {
				const versionId = parseSkillHubIdV1(
					context.req.param("skillVersionId"),
				);
				if (action === "review") {
					const { value } = await parseJson(
						request,
						SkillHubVersionReviewRequestV1Schema,
						metadata.traceId,
					);
					result = await dependencies.review(
						request,
						trusted,
						versionId,
						key,
						value,
					);
				} else {
					if (
						Number(request.headers.get("Content-Length") ?? 0) > 0 ||
						request.headers.has("Transfer-Encoding")
					)
						throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
					result = await dependencies.revoke(request, trusted, versionId, key);
				}
			}
			const response = publicLifecycle(result);
			return context.json(response, result.replayed ? 200 : 201);
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
