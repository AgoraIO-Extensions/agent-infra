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

const BrowserHandoffBindingV2Schema = z.strictObject({
	subjectId: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	sessionGeneration: z.number().int().positive().safe(),
	resourceFence: z.number().int().positive().safe(),
	workloadRevision: z.number().int().positive().safe(),
	imageDigest: z.string().regex(/^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/u),
	capabilityVersion: z.number().int().positive().safe(),
	capabilityRevision: z.number().int().positive().safe(),
	pageRevision: z.number().int().positive().safe(),
});

export const BrowserHandoffEventV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	kind: z.literal("event"),
	eventId: SseEventIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	sequence: z.number().int().positive().safe(),
	conversationCursor: OpaqueCursorV1Schema,
	occurredAt: Rfc3339TimestampV1Schema,
	type: z.literal("browser.handoff"),
	payload: z.strictObject({
		handoffId: OpaqueIdV1Schema,
		status: z.enum([
			"requested",
			"active",
			"returning",
			"completed",
			"revoked",
			"expired",
			"crashed",
			"unknown",
		]),
		reason: z.enum(["login", "mfa", "captcha", "human_judgment"]),
		requestedAt: Rfc3339TimestampV1Schema,
		expiresAt: Rfc3339TimestampV1Schema,
		operatorId: OpaqueIdV1Schema.optional(),
		terminalReason: z.string().min(1).max(256).optional(),
		binding: BrowserHandoffBindingV2Schema,
	}),
});

const BrowserSideEffectBindingV2Schema = BrowserHandoffBindingV2Schema.extend({
	actionId: OpaqueIdV1Schema,
	confirmationId: OpaqueIdV1Schema,
	operationRef: OpaqueIdV1Schema,
	attemptRef: OpaqueIdV1Schema,
});

export const BrowserSideEffectEventV2Schema = z
	.strictObject({
		schemaVersion: z.literal(2),
		kind: z.literal("event"),
		eventId: SseEventIdV1Schema,
		conversationId: OpaqueIdV1Schema,
		executionId: OpaqueIdV1Schema,
		sequence: z.number().int().positive().safe(),
		conversationCursor: OpaqueCursorV1Schema,
		occurredAt: Rfc3339TimestampV1Schema,
		type: z.literal("browser.side_effect"),
		payload: z.strictObject({
			confirmationId: OpaqueIdV1Schema,
			status: z.enum([
				"pending",
				"confirmed",
				"rejected",
				"cancelled",
				"expired",
				"unknown",
			]),
			requestedAt: Rfc3339TimestampV1Schema,
			expiresAt: Rfc3339TimestampV1Schema,
			operation: z.string().min(1).max(128),
			targetOrigin: z
				.string()
				.url()
				.max(2048)
				.refine((value) => {
					try {
						const url = new URL(value);
						return (
							(url.protocol === "http:" || url.protocol === "https:") &&
							url.username === "" &&
							url.password === "" &&
							url.pathname === "/" &&
							url.search === "" &&
							url.hash === ""
						);
					} catch {
						return false;
					}
				}, "targetOrigin must be an HTTP(S) origin"),
			redactedTargetSummary: z.string().min(1).max(1024),
			binding: BrowserSideEffectBindingV2Schema,
		}),
	})
	.superRefine((value, context) => {
		if (
			value.conversationId !== value.payload.binding.conversationId ||
			value.executionId !== value.payload.binding.executionId ||
			value.payload.confirmationId !== value.payload.binding.confirmationId
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Browser side-effect binding scope does not match event scope",
			});
		}
	});

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

/**
 * G-07：回退事件 V2 在 V1 payload 之外记录会话原所选选项及受理时的显示名。
 * 显示名读不到时为 null；V1 读取方仍收到不含原选项的 V1 事件，旧事件保持 V1。
 */
export const ModelSelectionFallbackEventV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	kind: z.literal("event"),
	eventId: SseEventIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	sequence: z.number().int().positive().safe(),
	conversationCursor: OpaqueCursorV1Schema,
	occurredAt: Rfc3339TimestampV1Schema,
	type: z.literal("model.selection.fell_back"),
	payload: z.strictObject({
		modelOptionId: OpaqueIdV1Schema,
		reasoningLevel: z.string().min(1),
		reason: z.literal("selection_unavailable"),
		requestedModelOptionId: OpaqueIdV1Schema,
		requestedModelDisplayName: z.string().min(1).max(1024).nullable(),
	}),
});

/** Mixed history preserves each original event version and stable reference. */
export const PersistedConversationEventV2Schema = z.union([
	PersistedConversationEventV1Schema,
	ExecutionOperationEventV2Schema,
	BrowserHandoffEventV2Schema,
	BrowserSideEffectEventV2Schema,
	ModelSelectionFallbackEventV2Schema,
]);

/**
 * #2979：模型提供的思考过程增量（原始推理或推理摘要），属于会话正文。只出现在 V2 会话
 * 读取、执行详情与 V2 SSE；V1 SSE 跳过它但推进持久游标。任务投影沿用
 * PersistedConversationEventV2，不包含思考过程。
 */
