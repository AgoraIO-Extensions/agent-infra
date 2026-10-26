import {
	type AgentConfigurationUseCaseV1,
	createAgentConfigurationUseCaseV1,
	createAgentManagementV1,
	createWorkloadReconciliationV1,
	type WorkloadReconciliationStateV1,
	type WorkloadRuntimePortV1,
} from "@agent-infra/platform-core";
import { FakeAgentConfigurationAdmissionsV1 } from "@agent-infra/platform-core/testing";
import postgres from "postgres";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	agentConfigurationConformanceAdmissionsV1,
	agentConfigurationConformanceRecordV1,
} from "../../platform-core/src/agent-configuration.conformance.ts";
import { PostgresAgentConfigurationTransactionV1 } from "./agent-configuration.ts";
import { PostgresAgentManagementTransactionV1 } from "./agent-management.ts";
import { lockAgentConfiguration } from "./conversation-execution-sql.ts";
import { readRecentPersonalConversations } from "./conversation-recent-query.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";
import { openPostgresWorkloadReconciliationStoreV1 } from "./workload-reconciliation.ts";

/**
 * ADR-0028 的验证契约（真实 PostgreSQL）：只改渠道的配置修订推进配置修订，但 Runtime 修订、
 * Workload 调谐与服务可用性都不变；Runtime 输入的修订照常调谐。
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const agentId = "agent-r";
const ownerId = "owner-r";
const actor = {
	schemaVersion: 1 as const,
	actorId: ownerId,
	rawRequestDigest: "0".repeat(64),
};
let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let workloads: ReturnType<typeof openPostgresWorkloadReconciliationStoreV1>;
let configurationTransaction: PostgresAgentConfigurationTransactionV1;
let configuration: AgentConfigurationUseCaseV1;
let idempotency = 0;

beforeAll(async () => {
	database = await startPostgresTestDatabase("runtime-revision");
	await migratePlatformDatabase(database);
	sql = postgres(database.databaseUrl, { onnotice: () => undefined });
	workloads = openPostgresWorkloadReconciliationStoreV1({
		...database,
		retryDelayMs: 0,
		monitorDelayMs: 0,
	});
	configurationTransaction = new PostgresAgentConfigurationTransactionV1({
		databaseUrl: database.databaseUrl,
	});
	const admissions = new FakeAgentConfigurationAdmissionsV1({
		...agentConfigurationConformanceAdmissionsV1,
		authorizations: [
			{ agentId, actorId: ownerId, authorizationRevision: "authorization-r" },
		],
		channelBindings: [{ kind: "wecom_bot", bindingReference: "binding-r" }],
		channelRevision: "channels-r",
	});
	configuration = createAgentConfigurationUseCaseV1({
		transaction: configurationTransaction,
		authorizationAdmission: admissions,
		imageAdmission: admissions,
		modelAdmission: admissions,
		secretAdmission: admissions,
		channelAdmission: admissions,
	});
});

afterAll(async () => {
	await workloads?.close();
	await configurationTransaction?.close();
	await sql?.end();
	await database?.stop();
});

beforeEach(async () => {
	await sql`truncate platform.agents, platform.outbox_items, platform.audit_events,
		platform.persisted_events, platform.idempotency_records, platform.conversations cascade`;
	const record = {
		schemaVersion: 2,
		agentId,
		revision: 1,
		source: {
			kind: "custom",
			imageDigest: `sha256:${"a".repeat(64)}`,
			admissionRevision: "admission-r",
			interactionMode: "platform-adapter",
			connectionEnabled: false,
		},
		modelConfiguration: null,
		environment: [],
		secrets: [],
		channels: [],
		channelRevision: "channels-initial",
	};
	await sql`insert into platform.agents(id, current_configuration_revision, authorization_revision)
		values (${agentId}, 1, 'authorization-r')`;
	await sql`insert into platform.agent_applications(id, agent_id, applicant_id, name, description,
		status, trace_id, request_id, submitted_at, management_revision, approval_revision,
		desired_state, workload_revision, fence)
		values ('application-r', ${agentId}, ${ownerId}, 'Agent', 'Fixture', 'creating', 'trace-r',
		'request-r', now(), 1, 1, 'running', 1, 1)`;
	// 旧写入路径不写 runtime_revision：迁移触发器按“改变了 Runtime 输入”补为本修订号。
	await sql`insert into platform.agent_configuration_revisions(agent_id, revision, source_reference, configuration, created_at)
		values (${agentId}, 1, ${record.source.imageDigest}, ${sql.json(record)}, now())`;
	await sql`insert into platform.agent_owners(agent_id, owner_id, created_at) values (${agentId}, ${ownerId}, now())`;
	await sql`insert into platform.outbox_items(id, scope_type, scope_id, operation, payload, trace_id, request_id)
		values ('task-r', 'agent', ${agentId}, 'agent.workload.reconcile.v1',
		${sql.json({ schemaVersion: 1, agentId, revision: 1, workloadRevision: 1, fence: 1, desiredState: "running" })},
		'trace-r', 'request-r')`;
});

afterEach(() => {
	vi.restoreAllMocks();
});

function runtime(): WorkloadRuntimePortV1 {
	return {
		capabilities: async () => ({}),
		preflight: async (_input, state) => ({
			...state.candidate,
			deployment: { admitted: true },
		}),
		closeRoute: async () => undefined,
		apply: async () => ({ uid: "uid-r", generation: 1 }),
		observe: async () => "healthy",
		activateSecrets: async () => "active",
		promote: async () => undefined,
		discardUnactivatedSecrets: async () => true,
		cleanup: async () => true,
	};
}

async function tick(worker: ReturnType<typeof createWorkloadReconciliationV1>) {
	// The monitor interval is zero, so every persisted state is due again.
	return worker.tick("worker-r");
}

async function untilReady(
	worker: ReturnType<typeof createWorkloadReconciliationV1>,
) {
	for (let attempt = 0; attempt < 12; attempt += 1) {
		await tick(worker);
		if ((await workload()).phase === "ready") return;
	}
	throw new Error("Workload did not become ready");
}

async function workload(): Promise<WorkloadReconciliationStateV1> {
	const [row] = await sql<
		{ state: WorkloadReconciliationStateV1 }[]
	>`select state from platform.workload_reconciliations where agent_id = ${agentId}`;
	if (!row) throw new Error("Missing Workload state");
	return row.state;
}

async function revisions() {
	return sql<
		{ revision: number; runtime_revision: number }[]
	>`select revision::int, runtime_revision::int from platform.agent_configuration_revisions
		where agent_id = ${agentId} order by revision`;
}

async function management() {
	const [row] = await sql<
		{ status: string; service_availability: string | null }[]
	>`select status, service_availability from platform.agent_applications where agent_id = ${agentId}`;
	return row;
}

async function pendingWorkloadOutbox() {
	return sql`select id from platform.outbox_items where scope_type = 'agent' and scope_id = ${agentId}
		and operation in ('agent.workload.reconcile.v1', 'agent.configuration.revised.v1')
		and status <> 'succeeded'`;
}

async function update(changes: Record<string, unknown>) {
	idempotency += 1;
	return configuration.update(
		{
			schemaVersion: 2,
			agentId,
			idempotencyKey: `runtime-revision-${idempotency}`,
			requestId: `request-${idempotency}`,
			traceId: `trace-${idempotency}`,
			changes: changes as never,
		},
		actor,
	);
}

const bindChannel = () =>
	update({
		channels: [
			{ kind: "wecom_bot", enabled: true, bindingReference: "binding-r" },
		],
	});
const unbindChannel = () =>
	update({ channels: [{ kind: "wecom_bot", enabled: false }] });
const changeEnvironment = (value: string) =>
	update({ environment: [{ name: "LOG_LEVEL", value }] });

async function configurationRow(revision: number) {
	const [row] = await sql<
		{ configuration: unknown }[]
	>`select configuration from platform.agent_configuration_revisions where agent_id = ${agentId} and revision = ${revision}`;
	return row?.configuration;
}

describe("Runtime revision (ADR-0028)", () => {
	it("binds a channel without waking, rebuilding or updating a ready Agent", async () => {
		const worker = createWorkloadReconciliationV1({
			store: workloads,
			runtime: runtime(),
		});
		await untilReady(worker);
		expect(await management()).toEqual({
			status: "available",
			service_availability: "ready",
		});
		const ready = await workload();

		await expect(bindChannel()).resolves.toMatchObject({
			revision: 2,
			changedFields: ["channels"],
		});
		// Configuration revision and audit advance; the Runtime revision does not.
		expect(await revisions()).toEqual([
			{ revision: 1, runtime_revision: 1 },
			{ revision: 2, runtime_revision: 1 },
		]);
		expect(await pendingWorkloadOutbox()).toEqual([]);
		expect(
			await sql`select details from platform.audit_events where action = 'agent.configuration.revised'`,
		).toEqual([{ details: { changedFields: ["channels"] } }]);

		// Periodic monitor steps keep the verified Workload and its availability.
		for (let attempt = 0; attempt < 3; attempt += 1) await tick(worker);
		expect(await workload()).toMatchObject({
			phase: "ready",
			sourceConfigurationRevision: 1,
			revision: ready.revision,
			verifiedRevision: ready.verifiedRevision,
			candidate: ready.candidate,
			verified: ready.verified,
		});
		expect(await management()).toEqual({
			status: "available",
			service_availability: "ready",
		});
		expect(
			await sql`select 1 from platform.audit_events where action = 'agent.workload.service_updating'`,
		).toHaveLength(0);

		// Unbinding is also a channel-only revision.
		await unbindChannel();
		expect((await revisions()).at(-1)).toEqual({
			revision: 3,
			runtime_revision: 1,
		});
		await tick(worker);
		expect(await workload()).toMatchObject({
			phase: "ready",
			sourceConfigurationRevision: 1,
			revision: ready.revision,
		});
	});

	it("reconciles every Runtime input revision and adopts its own configuration document", async () => {
		const worker = createWorkloadReconciliationV1({
			store: workloads,
			runtime: runtime(),
		});
		await untilReady(worker);
		await bindChannel();
		await changeEnvironment("debug");
		expect(await revisions()).toEqual([
			{ revision: 1, runtime_revision: 1 },
			{ revision: 2, runtime_revision: 1 },
			{ revision: 3, runtime_revision: 3 },
		]);
		expect(await pendingWorkloadOutbox()).toHaveLength(1);
		await tick(worker);
		expect(await workload()).toMatchObject({
			phase: "preflight",
			sourceConfigurationRevision: 3,
		});
		await untilReady(worker);
		const state = await workload();
		expect(state.sourceConfigurationRevision).toBe(3);
		// The embedded document is the Runtime revision's row, channels included.
		expect(state.verified?.configuration).toEqual(await configurationRow(3));
		expect(state.verified?.configuration).toMatchObject({
			environment: [{ name: "LOG_LEVEL", value: "debug" }],
			channels: [{ kind: "wecom_bot", bindingReference: "binding-r" }],
		});
	});

	it("keeps an in-flight Runtime step valid when only channels change meanwhile", async () => {
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		let holdPreflight = false;
		const base = runtime();
		const worker = createWorkloadReconciliationV1({
			store: workloads,
			runtime: {
				...base,
				async preflight(input, state) {
					if (holdPreflight) {
						entered.resolve();
						await gate.promise;
					}
					return base.preflight(input, state);
				},
			},
		});
		await untilReady(worker);
		await changeEnvironment("debug");
		await tick(worker);
		expect(await workload()).toMatchObject({
			phase: "preflight",
			sourceConfigurationRevision: 2,
		});
		holdPreflight = true;
		const step = tick(worker);
		await entered.promise;
		// A channel change commits while the Runtime step runs outside any lock.
		await bindChannel();
		gate.resolve();
		await expect(step).resolves.toBe("advanced");
		holdPreflight = false;
		// The write-back was not discarded and the candidate was not superseded.
		const advanced = await workload();
		expect(advanced).toMatchObject({
			phase: "closing",
			sourceConfigurationRevision: 2,
			candidate: { configuration: { revision: 2 } },
		});
		await untilReady(worker);
		expect(await workload()).toMatchObject({
			phase: "ready",
			sourceConfigurationRevision: 2,
			verified: { configuration: await configurationRow(2) },
		});
		expect(await revisions()).toEqual([
			{ revision: 1, runtime_revision: 1 },
			{ revision: 2, runtime_revision: 2 },
			{ revision: 3, runtime_revision: 2 },
		]);
	});

	it("leaves a stopped Agent's Workload and recent conversations intact when its channel changes", async () => {
		const worker = createWorkloadReconciliationV1({
			store: workloads,
			runtime: runtime(),
		});
		await untilReady(worker);
		const transaction = new PostgresAgentManagementTransactionV1({
			databaseUrl: database.databaseUrl,
		});
		try {
			const decision = await createAgentManagementV1(
				transaction,
			).executeManagementCommand(
				{
					schemaVersion: 1,
					command: "stop_agent",
					agentId,
					expectedRevision: 2,
					idempotencyKey: "stop-runtime-revision",
					requestId: "request-stop-runtime-revision",
					traceId: "trace-stop-runtime-revision",
				},
				{
					schemaVersion: 1,
					userId: ownerId,
					accountStatus: "active",
					organizationIds: [],
					isAdministrator: false,
				},
			);
			expect(decision.outcome).toBe("accepted");
		} finally {
			await transaction.close();
		}
		for (let attempt = 0; attempt < 6; attempt += 1) {
			await tick(worker);
			if ((await workload()).phase === "stopped") break;
		}
		const stopped = await workload();
		expect(stopped).toMatchObject({
			phase: "stopped",
			sourceConfigurationRevision: 1,
		});
		await sql`insert into platform.conversations
			(id, agent_id, actor_id, principal_type, channel_id, status, session_generation,
			 authorization_revision, last_conversation_cursor, created_at, updated_at)
			values ('conversation-r', ${agentId}, ${ownerId}, 'user', 'web', 'ready', 1,
			 'authorization-r', 0, now(), now())`;
		const recent = () =>
			readRecentPersonalConversations(
				sql,
				{
					user: {
						schemaVersion: 1,
						userId: ownerId,
						accountStatus: "active",
						organizationIds: [],
						authorizationRevision: "identity-r",
					},
					limit: 10,
				},
				(row) => ({ conversationId: row.id }) as never,
			);

		await bindChannel();
		await unbindChannel();
		expect((await revisions()).map((row) => row.runtime_revision)).toEqual([
			1, 1, 1,
		]);
		for (let attempt = 0; attempt < 3; attempt += 1) await tick(worker);
		// No reset to closing with a stale candidate: the Workload still matches.
		expect(await workload()).toEqual(stopped);
		await expect(recent()).resolves.toMatchObject([
			{
				projection: { conversationId: "conversation-r" },
				channel: { configurationRevision: 1 },
			},
		]);
	});

	it("pins new Executions to the Runtime revision that carries their model configuration", async () => {
		const model = "agent-m";
		const record = {
			...structuredClone(agentConfigurationConformanceRecordV1),
			agentId: model,
			revision: 1,
		};
		await sql`insert into platform.agents(id, current_configuration_revision, authorization_revision)
			values (${model}, 2, 'authorization-m')`;
		await sql`insert into platform.agent_configuration_revisions(agent_id, revision, source_reference, configuration, created_at)
			values (${model}, 1, 'template_01', ${sql.json(record)}, now())`;
		const channelOnly = {
			...record,
			revision: 2,
			channels: [{ kind: "wecom_bot", bindingReference: "binding-m" }],
			channelRevision: "channels-m",
		};
		await sql`insert into platform.agent_configuration_revisions(agent_id, revision, runtime_revision, source_reference, configuration, created_at)
			values (${model}, 2, 1, 'template_01', ${sql.json(channelOnly)}, now())`;
		const locked = await sql.begin((transaction) =>
			lockAgentConfiguration(transaction as never, model),
		);
		expect(locked).toMatchObject({
			configuration: { revision: 2, channels: channelOnly.channels },
			runtimeConfiguration: { revision: 1, channels: [] },
			modelConfiguration: {
				configurationRevision: 1,
				defaultOptionId: "model_primary",
			},
		});
		// A row claiming to inherit a different model configuration fails closed.
		const forged = {
			...channelOnly,
			revision: 3,
			modelConfiguration: {
				...record.modelConfiguration,
				defaultReasoningLevel: "medium",
				options: record.modelConfiguration.options.map((option) => ({
					...option,
					reasoningLevels: ["low", "medium"],
				})),
			},
		};
		await sql`insert into platform.agent_configuration_revisions(agent_id, revision, runtime_revision, source_reference, configuration, created_at)
			values (${model}, 3, 1, 'template_01', ${sql.json(forged)}, now())`;
		await sql`update platform.agents set current_configuration_revision = 3 where id = ${model}`;
		await expect(
			sql.begin((transaction) =>
				lockAgentConfiguration(transaction as never, model),
			),
		).rejects.toThrow();
		// The same document is accepted once it is its own Runtime revision.
		await sql`update platform.agent_configuration_revisions set runtime_revision = 3
			where agent_id = ${model} and revision = 3`;
		await expect(
			sql.begin((transaction) =>
				lockAgentConfiguration(transaction as never, model),
			),
		).resolves.toMatchObject({
			modelConfiguration: { configurationRevision: 3 },
		});
	});
});
