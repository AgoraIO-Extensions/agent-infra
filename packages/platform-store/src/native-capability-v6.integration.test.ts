import { createHash } from "node:crypto";
import { createNativeCapabilityAdmissionUseCaseV6 } from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { PostgresConversationExecutionTransactionV1 } from "./conversation-execution.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";
import { seedSessionSandboxFixture } from "./session-sandbox.fixture.js";

let database: PostgresTestDatabase | undefined;
let client: ReturnType<typeof postgres>;
let store: PostgresConversationExecutionTransactionV1;
let databaseUrl: string;
const authority = {
	conversationId: "native-v6-conversation",
	agentId: "native-v6-agent",
	actorId: "native-v6-user",
	channelId: "web",
	principal: { kind: "user" as const, id: "native-v6-user" },
	executionSource: "web" as const,
	authorizationRevision: "native-v6-auth",
	sessionGeneration: 1,
	hostSessionRef: "native-v6-host",
};
const keyBinding = {
	purpose: "personal" as const,
	subjectId: authority.actorId,
	ciphertextRef: "native-v6-key",
	version: 1,
};
function request(executionId = "native-v6-execution") {
	return {
		schemaVersion: 6 as const,
		requestId: "native-v6-request",
		traceId: "native-v6-trace",
		principal: authority.principal,
		executionSource: authority.executionSource,
		channelId: authority.channelId,
		agentId: authority.agentId,
		conversationId: authority.conversationId,
		executionId,
		turnId: `turn-${executionId}`,
		sessionGeneration: 1,
		hostSessionRef: authority.hostSessionRef,
		operation: {
			kind: "execution" as const,
			id: executionId,
			deliveryFence: 1,
			executionDeliveryFence: 1,
		},
		grant: {
			schemaVersion: 6 as const,
			format: "runtime-execution-jws" as const,
			token: "controlled.test.grant",
		},
		keyBinding,
		capabilityId: "c".repeat(64),
		capabilityKind: "command" as const,
		directoryRevision: "d".repeat(64),
		parameters: "compact",
		parametersDigest: createHash("sha256").update("compact").digest("hex"),
		capabilitySourceVersion: "0.153.0",
		selection: {
			schemaVersion: 1 as const,
			modelOptionId: "model-primary",
			reasoningLevel: "high",
		},
		configVersion: "config-1",
	};
}
type PreparedInput = Omit<ReturnType<typeof request>, "grant">;
function publicInvocation(
	input: PreparedInput = request(),
	idempotencyKey = input.executionId,
) {
	return {
		schemaVersion: 3 as const,
		conversationId: input.conversationId,
		capabilityId: input.capabilityId,
		directoryRevision: input.directoryRevision,
		parameters: input.parameters,
		selection: input.selection,
		idempotencyKey,
		requestId: input.requestId,
		traceId: input.traceId,
	};
}
function useCase(currentKey = keyBinding) {
	const internal = createNativeCapabilityAdmissionUseCaseV6({
		authorization: {
			authorize: async () => ({
				outcome: "allowed",
				authority,
				keyBinding: currentKey,
			}),
		},
		transaction: store,
	});
	return {
		admit: (input: PreparedInput, invocation = publicInvocation(input)) =>
			internal.admit(input, invocation),
	};
}
beforeAll(async () => {
	const local = process.env.V6_ADMISSION_TEST_DATABASE_URL;
	if (local) {
		const parsed = new URL(local);
		if (
			!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
			!parsed.pathname.startsWith("/native_v6_")
		)
			throw new Error(
				"V6 admission tests require an isolated local test database",
			);
		databaseUrl = local;
	} else {
		database = await startPostgresTestDatabase("native-v6-admission");
		databaseUrl = database.databaseUrl;
	}
	await migratePlatformDatabase({ databaseUrl });
	client = postgres(databaseUrl, { max: 3 });
	store = new PostgresConversationExecutionTransactionV1({ databaseUrl });
}, 120_000);
afterAll(async () => {
	await store?.close();
	await client?.end({ timeout: 5 });
	await database?.stop();
});
beforeEach(async () => {
	await client`truncate platform.agents, platform.conversations, platform.conversation_executions,
 platform.outbox_items, platform.idempotency_records, platform.conversation_audit_events, platform.relay_key_subjects cascade`;
	await client`insert into platform.agents (id,current_configuration_revision,authorization_revision)
 values (${authority.agentId},1,${authority.authorizationRevision})`;
	await client`insert into platform.conversations (id,agent_id,actor_id,principal_type,channel_id,status,session_generation,host_session_ref,authorization_revision,last_conversation_cursor)
 values (${authority.conversationId},${authority.agentId},${authority.actorId},'user','web','ready',1,${authority.hostSessionRef},${authority.authorizationRevision},0)`;
	await seedSessionSandboxFixture(client, authority.conversationId);
	await client`insert into platform.relay_key_subjects (purpose,subject_id,last_version,current_version) values ('personal',${authority.actorId},1,1)`;
	await client`insert into platform.relay_key_versions (purpose,subject_id,key_version,key_id,ciphertext) values ('personal',${authority.actorId},1,${keyBinding.ciphertextRef},${client.json({ purpose: "personal", subjectId: authority.actorId, keyId: keyBinding.ciphertextRef, keyVersion: 1 })})`;
});
async function effects() {
	const [row] = await client`select
 (select count(*)::int from platform.conversation_executions where execution_id <> 'occupied') as executions,
 (select count(*)::int from platform.outbox_items where operation='conversation.native-capability.invoke.v2') as outbox,
 (select count(*)::int from platform.idempotency_records) as idempotency,
 (select count(*)::int from platform.conversation_audit_events) as audit`;
	return row;
}
async function settledAdmissions<T>(pending: Promise<T>[]): Promise<T[]> {
	const results = await Promise.allSettled(pending);
	return results.map((result) => {
		if (result.status === "rejected") throw result.reason;
		return result.value;
	});
}
const noEffects = { executions: 0, outbox: 0, idempotency: 0, audit: 0 };
it.each(["waiting", "submitted", "processing", "unknown"] as const)(
	"refuses %s occupancy before all durable writes",
	async (status) => {
		await client`insert into platform.conversation_executions
 (execution_id,conversation_id,sandbox_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,delivery_fence,authorization_revision,task_wait_order,task_wait_deadline,created_at,updated_at)
 select 'occupied',c.id,s.sandbox_id,c.agent_id,c.actor_id,c.channel_id,'occupied-turn',${status},1,0,c.authorization_revision,
 ${status === "waiting" ? 1 : null},${status === "waiting" ? new Date(Date.now() + 60000) : null},now(),now()
 from platform.conversations c join platform.session_sandbox_allocations s on s.conversation_id=c.id where c.id=${authority.conversationId}`;
		expect(await useCase().admit(request())).toMatchObject({
			outcome: status === "unknown" ? "unknown" : "busy",
		});
		expect(await effects()).toEqual(noEffects);
	},
);
it.each(["active", "unavailable"] as const)(
	"rejects a %s Conversation even without an execution row",
	async (status) => {
		await client`update platform.conversations set status=${status} where id=${authority.conversationId}`;
		expect(await useCase().admit(request())).toMatchObject({
			outcome: "denied",
		});
		expect(await effects()).toEqual(noEffects);
	},
);
it("rejects a stopped Sandbox", async () => {
	await client`update platform.session_sandbox_allocations set desired_state='stopped' where conversation_id=${authority.conversationId}`;
	expect(await useCase().admit(request())).toMatchObject({
		outcome: "unavailable",
	});
	expect(await effects()).toEqual(noEffects);
});
it("checks the current Agent authorization revision", async () => {
	await client`update platform.agents set authorization_revision='revoked' where id=${authority.agentId}`;
	expect(await useCase().admit(request())).toMatchObject({ outcome: "denied" });
	expect(await effects()).toEqual(noEffects);
});
async function rotateKey() {
	const next = { ...keyBinding, ciphertextRef: "native-v6-key-2", version: 2 };
	await client`insert into platform.relay_key_versions (purpose,subject_id,key_version,key_id,ciphertext)
 values ('personal',${authority.actorId},2,${next.ciphertextRef},${client.json({ purpose: "personal", subjectId: authority.actorId, keyId: next.ciphertextRef, keyVersion: 2 })})`;
	await client`update platform.relay_key_subjects set last_version=2,current_version=2 where purpose='personal' and subject_id=${authority.actorId}`;
	return next;
}
it("rejects a new operation when its Key is no longer current", async () => {
	await rotateKey();
	expect(await useCase().admit(request())).toMatchObject({ outcome: "denied" });
	expect(await effects()).toEqual(noEffects);
});
it("rejects a new operation when the current Key is absent", async () => {
	await client`update platform.relay_key_subjects set current_version=null where purpose='personal' and subject_id=${authority.actorId}`;
	expect(await useCase().admit(request())).toMatchObject({ outcome: "denied" });
	expect(await effects()).toEqual(noEffects);
});
it("accepts and persists the newly authorized current Key after rotation", async () => {
	const next = await rotateKey();
	const result = await useCase(next).admit({ ...request(), keyBinding: next });
	expect(result).toMatchObject({
		outcome: "accepted",
		plan: { keyBinding: next },
	});
	const [execution] =
		await client`select relay_key_id,relay_key_version::int from platform.conversation_executions where execution_id=${request().executionId}`;
	expect(execution).toEqual({
		relay_key_id: next.ciphertextRef,
		relay_key_version: 2,
	});
});
it("replays the frozen accepted Key without following the current alias", async () => {
	const accepted = await useCase().admit(request());
	expect(accepted.outcome).toBe("accepted");
	if (accepted.outcome !== "accepted") throw new Error("expected acceptance");
	const before = await effects();
	await rotateKey();
	expect(await useCase().admit(request())).toEqual({
		outcome: "replayed",
		plan: accepted.plan,
	});
	expect(await effects()).toEqual(before);
});
it("serializes same-key admissions and replays the original plan after reopening the Store", async () => {
	const results = await settledAdmissions([
		useCase().admit(request()),
		useCase().admit(request()),
	]);
	expect(results.map((r) => r.outcome).sort()).toEqual([
		"accepted",
		"replayed",
	]);
	expect(await effects()).toEqual({
		executions: 1,
		outbox: 1,
		idempotency: 1,
		audit: 1,
	});
	const accepted = results.find((r) => r.outcome === "accepted");
	if (accepted?.outcome !== "accepted") throw new Error("expected acceptance");
	const [outbox] =
		await client`select payload from platform.outbox_items where id=${accepted.plan.outbox.id}`;
	expect(outbox?.payload).toEqual(accepted.plan.outbox.payload);
	await store.close();
	store = new PostgresConversationExecutionTransactionV1({ databaseUrl });
	expect(
		await useCase().admit({
			...request(),
			requestId: "retry",
			traceId: "retry",
		}),
	).toEqual({ outcome: "replayed", plan: accepted.plan });
});
it("serializes different-key admissions into one Execution", async () => {
	const results = await settledAdmissions([
		useCase().admit(request("one")),
		useCase().admit(request("two")),
	]);
	expect(results.map((r) => r.outcome).sort()).toEqual(["accepted", "busy"]);
	expect(await effects()).toEqual({
		executions: 1,
		outbox: 1,
		idempotency: 1,
		audit: 1,
	});
});
const failurePoints = [
	{ stage: "outbox", table: "platform.outbox_items", event: "insert" },
	{
		stage: "audit",
		table: "platform.conversation_audit_events",
		event: "insert",
	},
	{
		stage: "idempotency completion",
		table: "platform.idempotency_records",
		event: "update",
	},
];
it.each(failurePoints)(
	"rolls back all writes when $stage fails",
	async ({ table, event }) => {
		await client`create sequence platform.v6_failure_hit`;
		await client`create function platform.fail_v6_write() returns trigger language plpgsql as $$begin perform nextval('platform.v6_failure_hit'); raise exception 'controlled transaction failure'; end$$`;
		// Table and event come only from the fixed test cases above.
		await client.unsafe(
			`create trigger fail_v6_write before ${event} on ${table} for each row execute function platform.fail_v6_write()`,
		);
		try {
			await expect(useCase().admit(request())).rejects.toMatchObject({
				code: "unavailable",
			});
			const [hit] = await client`select is_called from platform.v6_failure_hit`;
			expect(hit?.is_called).toBe(true);
			expect(await effects()).toEqual(noEffects);
		} finally {
			await client.unsafe(`drop trigger fail_v6_write on ${table}`);
			await client`drop function platform.fail_v6_write()`;
			await client`drop sequence platform.v6_failure_hit`;
		}
	},
);
it("denies replay after the Agent authorization revision changes", async () => {
	expect(await useCase().admit(request())).toMatchObject({
		outcome: "accepted",
	});
	const before = await effects();
	await client`update platform.agents set authorization_revision='revoked' where id=${authority.agentId}`;
	expect(await useCase().admit(request())).toMatchObject({
		outcome: "denied",
		reason: "authorization_lost",
	});
	expect(await effects()).toEqual(before);
});

