import { z } from "zod";

import {
	IdempotencyKeyV1Schema,
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
import { pilotBrowserSseOpenApiPathsV1 } from "./sse.ts";

const nonEmptyString = () => z.string().min(1);
const idArray = () => z.array(OpaqueIdV1Schema);
const pathId = () => OpaqueIdV1Schema;
const idempotencyHeader = z.strictObject({
	"Idempotency-Key": IdempotencyKeyV1Schema,
});
const pageQuery = z.strictObject({
	cursor: OpaqueCursorV1Schema.optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
});
const jsonContent = (schema: z.ZodType) => ({
	content: { "application/json": { schema } },
});
const requiredJsonRequestBody = (schema: z.ZodType) => ({
	required: true,
	...jsonContent(schema),
});
const jsonResponse = (description: string, schema: z.ZodType) => ({
	description,
	...jsonContent(schema),
});
const errorResponses = {
	"400": jsonResponse("Invalid request", PilotProtocolErrorV1Schema),
	"401": jsonResponse("Authentication required", PilotProtocolErrorV1Schema),
	"403": jsonResponse("Request is not authorized", PilotProtocolErrorV1Schema),
	"404": jsonResponse("Resource is unavailable", PilotProtocolErrorV1Schema),
	"409": jsonResponse(
		"Request conflicts with current state",
		PilotProtocolErrorV1Schema,
	),
	"503": jsonResponse(
		"Dependency is temporarily unavailable",
		PilotProtocolErrorV1Schema,
	),
	"500": jsonResponse("Internal error", PilotInternalErrorV1Schema),
};

export const BrowserUserProjectionV1Schema = z.strictObject({
	userId: OpaqueIdV1Schema,
	displayName: nonEmptyString(),
	roles: z.array(z.enum(["employee", "system_admin"])).min(1),
});

export const BrowserSessionProjectionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	user: BrowserUserProjectionV1Schema,
});

export const AvailabilityTargetV1Schema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("user"), userId: OpaqueIdV1Schema }),
	z.strictObject({
		kind: z.literal("organization"),
		organizationId: OpaqueIdV1Schema,
	}),
]);

export const AgentSourceInputV1Schema = z.union([
	z.strictObject({
		kind: z.literal("standard"),
		templateId: OpaqueIdV1Schema,
	}),
	z.strictObject({
		kind: z.literal("custom"),
		imageReference: nonEmptyString(),
		interactionMode: z.literal("self-managed"),
		identityResponsibility: z.enum(["self-managed", "platform-managed"]),
	}),
	z.strictObject({
		kind: z.literal("custom"),
		imageReference: nonEmptyString(),
		interactionMode: z.literal("platform-adapter"),
	}),
]);

export const ModelOptionInputV1Schema = z.strictObject({
	optionId: OpaqueIdV1Schema,
	endpointId: OpaqueIdV1Schema,
	modelId: nonEmptyString(),
	reasoningLevels: z.array(nonEmptyString()).min(1),
	credentialValue: nonEmptyString().meta({ writeOnly: true }).optional(),
});

export const ModelConfigurationInputV1Schema = z.strictObject({
	options: z.array(ModelOptionInputV1Schema).min(1),
	defaultOptionId: OpaqueIdV1Schema,
	defaultReasoningLevel: nonEmptyString(),
});

export const ActionSelectionV1Schema = z.strictObject({
	providerId: OpaqueIdV1Schema,
	actionId: OpaqueIdV1Schema,
	actionVersion: nonEmptyString(),
});

export const EnvironmentValueInputV1Schema = z.strictObject({
	name: nonEmptyString(),
	value: z.string(),
});

export const SecretValueInputV1Schema = z.strictObject({
	name: nonEmptyString(),
	value: nonEmptyString().meta({ writeOnly: true }),
});

