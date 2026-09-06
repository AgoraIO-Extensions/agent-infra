import {
	type ConversationExecutionAuthorityV1,
	type ConversationExecutionTransactionPortV1,
	type ConversationExecutionUseCaseV1,
	type ConversationModelConfigurationV1,
	createConversationExecutionUseCaseV1,
} from "@agent-infra/platform-core";
import {
	type ConversationCommandConformanceSnapshotV1,
	conversationCommandConformanceV1,
	conversationConformanceAuthorityV1,
} from "@agent-infra/platform-core/testing";
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

const conformanceModelConfiguration = {
	configurationRevision: 1,
	options: [
		{ optionId: "model_primary", reasoningLevels: ["low", "medium"] },
		{ optionId: "model_alternate", reasoningLevels: ["high"] },
	],
	defaultOptionId: "model_primary",
	defaultReasoningLevel: "low",
} as const satisfies ConversationModelConfigurationV1;

let databaseUrl = "";
let client: ReturnType<typeof postgres>;
let testDatabase: PostgresTestDatabase | undefined;

const failureTable = {
	conversation: "platform.conversations",
	idempotency: "platform.idempotency_records",
	execution: "platform.conversation_executions",
	message: "platform.conversation_messages",
	stop: "platform.conversation_stops",
	outbox: "platform.outbox_items",
	audit: "platform.conversation_audit_events",
	commit: "platform.conversation_audit_events",
} as const;

type FailurePoint = keyof typeof failureTable;
const initialMessageFailurePoints = [
	"idempotency",
	"execution",
	"message",
	"outbox",
	"audit",
	"commit",
] as const;

beforeAll(async () => {
	testDatabase = await startPostgresTestDatabase("conversation-execution");
	databaseUrl = testDatabase.databaseUrl;
	await migratePlatformDatabase({ databaseUrl });
	client = postgres(databaseUrl, { max: 1 });
}, 120_000);

afterEach(async () => {
	await client`truncate platform.conversation_events,
		platform.conversation_audit_events, platform.audit_events,
		platform.outbox_items,
		platform.idempotency_records, platform.conversation_stops,
		platform.conversation_messages, platform.conversation_executions,
		platform.conversations`;
});

async function persistConformanceModelConfiguration(
	modelConfiguration: ConversationModelConfigurationV1 | undefined,
): Promise<void> {
	const revision = modelConfiguration?.configurationRevision ?? 1;
	const record = {
		schemaVersion: 1,
		agentId: conversationConformanceAuthorityV1.agentId,
		revision,
		source: modelConfiguration
			? {
					kind: "standard",
					templateId: "template_fixture",
					imageDigest: `sha256:${"a".repeat(64)}`,
					admissionRevision: "admission_fixture",
					allowedEnvironmentKeys: [],
					allowedSecretKeys: [],
					platformManagedKeys: [],
					connectionEnabled: false,
				}
			: {
					kind: "custom",
					imageDigest: `sha256:${"b".repeat(64)}`,
					admissionRevision: "admission_fixture",
					interactionMode: "platform-adapter",
					connectionEnabled: false,
				},
		modelConfiguration: modelConfiguration
			? {
					catalogRevision: `catalog_fixture_${revision}`,
					options: modelConfiguration.options.map(
						({ optionId, reasoningLevels }, index) => ({
							optionId,
							endpointId: `endpoint_fixture_${index}`,
							modelId: `model_fixture_${index}`,
							reasoningLevels,
							credential: {
								secretId: `secret_fixture_${index}`,
								version: 1,
								isSet: true,
							},
						}),
					),
					defaultOptionId: modelConfiguration.defaultOptionId,
					defaultReasoningLevel: modelConfiguration.defaultReasoningLevel,
				}
			: null,
		actions: [],
		actionSetRevision: "actions_fixture",
		environment: [],
		secrets: [],
		channels: [],
		channelRevision: "channels_fixture",
	};
	await client`
		insert into platform.agents
			(id, current_configuration_revision, authorization_revision)
		values
			(${conversationConformanceAuthorityV1.agentId}, ${revision},
			 ${conversationConformanceAuthorityV1.authorizationRevision})
		on conflict (id) do update
		set authorization_revision = excluded.authorization_revision
	`;
	await client`
		insert into platform.agent_configuration_revisions
			(agent_id, revision, source_reference, created_at, configuration)
		values
			(${conversationConformanceAuthorityV1.agentId}, ${revision},
			 ${`source_fixture_${revision}`}, now(), ${client.json(record)})
		on conflict (agent_id, revision) do update
		set configuration = excluded.configuration
	`;
	await client`
		update platform.agents
		set current_configuration_revision = ${revision}
		where id = ${conversationConformanceAuthorityV1.agentId}
	`;
}

