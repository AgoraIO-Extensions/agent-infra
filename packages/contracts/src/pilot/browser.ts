import { z } from "zod";
import {
	FileLimitDeclarationProjectionV1Schema,
	FileLimitDeclarationResponseV1Schema,
	FileLimitDeclarationWriteRequestV1Schema,
} from "../files.ts";
import {
	IdempotencyKeyV1Schema,
	OpaqueCursorV1Schema,
	OpaqueIdV1Schema,
	Rfc3339TimestampV1Schema,
	SchemaVersionV1Schema,
	TraceIdV1Schema,
} from "../index.ts";
import { BrowserCapabilityProjectionV1Schema } from "../runtime/browser-capability.ts";
import { RuntimeSkillCapabilityV1Schema } from "../runtime/events.ts";
import {
	AgentApiLifecycleAcceptedResponseV1Schema,
	AgentApiLifecycleRequestV1Schema,
	AgentApiLifecycleResponseV1Schema,
	AgentApiStateResponseV1Schema,
} from "./agent-api-lifecycle.ts";
import {
	AgentApplicationManagerRequestV1Schema,
	AgentApplicationManagerResponseV1Schema,
} from "./agent-application-manager.ts";
import {
	AgentApplicationModelCandidatesRequestV2Schema,
	AgentApplicationModelCandidatesResponseV2Schema,
	AgentDefaultRelayKeyCandidatesRequestV1Schema,
	AgentDefaultRelayKeyCandidatesV1Schema,
	AgentDefaultRelayKeyDisplayCandidatesV2Schema,
	AgentDefaultRelayKeyReplaceRequestV1Schema,
	AgentDefaultRelayKeySavedCandidatesV1Schema,
	AgentDefaultRelayKeySavedDisplayCandidatesV2Schema,
	AgentDefaultRelayKeyStateV1Schema,
} from "./agent-default-relay-key.ts";
import {
	AgentUserManageGrantRequestV1Schema,
	AgentUserManageGrantResponseV1Schema,
	AgentUserManageRevokeRequestV1Schema,
	AgentUserManageRevokeResponseV1Schema,
} from "./agent-user-manage-grants.ts";
import {
	AgentUserUseGrantRequestV1Schema,
	AgentUserUseGrantResponseV1Schema,
	AgentUserUseRevokeRequestV1Schema,
	AgentUserUseRevokeResponseV1Schema,
} from "./agent-user-use-grants.ts";
import {
	ApplicationApiCredentialListQueryV1Schema,
	ApplicationApiCredentialPageV1Schema,
	ApplicationApiCredentialRequestV1Schema,
	ApplicationApiCredentialResponseV1Schema,
	ApplicationApiCredentialRevocationV1Schema,
} from "./application-api-credentials.ts";
import {
	ApplicationMaterialGrantRequestV1Schema,
	ApplicationMaterialGrantResponseV1Schema,
	ApplicationMaterialGrantRevokeRequestV1Schema,
} from "./application-material-grants.ts";
import {
	ApplicationDisableRequestV1Schema,
	ApplicationMetadataV1Schema,
	ApplicationRegistrationRequestV1Schema,
	ApplicationRegistrationResponseV1Schema,
} from "./application-registration.ts";
import {
	PilotInternalErrorV1Schema,
	PilotProtocolErrorV1Schema,
} from "./errors.ts";
import {
	MultiServiceAgentSourceV1Schema,
	MultiServiceResourceCapV1Schema,
	MultiServiceResourceProfileProjectionV1Schema,
} from "./multi-service.ts";
import {
	PersonalApiCredentialIssueRequestV1Schema,
	PersonalApiCredentialIssueResponseV1Schema,
	PersonalApiCredentialListQueryV1Schema,
	PersonalApiCredentialMetadataV1Schema,
	PersonalApiCredentialNarrowRequestV1Schema,
	PersonalApiCredentialNarrowResponseV1Schema,
	PersonalApiCredentialPageV1Schema,
	PersonalApiCredentialRevokeResponseV1Schema,
} from "./personal-api-credentials.ts";
import {
	PersonalRelayKeyReplaceRequestV1Schema,
	PersonalRelayKeyRevokeRequestV1Schema,
	PersonalRelayKeyStateV1Schema,
} from "./personal-relay-key.ts";
import { WecomApplicationCredentialsV1Schema } from "./wecom-application.ts";

const nonEmptyString = () => z.string().min(1);
const idArray = () => z.array(OpaqueIdV1Schema);
const pathId = () => OpaqueIdV1Schema;
const idempotencyHeader = z.strictObject({
	"Idempotency-Key": IdempotencyKeyV1Schema,
});
const personalCredentialSecurity: Record<string, never[]>[] = [
	{ PlatformSession: [] },
];
const agentApiCredentialSecurity: Record<string, never[]>[] = [
	{ platformApiCredential: [] },
];
const agentListSecurity: Record<string, never[]>[] = [
	{ PlatformSession: [] },
	{ platformApiCredential: [] },
];
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

