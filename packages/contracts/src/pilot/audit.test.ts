import { describe, expect, it } from "vitest";
import {
	ScopedPlatformAuditProjectionV1Schema,
	ScopedPlatformAuditQueryV1Schema,
} from "./audit.ts";

const record = {
	schemaVersion: 1,
	auditId: "audit-operation-a",
	action: "execution.operation.observed",
	actor: { kind: "system", actorId: "platform_worker" },
	subject: { kind: "execution", subjectId: "execution-a" },
	result: "unknown",
	summary: "execution.operation.observed",
	taskApi: null,
	occurredAt: "2026-09-26T00:00:00Z",
	traceId: "trace-a",
	requestId: null,
	agentId: "agent-a",
	conversationId: "conversation-a",
	executionId: "execution-a",
	authorizationRecordId: "authorization-a",
	originalPrincipal: { kind: "application", id: "application-a" },
	executor: "platform_worker",
	operation: {
		eventId: "operation-event-a",
		fact: {
			kind: "tool",
			operationRef: "operation-a",
			attemptRef: "attempt-a",
			phase: "unknown",
			toolId: "Read",
			failureCode: "recovery_unconfirmed",
		},
	},
};

describe("scoped public audit contract", () => {
	it("preserves the original application and actual Worker separately", () => {
		expect(ScopedPlatformAuditProjectionV1Schema.parse(record)).toEqual(record);
	});

	it.each([
		{ ...record, details: { body: "SENSITIVE_SENTINEL" } },
		{ ...record, credential: "SENSITIVE_SENTINEL" },
		{
			...record,
			operation: {
				...record.operation,
				fact: { ...record.operation.fact, arguments: "SENSITIVE_SENTINEL" },
			},
		},
		{ ...record, result: "guessed-success" },
		{ ...record, executor: "caller-supplied" },
		{ ...record, summary: "" },
		{ ...record, summary: "a".repeat(1025) },
		{ ...record, summary: undefined },
		{ ...record, taskApi: undefined },
	])("rejects private fields and invented outcomes", (input) => {
		expect(ScopedPlatformAuditProjectionV1Schema.safeParse(input).success).toBe(
			false,
		);
	});

	it("preserves a trusted request attempt without inventing an Execution binding", () => {
		const attempt = {
			...record,
			action: "task.api.access",
			actor: { kind: "application", actorId: "application-a" },
			subject: { kind: "agent", subjectId: "agent-a" },
			result: "succeeded",
			summary: "task.api.access: request_accepted",
			taskApi: {
				operation: "submit",
				phase: "access",
				reason: "request_accepted",
			},
			conversationId: null,
			executionId: null,
			authorizationRecordId: null,
			originalPrincipal: null,
			executor: null,
			operation: null,
		};
		expect(ScopedPlatformAuditProjectionV1Schema.parse(attempt)).toEqual(
			attempt,
		);
	});

	it.each([
		{ body: "SENSITIVE_SENTINEL" },
		{ secret: "SENSITIVE_SENTINEL" },
		{ details: { reason: "SENSITIVE_SENTINEL" } },
		{ reason: "SENSITIVE_SENTINEL" },
		{ operation: "caller-operation" },
		{ phase: "caller-phase" },
	])("rejects private or unsupported task API metadata", (input) => {
		expect(
			ScopedPlatformAuditProjectionV1Schema.safeParse({
				...record,
				taskApi: {
					operation: "read",
					phase: "access",
					reason: "missing_scope",
					...input,
				},
			}).success,
		).toBe(false);
	});

	it("does not add timing or execution facts to a historic management record", () => {
		const historic = {
			...record,
			action: "agent.lifecycle.stopped",
			actor: { kind: "user", actorId: "admin-a" },
			subject: { kind: "agent", subjectId: "agent-a" },
			result: "succeeded",
			conversationId: null,
			executionId: null,
			authorizationRecordId: null,
			originalPrincipal: null,
			executor: null,
			operation: null,
		};
		expect(ScopedPlatformAuditProjectionV1Schema.parse(historic)).toEqual(
			historic,
		);
	});

	it.each([
		{ limit: "101" },
		{ limit: "2.5" },
		{ result: "guessed-success" },
		{ action: "caller.action" },
		{ ownerId: "other-user" },
		{ body: "SENSITIVE_SENTINEL" },
	])("rejects unbounded or unsupported query input", (input) => {
		expect(ScopedPlatformAuditQueryV1Schema.safeParse(input).success).toBe(
			false,
		);
	});
});
