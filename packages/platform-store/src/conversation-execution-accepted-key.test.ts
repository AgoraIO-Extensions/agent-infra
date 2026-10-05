import { Buffer } from "node:buffer";
import {
	type RuntimeSubmitTurnRequestV4,
	RuntimeSubmitTurnRequestV4Schema,
	RuntimeSupplementRequestV4Schema,
} from "@agent-infra/contracts/runtime";
import { parseTaskAuthorizationBoundaryV1 } from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { claimWork } from "./conversation-dispatch-claim.ts";
import { lockOutbox, ownedState } from "./conversation-dispatch-sql.ts";
import { PostgresConversationExecutionTransactionV1 } from "./conversation-execution.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";
import { seedSessionSandboxFixture } from "./session-sandbox.fixture.ts";

let database: PostgresTestDatabase;
let client: ReturnType<typeof postgres>;
let store: PostgresConversationExecutionTransactionV1 | undefined;
beforeAll(async () => {
	database = await startPostgresTestDatabase("accepted-key-supplier");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	client = postgres(database.databaseUrl, { max: 2 });
}, 120_000);
afterEach(async () => {
	await store?.close();
	store = undefined;
	await client`truncate platform.conversations, platform.relay_key_subjects, platform.outbox_items cascade`;
});
afterAll(async () => {
	await client?.end();
	await database?.stop();
});

async function accepted(
	channel: "web" | "api:user" | "api:application" = "web",
) {
	const principal = {
		kind: channel === "api:application" ? "application" : "user",
		id: "original-subject",
	} as const;
	const purpose = channel === "web" ? "personal" : "agent-default";
	const subjectId = channel === "web" ? principal.id : "original-agent";
	const request = RuntimeSubmitTurnRequestV4Schema.parse({
		schemaVersion: 4,
		requestId: "request",
		traceId: "trace",
		principal,
		executionSource: channel === "web" ? "web" : "platform-api",
		channelId: channel,
		agentId: "original-agent",
		conversationId: "original-conversation",
		executionId: "original-execution",
		turnId: "original-turn",
		sessionGeneration: 1,
		hostSessionRef: null,
		operation: {
			kind: "execution",
			id: "original-execution",
			deliveryFence: 7,
			executionDeliveryFence: 7,
		},
		grant: {
			schemaVersion: 4,
			format: "runtime-execution-jws",
			token: "a.b.c",
		},
		keyBinding: {
			purpose,
			subjectId,
			ciphertextRef: "accepted-key",
			version: 1,
		},
		input: { text: "original input", attachments: [] },
		selection: {
			schemaVersion: 1,
			modelOptionId: "accepted-model",
			reasoningLevel: "high",
		},
	});
	const boundary = parseTaskAuthorizationBoundaryV1({
		schemaVersion: 1,
		principal,
		agentId: request.agentId,
		channelId: channel,
		identityRevision: "identity",
		agentAuthorizationRevision: "agent-revision",
		accessSources:
			channel === "web"
				? [{ kind: "user", userId: principal.id }]
				: [{ kind: "api-use", useGrantRevision: "grant" }],
	});
	await client.begin(async (sql) => {
		await sql`insert into platform.relay_key_subjects(purpose, subject_id, last_version, current_version)
   values (${purpose}, ${subjectId}, 1, 1)`;
		await sql`insert into platform.relay_key_versions(purpose, subject_id, key_version, key_id, ciphertext)
   values (${purpose}, ${subjectId}, 1, 'accepted-key', ${sql.json({ purpose, subjectId, keyId: "accepted-key", keyVersion: 1 })})`;
		await sql`insert into platform.conversations(id, agent_id, actor_id, principal_type, channel_id, status, session_generation, authorization_revision)
   values (${request.conversationId}, ${request.agentId}, ${principal.id}, ${principal.kind}, ${channel}, 'ready', 1, 'agent-revision')`;
		await sql`insert into platform.conversation_executions(execution_id, conversation_id, agent_id, actor_id, principal_type,
   channel_id, turn_id, status, session_generation, delivery_fence, authorization_revision, created_at,
   model_configuration_revision, model_option_id, reasoning_level, execution_source,
   relay_key_purpose, relay_key_subject_id, relay_key_id, relay_key_version,
   runtime_submit_protocol, original_operation_digest, original_submit_host_session_ref)
   values (${request.executionId}, ${request.conversationId}, ${request.agentId}, ${principal.id}, ${principal.kind}, ${channel},
    ${request.turnId}, 'unknown', 1, 7, 'agent-revision', clock_timestamp(), 1, 'accepted-model', 'high', ${request.executionSource},
   ${purpose}, ${subjectId}, 'accepted-key', 1, 'v4', ${"a".repeat(43)}, null)`;
		await sql`insert into platform.conversation_messages(message_id, conversation_id, actor_id, role, text, execution_id, status, created_at)
   values ('original-message', ${request.conversationId}, ${principal.id}, 'user', 'original input', ${request.executionId}, 'submitted', clock_timestamp())`;
		await sql`insert into platform.task_authorization_records(id, execution_id, boundary)
   values ('accepted-authorization', ${request.executionId}, ${client.json(boundary as unknown as postgres.JSONValue)})`;
		await sql`insert into platform.outbox_items(id, scope_type, scope_id, operation, payload, status,
   lease_owner, lease_expires_at, delivery_fence, trace_id, request_id)
   values (${`conversation:turn:${request.executionId}`}, 'conversation', ${request.conversationId}, 'conversation.turn.submit.v1',
    ${sql.json({
			schemaVersion: 1,
			conversationId: request.conversationId,
			executionId: request.executionId,
			messageId: "original-message",
			turnId: request.turnId,
			sessionGeneration: 1,
			modelConfigurationRevision: 1,
			modelOptionId: "accepted-model",
			reasoningLevel: "high",
		})},
    'processing', 'original-worker', clock_timestamp() + interval '1 minute', 7, 'trace', 'request')`;
	});
	await seedSessionSandboxFixture(client, request.conversationId);
	store = new PostgresConversationExecutionTransactionV1({
		databaseUrl: database.databaseUrl,
	});
	return { request, store };
}

