import { createHash } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "../../../apps/platform-worker/src/kubernetes.fixture.ts";
import { workloadResourceConfigurationHashV1 } from "../../../apps/platform-worker/src/workload-runtime.ts";
import {
	type ConversationDispatchAuthorizationPortV1,
	type ConversationDispatchClaimV1,
	type ConversationRuntimeEvent,
	ConversationRuntimeHostError,
	type ConversationRuntimeHostPortV1,
	type ConversationRuntimeOperationEventV2,
	createConversationDispatchUseCaseV1,
} from "../../platform-core/src/conversation-dispatch.ts";
import { createConversationEventUseCaseV1 } from "../../platform-core/src/conversation-events.ts";
import { createConversationExecutionUseCaseV1 } from "../../platform-core/src/conversation-execution.ts";
import { createConversationTaskAdmissionUseCaseV1 } from "../../platform-core/src/conversation-execution-task.ts";
import { FakeConversationRuntimeHostV1 } from "../../platform-core/src/fake-conversation-runtime-host.ts";
import { PostgresConversationDispatchStoreV1 } from "./conversation-dispatch.ts";
import { PostgresConversationEventTransactionV1 } from "./conversation-events.ts";
import { PostgresConversationExecutionTransactionV1 } from "./conversation-execution.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";
import { PostgresTaskAuthorizationStoreV1 } from "./task-authorization.ts";

let databaseUrl = "";
let client: ReturnType<typeof postgres>;
let testDatabase: PostgresTestDatabase | undefined;
let fixture = 1;

beforeAll(async () => {
	testDatabase = await startPostgresTestDatabase("conversation-dispatch");
	databaseUrl = testDatabase.databaseUrl;
	await migratePlatformDatabase({ databaseUrl });
	client = postgres(databaseUrl, { max: 5, onnotice: () => {} });
}, 120_000);

afterEach(async () => {
	await client.unsafe(
		"drop trigger if exists isolation_confirmation_failure on platform.audit_events",
	);
	await client.unsafe(
		"drop function if exists platform.isolation_confirmation_failure()",
	);
	await client.unsafe(`drop trigger if exists conversation_dispatch_failure
		on platform.conversation_executions`);
	await client.unsafe(
		"drop function if exists platform.conversation_dispatch_failure()",
	);
	await client`truncate platform.conversation_generation_tombstones,
		platform.task_control_records, platform.task_authorization_records,
		platform.file_accesses, platform.files, platform.conversation_events,
		platform.conversation_audit_events, platform.audit_events,
		platform.outbox_items, platform.idempotency_records,
		platform.conversation_stops, platform.conversation_messages,
		platform.conversation_executions, platform.conversations`;
	await client`truncate platform.agents cascade`;
});

afterAll(async () => {
	await client?.end();
	await testDatabase?.stop();
});

