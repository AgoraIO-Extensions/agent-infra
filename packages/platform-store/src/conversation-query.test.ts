import {
	projectConversationMessagesV1,
	wecomChannelIdV1,
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
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "../../../apps/platform-worker/src/kubernetes.fixture.ts";
import { workloadResourceConfigurationHashV1 } from "../../../apps/platform-worker/src/workload-runtime.ts";
import { agentConfigurationConformanceRecordV1 } from "../../platform-core/src/agent-configuration.conformance.ts";
import {
	ConversationQueryError,
	type ConversationQueryScopeV1,
	PostgresConversationQueryV1,
	repeatableRead,
} from "./conversation-query.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";
import { seedSessionSandboxFixture } from "./session-sandbox.fixture.ts";

let databaseUrl = "";
let client: ReturnType<typeof postgres>;
let database: PostgresTestDatabase | undefined;
let query: PostgresConversationQueryV1;

beforeAll(async () => {
	database = await startPostgresTestDatabase("conversation-query");
	databaseUrl = database.databaseUrl;
	client = postgres(databaseUrl, { max: 10 });
	await migratePlatformDatabase({ databaseUrl });
	query = new PostgresConversationQueryV1({
		databaseUrl,
		replayWindow: 2,
	});

	for (const [conversationId, actorId] of [
		["conversation-1", "actor-1"],
		["conversation-2", "actor-2"],
		["conversation-3", "actor-1"],
	] as const) {
		await client`
			insert into platform.conversations
				(id, agent_id, actor_id, channel_id, status, session_generation,
				 authorization_revision, last_conversation_cursor, created_at, updated_at)
			values
				(${conversationId}, 'agent-1', ${actorId}, 'web', 'active', 1,
				 'authorization-1', 0, '2026-09-06T00:00:00.000Z',
				 '2026-09-06T00:00:00.000Z')
		`;
		await client`
			insert into platform.conversation_executions
				(execution_id, conversation_id, agent_id, actor_id, channel_id, turn_id,
				 status, session_generation, delivery_fence, authorization_revision,
				 created_at, updated_at)
			values
				(${`execution-${conversationId}`}, ${conversationId}, 'agent-1', ${actorId},
				 'web', ${`turn-${conversationId}`}, 'completed', 1, 1,
				 'authorization-1', '2026-09-06T00:00:01.000Z',
				 '2026-09-06T00:00:04.000Z')
		`;
		await client`
			insert into platform.conversation_messages
				(message_id, conversation_id, actor_id, role, text, execution_id, status,
				 created_at, updated_at)
			values
				(${`message-${conversationId}`}, ${conversationId}, ${actorId}, 'user',
				 'bounded fixture', ${`execution-${conversationId}`}, 'submitted',
				 '2026-09-06T00:00:01.000Z', '2026-09-06T00:00:01.000Z')
		`;
		await client`
			insert into platform.outbox_items
				(id, scope_type, scope_id, operation, payload, trace_id, request_id,
				 available_at, created_at, updated_at)
			values
				(${`outbox-${conversationId}`}, 'conversation', ${conversationId},
				 'conversation.turn.submit.v1', ${client.json({
						schemaVersion: 1,
						conversationId,
						executionId: `execution-${conversationId}`,
						messageId: `message-${conversationId}`,
						turnId: `turn-${conversationId}`,
						sessionGeneration: 1,
					})}, 'trace-1', 'request-1', '2026-09-06T00:00:01.000Z',
				 '2026-09-06T00:00:01.000Z', '2026-09-06T00:00:01.000Z')
		`;
		await client`
			insert into platform.conversation_audit_events
				(id, conversation_id, execution_id, agent_id, actor_id, action, trace_id,
				 request_id, occurred_at)
			values
				(${`audit-${conversationId}`}, ${conversationId},
				 ${`execution-${conversationId}`}, 'agent-1', ${actorId},
				 'conversation.message.accepted', 'trace-1', 'request-1',
				 '2026-09-06T00:00:01.000Z')
		`;
	}

	for (const cursor of [1, 2, 3]) {
		await client`
			insert into platform.conversation_events
				(event_id, conversation_id, execution_id, adapter_event_key, sequence,
				 conversation_cursor, event_type, event_payload, event_digest,
				 runtime_cursor, occurred_at, source)
			values
				(${`event-${cursor}`}, 'conversation-1', 'execution-conversation-1',
				 ${`adapter-${cursor}`}, ${cursor}, ${cursor}, 'text.delta',
				 ${client.json({ type: "text.delta", text: `part-${cursor}` })},
				 ${String(cursor).repeat(64)}, ${`runtime-${cursor}`},
				 now(), 'runtime')
		`;
	}
	await client`
		update platform.conversations set last_conversation_cursor = 3
		where id = 'conversation-1'
	`;
	await client`
		update platform.conversation_executions
		set last_event_sequence = 3, last_runtime_cursor = 'runtime-3'
		where execution_id = 'execution-conversation-1'
	`;
	await client`
		insert into platform.conversation_events
			(event_id, conversation_id, execution_id, adapter_event_key, sequence,
			 conversation_cursor, event_type, event_payload, event_digest,
			 runtime_cursor, occurred_at, source)
		values
			('event-conversation-2', 'conversation-2', 'execution-conversation-2',
			 'adapter-conversation-2', 1, 1, 'text.delta',
			 ${client.json({ type: "text.delta", text: "other" })}, ${"a".repeat(64)},
			 'runtime-conversation-2', now(), 'runtime')
	`;
	await client`
		update platform.conversations set last_conversation_cursor = 1
		where id = 'conversation-2'
	`;
	for (const [kind, channel, suffix] of [
		["user", "api", "user-1"],
		["user", "api", "user-2"],
		["application", "api", "application-1"],
		["application", "api", "application-2"],
		["user", "api:user", "legacy-user"],
		["application", "api:application", "legacy-application"],
	] as const) {
		const conversationId = `typed-${suffix}`;
		const executionId = `execution-${conversationId}`;
		await client`
			insert into platform.conversations
				(id, agent_id, actor_id, channel_id, principal_type, status,
				 session_generation, authorization_revision, last_conversation_cursor, created_at)
			values (${conversationId}, 'agent-typed', 'shared-principal', ${channel},
				${kind}, 'active', 1, 'authorization-typed', 1, now())
		`;
		await client`
			insert into platform.conversation_executions
				(execution_id, conversation_id, agent_id, actor_id, channel_id,
				 principal_type, turn_id, status, session_generation, authorization_revision,
				 created_at)
			values (${executionId}, ${conversationId}, 'agent-typed', 'shared-principal',
				${channel}, ${kind}, ${`turn-${suffix}`}, 'completed', 1,
				'authorization-typed', now())
		`;
		await client`
			insert into platform.conversation_messages
				(message_id, conversation_id, actor_id, role, text, execution_id, status, created_at)
			values (${`message-${suffix}`}, ${conversationId}, 'shared-principal', 'user',
				${suffix}, ${executionId}, 'submitted', now())
		`;
		await client`
			insert into platform.conversation_events
				(event_id, conversation_id, execution_id, adapter_event_key, sequence,
				 conversation_cursor, event_type, event_payload, event_digest, runtime_cursor, occurred_at, source)
			values (${`event-${suffix}`}, ${conversationId}, ${executionId},
				${`adapter-${suffix}`}, 1, 1, 'text.delta',
				${client.json({ type: "text.delta", text: suffix })}, ${"b".repeat(64)}, ${`runtime-${suffix}`}, now(), 'runtime')
		`;
	}
	for (const row of await client`select id from platform.conversations`) {
		await seedSessionSandboxFixture(client, String(row.id));
	}
}, 120_000);

afterAll(async () => {
	await query?.close();
	await client?.end();
	await database?.stop();
});

const actorOne = { actorId: "actor-1", channelId: "web" };

async function seedCurrentRuntimeTargetFixture() {
	const agentId = "agent-1";
	const deployment = workloadDesiredFixture(1, agentId, "internal-only");
	const configuration = {
		...structuredClone(agentConfigurationConformanceRecordV1),
		agentId,
		revision: 1,
	};
	const executionCapacity = {
		schemaVersion: 1,
		imageDigest: deployment.imageDigest,
		resourceProfileRef: deployment.resourceProfileRef,
		resourceConfigurationHash:
			workloadResourceConfigurationHashV1(workloadTestPolicy),
		maximumConcurrentExecutions: 8,
		conformanceEvidenceHash: "c".repeat(64),
	};
	const version = { configuration, deployment, executionCapacity };
	const state = {
		schemaVersion: 1,
		agentId,
		sourceConfigurationRevision: 1,
		sourceLifecycleRevision: 1,
		revision: 1,
		fence: 1,
		phase: "ready",
		candidate: version,
		verified: version,
		verifiedRevision: 1,
		identity: { uid: `workload-${agentId}`, generation: 1 },
		rollback: false,
		failureCode: null,
		attempts: 0,
	};
	const relayKeyId = "native-runtime-target-key";
	await client`insert into platform.relay_key_subjects
		(purpose, subject_id, last_version, current_version)
		values ('personal', 'actor-1', 1, 1)
		on conflict (purpose, subject_id) do update set last_version=1, current_version=1`;
	await client`insert into platform.relay_key_versions
		(purpose, subject_id, key_version, key_id, ciphertext)
		values ('personal', 'actor-1', 1, ${relayKeyId}, ${client.json({
			purpose: "personal",
			subjectId: "actor-1",
			keyId: relayKeyId,
			keyVersion: 1,
		})})
		on conflict (purpose, subject_id, key_version) do nothing`;
	await client`insert into platform.agents (id, current_configuration_revision, authorization_revision)
		values (${agentId}, 1, 'authorization-1')
		on conflict (id) do update set current_configuration_revision=excluded.current_configuration_revision,
			authorization_revision=excluded.authorization_revision`;
	await client`insert into platform.agent_applications
		(id, agent_id, applicant_id, name, description, status, trace_id, request_id,
		 submitted_at, management_revision, approval_revision, desired_state,
		 service_availability, workload_revision, fence)
		values ('application-native-target', ${agentId}, 'actor-1', 'Agent', 'Fixture',
			'available', 'trace-native-target', 'request-native-target', now(), 1, 1,
			'running', 'ready', 1, 1)
		on conflict (id) do update set desired_state='running', workload_revision=1, fence=1`;
	await client`insert into platform.workload_reconciliations
		(agent_id, revision, state, next_attempt_at)
		values (${agentId}, 1, ${client.json(state as unknown as postgres.JSONValue)}, now())
		on conflict (agent_id) do update set revision=excluded.revision, state=excluded.state`;
	const [allocation] = await client<{ sandbox_id: string }[]>`
		select sandbox_id from platform.session_sandbox_allocations
		where conversation_id='conversation-1'`;
	if (!allocation?.sandbox_id) throw new Error("Missing Sandbox fixture");
	const policy = {
		namespace: "fixture-sandboxes",
		resourceConfigurationHash:
			workloadResourceConfigurationHashV1(workloadTestPolicy),
		configurationRevision: 1,
		workloadRevision: 1,
		managementFence: 1,
		imageDigest: deployment.imageDigest,
	};
	await client`update platform.session_sandbox_allocations
		set status='ready', desired_state='running', resource_fence=1,
		resource_policy=${client.json(policy)},
		resource_observation=jsonb_build_object('status','ready','resources',
			(select jsonb_agg(jsonb_build_object('kind', kind, 'namespace', 'fixture-sandboxes',
				'name', 'sandbox-' || ${allocation.sandbox_id}, 'uid', ${allocation.sandbox_id} || '-' || kind,
				'resourceVersion', '1'))
			 from unnest(array['Pod','Service','ServiceAccount','PersistentVolumeClaim','NetworkPolicy','Secret']) as kind))
		where conversation_id='conversation-1'`;
	await client`update platform.conversations set host_session_ref='native-runtime-target-host'
		where id='conversation-1'`;
	await client`update platform.conversation_executions
		set runtime_submit_protocol='v4', original_operation_digest=${"a".repeat(43)},
			execution_source='web', relay_key_purpose='personal', relay_key_subject_id='actor-1',
			relay_key_id=${relayKeyId}, relay_key_version=1,
			original_submit_host_session_ref='native-runtime-target-host'
		where execution_id='execution-conversation-1'`;
	return { allocation, policy, deployment };
}

describe("API Conversation principal binding", () => {
	const apiScope = (kind: "user" | "application", channelId = "api") => ({
		actorId: "shared-principal",
		channelId,
		principal: { kind, id: "shared-principal" },
	});

	it.each(["user", "application"] as const)(
		"isolates %s from the other principal kind with the same ID and channel",
		async (kind) => {
			const allowed = apiScope(kind);
			const denied = apiScope(kind === "user" ? "application" : "user");
			const conversationId = `typed-${kind}-1`;
			const executionId = `execution-${conversationId}`;
			expect(await query.get(allowed, conversationId)).toMatchObject({
				messages: [{ text: `${kind}-1` }],
				executions: [{ executionId }],
			});
			expect(
				await query.getExecution(allowed, conversationId, executionId),
			).toBeDefined();
			expect(
				await query.replay(allowed, conversationId, undefined),
			).toMatchObject({
				outcome: "events",
				events: [{ executionId }],
			});
			await expect(
				query.getAuthorizationTarget(denied, conversationId),
			).resolves.toBeUndefined();
			await expect(query.get(denied, conversationId)).resolves.toBeUndefined();
			await expect(
				query.getExecution(denied, conversationId, executionId),
			).resolves.toBeUndefined();
			await expect(
				query.replay(denied, conversationId, undefined),
			).resolves.toBeUndefined();
			await expect(
				query.getExecution(
					allowed,
					conversationId,
					"execution-typed-legacy-user",
				),
			).resolves.toBeUndefined();
			const page = await query.list(allowed, "agent-typed", { limit: 1 });
			expect(page.items[0]?.conversationId).toBe(conversationId);
			expect(page.nextCursor).not.toBeNull();
			await expect(
				query.list(denied, "agent-typed", {
					limit: 1,
					cursor: page.nextCursor ?? "",
				}),
			).rejects.toMatchObject({ code: "invalid_request" });
			const next = await query.list(allowed, "agent-typed", {
				limit: 1,
				cursor: page.nextCursor ?? "",
			});
			expect(next.items.map((item) => item.conversationId)).toEqual([
				`typed-${kind}-2`,
			]);
		},
	);

	it.each(["user", "application"] as const)(
		"preserves the typed legacy API channel for %s",
		async (kind) => {
			const current = apiScope(kind, `api:${kind}`);
			const id = `typed-legacy-${kind}`;
			expect(await query.get(current, id)).toBeDefined();
			expect(
				(await query.list(current, "agent-typed", { limit: 10 })).items.map(
					(item) => item.conversationId,
				),
			).toEqual([id]);
			await expect(query.get(apiScope(kind), id)).resolves.toBeUndefined();
		},
	);

	it.each(["user", "application"] as const)(
		"paginates a maximum-length opaque %s ID without changing its scope limit",
		async (kind) => {
			const actorId = "\\".repeat(1024);
			const current = {
				...apiScope(kind),
				actorId,
				principal: { kind, id: actorId },
			};
			const ids = [`opaque-${kind}-1`, `opaque-${kind}-2`];
			for (const id of ids)
				await client`insert into platform.conversations
					(id,agent_id,actor_id,channel_id,principal_type,status,session_generation,authorization_revision)
					values (${id},'agent-typed',${actorId},'api',${kind},'ready',1,'authorization-typed')`;
			for (const id of ids) await seedSessionSandboxFixture(client, id);
			const first = await query.list(current, "agent-typed", { limit: 1 });
			expect(first.items.map((item) => item.conversationId)).toEqual([ids[0]]);
			if (!first.nextCursor) throw new Error("Expected a typed list cursor");
			const second = await query.list(current, "agent-typed", {
				limit: 1,
				cursor: first.nextCursor,
			});
			expect(second.items.map((item) => item.conversationId)).toEqual([ids[1]]);
			await expect(
				query.list(
					{
						...current,
						actorId: `${actorId}x`,
						principal: { kind, id: `${actorId}x` },
					},
					"agent-typed",
					{ limit: 1 },
				),
			).rejects.toMatchObject({ code: "invalid_request" });
		},
	);

	it("rejects missing, mismatched and untrusted API principal metadata", async () => {
		let getterCalls = 0;
		const getter = {
			actorId: "shared-principal",
			channelId: "api",
			get principal() {
				getterCalls += 1;
				throw new Error("getter must not run");
			},
		};
		for (const invalid of [
			{ actorId: "shared-principal", channelId: "api" },
			{ actorId: "shared-principal", channelId: "api:user" },
			{ actorId: "shared-principal", channelId: "api:application" },
			apiScope("user", "api:application"),
			apiScope("application", "api:user"),
			apiScope("application", "web"),
			apiScope("user", "api:unknown"),
			{ ...apiScope("application"), actorId: "other-id" },
			{
				...apiScope("application"),
				principal: { kind: "owner", id: "shared-principal" },
			},
			getter,
			new Proxy(apiScope("application"), {}),
		]) {
			await expect(
				query.get(invalid as ConversationQueryScopeV1, "typed-application-1"),
			).rejects.toBeInstanceOf(ConversationQueryError);
		}
		expect(getterCalls).toBe(0);
	});

	it("replays only target E across same-C gaps and rejects another E's event/cursor", async () => {
		const conversationId = "typed-gaps";
		await client`insert into platform.conversations
			(id,agent_id,actor_id,channel_id,principal_type,status,session_generation,authorization_revision,last_conversation_cursor)
			values (${conversationId},'agent-typed','shared-principal','api','application','ready',1,'authorization-typed',6)`;
		for (const executionId of ["gaps-own", "gaps-other"]) {
			await client`insert into platform.conversation_executions
				(execution_id,conversation_id,agent_id,actor_id,channel_id,principal_type,turn_id,status,session_generation,authorization_revision,created_at)
				values (${executionId},${conversationId},'agent-typed','shared-principal','api','application',${`turn-${executionId}`},'completed',1,'authorization-typed',now())`;
		}
		for (const [cursor, executionId, sequence] of [
			[1, "gaps-own", 1],
			[2, "gaps-other", 1],
			[3, "gaps-other", 2],
			[4, "gaps-other", 3],
			[5, "gaps-own", 2],
			[6, "gaps-other", 4],
		] as const) {
			await client`insert into platform.conversation_events
				(event_id,conversation_id,execution_id,adapter_event_key,sequence,conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,occurred_at,source)
				values (${`gap-event-${cursor}`},${conversationId},${executionId},${`gap-${cursor}`},${sequence},${cursor},'text.delta',${client.json({ type: "text.delta", text: executionId })},${"c".repeat(64)},${`gap-runtime-${cursor}`},now(),'runtime')`;
		}
		await client`update platform.conversation_events set persisted_at=now()-interval '1 hour' where execution_id='gaps-other'`;
		await seedSessionSandboxFixture(client, conversationId);
		const replay = await query.replayExecution(
			apiScope("application"),
			conversationId,
			"gaps-own",
			undefined,
		);
		expect(replay).toMatchObject({
			outcome: "events",
			events: [{ eventId: "gap-event-1" }, { eventId: "gap-event-5" }],
		});
		if (replay?.outcome !== "events")
			throw new Error("Expected target E replay");
		await expect(
			query.replayExecution(
				apiScope("application"),
				conversationId,
				"gaps-own",
				{ kind: "last-event-id", value: "gap-event-1" },
			),
		).resolves.toMatchObject({
			outcome: "events",
			events: [{ eventId: "gap-event-5" }],
		});
		await expect(
			query.replayExecution(
				apiScope("application"),
				conversationId,
				"gaps-own",
				{ kind: "cursor", value: replay.resumeCursor },
			),
		).resolves.toMatchObject({ outcome: "events", events: [] });
		await expect(
			query.replayExecution(
				apiScope("application"),
				conversationId,
				"gaps-own",
				{ kind: "last-event-id", value: "gap-event-6" },
			),
		).resolves.toMatchObject({ outcome: "reload", reason: "unknown_event_id" });
		await expect(
			query.replayExecution(
				apiScope("application"),
				conversationId,
				"gaps-other",
				{ kind: "cursor", value: replay.resumeCursor },
			),
		).resolves.toMatchObject({ outcome: "reload", reason: "cursor_expired" });
	});

	it("rejects persisted C/E principal mismatches and invalid application channels", async () => {
		for (const channel of ["web", "api:user"]) {
			await expect(client`
				insert into platform.conversations
					(id, agent_id, actor_id, channel_id, principal_type, status, session_generation, authorization_revision, created_at)
				values (${`invalid-${channel}`}, 'agent-typed', 'shared-principal', ${channel}, 'application', 'ready', 1, 'authorization-typed', now())
			`).rejects.toMatchObject({ code: "23514" });
		}
		await expect(client`
			insert into platform.conversation_executions
				(execution_id, conversation_id, agent_id, actor_id, channel_id, principal_type, turn_id, status, session_generation, authorization_revision, created_at)
			values ('invalid-kind', 'typed-application-1', 'agent-typed', 'shared-principal', 'api', 'user', 'turn-invalid', 'completed', 1, 'authorization-typed', now())
		`).rejects.toMatchObject({ code: "23503" });
	});
});

describe("PostgreSQL Conversation query", () => {
	it("projects each Sandbox readiness without hiding authorized history or changing another Session", async () => {
		const before = await query.get(actorOne, "conversation-1");
		expect(before?.conversation.sandboxReady).toBe(true);
		try {
			for (const status of [
				"allocated",
				"applying",
				"observed",
				"unknown",
				"stopped",
				"unavailable",
			]) {
				await client`update platform.session_sandbox_allocations set status = ${status} where conversation_id = 'conversation-1'`;
				const detail = await query.get(actorOne, "conversation-1");
				expect(detail?.conversation.sandboxReady).toBe(false);
				expect(detail?.conversation.sandbox).toEqual(
					before?.conversation.sandbox,
				);
				expect(detail?.messages).toEqual(before?.messages);
				expect(detail?.executions).toEqual(before?.executions);
				expect(
					(await query.get(actorOne, "conversation-3"))?.conversation
						.sandboxReady,
				).toBe(true);
				expect(
					await query.replay(actorOne, "conversation-1", undefined),
				).toBeDefined();
			}
		} finally {
			await client`update platform.session_sandbox_allocations set status = 'ready' where conversation_id = 'conversation-1'`;
		}
	});

	it("treats a completed management stop as settled instead of preparing", async () => {
		const [originalAllocation] = await client<
			{ status: string; desired_state: string; resource_observation: unknown }[]
		>`select status, desired_state, resource_observation
			from platform.session_sandbox_allocations where conversation_id = 'conversation-1'`;
		const intentId = "conversation:sandbox:management-stop-query";
		const newerIntentId = "conversation:sandbox:management-stop-query:newer";
		await client`delete from platform.outbox_items where id = ${intentId}`;
		await client`delete from platform.outbox_items where id = ${newerIntentId}`;
		await client`insert into platform.outbox_items
			(id, scope_type, scope_id, operation, payload, trace_id, request_id, status, available_at, created_at, updated_at)
			values (${intentId}, 'conversation', 'conversation-1', 'conversation.sandbox.reconcile.v1',
				${client.json({ schemaVersion: 1, conversationId: "conversation-1", sessionGeneration: 1 })},
				'management-stop-query', 'management-stop-query', 'succeeded', now(), now(), now())`;
		if (!originalAllocation) throw new Error("Expected Sandbox fixture");
		try {
			await client`update platform.session_sandbox_allocations
				set status = 'stopped', desired_state = 'stopped'
				where conversation_id = 'conversation-1'`;
			await client`update platform.outbox_items
				set status = 'succeeded', payload = payload || ${client.json({
					lifecycle: {
						schemaVersion: 1,
						authority: { targetDesiredState: "stopped" },
						stopReceipt: {},
					},
				})}
				where id = ${intentId}`;
			expect(await query.get(actorOne, "conversation-1")).toMatchObject({
				conversation: { sandboxReady: false, sandboxResumable: true },
			});
			await client`insert into platform.outbox_items
				(id, scope_type, scope_id, operation, payload, trace_id, request_id, status, available_at, created_at, updated_at)
				values (${newerIntentId}, 'conversation', 'conversation-1', 'conversation.sandbox.reconcile.v1',
					${client.json({ schemaVersion: 1, conversationId: "conversation-1", sessionGeneration: 1 })},
					'management-stop-query-newer', 'management-stop-query-newer', 'pending', now(), now() + interval '1 second', now() + interval '1 second')`;
			expect(
				(await query.get(actorOne, "conversation-1"))?.conversation,
			).not.toHaveProperty("sandboxResumable");
		} finally {
			await client`update platform.session_sandbox_allocations
				set status = ${originalAllocation.status}, desired_state = ${originalAllocation.desired_state},
					resource_observation = ${client.json(originalAllocation.resource_observation as Parameters<typeof client.json>[0])}
				where conversation_id = 'conversation-1'`;
			await client`delete from platform.outbox_items where id = ${intentId}`;
			await client`delete from platform.outbox_items where id = ${newerIntentId}`;
		}
	});

	it("hides all query paths for a Session with an unbound persisted Execution", async () => {
		const [original] =
			await client`select sandbox_id from platform.conversation_executions
			where execution_id = 'execution-conversation-1'`;
		await client`update platform.conversation_executions set sandbox_id = null
			where execution_id = 'execution-conversation-1'`;
		try {
			await expect(
				query.get(actorOne, "conversation-1"),
			).resolves.toBeUndefined();
			await expect(
				query.getAuthorizationTarget(actorOne, "conversation-1"),
			).resolves.toBeUndefined();
			await expect(
				query.getExecution(
					actorOne,
					"conversation-1",
					"execution-conversation-1",
				),
			).resolves.toBeUndefined();
			await expect(
				query.replay(actorOne, "conversation-1", undefined),
			).resolves.toBeUndefined();
		} finally {
			await client`update platform.conversation_executions set sandbox_id = ${original?.sandbox_id}
				where execution_id = 'execution-conversation-1'`;
		}
	});

	it("hides a stale allocation generation without repairing the allocation", async () => {
		await client`update platform.session_sandbox_allocations set session_generation = 2
			where conversation_id = 'conversation-1'`;
		try {
			await expect(
				query.get(actorOne, "conversation-1"),
			).resolves.toBeUndefined();
			await expect(
				query.replay(actorOne, "conversation-1", undefined),
			).resolves.toBeUndefined();
			expect(
				await client`select session_generation::int as generation
				from platform.session_sandbox_allocations where conversation_id = 'conversation-1'`,
			).toEqual([{ generation: 2 }]);
		} finally {
			await client`update platform.session_sandbox_allocations set session_generation = 1
				where conversation_id = 'conversation-1'`;
		}
	});

	it("binds list, history, and execution detail to actor and channel", async () => {
		const page = await query.list(actorOne, "agent-1", { limit: 1 });
		expect(page.items).toEqual([
			expect.objectContaining({
				conversationId: "conversation-1",
				lastConversationCursor: expect.stringMatching(/^v1\./),
			}),
		]);
		const detail = await query.get(actorOne, "conversation-1");
		expect(detail).toMatchObject({
			messages: [{ messageId: "message-conversation-1" }],
			executions: [
				{
					executionId: "execution-conversation-1",
					sourceMessageId: "message-conversation-1",
					traceId: "trace-1",
				},
			],
		});
		expect(
			await query.getExecution(
				actorOne,
				"conversation-1",
				"execution-conversation-1",
			),
		).toMatchObject({ execution: { status: "completed" } });

		for (const deniedScope of [
			{ actorId: "actor-2", channelId: "web" },
			{ actorId: "actor-1", channelId: "wecom" },
		]) {
			await expect(query.get(deniedScope, "conversation-1")).resolves.toBe(
				undefined,
			);
			await expect(
				query.getExecution(
					deniedScope,
					"conversation-1",
					"execution-conversation-1",
				),
			).resolves.toBe(undefined);
		}
	});

	it("keeps Web, WeCom and API entry Sessions separate for one actor", async () => {
		const entries = [
			{ id: "conversation-entry-web", actorId: "actor-1", channel: "web" },
			{
				id: "conversation-entry-wecom-a",
				actorId: "sender-a",
				channel: wecomChannelIdV1({
					kind: "wecom_bot",
					bindingReference: "binding",
				}),
			},
			{
				id: "conversation-entry-wecom-b",
				actorId: "sender-b",
				channel: wecomChannelIdV1({
					kind: "wecom_bot",
					bindingReference: "binding",
				}),
			},
			{ id: "conversation-entry-api", actorId: "actor-1", channel: "api" },
		] as const;
		try {
			for (const entry of entries) {
				await client`
					insert into platform.conversations
						(id, agent_id, actor_id, channel_id, principal_type, status,
						 session_generation, authorization_revision, created_at, updated_at)
						values (${entry.id}, 'agent-1', ${entry.actorId}, ${entry.channel}, 'user',
						 'active', 1, 'authorization-1', '2026-09-05T00:00:00.000Z',
						 '2026-09-05T00:00:00.000Z')`;
				await seedSessionSandboxFixture(client, entry.id);
				await client`
					insert into platform.conversation_executions
						(execution_id, conversation_id, agent_id, actor_id, channel_id,
						 principal_type, turn_id, status, session_generation,
						 authorization_revision, created_at, updated_at)
						values (${`execution-${entry.id}`}, ${entry.id}, 'agent-1', ${entry.actorId},
						 ${entry.channel}, 'user', ${`turn-${entry.id}`}, 'completed', 1,
						 'authorization-1', now(), now())`;
				await client`update platform.conversation_executions e
					set sandbox_id = s.sandbox_id
					from platform.session_sandbox_allocations s
					where e.conversation_id = ${entry.id} and s.conversation_id = e.conversation_id`;
			}
			const webList = await query.list(actorOne, "agent-1", { limit: 20 });
			const webIds = webList.items.map((item) => item.conversationId);
			expect(webIds).toContain(entries[0].id);
			for (const entry of entries.slice(1))
				expect(webIds).not.toContain(entry.id);
			const debugRows = await client`
				select c.id, c.actor_id, c.channel_id, s.sandbox_id, e.sandbox_id as execution_sandbox_id
				from platform.conversations c
				join platform.session_sandbox_allocations s on s.conversation_id = c.id
				join platform.conversation_executions e on e.conversation_id = c.id
				where c.id = ${entries[0].id}`;
			expect(debugRows).toHaveLength(1);
			const web = await query.get(actorOne, entries[0].id);
			const wecomA = await query.get(
				{ actorId: entries[1].actorId, channelId: entries[1].channel },
				entries[1].id,
			);
			const wecomB = await query.get(
				{ actorId: entries[2].actorId, channelId: entries[2].channel },
				entries[2].id,
			);
			const api = await query.get(
				{
					actorId: "actor-1",
					channelId: "api",
					principal: { kind: "user", id: "actor-1" },
				},
				entries[3].id,
			);
			expect(web?.conversation.conversationId).toBe(entries[0].id);
			expect(wecomA?.conversation.conversationId).toBe(entries[1].id);
			expect(wecomB?.conversation.conversationId).toBe(entries[2].id);
			expect(api?.conversation.conversationId).toBe(entries[3].id);
			const webSandbox = web?.conversation.sandbox;
			const wecomSandbox = wecomA?.conversation.sandbox;
			const secondWecomSandbox = wecomB?.conversation.sandbox;
			const apiSandbox = api?.conversation.sandbox;
			if (!webSandbox || !wecomSandbox || !secondWecomSandbox || !apiSandbox)
				throw new Error("Expected Sandbox bindings");
			expect(webSandbox.sessionId).toBe(entries[0].id);
			expect(wecomSandbox.sessionId).toBe(entries[1].id);
			expect(secondWecomSandbox.sessionId).toBe(entries[2].id);
			expect(apiSandbox.sessionId).toBe(entries[3].id);
			const sandboxIds = [
				webSandbox.sandboxId,
				wecomSandbox.sandboxId,
				secondWecomSandbox.sandboxId,
				apiSandbox.sandboxId,
			];
			expect(new Set(sandboxIds).size).toBe(entries.length);
			expect(wecomSandbox.sandboxId).not.toBe(apiSandbox.sandboxId);
			expect(wecomSandbox.sandboxId).not.toBe(secondWecomSandbox.sandboxId);
			expect(secondWecomSandbox.sandboxId).not.toBe(apiSandbox.sandboxId);
			expect(web?.executions[0]?.executionId).toBe(
				`execution-${entries[0].id}`,
			);
			expect(wecomA?.executions[0]?.executionId).toBe(
				`execution-${entries[1].id}`,
			);
			expect(wecomB?.executions[0]?.executionId).toBe(
				`execution-${entries[2].id}`,
			);
			expect(api?.executions[0]?.executionId).toBe(
				`execution-${entries[3].id}`,
			);
			await expect(
				query.get(
					{ actorId: entries[1].actorId, channelId: entries[1].channel },
					entries[2].id,
				),
			).resolves.toBeUndefined();
			await expect(
				query.get(
					{
						actorId: "actor-1",
						channelId: "api",
						principal: { kind: "user", id: "actor-1" },
					},
					entries[1].id,
				),
			).resolves.toBeUndefined();
			const foreignSandbox = await client<{ sandbox_id: string }[]>`
				select sandbox_id from platform.session_sandbox_allocations
				where conversation_id = ${entries[1].id}`;
			const ownSandbox = await client<{ sandbox_id: string }[]>`
				select sandbox_id from platform.session_sandbox_allocations
				where conversation_id = ${entries[0].id}`;
			if (!foreignSandbox[0]?.sandbox_id || !ownSandbox[0]?.sandbox_id)
				throw new Error("Expected persisted Sandbox identifiers");
			await client`
				update platform.conversation_executions
				set sandbox_id = ${foreignSandbox[0].sandbox_id}
				where execution_id = ${`execution-${entries[0].id}`}`;
			await expect(query.get(actorOne, entries[0].id)).resolves.toBeUndefined();
			await client`
				update platform.conversation_executions
				set sandbox_id = ${ownSandbox[0].sandbox_id}
				where execution_id = ${`execution-${entries[0].id}`}`;
			await client`
				update platform.conversation_executions
				set sandbox_id = '00000000-0000-4000-8000-000000000000'
				where execution_id = ${`execution-${entries[0].id}`}`;
			await expect(query.get(actorOne, entries[0].id)).resolves.toBeUndefined();
			await client`
				update platform.conversation_executions
				set sandbox_id = ${ownSandbox[0].sandbox_id}
				where execution_id = ${`execution-${entries[0].id}`}`;
			await expect(
				query.getExecution(
					actorOne,
					entries[0].id,
					`execution-${entries[1].id}`,
				),
			).resolves.toBeUndefined();
			await expect(
				query.getExecution(
					{ actorId: entries[1].actorId, channelId: entries[1].channel },
					entries[2].id,
					`execution-${entries[2].id}`,
				),
			).resolves.toBeUndefined();
			await expect(
				query.getExecution(actorOne, entries[0].id, "execution-unknown"),
			).resolves.toBeUndefined();
		} finally {
			for (const entry of entries) {
				await client`delete from platform.session_sandbox_allocations where conversation_id = ${entry.id}`;
				await client`delete from platform.conversation_executions where conversation_id = ${entry.id}`;
				await client`delete from platform.conversations where id = ${entry.id}`;
			}
		}
	});

	it("maps Last-Event-ID and bound cursor replay from persisted rows", async () => {
		const byEvent = await query.replay(actorOne, "conversation-1", {
			kind: "last-event-id",
			value: "event-1",
		});
		expect(byEvent).toMatchObject({
			outcome: "events",
			events: [
				{ eventId: "event-2", sequence: 2 },
				{ eventId: "event-3", sequence: 3 },
			],
		});
		if (byEvent?.outcome !== "events") throw new Error("Expected replay");
		const cursor = byEvent.events[0]?.conversationCursor;
		if (!cursor) throw new Error("Expected cursor");
		await expect(
			query.replay(actorOne, "conversation-1", {
				kind: "cursor",
				value: cursor,
			}),
		).resolves.toMatchObject({
			outcome: "events",
			events: [{ eventId: "event-3" }],
		});
	});

	it("returns bounded reload controls without disclosing other conversations", async () => {
		await expect(
			query.replay(actorOne, "conversation-1", undefined),
		).resolves.toMatchObject({
			outcome: "reload",
			reason: "cursor_expired",
		});
		await expect(
			query.replay(actorOne, "conversation-1", {
				kind: "last-event-id",
				value: "event-missing",
			}),
		).resolves.toMatchObject({
			outcome: "reload",
			reason: "unknown_event_id",
		});
		await expect(
			query.replay(actorOne, "conversation-1", {
				kind: "last-event-id",
				value: "event-conversation-2",
			}),
		).resolves.toMatchObject({
			outcome: "reload",
			reason: "unknown_event_id",
		});
	});

	it("rejects malformed or cross-scope cursors before querying another scope", async () => {
		await expect(
			query.replay(actorOne, "conversation-1", {
				kind: "cursor",
				value: "not-a-cursor",
			}),
		).rejects.toBeInstanceOf(ConversationQueryError);
		const replay = await query.replay(actorOne, "conversation-1", {
			kind: "last-event-id",
			value: "event-2",
		});
		if (replay?.outcome !== "events") throw new Error("Expected replay cursor");
		await expect(
			query.replay({ actorId: "actor-2", channelId: "web" }, "conversation-2", {
				kind: "cursor",
				value: replay.resumeCursor,
			}),
		).resolves.toMatchObject({
			outcome: "reload",
			reason: "cross_conversation_cursor",
		});
		const page = await query.list(actorOne, "agent-1", { limit: 1 });
		if (!page.nextCursor) throw new Error("Expected a bound list cursor");
		await expect(
			query.list({ actorId: "actor-2", channelId: "web" }, "agent-1", {
				limit: 1,
				cursor: page.nextCursor,
			}),
		).rejects.toMatchObject({ code: "invalid_request" });
	});

	it("uses persistence time and returns a resumable reload after the time window", async () => {
		await client`
			update platform.conversation_events
			set occurred_at = now() - interval '1 hour'
			where event_id = 'event-3'
		`;
		const timeBounded = new PostgresConversationQueryV1({
			databaseUrl,
			replayWindow: 2,
			replayWindowMs: 60_000,
		});
		try {
			await expect(
				timeBounded.replay(actorOne, "conversation-1", {
					kind: "last-event-id",
					value: "event-2",
				}),
			).resolves.toMatchObject({
				outcome: "events",
				events: [{ eventId: "event-3" }],
			});
			await client`
				update platform.conversation_events
				set persisted_at = now() - interval '1 hour'
				where event_id = 'event-3'
			`;
			const expired = await timeBounded.replay(actorOne, "conversation-1", {
				kind: "last-event-id",
				value: "event-2",
			});
			expect(expired).toMatchObject({
				outcome: "reload",
				reason: "cursor_expired",
			});
			if (expired?.outcome !== "reload") throw new Error("Expected reload");
			await expect(
				timeBounded.replay(actorOne, "conversation-1", {
					kind: "cursor",
					value: expired.resumeCursor,
				}),
			).resolves.toMatchObject({
				outcome: "events",
				events: [],
			});
		} finally {
			await timeBounded.close();
		}
	});
});

describe("PostgreSQL original native metadata scope", () => {
	const read = (
		inputScope: ConversationQueryScopeV1 = actorOne,
		conversationId = "conversation-1",
		executionId = "execution-conversation-1",
	) =>
		query.readNativeMetadataObjectScopeV1({
			scope: inputScope,
			conversationId,
			executionId,
			signal: new AbortController().signal,
		});

	it("projects the terminal Execution's persisted generation and revision", async () => {
		await client`
			update platform.conversations
			set session_generation = 2,
				authorization_revision = 'current-revision',
				host_session_ref = 'current-host'
			where id = 'conversation-1'
		`;
		try {
			expect(await read()).toEqual({
				schemaVersion: 1,
				principal: { kind: "user", id: "actor-1" },
				agentId: "agent-1",
				channelId: "web",
				conversationId: "conversation-1",
				executionId: "execution-conversation-1",
				sessionGeneration: 1,
				authorizationRevision: "authorization-1",
				originalHostScopeRef: null,
			});
		} finally {
			await client`
				update platform.conversations
				set session_generation = 1,
					authorization_revision = 'authorization-1',
					host_session_ref = null
				where id = 'conversation-1'
			`;
		}
	});

	it("returns the requested Execution's original Host scope", async () => {
		const relayKeyId = `native-metadata-test-key-${process.pid}`;
		await client`
			insert into platform.relay_key_subjects
				(purpose, subject_id, last_version, current_version)
			values ('personal', 'actor-1', 1, 1)
			on conflict (purpose, subject_id) do nothing
		`;
		await client`
			insert into platform.relay_key_versions
				(purpose, subject_id, key_version, key_id, ciphertext)
			values ('personal', 'actor-1', 1, ${relayKeyId}, ${client.json({
				purpose: "personal",
				subjectId: "actor-1",
				keyId: relayKeyId,
				keyVersion: 1,
			})})
		`;
		try {
			await client`
				update platform.conversation_executions
				set runtime_submit_protocol = 'v4',
					original_operation_digest = ${"a".repeat(43)},
					original_submit_host_session_ref = 'historical-host',
					execution_source = 'web',
					relay_key_purpose = 'personal',
					relay_key_subject_id = 'actor-1',
					relay_key_id = ${relayKeyId},
					relay_key_version = 1
				where execution_id = 'execution-conversation-1'
			`;
			expect(await read()).toMatchObject({
				originalHostScopeRef: "historical-host",
			});
		} finally {
			await client`
				update platform.conversation_executions
				set runtime_submit_protocol = null,
					original_operation_digest = null,
					original_submit_host_session_ref = null,
					execution_source = null,
					relay_key_purpose = null,
					relay_key_subject_id = null,
					relay_key_id = null,
					relay_key_version = null
				where execution_id = 'execution-conversation-1'
			`;
			await client`
				delete from platform.relay_key_versions
				where purpose = 'personal' and subject_id = 'actor-1' and key_id = ${relayKeyId}
			`;
			await client`
				delete from platform.relay_key_subjects
				where purpose = 'personal' and subject_id = 'actor-1'
			`;
		}
	});

	it.each([
		[
			{ actorId: "actor-2", channelId: "web" },
			"conversation-1",
			"execution-conversation-1",
		],
		[
			{ actorId: "actor-1", channelId: "wecom" },
			"conversation-1",
			"execution-conversation-1",
		],
		[
			{
				actorId: "shared-principal",
				channelId: "api",
				principal: { kind: "application" as const, id: "shared-principal" },
			},
			"typed-application-1",
			"execution-typed-application-1",
		],
		[actorOne, "conversation-1", "execution-conversation-2"],
		[actorOne, "conversation-missing", "execution-conversation-1"],
		[actorOne, "conversation-1", "execution-missing"],
	] as const)(
		"hides missing or cross-object/principal scope %j / %s / %s",
		async (inputScope, conversationId, executionId) => {
			await expect(
				read(inputScope, conversationId, executionId),
			).resolves.toBeUndefined();
		},
	);

	it("reads only the metadata projection and leaves all persisted rows unchanged", async () => {
		const snapshot = async () => {
			const rows = [];
			for (const table of [
				"conversations",
				"conversation_executions",
				"conversation_messages",
				"conversation_events",
				"outbox_items",
				"conversation_audit_events",
			] as const) {
				rows.push([
					table,
					await client.unsafe(
						`select to_jsonb(r)::text as bytes, xmin::text as xmin from platform.${table} r order by 1, 2`,
					),
				]);
			}
			return JSON.stringify(rows);
		};
		const before = await snapshot();
		const role = `native_metadata_query_${process.pid}_${Date.now()}`;
		const roleUrl = new URL(databaseUrl);
		try {
			await client.unsafe(`create role ${role} nologin`);
			await client.unsafe(`grant usage on schema platform to ${role}`);
			await client.unsafe(
				`grant select (id, agent_id, actor_id, channel_id, principal_type) on platform.conversations to ${role}`,
			);
			await client.unsafe(
				`grant select (execution_id, conversation_id, agent_id, actor_id, channel_id, principal_type, session_generation, authorization_revision, original_submit_host_session_ref, accepted_original_host_session_ref) on platform.conversation_executions to ${role}`,
			);
			roleUrl.searchParams.set("options", `-c role=${role}`);
			const limited = new PostgresConversationQueryV1({
				databaseUrl: roleUrl.href,
			});
			const denied = postgres(roleUrl.href, { max: 1 });
			try {
				for (const queryText of [
					"select text from platform.conversation_messages",
					"select event_payload from platform.conversation_events",
					"select payload from platform.outbox_items",
					"select details from platform.conversation_audit_events",
				]) {
					await expect(denied.unsafe(queryText)).rejects.toMatchObject({
						code: "42501",
					});
				}
				expect(
					await limited.readNativeMetadataObjectScopeV1({
						scope: actorOne,
						conversationId: "conversation-1",
						executionId: "execution-conversation-1",
					}),
				).toMatchObject({
					executionId: "execution-conversation-1",
					sessionGeneration: 1,
				});
			} finally {
				await limited.close();
				await denied.end();
			}
		} finally {
			await client.unsafe(`drop owned by ${role}`);
			await client.unsafe(`drop role ${role}`);
		}
		expect(await snapshot()).toBe(before);
	});
});

describe("PostgreSQL current native capability scope", () => {
	const relayKeyId = `native-capability-current-${process.pid}`;
	beforeEach(async () => {
		await client`
			insert into platform.relay_key_subjects
				(purpose, subject_id, last_version, current_version)
			values ('personal', 'actor-1', 1, 1)
			on conflict (purpose, subject_id) do nothing
		`;
		await client`
			insert into platform.relay_key_versions
				(purpose, subject_id, key_version, key_id, ciphertext)
			values ('personal', 'actor-1', 1, ${relayKeyId}, ${client.json({
				purpose: "personal",
				subjectId: "actor-1",
				keyId: relayKeyId,
				keyVersion: 1,
			})})
			on conflict (purpose, subject_id, key_version) do nothing
		`;
		await client`
			update platform.conversation_executions
			set runtime_submit_protocol = 'v4',
				original_operation_digest = ${"a".repeat(43)},
				execution_source = 'web',
				relay_key_purpose = 'personal',
				relay_key_subject_id = 'actor-1',
				relay_key_id = ${relayKeyId},
				relay_key_version = 1,
				original_submit_host_session_ref = 'native-current-host',
				status = 'completed',
				session_generation = 1,
				authorization_revision = 'authorization-1'
			where execution_id = 'execution-conversation-1'
		`;
	});
	afterEach(async () => {
		await client`
			update platform.conversations
			set status = 'active', session_generation = 1,
				authorization_revision = 'authorization-1', host_session_ref = null
			where id = 'conversation-1'
		`;
		await client`
			update platform.conversation_executions
			set runtime_submit_protocol = null,
				original_operation_digest = null,
				execution_source = null,
				relay_key_purpose = null,
				relay_key_subject_id = null,
				relay_key_id = null,
				relay_key_version = null,
				original_submit_host_session_ref = null,
				session_generation = 1,
				authorization_revision = 'authorization-1',
				status = 'completed'
			where execution_id = 'execution-conversation-1'
		`;
		await client`
			delete from platform.relay_key_versions
			where purpose = 'personal' and subject_id = 'actor-1' and key_id = ${relayKeyId}
		`;
	});
	it("returns only an Execution bound to the current generation, revision and Host", async () => {
		await client`
			update platform.conversations
			set status = 'ready',
				host_session_ref = 'native-current-host'
			where id = 'conversation-1'
		`;
		try {
			expect(
				await query.readNativeCapabilityCurrentScopeV1({
					scope: actorOne,
					agentId: "agent-1",
					conversationId: "conversation-1",
				}),
			).toEqual({
				agentId: "agent-1",
				actorId: "actor-1",
				channelId: "web",
				conversationId: "conversation-1",
				executionId: "execution-conversation-1",
				sessionGeneration: 1,
				authorizationRevision: "authorization-1",
				currentHostScopeRef: "native-current-host",
			});
		} finally {
			await client`
				update platform.conversations
				set status = 'active', host_session_ref = null
				where id = 'conversation-1'
			`;
		}
	});

	it("selects the latest matching Execution when history shares the same Host", async () => {
		await client`
			update platform.conversations
			set status = 'ready', host_session_ref = 'native-current-host'
			where id = 'conversation-1'
		`;
		await client`
			insert into platform.conversation_executions
				(execution_id, conversation_id, agent_id, actor_id, channel_id,
				 turn_id, status, session_generation, delivery_fence,
				 authorization_revision, execution_source, relay_key_purpose,
				 relay_key_subject_id, relay_key_id, relay_key_version,
				 runtime_submit_protocol, original_operation_digest,
				 original_submit_host_session_ref, principal_type, created_at, updated_at)
			values
				('execution-conversation-1-latest', 'conversation-1', 'agent-1', 'actor-1',
				 'web', 'turn-conversation-1-latest', 'completed', 1, 1,
				 'authorization-1', 'web', 'personal', 'actor-1', ${relayKeyId}, 1,
				 'v4', ${"b".repeat(43)}, 'native-current-host', 'user',
				 '2026-09-06T00:00:05.000Z', '2026-09-06T00:00:05.000Z')
		`;
		try {
			expect(
				await query.readNativeCapabilityCurrentScopeV1({
					scope: actorOne,
					agentId: "agent-1",
					conversationId: "conversation-1",
				}),
			).toMatchObject({
				executionId: "execution-conversation-1-latest",
				currentHostScopeRef: "native-current-host",
			});
		} finally {
			await client`
				delete from platform.conversation_executions
				where execution_id = 'execution-conversation-1-latest'
			`;
		}
	});

	it.each([
		["cross actor", { actorId: "actor-2", channelId: "web" }],
		["cross channel", { actorId: "actor-1", channelId: "wecom" }],
	] as const)("fails closed for %s", async (_label, scope) => {
		await client`
			update platform.conversations
			set host_session_ref = 'native-current-host'
			where id = 'conversation-1'
		`;
		try {
			expect(
				await query.readNativeCapabilityCurrentScopeV1({
					scope,
					agentId: "agent-1",
					conversationId: "conversation-1",
				}),
			).toBeUndefined();
		} finally {
			await client`
				update platform.conversations
				set host_session_ref = null
				where id = 'conversation-1'
			`;
		}
	});

	it("fails closed when generation or Host drifts", async () => {
		await client`
			update platform.conversations
			set host_session_ref = 'native-current-host', session_generation = 2
			where id = 'conversation-1'
		`;
		try {
			expect(
				await query.readNativeCapabilityCurrentScopeV1({
					scope: actorOne,
					agentId: "agent-1",
					conversationId: "conversation-1",
				}),
			).toBeUndefined();
		} finally {
			await client`
				update platform.conversations
				set session_generation = 1, host_session_ref = null
				where id = 'conversation-1'
			`;
		}
	});
});

describe("PostgreSQL native metadata callback credential scope", () => {
	const read = () =>
		query.readNativeMetadataCallbackCredentialScopeV1({
			scope: actorOne,
			agentId: "agent-1",
			conversationId: "conversation-1",
			executionId: "execution-conversation-1",
			signal: new AbortController().signal,
		});

	it("returns the ready execution Sandbox and its policy namespace", async () => {
		const [original] = await client<
			{ resource_policy: Record<string, unknown> | null }[]
		>`select resource_policy from platform.session_sandbox_allocations
			where conversation_id='conversation-1'`;
		await client`
			update platform.session_sandbox_allocations
			set resource_policy=jsonb_set(coalesce(resource_policy, '{}'::jsonb), '{namespace}', '"fixture-sandboxes"')
			where conversation_id='conversation-1'`;
		const [allocation] = await client<
			{ sandbox_id: string; namespace: string | null }[]
		>`select sandbox_id, resource_policy->>'namespace' as namespace
			from platform.session_sandbox_allocations where conversation_id='conversation-1'`;
		try {
			if (!allocation?.sandbox_id || !allocation.namespace)
				throw new Error("Expected ready Sandbox fixture");
			await expect(read()).resolves.toEqual({
				sandboxId: allocation.sandbox_id,
				namespace: allocation.namespace,
				originalHostScopeRef: null,
			});
		} finally {
			await client`
				update platform.session_sandbox_allocations set resource_policy=${
					original?.resource_policy
						? client.json(
								original.resource_policy as Parameters<typeof client.json>[0],
							)
						: null
				}
				where conversation_id='conversation-1'`;
		}
	});

	it("rejects a callback request for a foreign Agent", async () => {
		await expect(
			query.readNativeMetadataCallbackCredentialScopeV1({
				scope: actorOne,
				agentId: "agent-foreign",
				conversationId: "conversation-1",
				executionId: "execution-conversation-1",
				signal: new AbortController().signal,
			}),
		).resolves.toBeUndefined();
	});

	it("returns an explicit deployment scope for an unbound Agent execution", async () => {
		const [original] = await client<{ sandbox_id: string | null }[]>`
			select sandbox_id from platform.conversation_executions
			where execution_id='execution-conversation-1'`;
		if (original === undefined) throw new Error("Missing execution fixture");
		await client`
			update platform.conversation_executions set sandbox_id=null
			where execution_id='execution-conversation-1'`;
		try {
			await expect(read()).resolves.toEqual({
				sandboxId: null,
				namespace: null,
				originalHostScopeRef: null,
			});
		} finally {
			await client`
				update platform.conversation_executions set sandbox_id=${original.sandbox_id}
				where execution_id='execution-conversation-1'`;
		}
	});

	it("rejects a Sandbox allocation that is no longer ready", async () => {
		await client`
			update platform.session_sandbox_allocations set status='stopped'
			where conversation_id='conversation-1'`;
		try {
			await expect(read()).resolves.toBeUndefined();
		} finally {
			await client`
				update platform.session_sandbox_allocations set status='ready'
				where conversation_id='conversation-1'`;
		}
	});
});

describe("PostgreSQL native metadata current Runtime target scope", () => {
	const request = {
		scope: actorOne,
		agentId: "agent-1",
		conversationId: "conversation-1",
		executionId: "execution-conversation-1",
		sandboxPolicy: {
			namespace: "fixture-sandboxes",
			resourceConfigurationHash:
				workloadResourceConfigurationHashV1(workloadTestPolicy),
		},
		signal: new AbortController().signal,
	};

	it.each(["submitted-host", "accepted-first-host"] as const)(
		"returns the verified Agent-level current route using %s",
		async (bindingKind) => {
			const [sandbox] = await client<{ sandbox_id: string | null }[]>`
			select sandbox_id from platform.conversation_executions
			where execution_id='execution-conversation-1'`;
			if (!sandbox?.sandbox_id) throw new Error("Missing execution Sandbox");
			await seedCurrentRuntimeTargetFixture();
			if (bindingKind === "accepted-first-host") {
				await client`update platform.conversation_executions
				set original_submit_host_session_ref=null,
					accepted_original_host_session_ref='native-runtime-target-host'
				where execution_id='execution-conversation-1'`;
			}
			await client`update platform.conversation_executions set sandbox_id=null
			where execution_id='execution-conversation-1'`;
			try {
				await expect(
					query.readNativeMetadataObjectScopeV1({
						scope: actorOne,
						conversationId: request.conversationId,
						executionId: request.executionId,
					}),
				).resolves.toMatchObject({
					originalHostScopeRef: "native-runtime-target-host",
				});
				await expect(
					query.readNativeMetadataCallbackCredentialScopeV1(request),
				).resolves.toMatchObject({
					originalHostScopeRef: "native-runtime-target-host",
				});
				await expect(
					query.readNativeMetadataRuntimeTargetScopeV1(request),
				).resolves.toMatchObject({
					agentId: "agent-1",
					conversationId: "conversation-1",
					executionId: "execution-conversation-1",
					originalHostScopeRef: "native-runtime-target-host",
					sandboxResource: null,
					workloadState: { phase: "ready", agentId: "agent-1" },
				});
			} finally {
				await client`update platform.conversation_executions set accepted_original_host_session_ref=null where execution_id='execution-conversation-1'`;
				await client`update platform.conversation_executions set sandbox_id=${sandbox.sandbox_id}
				where execution_id='execution-conversation-1'`;
				await client`update platform.session_sandbox_allocations
				set resource_policy=null, resource_observation=null, status='allocated',
					desired_state='running', resource_fence=0 where conversation_id='conversation-1'`;
				await client`update platform.conversations set host_session_ref=null
				where id='conversation-1'`;
				await client`update platform.conversation_executions
				set runtime_submit_protocol=null, original_operation_digest=null,
					execution_source=null, relay_key_purpose=null, relay_key_subject_id=null,
					relay_key_id=null, relay_key_version=null, original_submit_host_session_ref=null
				where execution_id='execution-conversation-1'`;
			}
		},
	);

	it("returns the complete ready Session Sandbox receipt", async () => {
		await seedCurrentRuntimeTargetFixture();
		try {
			const result =
				await query.readNativeMetadataRuntimeTargetScopeV1(request);
			expect(result).toMatchObject({
				originalHostScopeRef: "native-runtime-target-host",
				workloadState: { phase: "ready", agentId: "agent-1" },
				sandboxResource: {
					status: "ready",
					desiredState: "running",
					policy: { namespace: "fixture-sandboxes" },
					observation: { status: "ready" },
				},
			});
			const service = result?.sandboxResource?.observation?.resources.find(
				(resource) => resource.kind === "Service",
			);
			expect(service?.name).toBe(result?.sandboxResource?.sandbox.resourceName);
		} finally {
			await client`update platform.session_sandbox_allocations
				set resource_policy=null, resource_observation=null, status='allocated',
					desired_state='running', resource_fence=0 where conversation_id='conversation-1'`;
			await client`update platform.conversations set host_session_ref=null
				where id='conversation-1'`;
			await client`update platform.conversation_executions
				set runtime_submit_protocol=null, original_operation_digest=null,
					execution_source=null, relay_key_purpose=null, relay_key_subject_id=null,
					relay_key_id=null, relay_key_version=null, original_submit_host_session_ref=null
				where execution_id='execution-conversation-1'`;
		}
	});

	it.each([
		["cross actor", { scope: { actorId: "actor-2", channelId: "web" } }],
		["cross conversation", { conversationId: "conversation-2" }],
	] as const)("fails closed for %s", async (_label, change) => {
		await seedCurrentRuntimeTargetFixture();
		try {
			await expect(
				query.readNativeMetadataRuntimeTargetScopeV1({
					...request,
					...change,
				}),
			).resolves.toBeUndefined();
		} finally {
			await client`update platform.session_sandbox_allocations
				set resource_policy=null, resource_observation=null, status='allocated',
					desired_state='running', resource_fence=0 where conversation_id='conversation-1'`;
			await client`update platform.conversations set host_session_ref=null
				where id='conversation-1'`;
			await client`update platform.conversation_executions
				set runtime_submit_protocol=null, original_operation_digest=null,
					execution_source=null, relay_key_purpose=null, relay_key_subject_id=null,
					relay_key_id=null, relay_key_version=null, original_submit_host_session_ref=null
				where execution_id='execution-conversation-1'`;
		}
	});

	it("fails closed when the persisted Sandbox is stopped or not ready", async () => {
		await seedCurrentRuntimeTargetFixture();
		try {
			await client`update platform.session_sandbox_allocations
				set status='stopped' where conversation_id='conversation-1'`;
			await expect(
				query.readNativeMetadataRuntimeTargetScopeV1(request),
			).resolves.toBeUndefined();
		} finally {
			await client`update platform.session_sandbox_allocations
				set resource_policy=null, resource_observation=null, status='allocated',
					desired_state='running', resource_fence=0 where conversation_id='conversation-1'`;
			await client`update platform.conversations set host_session_ref=null
				where id='conversation-1'`;
			await client`update platform.conversation_executions
				set runtime_submit_protocol=null, original_operation_digest=null,
					execution_source=null, relay_key_purpose=null, relay_key_subject_id=null,
					relay_key_id=null, relay_key_version=null, original_submit_host_session_ref=null
				where execution_id='execution-conversation-1'`;
		}
	});
});

describe("PostgreSQL current model-directory dispatch scope", () => {
	it("binds the active Web execution to its Conversation session and fence", async () => {
		await client`
			update platform.conversations
			set host_session_ref = 'current-model-host'
			where id = 'conversation-1'
		`;
		await client`
			update platform.conversation_executions
			set status = 'processing', delivery_fence = 9, updated_at = now()
			where execution_id = 'execution-conversation-1'
		`;
		try {
			expect(
				await query.readRuntimeModelDirectoryDispatchRequestV1({
					scope: actorOne,
					conversationId: "conversation-1",
				}),
			).toMatchObject({
				actorId: "actor-1",
				channelId: "web",
				agentId: "agent-1",
				conversationId: "conversation-1",
				executionId: "execution-conversation-1",
				turnId: "turn-conversation-1",
				sessionGeneration: 1,
				deliveryFence: 9,
				hostSessionRef: "current-model-host",
			});
		} finally {
			await client`
				update platform.conversations
				set host_session_ref = null
				where id = 'conversation-1'
			`;
			await client`
				update platform.conversation_executions
				set status = 'completed', delivery_fence = 1
				where execution_id = 'execution-conversation-1'
			`;
		}
	});

	it("fails closed for another actor and for a completed execution", async () => {
		await client`
			update platform.conversations
			set host_session_ref = 'current-model-host'
			where id = 'conversation-1'
		`;
		await client`
			update platform.conversation_executions
			set status = 'processing', delivery_fence = 9
			where execution_id = 'execution-conversation-1'
		`;
		try {
			await expect(
				query.readRuntimeModelDirectoryDispatchRequestV1({
					scope: { actorId: "actor-2", channelId: "web" },
					conversationId: "conversation-1",
				}),
			).resolves.toBeUndefined();
			await client`
				update platform.conversation_executions
				set status = 'completed'
				where execution_id = 'execution-conversation-1'
			`;
			await expect(
				query.readRuntimeModelDirectoryDispatchRequestV1({
					scope: actorOne,
					conversationId: "conversation-1",
				}),
			).resolves.toBeUndefined();
		} finally {
			await client`
				update platform.conversations
				set host_session_ref = null
				where id = 'conversation-1'
			`;
			await client`
				update platform.conversation_executions
				set status = 'completed', delivery_fence = 1
				where execution_id = 'execution-conversation-1'
			`;
		}
	});
});

it("preserves unallocated history and replay without treating missing or corrupt bindings as readiness", async () => {
	const scope = { actorId: "legacy-user", channelId: "web" };
	await client`insert into platform.conversations
   (id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision,last_conversation_cursor)
   values ('legacy-history','legacy-agent','legacy-user','web','active',1,'legacy-auth',1)`;
	await client`insert into platform.conversation_executions
   (execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,authorization_revision,created_at)
   values ('legacy-execution','legacy-history','legacy-agent','legacy-user','web','legacy-turn','unknown',1,'legacy-auth',now())`;
	await client`insert into platform.conversation_events
   (event_id,conversation_id,execution_id,adapter_event_key,sequence,conversation_cursor,event_type,event_payload,event_digest,occurred_at,source,runtime_cursor)
   values ('legacy-event','legacy-history','legacy-execution','legacy-adapter',1,1,'text.delta',${client.json({ type: "text.delta", text: "historical output" })},${"a".repeat(64)},now(),'runtime','legacy-runtime-cursor')`;
	const detail = await query.get(scope, "legacy-history");
	expect(detail).toMatchObject({
		conversation: {
			conversationId: "legacy-history",
			status: "active",
			sandboxReady: false,
		},
		executions: [{ executionId: "legacy-execution", status: "unknown" }],
		events: [{ eventId: "legacy-event" }],
	});
	expect(detail?.conversation.sandbox).toBeUndefined();
	expect(
		(await query.list(scope, "legacy-agent", { limit: 10 })).items,
	).toHaveLength(1);
	expect(await query.getAuthorizationTarget(scope, "legacy-history")).toEqual({
		agentId: "legacy-agent",
	});
	expect(
		await query.getExecution(scope, "legacy-history", "legacy-execution"),
	).toMatchObject({
		execution: { executionId: "legacy-execution" },
		events: [{ eventId: "legacy-event" }],
	});
	expect(await query.replay(scope, "legacy-history", undefined)).toMatchObject({
		outcome: "events",
		events: [{ eventId: "legacy-event" }],
	});
	for (const denied of [
		{ actorId: "other-user", channelId: "web" },
		{ actorId: "legacy-user", channelId: "wecom" },
	]) {
		expect(await query.get(denied, "legacy-history")).toBeUndefined();
		expect(
			await query.getAuthorizationTarget(denied, "legacy-history"),
		).toBeUndefined();
		expect(
			await query.getExecution(denied, "legacy-history", "legacy-execution"),
		).toBeUndefined();
		expect(
			await query.replay(denied, "legacy-history", undefined),
		).toBeUndefined();
	}
	expect((await query.list(scope, "other-agent", { limit: 10 })).items).toEqual(
		[],
	);
	expect(
		await client`select count(*)::int as count from platform.session_sandbox_allocations where conversation_id='legacy-history'`,
	).toEqual([{ count: 0 }]);
	await client`update platform.conversation_executions set sandbox_id='11111111-1111-1111-1111-111111111111' where execution_id='legacy-execution'`;
	expect(await query.get(scope, "legacy-history")).toBeUndefined();
	expect(
		await query.getExecution(scope, "legacy-history", "legacy-execution"),
	).toBeUndefined();
	expect(
		await query.replay(scope, "legacy-history", undefined),
	).toBeUndefined();
	expect(
		(await query.list(scope, "legacy-agent", { limit: 10 })).items,
	).toEqual([]);
});

it("does not treat a newly allocated empty Session with a missing allocation as historical", async () => {
	const scope = { actorId: "new-user", channelId: "web" };
	await client`insert into platform.conversations
		(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision)
		values ('lost-allocation','new-agent','new-user','web','ready',1,'auth')`;
	await client`insert into platform.conversation_audit_events
		(id,conversation_id,agent_id,actor_id,action,trace_id,request_id,occurred_at,details)
		values ('allocation-fact','lost-allocation','new-agent','new-user','conversation.sandbox.allocated','trace','request',now(),'{}')`;
	expect(await query.get(scope, "lost-allocation")).toBeUndefined();
	expect(
		await query.getAuthorizationTarget(scope, "lost-allocation"),
	).toBeUndefined();
	expect(
		await query.replay(scope, "lost-allocation", undefined),
	).toBeUndefined();
	expect((await query.list(scope, "new-agent", { limit: 10 })).items).toEqual(
		[],
	);
	expect(
		await client`select sandbox_id from platform.session_sandbox_allocations where conversation_id='lost-allocation'`,
	).toEqual([]);
});

describe("long Conversation reads (#1732)", () => {
	const longScope = { actorId: "long-actor", channelId: "web" };
	const eventsPerExecution = 150;

	beforeAll(async () => {
		await client`insert into platform.conversations
			(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision,last_conversation_cursor)
			values ('long-history','long-agent','long-actor','web','ready',1,'auth-long',${2 * eventsPerExecution})`;
		let cursor = 0;
		for (const [index, executionId] of ["long-1", "long-2"].entries()) {
			await client`insert into platform.conversation_executions
				(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,authorization_revision,created_at)
				values (${executionId},'long-history','long-agent','long-actor','web',${`turn-${executionId}`},'completed',1,'auth-long',${`2026-09-06T00:0${index}:00.000Z`})`;
			// The first audit record names the trace; later ones must not win.
			for (const [offset, trace] of [
				[1, `trace-${executionId}`],
				[2, `later-${executionId}`],
			] as const)
				await client`insert into platform.conversation_audit_events
					(id,conversation_id,execution_id,agent_id,actor_id,action,trace_id,request_id,occurred_at)
					values (${`audit-${executionId}-${offset}`},'long-history',${executionId},'long-agent','long-actor',
						'conversation.message.accepted',${trace},'request-long',${`2026-09-06T00:0${index}:0${offset}.000Z`})`;
			for (let sequence = 1; sequence <= eventsPerExecution; sequence++) {
				cursor++;
				await client`insert into platform.conversation_events
					(event_id,conversation_id,execution_id,adapter_event_key,sequence,conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,occurred_at,source)
					values (${`long-event-${cursor}`},'long-history',${executionId},${`long-${cursor}`},${sequence},${cursor},'text.delta',
						${client.json({ type: "text.delta", text: `part-${cursor}` })},${"d".repeat(64)},${`long-runtime-${cursor}`},now(),'runtime')`;
			}
		}
		await seedSessionSandboxFixture(client, "long-history");
		// 扫描计数读的是库级统计。刚在 1 秒内刷新过统计的后端，会把后续统计延迟到
		// 空闲 10 秒（PGSTAT_IDLE_INTERVAL）后才写入；前面用例遗留的连接池若在计数
		// 窗口内补记扫描，会让断言偶发超限。先等过这个间隔再开始计数。
		await new Promise((resolve) => setTimeout(resolve, 11_000));
	}, 60_000);

	async function auditScans() {
		const [row] = await client<{ scans: string }[]>`
			select (coalesce(seq_scan, 0) + coalesce(idx_scan, 0))::text as scans
			from pg_stat_user_tables
			where schemaname = 'platform' and relname = 'conversation_audit_events'`;
		return Number(row?.scans);
	}

	/** Audit table scans made by one read on its own connections. */
	async function auditScansDuring<T>(
		read: (reader: PostgresConversationQueryV1) => Promise<T>,
	) {
		const reader = new PostgresConversationQueryV1({
			databaseUrl,
			replayWindow: 100,
		});
		const before = await auditScans();
		let result: T;
		try {
			result = await read(reader);
		} finally {
			// A backend flushes its table statistics when it exits.
			await reader.close();
		}
		let scans = before;
		for (let attempt = 0; attempt < 50 && scans === before; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			scans = await auditScans();
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
		return { result, scans: (await auditScans()) - before };
	}

	it("looks up each Execution's trace once instead of once per event", async () => {
		const { result: detail, scans } = await auditScansDuring((reader) =>
			reader.get(longScope, "long-history"),
		);
		expect(detail?.events).toHaveLength(2 * eventsPerExecution);
		expect(
			new Set(
				detail?.events.map((event) => `${event.executionId}:${event.traceId}`),
			),
		).toEqual(new Set(["long-1:trace-long-1", "long-2:trace-long-2"]));
		expect(detail?.executions.map((item) => item.traceId)).toEqual([
			"trace-long-1",
			"trace-long-2",
		]);
		// Two Executions are looked up by the event and the execution reads;
		// a per-event lookup would scan the audit table 300 times.
		expect(scans).toBeGreaterThan(0);
		expect(scans).toBeLessThanOrEqual(8);
	});

	it("bounds detail reads at complete Execution boundaries and pages earlier history", async () => {
		const reader = new PostgresConversationQueryV1({
			databaseUrl,
			eventWindow: 100,
		});
		try {
			const recent = await reader.get(longScope, "long-history");
			expect(recent?.events).toHaveLength(eventsPerExecution);
			expect(new Set(recent?.events.map((item) => item.executionId))).toEqual(
				new Set(["long-2"]),
			);
			expect(recent?.eventWindow).toEqual({
				hasEarlier: true,
				beforeCursor: expect.any(String),
			});
			const earlier = await reader.get(longScope, "long-history", undefined, {
				beforeCursor: recent?.eventWindow?.beforeCursor as string,
			});
			expect(earlier?.events).toHaveLength(eventsPerExecution);
			expect(new Set(earlier?.events.map((item) => item.executionId))).toEqual(
				new Set(["long-1"]),
			);
			expect(earlier?.eventWindow).toEqual({
				hasEarlier: false,
				beforeCursor: null,
			});
		} finally {
			await reader.close();
		}
	});

	it("looks up traces only for the Executions an incremental replay returns", async () => {
		const replays = 20;
		const { result: replay, scans } = await auditScansDuring(async (reader) => {
			let last: Awaited<ReturnType<typeof reader.replay>>;
			for (let attempt = 0; attempt < replays; attempt++)
				last = await reader.replay(longScope, "long-history", {
					kind: "last-event-id",
					value: `long-event-${2 * eventsPerExecution - 10}`,
				});
			return last;
		});
		expect(replay).toMatchObject({ outcome: "events" });
		const events = replay?.outcome === "events" ? replay.events : [];
		expect(events).toHaveLength(10);
		expect(new Set(events.map((event) => event.traceId))).toEqual(
			new Set(["trace-long-2"]),
		);
		// Each replay reads only the latest Execution's trace; reading every
		// Execution of the Conversation would double the lookups.
		expect(scans).toBeGreaterThanOrEqual(replays);
		expect(scans).toBeLessThan(replays + replays / 2);
	});

	it("cancels the database statement when the caller aborts the read", async () => {
		const locker = postgres(databaseUrl, { max: 1 });
		const holder = await locker.reserve();
		const blocked = async () => {
			const [row] = await client<{ count: number }[]>`
				select count(*)::int as count from pg_stat_activity
				where wait_event_type = 'Lock' and query like '%conversation_events%'`;
			return row?.count ?? 0;
		};
		try {
			await holder`begin`;
			await holder`lock table platform.conversation_events in access exclusive mode`;
			const controller = new AbortController();
			const reading = query.get(longScope, "long-history", controller.signal);
			const settled = reading.then(
				() => "resolved",
				(error: unknown) => error,
			);
			for (let attempt = 0; attempt < 100 && (await blocked()) === 0; attempt++)
				await new Promise((resolve) => setTimeout(resolve, 50));
			expect(await blocked()).toBe(1);
			const abortedAt = performance.now();
			controller.abort();
			expect(await settled).toBeInstanceOf(ConversationQueryError);
			expect(performance.now() - abortedAt).toBeLessThan(1_000);
			expect(await blocked()).toBe(0);
		} finally {
			await holder`rollback`.catch(() => undefined);
			holder.release();
			await locker.end();
		}
		// The pool stays usable after a cancelled read.
		expect((await query.get(longScope, "long-history"))?.events).toHaveLength(
			2 * eventsPerExecution,
		);
	});

	it("does not start a read whose caller already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			query.get(longScope, "long-history", controller.signal),
		).rejects.toBeInstanceOf(ConversationQueryError);
		await expect(
			query.replay(longScope, "long-history", undefined, controller.signal),
		).rejects.toBeInstanceOf(ConversationQueryError);
	});
});