export const ChannelBindingInputV1Schema = z.discriminatedUnion("enabled", [
	z.strictObject({
		kind: z.enum(["wecom_bot", "wecom_app"]),
		enabled: z.literal(true),
		bindingReference: OpaqueIdV1Schema,
	}),
	z.strictObject({
		kind: z.enum(["wecom_bot", "wecom_app"]),
		enabled: z.literal(false),
	}),
]);

export const ChannelBindingProjectionV1Schema = z.strictObject({
	kind: z.enum(["web", "wecom_bot", "wecom_app"]),
	status: z.enum(["available", "not_configured", "binding", "bound", "failed"]),
});

const applicationInputShape = {
	schemaVersion: SchemaVersionV1Schema,
	name: nonEmptyString(),
	description: nonEmptyString(),
	source: AgentSourceInputV1Schema,
	coOwnerIds: idArray(),
	availability: z.array(AvailabilityTargetV1Schema),
	modelConfiguration: ModelConfigurationInputV1Schema.optional(),
	actions: z.array(ActionSelectionV1Schema),
	environment: z.array(EnvironmentValueInputV1Schema),
	secrets: z.array(SecretValueInputV1Schema),
};

export const AgentApplicationCreateRequestV1Schema = z.strictObject(
	applicationInputShape,
);
export const AgentApplicationUpdateRequestV1Schema = z.strictObject({
	...applicationInputShape,
	secrets: applicationInputShape.secrets.optional(),
});

export const AgentManagementStatusV1Schema = z.enum([
	"pending_approval",
	"withdrawn",
	"rejected",
	"creating",
	"available",
	"stopped",
	"creation_failed",
	"disabled",
]);
export const AgentServiceAvailabilityV1Schema = z.enum([
	"ready",
	"starting",
	"updating",
	"unavailable",
]);

export const ModelOptionProjectionV1Schema = z.strictObject({
	optionId: OpaqueIdV1Schema,
	displayName: nonEmptyString(),
	modelId: nonEmptyString(),
	reasoningLevels: z.array(nonEmptyString()).min(1),
});

export const AgentConfigurationProjectionV1Schema = z.strictObject({
	owners: z.array(BrowserUserProjectionV1Schema).min(1),
	availability: z.array(AvailabilityTargetV1Schema),
	modelOptions: z.array(ModelOptionProjectionV1Schema),
	defaultModelOptionId: OpaqueIdV1Schema.nullable(),
	defaultReasoningLevel: nonEmptyString().nullable(),
	actions: z.array(ActionSelectionV1Schema),
	environment: z.array(EnvironmentValueInputV1Schema),
	channels: z.array(ChannelBindingProjectionV1Schema),
	secrets: z.array(
		z.strictObject({
			name: nonEmptyString(),
			isSet: z.boolean(),
			version: z.number().int().positive().nullable(),
		}),
	),
});

export const AgentResourceProfileProjectionV1Schema = z.strictObject({
	profileId: OpaqueIdV1Schema,
	displayName: nonEmptyString(),
	estimatedResources: z.strictObject({
		cpuMillicores: z.number().int().positive(),
		memoryMiB: z.number().int().positive(),
		storageGiB: z.number().int().positive(),
	}),
});

export const AgentApplicationProjectionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	applicationId: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema.nullable(),
	name: nonEmptyString(),
	description: nonEmptyString(),
	source: AgentSourceInputV1Schema,
	status: AgentManagementStatusV1Schema,
	resourceProfile: AgentResourceProfileProjectionV1Schema,
	configuration: AgentConfigurationProjectionV1Schema,
	submittedAt: Rfc3339TimestampV1Schema,
	decision: z
		.strictObject({
			decidedAt: Rfc3339TimestampV1Schema,
			reason: nonEmptyString().nullable(),
		})
		.nullable(),
});

