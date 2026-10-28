import { z } from "zod";
import {
	OpaqueCursorV1Schema,
	OpaqueIdV1Schema,
	RequestIdV1Schema,
	Rfc3339TimestampV1Schema,
	TraceIdV1Schema,
} from "../index.ts";
import { RuntimeOperationFactV2Schema } from "../runtime/events-v2.ts";
import { PilotProtocolErrorV1Schema } from "./errors.ts";

const ApiPrincipalV1Schema = z.strictObject({
	kind: z.enum(["user", "application"]),
	id: OpaqueIdV1Schema,
});

export const ScopedPlatformAuditResultV1Schema = z.enum([
	"succeeded",
	"rejected",
	"failed",
	"accepted",
	"intent",
	"started",
	"submitted",
	"waiting",
	"processing",
	"completed",
	"cancelled",
	"unknown",
]);

export const ScopedPlatformAuditActionV1Schema = z.enum([
	"skill.version.register",
	"skill.version.review",
	"skill.version.revoke",
	"skill.version.read",
	"skill.version.refused",
	"connection.installation.begin",
	"connection.installation.confirm",
	"agent.application.submitted",
	"agent.application.updated",
	"agent.application.resubmitted",
	"agent.application.withdrawn",
	"agent.application.approved",
	"agent.application.rejected",
	"agent.lifecycle.stopped",
	"agent.lifecycle.restarted",
	"agent.lifecycle.creation_retried",
	"agent.lifecycle.disabled",
	"agent.workload.creation_succeeded",
	"agent.workload.creation_failed",
	"agent.workload.service_starting",
	"agent.workload.service_ready",
	"agent.workload.service_updating",
	"agent.workload.service_unavailable",
	"agent.configuration.revised",
	"agent.access.updated",
	"api.access.rejected",
	"api.application.created",
	"api.credential.issued",
	"api.credential.revoked",
	"api.credential.narrowed",
	"api.credential.metadata.read",
	"api.credential.identity.read",
	"api.credential.delivery.granted",
	"api.credential.delivery.revoked",
	"api.agent.grant.granted",
	"api.agent.grant.revoked",
	"api.agent.metadata.read",
	"api.agent.state.read",
	"api.agent.manager.granted",
	"api.agent.manager.revoked",
	"api.agent.manager.replayed",
	"api.agent.lifecycle.refused",
	"api.agent.manager.refused",
	"api.agent.use.granted",
	"api.agent.use.revoked",
	"api.agent.use.replayed",
	"api.agent.use.refused",
	"api.agent.state.refused",
	"platform.user.disabled",
	"platform.user.reenabled",

	"relay_key.personal.read",
	"relay_key.personal.replace",
	"relay_key.personal.revoke",
	"task.api.access",
	"task.api.subscription.started",
	"task.api.subscription.ended",
	"task.authorization.accepted",
	"task.status.changed",
	"task.control.created",
	"execution.operation.observed",
	"conversation.task.accepted",
	"conversation.message.accepted",
	"conversation.regeneration.accepted",
	"conversation.stop.accepted",
	"conversation.model_selection.updated",
	"conversation.model_selection.fell_back",
	"conversation.task.status",
	"secret.decrypt",
	"secret.activate",
	"secret.rewrap",
	"secret.retire-key",
	"audit.query.completed",
	"audit.query.failed",
	"wecom.setup_started",
	"wecom.credentials_submitted",
	"wecom.setup_cancelled",
	"wecom.setup_expired",
	"wecom.setup_failed",
	"wecom.callback_verified",
	"wecom.setup_activated",
	"wecom.connection_verifying",
	"wecom.connection_connected",
	"wecom.connection_disconnected",
	"wecom.connection_auth_failed",
	"wecom.denied",
	"wecom.unavailable",
	"wecom.conflict",
	"wecom.accepted",
	"wecom.unknown",
	"wecom.sending",
	"wecom.sent",
	"wecom.failed",
	"wecom.cancelled",
	"wecom.expired",
	"wecom.abandoned",
	"api.agent.create.accepted",
	"api.agent.create.replayed",
	"api.agent.create.refused",
	"relay_key.agent_default.replace",
	"skill.project.create",
	"skill.project.update",
	"skill.project.list",
	"skill.project.read",
	"relay_key.agent_default.read",
	"relay_key.agent_default.candidates",
	// #3258：企微 /new 开始新会话、会话不可用（#3184）与入站媒体被拒绝（#3241）
	"wecom.conversation_started",
	"wecom.conversation_unavailable",
	"wecom.media_rejected",
	"application.credential.issued",
	"application.credential.rotated",
	"application.credential.delivery",
	"application.credential.metadata.read",
	"application.credential.revoked",
]);

