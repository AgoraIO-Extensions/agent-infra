import {
	EvaluationExperimentCreateV1Schema,
	EvaluationExperimentPageV1Schema,
	EvaluationExperimentV1Schema,
	EvaluationReviewPageV1Schema,
	EvaluationReviewV1Schema,
	EvaluationScoreMetadataV1Schema,
	EvaluationScoreSubmitV1Schema,
	EvaluationScoringContextV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	type createEvaluationExperimentsV1,
	createEvaluationHumanScoringV1,
	EvaluationDataErrorV1,
	type EvaluationRequestV1,
} from "@agent-infra/platform-core";
import type { PostgresEvaluationScoringV1 } from "@agent-infra/platform-store";
import type { Context, Hono } from "hono";
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
export function registerEvaluationExperimentRoutesV1(
	app: Hono,
	input?: {
		identity: IdentityAdapter;
		experiments: ReturnType<typeof createEvaluationExperimentsV1>;
		scoring: PostgresEvaluationScoringV1;
	},
) {
	app.all("/api/v2/evaluation/experiments/*", route);
	app.all("/api/v2/evaluation/scores/*", route);
	app.post("/api/v2/evaluation/experiments", route);
	async function route(context: Context) {
		const request = context.req.raw;
		const metadata = requestMetadata(request);
		context.header("Cache-Control", "no-store");
		try {
			if (!input)
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			const url = new URL(request.url);
			if (
				request.method === "GET" &&
				(request.body !== null ||
					request.headers.has("content-length") ||
					request.headers.has("transfer-encoding"))
			)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			for (const name of new Set(url.searchParams.keys()))
				if (url.searchParams.getAll(name).length !== 1)
					throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			if (
				(url.search &&
					!(
						request.method === "GET" &&
						(url.pathname.startsWith("/api/v2/evaluation/experiments/") ||
							/^\/api\/v2\/evaluation\/scores\/[^/]+\/reviews$/.test(
								url.pathname,
							))
					)) ||
				[
					"x-principal",
					"x-user-id",
					"x-application-id",
					"x-principal-id",
					"x-role",
					"x-scope",
					"x-identity-context",
				].some((h) => request.headers.has(h))
			)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			const trusted: EvaluationRequestV1 = {
				...metadata,
				authentication: request.headers.has("Authorization")
					? {
							kind: "credential",
							material: requireApiManagementMaterial(request, metadata.traceId),
						}
					: {
							kind: "browser",
							userId: (
								await resolveIdentity(input.identity, request, metadata.traceId)
							).userId,
						},
			};
			const path = url.pathname.split("/");
			if (
				path.length === 5 &&
				path[4] === "experiments" &&
				request.method === "POST"
			)
				return context.json(
					EvaluationExperimentV1Schema.parse(
						await input.experiments.create(
							trusted,
							parseIdempotencyKey(request, metadata.traceId),
							(
								await parseJson(
									request,
									EvaluationExperimentCreateV1Schema,
									metadata.traceId,
								)
							).value,
						),
					),
					201,
				);
			if (path[4] === "experiments" && path[5]) {
				const id = z.uuid().parse(path[5]);
				if (request.method === "GET" && path.length === 6) {
					for (const key of url.searchParams.keys())
						if (!["limit", "cursor"].includes(key))
							throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
					return context.json(
						EvaluationExperimentPageV1Schema.parse(
							await input.experiments.get(
								trusted,
								id,
								url.searchParams.has("limit")
									? z.coerce
											.number()
											.int()
											.min(1)
											.max(100)
											.parse(url.searchParams.get("limit"))
									: 50,
								url.searchParams.has("cursor")
									? z.uuid().parse(url.searchParams.get("cursor"))
									: undefined,
							),
						),
					);
				}
				if (
					request.method === "POST" &&
					path[6] === "cancel" &&
					path.length === 7
				) {
					await parseJson(request, z.strictObject({}), metadata.traceId);
					return context.json(
						EvaluationExperimentV1Schema.parse(
							await input.experiments.cancel(
								trusted,
								id,
								parseIdempotencyKey(request, metadata.traceId),
							),
						),
					);
				}
			}
			if (path[4] === "scores") {
				const id = z.uuid().parse(path[5]);
				const humans = createEvaluationHumanScoringV1(input.scoring);
				if (request.method === "GET" && path.length === 6) {
					const { intent } = await input.scoring.load(trusted, id, "score");
					return context.json(
						EvaluationScoreMetadataV1Schema.parse({
							scoreId: intent.id,
							source: intent.scorer.implementation.kind,
							scoringModel:
								intent.scorer.implementation.kind === "model"
									? intent.scorer.implementation.modelId
									: null,
							sampleTaskId: intent.sampleTaskId,
							experimentId: intent.experimentId,
							executionId: intent.executionId,
							scorerId: intent.scorer.scorerId,
							scorerVersion: intent.scorer.version,
							status: intent.status,
							revision: intent.revision,
							value: intent.value,
							passed: intent.passed,
							failureCode: intent.failureCode,
							scoreActor: intent.scoreActor,
						}),
					);
				}
				if (
					request.method === "GET" &&
					path.length === 7 &&
					["content", "review-context"].includes(path[6] ?? "")
				)
					return context.json(
						EvaluationScoringContextV1Schema.parse(
							await input.scoring.content(
								trusted,
								id,
								path[6] === "review-context" ? "review" : "score",
							),
						),
					);
				if (
					request.method === "GET" &&
					path.length === 7 &&
					path[6] === "reviews"
				) {
					for (const key of url.searchParams.keys())
						if (!["limit", "cursor"].includes(key))
							throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
					const limit = url.searchParams.has("limit")
						? z.coerce
								.number()
								.int()
								.min(1)
								.max(100)
								.parse(url.searchParams.get("limit"))
						: 20;
					const cursor = url.searchParams.has("cursor")
						? z.uuid().parse(url.searchParams.get("cursor"))
						: undefined;
					return context.json(
						EvaluationReviewPageV1Schema.parse(
							await input.scoring.reviews(trusted, id, limit, cursor),
						),
					);
				}
				if (
					request.method === "POST" &&
					path.length === 7 &&
					["reviews", "human"].includes(path[6] ?? "")
				) {
					const body = (
						await parseJson(
							request,
							EvaluationScoreSubmitV1Schema,
							metadata.traceId,
						)
					).value;
					const key = parseIdempotencyKey(request, metadata.traceId);
					if (path[6] === "reviews" && path.length === 7)
						return context.json(
							EvaluationReviewV1Schema.parse(
								await humans.review(
									trusted,
									key,
									id,
									body.expectedRevision,
									body.result,
								),
							),
							201,
						);
					if (path[6] === "human" && path.length === 7) {
						const intent = await humans.submit(
							trusted,
							key,
							id,
							body.expectedRevision,
							body.result,
						);
						return context.json(
							EvaluationScoreMetadataV1Schema.parse({
								scoreId: intent.id,
								source: intent.scorer.implementation.kind,
								scoringModel:
									intent.scorer.implementation.kind === "model"
										? intent.scorer.implementation.modelId
										: null,
								sampleTaskId: intent.sampleTaskId,
								experimentId: intent.experimentId,
								executionId: intent.executionId,
								scorerId: intent.scorer.scorerId,
								scorerVersion: intent.scorer.version,
								status: intent.status,
								revision: intent.revision,
								value: intent.value,
								passed: intent.passed,
								failureCode: intent.failureCode,
								scoreActor: intent.scoreActor,
							}),
						);
					}
				}
			}
			throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
		} catch (error) {
			const failure =
				error instanceof EvaluationDataErrorV1
					? new HttpProtocolError(
							error.code === "invalid"
								? "INVALID_REQUEST"
								: error.code === "denied"
									? "RESOURCE_UNAVAILABLE"
									: error.code === "conflict"
										? "CONFLICT"
										: "DEPENDENCY_UNAVAILABLE",
							metadata.traceId,
						)
					: error instanceof z.ZodError
						? new HttpProtocolError("INVALID_REQUEST", metadata.traceId)
						: error;
			const protocol = mapCoreError(failure, metadata.traceId);
			return context.json(protocol.body, protocol.status);
		}
	}
}
