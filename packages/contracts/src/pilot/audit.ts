import { z } from "zod";
import {
	OpaqueCursorV1Schema,
	OpaqueIdV1Schema,
	RequestIdV1Schema,
	Rfc3339TimestampV1Schema,
	TraceIdV1Schema,
} from "../index.ts";
import { RuntimeOperationFactV2Schema } from "../runtime/events-v2.ts";
import { ApiPrincipalV1Schema } from "./browser.ts";
import { PilotProtocolErrorV1Schema } from "./errors.ts";

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
	"api.credential.delivery.granted",
	"api.credential.delivery.revoked",
	"api.agent.grant.granted",
	"api.agent.grant.revoked",
	"task.api.access",
	"task.api.submit.result",
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
		]),
		subjectId: OpaqueIdV1Schema,
	}),
	result: ScopedPlatformAuditResultV1Schema,
	summary: z.string().min(1).max(1024),
	taskApi: z
		.strictObject({
			operation: z.enum(["submit", "read", "cancel", "subscribe"]),
			phase: z.enum([
				"access",
				"submit.result",
				"subscription.started",
				"subscription.ended",
			]),
			reason: z.enum([
				"request_accepted",
				"task_accepted",
				"task_replayed",
				"idempotency_conflict",
				"agent_unavailable",
				"conversation_unavailable",
				"model_unavailable",
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
const list = (operationId: string, security: Record<string, never[]>[]) => ({
	get: {
		operationId,
		security,
		requestParams: { query: ScopedPlatformAuditQueryV1Schema },
		responses: {
			"200": json("Authorized audit metadata", ScopedPlatformAuditPageV1Schema),
			...errors,
		},
	},
});
const detail = (operationId: string, security: Record<string, never[]>[]) => ({
	get: {
		operationId,
		security,
		requestParams: {
			path: z.strictObject({ auditId: OpaqueIdV1Schema }),
			query: ScopedPlatformAuditQueryV1Schema,
		},
		responses: {
			"200": json(
				"Authorized audit detail",
				ScopedPlatformAuditProjectionV1Schema,
			),
			...errors,
		},
	},
});

export const pilotScopedAuditOpenApiPathsV1 = {
	"/api/v1/audit": list("listOwnExecutionAudit", [
		{ platformApiCredential: [] },
		{},
	]),
	"/api/v1/audit/{auditId}": detail("getOwnExecutionAudit", [
		{ platformApiCredential: [] },
		{},
	]),
	"/api/v3/admin/audit": list("listScopedAdministratorAudit", []),
	"/api/v3/admin/audit/{auditId}": detail("getScopedAdministratorAudit", []),
} as const;

export const pilotScopedAuditSchemasV1 = {
	ScopedPlatformAuditResultV1: ScopedPlatformAuditResultV1Schema,
	ScopedPlatformAuditActionV1: ScopedPlatformAuditActionV1Schema,
	ScopedPlatformAuditProjectionV1: ScopedPlatformAuditProjectionV1Schema,
	ScopedPlatformAuditPageV1: ScopedPlatformAuditPageV1Schema,
};

export type ScopedPlatformAuditProjectionV1 = z.infer<
	typeof ScopedPlatformAuditProjectionV1Schema
>;
