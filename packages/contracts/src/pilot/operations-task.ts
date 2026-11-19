import { z } from "zod";
import { PilotProtocolErrorV1Schema } from "./errors.ts";

const id = z.string().min(1).max(256);
const timestamp = z.iso.datetime({ offset: true });
export const OperationsTaskQueryV2Schema = z
	.strictObject({
		agentId: id,
		sessionId: id,
		start: timestamp,
		end: timestamp,
	})
	.refine(({ start, end }) => {
		const span = Date.parse(end) - Date.parse(start);
		return span > 0 && span <= 30 * 86_400_000;
	});
export type OperationsTaskQueryV2 = z.infer<typeof OperationsTaskQueryV2Schema>;

const status = z.enum([
	"waiting",
	"submitted",
	"processing",
	"completed",
	"failed",
	"cancelled",
	"unknown",
]);
const evidence = z.strictObject({
	stage: z.enum([
		"acceptance",
		"queue",
		"dispatch",
		"execution",
		"result",
		"runtime",
		"model",
		"tool",
		"verification",
	]),
	state: z.enum([
		"accepted",
		"waiting",
		"submitted",
		"processing",
		"completed",
		"failed",
		"cancelled",
		"unknown",
		"started",
	]),
	observedAt: timestamp,
	startedAt: timestamp.nullable(),
	finishedAt: timestamp.nullable(),
	durationMs: z.number().int().nonnegative().nullable(),
	errorCode: z.string().min(1).max(128).nullable(),
});
export const OperationsTasksV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	source: z.literal("platform"),
	state: z.enum(["available", "missing", "unavailable"]),
	truncated: z.boolean(),
	tasks: z
		.array(
			z.strictObject({
				executionId: id,
				status,
				evidence: z.array(evidence).max(160),
			}),
		)
		.max(48),
});
export type OperationsTasksV2 = z.infer<typeof OperationsTasksV2Schema>;

const response = (description: string, model: z.ZodType) => {
	const schema = z.toJSONSchema(model);
	delete schema.$schema;
	return { description, content: { "application/json": { schema } } };
};
export const operationsTaskOpenApiPathsV2 = {
	"/api/v2/ops/tasks": {
		get: {
			operationId: "getOperationsTasksV2",
			summary: "Read bounded administrator task stage evidence",
			security: [{ PlatformSession: [] }],
			parameters: ["agentId", "sessionId", "start", "end"].map((name) => ({
				name,
				in: "query",
				required: true,
				schema:
					name === "start" || name === "end"
						? { type: "string", format: "date-time" }
						: { type: "string", minLength: 1, maxLength: 256 },
			})),
			responses: {
				"200": response(
					"Task metadata, truncation or a source gap",
					OperationsTasksV2Schema,
				),
				"400": response("Invalid bounded query", PilotProtocolErrorV1Schema),
				"401": response("Authentication required", PilotProtocolErrorV1Schema),
				"403": response("Not authorized", PilotProtocolErrorV1Schema),
				"503": response("Query unavailable", PilotProtocolErrorV1Schema),
			},
		},
	},
} as const;