export const AgentProjectionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	agentId: OpaqueIdV1Schema,
	name: nonEmptyString(),
	description: nonEmptyString(),
	source: AgentSourceInputV1Schema,
	managementStatus: AgentManagementStatusV1Schema,
	serviceAvailability: AgentServiceAvailabilityV1Schema.nullable(),
	configuration: AgentConfigurationProjectionV1Schema,
	capabilities: z.strictObject({
		modelSelection: z.boolean(),
		attachments: z.boolean(),
		resultFiles: z.boolean(),
		connection: z.boolean(),
		supplementaryInstruction: z.boolean(),
	}),
	interactionUrl: z
		.string()
		.url()
		.regex(/^https:\/\//)
		.nullable(),
});

export const AgentConfigurationUpdateRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	coOwnerIds: idArray().optional(),
	availability: z.array(AvailabilityTargetV1Schema).optional(),
	modelConfiguration: ModelConfigurationInputV1Schema.optional(),
	actions: z.array(ActionSelectionV1Schema).optional(),
	environment: z.array(EnvironmentValueInputV1Schema).optional(),
	channels: z.array(ChannelBindingInputV1Schema).optional(),
	secrets: z.array(SecretValueInputV1Schema).optional(),
});

export const AgentLifecycleCommandRequestV1Schema = z.discriminatedUnion(
	"command",
	[
		z.strictObject({
			schemaVersion: SchemaVersionV1Schema,
			command: z.enum(["stop", "restart", "retry_creation", "disable"]),
		}),
		z.strictObject({
			schemaVersion: SchemaVersionV1Schema,
			command: z.literal("upgrade_custom_image"),
			imageReference: nonEmptyString(),
		}),
	],
);

export const ApprovalDecisionRequestV1Schema = z.discriminatedUnion(
	"decision",
	[
		z.strictObject({
			schemaVersion: SchemaVersionV1Schema,
			decision: z.literal("approve"),
		}),
		z.strictObject({
			schemaVersion: SchemaVersionV1Schema,
			decision: z.literal("reject"),
			reason: nonEmptyString(),
		}),
	],
);

export const ConversationProjectionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	conversationId: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema,
	title: nonEmptyString().nullable(),
	status: z.enum(["ready", "active", "unavailable"]),
	selectedModelOptionId: OpaqueIdV1Schema.nullable(),
	selectedReasoningLevel: nonEmptyString().nullable(),
	lastConversationCursor: OpaqueCursorV1Schema.nullable(),
	createdAt: Rfc3339TimestampV1Schema,
	updatedAt: Rfc3339TimestampV1Schema,
});

const messageProjectionShape = {
	messageId: OpaqueIdV1Schema,
	role: z.enum(["user", "assistant"]),
	text: z.string(),
	executionId: OpaqueIdV1Schema.nullable(),
	replyToMessageId: OpaqueIdV1Schema.nullable(),
	answerVersion: z.number().int().positive().nullable(),
	isCurrentAnswer: z.boolean().nullable(),
	createdAt: Rfc3339TimestampV1Schema,
};

export const MessageProjectionV1Schema = z.discriminatedUnion("status", [
	z.strictObject({
		...messageProjectionShape,
		status: z.enum(["submitted", "processing", "completed", "cancelled"]),
		error: z.null(),
	}),
	z.strictObject({
		...messageProjectionShape,
		status: z.literal("failed"),
		error: PilotProtocolErrorV1Schema,
	}),
]);

export const ConversationDetailProjectionV1Schema = z.strictObject({
	conversation: ConversationProjectionV1Schema,
	messages: z.array(MessageProjectionV1Schema),
});

export const MessageCommandRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	text: nonEmptyString(),
});
export const RegenerateCommandRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	messageId: OpaqueIdV1Schema,
});
export const StopCommandRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	targetExecutionId: OpaqueIdV1Schema,
});
export const ModelSelectionUpdateRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	modelOptionId: OpaqueIdV1Schema,
	reasoningLevel: nonEmptyString(),
});

