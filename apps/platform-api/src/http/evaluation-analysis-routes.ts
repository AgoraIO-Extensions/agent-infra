import {
	EvaluationAnalysisDetailV1Schema,
	EvaluationAnalysisSummaryV1Schema,
	EvaluationChoiceCatalogV1Schema,
	EvaluationHistoryV1Schema,
	EvaluationQueryTooLargeV1Schema,
	EvaluationWorklistV1Schema,
	TaskFeedbackContextV1Schema,
	TaskFeedbackRecordV1Schema,
	TaskFeedbackSubmitV1Schema,
	TaskFeedbackSummaryQueryV1Schema,
	TaskFeedbackSummaryV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	createTaskFeedbackV1,
	EvaluationDataErrorV1,
	EvaluationQueryLimitErrorV1,
	type EvaluationRequestV1,
	PersonalApiCredentialErrorV1,
} from "@agent-infra/platform-core";
import type {
	PostgresEvaluationAnalysisV1,
	PostgresEvaluationFeedbackV1,
	PostgresEvaluationScoringV1,
} from "@agent-infra/platform-store";
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
export interface EvaluationAnalysisRoutesV1 {
	identity: IdentityAdapter;
	analysis: PostgresEvaluationAnalysisV1;
	feedback: PostgresEvaluationFeedbackV1;
	scoring: PostgresEvaluationScoringV1;
}
export function registerEvaluationAnalysisRoutesV1(
	app: Hono,
	input?: EvaluationAnalysisRoutesV1,
) {
	app.get("/api/v2/evaluation/history", route);
	app.get("/api/v2/evaluation/choices", route);
	app.get("/api/v2/evaluation/worklist", route);
	app.get("/api/v2/evaluation/analysis/:experimentId", route);
	app.get(
		"/api/v2/evaluation/analysis/:experimentId/samples/:sampleTaskId",
		route,
	);
	app.all("/api/v2/task-feedback/:executionId", route);
	app.get("/api/v2/agents/:agentId/feedback-summary", route);
	async function route(context: Context) {
		const request = context.req.raw;
		const metadata = requestMetadata(request);
		context.header("Cache-Control", "no-store");
		try {
			if (!input)
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			const url = new URL(request.url);
			const path = url.pathname.split("/");
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
			const query = (keys: string[]) => {
				for (const name of url.searchParams.keys())
					if (!keys.includes(name))
						throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			};
			const pagination = () => ({
				limit: url.searchParams.has("limit")
					? z.coerce
							.number()
							.int()
							.min(1)
							.max(100)
							.parse(url.searchParams.get("limit"))
					: 50,
				cursor: url.searchParams.has("cursor")
					? z.uuid().parse(url.searchParams.get("cursor"))
					: undefined,
			});
			if (path[3] === "task-feedback" && path.length === 5) {
				query([]);
				const id = z.string().min(1).max(256).parse(path[4]);
				const service = createTaskFeedbackV1(input.feedback);
				if (request.method === "GET")
					return context.json(
						TaskFeedbackContextV1Schema.parse(await service.get(trusted, id)),
					);
				if (request.method === "PUT")
					return context.json(
						TaskFeedbackRecordV1Schema.parse(
							await service.submit(
								trusted,
								id,
								parseIdempotencyKey(request, metadata.traceId),
								(
									await parseJson(
										request,
										TaskFeedbackSubmitV1Schema,
										metadata.traceId,
									)
								).value,
							),
						),
					);
			}
			if (
				path[3] === "agents" &&
				path[5] === "feedback-summary" &&
				path.length === 6 &&
				request.method === "GET"
			) {
				query(["view", "from", "to", "modelId", "configVersion"]);
				const view = z
					.enum(["self", "owner"])
					.parse(url.searchParams.get("view") ?? "self");
				const q = TaskFeedbackSummaryQueryV1Schema.parse(
					Object.fromEntries(
						[...url.searchParams.entries()].filter(([key]) => key !== "view"),
					),
				);
				return context.json(
					TaskFeedbackSummaryV1Schema.parse(
						await input.feedback.summary(
							trusted,
							z.string().min(1).max(256).parse(path[4]),
							view,
							q,
						),
					),
				);
			}
			if (path[3] === "evaluation" && request.method === "GET") {
				if (path[4] === "history" && path.length === 5) {
					query(["limit", "cursor"]);
					const p = pagination();
					return context.json(
						EvaluationHistoryV1Schema.parse(
							await input.analysis.history(trusted, p.limit, p.cursor),
						),
					);
				}
				if (path[4] === "choices" && path.length === 5) {
					query(["datasetId", "versionId"]);
					return context.json(
						EvaluationChoiceCatalogV1Schema.parse(
							await input.analysis.choices(
								trusted,
								z.uuid().parse(url.searchParams.get("datasetId")),
								z.uuid().parse(url.searchParams.get("versionId")),
							),
						),
					);
				}
				if (path[4] === "worklist" && path.length === 5) {
					query(["purpose", "limit", "cursor"]);
					const p = pagination();
					return context.json(
						EvaluationWorklistV1Schema.parse(
							await input.scoring.worklist(
								trusted,
								z
									.enum(["score", "review"])
									.parse(url.searchParams.get("purpose")),
								p.limit,
								p.cursor,
							),
						),
					);
				}
				if (path[4] === "analysis" && path[5]) {
					query(
						path.length === 8
							? ["limit", "cursor", "scoreId", "reviewCursor"]
							: [],
					);
					const id = z.uuid().parse(path[5]);
					if (path.length === 6)
						return context.json(
							EvaluationAnalysisSummaryV1Schema.parse(
								await input.analysis.summary(trusted, id),
							),
						);
					if (path.length === 8 && path[6] === "samples")
						return context.json(
							EvaluationAnalysisDetailV1Schema.parse(
								await input.analysis.detail(
									trusted,
									id,
									z.uuid().parse(path[7]),
									{
										...pagination(),
										...(url.searchParams.has("scoreId")
											? {
													scoreId: z
														.uuid()
														.parse(url.searchParams.get("scoreId")),
												}
											: {}),
										...(url.searchParams.has("reviewCursor")
											? {
													reviewCursor: z
														.uuid()
														.parse(url.searchParams.get("reviewCursor")),
												}
											: {}),
									},
								),
							),
						);
				}
			}
			throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
		} catch (error) {
			if (error instanceof EvaluationQueryLimitErrorV1)
				return context.json(
					EvaluationQueryTooLargeV1Schema.parse({
						schemaVersion: 1,
						code: "EVALUATION_QUERY_TOO_LARGE",
						message:
							"Query range is too large. Narrow the time window or filters.",
						traceId: metadata.traceId,
						retryable: false,
					}),
					400,
				);
			const e =
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
					: error instanceof z.ZodError ||
							error instanceof EvaluationQueryLimitErrorV1
						? new HttpProtocolError("INVALID_REQUEST", metadata.traceId)
						: error instanceof PersonalApiCredentialErrorV1
							? new HttpProtocolError(
									error.code === "unavailable"
										? "DEPENDENCY_UNAVAILABLE"
										: "RESOURCE_UNAVAILABLE",
									metadata.traceId,
								)
							: error;
			const mapped = mapCoreError(e, metadata.traceId);
			return context.json(mapped.body, mapped.status);
		}
	}
}