it.each(["web", "api:user", "api:application"] as const)(
	"projects saved %s identity, selection and exact Key; initial Session may be null",
	async (channel) => {
		const { store, request } = await accepted(channel);
		await client`update platform.relay_key_subjects set last_version=2, current_version=null`;
		const projection = await store.readAcceptedExecution({
			...request,
			selection: { ...request.selection, modelOptionId: "caller-model" },
		});
		expect(projection).toEqual({
			scope: {
				principal: request.principal,
				executionSource: request.executionSource,
				channelId: request.channelId,
				agentId: request.agentId,
				conversationId: request.conversationId,
				executionId: request.executionId,
				turnId: request.turnId,
				sessionGeneration: 1,
				hostSessionRef: null,
				keyBinding: request.keyBinding,
			},
			trustedHostSessionRef: null,
			authorizationRecordId: "accepted-authorization",
			selection: request.selection,
		});
	},
);

it("reads only the accepted ciphertext tuple and fails closed on crossed bindings", async () => {
	const { store, request } = await accepted();
	const ciphertext = {
		schemaVersion: 1,
		purpose: request.keyBinding.purpose,
		subjectId: request.keyBinding.subjectId,
		keyId: request.keyBinding.ciphertextRef,
		keyVersion: request.keyBinding.version,
		crypto: {
			schemaVersion: 1,
			algorithmVersion: "aes-256-gcm:v1",
			wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
			wrappingKeyVersion: "wrapping-key-1",
			aadVersion: "relay-key-aad:v1",
			dekFingerprint: "a".repeat(64),
			nonce: Buffer.alloc(12).toString("base64"),
			ciphertext: Buffer.alloc(16).toString("base64"),
			authenticationTag: Buffer.alloc(16).toString("base64"),
			wrappedDek: Buffer.alloc(384).toString("base64"),
		},
	};
	await client`update platform.relay_key_versions set ciphertext=${client.json(ciphertext)}
		where purpose=${request.keyBinding.purpose} and subject_id=${request.keyBinding.subjectId}
		and key_id=${request.keyBinding.ciphertextRef} and key_version=${request.keyBinding.version}`;

	await expect(
		store.readCiphertext({
			purpose: request.keyBinding.purpose,
			subjectId: request.keyBinding.subjectId,
			keyId: request.keyBinding.ciphertextRef,
			keyVersion: request.keyBinding.version,
		}),
	).resolves.toEqual(ciphertext);
	await expect(
		store.readCiphertext({
			purpose: request.keyBinding.purpose,
			subjectId: request.keyBinding.subjectId,
			keyId: "other-key",
			keyVersion: request.keyBinding.version,
		}),
	).resolves.toBeNull();
});