export const ReasoningDeltaEventV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	kind: z.literal("event"),
	eventId: SseEventIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	sequence: z.number().int().positive().safe(),
	conversationCursor: OpaqueCursorV1Schema,
	occurredAt: Rfc3339TimestampV1Schema,
	type: z.literal("reasoning.delta"),
	payload: z.strictObject({
		kind: z.enum(["raw", "summary"]),
		text: z.string().min(1),
	}),
});

/** 会话读取方看到的事件：混合版本历史加上思考过程。 */
const conversationEvents = z.array(
	z.union([PersistedConversationEventV2Schema, ReasoningDeltaEventV2Schema]),
);

export const ConversationSseMessageV2Schema = z.union([
	PersistedConversationEventV2Schema,
	ReasoningDeltaEventV2Schema,
	HeartbeatSignalV1Schema,
	TimelineReloadSignalV1Schema,
	AuthorizationRevokedSignalV1Schema,
]);

export const ConversationEventWindowV1Schema = z.strictObject({
	hasEarlier: z.boolean(),
	beforeCursor: OpaqueCursorV1Schema.nullable(),
});

export function framePilotSseMessageV2(input: unknown) {
	const data = ConversationSseMessageV2Schema.parse(input);
	return data.kind === "event" ? { id: data.eventId, data } : { data };
}

export const ConversationDetailProjectionV2Schema =
	ConversationDetailProjectionV1Schema.extend({
		schemaVersion: z.literal(2),
		events: conversationEvents,
		/** Present on current servers; omitted by older detail responses. */
		eventWindow: ConversationEventWindowV1Schema.optional(),
		/** Whether the Conversation's own Session Sandbox can take messages yet.
		 * Absent from older servers, which the Web treats as "ready" (#1534);
		 * "updating" while the Sandbox upgrades to a new deployment (ADR 0023). */
		sessionAvailability: z
			.enum(["preparing", "ready", "unavailable", "updating"])
			.optional(),
	});

const executionAdditions = {
	schemaVersion: z.literal(2),
	events: conversationEvents,
};
export const ExecutionDetailProjectionV2Schema = z.discriminatedUnion(
	"status",
	[
		ExecutionDetailProjectionV1Schema.options[0].extend(executionAdditions),
		ExecutionDetailProjectionV1Schema.options[1].extend(executionAdditions),
	],
);

const conversationList =
	pilotBrowserOpenApiPathsV1["/api/v1/agents/{agentId}/conversations"].get;
const personalConversationSecurity: Record<string, never[]>[] = [
	{ PlatformSession: [] },
];

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
	"/api/v2/me/conversations/recent": {
		get: {
			...conversationList,
			operationId: "listRecentPersonalConversationsV2",
			description:
				"Current personal Web conversation metadata ordered by updatedAt DESC, id DESC after authorization filtering",
			security: personalConversationSecurity,
			requestParams: {
				query: conversationList.requestParams.query.extend({
					limit: conversationList.requestParams.query.shape.limit.default(50),
				}),
			},
		},
	},
	"/api/v2/conversations/{conversationId}": {
		get: {
			...conversationRead,
			operationId: "getConversationV2",
			requestParams: {
				...conversationRead.requestParams,
				query: z.strictObject({
					beforeCursor: OpaqueCursorV1Schema.optional(),
				}),
			},
			responses: {
				...conversationRead.responses,
				"200": {
					description:
						"Conversation messages and a bounded mixed-version event window",
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
				"404": conversationRead.responses["404"],
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
	BrowserHandoffEventV2: BrowserHandoffEventV2Schema,
	BrowserSideEffectEventV2: BrowserSideEffectEventV2Schema,
	ModelSelectionFallbackEventV2: ModelSelectionFallbackEventV2Schema,
	PersistedConversationEventV2: PersistedConversationEventV2Schema,
	ReasoningDeltaEventV2: ReasoningDeltaEventV2Schema,
	ConversationSseMessageV2: ConversationSseMessageV2Schema,
};

export const pilotOperationSchemasV2 = {
	...pilotOperationSseSchemasV2,
	ConversationEventWindowV1: ConversationEventWindowV1Schema,
	ConversationDetailProjectionV2: ConversationDetailProjectionV2Schema,
	ExecutionDetailProjectionV2: ExecutionDetailProjectionV2Schema,
};

export type ExecutionOperationEventV2 = z.infer<
	typeof ExecutionOperationEventV2Schema
>;
export type BrowserHandoffEventV2 = z.infer<typeof BrowserHandoffEventV2Schema>;
export type BrowserSideEffectEventV2 = z.infer<
	typeof BrowserSideEffectEventV2Schema
>;
export type ModelSelectionFallbackEventV2 = z.infer<
	typeof ModelSelectionFallbackEventV2Schema
>;
export type PersistedConversationEventV2 = z.infer<
	typeof PersistedConversationEventV2Schema
>;
export type ReasoningDeltaEventV2 = z.infer<typeof ReasoningDeltaEventV2Schema>;
export type ConversationSseMessageV2 = z.infer<
	typeof ConversationSseMessageV2Schema
>;
export type ConversationEventWindowV1 = z.infer<
	typeof ConversationEventWindowV1Schema
>;
