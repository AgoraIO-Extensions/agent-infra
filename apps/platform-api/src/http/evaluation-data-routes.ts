import {
	EvaluationDatasetContentV1Schema,
	EvaluationDatasetCreateV1Schema,
	EvaluationDatasetPageV1Schema,
	EvaluationDatasetV1Schema,
	EvaluationGrantCreateV1Schema,
	EvaluationGrantV1Schema,
	EvaluationRevisionCommandV1Schema,
	EvaluationVersionReserveV1Schema,
	EvaluationVersionV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	type createEvaluationDataV1,
	EvaluationDataErrorV1,
} from "@agent-infra/platform-core";
import type { Hono } from "hono";
import { z } from "zod";
import { requireApiManagementMaterial } from "./agent-api-management-support.js";
import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	requestMetadata,
} from "./common.js";
import { mapCoreError } from "./core-errors.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface EvaluationDataRoutesV1 {
	identity: IdentityAdapter;
	service: ReturnType<typeof createEvaluationDataV1>;
}
export function registerEvaluationDataRoutesV1(
	app: Hono,
	input?: EvaluationDataRoutesV1,
) {
	app.all("/api/v2/evaluation/*", async (context) => {
		const request = context.req.raw;
		const metadata = requestMetadata(request);
		context.header("Cache-Control", "no-store");
		try {
			if (!input)
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			const url = new URL(request.url);
			if (
				url.search ||
				(request.method === "GET" &&
					(request.body !== null ||
						request.headers.has("content-length") ||
						request.headers.has("transfer-encoding"))) ||
				[
					"x-user-id",
					"x-application-id",
					"x-principal",
					"x-principal-id",
					"x-role",
					"x-scope",
					"x-identity-context",
				].some((h) => request.headers.has(h))
			)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			const authentication = request.headers.has("Authorization")
				? {
						kind: "credential" as const,
						material: requireApiManagementMaterial(request, metadata.traceId),
					}
				: {
						kind: "browser" as const,
						userId: (
							await resolveIdentity(input.identity, request, metadata.traceId)
						).userId,
					};
			const trusted = { authentication, ...metadata };
			const segments = url.pathname
				.slice("/api/v2/evaluation/".length)
				.split("/");
			if (segments[0] !== "datasets")
				throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
			const key = () => parseIdempotencyKey(request, metadata.traceId);
			const body = async <T>(schema: z.ZodType<T>) =>
				(await parseJson(request, schema, metadata.traceId)).value;
			if (segments.length === 1) {
				if (request.method === "GET")
					return context.json(
						EvaluationDatasetPageV1Schema.parse(
							await input.service.list(trusted),
						),
					);
				if (request.method === "POST")
					return context.json(
						EvaluationDatasetV1Schema.parse(
							await input.service.create(
								trusted,
								key(),
								await body(EvaluationDatasetCreateV1Schema),
							),
						),
						201,
					);
			}
			const datasetId = z.uuid().parse(segments[1]);
			if (segments[2] === "versions") {
				if (segments.length === 3 && request.method === "POST")
					return context.json(
						EvaluationVersionV1Schema.parse(
							await input.service.reserve(
								trusted,
								key(),
								datasetId,
								await body(EvaluationVersionReserveV1Schema),
							),
						),
						201,
					);
				const versionId = z.uuid().parse(segments[3]);
				if (segments.length === 5 && segments[4] === "content") {
					if (request.method === "PUT") {
						const value = await body(EvaluationDatasetContentV1Schema);
						return context.json(
							EvaluationVersionV1Schema.parse(
								await input.service.upload(
									trusted,
									key(),
									datasetId,
									versionId,
									new TextEncoder().encode(JSON.stringify(value)),
								),
							),
						);
					}
					if (request.method === "GET")
						return context.json(
							EvaluationDatasetContentV1Schema.parse(
								await input.service.read(trusted, datasetId, versionId),
							),
						);
					if (request.method === "DELETE")
						return context.json(
							EvaluationVersionV1Schema.parse(
								await input.service.remove(
									trusted,
									key(),
									datasetId,
									versionId,
									(await body(EvaluationRevisionCommandV1Schema))
										.expectedRevision,
								),
							),
						);
				}
				if (
					segments.length === 5 &&
					segments[4] === "confirm" &&
					request.method === "POST"
				) {
					if (await request.text())
						throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
					return context.json(
						EvaluationVersionV1Schema.parse(
							await input.service.confirm(trusted, datasetId, versionId),
						),
					);
				}
			}
			if (segments[2] === "grants") {
				if (segments.length === 3 && request.method === "POST")
					return context.json(
						EvaluationGrantV1Schema.parse(
							await input.service.grant(
								trusted,
								key(),
								datasetId,
								await body(EvaluationGrantCreateV1Schema),
							),
						),
						201,
					);
				if (segments.length === 4 && request.method === "DELETE")
					return context.json(
						EvaluationGrantV1Schema.parse(
							await input.service.revoke(
								trusted,
								key(),
								datasetId,
								z.uuid().parse(segments[3]),
								(await body(EvaluationRevisionCommandV1Schema))
									.expectedRevision,
							),
						),
					);
			}
			throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
		} catch (error) {
			const protocol = mapCoreError(
				error instanceof EvaluationDataErrorV1
					? new HttpProtocolError(
							(
								{
									invalid: "INVALID_REQUEST",
									denied: "RESOURCE_UNAVAILABLE",
									conflict: "CONFLICT",
									unavailable: "DEPENDENCY_UNAVAILABLE",
								} as const
							)[error.code],
							metadata.traceId,
						)
					: error instanceof z.ZodError
						? new HttpProtocolError("INVALID_REQUEST", metadata.traceId)
						: error,
				metadata.traceId,
			);
			return context.json(protocol.body, protocol.status);
		}
	});
}
