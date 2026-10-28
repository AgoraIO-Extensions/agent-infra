import { describe, expect, it } from "vitest";
import {
	ScopedPlatformAuditProjectionV1Schema,
	ScopedPlatformAuditProjectionV2Schema,
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
	it.each([
		"api.agent.create.accepted",
		"api.agent.create.replayed",
		"api.agent.create.refused",
		"relay_key.agent_default.replace",
	])(
		"preserves the existing creation producer action %s without exposing private fields",
		(action) => {
			const creation = {
				...record,
				action,
				actor: { kind: "application", actorId: "robot" },
				subject: { kind: "agent", subjectId: "agent-a" },
				result: action.endsWith("refused") ? "rejected" : "succeeded",
				summary: action,
				conversationId: null,
				executionId: null,
				authorizationRecordId: null,
				originalPrincipal: null,
				executor: null,
				operation: null,
			};
			expect(ScopedPlatformAuditProjectionV1Schema.parse(creation)).toEqual(
				creation,
			);
			expect(ScopedPlatformAuditQueryV1Schema.parse({ action })).toEqual({
				action,
			});
			for (const field of [
				"credential",
				"defaultRelayKey",
				"details",
				"configuration",
			])
				expect(
					ScopedPlatformAuditProjectionV1Schema.safeParse({
						...creation,
						[field]: "private-sentinel",
					}).success,
				).toBe(false);
		},
	);
	it("continues to reject unregistered creation or Relay Key actions", () => {
		for (const action of [
			"api.agent.create.guessed",
			"relay_key.agent_default.guessed",
		])
			expect(
				ScopedPlatformAuditProjectionV1Schema.safeParse({ ...record, action })
					.success,
			).toBe(false);
	});
	it.each([
		"skill.project.create",
		"skill.project.update",
		"skill.project.list",
		"skill.project.read",
		"relay_key.agent_default.read",
		"relay_key.agent_default.candidates",
	])(
		"accepts the #2879 registered action %s in scoped audit projections",
		(action) => {
			expect(
				ScopedPlatformAuditProjectionV1Schema.safeParse({
					...record,
					action,
					subject: { kind: "agent", subjectId: "agent-b" },
					result: "succeeded",
					summary: action,
				}).success,
			).toBe(true);
		},
	);
	it.each([
		"api.credential.issued",
		"api.credential.revoked",
		"api.credential.narrowed",
	])(
		"preserves the known credential reference for %s without private details",
		(action) => {
			const mutation = {
				...record,
				action,
				actor: { kind: "user", actorId: "user-a" },
				subject: { kind: "api_credential", subjectId: "api_credential_a" },
				result: "succeeded",
				summary: action,
				agentId: null,
				conversationId: null,
				executionId: null,
				authorizationRecordId: null,
				originalPrincipal: null,
				executor: null,
				operation: null,
			};
			expect(ScopedPlatformAuditProjectionV1Schema.parse(mutation)).toEqual(
				mutation,
			);
		},
	);

	it.each(["credential", "credentialHash", "scopes", "expiresAt", "details"])(
		"rejects credential %s in the object reference or projection",
		(field) => {
			const subject = { kind: "api_credential", subjectId: "api_credential_a" };
			for (const input of [
				{ ...record, subject: { ...subject, [field]: "SENSITIVE_SENTINEL" } },
				{ ...record, subject, [field]: "SENSITIVE_SENTINEL" },
			]) {
				expect(
					ScopedPlatformAuditProjectionV1Schema.safeParse(input).success,
				).toBe(false);
			}
		},
	);

	it.each([
		{ kind: "api_credential", subjectId: "" },
		{ kind: "invented_credential", subjectId: "api_credential_a" },
	])("rejects invalid credential object references", (subject) => {
		expect(
			ScopedPlatformAuditProjectionV1Schema.safeParse({ ...record, subject })
				.success,
		).toBe(false);
	});

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

	it("publishes WeCom lifecycle and delivery actions without private details", () => {
		for (const action of [
			"wecom.setup_started",
			"wecom.callback_verified",
			"wecom.connection_connected",
			"wecom.accepted",
			"wecom.unknown",
			// #3258：#3184 与 #3241 已有写入方的企微回执动作
			"wecom.conversation_started",
			"wecom.conversation_unavailable",
			"wecom.media_rejected",
		] as const) {
			expect(
				ScopedPlatformAuditProjectionV1Schema.shape.action.safeParse(action)
					.success,
			).toBe(true);
			expect(ScopedPlatformAuditQueryV1Schema.parse({ action })).toEqual({
				action,
			});
		}
		expect(
			ScopedPlatformAuditProjectionV1Schema.shape.action.safeParse(
				"wecom.not_registered",
			).success,
		).toBe(false);
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

describe("scoped public audit display-name V2 contract (#2909)", () => {
	const named = {
		...record,
		schemaVersion: 2,
		actor: { ...record.actor, displayName: null },
		subject: { ...record.subject, displayName: null },
		originalPrincipal: {
			...record.originalPrincipal,
			displayName: "运维机器人",
		},
		agentDisplayName: "编程助手",
	};

	it("carries names only for applications, Agents and creation applications", () => {
		expect(ScopedPlatformAuditProjectionV2Schema.parse(named)).toEqual(named);
		const agentSubject = {
			...named,
			subject: { kind: "agent", subjectId: "agent-a", displayName: "编程助手" },
		};
		expect(ScopedPlatformAuditProjectionV2Schema.parse(agentSubject)).toEqual(
			agentSubject,
		);
		const application = {
			...named,
			actor: {
				kind: "application",
				actorId: "application-a",
				displayName: "运维机器人",
			},
			subject: {
				kind: "agent_application",
				subjectId: "agent-application-a",
				displayName: "编程助手",
			},
		};
		expect(ScopedPlatformAuditProjectionV2Schema.parse(application)).toEqual(
			application,
		);
	});

	it.each([
		{ actor: { kind: "user", actorId: "user-a", displayName: "张三" } },
		{
			actor: {
				kind: "system",
				actorId: "platform_worker",
				displayName: "后台",
			},
		},
		{
			originalPrincipal: {
				kind: "user",
				id: "user-a",
				displayName: "张三",
			},
		},
		{
			subject: {
				kind: "execution",
				subjectId: "execution-a",
				displayName: "执行",
			},
		},
		{ agentId: null, agentDisplayName: "编程助手" },
	])("rejects a display name on a reference that cannot carry one", (input) => {
		expect(
			ScopedPlatformAuditProjectionV2Schema.safeParse({ ...named, ...input })
				.success,
		).toBe(false);
	});

	it("keeps V2 strict and bounded, and V1 readers reject V2 fields", () => {
		for (const input of [
			{ credential: "private-sentinel" },
			{ schemaVersion: 1 },
			{ agentDisplayName: "" },
			{ agentDisplayName: "名".repeat(201) },
			{ actor: { ...named.actor, email: "user@example.invalid" } },
		])
			expect(
				ScopedPlatformAuditProjectionV2Schema.safeParse({ ...named, ...input })
					.success,
			).toBe(false);
		const { agentDisplayName: _name, ...withoutName } = named;
		expect(
			ScopedPlatformAuditProjectionV2Schema.safeParse(withoutName).success,
		).toBe(false);
		expect(
			ScopedPlatformAuditProjectionV1Schema.safeParse({
				...record,
				agentDisplayName: "编程助手",
			}).success,
		).toBe(false);
		expect(ScopedPlatformAuditProjectionV1Schema.parse(record)).toEqual(record);
	});
});

it.each([
	"application.credential.issued",
	"application.credential.rotated",
	"application.credential.delivery",
	"application.credential.metadata.read",
	"application.credential.revoked",
])("publishes bounded application governance %s", (action) => {
	const input = {
		...record,
		action,
		actor: { kind: "user", actorId: "manager" },
		subject: { kind: "application", subjectId: "application-a" },
		result: "succeeded",
		taskApi: null,
		originalPrincipal: null,
		executor: null,
		operation: null,
	};
	expect(ScopedPlatformAuditProjectionV1Schema.parse(input)).toEqual(input);
	for (const field of ["credential", "credentialHash", "details"])
		expect(
			ScopedPlatformAuditProjectionV1Schema.safeParse({
				...input,
				[field]: "PRIVATE_SENTINEL",
			}).success,
		).toBe(false);
});