describe("reasoning-heavy Conversation windows (#3068)", () => {
	const reasoningScope = { actorId: "reasoning-actor", channelId: "web" };
	type Round = { readonly reasoning: number; readonly text: number };
	/** 与固定环境 DeepSeek「高」档实测同量级：每轮 500 条以上思考增量、几十条正文增量。 */
	const deepSeekRounds: readonly Round[] = [
		{ reasoning: 520, text: 60 },
		{ reasoning: 610, text: 45 },
		{ reasoning: 505, text: 70 },
	];
	const roundSize = (round: Round) => round.reasoning + round.text + 2;
	const executionOf = (conversationId: string, round: number) =>
		`${conversationId}-round-${round}`;
	/** 第 round 轮的完整回答正文，与写入的 text.delta 逐条拼接一致。 */
	const answerOf = (
		conversationId: string,
		round: number,
		rounds: readonly Round[],
	) => {
		const shape = rounds[round - 1] as Round;
		return Array.from(
			{ length: shape.text },
			(_, index) =>
				`${executionOf(conversationId, round)}-answer-${shape.reasoning + 2 + index} `,
		).join("");
	};
	const fourRounds: readonly Round[] = [
		{ reasoning: 540, text: 50 },
		...deepSeekRounds,
	];
	const executions = (events: readonly { executionId: string }[] = []) => [
		...new Set(events.map((event) => event.executionId)),
	];
	/** 会话详情投影出的各轮回答正文，按 Execution 取用。 */
	const answersOf = (
		detail: Awaited<ReturnType<PostgresConversationQueryV1["get"]>>,
	) =>
		new Map(
			projectConversationMessagesV1(detail as NonNullable<typeof detail>)
				.filter((message) => message.role === "assistant")
				.map((message) => [message.executionId, message.text]),
		);

	/** 按轮次批量写入：每轮依次为 processing、思考增量、正文增量、completed。 */
	async function seedRounds(conversationId: string, rounds: readonly Round[]) {
		const total = rounds.reduce((sum, round) => sum + roundSize(round), 0);
		await client`insert into platform.conversations
			(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision,last_conversation_cursor)
			values (${conversationId},'reasoning-agent','reasoning-actor','web','ready',1,'auth-reasoning',${total})`;
		let cursor = 0;
		for (const [index, round] of rounds.entries()) {
			const executionId = executionOf(conversationId, index + 1);
			const messageId = `${executionId}-question`;
			const createdAt = new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString();
			await client`insert into platform.conversation_executions
				(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,authorization_revision,created_at)
				values (${executionId},${conversationId},'reasoning-agent','reasoning-actor','web',${`turn-${executionId}`},'completed',1,'auth-reasoning',${createdAt})`;
			await client`insert into platform.conversation_messages
				(message_id,conversation_id,actor_id,role,text,execution_id,status,created_at,updated_at)
				values (${messageId},${conversationId},'reasoning-actor','user',${`question-${index + 1}`},${executionId},'submitted',${createdAt},${createdAt})`;
			await client`insert into platform.outbox_items
				(id,scope_type,scope_id,operation,payload,trace_id,request_id,available_at,created_at,updated_at)
				values (${`outbox-${executionId}`},'conversation',${conversationId},'conversation.turn.submit.v1',
					${client.json({
						schemaVersion: 1,
						conversationId,
						executionId,
						messageId,
						turnId: `turn-${executionId}`,
						sessionGeneration: 1,
					})},'trace-reasoning','request-reasoning',${createdAt},${createdAt},${createdAt})`;
			await client`insert into platform.conversation_events
				(event_id,conversation_id,execution_id,adapter_event_key,sequence,conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,occurred_at,source)
				select ${executionId} || '-event-' || n, ${conversationId}, ${executionId},
					${executionId} || '-key-' || n, n, ${cursor}::bigint + n, kind.event_type, kind.event_payload,
					${"d".repeat(64)}, ${executionId} || '-runtime-' || n,
					${createdAt}::timestamptz + n * interval '1 millisecond', 'runtime'
				from generate_series(1, ${roundSize(round)}::int) as n
				cross join lateral (
					select
						case
							when n = 1 or n = ${roundSize(round)}::int then 'execution.status'
							when n <= 1 + ${round.reasoning}::int then 'reasoning.delta'
							else 'text.delta'
						end as event_type,
						case
							when n = 1 then jsonb_build_object('type', 'execution.status', 'status', 'processing')
							when n = ${roundSize(round)}::int then jsonb_build_object('type', 'execution.status', 'status', 'completed')
							when n <= 1 + ${round.reasoning}::int then jsonb_build_object('type', 'reasoning.delta', 'kind', 'raw', 'text', 'thought-' || n || ' ')
							else jsonb_build_object('type', 'text.delta', 'text', ${executionId} || '-answer-' || n || ' ')
						end as event_payload
				) kind`;
			cursor += roundSize(round);
		}
		await seedSessionSandboxFixture(client, conversationId);
	}

	beforeAll(async () => {
		await seedRounds("reasoning-three", deepSeekRounds);
		await seedRounds("reasoning-four", fourRounds);
		await seedRounds("reasoning-walk", [
			{ reasoning: 30, text: 5 },
			{ reasoning: 150, text: 3 },
			{ reasoning: 10, text: 20 },
			{ reasoning: 40, text: 2 },
			{ reasoning: 0, text: 8 },
			{ reasoning: 120, text: 4 },
		]);
	}, 60_000);

	/** 与 platform-api 装配一致：窗口 200 条、总上限取默认值。 */
	function platformReader() {
		return new PostgresConversationQueryV1({ databaseUrl, eventWindow: 200 });
	}

	it("shows every answer and thinking process of a three-round reasoning conversation on the first screen", async () => {
		const reader = platformReader();
		try {
			const detail = await reader.get(reasoningScope, "reasoning-three");
			// 思考增量不计入窗口条数：3 轮共 1,816 条事件，旧规则只装得下最新一轮。
			expect(detail?.events).toHaveLength(
				deepSeekRounds.reduce((sum, round) => sum + roundSize(round), 0),
			);
			expect(detail?.eventWindow).toEqual({
				hasEarlier: false,
				beforeCursor: null,
			});
			expect(answersOf(detail)).toEqual(
				new Map(
					[1, 2, 3].map((round) => [
						executionOf("reasoning-three", round),
						answerOf("reasoning-three", round, deepSeekRounds),
					]),
				),
			);
			for (const [index, round] of deepSeekRounds.entries())
				expect(
					detail?.events.filter(
						(event) =>
							event.executionId === executionOf("reasoning-three", index + 1) &&
							event.eventType === "reasoning.delta",
					),
				).toHaveLength(round.reasoning);
		} finally {
			await reader.close();
		}
	});

	it("bounds the first screen by total events and pages the rest without duplicates or gaps", async () => {
		const reader = platformReader();
		try {
			const recent = await reader.get(reasoningScope, "reasoning-four");
			// 计数窗口会跨到第 1 轮，但加入它会超过 2,000 条总上限，留给更早的页；最近 3 轮完整。
			expect(executions(recent?.events)).toEqual(
				[2, 3, 4].map((round) => executionOf("reasoning-four", round)),
			);
			expect(recent?.events.length).toBeLessThanOrEqual(2_000);
			// 窗口外的第 1 轮没有正文，由 Web 提示「加载更早内容」（NW-15）。
			expect(answersOf(recent)).toEqual(
				new Map([
					[executionOf("reasoning-four", 1), ""],
					...[2, 3, 4].map(
						(round) =>
							[
								executionOf("reasoning-four", round),
								answerOf("reasoning-four", round, fourRounds),
							] as const,
					),
				]),
			);
			expect(recent?.eventWindow).toEqual({
				hasEarlier: true,
				beforeCursor: expect.any(String),
			});
			const earlier = await reader.get(
				reasoningScope,
				"reasoning-four",
				undefined,
				{ beforeCursor: recent?.eventWindow?.beforeCursor as string },
			);
			expect(executions(earlier?.events)).toEqual([
				executionOf("reasoning-four", 1),
			]);
			expect(earlier?.eventWindow).toEqual({
				hasEarlier: false,
				beforeCursor: null,
			});
			const full = await query.get(reasoningScope, "reasoning-four");
			expect(
				[...(earlier?.events ?? []), ...(recent?.events ?? [])].map(
					(event) => event.eventId,
				),
			).toEqual(full?.events.map((event) => event.eventId));
		} finally {
			await reader.close();
		}
	});

	it("keeps every page within the total limit except a single oversized Execution", async () => {
		const reader = new PostgresConversationQueryV1({
			databaseUrl,
			eventWindow: 20,
			eventWindowMaxEvents: 100,
		});
		try {
			const pages: (readonly string[])[] = [];
			const walked: string[] = [];
			let beforeCursor: string | undefined;
			for (let page = 0; page < 10; page++) {
				const detail = await reader.get(
					reasoningScope,
					"reasoning-walk",
					undefined,
					beforeCursor === undefined ? undefined : { beforeCursor },
				);
				pages.push(executions(detail?.events));
				walked.unshift(...(detail?.events.map((event) => event.eventId) ?? []));
				if (!detail?.eventWindow?.hasEarlier) break;
				beforeCursor = detail.eventWindow.beforeCursor as string;
			}
			// 第 6、2 轮各自超过 100 条，只能独占一页且完整返回；第 3–5 轮合计 86 条同页；
			// 第 1 轮不足计数窗口，读到最早。
			expect(pages).toEqual(
				[[6], [3, 4, 5], [2], [1]].map((rounds) =>
					rounds.map((round) => executionOf("reasoning-walk", round)),
				),
			);
			const full = await query.get(reasoningScope, "reasoning-walk");
			expect(walked).toEqual(full?.events.map((event) => event.eventId));
			expect(new Set(walked).size).toBe(walked.length);
		} finally {
			await reader.close();
		}
	});

	it("rejects an invalid total event limit", () => {
		for (const eventWindowMaxEvents of [0, 10_001, 1.5])
			expect(
				() =>
					new PostgresConversationQueryV1({
						databaseUrl,
						eventWindow: 200,
						eventWindowMaxEvents,
					}),
			).toThrow(ConversationQueryError);
	});
});