it("rejects crossed principal namespace, Session, Key and operation fences", async () => {
	const { store, request } = await accepted("api:application");
	const bad: RuntimeSubmitTurnRequestV4[] = [
		{ ...request, principal: { kind: "user", id: request.principal.id } },
		{ ...request, principal: { ...request.principal, id: "other-subject" } },
		{ ...request, agentId: "other-agent" },
		{ ...request, turnId: "other-turn" },
		{ ...request, sessionGeneration: 2 },
		{ ...request, hostSessionRef: "other-session" },
		{
			...request,
			keyBinding: { ...request.keyBinding, ciphertextRef: "current-alias" },
		},
		{ ...request, keyBinding: { ...request.keyBinding, version: 2 } },
		{ ...request, operation: { ...request.operation, id: "other-execution" } },
		{ ...request, operation: { ...request.operation, deliveryFence: 8 } },
		{
			...request,
			operation: { ...request.operation, executionDeliveryFence: 4 },
		},
	];
	for (const value of bad)
		expect(await store.readAcceptedExecution(value)).toBeNull();
});

it("rejects revoked authorization, expired lease, pending stop and unpinned protocol", async () => {
	const { store, request } = await accepted();
	await client`update platform.task_authorization_records set revoked_at=clock_timestamp()`;
	expect(await store.readAcceptedExecution(request)).toBeNull();
	await client`update platform.task_authorization_records set revoked_at=null`;
	await client`update platform.outbox_items set lease_expires_at=clock_timestamp()-interval '1 second'`;
	expect(await store.readAcceptedExecution(request)).toBeNull();
	await client`update platform.outbox_items set lease_expires_at=clock_timestamp()+interval '1 minute'`;
	await client`insert into platform.conversation_stops(execution_id, stop_request_id, status, created_at)
  values (${request.executionId}, 'stop-request', 'submitted', clock_timestamp())`;
	expect(await store.readAcceptedExecution(request)).toBeNull();
	await client`delete from platform.conversation_stops`;
	await client`update platform.conversation_executions set runtime_submit_protocol=null, original_operation_digest=null,
  original_submit_host_session_ref=null`;
	expect(await store.readAcceptedExecution(request)).toBeNull();
});

it("close joins an already accepted real SQL read and rejects new reads before closing its original pool", async () => {
	const { store, request } = await accepted();
	const held = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const blocker = client.begin(async (sql) => {
		await sql`select id from platform.outbox_items where id=${`conversation:turn:${request.executionId}`} for update`;
		held.resolve();
		await release.promise;
	});
	await held.promise;
	const read = store.readAcceptedExecution(request);
	let closed = false;
	const closing = store.close().then(() => {
		closed = true;
	});
	try {
		await expect(store.readAcceptedExecution(request)).rejects.toThrow();
		await client`select 1`;
		expect(closed).toBe(false);
	} finally {
		release.resolve();
		await blocker;
	}
	expect(await read).not.toBeNull();
	await closing;
	expect(closed).toBe(true);
	await expect(store.readAcceptedExecution(request)).rejects.toThrow();
});

it("supplement uses the saved message operation and current trusted Session while keeping the original null submit Session", async () => {
	const { store, request } = await accepted();
	await client`update platform.conversations set status='active', host_session_ref='current-session'`;
	await client`update platform.conversation_executions set status='processing'`;
	await client`insert into platform.conversation_messages(message_id, conversation_id, actor_id, role, text, execution_id, status, created_at)
  values ('supplement-message', ${request.conversationId}, ${request.principal.id}, 'user', 'more input', ${request.executionId}, 'submitted', clock_timestamp())`;
	await client`insert into platform.outbox_items(id, scope_type, scope_id, operation, payload, status,
  lease_owner, lease_expires_at, delivery_fence, trace_id, request_id)
  values ('conversation:supplement:supplement-message', 'conversation', ${request.conversationId}, 'conversation.turn.supplement.v1',
   ${client.json({
			schemaVersion: 1,
			conversationId: request.conversationId,
			executionId: request.executionId,
			messageId: "supplement-message",
			turnId: request.turnId,
			sessionGeneration: 1,
			modelConfigurationRevision: 1,
			modelOptionId: "accepted-model",
			reasoningLevel: "high",
		})},
   'processing', 'original-worker', clock_timestamp()+interval '1 minute', 9, 'trace', 'request')`;
	const { selection, ...base } = request;
	const supplement = RuntimeSupplementRequestV4Schema.parse({
		...base,
		hostSessionRef: "current-session",
		operation: {
			kind: "message",
			id: "supplement-message",
			deliveryFence: 9,
			executionDeliveryFence: 7,
		},
	});
	expect(await store.readAcceptedExecution(supplement)).toEqual({
		scope: {
			principal: request.principal,
			executionSource: request.executionSource,
			channelId: request.channelId,
			agentId: request.agentId,
			conversationId: request.conversationId,
			executionId: request.executionId,
			turnId: request.turnId,
			sessionGeneration: 1,
			hostSessionRef: null,
			keyBinding: request.keyBinding,
		},
		trustedHostSessionRef: "current-session",
		authorizationRecordId: "accepted-authorization",
		selection,
	});
	expect(
		await store.readAcceptedExecution({
			...supplement,
			hostSessionRef: "other-session",
		}),
	).toBeNull();
	await client`update platform.conversation_messages set actor_id='other-subject' where message_id='supplement-message'`;
	expect(await store.readAcceptedExecution(supplement)).toBeNull();
});

