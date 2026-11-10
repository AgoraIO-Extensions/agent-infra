import {
	createAgentManagementV1,
	createApplicationFoundationUseCaseV1,
	planConnectionConsumerRegistrationV1,
} from "@agent-infra/platform-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
	applicationFoundationActorContextV1,
	applicationFoundationAdmissionDependenciesV1,
	applicationFoundationCommandV1,
} from "../../platform-core/src/application-foundation.conformance.js";
import { PostgresAgentManagementTransactionV1 } from "./agent-management.js";
import { PostgresApplicationFoundationTransactionV1 } from "./application-foundation.js";
import {
	insertConnectionConsumerRegistrationV1,
	PostgresConnectionConsumerRegistrationStoreV1,
} from "./connection-consumer-registration.js";
import { migratePlatformDatabase } from "./migrate.js";
import { createPostgresOutboxStore } from "./outbox.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";
import { createSecretRecordFixtureResolver } from "./secret-record-fixture.js";

const policy = {
	schemaVersion: 1 as const,
	sourceNamespace: "platform-registration-test",
	revision: "policy-1",
	callbackUrl: "https://platform.example.test/connection/callback",
	resource: "https://connection.example.test/mcp",
	scope: "mcp:tools",
};
let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let foundation: PostgresApplicationFoundationTransactionV1;
let management: PostgresAgentManagementTransactionV1;
let registrations: PostgresConnectionConsumerRegistrationStoreV1;
let outbox: ReturnType<typeof createPostgresOutboxStore>;
beforeAll(async () => {
	database = await startPostgresTestDatabase(
		"connection-consumer-registration",
	);
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 3, onnotice: () => {} });
	foundation = new PostgresApplicationFoundationTransactionV1({
		databaseUrl: database.databaseUrl,
		connectionConsumerRegistration: policy,
	});
	management = new PostgresAgentManagementTransactionV1({
		databaseUrl: database.databaseUrl,
		connectionConsumerRegistration: policy,
	});
	registrations = new PostgresConnectionConsumerRegistrationStoreV1({
		databaseUrl: database.databaseUrl,
		policy,
	});
	outbox = createPostgresOutboxStore({ databaseUrl: database.databaseUrl });
}, 120_000);
beforeEach(async () => {
	await sql`truncate platform.agents, platform.outbox_items, platform.persisted_events, platform.audit_events, platform.idempotency_records cascade`;
});
afterAll(async () => {
	await Promise.all([
		foundation?.close(),
		management?.close(),
		registrations?.close(),
		outbox?.close(),
		sql?.end(),
	]);
	await database?.stop();
});

async function submit(id = "agent-a") {
	await createApplicationFoundationUseCaseV1({
		transaction: foundation,
		...applicationFoundationAdmissionDependenciesV1(),
	}).submit(
		{
			...applicationFoundationCommandV1,
			agentId: id,
			applicationId: `application-${id}`,
			idempotencyKey: `submit-${id}`,
		},
		applicationFoundationActorContextV1,
		createSecretRecordFixtureResolver(),
	);
}
async function approve(id = "agent-a", key = `approve-${id}`) {
	return createAgentManagementV1(management).executeManagementCommand(
		{
			schemaVersion: 1,
			command: "approve_application",
			applicationId: `application-${id}`,
			expectedRevision: 0,
			idempotencyKey: key,
			traceId: `trace-${id}`,
			requestId: `request-${id}`,
		},
		{
			schemaVersion: 1,
			userId: "administrator",
			accountStatus: "active",
			isAdministrator: true,
			organizationIds: [],
		},
	);
}
async function claim() {
	const [itemId] = await registrations.pending();
	expect(itemId).toBeTruthy();
	const lease = await outbox.claim({
		itemId: String(itemId),
		leaseOwner: "test-worker",
		leaseDurationMs: 30_000,
	});
	if (!lease) throw new Error("Expected owned registration lease");
	return lease;
}

it("does not register pending Web submissions; approval atomically adds one independent intent/outbox", async () => {
	await submit();
	expect(
		await sql`select * from platform.connection_consumer_registrations`,
	).toHaveLength(0);
	expect(
		(await sql`select operation from platform.outbox_items`).map(
			(r) => r.operation,
		),
	).toEqual(["agent.application.submitted.v1"]);
	expect((await approve()).outcome).toBe("accepted");
	expect((await approve()).outcome).toBe("replayed");
	expect(
		await sql`select source_key, status, request->>'platformOwnerId' as owner from platform.connection_consumer_registrations`,
	).toEqual([
		{
			source_key: "agent-a",
			status: "pending",
			owner: applicationFoundationActorContextV1.userId,
		},
	]);
	expect(
		(
			await sql`select operation from platform.outbox_items order by operation`
		).map((r) => r.operation),
	).toEqual([
		"agent.application.submitted.v1",
		"agent.connection.consumer.register.v1",
		"agent.workload.reconcile.v1",
	]);
});

it("rolls back the approval transition and workload outbox if registration persistence fails", async () => {
	await submit();
	await sql`create function platform.registration_fault() returns trigger language plpgsql as $$ begin raise exception 'controlled registration failure'; end $$`;
	await sql`create trigger registration_fault before insert on platform.connection_consumer_registrations for each row execute function platform.registration_fault()`;
	try {
		await expect(approve()).rejects.toMatchObject({ code: "unavailable" });
	} finally {
		await sql`drop trigger registration_fault on platform.connection_consumer_registrations`;
		await sql`drop function platform.registration_fault()`;
	}
	expect(await sql`select status from platform.agent_applications`).toEqual([
		{ status: "pending_approval" },
	]);
	expect(
		await sql`select * from platform.connection_consumer_registrations`,
	).toHaveLength(0);
	expect(await sql`select operation from platform.outbox_items`).toEqual([
		{ operation: "agent.application.submitted.v1" },
	]);
});