export const CommandAcceptedProjectionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	status: z.enum(["submitted", "processing", "already_finished"]),
	messageId: OpaqueIdV1Schema.nullable(),
	executionId: OpaqueIdV1Schema.nullable(),
});

export const ExecutionProcessSummaryV1Schema = z.discriminatedUnion("kind", [
	z.strictObject({
		occurredAt: Rfc3339TimestampV1Schema,
		kind: z.literal("status"),
		status: z.enum([
			"submitted",
			"processing",
			"completed",
			"failed",
			"cancelled",
			"unknown",
		]),
		summary: nonEmptyString(),
	}),
	z.strictObject({
		occurredAt: Rfc3339TimestampV1Schema,
		kind: z.literal("model_call"),
		modelId: nonEmptyString(),
		reasoningLevel: nonEmptyString().nullable(),
		status: z.enum(["succeeded", "failed"]),
		summary: nonEmptyString(),
	}),
	z.strictObject({
		occurredAt: Rfc3339TimestampV1Schema,
		kind: z.literal("connection_call"),
		callId: OpaqueIdV1Schema,
		providerId: OpaqueIdV1Schema,
		accountDisplay: nonEmptyString(),
		actionId: OpaqueIdV1Schema,
		actionVersion: nonEmptyString(),
		status: z.enum(["succeeded", "failed"]),
		summary: nonEmptyString(),
	}),
]);

const executionDetailProjectionShape = {
	schemaVersion: SchemaVersionV1Schema,
	executionId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	processSummary: z.array(ExecutionProcessSummaryV1Schema),
	startedAt: Rfc3339TimestampV1Schema.nullable(),
	finishedAt: Rfc3339TimestampV1Schema.nullable(),
};

export const ExecutionDetailProjectionV1Schema = z.discriminatedUnion(
	"status",
	[
		z.strictObject({
			...executionDetailProjectionShape,
			status: z.enum([
				"submitted",
				"processing",
				"completed",
				"cancelled",
				"unknown",
			]),
			error: z.null(),
		}),
		z.strictObject({
			...executionDetailProjectionShape,
			status: z.literal("failed"),
			error: PilotProtocolErrorV1Schema,
		}),
	],
);

export const PlatformAuditProjectionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	auditId: OpaqueIdV1Schema,
	action: nonEmptyString(),
	actor: BrowserUserProjectionV1Schema,
	subjectType: z.enum(["agent_application", "agent", "configuration", "grant"]),
	subjectId: OpaqueIdV1Schema,
	result: z.enum(["succeeded", "failed"]),
	summary: nonEmptyString(),
	occurredAt: Rfc3339TimestampV1Schema,
	traceId: TraceIdV1Schema,
});

const applicationPage = z.strictObject({
	items: z.array(AgentApplicationProjectionV1Schema),
	nextCursor: OpaqueCursorV1Schema.nullable(),
});
const agentPage = z.strictObject({
	items: z.array(AgentProjectionV1Schema),
	nextCursor: OpaqueCursorV1Schema.nullable(),
});
const conversationPage = z.strictObject({
	items: z.array(ConversationProjectionV1Schema),
	nextCursor: OpaqueCursorV1Schema.nullable(),
});
const auditPage = z.strictObject({
	items: z.array(PlatformAuditProjectionV1Schema),
	nextCursor: OpaqueCursorV1Schema.nullable(),
});
const applicationPath = z.strictObject({ applicationId: pathId() });
const agentPath = z.strictObject({ agentId: pathId() });
const conversationPath = z.strictObject({ conversationId: pathId() });
const executionPath = z.strictObject({
	conversationId: pathId(),
	executionId: pathId(),
});
const createConversationRequest = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
});

