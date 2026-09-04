import {
	type ConversationExecutionAuthorityV1,
	type ConversationExecutionUseCaseV1,
	createConversationExecutionUseCaseV1,
} from "@agent-infra/platform-core";
import { FakeConversationExecutionV1 } from "@agent-infra/platform-core/testing";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PostgresConversationExecutionTransactionV1 } from "./conversation-execution.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

const authority: ConversationExecutionAuthorityV1 = {
	schemaVersion: 1,
	actorId: "user_01",
	agentId: "agent_01",
	channelId: "web",
	authorizationRevision: "authorization_01",
	supportsSupplementaryInstruction: true,
};

let databaseUrl = "";
let client: ReturnType<typeof postgres>;
let testDatabase: PostgresTestDatabase | undefined;

const failureTable = {
	idempotency: "platform.idempotency_records",
	execution: "platform.conversation_executions",
	message: "platform.conversation_messages",
	outbox: "platform.outbox_items",
	audit: "platform.conversation_audit_events",
	commit: "platform.conversation_audit_events",
} as const;

type FailurePoint = keyof typeof failureTable;

interface ConversationConformanceHarness {
	readonly useCase: ConversationExecutionUseCaseV1;
	setAuthority(next: ConversationExecutionAuthorityV1): void;
	completeExecution(executionId: string): Promise<void>;
	close(): Promise<void>;
}

beforeAll(async () => {
	testDatabase = await startPostgresTestDatabase("conversation-execution");
	databaseUrl = testDatabase.databaseUrl;
	await migratePlatformDatabase({ databaseUrl });
	client = postgres(databaseUrl, { max: 1 });
}, 120_000);

afterEach(async () => {
	await client`truncate platform.conversation_audit_events, platform.audit_events,
		platform.outbox_items,
		platform.idempotency_records, platform.conversation_stops,
		platform.conversation_messages, platform.conversation_executions,
		platform.conversations`;
});

conversationCommandConformance(
	"Fake Conversation command conformance",
	async () => {
		let effectiveAuthority = authority;
		let nextId = 1;
		const fake = new FakeConversationExecutionV1({
			authorization: {
				async authorize() {
					return {
						outcome: "allowed",
						authority: structuredClone(effectiveAuthority),
					};
				},
			},
			now: () => new Date("2026-09-04T00:00:00.000Z"),
			newId: () => `conformance_${nextId++}`,
		});
		return {
			useCase: fake,
			setAuthority(next) {
				effectiveAuthority = structuredClone(next);
			},
			async completeExecution(executionId) {
				fake.completeExecution(executionId);
			},
			async close() {},
		};
	},
);

conversationCommandConformance(
	"PostgreSQL Conversation command conformance",
	async () => {
		let effectiveAuthority = authority;
		let nextId = 1;
		const transaction = new PostgresConversationExecutionTransactionV1({
			databaseUrl,
		});
		const useCase = createConversationExecutionUseCaseV1(
			{
				authorization: {
					async authorize() {
						return {
							outcome: "allowed",
							authority: structuredClone(effectiveAuthority),
						};
					},
				},
				transaction,
			},
			{
				now: () => new Date("2026-09-04T00:00:00.000Z"),
				newId: () => `conformance_${nextId++}`,
			},
		);
		return {
			useCase,
			setAuthority(next) {
				effectiveAuthority = structuredClone(next);
			},
			async completeExecution(executionId) {
				await client`
					update platform.conversation_executions
					set status = 'completed'
					where execution_id = ${executionId}
				`;
			},
			close: () => transaction.close(),
		};
	},
);

afterAll(async () => {
	await client?.end();
	await testDatabase?.stop();
});

function createConversation(
	resolvedAuthority: ConversationExecutionAuthorityV1 = authority,
) {
	let nextId = 1;
	const transaction = new PostgresConversationExecutionTransactionV1({
		databaseUrl,
	});
	return {
		transaction,
		useCase: createConversationExecutionUseCaseV1(
			{
				authorization: {
					async authorize() {
						return { outcome: "allowed", authority: resolvedAuthority };
					},
				},
				transaction,
			},
			{
				now: () => new Date("2026-09-04T00:00:00.000Z"),
				newId: () => `conversation_id_${nextId++}`,
			},
		),
	};
}

