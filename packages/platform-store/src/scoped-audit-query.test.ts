import { randomUUID } from "node:crypto";
import {
	type ApiPrincipalV1,
	createConversationEventUseCaseV1,
	createTaskApiAuditV1,
	type PlatformAuditQueryScopeV1,
	type TaskAuthorizationBoundaryV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresConversationEventTransactionV1 } from "./conversation-events.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";
import { PostgresScopedPlatformAuditQueryV1 } from "./scoped-audit-query.ts";
import { PostgresTaskApiAuditStoreV1 } from "./task-api-audit.ts";
import {
	insertTaskAuthorization,
	PostgresTaskAuthorizationStoreV1,
} from "./task-authorization.ts";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let query: PostgresScopedPlatformAuditQueryV1;
const admin: PlatformAuditQueryScopeV1 = {
	kind: "administrator",
	administratorId: "platform-admin",
};
const request = () => ({ requestId: randomUUID(), traceId: randomUUID() });
const page = { limit: 100, filters: {} };
const detail = { limit: 1, filters: {} };

beforeAll(async () => {
	database = await startPostgresTestDatabase("scoped-audit-query");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 10 });
	query = new PostgresScopedPlatformAuditQueryV1({
		databaseUrl: database.databaseUrl,
	});
}, 120_000);
afterAll(async () => {
	await query?.close();
	await sql?.end();
	await database?.stop();
});

async function fixture(
	principal: ApiPrincipalV1 = { kind: "user", id: randomUUID() },
	agentId = randomUUID(),
	withProvenance = true,
) {
	const executionId = randomUUID();
	const conversationId = randomUUID();
	const channelId =
		principal.kind === "application" ? "api:application" : "web";
	await sql`insert into platform.agents (id, authorization_revision) values (${agentId}, 'current-agent-revision') on conflict do nothing`;
	await sql`insert into platform.agent_applications (id, agent_id, applicant_id, name, description, status, trace_id, request_id, submitted_at)
		values (${randomUUID()}, ${agentId}, ${principal.id}, 'Audit fixture', 'Controlled metadata', 'pending_approval', 'seed-trace', 'seed-request', now()) on conflict do nothing`;
	await sql`insert into platform.agent_availability (agent_id, target_type, target_id) values (${agentId}, ${principal.kind}, ${principal.id}) on conflict do nothing`;
	await sql`insert into platform.agent_owners (agent_id, owner_id, created_at) values (${agentId}, 'different-owner', now()) on conflict do nothing`;
	await sql`insert into platform.agent_principal_grants (agent_id, principal_type, principal_id, grant_type, authorization_revision)
		values (${agentId}, ${principal.kind}, ${principal.id}, 'use', 'current-agent-revision') on conflict do nothing`;
	let scope: PlatformAuditQueryScopeV1;
	if (principal.kind === "application") {
		await sql`insert into platform.platform_applications (id, name, responsible_user_id, authorization_revision)
			values (${principal.id}, 'Test application', 'different-responsible-user', 'application-current') on conflict do nothing`;
		const credentialId = randomUUID();
		await sql`insert into platform.platform_api_credentials (id, principal_type, principal_id, credential_hash, scopes)
			values (${credentialId}, 'application', ${principal.id}, ${credentialId.replaceAll("-", "").padEnd(64, "0")}, '["agent:use"]')`;
		scope = {
			kind: "execution",
			principal,
			credential: {
				schemaVersion: 1,
				credentialId,
				principal,
				scopes: ["agent:use"],
				expiresAt: null,
				revokedAt: null,
				createdAt: new Date(),
			},
		};
	} else
		scope = {
			kind: "execution",
			principal,
			user: {
				schemaVersion: 1,
				userId: principal.id,
				accountStatus: "active",
				organizationIds: [],
				authorizationRevision: "directory-current",
			},
		};
	await sql`insert into platform.conversations (id, agent_id, actor_id, channel_id, status, session_generation, authorization_revision, created_at, updated_at)
		values (${conversationId}, ${agentId}, ${principal.id}, ${channelId}, 'active', 1, 'current-agent-revision', now(), now())`;
	await sql`insert into platform.conversation_executions (execution_id, conversation_id, agent_id, actor_id, channel_id, turn_id, status,
		session_generation, delivery_fence, authorization_revision, model_configuration_revision, model_option_id, reasoning_level, created_at, updated_at)
		values (${executionId}, ${conversationId}, ${agentId}, ${principal.id}, ${channelId}, ${randomUUID()}, 'processing', 1, 1, 'current-agent-revision', 1, 'test-model-option', 'medium', now(), now())`;
	const boundary: TaskAuthorizationBoundaryV1 = {
		schemaVersion: 1,
		principal,
		agentId,
		channelId,
		identityRevision: "original-identity",
		agentAuthorizationRevision: "current-agent-revision",
		accessSources:
			principal.kind === "user"
				? [{ kind: "user", userId: principal.id }]
				: [{ kind: "application", applicationId: principal.id }],
	};
	if (withProvenance)
		await sql.begin((transaction) =>
			insertTaskAuthorization(transaction, {
				executionId,
				boundary,
				traceId: "original-trace",
				requestId: "original-request",
			}),
		);
	const auditId = randomUUID();
	await sql`insert into platform.conversation_audit_events (id, conversation_id, execution_id, agent_id, actor_id, action, trace_id, request_id, occurred_at)
		values (${auditId}, ${conversationId}, ${executionId}, ${agentId}, ${principal.id}, 'conversation.task.accepted', 'task-trace', 'task-request', now())`;
	return { principal, scope, agentId, executionId, conversationId, auditId };
}

