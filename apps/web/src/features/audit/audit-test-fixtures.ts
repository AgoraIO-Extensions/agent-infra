import type { AuditRecord } from "./audit-query.js";

export function auditRecord(auditId = "audit-a"): AuditRecord {
	return {
		schemaVersion: 1,
		auditId,
		action: "task.api.submit.result",
		actor: { kind: "user", actorId: "user-a" },
		subject: { kind: "execution", subjectId: "execution-a" },
		result: "succeeded",
		summary: "任务已受理",
		taskApi: {
			operation: "submit",
			phase: "submit.result",
			reason: "task_accepted",
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
