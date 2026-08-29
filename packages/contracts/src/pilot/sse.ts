import { z } from "zod";

import {
	OpaqueCursorV1Schema,
	OpaqueIdV1Schema,
	Rfc3339TimestampV1Schema,
	SchemaVersionV1Schema,
	TraceIdV1Schema,
} from "../index.ts";
import {
	PilotInternalErrorV1Schema,
	PilotProtocolErrorV1Schema,
} from "./errors.ts";

const nonEmptyString = () => z.string().min(1);
const eventShape = {
	schemaVersion: SchemaVersionV1Schema,
	kind: z.literal("event"),
	eventId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	sequence: z.number().int().positive(),
	conversationCursor: OpaqueCursorV1Schema,
	occurredAt: Rfc3339TimestampV1Schema,
};

export const TextDeltaEventV1Schema = z.strictObject({
	...eventShape,
	type: z.literal("text.delta"),
	payload: z.strictObject({ text: z.string() }),
});

export const ExecutionStatusEventV1Schema = z.strictObject({
	...eventShape,
	type: z.literal("execution.status"),
	payload: z.strictObject({
		status: z.enum([
			"submitted",
			"processing",
			"completed",
			"failed",
			"cancelled",
			"unknown",
		]),
	}),
});

export const ExecutionDetailEventV1Schema = z.strictObject({
	...eventShape,
	type: z.literal("execution.detail"),
	payload: z.strictObject({
		category: z.enum(["status", "model_call", "connection_call"]),
		summary: nonEmptyString(),
		callId: OpaqueIdV1Schema.optional(),
	}),
});

export const ResultFileEventV1Schema = z.strictObject({
	...eventShape,
	type: z.literal("result.file"),
	payload: z.strictObject({
		fileId: OpaqueIdV1Schema,
		name: nonEmptyString(),
		mediaType: nonEmptyString(),
		sizeBytes: z.number().int().nonnegative(),
	}),
});

export const ConversationErrorEventV1Schema = z.strictObject({
	...eventShape,
	type: z.literal("conversation.error"),
	payload: z.strictObject({ error: PilotProtocolErrorV1Schema }),
});

export const PersistedConversationEventV1Schema = z.discriminatedUnion("type", [
	TextDeltaEventV1Schema,
	ExecutionStatusEventV1Schema,
	ExecutionDetailEventV1Schema,
	ResultFileEventV1Schema,
	ConversationErrorEventV1Schema,
]);

export const TimelineReloadSignalV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	kind: z.literal("control"),
	type: z.literal("timeline.reload"),
	reason: z.enum([
		"unknown_event_id",
		"cross_conversation_cursor",
		"cursor_expired",
	]),
	resumeCursor: OpaqueCursorV1Schema,
});

export const HeartbeatSignalV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	kind: z.literal("control"),
	type: z.literal("heartbeat"),
	occurredAt: Rfc3339TimestampV1Schema,
});

const authorizationRevokedError = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	code: z.literal("AUTHORIZATION_REVOKED"),
	message: nonEmptyString(),
	retryable: z.literal(false),
	traceId: TraceIdV1Schema,
});

export const AuthorizationRevokedSignalV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	kind: z.literal("control"),
	type: z.literal("authorization.revoked"),
	error: authorizationRevokedError,
});

export const ConversationSseMessageV1Schema = z.union([
	PersistedConversationEventV1Schema,
	HeartbeatSignalV1Schema,
	TimelineReloadSignalV1Schema,
	AuthorizationRevokedSignalV1Schema,
]);

const conversationPath = z.strictObject({
	conversationId: OpaqueIdV1Schema,
});
const replayQuery = z.strictObject({
	cursor: OpaqueCursorV1Schema.optional(),
});
const replayHeader = z.strictObject({
	"Last-Event-ID": OpaqueIdV1Schema.optional(),
});
const replaySelector = z.strictObject({
	cursor: OpaqueCursorV1Schema.optional(),
	lastEventId: OpaqueIdV1Schema.optional(),
});

export function resolvePilotReplaySelectorV1(input: unknown) {
	const selector = replaySelector.parse(input);
	if (selector.cursor !== undefined && selector.lastEventId !== undefined) {
		throw new Error("Replay selector is ambiguous");
	}
	if (selector.cursor !== undefined) {
		return { kind: "cursor", value: selector.cursor } as const;
	}
	if (selector.lastEventId !== undefined) {
		return { kind: "last-event-id", value: selector.lastEventId } as const;
	}
	return undefined;
}

const protocolErrorResponse = (description: string) => ({
	description,
	content: { "application/json": { schema: PilotProtocolErrorV1Schema } },
});

export const pilotBrowserSseOpenApiPathsV1 = {
	"/api/v1/conversations/{conversationId}/events": {
		get: {
			operationId: "streamConversationEvents",
			requestParams: {
				path: conversationPath,
				query: replayQuery,
				header: replayHeader,
			},
			responses: {
				"200": {
					description:
						"Persisted conversation events and bounded control signals",
					content: {
						"text/event-stream": { schema: ConversationSseMessageV1Schema },
					},
				},
				"400": protocolErrorResponse("Invalid replay cursor"),
				"401": protocolErrorResponse("Authentication required"),
				"403": protocolErrorResponse("Conversation access is unavailable"),
				"503": protocolErrorResponse("Event stream is temporarily unavailable"),
				"500": {
					description: "Internal error",
					content: {
						"application/json": { schema: PilotInternalErrorV1Schema },
					},
				},
			},
		},
	},
} as const;

export const pilotSseSchemasV1 = {
	AuthorizationRevokedSignalV1: AuthorizationRevokedSignalV1Schema,
	ConversationSseMessageV1: ConversationSseMessageV1Schema,
	HeartbeatSignalV1: HeartbeatSignalV1Schema,
	PersistedConversationEventV1: PersistedConversationEventV1Schema,
	TimelineReloadSignalV1: TimelineReloadSignalV1Schema,
};

export type PersistedConversationEventV1 = z.infer<
	typeof PersistedConversationEventV1Schema
>;
export type ConversationSseMessageV1 = z.infer<
	typeof ConversationSseMessageV1Schema
>;