describe("aborted reads release their transaction (#2664)", () => {
	/** 在期限内看 Promise 是结束了还是挂住了；挂住正是这个缺陷。 */
	async function outcome(promise: Promise<unknown>, timeoutMs = 5_000) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				promise.then(
					() => "resolved",
					() => "rejected",
				),
				new Promise<string>((resolve) => {
					timer = setTimeout(() => resolve("hung"), timeoutMs);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	async function idleInTransaction(applicationName: string) {
		const [row] = await client<{ count: number }[]>`
			select count(*)::int as count from pg_stat_activity
			where application_name = ${applicationName} and state = 'idle in transaction'`;
		return row?.count ?? 0;
	}

	it("ends a read aborted between two statements and returns its only connection", async () => {
		const applicationName = "kiro-2664-between";
		const reader = postgres(databaseUrl, {
			max: 1,
			connection: { application_name: applicationName },
		});
		try {
			const controller = new AbortController();
			const read = repeatableRead(
				reader,
				async (transaction, run) => {
					await run(transaction`select 1 as first`);
					// 调用方在两条语句之间断开（例如浏览器关闭了标签页）。
					controller.abort();
					await run(transaction`select 2 as second`);
					return "unreachable";
				},
				controller.signal,
			);
			expect(await outcome(read)).toBe("rejected");
			// 唯一的连接已经归还：同一个客户端还能执行查询。
			expect(
				await outcome(reader`select 3 as value`.then((rows) => rows[0]?.value)),
			).toBe("resolved");
			expect(await idleInTransaction(applicationName)).toBe(0);
		} finally {
			await reader.end({ timeout: 1 });
		}
	});

	it("ends a read aborted while parameterised statements queue behind a describe (#2664)", async () => {
		// 新连接上第一次执行带参数的语句要先 describe，postgres-js 会把同一事务里随后的语句放进事务
		// 本地队列，尚未交给连接；这正是线上会话读取（并行读取消息、执行和事件）的形状。
		const applicationName = "kiro-2664-describe";
		const reader = postgres(databaseUrl, {
			max: 1,
			connection: { application_name: applicationName },
		});
		try {
			const controller = new AbortController();
			const seconds = 30;
			const read = repeatableRead(
				reader,
				async (transaction, run) => {
					await Promise.all([
						run(transaction`select pg_sleep(${seconds})`),
						run(transaction`select ${2}::int as second`),
						run(transaction`select ${3}::int as third`),
					]);
					return "unreachable";
				},
				controller.signal,
			);
			setTimeout(() => controller.abort(), 300);
			expect(await outcome(read)).toBe("rejected");
			expect(
				await outcome(
					reader`select ${4}::int as value`.then((rows) => rows[0]?.value),
				),
			).toBe("resolved");
			expect(await idleInTransaction(applicationName)).toBe(0);
		} finally {
			await reader.end({ timeout: 1 });
		}
	});

	it("ends a read aborted while later statements wait behind a running one", async () => {
		const applicationName = "kiro-2664-queued";
		const reader = postgres(databaseUrl, {
			max: 1,
			connection: { application_name: applicationName },
		});
		try {
			const controller = new AbortController();
			const read = repeatableRead(
				reader,
				async (transaction, run) => {
					await Promise.all([
						run(transaction`select pg_sleep(30)`),
						run(transaction`select 2 as second`),
						run(transaction`select 3 as third`),
					]);
					return "unreachable";
				},
				controller.signal,
			);
			setTimeout(() => controller.abort(), 300);
			expect(await outcome(read)).toBe("rejected");
			expect(
				await outcome(reader`select 4 as value`.then((rows) => rows[0]?.value)),
			).toBe("resolved");
			expect(await idleInTransaction(applicationName)).toBe(0);
		} finally {
			await reader.end({ timeout: 1 });
		}
	});
});
