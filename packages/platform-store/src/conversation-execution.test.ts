import { createHash } from "node:crypto";
import {
	type ConversationExecutionAuthorityV1,
	type ConversationExecutionTransactionPortV1,
	type ConversationExecutionUseCaseV1,
	type ConversationModelConfigurationV1,
	createConversationEventUseCaseV1,
	createConversationExecutionUseCaseV1,
	createNativeCapabilityAdmissionUseCaseV1,
	createSessionSandboxBindingV1,
	type FileLimitsV1,
	type FileRecordV1,
	nativeCapabilityAdmissionRequestDigestV1,
	nativeCapabilityAdmissionRequestDigestV2,
	nativeCapabilityParametersDigestV1,
} from "@agent-infra/platform-core";
import {
	type ConversationCommandConformanceHarnessV1,
	type ConversationCommandConformanceSnapshotV1,
	conversationCommandConformanceV1,
	conversationConformanceAuthorityV1,
	conversationConformanceModelIdV1,
	FakeNativeCapabilityMetadataRevalidationV1,
} from "@agent-infra/platform-core/testing";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgresConversationDispatchStoreV1 } from "./conversation-dispatch.ts";
import { PostgresConversationEventTransactionV1 } from "./conversation-events.ts";
import {
	type PostgresConversationExecutionOptionsV1,
	PostgresConversationExecutionTransactionV1,
} from "./conversation-execution.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";
import { markSessionSandboxReadyFixture } from "./session-sandbox.fixture.ts";
import {
	insertTaskAuthorization,
	PostgresTaskAuthorizationStoreV1,
} from "./task-authorization.ts";

const storeConformanceAuthority = conversationConformanceAuthorityV1;

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
	sandbox: "platform.session_sandbox_allocations",
	conversation: "platform.conversations",
	idempotency: "platform.idempotency_records",
	execution: "platform.conversation_executions",
	message: "platform.conversation_messages",
	stop: "platform.conversation_stops",
	outbox: "platform.outbox_items",
	audit: "platform.conversation_audit_events",
	event: "platform.conversation_events",
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
	await client`truncate platform.conversation_generation_tombstones,
		platform.connection_installation_commands,
		platform.connection_installation_authorizations,
		platform.session_sandbox_allocations,
		platform.task_control_records, platform.task_authorization_records,
		platform.file_accesses, platform.files, platform.conversation_events,
		platform.conversation_audit_events, platform.audit_events,
		platform.outbox_items,
		platform.idempotency_records, platform.conversation_stops,
		platform.conversation_messages, platform.conversation_executions,
		platform.conversations`;
});

let conformanceConfigurationVersion: 1 | 3 = 1;