export const ConnectionCapabilityProjectionV1Schema = z.discriminatedUnion(
	"status",
	[
		z.strictObject({
			status: z.literal("available"),
			schemaVersion: z.literal(1),
			publicOrigin: z.string().url(),
			mcpPath: z.string().startsWith("/"),
			webPath: z.string().startsWith("/"),
			configFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
		}),
		z.strictObject({
			status: z.literal("unavailable"),
			schemaVersion: z.literal(1),
			reason: z.enum(["missing", "invalid", "unapproved", "unavailable"]),
		}),
	],
);

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
	MultiServiceAgentSourceV1Schema,
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
	updatedAt: Rfc3339TimestampV1Schema.optional(),
	applicant: BrowserUserProjectionV1Schema.nullable().optional(),
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
		nativeMetadata: z.boolean().optional(),
		skills: z.array(RuntimeSkillCapabilityV1Schema).max(150).optional(),
		browser: BrowserCapabilityProjectionV1Schema.optional(),
	}),
	interactionUrl: z
		.string()
		.url()
		.regex(/^https:\/\/(?![^/?#]*@)[^?#]+$/)
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

// Independent Connection authorization retires Platform-owned Action selection.
// Keep the published V1 schemas intact for historical consumers.
export const AgentApplicationCreateRequestV2Schema =
	AgentApplicationCreateRequestV1Schema.omit({ actions: true }).extend({
		schemaVersion: z.literal(2),
		source: z.union([
			z.strictObject({
				kind: z.literal("standard"),
				templateId: OpaqueIdV1Schema,
				templateRevision: OpaqueIdV1Schema.optional(),
			}),
			...AgentSourceInputV1Schema.options.slice(1),
		]),
		defaultRelayKey: nonEmptyString().meta({ writeOnly: true }).optional(),
	});

const [
	standardSource,
	selfManagedSource,
	platformAdapterSource,
	multiServiceSource,
] = AgentSourceInputV1Schema.options;
const AgentApiCreationCustomRequestV1Schema =
	AgentApplicationCreateRequestV2Schema.omit({
		modelConfiguration: true,
	}).extend({
		source: z.union([
			selfManagedSource,
			platformAdapterSource,
			multiServiceSource,
		]),
	});
const AgentApiCreationStandardRequestV1Schema =
	AgentApplicationCreateRequestV2Schema.extend({
		schemaVersion: z.literal(3),
		source: standardSource,
		modelConfiguration: ModelConfigurationInputV1Schema.extend({
			options: z
				.array(ModelOptionInputV1Schema.omit({ credentialValue: true }))
				.min(1),
		}),
		defaultRelayKey: z
			.string()
			.min(16)
			.max(8192)
			.regex(/^[\x21-\x7e]+$/)
			.meta({ writeOnly: true }),
	});
export const AgentApiCreationRequestV1Schema = z.union([
	AgentApiCreationCustomRequestV1Schema,
	AgentApiCreationStandardRequestV1Schema,
]);
export const AgentApiCreationResponseV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	agentId: OpaqueIdV1Schema,
	status: z.enum([
		"creating",
		"available",
		"stopped",
		"creation_failed",
		"disabled",
	]),
	revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
	replayed: z.boolean(),
});
/**
 * 带默认 Relay Key 的标准 Agent 更换模型集合：必须同时重新提交 Key（服务端按 Key 实际
 * 可见的模型校验，API 没有解密私钥）并带上调用方看到的配置修订和 Key 版本。三者要么
 * 同时出现、同时省略；`modelConfiguration` 此时不得携带 `credentialValue`。
 */
const defaultRelayKeyReplacementShape = {
	defaultRelayKey: z
		.string()
		.min(16)
		.max(8192)
		.regex(/^[\x21-\x7e]+$/)
		.meta({ writeOnly: true })
		.optional(),
	expectedConfigurationRevision: z.number().int().positive().optional(),
	expectedKeyVersion: z.number().int().positive().nullable().optional(),
};
export const AgentApplicationUpdateRequestV2Schema =
	AgentApplicationUpdateRequestV1Schema.omit({ actions: true }).extend({
		schemaVersion: z.literal(2),
		source: z.union([
			z.strictObject({
				kind: z.literal("standard"),
				templateId: OpaqueIdV1Schema,
				templateRevision: OpaqueIdV1Schema.optional(),
			}),
			...AgentSourceInputV1Schema.options.slice(1),
		]),
		...defaultRelayKeyReplacementShape,
	});
const AgentConfigurationUpdateRequestV2BaseSchema =
	AgentConfigurationUpdateRequestV1Schema.omit({ actions: true }).extend({
		schemaVersion: z.literal(2),
		...defaultRelayKeyReplacementShape,
	});
export const AgentConfigurationUpdateRequestV4Schema =
	AgentConfigurationUpdateRequestV1Schema.omit({ actions: true }).extend({
		schemaVersion: z.literal(4),
		expectedConfigurationRevision: z.number().int().positive(),
		expectedKeyVersion: z.number().int().positive(),
	});
export const AgentConfigurationUpdateRequestV2Schema =
	AgentConfigurationUpdateRequestV2BaseSchema;
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
	/**
	 * Agent 当前管理修订号，只返回给该 Agent 的 Owner（#3070）。
	 * 浏览器会话授予或撤销用户 API 使用权、管理权时，把它作为 expectedRevision 传入；
	 * 非 Owner 的响应不含此字段。
	 */
	managementRevision: z
		.number()
		.int()
		.min(0)
		.max(Number.MAX_SAFE_INTEGER)
		.optional(),
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
/** #3376：Web 发送者撤回自己仍在排队的消息；目标是该消息绑定的等待 Execution。 */
export const WithdrawCommandRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	targetExecutionId: OpaqueIdV1Schema,
});
export const WithdrawalAcceptedProjectionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	status: z.enum(["withdrawn", "already_started", "already_finished"]),
	executionId: OpaqueIdV1Schema,
});
export const BrowserCommandRequestV1Schema = z.discriminatedUnion("command", [
	z.strictObject({
		schemaVersion: SchemaVersionV1Schema,
		command: z.enum(["pause", "take_over", "return_to_agent", "revoke"]),
		handoffId: OpaqueIdV1Schema,
	}),
	z.strictObject({
		schemaVersion: SchemaVersionV1Schema,
		command: z.enum([
			"confirm_side_effect",
			"reject_side_effect",
			"cancel_side_effect",
		]),
		confirmationId: OpaqueIdV1Schema,
	}),
]);
export type BrowserCommandRequestV1 = z.infer<
	typeof BrowserCommandRequestV1Schema
>;
export const ModelSelectionUpdateRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	modelOptionId: OpaqueIdV1Schema,
	reasoningLevel: nonEmptyString(),
});

/**
 * The model directory returned by the Runtime for one authorized Platform
 * conversation.  Runtime model ids are safe display data; endpoint, key and
 * native ACP session details deliberately have no representation here.
 */
export const ConversationModelSelectionProjectionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	conversationId: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema,
	source: z.enum(["standard", "custom-platform-adapter"]),
	available: z.boolean(),
	options: z.array(ModelOptionProjectionV1Schema),
	currentModelOptionId: OpaqueIdV1Schema.nullable(),
	currentReasoningLevel: nonEmptyString().nullable(),
	selectedModelOptionId: OpaqueIdV1Schema.nullable(),
	selectedReasoningLevel: nonEmptyString().nullable(),
});

export const CommandAcceptedProjectionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	status: z.enum(["submitted", "processing", "already_finished"]),
	messageId: OpaqueIdV1Schema.nullable(),
	executionId: OpaqueIdV1Schema.nullable(),
});
export const BrowserCommandAcceptedProjectionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	outcome: z.enum(["accepted", "replayed", "unknown"]),
	command: z.enum([
		"pause",
		"take_over",
		"return_to_agent",
		"revoke",
		"confirm_side_effect",
		"reject_side_effect",
		"cancel_side_effect",
	]),
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	handoffId: OpaqueIdV1Schema.optional(),
	confirmationId: OpaqueIdV1Schema.optional(),
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
	actor: BrowserUserProjectionV1Schema,
	subjectType: z.enum([
		"agent_application",
		"agent",
		"configuration",
		"grant",
		"user",
	]),
	subjectId: OpaqueIdV1Schema,
	result: z.enum(["succeeded", "failed"]),
	summary: nonEmptyString(),
	occurredAt: Rfc3339TimestampV1Schema,
	traceId: TraceIdV1Schema,
});

