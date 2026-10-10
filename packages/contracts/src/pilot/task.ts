import { z } from "zod";
import {
	IdempotencyKeyV1Schema,
	OpaqueCursorV1Schema,
	OpaqueIdV1Schema,
	Rfc3339TimestampV1Schema,
	SchemaVersionV1Schema,
} from "../index.ts";
import { PilotProtocolErrorV1Schema } from "./errors.ts";
import { PersistedConversationEventV2Schema } from "./operation-v2.ts";
import {
	AuthorizationRevokedSignalV1Schema,
	HeartbeatSignalV1Schema,
	SseEventIdV1Schema,
	TimelineReloadSignalV1Schema,
} from "./sse.ts";

export const TaskStatusV1Schema = z.enum([
	"waiting",
	"submitted",
	"processing",
	"completed",
	"failed",
	"cancelled",
	"unknown",
]);
const taskStatusPayload = z.union([
	z.strictObject({
		status: TaskStatusV1Schema.exclude(["failed", "unknown"]),
	}),
	z.strictObject({
		status: z.literal("failed"),
		reason: z
			.enum([
				"TASK_WAIT_TIMEOUT",
				"AGENT_UNAVAILABLE",
				"CONVERSATION_UNAVAILABLE",
			])
			.optional(),
	}),
	z.strictObject({
		status: z.literal("unknown"),
		reason: z.literal("STOP_CONFIRMATION_TIMEOUT").optional(),
	}),
]);
export const TaskStatusEventV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	kind: z.literal("event"),
	eventId: SseEventIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	sequence: z.number().int().positive().safe(),
	conversationCursor: OpaqueCursorV1Schema,
	occurredAt: Rfc3339TimestampV1Schema,
	type: z.literal("task.status"),
	payload: taskStatusPayload,
});
export const TaskPersistedEventV1Schema = z.union([
	PersistedConversationEventV2Schema,
	TaskStatusEventV1Schema,
]);
export const TaskSseMessageV1Schema = z.union([
	TaskPersistedEventV1Schema,
	HeartbeatSignalV1Schema,
	TimelineReloadSignalV1Schema,
	AuthorizationRevokedSignalV1Schema,
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
	status: TaskStatusV1Schema,
	output: z.string(),
	events: z.array(TaskPersistedEventV1Schema),
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
const taskStreamPath = z.strictObject({
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
});
const taskStreamQuery = z.strictObject({
	cursor: OpaqueCursorV1Schema.optional(),
});
const taskStreamHeader = z.strictObject({
	"Last-Event-ID": SseEventIdV1Schema.optional(),
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
			"x-agent-infra-sse-framing": {
				controlId: null,
				persistedEventId: "eventId",
			},
			"x-agent-infra-replay-selector": {
				header: "Last-Event-ID",
				mode: "at-most-one",
				query: "cursor",
			},
			requestParams: {
				path: taskStreamPath,
				query: taskStreamQuery,
				header: taskStreamHeader,
			},
			responses: {
				"200": {
					description: "Persisted events for this Execution",
					content: { "text/event-stream": { schema: TaskSseMessageV1Schema } },
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
	TaskStatusEventV1: TaskStatusEventV1Schema,
	CancelTaskRequestV1: CancelTaskRequestV1Schema,
	TaskCancellationV1: TaskCancellationV1Schema,
	TaskSseMessageV1: TaskSseMessageV1Schema,
};