async function persistConformanceModelConfiguration(
	modelConfiguration: ConversationModelConfigurationV1 | undefined,
	executionAuthority = storeConformanceAuthority,
): Promise<void> {
	const revision = modelConfiguration?.configurationRevision ?? 1;
	const record = {
		schemaVersion: 1,
		agentId: executionAuthority.agentId,
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
							// 与 Fake 相同的模型 ID 约定，回退事件据此记录原选项显示名（G-07）。
							modelId: conversationConformanceModelIdV1(optionId),
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
	const persisted =
		conformanceConfigurationVersion === 3 && record.modelConfiguration
			? (({ actions: _actions, actionSetRevision: _revision, ...current }) => ({
					...current,
					schemaVersion: 3,
					modelConfiguration: current.modelConfiguration && {
						...current.modelConfiguration,
						options: current.modelConfiguration.options.map(
							({ credential: _credential, ...option }) => option,
						),
					},
				}))(record)
			: record;
	await client`
		insert into platform.agents
			(id, current_configuration_revision, authorization_revision)
		values
			(${executionAuthority.agentId}, ${revision},
			 ${executionAuthority.authorizationRevision})
		on conflict (id) do update
		set authorization_revision = excluded.authorization_revision
	`;
	await client`
		insert into platform.agent_configuration_revisions
			(agent_id, revision, source_reference, created_at, configuration)
		values
			(${executionAuthority.agentId}, ${revision},
			 ${`source_fixture_${revision}`}, now(), ${client.json(persisted)})
		on conflict (agent_id, revision) do update
		set configuration = excluded.configuration
	`;
	const subjectId = executionAuthority.actorId;
	const keyId = `fixture-key:personal:${subjectId}`;
	await client`insert into platform.relay_key_subjects
		(purpose, subject_id, last_version, current_version)
		values ('personal', ${subjectId}, 1, 1)
		on conflict (purpose, subject_id) do nothing`;
	await client`insert into platform.relay_key_versions
		(purpose, subject_id, key_version, key_id, ciphertext)
		values ('personal', ${subjectId}, 1, ${keyId},
			${client.json({ purpose: "personal", subjectId, keyId, keyVersion: 1 })})
		on conflict (purpose, subject_id, key_version) do nothing`;
	await client`
		update platform.agents
		set current_configuration_revision = ${revision}
		where id = ${executionAuthority.agentId}
	`;
}

const openPostgresConformanceHarness = async () => {
	await persistConformanceModelConfiguration(conformanceModelConfiguration);
	let effectiveAuthority: ConversationExecutionAuthorityV1 | undefined =
		storeConformanceAuthority;
	let nextId = 1;
	let failureCleanupRequired = false;
	let fallbackFailureCleanupRequired = false;
	let modelSelectionFailureCleanupRequired = false;
	let loseNextResponse = false;
	const adapter = new PostgresConversationExecutionTransactionV1({
		databaseUrl,
		userDirectory: {
			async resolveUser(userId) {
				return {
					schemaVersion: 1,
					userId,
					accountStatus: "active",
					organizationIds: [],
					authorizationRevision: "identity_fixture_1",
				};
			},
		},
	});
	const eventAdapter = new PostgresConversationEventTransactionV1({
		databaseUrl,
	});
	let nextRuntimeEventId = 1;
	const runtimeEvents = createConversationEventUseCaseV1(
		{ transaction: eventAdapter },
		{ newId: () => `runtime_event_fixture_${nextRuntimeEventId++}` },
	);
	const transaction: ConversationExecutionTransactionPortV1 = {
		requestMetadataRecovery: (request, decide) =>
			adapter.requestMetadataRecovery(request, decide),
		readConversation: (request, project) =>
			adapter.readConversation(request, project),
		createConversation: (request, decide) =>
			adapter.createConversation(request, decide),
		async executeMessage(request, decide) {
			try {
				return await adapter.executeMessage(request, decide);
			} finally {
				if (failureCleanupRequired || fallbackFailureCleanupRequired) {
					try {
						await disarmFailure(
							fallbackFailureCleanupRequired ? "event" : "message",
						);
					} finally {
						failureCleanupRequired = false;
						fallbackFailureCleanupRequired = false;
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
		requestMetadataRecovery: (query) => inner.requestMetadataRecovery(query),
		readConversation: (query) => inner.readConversation(query),
		async createConversation(command) {
			const result = await inner.createConversation(command);
			if (result.outcome === "accepted")
				await markSessionSandboxReadyFixture(
					client,
					result.result.conversationId,
				);
			return result;
		},
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
		withdraw: (command) => inner.withdraw(command),
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
		async failNextFallbackEventCommit() {
			fallbackFailureCleanupRequired = true;
			await armFailure("event");
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
		async startExecution(executionId) {
			const updated = await client`
				update platform.conversation_executions
				set status = 'processing'
				where execution_id = ${executionId} and status in ('submitted', 'unknown')
			`;
			if (updated.count !== 1) throw new Error("Expected one Execution");
		},
		setModelConfiguration: persistConformanceModelConfiguration,
		async persistRuntimeEvent(conversationId, executionId, adapterEventKey) {
			const decision = await runtimeEvents.persist({
				schemaVersion: 1,
				conversationId,
				executionId,
				sessionGeneration: 1,
				deliveryFence: 0,
				adapterEventKey,
				runtimeCursor: `runtime_cursor_${adapterEventKey}`,
				occurredAt: "2026-09-04T00:00:00.000Z",
				event: { type: "text.delta", text: "bounded runtime fixture" },
			});
			if (decision.outcome !== "accepted") {
				throw new Error("Expected PostgreSQL Runtime event acceptance");
			}
			return decision.event;
		},
		async eventSnapshot(conversationId) {
			const [conversation] = await client<
				{ readonly last_conversation_cursor: string | number }[]
			>`select last_conversation_cursor from platform.conversations
				where id = ${conversationId}`;
			if (!conversation) throw new Error("Expected Conversation");
			const executions = await client<
				{
					readonly execution_id: string;
					readonly last_event_sequence: string | number;
					readonly last_runtime_cursor: string | null;
				}[]
			>`select execution_id, last_event_sequence, last_runtime_cursor
				from platform.conversation_executions
				where conversation_id = ${conversationId}
				order by created_at, execution_id`;
			const events = await client<
				{
					readonly source: "platform" | "runtime";
					readonly runtime_cursor: string | null;
					readonly event_id: string;
					readonly execution_id: string;
					readonly sequence: string | number;
					readonly conversation_cursor: string | number;
					readonly occurred_at: Date;
					readonly event_payload: Record<string, unknown>;
				}[]
			>`select source, runtime_cursor, event_id, execution_id, sequence,
				conversation_cursor, occurred_at, event_payload
				from platform.conversation_events
				where conversation_id = ${conversationId}
				order by conversation_cursor`;
			const audits = await client<{ readonly execution_id: string }[]>`
				select execution_id from platform.conversation_audit_events
				where conversation_id = ${conversationId}
					and action = 'conversation.model_selection.fell_back'
				order by occurred_at, id
			`;
			return {
				lastConversationCursor: Number(conversation.last_conversation_cursor),
				executions: executions.map((execution) => ({
					executionId: execution.execution_id,
					lastEventSequence: Number(execution.last_event_sequence),
					lastRuntimeCursor: execution.last_runtime_cursor,
				})),
				events: events.map((event) => ({
					source: event.source,
					runtimeCursor: event.runtime_cursor,
					event: {
						schemaVersion: 1 as const,
						eventId: event.event_id,
						conversationId,
						executionId: event.execution_id,
						sequence: Number(event.sequence),
						conversationCursor: Number(event.conversation_cursor),
						occurredAt: event.occurred_at.toISOString(),
						event: event.event_payload as never,
					},
				})),
				fallbackAuditExecutionIds: audits.map(
					({ execution_id }) => execution_id,
				),
			};
		},
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
			const auditRows = await client<
				{
					readonly action: string;
					readonly details: {
						readonly previousModelOptionId: string;
						readonly previousReasoningLevel: string;
						readonly modelConfigurationRevision: number;
						readonly modelOptionId: string;
						readonly reasoningLevel: string;
					} | null;
				}[]
			>`
			select action, details from platform.conversation_audit_events
				where conversation_id = ${conversationId}
				order by action
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
				auditActions: auditRows
					.map(({ action }) => action)
					.filter((action) => action !== "conversation.sandbox.allocated"),
				fallbackFacts: auditRows.flatMap(({ action, details }) =>
					action === "conversation.model_selection.fell_back" && details
						? [details]
						: [],
				),
			};
		},
		async snapshot() {
			// The shared command conformance counts command effects. Allocation audit
			// atomicity and uniqueness are asserted by the PostgreSQL allocation cases.
			const counts = await commandEffectCounts();
			const [allocation] = await client`select count(*)::int as count
				from platform.conversation_audit_events where action = 'conversation.sandbox.allocated'`;
			const [preparation] =
				await client`select count(*)::int as count from platform.outbox_items where operation = 'conversation.sandbox.reconcile.v1'`;
			return {
				...counts,
				audit: counts.audit - Number(allocation?.count),
				outbox: counts.outbox - Number(preparation?.count),
			};
		},
		async close() {
			try {
				await Promise.all([disarmFailure("message"), disarmFailure("event")]);
			} finally {
				try {
					await disarmFailure("audit");
				} finally {
					await Promise.all([adapter.close(), eventAdapter.close()]);
				}
			}
		},
	} satisfies ConversationCommandConformanceHarnessV1;
};

conversationCommandConformanceV1("PostgreSQL", async () => {
	conformanceConfigurationVersion = 1;
	return openPostgresConformanceHarness();
});

// 带 Agent 默认 Relay Key 的标准 Agent 持久化为 V3（无模型凭证），同一套会话规则必须成立。
conversationCommandConformanceV1(
	"PostgreSQL V3 default Relay Key",
	async () => {
		conformanceConfigurationVersion = 3;
		return openPostgresConformanceHarness();
	},
);

afterAll(async () => {
	await client?.end();
	await testDatabase?.stop();
});

/** 包装事务端口：在 decide 返回的计划里改写 outbox 的 traceParent。 */
function tamperedTransaction(
	transaction: PostgresConversationExecutionTransactionV1,
	tamper: {
		readonly method: "executeMessage" | "executeRegeneration" | "executeStop";
		readonly traceParent: string;
	},
) {
	return new Proxy(transaction, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			if (property !== tamper.method) return value.bind(target);
			return (
				request: unknown,
				decide: (state: unknown) => { outboxIntent: object },
			) =>
				(value as (...input: unknown[]) => unknown).call(
					target,
					request,
					(state: unknown) => {
						const plan = decide(state);
						return {
							...plan,
							outboxIntent: {
								...plan.outboxIntent,
								traceParent: tamper.traceParent,
							},
						};
					},
				);
		},
	});
}

function createConversation(
	resolvedAuthority: ConversationExecutionAuthorityV1 = authority,
	options: {
		readonly sandbox?: "preparing" | "ready";
		readonly readRequestedModelDisplayName?: PostgresConversationExecutionOptionsV1["readRequestedModelDisplayName"];
		/** 让某类命令的计划带上与命令不一致的 outbox traceparent（#2473）。 */
		readonly tamperTraceParent?: {
			readonly method: "executeMessage" | "executeRegeneration" | "executeStop";
			readonly traceParent: string;
		};
	} = {},
) {
	let nextId = 1;
	const transaction = new PostgresConversationExecutionTransactionV1({
		databaseUrl,
		...(options.readRequestedModelDisplayName
			? { readRequestedModelDisplayName: options.readRequestedModelDisplayName }
			: {}),
		userDirectory: {
			async resolveUser(userId) {
				return {
					schemaVersion: 1,
					userId,
					accountStatus: "active",
					organizationIds: [],
					authorizationRevision:
						resolvedAuthority.taskBoundary?.identityRevision ?? "identity-01",
				};
			},
		},
	});
	const useCase = createConversationExecutionUseCaseV1(
		{
			authorization: {
				async authorize() {
					return { outcome: "allowed", authority: resolvedAuthority };
				},
			},
			transaction: options.tamperTraceParent
				? tamperedTransaction(transaction, options.tamperTraceParent)
				: transaction,
		},
		{
			now: () => new Date("2026-09-04T00:00:00.000Z"),
			newId: () => `conversation_id_${nextId++}`,
		},
	);
	return {
		transaction,
		useCase: {
			...useCase,
			async createConversation(
				command: Parameters<typeof useCase.createConversation>[0],
			) {
				const result = await useCase.createConversation(command);
				// Command tests explicitly model a prepared fixture; preparation tests opt out.
				if (result.outcome === "accepted" && options.sandbox !== "preparing")
					await markSessionSandboxReadyFixture(
						client,
						result.result.conversationId,
					);
				return result;
			},
		},
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
	it("persists and replays one native capability admission atomically, including historical digests (#2950)", async () => {
		await persistConformanceModelConfiguration(undefined, authority);
		const { transaction, useCase } = createConversation();
		try {
			const created = await useCase.createConversation({
				schemaVersion: 1,
				agentId: authority.agentId,
				idempotencyKey: "native-create",
				requestId: "native-create",
				traceId: "native-create",
			});
			if (created.outcome !== "accepted")
				throw new Error("Expected native capability Conversation");
			const capabilityId = "a".repeat(64);
			const directoryRevision = "b".repeat(64);
			const metadata = new FakeNativeCapabilityMetadataRevalidationV1({
				hostScopeRef: null,
				projection: {
					selector: "skills",
					revision: directoryRevision,
					capabilities: [
						{
							id: capabilityId,
							kind: "skill",
							name: "workspace-summary",
							description: "Summarize workspace files",
							source: { name: "skill-hub", version: "1.0.0" },
							availability: "discovered",
						},
					],
				},
			});
			const admission = createNativeCapabilityAdmissionUseCaseV1({
				authorization: {
					async authorize() {
						return { outcome: "allowed", authority };
					},
				},
				metadata,
				transaction,
				newId: (() => {
					let id = 1;
					return () => `native-execution-${id++}`;
				})(),
			});
			const request = {
				schemaVersion: 1 as const,
				conversationId: created.result.conversationId,
				capabilityId,
				directoryRevision,
				parameters: "summarize the workspace",
				idempotencyKey: "native-invoke",
				requestId: "native-request",
				traceId: "native-trace",
			};

			const accepted = await admission.admit(request);
			expect(accepted).toMatchObject({
				outcome: "accepted",
				result: {
					status: "submitted",
					conversationId: created.result.conversationId,
					capabilityId,
				},
			});
			await expect(admission.admit(request)).resolves.toMatchObject({
				outcome: "replayed",
			});
			await expect(
				admission.admit({ ...request, idempotencyKey: "native-busy" }),
			).resolves.toEqual({ outcome: "busy" });
			const foreignAuthority = { ...authority, actorId: "foreign-user" };
			const foreignAdmission = createNativeCapabilityAdmissionUseCaseV1({
				authorization: {
					async authorize() {
						return { outcome: "allowed", authority: foreignAuthority };
					},
				},
				metadata,
				transaction,
			});
			await expect(
				foreignAdmission.admit({ ...request, idempotencyKey: "foreign" }),
			).resolves.toEqual({
				outcome: "denied",
				reason: "authorization_lost",
			});
			const staleAuthority = {
				...authority,
				authorizationRevision: "stale-revision",
			};
			const staleAdmission = createNativeCapabilityAdmissionUseCaseV1({
				authorization: {
					async authorize() {
						return { outcome: "allowed", authority: staleAuthority };
					},
				},
				metadata,
				transaction,
			});
			await expect(
				staleAdmission.admit({ ...request, idempotencyKey: "stale" }),
			).resolves.toEqual({
				outcome: "denied",
				reason: "authorization_lost",
			});
			if (accepted.outcome !== "accepted")
				throw new Error("Expected accepted native plan");
			const malformedRequest = {
				...request,
				idempotencyKey: "malformed",
				requestId: "malformed",
				traceId: "malformed",
			};
			await expect(
				transaction.admitNativeCapability(
					{
						command: malformedRequest,
						authority,
						requestDigest:
							nativeCapabilityAdmissionRequestDigestV1(malformedRequest),
					},
					async () => ({
						...accepted.plan,
						outbox: {
							...accepted.plan.outbox,
							payload: {
								...accepted.plan.outbox.payload,
								parametersDigest: "0".repeat(64),
							},
						},
					}),
					() => true,
					async () => true,
				),
			).rejects.toMatchObject({ code: "unavailable" });
			await expect(
				admission.admit({ ...request, parameters: "different" }),
			).resolves.toEqual({
				outcome: "conflict",
				reason: "idempotency_conflict",
			});

			expect(
				await client`
					select execution_id, status from platform.conversation_executions
					where conversation_id = ${created.result.conversationId}
				`,
			).toHaveLength(1);
			const [outbox] = await client<
				{ operation: string; payload: Record<string, unknown> }[]
			>`select operation, payload from platform.outbox_items
				where id = ${"conversation:native-capability:native-execution-1"}`;
			expect(outbox).toMatchObject({
				operation: "conversation.native-capability.invoke.v1",
				payload: {
					schemaVersion: 1,
					conversationId: created.result.conversationId,
					executionId: "native-execution-1",
					capabilityId,
					capabilityKind: "skill",
					directoryRevision,
					parametersDigest: nativeCapabilityParametersDigestV1(
						"summarize the workspace",
					),
				},
			});
			expect(
				await client`
					select action from platform.conversation_audit_events
					where execution_id = ${"native-execution-1"}
				`,
			).toEqual([{ action: "conversation.native_capability.accepted" }]);
			const dispatch = new PostgresConversationDispatchStoreV1({ databaseUrl });
			try {
				await expect
					.poll(async () => {
						const [row] = await client<
							{ available: boolean }[]
						>`select available_at <= clock_timestamp() as available from platform.outbox_items where id = 'conversation:native-capability:native-execution-1'`;
						return row?.available;
					})
					.toBe(true);
				const claimed = await dispatch.claim({
					schemaVersion: 1,
					itemId: "conversation:native-capability:native-execution-1",
					workerId: "native-worker",
					leaseDurationMs: 30_000,
				});
				expect(claimed.outcome).toBe("claimed");
				if (claimed.outcome !== "claimed")
					throw new Error("Expected native dispatch claim");
				expect(claimed.claim.executionDeliveryFence).toBe(
					claimed.claim.deliveryFence,
				);
				expect(
					await dispatch.readRuntimeState({ claim: claimed.claim }),
				).toMatchObject({
					executionStatus: "submitted",
					stopPending: false,
					originalOperationDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
				});
			} finally {
				await dispatch.close();
			}

			// Emulate a record committed by the previous binary in this isolated test DB.
			const legacyDigest = createHash("sha256")
				.update(JSON.stringify(request.parameters))
				.digest("hex");
			await client`update platform.idempotency_records
				set result = jsonb_set(jsonb_set(result, '{plan,parametersDigest}',
					to_jsonb(${legacyDigest}::text)), '{plan,outbox,payload,parametersDigest}',
					to_jsonb(${legacyDigest}::text))
				where scope_id = ${request.conversationId}
					and command_type = 'native-capability.invoke'
					and idempotency_key = ${request.idempotencyKey}`;
			await client`update platform.outbox_items
				set payload = jsonb_set(payload, '{parametersDigest}', to_jsonb(${legacyDigest}::text))
				where id = ${accepted.plan.outbox.id}`;
			const snapshot = () => client`select
				(select jsonb_agg(to_jsonb(i) order by id) from platform.idempotency_records i
					where scope_id = ${request.conversationId}) as idempotency,
				(select jsonb_agg(to_jsonb(e) order by execution_id) from platform.conversation_executions e
					where conversation_id = ${request.conversationId}) as executions,
				(select jsonb_agg(to_jsonb(o) order by id) from platform.outbox_items o
					where scope_type = 'conversation' and scope_id = ${request.conversationId}) as outbox,
				(select jsonb_agg(to_jsonb(a) order by id) from platform.conversation_audit_events a
					where execution_id = ${accepted.result.executionId}) as audit`;
			const beforeReplay = await snapshot();
			await expect(admission.admit(request)).resolves.toMatchObject({
				outcome: "replayed",
				result: accepted.result,
				plan: { parametersDigest: legacyDigest },
			});
			await expect(
				admission.admit({ ...request, parameters: "different" }),
			).resolves.toEqual({
				outcome: "conflict",
				reason: "idempotency_conflict",
			});
			expect(await snapshot()).toEqual(beforeReplay);
			await client`update platform.idempotency_records
				set result = jsonb_set(jsonb_set(result, '{plan,parametersDigest}',
					to_jsonb(${"0".repeat(64)}::text)), '{plan,outbox,payload,parametersDigest}',
					to_jsonb(${"0".repeat(64)}::text))
				where scope_id = ${request.conversationId}
					and command_type = 'native-capability.invoke'
					and idempotency_key = ${request.idempotencyKey}`;
			const beforeInvalidReplay = await snapshot();
			await expect(admission.admit(request)).resolves.toMatchObject({
				outcome: "unavailable",
			});
			expect(await snapshot()).toEqual(beforeInvalidReplay);
		} finally {
			await transaction.close();
		}
	});

	it("persists an Invocation V2 skill input sequence and binds each file to the Execution", async () => {
		await persistConformanceModelConfiguration(undefined, authority);
		const { transaction, useCase } = createConversation();
		try {
			const created = await useCase.createConversation({
				schemaVersion: 1,
				agentId: authority.agentId,
				idempotencyKey: "native-v2-create",
				requestId: "native-v2-create",
				traceId: "native-v2-create",
			});
			if (created.outcome !== "accepted")
				throw new Error("Expected native capability Conversation");
			const conversationId = created.result.conversationId;
			const capabilityId = "1".repeat(64);
			const directoryRevision = "2".repeat(64);
			const metadata = new FakeNativeCapabilityMetadataRevalidationV1({
				hostScopeRef: null,
				projection: {
					selector: "skills",
					revision: directoryRevision,
					capabilities: [
						{
							id: capabilityId,
							kind: "skill",
							name: "workspace-summary",
							description: "Summarize workspace files",
							source: { name: "skill-hub", version: "1.0.0" },
							availability: "discovered",
						},
					],
				},
			});
			const limits: FileLimitsV1 = {
				revision: "native-limits",
				expiresAt: "2099-01-01T00:00:00Z",
				mediaTypes: ["text/plain"],
				maxBytes: 4096,
			};
			const admission = createNativeCapabilityAdmissionUseCaseV1({
				authorization: {
					async authorize() {
						return { outcome: "allowed", authority };
					},
				},
				metadata,
				transaction,
				inputLimits: {
					async read() {
						return limits;
					},
				},
				now: () => new Date("2026-10-13T00:00:00.000Z"),
				newId: (() => {
					let id = 1;
					return () => `native-v2-execution-${id++}`;
				})(),
			});
			const files: FileRecordV1[] = ["native-file-a", "native-file-b"].map(
				(fileId) => ({
					...authority,
					conversationId,
					fileId,
					objectRef: `object-${fileId}`,
					kind: "attachment",
					idempotencyKey: `intent-${fileId}`,
					descriptor: {
						name: `${fileId}.txt`,
						mediaType: "text/plain",
						sizeBytes: 5,
						sha256: "e".repeat(64),
					},
					status: "available",
					executionId: null,
					messageId: null,
					sessionGeneration: null,
					objectVersion: "version-1",
					etag: "etag-1",
					createdAt: "2026-10-13T00:00:00.000Z",
					expiresAt: "2099-01-01T00:00:00Z",
					updatedAt: "2026-10-13T00:00:00.000Z",
					revision: 1,
				}),
			);
			for (const file of files)
				await client`insert into platform.files (file_id, actor_id, conversation_id, idempotency_key, record, updated_at)
					values (${file.fileId}, ${file.actorId}, ${file.conversationId}, ${file.idempotencyKey}, ${client.json(file as unknown as Parameters<typeof client.json>[0])}, now())`;
			const request = {
				schemaVersion: 2 as const,
				conversationId,
				capabilityId,
				directoryRevision,
				parameters: "summarize the attached inputs",
				idempotencyKey: "native-v2-invoke",
				requestId: "native-v2-request",
				traceId: "native-v2-trace",
				attachments: files.map((file) => file.fileId),
			};
			const accepted = await admission.admit(request);
			if (accepted.outcome !== "accepted")
				throw new Error("Expected accepted Invocation V2 plan");
			expect(accepted.plan.idempotency.requestDigest).toBe(
				nativeCapabilityAdmissionRequestDigestV2(request),
			);
			expect(accepted.plan.attachments).toMatchObject([
				{ fileId: "native-file-a", byteLength: 5, mediaType: "text/plain" },
				{ fileId: "native-file-b", byteLength: 5, mediaType: "text/plain" },
			]);
			const [outbox] = await client<{ payload: Record<string, unknown> }[]>`
				select payload from platform.outbox_items
				where id = ${accepted.plan.outbox.id}`;
			expect(outbox?.payload).toMatchObject({
				attachments: accepted.plan.attachments,
			});
			const readFiles = () =>
				client<{ record: FileRecordV1 }[]>`
					select record from platform.files
					where file_id in ('native-file-a','native-file-b')
					order by file_id`;
			const bound = await readFiles();
			expect(bound.map((row) => row.record)).toMatchObject([
				{
					fileId: "native-file-a",
					messageId: null,
					executionId: "native-v2-execution-1",
					sessionGeneration: 1,
					revision: 2,
				},
				{
					fileId: "native-file-b",
					messageId: null,
					executionId: "native-v2-execution-1",
					sessionGeneration: 1,
					revision: 2,
				},
			]);
			await expect(
				admission.admit({ ...request, requestId: "native-v2-replay" }),
			).resolves.toMatchObject({
				outcome: "replayed",
				plan: { attachments: accepted.plan.attachments },
			});
			expect(await readFiles()).toEqual(bound);
			await expect(
				admission.admit({
					...request,
					idempotencyKey: "native-v2-busy",
					requestId: "native-v2-busy",
				}),
			).resolves.toEqual({ outcome: "busy" });
		} finally {
			await transaction.close();
		}
	});

	it("rolls back native admission when the outbox write fails", async () => {
		await persistConformanceModelConfiguration(undefined, authority);
		const { transaction, useCase } = createConversation();
		try {
			const created = await useCase.createConversation({
				schemaVersion: 1,
				agentId: authority.agentId,
				idempotencyKey: "native-rollback-create",
				requestId: "native-rollback-create",
				traceId: "native-rollback-create",
			});
			if (created.outcome !== "accepted")
				throw new Error("Expected native capability Conversation");
			const capabilityId = "c".repeat(64);
			const directoryRevision = "d".repeat(64);
			const metadata = new FakeNativeCapabilityMetadataRevalidationV1({
				hostScopeRef: null,
				projection: {
					selector: "commands",
					revision: directoryRevision,
					capabilities: [
						{
							id: capabilityId,
							kind: "command",
							name: "workspace.read",
							description: "Read workspace",
							source: { name: "runtime", version: "1.0.0" },
							availability: "available",
						},
					],
				},
			});
			const admission = createNativeCapabilityAdmissionUseCaseV1({
				authorization: {
					async authorize() {
						return { outcome: "allowed", authority };
					},
				},
				metadata,
				transaction,
				newId: () => "native-rollback-execution",
			});
			const request = {
				schemaVersion: 1 as const,
				conversationId: created.result.conversationId,
				capabilityId,
				directoryRevision,
				parameters: "read workspace",
				idempotencyKey: "native-rollback",
				requestId: "native-rollback-request",
				traceId: "native-rollback-trace",
			};
			await armFailure("outbox");
			try {
				await expect(admission.admit(request)).resolves.toMatchObject({
					outcome: "unavailable",
				});
			} finally {
				await disarmFailure("outbox");
			}
			expect(
				await client`
					select count(*)::int as count from platform.conversation_executions
					where execution_id = ${"native-rollback-execution"}
				`,
			).toEqual([{ count: 0 }]);
			expect(
				await client`
					select count(*)::int as count from platform.outbox_items
					where operation = 'conversation.native-capability.invoke.v1'
				`,
			).toEqual([{ count: 0 }]);
			expect(
				await client`
					select count(*)::int as count from platform.idempotency_records
					where command_type = 'native-capability.invoke'
				`,
			).toEqual([{ count: 0 }]);
		} finally {
			await transaction.close();
		}
	});

	it("reads a Conversation without deadlocking against an Agent lifecycle fan-out (#2629)", async () => {
		await persistConformanceModelConfiguration(
			conformanceModelConfiguration,
			authority,
		);
		const { transaction, useCase } = createConversation(authority, {
			sandbox: "preparing",
		});
		// 生命周期事务和轮询用的连接要与 `client`（max: 1）分开，否则互相排队。
		const lifecycle = postgres(databaseUrl, { max: 2 });
		try {
			const created = await useCase.createConversation({
				schemaVersion: 1,
				agentId: authority.agentId,
				idempotencyKey: "deadlock-create",
				requestId: "deadlock-create",
				traceId: "deadlock",
			});
			if (created.outcome !== "accepted")
				throw new Error("Expected Session creation");
			const conversationId = created.result.conversationId;
			await markSessionSandboxReadyFixture(client, conversationId);

			// 与 Agent 生命周期命令一样的加锁顺序：先锁 Agent 行，再逐个锁该 Agent 的会话。
			const agentLocked = Promise.withResolvers<void>();
			const mayFanOut = Promise.withResolvers<void>();
			const fanOut = lifecycle.begin(async (sql) => {
				await sql`select id from platform.agents where id = ${authority.agentId} for update`;
				agentLocked.resolve();
				await mayFanOut.promise;
				await sql`select id from platform.conversations where agent_id = ${authority.agentId} order by id for update`;
				return "fanned out" as const;
			});
			// 提前挂上拒绝处理，避免等待期间出现未处理的拒绝。
			fanOut.catch(() => undefined);
			await agentLocked.promise;

			const read = useCase.readConversation({
				schemaVersion: 1,
				conversationId,
			});
			read.catch(() => undefined);
			// 等读取事务卡在 Agent 行上：修复前它此时已经持有会话的共享锁，修复后什么都没持有。
			let blocked = false;
			for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
				const [row] = await lifecycle`
					select count(*)::int as waiting from pg_stat_activity
					where datname = current_database() and wait_event_type = 'Lock'
						and query ilike '%platform.agents%for share%'`;
				blocked = (row?.waiting ?? 0) > 0;
				if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(blocked).toBe(true);

			mayFanOut.resolve();
			// 修复前其中一个事务被 PostgreSQL 作为死锁牺牲者终止（40P01）。
			await expect(fanOut).resolves.toBe("fanned out");
			await expect(read).resolves.toMatchObject({ outcome: "found" });
		} finally {
			await lifecycle.end({ timeout: 5 });
			await transaction.close();
		}
	});

	it("accepts the next Web message on an idle-reclaimed Session and requests its resume (#2239)", async () => {
		await persistConformanceModelConfiguration(
			conformanceModelConfiguration,
			authority,
		);
		const { transaction, useCase } = createConversation(authority, {
			sandbox: "preparing",
		});
		try {
			const created = await useCase.createConversation({
				schemaVersion: 1,
				agentId: authority.agentId,
				idempotencyKey: "reclaimed-create",
				requestId: "reclaimed-create",
				traceId: "reclaimed",
			});
			if (created.outcome !== "accepted")
				throw new Error("Expected Session creation");
			const conversationId = created.result.conversationId;
			await markSessionSandboxReadyFixture(client, conversationId);
			// 空闲回收已完成：计算资源停止，调谐意图等待下一条消息恢复。
			await client`update platform.session_sandbox_allocations
				set status = 'stopped', desired_state = 'stopped', resource_fence = resource_fence + 1
				where conversation_id = ${conversationId}`;
			const [intent] = await client<
				{ id: string }[]
			>`select id from platform.outbox_items
				where scope_type = 'conversation' and scope_id = ${conversationId}
					and operation = 'conversation.sandbox.reconcile.v1'`;
			if (!intent) throw new Error("Expected Sandbox reconcile intent");
			await client`update platform.outbox_items set status = 'succeeded',
				payload = payload || ${client.json({
					lifecycle: {
						schemaVersion: 1,
						reason: "idle_reclaim",
						authority: {
							kind: "management",
							applicationId: "application-fixture",
							managementRevision: 1,
							managementFence: 1,
							workloadRevision: 1,
							targetDesiredState: "running",
						},
						source: { sandbox: { generation: 1 } },
						stopReceipt: null,
						resumeRequested: false,
					},
				})}
				where id = ${intent.id}`;
			expect(
				await useCase.readConversation({ schemaVersion: 1, conversationId }),
			).toMatchObject({
				outcome: "found",
				result: {
					conversation: { sandboxReady: false, sandboxResumable: true },
				},
			});
			const accepted = await useCase.accept({
				schemaVersion: 1,
				command: "message",
				conversationId,
				text: "resume this Session",
				idempotencyKey: "reclaimed-message",
				requestId: "reclaimed-message",
				traceId: "reclaimed",
			});
			expect(accepted).toMatchObject({ outcome: "accepted" });
			const [resumed] = await client<
				{ status: string; resume: string | null }[]
			>`select status, payload->'lifecycle'->>'resumeRequested' as resume
				from platform.outbox_items where id = ${intent.id}`;
			expect(resumed).toEqual({ status: "pending", resume: "true" });
			// 恢复请求之后会话处于准备中，不再报告为可恢复。
			const read = await useCase.readConversation({
				schemaVersion: 1,
				conversationId,
			});
			expect(read).toMatchObject({
				outcome: "found",
				result: { conversation: { sandboxReady: false } },
			});
			expect(
				read.outcome === "found" &&
					"sandboxResumable" in read.result.conversation,
			).toBe(false);
		} finally {
			await transaction.close();
		}
	});

	it("denies a new message, supplement and regenerate once the Conversation is unavailable (ADR-0029)", async () => {
		await persistConformanceModelConfiguration(undefined, authority);
		const { transaction, useCase } = createConversation(authority);
		try {
			const created = await useCase.createConversation({
				schemaVersion: 1,
				agentId: authority.agentId,
				idempotencyKey: "unavailable-create",
				requestId: "unavailable-create",
				traceId: "unavailable",
			});
			if (created.outcome !== "accepted")
				throw new Error("Expected Session creation");
			const conversationId = created.result.conversationId;
			const message = {
				schemaVersion: 1 as const,
				command: "message" as const,
				conversationId,
				text: "controlled message",
				requestId: "unavailable-message",
				traceId: "unavailable",
			};
			const accepted = await useCase.accept({
				...message,
				idempotencyKey: "unavailable-message",
			});
			if (accepted.outcome !== "accepted" || !accepted.result.messageId)
				throw new Error("Expected the first message");
			// 回复仍在进行时会话变为不可用：补充指令也必须被拒绝。
			await client`update platform.conversations set status = 'unavailable' where id = ${conversationId}`;
			const counts = await commandEffectCounts();
			expect(
				await useCase.accept({
					...message,
					idempotencyKey: "unavailable-supplement",
				}),
			).toEqual({ outcome: "denied" });
			// Worker 以 RUNTIME_SESSION_BLOCKED 收敛后：执行失败、会话不可用。
			await client`update platform.conversation_executions set status = 'failed'
				where execution_id = ${accepted.result.executionId}`;
			expect(
				await useCase.accept({
					...message,
					idempotencyKey: "unavailable-next-message",
				}),
			).toEqual({ outcome: "denied" });
			expect(
				await useCase.regenerate({
					schemaVersion: 1,
					command: "regenerate",
					conversationId,
					sourceMessageId: accepted.result.messageId,
					idempotencyKey: "unavailable-regenerate",
					requestId: "unavailable-regenerate",
					traceId: "unavailable",
				}),
			).toEqual({ outcome: "denied" });
			expect(await commandEffectCounts()).toEqual(counts);
		} finally {
			await transaction.close();
		}
	});

	it("keeps a Web Session read-only until its own Sandbox is ready and preserves accepted replay when readiness is lost", async () => {
		await persistConformanceModelConfiguration(
			conformanceModelConfiguration,
			authority,
		);
		const { transaction, useCase } = createConversation(authority, {
			sandbox: "preparing",
		});
		try {
			const created = await useCase.createConversation({
				schemaVersion: 1,
				agentId: authority.agentId,
				idempotencyKey: "web-sandbox-create",
				requestId: "web-sandbox-create",
				traceId: "web-sandbox",
			});
			if (created.outcome !== "accepted")
				throw new Error("Expected Session creation");
			const conversationId = created.result.conversationId;
			const command = {
				schemaVersion: 1 as const,
				command: "message" as const,
				conversationId,
				text: "controlled message",
				idempotencyKey: "web-sandbox-message",
				requestId: "web-sandbox-message",
				traceId: "web-sandbox",
			};
			const before = await commandEffectCounts();
			// Preparing is a retryable start, not a denial (#1534).
			expect(await useCase.accept(command)).toEqual({ outcome: "starting" });
			expect(await commandEffectCounts()).toEqual(before);
			expect(
				await useCase.readConversation({ schemaVersion: 1, conversationId }),
			).toMatchObject({
				outcome: "found",
				result: { conversation: { sandboxReady: false } },
			});
			await markSessionSandboxReadyFixture(client, conversationId);
			expect(
				await useCase.readConversation({ schemaVersion: 1, conversationId }),
			).toMatchObject({
				outcome: "found",
				result: { conversation: { sandboxReady: true } },
			});
			const accepted = await useCase.accept(command);
			if (accepted.outcome !== "accepted" || !accepted.result.messageId)
				throw new Error("Expected ready Session acceptance");
			await client`update platform.session_sandbox_allocations set status = 'unknown' where conversation_id = ${conversationId}`;
			const acceptedCounts = await commandEffectCounts();
			expect(await useCase.accept(command)).toEqual({
				outcome: "replayed",
				result: accepted.result,
			});
			expect(
				await useCase.accept({
					...command,
					idempotencyKey: "web-sandbox-supplement",
				}),
			).toEqual({ outcome: "starting" });
			expect(
				await useCase.regenerate({
					schemaVersion: 1,
					command: "regenerate",
					conversationId,
					sourceMessageId: accepted.result.messageId,
					idempotencyKey: "web-sandbox-regenerate",
					requestId: "web-sandbox-regenerate",
					traceId: "web-sandbox",
				}),
			).toEqual({ outcome: "starting" });

			expect(await commandEffectCounts()).toEqual(acceptedCounts);
			expect(
				await useCase.readConversation({ schemaVersion: 1, conversationId }),
			).toMatchObject({
				outcome: "found",
				result: { conversation: { sandboxReady: false } },
			});
			expect(
				await useCase.stop({
					schemaVersion: 1,
					command: "stop",
					conversationId,
					targetExecutionId: accepted.result.executionId,
					idempotencyKey: "web-sandbox-stop",
					requestId: "web-sandbox-stop",
					traceId: "web-sandbox",
				}),
			).toMatchObject({ outcome: "accepted" });
			expect(
				await client`select status, session_generation::int as generation from platform.session_sandbox_allocations where conversation_id = ${conversationId}`,
			).toEqual([{ status: "unknown", generation: 1 }]);
		} finally {
			await transaction.close();
		}
	});

	it("commits original task authority with acceptance and rolls back control when required audit fails", async () => {
		await persistConformanceModelConfiguration(
			conformanceModelConfiguration,
			authority,
		);
		const taskBoundary = {
			schemaVersion: 1 as const,
			principal: { kind: "user" as const, id: authority.actorId },
			agentId: authority.agentId,
			channelId: "web",
			identityRevision: "identity-different-from-agent",
			agentAuthorizationRevision: authority.authorizationRevision,
			accessSources: [{ kind: "user" as const, userId: authority.actorId }],
		};
		const { transaction, useCase } = createConversation({
			...authority,
			taskBoundary,
		});
		const taskStore = new PostgresTaskAuthorizationStoreV1({ databaseUrl });
		try {
			await useCase.createConversation({
				schemaVersion: 1,
				agentId: authority.agentId,
				idempotencyKey: "task-create",
				requestId: "task-create",
				traceId: "task-trace",
			});
			const command = {
				schemaVersion: 1 as const,
				command: "message" as const,
				conversationId: "conversation_id_1",
				text: "secret-task-body-sentinel",
				idempotencyKey: "task-submit",
				requestId: "task-submit",
				traceId: "task-trace",
			};
			const accepted = await useCase.accept(command);
			expect(accepted.outcome).toBe("accepted");
			const [record] =
				await client`select id, execution_id, boundary from platform.task_authorization_records`;
			expect(record?.boundary).toEqual(taskBoundary);
			if (!record) throw new Error("Task authority was not committed");
			const [before] =
				await client`select request_digest, result from platform.idempotency_records where idempotency_key = 'task-submit'`;
			expect(await useCase.accept(command)).toMatchObject({
				outcome: "replayed",
				result: before?.result,
			});
			expect(
				await client`select request_digest, result from platform.idempotency_records where idempotency_key = 'task-submit'`,
			).toEqual([before]);
			expect(
				await client`select id from platform.task_authorization_records`,
			).toHaveLength(1);
			const audits =
				await client`select details from platform.audit_events where action = 'task.authorization.accepted'`;
			expect(audits).toHaveLength(1);
			expect(JSON.stringify(audits)).not.toContain(command.text);
			const control = {
				executionId: record.execution_id,
				authorizationRecordId: record.id,
				reason: "authorization_revoked" as const,
				workerId: "worker-test",
				traceId: "task-trace",
				requestId: "control-request",
			};
			for (const boundary of [
				{
					...taskBoundary,
					principal: { kind: "user", id: "other-user" },
					accessSources: [{ kind: "user", userId: "other-user" }],
				},
				{ ...taskBoundary, agentId: "other-agent" },
				{ ...taskBoundary, channelId: "other-channel" },
				{ ...taskBoundary, agentAuthorizationRevision: "other-revision" },
			]) {
				await client`update platform.task_authorization_records set boundary = ${client.json(boundary)} where id = ${record.id}`;
				await expect(
					taskStore.readExecution(record.execution_id),
				).rejects.toThrow("Task authorization persistence is unavailable");
				await expect(taskStore.recordControl(control)).rejects.toThrow(
					"Task authorization persistence is unavailable",
				);
			}
			await client`update platform.task_authorization_records set boundary = ${client.json(taskBoundary)} where id = ${record.id}`;
			expect(
				await client`select id from platform.task_control_records`,
			).toHaveLength(0);
			expect(
				await client`select stop_request_id from platform.conversation_stops`,
			).toHaveLength(0);
			await client.unsafe(
				`create function platform.fail_task_control_audit() returns trigger as $$ begin if NEW.action = 'task.control.created' then raise exception 'controlled audit failure'; end if; return NEW; end; $$ language plpgsql`,
			);
			await client.unsafe(
				"create trigger fail_task_control_audit before insert on platform.audit_events for each row execute function platform.fail_task_control_audit()",
			);
			await expect(taskStore.recordControl(control)).rejects.toThrow(
				"Task authorization persistence is unavailable",
			);
			expect(
				await client`select id from platform.task_control_records`,
			).toHaveLength(0);
			expect(
				await client`select stop_request_id from platform.conversation_stops`,
			).toHaveLength(0);
			expect(
				await client`select id from platform.outbox_items where operation = 'conversation.turn.stop.v1'`,
			).toHaveLength(0);
			expect(
				await client`select revoked_at from platform.task_authorization_records`,
			).toEqual([{ revoked_at: null }]);
			await client.unsafe(
				"drop trigger fail_task_control_audit on platform.audit_events",
			);
			const created = await taskStore.recordControl(control);
			expect(await taskStore.recordControl(control)).toEqual(created);
			expect(
				await client`select id from platform.task_control_records`,
			).toHaveLength(1);
			expect(
				await client`select stop_request_id from platform.conversation_stops`,
			).toHaveLength(1);
			expect(
				await client`select id from platform.outbox_items where operation = 'conversation.turn.stop.v1'`,
			).toHaveLength(1);
			expect(
				(
					await client`select revoked_at from platform.task_authorization_records`
				)[0]?.revoked_at,
			).toBeInstanceOf(Date);
			await expect(
				taskStore.recordControl({ ...control, executionId: "other-execution" }),
			).rejects.toThrow("Task authorization persistence is unavailable");
		} finally {
			await client.unsafe(
				"drop trigger if exists fail_task_control_audit on platform.audit_events",
			);
			await client.unsafe(
				"drop function if exists platform.fail_task_control_audit()",
			);
			await transaction.close();
			await taskStore.close();
			await client`delete from platform.agent_configuration_revisions where agent_id = ${authority.agentId}`;
		}
	});

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
		await expect(
			client`
				insert into platform.conversation_audit_events
					(id, conversation_id, execution_id, agent_id, actor_id, action,
					 trace_id, request_id, occurred_at)
				values
					('audit_missing_execution', 'conversation_legacy', null, 'agent_legacy',
					 'actor_legacy', 'conversation.message.accepted', 'trace_legacy',
					 'request_legacy', now())
			`,
		).rejects.toMatchObject({
			constraint_name: "conversation_audit_execution_binding",
		});
		await expect(
			client`
				insert into platform.conversation_audit_events
					(id, conversation_id, execution_id, agent_id, actor_id, action,
					 trace_id, request_id, occurred_at, details)
				values
					('audit_unexpected_execution', 'conversation_legacy', 'execution_legacy',
					 'agent_legacy', 'actor_legacy',
					 'conversation.model_selection.updated', 'trace_legacy',
					 'request_legacy', now(), '{}'::jsonb)
			`,
		).rejects.toMatchObject({
			constraint_name: "conversation_audit_execution_binding",
		});
		await expect(
			client`
				insert into platform.conversation_audit_events
					(id, conversation_id, execution_id, agent_id, actor_id, action,
					 trace_id, request_id, occurred_at)
				values
					('audit_missing_details', 'conversation_legacy', null, 'agent_legacy',
					 'actor_legacy', 'conversation.model_selection.updated', 'trace_legacy',
					 'request_legacy', now())
			`,
		).rejects.toMatchObject({
			constraint_name: "conversation_audit_details_binding",
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
				outbox: 2,
				idempotency: 2,
				audit: 2,
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

	describe("W3C traceparent on durable commands (#2473)", () => {
		const messageParent =
			"00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
		const regenerateParent =
			"00-1af7651916cd43dd8448eb211c80319c-c7ad6b7169203331-01";
		const stopParent =
			"00-2af7651916cd43dd8448eb211c80319c-d7ad6b7169203331-01";
		const tampered = "00-3af7651916cd43dd8448eb211c80319c-e7ad6b7169203331-01";
		const traceParents = () =>
			client<{ operation: string; trace_parent: string | null }[]>`
				select operation, trace_parent from platform.outbox_items
				where operation like 'conversation.turn.%' order by created_at, operation`;

		async function acceptMessage(
			useCase: ReturnType<typeof createConversation>["useCase"],
		) {
			await useCase.createConversation({
				schemaVersion: 1,
				agentId: authority.agentId,
				idempotencyKey: "create_trace",
				requestId: "request_create_trace",
				traceId: "trace_create_trace",
			});
			return useCase.accept({
				schemaVersion: 1,
				command: "message",
				conversationId: "conversation_id_1",
				text: "keep the trace",
				idempotencyKey: "message_trace",
				requestId: "request_message_trace",
				traceId: "trace_message_trace",
				traceParent: messageParent,
			});
		}

		it("keeps the traceparent of an accepted message, regeneration and stop on their outbox rows", async () => {
			const { transaction, useCase } = createConversation();
			try {
				await expect(acceptMessage(useCase)).resolves.toMatchObject({
					outcome: "accepted",
				});
				await client`update platform.conversation_executions set status = 'completed' where execution_id = 'conversation_id_3'`;
				await expect(
					useCase.regenerate({
						schemaVersion: 1,
						command: "regenerate",
						conversationId: "conversation_id_1",
						sourceMessageId: "conversation_id_2",
						idempotencyKey: "regenerate_trace",
						requestId: "request_regenerate_trace",
						traceId: "trace_regenerate_trace",
						traceParent: regenerateParent,
					}),
				).resolves.toMatchObject({ outcome: "accepted" });
				await expect(
					useCase.stop({
						schemaVersion: 1,
						command: "stop",
						conversationId: "conversation_id_1",
						targetExecutionId: "conversation_id_5",
						idempotencyKey: "stop_trace",
						requestId: "request_stop_trace",
						traceId: "trace_stop_trace",
						traceParent: stopParent,
					}),
				).resolves.toMatchObject({ outcome: "accepted" });
				expect(
					Object.fromEntries(
						(await traceParents()).map((row) => [
							row.operation,
							row.trace_parent,
						]),
					),
				).toEqual({
					"conversation.turn.submit.v1": messageParent,
					"conversation.turn.regenerate.v1": regenerateParent,
					"conversation.turn.stop.v1": stopParent,
				});
			} finally {
				await transaction.close();
			}
		});

		it("still accepts commands that carry no traceparent", async () => {
			const { transaction, useCase } = createConversation();
			try {
				await useCase.createConversation({
					schemaVersion: 1,
					agentId: authority.agentId,
					idempotencyKey: "create_no_trace",
					requestId: "request_create_no_trace",
					traceId: "trace_create_no_trace",
				});
				await expect(
					useCase.accept({
						schemaVersion: 1,
						command: "message",
						conversationId: "conversation_id_1",
						text: "no trace",
						idempotencyKey: "message_no_trace",
						requestId: "request_message_no_trace",
						traceId: "trace_message_no_trace",
					}),
				).resolves.toMatchObject({ outcome: "accepted" });
				expect(await traceParents()).toEqual([
					{ operation: "conversation.turn.submit.v1", trace_parent: null },
				]);
			} finally {
				await transaction.close();
			}
		});

		it.each(["executeMessage", "executeRegeneration", "executeStop"] as const)(
			"refuses a %s plan whose outbox traceparent differs from the command's",
			async (method) => {
				const honest = createConversation();
				const forged = createConversation(authority, {
					tamperTraceParent: { method, traceParent: tampered },
				});
				try {
					// 建立前置状态用不被篡改的用例；被篡改的用例只发最后一条命令。
					let command: () => Promise<unknown>;
					if (method === "executeMessage") {
						await honest.useCase.createConversation({
							schemaVersion: 1,
							agentId: authority.agentId,
							idempotencyKey: "create_forged",
							requestId: "request_create_forged",
							traceId: "trace_create_forged",
						});
						command = () =>
							forged.useCase.accept({
								schemaVersion: 1,
								command: "message",
								conversationId: "conversation_id_1",
								text: "forged",
								idempotencyKey: "message_forged",
								requestId: "request_message_forged",
								traceId: "trace_message_forged",
								traceParent: messageParent,
							});
					} else {
						await acceptMessage(honest.useCase);
						if (method === "executeRegeneration") {
							await client`update platform.conversation_executions set status = 'completed' where execution_id = 'conversation_id_3'`;
							command = () =>
								forged.useCase.regenerate({
									schemaVersion: 1,
									command: "regenerate",
									conversationId: "conversation_id_1",
									sourceMessageId: "conversation_id_2",
									idempotencyKey: "regenerate_forged",
									requestId: "request_regenerate_forged",
									traceId: "trace_regenerate_forged",
									traceParent: regenerateParent,
								});
						} else {
							command = () =>
								forged.useCase.stop({
									schemaVersion: 1,
									command: "stop",
									conversationId: "conversation_id_1",
									targetExecutionId: "conversation_id_3",
									idempotencyKey: "stop_forged",
									requestId: "request_stop_forged",
									traceId: "trace_stop_forged",
									traceParent: stopParent,
								});
						}
					}
					const before = await traceParents();
					await expect(command()).rejects.toMatchObject({
						name: "ConversationExecutionError",
						code: "unavailable",
					});
					// 被拒绝的命令不留下 outbox 行，已有的行保持原样。
					expect(await traceParents()).toEqual(before);
				} finally {
					await Promise.all([
						honest.transaction.close(),
						forged.transaction.close(),
					]);
				}
			},
		);
	});

	it.each(["ready", "active"] as const)(
		"regenerates a %s conversation from its existing user message",
		async (status) => {
			const { transaction, useCase } = createConversation();
			const eventTransaction = new PostgresConversationEventTransactionV1({
				databaseUrl,
			});
			const events = createConversationEventUseCaseV1(
				{ transaction: eventTransaction },
				{ newId: () => "terminal_event_02" },
			);
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
				if (status === "ready") {
					await expect(
						events.persist({
							schemaVersion: 1,
							conversationId: "conversation_id_1",
							executionId: "conversation_id_3",
							sessionGeneration: 1,
							deliveryFence: 0,
							adapterEventKey: "terminal_02",
							runtimeCursor: "runtime_terminal_02",
							occurredAt: "2026-09-04T00:00:00.000Z",
							event: { type: "execution.status", status: "completed" },
							transition: {
								executionStatus: "completed",
								conversationStatus: "ready",
							},
						}),
					).resolves.toMatchObject({ outcome: "accepted" });
				} else {
					await client`update platform.conversation_executions set status = 'completed' where execution_id = 'conversation_id_3'`;
				}
				expect(
					await client`select status from platform.conversations where id = 'conversation_id_1'`,
				).toEqual([{ status }]);

				const regeneration = {
					schemaVersion: 1,
					command: "regenerate",
					conversationId: "conversation_id_1",
					sourceMessageId: "conversation_id_2",
					idempotencyKey: "regenerate_02",
					requestId: "request_regenerate_02",
					traceId: "trace_regenerate_02",
				} as const;
				await expect(useCase.regenerate(regeneration)).resolves.toEqual({
					outcome: "accepted",
					result: {
						schemaVersion: 1,
						status: "submitted",
						messageId: null,
						executionId: "conversation_id_5",
					},
				});
				await expect(useCase.regenerate(regeneration)).resolves.toEqual({
					outcome: "replayed",
					result: {
						schemaVersion: 1,
						status: "submitted",
						messageId: null,
						executionId: "conversation_id_5",
					},
				});

				expect(
					await client`select status from platform.conversations where id = 'conversation_id_1'`,
				).toEqual([{ status: "active" }]);

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
					outbox: 3,
					idempotency: 3,
					audit: 3,
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
				await Promise.all([transaction.close(), eventTransaction.close()]);
			}
		},
	);

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
				outbox: 3,
				idempotency: 4,
				audit: 3,
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
			// 补充指令只给已被 Runtime 接受、仍在运行的回复（§12.5）。
			await client`
				update platform.conversation_executions set status = 'processing'
				where conversation_id = 'conversation_id_1'
			`;
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
			// 不能作为补充指令的消息进入排队，而不是繁忙。
			expect(
				await noSupplement.useCase.accept({
					...supplement,
					idempotencyKey: "message_04_busy",
				}),
			).toMatchObject({
				outcome: "accepted",
				result: { queuePosition: 1 },
			});
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
					messages: 3,
					executions: 2,
					outbox: 4,
					idempotency: 4,
					audit: 4,
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
		const first = createConversation(authority, { sandbox: "preparing" });
		const second = createConversation(authority, { sandbox: "preparing" });
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
			const intents =
				await client`select operation, payload from platform.outbox_items`;
			expect(intents).toEqual([
				{
					operation: "conversation.sandbox.reconcile.v1",
					payload: {
						schemaVersion: 1,
						conversationId: results[0].result.conversationId,
						sessionGeneration: 1,
					},
				},
			]);
			expect(
				await client`
					select
						(select count(*)::int from platform.conversations) as conversations,
						(select count(*)::int from platform.session_sandbox_allocations) as sandboxes,
						(select count(*)::int from platform.idempotency_records) as idempotency
				`,
			).toEqual([{ conversations: 1, sandboxes: 1, idempotency: 1 }]);
		} finally {
			await Promise.all([
				first.transaction.close(),
				second.transaction.close(),
			]);
		}
	});

	it("retains the allocation after Store reconnect and rejects a mismatched active Execution", async () => {
		const initial = createConversation();
		const command = {
			schemaVersion: 1 as const,
			agentId: authority.agentId,
			idempotencyKey: "sandbox_reconnect",
			requestId: "sandbox_reconnect_request",
			traceId: "sandbox_reconnect_trace",
		};
		try {
			await expect(
				initial.useCase.createConversation(command),
			).resolves.toMatchObject({ outcome: "accepted" });
		} finally {
			await initial.transaction.close();
		}
		const original =
			await client`select sandbox_id from platform.session_sandbox_allocations`;
		const reopened = createConversation();
		try {
			await expect(
				reopened.useCase.createConversation(command),
			).resolves.toMatchObject({ outcome: "replayed" });
			expect(
				await client`select sandbox_id from platform.session_sandbox_allocations`,
			).toEqual(original);
			const message = {
				schemaVersion: 1 as const,
				command: "message" as const,
				conversationId: "conversation_id_1",
				text: "sandbox transaction fixture",
				idempotencyKey: "sandbox_message",
				requestId: "sandbox_message_request",
				traceId: "sandbox_message_trace",
			};
			await expect(reopened.useCase.accept(message)).resolves.toMatchObject({
				outcome: "accepted",
			});
			expect(
				await client`select sandbox_id from platform.conversation_executions`,
			).toEqual(original);
			await client`update platform.conversation_executions set sandbox_id = null`;
			await expect(reopened.useCase.accept(message)).rejects.toMatchObject({
				code: "unavailable",
			});
			await expect(
				reopened.useCase.accept({
					...message,
					idempotencyKey: "sandbox_mismatch",
				}),
			).rejects.toMatchObject({ code: "unavailable" });
			expect(
				await client`select count(*)::int as count from platform.conversation_executions`,
			).toEqual([{ count: 1 }]);
			expect(
				await client`select count(*)::int as count from platform.outbox_items`,
			).toEqual([{ count: 2 }]);
		} finally {
			await reopened.transaction.close();
		}
	});

	it.each(["sandbox", "audit", "outbox", "commit"] as const)(
		"rolls back Session allocation at the %s write boundary",
		async (point) => {
			const { transaction, useCase } = createConversation();
			await armFailure(point);
			try {
				await expect(
					useCase.createConversation({
						schemaVersion: 1,
						agentId: authority.agentId,
						idempotencyKey: "sandbox_rollback",
						requestId: "sandbox_rollback_request",
						traceId: "sandbox_rollback_trace",
					}),
				).rejects.toMatchObject({ code: "unavailable" });
				expect(
					await client`
					select
						(select count(*)::int from platform.conversations) as conversations,
						(select count(*)::int from platform.session_sandbox_allocations) as sandboxes,
						(select count(*)::int from platform.outbox_items) as outbox,
						(select count(*)::int from platform.idempotency_records) as idempotency,
						(select count(*)::int from platform.conversation_audit_events) as audit
				`,
				).toEqual([
					{
						conversations: 0,
						sandboxes: 0,
						outbox: 0,
						idempotency: 0,
						audit: 0,
					},
				]);
			} finally {
				await disarmFailure(point);
				await transaction.close();
			}
		},
	);

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
						outbox: 1,
						audit: 1,
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
				outbox: 2,
				audit: 2,
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
						sandbox: createSessionSandboxBindingV1(
							authority,
							"invalid_plan_conversation",
						),
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
							createdAt: new Date("2026-09-04T00:00:00.000Z"),
							updatedAt: new Date("2026-09-04T00:00:00.000Z"),
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
			).toEqual([{ stops: 0, outbox: 2, audit: 2, idempotency: 3 }]);
		} finally {
			await transaction.close();
		}
	});
});

it("atomically binds confirmed input files with their Message and preserves binding on replay", async () => {
	const { transaction, useCase } = createConversation();
	const { createFileAuthorityV1 } = await import("@agent-infra/platform-core");
	const { PostgresFileStoreV1 } = await import("./files.ts");
	const files = new PostgresFileStoreV1(databaseUrl);
	try {
		await useCase.createConversation({
			schemaVersion: 1,
			agentId: authority.agentId,
			idempotencyKey: "create-files",
			requestId: "create-files",
			traceId: "create-files",
		});
		const scope = {
			actorId: authority.actorId,
			agentId: authority.agentId,
			channelId: authority.channelId,
			conversationId: "conversation_id_1",
		};
		const descriptor = {
			name: "fixture.txt",
			mediaType: "text/plain",
			sizeBytes: 5,
			sha256: "0".repeat(64),
		};
		const service = createFileAuthorityV1({
			store: files,
			intentTtlMs: 60000,
			accessTtlMs: 10000,
			issuer: "platform",
			keyVersion: "key",
			storage: {
				inspect: async () => ({
					...descriptor,
					version: "version",
					etag: "etag",
				}),
			},
		});
		const auth = {
			authorize: async () => ({
				...scope,
				execution: null,
				limits: {
					revision: "limits",
					expiresAt: "2099-01-01T00:00:00Z",
					maxBytes: 10,
					mediaTypes: ["text/plain"],
				},
			}),
		};
		const file = await service.createUpload(
			{
				conversationId: scope.conversationId,
				descriptor,
				idempotencyKey: "input",
			},
			auth,
		);
		const command = {
			schemaVersion: 1 as const,
			command: "message" as const,
			conversationId: scope.conversationId,
			text: "bounded fixture",
			attachments: [file.fileId],
			idempotencyKey: "message-files",
			requestId: "message-files",
			traceId: "message-files",
		};
		await expect(useCase.accept(command)).rejects.toBeDefined();
		expect(
			(await client`select message_id from platform.conversation_messages`)
				.length,
		).toBe(0);
		const access = await service.issueAccess(
			{
				conversationId: scope.conversationId,
				fileId: file.fileId,
				operation: "write",
				idempotencyKey: "access",
			},
			auth,
		);
		await service.complete(
			{
				conversationId: scope.conversationId,
				fileId: file.fileId,
				accessId: access.accessId,
			},
			auth,
		);
		const accepted = await useCase.accept(command);
		if (accepted.outcome !== "accepted")
			throw new Error("Expected attachment acceptance");
		expect(await useCase.accept(command)).toEqual({
			outcome: "replayed",
			result: accepted.result,
		});
		const bound = await service.getFile(
			{ conversationId: scope.conversationId, fileId: file.fileId },
			auth,
		);
		expect(bound.messageId).toBe(accepted.result.messageId);
		expect(bound.executionId).toBe(accepted.result.executionId);
		await expect(
			useCase.accept({ ...command, idempotencyKey: "rebind" }),
		).rejects.toBeDefined();
		expect(
			(await client`select message_id from platform.conversation_messages`)
				.length,
		).toBe(1);
	} finally {
		await files.close();
		await transaction.close();
	}
});

it("guards supplied Conversation SQL after the original transaction aborts and rolls back", async () => {
	const controller = new AbortController();
	let late: PostgresConversationExecutionTransactionV1 | undefined;
	let original: postgres.TransactionSql | undefined;
	await expect(
		client.begin(async (transaction) => {
			original = transaction;
			late = new PostgresConversationExecutionTransactionV1({
				transaction,
				signal: controller.signal,
			});
			controller.abort();
			throw new Error("Controlled original rollback");
		}),
	).rejects.toThrow("Controlled original rollback");
	if (!late) throw new Error("Missing supplied adapter");
	const supplied = late;
	const useCase = createConversationExecutionUseCaseV1({
		transaction: supplied,
		authorization: {
			authorize: async () => ({ outcome: "allowed", authority }),
		},
	});
	await expect(
		useCase.createConversation({
			schemaVersion: 1,
			agentId: authority.agentId,
			idempotencyKey: "late-supplied",
			traceId: "late-trace",
			requestId: "late-request",
		}),
	).rejects.toBeDefined();
	await expect(
		useCase.accept({
			schemaVersion: 1,
			command: "message",
			conversationId: "late-supplied",
			text: "controlled late input",
			idempotencyKey: "late-supplied-message",
			traceId: "late-trace",
			requestId: "late-request",
		}),
	).rejects.toBeDefined();
	if (!original) throw new Error("Missing original transaction");
	await expect(
		insertTaskAuthorization(original, {
			executionId: "late-supplied-execution",
			boundary: {
				schemaVersion: 1,
				principal: { kind: "user", id: authority.actorId },
				agentId: authority.agentId,
				channelId: authority.channelId,
				identityRevision: "identity-1",
				agentAuthorizationRevision: authority.authorizationRevision,
				accessSources: [{ kind: "user", userId: authority.actorId }],
			},
			traceId: "late-trace",
			requestId: "late-request",
		}),
	).rejects.toBeDefined();
	expect(
		await client`select id from platform.task_authorization_records`,
	).toHaveLength(0);
	expect(await client`select id from platform.conversations`).toHaveLength(0);
	expect(
		await client`select id from platform.idempotency_records`,
	).toHaveLength(0);
});

it("reads legacy Session state under current authority without admitting commands or repairing its binding", async () => {
	await persistConformanceModelConfiguration(undefined, authority);
	await client`insert into platform.conversations
   (id, agent_id, actor_id, channel_id, status, session_generation, authorization_revision)
   values ('legacy-read-only', ${authority.agentId}, ${authority.actorId}, 'web', 'active', 1, ${authority.authorizationRevision})`;
	const current = createConversation();
	const foreign = createConversation({ ...authority, actorId: "other-user" });
	const stale = createConversation({
		...authority,
		authorizationRevision: "stale-revision",
	});
	try {
		expect(
			await current.useCase.readConversation({
				schemaVersion: 1,
				conversationId: "legacy-read-only",
			}),
		).toMatchObject({
			outcome: "found",
			result: {
				conversation: { conversationId: "legacy-read-only", status: "active" },
			},
		});
		for (const denied of [foreign, stale]) {
			expect(
				await denied.useCase.readConversation({
					schemaVersion: 1,
					conversationId: "legacy-read-only",
				}),
			).toEqual({ outcome: "denied" });
		}
		expect(
			await current.useCase.accept({
				schemaVersion: 1,
				command: "message",
				conversationId: "legacy-read-only",
				text: "do not execute",
				idempotencyKey: "legacy-message",
				requestId: "legacy-message",
				traceId: "legacy-message",
			}),
		).toEqual({ outcome: "denied" });
		expect(
			await current.useCase.stop({
				schemaVersion: 1,
				command: "stop",
				conversationId: "legacy-read-only",
				targetExecutionId: "legacy-execution",
				idempotencyKey: "legacy-stop",
				requestId: "legacy-stop",
				traceId: "legacy-stop",
			}),
		).toEqual({ outcome: "denied" });
		expect(
			await current.useCase.requestMetadataRecovery({
				schemaVersion: 1,
				conversationId: "legacy-read-only",
			}),
		).toEqual({ outcome: "denied" });
		expect(
			await client`select count(*)::int as count from platform.session_sandbox_allocations`,
		).toEqual([{ count: 0 }]);
		expect(
			await client`select count(*)::int as count from platform.outbox_items`,
		).toEqual([{ count: 0 }]);
		expect(
			await client`select count(*)::int as count from platform.idempotency_records`,
		).toEqual([{ count: 0 }]);
	} finally {
		await current.transaction.close();
		await foreign.transaction.close();
		await stale.transaction.close();
	}
});

describe("PostgreSQL model fallback requested model (G-07)", () => {
	const requestedAuthority: ConversationExecutionAuthorityV1 = {
		...authority,
		agentId: "agent_requested_model",
		authorizationRevision: "authorization_requested_model",
	};
	const foreignAgentId = "agent_requested_model_foreign";

	/** 以本 Agent 修订 1 为模板写入另一修订，只改模型选项（含其模型 ID）。 */
	async function persistRevision(
		agentId: string,
		revision: number,
		options: readonly {
			optionId: string;
			modelId: string;
			endpointId?: string;
		}[],
	) {
		const [template] = await client<{ configuration: unknown }[]>`
			select configuration from platform.agent_configuration_revisions
			where agent_id = ${requestedAuthority.agentId} and revision = 1
		`;
		if (!template) throw new Error("Expected revision 1 fixture");
		const configuration = structuredClone(template.configuration) as {
			agentId: string;
			revision: number;
			modelConfiguration: {
				options: { optionId: string; modelId: string }[];
			};
		};
		const byId = new Map(
			configuration.modelConfiguration.options.map((option) => [
				option.optionId,
				option,
			]),
		);
		configuration.agentId = agentId;
		configuration.revision = revision;
		configuration.modelConfiguration.options = options.map(
			({ optionId, modelId, endpointId }) => {
				const base = byId.get(optionId);
				if (!base) throw new Error("Unknown option fixture");
				return {
					...base,
					modelId,
					...(endpointId === undefined ? {} : { endpointId }),
				};
			},
		);
		await client`
			insert into platform.agents
				(id, current_configuration_revision, authorization_revision)
			values (${agentId}, ${revision}, ${requestedAuthority.authorizationRevision})
			on conflict (id) do nothing
		`;
		await client`
			insert into platform.agent_configuration_revisions
				(agent_id, revision, source_reference, created_at, configuration)
			values (${agentId}, ${revision}, ${`source_requested_${revision}`}, now(),
				${client.json(configuration as never)})
			on conflict (agent_id, revision) do update
			set configuration = excluded.configuration
		`;
	}

	async function makeCurrent(agentId: string, revision: number) {
		await client`
			update platform.agents set current_configuration_revision = ${revision}
			where id = ${agentId}
		`;
	}

	afterEach(async () => {
		// 本组修订不能泄漏到其他用例：先恢复修订 1，再删除额外修订与外部 Agent。
		await makeCurrent(requestedAuthority.agentId, 1);
		await client`
			delete from platform.agent_configuration_revisions
			where (agent_id = ${requestedAuthority.agentId} and revision > 1)
				or agent_id = ${foreignAgentId}
		`;
		await client`delete from platform.agents where id = ${foreignAgentId}`;
	});

	it.each(["default", "trusted", "unavailable", "null", "invalid"] as const)(
		"records the name from this Agent's latest applied revision, ignoring pending and foreign revisions (%s)",
		async (nameSource) => {
			await persistConformanceModelConfiguration(
				conformanceModelConfiguration,
				requestedAuthority,
			);
			let alias = "Trusted historical model";
			const calls: { endpointId: string; modelId: string }[] = [];
			const resolver =
				nameSource === "default"
					? undefined
					: async (model: { endpointId: string; modelId: string }) => {
							calls.push(model);
							if (nameSource === "unavailable")
								throw new Error("Controlled name provider failure");
							if (nameSource === "null") return null;
							if (nameSource === "invalid") return "";
							return model.endpointId === "endpoint_historical"
								? alias
								: "Wrong endpoint";
						};
			const expectedName =
				nameSource === "default"
					? "relay-alternate-renamed"
					: nameSource === "trusted"
						? alias
						: null;
			const { transaction, useCase } = createConversation(requestedAuthority, {
				...(resolver ? { readRequestedModelDisplayName: resolver } : {}),
			});
			try {
				const created = await useCase.createConversation({
					schemaVersion: 1,
					agentId: requestedAuthority.agentId,
					idempotencyKey: "requested_model_create",
					requestId: "requested_model_create",
					traceId: "requested_model_create",
				});
				if (created.outcome !== "accepted")
					throw new Error("Expected Conversation creation");
				const conversationId = created.result.conversationId;
				await expect(
					useCase.selectModel({
						schemaVersion: 1,
						command: "model.select",
						conversationId,
						modelOptionId: "model_alternate",
						reasoningLevel: "high",
						idempotencyKey: "requested_model_select",
						requestId: "requested_model_select",
						traceId: "requested_model_select",
					}),
				).resolves.toMatchObject({ outcome: "accepted" });
				// 修订 2 仍有原选项但改了模型名；修订 3 删除它并成为当前修订。
				await persistRevision(requestedAuthority.agentId, 2, [
					{ optionId: "model_primary", modelId: "relay-primary" },
					{
						optionId: "model_alternate",
						modelId:
							nameSource === "default"
								? "relay-alternate-renamed"
								: "shared-model",
						endpointId: "endpoint_historical",
					},
				]);
				await persistRevision(requestedAuthority.agentId, 3, [
					{ optionId: "model_primary", modelId: "relay-primary" },
				]);
				await makeCurrent(requestedAuthority.agentId, 3);
				// 修订 4 尚未应用；其他 Agent 的修订 3 在上界内，也不能被采用。
				await persistRevision(requestedAuthority.agentId, 4, [
					{ optionId: "model_primary", modelId: "relay-primary" },
					{
						optionId: "model_alternate",
						modelId:
							nameSource === "default"
								? "relay-alternate-pending"
								: "shared-model",
						endpointId: "endpoint_future",
					},
				]);
				await persistRevision(foreignAgentId, 3, [
					{ optionId: "model_primary", modelId: "foreign-primary" },
					{
						optionId: "model_alternate",
						modelId:
							nameSource === "default" ? "foreign-alternate" : "shared-model",
						endpointId: "endpoint_foreign",
					},
				]);
				const accepted = await useCase.accept({
					schemaVersion: 1,
					command: "message",
					conversationId,
					text: "requested model fixture",
					idempotencyKey: "requested_model_message",
					requestId: "requested_model_message",
					traceId: "requested_model_message",
				});
				if (accepted.outcome !== "accepted")
					throw new Error("Expected fallback message acceptance");
				const rows = await client<{ event_payload: unknown }[]>`
				select event_payload from platform.conversation_events
				where conversation_id = ${conversationId}
					and event_type = 'model.selection.fell_back'
			`;
				expect(rows).toEqual([
					{
						event_payload: {
							type: "model.selection.fell_back",
							modelOptionId: "model_primary",
							reasoningLevel: "low",
							reason: "selection_unavailable",
							requestedModelOptionId: "model_alternate",
							requestedModelDisplayName: expectedName,
						},
					},
				]);
				expect(JSON.stringify(rows)).not.toContain("endpoint_historical");
				expect(calls).toEqual(
					resolver
						? [{ endpointId: "endpoint_historical", modelId: "shared-model" }]
						: [],
				);
				alias = "Later deployment name";
				// 之后的配置变化不改写已写入的事件。
				await persistRevision(requestedAuthority.agentId, 2, [
					{ optionId: "model_primary", modelId: "relay-primary" },
					{ optionId: "model_alternate", modelId: "relay-alternate-later" },
				]);
				await expect(
					useCase.accept({
						schemaVersion: 1,
						command: "message",
						conversationId,
						text: "requested model fixture",
						idempotencyKey: "requested_model_message",
						requestId: "requested_model_message",
						traceId: "requested_model_message",
					}),
				).resolves.toMatchObject({ outcome: "replayed" });
				expect(calls).toHaveLength(resolver ? 1 : 0);
				expect(
					await client`
					select event_payload->>'requestedModelDisplayName' as name
					from platform.conversation_events
					where conversation_id = ${conversationId}
						and event_type = 'model.selection.fell_back'
				`,
				).toEqual([{ name: expectedName }]);
			} finally {
				await transaction.close();
			}
		},
	);

	it.each(["supplement", "regenerate"] as const)(
		"keeps the trusted historical name on %s and does not resolve it for stop",
		async (command) => {
			await persistConformanceModelConfiguration(
				conformanceModelConfiguration,
				requestedAuthority,
			);
			let reads = 0;
			const { transaction, useCase } = createConversation(requestedAuthority, {
				readRequestedModelDisplayName: async () => {
					reads += 1;
					return "Trusted removed model";
				},
			});
			try {
				const created = await useCase.createConversation({
					schemaVersion: 1,
					agentId: requestedAuthority.agentId,
					idempotencyKey: "named-create",
					requestId: "named-create",
					traceId: "named-create",
				});
				if (created.outcome !== "accepted")
					throw new Error("Expected creation");
				const conversationId = created.result.conversationId;
				await expect(
					useCase.selectModel({
						schemaVersion: 1,
						command: "model.select",
						conversationId,
						modelOptionId: "model_alternate",
						reasoningLevel: "high",
						idempotencyKey: "named-select",
						requestId: "named-select",
						traceId: "named-select",
					}),
				).resolves.toMatchObject({ outcome: "accepted" });
				const initial = await useCase.accept({
					schemaVersion: 1,
					command: "message",
					conversationId,
					text: "controlled initial message",
					idempotencyKey: "named-initial",
					requestId: "named-initial",
					traceId: "named-initial",
				});
				if (initial.outcome !== "accepted" || !initial.result.messageId)
					throw new Error("Expected initial message");
				if (command === "regenerate") {
					await client`update platform.conversation_executions set status = 'completed' where execution_id = ${initial.result.executionId}`;
				} else {
					// 补充指令只给已被 Runtime 接受、仍在运行的回复（§12.5）。
					await client`update platform.conversation_executions set status = 'processing' where execution_id = ${initial.result.executionId}`;
				}
				await persistRevision(requestedAuthority.agentId, 2, [
					{ optionId: "model_primary", modelId: "relay-primary" },
				]);
				await makeCurrent(requestedAuthority.agentId, 2);
				reads = 0;
				const metadata = {
					schemaVersion: 1 as const,
					conversationId,
					idempotencyKey: "named-next",
					requestId: "named-next",
					traceId: "named-next",
				};
				const result =
					command === "supplement"
						? await useCase.accept({
								...metadata,
								command: "message",
								text: "controlled supplementary message",
							})
						: await useCase.regenerate({
								...metadata,
								command: "regenerate",
								sourceMessageId: initial.result.messageId,
							});
				if (result.outcome !== "accepted")
					throw new Error("Expected fallback command");
				expect(
					await client`select event_payload->>'requestedModelDisplayName' as name from platform.conversation_events where conversation_id = ${conversationId} and event_type = 'model.selection.fell_back'`,
				).toEqual([{ name: "Trusted removed model" }]);
				expect(reads).toBe(1);
				await expect(
					useCase.stop({
						...metadata,
						command: "stop",
						targetExecutionId: result.result.executionId,
						idempotencyKey: "named-stop",
					}),
				).resolves.toMatchObject({ outcome: "accepted" });
				expect(reads).toBe(1);
			} finally {
				await transaction.close();
			}
		},
	);

	it("records a null name when no applied revision of this Agent has the option", async () => {
		await persistConformanceModelConfiguration(
			conformanceModelConfiguration,
			requestedAuthority,
		);
		const { transaction, useCase } = createConversation(requestedAuthority);
		try {
			const created = await useCase.createConversation({
				schemaVersion: 1,
				agentId: requestedAuthority.agentId,
				idempotencyKey: "requested_model_unknown_create",
				requestId: "requested_model_unknown_create",
				traceId: "requested_model_unknown_create",
			});
			if (created.outcome !== "accepted")
				throw new Error("Expected Conversation creation");
			const conversationId = created.result.conversationId;
			// 模拟历史数据：会话所选选项只出现在其他 Agent 的修订中。
			await client`
				update platform.conversations
				set selected_model_option_id = 'model_foreign_only',
					selected_reasoning_level = 'high'
				where id = ${conversationId}
			`;
			await persistRevision(foreignAgentId, 1, [
				{ optionId: "model_primary", modelId: "foreign-primary" },
			]);
			await client`
				update platform.agent_configuration_revisions
				set configuration = jsonb_set(configuration,
					'{modelConfiguration,options,0,optionId}', '"model_foreign_only"')
				where agent_id = ${foreignAgentId} and revision = 1
			`;
			const accepted = await useCase.accept({
				schemaVersion: 1,
				command: "message",
				conversationId,
				text: "requested model unknown fixture",
				idempotencyKey: "requested_model_unknown_message",
				requestId: "requested_model_unknown_message",
				traceId: "requested_model_unknown_message",
			});
			if (accepted.outcome !== "accepted")
				throw new Error("Expected fallback message acceptance");
			expect(
				await client`
					select event_payload->'requestedModelOptionId' as id,
						event_payload->'requestedModelDisplayName' as name
					from platform.conversation_events
					where conversation_id = ${conversationId}
						and event_type = 'model.selection.fell_back'
				`,
			).toEqual([{ id: "model_foreign_only", name: null }]);
		} finally {
			await transaction.close();
		}
	});
});

describe("PostgreSQL bounded message queue (#3376)", () => {
	const queueBoundary = {
		schemaVersion: 1 as const,
		principal: { kind: "user" as const, id: authority.actorId },
		agentId: authority.agentId,
		channelId: "web",
		identityRevision: "identity-01",
		agentAuthorizationRevision: authority.authorizationRevision,
		accessSources: [{ kind: "user" as const, userId: authority.actorId }],
	};
	const queueAuthority: ConversationExecutionAuthorityV1 = {
		...authority,
		supportsSupplementaryInstruction: false,
		taskBoundary: queueBoundary,
	};
	const message = (
		conversationId: string,
		key: string,
		extra: { readonly queueDeadlineLimit?: string } = {},
	) => ({
		schemaVersion: 1 as const,
		command: "message" as const,
		conversationId,
		text: `bounded ${key}`,
		idempotencyKey: key,
		requestId: `request_${key}`,
		traceId: `trace_${key}`,
		...extra,
	});
	const withdrawal = (conversationId: string, executionId: string, key: string) => ({
		schemaVersion: 1 as const,
		command: "withdraw" as const,
		conversationId,
		targetExecutionId: executionId,
		idempotencyKey: key,
		requestId: `request_${key}`,
		traceId: `trace_${key}`,
	});
	const counts = async () =>
		(
			await client`
				select
					(select count(*)::int from platform.conversation_messages) as messages,
					(select count(*)::int from platform.conversation_executions) as executions,
					(select count(*)::int from platform.outbox_items where operation = 'conversation.turn.submit.v1') as turns
			`
		)[0];

	async function openQueue(
		resolved: ConversationExecutionAuthorityV1 = queueAuthority,
		maximumWaitingTasksPerAgent?: number,
	) {
		await persistConformanceModelConfiguration(undefined, resolved);
		let nextId = 1;
		const transaction = new PostgresConversationExecutionTransactionV1({
			databaseUrl,
			userDirectory: {
				async resolveUser(userId) {
					return {
						schemaVersion: 1,
						userId,
						accountStatus: "active",
						organizationIds: [],
						authorizationRevision: "identity-01",
					};
				},
			},
		});
		const useCase = createConversationExecutionUseCaseV1(
			{
				authorization: {
					async authorize() {
						return { outcome: "allowed", authority: resolved };
					},
				},
				transaction,
			},
			{
				now: () => new Date("2026-10-25T00:00:00.000Z"),
				newId: () => `queue_${resolved.actorId}_${nextId++}`,
				...(maximumWaitingTasksPerAgent === undefined
					? {}
					: { maximumWaitingTasksPerAgent }),
			},
		);
		const create = async (key: string) => {
			const created = await useCase.createConversation({
				schemaVersion: 1,
				agentId: resolved.agentId,
				idempotencyKey: key,
				requestId: `request_${key}`,
				traceId: `trace_${key}`,
			});
			if (created.outcome !== "accepted") throw new Error("Expected creation");
			await markSessionSandboxReadyFixture(client, created.result.conversationId);
			return created.result.conversationId;
		};
		const accept = async (
			conversationId: string,
			key: string,
			extra?: { readonly queueDeadlineLimit?: string },
		) => {
			const decision = await useCase.accept(message(conversationId, key, extra));
			if (decision.outcome !== "accepted") throw new Error("Expected accepted");
			return decision.result;
		};
		return { transaction, useCase, create, accept };
	}

	it("queues three messages in the shared Agent wait order, then reports busy with the queued count", async () => {
		const queue = await openQueue();
		try {
			const first = await queue.create("queue_create_first");
			const second = await queue.create("queue_create_second");
			await queue.accept(first, "first_active");
			await queue.accept(second, "second_active");
			const queued = [
				await queue.accept(first, "first_queued_1"),
				await queue.accept(second, "second_queued_1"),
				await queue.accept(first, "first_queued_2", {
					queueDeadlineLimit: "2026-10-25T00:08:30.000Z",
				}),
				await queue.accept(first, "first_queued_3"),
			];
			// 位次按会话计算，等待顺序与任务 API 共用 Agent 内的单调顺序空间。
			expect(queued.map(({ queuePosition }) => queuePosition)).toEqual([
				1, 1, 2, 3,
			]);
			const rows = await client<
				{
					execution_id: string;
					status: string;
					task_wait_order: string;
					task_wait_deadline: Date;
					last_event_sequence: string;
					available_at: string;
				}[]
			>`
				select e.execution_id, e.status, e.task_wait_order::text, e.task_wait_deadline,
					e.last_event_sequence::text, o.available_at::text
				from platform.conversation_executions e
				join platform.outbox_items o on o.id = 'conversation:turn:' || e.execution_id
				where e.task_wait_order is not null order by e.task_wait_order
			`;
			expect(rows.map((row) => row.execution_id)).toEqual(
				queued.map(({ executionId }) => executionId),
			);
			expect(rows.map((row) => row.task_wait_order)).toEqual([
				"1",
				"2",
				"3",
				"4",
			]);
			expect(rows.map((row) => row.task_wait_deadline.toISOString())).toEqual([
				"2026-10-25T00:10:00.000Z",
				"2026-10-25T00:10:00.000Z",
				// 渠道回复时限给出的上限更早时取较早者。
				"2026-10-25T00:08:30.000Z",
				"2026-10-25T00:10:00.000Z",
			]);
			expect(
				rows.every(
					(row) =>
						row.status === "waiting" &&
						row.available_at === "infinity" &&
						row.last_event_sequence === "1",
				),
			).toBe(true);
			expect(
				await client`
					select execution_id, sequence::int, event_payload, source
					from platform.conversation_events
					where execution_id = ${queued[0]?.executionId ?? ""}
				`,
			).toEqual([
				{
					execution_id: queued[0]?.executionId,
					sequence: 1,
					event_payload: { type: "task.status", status: "waiting" },
					source: "platform",
				},
			]);
			const before = await counts();
			await expect(
				queue.useCase.accept(message(first, "first_queued_4")),
			).resolves.toEqual({ outcome: "busy", queuedCount: 3 });
			expect(await counts()).toEqual(before);
			// 另一会话仍可排队：上限按会话计算。
			await expect(
				queue.accept(second, "second_queued_2"),
			).resolves.toMatchObject({ queuePosition: 2 });
		} finally {
			await queue.transaction.close();
		}
	});

	it("shares the Agent waiting capacity with task API waiting work", async () => {
		const queue = await openQueue(queueAuthority, 1);
		try {
			const first = await queue.create("capacity_first");
			const second = await queue.create("capacity_second");
			await queue.accept(first, "capacity_first_active");
			await queue.accept(second, "capacity_second_active");
			await expect(
				queue.accept(first, "capacity_first_queued"),
			).resolves.toMatchObject({ queuePosition: 1 });
			await expect(
				queue.useCase.accept(message(second, "capacity_second_queued")),
			).resolves.toEqual({ outcome: "busy", queuedCount: 0 });
		} finally {
			await queue.transaction.close();
		}
	});

	it("withdraws only the sender's own waiting message, idempotently, without affecting others", async () => {
		const queue = await openQueue();
		const foreignAuthority: ConversationExecutionAuthorityV1 = {
			...queueAuthority,
			actorId: "user_02",
			taskBoundary: {
				...queueBoundary,
				principal: { kind: "user", id: "user_02" },
				accessSources: [{ kind: "user", userId: "user_02" }],
			},
		};
		const foreign = await openQueue(foreignAuthority);
		try {
			const conversationId = await queue.create("withdraw_create");
			const otherConversation = await queue.create("withdraw_other_create");
			const active = await queue.accept(conversationId, "withdraw_active");
			const kept = await queue.accept(conversationId, "withdraw_kept");
			const target = await queue.accept(conversationId, "withdraw_target");
			const command = withdrawal(
				conversationId,
				target.executionId,
				"withdraw_key",
			);
			// 跨用户与跨会话都不能撤回，也不能探知目标是否存在。
			await expect(foreign.useCase.withdraw(command)).resolves.toEqual({
				outcome: "denied",
			});
			await expect(
				queue.useCase.withdraw({
					...command,
					conversationId: otherConversation,
					idempotencyKey: "withdraw_cross_conversation",
				}),
			).resolves.toEqual({ outcome: "denied" });
			// 当前回复不是排队消息，撤回不能用来停止它。
			await expect(
				queue.useCase.withdraw(
					withdrawal(conversationId, active.executionId, "withdraw_active_key"),
				),
			).resolves.toEqual({ outcome: "denied" });
			const result = {
				schemaVersion: 1,
				status: "withdrawn",
				executionId: target.executionId,
			};
			await expect(queue.useCase.withdraw(command)).resolves.toEqual({
				outcome: "accepted",
				result,
			});
			await expect(queue.useCase.withdraw(command)).resolves.toEqual({
				outcome: "replayed",
				result,
			});
			expect(
				await client`
					select e.status as execution, m.status as message, m.failure_code, o.status as outbox
					from platform.conversation_executions e
					join platform.conversation_messages m on m.execution_id = e.execution_id
					join platform.outbox_items o on o.id = 'conversation:turn:' || e.execution_id
					where e.execution_id in (${target.executionId}, ${kept.executionId})
					order by e.task_wait_order
				`,
			).toEqual([
				{
					execution: "waiting",
					message: "submitted",
					failure_code: null,
					outbox: "pending",
				},
				{
					execution: "cancelled",
					message: "failed",
					failure_code: "WITHDRAWN",
					outbox: "failed",
				},
			]);
			expect(
				await client`
					select event_payload from platform.conversation_events
					where execution_id = ${target.executionId} order by sequence
				`,
			).toEqual([
				{ event_payload: { type: "task.status", status: "waiting" } },
				{
					event_payload: {
						type: "task.status",
						status: "cancelled",
						reason: "WITHDRAWN",
					},
				},
			]);
			// 已离开等待（例如被认领准入）的消息不能撤回，也不影响执行。
			await client`update platform.conversation_executions set status = 'completed' where execution_id = ${active.executionId}`;
			await client`update platform.conversation_executions set status = 'unknown' where execution_id = ${kept.executionId}`;
			await expect(
				queue.useCase.withdraw(
					withdrawal(conversationId, kept.executionId, "withdraw_started"),
				),
			).resolves.toEqual({
				outcome: "accepted",
				result: {
					schemaVersion: 1,
					status: "already_started",
					executionId: kept.executionId,
				},
			});
			expect(
				await client`select status from platform.conversation_executions where execution_id = ${kept.executionId}`,
			).toEqual([{ status: "unknown" }]);
		} finally {
			await Promise.all([queue.transaction.close(), foreign.transaction.close()]);
		}
	});
});