it("serializes one public idempotency key even when retries allocate different operation IDs", async () => {
	const one = request("candidate-one");
	const two = request("candidate-two");
	const results = await settledAdmissions([
		useCase().admit(one, publicInvocation(one, "same-public-key")),
		useCase().admit(two, publicInvocation(two, "same-public-key")),
	]);
	expect(results.map((result) => result.outcome).sort()).toEqual([
		"accepted",
		"replayed",
	]);
	const plans = results.map((result) =>
		"plan" in result ? result.plan : null,
	);
	expect(plans[0]).toEqual(plans[1]);
	expect(await effects()).toEqual({
		executions: 1,
		outbox: 1,
		idempotency: 1,
		audit: 1,
	});
});

it("returns the original accepted operation after current Key/config and candidate IDs change", async () => {
	const accepted = await useCase().admit(request());
	if (accepted.outcome !== "accepted") throw new Error("expected acceptance");
	const before = await effects();
	const next = await rotateKey();
	const retry = {
		...request("new-candidate"),
		keyBinding: next,
		configVersion: "config-2",
	};
	expect(
		await useCase(next).admit(
			retry,
			publicInvocation(retry, request().executionId),
		),
	).toEqual({ outcome: "replayed", plan: accepted.plan });
	expect(await effects()).toEqual(before);
});

