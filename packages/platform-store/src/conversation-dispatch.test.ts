import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PostgresConversationDispatchStoreV1 } from "./conversation-dispatch.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

let databaseUrl = "";
let client: ReturnType<typeof postgres>;
let testDatabase: PostgresTestDatabase | undefined;
let fixture = 1;

beforeAll(async () => {
	testDatabase = await startPostgresTestDatabase("conversation-dispatch");
	databaseUrl = testDatabase.databaseUrl;
	await migratePlatformDatabase({ databaseUrl });
	client = postgres(databaseUrl, { max: 5 });
}, 120_000);

afterEach(async () => {
	await client.unsafe(`drop trigger if exists conversation_dispatch_failure
		on platform.conversation_executions`);
	await client.unsafe(
		"drop function if exists platform.conversation_dispatch_failure()",
	);
	await client`truncate platform.conversation_events,
		platform.conversation_audit_events, platform.audit_events,
		platform.outbox_items, platform.idempotency_records,
		platform.conversation_stops, platform.conversation_messages,
		platform.conversation_executions, platform.conversations`;
});

afterAll(async () => {
	await client?.end();
	await testDatabase?.stop();
});

async function seed(
	operation:
		| "conversation.turn.submit.v1"
		| "conversation.turn.regenerate.v1"
		| "conversation.turn.supplement.v1"
		| "conversation.turn.stop.v1" = "conversation.turn.submit.v1",
	options: {
		executionStatus?: "submitted" | "processing" | "unknown" | "completed";
		executionFence?: number;
		hostSessionRef?: string | null;
		legacySelection?: boolean;
	} = {},
) {
	const suffix = fixture++;
	const conversationId = `conversation-dispatch-${suffix}`;
	const executionId = `execution-dispatch-${suffix}`;
	const messageId = `message-dispatch-${suffix}`;
	const stopRequestId = `stop-dispatch-${suffix}`;
	const turnId = `turn-dispatch-${suffix}`;
	const itemId =
		operation === "conversation.turn.stop.v1"
			? `conversation:stop:${stopRequestId}`
			: operation === "conversation.turn.regenerate.v1"
				? `conversation:regenerate:${executionId}`
				: operation === "conversation.turn.supplement.v1"
					? `conversation:supplement:${messageId}`
					: `conversation:turn:${executionId}`;
	const executionStatus = options.executionStatus ?? "submitted";
	const executionFence = options.executionFence ?? 0;
	await client`
		insert into platform.conversations
			(id, agent_id, actor_id, channel_id, status, session_generation,
			 host_session_ref, authorization_revision, last_conversation_cursor,
			 created_at, updated_at)
		values
			(${conversationId}, 'agent-dispatch', 'actor-dispatch', 'web',
			 ${executionStatus === "completed" ? "ready" : "active"}, 1,
			 ${options.hostSessionRef ?? null}, 'authorization-dispatch', 0,
			 now(), now())
	`;
	await client`
		insert into platform.conversation_executions
			(execution_id, conversation_id, agent_id, actor_id, channel_id, turn_id,
			 status, session_generation, delivery_fence, authorization_revision,
			 model_configuration_revision, model_option_id, reasoning_level,
			 created_at, updated_at)
		values
			(${executionId}, ${conversationId}, 'agent-dispatch', 'actor-dispatch',
			 'web', ${turnId}, ${executionStatus}, 1, ${executionFence},
			 'authorization-dispatch', ${options.legacySelection ? null : 4},
			 ${options.legacySelection ? null : "model-option-dispatch"},
			 ${options.legacySelection ? null : "medium"},
			 now(), now())
	`;
	if (operation !== "conversation.turn.stop.v1") {
		await client`
			insert into platform.conversation_messages
				(message_id, conversation_id, actor_id, role, text, execution_id,
				 status, created_at, updated_at)
			values
				(${messageId}, ${conversationId}, 'actor-dispatch', 'user',
				 'bounded dispatch fixture', ${executionId}, 'submitted', now(), now())
		`;
	} else {
		await client`
			insert into platform.conversation_stops
				(execution_id, stop_request_id, status, created_at, updated_at)
			values (${executionId}, ${stopRequestId}, 'submitted', now(), now())
		`;
	}
	const payload =
		operation === "conversation.turn.stop.v1"
			? {
					schemaVersion: 1,
					conversationId,
					executionId,
					sessionGeneration: 1,
					stopRequestId,
				}
			: {
					schemaVersion: 1,
					conversationId,
					executionId,
					messageId,
					turnId,
					sessionGeneration: 1,
					...(options.legacySelection
						? {}
						: {
								modelConfigurationRevision: 4,
								modelOptionId: "model-option-dispatch",
								reasoningLevel: "medium",
							}),
				};
	await client`
		insert into platform.outbox_items
			(id, scope_type, scope_id, operation, payload, trace_id, request_id,
			 available_at, created_at, updated_at)
		values
			(${itemId}, 'conversation', ${conversationId}, ${operation},
			 ${client.json(payload)}, 'trace-dispatch', 'request-dispatch',
			 now(), now(), now())
	`;
	return {
		conversationId,
		executionId,
		messageId,
		stopRequestId,
		turnId,
		itemId,
	};
}

