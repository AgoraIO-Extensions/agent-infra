import { connectionConsumerProfileFingerprintV1 } from "@agent-infra/contracts/connection-consumer-profile";
import {
	type ConnectionConsumerRegistrationIntentV1,
	planConnectionConsumerRegistrationV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { resolveRegisteredConnectionConsumerBindingsV1 } from "./connection-registration-bindings.js";
import { createConnectionConsumerRegistrationWorkerV1 } from "./connection-registration-worker.js";

const policy = {
	schemaVersion: 1 as const,
	sourceNamespace: "controlled-worker-integration",
	revision: "policy-1",
	callbackUrl: "https://platform.example.test/connection/callback",
	resource: "https://connection.example.test/mcp",
	scope: "mcp:tools",
};
let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
beforeAll(async () => {
	database = await startPostgresTestDatabase("connection-registration-worker");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 2, onnotice: () => {} });
}, 120_000);
beforeEach(async () => {
	await sql`truncate platform.agents, platform.outbox_items, platform.persisted_events, platform.platform_user_disables cascade`;
	await sql`insert into platform.agents (id) values ('agent-a')`;
	await sql`insert into platform.agent_applications (id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,desired_state,workload_revision,fence) values ('application-a','agent-a','owner-a','Agent A','Controlled registration','creating','trace','request',now(),1,1,'running',1,1)`;
	await sql`insert into platform.agent_owners (agent_id,owner_id,created_at) values ('agent-a','owner-a',now())`;
	const intent = planConnectionConsumerRegistrationV1({
		policy,
		platformAgentId: "agent-a",
		platformOwnerId: "owner-a",
		consumerName: "Agent A",
	});
	await sql.begin(async (transaction) => {
		await transaction`insert into platform.connection_consumer_registrations(operation_id,agent_id,source_namespace,source_key,request_digest,idempotency_key,request) values (${intent.operationId},${intent.platformAgentId},${intent.sourceNamespace},${intent.sourceKey},${intent.requestDigest},${intent.idempotencyKey},${transaction.json({ ...intent })})`;
		await transaction`insert into platform.outbox_items(id,scope_type,scope_id,operation,payload,trace_id) values (${intent.operationId},'agent',${intent.platformAgentId},'agent.connection.consumer.register.v1',${transaction.json({ schemaVersion: 1, operationId: intent.operationId, platformAgentId: intent.platformAgentId, requestDigest: intent.requestDigest })},'trace')`;
	});
	await sql`insert into platform.outbox_items(id,scope_type,scope_id,operation,payload,trace_id) values ('workload-untouched','agent','agent-a','agent.workload.reconcile.v1','{}'::jsonb,'trace')`;
});
afterAll(async () => {
	await sql?.end();
	await database?.stop();
});
const receipt = (intent: ConnectionConsumerRegistrationIntentV1) => ({
	outcome: "registered" as const,
	receipt: {
		schemaVersion: 1 as const,
		operationId: intent.operationId,
		sourceNamespace: intent.sourceNamespace,
		sourceKey: intent.sourceKey,
		requestDigest: intent.requestDigest,
		consumerId: "actual-consumer-a",
		consumerRevision: "1",
		registrationId: "actual-registration-a",
	},
});

it("default absence of an adapter keeps the unsent intent pending and retries only its outbox", async () => {
	const worker = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: database.databaseUrl,
		policy,
	});
	try {
		await worker.runOnce();
		expect(
			await sql`select status, consumer_id from platform.connection_consumer_registrations`,
		).toEqual([{ status: "pending", consumer_id: null }]);
		expect(
			await sql`select operation,status from platform.outbox_items order by operation`,
		).toEqual([
			{
				operation: "agent.connection.consumer.register.v1",
				status: "retry_scheduled",
			},
			{ operation: "agent.workload.reconcile.v1", status: "pending" },
		]);
	} finally {
		await worker.close();
	}
});