async function armFailure(point: FailurePoint): Promise<void> {
	const functionName = `platform.conversation_execution_fail_${point}`;
	const triggerName = `conversation_execution_fail_${point}`;
	await client.unsafe(`
		create function ${functionName}() returns trigger language plpgsql as $$
		begin
			raise exception 'injected conversation execution failure';
		end
		$$
	`);
	await client.unsafe(
		point === "commit"
			? `create constraint trigger ${triggerName} after insert on ${failureTable[point]}
				deferrable initially deferred for each row execute function ${functionName}()`
			: `create trigger ${triggerName} before insert on ${failureTable[point]}
				for each row execute function ${functionName}()`,
	);
}

async function disarmFailure(point: FailurePoint): Promise<void> {
	const functionName = `platform.conversation_execution_fail_${point}`;
	const triggerName = `conversation_execution_fail_${point}`;
	await client.unsafe(
		`drop trigger if exists ${triggerName} on ${failureTable[point]}`,
	);
	await client.unsafe(`drop function if exists ${functionName}()`);
}

function conversationCommandConformance(
	name: string,
	open: () => Promise<ConversationConformanceHarness>,
): void {
	describe(name, () => {
		it("accepts, replays, conflicts, fences busy, regenerates, and stops identically", async () => {
			const harness = await open();
			try {
				const create = {
					schemaVersion: 1 as const,
					agentId: authority.agentId,
					idempotencyKey: "conformance_create",
					requestId: "conformance_request_create",
					traceId: "conformance_trace_create",
				};
				expect(await harness.useCase.createConversation(create)).toMatchObject({
					outcome: "accepted",
				});
				expect(await harness.useCase.createConversation(create)).toMatchObject({
					outcome: "replayed",
				});

				const initial = await harness.useCase.accept({
					schemaVersion: 1,
					command: "message",
					conversationId: "conformance_1",
					text: "initial",
					idempotencyKey: "conformance_message",
					requestId: "conformance_request_message",
					traceId: "conformance_trace_message",
				});
				if (
					initial.outcome !== "accepted" ||
					initial.result.messageId === null
				) {
					throw new Error("Expected an accepted initial message");
				}
				expect(await harness.useCase.createConversation(create)).toMatchObject({
					outcome: "replayed",
				});
				expect(
					await harness.useCase.accept({
						schemaVersion: 1,
						command: "message",
						conversationId: "conformance_1",
						text: "initial",
						idempotencyKey: "conformance_message",
						requestId: "conformance_request_message_retry",
						traceId: "conformance_trace_message_retry",
					}),
				).toEqual({ outcome: "replayed", result: initial.result });
				expect(
					await harness.useCase.accept({
						schemaVersion: 1,
						command: "message",
						conversationId: "conformance_1",
						text: "changed",
						idempotencyKey: "conformance_message",
						requestId: "conformance_request_message_conflict",
						traceId: "conformance_trace_message_conflict",
					}),
				).toEqual({ outcome: "conflict", reason: "idempotency_conflict" });

				harness.setAuthority({
					...authority,
					supportsSupplementaryInstruction: false,
				});
				expect(
					await harness.useCase.accept({
						schemaVersion: 1,
						command: "message",
						conversationId: "conformance_1",
						text: "busy",
						idempotencyKey: "conformance_busy",
						requestId: "conformance_request_busy",
						traceId: "conformance_trace_busy",
					}),
				).toEqual({ outcome: "busy" });
				harness.setAuthority({ ...authority, actorId: "foreign_actor" });
				expect(
					await harness.useCase.accept({
						schemaVersion: 1,
						command: "message",
						conversationId: "conformance_1",
						text: "foreign",
						idempotencyKey: "conformance_foreign",
						requestId: "conformance_request_foreign",
						traceId: "conformance_trace_foreign",
					}),
				).toEqual({ outcome: "denied" });
				harness.setAuthority(authority);

				const stopped = await harness.useCase.stop({
					schemaVersion: 1,
					command: "stop",
					conversationId: "conformance_1",
					targetExecutionId: initial.result.executionId,
					idempotencyKey: "conformance_stop",
					requestId: "conformance_request_stop",
					traceId: "conformance_trace_stop",
				});
				expect(stopped).toMatchObject({ outcome: "accepted" });
				expect(
					await harness.useCase.stop({
						schemaVersion: 1,
						command: "stop",
						conversationId: "conformance_1",
						targetExecutionId: initial.result.executionId,
						idempotencyKey: "conformance_stop_second_key",
						requestId: "conformance_request_stop_retry",
						traceId: "conformance_trace_stop_retry",
					}),
				).toMatchObject({ outcome: "replayed" });

				await harness.completeExecution(initial.result.executionId);
				const regenerated = await harness.useCase.regenerate({
					schemaVersion: 1,
					command: "regenerate",
					conversationId: "conformance_1",
					sourceMessageId: initial.result.messageId,
					idempotencyKey: "conformance_regenerate",
					requestId: "conformance_request_regenerate",
					traceId: "conformance_trace_regenerate",
				});
				if (regenerated.outcome !== "accepted") {
					throw new Error("Expected an accepted regeneration");
				}
				expect(
					await harness.useCase.regenerate({
						schemaVersion: 1,
						command: "regenerate",
						conversationId: "conformance_1",
						sourceMessageId: initial.result.messageId,
						idempotencyKey: "conformance_regenerate",
						requestId: "conformance_request_regenerate_retry",
						traceId: "conformance_trace_regenerate_retry",
					}),
				).toEqual({ outcome: "replayed", result: regenerated.result });
			} finally {
				await harness.close();
			}
		});
	});
}

