const protocolError = (
	code: string,
	message: string,
	retryable: boolean,
	traceId: string,
) => ({ schemaVersion: 1, code, message, retryable, traceId }) as const;

const replayTextEvent = {
	schemaVersion: 1,
	kind: "event",
	eventId: "event-replay-1",
	conversationId: "conversation-pilot-1",
	executionId: "execution-pilot-1",
	sequence: 1,
	conversationCursor: "cursor-pilot-1",
	occurredAt: "2026-08-28T10:00:00Z",
	type: "text.delta",
	payload: { text: "Hello" },
} as const;

export const pilotFakeScenariosV1 = {
	success: {
		kind: "http",
		operationId: "submitMessage",
		response: {
			status: 202,
			body: {
				schemaVersion: 1,
				status: "submitted",
				messageId: "message-pilot-1",
				executionId: "execution-pilot-1",
			},
		},
	},
	unauthorized: {
		kind: "http",
		operationId: "getAgent",
		response: {
			status: 403,
			body: protocolError(
				"RESOURCE_UNAVAILABLE",
				"The requested resource is unavailable",
				false,
				"trace-unauthorized",
			),
		},
	},
	starting: {
		kind: "http",
		operationId: "getAgent",
		response: {
			status: 200,
			body: {
				schemaVersion: 1,
				agentId: "agent-pilot-1",
				name: "Release assistant",
				description: "Helps the release team",
				source: { kind: "standard", templateId: "codex" },
				managementStatus: "available",
				serviceAvailability: "starting",
				configuration: {
					owners: [
						{
							userId: "user-owner-1",
							displayName: "Owner",
							roles: ["employee"],
						},
					],
					availability: [
						{ kind: "organization", organizationId: "org-platform" },
					],
					modelOptions: [
						{
							optionId: "model-primary",
							displayName: "Primary model",
							modelId: "gpt-5",
							reasoningLevels: ["medium", "high"],
						},
					],
					defaultModelOptionId: "model-primary",
					defaultReasoningLevel: "medium",
					actions: [
						{
							providerId: "github",
							actionId: "issues.read",
							actionVersion: "v3",
						},
					],
					environment: [{ name: "WORKSPACE_NAME", value: "release" }],
					channels: [
						{ kind: "web", status: "available" },
						{ kind: "wecom_bot", status: "not_configured" },
					],
					secrets: [{ name: "MODEL_API_KEY", isSet: true, version: 1 }],
				},
				capabilities: {
					modelSelection: true,
					attachments: true,
					resultFiles: true,
					connection: true,
					supplementaryInstruction: true,
				},
				interactionUrl: null,
			},
		},
	},
	busy: {
		kind: "http",
		operationId: "submitMessage",
		response: {
			status: 409,
			body: protocolError(
				"AGENT_BUSY",
				"This conversation already has an active response",
				true,
				"trace-busy",
			),
		},
	},
	failed: {
		kind: "http",
		operationId: "getExecutionDetail",
		messages: [
			{
				messageId: "message-original-not-started",
				role: "user",
				text: "Supplementary instruction",
				status: "failed",
				executionId: "execution-pilot-1",
				replyToMessageId: null,
				answerVersion: null,
				isCurrentAnswer: null,
				error: protocolError(
					"ORIGINAL_RESPONSE_NOT_STARTED",
					"The original response did not start",
					false,
					"trace-message-not-started",
				),
				createdAt: "2026-08-28T10:00:01Z",
			},
			{
				messageId: "message-original-finished",
				role: "user",
				text: "Supplementary instruction",
				status: "failed",
				executionId: "execution-pilot-1",
				replyToMessageId: null,
				answerVersion: null,
				isCurrentAnswer: null,
				error: protocolError(
					"ORIGINAL_RESPONSE_ALREADY_FINISHED",
					"The original response already finished",
					false,
					"trace-message-finished",
				),
				createdAt: "2026-08-28T10:00:02Z",
			},
			{
				messageId: "message-authorization-revoked",
				role: "user",
				text: "Supplementary instruction",
				status: "failed",
				executionId: "execution-pilot-1",
				replyToMessageId: null,
				answerVersion: null,
				isCurrentAnswer: null,
				error: protocolError(
					"AUTHORIZATION_REVOKED",
					"Authorization was revoked before delivery",
					false,
					"trace-message-authorization",
				),
				createdAt: "2026-08-28T10:00:03Z",
			},
			{
				messageId: "message-execution-failed",
				role: "assistant",
				text: "",
				status: "failed",
				executionId: "execution-pilot-1",
				replyToMessageId: "message-user-1",
				answerVersion: 1,
				isCurrentAnswer: true,
				error: protocolError(
					"EXECUTION_FAILED",
					"The response could not be completed",
					false,
					"trace-message-execution",
				),
				createdAt: "2026-08-28T10:00:04Z",
			},
		],
		response: {
			status: 200,
			body: {
				schemaVersion: 1,
				executionId: "execution-pilot-1",
				conversationId: "conversation-pilot-1",
				status: "failed",
				processSummary: [
					{
						occurredAt: "2026-08-28T10:00:01Z",
						kind: "status",
						status: "failed",
						summary: "Execution failed",
					},
				],
				startedAt: "2026-08-28T10:00:00Z",
				finishedAt: "2026-08-28T10:00:01Z",
				error: protocolError(
					"EXECUTION_FAILED",
					"The response could not be completed",
					false,
					"trace-failed",
				),
			},
		},
	},
	unavailable: {
		kind: "http",
		operationId: "submitMessage",
		response: {
			status: 503,
			body: protocolError(
				"RUNTIME_UNAVAILABLE",
				"The Agent is temporarily unavailable",
				true,
				"trace-unavailable",
			),
		},
	},
	replay: {
		kind: "sse",
		conversationId: "conversation-pilot-1",
		lastEventId: "event-before-replay",
		messages: [
			replayTextEvent,
			replayTextEvent,
			{
				schemaVersion: 1,
				kind: "event",
				eventId: "event-replay-2",
				conversationId: "conversation-pilot-1",
				executionId: "execution-pilot-1",
				sequence: 2,
				conversationCursor: "cursor-pilot-2",
				occurredAt: "2026-08-28T10:00:01Z",
				type: "execution.status",
				payload: { status: "completed" },
			},
		],
	},
	staleAuthorization: {
		kind: "sse",
		conversationId: "conversation-pilot-1",
		messages: [
			{
				schemaVersion: 1,
				kind: "control",
				type: "authorization.revoked",
				error: protocolError(
					"AUTHORIZATION_REVOKED",
					"Conversation access is no longer available",
					false,
					"trace-stale-authorization",
				),
			},
		],
	},
} as const satisfies Record<string, unknown>;

const pilotCursorOwnersV1: Record<string, string> = {
	"cursor-pilot-1": "conversation-pilot-1",
	"cursor-other-1": "conversation-other-1",
};

export function resolvePilotReplayV1(input: {
	conversationId: string;
	cursor: string;
}) {
	const owner = pilotCursorOwnersV1[input.cursor];
	if (owner !== input.conversationId) {
		return [
			{
				schemaVersion: 1,
				kind: "control",
				type: "timeline.reload",
				reason: owner ? "cross_conversation_cursor" : "unknown_event_id",
				resumeCursor: "cursor-pilot-2",
			},
		] as const;
	}
	return pilotFakeScenariosV1.replay.messages;
}
