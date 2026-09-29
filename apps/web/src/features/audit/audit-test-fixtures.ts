import type { AuditRecord } from "./audit-query.js";

export function auditRecord(auditId = "audit-a"): AuditRecord {
	return {
		schemaVersion: 1,
		auditId,
		action: "task.api.access",
		actor: { kind: "user", actorId: "user-a" },
		subject: { kind: "agent", subjectId: "agent-a" },
		result: "accepted",
		summary: "任务 API 访问获准",
		taskApi: {
			operation: "submit",
			phase: "access",
			reason: "request_accepted",
		},
		occurredAt: "2026-09-28T00:00:00.000Z",
		traceId: "trace-a",
		requestId: "request-a",
		agentId: "agent-a",
		conversationId: "conversation-a",
		executionId: "execution-a",
		authorizationRecordId: "authorization-a",
		originalPrincipal: { kind: "user", id: "user-a" },
		executor: null,
		operation: null,
	};
}

export function auditPage(
	auditId = "audit-a",
	nextCursor: string | null = null,
) {
	return { items: [auditRecord(auditId)], nextCursor };
}