describe("controlled PostgreSQL audit query", () => {
	it.each(["user", "application"] as const)(
		"queries accepted and replayed attempts through the same original %s Execution",
		async (kind) => {
			const f = await fixture({ kind, id: randomUUID() });
			const other = await fixture({ kind, id: randomUUID() }, f.agentId);
			const producer = new PostgresTaskApiAuditStoreV1({
				databaseUrl: database.databaseUrl,
			});
			const auditIds: string[] = [];
			const requestIds: string[] = [];
			try {
				for (const reason of ["task_accepted", "task_replayed"] as const) {
					const auditId = randomUUID();
					const metadata = request();
					auditIds.push(auditId);
					requestIds.push(metadata.requestId);
					await createTaskApiAuditV1(producer).record({
						schemaVersion: 1,
						auditId,
						operation: "submit",
						phase: "submit.result",
						result: "succeeded",
						reason,
						principal: f.principal,
						target: {
							kind: "execution",
							agentId: f.agentId,
							conversationId: f.conversationId,
							executionId: f.executionId,
						},
						...metadata,
					});
					const attempt = await query.getAudit(
						f.scope,
						auditId,
						detail,
						request(),
					);
					expect(attempt).toMatchObject({
						auditId,
						requestId: metadata.requestId,
						executionId: f.executionId,
						conversationId: f.conversationId,
						originalPrincipal: f.principal,
						result: "succeeded",
						taskApi: { operation: "submit", phase: "submit.result", reason },
						summary: expect.stringContaining(reason),
					});
					await expect(
						query.getAudit(other.scope, auditId, detail, request()),
					).rejects.toMatchObject({ code: "access_denied" });
				}
				const associated = await query.listAudit(
					f.scope,
					{
						...page,
						filters: {
							executionId: f.executionId,
							action: "task.api.submit.result",
							result: "succeeded",
						},
					},
					request(),
				);
				expect(associated.items.map((row) => row.auditId).sort()).toEqual(
					auditIds.sort(),
				);
				expect(new Set(associated.items.map((row) => row.requestId))).toEqual(
					new Set(requestIds),
				);
				expect(new Set(associated.items.map((row) => row.executionId))).toEqual(
					new Set([f.executionId]),
				);
				expect(
					associated.items.every((row) => row.authorizationRecordId !== null),
				).toBe(true);
				await sql`update platform.agent_principal_grants set revoked_at = now() where agent_id = ${f.agentId} and principal_type = ${kind} and principal_id = ${f.principal.id}`;
				if (kind === "user")
					await sql`delete from platform.agent_availability where agent_id = ${f.agentId} and target_type = 'user' and target_id = ${f.principal.id}`;
				await expect(
					query.getAudit(f.scope, auditIds[0] as string, detail, request()),
				).rejects.toMatchObject({ code: "access_denied" });
			} finally {
				await producer.close();
			}
		},
	);

	it("keeps actual admission rejections distinguishable and unbound in its own scope", async () => {
		const f = await fixture({ kind: "application", id: randomUUID() });
		const other = await fixture(
			{ kind: "application", id: randomUUID() },
			f.agentId,
		);
		const producer = new PostgresTaskApiAuditStoreV1({
			databaseUrl: database.databaseUrl,
		});
		const auditIds: string[] = [];
		try {
			for (const reason of [
				"idempotency_conflict",
				"capacity_full",
				"agent_unavailable",
				"conversation_unavailable",
				"model_unavailable",
			] as const) {
				const auditId = randomUUID();
				auditIds.push(auditId);
				await createTaskApiAuditV1(producer).record({
					schemaVersion: 1,
					auditId,
					operation: "submit",
					phase: "submit.result",
					result: "rejected",
					reason,
					principal: f.principal,
					target: { kind: "agent", agentId: f.agentId },
					...request(),
				});
				const attempt = await query.getAudit(
					f.scope,
					auditId,
					detail,
					request(),
				);
				expect(attempt).toMatchObject({
					executionId: null,
					conversationId: null,
					originalPrincipal: null,
					authorizationRecordId: null,
					result: "rejected",
					taskApi: { operation: "submit", phase: "submit.result", reason },
					summary: expect.stringContaining(reason),
				});
				await expect(
					query.getAudit(other.scope, auditId, detail, request()),
				).rejects.toMatchObject({ code: "access_denied" });
			}
			const associated = await query.listAudit(
				f.scope,
				{ ...page, filters: { executionId: f.executionId } },
				request(),
			);
			expect(
				associated.items.some((row) => auditIds.includes(row.auditId)),
			).toBe(false);
			await sql`update platform.agent_principal_grants set revoked_at = now() where agent_id = ${f.agentId} and principal_type = 'application' and principal_id = ${f.principal.id}`;
			await expect(
				query.getAudit(f.scope, auditIds[0] as string, detail, request()),
			).rejects.toMatchObject({ code: "access_denied" });
		} finally {
			await producer.close();
		}
	});

	it("does not bind an accepted attempt with a different Conversation or missing authorization provenance", async () => {
		const producer = new PostgresTaskApiAuditStoreV1({
			databaseUrl: database.databaseUrl,
		});
		try {
			const f = await fixture();
			const auditId = randomUUID();
			await createTaskApiAuditV1(producer).record({
				schemaVersion: 1,
				auditId,
				operation: "submit",
				phase: "submit.result",
				result: "succeeded",
				reason: "task_replayed",
				principal: f.principal,
				target: {
					kind: "execution",
					agentId: f.agentId,
					conversationId: randomUUID(),
					executionId: f.executionId,
				},
				...request(),
			});
			for (const scope of [admin, f.scope])
				await expect(
					query.getAudit(scope, auditId, detail, request()),
				).rejects.toMatchObject({ code: "unavailable" });
			const missing = await fixture(f.principal, f.agentId, false);
			const missingId = randomUUID();
			await createTaskApiAuditV1(producer).record({
				schemaVersion: 1,
				auditId: missingId,
				operation: "submit",
				phase: "submit.result",
				result: "succeeded",
				reason: "task_accepted",
				principal: missing.principal,
				target: {
					kind: "execution",
					agentId: missing.agentId,
					conversationId: missing.conversationId,
					executionId: missing.executionId,
				},
				...request(),
			});
			await expect(
				query.getAudit(missing.scope, missingId, detail, request()),
			).rejects.toMatchObject({ code: "access_denied" });
			expect(
				await query.getAudit(admin, missingId, detail, request()),
			).toMatchObject({ originalPrincipal: null, authorizationRecordId: null });
		} finally {
			await producer.close();
		}
	});

	it("strictly validates admission metadata before the own Agent exception can expose it", async () => {
		const f = await fixture();
		for (const malformed of [
			{ reason: "SENSITIVE_SENTINEL" },
			{ operation: "read" },
			{ reason: "task_accepted" },
			{ subscriptionId: "caller-subscription" },
			{ body: "SENSITIVE_SENTINEL" },
		]) {
			const auditId = randomUUID();
			const details = {
				schemaVersion: 1,
				operation: "submit",
				phase: "submit.result",
				reason: "capacity_full",
				target: { kind: "agent", agentId: f.agentId },
				...malformed,
			};
			await sql`insert into platform.audit_events (id, trace_id, request_id, actor_type, actor_id, action, target_type, target_id, outcome, agent_id, details)
				values (${auditId}, 'attempt-trace', 'attempt-request', ${f.principal.kind}, ${f.principal.id}, 'task.api.submit.result', 'agent', ${f.agentId}, 'rejected', ${f.agentId}, ${sql.json(details)})`;
			await expect(
				query.getAudit(f.scope, auditId, detail, request()),
			).rejects.toMatchObject({
				code: malformed.operation ? "access_denied" : "unavailable",
			});
			await sql`delete from platform.audit_events where id = ${auditId}`;
		}
	});

	it("retains the actual durable control reference and truthful status timeout reason in detail", async () => {
		const f = await fixture();
		const authority = new PostgresTaskAuthorizationStoreV1({
			databaseUrl: database.databaseUrl,
		});
		try {
			const [binding] =
				await sql`select id from platform.task_authorization_records where execution_id = ${f.executionId}`;
			if (!binding) throw new Error("Fixture authorization record is missing");
			const control = await authority.recordControl({
				executionId: f.executionId,
				authorizationRecordId: binding.id,
				reason: "recovery",
				workerId: "controlled-worker",
				...request(),
			});
			const [row] =
				await sql`select id from platform.audit_events where action = 'task.control.created' and target_id = ${f.executionId}`;
			if (!row) throw new Error("Control producer audit is missing");
			const detailRecord = await query.getAudit(
				f.scope,
				row.id,
				detail,
				request(),
			);
			expect(detailRecord.summary).toContain("reason=recovery");
			expect(detailRecord.summary).toContain(
				`controlRecordId=${control.controlRecordId}`,
			);
			const statusId = randomUUID();
			await sql`insert into platform.audit_events (id, trace_id, request_id, actor_type, actor_id, action, target_type, target_id, outcome, agent_id, details)
				values (${statusId}, 'status-trace', 'status-request', 'system', 'controlled-worker', 'task.status.changed', 'execution', ${f.executionId}, 'succeeded', ${f.agentId}, ${sql.json({ status: "unknown", eventId: randomUUID(), originalPrincipal: f.principal, reason: "STOP_CONFIRMATION_TIMEOUT" })})`;
			const status = await query.getAudit(f.scope, statusId, detail, request());
			expect(status.result).toBe("unknown");
			expect(status.summary).toContain("reason=STOP_CONFIRMATION_TIMEOUT");
		} finally {
			await authority.close();
		}
	});

	it("reads its own trusted submission attempt without inventing an Execution and rechecks current grants", async () => {
		const f = await fixture({ kind: "application", id: randomUUID() });
		const other = await fixture(
			{ kind: "application", id: randomUUID() },
			f.agentId,
		);
		const producer = new PostgresTaskApiAuditStoreV1({
			databaseUrl: database.databaseUrl,
		});
		const auditId = randomUUID();
		try {
			await createTaskApiAuditV1(producer).record({
				schemaVersion: 1,
				auditId,
				operation: "submit",
				phase: "access",
				result: "rejected",
				reason: "capacity_full",
				principal: f.principal,
				target: { kind: "agent", agentId: f.agentId },
				...request(),
			});
			const attempt = await query.getAudit(f.scope, auditId, detail, request());
			expect(attempt).toMatchObject({
				auditId,
				executionId: null,
				authorizationRecordId: null,
				originalPrincipal: null,
				summary: expect.stringContaining("task.api.access"),
				result: "rejected",
				taskApi: {
					operation: "submit",
					phase: "access",
					reason: "capacity_full",
				},
			});
			await expect(
				query.getAudit(other.scope, auditId, detail, request()),
			).rejects.toMatchObject({ code: "access_denied" });
			const associated = await query.listAudit(
				f.scope,
				{ ...page, filters: { executionId: f.executionId } },
				request(),
			);
			expect(associated.items.some((item) => item.auditId === auditId)).toBe(
				false,
			);
			await sql`update platform.agent_principal_grants set revoked_at = now() where agent_id = ${f.agentId} and principal_type = 'application' and principal_id = ${f.principal.id}`;
			await expect(
				query.getAudit(f.scope, auditId, detail, request()),
			).rejects.toMatchObject({ code: "access_denied" });
		} finally {
			await producer.close();
		}
	});

	it("persists a bounded early query denial with an unknown or trusted actor", async () => {
		for (const principal of [
			null,
			{ kind: "user" as const, id: "denied-user" },
		]) {
			const metadata = request();
			await query.recordDeniedQuery(
				{
					principal,
					requestedScope: "administrator",
					operation: "detail",
					result: "rejected",
					reason: "RESOURCE_UNAVAILABLE",
				},
				metadata,
			);
			const rows =
				await sql`select actor_type, actor_id, action, outcome, details from platform.audit_events where request_id = ${metadata.requestId}`;
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				actor_type: principal?.kind ?? "unknown",
				actor_id: principal?.id ?? "unknown",
				action: "audit.query.failed",
				outcome: "rejected",
				details: {
					schemaVersion: 1,
					scope: { kind: "denied", requestedScope: "administrator" },
					operation: "detail",
					result: "rejected",
					reason: "RESOURCE_UNAVAILABLE",
					count: 0,
				},
			});
		}
	});

	it("persists distinct early denial reasons and reads them through safe administrator detail", async () => {
		for (const reason of [
			"AUTHENTICATION_REQUIRED",
			"AUTHORIZATION_REVOKED",
		] as const) {
			const metadata = request();
			await query.recordDeniedQuery(
				{
					principal: null,
					requestedScope: "execution",
					operation: "list",
					result: "rejected",
					reason,
				},
				metadata,
			);
			const [row] =
				await sql`select id, details from platform.audit_events where request_id = ${metadata.requestId}`;
			if (!row) throw new Error("Denial audit is missing");
			expect(row.details.reason).toBe(reason);
			const record = await query.getAudit(admin, row.id, detail, request());
			expect(record.summary).toBe(`audit.query.failed: reason=${reason}`);
			expect(record.actor).toEqual({ kind: "unknown", actorId: "unknown" });
			expect(JSON.stringify(record)).not.toContain("details");
		}
	});

	it("retains Store invalid-request and access-denied codes in administrator detail", async () => {
		const f = await fixture();
		for (const [input, reason] of [
			[
				{ limit: 0, filters: { agentId: "PRIVATE_FILTER_SENTINEL" } },
				"invalid_request",
			],
			[
				{ limit: 1, filters: { executionId: "PRIVATE_EXECUTION_SENTINEL" } },
				"access_denied",
			],
		] as const) {
			const metadata = request();
			await expect(
				query.listAudit(f.scope, input, metadata),
			).rejects.toMatchObject({ code: reason });
			const [row] =
				await sql`select id, details from platform.audit_events where request_id = ${metadata.requestId}`;
			if (!row) throw new Error("Query rejection audit is missing");
			expect(row.details.reason).toBe(reason);
			const record = await query.getAudit(admin, row.id, detail, request());
			expect(record.summary).toBe(`audit.query.failed: reason=${reason}`);
			expect(JSON.stringify(row.details)).not.toContain("PRIVATE");
			expect(JSON.stringify(record)).not.toContain("PRIVATE");
		}
	});

	it.each([
		{ action: "audit.query.failed", outcome: "succeeded", result: "rejected" },
		{ action: "audit.query.failed", outcome: "failed", result: "rejected" },
		{ action: "audit.query.completed", outcome: "failed", result: "succeeded" },
	])(
		"rejects a persisted query outcome that contradicts its validated metadata: %j",
		async ({ action, outcome, result }) => {
			const auditId = randomUUID();
			const metadata = {
				schemaVersion: 1,
				scope: { kind: "administrator" },
				operation: "detail",
				result,
				count: 0,
				filters: {},
				limit: 1,
				hasCursor: false,
				...(action === "audit.query.failed"
					? { reason: "AUTHENTICATION_REQUIRED" }
					: {}),
			};
			await sql`insert into platform.audit_events (id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, details)
			values (${auditId}, 'contradictory-query-fixture', 'user', ${admin.administratorId}, ${action}, 'unknown', 'audit-query', ${outcome}, ${sql.json(metadata)})`;
			try {
				await expect(
					query.getAudit(admin, auditId, detail, request()),
				).rejects.toMatchObject({
					code: "unavailable",
					message: "Platform audit query is unavailable",
				});
			} finally {
				await sql`delete from platform.audit_events where id = ${auditId}`;
			}
		},
	);

	it("fails closed on arbitrary stored query reasons and fields without returning their contents", async () => {
		for (const change of [
			{ reason: "PRIVATE_ERROR_SENTINEL" },
			{ message: "PRIVATE_ERROR_SENTINEL" },
		]) {
			const auditId = randomUUID();
			const metadata = {
				schemaVersion: 1,
				scope: { kind: "denied", requestedScope: "execution" },
				operation: "list",
				result: "rejected",
				count: 0,
				reason: "AUTHENTICATION_REQUIRED",
				...change,
			};
			await sql`insert into platform.audit_events (id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, details)
				values (${auditId}, 'unsafe-query-fixture', 'unknown', 'unknown', 'audit.query.failed', 'unknown', 'audit-query', 'rejected', ${sql.json(metadata)})`;
			try {
				await expect(
					query.getAudit(admin, auditId, detail, request()),
				).rejects.toMatchObject({
					code: "unavailable",
					message: "Platform audit query is unavailable",
				});
			} finally {
				await sql`delete from platform.audit_events where id = ${auditId}`;
			}
		}
	});

	it("reads producer acceptance and conversation facts without returning private details, and writes one bounded request-correlated audit", async () => {
		const f = await fixture();
		const context = request();
		const result = await query.listAudit(
			f.scope,
			{ ...page, filters: { executionId: f.executionId } },
			context,
		);
		expect(result.items).toHaveLength(2);
		expect(
			result.items.every(
				(row) =>
					row.originalPrincipal?.id === f.principal.id &&
					row.result === "accepted",
			),
		).toBe(true);
		expect(result.items.find((row) => row.auditId === f.auditId)).toMatchObject(
			{
				conversationId: f.conversationId,
				authorizationRecordId: expect.any(String),
				operation: null,
			},
		);
		expect(JSON.stringify(result)).not.toContain("details");
		const audits =
			await sql`select action, request_id, trace_id, details from platform.audit_events where request_id = ${context.requestId}`;
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({
			action: "audit.query.completed",
			request_id: context.requestId,
			trace_id: context.traceId,
			details: { count: 2, filters: { hasExecutionId: true } },
		});
		expect(JSON.stringify(audits[0]?.details)).not.toContain(f.executionId);
	});

	it("separates equal user and application IDs and denies foreign Agent, execution and detail", async () => {
		const id = randomUUID();
		const user = await fixture({ kind: "user", id });
		const app = await fixture({ kind: "application", id }, user.agentId);
		const result = await query.listAudit(user.scope, page, request());
		expect(result.items.map((row) => row.executionId)).toEqual(
			expect.arrayContaining([user.executionId]),
		);
		expect(
			result.items.some((row) => row.executionId === app.executionId),
		).toBe(false);
		for (const input of [
			{ ...page, filters: { executionId: app.executionId } },
			{ ...page, filters: { principal: app.principal } },
			{ ...page, filters: { agentId: randomUUID() } },
		])
			await expect(
				query.listAudit(user.scope, input, request()),
			).rejects.toMatchObject({ code: "access_denied" });
		await expect(
			query.getAudit(user.scope, app.auditId, detail, request()),
		).rejects.toMatchObject({ code: "access_denied" });
		await expect(
			query.getAudit(user.scope, randomUUID(), detail, request()),
		).rejects.toMatchObject({ code: "access_denied" });
	});

	it("requires the matching original accepted audit, including principal kind, and retains historical ownership after original authorization revocation", async () => {
		const f = await fixture();
		await sql`update platform.task_authorization_records set revoked_at = now() where execution_id = ${f.executionId}`;
		await expect(
			query.getAudit(f.scope, f.auditId, detail, request()),
		).resolves.toMatchObject({ auditId: f.auditId });
		await sql`update platform.audit_events set actor_type = 'application' where action = 'task.authorization.accepted' and target_id = ${f.executionId}`;
		await expect(
			query.getAudit(f.scope, f.auditId, detail, request()),
		).rejects.toMatchObject({ code: "access_denied" });
		const old = await fixture(undefined, undefined, false);
		await expect(
			query.getAudit(old.scope, old.auditId, detail, request()),
		).rejects.toMatchObject({ code: "access_denied" });
		await expect(
			query.getAudit(admin, old.auditId, detail, request()),
		).resolves.toMatchObject({
			originalPrincipal: null,
			authorizationRecordId: null,
			actor: { kind: "unknown", actorId: "unknown" },
		});
	});

	it("applies current Web use rights before pagination, preserving authorized later rows", async () => {
		const principal = { kind: "user" as const, id: randomUUID() };
		const visible = await fixture(principal);
		const revoked = await fixture(principal);
		await sql`delete from platform.agent_availability where agent_id = ${revoked.agentId}`;
		const result = await query.listAudit(
			visible.scope,
			{ limit: 1, filters: { action: "conversation.task.accepted" } },
			request(),
		);
		expect(result.items.map((row) => row.auditId)).toEqual([visible.auditId]);
		await expect(
			query.getAudit(visible.scope, revoked.auditId, detail, request()),
		).rejects.toMatchObject({ code: "access_denied" });
		if (visible.scope.kind !== "execution" || !visible.scope.user)
			throw new Error("Expected user scope");
		await expect(
			query.listAudit(
				{
					...visible.scope,
					user: { ...visible.scope.user, accountStatus: "disabled" },
				},
				page,
				request(),
			),
		).rejects.toMatchObject({ code: "access_denied" });
	});

	it.each([
		"credential_revoked",
		"credential_expired",
		"application_disabled",
		"grant_revoked",
		"grant_revision_changed",
	])("rechecks current application authority: %s", async (change) => {
		const f = await fixture({ kind: "application", id: randomUUID() });
		if (f.scope.kind !== "execution" || !f.scope.credential)
			throw new Error("Expected application scope");
		await expect(
			query.getAudit(f.scope, f.auditId, detail, request()),
		).resolves.toMatchObject({ auditId: f.auditId });
		if (change === "credential_revoked")
			await sql`update platform.platform_api_credentials set revoked_at = now() where id = ${f.scope.credential.credentialId}`;
		if (change === "credential_expired")
			await sql`update platform.platform_api_credentials set expires_at = now() - interval '1 second' where id = ${f.scope.credential.credentialId}`;
		if (change === "application_disabled")
			await sql`update platform.platform_applications set status = 'disabled' where id = ${f.principal.id}`;
		if (change === "grant_revoked")
			await sql`update platform.agent_principal_grants set revoked_at = now() where agent_id = ${f.agentId}`;
		if (change === "grant_revision_changed")
			await sql`update platform.agents set authorization_revision = 'new-revision' where id = ${f.agentId}`;
		await expect(
			query.getAudit(f.scope, f.auditId, detail, request()),
		).rejects.toMatchObject({ code: "access_denied" });
		await expect(
			query.listAudit(
				f.scope,
				{ ...page, filters: { executionId: f.executionId } },
				request(),
			),
		).rejects.toMatchObject({ code: "access_denied" });
	});

	it("binds cursors to the complete scope and six filters, and preserves PostgreSQL timestamp precision across concurrent inserts", async () => {
		const principal = { kind: "user" as const, id: randomUUID() };
		const first = await fixture(principal);
		const second = await fixture(principal, first.agentId);
		await sql`update platform.conversation_audit_events set occurred_at = '2026-09-25T01:00:00.000002Z' where id = ${first.auditId}`;
		await sql`update platform.conversation_audit_events set occurred_at = '2026-09-25T01:00:00.000001Z' where id = ${second.auditId}`;
		const input = {
			limit: 1,
			filters: {
				action: "conversation.task.accepted" as const,
				from: "2026-09-25T00:00:00Z",
				until: "2026-09-26T00:00:00Z",
				agentId: first.agentId,
				principal,
				result: "accepted" as const,
			},
		};
		const a = await query.listAudit(first.scope, input, request());
		expect(a.items[0]?.auditId).toBe(first.auditId);
		expect(a.nextCursor).toEqual(expect.any(String));
		const fresh = await fixture(principal, first.agentId);
		const b = await query.listAudit(
			first.scope,
			{ ...input, cursor: a.nextCursor },
			request(),
		);
		expect(b.items.map((row) => row.auditId)).toEqual([second.auditId]);
		expect(b.items.some((row) => row.auditId === fresh.auditId)).toBe(false);
		const changed = [
			{ ...input, limit: 2 },
			{ ...input, filters: { ...input.filters, from: "2026-09-24T00:00:00Z" } },
			{
				...input,
				filters: { ...input.filters, executionId: first.executionId },
			},
			{ ...input, filters: { ...input.filters, result: "unknown" } },
			{
				...input,
				filters: { ...input.filters, action: "task.authorization.accepted" },
			},
		];
		for (const rebound of changed)
			await expect(
				query.listAudit(
					first.scope,
					{ ...rebound, cursor: a.nextCursor },
					request(),
				),
			).rejects.toMatchObject({ code: "access_denied" });
		await expect(
			query.listAudit(admin, { ...input, cursor: a.nextCursor }, request()),
		).rejects.toMatchObject({ code: "access_denied" });
	});

	it("projects actual durable operation phase, Worker provenance and bounded unverified Connection references", async () => {
		const f = await fixture();
		const adapter = new PostgresConversationEventTransactionV1({
			databaseUrl: database.databaseUrl,
		});
		const events = createConversationEventUseCaseV1(
			{ transaction: adapter },
			{ newId: randomUUID },
		);
		const command = (phase: "intent" | "unknown", key: string) => ({
			schemaVersion: 1 as const,
			conversationId: f.conversationId,
			executionId: f.executionId,
			sessionGeneration: 1,
			deliveryFence: 1,
			adapterEventKey: key,
			runtimeCursor: key,
			occurredAt: new Date().toISOString(),
			event: {
				schemaVersion: 2 as const,
				type: "execution.operation" as const,
				fact: {
					kind: "tool" as const,
					toolId: "controlled-tool",
					operationRef: "operation-1",
					attemptRef: "attempt-1",
					phase,
					connection: {
						serviceRef: "connection-service",
						callRef: "bounded-call",
						verification: "unverified" as const,
						reason: "record_unavailable" as const,
					},
				},
			},
		});
		try {
			await events.persist(command("intent", "intent"));
			await events.persist(command("unknown", "unknown"));
			const result = await query.listAudit(
				f.scope,
				{
					...page,
					filters: {
						executionId: f.executionId,
						action: "execution.operation.observed",
						result: "unknown",
					},
				},
				request(),
			);
			expect(result.items).toHaveLength(1);
			expect(result.items[0]).toMatchObject({
				result: "unknown",
				executor: "platform_worker",
				originalPrincipal: f.principal,
				operation: {
					fact: {
						phase: "unknown",
						connection: {
							verification: "unverified",
							reason: "authorization_unavailable",
						},
					},
				},
			});
			expect(result.items[0]?.operation?.fact).not.toHaveProperty("finishedAt");
			const [stored] =
				await sql`select outcome, details from platform.audit_events where id = ${result.items[0]?.auditId ?? "missing"}`;
			expect(stored?.outcome).toBe("succeeded");
			expect(stored?.details.fact.connection.reason).toBe("record_unavailable");
		} finally {
			await adapter.close();
		}
	});

	it("retains old administrator governance decoding and rejects corrupt results instead of fabricating success", async () => {
		const id = randomUUID();
		await sql`insert into platform.audit_events (id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome)
			values (${id}, 'governance-trace', 'user', 'governance-user', 'agent.application.rejected', 'agent_application', 'application-ref', 'rejected')`;
		await expect(
			query.getAudit(admin, id, detail, request()),
		).resolves.toMatchObject({
			result: "rejected",
			subject: { kind: "agent_application", subjectId: "application-ref" },
		});
		const f = await fixture();
		const corrupt = randomUUID();
		await sql`insert into platform.audit_events (id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, agent_id, details)
			values (${corrupt}, 'corrupt-trace', 'system', 'worker-real-id', 'task.status.changed', 'execution', ${f.executionId}, 'succeeded', ${f.agentId}, '{"status":"untrusted-status","body":"private-sentinel"}')`;
		await expect(
			query.getAudit(admin, corrupt, detail, request()),
		).rejects.toMatchObject({ code: "unavailable" });
	});

	it("durably records malformed/rebound requests without persisting caller filters, cursors, IDs or secret sentinels", async () => {
		const context = request();
		await expect(
			query.listAudit(
				admin,
				{
					limit: 1,
					filters: {
						principal: { kind: "user", id: "private-filter-sentinel" },
					},
					unknownField: "private-body-sentinel",
				},
				context,
			),
		).rejects.toMatchObject({ code: "invalid_request" });
		const rows =
			await sql`select details, outcome from platform.audit_events where request_id = ${context.requestId}`;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			outcome: "rejected",
			details: { count: 0, result: "rejected", filters: {} },
		});
		expect(JSON.stringify(rows)).not.toContain("private-");
	});

	it("reports query and required audit persistence failures explicitly and does not recurse", async () => {
		const f = await fixture();
		await sql.unsafe(
			"create function platform.scoped_audit_fail() returns trigger language plpgsql as $$ begin if NEW.action like 'audit.query.%' then raise exception 'private-db-sentinel'; end if; return NEW; end $$",
		);
		await sql.unsafe(
			"create trigger scoped_audit_fail before insert on platform.audit_events for each row execute function platform.scoped_audit_fail()",
		);
		const context = request();
		try {
			await expect(
				query.getAudit(f.scope, f.auditId, detail, context),
			).rejects.toMatchObject({
				code: "unavailable",
				message: "Platform audit query is unavailable",
			});
			expect(
				await sql`select id from platform.audit_events where request_id = ${context.requestId}`,
			).toHaveLength(0);
		} finally {
			await sql.unsafe(
				"drop trigger scoped_audit_fail on platform.audit_events",
			);
			await sql.unsafe("drop function platform.scoped_audit_fail()");
		}
		const broken = new PostgresScopedPlatformAuditQueryV1({
			databaseUrl: "postgres://invalid:invalid@127.0.0.1:1/unavailable",
		});
		try {
			await expect(
				broken.listAudit(admin, page, request()),
			).rejects.toMatchObject({ code: "unavailable" });
		} finally {
			await broken.close();
		}
	});

	it("denies an Agent Owner another principal's records and denies a formerly valid cursor after current use revocation", async () => {
		const f = await fixture();
		const ownerScope: PlatformAuditQueryScopeV1 = {
			kind: "execution",
			principal: { kind: "user", id: "different-owner" },
			user: {
				schemaVersion: 1,
				userId: "different-owner",
				accountStatus: "active",
				organizationIds: [],
				authorizationRevision: "owner-directory",
			},
		};
		expect(
			(
				await query.listAudit(
					ownerScope,
					{ ...page, filters: { agentId: f.agentId } },
					request(),
				)
			).items,
		).toHaveLength(0);
		await expect(
			query.getAudit(ownerScope, f.auditId, detail, request()),
		).rejects.toMatchObject({ code: "access_denied" });
		const input = { limit: 1, filters: { executionId: f.executionId } };
		const first = await query.listAudit(f.scope, input, request());
		expect(first.nextCursor).toEqual(expect.any(String));
		await sql`delete from platform.agent_availability where agent_id = ${f.agentId}`;
		await expect(
			query.listAudit(
				f.scope,
				{ ...input, cursor: first.nextCursor },
				request(),
			),
		).rejects.toMatchObject({ code: "access_denied" });
	});

	it("keeps mixed-table equal-time page anchors stable and applies detail filters", async () => {
		const f = await fixture();
		await sql`update platform.audit_events set occurred_at = '2026-09-25T02:00:00.123456Z' where target_id = ${f.executionId}`;
		await sql`update platform.conversation_audit_events set occurred_at = '2026-09-25T02:00:00.123456Z' where id = ${f.auditId}`;
		const input = { limit: 1, filters: { executionId: f.executionId } };
		const first = await query.listAudit(admin, input, request());
		expect(first.items[0]?.action).toBe("task.authorization.accepted");
		const second = await query.listAudit(
			admin,
			{ ...input, cursor: first.nextCursor },
			request(),
		);
		expect(second.items.map((row) => row.auditId)).toEqual([f.auditId]);
		expect(second.nextCursor).toBeNull();
		await expect(
			query.getAudit(
				f.scope,
				f.auditId,
				{ ...detail, filters: { action: "execution.operation.observed" } },
				request(),
			),
		).rejects.toMatchObject({ code: "access_denied" });
	});

	it("records a readable query failure once when audit insertion still works", async () => {
		const context = request();
		await sql.unsafe(
			"alter table platform.conversation_audit_events rename to scoped_audit_query_failure_fixture",
		);
		try {
			await expect(query.listAudit(admin, page, context)).rejects.toMatchObject(
				{ code: "unavailable" },
			);
			const records =
				await sql`select action, outcome, details from platform.audit_events where request_id = ${context.requestId}`;
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({
				action: "audit.query.failed",
				outcome: "failed",
				details: { result: "failed", count: 0, reason: "unavailable" },
			});
		} finally {
			await sql.unsafe(
				"alter table platform.scoped_audit_query_failure_fixture rename to conversation_audit_events",
			);
		}
	});

	it("does not infer original ownership from a boundary whose accepted audit is missing or ambiguous", async () => {
		const f = await fixture();
		await sql`insert into platform.audit_events (id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, details)
			select ${randomUUID()}, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, details
			from platform.audit_events where action = 'task.authorization.accepted' and target_id = ${f.executionId}`;
		await expect(
			query.getAudit(f.scope, f.auditId, detail, request()),
		).rejects.toMatchObject({ code: "access_denied" });
		await sql`delete from platform.audit_events where action = 'task.authorization.accepted' and target_id = ${f.executionId}`;
		await expect(
			query.getAudit(f.scope, f.auditId, detail, request()),
		).rejects.toMatchObject({ code: "access_denied" });
		await expect(
			query.getAudit(admin, f.auditId, detail, request()),
		).resolves.toMatchObject({ originalPrincipal: null });
	});
});