export const PlatformAuditProjectionV2Schema =
	PlatformAuditProjectionV1Schema.extend({
		schemaVersion: z.literal(2),
		subjectType: z.enum([
			"agent_application",
			"agent",
			"configuration",
			"grant",
			"user",
			"unknown",
		]),
		actor: z.union([
			BrowserUserProjectionV1Schema,
			z.strictObject({
				kind: z.literal("application"),
				actorId: OpaqueIdV1Schema,
			}),
			z.strictObject({
				kind: z.literal("unknown"),
				actorId: z.literal("unknown"),
			}),
			z.strictObject({
				kind: z.literal("system"),
				actorId: OpaqueIdV1Schema,
			}),
		]),
	});

export const DeploymentConfigurationStatusV2Schema = z.enum([
	"populated",
	"empty",
	"unavailable",
	"stale",
]);

export const DeploymentTemplateProjectionV2Schema = z.strictObject({
	readiness: z
		.strictObject({
			state: z.enum([
				"ready",
				"unregistered",
				"unverified",
				"failed",
				"disabled",
				"stale",
				"unavailable",
			]),
			revision: OpaqueIdV1Schema.nullable(),
		})
		.optional(),
	templateId: OpaqueIdV1Schema,
	displayName: nonEmptyString(),
	connectionEnabled: z.boolean(),
	allowedEnvironmentKeys: z.array(nonEmptyString()),
	allowedSecretKeys: z.array(nonEmptyString()),
});

export const PlatformUserDisableCommandV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	disabled: z.boolean(),
});

export const PlatformUserDisableStatusV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	userId: OpaqueIdV1Schema,
	disabled: z.boolean(),
});

export const PlatformUserDisableResultV1Schema =
	PlatformUserDisableStatusV1Schema.extend({
		changed: z.boolean(),
		auditOutcome: z.enum(["recorded", "not_required"]),
	});

export const DeploymentModelProjectionV2Schema = z.strictObject({
	modelId: nonEmptyString(),
	reasoningLevels: z.array(nonEmptyString()),
});

export const DeploymentModelEndpointProjectionV2Schema = z.strictObject({
	endpointId: OpaqueIdV1Schema,
	displayName: nonEmptyString(),
	models: z.array(DeploymentModelProjectionV2Schema),
});

export const DeploymentModelCatalogProjectionV2Schema = z.strictObject({
	status: DeploymentConfigurationStatusV2Schema,
	revision: OpaqueIdV1Schema.nullable(),
	endpoints: z.array(DeploymentModelEndpointProjectionV2Schema),
});

