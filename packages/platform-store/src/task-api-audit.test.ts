import {
	createTaskApiAuditV1,
	type TaskApiAuditInputV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresPlatformAuditQueryV1 } from "./audit.js";
import { PostgresConversationDispatchStoreV1 } from "./conversation-dispatch.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";
import { PostgresTaskApiAuditStoreV1 } from "./task-api-audit.js";

const input: TaskApiAuditInputV1 = {
	schemaVersion: 1,
	auditId: "audit_server",
	operation: "read",
	phase: "access",
	result: "succeeded",
	reason: "request_accepted",
	principal: { kind: "application", id: "application_trusted" },
	target: {
		kind: "execution",
		agentId: "agent_trusted",
		conversationId: "conversation_trusted",
		executionId: "execution_trusted",
	},
	requestId: "request_shared",
	traceId: "trace_shared",
	occurredAt: new Date("2026-09-26T00:00:00Z"),
};
const scope = {
	schemaVersion: 1,
	kind: "administrator",
	administratorId: "admin",
} as const;
const started: TaskApiAuditInputV1 = {
	...input,
	auditId: "audit_started",
	operation: "subscribe",
	phase: "subscription.started",
	subscriptionId: "subscription_recovery",
};
const ended: TaskApiAuditInputV1 = {
	...started,
	auditId: "ignored_random_end_id",
	phase: "subscription.ended",
	reason: "client_disconnected",
};