async function waitForConversationWaiters(count: number) {
	await vi.waitFor(async () => {
		const [row] = await client<
			{ count: number }[]
		>`select count(*)::int as count from pg_stat_activity
   where datname=current_database() and wait_event_type='Lock' and query like '%from platform.conversations%for update%'`;
		expect(row?.count).toBe(count);
	});
}

// Both public Store calls run against the same real PostgreSQL rows. Queue them
// behind a third transaction to make the old Conversation/Outbox inversion deterministic.
it("converges metadata recovery with a late accepted-key read without a lock inversion", async () => {
	const { store, request } = await accepted();
	await client`update platform.conversation_executions set status='completed', last_runtime_cursor='terminal-cursor'`;
	await client`update platform.outbox_items set status='succeeded', lease_owner=null, lease_expires_at=null`;
	await client`insert into platform.conversation_events
  (event_id,conversation_id,execution_id,adapter_event_key,sequence,conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,occurred_at,source)
  values ('terminal-tool',${request.conversationId},${request.executionId},'terminal-tool',1,1,'execution.operation',${client.json(
		{
			schemaVersion: 2,
			type: "execution.operation",
			fact: {
				kind: "tool",
				toolId: "tool",
				operationRef: "operation",
				attemptRef: "attempt",
				phase: "unknown",
				connection: {
					serviceRef: "service",
					verification: "unverified",
					reason: "receipt_missing",
				},
			},
		},
	)},${"a".repeat(64)},'terminal-cursor',clock_timestamp(),'runtime')`;
	const blocker = postgres(database.databaseUrl, { max: 1 });
	let recovery: Promise<unknown> | undefined;
	let reader: Promise<unknown> | undefined;
	const settle = (work: Promise<unknown>) =>
		work.then(
			(result) => ({ result }),
			(error) => ({ error }),
		);
	try {
		await blocker.begin(async (transaction) => {
			await transaction`select id from platform.conversations where id=${request.conversationId} for update`;
			recovery = settle(
				store.requestMetadataRecovery(
					{
						query: {
							schemaVersion: 1,
							conversationId: request.conversationId,
							executionId: request.executionId,
						},
						authority: {
							schemaVersion: 1,
							actorId: request.principal.id,
							agentId: request.agentId,
							channelId: "web",
							authorizationRevision: "agent-revision",
							supportsSupplementaryInstruction: true,
						},
					},
					(state) => {
						expect(state.candidates).toHaveLength(1);
						return { result: { outcome: "not_applicable" }, updates: [] };
					},
				),
			);
			await waitForConversationWaiters(1);
			reader = settle(store.readAcceptedExecution(request));
			await waitForConversationWaiters(2);
		});
		expect(await recovery).toEqual({ result: { outcome: "not_applicable" } });
		expect(await reader).toEqual({ result: null });
	} finally {
		await Promise.all([recovery, reader]);
		await blocker.end();
	}
});

it.each(["lease", "fence", "authority"] as const)(
	"rechecks %s after waiting for the Conversation lock",
	async (change) => {
		const { store, request } = await accepted();
		const blocker = postgres(database.databaseUrl, { max: 1 });
		let pending: Promise<unknown> | undefined;
		try {
			await blocker.begin(async (transaction) => {
				const [owner] = await transaction<
					{ pid: number }[]
				>`select pg_backend_pid() as pid`;
				if (!owner) throw new Error("Missing lock owner");
				await transaction`select id from platform.conversations where id=${request.conversationId} for update`;
				pending = store.readAcceptedExecution(request).then(
					(result) => ({ result }),
					(error) => ({ error }),
				);
				await vi.waitFor(async () => {
					const [row] = await client<{ blocked: boolean }[]>`select exists (
      select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock'
       and ${owner.pid}=any(pg_blocking_pids(pid)) and query like '%from platform.conversations%'
     ) as blocked`;
					expect(row?.blocked).toBe(true);
				});
				// The reader must not hold the Outbox while waiting for this Conversation.
				await transaction`select id from platform.outbox_items where id=${`conversation:turn:${request.executionId}`} for update`;
				if (change === "lease")
					await transaction`update platform.outbox_items set lease_expires_at=clock_timestamp()-interval '1 second'`;
				if (change === "fence")
					await transaction`update platform.outbox_items set delivery_fence=8`;
				if (change === "authority")
					await transaction`update platform.task_authorization_records set revoked_at=clock_timestamp()`;
			});
			expect(await pending).toEqual({ result: null });
		} finally {
			await pending;
			await blocker.end();
		}
	},
);