function open() {
	return new PostgresConversationDispatchStoreV1({ databaseUrl });
}

async function claim(
	itemId: string,
	workerId = "worker-1",
	leaseDurationMs = 30_000,
) {
	const store = open();
	const decision = await store.claim({
		schemaVersion: 1,
		itemId,
		workerId,
		leaseDurationMs,
	});
	return { store, decision };
}

async function dispatchState(work: { itemId: string; executionId: string }) {
	const [state] = await client`
		select o.status, o.delivery_fence::int as outbox_fence,
			e.status as execution_status,
			e.delivery_fence::int as execution_fence
		from platform.outbox_items o
		join platform.conversation_executions e
			on e.execution_id = ${work.executionId}
		where o.id = ${work.itemId}
	`;
	return state;
}

describe("PostgreSQL Conversation dispatch Store", () => {
	it("claims a Turn and atomically advances its Execution fence", async () => {
		const work = await seed();
		const first = await claim(work.itemId);
		try {
			expect(first.decision).toMatchObject({
				outcome: "claimed",
				claim: {
					itemId: work.itemId,
					conversationId: work.conversationId,
					executionId: work.executionId,
					deliveryFence: 1,
					executionDeliveryFence: 1,
					executionStatus: "unknown",
					modelConfigurationRevision: 4,
					modelOptionId: "model-option-dispatch",
					reasoningLevel: "medium",
					input: { text: "bounded dispatch fixture", attachments: [] },
				},
			});
			const second = await claim(work.itemId, "worker-2");
			try {
				expect(second.decision).toEqual({ outcome: "busy" });
			} finally {
				await second.store.close();
			}
			const row = await dispatchState(work);
			expect(row).toMatchObject({
				status: "processing",
				outbox_fence: 1,
				execution_status: "unknown",
				execution_fence: 1,
			});
		} finally {
			await first.store.close();
		}
	});

	it("preserves V1 recovery for a legacy outbox without frozen selection", async () => {
		const work = await seed("conversation.turn.submit.v1", {
			legacySelection: true,
		});
		const { store, decision } = await claim(work.itemId);
		try {
			expect(decision).toMatchObject({
				outcome: "claimed",
				claim: {
					modelConfigurationRevision: null,
					modelOptionId: null,
					reasoningLevel: null,
				},
			});
		} finally {
			await store.close();
		}
	});

	it("rechecks a pending stop in the same Conversation claim", async () => {
		const work = await seed();
		await client`
			insert into platform.conversation_stops
				(execution_id, stop_request_id, status, created_at, updated_at)
			values (${work.executionId}, ${work.stopRequestId}, 'submitted', now(), now())
		`;
		const { store, decision } = await claim(work.itemId);
		try {
			expect(decision).toMatchObject({
				outcome: "claimed",
				claim: { stopPending: true },
			});
		} finally {
			await store.close();
		}
	});

	it("invalidates a claim when stop becomes pending during authorization", async () => {
		const work = await seed();
		const { store, decision } = await claim(work.itemId);
		try {
			if (decision.outcome !== "claimed") throw new Error("Expected claim");
			await client`
				insert into platform.conversation_stops
					(execution_id, stop_request_id, status, created_at, updated_at)
				values (${work.executionId}, ${work.stopRequestId}, 'submitted', now(), now())
			`;
			await expect(
				store.renew({ claim: decision.claim, leaseDurationMs: 30_000 }),
			).resolves.toBe(false);
		} finally {
			await store.close();
		}
	});

	it("persists the opaque Host ref and terminal result before completing outbox", async () => {
		const work = await seed();
		const { store, decision } = await claim(work.itemId);
		try {
			if (decision.outcome !== "claimed") throw new Error("Expected claim");
			await expect(
				store.recordRuntimeResponse({
					claim: decision.claim,
					hostSessionRef: "host-session-dispatch",
					transition: {
						executionStatus: "processing",
						conversationStatus: "active",
					},
				}),
			).resolves.toBe(true);
			await expect(
				store.recordEventStatus({
					claim: decision.claim,
					transition: {
						executionStatus: "completed",
						conversationStatus: "ready",
					},
				}),
			).resolves.toBe(true);
			await expect(
				store.finish({
					claim: decision.claim,
					status: "succeeded",
					transition: {
						executionStatus: "completed",
						conversationStatus: "ready",
					},
				}),
			).resolves.toBe(true);
			const [state] = await client`
				select c.host_session_ref, c.status as conversation_status,
					e.status as execution_status, o.status as outbox_status,
					(select count(*)::int from platform.persisted_events
					 where stream_id = ${`outbox:${work.itemId}`}) as attempt_events
				from platform.conversations c
				join platform.conversation_executions e on e.conversation_id = c.id
				join platform.outbox_items o on o.id = ${work.itemId}
				where c.id = ${work.conversationId}
			`;
			expect(state).toEqual({
				host_session_ref: "host-session-dispatch",
				conversation_status: "ready",
				execution_status: "completed",
				outbox_status: "succeeded",
				attempt_events: 1,
			});
			await expect(
				store.claim({
					schemaVersion: 1,
					itemId: work.itemId,
					workerId: "worker-2",
					leaseDurationMs: 30_000,
				}),
			).resolves.toEqual({ outcome: "succeeded" });
		} finally {
			await store.close();
		}
	});

	it("invalidates an expired Worker's result after fence takeover", async () => {
		const work = await seed();
		const first = await claim(work.itemId, "worker-old", 30_000);
		if (first.decision.outcome !== "claimed") throw new Error("Expected claim");
		await client`
			update platform.outbox_items
			set lease_expires_at = clock_timestamp() - interval '1 second'
			where id = ${work.itemId}
		`;
		const second = await claim(work.itemId, "worker-new", 30_000);
		try {
			if (second.decision.outcome !== "claimed")
				throw new Error("Expected takeover");
			expect(second.decision.claim.deliveryFence).toBe(2);
			expect(second.decision.claim.executionDeliveryFence).toBe(2);
			await expect(
				first.store.recordRuntimeResponse({
					claim: first.decision.claim,
					hostSessionRef: "host-session-stale",
					transition: { executionStatus: "processing" },
				}),
			).resolves.toBe(false);
			await expect(
				second.store.recordRuntimeResponse({
					claim: second.decision.claim,
					hostSessionRef: "host-session-current",
					transition: { executionStatus: "processing" },
				}),
			).resolves.toBe(true);
		} finally {
			await first.store.close();
			await second.store.close();
		}
	});

	it("keeps supplementary and stop fences independent from the Execution fence", async () => {
		for (const operation of [
			"conversation.turn.supplement.v1",
			"conversation.turn.stop.v1",
		] as const) {
			const work = await seed(operation, {
				executionStatus: "processing",
				executionFence: 7,
				hostSessionRef: "host-session-existing",
			});
			const { store, decision } = await claim(work.itemId);
			try {
				if (decision.outcome !== "claimed") throw new Error("Expected claim");
				expect(decision.claim.deliveryFence).toBe(1);
				expect(decision.claim.executionDeliveryFence).toBe(7);
				await expect(
					store.finish({
						claim: decision.claim,
						status: "succeeded",
						transition:
							operation === "conversation.turn.stop.v1"
								? {
										executionStatus: "cancelled",
										conversationStatus: "ready",
									}
								: {},
					}),
				).resolves.toBe(true);
				const [execution] = await client`
					select delivery_fence::int as fence, status
					from platform.conversation_executions
					where execution_id = ${work.executionId}
				`;
				expect(execution?.fence).toBe(7);
				expect(execution?.status).toBe(
					operation === "conversation.turn.stop.v1"
						? "cancelled"
						: "processing",
				);
				if (operation === "conversation.turn.stop.v1") {
					const [stop] = await client`
						select status from platform.conversation_stops
						where execution_id = ${work.executionId}
					`;
					expect(stop?.status).toBe("completed");
				}
			} finally {
				await store.close();
			}
		}
	});

	it.each([
		["stale generation", { sessionGeneration: 2 }],
		["selection mismatch", { modelOptionId: "other-model-option" }],
		["raw native field", { nativeSessionId: "must-not-cross" }],
	])("rejects %s payloads without changing state", async (_case, extra) => {
		const work = await seed();
		const [row] = await client<{ payload: Record<string, unknown> }[]>`
			select payload from platform.outbox_items where id = ${work.itemId}
		`;
		await client`
			update platform.outbox_items
			set payload = ${client.json({ ...row?.payload, ...extra })}
			where id = ${work.itemId}
		`;
		const { store, decision } = await claim(work.itemId);
		try {
			expect(decision).toEqual({ outcome: "stale" });
			const state = await dispatchState(work);
			expect(state).toMatchObject({
				status: "pending",
				outbox_fence: 0,
				execution_status: "submitted",
				execution_fence: 0,
			});
		} finally {
			await store.close();
		}
	});

	it("rolls back outbox claiming when the Execution transition fails", async () => {
		const work = await seed();
		await client.unsafe(`
			create function platform.conversation_dispatch_failure()
			returns trigger language plpgsql as $$
			begin
				raise exception 'injected dispatch failure';
			end
			$$
		`);
		await client.unsafe(`
			create trigger conversation_dispatch_failure
			before update on platform.conversation_executions
			for each row execute function platform.conversation_dispatch_failure()
		`);
		const store = open();
		try {
			await expect(
				store.claim({
					schemaVersion: 1,
					itemId: work.itemId,
					workerId: "worker-1",
					leaseDurationMs: 30_000,
				}),
			).rejects.toMatchObject({ code: "CONVERSATION_DISPATCH_STORE_ERROR" });
			const state = await dispatchState(work);
			expect(state).toMatchObject({
				status: "pending",
				outbox_fence: 0,
				execution_status: "submitted",
				execution_fence: 0,
			});
		} finally {
			await store.close();
		}
	});
});