it("persists a prepared operation before any transport Grant is created", async () => {
	const { grant: _grant, ...prepared } = request();
	const result = await useCase().admit(prepared);
	expect(result.outcome).toBe("accepted");
	const [row] =
		await client`select payload from platform.outbox_items where operation='conversation.native-capability.invoke.v2'`;
	expect(row?.payload).not.toHaveProperty("grant");
	expect(JSON.stringify(row?.payload)).not.toContain("controlled.test.grant");
	expect(await effects()).toEqual({
		executions: 1,
		outbox: 1,
		idempotency: 1,
		audit: 1,
	});
});

it.each(["parameters", "selection"] as const)(
	"rejects changed public %s under the original idempotency key",
	async (field) => {
		expect((await useCase().admit(request())).outcome).toBe("accepted");
		const before = await effects();
		const retry =
			field === "parameters"
				? {
						...request("retry"),
						parameters: "changed",
						parametersDigest: createHash("sha256")
							.update("changed")
							.digest("hex"),
					}
				: {
						...request("retry"),
						selection: { ...request().selection, reasoningLevel: "low" },
					};
		expect(
			await useCase().admit(
				retry,
				publicInvocation(retry, request().executionId),
			),
		).toEqual({ outcome: "conflict", reason: "idempotency_conflict" });
		expect(await effects()).toEqual(before);
	},
);