conversationCommandConformanceV1("PostgreSQL", async () => {
	await persistConformanceModelConfiguration(conformanceModelConfiguration);
	let effectiveAuthority: ConversationExecutionAuthorityV1 | undefined =
		conversationConformanceAuthorityV1;
	let nextId = 1;
	let failureCleanupRequired = false;
	let modelSelectionFailureCleanupRequired = false;
	let loseNextResponse = false;
	const adapter = new PostgresConversationExecutionTransactionV1({
		databaseUrl,
	});
	const transaction: ConversationExecutionTransactionPortV1 = {
		createConversation: (request, decide) =>
			adapter.createConversation(request, decide),
		async executeMessage(request, decide) {
			try {
				return await adapter.executeMessage(request, decide);
			} finally {
				if (failureCleanupRequired) {
					try {
						await disarmFailure("message");
					} finally {
						failureCleanupRequired = false;
					}
				}
			}
		},
		async executeModelSelection(request, decide) {
			try {
				return await adapter.executeModelSelection(request, decide);
			} finally {
				if (modelSelectionFailureCleanupRequired) {
					try {
						await disarmFailure("audit");
					} finally {
						modelSelectionFailureCleanupRequired = false;
					}
				}
			}
		},
		executeRegeneration: (request, decide) =>
			adapter.executeRegeneration(request, decide),
		executeStop: (request, decide) => adapter.executeStop(request, decide),
	};
	const inner = createConversationExecutionUseCaseV1(
		{
			authorization: {
				async authorize() {
					return effectiveAuthority
						? {
								outcome: "allowed",
								authority: structuredClone(effectiveAuthority),
							}
						: { outcome: "denied" };
				},
			},
			transaction,
		},
		{
			now: () => new Date("2026-09-04T00:00:00.000Z"),
			newId: () => `conversation_fixture_${nextId++}`,
		},
	);
	const useCase: ConversationExecutionUseCaseV1 = {
		createConversation: (command) => inner.createConversation(command),
		async accept(command) {
			const decision = await inner.accept(command);
			if (loseNextResponse) {
				loseNextResponse = false;
				throw new Error("Injected response loss");
			}
			return decision;
		},
		regenerate: (command) => inner.regenerate(command),
		selectModel: (command) => inner.selectModel(command),
		stop: (command) => inner.stop(command),
	};
	return {
		useCase,
		setAuthority(next) {
			effectiveAuthority = next;
		},
		async failNextCommit() {
			failureCleanupRequired = true;
			await armFailure("message");
		},
		async failNextModelSelectionCommit() {
			modelSelectionFailureCleanupRequired = true;
			await armFailure("audit");
		},
		loseNextResponseAfterCommit() {
			loseNextResponse = true;
		},
		async completeExecution(executionId) {
			const updated = await client`
				update platform.conversation_executions
				set status = 'completed'
				where execution_id = ${executionId}
			`;
			if (updated.count !== 1) throw new Error("Expected one Execution");
		},
		setModelConfiguration: persistConformanceModelConfiguration,
		async modelSnapshot(conversationId) {
			const [conversation] = await client<
				{
					readonly selected_model_option_id: string | null;
					readonly selected_reasoning_level: string | null;
				}[]
			>`
				select selected_model_option_id, selected_reasoning_level
				from platform.conversations where id = ${conversationId}
			`;
			if (!conversation) throw new Error("Expected Conversation");
			const executions = await client<
				{
					readonly execution_id: string;
					readonly model_configuration_revision: string | number | null;
					readonly model_option_id: string | null;
					readonly reasoning_level: string | null;
				}[]
			>`
				select execution_id, model_configuration_revision, model_option_id,
					reasoning_level
				from platform.conversation_executions
				where conversation_id = ${conversationId}
				order by created_at, execution_id
			`;
			const outboxRows = await client<
				{ readonly payload: Record<string, unknown> }[]
			>`
				select payload from platform.outbox_items
				where scope_type = 'conversation' and scope_id = ${conversationId}
					and operation in ('conversation.turn.submit.v1',
						'conversation.turn.regenerate.v1')
				order by created_at, id
			`;
			return {
				selectedModelOptionId: conversation.selected_model_option_id,
				selectedReasoningLevel: conversation.selected_reasoning_level,
				executions: executions.map((execution) => ({
					executionId: execution.execution_id,
					modelConfigurationRevision:
						execution.model_configuration_revision === null
							? null
							: Number(execution.model_configuration_revision),
					modelOptionId: execution.model_option_id,
					reasoningLevel: execution.reasoning_level,
				})),
				outbox: outboxRows.map(({ payload }) => ({
					executionId: String(payload.executionId),
					modelConfigurationRevision:
						payload.modelConfigurationRevision === null
							? null
							: Number(payload.modelConfigurationRevision),
					modelOptionId:
						payload.modelOptionId === null
							? null
							: String(payload.modelOptionId),
					reasoningLevel:
						payload.reasoningLevel === null
							? null
							: String(payload.reasoningLevel),
				})),
			};
		},
		snapshot: commandEffectCounts,
		async close() {
			try {
				await disarmFailure("message");
			} finally {
				try {
					await disarmFailure("audit");
				} finally {
					await adapter.close();
				}
			}
		},
	};
});

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