describe("PostgreSQL Conversation command transaction", () => {
	it("atomically accepts an initial message through the Core transaction seam", async () => {
		const { transaction, useCase } = createConversation();
		try {
			await expect(
				useCase.createConversation({
					schemaVersion: 1,
					agentId: authority.agentId,
					idempotencyKey: "create_01",
					requestId: "request_create_01",
					traceId: "trace_create_01",
				}),
			).resolves.toEqual({
				outcome: "accepted",
				result: {
					schemaVersion: 1,
					conversationId: "conversation_id_1",
					agentId: authority.agentId,
					status: "ready",
				},
			});

			await expect(
				useCase.accept({
					schemaVersion: 1,
					command: "message",
					conversationId: "conversation_id_1",
					text: "do not persist this in audit",
					idempotencyKey: "message_01",
					requestId: "request_message_01",
					traceId: "trace_message_01",
				}),
			).resolves.toEqual({
				outcome: "accepted",
				result: {
					schemaVersion: 1,
					status: "submitted",
					messageId: "conversation_id_2",
					executionId: "conversation_id_3",
				},
			});

			const [counts, audit, auditRecord, outbox] = await Promise.all([
				client`
					select
						(select count(*)::int from platform.conversations) as conversations,
						(select count(*)::int from platform.conversation_messages) as messages,
						(select count(*)::int from platform.conversation_executions) as executions,
						(select count(*)::int from platform.outbox_items) as outbox,
						(select count(*)::int from platform.idempotency_records) as idempotency,
						(select count(*)::int from platform.conversation_audit_events) as audit,
						(select count(*)::int from platform.audit_events) as platform_audit
				`,
				client`
					select action, conversation_id, execution_id
					from platform.conversation_audit_events
					where action = 'conversation.message.accepted'
				`,
				client`
					select to_jsonb(conversation_audit_events) as record
					from platform.conversation_audit_events
					where action = 'conversation.message.accepted'
				`,
				client`
					select payload from platform.outbox_items
					where operation = 'conversation.turn.submit.v1'
				`,
			]);
			expect(counts[0]).toEqual({
				conversations: 1,
				messages: 1,
				executions: 1,
				outbox: 1,
				idempotency: 2,
				audit: 1,
				platform_audit: 0,
			});
			expect(audit).toEqual([
				{
					action: "conversation.message.accepted",
					conversation_id: "conversation_id_1",
					execution_id: "conversation_id_3",
				},
			]);
			expect(JSON.stringify(auditRecord)).not.toContain(
				"do not persist this in audit",
			);
			expect(JSON.stringify(outbox)).not.toContain(
				"do not persist this in audit",
			);
		} finally {
			await transaction.close();
		}
	});

	it("regenerates from an existing user message without creating another message", async () => {
		const { transaction, useCase } = createConversation();
		try {
			await useCase.createConversation({
				schemaVersion: 1,
				agentId: authority.agentId,
				idempotencyKey: "create_02",
				requestId: "request_create_02",
				traceId: "trace_create_02",
			});
			const initial = await useCase.accept({
				schemaVersion: 1,
				command: "message",
				conversationId: "conversation_id_1",
				text: "regenerate this answer",
				idempotencyKey: "message_02",
				requestId: "request_message_02",
				traceId: "trace_message_02",
			});
			expect(initial).toMatchObject({ outcome: "accepted" });
			await client`
				update platform.conversation_executions
				set status = 'completed'
				where execution_id = 'conversation_id_3'
			`;

			await expect(
				useCase.regenerate({
					schemaVersion: 1,
					command: "regenerate",
					conversationId: "conversation_id_1",
					sourceMessageId: "conversation_id_2",
					idempotencyKey: "regenerate_02",
					requestId: "request_regenerate_02",
					traceId: "trace_regenerate_02",
				}),
			).resolves.toEqual({
				outcome: "accepted",
				result: {
					schemaVersion: 1,
					status: "submitted",
					messageId: null,
					executionId: "conversation_id_5",
				},
			});

			const [counts, outbox, audit] = await Promise.all([
				client`
					select
						(select count(*)::int from platform.conversation_messages) as messages,
						(select count(*)::int from platform.conversation_executions) as executions,
						(select count(*)::int from platform.outbox_items) as outbox,
						(select count(*)::int from platform.idempotency_records) as idempotency,
						(select count(*)::int from platform.conversation_audit_events) as audit
				`,
				client`
					select operation, payload from platform.outbox_items
					where operation = 'conversation.turn.regenerate.v1'
				`,
				client`
					select action, conversation_id, execution_id
					from platform.conversation_audit_events
					where action = 'conversation.regeneration.accepted'
				`,
			]);
			expect(counts[0]).toEqual({
				messages: 1,
				executions: 2,
				outbox: 2,
				idempotency: 3,
				audit: 2,
			});
			expect(outbox).toEqual([
				{
					operation: "conversation.turn.regenerate.v1",
					payload: {
						schemaVersion: 1,
						conversationId: "conversation_id_1",
						executionId: "conversation_id_5",
						messageId: "conversation_id_2",
						turnId: "conversation_id_6",
						sessionGeneration: 1,
					},
				},
			]);
			expect(audit).toEqual([
				{
					action: "conversation.regeneration.accepted",
					conversation_id: "conversation_id_1",
					execution_id: "conversation_id_5",
				},
			]);
		} finally {
			await transaction.close();
		}
	});

	it("creates one stable stop request for a target execution", async () => {
		const { transaction, useCase } = createConversation();
		try {
			await useCase.createConversation({
				schemaVersion: 1,
				agentId: authority.agentId,
				idempotencyKey: "create_03",
				requestId: "request_create_03",
				traceId: "trace_create_03",
			});
			await useCase.accept({
				schemaVersion: 1,
				command: "message",
				conversationId: "conversation_id_1",
				text: "stop this answer",
				idempotencyKey: "message_03",
				requestId: "request_message_03",
				traceId: "trace_message_03",
			});

			await expect(
				useCase.stop({
					schemaVersion: 1,
					command: "stop",
					conversationId: "conversation_id_1",
					targetExecutionId: "conversation_id_3",
					idempotencyKey: "stop_03",
					requestId: "request_stop_03",
					traceId: "trace_stop_03",
				}),
			).resolves.toEqual({
				outcome: "accepted",
				result: {
					schemaVersion: 1,
					status: "submitted",
					executionId: "conversation_id_3",
				},
			});
			await expect(
				useCase.stop({
					schemaVersion: 1,
					command: "stop",
					conversationId: "conversation_id_1",
					targetExecutionId: "conversation_id_3",
					idempotencyKey: "stop_03_second_key",
					requestId: "request_stop_03_second_key",
					traceId: "trace_stop_03_second_key",
				}),
			).resolves.toEqual({
				outcome: "replayed",
				result: {
					schemaVersion: 1,
					status: "submitted",
					executionId: "conversation_id_3",
				},
			});

			const [counts, stops, outbox, audit] = await Promise.all([
				client`
					select
						(select count(*)::int from platform.conversation_stops) as stops,
						(select count(*)::int from platform.outbox_items) as outbox,
						(select count(*)::int from platform.idempotency_records) as idempotency,
						(select count(*)::int from platform.conversation_audit_events) as audit
				`,
				client`
					select execution_id, stop_request_id, status
					from platform.conversation_stops
				`,
				client`
					select operation, payload from platform.outbox_items
					where operation = 'conversation.turn.stop.v1'
				`,
				client`
					select action, conversation_id, execution_id
					from platform.conversation_audit_events
					where action = 'conversation.stop.accepted'
				`,
			]);
			expect(counts[0]).toEqual({
				stops: 1,
				outbox: 2,
				idempotency: 4,
				audit: 2,
			});
			expect(stops).toEqual([
				{
					execution_id: "conversation_id_3",
					stop_request_id: "conversation_id_5",
					status: "submitted",
				},
			]);
			expect(outbox).toEqual([
				{
					operation: "conversation.turn.stop.v1",
					payload: {
						schemaVersion: 1,
						conversationId: "conversation_id_1",
						executionId: "conversation_id_3",
						sessionGeneration: 1,
						stopRequestId: "conversation_id_5",
					},
				},
			]);
			expect(audit).toEqual([
				{
					action: "conversation.stop.accepted",
					conversation_id: "conversation_id_1",
					execution_id: "conversation_id_3",
				},
			]);
		} finally {
			await transaction.close();
		}
	});

	it("serializes replay, conflict, busy, and foreign binding paths without duplicate effects", async () => {
		const primary = createConversation();
		const noSupplement = createConversation({
			...authority,
			supportsSupplementaryInstruction: false,
		});
		const foreign = createConversation({
			...authority,
			actorId: "user_other",
		});
		const foreignAgent = createConversation({
			...authority,
			agentId: "agent_other",
		});
		try {
			await primary.useCase.createConversation({
				schemaVersion: 1,
				agentId: authority.agentId,
				idempotencyKey: "create_04",
				requestId: "request_create_04",
				traceId: "trace_create_04",
			});
			await primary.useCase.accept({
				schemaVersion: 1,
				command: "message",
				conversationId: "conversation_id_1",
				text: "start the turn",
				idempotencyKey: "message_04_initial",
				requestId: "request_message_04_initial",
				traceId: "trace_message_04_initial",
			});
			const supplement = {
				schemaVersion: 1 as const,
				command: "message" as const,
				conversationId: "conversation_id_1",
				text: "one logical supplement",
				idempotencyKey: "message_04_supplement",
				requestId: "request_message_04_supplement",
				traceId: "trace_message_04_supplement",
			};
			const [first, second] = await Promise.all([
				primary.useCase.accept(supplement),
				primary.useCase.accept(supplement),
			]);
			expect([first.outcome, second.outcome].toSorted()).toEqual([
				"accepted",
				"replayed",
			]);
			if (
				(first.outcome !== "accepted" && first.outcome !== "replayed") ||
				(second.outcome !== "accepted" && second.outcome !== "replayed")
			) {
				throw new Error("Expected one accepted and one replayed supplement");
			}
			expect(first.result).toEqual(second.result);
			expect(
				await primary.useCase.accept({
					...supplement,
					text: "changed content",
				}),
			).toEqual({ outcome: "conflict", reason: "idempotency_conflict" });
			expect(
				await noSupplement.useCase.accept({
					...supplement,
					idempotencyKey: "message_04_busy",
				}),
			).toEqual({ outcome: "busy" });
			expect(
				await foreign.useCase.accept({
					...supplement,
					idempotencyKey: "message_04_foreign",
				}),
			).toEqual({ outcome: "denied" });
			expect(
				await foreignAgent.useCase.accept({
					...supplement,
					idempotencyKey: "message_04_foreign_agent",
				}),
			).toEqual({ outcome: "denied" });
			expect(
				await client`
					select
						(select count(*)::int from platform.conversation_messages) as messages,
						(select count(*)::int from platform.conversation_executions) as executions,
						(select count(*)::int from platform.outbox_items) as outbox,
						(select count(*)::int from platform.idempotency_records) as idempotency,
						(select count(*)::int from platform.conversation_audit_events) as audit
				`,
			).toEqual([
				{
					messages: 2,
					executions: 1,
					outbox: 2,
					idempotency: 3,
					audit: 2,
				},
			]);
		} finally {
			await Promise.all([
				primary.transaction.close(),
				noSupplement.transaction.close(),
				foreign.transaction.close(),
				foreignAgent.transaction.close(),
			]);
		}
	});

	it("serializes concurrent same-key conversation creation", async () => {
		const first = createConversation();
		const second = createConversation();
		const command = {
			schemaVersion: 1 as const,
			agentId: authority.agentId,
			idempotencyKey: "concurrent_create",
			requestId: "request_concurrent_create",
			traceId: "trace_concurrent_create",
		};
		try {
			const results = await Promise.all([
				first.useCase.createConversation(command),
				second.useCase.createConversation(command),
			]);
			expect(results.map(({ outcome }) => outcome).toSorted()).toEqual([
				"accepted",
				"replayed",
			]);
			if (
				(results[0]?.outcome !== "accepted" &&
					results[0]?.outcome !== "replayed") ||
				(results[1]?.outcome !== "accepted" &&
					results[1]?.outcome !== "replayed")
			) {
				throw new Error("Expected accepted and replayed creates");
			}
			expect(results[0].result).toEqual(results[1].result);
			expect(
				await client`
					select
						(select count(*)::int from platform.conversations) as conversations,
						(select count(*)::int from platform.idempotency_records) as idempotency
				`,
			).toEqual([{ conversations: 1, idempotency: 1 }]);
		} finally {
			await Promise.all([
				first.transaction.close(),
				second.transaction.close(),
			]);
		}
	});

	it("rolls back every initial-message write boundary", async () => {
		const { transaction, useCase } = createConversation();
		try {
			await useCase.createConversation({
				schemaVersion: 1,
				agentId: authority.agentId,
				idempotencyKey: "create_rollback",
				requestId: "request_create_rollback",
				traceId: "trace_create_rollback",
			});
			for (const point of Object.keys(failureTable) as FailurePoint[]) {
				await armFailure(point);
				try {
					await expect(
						useCase.accept({
							schemaVersion: 1,
							command: "message",
							conversationId: "conversation_id_1",
							text: `rollback ${point}`,
							idempotencyKey: `message_rollback_${point}`,
							requestId: `request_rollback_${point}`,
							traceId: `trace_rollback_${point}`,
						}),
					).rejects.toMatchObject({
						name: "ConversationExecutionError",
						code: "unavailable",
					});
				} finally {
					await disarmFailure(point);
				}
				expect(
					await client`
						select
							(select status from platform.conversations
								where id = 'conversation_id_1') as conversation_status,
							(select count(*)::int from platform.conversation_messages) as messages,
							(select count(*)::int from platform.conversation_executions) as executions,
							(select count(*)::int from platform.outbox_items) as outbox,
							(select count(*)::int from platform.conversation_audit_events) as audit,
							(select count(*)::int from platform.idempotency_records) as idempotency
					`,
				).toEqual([
					{
						conversation_status: "ready",
						messages: 0,
						executions: 0,
						outbox: 0,
						audit: 0,
						idempotency: 1,
					},
				]);
			}
		} finally {
			await transaction.close();
		}
	});

	it("fails closed when an internal create plan does not match its result", async () => {
		const transaction = new PostgresConversationExecutionTransactionV1({
			databaseUrl,
		});
		try {
			await expect(
				transaction.createConversation(
					{
						command: {
							schemaVersion: 1,
							agentId: authority.agentId,
							idempotencyKey: "invalid_internal_plan",
							requestId: "request_invalid_internal_plan",
							traceId: "trace_invalid_internal_plan",
						},
						authority,
						requestDigest: "a".repeat(64),
					},
					() => ({
						schemaVersion: 1,
						conversation: {
							schemaVersion: 1,
							conversationId: "invalid_plan_conversation",
							agentId: authority.agentId,
							actorId: authority.actorId,
							channelId: authority.channelId,
							status: "ready",
							sessionGeneration: 1,
							hostSessionRef: null,
							authorizationRevision: authority.authorizationRevision,
							lastConversationCursor: 0,
						},
						result: {
							schemaVersion: 1,
							conversationId: "different_result_conversation",
							agentId: authority.agentId,
							status: "ready",
						},
						idempotency: {
							scopeType: "agent",
							scopeId: authority.agentId,
							actorId: authority.actorId,
							channelId: authority.channelId,
							commandType: "conversation.create",
							key: "invalid_internal_plan",
							requestDigest: "a".repeat(64),
						},
					}),
				),
			).rejects.toMatchObject({
				name: "ConversationExecutionError",
				code: "unavailable",
			});
			expect(
				await client`
					select
						(select count(*)::int from platform.conversations) as conversations,
						(select count(*)::int from platform.idempotency_records) as idempotency
				`,
			).toEqual([{ conversations: 0, idempotency: 0 }]);
		} finally {
			await transaction.close();
		}
	});

	it("records terminal stop idempotency without creating a stop side effect", async () => {
		const { transaction, useCase } = createConversation();
		try {
			await useCase.createConversation({
				schemaVersion: 1,
				agentId: authority.agentId,
				idempotencyKey: "create_terminal_stop",
				requestId: "request_create_terminal_stop",
				traceId: "trace_create_terminal_stop",
			});
			await useCase.accept({
				schemaVersion: 1,
				command: "message",
				conversationId: "conversation_id_1",
				text: "finish before stopping",
				idempotencyKey: "message_terminal_stop",
				requestId: "request_message_terminal_stop",
				traceId: "trace_message_terminal_stop",
			});
			await client`
				update platform.conversation_executions
				set status = 'completed'
				where execution_id = 'conversation_id_3'
			`;
			const stop = {
				schemaVersion: 1 as const,
				command: "stop" as const,
				conversationId: "conversation_id_1",
				targetExecutionId: "conversation_id_3",
				idempotencyKey: "terminal_stop",
				requestId: "request_terminal_stop",
				traceId: "trace_terminal_stop",
			};
			expect(await useCase.stop(stop)).toEqual({
				outcome: "accepted",
				result: {
					schemaVersion: 1,
					status: "already_finished",
					executionId: "conversation_id_3",
				},
			});
			expect(await useCase.stop(stop)).toEqual({
				outcome: "replayed",
				result: {
					schemaVersion: 1,
					status: "already_finished",
					executionId: "conversation_id_3",
				},
			});
			expect(
				await client`
					select
						(select count(*)::int from platform.conversation_stops) as stops,
						(select count(*)::int from platform.outbox_items) as outbox,
						(select count(*)::int from platform.conversation_audit_events) as audit,
						(select count(*)::int from platform.idempotency_records) as idempotency
				`,
			).toEqual([{ stops: 0, outbox: 1, audit: 1, idempotency: 3 }]);
		} finally {
			await transaction.close();
		}
	});
});
