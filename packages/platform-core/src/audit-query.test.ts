import { describe, expect, it } from "vitest";
import {
	type PlatformAuditQueryScopeV1,
	type PlatformExecutionAuditBindingV1,
	parsePlatformAuditQueryInputV1,
	parsePlatformAuditQueryScopeV1,
	projectPlatformAuditQueryDenialV1,
	projectPlatformAuditQueryRecordV1,
	projectPlatformAuditQuerySummaryV1,
	projectPlatformOperationAuditV1,
	projectPlatformTaskAuditSummaryV1,
	requirePlatformExecutionAuditBindingV1,
} from "./audit-query.js";

const user = {
	schemaVersion: 1 as const,
	userId: "principal-a",
	accountStatus: "active" as const,
	organizationIds: [],
	authorizationRevision: "directory-1",
};
const scope: PlatformAuditQueryScopeV1 = {
	kind: "execution",
	principal: { kind: "user", id: user.userId },
	user,
};
const admin: PlatformAuditQueryScopeV1 = {
	kind: "administrator",
	administratorId: "admin-a",
};
const credential = {
	schemaVersion: 1 as const,
	credentialId: "credential-a",
	principal: scope.principal,
	scopes: ["agent:use" as const],
	expiresAt: null,
	revokedAt: null,
	createdAt: new Date("2026-09-01T00:00:00Z"),
};
const binding: PlatformExecutionAuditBindingV1 = {
	executionId: "execution-a",
	agentId: "agent-a",
	actorId: user.userId,
	channelId: "web",
	authorizationRecordId: "authorization-a",
	acceptedActor: scope.principal,
	acceptedExecutionId: "execution-a",
	acceptedAgentId: "agent-a",
	acceptedAuthorizationRecordId: "authorization-a",
	boundary: {
		schemaVersion: 1,
		principal: scope.principal,
		agentId: "agent-a",
		channelId: "web",
		identityRevision: "directory-1",
		agentAuthorizationRevision: "agent-access-1",
		accessSources: [{ kind: "user", userId: user.userId }],
	},
};
const operation = {
	schemaVersion: 2,
	eventId: "event-a",
	authorizationRecordId: binding.authorizationRecordId,
	executor: "platform_worker",
	fact: {
		kind: "tool",
		operationRef: "operation-a",
		attemptRef: "attempt-a",
		phase: "unknown",
		toolId: "Read",
		failureCode: "recovery_unconfirmed",
	},
};