async function commandEffectCounts() {
	const [counts] = await client<ConversationCommandConformanceSnapshotV1[]>`
		select
			(select count(*)::int from platform.conversations) as conversations,
			(select count(*)::int from platform.conversation_messages) as messages,
			(select count(*)::int from platform.conversation_executions) as executions,
			(select count(*)::int from platform.conversation_stops) as stops,
			(select count(*)::int from platform.outbox_items) as outbox,
			(select count(*)::int from platform.conversation_audit_events) as audit,
			(select count(*)::int from platform.idempotency_records) as idempotency
	`;
	if (!counts) throw new Error("Expected Conversation effect counts");
	return counts;
}

describe("PostgreSQL Conversation command transaction", () => {
	it("keeps legacy rows valid while enforcing complete model selections", async () => {
		await client`
			insert into platform.conversations
				(id, agent_id, actor_id, channel_id, status, session_generation,
				 authorization_revision)
			values
				('conversation_legacy', 'agent_legacy', 'actor_legacy', 'web', 'ready', 1,
				 'authorization_legacy')
		`;
		await client`
			insert into platform.conversation_executions
				(execution_id, conversation_id, agent_id, actor_id, channel_id, turn_id,
				 status, session_generation, authorization_revision, created_at)
			values
				('execution_legacy', 'conversation_legacy', 'agent_legacy', 'actor_legacy',
				 'web', 'turn_legacy', 'completed', 1, 'authorization_legacy', now())
		`;
		const [legacy] = await client<
			{
				readonly selected_model_option_id: string | null;
				readonly selected_reasoning_level: string | null;
				readonly model_configuration_revision: string | null;
				readonly model_option_id: string | null;
				readonly reasoning_level: string | null;
			}[]
		>`
			select conversation.selected_model_option_id,
				conversation.selected_reasoning_level,
				execution.model_configuration_revision,
				execution.model_option_id, execution.reasoning_level
			from platform.conversations as conversation
			join platform.conversation_executions as execution
				on execution.conversation_id = conversation.id
			where conversation.id = 'conversation_legacy'
		`;
		expect(legacy).toEqual({
			selected_model_option_id: null,
			selected_reasoning_level: null,
			model_configuration_revision: null,
			model_option_id: null,
			reasoning_level: null,
		});
		await expect(
			client`
				update platform.conversations
				set selected_model_option_id = 'model_incomplete'
				where id = 'conversation_legacy'
			`,
		).rejects.toMatchObject({
			constraint_name: "conversation_model_selection_pair",
		});
		await expect(
			client`
				update platform.conversation_executions
				set model_option_id = 'model_incomplete'
				where execution_id = 'execution_legacy'
			`,
		).rejects.toMatchObject({
			constraint_name: "conversation_execution_model_selection",
		});
	});

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
						modelConfigurationRevision: null,
						modelOptionId: null,
						reasoningLevel: null,
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
			for (const point of initialMessageFailurePoints) {
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

	it("rolls back conversation creation and stop insertion failures", async () => {
		const createFailure = createConversation();
		try {
			await armFailure("conversation");
			try {
				await expect(
					createFailure.useCase.createConversation({
						schemaVersion: 1,
						agentId: authority.agentId,
						idempotencyKey: "create_insert_rollback",
						requestId: "request_create_insert_rollback",
						traceId: "trace_create_insert_rollback",
					}),
				).rejects.toMatchObject({
					name: "ConversationExecutionError",
					code: "unavailable",
				});
			} finally {
				await disarmFailure("conversation");
			}
			expect(await commandEffectCounts()).toEqual({
				conversations: 0,
				messages: 0,
				executions: 0,
				stops: 0,
				outbox: 0,
				audit: 0,
				idempotency: 0,
			});
		} finally {
			await createFailure.transaction.close();
		}

		const stopFailure = createConversation();
		try {
			await stopFailure.useCase.createConversation({
				schemaVersion: 1,
				agentId: authority.agentId,
				idempotencyKey: "create_stop_insert_rollback",
				requestId: "request_stop_insert_rollback",
				traceId: "trace_stop_insert_rollback",
			});
			await stopFailure.useCase.accept({
				schemaVersion: 1,
				command: "message",
				conversationId: "conversation_id_1",
				text: "stop insert rollback",
				idempotencyKey: "message_stop_insert_rollback",
				requestId: "request_message_stop_insert_rollback",
				traceId: "trace_message_stop_insert_rollback",
			});
			const before = await commandEffectCounts();
			await armFailure("stop");
			try {
				await expect(
					stopFailure.useCase.stop({
						schemaVersion: 1,
						command: "stop",
						conversationId: "conversation_id_1",
						targetExecutionId: "conversation_id_3",
						idempotencyKey: "stop_insert_rollback",
						requestId: "request_stop_insert_rollback",
						traceId: "trace_stop_insert_rollback",
					}),
				).rejects.toMatchObject({
					name: "ConversationExecutionError",
					code: "unavailable",
				});
			} finally {
				await disarmFailure("stop");
			}
			expect(await commandEffectCounts()).toEqual(before);
			expect(before).toEqual({
				conversations: 1,
				messages: 1,
				executions: 1,
				stops: 0,
				outbox: 1,
				audit: 1,
				idempotency: 2,
			});
		} finally {
			await stopFailure.transaction.close();
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
							selectedModelOptionId: null,
							selectedReasoningLevel: null,
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

	it("denies a create command whose Agent differs from the resolved authority", async () => {
		const transaction = new PostgresConversationExecutionTransactionV1({
			databaseUrl,
		});
		let decided = false;
		try {
			await expect(
				transaction.createConversation(
					{
						command: {
							schemaVersion: 1,
							agentId: "agent_foreign",
							idempotencyKey: "foreign_agent_create",
							requestId: "request_foreign_agent_create",
							traceId: "trace_foreign_agent_create",
						},
						authority,
						requestDigest: "a".repeat(64),
					},
					() => {
						decided = true;
						throw new Error("the decision callback must not run");
					},
				),
			).resolves.toEqual({ outcome: "denied" });
			expect(decided).toBe(false);
			expect(await commandEffectCounts()).toEqual({
				conversations: 0,
				messages: 0,
				executions: 0,
				stops: 0,
				outbox: 0,
				audit: 0,
				idempotency: 0,
			});
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
