import {
	createTaskApiAuditV1,
	type TaskApiAuditRecordInputV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { PostgresConversationExecutionTransactionV1 } from "./conversation-execution.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
const stores: PostgresConversationExecutionTransactionV1[] = [];
function writer() {
	const store = new PostgresConversationExecutionTransactionV1({
		databaseUrl: database.databaseUrl,
	});
	stores.push(store);
	return createTaskApiAuditV1({
		write: (plan) => store.writeTaskApiAudit(plan),
	});
}
const started: TaskApiAuditRecordInputV1 = {
	schemaVersion: 1,
	auditId: "start-audit",
	operation: "subscribe",
	phase: "subscription.started",
	result: "succeeded",
	reason: "request_accepted",
	principal: { kind: "application", id: "application" },
	target: {
		kind: "execution",
		agentId: "agent",
		conversationId: "conversation",
		executionId: "execution",
	},
	requestId: "request",
	traceId: "trace",
	subscriptionId: "subscription",
};
beforeAll(async () => {
	database = await startPostgresTestDatabase("task-api-audit-owned-client");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 1 });
}, 120_000);
beforeEach(async () => {
	await sql`truncate platform.audit_events,platform.outbox_items`;
});
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
});
afterAll(async () => {
	await sql?.end();
	await database?.stop();
});
describe("Task API access audit through the original Conversation Store", () => {
	it("rejects credential/body metadata and mismatched replay instead of overwriting audits", async () => {
		const audit = writer();
		await expect(
			audit.record({
				...started,
				credential: "private credential",
			} as TaskApiAuditRecordInputV1),
		).rejects.toMatchObject({ code: "invalid_input" });
		await audit.record({
			...started,
			operation: "read",
			phase: "access",
			subscriptionId: undefined,
		});
		await expect(
			audit.record({
				...started,
				operation: "read",
				phase: "access",
				subscriptionId: undefined,
				principal: { kind: "user", id: "application" },
			}),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(
			await sql`select actor_type,actor_id,details from platform.audit_events`,
		).toMatchObject([
			{
				actor_type: "application",
				actor_id: "application",
				details: { operation: "read" },
			},
		]);
	});
});
