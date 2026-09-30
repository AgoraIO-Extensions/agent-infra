import { z } from "zod";
import {
	IdempotencyKeyV1Schema,
	OpaqueCursorV1Schema,
	OpaqueIdV1Schema,
	SchemaVersionV1Schema,
} from "../index.ts";
import { PilotProtocolErrorV1Schema } from "./errors.ts";
import {
	ConversationSseMessageV2Schema,
	PersistedConversationEventV2Schema,
} from "./operation-v2.ts";
import { SseEventIdV1Schema } from "./sse.ts";

export const TaskStreamErrorV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	kind: z.literal("control"),
	type: z.literal("task.stream.error"),
	error: PilotProtocolErrorV1Schema,
});
export const TaskSseMessageV1Schema = z.union([
	ConversationSseMessageV2Schema,
	TaskStreamErrorV1Schema,
]);
export function frameTaskSseMessageV1(input: unknown) {
	const data = TaskSseMessageV1Schema.parse(input);
	return data.kind === "event" ? { id: data.eventId, data } : { data };
}

export const SubmitTaskRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	text: z.string().min(1),
	conversationId: OpaqueIdV1Schema.optional(),
});
export const TaskAcceptedV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	status: z.literal("accepted"),
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	messageId: OpaqueIdV1Schema,
});
export const TaskProjectionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	status: z.enum([
		"waiting",
		"submitted",
		"processing",
		"completed",
		"failed",
		"cancelled",
		"unknown",
	]),
	output: z.string(),
	events: z.array(PersistedConversationEventV2Schema),
});
export const CancelTaskRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
});
export const TaskCancellationV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	executionId: OpaqueIdV1Schema,
	status: z.enum(["submitted", "already_finished"]),
});

const json = (description: string, schema: z.ZodType) => ({
	description,
	content: { "application/json": { schema } },
});
const errors = Object.fromEntries(
	[400, 401, 403, 404, 409, 500, 503].map((status) => [
		String(status),
		json("Task request failed", PilotProtocolErrorV1Schema),
	]),
);
const taskPath = z.strictObject({
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
});
const idempotency = z.strictObject({
	"Idempotency-Key": IdempotencyKeyV1Schema,
});
const body = (schema: z.ZodType) => ({
	required: true,
	content: { "application/json": { schema } },
});

export const pilotTaskOpenApiPathsV1 = {
	"/api/v1/agents/{agentId}/tasks": {
		post: {
			operationId: "submitAgentTask",
			security: [{ platformApiCredential: [] }],
			requestParams: {
				path: z.strictObject({ agentId: OpaqueIdV1Schema }),
				header: idempotency,
			},
			requestBody: body(SubmitTaskRequestV1Schema),
			responses: {
				"202": json("Durably accepted task", TaskAcceptedV1Schema),
				...errors,
			},
		},
	},
	"/api/v1/conversations/{conversationId}/tasks/{executionId}": {
		get: {
			operationId: "getAgentTask",
			security: [{ platformApiCredential: [] }],
			requestParams: { path: taskPath },
			responses: {
				"200": json(
					"This execution's output and original events",
					TaskProjectionV1Schema,
				),
				...errors,
			},
		},
	},
	"/api/v1/conversations/{conversationId}/tasks/{executionId}/cancel": {
		post: {
			operationId: "cancelAgentTask",
			security: [{ platformApiCredential: [] }],
			requestParams: { path: taskPath, header: idempotency },
			requestBody: body(CancelTaskRequestV1Schema),
			responses: {
				"202": json(
					"Cancellation requested; stopping is confirmed by task status",
					TaskCancellationV1Schema,
				),
				...errors,
			},
		},
	},
	"/api/v1/conversations/{conversationId}/tasks/{executionId}/events": {
		get: {
			operationId: "streamAgentTaskEvents",
			security: [{ platformApiCredential: [] }],
			requestParams: {
				path: taskPath,
				query: z.strictObject({ cursor: OpaqueCursorV1Schema.optional() }),
				header: z.strictObject({
					"Last-Event-ID": SseEventIdV1Schema.optional(),
				}),
			},
			"x-agent-infra-replay-selector": {
				header: "Last-Event-ID",
				mode: "at-most-one",
				query: "cursor",
			},
			"x-agent-infra-sse-framing": {
				controlId: null,
				persistedEventId: "eventId",
			},
			responses: {
				"200": {
					description:
						"Only this execution's persisted events and bounded controls",
					content: {
						"text/event-stream": { schema: TaskSseMessageV1Schema },
					},
				},
				...errors,
			},
		},
	},
} as const;

export const pilotTaskSchemasV1 = {
	SubmitTaskRequestV1: SubmitTaskRequestV1Schema,
	TaskAcceptedV1: TaskAcceptedV1Schema,
	TaskProjectionV1: TaskProjectionV1Schema,
	CancelTaskRequestV1: CancelTaskRequestV1Schema,
	TaskCancellationV1: TaskCancellationV1Schema,
	TaskStreamErrorV1: TaskStreamErrorV1Schema,
	TaskSseMessageV1: TaskSseMessageV1Schema,
};