export const ScopedPlatformAuditProjectionV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	auditId: OpaqueIdV1Schema,
	action: ScopedPlatformAuditActionV1Schema,
	actor: z.strictObject({
		kind: z.enum(["user", "application", "system", "unknown"]),
		actorId: OpaqueIdV1Schema,
	}),
	subject: z.strictObject({
		kind: z.enum([
			"agent_application",
			"agent",
			"secret",
			"secret_key",
			"grant",
			"unknown",
			"conversation",
			"execution",
			"configuration",
			"api_credential",
			"application",
		]),
		subjectId: OpaqueIdV1Schema,
	}),
	result: ScopedPlatformAuditResultV1Schema,
	summary: z.string().min(1).max(1024),
	taskApi: z
		.strictObject({
			operation: z.enum(["submit", "read", "cancel", "subscribe"]),
			phase: z.enum(["access", "subscription.started", "subscription.ended"]),
			reason: z.enum([
				"request_accepted",
				"invalid_request",
				"authentication_required",
				"authorization_revoked",
				"missing_scope",
				"resource_unavailable",
				"capacity_full",
				"conflict",
				"dependency_unavailable",
				"client_disconnected",
				"stream_ended",
				"subscription_unconfirmed",
			]),
			subscriptionId: OpaqueIdV1Schema.optional(),
		})
		.nullable(),
	occurredAt: Rfc3339TimestampV1Schema,
	traceId: TraceIdV1Schema,
	requestId: RequestIdV1Schema.nullable(),
	agentId: OpaqueIdV1Schema.nullable(),
	conversationId: OpaqueIdV1Schema.nullable(),
	executionId: OpaqueIdV1Schema.nullable(),
	authorizationRecordId: OpaqueIdV1Schema.nullable(),
	originalPrincipal: ApiPrincipalV1Schema.nullable(),
	executor: z.literal("platform_worker").nullable(),
	operation: z
		.strictObject({
			eventId: OpaqueIdV1Schema,
			fact: RuntimeOperationFactV2Schema,
		})
		.nullable(),
});

export const ScopedPlatformAuditPageV1Schema = z.strictObject({
	items: z.array(ScopedPlatformAuditProjectionV1Schema),
	nextCursor: OpaqueCursorV1Schema.nullable(),
});

// #2909：显示名由服务端按查询方当前权限解析；无权查看、对象不存在或无法确认时为 null，
// 调用方只能看到类型与 ID。名称是普通元数据，不来自请求，也不进入审计记录本身。
const ScopedPlatformAuditDisplayNameV2Schema = z
	.string()
	.min(1)
	.max(200)
	.nullable();
const v1Shape = ScopedPlatformAuditProjectionV1Schema.shape;

/** V1 不可加字段（strict reader），V2 在新入口提供 Agent、创建申请与应用的显示名。 */
export const ScopedPlatformAuditProjectionV2Schema = z
	.strictObject({
		...v1Shape,
		schemaVersion: z.literal(2),
		actor: z.strictObject({
			...v1Shape.actor.shape,
			displayName: ScopedPlatformAuditDisplayNameV2Schema,
		}),
		subject: z.strictObject({
			...v1Shape.subject.shape,
			displayName: ScopedPlatformAuditDisplayNameV2Schema,
		}),
		originalPrincipal: z
			.strictObject({
				...ApiPrincipalV1Schema.shape,
				displayName: ScopedPlatformAuditDisplayNameV2Schema,
			})
			.nullable(),
		agentDisplayName: ScopedPlatformAuditDisplayNameV2Schema,
	})
	.superRefine((record, context) => {
		// 只有应用主体、Agent 与创建申请对象可以带名称；用户名称仍由目录按权限解析。
		const misplaced = [
			record.actor.displayName !== null && record.actor.kind !== "application"
				? "actor"
				: null,
			record.originalPrincipal?.displayName != null &&
			record.originalPrincipal.kind !== "application"
				? "originalPrincipal"
				: null,
			record.subject.displayName !== null &&
			record.subject.kind !== "agent" &&
			record.subject.kind !== "agent_application"
				? "subject"
				: null,
			record.agentDisplayName !== null && record.agentId === null
				? "agentDisplayName"
				: null,
		].filter((path) => path !== null);
		for (const path of misplaced)
			context.addIssue({
				code: "custom",
				path: [path],
				message: "Display name is not allowed for this reference",
			});
	});

export const ScopedPlatformAuditPageV2Schema = z.strictObject({
	items: z.array(ScopedPlatformAuditProjectionV2Schema),
	nextCursor: OpaqueCursorV1Schema.nullable(),
});

