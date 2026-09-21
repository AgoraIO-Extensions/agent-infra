import { z } from "zod";

import {
	OpaqueCursorV1Schema,
	OpaqueIdV1Schema,
	Rfc3339TimestampV1Schema,
} from "../index.ts";
import {
	RuntimeConnectionAssociationV1Schema,
	RuntimeOperationFactV2Schema,
	RuntimeOperationFailureV2Schema,
} from "../runtime/events-v2.ts";
import {
	ConversationDetailProjectionV1Schema,
	ExecutionDetailProjectionV1Schema,
	pilotBrowserOpenApiPathsV1,
} from "./browser.ts";
import {
	AuthorizationRevokedSignalV1Schema,
	HeartbeatSignalV1Schema,
	PersistedConversationEventV1Schema,
	pilotBrowserSseOpenApiPathsV1,
	pilotSseSchemasV1,
	SseEventIdV1Schema,
	TimelineReloadSignalV1Schema,
} from "./sse.ts";

/** The same public operation fact contract is used across Runtime and browser transports. */
export const ExecutionOperationEventV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	kind: z.literal("event"),
	eventId: SseEventIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	sequence: z.number().int().positive().safe(),
	conversationCursor: OpaqueCursorV1Schema,
	occurredAt: Rfc3339TimestampV1Schema,
	type: z.literal("execution.operation"),
	payload: RuntimeOperationFactV2Schema,
});

/** Mixed history preserves each original event version and stable reference. */
export const PersistedConversationEventV2Schema = z.union([
	PersistedConversationEventV1Schema,
	ExecutionOperationEventV2Schema,
]);

export const ConversationSseMessageV2Schema = z.union([
	PersistedConversationEventV2Schema,
	HeartbeatSignalV1Schema,
	TimelineReloadSignalV1Schema,
	AuthorizationRevokedSignalV1Schema,
]);

export function framePilotSseMessageV2(input: unknown) {
	const data = ConversationSseMessageV2Schema.parse(input);
	return data.kind === "event" ? { id: data.eventId, data } : { data };
}

export const ConversationDetailProjectionV2Schema =
	ConversationDetailProjectionV1Schema.extend({
		schemaVersion: z.literal(2),
		events: z.array(PersistedConversationEventV2Schema),
	});

const executionAdditions = {
	schemaVersion: z.literal(2),
	events: z.array(PersistedConversationEventV2Schema),
};
export const ExecutionDetailProjectionV2Schema = z.discriminatedUnion(
	"status",
	[
		ExecutionDetailProjectionV1Schema.options[0].extend(executionAdditions),
		ExecutionDetailProjectionV1Schema.options[1].extend(executionAdditions),
	],
);

const conversationRead =
	pilotBrowserOpenApiPathsV1["/api/v1/conversations/{conversationId}"].get;
const executionRead =
	pilotBrowserOpenApiPathsV1[
		"/api/v1/conversations/{conversationId}/executions/{executionId}"
	].get;
const streamRead =
	pilotBrowserSseOpenApiPathsV1["/api/v1/conversations/{conversationId}/events"]
		.get;

export const pilotOperationOpenApiPathsV2 = {
	"/api/v2/conversations/{conversationId}": {
		get: {
			...conversationRead,
			operationId: "getConversationV2",
			responses: {
				...conversationRead.responses,
				"200": {
					description:
						"Conversation messages and complete mixed-version event history",
					content: {
						"application/json": {
							schema: ConversationDetailProjectionV2Schema,
						},
					},
				},
			},
		},
	},
	"/api/v2/conversations/{conversationId}/executions/{executionId}": {
		get: {
			...executionRead,
			operationId: "getExecutionDetailV2",
			responses: {
				...executionRead.responses,
				"200": {
					description:
						"Execution detail with original structured operation facts and event history",
					content: {
						"application/json": { schema: ExecutionDetailProjectionV2Schema },
					},
				},
			},
		},
	},
	"/api/v2/conversations/{conversationId}/events": {
		get: {
			...streamRead,
			operationId: "streamConversationEventsV2",
			responses: {
				...streamRead.responses,
				"200": {
					description:
						"Original V1 events, V2 operation facts and bounded V1 controls",
					content: {
						"text/event-stream": { schema: ConversationSseMessageV2Schema },
					},
				},
			},
		},
	},
} as const;

export const pilotOperationSseSchemasV2 = {
	...pilotSseSchemasV1,
	RuntimeConnectionAssociationV1: RuntimeConnectionAssociationV1Schema,
	RuntimeOperationFailureV2: RuntimeOperationFailureV2Schema,
	RuntimeOperationFactV2: RuntimeOperationFactV2Schema,
	ExecutionOperationEventV2: ExecutionOperationEventV2Schema,
	PersistedConversationEventV2: PersistedConversationEventV2Schema,
	ConversationSseMessageV2: ConversationSseMessageV2Schema,
};

export const pilotOperationSchemasV2 = {
	...pilotOperationSseSchemasV2,
	ConversationDetailProjectionV2: ConversationDetailProjectionV2Schema,
	ExecutionDetailProjectionV2: ExecutionDetailProjectionV2Schema,
};

export type ExecutionOperationEventV2 = z.infer<
	typeof ExecutionOperationEventV2Schema
>;
export type PersistedConversationEventV2 = z.infer<
	typeof PersistedConversationEventV2Schema
>;
export type ConversationSseMessageV2 = z.infer<
	typeof ConversationSseMessageV2Schema
>;