it.each(["claim", "ownedState"] as const)(
	"serializes an accepted reader with %s on the original rows",
	async (mode) => {
		const { store, request } = await accepted();
		const itemId = `conversation:turn:${request.executionId}`;
		const command = {
			schemaVersion: 1 as const,
			itemId,
			workerId: "original-worker",
			leaseDurationMs: 60_000,
		};
		await client`update platform.outbox_items set lease_expires_at=clock_timestamp()-interval '1 second'`;
		const decision = await client.begin((transaction) =>
			claimWork(transaction, command),
		);
		if (decision.outcome !== "claimed")
			throw new Error("Expected original claim");
		const currentRequest = {
			...request,
			operation: {
				...request.operation,
				deliveryFence: decision.claim.deliveryFence,
				executionDeliveryFence: decision.claim.executionDeliveryFence,
			},
		};
		const blocker = postgres(database.databaseUrl, { max: 1 });
		let reader: Promise<unknown> | undefined;
		let dispatch: Promise<unknown> | undefined;
		try {
			await blocker.begin(async (transaction) => {
				await transaction`select id from platform.conversations where id=${request.conversationId} for update`;
				reader = store.readAcceptedExecution(currentRequest).then(
					(result) => ({ result }),
					(error) => ({ error }),
				);
				await waitForConversationWaiters(1);
				dispatch = client
					.begin(async (sql) =>
						mode === "claim"
							? claimWork(sql, command)
							: ownedState(sql, decision.claim),
					)
					.then(
						(result) => ({ result }),
						(error) => ({ error }),
					);
				await waitForConversationWaiters(2);
			});
			expect(await reader).toMatchObject({
				result: { authorizationRecordId: "accepted-authorization" },
			});
			expect(await dispatch).toMatchObject({
				result:
					mode === "claim" ? { outcome: "busy" } : { outbox: { id: itemId } },
			});
			const [saved] = await client<
				{ fence: string; attempts: number }[]
			>`select delivery_fence::text as fence, attempt_count as attempts from platform.outbox_items where id=${itemId}`;
			expect(saved).toEqual({
				fence: String(decision.claim.deliveryFence),
				attempts: 1,
			});
		} finally {
			await Promise.all([reader, dispatch]);
			await blocker.end();
		}
	},
);

it("rejects a crossed expected Conversation before locking it and scope drift after a lock wait", async () => {
	const { request } = await accepted();
	const itemId = `conversation:turn:${request.executionId}`;
	const blocker = postgres(database.databaseUrl, { max: 1 });
	let pending: Promise<unknown> | undefined;
	try {
		await blocker.begin(async (transaction) => {
			const [owner] = await transaction<
				{ pid: number }[]
			>`select pg_backend_pid() as pid`;
			if (!owner) throw new Error("Missing lock owner");
			await transaction`select id from platform.conversations where id=${request.conversationId} for update`;
			const crossed = await client.begin(async (sql) => {
				await sql`set local lock_timeout = '100ms'`;
				return (await lockOutbox(sql, itemId, "other-conversation")) ?? null;
			});
			expect(crossed).toBeNull();
			pending = client
				.begin(
					async (sql) =>
						(await lockOutbox(sql, itemId, request.conversationId)) ?? null,
				)
				.then(
					(result) => ({ result }),
					(error) => ({ error }),
				);
			await vi.waitFor(async () => {
				const [row] = await client<{ blocked: boolean }[]>`select exists (
     select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock'
      and ${owner.pid}=any(pg_blocking_pids(pid)) and query like '%from platform.conversations%'
    ) as blocked`;
				expect(row?.blocked).toBe(true);
			});
			await transaction`update platform.outbox_items set scope_id='other-conversation' where id=${itemId}`;
		});
		expect(await pending).toEqual({ result: null });
	} finally {
		await pending;
		await blocker.end();
	}
});
