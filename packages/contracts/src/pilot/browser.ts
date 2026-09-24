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
const agentListQuery = pageQuery.extend({
	scope: z.literal("owner").optional(),
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
	z.strictObject({
		kind: z.literal("application"),
		applicationId: OpaqueIdV1Schema,
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
		.regex(/^https:\/\/(?![^/?#]*@)[^?#]+$/)
		.nullable(),
});

export const AgentDirectCreationProjectionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	applicationId: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema,
	status: z.literal("creating"),
});

export const ApiCredentialScopeV1Schema = z.enum([
	"agent:create",
	"agent:manage",
	"agent:use",
	"agent:read",
]);

export const ApiPrincipalV1Schema = z.strictObject({
	kind: z.enum(["user", "application"]),
	id: OpaqueIdV1Schema,
});

export const ApiCredentialMetadataProjectionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	credentialId: OpaqueIdV1Schema,
	principal: ApiPrincipalV1Schema,
	scopes: z.array(ApiCredentialScopeV1Schema).min(1),
	expiresAt: Rfc3339TimestampV1Schema.nullable(),
	revokedAt: Rfc3339TimestampV1Schema.nullable(),
	createdAt: Rfc3339TimestampV1Schema,
});

export const ApiCredentialIssueRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	scopes: z.array(ApiCredentialScopeV1Schema).min(1),
	expiresAt: Rfc3339TimestampV1Schema.nullable(),
	recipient: ApiPrincipalV1Schema.optional(),
});

export const ApiCredentialIssueProjectionV1Schema = z.strictObject({
	metadata: ApiCredentialMetadataProjectionV1Schema,
	credential: nonEmptyString(),
});

/** Application credential values are only present when the recipient is the caller. */
export const ApiApplicationCredentialIssueProjectionV1Schema = z.union([
	ApiCredentialIssueProjectionV1Schema,
	z.strictObject({ metadata: ApiCredentialMetadataProjectionV1Schema }),
]);

export const ApiApplicationCreateRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	name: nonEmptyString().max(200),
});

export const ApiApplicationProjectionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	applicationId: OpaqueIdV1Schema,
	name: nonEmptyString(),
	responsibleUserId: OpaqueIdV1Schema,
	status: z.enum(["active", "disabled"]),
	authorizationRevision: nonEmptyString(),
});

export const ApiAgentGrantRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	principal: ApiPrincipalV1Schema,
	grantType: z.enum(["manage", "use"]),
});

export const ApiAgentGrantProjectionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	agentId: OpaqueIdV1Schema,
	principal: ApiPrincipalV1Schema,
	grantType: z.enum(["manage", "use"]),
	authorizationRevision: nonEmptyString(),
	revokedAt: Rfc3339TimestampV1Schema.nullable(),
});

const apiCredentialPageV1 = z.strictObject({
	items: z.array(ApiCredentialMetadataProjectionV1Schema),
	nextCursor: OpaqueCursorV1Schema.nullable(),
});