export const ScopedPlatformAuditQueryV1Schema = z.strictObject({
	limit: z.coerce.number().int().min(1).max(100).optional(),
	cursor: OpaqueCursorV1Schema.optional(),
	from: Rfc3339TimestampV1Schema.optional(),
	until: Rfc3339TimestampV1Schema.optional(),
	principalKind: z.enum(["user", "application"]).optional(),
	principalId: OpaqueIdV1Schema.optional(),
	agentId: OpaqueIdV1Schema.optional(),
	action: ScopedPlatformAuditActionV1Schema.optional(),
	result: ScopedPlatformAuditResultV1Schema.optional(),
	executionId: OpaqueIdV1Schema.optional(),
});

const json = (description: string, schema: z.ZodType) => ({
	description,
	content: { "application/json": { schema } },
});
const errors = Object.fromEntries(
	[400, 401, 403, 404, 503].map((status) => [
		String(status),
		json("Audit query failed", PilotProtocolErrorV1Schema),
	]),
);
const list = (
	operationId: string,
	security: Record<string, never[]>[],
	page: z.ZodType = ScopedPlatformAuditPageV1Schema,
	description = "Authorized audit metadata",
) => ({
	get: {
		operationId,
		security,
		requestParams: { query: ScopedPlatformAuditQueryV1Schema },
		responses: {
			"200": json(description, page),
			...errors,
		},
	},
});
const detail = (
	operationId: string,
	security: Record<string, never[]>[],
	projection: z.ZodType = ScopedPlatformAuditProjectionV1Schema,
	description = "Authorized audit detail",
) => ({
	get: {
		operationId,
		security,
		requestParams: {
			path: z.strictObject({ auditId: OpaqueIdV1Schema }),
			query: ScopedPlatformAuditQueryV1Schema,
		},
		responses: {
			"200": json(description, projection),
			...errors,
		},
	},
});

export const pilotScopedAuditOpenApiPathsV1 = {
	"/api/v1/audit": list("listOwnExecutionAudit", [
		{ PlatformSession: [] },
		{ platformApiCredential: [] },
	]),
	"/api/v1/audit/{auditId}": detail("getOwnExecutionAudit", [
		{ PlatformSession: [] },
		{ platformApiCredential: [] },
	]),
	"/api/v3/admin/audit": list("listScopedAdministratorAudit", [
		{ PlatformSession: [] },
	]),
	"/api/v3/admin/audit/{auditId}": detail("getScopedAdministratorAudit", [
		{ PlatformSession: [] },
	]),
} as const;

/** #2909：带显示名的 V2 入口；V1 路径与响应保持不变。 */
export const pilotScopedAuditOpenApiPathsV2 = {
	"/api/v2/audit": list(
		"listOwnExecutionAuditV2",
		[{ PlatformSession: [] }, { platformApiCredential: [] }],
		ScopedPlatformAuditPageV2Schema,
		"Authorized audit metadata with permitted display names",
	),
	"/api/v2/audit/{auditId}": detail(
		"getOwnExecutionAuditV2",
		[{ PlatformSession: [] }, { platformApiCredential: [] }],
		ScopedPlatformAuditProjectionV2Schema,
		"Authorized audit detail with permitted display names",
	),
	"/api/v4/admin/audit": list(
		"listScopedAdministratorAuditV2",
		[{ PlatformSession: [] }],
		ScopedPlatformAuditPageV2Schema,
		"Authorized audit metadata with permitted display names",
	),
	"/api/v4/admin/audit/{auditId}": detail(
		"getScopedAdministratorAuditV2",
		[{ PlatformSession: [] }],
		ScopedPlatformAuditProjectionV2Schema,
		"Authorized audit detail with permitted display names",
	),
} as const;

export const pilotScopedAuditSchemasV1 = {
	ScopedPlatformAuditResultV1: ScopedPlatformAuditResultV1Schema,
	ScopedPlatformAuditActionV1: ScopedPlatformAuditActionV1Schema,
	ScopedPlatformAuditProjectionV1: ScopedPlatformAuditProjectionV1Schema,
	ScopedPlatformAuditPageV1: ScopedPlatformAuditPageV1Schema,
};

export const pilotScopedAuditSchemasV2 = {
	ScopedPlatformAuditProjectionV2: ScopedPlatformAuditProjectionV2Schema,
	ScopedPlatformAuditPageV2: ScopedPlatformAuditPageV2Schema,
};

export type ScopedPlatformAuditProjectionV1 = z.infer<
	typeof ScopedPlatformAuditProjectionV1Schema
>;
export type ScopedPlatformAuditProjectionV2 = z.infer<
	typeof ScopedPlatformAuditProjectionV2Schema
>;