export const DeploymentConfigurationProjectionV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	status: DeploymentConfigurationStatusV2Schema,
	templates: z.array(DeploymentTemplateProjectionV2Schema),
	modelCatalog: DeploymentModelCatalogProjectionV2Schema,
	/** Resource profile choices are deployment-owned and read-only. */
	multiServiceResourceProfiles: z
		.array(MultiServiceResourceProfileProjectionV1Schema)
		.optional(),
	multiServiceResourceCap: MultiServiceResourceCapV1Schema.optional(),
	multiServiceResourceDefaultProfileRef: OpaqueIdV1Schema.optional(),
	multiServiceResourceProfilesSource: z
		.enum(["deployment", "default"])
		.optional(),
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
const platformUserPath = z.strictObject({ userId: z.uuidv4() });
const agentPath = z.strictObject({ agentId: pathId() });
const channelFileLimitPath = z.strictObject({
	agentId: pathId(),
	channelId: pathId(),
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
	status: z.enum([
		"accepted",
		"busy",
		"unavailable",
		"new_conversation",
		"media_rejected",
	]),
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
export const WecomQrAuthorizationProjectionV1Schema = z.strictObject({
	authorizationUrl: z.url(),
	authOrigin: z.url(),
	source: z.string().min(1).max(256),
	state: wecomSetupState,
});
const wecomBotSetupBeginProjection = z.discriminatedUnion("qrAvailable", [
	WecomSetupProjectionV1Schema.extend({
		state: wecomSetupState,
		qrAvailable: z.literal(false),
		qrUnavailableReason: z.literal("authorization_correlation_unverified"),
	}),
	WecomSetupProjectionV1Schema.extend({
		state: wecomSetupState,
		qrAvailable: z.literal(true),
		qr: WecomQrAuthorizationProjectionV1Schema,
	}),
]);
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
const wecomAppSetupProjection = WecomSetupProjectionV1Schema.extend({
	callbackUrl: z.url(),
});
export const pilotBrowserHttpOpenApiPathsV1 = {
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
					wecomBotSetupBeginProjection,
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
	"/api/v1/agents/{agentId}/wecom-app": {
		get: {
			operationId: "getWecomAppConnection",
			requestParams: { path: z.strictObject({ agentId: pathId() }) },
			responses: {
				"200": jsonResponse(
					"Owner application connection status",
					z.strictObject({
						status: z.enum([
							"not_configured",
							"callback",
							"verifying",
							"connected",
							"disconnected",
							"auth_failed",
						]),
						sessionId: OpaqueIdV1Schema.optional(),
						callbackUrl: z.url().optional(),
					}),
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/agents/{agentId}/wecom-app-setup": {
		post: {
			operationId: "beginWecomAppSetup",
			requestParams: { path: z.strictObject({ agentId: pathId() }) },
			responses: {
				"200": jsonResponse(
					"Owner application setup session",
					wecomAppSetupProjection.extend({ state: wecomSetupState }),
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/agents/{agentId}/wecom-app-setup/{sessionId}": {
		get: {
			operationId: "getWecomAppSetup",
			requestParams: { path: wecomSetupPath },
			responses: {
				"200": jsonResponse(
					"Owner application setup status",
					wecomAppSetupProjection,
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/agents/{agentId}/wecom-app-setup/{sessionId}/credentials": {
		post: {
			operationId: "submitWecomAppCredentials",
			requestParams: { path: wecomSetupPath },
			requestBody: requiredJsonRequestBody(WecomApplicationCredentialsV1Schema),
			responses: {
				"200": jsonResponse(
					"Candidate pending Worker validation",
					wecomAppSetupProjection,
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/agents/{agentId}/wecom-app-setup/{sessionId}/cancel": {
		post: {
			operationId: "cancelWecomAppSetup",
			requestParams: { path: wecomSetupPath },
			responses: {
				"200": jsonResponse(
					"Cancelled application setup session",
					wecomAppSetupProjection,
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
	"/api/v1/connection/capability": {
		get: {
			operationId: "getConnectionCapability",
			responses: {
				"200": jsonResponse(
					"Server-resolved Connection capability",
					ConnectionCapabilityProjectionV1Schema,
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
	"/api/v1/conversations/{conversationId}/withdrawals": {
		post: {
			operationId: "withdrawQueuedMessage",
			requestParams: { path: conversationPath, header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(WithdrawCommandRequestV1Schema),
			responses: {
				"202": jsonResponse(
					"Withdrawal accepted",
					WithdrawalAcceptedProjectionV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/conversations/{conversationId}/browser/commands": {
		post: {
			operationId: "commandBrowserHandoffOrSideEffect",
			requestParams: { path: conversationPath, header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(BrowserCommandRequestV1Schema),
			responses: {
				"202": jsonResponse(
					"Browser command accepted",
					BrowserCommandAcceptedProjectionV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v1/conversations/{conversationId}/model-selection": {
		get: {
			operationId: "getConversationModelSelection",
			requestParams: { path: conversationPath },
			responses: {
				"200": jsonResponse(
					"Current Runtime model selection",
					ConversationModelSelectionProjectionV1Schema,
				),
				...errorResponses,
			},
		},
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
	"/api/v2/admin/users/{userId}/disable": {
		get: {
			operationId: "getPlatformUserDisabledV2",
			requestParams: { path: platformUserPath },
			responses: {
				"200": jsonResponse(
					"Current Platform user disable status",
					PlatformUserDisableStatusV1Schema,
				),
				...errorResponses,
			},
		},
		put: {
			operationId: "setPlatformUserDisabledV2",
			requestParams: { path: platformUserPath },
			requestBody: requiredJsonRequestBody(PlatformUserDisableCommandV1Schema),
			responses: {
				"200": jsonResponse(
					"Platform user status and audit result",
					PlatformUserDisableResultV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v2/agents/{agentId}/state": {
		get: {
			operationId: "getAgentApiStateV1",
			security: agentApiCredentialSecurity,
			requestParams: { path: agentPath },
			responses: {
				"200": jsonResponse(
					"Current authorized Agent lifecycle state",
					AgentApiStateResponseV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v2/agents/{agentId}/application-managers/{applicationId}": {
		put: {
			operationId: "grantAgentApplicationManagerV1",
			security: personalCredentialSecurity,
			requestParams: {
				path: z.strictObject({ agentId: pathId(), applicationId: pathId() }),
				header: idempotencyHeader,
			},
			requestBody: requiredJsonRequestBody(
				AgentApplicationManagerRequestV1Schema,
			),
			responses: {
				"200": jsonResponse(
					"Explicit application manage grant",
					AgentApplicationManagerResponseV1Schema,
				),
				...errorResponses,
			},
		},
		delete: {
			operationId: "revokeAgentApplicationManagerV1",
			security: personalCredentialSecurity,
			requestParams: {
				path: z.strictObject({ agentId: pathId(), applicationId: pathId() }),
				header: idempotencyHeader,
			},
			requestBody: requiredJsonRequestBody(
				AgentApplicationManagerRequestV1Schema,
			),
			responses: {
				"200": jsonResponse(
					"Explicit application manage revocation",
					AgentApplicationManagerResponseV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v2/agents/{agentId}/application-use-grants/{applicationId}": {
		put: {
			operationId: "grantAgentApplicationUseV1",
			security: personalCredentialSecurity,
			requestParams: {
				path: z.strictObject({ agentId: pathId(), applicationId: pathId() }),
				header: idempotencyHeader,
			},
			requestBody: requiredJsonRequestBody(
				AgentApplicationManagerRequestV1Schema,
			),
			responses: {
				"200": jsonResponse(
					"Explicit application use grant",
					AgentApplicationManagerResponseV1Schema,
				),
				...errorResponses,
			},
		},
		delete: {
			operationId: "revokeAgentApplicationUseV1",
			security: personalCredentialSecurity,
			requestParams: {
				path: z.strictObject({ agentId: pathId(), applicationId: pathId() }),
				header: idempotencyHeader,
			},
			requestBody: requiredJsonRequestBody(
				AgentApplicationManagerRequestV1Schema,
			),
			responses: {
				"200": jsonResponse(
					"Explicit application use revocation",
					AgentApplicationManagerResponseV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v2/agents/{agentId}/api-use-grants/{userId}": {
		put: {
			operationId: "grantAgentUserApiUseV1",
			security: personalCredentialSecurity,
			requestParams: {
				path: z.strictObject({ agentId: pathId(), userId: pathId() }),
				header: idempotencyHeader,
			},
			requestBody: requiredJsonRequestBody(AgentUserUseGrantRequestV1Schema),
			responses: {
				"200": jsonResponse(
					"Explicit user API use grant",
					AgentUserUseGrantResponseV1Schema,
				),
				...errorResponses,
			},
		},
		delete: {
			operationId: "revokeAgentUserApiUseV1",
			security: personalCredentialSecurity,
			requestParams: {
				path: z.strictObject({ agentId: pathId(), userId: pathId() }),
				header: idempotencyHeader,
			},
			requestBody: requiredJsonRequestBody(AgentUserUseRevokeRequestV1Schema),
			responses: {
				"200": jsonResponse(
					"Explicit user API use revocation",
					AgentUserUseRevokeResponseV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v2/agents/{agentId}/api-manage-grants/{userId}": {
		put: {
			operationId: "grantAgentUserApiManageV1",
			security: personalCredentialSecurity,
			requestParams: {
				path: z.strictObject({ agentId: pathId(), userId: pathId() }),
				header: idempotencyHeader,
			},
			requestBody: requiredJsonRequestBody(AgentUserManageGrantRequestV1Schema),
			responses: {
				"200": jsonResponse(
					"Explicit user API manage grant",
					AgentUserManageGrantResponseV1Schema,
				),
				...errorResponses,
			},
		},
		delete: {
			operationId: "revokeAgentUserApiManageV1",
			security: personalCredentialSecurity,
			requestParams: {
				path: z.strictObject({ agentId: pathId(), userId: pathId() }),
				header: idempotencyHeader,
			},
			requestBody: requiredJsonRequestBody(
				AgentUserManageRevokeRequestV1Schema,
			),
			responses: {
				"200": jsonResponse(
					"Explicit user API manage revocation",
					AgentUserManageRevokeResponseV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v2/agents/{agentId}/commands": {
		post: {
			operationId: "commandAgentApiLifecycleV1",
			security: agentApiCredentialSecurity,
			requestParams: { path: agentPath, header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(AgentApiLifecycleRequestV1Schema),
			responses: {
				"202": jsonResponse(
					"Agent lifecycle command accepted",
					AgentApiLifecycleResponseV1Schema,
				),
				...errorResponses,
			},
		},
	},

	"/api/v2/applications/{applicationId}/credentials/{credentialId}": {
		delete: {
			operationId: "revokeApplicationApiCredentialV2",
			summary:
				"Revoke one application credential without canceling accepted tasks",
			security: personalCredentialSecurity,
			requestParams: {
				path: z.strictObject({
					applicationId: pathId(),
					credentialId: pathId(),
				}),
				header: idempotencyHeader,
			},
			responses: {
				"200": jsonResponse(
					"Revoked credential metadata",
					ApplicationApiCredentialRevocationV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v2/applications/{applicationId}/credentials": {
		get: {
			operationId: "listApplicationApiCredentialsV2",
			summary:
				"Read bounded application credential metadata as the current responsible user",
			security: personalCredentialSecurity,
			requestParams: {
				path: z.strictObject({ applicationId: pathId() }),
				query: ApplicationApiCredentialListQueryV1Schema,
			},
			responses: {
				"200": jsonResponse(
					"Credential metadata only",
					ApplicationApiCredentialPageV1Schema,
				),
				...errorResponses,
			},
		},
		post: {
			operationId: "issueOrRotateApplicationApiCredentialV2",
			summary:
				"Issue or rotate an application credential for an explicitly granted recipient",
			description:
				"Current responsible-user browser session only. Material is delivered through the trusted consumer, never this management response. Same-key retry only returns metadata and delivery status; unknown delivery requires explicit rotation with a new key. Responses are no-store.",
			security: personalCredentialSecurity,
			requestParams: {
				path: z.strictObject({ applicationId: pathId() }),
				header: idempotencyHeader,
			},
			requestBody: requiredJsonRequestBody(
				ApplicationApiCredentialRequestV1Schema,
			),
			responses: {
				"201": jsonResponse(
					"Credential committed; inspect delivery status",
					ApplicationApiCredentialResponseV1Schema,
				),
				"200": jsonResponse(
					"Original metadata and delivery status replayed",
					ApplicationApiCredentialResponseV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v2/applications": {
		post: {
			operationId: "registerApplicationV2",
			summary: "Register an application owned by the current browser user",
			description:
				"Active browser session only; no Authorization header or query. Responsibility is bound by the server. Same-key replay returns the original metadata. No credential or grant is issued. Responses are no-store.",
			security: personalCredentialSecurity,
			requestParams: { header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(
				ApplicationRegistrationRequestV1Schema,
			),
			responses: {
				"201": jsonResponse(
					"Application committed",
					ApplicationRegistrationResponseV1Schema,
				),
				"200": jsonResponse(
					"Original application metadata replayed",
					ApplicationRegistrationResponseV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v2/applications/{applicationId}/material-grant": {
		post: {
			operationId: "grantApplicationMaterialV2",
			summary:
				"Grant application credential material access to a typed recipient",
			description:
				"Current system_admin only. The response contains grant metadata and never credential material; responsibility and administrator roles alone do not return material.",
			security: personalCredentialSecurity,
			requestParams: {
				path: z.strictObject({ applicationId: OpaqueIdV1Schema }),
			},
			requestBody: requiredJsonRequestBody(
				ApplicationMaterialGrantRequestV1Schema,
			),
			responses: {
				"201": jsonResponse(
					"Material grant metadata",
					ApplicationMaterialGrantResponseV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v2/applications/{applicationId}/material-grant/{principalType}/{principalId}":
		{
			patch: {
				operationId: "revokeApplicationMaterialV2",
				summary: "Revoke a typed application credential material grant",
				description:
					"Current system_admin only. expectedRevision is required to prevent a stale revoke from changing a newer grant.",
				security: personalCredentialSecurity,
				requestParams: {
					path: z.strictObject({
						applicationId: OpaqueIdV1Schema,
						principalType: z.enum(["user", "application"]),
						principalId: OpaqueIdV1Schema,
					}),
				},
				requestBody: requiredJsonRequestBody(
					ApplicationMaterialGrantRevokeRequestV1Schema,
				),
				responses: {
					"200": jsonResponse(
						"Revoked material grant metadata",
						ApplicationMaterialGrantResponseV1Schema,
					),
					...errorResponses,
				},
			},
			get: {
				operationId: "readApplicationMaterialV2",
				summary: "Read typed application credential material grant metadata",
				description:
					"Current system_admin only. Grant metadata is returned; credential material is never returned.",
				security: personalCredentialSecurity,
				requestParams: {
					path: z.strictObject({
						applicationId: OpaqueIdV1Schema,
						principalType: z.enum(["user", "application"]),
						principalId: OpaqueIdV1Schema,
					}),
				},
				responses: {
					"200": jsonResponse(
						"Material grant metadata",
						ApplicationMaterialGrantResponseV1Schema,
					),
					...errorResponses,
				},
			},
		},
	"/api/v2/applications/{applicationId}": {
		patch: {
			operationId: "disableOwnApplicationV2",
			summary: "Disable an application owned by the current browser user",
			description:
				"Active browser session only; no Authorization header or query. Current ownership is rechecked on replay. Cross-person and missing applications both return 404. No credential material is returned. Responses are no-store.",
			security: personalCredentialSecurity,
			requestParams: {
				path: z.strictObject({ applicationId: OpaqueIdV1Schema }),
				header: idempotencyHeader,
			},
			requestBody: requiredJsonRequestBody(ApplicationDisableRequestV1Schema),
			responses: {
				"200": jsonResponse(
					"Disabled application metadata",
					ApplicationMetadataV1Schema,
				),
				...errorResponses,
			},
		},
		get: {
			operationId: "getOwnApplicationV2",
			summary: "Read an application owned by the current browser user",
			description:
				"Active browser session only; no Authorization header, query or request body. Cross-person and missing applications both return 404. Metadata contains no material or grants. Responses are no-store.",
			security: personalCredentialSecurity,
			requestParams: {
				path: z.strictObject({ applicationId: OpaqueIdV1Schema }),
			},
			responses: {
				"200": jsonResponse(
					"Own application metadata",
					ApplicationMetadataV1Schema,
				),
				...errorResponses,
			},
		},
	},

	"/api/v2/agents/{agentId}/default-relay-key": {
		get: {
			operationId: "getAgentDefaultRelayKeyV2",
			summary: "Read current Owner Agent default Relay Key state",
			security: personalCredentialSecurity,
			requestParams: { path: agentPath },
			responses: {
				"200": jsonResponse(
					"Key state only",
					AgentDefaultRelayKeyStateV1Schema,
				),
				...errorResponses,
			},
		},
		put: {
			operationId: "replaceAgentDefaultRelayKeyV2",
			summary: "Replace an existing Agent default Relay Key",
			description:
				"Current Owner browser session only. Compare-and-swap on Key and configuration versions. Revalidates every currently configured model against fresh Key visibility and exact template/image binding. Does not create or migrate an Agent configuration. No-store; no Authorization header or query.",
			security: personalCredentialSecurity,
			requestParams: { path: agentPath },
			requestBody: requiredJsonRequestBody(
				AgentDefaultRelayKeyReplaceRequestV1Schema,
			),
			responses: {
				"200": jsonResponse(
					"Committed Key state",
					AgentDefaultRelayKeyStateV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v2/agents/{agentId}/default-relay-key/candidates": {
		get: {
			operationId: "getAgentDefaultRelayKeySavedCandidatesV2",
			summary: "Read models visible to the persisted Agent default Relay Key",
			description:
				"Current Owner browser session only; the saved Key is decrypted transiently inside the Worker and no Key material is returned. No-store.",
			security: personalCredentialSecurity,
			requestParams: { path: agentPath },
			responses: {
				"200": jsonResponse(
					"Saved-Key compatible candidates",
					AgentDefaultRelayKeySavedCandidatesV1Schema,
				),
				...errorResponses,
			},
		},
		post: {
			operationId: "getAgentDefaultRelayKeyCandidatesV2",
			summary:
				"Preview Key-visible models compatible with the current Agent template",
			description:
				"Preview is not a save authorization or proof of real model execution. The write independently revalidates. Current Owner browser session only; no-store.",
			security: personalCredentialSecurity,
			requestParams: { path: agentPath },
			requestBody: requiredJsonRequestBody(
				AgentDefaultRelayKeyCandidatesRequestV1Schema,
			),
			responses: {
				"200": jsonResponse(
					"Compatible candidates",
					AgentDefaultRelayKeyCandidatesV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v2/agents/{agentId}/default-relay-key/display-candidates": {
		get: {
			operationId: "getAgentDefaultRelayKeySavedDisplayCandidatesV2",
			summary: "Read saved-Key candidates with deployment-owned model names",
			description:
				"Current Owner browser session only. Retains current configuration and saved Key version checks; names are presentation metadata only. No Key material is returned. No-store; no Authorization header, query or request body.",
			security: personalCredentialSecurity,
			requestParams: { path: agentPath },
			responses: {
				"200": jsonResponse(
					"Saved-Key candidates with display names",
					AgentDefaultRelayKeySavedDisplayCandidatesV2Schema,
				),
				...errorResponses,
			},
		},
		post: {
			operationId: "getAgentDefaultRelayKeyDisplayCandidatesV2",
			summary:
				"Preview Key-visible candidates with deployment-owned model names",
			description:
				"Current Owner browser session only. Retains the original candidate intersection and independent save revalidation. Names never authorize a model or prove execution. No-store; no Authorization header or query.",
			security: personalCredentialSecurity,
			requestParams: { path: agentPath },
			requestBody: requiredJsonRequestBody(
				AgentDefaultRelayKeyCandidatesRequestV1Schema,
			),
			responses: {
				"200": jsonResponse(
					"Compatible candidates with display names",
					AgentDefaultRelayKeyDisplayCandidatesV2Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v2/me/relay-key": {
		get: {
			operationId: "getPersonalRelayKeyV2",
			summary: "Read the current browser user's personal Relay Key state",
			description:
				"Active browser session only; no Authorization header, query or request body. No Key material is returned. Responses are no-store.",
			security: personalCredentialSecurity,
			responses: {
				"200": jsonResponse(
					"Personal Key state only",
					PersonalRelayKeyStateV1Schema,
				),
				...errorResponses,
			},
		},
		put: {
			operationId: "replacePersonalRelayKeyV2",
			summary: "Set or replace the current browser user's personal Relay Key",
			description:
				"Active browser session only; no Authorization header or query. expectedVersion is a compare-and-swap guard. The approved read-only validation proves authentication only. Responses are no-store.",
			security: personalCredentialSecurity,
			requestBody: requiredJsonRequestBody(
				PersonalRelayKeyReplaceRequestV1Schema,
			),
			responses: {
				"200": jsonResponse(
					"Committed personal Key state",
					PersonalRelayKeyStateV1Schema,
				),
				...errorResponses,
			},
		},
		delete: {
			operationId: "revokePersonalRelayKeyV2",
			summary: "Revoke the current browser user's personal Relay Key pointer",
			description:
				"Active browser session only; no Authorization header or query. Already accepted Executions retain their exact original encrypted version. Responses are no-store.",
			security: personalCredentialSecurity,
			requestBody: requiredJsonRequestBody(
				PersonalRelayKeyRevokeRequestV1Schema,
			),
			responses: {
				"200": jsonResponse(
					"Committed unset personal Key state",
					PersonalRelayKeyStateV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v2/me/api-credentials": {
		get: {
			operationId: "listPersonalApiCredentialsV2",
			summary: "List only the current browser user's credential metadata",
			description:
				"Any Authorization header is rejected. Limit defaults to 20; cursor is bound to this user and limit. Credential material and hashes are never returned. Responses are no-store.",
			security: personalCredentialSecurity,
			requestParams: { query: PersonalApiCredentialListQueryV1Schema },
			responses: {
				"200": jsonResponse(
					"Personal credential metadata page",
					PersonalApiCredentialPageV1Schema,
				),
				...errorResponses,
			},
		},
		post: {
			operationId: "issuePersonalApiCredentialV2",
			summary: "Issue a personal credential with one-time material delivery",
			description:
				"Active browser user only. Any Authorization header is rejected. Same-key replay returns the original current metadata and null material. Responses are no-store.",
			security: personalCredentialSecurity,
			requestParams: { header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(
				PersonalApiCredentialIssueRequestV1Schema,
			),
			responses: {
				"201": jsonResponse(
					"Credential committed with first-delivery material",
					PersonalApiCredentialIssueResponseV1Schema.options[0],
				),
				"200": jsonResponse(
					"Original credential metadata; material is not replayed",
					PersonalApiCredentialIssueResponseV1Schema.options[1],
				),
				...errorResponses,
			},
		},
	},
	"/api/v2/me/api-credentials/{credentialId}": {
		patch: {
			operationId: "narrowPersonalApiCredentialV2",
			summary: "Restrict one personal credential's scopes or expiry",
			description:
				"Active browser user only. Any Authorization header is rejected. Scopes can only be a nonempty subset; expiry can only be made earlier. Revoked or expired credentials are never revived. Same-key replay returns current metadata. Cross-person and absent IDs both return 404. Responses are no-store.",
			security: personalCredentialSecurity,
			requestParams: {
				path: z.strictObject({ credentialId: pathId() }),
				header: idempotencyHeader,
			},
			requestBody: requiredJsonRequestBody(
				PersonalApiCredentialNarrowRequestV1Schema,
			),
			responses: {
				"200": jsonResponse(
					"Current restricted credential metadata",
					PersonalApiCredentialNarrowResponseV1Schema,
				),
				...errorResponses,
			},
		},
		delete: {
			operationId: "revokePersonalApiCredentialV2",
			summary: "Revoke one credential owned by the current browser user",
			description:
				"Any Authorization header is rejected. Cross-person and missing credentials both return 404. No request body or identity overrides are accepted. Responses are no-store.",
			security: personalCredentialSecurity,
			requestParams: {
				header: idempotencyHeader,
				path: z.strictObject({ credentialId: OpaqueIdV1Schema }),
			},
			responses: {
				"200": jsonResponse(
					"Current revoked credential metadata",
					PersonalApiCredentialRevokeResponseV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v2/deployment/configuration": {
		get: {
			operationId: "getDeploymentConfigurationV2",
			responses: {
				"200": jsonResponse(
					"Deployment-owned application choices",
					DeploymentConfigurationProjectionV2Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v2/agent-applications/model-candidates": {
		post: {
			operationId: "getAgentApplicationModelCandidatesV2",
			summary:
				"Preview models for a standard-template application before creation",
			description:
				"Active browser session only; no Authorization header or query. Template readiness and current user authority are checked. No Key, Agent or application is persisted. Responses are no-store; submission independently revalidates the Key, template and models.",
			security: personalCredentialSecurity,
			requestBody: requiredJsonRequestBody(
				AgentApplicationModelCandidatesRequestV2Schema,
			),
			responses: {
				"200": jsonResponse(
					"Models available to a standard-template application",
					AgentApplicationModelCandidatesResponseV2Schema,
				),
				...errorResponses,
			},
		},
	},
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
	"/api/v2/admin/agents": {
		get: {
			operationId: "listAdminAgentsV2",
			requestParams: { query: pageQuery },
			responses: {
				"200": jsonResponse("Administrator agents", agentPageV2),
				...errorResponses,
			},
		},
	},
	// #3033：系统管理员按职责读取单个 Agent，形状与管理员列表项相同；不扩大 getAgentV2 的可见范围。
	"/api/v2/admin/agents/{agentId}": {
		get: {
			operationId: "getAdminAgentV2",
			summary: "Read one Agent through the administrator projection",
			description:
				"Browser session only; no Authorization header or query. The current identity must be an active system_admin. Returns the same AgentProjectionV2 as listAdminAgentsV2, does not widen getAgentV2 visibility and grants no configuration, authorization or use rights. Responses are no-store.",
			security: personalCredentialSecurity,
			requestParams: { path: agentPath },
			responses: {
				"200": jsonResponse("Administrator Agent", AgentProjectionV2Schema),
				...errorResponses,
			},
		},
	},
	"/api/v2/agents": {
		get: {
			operationId: "listAgentsV2",
			description:
				"Browser discovery/Owner uses PlatformSession. Personal Bearer requires agent:read and current explicit manage or use grants; only limit/cursor, no scope override or mixed Cookie.",
			security: agentListSecurity,
			requestParams: { query: agentListQuery },
			responses: {
				"200": jsonResponse("Visible agents", agentPageV2),
				...errorResponses,
			},
		},
		post: {
			operationId: "createAgentApiV1",
			security: agentApiCredentialSecurity,
			requestParams: { header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(AgentApiCreationRequestV1Schema),
			responses: {
				"201": jsonResponse(
					"Agent API creation accepted",
					AgentApiCreationResponseV1Schema,
				),
				"200": jsonResponse(
					"Original Agent API creation replayed",
					AgentApiCreationResponseV1Schema,
				),
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
	"/api/v2/agents/{agentId}/configuration/saved-model": {
		put: {
			operationId: "updateAgentSavedModelConfigurationV2",
			summary: "Update models bound to the persisted Agent default Relay Key",
			description:
				"Owner browser session only. The saved Key is never submitted; configuration and Key versions are compare-and-swap guards.",
			requestParams: { path: agentPath, header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(
				AgentConfigurationUpdateRequestV4Schema,
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
					z.union([
						AgentProjectionV2Schema,
						AgentApiLifecycleAcceptedResponseV1Schema,
					]),
				),
				...errorResponses,
			},
		},
	},

	"/api/v2/agents/{agentId}/file-limits": {
		get: {
			operationId: "readAgentFileLimitsV2",
			summary: "Read the Agent file limit declaration",
			description:
				"Browser session only. The current identity must be an active Owner, Co-owner or system_admin for the Agent. The declaration is independent from the Agent configuration revision but carries its own revision and expiry.",
			requestParams: { path: agentPath },
			responses: {
				"200": jsonResponse(
					"Agent file limit declaration",
					FileLimitDeclarationResponseV1Schema,
				),
				...errorResponses,
			},
		},
		put: {
			operationId: "updateAgentFileLimitsV2",
			summary: "Create or replace the Agent file limit declaration",
			description:
				"Browser session only. `expectedRevision` is the persisted declaration revision; `null` creates it. A mismatch returns 409 and mutates nothing. A declaration that is already expired is rejected.",
			requestParams: { path: agentPath, header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(
				FileLimitDeclarationWriteRequestV1Schema,
			),
			responses: {
				"200": jsonResponse(
					"Agent file limit declaration",
					FileLimitDeclarationResponseV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v2/agents/{agentId}/channels/{channelId}/file-limits": {
		get: {
			operationId: "readChannelFileLimitsV2",
			summary: "Read the Channel file limit declaration",
			description:
				"Browser session only. Channel declarations are scoped to one Agent and channel binding; the current identity must be an active Owner, Co-owner or system_admin for the Agent.",
			requestParams: { path: channelFileLimitPath },
			responses: {
				"200": jsonResponse(
					"Channel file limit declaration",
					FileLimitDeclarationResponseV1Schema,
				),
				...errorResponses,
			},
		},
		put: {
			operationId: "updateChannelFileLimitsV2",
			summary: "Create or replace the Channel file limit declaration",
			description:
				"Browser session only. `expectedRevision` is the persisted declaration revision; `null` creates it. A mismatch returns 409 and mutates nothing. A declaration that is already expired is rejected.",
			requestParams: { path: channelFileLimitPath, header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(
				FileLimitDeclarationWriteRequestV1Schema,
			),
			responses: {
				"200": jsonResponse(
					"Channel file limit declaration",
					FileLimitDeclarationResponseV1Schema,
				),
				...errorResponses,
			},
		},
	},
	"/api/v2/admin/deployment/file-limits": {
		get: {
			operationId: "readDeploymentFileLimitsV2",
			summary: "Read the deployment file limit declaration",
			description:
				"Browser session only. The current identity must be an active system_admin. The deployment declaration caps every Agent and Channel intersection.",
			responses: {
				"200": jsonResponse(
					"Deployment file limit declaration",
					FileLimitDeclarationResponseV1Schema,
				),
				...errorResponses,
			},
		},
		put: {
			operationId: "updateDeploymentFileLimitsV2",
			summary: "Create or replace the deployment file limit declaration",
			description:
				"Browser session only; system_admin only. `expectedRevision` is the persisted declaration revision; `null` creates it. A mismatch returns 409 and mutates nothing. A declaration that is already expired is rejected.",
			requestParams: { header: idempotencyHeader },
			requestBody: requiredJsonRequestBody(
				FileLimitDeclarationWriteRequestV1Schema,
			),
			responses: {
				"200": jsonResponse(
					"Deployment file limit declaration",
					FileLimitDeclarationResponseV1Schema,
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
	ConnectionCapabilityProjectionV1: ConnectionCapabilityProjectionV1Schema,
	CommandAcceptedProjectionV1: CommandAcceptedProjectionV1Schema,
	BrowserCommandAcceptedProjectionV1: BrowserCommandAcceptedProjectionV1Schema,
	BrowserCommandRequestV1: BrowserCommandRequestV1Schema,
	ChannelBindingInputV1: ChannelBindingInputV1Schema,
	ChannelBindingProjectionV1: ChannelBindingProjectionV1Schema,
	ConversationDetailProjectionV1: ConversationDetailProjectionV1Schema,
	ConversationModelSelectionProjectionV1:
		ConversationModelSelectionProjectionV1Schema,
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
	WithdrawCommandRequestV1: WithdrawCommandRequestV1Schema,
	WithdrawalAcceptedProjectionV1: WithdrawalAcceptedProjectionV1Schema,
};

export const pilotBrowserSchemasV2 = {
	FileLimitDeclarationProjectionV1: FileLimitDeclarationProjectionV1Schema,
	FileLimitDeclarationResponseV1: FileLimitDeclarationResponseV1Schema,
	FileLimitDeclarationWriteRequestV1: FileLimitDeclarationWriteRequestV1Schema,
	PlatformUserDisableCommandV1: PlatformUserDisableCommandV1Schema,
	PlatformUserDisableStatusV1: PlatformUserDisableStatusV1Schema,
	PlatformUserDisableResultV1: PlatformUserDisableResultV1Schema,
	AgentApiStateResponseV1: AgentApiStateResponseV1Schema,
	AgentApplicationManagerRequestV1: AgentApplicationManagerRequestV1Schema,
	AgentApplicationManagerResponseV1: AgentApplicationManagerResponseV1Schema,
	AgentUserUseRevokeRequestV1: AgentUserUseRevokeRequestV1Schema,
	AgentUserUseRevokeResponseV1: AgentUserUseRevokeResponseV1Schema,
	AgentUserUseGrantRequestV1: AgentUserUseGrantRequestV1Schema,
	AgentUserUseGrantResponseV1: AgentUserUseGrantResponseV1Schema,
	AgentUserManageGrantRequestV1: AgentUserManageGrantRequestV1Schema,
	AgentUserManageGrantResponseV1: AgentUserManageGrantResponseV1Schema,
	AgentUserManageRevokeRequestV1: AgentUserManageRevokeRequestV1Schema,
	AgentUserManageRevokeResponseV1: AgentUserManageRevokeResponseV1Schema,
	AgentApiLifecycleRequestV1: AgentApiLifecycleRequestV1Schema,
	AgentApiLifecycleAcceptedResponseV1:
		AgentApiLifecycleAcceptedResponseV1Schema,
	AgentApiLifecycleResponseV1: AgentApiLifecycleResponseV1Schema,
	AgentApiCreationRequestV1: AgentApiCreationRequestV1Schema,
	AgentApiCreationResponseV1: AgentApiCreationResponseV1Schema,
	ApplicationMetadataV1: ApplicationMetadataV1Schema,
	ApplicationDisableRequestV1: ApplicationDisableRequestV1Schema,
	ApplicationRegistrationRequestV1: ApplicationRegistrationRequestV1Schema,
	ApplicationRegistrationResponseV1: ApplicationRegistrationResponseV1Schema,
	PersonalRelayKeyStateV1: PersonalRelayKeyStateV1Schema,
	PersonalRelayKeyReplaceRequestV1: PersonalRelayKeyReplaceRequestV1Schema,
	PersonalRelayKeyRevokeRequestV1: PersonalRelayKeyRevokeRequestV1Schema,
	PersonalApiCredentialIssueRequestV1:
		PersonalApiCredentialIssueRequestV1Schema,
	PersonalApiCredentialIssueResponseV1:
		PersonalApiCredentialIssueResponseV1Schema,
	PersonalApiCredentialMetadataV1: PersonalApiCredentialMetadataV1Schema,
	PersonalApiCredentialListQueryV1: PersonalApiCredentialListQueryV1Schema,
	PersonalApiCredentialPageV1: PersonalApiCredentialPageV1Schema,
	PersonalApiCredentialNarrowRequestV1:
		PersonalApiCredentialNarrowRequestV1Schema,
	PersonalApiCredentialNarrowResponseV1:
		PersonalApiCredentialNarrowResponseV1Schema,
	PersonalApiCredentialRevokeResponseV1:
		PersonalApiCredentialRevokeResponseV1Schema,
	AgentLifecycleCommandRequestV1: AgentLifecycleCommandRequestV1Schema,
	ApprovalDecisionRequestV1: ApprovalDecisionRequestV1Schema,
	AgentApplicationCreateRequestV2: AgentApplicationCreateRequestV2Schema,
	AgentApplicationModelCandidatesRequestV2:
		AgentApplicationModelCandidatesRequestV2Schema,
	AgentApplicationModelCandidatesResponseV2:
		AgentApplicationModelCandidatesResponseV2Schema,
	AgentApplicationUpdateRequestV2: AgentApplicationUpdateRequestV2Schema,
	AgentConfigurationUpdateRequestV2: AgentConfigurationUpdateRequestV2Schema,
	AgentApplicationProjectionV2: AgentApplicationProjectionV2Schema,
	AgentConfigurationProjectionV2: AgentConfigurationProjectionV2Schema,
	AgentProjectionV2: AgentProjectionV2Schema,
	DeploymentConfigurationStatusV2: DeploymentConfigurationStatusV2Schema,
	DeploymentConfigurationProjectionV2:
		DeploymentConfigurationProjectionV2Schema,
	DeploymentModelCatalogProjectionV2: DeploymentModelCatalogProjectionV2Schema,
	DeploymentModelEndpointProjectionV2:
		DeploymentModelEndpointProjectionV2Schema,
	DeploymentModelProjectionV2: DeploymentModelProjectionV2Schema,
	DeploymentTemplateProjectionV2: DeploymentTemplateProjectionV2Schema,

	PilotInternalErrorV1: PilotInternalErrorV1Schema,
	PilotProtocolErrorV1: PilotProtocolErrorV1Schema,
	PlatformAuditProjectionV2: PlatformAuditProjectionV2Schema,
};
