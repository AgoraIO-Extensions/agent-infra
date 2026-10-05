import { generateKeyPairSync } from "node:crypto";
import { createRuntimeExecutionGrantVerifierV2 } from "@agent-infra/agent-runtime";
import {
	createConversationDispatchUseCaseV1,
	createConversationEventUseCaseV1,
} from "@agent-infra/platform-core";
import {
	PostgresConversationDispatchStoreV1,
	PostgresConversationEventTransactionV1,
	PostgresTaskAuthorizationStoreV1,
} from "@agent-infra/platform-store";
import postgres from "postgres";
import { expect, it } from "vitest";
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.js";
import { startPostgresTestDatabase } from "../../../packages/platform-store/src/postgres-test.js";
import { seedSessionSandboxFixture } from "../../../packages/platform-store/src/session-sandbox.fixture.js";
import { createConversationRuntimeV2 } from "./conversation-runtime.js";

// Real PostgreSQL, Worker authorization/transport and Core/Store CAS. The Host
// response and original retained admission are controlled inputs, not native V4
// acceptance, an Execution Key installation or identity/provider verification.
it("recovers only the original control ref through production Worker/Core and PostgreSQL CAS", async () => {
	const database = await startPostgresTestDatabase("1070-control-binding");
	const sql = postgres(database.databaseUrl, { max: 2 });
	const store = new PostgresConversationDispatchStoreV1(database);
	const authorizationStore = new PostgresTaskAuthorizationStoreV1(database);
	const eventTransaction = new PostgresConversationEventTransactionV1(database);
	const events = createConversationEventUseCaseV1({
		transaction: eventTransaction,
	});
	const keys = generateKeyPairSync("ed25519");
	const verify = createRuntimeExecutionGrantVerifierV2(
		new Map([["1070-signing", keys.publicKey]]),
	);
	const failures: unknown[] = [];
	try {
		await migratePlatformDatabase(database);
		await sql`insert into platform.agents (id, current_configuration_revision, authorization_revision)
			values ('agent-1070', 1, 'authorization-1070')`;
		await sql`insert into platform.agent_applications
			(id, agent_id, applicant_id, name, description, status, trace_id, request_id, submitted_at,
			 management_revision, approval_revision, desired_state, service_availability, workload_revision, fence)
			values ('application-1070', 'agent-1070', 'owner-1070', 'Controlled Agent', 'Controlled fixture',
			 'available', 'trace-1070', 'request-1070', now(), 1, 1, 'running', 'ready', 1, 1)`;
		let ordinal = 0;
		for (const scenario of [
			"submit",
			"regenerate",
			"stop",
			"response_lost",
			"malformed_response",
			"wrong_execution",
			"takeover",
			"persistence_failure",
		] as const) {
			ordinal++;
			const conversationId = `conversation-1070-${ordinal}`;
			const executionId = `execution-1070-${ordinal}`;
			const turnId = `turn-1070-${ordinal}`;
			const messageId = `message-1070-${ordinal}`;
			const stopRequestId = `stop-1070-${ordinal}`;
			const successorId = `successor-1070-${ordinal}`;
			const operation =
				scenario === "regenerate"
					? "conversation.turn.regenerate.v1"
					: "conversation.turn.submit.v1";
			const originItem = `conversation:${scenario === "regenerate" ? "regenerate" : "turn"}:${executionId}`;
			const itemId =
				scenario === "stop" ? `conversation:stop:${stopRequestId}` : originItem;
			const hostSessionRef = `controlled-durable-ref-${ordinal}`;
			await sql`insert into platform.conversations
				(id, agent_id, actor_id, channel_id, status, session_generation, authorization_revision)
				values (${conversationId}, 'agent-1070', 'user-1070', 'web', 'active', 1, 'authorization-1070')`;
			await sql`insert into platform.conversation_executions
					(execution_id, conversation_id, agent_id, actor_id, channel_id, turn_id, status,
					 session_generation, delivery_fence, authorization_revision, model_configuration_revision,
					 model_option_id, reasoning_level, last_runtime_cursor, created_at)
					values (${executionId}, ${conversationId}, 'agent-1070', 'user-1070', 'web', ${turnId},
					 'unknown', 1, 7, 'authorization-1070', 1, 'option-1070', 'high', 'original-cursor', now())`;
			await seedSessionSandboxFixture(sql, conversationId);
			// Unknown owns the active slot. A same-Conversation successor must
			// be rejected by the real constraint, rather than seeded beside it.
			await expect(
				sql`insert into platform.conversation_executions
					(execution_id, conversation_id, agent_id, actor_id, channel_id, turn_id, status,
					 session_generation, delivery_fence, authorization_revision, model_configuration_revision,
					 model_option_id, reasoning_level, created_at)
					values (${successorId}, ${conversationId}, 'agent-1070', 'user-1070', 'web', ${`successor-turn-${ordinal}`},
					 'submitted', 1, 0, 'authorization-1070', 1, 'option-1070', 'high', now())`,
			).rejects.toMatchObject({
				code: "23505",
				constraint_name: "conversation_active_execution_unique",
			});
			await sql`insert into platform.conversation_messages
				(message_id, conversation_id, actor_id, role, text, execution_id, status, created_at)
				values (${messageId}, ${conversationId}, 'user-1070', 'user', 'controlled retained admission', ${executionId}, 'submitted', now())`;
			const payload = {
				schemaVersion: 1,
				conversationId,
				executionId,
				turnId,
				messageId,
				sessionGeneration: 1,
				modelConfigurationRevision: 1,
				modelOptionId: "option-1070",
				reasoningLevel: "high",
			};
			await sql`insert into platform.outbox_items
				(id, scope_type, scope_id, operation, payload, trace_id, request_id, delivery_fence)
				values (${originItem}, 'conversation', ${conversationId}, ${operation}, ${sql.json(payload)}, 'trace-1070', 'request-1070', 7)`;
			await sql`insert into platform.conversation_stops (execution_id, stop_request_id, status, created_at)
				values (${executionId}, ${stopRequestId}, 'submitted', now())`;
			if (scenario === "stop" || scenario === "submit")
				await sql`insert into platform.outbox_items
				(id, scope_type, scope_id, operation, payload, trace_id, request_id)
				values (${`conversation:stop:${stopRequestId}`}, 'conversation', ${conversationId}, 'conversation.turn.stop.v1',
				 ${sql.json({ schemaVersion: 1, conversationId, executionId, sessionGeneration: 1, stopRequestId })}, 'trace-1070', 'request-1070')`;
			const boundary = {
				schemaVersion: 1,
				principal: { kind: "user", id: "user-1070" },
				agentId: "agent-1070",
				channelId: "web",
				identityRevision: "identity-1070",
				agentAuthorizationRevision: "authorization-1070",
				accessSources: [
					{ kind: "organization", organizationId: "organization-1070" },
				],
			};
			await sql`insert into platform.task_authorization_records (id, execution_id, boundary, revoked_at)
				values (${`authorization-record-${ordinal}`}, ${executionId}, ${sql.json(boundary)}, now())`;
			const before =
				await sql`select execution_id, turn_id, session_generation, model_configuration_revision,
				model_option_id, reasoning_level, authorization_revision, last_runtime_cursor, status
				from platform.conversation_executions where conversation_id = ${conversationId} order by execution_id`;
			let calls = 0;
			let phase = "binding";
			const paths: string[] = [];
			let streamController:
				| ReadableStreamDefaultController<Uint8Array>
				| undefined;
			let signalStreamReady: (() => void) | undefined;
			const streamReady = new Promise<void>((resolve) => {
				signalStreamReady = resolve;
			});
			const runtime = createConversationRuntimeV2({
				workerId: "worker-1070",
				signing: {
					issuer: "platform-1070",
					workerId: "transport-1070",
					keyId: "1070-signing",
					privateKey: keys.privateKey,
				},
				directory: {
					async resolveUser() {
						throw new Error("Revoked control must not use directory");
					},
				},
				taskAuthorizationStore: authorizationStore,
				dispatchStore: store,
				async resolveRuntimeHost({ purpose, command }) {
					expect(purpose).toBe("control");
					expect([
						"session.status",
						"turn.stop",
						"events.persist",
						"events.ack",
					]).toContain(command);
					return {
						baseUrl: "http://controlled-host-1070",
						serviceToken: "synthetic-control-transport",
						workerId: "transport-1070",
					};
				},
				async fetch(url, init) {
					calls++;
					const path = new URL(String(url)).pathname.split("/v3/")[1];
					if (!path) throw new Error("Unexpected controlled Runtime path");
					paths.push(path);
					expect(init?.headers).toMatchObject({
						authorization: "Bearer synthetic-control-transport",
					});
					const request = JSON.parse(init?.body as string);
					const verified = verify(request.grant).claims;
					expect(verified).toMatchObject({
						purpose: "control",
						reason:
							phase === "terminal" &&
							path === "events/ack" &&
							request.confirmedCursor === "original-terminal-cursor"
								? "recovery"
								: "authorization_revoked",
						executionId,
						turnId,
					});
					expect(request).toMatchObject({
						hostSessionRef: phase === "binding" ? null : hostSessionRef,
						executionId,
						turnId,
						sessionGeneration: 1,
					});
					expect(request).not.toHaveProperty("input");
					expect(request).not.toHaveProperty("executionKey");
					if (phase !== "binding") {
						const [execution] =
							await sql`select delivery_fence, last_runtime_cursor, status from platform.conversation_executions where execution_id = ${executionId}`;
						expect(request.operation.executionDeliveryFence).toBe(
							Number(execution?.delivery_fence),
						);
						if (path === "status") {
							expect(verified.allowedCommands).toEqual(["session.status"]);
							return Response.json({
								schemaVersion: 3,
								executionId,
								hostSessionRef,
								outcome: "found",
								status: "running",
							});
						}
						if (path === "stops") {
							expect(phase).toBe("stop");
							expect(verified.allowedCommands).toEqual(["turn.stop"]);
							expect(request.operation).toMatchObject({
								kind: "stop",
								id: stopRequestId,
							});
							return Response.json({
								schemaVersion: 3,
								hostSessionRef,
								operationId: stopRequestId,
								result: { outcome: "accepted", status: "running" },
							});
						}
						if (path === "events/ack") {
							expect(verified.allowedCommands).toEqual(["events.ack"]);
							expect(request.confirmedCursor).toBe(
								execution?.last_runtime_cursor,
							);
							if (request.confirmedCursor === "original-terminal-cursor") {
								expect(phase).toBe("terminal");
								expect(execution?.status).toBe("cancelled");
								const [completedStop] =
									await sql`select status from platform.conversation_stops where execution_id = ${executionId} and stop_request_id = ${stopRequestId}`;
								expect(completedStop?.status).toBe("completed");
								const persisted =
									await sql`select event_payload from platform.conversation_events where execution_id = ${executionId} and adapter_event_key = 'original-terminal'`;
								expect(persisted).toHaveLength(1);
								expect(persisted[0]?.event_payload).toEqual({
									type: "execution.status",
									status: "cancelled",
								});
							}
							return Response.json({
								schemaVersion: 3,
								executionId,
								confirmedCursor: request.confirmedCursor,
							});
						}
						if (path === "events/stream") {
							expect(verified.allowedCommands).toEqual(["events.persist"]);
							expect(request.afterCursor).toBe("original-cursor");
							expect(phase).toBe("running");
							return new Response(
								new ReadableStream<Uint8Array>({
									start(controller) {
										streamController = controller;
										signalStreamReady?.();
									},
								}),
								{ headers: { "content-type": "text/event-stream" } },
							);
						}
						throw new Error("Business redispatch or Key delivery forbidden");
					}
					expect(path).toBe("original-binding");
					expect(verified.allowedCommands).toEqual(["session.status"]);
					expect(request.originalOperationDigest).toMatch(
						/^[A-Za-z0-9_-]{43}$/,
					);
					if (scenario === "response_lost")
						throw new Error("Controlled transport response loss");
					if (scenario === "malformed_response")
						return new Response(
							JSON.stringify({
								schemaVersion: 3,
								outcome: "binding_found",
								hostSessionRef,
								executionId,
								status: "running",
							}),
						);
					return new Response(
						JSON.stringify({
							schemaVersion: 3,
							outcome: "binding_found",
							hostSessionRef,
							executionId:
								scenario === "wrong_execution"
									? "foreign-execution"
									: executionId,
						}),
					);
				},
			});
			const record = store.recordRuntimeResponse.bind(store);
			store.recordRuntimeResponse = async (input) => {
				expect(input.transition).toEqual({});
				if (scenario === "takeover") {
					await sql`update platform.outbox_items set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${itemId}`;
					expect(
						(
							await store.claim({
								schemaVersion: 1,
								itemId,
								workerId: "second-worker-1070",
								leaseDurationMs: 30_000,
							})
						).outcome,
					).toBe("claimed");
				}
				if (scenario === "persistence_failure") {
					await sql.unsafe(
						"create function platform.binding_1070_failure() returns trigger language plpgsql as $$ begin raise exception 'controlled binding persistence failure'; end $$",
					);
					await sql.unsafe(
						"create trigger binding_1070_failure before update of host_session_ref on platform.conversations for each row execute function platform.binding_1070_failure()",
					);
				}
				return record(input);
			};
			try {
				const useCase = createConversationDispatchUseCaseV1(
					{
						store,
						authorization: runtime.authorization,
						runtimeHost: runtime.runtimeHost,
						events: {
							async persist() {
								throw new Error(
									"Binding-only cannot acknowledge or persist Runtime events",
								);
							},
						},
					},
					{ leaseDurationMs: 30_000, retryDelayMs: 0 },
				);
				const result = await useCase.dispatch({
					schemaVersion: 1,
					itemId,
					workerId: "worker-1070",
				});
				const success = ["submit", "regenerate", "stop"].includes(scenario);
				expect(result.outcome).toBe(
					success ? "unknown" : scenario === "takeover" ? "stale" : "retry",
				);
				const [conversation] =
					await sql`select host_session_ref, status, session_generation::integer as session_generation, authorization_revision from platform.conversations where id = ${conversationId}`;
				expect(conversation).toEqual({
					host_session_ref: success ? hostSessionRef : null,
					status: "active",
					session_generation: 1,
					authorization_revision: "authorization-1070",
				});
				expect(
					await sql`select execution_id, turn_id, session_generation, model_configuration_revision,
					model_option_id, reasoning_level, authorization_revision, last_runtime_cursor, status
					from platform.conversation_executions where conversation_id = ${conversationId} order by execution_id`,
				).toEqual(before);
				const [stop] =
					await sql`select status from platform.conversation_stops where execution_id = ${executionId}`;
				expect(stop?.status).toBe("submitted");
				const [successor] =
					await sql`select coalesce(sum(delivery_fence), 0) as delivery_fence, count(*) as executions from platform.conversation_executions where execution_id = ${successorId}`;
				expect(Number(successor?.delivery_fence)).toBe(0);
				expect(Number(successor?.executions)).toBe(0);
				expect(calls).toBe(1);
				if (scenario === "submit") {
					// Re-claim the real outbox after ref-only CAS, then use the original
					// status/stop/stream/commit-before-ACK paths with the persisted ref.
					store.recordRuntimeResponse = record;
					const resumed = createConversationDispatchUseCaseV1(
						{
							store,
							authorization: runtime.authorization,
							runtimeHost: runtime.runtimeHost,
							events,
						},
						{ leaseDurationMs: 30_000, retryDelayMs: 0 },
					);
					phase = "running";
					const continuing = resumed.dispatch({
						schemaVersion: 1,
						itemId,
						workerId: "worker-1070",
					});
					try {
						await Promise.race([
							streamReady,
							continuing.then(() => {
								throw new Error("Original stream was not opened");
							}),
						]);
						const [active] =
							await sql`select status, last_runtime_cursor from platform.conversation_executions where execution_id = ${executionId}`;
						expect(active).toEqual({
							status: "processing",
							last_runtime_cursor: "original-cursor",
						});
						phase = "stop";
						expect(
							(
								await resumed.dispatch({
									schemaVersion: 1,
									itemId: `conversation:stop:${stopRequestId}`,
									workerId: "worker-1070",
								})
							).outcome,
						).toBe("accepted");
						phase = "terminal";
						const terminal = {
							schemaVersion: 1,
							executionId,
							adapterEventKey: "original-terminal",
							cursor: "original-terminal-cursor",
							occurredAt: "2026-10-01T02:00:00Z",
							type: "completed",
							payload: { status: "cancelled" },
						};
						streamController?.enqueue(
							new TextEncoder().encode(
								`id: ${terminal.cursor}\nevent: completed\ndata: ${JSON.stringify(terminal)}\n\n`,
							),
						);
						streamController?.close();
						expect((await continuing).outcome).toBe("accepted");
						expect(paths).toEqual([
							"original-binding",
							"status",
							"events/ack",
							"events/stream",
							"stops",
							"events/ack",
						]);
						const [finished] =
							await sql`select execution_id, turn_id, session_generation::integer as session_generation, authorization_revision, last_runtime_cursor, status from platform.conversation_executions where execution_id = ${executionId}`;
						expect(finished).toEqual({
							execution_id: executionId,
							turn_id: turnId,
							session_generation: 1,
							authorization_revision: "authorization-1070",
							last_runtime_cursor: "original-terminal-cursor",
							status: "cancelled",
						});
						const [unclaimed] =
							await sql`select coalesce(sum(delivery_fence), 0) as delivery_fence, count(*) as executions from platform.conversation_executions where execution_id = ${successorId}`;
						expect(Number(unclaimed?.delivery_fence)).toBe(0);
						expect(Number(unclaimed?.executions)).toBe(0);
					} finally {
						runtime.close();
						try {
							streamController?.close();
						} catch {
							/* already closed */
						}
						await continuing;
					}
				}
			} finally {
				store.recordRuntimeResponse = record;
				runtime.close();
				if (scenario === "persistence_failure") {
					await sql.unsafe(
						"drop trigger if exists binding_1070_failure on platform.conversations",
					);
					await sql.unsafe(
						"drop function if exists platform.binding_1070_failure()",
					);
				}
			}
		}
	} catch (error) {
		failures.push(error);
	} finally {
		const closed = await Promise.allSettled([
			store.close(),
			authorizationStore.close(),
			eventTransaction.close(),
			sql.end(),
		]);
		const stopped = await Promise.allSettled([database.stop()]);
		for (const result of [...closed, ...stopped])
			if (result.status === "rejected") failures.push(result.reason);
	}
	if (failures.length)
		throw new AggregateError(failures, "Control binding integration failed");
}, 120_000);