async function seedCapacityAgent(
	agentId = "agent-dispatch",
	maximumConcurrentExecutions = 8,
	sourceKind: "standard" | "custom" = "standard",
) {
	const deployment = workloadDesiredFixture(4, agentId, "internal-only");
	const configuration = {
		schemaVersion: 2,
		agentId,
		revision: 4,
		channels: [],
		channelRevision: "channels-a",
		modelConfiguration:
			sourceKind === "custom"
				? null
				: {
						catalogRevision: "catalog-dispatch",
						options: [
							{
								optionId: "model-option-dispatch",
								endpointId: "endpoint-dispatch",
								modelId: "model-dispatch",
								reasoningLevels: ["medium"],
								credential: {
									secretId: "model-secret-dispatch",
									version: 1,
									isSet: true,
								},
							},
						],
						defaultOptionId: "model-option-dispatch",
						defaultReasoningLevel: "medium",
					},
		secrets: [],
		environment: [],
		source: {
			kind: sourceKind,
			imageDigest: deployment.imageDigest,
			admissionRevision: "admission-a",
			...(sourceKind === "custom"
				? { interactionMode: "platform-adapter" }
				: {
						templateId: "template-dispatch",
						allowedEnvironmentKeys: [],
						allowedSecretKeys: [],
						platformManagedKeys: [],
					}),
			connectionEnabled: false,
		},
	};
	const executionCapacity = {
		schemaVersion: 1,
		imageDigest: deployment.imageDigest,
		resourceProfileRef: deployment.resourceProfileRef,
		resourceConfigurationHash:
			workloadResourceConfigurationHashV1(workloadTestPolicy),
		maximumConcurrentExecutions,
		conformanceEvidenceHash: "c".repeat(64),
	};
	const version = { configuration, deployment, executionCapacity };
	const state = {
		schemaVersion: 1,
		agentId,
		sourceConfigurationRevision: 4,
		sourceLifecycleRevision: 4,
		revision: 4,
		fence: 4,
		phase: "ready",
		candidate: version,
		verified: version,
		verifiedRevision: 4,
		identity: { uid: `workload-${agentId}`, generation: 1 },
		rollback: false,
		failureCode: null,
		attempts: 0,
	};
	await client`insert into platform.agents (id, current_configuration_revision) values (${agentId}, 4) on conflict do nothing`;
	await client`insert into platform.agent_applications
		(id, agent_id, applicant_id, name, description, status, trace_id, request_id, submitted_at,
		management_revision, approval_revision, desired_state, service_availability, workload_revision, fence)
		values (${`application-${agentId}`}, ${agentId}, 'owner-a', 'Agent', 'Fixture', 'available',
		'trace-a', 'request-a', now(), 1, 1, 'running', 'ready', 4, 4) on conflict do nothing`;
	await client`insert into platform.workload_reconciliations (agent_id, revision, state, next_attempt_at)
		values (${agentId}, 4, ${client.json(state)}, now()) on conflict do nothing`;
	return state;
}

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
		agentId?: string;
	} = {},
) {
	const agentId = options.agentId ?? "agent-dispatch";
	await seedCapacityAgent(agentId);
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
			(${conversationId}, ${agentId}, 'actor-dispatch', 'web',
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
			(${executionId}, ${conversationId}, ${agentId}, 'actor-dispatch',
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

async function seedStop(work: Awaited<ReturnType<typeof seed>>) {
	await client`
		insert into platform.conversation_stops
			(execution_id, stop_request_id, status, created_at, updated_at)
		values (${work.executionId}, ${work.stopRequestId}, 'submitted', now(), now())
	`;
	await client`
		insert into platform.outbox_items
			(id, scope_type, scope_id, operation, payload, trace_id, request_id,
			 available_at, created_at, updated_at)
		values
			(${`conversation:stop:${work.stopRequestId}`}, 'conversation',
			 ${work.conversationId}, 'conversation.turn.stop.v1', ${client.json({
					schemaVersion: 1,
					conversationId: work.conversationId,
					executionId: work.executionId,
					sessionGeneration: 1,
					stopRequestId: work.stopRequestId,
				})}, 'trace-stop-dispatch', 'request-stop-dispatch', now(), now(), now())
	`;
}

async function seedSupplement(work: Awaited<ReturnType<typeof seed>>) {
	const messageId = `supplement-${work.messageId}`;
	await client`
		insert into platform.conversation_messages
			(message_id, conversation_id, actor_id, role, text, execution_id,
			 status, created_at, updated_at)
		values (${messageId}, ${work.conversationId}, 'actor-dispatch', 'user',
			'pending supplement', ${work.executionId}, 'submitted', now(), now())
	`;
	await client`
		insert into platform.outbox_items
			(id, scope_type, scope_id, operation, payload, trace_id, request_id,
			 available_at, created_at, updated_at)
		values (${`conversation:supplement:${messageId}`}, 'conversation',
			${work.conversationId}, 'conversation.turn.supplement.v1', ${client.json({
				schemaVersion: 1,
				conversationId: work.conversationId,
				executionId: work.executionId,
				messageId,
				turnId: work.turnId,
				sessionGeneration: 1,
				modelConfigurationRevision: 4,
				modelOptionId: "model-option-dispatch",
				reasoningLevel: "medium",
			})}, 'trace-supplement-dispatch', 'request-supplement-dispatch',
			now(), now(), now())
	`;
	return messageId;
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
	it("reserves verified capacity for an accepted custom Agent message without Platform model selection", async () => {
		const agentId = "custom-dispatch";
		const state = await seedCapacityAgent(agentId, 1, "custom");
		await client`insert into platform.agent_configuration_revisions
			(agent_id, revision, source_reference, created_at, configuration)
			values (${agentId}, 4, 'custom-dispatch-source', now(), ${client.json(state.verified.configuration)})`;
		const transaction = new PostgresConversationExecutionTransactionV1({
			databaseUrl,
		});
		const store = open();
		const api = createConversationExecutionUseCaseV1({
			transaction,
			authorization: {
				async authorize() {
					return {
						outcome: "allowed",
						authority: {
							schemaVersion: 1,
							actorId: "actor-dispatch",
							agentId,
							channelId: "web",
							authorizationRevision: "authorization-dispatch",
							supportsSupplementaryInstruction: true,
						},
					};
				},
			},
		});
		try {
			const created = await api.createConversation({
				schemaVersion: 1,
				agentId,
				idempotencyKey: "custom-create",
				requestId: "custom-create",
				traceId: "custom-trace",
			});
			if (created.outcome !== "accepted")
				throw new Error("Expected custom Conversation");
			const accepted = await api.accept({
				schemaVersion: 1,
				command: "message",
				conversationId: created.result.conversationId,
				text: "bounded custom dispatch fixture",
				idempotencyKey: "custom-message",
				requestId: "custom-message",
				traceId: "custom-trace",
			});
			if (accepted.outcome !== "accepted")
				throw new Error("Expected custom message acceptance");
			const [work] = await store.findDispatchable({ limit: 1 });
			if (!work) throw new Error("Expected accepted message outbox");
			const decision = await store.claim({
				schemaVersion: 1,
				itemId: work.itemId,
				workerId: "custom-worker",
				leaseDurationMs: 30_000,
			});
			if (decision.outcome !== "claimed") throw new Error("Expected claim");
			expect(decision.claim).toMatchObject({
				executionId: accepted.result.executionId,
				modelConfigurationRevision: null,
				modelOptionId: null,
				reasoningLevel: null,
			});
			expect(
				await store.prepareRuntimeDispatch({
					claim: decision.claim,
					leaseDurationMs: 30_000,
				}),
			).toBe(true);
			expect(
				await store.readRuntimeState({ claim: decision.claim }),
			).toMatchObject({
				executionStatus: "unknown",
			});
		} finally {
			await Promise.all([transaction.close(), store.close()]);
		}
	});

	it("calls the Runtime port for only one of two concurrently discovered Conversations at capacity one", async () => {
		await seedCapacityAgent("agent-dispatch", 1);
		const works = await Promise.all([seed(), seed()]);
		const stores = [open(), open()];
		// This counter verifies Core/Store admission; native capacity is a separate
		// deployment load/conformance result, never inferred from this fixture.
		const runtimeHost = new FakeConversationRuntimeHostV1();
		try {
			const outcomes = await Promise.all(
				stores.map((store, index) => {
					const work = works[index];
					if (!work) throw new Error("Missing fixture");
					return createConversationDispatchUseCaseV1(
						{
							store,
							runtimeHost,
							authorization: {
								async authorize({ claim }) {
									return {
										outcome: "allowed",
										authority: {
											schemaVersion: 1,
											agentId: claim.agentId,
											actorId: claim.actorId,
											channelId: claim.channelId,
											conversationId: claim.conversationId,
											executionId: claim.executionId,
											turnId: claim.turnId,
											sessionGeneration: claim.sessionGeneration,
											authorizationRevision: claim.authorizationRevision,
											runtimeGrant: "synthetic-grant",
										},
									};
								},
							},
							events: {
								async persist() {
									throw new Error("The fixture has no runtime events");
								},
							},
						},
						{ retryDelayMs: 0 },
					).dispatch({
						schemaVersion: 1,
						itemId: work.itemId,
						workerId: `capacity-worker-${index}`,
					});
				}),
			);
			expect(outcomes).toHaveLength(2);
			expect(runtimeHost.sideEffectCount()).toBe(1);
			const states = await Promise.all(works.map(dispatchState));
			expect(states.map((state) => state?.execution_status).sort()).toEqual([
				"submitted",
				"unknown",
			]);
		} finally {
			await Promise.all(stores.map((store) => store.close()));
		}
	});

	it("atomically admits verified Agent capacity across Workers and retains it through takeover and failed terminal commit", async () => {
		await seedCapacityAgent("agent-dispatch", 1);
		const first = await seed();
		const second = await seed();
		const otherAgent = await seed(undefined, { agentId: "agent-other" });
		const workers = await Promise.all([
			claim(first.itemId, "capacity-worker-1"),
			claim(second.itemId, "capacity-worker-2"),
			claim(otherAgent.itemId, "capacity-worker-3"),
		]);
		const current = workers.map((worker) => {
			if (worker.decision.outcome !== "claimed")
				throw new Error("Expected claim");
			return { store: worker.store, claim: worker.decision.claim };
		});
		let takeover: Awaited<ReturnType<typeof claim>> | undefined;
		try {
			const results = await Promise.all(
				current.map(({ store, claim }) =>
					store.prepareRuntimeDispatch({ claim, leaseDurationMs: 30_000 }),
				),
			);
			expect(results.slice(0, 2).sort()).toEqual(
				["capacity_wait", true].sort(),
			);
			expect(results[2]).toBe(true);
			const admittedIndex = results[0] === true ? 0 : 1;
			const admitted = current[admittedIndex];
			const waiting = current[1 - admittedIndex];
			if (!admitted || !waiting) throw new Error("Missing fixture");
			expect(
				(
					await dispatchState({
						itemId: waiting.claim.itemId,
						executionId: waiting.claim.executionId,
					})
				)?.execution_status,
			).toBe("submitted");
			await client`update platform.outbox_items set lease_expires_at = now() - interval '1 second' where id = ${admitted.claim.itemId}`;
			takeover = await claim(
				admitted.claim.itemId,
				"capacity-worker-restarted",
			);
			if (takeover.decision.outcome !== "claimed")
				throw new Error("Expected takeover");
			const reclaimed = takeover.decision.claim;
			expect(reclaimed.executionStatus).toBe("unknown");
			expect(
				await takeover.store.prepareRuntimeDispatch({
					claim: reclaimed,
					leaseDurationMs: 30_000,
				}),
			).toBe(true);
			expect(
				await waiting.store.prepareRuntimeDispatch({
					claim: waiting.claim,
					leaseDurationMs: 30_000,
				}),
			).toBe("capacity_wait");
			expect(
				await takeover.store.retry({
					claim: reclaimed,
					retryDelayMs: 0,
					errorCode: "RUNTIME_UNAVAILABLE",
					transition: {
						executionStatus: "submitted",
						conversationStatus: "active",
					},
				}),
			).toBe(false);
			await client.unsafe(`create function platform.conversation_dispatch_failure() returns trigger language plpgsql as $$ begin
				if new.status = 'completed' then raise exception 'synthetic terminal failure'; end if; return new; end $$`);
			await client.unsafe(`create trigger conversation_dispatch_failure before update on platform.conversation_executions
				for each row execute function platform.conversation_dispatch_failure()`);
			const terminal = {
				claim: reclaimed,
				status: "succeeded" as const,
				transition: {
					executionStatus: "completed" as const,
					conversationStatus: "ready" as const,
				},
			};
			await expect(takeover.store.finish(terminal)).rejects.toThrow();
			expect(
				await waiting.store.prepareRuntimeDispatch({
					claim: waiting.claim,
					leaseDurationMs: 30_000,
				}),
			).toBe("capacity_wait");
			await client.unsafe(
				"drop trigger conversation_dispatch_failure on platform.conversation_executions",
			);
			expect(await takeover.store.finish(terminal)).toBe(true);
			expect(
				await waiting.store.prepareRuntimeDispatch({
					claim: waiting.claim,
					leaseDurationMs: 30_000,
				}),
			).toBe(true);
			expect(
				await waiting.store.prepareRuntimeDispatch({
					claim: waiting.claim,
					leaseDurationMs: 30_000,
				}),
			).toBe(true);
		} finally {
			await Promise.all([
				...workers.map((worker) => worker.store.close()),
				takeover?.store.close(),
			]);
		}
	});

	it.each([
		"missing",
		"image",
		"resources",
		"configuration",
		"lifecycle",
		"stopped",
	])(
		"does not reserve new capacity for %s deployment evidence",
		async (drift) => {
			const work = await seed();
			const state = await seedCapacityAgent();
			if (drift === "missing") {
				const { executionCapacity: _removed, ...version } = state.verified;
				await client`update platform.workload_reconciliations set state = ${client.json({ ...state, candidate: version, verified: version })} where agent_id = 'agent-dispatch'`;
			} else if (drift === "image" || drift === "resources") {
				const capacity = {
					...state.verified.executionCapacity,
					...(drift === "image"
						? { imageDigest: `sha256:${"e".repeat(64)}` }
						: { resourceProfileRef: "different" }),
				};
				const version = { ...state.verified, executionCapacity: capacity };
				await client`update platform.workload_reconciliations set state = ${client.json({ ...state, candidate: version, verified: version })} where agent_id = 'agent-dispatch'`;
			} else if (drift === "configuration") {
				await client`update platform.agents set current_configuration_revision = 5 where id = 'agent-dispatch'`;
			} else if (drift === "lifecycle") {
				await client`update platform.agent_applications set workload_revision = 5, fence = 5 where agent_id = 'agent-dispatch'`;
			} else {
				await client`update platform.agent_applications set status = 'stopped', desired_state = 'stopped', service_availability = null where agent_id = 'agent-dispatch'`;
			}
			const { store, decision } = await claim(work.itemId);
			try {
				if (decision.outcome !== "claimed") throw new Error("Expected claim");
				expect(
					await store.prepareRuntimeDispatch({
						claim: decision.claim,
						leaseDurationMs: 30_000,
					}),
				).toBe("capacity_unavailable");
				expect((await dispatchState(work))?.execution_status).toBe("submitted");
			} finally {
				await store.close();
			}
		},
	);

	it("allows occupied execution recovery and controls without a remaining capacity profile", async () => {
		const work = await seed(undefined, { executionStatus: "processing" });
		await client`update platform.workload_reconciliations set state = state #- '{verified,executionCapacity}' #- '{candidate,executionCapacity}'`;
		const { store, decision } = await claim(work.itemId);
		try {
			if (decision.outcome !== "claimed") throw new Error("Expected claim");
			expect(
				await store.prepareRuntimeDispatch({
					claim: decision.claim,
					leaseDurationMs: 30_000,
				}),
			).toBe(true);
			const messageId = await seedSupplement(work);
			const supplement = await claim(`conversation:supplement:${messageId}`);
			try {
				if (supplement.decision.outcome !== "claimed")
					throw new Error("Expected supplement");
				expect(
					await supplement.store.prepareRuntimeDispatch({
						claim: supplement.decision.claim,
						leaseDurationMs: 30_000,
					}),
				).toBe(true);
			} finally {
				await supplement.store.close();
			}
			await seedStop(work);
			const stop = await claim(`conversation:stop:${work.stopRequestId}`);
			try {
				if (stop.decision.outcome !== "claimed")
					throw new Error("Expected stop");
				expect(
					await stop.store.prepareRuntimeDispatch({
						claim: stop.decision.claim,
						leaseDurationMs: 30_000,
					}),
				).toBe(true);
			} finally {
				await stop.store.close();
			}
		} finally {
			await store.close();
		}
	});

	it.each(["turn", "stop"])(
		"rejects ambiguous original operations during %s recovery",
		async (kind) => {
			const work = await seed("conversation.turn.submit.v1", {
				executionStatus: "processing",
				hostSessionRef: "host-original",
			});
			if (kind === "stop") await seedStop(work);
			const { store, decision } = await claim(
				kind === "stop"
					? `conversation:stop:${work.stopRequestId}`
					: work.itemId,
			);
			try {
				if (decision.outcome !== "claimed")
					throw new Error("Expected an owned claim");
				expect(
					await store.readRuntimeState({ claim: decision.claim }),
				).toMatchObject({ hostSessionRef: "host-original" });
				await client`insert into platform.outbox_items (id, scope_type, scope_id, operation, payload, trace_id, request_id)
				select ${`conversation:regenerate:${work.executionId}`}, scope_type, scope_id, 'conversation.turn.regenerate.v1', payload, trace_id, request_id
				from platform.outbox_items where id = ${work.itemId}`;
				expect(
					await store.readRuntimeState({ claim: decision.claim }),
				).toBeNull();
			} finally {
				await store.close();
			}
		},
	);

	it("derives recovery digest from accepted input and rejects expired or foreign leases", async () => {
		const work = await seed();
		const { store, decision } = await claim(work.itemId);
		try {
			if (decision.outcome !== "claimed")
				throw new Error("Expected an owned claim");
			const expected = createHash("sha256")
				.update(
					JSON.stringify({
						agentId: "agent-dispatch",
						conversationId: work.conversationId,
						executionId: work.executionId,
						input: { attachments: [], text: "bounded dispatch fixture" },
						kind: "submit-turn",
						selection: {
							modelOptionId: "model-option-dispatch",
							reasoningLevel: "medium",
							schemaVersion: 1,
						},
						sessionGeneration: 1,
						turnId: work.turnId,
					}),
				)
				.digest("base64url");
			const state = await store.readRuntimeState({ claim: decision.claim });
			expect(state).toMatchObject({
				originalOperationDigest: expected,
				hostSessionRef: null,
				runtimeCursor: null,
				executionStatus: "submitted",
				stopPending: false,
			});
			expect(
				await store.readRuntimeState({
					claim: {
						...decision.claim,
						input: { text: "caller-substituted-body", attachments: [] },
					},
				}),
			).toEqual(state);
			expect(
				await store.readRuntimeState({
					claim: { ...decision.claim, actorId: "other-user" },
				}),
			).toBeNull();
			await client`update platform.outbox_items set lease_expires_at = now() - interval '1 second' where id = ${work.itemId}`;
			expect(
				await store.readRuntimeState({ claim: decision.claim }),
			).toBeNull();
		} finally {
			await store.close();
		}
	});

	it("discovers only due Conversation work without taking another Worker's lease", async () => {
		const store = new PostgresConversationDispatchStoreV1({ databaseUrl });
		try {
			const due = await seed();
			const future = await seed();
			const leased = await seed();
			const expired = await seed();
			const foreignScope = await seed();
			const foreignOperation = await seed();
			await client`update platform.outbox_items
				set available_at = clock_timestamp() + interval '1 hour'
				where id = ${future.itemId}`;
			await client`update platform.outbox_items set scope_type = 'agent'
				where id = ${foreignScope.itemId}`;
			await client`update platform.outbox_items set operation = 'agent.workload.reconcile.v1'
				where id = ${foreignOperation.itemId}`;
			for (const work of [leased, expired]) {
				expect(
					await store.claim({
						schemaVersion: 1,
						itemId: work.itemId,
						workerId: "other-worker",
						leaseDurationMs: 60_000,
					}),
				).toMatchObject({ outcome: "claimed" });
			}
			await client`update platform.outbox_items
				set lease_expires_at = clock_timestamp() - interval '1 second'
				where id = ${expired.itemId}`;
			const before = await client`select id, status, lease_owner, delivery_fence
				from platform.outbox_items order by id`;
			const found = await store.findDispatchable({ limit: 256 });
			expect(found.map((item) => item.itemId).sort()).toEqual(
				[due.itemId, expired.itemId].sort(),
			);
			expect(
				await client`select id, status, lease_owner, delivery_fence
					from platform.outbox_items order by id`,
			).toEqual(before);
		} finally {
			await store.close();
		}
	});

	it("rotates bounded discovery past an outstanding item and includes stop work", async () => {
		const store = new PostgresConversationDispatchStoreV1({ databaseUrl });
		try {
			const turn = await seed();
			const stop = await seed("conversation.turn.stop.v1");
			const first = await store.findDispatchable({ limit: 1 });
			expect(first).toHaveLength(1);
			const second = await store.findDispatchable({
				limit: 1,
				afterItemId: first[0]?.itemId,
			});
			expect(second).toHaveLength(1);
			expect(new Set([...first, ...second].map((item) => item.itemId))).toEqual(
				new Set([turn.itemId, stop.itemId]),
			);
			expect([...first, ...second]).toContainEqual({
				itemId: stop.itemId,
				operation: "conversation.turn.stop.v1",
			});
			expect(
				await store.findDispatchable({
					limit: 1,
					afterItemId: second[0]?.itemId,
				}),
			).toEqual(first);
		} finally {
			await store.close();
		}
	});

	it("claims a Turn and prepares unknown delivery only after authorization", async () => {
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
					executionStatus: "submitted",
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
				execution_status: "submitted",
				execution_fence: 1,
			});
			if (first.decision.outcome !== "claimed") {
				throw new Error("Expected claim");
			}
			await expect(
				first.store.prepareRuntimeDispatch({
					claim: first.decision.claim,
					leaseDurationMs: 30_000,
				}),
			).resolves.toBe(true);
			await expect(dispatchState(work)).resolves.toMatchObject({
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

	it("atomically cancels an unaccepted Turn when its stop is already pending", async () => {
		const work = await seed();
		await seedStop(work);
		const supplementMessageId = await seedSupplement(work);
		const { store, decision } = await claim(work.itemId);
		try {
			expect(decision).toEqual({ outcome: "succeeded" });
			const [state] = await client`
				select turn_outbox.status as turn_status,
					turn_outbox.delivery_fence::int as turn_fence,
					stop_outbox.status as stop_status,
					stop_outbox.delivery_fence::int as stop_fence,
					e.status as execution_status,
					e.delivery_fence::int as execution_fence,
					s.status as stop_request_status,
					supplement.status as supplement_status,
					supplement.failure_code as supplement_failure_code,
					supplement_outbox.status as supplement_outbox_status
				from platform.outbox_items turn_outbox
				join platform.outbox_items stop_outbox
					on stop_outbox.id = ${`conversation:stop:${work.stopRequestId}`}
				join platform.conversation_executions e
					on e.execution_id = ${work.executionId}
				join platform.conversation_stops s
					on s.execution_id = e.execution_id
				join platform.conversation_messages supplement
					on supplement.message_id = ${supplementMessageId}
				join platform.outbox_items supplement_outbox
					on supplement_outbox.id = ${`conversation:supplement:${supplementMessageId}`}
				where turn_outbox.id = ${work.itemId}
			`;
			expect(state).toEqual({
				turn_status: "succeeded",
				turn_fence: 0,
				stop_status: "succeeded",
				stop_fence: 0,
				execution_status: "cancelled",
				execution_fence: 0,
				stop_request_status: "completed",
				supplement_status: "failed",
				supplement_failure_code: "ORIGINAL_RESPONSE_NOT_STARTED",
				supplement_outbox_status: "failed",
			});
		} finally {
			await store.close();
		}
	});

	it("releases the original Turn lease after a concurrent stop commits cancellation", async () => {
		const work = await seed("conversation.turn.submit.v1", {
			executionStatus: "processing",
			hostSessionRef: "host-session-existing",
		});
		const { store, decision } = await claim(work.itemId);
		try {
			if (decision.outcome !== "claimed") throw new Error("Expected claim");
			await seedStop(work);
			const stop = await store.claim({
				schemaVersion: 1,
				itemId: `conversation:stop:${work.stopRequestId}`,
				workerId: "stop-worker",
				leaseDurationMs: 30_000,
			});
			if (stop.outcome !== "claimed") throw new Error("Expected stop claim");
			expect(
				await store.recordRuntimeResponse({
					claim: stop.claim,
					hostSessionRef: "host-session-existing",
					transition: {
						executionStatus: "cancelled",
						conversationStatus: "ready",
					},
				}),
			).toBe(true);
			expect(
				await store.finish({
					claim: stop.claim,
					status: "succeeded",
					transition: {},
				}),
			).toBe(true);
			// The old business event stream fails before it sees the terminal event.
			// Its immutable claim still asks to mark the original Turn unknown.
			expect(
				await store.retry({
					claim: decision.claim,
					retryDelayMs: 0,
					errorCode: "RUNTIME_UNAVAILABLE",
					transition: {
						executionStatus: "unknown",
						conversationStatus: "active",
					},
				}),
			).toBe(true);
			const [released] = await client`
				select status, lease_owner, lease_expires_at from platform.outbox_items
				where id = ${work.itemId}
			`;
			expect(released).toEqual({
				status: "retry_scheduled",
				lease_owner: null,
				lease_expires_at: null,
			});
			expect(await dispatchState(work)).toMatchObject({
				execution_status: "cancelled",
				execution_fence: decision.claim.executionDeliveryFence,
			});
			const [conversation] =
				await client`select status from platform.conversations where id = ${work.conversationId}`;
			expect(conversation?.status).toBe("ready");
			const recovered = await store.claim({
				schemaVersion: 1,
				itemId: work.itemId,
				workerId: "recovery-worker",
				leaseDurationMs: 30_000,
			});
			expect(recovered).toMatchObject({
				outcome: "claimed",
				claim: {
					executionId: work.executionId,
					turnId: work.turnId,
					executionStatus: "cancelled",
					deliveryFence: decision.claim.deliveryFence + 1,
					executionDeliveryFence: decision.claim.executionDeliveryFence,
				},
			});
			// Relaxing stop bookkeeping must not permit the old Worker after takeover.
			expect(
				await store.renew({ claim: decision.claim, leaseDurationMs: 30_000 }),
			).toBe(false);
			expect(
				await store.retry({
					claim: decision.claim,
					retryDelayMs: 0,
					errorCode: "RUNTIME_UNAVAILABLE",
					transition: {},
				}),
			).toBe(false);
			expect(
				await store.finish({
					claim: decision.claim,
					status: "succeeded",
					transition: {},
				}),
			).toBe(false);
		} finally {
			await store.close();
		}
	});

	it("recovers the stopped original Turn facts and ACKs from the committed cursor without another submit", async () => {
		const work = await seed();
		const authorizationRecordId = `authorization-${work.executionId}`;
		await client`insert into platform.task_authorization_records (id, execution_id, boundary) values (${authorizationRecordId}, ${work.executionId}, ${client.json(
			{
				schemaVersion: 1,
				principal: { kind: "user", id: "actor-dispatch" },
				agentId: "agent-dispatch",
				channelId: "web",
				identityRevision: "identity-1",
				agentAuthorizationRevision: "authorization-dispatch",
				accessSources: [{ kind: "user", userId: "actor-dispatch" }],
			},
		)})`;
		await client`insert into platform.audit_events (id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, details)
			values (${`acceptance-${work.executionId}`}, 'trace-original', 'user', 'actor-dispatch', 'task.authorization.accepted', 'execution', ${work.executionId}, 'succeeded', 'request-original', 'agent-dispatch', ${client.json({ authorizationRecordId })})`;
		const store = open();
		const transaction = new PostgresConversationEventTransactionV1({
			databaseUrl,
		});
		const events = createConversationEventUseCaseV1({ transaction });
		const claims: ConversationDispatchClaimV1[] = [];
		const acknowledgements: string[] = [];
		const eventRequests: { afterCursor?: string; runtimeGrant: unknown }[] = [];
		let submits = 0;
		const fact = (
			phase: "intent" | "started" | "unknown",
			sequence: number,
		): ConversationRuntimeOperationEventV2 => ({
			schemaVersion: 2,
			adapterEventKey: `model-${phase}`,
			executionId: work.executionId,
			cursor: `cursor-${sequence}`,
			occurredAt: `2026-09-14T12:00:0${sequence}Z`,
			type: "operation",
			payload: {
				kind: "model",
				phase,
				operationRef: "original-model",
				attemptRef: "original-attempt",
				model: {
					configVersion: "config-4",
					modelOptionId: "model-option-dispatch",
					modelId: "model",
					reasoningLevel: "medium",
				},
			},
		});
		const runtimeHost: ConversationRuntimeHostPortV1 = {
			async dispatch(request) {
				submits += 1;
				return {
					schemaVersion: 2,
					hostSessionRef: "host-session-existing",
					operationId: request.messageId ?? request.executionId,
					result: { outcome: "accepted", status: "running" },
				};
			},
			async recoverStatus() {
				throw new Error(
					"Terminal recovery must only drain the original events",
				);
			},
			async *events(request) {
				eventRequests.push(request);
				if (request.runtimeGrant === "business") {
					yield fact("intent", 1);
					yield fact("started", 2);
					await seedStop(work);
					const stop = await store.claim({
						schemaVersion: 1,
						itemId: `conversation:stop:${work.stopRequestId}`,
						workerId: "stop-worker",
						leaseDurationMs: 30_000,
					});
					if (stop.outcome !== "claimed")
						throw new Error("Expected stop claim");
					expect(
						await store.recordRuntimeResponse({
							claim: stop.claim,
							hostSessionRef: "host-session-existing",
							transition: {
								executionStatus: "cancelled",
								conversationStatus: "ready",
							},
						}),
					).toBe(true);
					expect(
						await store.finish({
							claim: stop.claim,
							status: "succeeded",
							transition: {},
						}),
					).toBe(true);
					throw new ConversationRuntimeHostError("RUNTIME_UNAVAILABLE", true);
				}
				yield fact("unknown", 3);
				yield {
					schemaVersion: 1,
					adapterEventKey: "cancelled",
					executionId: work.executionId,
					cursor: "cursor-4",
					occurredAt: "2026-09-14T12:00:04Z",
					type: "completed",
					payload: { status: "cancelled" },
				};
			},
			async acknowledge(request) {
				const [execution] =
					await client`select last_runtime_cursor from platform.conversation_executions where execution_id = ${work.executionId}`;
				expect(execution?.last_runtime_cursor).toBe(request.confirmedCursor);
				acknowledgements.push(request.confirmedCursor);
			},
		};
		const useCase = createConversationDispatchUseCaseV1(
			{
				store,
				runtimeHost,
				events,
				authorization: {
					async authorize({ claim }) {
						claims.push(claim);
						return {
							outcome: "allowed",
							authority: {
								schemaVersion: 1,
								agentId: claim.agentId,
								actorId: claim.actorId,
								channelId: claim.channelId,
								conversationId: claim.conversationId,
								executionId: claim.executionId,
								turnId: claim.turnId,
								sessionGeneration: claim.sessionGeneration,
								authorizationRevision: claim.authorizationRevision,
								runtimeGrant:
									claim.executionStatus === "cancelled"
										? "control"
										: "business",
								...(claim.executionStatus === "cancelled"
									? { controlOnly: true as const }
									: {}),
							},
						};
					},
				},
			},
			{ leaseDurationMs: 30_000, retryDelayMs: 0 },
		);
		try {
			const command = {
				schemaVersion: 1 as const,
				itemId: work.itemId,
				workerId: "original-worker",
			};
			expect(await useCase.dispatch(command)).toMatchObject({
				outcome: "retry",
				retryScheduled: true,
			});
			expect(eventRequests).toHaveLength(1);
			expect(acknowledgements).toEqual(["cursor-1", "cursor-2"]);
			expect(await dispatchState(work)).toMatchObject({
				status: "retry_scheduled",
				execution_status: "cancelled",
			});
			expect(await useCase.dispatch(command)).toMatchObject({
				outcome: "accepted",
			});
			expect(submits).toBe(1);
			expect(
				eventRequests.map(({ afterCursor, runtimeGrant }) => ({
					afterCursor,
					runtimeGrant,
				})),
			).toEqual([
				{ afterCursor: undefined, runtimeGrant: "business" },
				{ afterCursor: "cursor-2", runtimeGrant: "control" },
			]);
			expect(acknowledgements).toEqual([
				"cursor-1",
				"cursor-2",
				"cursor-2",
				"cursor-3",
				"cursor-4",
			]);
			expect(claims[1]).toMatchObject({
				executionId: work.executionId,
				turnId: work.turnId,
				executionDeliveryFence: claims[0]?.executionDeliveryFence,
			});
			const saved =
				await client`select adapter_event_key from platform.conversation_events where execution_id = ${work.executionId} order by sequence`;
			expect(saved.map((event) => event.adapter_event_key)).toEqual([
				"model-intent",
				"model-started",
				"model-unknown",
				"cancelled",
			]);
			expect(await dispatchState(work)).toMatchObject({
				status: "succeeded",
				execution_status: "cancelled",
				execution_fence: claims[0]?.executionDeliveryFence,
			});
		} finally {
			await transaction.close();
			await store.close();
		}
	});

	it.each(["renew", "retry", "finish"] as const)(
		"keeps owned Turn %s bookkeeping valid while stop is pending",
		async (operation) => {
			const work = await seed("conversation.turn.submit.v1", {
				executionStatus: "processing",
				hostSessionRef: "host-session-existing",
			});
			const { store, decision } = await claim(work.itemId);
			try {
				if (decision.outcome !== "claimed") throw new Error("Expected claim");
				await seedStop(work);
				const result =
					operation === "renew"
						? await store.renew({
								claim: decision.claim,
								leaseDurationMs: 30_000,
							})
						: operation === "retry"
							? await store.retry({
									claim: decision.claim,
									retryDelayMs: 0,
									errorCode: "RUNTIME_UNAVAILABLE",
									transition: {},
								})
							: await store.finish({
									claim: decision.claim,
									status: "succeeded",
									transition: {},
								});
				expect(result).toBe(true);
				expect(await dispatchState(work)).toMatchObject({
					execution_status: "processing",
					execution_fence: decision.claim.executionDeliveryFence,
				});
			} finally {
				await store.close();
			}
		},
	);

	it("invalidates a claim when stop becomes pending during authorization", async () => {
		const work = await seed();
		const { store, decision } = await claim(work.itemId);
		try {
			if (decision.outcome !== "claimed") throw new Error("Expected claim");
			await seedStop(work);
			await expect(
				store.prepareRuntimeDispatch({
					claim: decision.claim,
					leaseDurationMs: 30_000,
				}),
			).resolves.toBe(false);
			await client`
				update platform.outbox_items
				set lease_expires_at = clock_timestamp() - interval '1 second'
				where id = ${work.itemId}
			`;
			const takeover = await claim(work.itemId, "worker-2");
			try {
				expect(takeover.decision).toEqual({ outcome: "succeeded" });
				expect(await dispatchState(work)).toMatchObject({
					status: "succeeded",
					outbox_fence: 1,
					execution_status: "cancelled",
					execution_fence: 1,
				});
			} finally {
				await takeover.store.close();
			}
		} finally {
			await store.close();
		}
	});

	it("cancels an unknown Turn after RuntimeHost confirms it was not accepted", async () => {
		const work = await seed("conversation.turn.submit.v1", {
			executionStatus: "unknown",
			hostSessionRef: "host-session-existing",
		});
		await seedStop(work);
		const { store, decision } = await claim(work.itemId);
		try {
			if (decision.outcome !== "claimed") throw new Error("Expected claim");
			expect(decision.claim).toMatchObject({
				executionStatus: "unknown",
				stopPending: true,
				executionDeliveryFence: 1,
			});
			await expect(
				store.prepareRuntimeDispatch({
					claim: decision.claim,
					leaseDurationMs: 30_000,
				}),
			).resolves.toBe(true);
			await expect(
				store.cancelUnaccepted({ claim: decision.claim }),
			).resolves.toBe(true);
			expect(await dispatchState(work)).toMatchObject({
				status: "succeeded",
				execution_status: "cancelled",
				execution_fence: 1,
			});
			const [stop] = await client`
				select request.status, outbox.status as outbox_status
				from platform.conversation_stops request
				join platform.outbox_items outbox
					on outbox.id = ${`conversation:stop:${work.stopRequestId}`}
				where request.execution_id = ${work.executionId}
			`;
			expect(stop).toEqual({ status: "completed", outbox_status: "succeeded" });
		} finally {
			await store.close();
		}
	});

	it("persists the opaque Host ref and terminal result before completing outbox", async () => {
		const work = await seed();
		const { store, decision } = await claim(work.itemId);
		try {
			if (decision.outcome !== "claimed") throw new Error("Expected claim");
			expect(
				await store.prepareRuntimeDispatch({
					claim: decision.claim,
					leaseDurationMs: 30_000,
				}),
			).toBe(true);
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
			expect(
				await second.store.prepareRuntimeDispatch({
					claim: second.decision.claim,
					leaseDurationMs: 30_000,
				}),
			).toBe(true);
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

	it.each(["read", "prepare", "retry"])(
		"promptly retries a stop fenced by Turn recovery at %s without using stale authority",
		async (boundary) => {
			const work = await seed(undefined, {
				executionStatus: "processing",
				executionFence: 1,
				hostSessionRef: "host-original",
			});
			await client`update platform.outbox_items set delivery_fence=1,status='retry_scheduled' where id=${work.itemId}`;
			await seedStop(work);
			const stop = await claim(`conversation:stop:${work.stopRequestId}`);
			const recovery = await claim(work.itemId, "recovery-worker");
			try {
				if (
					stop.decision.outcome !== "claimed" ||
					recovery.decision.outcome !== "claimed"
				)
					throw new Error("Expected independent stop and Turn claims");
				const stale = stop.decision.claim;
				expect(stale.executionDeliveryFence).toBe(1);
				expect(recovery.decision.claim.executionDeliveryFence).toBe(2);
				const originalStop =
					await client`select * from platform.conversation_stops where execution_id=${work.executionId}`;
				const originalLease =
					await client`select status,lease_owner,lease_expires_at from platform.outbox_items where id=${stale.itemId}`;
				for (const substituted of [
					{ ...stale, actorId: "another-actor" },
					{ ...stale, sessionGeneration: stale.sessionGeneration + 1 },
					{ ...stale, stopRequestId: "another-stop" },
				]) {
					expect(
						await stop.store.readRuntimeState({ claim: substituted }),
					).toBeNull();
					expect(
						await client`select status,lease_owner,lease_expires_at from platform.outbox_items where id=${stale.itemId}`,
					).toEqual(originalLease);
				}
				if (boundary === "read")
					expect(
						await stop.store.readRuntimeState({ claim: stale }),
					).toBeNull();
				else if (boundary === "prepare")
					expect(
						await stop.store.prepareRuntimeDispatch({
							claim: stale,
							leaseDurationMs: 30_000,
						}),
					).toBe(false);
				else
					expect(
						await stop.store.retry({
							claim: stale,
							retryDelayMs: 0,
							errorCode: "RUNTIME_GRANT_INVALID",
							transition: { executionStatus: "unknown" },
						}),
					).toBe(true);
				expect(
					await client`select status,lease_owner,lease_expires_at from platform.outbox_items where id=${stale.itemId}`,
				).toEqual([
					{
						status: "retry_scheduled",
						lease_owner: null,
						lease_expires_at: null,
					},
				]);
				expect((await dispatchState(work))?.execution_status).toBe(
					"processing",
				);
				expect(
					await client`select * from platform.conversation_stops where execution_id=${work.executionId}`,
				).toEqual(originalStop);
				expect(
					await client`select payload->>'errorCode' as error_code from platform.persisted_events where stream_id=${`outbox:${stale.itemId}`} and event_type='outbox.retry_scheduled'`,
				).toEqual([{ error_code: "EXECUTION_FENCE_CHANGED" }]);
				expect(
					await stop.store.findDispatchable({ limit: 256 }),
				).toContainEqual({
					itemId: stale.itemId,
					operation: "conversation.turn.stop.v1",
				});
				const fresh = await stop.store.claim({
					schemaVersion: 1,
					itemId: stale.itemId,
					workerId: "fresh-control-worker",
					leaseDurationMs: 30_000,
				});
				if (fresh.outcome !== "claimed") throw new Error("Expected fresh stop");
				expect(fresh.claim.executionDeliveryFence).toBe(2);
				expect(fresh.claim.deliveryFence).toBe(stale.deliveryFence + 1);
				expect(
					await stop.store.prepareRuntimeDispatch({
						claim: fresh.claim,
						leaseDurationMs: 30_000,
					}),
				).toBe(true);
				expect(await stop.store.readRuntimeState({ claim: stale })).toBeNull();
				expect(
					await client`select status,lease_owner,delivery_fence::int as fence from platform.outbox_items where id=${stale.itemId}`,
				).toEqual([
					{
						status: "processing",
						lease_owner: "fresh-control-worker",
						fence: fresh.claim.deliveryFence,
					},
				]);
			} finally {
				await Promise.all([stop.store.close(), recovery.store.close()]);
			}
		},
	);

	it("rejects a substituted fenced stop without observing its expired deadline", async () => {
		const work = await seed(undefined, {
			executionStatus: "processing",
			executionFence: 1,
			hostSessionRef: "host-original",
		});
		await client`update platform.outbox_items set delivery_fence=1,status='retry_scheduled' where id=${work.itemId}`;
		await seedStop(work);
		const stop = await claim(`conversation:stop:${work.stopRequestId}`);
		const recovery = await claim(work.itemId, "recovery-worker");
		try {
			if (
				stop.decision.outcome !== "claimed" ||
				recovery.decision.outcome !== "claimed"
			)
				throw new Error("Expected independent stop and Turn claims");
			await client`update platform.conversation_stops set confirmation_deadline=clock_timestamp()-interval '1 second' where execution_id=${work.executionId}`;
			const before =
				await client`select * from platform.conversation_stops where execution_id=${work.executionId}`;
			const auditBefore =
				await client`select * from platform.audit_events where target_id=${work.executionId} order by id`;
			const lease =
				await client`select status,lease_owner,lease_expires_at from platform.outbox_items where id=${stop.decision.claim.itemId}`;
			const substituted = {
				...stop.decision.claim,
				stopRequestId: "another-stop",
			};
			expect(
				await stop.store.readRuntimeState({ claim: substituted }),
			).toBeNull();
			expect(
				await stop.store.prepareRuntimeDispatch({
					claim: substituted,
					leaseDurationMs: 30_000,
				}),
			).toBe(false);
			expect(
				await stop.store.retry({
					claim: substituted,
					retryDelayMs: 0,
					errorCode: "RUNTIME_GRANT_INVALID",
					transition: {},
				}),
			).toBe(false);
			expect(
				await client`select * from platform.conversation_stops where execution_id=${work.executionId}`,
			).toEqual(before);
			expect(
				await client`select status,lease_owner,lease_expires_at from platform.outbox_items where id=${stop.decision.claim.itemId}`,
			).toEqual(lease);
			expect((await dispatchState(work))?.execution_status).toBe("processing");
			expect(
				await client`select * from platform.audit_events where target_id=${work.executionId} order by id`,
			).toEqual(auditBefore);
		} finally {
			await Promise.all([stop.store.close(), recovery.store.close()]);
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

	it("persists a supplementary delivery failure on its Message", async () => {
		const work = await seed("conversation.turn.supplement.v1", {
			executionStatus: "processing",
			executionFence: 7,
			hostSessionRef: "host-session-existing",
		});
		const { store, decision } = await claim(work.itemId);
		try {
			if (decision.outcome !== "claimed") throw new Error("Expected claim");
			await expect(
				store.finish({
					claim: decision.claim,
					status: "failed",
					transition: {},
					errorCode: "AUTHORIZATION_REVOKED",
				}),
			).resolves.toBe(true);
			const [state] = await client`
				select message.status as message_status,
					message.failure_code, outbox.status as outbox_status
				from platform.conversation_messages message
				join platform.outbox_items outbox on outbox.id = ${work.itemId}
				where message.message_id = ${work.messageId}
			`;
			expect(state).toEqual({
				message_status: "failed",
				failure_code: "AUTHORIZATION_REVOKED",
				outbox_status: "failed",
			});
		} finally {
			await store.close();
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

const isolationAuthorization: ConversationDispatchAuthorizationPortV1 = {
	async authorize({ claim }) {
		return {
			outcome: "allowed",
			authority: {
				schemaVersion: 1,
				agentId: claim.agentId,
				actorId: claim.actorId,
				channelId: claim.channelId,
				conversationId: claim.conversationId,
				executionId: claim.executionId,
				turnId: claim.turnId,
				sessionGeneration: claim.sessionGeneration,
				authorizationRevision: claim.authorizationRevision,
				runtimeGrant: {},
			},
		};
	},
};
async function seedIsolation(hostSessionRef: string | null = "original-host") {
	const work = await seed("conversation.turn.submit.v1", {
		executionStatus: "unknown",
		hostSessionRef,
	});
	const boundary = {
		schemaVersion: 1,
		principal: { kind: "user", id: "actor-dispatch" },
		agentId: "agent-dispatch",
		channelId: "web",
		identityRevision: "identity-original",
		agentAuthorizationRevision: "authorization-dispatch",
		accessSources: [{ kind: "organization", organizationId: "original-team" }],
	};
	await client`insert into platform.task_authorization_records (id, execution_id, boundary) values (${`authorization-${work.executionId}`}, ${work.executionId}, ${client.json(boundary)})`;
	return work;
}
async function isolationState(work: Awaited<ReturnType<typeof seed>>) {
	const [state] = await client`
    select c.status, c.session_generation::int as generation, c.host_session_ref,
      e.status as execution_status, t.status as isolation_status, t.operation_id, t.control_record_id
    from platform.conversations c join platform.conversation_executions e on e.conversation_id = c.id
    left join platform.conversation_generation_tombstones t on t.conversation_id = c.id
    where c.id = ${work.conversationId} and e.execution_id = ${work.executionId}
  `;
	return state;
}
function isolationHost(
	work: Awaited<ReturnType<typeof seed>>,
	overrides: Partial<ConversationRuntimeHostPortV1> = {},
): ConversationRuntimeHostPortV1 {
	return {
		async dispatch() {
			throw new Error("Must never resubmit an isolated Turn");
		},
		async recoverStatus() {
			throw new Error("Unexpected legacy recovery");
		},
		async recoverOriginalStatus() {
			return {
				schemaVersion: 2,
				hostSessionRef: "original-host",
				executionId: work.executionId,
				outcome: "recovery_failed",
				code: "RUNTIME_SESSION_RECOVERY_FAILED",
			};
		},
		async cancelGeneration() {
			return {
				schemaVersion: 2,
				hostSessionRef: "original-host",
				operationId: `generation:${work.conversationId}:1`,
				result: { outcome: "accepted", status: "cancelled" },
			};
		},
		async *events() {},
		async *drainGenerationEvents() {},
		...overrides,
	};
}

describe("durable generation isolation in the existing dispatch loop", () => {
	it.each([1, 2])(
		"retries a committed isolation cursor after %i undelivered ACKs before confirming an empty drain",
		async (failures) => {
			const work = await seedIsolation();
			const store = open();
			const transaction = new PostgresConversationEventTransactionV1({
				databaseUrl,
			});
			const events = createConversationEventUseCaseV1({ transaction });
			let attempts = 0;
			let submitted = 0;
			let watermark: string | null = null;
			const drainCursors: (string | null)[] = [];
			const readCursor = async () => {
				const [row] =
					await client`select last_runtime_cursor from platform.conversation_executions where execution_id = ${work.executionId}`;
				return row?.last_runtime_cursor as string | null;
			};
			const eventSnapshot = async () => ({
				events:
					await client`select * from platform.conversation_events where execution_id = ${work.executionId} order by sequence`,
				audits:
					await client`select * from platform.conversation_audit_events where execution_id = ${work.executionId}`,
				cursor: await readCursor(),
			});
			const runtimeHost = isolationHost(work, {
				async dispatch() {
					submitted++;
					throw new Error("Unexpected Turn submission");
				},
				async *drainGenerationEvents() {
					// Match the real Worker: resume strictly after the persisted DB cursor.
					const cursor = await readCursor();
					drainCursors.push(cursor);
					if (cursor === "last-cursor") return;
					yield {
						schemaVersion: 1,
						type: "text",
						executionId: work.executionId,
						adapterEventKey: "last-output",
						cursor: "last-cursor",
						occurredAt: "2026-09-15T00:00:00.000Z",
						payload: { delta: "original" },
					};
				},
				async acknowledge(request) {
					expect(await readCursor()).toBe(request.confirmedCursor);
					expect(request).toMatchObject({
						executionId: work.executionId,
						sessionGeneration: 1,
						hostSessionRef: "original-host",
					});
					attempts++;
					if (attempts <= failures)
						throw new Error("ACK not delivered to Runtime");
					watermark = request.confirmedCursor;
				},
			});
			const useCase = createConversationDispatchUseCaseV1(
				{ store, authorization: isolationAuthorization, runtimeHost, events },
				{ retryDelayMs: 0 },
			);
			const command = {
				schemaVersion: 1 as const,
				itemId: work.itemId,
				workerId: "worker",
			};
			try {
				expect(await useCase.dispatch(command)).toMatchObject({
					outcome: "retry",
				});
				expect(await useCase.dispatch(command)).toMatchObject({
					outcome: "retry",
				});
				const committed = await eventSnapshot();
				expect(committed.events).toHaveLength(1);
				expect(committed.cursor).toBe("last-cursor");
				expect(watermark).toBeNull();
				for (let failure = 1; failure < failures; failure++) {
					expect(await useCase.dispatch(command)).toMatchObject({
						outcome: "retry",
					});
					expect(await isolationState(work)).toMatchObject({
						generation: 1,
						isolation_status: "pending",
					});
					expect(await eventSnapshot()).toEqual(committed);
					expect(watermark).toBeNull();
				}
				expect(await useCase.dispatch(command)).toMatchObject({
					outcome: "accepted",
				});
				expect(watermark).toBe("last-cursor");
				expect(attempts).toBe(failures + 1);
				expect(drainCursors).toEqual([null, "last-cursor"]);
				expect(await eventSnapshot()).toEqual(committed);
				expect(await isolationState(work)).toMatchObject({
					generation: 2,
					isolation_status: "confirmed",
				});
				const [audit] =
					await client`select count(*)::int as count from platform.audit_events where target_id = ${work.conversationId} and action = 'conversation.generation.isolation.confirmed'`;
				expect(audit?.count).toBe(1);
				expect(submitted).toBe(0);
			} finally {
				await Promise.all([store.close(), transaction.close()]);
			}
		},
	);

	it("recovers the original opaque ref atomically, retries the same barrier after lost ACK and archives events before confirming", async () => {
		const work = await seedIsolation(null);
		const store = open();
		const transaction = new PostgresConversationEventTransactionV1({
			databaseUrl,
		});
		const events = createConversationEventUseCaseV1({ transaction });
		const operations: string[] = [];
		let lostAck = true;
		let submitted = 0;
		const runtimeHost = isolationHost(work, {
			async dispatch() {
				submitted += 1;
				throw new Error("Unexpected submit");
			},
			async cancelGeneration() {
				operations.push(`generation:${work.conversationId}:1`);
				if (lostAck) {
					lostAck = false;
					throw new ConversationRuntimeHostError("RUNTIME_UNAVAILABLE", true);
				}
				return {
					schemaVersion: 2,
					hostSessionRef: "original-host",
					operationId: operations[0] ?? "",
					result: { outcome: "accepted", status: "cancelled" },
				};
			},
			async *drainGenerationEvents() {
				yield {
					schemaVersion: 1,
					type: "text",
					executionId: work.executionId,
					adapterEventKey: "original-text",
					cursor: "cursor-1",
					occurredAt: "2026-09-15T00:00:00.000Z",
					payload: { delta: "already produced original output" },
				};
			},
		});
		const useCase = createConversationDispatchUseCaseV1(
			{ store, authorization: isolationAuthorization, runtimeHost, events },
			{ retryDelayMs: 0 },
		);
		const command = {
			schemaVersion: 1 as const,
			itemId: work.itemId,
			workerId: "worker-recover",
		};
		try {
			expect(await useCase.dispatch(command)).toMatchObject({
				outcome: "retry",
				retryScheduled: true,
			});
			expect(await isolationState(work)).toMatchObject({
				generation: 1,
				host_session_ref: "original-host",
				execution_status: "unknown",
				isolation_status: "pending",
			});
			expect(await useCase.dispatch(command)).toMatchObject({
				outcome: "retry",
				retryScheduled: true,
			});
			expect(await isolationState(work)).toMatchObject({
				generation: 1,
				isolation_status: "pending",
			});
			expect(await useCase.dispatch(command)).toMatchObject({
				outcome: "accepted",
			});
			expect(await isolationState(work)).toMatchObject({
				generation: 2,
				status: "unavailable",
				execution_status: "failed",
				isolation_status: "confirmed",
				host_session_ref: "original-host",
			});
			expect(operations).toHaveLength(2);
			expect(new Set(operations).size).toBe(1);
			expect(submitted).toBe(0);
			const saved =
				await client`select adapter_event_key, event_payload from platform.conversation_events where execution_id = ${work.executionId}`;
			expect(saved).toHaveLength(1);
			expect(saved[0]?.adapter_event_key).toBe("original-text");
			expect(
				await events.persist({
					schemaVersion: 1,
					conversationId: work.conversationId,
					executionId: work.executionId,
					sessionGeneration: 1,
					deliveryFence: 1,
					adapterEventKey: "original-text",
					runtimeCursor: "cursor-1",
					occurredAt: "2026-09-15T00:00:00.000Z",
					event: {
						type: "text.delta",
						text: "already produced original output",
					},
				}),
			).toMatchObject({ outcome: "replayed" });
			expect(
				await events.persist({
					schemaVersion: 1,
					conversationId: work.conversationId,
					executionId: work.executionId,
					sessionGeneration: 1,
					deliveryFence: 3,
					adapterEventKey: "late-text",
					runtimeCursor: "cursor-2",
					occurredAt: "2026-09-15T00:00:01.000Z",
					event: { type: "text.delta", text: "late" },
				}),
			).toMatchObject({ outcome: "stale" });
		} finally {
			await Promise.all([store.close(), transaction.close()]);
		}
	});

	it.each([
		"unknown",
		"unavailable",
		"rpc_failure",
		"recovery-code-without-ref",
	] as const)(
		"does not isolate an ordinary %s recovery result",
		async (mode) => {
			const work = await seedIsolation(
				mode === "recovery-code-without-ref" ? null : "original-host",
			);
			const store = open();
			const runtimeHost = isolationHost(work, {
				async recoverOriginalStatus() {
					if (mode === "recovery-code-without-ref")
						throw new ConversationRuntimeHostError(
							"RUNTIME_SESSION_RECOVERY_FAILED",
							false,
						);
					if (mode === "rpc_failure")
						throw new ConversationRuntimeHostError("RUNTIME_UNAVAILABLE", true);
					return {
						schemaVersion: 2,
						outcome: "found",
						executionId: work.executionId,
						hostSessionRef: "original-host",
						status: mode,
					};
				},
			});
			try {
				await createConversationDispatchUseCaseV1(
					{
						store,
						authorization: isolationAuthorization,
						runtimeHost,
						events: {
							async persist() {
								throw new Error("No events");
							},
						},
					},
					{ retryDelayMs: 0 },
				).dispatch({
					schemaVersion: 1,
					itemId: work.itemId,
					workerId: "worker",
				});
				expect(await isolationState(work)).toMatchObject({
					generation: 1,
					isolation_status: null,
				});
			} finally {
				await store.close();
			}
		},
	);

	it("keeps isolation pending when the barrier receipt is not terminal or event acknowledgement is lost", async () => {
		const work = await seedIsolation();
		const store = open();
		const transaction = new PostgresConversationEventTransactionV1({
			databaseUrl,
		});
		const events = createConversationEventUseCaseV1({ transaction });
		let terminalAck = false;
		let lostEventAck = true;
		const runtimeHost = isolationHost(work, {
			async cancelGeneration() {
				return {
					schemaVersion: 2,
					hostSessionRef: "original-host",
					operationId: `generation:${work.conversationId}:1`,
					result: {
						outcome: "accepted",
						status: terminalAck ? "cancelled" : "running",
					},
				};
			},
			async *drainGenerationEvents() {
				yield {
					schemaVersion: 1,
					type: "text",
					executionId: work.executionId,
					adapterEventKey: "last-output",
					cursor: "last-cursor",
					occurredAt: "2026-09-15T00:00:00.000Z",
					payload: { delta: "original" },
				};
			},
			async acknowledge() {
				if (lostEventAck) {
					lostEventAck = false;
					throw new Error("ACK lost after commit");
				}
			},
		});
		const useCase = createConversationDispatchUseCaseV1(
			{ store, authorization: isolationAuthorization, runtimeHost, events },
			{ retryDelayMs: 0 },
		);
		const command = {
			schemaVersion: 1 as const,
			itemId: work.itemId,
			workerId: "worker",
		};
		try {
			await useCase.dispatch(command);
			expect(await useCase.dispatch(command)).toMatchObject({
				outcome: "retry",
			});
			expect(await isolationState(work)).toMatchObject({
				generation: 1,
				isolation_status: "pending",
			});
			terminalAck = true;
			await client.unsafe(
				"create function platform.conversation_dispatch_failure() returns trigger language plpgsql as $$ begin if NEW.last_event_sequence > OLD.last_event_sequence then raise exception 'injected event transaction failure'; end if; return NEW; end $$",
			);
			await client.unsafe(
				"create trigger conversation_dispatch_failure before update on platform.conversation_executions for each row execute function platform.conversation_dispatch_failure()",
			);
			expect(await useCase.dispatch(command)).toMatchObject({
				outcome: "retry",
			});
			expect(await isolationState(work)).toMatchObject({
				generation: 1,
				isolation_status: "pending",
			});
			expect(
				await client`select * from platform.conversation_events where execution_id = ${work.executionId}`,
			).toHaveLength(0);
			await client.unsafe(
				"drop trigger conversation_dispatch_failure on platform.conversation_executions",
			);
			expect(await useCase.dispatch(command)).toMatchObject({
				outcome: "retry",
			});
			expect(await isolationState(work)).toMatchObject({
				generation: 1,
				isolation_status: "pending",
			});
			expect(await useCase.dispatch(command)).toMatchObject({
				outcome: "accepted",
			});
			expect(
				await client`select * from platform.conversation_events where execution_id = ${work.executionId}`,
			).toHaveLength(1);
		} finally {
			await Promise.all([store.close(), transaction.close()]);
		}
	});

	it("discovers a pending tombstone after the original execution and outbox complete and retains Agent occupancy until confirmation", async () => {
		await seedCapacityAgent("agent-dispatch", 1);
		const work = await seedIsolation();
		const other = await seed();
		const eventTransaction = new PostgresConversationEventTransactionV1({
			databaseUrl,
		});
		const eventStore = createConversationEventUseCaseV1({
			transaction: eventTransaction,
		});
		const first = await claim(work.itemId);
		const second = await claim(other.itemId, "other-worker");
		try {
			if (
				first.decision.outcome !== "claimed" ||
				second.decision.outcome !== "claimed"
			)
				throw new Error("Expected claims");
			const original = first.decision.claim;
			expect(
				await first.store.beginGenerationIsolation({
					claim: original,
					hostSessionRef: "original-host",
					failureCode: "RUNTIME_SESSION_RECOVERY_FAILED",
				}),
			).toBe(true);
			expect(
				await eventStore.persist({
					schemaVersion: 1,
					conversationId: work.conversationId,
					executionId: work.executionId,
					sessionGeneration: 1,
					deliveryFence: original.executionDeliveryFence,
					adapterEventKey: "completed-before-barrier",
					runtimeCursor: "terminal-cursor",
					occurredAt: "2026-09-15T00:00:00.000Z",
					event: { type: "execution.status", status: "completed" },
					transition: {
						executionStatus: "completed",
						conversationStatus: "ready",
					},
					dispatchLease: {
						schemaVersion: 1,
						itemId: original.itemId,
						leaseOwner: original.leaseOwner,
						deliveryFence: original.deliveryFence,
					},
				}),
			).toMatchObject({ outcome: "accepted" });
			expect(
				await first.store.finish({
					claim: original,
					status: "succeeded",
					transition: {},
				}),
			).toBe(true);
			expect(
				(await first.store.findDispatchable({ limit: 20 })).map(
					(row) => row.itemId,
				),
			).toContain(work.itemId);
			expect(
				await second.store.prepareRuntimeDispatch({
					claim: second.decision.claim,
					leaseDurationMs: 30_000,
				}),
			).toBe("capacity_wait");
			const next = await first.store.claim({
				schemaVersion: 1,
				itemId: work.itemId,
				workerId: "takeover",
				leaseDurationMs: 30_000,
			});
			if (next.outcome !== "claimed")
				throw new Error("Expected isolation claim");
			expect(next.claim.generationIsolation).toMatchObject({
				operationId: `generation:${work.conversationId}:1`,
			});
			expect(
				await first.store.confirmGenerationIsolation({
					claim: next.claim,
					operationId: `generation:${work.conversationId}:1`,
					hostSessionRef: "original-host",
				}),
			).toBe(true);
			expect(await isolationState(work)).toMatchObject({
				generation: 2,
				execution_status: "completed",
				isolation_status: "confirmed",
			});
			expect(
				await second.store.prepareRuntimeDispatch({
					claim: second.decision.claim,
					leaseDurationMs: 30_000,
				}),
			).toBe(true);
		} finally {
			await Promise.all([
				first.store.close(),
				second.store.close(),
				eventTransaction.close(),
			]);
		}
	});

	it("survives restart and two Workers with the same tombstone and rolls back every confirmation write when audit fails", async () => {
		const work = await seedIsolation();
		const supplement = await seedSupplement(work);
		await seedStop(work);
		const first = await claim(work.itemId, "first");
		if (first.decision.outcome !== "claimed") throw new Error("Expected claim");
		const old = first.decision.claim;
		await first.store.beginGenerationIsolation({
			claim: old,
			hostSessionRef: "original-host",
			failureCode: "RUNTIME_SESSION_RECOVERY_FAILED",
		});
		await first.store.close();
		await client`update platform.outbox_items set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${work.itemId}`;
		const stores = [open(), open()];
		try {
			const claims = await Promise.all(
				stores.map((store, i) =>
					store.claim({
						schemaVersion: 1,
						itemId: work.itemId,
						workerId: `second-${i}`,
						leaseDurationMs: 30_000,
					}),
				),
			);
			expect(
				claims.filter((result) => result.outcome === "claimed"),
			).toHaveLength(1);
			const winning = claims.findIndex(
				(result) => result.outcome === "claimed",
			);
			const result = claims[winning];
			const store = stores[winning];
			if (!store || result?.outcome !== "claimed")
				throw new Error("Expected winning claim");
			const confirmation = {
				claim: result.claim,
				operationId: `generation:${work.conversationId}:1`,
				hostSessionRef: "original-host",
			};
			expect(
				await store.confirmGenerationIsolation({ ...confirmation, claim: old }),
			).toBe(false);
			await client.unsafe(
				"create function platform.isolation_confirmation_failure() returns trigger language plpgsql as $$ begin if NEW.action = 'conversation.generation.isolation.confirmed' then raise exception 'injected confirmation failure'; end if; return NEW; end $$",
			);
			await client.unsafe(
				"create trigger isolation_confirmation_failure before insert on platform.audit_events for each row execute function platform.isolation_confirmation_failure()",
			);
			await expect(
				store.confirmGenerationIsolation(confirmation),
			).rejects.toThrow();
			expect(await isolationState(work)).toMatchObject({
				generation: 1,
				isolation_status: "pending",
				execution_status: "unknown",
			});
			expect(
				(
					await client`select status from platform.conversation_messages where message_id = ${supplement}`
				)[0]?.status,
			).toBe("submitted");
			await client.unsafe(
				"drop trigger isolation_confirmation_failure on platform.audit_events",
			);
			expect(await store.confirmGenerationIsolation(confirmation)).toBe(true);
			expect(await isolationState(work)).toMatchObject({
				generation: 2,
				isolation_status: "confirmed",
				execution_status: "failed",
			});
			expect(
				(
					await client`select status from platform.conversation_messages where message_id = ${supplement}`
				)[0]?.status,
			).toBe("failed");
			expect(
				await client`select * from platform.conversation_generation_tombstones where conversation_id = ${work.conversationId}`,
			).toHaveLength(1);
		} finally {
			await Promise.all(stores.map((store) => store.close()));
		}
	});
});

describe("generation isolation admission and proof boundaries", () => {
	it("denies new user commands and a previously claimed supplement while preserving the old event generation", async () => {
		const work = await seedIsolation();
		const supplement = await seedSupplement(work);
		const original = await claim(work.itemId);
		const append = await claim(
			`conversation:supplement:${supplement}`,
			"append-worker",
		);
		const transaction = new PostgresConversationExecutionTransactionV1({
			databaseUrl,
		});
		const api = createConversationExecutionUseCaseV1({
			transaction,
			authorization: {
				async authorize() {
					return {
						outcome: "allowed",
						authority: {
							schemaVersion: 1,
							actorId: "actor-dispatch",
							agentId: "agent-dispatch",
							channelId: "web",
							authorizationRevision: "authorization-dispatch",
							supportsSupplementaryInstruction: true,
						},
					};
				},
			},
		});
		try {
			if (
				original.decision.outcome !== "claimed" ||
				append.decision.outcome !== "claimed"
			)
				throw new Error("Expected claims");
			await original.store.beginGenerationIsolation({
				claim: original.decision.claim,
				hostSessionRef: "original-host",
				failureCode: "RUNTIME_SESSION_RECOVERY_FAILED",
			});
			expect(
				await append.store.prepareRuntimeDispatch({
					claim: append.decision.claim,
					leaseDurationMs: 30_000,
				}),
			).toBe(false);
			expect(
				await api.accept({
					schemaVersion: 1,
					command: "message",
					conversationId: work.conversationId,
					text: "new business",
					idempotencyKey: "new-business",
					requestId: "new-request",
					traceId: "new-trace",
				}),
			).toMatchObject({ outcome: "denied" });
			expect(
				await api.regenerate({
					schemaVersion: 1,
					command: "regenerate",
					conversationId: work.conversationId,
					sourceMessageId: work.messageId,
					idempotencyKey: "new-regenerate",
					requestId: "new-request",
					traceId: "new-trace",
				}),
			).toMatchObject({ outcome: "denied" });
			expect(await isolationState(work)).toMatchObject({
				generation: 1,
				execution_status: "unknown",
				isolation_status: "pending",
			});
		} finally {
			await Promise.all([
				original.store.close(),
				append.store.close(),
				transaction.close(),
			]);
		}
	});

	it("rejects another original subject and mismatched Host reference before writing an isolation intent", async () => {
		const work = await seedIsolation();
		const current = await claim(work.itemId);
		try {
			if (current.decision.outcome !== "claimed")
				throw new Error("Expected claim");
			const input = {
				claim: current.decision.claim,
				hostSessionRef: "original-host",
				failureCode: "RUNTIME_SESSION_RECOVERY_FAILED" as const,
			};
			expect(
				await current.store.beginGenerationIsolation({
					...input,
					claim: { ...input.claim, actorId: "new-owner" },
				}),
			).toBe(false);
			expect(
				await current.store.beginGenerationIsolation({
					...input,
					hostSessionRef: "other-host",
				}),
			).toBe(false);
			await client`update platform.task_authorization_records set boundary = jsonb_set(boundary, '{principal,id}', '"new-owner"') where execution_id = ${work.executionId}`;
			await expect(
				current.store.beginGenerationIsolation(input),
			).rejects.toThrow();
			expect(await isolationState(work)).toMatchObject({
				generation: 1,
				isolation_status: null,
			});
		} finally {
			await current.store.close();
		}
	});

	it.each([
		"unknown",
		"rejected",
		"foreign-operation",
		"foreign-session",
	] as const)(
		"retains the original generation for an unconfirmed %s barrier",
		async (mode) => {
			const work = await seedIsolation();
			const store = open();
			const runtimeHost = isolationHost(work, {
				async cancelGeneration() {
					return {
						schemaVersion: 2,
						hostSessionRef:
							mode === "foreign-session" ? "other-host" : "original-host",
						operationId:
							mode === "foreign-operation"
								? "other-operation"
								: `generation:${work.conversationId}:1`,
						result:
							mode === "unknown"
								? {
										outcome: "unknown",
										code: "RUNTIME_ACCEPTANCE_UNKNOWN",
										message:
											"Runtime command acceptance could not be confirmed",
									}
								: mode === "rejected"
									? {
											outcome: "rejected",
											code: "RUNTIME_TURN_NOT_ACTIVE",
											message: "Runtime turn is no longer active",
											retryable: false,
										}
									: { outcome: "accepted", status: "cancelled" },
					};
				},
			});
			const useCase = createConversationDispatchUseCaseV1(
				{
					store,
					authorization: isolationAuthorization,
					runtimeHost,
					events: {
						async persist() {
							throw new Error("No events expected");
						},
					},
				},
				{ retryDelayMs: 0 },
			);
			try {
				const command = {
					schemaVersion: 1 as const,
					itemId: work.itemId,
					workerId: "worker",
				};
				await useCase.dispatch(command);
				expect(await useCase.dispatch(command)).toMatchObject({
					outcome: "retry",
					retryScheduled: true,
				});
				expect(await isolationState(work)).toMatchObject({
					generation: 1,
					isolation_status: "pending",
					execution_status: "unknown",
				});
			} finally {
				await store.close();
			}
		},
	);
});

it("rolls back a recovered Host reference with the isolation intent when control audit cannot commit", async () => {
	const work = await seedIsolation(null);
	const current = await claim(work.itemId);
	try {
		if (current.decision.outcome !== "claimed")
			throw new Error("Expected claim");
		await client.unsafe(
			"create function platform.isolation_confirmation_failure() returns trigger language plpgsql as $$ begin if NEW.action = 'conversation.generation.isolation.started' then raise exception 'injected intent audit failure'; end if; return NEW; end $$",
		);
		await client.unsafe(
			"create trigger isolation_confirmation_failure before insert on platform.audit_events for each row execute function platform.isolation_confirmation_failure()",
		);
		const input = {
			claim: current.decision.claim,
			hostSessionRef: "original-host",
			failureCode: "RUNTIME_SESSION_RECOVERY_FAILED" as const,
		};
		await expect(
			current.store.beginGenerationIsolation(input),
		).rejects.toThrow();
		expect(await isolationState(work)).toMatchObject({
			generation: 1,
			isolation_status: null,
			host_session_ref: null,
			execution_status: "unknown",
		});
		await client.unsafe(
			"drop trigger isolation_confirmation_failure on platform.audit_events",
		);
		expect(await current.store.beginGenerationIsolation(input)).toBe(true);
		expect(await isolationState(work)).toMatchObject({
			generation: 1,
			isolation_status: "pending",
			host_session_ref: "original-host",
		});
	} finally {
		await current.store.close();
	}
});

describe("PostgreSQL terminal outbox event recovery", () => {
	it.each([
		"none",
		"terminal-commit",
		"terminal-ack",
		"metadata-before-commit",
		"metadata-commit",
		"metadata-ack",
	])(
		"keeps original terminal state and commits/ACKs metadata once with %s fault",
		async (fault) => {
			const work = await seed();
			const authorizationRecordId = `authorization-${work.executionId}`;
			await client`insert into platform.task_authorization_records (id, execution_id, boundary)
				values (${authorizationRecordId}, ${work.executionId}, ${client.json({
					schemaVersion: 1,
					principal: { kind: "user", id: "actor-dispatch" },
					agentId: "agent-dispatch",
					channelId: "web",
					identityRevision: "identity-1",
					agentAuthorizationRevision: "authorization-dispatch",
					accessSources: [{ kind: "user", userId: "actor-dispatch" }],
				})})`;
			await client`insert into platform.audit_events
				(id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, details)
				values (${`acceptance-${work.executionId}`}, 'trace-original', 'user', 'actor-dispatch', 'task.authorization.accepted', 'execution',
					${work.executionId}, 'succeeded', 'request-original', 'agent-dispatch', ${client.json({ authorizationRecordId })})`;
			const store = open();
			const inner = new FakeConversationRuntimeHostV1();
			const runtimeHost: ConversationRuntimeHostPortV1 = inner;
			const event = (sequence: number) => ({
				schemaVersion: 1 as const,
				adapterEventKey: `event-${sequence}`,
				executionId: work.executionId,
				cursor: `cursor-${sequence}`,
				occurredAt: new Date(1_800_000_000_000 + sequence).toISOString(),
			});
			const intent = {
				kind: "tool",
				toolId: "connection.create_pr",
				operationRef: "tool",
				attemptRef: "attempt",
				phase: "intent",
			} as const;
			const started = {
				...intent,
				phase: "started",
				startedAt: event(2).occurredAt,
			} as const;
			const outcome = {
				...started,
				phase: "unknown",
				finishedAt: event(3).occurredAt,
				durationMs: 1,
			} as const;
			const operation = (
				sequence: number,
				payload: ConversationRuntimeOperationEventV2["payload"],
			): ConversationRuntimeOperationEventV2 => ({
				...event(sequence),
				schemaVersion: 2,
				type: "operation",
				payload,
			});
			const stream: ConversationRuntimeEvent[] = [
				operation(1, intent),
				operation(2, started),
				operation(3, outcome),
				{ ...event(4), type: "completed", payload: { status: "completed" } },
				operation(5, {
					...outcome,
					connection: {
						serviceRef: "connection",
						verification: "verified",
						callRef: "call",
					},
				}),
			];
			const requests: { deliveryFence: number; afterCursor?: string }[] = [];
			runtimeHost.events = async function* (request) {
				requests.push(request);
				const start = request.afterCursor
					? stream.findIndex((event) => event.cursor === request.afterCursor) +
						1
					: 0;
				for (const frame of stream.slice(start)) yield frame;
			};
			const eventTransaction = new PostgresConversationEventTransactionV1({
				databaseUrl,
			});
			const eventUseCase = createConversationEventUseCaseV1({
				transaction: eventTransaction,
			});
			const claims: ConversationDispatchClaimV1[] = [];
			let remaining =
				fault === "metadata-before-commit" || fault.endsWith("ack") ? 2 : 1;
			const acknowledgements: string[] = [];
			runtimeHost.acknowledge = async (request) => {
				const [persisted] =
					await client`select last_runtime_cursor from platform.conversation_executions where execution_id = ${work.executionId}`;
				expect(persisted?.last_runtime_cursor).toBe(request.confirmedCursor);
				expect(request.deliveryFence).toBe(1);
				if (
					fault.endsWith("ack") &&
					remaining > 0 &&
					request.confirmedCursor ===
						(fault.startsWith("terminal") ? "cursor-4" : "cursor-5")
				) {
					remaining--;
					throw new Error("injected acknowledgement loss");
				}
				acknowledgements.push(request.confirmedCursor);
				if (fault === "none" && request.confirmedCursor === "cursor-4")
					await client`update platform.conversations set status = 'active' where id = ${work.conversationId}`;
			};
			const useCase = createConversationDispatchUseCaseV1(
				{
					store,
					runtimeHost,
					authorization: {
						async authorize(input) {
							claims.push(input.claim);
							return isolationAuthorization.authorize(input);
						},
					},
					events: {
						async persist(command) {
							const target = fault.startsWith("terminal")
								? "cursor-4"
								: "cursor-5";
							if (
								fault.includes("commit") &&
								remaining > 0 &&
								command.runtimeCursor === target
							) {
								remaining--;
								if (fault !== "metadata-before-commit")
									await eventUseCase.persist(command);
								throw new Error("injected transaction response loss");
							}
							return eventUseCase.persist(command);
						},
					},
				},
				{ retryDelayMs: 0 },
			);
			const dispatch = () =>
				useCase.dispatch({
					schemaVersion: 1,
					itemId: work.itemId,
					workerId: "worker",
				});
			try {
				await expect(dispatch()).resolves.toMatchObject({
					outcome: fault === "none" ? "accepted" : "retry",
					...(fault === "none" ? {} : { retryScheduled: true }),
				});
				expect(await dispatchState(work)).toMatchObject({
					status: fault === "none" ? "succeeded" : "retry_scheduled",
					execution_status: "completed",
					execution_fence: 1,
				});
				// Replaying a terminal journal must not need new Agent capacity or reset
				// the Conversation state now used by a subsequent Execution.
				await client`update platform.workload_reconciliations set state = state #- '{verified,executionCapacity}' #- '{candidate,executionCapacity}' where agent_id = 'agent-dispatch'`;
				if (fault !== "none")
					await client`update platform.conversations set status = 'active' where id = ${work.conversationId}`;
				for (
					let retry = 0;
					retry < 3 && (await dispatchState(work))?.status !== "succeeded";
					retry++
				) {
					expect(
						(await store.findDispatchable({ limit: 256 })).some(
							(item) => item.itemId === work.itemId,
						),
					).toBe(true);
					await dispatch();
				}
				expect(await dispatchState(work)).toMatchObject({
					status: "succeeded",
					execution_status: "completed",
					execution_fence: 1,
					outbox_fence: claims.length,
				});
				expect(
					claims
						.slice(1)
						.every(
							(claim) =>
								claim.executionDeliveryFence === 1 &&
								claim.runtimeTerminalEventSeen,
						),
				).toBe(true);
				expect(inner.sideEffectCount()).toBe(1);
				expect(acknowledgements.at(-1)).toBe("cursor-5");
				expect(requests.every((request) => request.deliveryFence === 1)).toBe(
					true,
				);
				const rows =
					await client`select event_type, event_payload, runtime_cursor from platform.conversation_events where execution_id = ${work.executionId} order by sequence`;
				expect(rows).toHaveLength(5);
				expect(rows[4]?.event_payload).toMatchObject({
					type: "execution.operation",
					fact: {
						...outcome,
						connection: { verification: "verified", callRef: "call" },
					},
				});
				const [conversation] =
					await client`select status from platform.conversations where id = ${work.conversationId}`;
				expect(conversation?.status).toBe("active");
				const stale = claims[0];
				if (!stale) throw new Error("Missing original claim");
				expect(
					await store.retry({
						claim: stale,
						retryDelayMs: 0,
						transition: {},
						errorCode: "OLD_WORKER",
					}),
				).toBe(false);
			} finally {
				await eventTransaction.close();
				await store.close();
			}
		},
	);
});

describe("authorized historical metadata rearm", () => {
	async function terminalHistory(
		originalStatus: "succeeded" | "failed" = "succeeded",
	) {
		const work = await seed();
		const authorizationRecordId = `authorization-${work.executionId}`;
		await client`insert into platform.task_authorization_records (id, execution_id, boundary) values (${authorizationRecordId}, ${work.executionId}, ${client.json(
			{
				schemaVersion: 1,
				principal: { kind: "user", id: "actor-dispatch" },
				agentId: "agent-dispatch",
				channelId: "web",
				identityRevision: "identity-1",
				agentAuthorizationRevision: "authorization-dispatch",
				accessSources: [{ kind: "user", userId: "actor-dispatch" }],
			},
		)})`;
		await client`insert into platform.audit_events (id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, details)
			values (${`acceptance-${work.executionId}`}, 'trace-original', 'user', 'actor-dispatch', 'task.authorization.accepted', 'execution', ${work.executionId}, 'succeeded', 'request-original', 'agent-dispatch', ${client.json({ authorizationRecordId })})`;
		const eventTransaction = new PostgresConversationEventTransactionV1({
			databaseUrl,
		});
		const transaction = new PostgresConversationExecutionTransactionV1({
			databaseUrl,
		});
		const events = createConversationEventUseCaseV1({
			transaction: eventTransaction,
		});
		const store = open();
		const runtimeHost =
			new FakeConversationRuntimeHostV1() as ConversationRuntimeHostPortV1;
		const outcome = {
			kind: "tool",
			toolId: "connection.create_pr",
			operationRef: "tool",
			attemptRef: "attempt",
			phase: "unknown",
			startedAt: new Date(1_800_000_000_002).toISOString(),
			finishedAt: new Date(1_800_000_000_003).toISOString(),
			durationMs: 1,
			connection: {
				serviceRef: "connection",
				verification: "unverified",
				reason: "receipt_missing",
			},
		} as const;
		const operation = (
			n: number,
			payload: ConversationRuntimeOperationEventV2["payload"],
		): ConversationRuntimeOperationEventV2 => ({
			schemaVersion: 2,
			type: "operation",
			adapterEventKey: `event-${n}`,
			cursor: `cursor-${n}`,
			executionId: work.executionId,
			occurredAt: new Date(1_800_000_000_000 + n).toISOString(),
			payload,
		});
		const stream: ConversationRuntimeEvent[] = [
			operation(1, {
				kind: "tool",
				toolId: outcome.toolId,
				operationRef: "tool",
				attemptRef: "attempt",
				phase: "intent",
			}),
			operation(2, {
				kind: "tool",
				toolId: outcome.toolId,
				operationRef: "tool",
				attemptRef: "attempt",
				phase: "started",
				startedAt: outcome.startedAt,
			}),
			operation(3, outcome),
			{
				schemaVersion: 1,
				type: "completed",
				adapterEventKey: "event-4",
				cursor: "cursor-4",
				executionId: work.executionId,
				occurredAt: new Date(1_800_000_000_004).toISOString(),
				payload: { status: "completed" },
			},
		];
		const requests: { requestId: string; kind: string }[] = [];
		runtimeHost.events = async function* (request) {
			requests.push({ requestId: request.requestId, kind: "events" });
			const index = request.afterCursor
				? stream.findIndex((event) => event.cursor === request.afterCursor) + 1
				: 0;
			for (const event of stream.slice(index)) yield event;
		};
		let loseMetadataAck = false;
		runtimeHost.acknowledge = async (request) => {
			requests.push({ requestId: request.requestId, kind: "ack" });
			if (loseMetadataAck && request.confirmedCursor === "cursor-5") {
				loseMetadataAck = false;
				throw new Error("metadata ACK response lost");
			}
		};
		runtimeHost.recoverOriginalStatus = async (request) => {
			requests.push({ requestId: request.requestId, kind: "status" });
			return {
				schemaVersion: 2,
				hostSessionRef: request.hostSessionRef,
				executionId: request.executionId,
				outcome: "found",
				status: "completed",
			};
		};
		const dispatch = createConversationDispatchUseCaseV1(
			{ store, events, runtimeHost, authorization: isolationAuthorization },
			{ retryDelayMs: 0 },
		);
		const run = () =>
			dispatch.dispatch({
				schemaVersion: 1,
				itemId: work.itemId,
				workerId: "worker",
			});
		expect(await run()).toMatchObject({ outcome: "accepted" });
		await client`update platform.outbox_items set status = ${originalStatus} where id = ${work.itemId}`;
		const authority = {
			schemaVersion: 1 as const,
			actorId: "actor-dispatch",
			agentId: "agent-dispatch",
			channelId: "web",
			authorizationRevision: "authorization-dispatch",
			supportsSupplementaryInstruction: true,
		};
		let pass = 0;
		const rearm = (patch: Partial<typeof authority> = {}) =>
			createConversationExecutionUseCaseV1(
				{
					transaction,
					authorization: {
						async authorize() {
							return {
								outcome: "allowed",
								authority: { ...authority, ...patch },
							};
						},
					},
				},
				{
					now: () => new Date(1_800_000_000_100 + pass),
					newId: () => `pass-${++pass}`,
				},
			).requestMetadataRecovery({
				schemaVersion: 1,
				conversationId: work.conversationId,
				executionId: work.executionId,
			});
		return {
			work,
			store,
			loseMetadataAck: () => {
				loseMetadataAck = true;
			},
			run,
			rearm,
			transaction,
			requests,
			stream,
			verified: operation(5, {
				...outcome,
				connection: {
					serviceRef: "connection",
					verification: "verified",
					callRef: "call",
				},
			}),
			close: async () => {
				await store.close();
				await transaction.close();
				await eventTransaction.close();
			},
		};
	}

	it.each(["succeeded", "failed"] as const)(
		"rearms an ended %s outbox once, retains the original task fence and active Conversation, and drains after restart",
		async (originalStatus) => {
			const h = await terminalHistory(originalStatus);
			try {
				await client`update platform.conversations set status = 'active', authorization_revision = 'new-business-revision' where id = ${h.work.conversationId}`;
				const before = await dispatchState(h.work);
				const [one, two] = await Promise.all([h.rearm(), h.rearm()]);
				expect([one.outcome, two.outcome].sort()).toEqual([
					"coalesced",
					"scheduled",
				]);
				const current = await claim(h.work.itemId);
				await current.store.close();
				expect(current.decision.outcome).toBe("claimed");
				if (current.decision.outcome !== "claimed")
					throw new Error("claim failed");
				const recoveryClaim = current.decision.claim;
				if (!recoveryClaim.metadataRecovery)
					throw new Error("missing metadata marker");
				expect(recoveryClaim.metadataRecovery).toEqual({
					id: "pass-1",
					requestedAt: 1_800_000_000_100,
					originalStatus,
				});
				expect(recoveryClaim.executionDeliveryFence).toBe(
					before?.execution_fence,
				);
				expect(recoveryClaim.deliveryFence).toBe(
					Number(before?.outbox_fence) + 1,
				);
				await expect(
					h.store.prepareRuntimeDispatch({
						claim: recoveryClaim,
						leaseDurationMs: 30_000,
					}),
				).rejects.toThrow();
				await expect(
					h.store.recordRuntimeResponse({
						claim: recoveryClaim,
						hostSessionRef: recoveryClaim.hostSessionRef ?? "missing",
						transition: {},
					}),
				).rejects.toThrow();
				await expect(
					h.store.finish({
						claim: recoveryClaim,
						status: "succeeded",
						transition: { conversationStatus: "ready" },
					}),
				).rejects.toThrow();
				expect(
					await h.store.readRuntimeState({
						claim: {
							...recoveryClaim,
							metadataRecovery: {
								...recoveryClaim.metadataRecovery,
								id: "old-pass",
							},
						},
					}),
				).toBeNull();
				expect(
					await h.store.retry({
						claim: recoveryClaim,
						retryDelayMs: 0,
						errorCode: "TRANSPORT_LOST",
						transition: {},
					}),
				).toBe(true);
				h.stream.push(h.verified);
				h.requests.length = 0;
				expect(await h.run()).toMatchObject({ outcome: "accepted" });
				expect(h.requests.map((request) => request.kind)).toEqual([
					"status",
					"ack",
					"events",
					"ack",
				]);
				expect(
					h.requests.every((request) => request.requestId === "pass-1"),
				).toBe(true);
				expect(await dispatchState(h.work)).toMatchObject({
					status: originalStatus,
					execution_status: "completed",
					execution_fence: before?.execution_fence,
				});
				const [conversation] =
					await client`select status, authorization_revision from platform.conversations where id = ${h.work.conversationId}`;
				expect(conversation).toMatchObject({
					status: "active",
					authorization_revision: "new-business-revision",
				});
				expect(await h.rearm()).toEqual({ outcome: "not_applicable" });
				expect(await h.rearm({ actorId: "other-user" })).toEqual({
					outcome: "denied",
				});
				expect(await h.rearm({ agentId: "other-agent" })).toEqual({
					outcome: "denied",
				});
				expect(await h.rearm({ channelId: "other-channel" })).toEqual({
					outcome: "denied",
				});
			} finally {
				await h.close();
			}
		},
	);
	it("keeps current business capacity independent and refuses generation confirmation until another Execution metadata outbox drains", async () => {
		const h = await terminalHistory();
		try {
			expect(await h.rearm()).toEqual({ outcome: "scheduled" });
			const original = await claim(h.work.itemId);
			await original.store.close();
			if (original.decision.outcome !== "claimed")
				throw new Error("metadata not claimed");
			const oldClaim = original.decision.claim;
			const hostSessionRef = oldClaim.hostSessionRef;
			if (!hostSessionRef) throw new Error("missing original Host");
			const executionId = "new-execution";
			const itemId = `conversation:turn:${executionId}`;
			await client`insert into platform.conversation_executions (execution_id, conversation_id, agent_id, actor_id, channel_id, turn_id, status, session_generation, delivery_fence, authorization_revision, model_configuration_revision, model_option_id, reasoning_level, created_at, updated_at)
				select ${executionId}, conversation_id, agent_id, actor_id, channel_id, 'new-turn', 'submitted', session_generation, 0, authorization_revision, model_configuration_revision, model_option_id, reasoning_level, now(), now() from platform.conversation_executions where execution_id = ${h.work.executionId}`;
			await client`insert into platform.conversation_messages (message_id, conversation_id, actor_id, role, text, execution_id, status, created_at, updated_at)
				values ('new-message', ${h.work.conversationId}, 'actor-dispatch', 'user', 'new task', ${executionId}, 'submitted', now(), now())`;
			await client`insert into platform.outbox_items (id, scope_type, scope_id, operation, payload, trace_id, request_id)
				select ${itemId}, scope_type, scope_id, operation, (payload - 'metadataRecovery') || ${client.json({ executionId, messageId: "new-message", turnId: "new-turn" })}, 'new-trace', 'new-request' from platform.outbox_items where id = ${h.work.itemId}`;
			await client`insert into platform.task_authorization_records (id, execution_id, boundary) select 'new-authorization', ${executionId}, boundary from platform.task_authorization_records where execution_id = ${h.work.executionId}`;
			await client`update platform.conversations set status = 'active' where id = ${h.work.conversationId}`;
			const business = await claim(itemId);
			await business.store.close();
			if (business.decision.outcome !== "claimed")
				throw new Error("business not claimed");
			const businessClaim = business.decision.claim;
			expect(
				await h.store.prepareRuntimeDispatch({
					claim: businessClaim,
					leaseDurationMs: 30_000,
				}),
			).toBe(true);
			const [capacity] =
				await client`select count(*) filter (where status in ('processing', 'unknown'))::int as active from platform.conversation_executions where conversation_id = ${h.work.conversationId}`;
			expect(capacity?.active).toBe(1);
			expect(
				await h.store.beginGenerationIsolation({
					claim: { ...businessClaim, executionStatus: "unknown" },
					hostSessionRef: hostSessionRef,
					failureCode: "RUNTIME_SESSION_RECOVERY_FAILED",
				}),
			).toBe(true);
			expect(await h.rearm()).toEqual({ outcome: "not_applicable" });
			expect(await h.store.readRuntimeState({ claim: oldClaim })).toMatchObject(
				{
					metadataRecovery: oldClaim.metadataRecovery,
					generationIsolation: {
						operationId: `generation:${h.work.conversationId}:1`,
					},
				},
			);
			expect(
				await h.store.retry({
					claim: businessClaim,
					retryDelayMs: 0,
					errorCode: "GENERATION_BARRIER_UNCONFIRMED",
					transition: {},
				}),
			).toBe(true);
			const barrier = await claim(itemId);
			await barrier.store.close();
			if (barrier.decision.outcome !== "claimed")
				throw new Error("barrier not claimed");
			const barrierClaim = barrier.decision.claim;
			const isolation = barrierClaim.generationIsolation;
			if (!isolation) throw new Error("missing isolation");
			const confirm = () =>
				h.store.confirmGenerationIsolation({
					claim: barrierClaim,
					operationId: isolation.operationId,
					hostSessionRef: hostSessionRef,
				});
			expect(await confirm()).toBe(false);
			expect(
				await h.store.retry({
					claim: oldClaim,
					retryDelayMs: 0,
					errorCode: "ACK_LOST",
					transition: {},
				}),
			).toBe(true);
			const draining = await claim(h.work.itemId);
			await draining.store.close();
			if (draining.decision.outcome !== "claimed")
				throw new Error("metadata cannot drain during isolation");
			expect(draining.decision.claim.generationIsolation).toBeUndefined();
			expect(
				await h.store.readRuntimeState({ claim: draining.decision.claim }),
			).toMatchObject({
				generationIsolation: {
					operationId: isolation.operationId,
				},
			});
			expect(
				await h.store.retry({
					claim: draining.decision.claim,
					retryDelayMs: 0,
					errorCode: "REPLAY",
					transition: {},
				}),
			).toBe(true);
			h.stream.push(h.verified);
			expect(await h.run()).toMatchObject({ outcome: "accepted" });
			expect(await confirm()).toBe(true);
			expect(await h.store.readRuntimeState({ claim: oldClaim })).toBeNull();
			expect(await h.rearm()).toEqual({ outcome: "not_applicable" });
		} finally {
			await h.close();
		}
	});
	it("keeps the same pass through a committed metadata ACK loss and refuses stale business transitions", async () => {
		const h = await terminalHistory();
		try {
			await h.rearm();
			h.stream.push(h.verified);
			h.requests.length = 0;
			h.loseMetadataAck();
			expect(await h.run()).toMatchObject({
				outcome: "retry",
				retryScheduled: true,
			});
			const [before] =
				await client`select payload, status from platform.outbox_items where id = ${h.work.itemId}`;
			expect(before?.status).toBe("retry_scheduled");
			expect(await h.run()).toMatchObject({ outcome: "accepted" });
			expect(
				h.requests.every((request) => request.requestId === "pass-1"),
			).toBe(true);
			const [after] =
				await client`select payload from platform.outbox_items where id = ${h.work.itemId}`;
			expect(after?.payload).toEqual(before?.payload);
			const [count] =
				await client`select count(*)::int as value from platform.conversation_events where execution_id = ${h.work.executionId} and runtime_cursor = 'cursor-5'`;
			expect(count?.value).toBe(1);
		} finally {
			await h.close();
		}
	});

	it("ends a pass without new evidence, permits a later query, and rejects malformed persisted recovery metadata", async () => {
		const h = await terminalHistory();
		try {
			await h.rearm();
			expect(await h.run()).toMatchObject({ outcome: "accepted" });
			expect(await h.rearm()).toEqual({ outcome: "scheduled" });
			const [current] =
				await client`select payload from platform.outbox_items where id = ${h.work.itemId}`;
			expect(current?.payload.metadataRecovery.id).toBe("pass-2");
			await client`update platform.outbox_items set payload = jsonb_set(payload, '{metadataRecovery,unexpected}', 'true'::jsonb) where id = ${h.work.itemId}`;
			const invalid = await claim(h.work.itemId);
			await invalid.store.close();
			expect(invalid.decision).toEqual({ outcome: "stale" });
		} finally {
			await h.close();
		}
	});
});

async function waitingTaskHarness(maximumConcurrentExecutions = 1) {
	const agentId = `waiting-agent-${fixture++}`;
	const ready = await seedCapacityAgent(agentId, maximumConcurrentExecutions);
	await client`update platform.agents set authorization_revision = 'waiting-grant' where id = ${agentId}`;
	await client`insert into platform.agent_configuration_revisions
		(agent_id, revision, source_reference, created_at, configuration)
		values (${agentId}, 4, 'waiting-fixture', now(), ${client.json(ready.verified.configuration)})`;
	const transaction = new PostgresConversationExecutionTransactionV1({
		databaseUrl,
	});
	const store = open();
	const controls = new PostgresTaskAuthorizationStoreV1({ databaseUrl });
	const runtimeHost = new FakeConversationRuntimeHostV1();
	const submit = async (prefix: string, conversationId?: string) => {
		let nextId = 0;
		const decision = await createConversationTaskAdmissionUseCaseV1(
			{
				transaction,
				authorization: {
					async authorize() {
						return {
							outcome: "allowed",
							authority: {
								schemaVersion: 1,
								actorId: "waiting-user",
								agentId,
								channelId: "api",
								authorizationRevision: "waiting-grant",
								supportsSupplementaryInstruction: false,
								taskBoundary: {
									schemaVersion: 1,
									principal: { kind: "user", id: "waiting-user" },
									agentId,
									channelId: "api",
									identityRevision: "waiting-identity",
									agentAuthorizationRevision: "waiting-grant",
									accessSources: [{ kind: "user", userId: "waiting-user" }],
								},
							},
						};
					},
				},
			},
			{ maximumWaitingTasksPerAgent: 20, waitingTimeoutMs: 120_000 },
			{
				now: () => new Date(),
				newId: () => `${agentId}-${prefix}-${++nextId}`,
			},
		).submitTask({
			schemaVersion: 1,
			agentId,
			...(conversationId ? { conversationId } : {}),
			text: "bounded waiting fixture",
			idempotencyKey: prefix,
			requestId: `request-${prefix}`,
			traceId: `trace-${prefix}`,
		});
		if (decision.outcome !== "accepted")
			throw new Error(`Expected waiting admission: ${decision.outcome}`);
		const [outbox] = await client<
			{ id: string }[]
		>`select id from platform.outbox_items
			where payload->>'executionId' = ${decision.result.executionId} and operation = 'conversation.turn.submit.v1'`;
		if (!outbox) throw new Error("Missing admitted outbox");
		return { ...decision.result, itemId: outbox.id };
	};
	const own = async (itemId: string, workerId = "waiting-worker") => {
		const decision = await store.claim({
			schemaVersion: 1,
			itemId,
			workerId,
			leaseDurationMs: 30_000,
		});
		if (decision.outcome !== "claimed")
			throw new Error(`Expected waiting claim: ${decision.outcome}`);
		return decision.claim;
	};
	const dispatch = async (
		itemId: string,
		beforeAuthorize?: (claim: ConversationDispatchClaimV1) => Promise<void>,
	) =>
		createConversationDispatchUseCaseV1(
			{
				store,
				runtimeHost,
				authorization: {
					async authorize({ claim }) {
						await beforeAuthorize?.(claim);
						return {
							outcome: "allowed",
							authority: {
								schemaVersion: 1,
								agentId: claim.agentId,
								actorId: claim.actorId,
								channelId: claim.channelId,
								conversationId: claim.conversationId,
								executionId: claim.executionId,
								turnId: claim.turnId,
								sessionGeneration: claim.sessionGeneration,
								authorizationRevision: claim.authorizationRevision,
								runtimeGrant: "synthetic-waiting-grant",
							},
						};
					},
				},
				events: {
					async persist() {
						throw new Error("No Runtime events in waiting fixture");
					},
				},
			},
			{ retryDelayMs: 0 },
		).dispatch({ schemaVersion: 1, itemId, workerId: `dispatch-${fixture++}` });
	const control = async (
		executionId: string,
		reason: "stop" | "authorization_revoked",
	) => {
		const [record] = await client<
			{ id: string }[]
		>`select id from platform.task_authorization_records where execution_id = ${executionId}`;
		if (!record) throw new Error("Missing admitted authorization");
		return controls.recordControl({
			executionId,
			authorizationRecordId: record.id,
			reason,
			workerId: "waiting-control",
			traceId: "waiting-control-trace",
			requestId: "waiting-control-request",
		});
	};
	const close = () =>
		Promise.all([transaction.close(), store.close(), controls.close()]);
	return {
		agentId,
		ready,
		store,
		runtimeHost,
		submit,
		own,
		dispatch,
		control,
		close,
	};
}

async function taskQueueState(executionId: string) {
	const [row] = await client`select status, task_wait_order::text as wait_order,
		task_wait_deadline, delivery_fence::text as fence from platform.conversation_executions where execution_id = ${executionId}`;
	if (!row) throw new Error("Missing task state");
	return row;
}

async function expireTask(executionId: string) {
	await client`update platform.conversation_executions set task_wait_deadline = clock_timestamp() - interval '1 second' where execution_id = ${executionId}`;
}

describe("durable stop confirmation", () => {
	it("discovers an expired stop before retry availability after restart, refuses a running ACK and confirms only a real terminal event", async () => {
		const work = await seed("conversation.turn.stop.v1", {
			executionStatus: "processing",
			hostSessionRef: "original-stop-session",
		});
		await client`update platform.outbox_items set status = 'retry_scheduled', available_at = clock_timestamp() + interval '1 day' where id = ${work.itemId}`;
		await client`update platform.conversation_stops set confirmation_deadline = clock_timestamp() - interval '1 second' where execution_id = ${work.executionId}`;
		const restarted = open();
		const eventTransaction = new PostgresConversationEventTransactionV1({
			databaseUrl,
		});
		try {
			expect(await restarted.findDispatchable({ limit: 20 })).toContainEqual({
				itemId: work.itemId,
				operation: "conversation.turn.stop.v1",
			});
			const decision = await restarted.claim({
				schemaVersion: 1,
				itemId: work.itemId,
				workerId: "restarted-stop-worker",
				leaseDurationMs: 30_000,
			});
			if (decision.outcome !== "claimed")
				throw new Error(`Expected stop claim: ${decision.outcome}`);
			const owned = decision.claim;
			expect(owned.executionStatus).toBe("unknown");
			expect(owned.hostSessionRef).toBe("original-stop-session");
			expect(
				await restarted.finish({
					claim: owned,
					status: "succeeded",
					transition: { executionStatus: "processing" },
				}),
			).toBe(false);
			const [unconfirmed] =
				await client`select status from platform.conversation_stops where execution_id = ${work.executionId}`;
			expect(unconfirmed?.status).toBe("submitted");
			const events = createConversationEventUseCaseV1({
				transaction: eventTransaction,
			});
			const command = {
				schemaVersion: 1 as const,
				conversationId: work.conversationId,
				executionId: work.executionId,
				sessionGeneration: owned.sessionGeneration,
				deliveryFence: owned.executionDeliveryFence,
				adapterEventKey: "late-running",
				runtimeCursor: "late-running-cursor",
				occurredAt: new Date().toISOString(),
				event: {
					type: "execution.status" as const,
					status: "processing" as const,
				},
				transition: {
					executionStatus: "processing" as const,
					conversationStatus: "active" as const,
				},
			};
			expect(await events.persist(command)).toMatchObject({
				outcome: "accepted",
			});
			expect((await taskQueueState(work.executionId)).status).toBe("unknown");
			expect(
				await events.persist({
					...command,
					adapterEventKey: "late-completed",
					runtimeCursor: "late-completed-cursor",
					event: { type: "execution.status", status: "completed" },
					transition: {
						executionStatus: "completed",
						conversationStatus: "ready",
					},
				}),
			).toMatchObject({ outcome: "accepted" });
			expect((await taskQueueState(work.executionId)).status).toBe("completed");
			const [confirmed] =
				await client`select status from platform.conversation_stops where execution_id = ${work.executionId}`;
			expect(confirmed?.status).toBe("completed");
			expect(
				await restarted.finish({
					claim: owned,
					status: "succeeded",
					transition: {},
				}),
			).toBe(true);
		} finally {
			await Promise.all([restarted.close(), eventTransaction.close()]);
		}
	});

	it("keeps natural completion when it wins before the stop deadline and emits no timeout", async () => {
		const work = await seed("conversation.turn.stop.v1", {
			executionStatus: "processing",
			hostSessionRef: "original-stop-session",
		});
		const first = await claim(work.itemId);
		try {
			if (first.decision.outcome !== "claimed")
				throw new Error("Expected stop claim");
			expect(
				await first.store.finish({
					claim: first.decision.claim,
					status: "succeeded",
					transition: {
						executionStatus: "completed",
						conversationStatus: "ready",
					},
				}),
			).toBe(true);
			await client`update platform.conversation_stops set confirmation_deadline = clock_timestamp() - interval '1 second' where execution_id = ${work.executionId}`;
			expect(
				await first.store.renew({
					claim: first.decision.claim,
					leaseDurationMs: 30_000,
				}),
			).toBe(false);
			expect((await taskQueueState(work.executionId)).status).toBe("completed");
			const [stop] =
				await client`select status, confirmation_timed_out_at from platform.conversation_stops where execution_id = ${work.executionId}`;
			expect(stop).toEqual({
				status: "completed",
				confirmation_timed_out_at: null,
			});
			const [timeout] =
				await client`select count(*)::int as count from platform.conversation_events where execution_id = ${work.executionId} and event_payload->>'reason' = 'STOP_CONFIRMATION_TIMEOUT'`;
			expect(timeout?.count).toBe(0);
		} finally {
			await first.store.close();
		}
	});

	it("marks expired stop confirmation unknown while retaining its original binding and blocking the next task", async () => {
		const h = await waitingTaskHarness();
		try {
			const first = await h.submit("stop-expired-first");
			const owned = await h.own(first.itemId);
			await h.store.prepareRuntimeDispatch({
				claim: owned,
				leaseDurationMs: 30_000,
			});
			await h.store.recordRuntimeResponse({
				claim: owned,
				hostSessionRef: "original-stop-session",
				transition: {
					executionStatus: "processing",
					conversationStatus: "active",
				},
			});
			const second = await h.submit(
				"stop-expired-second",
				first.conversationId,
			);
			await h.control(first.executionId, "stop");
			await client`update platform.conversation_stops set confirmation_deadline = clock_timestamp() - interval '1 second' where execution_id = ${first.executionId}`;
			expect(
				await h.store.renew({ claim: owned, leaseDurationMs: 30_000 }),
			).toBe(true);
			const [execution] =
				await client`select status, session_generation::text, delivery_fence::text from platform.conversation_executions where execution_id = ${first.executionId}`;
			expect(execution).toMatchObject({
				status: "unknown",
				session_generation: "1",
				delivery_fence: String(owned.executionDeliveryFence),
			});
			const [conversation] =
				await client`select status, host_session_ref from platform.conversations where id = ${first.conversationId}`;
			expect(conversation).toEqual({
				status: "active",
				host_session_ref: "original-stop-session",
			});
			expect(
				await h.store.claim({
					schemaVersion: 1,
					itemId: second.itemId,
					workerId: "successor",
					leaseDurationMs: 30_000,
				}),
			).toEqual({ outcome: "busy" });
			const [event] =
				await client`select event_payload from platform.conversation_events where execution_id = ${first.executionId} and event_payload->>'reason' = 'STOP_CONFIRMATION_TIMEOUT'`;
			expect(event?.event_payload).toEqual({
				type: "task.status",
				status: "unknown",
				reason: "STOP_CONFIRMATION_TIMEOUT",
			});
			expect(
				await h.store.renew({ claim: owned, leaseDurationMs: 30_000 }),
			).toBe(true);
			const [count] =
				await client`select count(*)::int as value from platform.conversation_events where execution_id = ${first.executionId} and event_payload->>'reason' = 'STOP_CONFIRMATION_TIMEOUT'`;
			expect(count?.value).toBe(1);
		} finally {
			await h.close();
		}
	});

	it("keeps a timed-out Execution unknown after a running response, then releases the queue on confirmed natural completion", async () => {
		const h = await waitingTaskHarness();
		try {
			const first = await h.submit("stop-terminal-first");
			const owned = await h.own(first.itemId);
			await h.store.prepareRuntimeDispatch({
				claim: owned,
				leaseDurationMs: 30_000,
			});
			await h.store.recordRuntimeResponse({
				claim: owned,
				hostSessionRef: "original-stop-session",
				transition: {
					executionStatus: "processing",
					conversationStatus: "active",
				},
			});
			const second = await h.submit(
				"stop-terminal-second",
				first.conversationId,
			);
			await h.control(first.executionId, "stop");
			await client`update platform.conversation_stops set confirmation_deadline = clock_timestamp() - interval '1 second' where execution_id = ${first.executionId}`;
			await h.store.renew({ claim: owned, leaseDurationMs: 30_000 });
			expect(
				await h.store.recordRuntimeResponse({
					claim: { ...owned, stopPending: true },
					hostSessionRef: "original-stop-session",
					transition: {
						executionStatus: "processing",
						conversationStatus: "active",
					},
				}),
			).toBe(true);
			expect((await taskQueueState(first.executionId)).status).toBe("unknown");
			expect(
				await h.store.finish({
					claim: owned,
					status: "succeeded",
					transition: {
						executionStatus: "completed",
						conversationStatus: "ready",
					},
				}),
			).toBe(true);
			const [stop] =
				await client`select status from platform.conversation_stops where execution_id = ${first.executionId}`;
			expect(stop?.status).toBe("completed");
			const next = await h.own(second.itemId);
			expect(
				await h.store.prepareRuntimeDispatch({
					claim: next,
					leaseDurationMs: 30_000,
				}),
			).toBe(true);
			expect((await taskQueueState(first.executionId)).status).toBe(
				"completed",
			);
		} finally {
			await h.close();
		}
	});

	it("rolls back deadline observation, state, events and lease when required timeout audit fails", async () => {
		const h = await waitingTaskHarness();
		try {
			const first = await h.submit("stop-audit-first");
			const owned = await h.own(first.itemId);
			await h.store.prepareRuntimeDispatch({
				claim: owned,
				leaseDurationMs: 30_000,
			});
			await h.store.recordRuntimeResponse({
				claim: owned,
				hostSessionRef: "original-stop-session",
				transition: {
					executionStatus: "processing",
					conversationStatus: "active",
				},
			});
			await h.control(first.executionId, "stop");
			await client`update platform.conversation_stops set confirmation_deadline = clock_timestamp() - interval '1 second' where execution_id = ${first.executionId}`;
			const [before] =
				await client`select lease_expires_at from platform.outbox_items where id = ${first.itemId}`;
			await client.unsafe(
				"create function platform.isolation_confirmation_failure() returns trigger language plpgsql as $$ begin if NEW.details->>'reason' = 'STOP_CONFIRMATION_TIMEOUT' then raise exception 'timeout audit failure'; end if; return NEW; end $$",
			);
			await client.unsafe(
				"create trigger isolation_confirmation_failure before insert on platform.audit_events for each row execute function platform.isolation_confirmation_failure()",
			);
			await expect(
				h.store.renew({ claim: owned, leaseDurationMs: 60_000 }),
			).rejects.toMatchObject({ code: "CONVERSATION_DISPATCH_STORE_ERROR" });
			expect((await taskQueueState(first.executionId)).status).toBe(
				"processing",
			);
			const [stop] =
				await client`select confirmation_timed_out_at from platform.conversation_stops where execution_id = ${first.executionId}`;
			expect(stop?.confirmation_timed_out_at).toBeNull();
			const [after] =
				await client`select lease_expires_at from platform.outbox_items where id = ${first.itemId}`;
			expect(after).toEqual(before);
			const [events] =
				await client`select count(*)::int as count from platform.conversation_events where execution_id = ${first.executionId} and event_payload->>'reason' = 'STOP_CONFIRMATION_TIMEOUT'`;
			expect(events?.count).toBe(0);
		} finally {
			await h.close();
		}
	});

	it("fixes the first running cancellation deadline across repeated control and a reopened Worker", async () => {
		const h = await waitingTaskHarness();
		try {
			const first = await h.submit("stop-deadline-first");
			const owned = await h.own(first.itemId);
			expect(
				await h.store.prepareRuntimeDispatch({
					claim: owned,
					leaseDurationMs: 30_000,
				}),
			).toBe(true);
			expect(
				await h.store.recordRuntimeResponse({
					claim: owned,
					hostSessionRef: "original-stop-session",
					transition: {
						executionStatus: "processing",
						conversationStatus: "active",
					},
				}),
			).toBe(true);
			await h.control(first.executionId, "stop");
			const [initial] =
				await client`select stop_request_id, confirmation_deadline, created_at from platform.conversation_stops where execution_id = ${first.executionId}`;
			expect(
				initial?.confirmation_deadline.getTime() -
					initial?.created_at.getTime(),
			).toBe(60_000);
			await h.control(first.executionId, "authorization_revoked");
			const restarted = open();
			try {
				expect(
					await restarted.renew({ claim: owned, leaseDurationMs: 30_000 }),
				).toBe(true);
			} finally {
				await restarted.close();
			}
			const [after] =
				await client`select stop_request_id, confirmation_deadline, created_at from platform.conversation_stops where execution_id = ${first.executionId}`;
			expect(after).toEqual(initial);
		} finally {
			await h.close();
		}
	});
});

describe("durable waiting task dispatch from real admission", () => {
	it("promotes only the earliest same-Conversation task despite reversed discovery order and concurrent claims", async () => {
		const h = await waitingTaskHarness(2);
		try {
			const first = await h.submit("z-first");
			const second = await h.submit("a-second", first.conversationId);
			const discovered = await h.store.findDispatchable({ limit: 20 });
			expect(discovered.map((work) => work.itemId)).toEqual([
				second.itemId,
				first.itemId,
			]);
			const claims = await Promise.all(
				[first, second].map((work, index) =>
					h.store.claim({
						schemaVersion: 1,
						itemId: work.itemId,
						workerId: `order-worker-${index}`,
						leaseDurationMs: 30_000,
					}),
				),
			);
			expect(claims[1]).toEqual({ outcome: "busy" });
			const original = claims[0];
			if (original?.outcome !== "claimed")
				throw new Error("Earliest claim missing");
			expect(
				await h.store.prepareRuntimeDispatch({
					claim: original.claim,
					leaseDurationMs: 30_000,
				}),
			).toBe(true);
			expect((await taskQueueState(first.executionId)).status).toBe("unknown");
			expect(
				await h.store.claim({
					schemaVersion: 1,
					itemId: second.itemId,
					workerId: "blocked-worker",
					leaseDurationMs: 30_000,
				}),
			).toEqual({ outcome: "busy" });
			await h.store.finish({
				claim: original.claim,
				status: "succeeded",
				transition: { executionStatus: "processing" },
			});
			expect(
				await h.store.claim({
					schemaVersion: 1,
					itemId: second.itemId,
					workerId: "processing-worker",
					leaseDurationMs: 30_000,
				}),
			).toEqual({ outcome: "busy" });
			await client`update platform.conversation_executions set status = 'completed' where execution_id = ${first.executionId}`;
			await client`insert into platform.conversation_stops (execution_id, stop_request_id, status, created_at, updated_at)
				values (${first.executionId}, 'waiting-order-stop', 'submitted', clock_timestamp(), clock_timestamp())`;
			expect(
				await h.store.claim({
					schemaVersion: 1,
					itemId: second.itemId,
					workerId: "stop-worker",
					leaseDurationMs: 30_000,
				}),
			).toEqual({ outcome: "busy" });
			await client`update platform.conversation_stops set status = 'completed' where execution_id = ${first.executionId}`;
			expect(
				await h.store.prepareRuntimeDispatch({
					claim: await h.own(second.itemId),
					leaseDurationMs: 30_000,
				}),
			).toBe(true);
		} finally {
			await h.close();
		}
	});

	it("atomically reserves capacity across Conversations and retains unknown occupancy after restart and deadline expiry", async () => {
		const h = await waitingTaskHarness();
		const restarted = open();
		try {
			const works = [await h.submit("first"), await h.submit("second")];
			const originals = await Promise.all(
				works.map((work, index) =>
					h.own(work.itemId, `capacity-waiting-${index}`),
				),
			);
			const prepared = await Promise.all(
				originals.map((claim) =>
					h.store.prepareRuntimeDispatch({ claim, leaseDurationMs: 30_000 }),
				),
			);
			expect(prepared.filter((outcome) => outcome === true)).toHaveLength(1);
			const winnerIndex = prepared.indexOf(true);
			const loserIndex = winnerIndex === 0 ? 1 : 0;
			const winner = works[winnerIndex];
			const loser = works[loserIndex];
			const winnerClaim = originals[winnerIndex];
			const loserClaim = originals[loserIndex];
			if (!winner || !loser || !winnerClaim || !loserClaim)
				throw new Error("Missing capacity fixture");
			expect((await taskQueueState(loser.executionId)).status).toBe("waiting");
			const original = await taskQueueState(winner.executionId);
			await client`update platform.outbox_items set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${winner.itemId}`;
			const takeover = await restarted.claim({
				schemaVersion: 1,
				itemId: winner.itemId,
				workerId: "restart-worker",
				leaseDurationMs: 30_000,
			});
			if (takeover.outcome !== "claimed")
				throw new Error("Restart claim missing");
			expect(
				await restarted.prepareRuntimeDispatch({
					claim: takeover.claim,
					leaseDurationMs: 30_000,
				}),
			).toBe(true);
			expect(await taskQueueState(winner.executionId)).toMatchObject({
				status: "unknown",
				wait_order: original.wait_order,
				task_wait_deadline: original.task_wait_deadline,
			});
			await expireTask(winner.executionId);
			expect(
				await restarted.prepareRuntimeDispatch({
					claim: takeover.claim,
					leaseDurationMs: 30_000,
				}),
			).toBe(true);
			expect((await taskQueueState(winner.executionId)).status).toBe("unknown");
			expect(
				await h.store.prepareRuntimeDispatch({
					claim: loserClaim,
					leaseDurationMs: 30_000,
				}),
			).not.toBe(true);
			await expireTask(loser.executionId);
			expect(
				await h.store.prepareRuntimeDispatch({
					claim: loserClaim,
					leaseDurationMs: 30_000,
				}),
			).toBe(false);
			expect((await taskQueueState(loser.executionId)).status).toBe("failed");
			const events =
				await client`select event_payload from platform.conversation_events where execution_id = ${loser.executionId} order by sequence`;
			expect(events.map((event) => event.event_payload.status)).toEqual([
				"waiting",
				"failed",
			]);
			expect(
				await client`select details from platform.audit_events where target_id = ${loser.executionId} and action = 'task.status.changed'`,
			).toEqual([
				expect.objectContaining({
					details: expect.objectContaining({
						status: "failed",
						reason: "TASK_WAIT_TIMEOUT",
					}),
				}),
			]);
		} finally {
			await Promise.all([h.close(), restarted.close()]);
		}
	});

	it("preserves queued deadline and order through durable retry and discovers timeout even before retry availability", async () => {
		const h = await waitingTaskHarness();
		const restarted = open();
		try {
			const work = await h.submit("retry-deadline");
			const original = await taskQueueState(work.executionId);
			const claimed = await h.own(work.itemId);
			expect(
				await h.store.retry({
					claim: claimed,
					retryDelayMs: 60_000,
					errorCode: "AUTHORIZATION_UNAVAILABLE",
					transition: {},
				}),
			).toBe(true);
			expect(await taskQueueState(work.executionId)).toMatchObject({
				status: "waiting",
				wait_order: original.wait_order,
				task_wait_deadline: original.task_wait_deadline,
			});
			expect(await restarted.findDispatchable({ limit: 20 })).toEqual([]);
			await expireTask(work.executionId);
			expect(await restarted.findDispatchable({ limit: 20 })).toEqual([
				{ itemId: work.itemId, operation: "conversation.turn.submit.v1" },
			]);
			expect(
				await restarted.claim({
					schemaVersion: 1,
					itemId: work.itemId,
					workerId: "retry-timeout-worker",
					leaseDurationMs: 30_000,
				}),
			).toEqual({ outcome: "failed" });
			expect((await taskQueueState(work.executionId)).status).toBe("failed");
			expect(h.runtimeHost.sideEffectCount()).toBe(0);
		} finally {
			await Promise.all([h.close(), restarted.close()]);
		}
	});

	it("rolls back promotion, status event and Conversation cursor if the required task status audit cannot persist", async () => {
		const h = await waitingTaskHarness();
		try {
			const work = await h.submit("audit-rollback");
			const claimed = await h.own(work.itemId);
			const original = await taskQueueState(work.executionId);
			const before =
				await client`select status, last_conversation_cursor from platform.conversations where id = ${work.conversationId}`;
			await client`create function platform.waiting_task_audit_failure() returns trigger language plpgsql as $$
				begin if NEW.action = 'task.status.changed' then raise exception 'task status audit unavailable'; end if; return NEW; end $$`;
			await client`create trigger waiting_task_audit_failure before insert on platform.audit_events
				for each row execute function platform.waiting_task_audit_failure()`;
			await expect(
				h.store.prepareRuntimeDispatch({
					claim: claimed,
					leaseDurationMs: 30_000,
				}),
			).rejects.toThrow("Conversation dispatch store is unavailable");
			expect(await taskQueueState(work.executionId)).toEqual(original);
			expect(
				await client`select status, last_conversation_cursor from platform.conversations where id = ${work.conversationId}`,
			).toEqual(before);
			const events =
				await client`select event_payload from platform.conversation_events where execution_id = ${work.executionId} order by sequence`;
			expect(events.map((event) => event.event_payload.status)).toEqual([
				"waiting",
			]);
			expect(
				await client`select id from platform.audit_events where target_id = ${work.executionId} and action = 'task.status.changed'`,
			).toEqual([]);
			await client`drop trigger waiting_task_audit_failure on platform.audit_events`;
			await client`drop function platform.waiting_task_audit_failure()`;
			expect(
				await h.store.prepareRuntimeDispatch({
					claim: claimed,
					leaseDurationMs: 30_000,
				}),
			).toBe(true);
		} finally {
			await client`drop trigger if exists waiting_task_audit_failure on platform.audit_events`;
			await client`drop function if exists platform.waiting_task_audit_failure()`;
			await h.close();
		}
	});

	it.each(["starting", "updating"])(
		"keeps %s tasks durable until service readiness returns",
		async (availability) => {
			const h = await waitingTaskHarness();
			try {
				await client`update platform.agent_applications set service_availability = ${availability} where agent_id = ${h.agentId}`;
				const work = await h.submit(availability);
				const original = await taskQueueState(work.executionId);
				expect(await h.dispatch(work.itemId)).toMatchObject({
					outcome: "busy",
				});
				expect(h.runtimeHost.sideEffectCount()).toBe(0);
				expect(await taskQueueState(work.executionId)).toEqual(original);
				await client`update platform.agent_applications set service_availability = 'ready' where agent_id = ${h.agentId}`;
				await h.dispatch(work.itemId);
				expect(h.runtimeHost.sideEffectCount()).toBe(1);
			} finally {
				await h.close();
			}
		},
	);

	it.each(["stopping", "fault"])(
		"fails a waiting task after Agent changes to %s",
		async (availability) => {
			const h = await waitingTaskHarness();
			try {
				const work = await h.submit(availability);
				if (availability === "stopping")
					await client`update platform.agent_applications set status = 'stopped', desired_state = 'stopped', service_availability = null where agent_id = ${h.agentId}`;
				else
					await client`update platform.agent_applications set service_availability = 'unavailable', failure_code = 'workload_unavailable' where agent_id = ${h.agentId}`;
				await h.dispatch(work.itemId);
				expect(h.runtimeHost.sideEffectCount()).toBe(0);
				expect((await taskQueueState(work.executionId)).status).toBe("failed");
				expect((await dispatchState(work))?.status).toBe("failed");
			} finally {
				await h.close();
			}
		},
	);

	it.each(["timeout", "lifecycle"])(
		"rechecks %s after claim and before any Runtime call",
		async (change) => {
			const h = await waitingTaskHarness();
			try {
				const work = await h.submit(change);
				await h.dispatch(work.itemId, async () => {
					if (change === "timeout") await expireTask(work.executionId);
					else
						await client`update platform.agent_applications set status = 'stopped', desired_state = 'stopped', service_availability = null where agent_id = ${h.agentId}`;
				});
				expect(h.runtimeHost.sideEffectCount()).toBe(0);
				expect((await taskQueueState(work.executionId)).status).toBe("failed");
			} finally {
				await h.close();
			}
		},
	);

	it.each(["stop", "authorization_revoked"] as const)(
		"locally cancels waiting work for %s during authorization without sending Runtime stop",
		async (reason) => {
			const h = await waitingTaskHarness();
			try {
				const work = await h.submit(reason);
				await h.dispatch(work.itemId, async () => {
					await h.control(work.executionId, reason);
				});
				expect(h.runtimeHost.sideEffectCount()).toBe(0);
				expect((await taskQueueState(work.executionId)).status).toBe(
					"cancelled",
				);
				expect(
					await client`select execution_id from platform.conversation_stops where execution_id = ${work.executionId}`,
				).toEqual([]);
				expect(
					await client`select id from platform.outbox_items where operation = 'conversation.turn.stop.v1'`,
				).toEqual([]);
				expect(
					await client`select action from platform.audit_events where target_id = ${work.executionId} and actor_type = 'system' and action = 'task.control.created'`,
				).toHaveLength(1);
				const events =
					await client`select event_payload from platform.conversation_events where execution_id = ${work.executionId} order by sequence`;
				expect(events.map((event) => event.event_payload.status)).toEqual([
					"waiting",
					"cancelled",
				]);
			} finally {
				await h.close();
			}
		},
	);

	it.each(["stop", "authorization_revoked"] as const)(
		"serializes concurrent %s control against waiting promotion",
		async (reason) => {
			const h = await waitingTaskHarness();
			try {
				const work = await h.submit(`race-${reason}`);
				const claimed = await h.own(work.itemId);
				const [prepared] = await Promise.all([
					h.store.prepareRuntimeDispatch({
						claim: claimed,
						leaseDurationMs: 30_000,
					}),
					h.control(work.executionId, reason),
				]);
				const state = await taskQueueState(work.executionId);
				const stops =
					await client`select status from platform.conversation_stops where execution_id = ${work.executionId}`;
				if (prepared === true) {
					expect(state.status).toBe("unknown");
					expect(stops).toEqual([
						expect.objectContaining({ status: "submitted" }),
					]);
				} else {
					expect(state.status).toBe("cancelled");
					expect(stops).toEqual([]);
				}
				expect(
					await h.store.prepareRuntimeDispatch({
						claim: claimed,
						leaseDurationMs: 30_000,
					}),
				).toBe(false);
				expect(
					await client`select action from platform.audit_events where target_id = ${work.executionId} and actor_type = 'system' and action = 'task.control.created'`,
				).toHaveLength(1);
				expect(h.runtimeHost.sideEffectCount()).toBe(0);
			} finally {
				await h.close();
			}
		},
	);

	it("rejects an expired lease and old fence while preserving the original waiting deadline and order", async () => {
		const h = await waitingTaskHarness();
		try {
			const work = await h.submit("takeover");
			const original = await taskQueueState(work.executionId);
			const old = await h.own(work.itemId, "old-worker");
			await client`update platform.outbox_items set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${work.itemId}`;
			expect(
				await h.store.prepareRuntimeDispatch({
					claim: old,
					leaseDurationMs: 30_000,
				}),
			).toBe(false);
			const current = await h.own(work.itemId, "new-worker");
			expect(current.executionDeliveryFence).toBeGreaterThan(
				old.executionDeliveryFence,
			);
			expect(
				await h.store.prepareRuntimeDispatch({
					claim: old,
					leaseDurationMs: 30_000,
				}),
			).toBe(false);
			expect(await taskQueueState(work.executionId)).toMatchObject({
				status: "waiting",
				wait_order: original.wait_order,
				task_wait_deadline: original.task_wait_deadline,
			});
			expect(
				await h.store.prepareRuntimeDispatch({
					claim: current,
					leaseDurationMs: 30_000,
				}),
			).toBe(true);
		} finally {
			await h.close();
		}
	});

	it("persists one local cancelled task status after original Runtime acceptance is proven absent, retaining original authorization provenance", async () => {
		const h = await waitingTaskHarness();
		try {
			const work = await h.submit("unaccepted-cancel");
			const original = await h.own(work.itemId);
			expect(
				await h.store.prepareRuntimeDispatch({
					claim: original,
					leaseDurationMs: 30_000,
				}),
			).toBe(true);
			await client`update platform.conversations set authorization_revision = 'new-conversation-grant' where id = ${work.conversationId}`;
			await h.control(work.executionId, "stop");
			await client`update platform.outbox_items set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${work.itemId}`;
			const recovered = await h.own(work.itemId, "not-found-proof-worker");
			expect(recovered).toMatchObject({
				executionStatus: "unknown",
				stopPending: true,
				authorizationRevision: "waiting-grant",
			});
			const [before] =
				await client`select last_conversation_cursor::int as cursor from platform.conversations where id = ${work.conversationId}`;
			// The RuntimeHost not_found result authorizes this existing local cancel method.
			expect(await h.store.cancelUnaccepted({ claim: recovered })).toBe(true);
			expect((await taskQueueState(work.executionId)).status).toBe("cancelled");
			const events =
				await client`select event_payload from platform.conversation_events where execution_id = ${work.executionId} and event_type = 'task.status' order by sequence`;
			expect(events.map((event) => event.event_payload.status)).toEqual([
				"waiting",
				"unknown",
				"cancelled",
			]);
			const audits =
				await client`select actor_id, details from platform.audit_events where target_id = ${work.executionId}
				and action = 'task.status.changed' and details->>'status' = 'cancelled'`;
			expect(audits).toEqual([
				expect.objectContaining({
					actor_id: "not-found-proof-worker",
					details: expect.objectContaining({
						status: "cancelled",
						reason: "TASK_CANCELLED",
						originalPrincipal: { kind: "user", id: "waiting-user" },
					}),
				}),
			]);
			const conversation =
				await client`select status, authorization_revision, last_conversation_cursor::int as cursor from platform.conversations where id = ${work.conversationId}`;
			expect(conversation).toEqual([
				{
					status: "ready",
					authorization_revision: "new-conversation-grant",
					cursor: Number(before?.cursor) + 1,
				},
			]);
			expect(await h.store.cancelUnaccepted({ claim: recovered })).toBe(false);
			expect(
				await client`select status, authorization_revision, last_conversation_cursor::int as cursor from platform.conversations where id = ${work.conversationId}`,
			).toEqual(conversation);
			expect(
				await client`select event_payload from platform.conversation_events where execution_id = ${work.executionId} and event_type = 'task.status' order by sequence`,
			).toEqual(events);
			expect(
				await client`select actor_id, details from platform.audit_events where target_id = ${work.executionId}
				and action = 'task.status.changed' and details->>'status' = 'cancelled'`,
			).toEqual(audits);
			expect(h.runtimeHost.sideEffectCount()).toBe(0);
		} finally {
			await h.close();
		}
	});

	it("completes concurrent message admission and model reads against waiting preparation without a lock cycle", async () => {
		const h = await waitingTaskHarness();
		const transaction = new PostgresConversationExecutionTransactionV1({
			databaseUrl,
		});
		try {
			const work = await h.submit("web-race");
			const claimed = await h.own(work.itemId);
			const web = createConversationExecutionUseCaseV1({
				transaction,
				authorization: {
					async authorize() {
						return {
							outcome: "allowed",
							authority: {
								schemaVersion: 1,
								actorId: "waiting-user",
								agentId: h.agentId,
								channelId: "api",
								authorizationRevision: "waiting-grant",
								supportsSupplementaryInstruction: false,
							},
						};
					},
				},
			});
			const [prepared, message, read, selection] = await Promise.all([
				h.store.prepareRuntimeDispatch({
					claim: claimed,
					leaseDurationMs: 30_000,
				}),
				web.accept({
					schemaVersion: 1,
					command: "message",
					conversationId: work.conversationId,
					text: "concurrent normal message",
					idempotencyKey: "web-race-message",
					requestId: "web-race-message",
					traceId: "web-race-trace",
				}),
				web.readConversation({
					schemaVersion: 1,
					conversationId: work.conversationId,
				}),
				web.selectModel({
					schemaVersion: 1,
					command: "model.select",
					conversationId: work.conversationId,
					modelOptionId: "model-option-dispatch",
					reasoningLevel: "medium",
					idempotencyKey: "web-race-model",
					requestId: "web-race-model",
					traceId: "web-race-trace",
				}),
			]);
			expect(prepared).toBe(true);
			expect(message).toEqual({ outcome: "busy" });
			expect(read).toMatchObject({ outcome: "found" });
			expect(selection).toMatchObject({ outcome: "accepted" });
			expect((await taskQueueState(work.executionId)).status).toBe("unknown");
			expect(
				await client`select execution_id from platform.conversation_executions where conversation_id = ${work.conversationId}`,
			).toEqual([{ execution_id: work.executionId }]);
		} finally {
			await Promise.all([h.close(), transaction.close()]);
		}
	});

	it("keeps accepted provenance when the Conversation authorization revision changes before promotion", async () => {
		const h = await waitingTaskHarness();
		try {
			const work = await h.submit("auth-revision");
			await client`update platform.conversations set authorization_revision = 'current-conversation-grant' where id = ${work.conversationId}`;
			expect(
				await h.dispatch(work.itemId, async (claim) => {
					expect(claim.authorizationRevision).toBe("waiting-grant");
				}),
			).toMatchObject({ outcome: "retry" });
			expect(h.runtimeHost.sideEffectCount()).toBe(1);
			expect((await taskQueueState(work.executionId)).status).toBe("unknown");
			const [binding] =
				await client`select e.authorization_revision as accepted_revision, a.boundary->>'agentAuthorizationRevision' as original_revision,
				c.authorization_revision as conversation_revision, c.host_session_ref from platform.conversation_executions e
				join platform.task_authorization_records a on a.execution_id = e.execution_id
				join platform.conversations c on c.id = e.conversation_id where e.execution_id = ${work.executionId}`;
			expect(binding).toEqual({
				accepted_revision: "waiting-grant",
				original_revision: "waiting-grant",
				conversation_revision: "current-conversation-grant",
				host_session_ref: `host-session-${work.conversationId}`,
			});
			const events =
				await client`select event_payload from platform.conversation_events where execution_id = ${work.executionId} and event_type = 'task.status' order by sequence`;
			expect(events.map((event) => event.event_payload.status)).toContain(
				"processing",
			);
			expect(events.at(-1)?.event_payload.status).toBe("unknown");
		} finally {
			await h.close();
		}
	});

	it.each(["busy", "rejected"] as const)(
		"releases only the promoted Conversation occupancy after Runtime %s",
		async (outcome) => {
			const h = await waitingTaskHarness(2);
			try {
				const occupied = await h.submit("occupied");
				expect(await h.dispatch(occupied.itemId)).toMatchObject({
					outcome: "retry",
				});
				const rejected = await h.submit("rejected");
				h.runtimeHost.setResult(
					outcome === "busy"
						? { outcome: "busy" }
						: {
								outcome: "rejected",
								code: "RUNTIME_TURN_NOT_ACTIVE",
								message: "Runtime turn is no longer active",
								retryable: false,
							},
				);
				await h.dispatch(rejected.itemId);
				expect((await taskQueueState(occupied.executionId)).status).toBe(
					"unknown",
				);
				expect((await taskQueueState(rejected.executionId)).status).toBe(
					"failed",
				);
				expect(h.runtimeHost.sideEffectCount()).toBe(2);
				expect(await h.dispatch(rejected.itemId)).toMatchObject({
					outcome: "rejected",
				});
				expect(h.runtimeHost.sideEffectCount()).toBe(2);
				const conversations =
					await client`select id, status from platform.conversations order by id`;
				expect(conversations).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							id: occupied.conversationId,
							status: "active",
						}),
						expect.objectContaining({
							id: rejected.conversationId,
							status: "ready",
						}),
					]),
				);
				const next = await h.submit("next", rejected.conversationId);
				h.runtimeHost.setResult({ outcome: "accepted", status: "running" });
				await h.dispatch(next.itemId);
				expect((await taskQueueState(next.executionId)).status).toBe("unknown");
			} finally {
				await h.close();
			}
		},
	);
});

async function unknownTaskFixture() {
	const h = await waitingTaskHarness();
	try {
		const work = await h.submit("unsent-proof");
		const claim = await h.own(work.itemId, "unsent-proof-worker");
		expect(
			await h.store.prepareRuntimeDispatch({ claim, leaseDurationMs: 30_000 }),
		).toBe(true);
		const hostSessionRef = `unsent-host-${work.conversationId}`;
		return { ...h, work, claim, hostSessionRef };
	} catch (error) {
		await h.close();
		throw error;
	}
}

async function originalTaskBinding(executionId: string) {
	const [row] =
		await client`select execution_id, conversation_id, turn_id, actor_id, channel_id,
		session_generation::text, delivery_fence::text, task_wait_order::text, task_wait_deadline,
		model_configuration_revision::text, model_option_id, reasoning_level,
		(select message_id from platform.conversation_messages m where m.execution_id = e.execution_id and role = 'user') as message_id,
		(select id from platform.outbox_items o where o.payload->>'executionId' = e.execution_id and operation = 'conversation.turn.submit.v1') as item_id
		from platform.conversation_executions e where execution_id = ${executionId}`;
	if (!row) throw new Error("Missing original task binding");
	return row;
}

async function taskStatusEvents(executionId: string) {
	return client`select event_payload from platform.conversation_events
		where execution_id = ${executionId} and event_type = 'task.status' order by sequence`;
}

describe("confirmed unsent task reconciliation", () => {
	it.each(["ready", "starting", "updating"])(
		"restores %s unsent work with its original queue and identity, then reserves a later fence",
		async (availability) => {
			const h = await unknownTaskFixture();
			try {
				const binding = await originalTaskBinding(h.work.executionId);
				await client`update platform.agent_applications set service_availability = ${availability} where agent_id = ${h.agentId}`;
				expect(
					await h.store.reconcileUnacceptedTask({
						claim: h.claim,
						hostSessionRef: h.hostSessionRef,
					}),
				).toBe("waiting");
				expect((await taskQueueState(h.work.executionId)).status).toBe(
					"waiting",
				);
				expect(await originalTaskBinding(h.work.executionId)).toEqual(binding);
				const [outbox] =
					await client`select status, lease_owner, lease_expires_at from platform.outbox_items where id = ${h.work.itemId}`;
				expect(outbox).toMatchObject({
					status: "retry_scheduled",
					lease_owner: null,
					lease_expires_at: null,
				});
				const [conversation] =
					await client`select status, session_generation::text as generation, host_session_ref from platform.conversations where id = ${h.work.conversationId}`;
				expect(conversation).toEqual({
					status: "ready",
					generation: binding.session_generation,
					host_session_ref: h.hostSessionRef,
				});
				expect(
					(await taskStatusEvents(h.work.executionId)).map(
						(event) => event.event_payload.status,
					),
				).toEqual(["waiting", "unknown", "waiting"]);
				expect(
					await h.store.reconcileUnacceptedTask({
						claim: h.claim,
						hostSessionRef: h.hostSessionRef,
					}),
				).toBe("stale");
				if (availability !== "ready") {
					expect(
						await h.store.claim({
							schemaVersion: 1,
							itemId: h.work.itemId,
							workerId: "still-starting-worker",
							leaseDurationMs: 30_000,
						}),
					).toEqual({ outcome: "busy" });
					await client`update platform.agent_applications set service_availability = 'ready' where agent_id = ${h.agentId}`;
				}
				const next = await h.own(h.work.itemId, "unsent-next-worker");
				expect(next.executionDeliveryFence).toBeGreaterThan(
					h.claim.executionDeliveryFence,
				);
				expect(next.deliveryFence).toBeGreaterThan(h.claim.deliveryFence);
				expect(
					await h.store.prepareRuntimeDispatch({
						claim: next,
						leaseDurationMs: 30_000,
					}),
				).toBe(true);
				expect((await taskQueueState(h.work.executionId)).status).toBe(
					"unknown",
				);
				expect(h.runtimeHost.sideEffectCount()).toBe(0);
			} finally {
				await h.close();
			}
		},
	);

	it("retains unknown occupancy past its queue deadline until typed absence proof permits failure", async () => {
		const h = await unknownTaskFixture();
		try {
			const binding = await originalTaskBinding(h.work.executionId);
			await expireTask(h.work.executionId);
			expect(
				await h.store.prepareRuntimeDispatch({
					claim: h.claim,
					leaseDurationMs: 30_000,
				}),
			).toBe(true);
			expect((await taskQueueState(h.work.executionId)).status).toBe("unknown");
			const other = await h.submit("deadline-other");
			const otherClaim = await h.own(other.itemId, "deadline-other-worker");
			expect(
				await h.store.prepareRuntimeDispatch({
					claim: otherClaim,
					leaseDurationMs: 30_000,
				}),
			).toBe("capacity_wait");
			expect(
				await h.store.reconcileUnacceptedTask({
					claim: h.claim,
					hostSessionRef: h.hostSessionRef,
				}),
			).toBe("failed");
			expect((await taskQueueState(h.work.executionId)).status).toBe("failed");
			expect(
				(await originalTaskBinding(h.work.executionId)).task_wait_order,
			).toBe(binding.task_wait_order);
			expect(
				(await taskStatusEvents(h.work.executionId)).map(
					(event) => event.event_payload.status,
				),
			).toEqual(["waiting", "unknown", "failed"]);
			expect(
				await client`select details from platform.audit_events where target_id = ${h.work.executionId} and action = 'task.status.changed' and details->>'status' = 'failed'`,
			).toEqual([
				expect.objectContaining({
					details: expect.objectContaining({
						reason: "TASK_WAIT_TIMEOUT",
						originalPrincipal: { kind: "user", id: "waiting-user" },
					}),
				}),
			]);
			expect(
				await h.store.prepareRuntimeDispatch({
					claim: otherClaim,
					leaseDurationMs: 30_000,
				}),
			).toBe(true);
		} finally {
			await h.close();
		}
	});

	it.each(["stopped", "fault"])(
		"fails %s work after absence proof without replacing the original task",
		async (lifecycle) => {
			const h = await unknownTaskFixture();
			try {
				const binding = await originalTaskBinding(h.work.executionId);
				if (lifecycle === "stopped")
					await client`update platform.agent_applications set status = 'stopped', desired_state = 'stopped', service_availability = null where agent_id = ${h.agentId}`;
				else
					await client`update platform.agent_applications set service_availability = 'unavailable', failure_code = 'workload_unavailable' where agent_id = ${h.agentId}`;
				expect(
					await h.store.reconcileUnacceptedTask({
						claim: h.claim,
						hostSessionRef: h.hostSessionRef,
					}),
				).toBe("failed");
				expect((await taskQueueState(h.work.executionId)).status).toBe(
					"failed",
				);
				expect(await originalTaskBinding(h.work.executionId)).toEqual(binding);
				expect((await dispatchState(h.work))?.status).toBe("failed");
				expect(
					await client`select status from platform.conversations where id = ${h.work.conversationId}`,
				).toEqual([{ status: "ready" }]);
			} finally {
				await h.close();
			}
		},
	);

	it.each(["stop", "revoked-without-stop"])(
		"converges %s to one cancellation on the original task and stop",
		async (control) => {
			const h = await unknownTaskFixture();
			try {
				if (control === "stop") await h.control(h.work.executionId, "stop");
				else
					await client`update platform.task_authorization_records set revoked_at = clock_timestamp() where execution_id = ${h.work.executionId}`;
				await client`update platform.outbox_items set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${h.work.itemId}`;
				const claim = await h.own(h.work.itemId, "unsent-control-worker");
				expect(claim.stopPending).toBe(control === "stop");
				const binding = await originalTaskBinding(h.work.executionId);
				expect(
					await h.store.reconcileUnacceptedTask({
						claim,
						hostSessionRef: h.hostSessionRef,
					}),
				).toBe("cancelled");
				expect((await taskQueueState(h.work.executionId)).status).toBe(
					"cancelled",
				);
				expect(await originalTaskBinding(h.work.executionId)).toEqual(binding);
				expect(
					(await taskStatusEvents(h.work.executionId)).map(
						(event) => event.event_payload.status,
					),
				).toEqual(["waiting", "unknown", "cancelled"]);
				const stops =
					await client`select status from platform.conversation_stops where execution_id = ${h.work.executionId}`;
				expect(stops).toEqual(
					control === "stop" ? [{ status: "completed" }] : [],
				);
				if (control === "stop") {
					expect(
						await client`select status from platform.outbox_items where payload->>'executionId' = ${h.work.executionId} and operation = 'conversation.turn.stop.v1'`,
					).toEqual([{ status: "succeeded" }]);
				}
				const before =
					await client`select last_conversation_cursor from platform.conversations where id = ${h.work.conversationId}`;
				expect(
					await h.store.reconcileUnacceptedTask({
						claim,
						hostSessionRef: h.hostSessionRef,
					}),
				).toBe("stale");
				expect(
					await client`select last_conversation_cursor from platform.conversations where id = ${h.work.conversationId}`,
				).toEqual(before);
				expect(
					(await taskStatusEvents(h.work.executionId)).filter(
						(event) => event.event_payload.status === "cancelled",
					),
				).toHaveLength(1);
			} finally {
				await h.close();
			}
		},
	);

	it.each([
		"lease",
		"fence",
		"session",
		"cursor",
		"host-reference",
		"isolation",
		"found",
	])(
		"retains occupied state for %s that cannot prove absence of the original operation",
		async (mismatch) => {
			const h = await unknownTaskFixture();
			try {
				if (mismatch === "lease")
					await client`update platform.outbox_items set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${h.work.itemId}`;
				if (mismatch === "fence") {
					await client`update platform.outbox_items set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${h.work.itemId}`;
					await h.own(h.work.itemId, "unsent-fence-takeover-worker");
				}
				if (mismatch === "session")
					await client`update platform.conversations set session_generation = session_generation + 1 where id = ${h.work.conversationId}`;
				if (mismatch === "cursor")
					await client`update platform.conversation_executions set last_runtime_cursor = 'observed-runtime-cursor' where execution_id = ${h.work.executionId}`;
				if (mismatch === "host-reference")
					await client`update platform.conversations set host_session_ref = 'actual-original-host' where id = ${h.work.conversationId}`;
				if (mismatch === "isolation") {
					await client`update platform.outbox_items set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${h.work.itemId}`;
					h.claim = await h.own(h.work.itemId, "unsent-isolation-worker");
					expect(
						await h.store.beginGenerationIsolation({
							claim: h.claim,
							hostSessionRef: h.hostSessionRef,
							failureCode: "RUNTIME_SESSION_RECOVERY_FAILED",
						}),
					).toBe(true);
				}
				if (mismatch === "found")
					expect(
						await h.store.recordRuntimeResponse({
							claim: h.claim,
							hostSessionRef: h.hostSessionRef,
							transition: {
								executionStatus: "processing",
								conversationStatus: "active",
							},
						}),
					).toBe(true);
				const before = await taskQueueState(h.work.executionId);
				const events = await taskStatusEvents(h.work.executionId);
				expect(
					await h.store.reconcileUnacceptedTask({
						claim: h.claim,
						hostSessionRef: h.hostSessionRef,
					}),
				).toBe("stale");
				expect(await taskQueueState(h.work.executionId)).toEqual(before);
				expect(await taskStatusEvents(h.work.executionId)).toEqual(events);
				expect((await taskQueueState(h.work.executionId)).status).toBe(
					mismatch === "found" ? "processing" : "unknown",
				);
			} finally {
				await h.close();
			}
		},
	);

	it("rolls back original task and pending stop convergence when the required reconciliation audit fails", async () => {
		const h = await unknownTaskFixture();
		try {
			await h.control(h.work.executionId, "stop");
			await client`update platform.outbox_items set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${h.work.itemId}`;
			const claim = await h.own(h.work.itemId, "unsent-rollback-worker");
			const before = await taskQueueState(h.work.executionId);
			const events = await taskStatusEvents(h.work.executionId);
			const cursor =
				await client`select last_conversation_cursor from platform.conversations where id = ${h.work.conversationId}`;
			await client`create function platform.unsent_task_audit_failure() returns trigger language plpgsql as $$
				begin if NEW.action = 'task.status.changed' then raise exception 'unsent status audit unavailable'; end if; return NEW; end $$`;
			await client`create trigger unsent_task_audit_failure before insert on platform.audit_events for each row execute function platform.unsent_task_audit_failure()`;
			await expect(
				h.store.reconcileUnacceptedTask({
					claim,
					hostSessionRef: h.hostSessionRef,
				}),
			).rejects.toThrow("Conversation dispatch store is unavailable");
			expect(await taskQueueState(h.work.executionId)).toEqual(before);
			expect(await taskStatusEvents(h.work.executionId)).toEqual(events);
			expect(
				await client`select last_conversation_cursor from platform.conversations where id = ${h.work.conversationId}`,
			).toEqual(cursor);
			expect(
				await client`select status from platform.conversation_stops where execution_id = ${h.work.executionId}`,
			).toEqual([{ status: "submitted" }]);
			expect(
				await client`select status from platform.outbox_items where payload->>'executionId' = ${h.work.executionId} and operation = 'conversation.turn.stop.v1'`,
			).toEqual([{ status: "pending" }]);
			await client`drop trigger unsent_task_audit_failure on platform.audit_events`;
			await client`drop function platform.unsent_task_audit_failure()`;
			expect(
				await h.store.reconcileUnacceptedTask({
					claim,
					hostSessionRef: h.hostSessionRef,
				}),
			).toBe("cancelled");
		} finally {
			await client`drop trigger if exists unsent_task_audit_failure on platform.audit_events`;
			await client`drop function if exists platform.unsent_task_audit_failure()`;
			await h.close();
		}
	});
});

it("persists and confirms isolation of the original application generation after recovery failure", async () => {
	const work = await seedIsolation();
	const boundary = {
		schemaVersion: 1,
		principal: { kind: "application", id: "actor-dispatch" },
		agentId: "agent-dispatch",
		channelId: "api:application",
		identityRevision: "app-original",
		agentAuthorizationRevision: "authorization-dispatch",
		accessSources: [{ kind: "application", applicationId: "actor-dispatch" }],
	};
	await client`update platform.conversations set channel_id = 'api:application' where id = ${work.conversationId}`;
	await client`update platform.conversation_executions set channel_id = 'api:application' where execution_id = ${work.executionId}`;
	await client`update platform.task_authorization_records set boundary = ${client.json(boundary)} where execution_id = ${work.executionId}`;
	const first = await claim(work.itemId);
	try {
		if (first.decision.outcome !== "claimed") throw Error();
		expect(
			await first.store.beginGenerationIsolation({
				claim: first.decision.claim,
				hostSessionRef: "original-host",
				failureCode: "RUNTIME_SESSION_RECOVERY_FAILED",
			}),
		).toBe(true);
		expect(
			await first.store.retry({
				claim: first.decision.claim,
				retryDelayMs: 0,
				errorCode: "GENERATION_BARRIER_UNCONFIRMED",
				transition: {},
			}),
		).toBe(true);
		const next = await first.store.claim({
			schemaVersion: 1,
			itemId: work.itemId,
			workerId: "app-recovery",
			leaseDurationMs: 30000,
		});
		if (next.outcome !== "claimed") throw Error();
		expect(next.claim.generationIsolation?.originalPrincipal).toEqual({
			kind: "application",
			id: "actor-dispatch",
		});
		expect(
			await first.store.confirmGenerationIsolation({
				claim: next.claim,
				operationId: `generation:${work.conversationId}:1`,
				hostSessionRef: "original-host",
			}),
		).toBe(true);
		expect(await isolationState(work)).toMatchObject({
			generation: 2,
			status: "unavailable",
			execution_status: "failed",
			isolation_status: "confirmed",
		});
		const [tombstone] =
			await client`select original_principal from platform.conversation_generation_tombstones where conversation_id = ${work.conversationId}`;
		expect(tombstone?.original_principal).toEqual({
			kind: "application",
			id: "actor-dispatch",
		});
	} finally {
		await first.store.close();
	}
});