const apiApplicationPageV1 = z.strictObject({
	items: z.array(ApiApplicationProjectionV1Schema),
	nextCursor: OpaqueCursorV1Schema.nullable(),
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

// Independent Connection authorization retires Platform-owned Action selection.
// Keep the published V1 schemas intact for historical consumers.
export const AgentApplicationCreateRequestV2Schema =
	AgentApplicationCreateRequestV1Schema.omit({ actions: true }).extend({
		schemaVersion: z.literal(2),
	});
export const AgentApplicationUpdateRequestV2Schema =
	AgentApplicationUpdateRequestV1Schema.omit({ actions: true }).extend({
		schemaVersion: z.literal(2),
	});
export const AgentConfigurationUpdateRequestV2Schema =
	AgentConfigurationUpdateRequestV1Schema.omit({ actions: true }).extend({
		schemaVersion: z.literal(2),
	});
export const AgentConfigurationProjectionV2Schema =
	AgentConfigurationProjectionV1Schema.omit({ actions: true });
export const AgentApplicationProjectionV2Schema =
	AgentApplicationProjectionV1Schema.extend({
		schemaVersion: z.literal(2),
		configuration: AgentConfigurationProjectionV2Schema,
	});
export const AgentProjectionV2Schema = AgentProjectionV1Schema.extend({
	schemaVersion: z.literal(2),
	configuration: AgentConfigurationProjectionV2Schema,
});

export const AgentLifecycleCommandRequestV1Schema = z.discriminatedUnion(
	"command",
	[
		z.strictObject({
			schemaVersion: SchemaVersionV1Schema,
			command: z.enum([
				"start",
				"stop",
				"restart",
				"retry_creation",
				"disable",
			]),
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
	attachments: z.array(OpaqueIdV1Schema).max(32).optional(),
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
	z.strictObject({
		occurredAt: Rfc3339TimestampV1Schema,
		kind: z.literal("agent_summary"),
		category: z.enum(["status", "model_call", "connection_call"]),
		summary: nonEmptyString(),
		callId: OpaqueIdV1Schema.optional(),
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
	actor: z.union([
		BrowserUserProjectionV1Schema,
		z.strictObject({
			kind: z.literal("application"),
			actorId: OpaqueIdV1Schema,
		}),
	]),
	subjectType: z.enum(["agent_application", "agent", "configuration", "grant"]),
	subjectId: OpaqueIdV1Schema,
	result: z.enum(["succeeded", "failed"]),
	summary: nonEmptyString(),
	occurredAt: Rfc3339TimestampV1Schema,
	traceId: TraceIdV1Schema,
});

export const PlatformAuditProjectionV2Schema =
	PlatformAuditProjectionV1Schema.extend({
		schemaVersion: z.literal(2),
		actor: z.union([
			BrowserUserProjectionV1Schema,
			z.strictObject({
				kind: z.literal("application"),
				actorId: OpaqueIdV1Schema,
			}),
			z.strictObject({
				kind: z.literal("system"),
				actorId: OpaqueIdV1Schema,
			}),
		]),
	});

const applicationPage = z.strictObject({
	items: z.array(AgentApplicationProjectionV1Schema),
	nextCursor: OpaqueCursorV1Schema.nullable(),
});
const agentPage = z.strictObject({
	items: z.array(AgentProjectionV1Schema),
	nextCursor: OpaqueCursorV1Schema.nullable(),
});
export const ConversationPageV1Schema = z.strictObject({
	items: z.array(ConversationProjectionV1Schema),
	nextCursor: OpaqueCursorV1Schema.nullable(),
});
const applicationPageV2 = applicationPage.extend({
	items: z.array(AgentApplicationProjectionV2Schema),
});
const agentPageV2 = agentPage.extend({
	items: z.array(AgentProjectionV2Schema),
});
const auditPage = z.strictObject({
	items: z.array(PlatformAuditProjectionV1Schema),
	nextCursor: OpaqueCursorV1Schema.nullable(),
});
const auditPageV2 = z.strictObject({
	items: z.array(PlatformAuditProjectionV2Schema),
	nextCursor: OpaqueCursorV1Schema.nullable(),
});
const applicationPath = z.strictObject({ applicationId: pathId() });
const agentPath = z.strictObject({ agentId: pathId() });
const credentialPath = z.strictObject({ credentialId: pathId() });
const applicationCredentialPath = z.strictObject({
	applicationId: pathId(),
	credentialId: pathId(),
});
const conversationPath = z.strictObject({ conversationId: pathId() });
const executionPath = z.strictObject({
	conversationId: pathId(),
	executionId: pathId(),
});
export const CreateConversationRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
});

export const WecomReceiptProjectionV1Schema = z.strictObject({
	receiptId: OpaqueIdV1Schema,
	status: z.enum(["accepted", "busy", "unavailable"]),
	conversationId: OpaqueIdV1Schema.nullable(),
	executionId: OpaqueIdV1Schema.nullable(),
	deliveryStatus: z.enum([
		"pending",
		"claimed",
		"sending",
		"sent",
		"failed",
		"unknown",
		"cancelled",
		"expired",
		"abandoned",
	]),
});
const wecomReceiptPath = z.strictObject({ receiptId: pathId() });
export const WecomSetupProjectionV1Schema = z.strictObject({
	sessionId: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema,
	configurationRevision: z.number().int().positive(),
	expiresAt: Rfc3339TimestampV1Schema,
	status: z.enum([
		"awaiting_input",
		"verifying",
		"active",
		"auth_failed",
		"conflict",
		"cancelled",
		"expired",
	]),
});
const wecomSetupState = z.string().min(1).max(1024);
export const WecomSetupCredentialsV1Schema = z.strictObject({
	state: wecomSetupState,
	botId: z.string().min(1).max(1024),
	secret: z.string().min(1).max(1024).meta({ writeOnly: true }),
	takeoverConfirmed: z.literal(true),
});
const wecomSetupPath = z.strictObject({
	agentId: pathId(),
	sessionId: pathId(),
});
export const pilotBrowserHttpOpenApiPathsV1 = {
	"/api/v1/api-credentials": {
		get: {
			operationId: "listApiCredentials",
			requestParams: { query: pageQuery },
			responses: {
				"200": jsonResponse("API credentials", apiCredentialPageV1),
				...errorResponses,
			},
		},
		post: {
			operationId: "issueApiCredential",
			requestBody: requiredJsonRequestBody(ApiCredentialIssueRequestV1Schema),
			responses: {
				"201": jsonResponse(
					"Issued API credential",
					ApiCredentialIssueProjectionV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/api-credentials/{credentialId}": {
		delete: {
			operationId: "revokeApiCredential",
			requestParams: { path: credentialPath },
			responses: {
				"204": { description: "API credential revoked" },
				...errorResponses,
			},
		},
	},
	"/api/v1/applications": {
		get: {
			operationId: "listApiApplications",
			requestParams: { query: pageQuery },
			responses: {
				"200": jsonResponse("API applications", apiApplicationPageV1),
				...errorResponses,
			},
		},
		post: {
			operationId: "createApiApplication",
			requestBody: requiredJsonRequestBody(ApiApplicationCreateRequestV1Schema),
			responses: {
				"201": jsonResponse(
					"API application",
					ApiApplicationProjectionV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/applications/{applicationId}/credentials": {
		get: {
			operationId: "listApplicationCredentials",
			requestParams: { path: applicationPath, query: pageQuery },
			responses: {
				"200": jsonResponse(
					"Application credential metadata",
					apiCredentialPageV1,
				),
				...errorResponses,
			},
		},
		post: {
			operationId: "issueApplicationCredential",
			requestParams: { path: applicationPath },
			requestBody: requiredJsonRequestBody(ApiCredentialIssueRequestV1Schema),
			responses: {
				"201": jsonResponse(
					"Issued application credential",
					ApiApplicationCredentialIssueProjectionV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/applications/{applicationId}/credentials/{credentialId}": {
		delete: {
			operationId: "revokeApplicationCredential",
			requestParams: { path: applicationCredentialPath },
			responses: {
				"204": { description: "Application credential revoked" },
				...errorResponses,
			},
		},
	},
	"/api/v1/applications/{applicationId}/credential-delivery": {
		post: {
			operationId: "grantApplicationCredentialDelivery",
			requestParams: { path: applicationPath },
			requestBody: requiredJsonRequestBody(ApiPrincipalV1Schema),
			responses: {
				"204": { description: "Credential delivery granted" },
				...errorResponses,
			},
		},
		delete: {
			operationId: "revokeApplicationCredentialDelivery",
			requestParams: { path: applicationPath },
			requestBody: requiredJsonRequestBody(ApiPrincipalV1Schema),
			responses: {
				"204": { description: "Credential delivery revoked" },
				...errorResponses,
			},
		},
	},
	"/api/v1/agents/{agentId}/wecom-bot": {
		get: {
			operationId: "getWecomBotConnection",
			requestParams: { path: z.strictObject({ agentId: pathId() }) },
			responses: {
				"200": jsonResponse(
					"Owner bot connection status",
					z.strictObject({
						status: z.enum([
							"not_configured",
							"callback",
							"verifying",
							"connected",
							"disconnected",
							"auth_failed",
						]),
					}),
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/agents/{agentId}/wecom-setup": {
		post: {
			operationId: "beginWecomSetup",
			requestParams: { path: z.strictObject({ agentId: pathId() }) },
			responses: {
				"200": jsonResponse(
					"Owner configuration session",
					WecomSetupProjectionV1Schema.extend({
						state: wecomSetupState,
						qrAvailable: z.literal(false),
						qrUnavailableReason: z.literal(
							"authorization_correlation_unverified",
						),
					}),
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/agents/{agentId}/wecom-setup/{sessionId}": {
		get: {
			operationId: "getWecomSetup",
			requestParams: { path: wecomSetupPath },
			responses: {
				"200": jsonResponse(
					"Owner configuration status",
					WecomSetupProjectionV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/agents/{agentId}/wecom-setup/{sessionId}/credentials": {
		post: {
			operationId: "submitWecomCredentials",
			requestParams: { path: wecomSetupPath },
			requestBody: requiredJsonRequestBody(WecomSetupCredentialsV1Schema),
			responses: {
				"200": jsonResponse(
					"Candidate pending Worker validation",
					WecomSetupProjectionV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/agents/{agentId}/wecom-setup/{sessionId}/cancel": {
		post: {
			operationId: "cancelWecomSetup",
			requestParams: { path: wecomSetupPath },
			responses: {
				"200": jsonResponse(
					"Cancelled configuration session",
					WecomSetupProjectionV1Schema,
				),
				...errorResponses,
			},
		},
	},

	"/api/v1/wecom/receipts": {
		get: {
			operationId: "listWecomReceipts",
			requestParams: {
				query: z.strictObject({ cursor: OpaqueCursorV1Schema.optional() }),
			},
			responses: {
				"200": jsonResponse(
					"Current sender's delivery statuses",
					z.strictObject({
						items: z.array(WecomReceiptProjectionV1Schema),
						nextCursor: OpaqueCursorV1Schema.nullable(),
					}),
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/wecom/receipts/{receiptId}": {
		get: {
			operationId: "getWecomReceipt",
			requestParams: { path: wecomReceiptPath },
			responses: {
				"200": jsonResponse(
					"Current sender's delivery status",
					WecomReceiptProjectionV1Schema.extend({
						schemaVersion: SchemaVersionV1Schema,
					}),
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/wecom/receipts/{receiptId}/abandon": {
		post: {
			operationId: "abandonUnknownWecomDelivery",
			requestParams: { path: wecomReceiptPath },
			responses: {
				"200": jsonResponse(
					"Abandoned without resending",
					z.strictObject({
						schemaVersion: SchemaVersionV1Schema,
						status: z.literal("abandoned"),
					}),
				),
				...errorResponses,
			},
		},
	},

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
		post: {
			operationId: "createAgentDirectly",
			requestParams: { header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(
				AgentApplicationCreateRequestV2Schema,
			),
			responses: {
				"201": jsonResponse(
					"Agent creation accepted",
					AgentDirectCreationProjectionV1Schema,
				),
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
	"/api/v1/agents/{agentId}/grants": {
		post: {
			operationId: "grantAgentPrincipal",
			requestParams: { path: agentPath },
			requestBody: requiredJsonRequestBody(ApiAgentGrantRequestV1Schema),
			responses: {
				"200": jsonResponse(
					"Agent principal grant",
					ApiAgentGrantProjectionV1Schema,
				),
				...errorResponses,
			},
		},
		delete: {
			operationId: "revokeAgentPrincipalGrant",
			requestParams: { path: agentPath },
			requestBody: requiredJsonRequestBody(ApiAgentGrantRequestV1Schema),
			responses: {
				"204": { description: "Agent principal grant revoked" },
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
				"200": jsonResponse("Conversation history", ConversationPageV1Schema),
				...errorResponses,
			},
		},
		post: {
			operationId: "createConversation",
			requestParams: { path: agentPath, header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(CreateConversationRequestV1Schema),
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

export const pilotBrowserOpenApiPathsV1 = pilotBrowserHttpOpenApiPathsV1;

export const pilotBrowserHttpOpenApiPathsV2 = {
	"/api/v2/agent-applications": {
		get: {
			operationId: "listAgentApplicationsV2",
			requestParams: { query: pageQuery },
			responses: {
				"200": jsonResponse("Current user's applications", applicationPageV2),
				...errorResponses,
			},
		},
		post: {
			operationId: "createAgentApplicationV2",
			requestParams: { header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(
				AgentApplicationCreateRequestV2Schema,
			),
			responses: {
				"201": jsonResponse(
					"Application submitted",
					AgentApplicationProjectionV2Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v2/agent-applications/{applicationId}": {
		get: {
			operationId: "getAgentApplicationV2",
			requestParams: { path: applicationPath },
			responses: {
				"200": jsonResponse(
					"Application detail",
					AgentApplicationProjectionV2Schema,
				),
				...errorResponses,
			},
		},
		put: {
			operationId: "updateAgentApplicationV2",
			requestParams: { path: applicationPath, header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(
				AgentApplicationUpdateRequestV2Schema,
			),
			responses: {
				"200": jsonResponse(
					"Application updated",
					AgentApplicationProjectionV2Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v2/agent-applications/{applicationId}/withdraw": {
		post: {
			operationId: "withdrawAgentApplicationV2",
			requestParams: { path: applicationPath, header: idempotencyHeader },
			responses: {
				"200": jsonResponse(
					"Application withdrawn",
					AgentApplicationProjectionV2Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v2/admin/agent-applications": {
		get: {
			operationId: "listPendingAgentApplicationsV2",
			requestParams: { query: pageQuery },
			responses: {
				"200": jsonResponse("Pending applications", applicationPageV2),
				...errorResponses,
			},
		},
	},
	"/api/v2/admin/agent-applications/{applicationId}/decision": {
		post: {
			operationId: "decideAgentApplicationV2",
			requestParams: { path: applicationPath, header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(ApprovalDecisionRequestV1Schema),
			responses: {
				"200": jsonResponse(
					"Application decision",
					AgentApplicationProjectionV2Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v2/agents": {
		get: {
			operationId: "listAgentsV2",
			requestParams: { query: agentListQuery },
			responses: {
				"200": jsonResponse("Visible agents", agentPageV2),
				...errorResponses,
			},
		},
	},
	"/api/v2/agents/{agentId}": {
		get: {
			operationId: "getAgentV2",
			requestParams: { path: agentPath },
			responses: {
				"200": jsonResponse("Agent detail", AgentProjectionV2Schema),
				...errorResponses,
			},
		},
	},
	"/api/v2/agents/{agentId}/configuration": {
		put: {
			operationId: "updateAgentConfigurationV2",
			requestParams: { path: agentPath, header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(
				AgentConfigurationUpdateRequestV2Schema,
			),
			responses: {
				"200": jsonResponse("Agent configuration", AgentProjectionV2Schema),
				...errorResponses,
			},
		},
	},
	"/api/v2/agents/{agentId}/lifecycle": {
		post: {
			operationId: "commandAgentLifecycleV2",
			requestParams: { path: agentPath, header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(
				AgentLifecycleCommandRequestV1Schema,
			),
			responses: {
				"202": jsonResponse(
					"Lifecycle command accepted",
					AgentProjectionV2Schema,
				),
				...errorResponses,
			},
		},
	},

	"/api/v2/admin/audit": {
		get: {
			operationId: "listPlatformAuditV2",
			requestParams: { query: pageQuery },
			responses: {
				"200": jsonResponse("Platform audit", auditPageV2),
				...errorResponses,
			},
		},
	},
} as const;

export const pilotBrowserOpenApiPathsV2 = pilotBrowserHttpOpenApiPathsV2;

export const pilotBrowserSchemasV1 = {
	ApiAgentGrantProjectionV1: ApiAgentGrantProjectionV1Schema,
	ApiAgentGrantRequestV1: ApiAgentGrantRequestV1Schema,
	ApiApplicationCreateRequestV1: ApiApplicationCreateRequestV1Schema,
	ApiApplicationCredentialIssueProjectionV1:
		ApiApplicationCredentialIssueProjectionV1Schema,
	ApiApplicationProjectionV1: ApiApplicationProjectionV1Schema,
	ApiCredentialIssueProjectionV1: ApiCredentialIssueProjectionV1Schema,
	ApiCredentialIssueRequestV1: ApiCredentialIssueRequestV1Schema,
	ApiCredentialMetadataProjectionV1: ApiCredentialMetadataProjectionV1Schema,
	ApiCredentialScopeV1: ApiCredentialScopeV1Schema,
	ApiPrincipalV1: ApiPrincipalV1Schema,
	ActionSelectionV1: ActionSelectionV1Schema,
	AgentApplicationCreateRequestV1: AgentApplicationCreateRequestV1Schema,
	AgentApplicationCreateRequestV2: AgentApplicationCreateRequestV2Schema,
	AgentApplicationProjectionV1: AgentApplicationProjectionV1Schema,
	AgentDirectCreationProjectionV1: AgentDirectCreationProjectionV1Schema,
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

export const pilotBrowserSchemasV2 = {
	AgentLifecycleCommandRequestV1: AgentLifecycleCommandRequestV1Schema,
	ApprovalDecisionRequestV1: ApprovalDecisionRequestV1Schema,
	AgentApplicationCreateRequestV2: AgentApplicationCreateRequestV2Schema,
	AgentApplicationUpdateRequestV2: AgentApplicationUpdateRequestV2Schema,
	AgentConfigurationUpdateRequestV2: AgentConfigurationUpdateRequestV2Schema,
	AgentApplicationProjectionV2: AgentApplicationProjectionV2Schema,
	AgentConfigurationProjectionV2: AgentConfigurationProjectionV2Schema,
	AgentProjectionV2: AgentProjectionV2Schema,

	PilotInternalErrorV1: PilotInternalErrorV1Schema,
	PilotProtocolErrorV1: PilotProtocolErrorV1Schema,
	PlatformAuditProjectionV2: PlatformAuditProjectionV2Schema,
};