export const pilotBrowserHttpOpenApiPathsV1 = {
	"/api/v1/session": {
		get: {
			operationId: "getCurrentSession",
			responses: {
				"200": jsonResponse(
					"Current browser session",
					BrowserSessionProjectionV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/agent-applications": {
		get: {
			operationId: "listAgentApplications",
			requestParams: { query: pageQuery },
			responses: {
				"200": jsonResponse("Current user's applications", applicationPage),
				...errorResponses,
			},
		},
		post: {
			operationId: "createAgentApplication",
			requestParams: { header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(
				AgentApplicationCreateRequestV1Schema,
			),
			responses: {
				"201": jsonResponse(
					"Application submitted",
					AgentApplicationProjectionV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/agent-applications/{applicationId}": {
		get: {
			operationId: "getAgentApplication",
			requestParams: { path: applicationPath },
			responses: {
				"200": jsonResponse(
					"Application detail",
					AgentApplicationProjectionV1Schema,
				),
				...errorResponses,
			},
		},
		put: {
			operationId: "updateAgentApplication",
			requestParams: { path: applicationPath, header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(
				AgentApplicationUpdateRequestV1Schema,
			),
			responses: {
				"200": jsonResponse(
					"Application updated",
					AgentApplicationProjectionV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/agent-applications/{applicationId}/withdraw": {
		post: {
			operationId: "withdrawAgentApplication",
			requestParams: { path: applicationPath, header: idempotencyHeader },
			responses: {
				"200": jsonResponse(
					"Application withdrawn",
					AgentApplicationProjectionV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/admin/agent-applications": {
		get: {
			operationId: "listPendingAgentApplications",
			requestParams: { query: pageQuery },
			responses: {
				"200": jsonResponse("Pending applications", applicationPage),
				...errorResponses,
			},
		},
	},
	"/api/v1/admin/agent-applications/{applicationId}/decision": {
		post: {
			operationId: "decideAgentApplication",
			requestParams: { path: applicationPath, header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(ApprovalDecisionRequestV1Schema),
			responses: {
				"200": jsonResponse(
					"Application decision",
					AgentApplicationProjectionV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/agents": {
		get: {
			operationId: "listAgents",
			requestParams: { query: pageQuery },
			responses: {
				"200": jsonResponse("Visible agents", agentPage),
				...errorResponses,
			},
		},
	},
	"/api/v1/agents/{agentId}": {
		get: {
			operationId: "getAgent",
			requestParams: { path: agentPath },
			responses: {
				"200": jsonResponse("Agent detail", AgentProjectionV1Schema),
				...errorResponses,
			},
		},
	},
	"/api/v1/agents/{agentId}/configuration": {
		put: {
			operationId: "updateAgentConfiguration",
			requestParams: { path: agentPath, header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(
				AgentConfigurationUpdateRequestV1Schema,
			),
			responses: {
				"200": jsonResponse("Agent configuration", AgentProjectionV1Schema),
				...errorResponses,
			},
		},
	},
	"/api/v1/agents/{agentId}/lifecycle": {
		post: {
			operationId: "commandAgentLifecycle",
			requestParams: { path: agentPath, header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(
				AgentLifecycleCommandRequestV1Schema,
			),
			responses: {
				"202": jsonResponse(
					"Lifecycle command accepted",
					AgentProjectionV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/agents/{agentId}/conversations": {
		get: {
			operationId: "listConversations",
			requestParams: { path: agentPath, query: pageQuery },
			responses: {
				"200": jsonResponse("Conversation history", conversationPage),
				...errorResponses,
			},
		},
		post: {
			operationId: "createConversation",
			requestParams: { path: agentPath, header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(createConversationRequest),
			responses: {
				"201": jsonResponse(
					"Conversation created",
					ConversationProjectionV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/conversations/{conversationId}": {
		get: {
			operationId: "getConversation",
			requestParams: { path: conversationPath },
			responses: {
				"200": jsonResponse(
					"Conversation timeline",
					ConversationDetailProjectionV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/conversations/{conversationId}/messages": {
		post: {
			operationId: "submitMessage",
			requestParams: { path: conversationPath, header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(MessageCommandRequestV1Schema),
			responses: {
				"202": jsonResponse(
					"Message accepted",
					CommandAcceptedProjectionV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/conversations/{conversationId}/regenerations": {
		post: {
			operationId: "regenerateAnswer",
			requestParams: { path: conversationPath, header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(RegenerateCommandRequestV1Schema),
			responses: {
				"202": jsonResponse(
					"Regeneration accepted",
					CommandAcceptedProjectionV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/conversations/{conversationId}/stops": {
		post: {
			operationId: "stopExecution",
			requestParams: { path: conversationPath, header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(StopCommandRequestV1Schema),
			responses: {
				"202": jsonResponse("Stop accepted", CommandAcceptedProjectionV1Schema),
				...errorResponses,
			},
		},
	},
	"/api/v1/conversations/{conversationId}/model-selection": {
		put: {
			operationId: "updateConversationModelSelection",
			requestParams: { path: conversationPath, header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(ModelSelectionUpdateRequestV1Schema),
			responses: {
				"200": jsonResponse(
					"Model selection updated",
					ConversationProjectionV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/conversations/{conversationId}/executions/{executionId}": {
		get: {
			operationId: "getExecutionDetail",
			requestParams: { path: executionPath },
			responses: {
				"200": jsonResponse(
					"Execution detail",
					ExecutionDetailProjectionV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/admin/audit": {
		get: {
			operationId: "listPlatformAudit",
			requestParams: { query: pageQuery },
			responses: {
				"200": jsonResponse("Platform audit", auditPage),
				...errorResponses,
			},
		},
	},
} as const;

export const pilotBrowserOpenApiPathsV1 = {
	...pilotBrowserHttpOpenApiPathsV1,
	...pilotBrowserSseOpenApiPathsV1,
} as const;

export const pilotBrowserSchemasV1 = {
	ActionSelectionV1: ActionSelectionV1Schema,
	AgentApplicationCreateRequestV1: AgentApplicationCreateRequestV1Schema,
	AgentApplicationProjectionV1: AgentApplicationProjectionV1Schema,
	AgentApplicationUpdateRequestV1: AgentApplicationUpdateRequestV1Schema,
	AgentConfigurationProjectionV1: AgentConfigurationProjectionV1Schema,
	AgentConfigurationUpdateRequestV1: AgentConfigurationUpdateRequestV1Schema,
	AgentLifecycleCommandRequestV1: AgentLifecycleCommandRequestV1Schema,
	AgentProjectionV1: AgentProjectionV1Schema,
	AgentResourceProfileProjectionV1: AgentResourceProfileProjectionV1Schema,
	ApprovalDecisionRequestV1: ApprovalDecisionRequestV1Schema,
	BrowserSessionProjectionV1: BrowserSessionProjectionV1Schema,
	CommandAcceptedProjectionV1: CommandAcceptedProjectionV1Schema,
	ChannelBindingInputV1: ChannelBindingInputV1Schema,
	ChannelBindingProjectionV1: ChannelBindingProjectionV1Schema,
	ConversationDetailProjectionV1: ConversationDetailProjectionV1Schema,
	ConversationProjectionV1: ConversationProjectionV1Schema,
	ExecutionDetailProjectionV1: ExecutionDetailProjectionV1Schema,
	ExecutionProcessSummaryV1: ExecutionProcessSummaryV1Schema,
	MessageCommandRequestV1: MessageCommandRequestV1Schema,
	MessageProjectionV1: MessageProjectionV1Schema,
	ModelSelectionUpdateRequestV1: ModelSelectionUpdateRequestV1Schema,
	PilotInternalErrorV1: PilotInternalErrorV1Schema,
	PilotProtocolErrorV1: PilotProtocolErrorV1Schema,
	PlatformAuditProjectionV1: PlatformAuditProjectionV1Schema,
	RegenerateCommandRequestV1: RegenerateCommandRequestV1Schema,
	StopCommandRequestV1: StopCommandRequestV1Schema,
};