it("reconciles a thrown registration on the same operation without creating again", async () => {
	const register = vi.fn(async () => {
		throw new Error("Controlled lost response");
	});
	const reconcile = vi.fn(
		async (intent: ConnectionConsumerRegistrationIntentV1) => receipt(intent),
	);
	const worker = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: database.databaseUrl,
		policy,
		adapter: { register, reconcile },
	});
	try {
		await worker.runOnce();
		expect(
			await sql`select status from platform.connection_consumer_registrations`,
		).toEqual([{ status: "unknown" }]);
		await sql`update platform.outbox_items set available_at = now() where operation = 'agent.connection.consumer.register.v1'`;
		await worker.runOnce();
		expect(register).toHaveBeenCalledOnce();
		expect(reconcile).toHaveBeenCalledOnce();
		expect(
			await sql`select status, consumer_id from platform.connection_consumer_registrations`,
		).toEqual([{ status: "registered", consumer_id: "actual-consumer-a" }]);
		expect(
			await sql`select status from platform.outbox_items where operation = 'agent.connection.consumer.register.v1'`,
		).toEqual([{ status: "succeeded" }]);
		expect(
			await sql`select * from platform.connection_consumer_registrations`,
		).toHaveLength(1);
	} finally {
		await worker.close();
	}
});

it("keeps the original delivery unknown if the Platform Owner is disabled during I/O", async () => {
	const register = vi.fn(
		async (intent: ConnectionConsumerRegistrationIntentV1) => {
			await sql`insert into platform.platform_user_disables(user_id) values ('owner-a')`;
			return receipt(intent);
		},
	);
	const worker = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: database.databaseUrl,
		policy,
		adapter: { register, reconcile: register },
	});
	try {
		await worker.runOnce();
		expect(register).toHaveBeenCalledOnce();
		expect(
			await sql`select status, consumer_id from platform.connection_consumer_registrations`,
		).toEqual([{ status: "unknown", consumer_id: null }]);
		expect(
			await sql`select status from platform.outbox_items where operation = 'agent.connection.consumer.register.v1'`,
		).toEqual([{ status: "retry_scheduled" }]);
	} finally {
		await worker.close();
	}
});

it.each([false, true])(
	"consumes the original worker's persisted Consumer binding and rejects a late Owner change (%s)",
	async (changed) => {
		const worker = createConnectionConsumerRegistrationWorkerV1({
			databaseUrl: database.databaseUrl,
			policy,
			adapter: {
				register: async (intent) => receipt(intent),
				reconcile: async (intent) => receipt(intent),
			},
		});
		try {
			await worker.runOnce();
			const resolve = vi.fn(async (signal: AbortSignal, registrations) => {
				signal.throwIfAborted();
				const binding = registrations?.["agent-a"];
				if (!binding) throw Error("Expected original persisted binding");
				expect(binding.receipt.consumerId).toBe("actual-consumer-a");
				expect(binding.source).toEqual({
					ref: binding.intent.operationId,
					revision: "1",
				});
				const profile = {
					schemaVersion: 1 as const,
					publicOrigin: "https://connection.example.test",
					mcpPath: "/mcp",
					consumerId: binding.receipt.consumerId,
					audience: "mcp",
					egressProfile: { ref: "controlled-egress", revision: "r1" },
				};
				if (changed)
					await sql`insert into platform.platform_user_disables(user_id) values ('owner-a')`;
				return {
					"agent-a": {
						profile,
						approval: {
							schemaVersion: 1,
							configFingerprint:
								connectionConsumerProfileFingerprintV1(profile),
							egressEnforced: true,
							source: binding.source,
						},
						installationSupply: {
							ref: "controlled-host-supply",
							revision: "r1",
						},
					},
				};
			});
			const bindings = await resolveRegisteredConnectionConsumerBindingsV1({
				databaseUrl: database.databaseUrl,
				policy,
				resolve,
				signal: new AbortController().signal,
			});
			expect(resolve).toHaveBeenCalledOnce();
			expect(Object.keys(bindings)).toEqual(changed ? [] : ["agent-a"]);
			if (!changed)
				expect(bindings["agent-a"]?.profile).toMatchObject({
					consumerId: "actual-consumer-a",
				});
		} finally {
			await worker.close();
		}
	},
);

it("never prepares an installation from an original unknown worker delivery", async () => {
	const unknown = async () => ({
		outcome: "unknown" as const,
		failureCode: "CONTROLLED_UNKNOWN",
	});
	const worker = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: database.databaseUrl,
		policy,
		adapter: { register: unknown, reconcile: unknown },
	});
	try {
		await worker.runOnce();
		const resolve = vi.fn(async () => ({}));
		expect(
			await resolveRegisteredConnectionConsumerBindingsV1({
				databaseUrl: database.databaseUrl,
				policy,
				resolve,
				signal: new AbortController().signal,
			}),
		).toEqual({});
		expect(resolve).not.toHaveBeenCalled();
	} finally {
		await worker.close();
	}
});
