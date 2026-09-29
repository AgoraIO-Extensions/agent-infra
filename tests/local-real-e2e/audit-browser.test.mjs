import assert from "node:assert/strict";
import test from "node:test";

import { validateAuditBrowserFixture } from "./audit-browser-validation.mjs";

function fixture(auditId, principalId = "audit-user-a") {
	return {
		schemaVersion: 1,
		auditId,
		action: "task.api.access",
		actor: { kind: "user", actorId: principalId },
		subject: { kind: "agent", subjectId: "agent-a" },
		result: "accepted",
		summary: "受控审计 fixture",
		taskApi: {
			operation: "submit",
			phase: "access",
			reason: "request_accepted",
		},
		occurredAt: "2026-09-28T00:00:00.000Z",
		traceId: "trace-a",
		requestId: "request-a",
		agentId: "agent-a",
		conversationId: null,
		executionId: null,
		authorizationRecordId: null,
		originalPrincipal: { kind: "user", id: principalId },
		executor: null,
		operation: null,
	};
}

test("controlled browser fixture validates principal scope and preserves cursor", () => {
	const result = validateAuditBrowserFixture(
		{ items: [fixture("audit-a")], nextCursor: "cursor-next" },
		{ kind: "user", id: "audit-user-a" },
	);
	assert.deepEqual(result, {
		count: 1,
		nextCursor: "cursor-next",
		auditIds: ["audit-a"],
		containsSensitiveBody: false,
	});
});

test("controlled browser fixture rejects cross-principal data and sensitive body", () => {
	assert.equal(
		validateAuditBrowserFixture(
			{
				items: [
					{
						...fixture("audit-b", "audit-user-b"),
						body: "PRIVATE_SYNTHETIC_AUDIT_BODY",
					},
				],
				nextCursor: null,
			},
			{ kind: "user", id: "audit-user-a" },
		),
		null,
	);
});