describe("Task API audit PostgreSQL persistence", () => {
	let database: PostgresTestDatabase;
	let sql: ReturnType<typeof postgres>;
	let writer: PostgresTaskApiAuditStoreV1;
	let reader: PostgresPlatformAuditQueryV1;
	beforeAll(async () => {
		database = await startPostgresTestDatabase("task-api-audit");
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		sql = postgres(database.databaseUrl, { max: 1 });
		writer = new PostgresTaskApiAuditStoreV1({
			databaseUrl: database.databaseUrl,
		});
		reader = new PostgresPlatformAuditQueryV1({
			databaseUrl: database.databaseUrl,
		});
	}, 120_000);
	beforeEach(async () => {
		await sql`truncate platform.audit_events, platform.outbox_items`;
	});
	it.each(["outbox_items", "audit_events"] as const)(
		"rolls back subscription start when %s persistence fails",
		async (table) => {
			await sql.unsafe(
				`create function platform.fail_subscription_start() returns trigger language plpgsql as $$ begin raise exception 'private start failure'; end $$`,
			);
			await sql.unsafe(
				`create trigger fail_subscription_start before insert on platform.${table} for each row execute function platform.fail_subscription_start()`,
			);
			try {
				await expect(
					createTaskApiAuditV1(writer).record(started),
				).rejects.toMatchObject({ code: "unavailable" });
				expect(await sql`select id from platform.audit_events`).toHaveLength(0);
				expect(await sql`select id from platform.outbox_items`).toHaveLength(0);
			} finally {
				await sql.unsafe(
					`drop trigger fail_subscription_start on platform.${table}`,
				);
				await sql`drop function platform.fail_subscription_start()`;
			}
		},
	);
	it("keeps a live subscription leased and refuses another instance's renewal or end", async () => {
		const first = createTaskApiAuditV1(writer);
		const otherStore = new PostgresTaskApiAuditStoreV1({
			databaseUrl: database.databaseUrl,
		});
		const other = createTaskApiAuditV1(otherStore);
		const dispatch = new PostgresConversationDispatchStoreV1({
			databaseUrl: database.databaseUrl,
		});
		try {
			await first.record(started);
			await first.record({ ...started, occurredAt: new Date() });
			const [intent] = await sql`select * from platform.outbox_items`;
			expect(intent).toMatchObject({
				scope_type: "task_api_subscription",
				operation: "task.api.subscription.end",
				status: "processing",
				delivery_fence: "1",
			});
			expect(JSON.stringify(intent?.payload)).not.toContain("occurredAt");
			expect(await other.recoverSubscriptions()).toBe(0);
			await expect(
				other.renewSubscription(started.subscriptionId as string),
			).rejects.toMatchObject({ code: "unavailable" });
			await expect(other.record(ended)).rejects.toMatchObject({
				code: "unavailable",
			});
			await first.renewSubscription(started.subscriptionId as string);
			expect(await dispatch.findDispatchable({ limit: 10 })).toEqual([]);
			await first.record(ended);
			await first.record({
				...ended,
				auditId: "another_random_end_id",
				occurredAt: new Date(),
			});
			expect(await other.recoverSubscriptions()).toBe(0);
			await expect(
				first.record({ ...ended, reason: "stream_ended" }),
			).rejects.toMatchObject({ code: "unavailable" });
			expect(await sql`select id from platform.audit_events`).toHaveLength(2);
		} finally {
			await dispatch.close();
			await otherStore.close();
		}
	});
	it("persists one failed end at recovery observation time and rejects the expired original instance", async () => {
		const first = createTaskApiAuditV1(writer);
		const otherStore = new PostgresTaskApiAuditStoreV1({
			databaseUrl: database.databaseUrl,
		});
		const other = createTaskApiAuditV1(otherStore);
		try {
			await first.record(started);
			await sql`update platform.outbox_items set lease_expires_at=clock_timestamp()-interval '1 second'`;
			await expect(
				first.renewSubscription(started.subscriptionId as string),
			).rejects.toMatchObject({ code: "unavailable" });
			await expect(first.record(ended)).rejects.toMatchObject({
				code: "unavailable",
			});
			const [observedBefore] =
				await sql`select clock_timestamp() as observed_at`;
			expect(
				(
					await Promise.all([
						first.recoverSubscriptions(),
						other.recoverSubscriptions(),
					])
				).reduce((sum, count) => sum + count, 0),
			).toBe(1);
			const [end] =
				await sql`select * from platform.audit_events where action='task.api.subscription.ended'`;
			expect(end).toMatchObject({
				outcome: "failed",
				details: {
					reason: "subscription_unconfirmed",
					subscriptionId: started.subscriptionId,
				},
			});
			expect(end?.id).not.toBe(ended.auditId);
			expect(end?.occurred_at.getTime()).toBeGreaterThanOrEqual(
				observedBefore?.observed_at.getTime(),
			);
			const [observedAfter] =
				await sql`select clock_timestamp() as observed_at`;
			expect(end?.occurred_at.getTime()).toBeLessThanOrEqual(
				observedAfter?.observed_at.getTime(),
			);
			const [intent] = await sql`select * from platform.outbox_items`;
			expect(intent).toMatchObject({
				status: "succeeded",
				delivery_fence: "2",
				lease_owner: null,
				lease_expires_at: null,
			});
			expect(intent?.payload.endInput.auditId).toBe(end?.id);
			expect(intent?.payload.startedAuditId).toBe(started.auditId);
			expect(await first.recoverSubscriptions()).toBe(0);
			expect(await other.recoverSubscriptions()).toBe(0);
			await expect(first.record(ended)).rejects.toMatchObject({
				code: "unavailable",
			});
			await expect(
				first.renewSubscription(started.subscriptionId as string),
			).rejects.toMatchObject({ code: "unavailable" });
			expect(
				(await reader.listAudit(scope, { schemaVersion: 1, limit: 10 })).items,
			).toHaveLength(2);
		} finally {
			await otherStore.close();
		}
	});
	it("keeps the durable intent after a failed end and rolls back failed recovery", async () => {
		const audit = createTaskApiAuditV1(writer);
		await audit.record(started);
		await sql`create function platform.fail_subscription_end() returns trigger language plpgsql as $$ begin if NEW.action='task.api.subscription.ended' then raise exception 'private end failure'; end if; return NEW; end $$`;
		await sql`create trigger fail_subscription_end before insert on platform.audit_events for each row execute function platform.fail_subscription_end()`;
		try {
			await expect(audit.record(ended)).rejects.toMatchObject({
				code: "unavailable",
			});
			expect(await sql`select id from platform.audit_events`).toHaveLength(1);
			expect(
				(await sql`select status from platform.outbox_items`)[0]?.status,
			).toBe("processing");
			await sql`update platform.outbox_items set lease_expires_at=clock_timestamp()-interval '1 second'`;
			await expect(audit.recoverSubscriptions()).rejects.toMatchObject({
				code: "unavailable",
			});
			expect(
				(await sql`select delivery_fence from platform.outbox_items`)[0]
					?.delivery_fence,
			).toBe("1");
		} finally {
			await sql`drop trigger fail_subscription_end on platform.audit_events`;
			await sql`drop function platform.fail_subscription_end()`;
		}
		expect(await audit.recoverSubscriptions()).toBe(1);
		expect(await audit.recoverSubscriptions()).toBe(0);
	});
	it("rolls back an end audit if completing the intent fails", async () => {
		const audit = createTaskApiAuditV1(writer);
		await audit.record(started);
		await sql`create function platform.fail_subscription_complete() returns trigger language plpgsql as $$ begin if NEW.status='succeeded' then raise exception 'private complete failure'; end if; return NEW; end $$`;
		await sql`create trigger fail_subscription_complete before update on platform.outbox_items for each row execute function platform.fail_subscription_complete()`;
		try {
			await expect(audit.record(ended)).rejects.toMatchObject({
				code: "unavailable",
			});
			expect(await sql`select id from platform.audit_events`).toHaveLength(1);
			expect(
				(await sql`select status from platform.outbox_items`)[0]?.status,
			).toBe("processing");
		} finally {
			await sql`drop trigger fail_subscription_complete on platform.outbox_items`;
			await sql`drop function platform.fail_subscription_complete()`;
		}
		await audit.record(ended);
		expect(await sql`select id from platform.audit_events`).toHaveLength(2);
	});
	it("rejects private intent fields and replacement start bindings without writing an end", async () => {
		const audit = createTaskApiAuditV1(writer);
		for (const patch of [
			{ body: "private intent body" },
			{ credential: "private intent credential" },
			{ startedAuditId: "forged_start" },
		]) {
			await sql`truncate platform.audit_events,platform.outbox_items`;
			await audit.record(started);
			await sql`update platform.outbox_items set payload=payload || ${sql.json(patch as never)}::jsonb,lease_expires_at=clock_timestamp()-interval '1 second'`;
			await expect(audit.recoverSubscriptions()).rejects.toMatchObject({
				code: "unavailable",
			});
			expect(await sql`select id from platform.audit_events`).toHaveLength(1);
			expect(
				(await sql`select status,delivery_fence from platform.outbox_items`)[0],
			).toMatchObject({ status: "processing", delivery_fence: "1" });
		}
	});
	it("does not recover foreign scopes or operations even if their leases expire", async () => {
		const audit = createTaskApiAuditV1(writer);
		await audit.record(started);
		await sql`update platform.outbox_items set lease_expires_at=clock_timestamp()-interval '1 second',scope_type='conversation'`;
		expect(await audit.recoverSubscriptions()).toBe(0);
		await sql`update platform.outbox_items set scope_type='task_api_subscription',operation='conversation.turn.submit.v1'`;
		expect(await audit.recoverSubscriptions()).toBe(0);
		expect(await sql`select id from platform.audit_events`).toHaveLength(1);
	});
	afterAll(async () => {
		await writer?.close();
		await reader?.close();
		await sql?.end();
		await database?.stop();
	});
	it("persists trusted resources, principal and fixed reason with administrator readback", async () => {
		await createTaskApiAuditV1(writer).record(input);
		const [row] = await sql`select * from platform.audit_events`;
		expect(row).toMatchObject({
			actor_type: "application",
			actor_id: "application_trusted",
			target_type: "execution",
			target_id: "execution_trusted",
			agent_id: "agent_trusted",
			request_id: "request_shared",
			action: "task.api.access",
			details: { operation: "read", reason: "request_accepted" },
		});
		const page = await reader.listAudit(scope, { schemaVersion: 1, limit: 10 });
		expect(page.items[0]).toMatchObject({
			action: "task.api.access",
			actor: { kind: "application", actorId: "application_trusted" },
			subject: { kind: "execution", subjectId: "execution_trusted" },
			summary: "task.api.access: request_accepted",
		});
	});
	it("replays identical stable IDs but fails closed on changed payload and keeps time", async () => {
		const audit = createTaskApiAuditV1(writer);
		await audit.record(input);
		await audit.record({
			...input,
			occurredAt: new Date("2026-09-26T01:00:00Z"),
		});
		await expect(
			audit.record({
				...input,
				reason: "resource_unavailable",
				result: "rejected",
			}),
		).rejects.toMatchObject({ code: "unavailable" });
		const rows = await sql`select occurred_at from platform.audit_events`;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.occurred_at).toEqual(input.occurredAt);
	});
	it("does not deduplicate separate accesses from reused request metadata", async () => {
		const audit = createTaskApiAuditV1(writer);
		await audit.record(input);
		await audit.record({ ...input, auditId: "audit_server_next" });
		expect(await sql`select id from platform.audit_events`).toHaveLength(2);
	});
	it("stores unknown identities and resources only as fixed placeholders", async () => {
		await createTaskApiAuditV1(writer).record({
			...input,
			principal: { kind: "unknown" },
			target: { kind: "unknown" },
			reason: "authentication_required",
			result: "rejected",
		});
		const [row] = await sql`select * from platform.audit_events`;
		expect(row).toMatchObject({
			actor_type: "unknown",
			actor_id: "unknown",
			target_type: "unknown",
			target_id: "unknown",
			agent_id: null,
			details: { target: { kind: "unknown" } },
		});
		expect(
			(await reader.listAudit(scope, { schemaVersion: 1, limit: 10 })).items[0]
				?.actor.kind,
		).toBe("unknown");
	});
	it("records subscription start and end using the same trusted context", async () => {
		const audit = createTaskApiAuditV1(writer);
		for (const phase of ["subscription.started", "subscription.ended"] as const)
			await audit.record({
				...input,
				auditId: phase,
				operation: "subscribe",
				phase,
				subscriptionId: "subscription_server",
				reason:
					phase === "subscription.started"
						? "request_accepted"
						: "client_disconnected",
			});
		const rows =
			await sql`select request_id, trace_id, details from platform.audit_events`;
		expect(
			rows.map((row) => [
				row.request_id,
				row.trace_id,
				row.details.subscriptionId,
			]),
		).toEqual([
			["request_shared", "trace_shared", "subscription_server"],
			["request_shared", "trace_shared", "subscription_server"],
		]);
		const first = await reader.listAudit(scope, { schemaVersion: 1, limit: 1 });
		expect(first.nextCursor).not.toBeNull();
		const second = await reader.listAudit(scope, {
			schemaVersion: 1,
			limit: 1,
			cursor: first.nextCursor as string,
		});
		expect(second.items).toHaveLength(1);
		expect(second.items[0]?.auditId).not.toBe(first.items[0]?.auditId);
	});
	it("rejects private, forged and malformed persisted task metadata on readback", async () => {
		for (const patch of [
			{ body: "private task content" },
			{ credential: "private credential" },
			{ reason: "private task content" },
			{ phase: "subscription.ended" },
			{
				target: {
					kind: "execution",
					agentId: "forged",
					conversationId: "conversation_trusted",
					executionId: "execution_trusted",
				},
			},
		]) {
			await sql`truncate platform.audit_events`;
			await createTaskApiAuditV1(writer).record(input);
			await sql`update platform.audit_events set details = details || ${sql.json(patch)}::jsonb`;
			await expect(
				reader.listAudit(scope, { schemaVersion: 1, limit: 10 }),
			).rejects.toMatchObject({ code: "unavailable" });
		}
	});
	it("pages management records before filtering task audits and rejects task cursor anchors", async () => {
		const audit = createTaskApiAuditV1(writer);
		for (let index = 0; index < 3; index++) {
			await audit.record({
				...input,
				auditId: `audit_task_${index}`,
				occurredAt: new Date("2026-09-26T02:00:00Z"),
				principal: { kind: "unknown" },
				target: { kind: "unknown" },
				result: "rejected",
				reason: "authentication_required",
			});
		}
		for (const [offset, phase] of (
			["subscription.started", "subscription.ended"] as const
		).entries()) {
			await audit.record({
				...input,
				auditId: `audit_task_${3 + offset}`,
				occurredAt: new Date("2026-09-26T02:00:00Z"),
				operation: "subscribe",
				phase,
				subscriptionId: "subscription_management_test",
				reason:
					phase === "subscription.started"
						? "request_accepted"
						: "stream_ended",
			});
		}
		for (const suffix of ["a", "b", "c"]) {
			await sql`insert into platform.audit_events (id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, occurred_at, details) values (${`management_${suffix}`}, 'trace_management', 'user', 'user_management', 'agent.application.submitted', 'agent_application', 'application_management', 'succeeded', '2026-09-26T01:00:00Z', null)`;
		}
		const first = await reader.listManagementAudit(scope, {
			schemaVersion: 1,
			limit: 2,
		});
		expect(first.items.map((item) => item.auditId)).toEqual([
			"management_c",
			"management_b",
		]);
		expect(first.nextCursor).toBe("management_b");
		const second = await reader.listManagementAudit(scope, {
			schemaVersion: 1,
			limit: 2,
			cursor: first.nextCursor as string,
		});
		expect(second.items.map((item) => item.auditId)).toEqual(["management_a"]);
		expect(second.nextCursor).toBeNull();
		for (const cursor of ["audit_task_0", "audit_task_3", "audit_task_4"])
			await expect(
				reader.listManagementAudit(scope, {
					schemaVersion: 1,
					limit: 2,
					cursor,
				}),
			).rejects.toMatchObject({ code: "invalid_request" });
		expect(
			(await reader.listAudit(scope, { schemaVersion: 1, limit: 10 })).items,
		).toHaveLength(8);
		expect(await sql`select id from platform.audit_events`).toHaveLength(8);
	});
	it("does not expose persistence credentials when connection fails", async () => {
		const unavailable = new PostgresTaskApiAuditStoreV1({
			databaseUrl: "postgres://test:private-password@127.0.0.1:1/test",
		});
		try {
			const error = await createTaskApiAuditV1(unavailable)
				.record(input)
				.catch((failure) => failure);
			expect(error).toMatchObject({
				code: "unavailable",
				message: "Task API audit persistence is unavailable",
			});
			expect(String(error)).not.toContain("private-password");
		} finally {
			await unavailable.close();
		}
	});
});