it("two formal Agents have distinct source keys; same intent replays and changed input conflicts", async () => {
	await submit("agent-a");
	await submit("agent-b");
	await approve("agent-a");
	await approve("agent-b");
	const rows =
		await sql`select operation_id, source_namespace, source_key from platform.connection_consumer_registrations order by source_key`;
	expect(rows.map((row) => row.source_key)).toEqual(["agent-a", "agent-b"]);
	expect(rows[0]?.operation_id).not.toBe(rows[1]?.operation_id);
	const input = {
		policy,
		platformAgentId: "agent-a",
		platformOwnerId: applicationFoundationActorContextV1.userId,
		consumerName: applicationFoundationCommandV1.name,
		transition: {
			operation: "approve_application",
			creationChannel: "web" as const,
			from: "pending_approval",
			to: "creating",
		},
		traceId: "retry",
		requestId: "retry",
		occurredAt: new Date(),
	};
	await drizzle(sql).transaction((tx) =>
		insertConnectionConsumerRegistrationV1(tx, input),
	);
	await expect(
		drizzle(sql).transaction((tx) =>
			insertConnectionConsumerRegistrationV1(tx, {
				...input,
				consumerName: "Changed",
			}),
		),
	).rejects.toThrow("CONNECTION_CONSUMER_REGISTRATION_CONFLICT");
	expect(
		await sql`select * from platform.connection_consumer_registrations`,
	).toHaveLength(2);
});

it("unavailable adapter keeps the unsent original pending and allows its first register later", async () => {
	await submit();
	await approve();
	const lease = await claim();
	expect(await registrations.beginAttempt(lease, false)).toEqual({
		outcome: "pending",
	});
	await outbox.scheduleRetry({
		itemId: lease.itemId,
		leaseOwner: lease.leaseOwner,
		deliveryFence: lease.deliveryFence,
		retryDelayMs: 0,
		errorCode: "ADAPTER_UNAVAILABLE",
	});
	const next = await claim();
	expect(await registrations.beginAttempt(next, true)).toMatchObject({
		outcome: "deliver",
		mode: "register",
	});
	expect(
		await registrations.complete(next, {
			outcome: "unknown",
			failureCode: "RESULT_UNKNOWN",
		}),
	).toBe(true);
	expect(
		await sql`select status, consumer_id from platform.connection_consumer_registrations`,
	).toEqual([{ status: "unknown", consumer_id: null }]);
	const other = new PostgresConnectionConsumerRegistrationStoreV1({
		databaseUrl: database.databaseUrl,
		policy: { ...policy, sourceNamespace: "another-source" },
	});
	try {
		expect(await other.current(next)).toBe(false);
	} finally {
		await other.close();
	}
});

it("rejects cross-Agent receipts and stale fences; only an exact receipt establishes registered", async () => {
	await submit();
	await approve();
	const lease = await claim();
	const attempt = await registrations.beginAttempt(lease, true);
	if (attempt?.outcome !== "deliver")
		throw new Error("Expected registration attempt");
	const intent = planConnectionConsumerRegistrationV1({
		policy,
		platformAgentId: "agent-a",
		platformOwnerId: applicationFoundationActorContextV1.userId,
		consumerName: applicationFoundationCommandV1.name,
	});
	const receipt = {
		schemaVersion: 1 as const,
		operationId: intent.operationId,
		sourceNamespace: intent.sourceNamespace,
		sourceKey: intent.sourceKey,
		requestDigest: intent.requestDigest,
		consumerId: "actual-consumer-a",
		consumerRevision: "1",
		registrationId: "actual-registration-a",
	};
	await expect(
		registrations.complete(lease, {
			outcome: "registered",
			receipt: { ...receipt, sourceKey: "agent-b" },
		}),
	).rejects.toThrow();
	expect(
		await registrations.complete(
			{ ...lease, deliveryFence: lease.deliveryFence + 1n },
			{ outcome: "registered", receipt },
		),
	).toBe(false);
	expect(
		await registrations.complete(lease, { outcome: "registered", receipt }),
	).toBe(true);
	expect(
		await sql`select status, consumer_id from platform.connection_consumer_registrations`,
	).toEqual([{ status: "registered", consumer_id: "actual-consumer-a" }]);
});

it("the schema rejects secret-shaped extra fields and incomplete registered claims", async () => {
	await submit();
	await approve();
	await expect(
		sql`update platform.connection_consumer_registrations set request = request || '{"token":"forbidden-extra-field"}'::jsonb`,
	).rejects.toMatchObject({ code: "23514" });
	await expect(
		sql`update platform.connection_consumer_registrations set status = 'registered', consumer_id = 'unverified'`,
	).rejects.toMatchObject({ code: "23514" });
	await expect(
		sql`update platform.connection_consumer_registrations set request = request - 'platformOwnerId'`,
	).rejects.toMatchObject({ code: "23514" });
	expect(
		await sql`select status, consumer_id from platform.connection_consumer_registrations`,
	).toEqual([{ status: "pending", consumer_id: null }]);
});