describe("scoped audit domain", () => {
	it("distinguishes durable task control reasons and retains the control reference", () => {
		for (const reason of [
			"stop",
			"authorization_revoked",
			"recovery",
			"generation_isolation",
		])
			expect(
				projectPlatformTaskAuditSummaryV1("task.control.created", {
					workerId: "worker-a",
					originalPrincipal: scope.principal,
					controlRecordId: "control-a",
					authorizationRecordId: "authorization-a",
					reason,
				}),
			).toBe(
				`task.control.created: reason=${reason}, controlRecordId=control-a`,
			);
	});

	it("distinguishes known task timeout reasons from absent or unrecognized reasons", () => {
		const details = {
			status: "unknown",
			eventId: "event-a",
			originalPrincipal: scope.principal,
		};
		expect(
			projectPlatformTaskAuditSummaryV1("task.status.changed", {
				...details,
				reason: "STOP_CONFIRMATION_TIMEOUT",
			}),
		).toBe(
			"task.status.changed: status=unknown, reason=STOP_CONFIRMATION_TIMEOUT",
		);
		expect(
			projectPlatformTaskAuditSummaryV1("task.status.changed", {
				...details,
				status: "failed",
				reason: "TASK_WAIT_TIMEOUT",
			}),
		).toBe("task.status.changed: status=failed, reason=TASK_WAIT_TIMEOUT");
		expect(
			projectPlatformTaskAuditSummaryV1("task.status.changed", details),
		).toBe("task.status.changed: status=unknown, reason=unknown");
		expect(
			projectPlatformTaskAuditSummaryV1("task.status.changed", {
				...details,
				reason: "PRIVATE_RUNTIME_ERROR_SENTINEL",
			}),
		).toBe("task.status.changed: status=unknown, reason=unknown");
	});

	it("retains valid legacy metadata without inventing a reason, state or control reference", () => {
		expect(
			projectPlatformTaskAuditSummaryV1("task.control.created", null),
		).toBe("task.control.created: reason=unknown, controlRecordId=unknown");
		expect(
			projectPlatformTaskAuditSummaryV1("task.status.changed", undefined),
		).toBe("task.status.changed: status=unknown, reason=unknown");
		expect(
			projectPlatformTaskAuditSummaryV1("task.status.changed", {
				status: "cancelled",
				eventId: "old-event",
				originalExecution: { actorId: user.userId, channelId: "web" },
				reason: "TASK_CANCELLED",
			}),
		).toBe("task.status.changed: status=cancelled, reason=TASK_CANCELLED");
	});

	it.each([
		{ body: "PRIVATE_SENTINEL" },
		{ secret: "PRIVATE_SENTINEL" },
		{ errorCode: "PRIVATE_SENTINEL" },
		{ originalPrincipal: { kind: "system", id: "worker-a" } },
		{ originalPrincipal: { kind: "user", id: user.userId, token: "PRIVATE" } },
		{ workerId: "" },
		{ authorizationRecordId: "" },
		{ controlRecordId: "" },
		{ controlRecordId: "a".repeat(1024) },
	])("rejects unsafe control summary metadata: %j", (change) => {
		expect(() =>
			projectPlatformTaskAuditSummaryV1("task.control.created", {
				workerId: "worker-a",
				originalPrincipal: scope.principal,
				controlRecordId: "control-a",
				authorizationRecordId: "authorization-a",
				reason: "stop",
				...change,
			}),
		).toThrowError(expect.objectContaining({ code: "unavailable" }));
	});

	it("rejects status summary secrets and ambiguous legacy identity", () => {
		for (const details of [
			{ status: "failed", body: "PRIVATE_SENTINEL" },
			{
				status: "failed",
				originalExecution: { actorId: user.userId, token: "PRIVATE" },
			},
			{
				status: "failed",
				originalPrincipal: scope.principal,
				originalExecution: { actorId: user.userId, channelId: "web" },
			},
		])
			expect(() =>
				projectPlatformTaskAuditSummaryV1("task.status.changed", details),
			).toThrowError(expect.objectContaining({ code: "unavailable" }));
	});

	it("projects a rejected query with a trusted actor and no caller-controlled scope fields", () => {
		expect(
			projectPlatformAuditQueryDenialV1({
				principal: scope.principal,
				requestedScope: "administrator",
				operation: "detail",
				result: "rejected",
				reason: "RESOURCE_UNAVAILABLE",
			}),
		).toEqual({
			actor: { kind: "user", actorId: user.userId },
			details: {
				schemaVersion: 1,
				scope: { kind: "denied", requestedScope: "administrator" },
				operation: "detail",
				result: "rejected",
				reason: "RESOURCE_UNAVAILABLE",
				count: 0,
			},
		});
	});

	it("records unresolved identity as unknown and preserves application kind", () => {
		const input = {
			principal: null,
			requestedScope: "execution" as const,
			operation: "list" as const,
			result: "failed" as const,
			reason: "DEPENDENCY_UNAVAILABLE" as const,
		};
		expect(projectPlatformAuditQueryDenialV1(input)).toMatchObject({
			actor: { kind: "unknown", actorId: "unknown" },
			details: { scope: { kind: "denied" }, result: "failed", count: 0 },
		});
		expect(
			projectPlatformAuditQueryDenialV1({
				...input,
				principal: { kind: "application", id: user.userId },
			}),
		).toMatchObject({ actor: { kind: "application", actorId: user.userId } });
	});

	it.each([
		{ principal: { kind: "system", id: "untrusted" } },
		{ principal: { kind: "user", id: "" } },
		{ principal: { kind: "user", id: "subject", roles: ["system_admin"] } },
		{ requestedScope: "owner" },
		{ operation: "export" },
		{ result: "succeeded" },
		{ reason: "PRIVATE_ERROR_SENTINEL" },
		{ reason: undefined },
		{ error: "PRIVATE_ERROR_SENTINEL" },
		{ filters: { executionId: "PRIVATE_FILTER" } },
		{ credential: "PRIVATE_CREDENTIAL" },
	])("rejects unbounded or invalid denied-query metadata: %j", (change) => {
		expect(() =>
			projectPlatformAuditQueryDenialV1({
				principal: scope.principal,
				requestedScope: "execution",
				operation: "list",
				result: "rejected",
				reason: "access_denied",
				...change,
			} as Parameters<typeof projectPlatformAuditQueryDenialV1>[0]),
		).toThrowError(expect.objectContaining({ code: "invalid_request" }));
	});

	it("rejects denied-query accessors without evaluating their identity", () => {
		let reads = 0;
		expect(() =>
			projectPlatformAuditQueryDenialV1({
				get principal() {
					reads += 1;
					return scope.principal;
				},
				requestedScope: "execution",
				operation: "list",
				result: "rejected",
				reason: "access_denied",
			}),
		).toThrowError(expect.objectContaining({ code: "invalid_request" }));
		expect(reads).toBe(0);
	});

	it("preserves distinct bounded denial reasons without exposing arbitrary metadata", () => {
		for (const reason of [
			"AUTHENTICATION_REQUIRED",
			"AUTHORIZATION_REVOKED",
		] as const) {
			const projection = projectPlatformAuditQueryDenialV1({
				principal: null,
				requestedScope: "execution",
				operation: "list",
				result: "rejected",
				reason,
			});
			expect(projection.details.reason).toBe(reason);
			expect(
				projectPlatformAuditQuerySummaryV1(
					"audit.query.failed",
					projection.details,
				),
			).toBe(`audit.query.failed: reason=${reason}`);
		}
		const record = projectPlatformAuditQueryRecordV1({
			scope,
			query: { limit: 1, filters: {} },
			operation: "detail",
			result: "rejected",
			count: 0,
			reason: "access_denied",
		});
		expect(
			projectPlatformAuditQuerySummaryV1("audit.query.failed", record),
		).toBe("audit.query.failed: reason=access_denied");
		const { reason: _reason, ...legacy } = record;
		expect(
			projectPlatformAuditQuerySummaryV1("audit.query.failed", legacy),
		).toBe("audit.query.failed: reason=unknown");
	});

	it.each([
		{ reason: "PRIVATE_ERROR_SENTINEL" },
		{ reason: { message: "PRIVATE_ERROR_SENTINEL" } },
		{ message: "PRIVATE_ERROR_SENTINEL" },
		{ filters: { executionId: "PRIVATE_FILTER_SENTINEL" } },
		{
			scope: { kind: "denied", requestedScope: "execution", token: "PRIVATE" },
		},
		{ count: 1 },
		{ result: "succeeded" },
	])("rejects unsafe stored query summary metadata: %j", (change) => {
		expect(() =>
			projectPlatformAuditQuerySummaryV1("audit.query.failed", {
				schemaVersion: 1,
				scope: { kind: "denied", requestedScope: "execution" },
				operation: "list",
				result: "rejected",
				count: 0,
				reason: "AUTHENTICATION_REQUIRED",
				...change,
			}),
		).toThrowError(
			expect.objectContaining({
				code: "unavailable",
				message: "Platform audit query is unavailable",
			}),
		);
	});

	it("rejects arbitrary projected query reasons and reasons on successful queries", () => {
		for (const change of [
			{ result: "rejected", reason: "PRIVATE_ERROR_SENTINEL" },
			{ result: "succeeded", reason: "access_denied" },
		])
			expect(() =>
				projectPlatformAuditQueryRecordV1({
					scope,
					query: { limit: 1, filters: {} },
					operation: "list",
					count: 0,
					...change,
				} as never),
			).toThrowError(expect.objectContaining({ code: "invalid_request" }));
	});

	it("rejects a stored query reason accessor without reading its error", () => {
		let reads = 0;
		expect(() =>
			projectPlatformAuditQuerySummaryV1("audit.query.failed", {
				schemaVersion: 1,
				scope: { kind: "denied", requestedScope: "execution" },
				operation: "list",
				result: "rejected",
				count: 0,
				get reason() {
					reads += 1;
					return "PRIVATE_ERROR_SENTINEL";
				},
			}),
		).toThrowError(expect.objectContaining({ code: "unavailable" }));
		expect(reads).toBe(0);
	});

	it("binds equal string IDs to their distinct principal kinds", () => {
		const application = { kind: "application" as const, id: user.userId };
		expect(
			parsePlatformAuditQueryScopeV1({
				kind: "execution",
				principal: application,
				credential: { ...credential, principal: application },
			}),
		).toMatchObject({ principal: application });
		expect(() =>
			parsePlatformAuditQueryScopeV1({
				kind: "execution",
				principal: application,
				credential,
			}),
		).toThrowError(expect.objectContaining({ code: "access_denied" }));
		expect(() =>
			parsePlatformAuditQueryInputV1(
				{ limit: 10, filters: { principal: application } },
				scope,
			),
		).toThrowError(expect.objectContaining({ code: "access_denied" }));
	});

	it.each([
		{ ...scope, user: { ...user, accountStatus: "disabled" } },
		{ ...scope, user: { ...user, userId: "other-user" } },
		{ ...scope, credential: { ...credential, revokedAt: new Date() } },
		{
			...scope,
			credential: {
				...credential,
				expiresAt: new Date("2026-09-01T00:00:00Z"),
			},
		},
		{ ...scope, credential: { ...credential, scopes: ["agent:manage"] } },
		{ ...scope, ownerId: "principal-a" },
		{
			kind: "execution",
			principal: { kind: "application", id: "application-a" },
		},
	])(
		"rejects inactive identities, credentials and role-based scope widening",
		(input) => {
			expect(() =>
				parsePlatformAuditQueryScopeV1(input, new Date("2026-09-26T00:00:00Z")),
			).toThrowError(expect.objectContaining({ code: "access_denied" }));
		},
	);

	it("snapshots credential scopes and dates before asynchronous query work", () => {
		const mutable = {
			...credential,
			scopes: [...credential.scopes],
			expiresAt: new Date("2027-01-01T00:00:00Z"),
		};
		const parsed = parsePlatformAuditQueryScopeV1({
			...scope,
			credential: mutable,
		});
		mutable.scopes.length = 0;
		mutable.expiresAt.setTime(0);
		expect(parsed).toMatchObject({
			credential: {
				scopes: ["agent:use"],
				expiresAt: new Date("2027-01-01T00:00:00Z"),
			},
		});
	});

	it("rejects sparse credential scopes before a query can be admitted", () => {
		const scopes = new Array(2);
		scopes[1] = "agent:use";
		expect(() =>
			parsePlatformAuditQueryScopeV1({
				...scope,
				credential: { ...credential, scopes },
			}),
		).toThrowError(expect.objectContaining({ code: "access_denied" }));
	});

	it("normalizes inclusive start and exclusive end with six finite filters", () => {
		expect(
			parsePlatformAuditQueryInputV1(
				{
					limit: 50,
					filters: {
						from: "2026-09-25T08:00:00+08:00",
						until: "2026-09-26T00:00:00Z",
						principal: scope.principal,
						agentId: "agent-a",
						action: "execution.operation.observed",
						result: "unknown",
						executionId: binding.executionId,
					},
				},
				scope,
			).filters,
		).toMatchObject({
			from: "2026-09-25T00:00:00.000Z",
			until: "2026-09-26T00:00:00.000Z",
			result: "unknown",
		});
	});

	it.each([
		{ limit: 101, filters: {} },
		{ limit: 10, filters: {}, cursor: "" },
		{ limit: 10, filters: {}, body: "SENSITIVE_SENTINEL" },
		{ limit: 10, filters: { body: "SENSITIVE_SENTINEL" } },
		{ limit: 10, filters: { action: "SENSITIVE_SENTINEL" } },
		{ limit: 10, filters: { result: "guessed-success" } },
		{ limit: 10, filters: { from: "2026-02-30T00:00:00Z" } },
		{
			limit: 10,
			filters: { from: "2026-09-26T00:00:00Z", until: "2026-09-25T00:00:00Z" },
		},
	])("rejects malformed filters without retaining caller fields", (input) => {
		expect(() => parsePlatformAuditQueryInputV1(input, scope)).toThrowError(
			expect.objectContaining({
				code: "invalid_request",
				message: "Platform audit query is unavailable",
			}),
		);
	});

	it("retains original principal and actual Worker independently", () => {
		expect(
			projectPlatformOperationAuditV1(operation, binding, scope),
		).toMatchObject({
			originalPrincipal: scope.principal,
			executor: "platform_worker",
			result: "unknown",
			fact: {
				operationRef: "operation-a",
				attemptRef: "attempt-a",
				phase: "unknown",
			},
		});
	});

	it.each(["intent", "started", "completed", "failed", "unknown"] as const)(
		"projects operation phase %s independently of observation success",
		(phase) => {
			const fact = { ...operation.fact, phase, failureCode: undefined };
			delete fact.failureCode;
			expect(
				projectPlatformOperationAuditV1({ ...operation, fact }, binding, admin)
					.result,
			).toBe(phase);
		},
	);

	it.each([
		{ ...binding, executionId: "other-execution" },
		{ ...binding, acceptedAuthorizationRecordId: "other-authorization" },
		{ ...binding, actorId: "other-user" },
		{ ...binding, agentId: "other-agent" },
		{ ...binding, channelId: "api:user" },
		{ ...binding, acceptedActor: { kind: "application", id: user.userId } },
		{ ...binding, boundary: null },
	])("rejects unverified or substituted original acceptance", (input) => {
		expect(() =>
			requirePlatformExecutionAuditBindingV1(
				input as PlatformExecutionAuditBindingV1,
				scope,
			),
		).toThrowError(expect.objectContaining({ code: "access_denied" }));
	});

	it.each([
		{ ...operation, authorizationRecordId: "other-authorization" },
		{ ...operation, executor: "caller-supplied" },
		{ ...operation, body: "SENSITIVE_SENTINEL" },
		{
			...operation,
			fact: { ...operation.fact, arguments: "SENSITIVE_SENTINEL" },
		},
		{
			...operation,
			fact: {
				...operation.fact,
				durationMs: 0,
				finishedAt: "2026-09-26T00:00:00Z",
			},
		},
	])("rejects forged metadata and unconfirmed timing", (input) => {
		expect(() =>
			projectPlatformOperationAuditV1(input, binding, scope),
		).toThrowError(expect.objectContaining({ code: "unavailable" }));
	});

	it("records a finite query without identity, credentials, cursor or recursive writes", () => {
		const projection = projectPlatformAuditQueryRecordV1({
			scope: { ...scope, credential },
			query: { limit: 10, cursor: "private-cursor", filters: {} },
			operation: "list",
			result: "succeeded",
			count: 3,
		});
		expect(projection).toEqual({
			schemaVersion: 1,
			scope: { kind: "execution", principal: scope.principal },
			operation: "list",
			filters: {},
			limit: 10,
			hasCursor: true,
			result: "succeeded",
			count: 3,
		});
		expect(JSON.stringify(projection)).not.toMatch(
			/credential|private-cursor|directory-1/,
		);
		expect(() =>
			projectPlatformAuditQueryRecordV1({
				scope,
				query: { limit: 10, filters: {} },
				operation: "list",
				result: "failed",
				count: 1,
			}),
		).toThrowError(expect.objectContaining({ code: "invalid_request" }));
	});

	it.each([false, true])(
		"rejects query record accessors without evaluating them",
		(throws) => {
			let reads = 0;
			const input = {
				scope,
				query: { limit: 10, filters: {} },
				operation: "list" as const,
				result: "succeeded" as const,
				get count() {
					reads += 1;
					if (throws) throw new Error("SENSITIVE_SENTINEL");
					return reads < 4 ? 0 : "SENSITIVE_SENTINEL";
				},
			};
			expect(() =>
				projectPlatformAuditQueryRecordV1(input as never),
			).toThrowError(
				expect.objectContaining({
					code: "invalid_request",
					message: "Platform audit query is unavailable",
				}),
			);
			expect(reads).toBe(0);
		},
	);

	it("rejects an accessor that substitutes the accepted authorization binding", () => {
		let reads = 0;
		const substituted = {
			...binding,
			get authorizationRecordId() {
				reads += 1;
				return reads < 3
					? binding.authorizationRecordId
					: "other-authorization";
			},
		};
		expect(() =>
			projectPlatformOperationAuditV1(
				{ ...operation, authorizationRecordId: "other-authorization" },
				substituted,
				scope,
			),
		).toThrowError(expect.objectContaining({ code: "access_denied" }));
		expect(reads).toBe(0);
	});

	it("records only the presence of unverified identifier filters", () => {
		const projection = projectPlatformAuditQueryRecordV1({
			scope: admin,
			query: {
				limit: 10,
				filters: {
					principal: { kind: "user", id: "Bearer SENSITIVE_SENTINEL" },
					agentId: "Bearer SENSITIVE_SENTINEL",
					executionId: "Bearer SENSITIVE_SENTINEL",
					action: "execution.operation.observed",
					result: "unknown",
				},
			},
			operation: "list",
			result: "succeeded",
			count: 0,
		});
		expect(projection.filters).toEqual({
			hasPrincipal: true,
			hasAgentId: true,
			hasExecutionId: true,
			action: "execution.operation.observed",
			result: "unknown",
		});
		expect(JSON.stringify(projection)).not.toContain("SENSITIVE_SENTINEL");
	});
});
