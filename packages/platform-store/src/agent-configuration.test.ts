import { validatePlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import type {
	AgentConfigurationAccessAuthorityV1,
	AgentConfigurationRecordV2,
	AgentConfigurationTransactionPortV1,
	AgentConfigurationUseCaseDependenciesV1,
	AgentConfigurationWritePlanV1,
	AgentManagementStateV1,
	WorkloadReconciliationStateV1,
} from "@agent-infra/platform-core";
import {
	createAgentConfigurationUseCaseV1,
	createAgentManagementV1,
	immutableSecretNameV1,
} from "@agent-infra/platform-core";
import { FakeAgentConfigurationAdmissionsV1 } from "@agent-infra/platform-core/testing";
import postgres from "postgres";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import { workloadDesiredFixture } from "../../../apps/platform-worker/src/kubernetes.fixture.js";
import {
	agentConfigurationConformanceAdmissionsV1,
	agentConfigurationConformanceRecordV1,
	agentConfigurationCustomImageUpgradeConformance,
	agentConfigurationUseCaseConformance,
} from "../../platform-core/src/agent-configuration.conformance.ts";
import {
	AgentConfigurationStoreError,
	PostgresAgentConfigurationQueryV1,
	PostgresAgentConfigurationTransactionV1,
} from "./agent-configuration.ts";
import { decodeAgentConfigurationRecord } from "./agent-configuration-record.ts";
import { PostgresAgentManagementTransactionV1 } from "./agent-management.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";
import {
	createSecretRecordFixtureResolver,
	materializeSecretRecordFixtureAttachments,
} from "./secret-record-fixture.ts";

import { openPostgresWorkloadReconciliationStoreV1 } from "./workload-reconciliation.ts";

vi.setConfig({ testTimeout: 30_000 });

const occurredAt = new Date("2026-08-31T04:00:00.000Z");
const actor = {
	schemaVersion: 1 as const,
	actorId: "owner_01",
	rawRequestDigest: "0".repeat(64),
};
const accessState: AgentManagementStateV1 = {
	schemaVersion: 1,
	applicationId: "application_01",
	agentId: "agent_01",
	applicantId: "owner_01",
	status: "available",
	revision: 11,
	approvalRevision: 1,
	decisionReason: null,
	serviceAvailability: "ready",
	desiredState: "running",
	workloadRevision: 1,
	fence: 1,
	ownerIds: ["owner_01"],
	availability: [],
	failureCode: null,
};
const accessAuthority: AgentConfigurationAccessAuthorityV1 = {
	state: accessState,
	actorContext: {
		schemaVersion: 1,
		userId: "owner_01",
		accountStatus: "active",
		organizationIds: ["org_platform"],
		isAdministrator: false,
	},
	authorityContext: {
		schemaVersion: 1,
		users: [
			{ userId: "owner_01", accountStatus: "active" },
			{ userId: "owner_02", accountStatus: "active" },
		],
		organizationIds: ["org_platform"],
	},
};

let adminClient: ReturnType<typeof postgres>;
let databaseUrl = "";
let testDatabase: PostgresTestDatabase | undefined;
const adapters: { close(): Promise<void> }[] = [];

function admissions(
	withAccess = false,
	authorizationRevision = "authorization_9",
) {
	return new FakeAgentConfigurationAdmissionsV1({
		...agentConfigurationConformanceAdmissionsV1,
		authorizations: [
			{
				agentId: "agent_01",
				actorId: "owner_01",
				authorizationRevision,
				...(withAccess ? { accessAuthority } : {}),
			},
		],
	});
}

function dependencies(
	transaction: AgentConfigurationTransactionPortV1,
	withAccess = false,
	authorizationRevision = "authorization_9",
): AgentConfigurationUseCaseDependenciesV1 {
	const admission = admissions(withAccess, authorizationRevision);
	return {
		transaction,
		authorizationAdmission: admission,
		imageAdmission: admission,
		modelAdmission: admission,
		secretAdmission: admission,
		channelAdmission: admission,
	};
}

function useCase(
	transaction: AgentConfigurationTransactionPortV1,
	withAccess = false,
	authorizationRevision = "authorization_9",
) {
	return createAgentConfigurationUseCaseV1(
		dependencies(transaction, withAccess, authorizationRevision),
		{ now: () => new Date(occurredAt) },
	);
}

async function clearDatabase() {
	await adminClient`truncate platform.audit_events, platform.outbox_items,
		platform.idempotency_records, platform.agent_management_history,
		platform.agent_availability, platform.agent_owners,
		platform.agent_configuration_revisions, platform.agent_applications,
		platform.agents cascade`;
}

async function seed(
	agentId = "agent_01",
	record = agentConfigurationConformanceRecordV1,
) {
	const configuration = { ...structuredClone(record), agentId };
	const sourceReference =
		configuration.source.kind === "standard"
			? configuration.source.templateId
			: configuration.source.imageDigest;
	await adminClient`
		insert into platform.agents
			(id, current_configuration_revision, created_at, authorization_revision)
		values (${agentId}, 7, ${occurredAt}, 'authorization_9')
	`;
	await adminClient`
		insert into platform.agent_applications
			(id, agent_id, applicant_id, name, description, status, trace_id,
			 request_id, submitted_at, management_revision, approval_revision,
			 service_availability, desired_state, workload_revision, fence)
		values (${`application_${agentId}`}, ${agentId}, 'owner_01', 'Agent',
			'Agent description', 'available', 'trace_seed', 'request_seed',
			${occurredAt}, 11, 1, 'ready', 'running', 1, 1)
	`;
	await adminClient`
		insert into platform.agent_configuration_revisions
			(agent_id, revision, source_reference, created_at, configuration)
		values (${agentId}, 7, ${sourceReference}, ${occurredAt},
			${adminClient.json(configuration as never)})
	`;
	await adminClient`
		insert into platform.agent_owners (agent_id, owner_id, created_at)
		values (${agentId}, 'owner_01', ${occurredAt})
	`;
}

async function waitForBlockedQuery(includes: readonly string[]): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const rows = await adminClient<{ query: string }[]>`
			select query from pg_stat_activity
			where datname = current_database() and wait_event_type = 'Lock'
		`;
		if (
			rows.some(({ query }) =>
				includes.every((fragment) => query.toLowerCase().includes(fragment)),
			)
		) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(
		`Timed out waiting for blocked query: ${includes.join(", ")}`,
	);
}

async function snapshot() {
	const [agent] = await adminClient`
		select current_configuration_revision, authorization_revision
		from platform.agents where id = 'agent_01'
	`;
	const [application] = await adminClient`
		select management_revision from platform.agent_applications
		where agent_id = 'agent_01'
	`;
	const [current] = await adminClient`
		select configuration from platform.agent_configuration_revisions
		where agent_id = 'agent_01'
			and revision = ${agent?.current_configuration_revision ?? 0}
	`;
	const [counts] = await adminClient`
		select
			(select count(*) from platform.agent_configuration_revisions
				where agent_id = 'agent_01') as configuration_count,
			(select count(*) from platform.idempotency_records) as idempotency_count,
			(select count(*) from platform.outbox_items) as outbox_count,
			(select count(*) from platform.audit_events) as audit_count
	`;
	return {
		configuration: decodeAgentConfigurationRecord(current?.configuration),
		currentRevision: Number(agent?.current_configuration_revision),
		authorizationRevision: String(agent?.authorization_revision),
		managementRevision: Number(application?.management_revision),
		configurationCount: Number(counts?.configuration_count),
		idempotencyCount: Number(counts?.idempotency_count),
		outboxCount: Number(counts?.outbox_count),
		auditCount: Number(counts?.audit_count),
	};
}

function openTransaction() {
	const adapter = new PostgresAgentConfigurationTransactionV1({ databaseUrl });
	adapters.push(adapter);
	return adapter;
}

beforeAll(async () => {
	testDatabase = await startPostgresTestDatabase("agent-configuration");
	databaseUrl = testDatabase.databaseUrl;
	await migratePlatformDatabase({ databaseUrl });
	adminClient = postgres(databaseUrl, { max: 4 });
}, 120_000);

afterEach(async () => {
	await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

afterAll(async () => {
	await adminClient?.end();
	await testDatabase?.stop();
});

describe("PostgreSQL Agent configuration transaction", () => {
	it("replays original V1 Action results without rewriting configuration, digest, history or effects", async () => {
		await clearDatabase();
		await seed();
		const actions = [
			{ providerId: "github", actionId: "issues.read", actionVersion: "v3" },
		];
		const legacy = {
			...agentConfigurationConformanceRecordV1,
			schemaVersion: 1,
			actions,
			actionSetRevision: "original-action-policy",
		};
		await adminClient`update platform.agent_configuration_revisions set configuration = ${adminClient.json(legacy as unknown as postgres.JSONValue)} where agent_id = 'agent_01' and revision = 7`;
		const result = {
			schemaVersion: 1,
			agentId: "agent_01",
			revision: 7,
			changedFields: ["actions"],
		};
		// Captured using the pre-retirement V1 digest formula, including the Actions.
		const digest =
			"d526cd4b79ed7c1eba491bef15abc9c50f0c61d218b1cf040a430e976dc39f45";
		await adminClient`insert into platform.idempotency_records (id, scope_type, scope_id, actor_id, command_type, idempotency_key, request_digest, status, result, created_at, updated_at) values ('legacy-action-result', 'agent', 'agent_01', 'owner_01', 'agent.configuration.update.v1', 'legacy-action-key', ${digest}, 'completed', ${adminClient.json(result)}, ${occurredAt}, ${occurredAt})`;
		const before =
			await adminClient`select configuration, (select row_to_json(i) from platform.idempotency_records i where id = 'legacy-action-result') idempotency from platform.agent_configuration_revisions where agent_id = 'agent_01' and revision = 7`;
		const command = {
			schemaVersion: 1,
			agentId: "agent_01",
			idempotencyKey: "legacy-action-key",
			requestId: "legacy-request",
			traceId: "legacy-trace",
			changes: { actions },
		};
		const configuration = useCase(openTransaction());
		await expect(configuration.replayLegacyV1(command, actor)).resolves.toEqual(
			result,
		);
		await expect(
			configuration.update(command as never, actor),
		).rejects.toMatchObject({ code: "invalid_command" });
		await expect(
			configuration.replayLegacyV1(
				{ ...command, idempotencyKey: "new-legacy-key" },
				actor,
			),
		).rejects.toMatchObject({ code: "invalid_command" });
		await expect(
			configuration.replayLegacyV1(
				{ ...command, changes: { actions: [] } },
				actor,
			),
		).rejects.toMatchObject({ code: "idempotency_conflict" });
		await expect(
			configuration.replayLegacyV1(command, { ...actor, actorId: "owner_02" }),
		).rejects.toMatchObject({ code: "not_authorized" });
		expect(
			await adminClient`select configuration, (select row_to_json(i) from platform.idempotency_records i where id = 'legacy-action-result') idempotency from platform.agent_configuration_revisions where agent_id = 'agent_01' and revision = 7`,
		).toEqual(before);
		const [effects] =
			await adminClient`select (select count(*) from platform.agent_configuration_revisions) configurations, (select count(*) from platform.idempotency_records) idempotency, (select count(*) from platform.outbox_items) outbox, (select count(*) from platform.audit_events) audit`;
		expect(effects).toEqual({
			configurations: "1",
			idempotency: "1",
			outbox: "0",
			audit: "0",
		});
		await expect(
			configuration.update(
				{
					...command,
					schemaVersion: 2,
					idempotencyKey: "v2-environment",
					changes: { environment: [{ name: "LOG_LEVEL", value: "debug" }] },
				},
				actor,
			),
		).resolves.toMatchObject({ revision: 8, changedFields: ["environment"] });
		const rows =
			await adminClient`select revision::text, configuration from platform.agent_configuration_revisions order by revision`;
		expect(rows[0]?.configuration).toEqual(legacy);
		expect(rows[1]?.configuration).toMatchObject({
			schemaVersion: 2,
			revision: 8,
		});
		expect(rows[1]?.configuration).not.toHaveProperty("actions");
		expect(rows[1]?.configuration).not.toHaveProperty("actionSetRevision");
	});

	agentConfigurationUseCaseConformance(async () => {
		await clearDatabase();
		await seed();
		const adapter = openTransaction();
		let lastPlan: AgentConfigurationWritePlanV1 | null = null;
		let failNextCommitAsStale = false;
		const transaction: AgentConfigurationTransactionPortV1 = {
			read: adapter.read.bind(adapter),
			async commit(plan, attachments) {
				if (failNextCommitAsStale) {
					failNextCommitAsStale = false;
					await adminClient`
						update platform.agents
						set authorization_revision = 'authorization_concurrent'
						where id = 'agent_01'
					`;
				}
				const decision = await adapter.commit(
					plan,
					await materializeSecretRecordFixtureAttachments(attachments),
				);
				if (decision.outcome === "committed") lastPlan = structuredClone(plan);
				return decision;
			},
		};
		const baseDependencies = dependencies(transaction);
		return {
			useCase: createAgentConfigurationUseCaseV1(baseDependencies, {
				now: () => new Date(occurredAt),
			}),
			useCaseWithDependencies(overrides) {
				return createAgentConfigurationUseCaseV1(
					{ ...baseDependencies, ...overrides },
					{ now: () => new Date(occurredAt) },
				);
			},
			async snapshot() {
				const stored = await snapshot();
				return {
					configuration: stored.configuration,
					authorizationRevision: stored.authorizationRevision,
					commitCount: stored.configurationCount - 1,
					lastPlan,
					idempotencyCount: stored.idempotencyCount,
					outboxCount: stored.outboxCount,
					auditCount: stored.auditCount,
				};
			},
			async failNextCommitAsStale() {
				failNextCommitAsStale = true;
			},
			async close() {},
		};
	});

	it("atomically persists direct configuration Secret ciphertext records", async () => {
		await clearDatabase();
		await seed();
		const adapter = openTransaction();
		const input = {
			schemaVersion: 2 as const,
			agentId: "agent_01",
			idempotencyKey: "configuration-secret-sidecar",
			requestId: "request_01",
			traceId: "trace_secret_sidecar",
			changes: { secrets: [{ name: "BOT_TOKEN", replace: true as const }] },
		};
		const first = await useCase(adapter).update(
			input,
			actor,
			createSecretRecordFixtureResolver(),
		);
		const records = await adminClient`
			select agent_id, secret_id, secret_version, configuration_revision,
				owner_id, lifecycle_state, record
			from platform.secret_records
			order by secret_id
		`;
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			agent_id: "agent_01",
			secret_id: "secret_bot_token",
			secret_version: "3",
			configuration_revision: "8",
			owner_id: "owner_01",
			lifecycle_state: "pending",
		});
		expect(JSON.stringify(records)).not.toContain("fixture:");
		const replayResolve = vi.fn();
		await expect(
			useCase(adapter).update(input, actor, { resolve: replayResolve }),
		).resolves.toEqual(first);
		expect(replayResolve).not.toHaveBeenCalled();
		expect(
			await adminClient`select count(*) as count from platform.secret_records`,
		).toEqual([{ count: "1" }]);
	});

	it("does not insert pending Secret records after a stale revision", async () => {
		await clearDatabase();
		await seed();
		const adapter = openTransaction();
		const fixture = createSecretRecordFixtureResolver();
		const resolve = vi.fn(fixture.resolve);
		const transaction: AgentConfigurationTransactionPortV1 = {
			read: adapter.read.bind(adapter),
			async commit(plan, attachments) {
				await adminClient`
					update platform.agents set current_configuration_revision = 8
					where id = 'agent_01'
				`;
				return await adapter.commit(plan, attachments);
			},
		};
		await expect(
			useCase(transaction).update(
				{
					schemaVersion: 2,
					agentId: "agent_01",
					idempotencyKey: "configuration-secret-stale",
					requestId: "request_01",
					traceId: "trace_secret_stale",
					changes: { secrets: [{ name: "BOT_TOKEN", replace: true }] },
				},
				actor,
				{ resolve },
			),
		).rejects.toMatchObject({ code: "stale_revision" });
		expect(resolve).toHaveBeenCalledOnce();
		expect(
			await adminClient`select count(*) as count from platform.secret_records`,
		).toEqual([{ count: "0" }]);
	});

	it("rejects a reused DEK fingerprint without committing a second revision", async () => {
		await clearDatabase();
		await seed();
		const adapter = openTransaction();
		await useCase(adapter).update(
			{
				schemaVersion: 2,
				agentId: "agent_01",
				idempotencyKey: "configuration-secret-first",
				requestId: "request_01",
				traceId: "trace_secret_first",
				changes: { secrets: [{ name: "BOT_TOKEN", replace: true }] },
			},
			actor,
			createSecretRecordFixtureResolver(),
		);
		const [persisted] = await adminClient`
			select dek_fingerprint from platform.secret_records
		`;
		const fingerprint = String(persisted?.dek_fingerprint);
		const admissions = new FakeAgentConfigurationAdmissionsV1({
			...agentConfigurationConformanceAdmissionsV1,
			secretReplacements: [
				{
					requestId: "request_collision",
					name: "BOT_TOKEN",
					secretId: "secret_bot_token_replacement",
					version: 4,
				},
			],
		});
		const collisionUseCase = createAgentConfigurationUseCaseV1(
			{
				transaction: adapter,
				authorizationAdmission: admissions,
				imageAdmission: admissions,
				modelAdmission: admissions,
				secretAdmission: admissions,
				channelAdmission: admissions,
			},
			{ now: () => new Date(occurredAt) },
		);
		const fixture = createSecretRecordFixtureResolver();
		await expect(
			collisionUseCase.update(
				{
					schemaVersion: 2,
					agentId: "agent_01",
					idempotencyKey: "configuration-secret-collision",
					requestId: "request_collision",
					traceId: "trace_secret_collision",
					changes: { secrets: [{ name: "BOT_TOKEN", replace: true }] },
				},
				actor,
				{
					async resolve(input) {
						const records = await fixture.resolve(input);
						if (!Array.isArray(records) || records.length !== 1) {
							throw new Error("Expected one fixture record");
						}
						return records.map((record) => ({
							...(record as Record<string, unknown>),
							crypto: {
								...(record as { crypto: Record<string, unknown> }).crypto,
								dekFingerprint: fingerprint,
							},
						}));
					},
				},
			),
		).rejects.toMatchObject({ code: "persistence_failed" });
		expect(await snapshot()).toMatchObject({
			currentRevision: 8,
			configurationCount: 2,
			idempotencyCount: 1,
			outboxCount: 1,
			auditCount: 1,
		});
		expect(
			await adminClient`select count(*) as count from platform.secret_records`,
		).toEqual([{ count: "1" }]);
	});

	it("rolls back the configuration revision when pending Secret insertion fails", async () => {
		await clearDatabase();
		await seed();
		await armFailure(
			"secret_record",
			"platform.secret_records",
			"insert",
			false,
		);
		try {
			await expect(
				useCase(openTransaction()).update(
					{
						schemaVersion: 2,
						agentId: "agent_01",
						idempotencyKey: "configuration-secret-rollback",
						requestId: "request_01",
						traceId: "trace_secret_rollback",
						changes: { secrets: [{ name: "BOT_TOKEN", replace: true }] },
					},
					actor,
					createSecretRecordFixtureResolver(),
				),
			).rejects.toMatchObject({ code: "persistence_failed" });
		} finally {
			await disarmFailure("secret_record", "platform.secret_records");
		}
		expect(await snapshot()).toMatchObject({
			currentRevision: 7,
			configurationCount: 1,
			idempotencyCount: 0,
			outboxCount: 0,
			auditCount: 0,
		});
		expect(
			await adminClient`select count(*) as count from platform.secret_records`,
		).toEqual([{ count: "0" }]);
	});

	agentConfigurationCustomImageUpgradeConformance(async (input) => {
		await clearDatabase();
		await seed("agent_01", input.record);
		const adapter = openTransaction();
		let lastPlan: AgentConfigurationWritePlanV1 | null = null;
		let commitFailureArmed = false;
		let failNextCommitAsStale = false;
		async function disarmCommitFailure() {
			if (!commitFailureArmed) return;
			await disarmFailure(
				"custom_image_upgrade",
				"platform.agent_configuration_revisions",
			);
			commitFailureArmed = false;
		}
		const transaction: AgentConfigurationTransactionPortV1 = {
			read: adapter.read.bind(adapter),
			async commit(plan) {
				if (failNextCommitAsStale) {
					failNextCommitAsStale = false;
					await adminClient`
						update platform.agents
						set authorization_revision = 'authorization_concurrent'
						where id = 'agent_01'
					`;
				}
				try {
					const decision = await adapter.commit(plan);
					if (decision.outcome === "committed")
						lastPlan = structuredClone(plan);
					return decision;
				} finally {
					await disarmCommitFailure();
				}
			},
		};
		const admission = new FakeAgentConfigurationAdmissionsV1({
			...agentConfigurationConformanceAdmissionsV1,
			images: [{ selection: input.selection, source: input.source }],
		});
		const baseDependencies = {
			...dependencies(transaction),
			imageAdmission: admission,
		};
		return {
			async failNextCommit() {
				await armFailure(
					"custom_image_upgrade",
					"platform.agent_configuration_revisions",
					"insert",
					false,
				);
				commitFailureArmed = true;
			},
			useCase: createAgentConfigurationUseCaseV1(baseDependencies, {
				now: () => new Date(occurredAt),
			}),
			useCaseWithDependencies(overrides) {
				return createAgentConfigurationUseCaseV1(
					{ ...baseDependencies, ...overrides },
					{ now: () => new Date(occurredAt) },
				);
			},
			async snapshot() {
				const stored = await snapshot();
				return {
					configuration: stored.configuration,
					authorizationRevision: stored.authorizationRevision,
					commitCount: stored.configurationCount - 1,
					lastPlan,
					idempotencyCount: stored.idempotencyCount,
					outboxCount: stored.outboxCount,
					auditCount: stored.auditCount,
				};
			},
			async failNextCommitAsStale() {
				failNextCommitAsStale = true;
			},
			async close() {
				await disarmCommitFailure();
			},
		};
	});

	it("reads one bounded configuration record with its persisted authorization revision", async () => {
		await clearDatabase();
		await seed();
		const adapter = openTransaction();
		await expect(
			adapter.read({
				schemaVersion: 1,
				agentId: "agent_01",
				actorId: "owner_01",
				idempotencyKey: "read-current-record",
				requestDigest: "0".repeat(64),
			}),
		).resolves.toEqual({
			outcome: "ready",
			record: {
				schemaVersion: 1,
				configuration: agentConfigurationConformanceRecordV1,
				authorizationRevision: "authorization_9",
			},
		});
	});

	it.each([true, false])(
		"rolls back every write and the deferred commit boundary (runtime=%s)",
		async (runtimeChange) => {
			const plan = await captureAccessPlan("authorization_10", runtimeChange);
			const points = [
				[
					"configuration",
					"platform.agent_configuration_revisions",
					"insert",
					"before",
				],
				["pointer", "platform.agents", "update", "before"],
				["access", "platform.agent_applications", "update", "before"],
				["owners_delete", "platform.agent_owners", "delete", "before"],
				["owners", "platform.agent_owners", "insert", "before"],
				[
					"availability_delete",
					"platform.agent_availability",
					"delete",
					"before",
				],
				["availability", "platform.agent_availability", "insert", "before"],
				["idempotency", "platform.idempotency_records", "insert", "before"],
				["outbox", "platform.outbox_items", "insert", "before"],
				["audit", "platform.audit_events", "insert", "before"],
				["commit", "platform.audit_events", "insert", "after"],
			] as const;
			for (const [point, table, operation, timing] of points) {
				if (!runtimeChange && (point === "configuration" || point === "outbox"))
					continue;
				await clearDatabase();
				await seed();
				if (point === "availability_delete") {
					await adminClient`
					insert into platform.agent_availability
						(agent_id, target_type, target_id)
					values ('agent_01', 'user', 'member_previous')
				`;
				}
				await armFailure(point, table, operation, timing === "after");
				const adapter = openTransaction();
				await expect(adapter.commit(plan)).rejects.toEqual(
					expect.objectContaining({
						name: "AgentConfigurationStoreError",
						code: "unavailable",
					}),
				);
				await disarmFailure(point, table);
				const stored = await snapshot();
				expect(stored).toMatchObject({
					currentRevision: 7,
					authorizationRevision: "authorization_9",
					managementRevision: 11,
					configurationCount: 1,
					idempotencyCount: 0,
					outboxCount: 0,
					auditCount: 0,
				});
			}
		},
	);

	it("rejects non-canonical payloads and bounded access inputs before writes", async () => {
		await clearDatabase();
		await seed();
		const plan = await captureAccessPlan();
		const malformedPlans = [
			{
				...plan,
				outboxIntent: {
					...plan.outboxIntent,
					payload: {
						...plan.outboxIntent?.payload,
						plaintext: "database-secret",
					},
				},
			},
			{
				...plan,
				accessUpdate: {
					...plan.accessUpdate,
					ownerIds: Array.from({ length: 257 }, (_, index) => `owner_${index}`),
				},
			},
			{
				...plan,
				auditEvent: { ...plan.auditEvent, actorId: "a".repeat(1025) },
			},
			{ ...plan, expectedAuthorizationRevision: "" },
			{ ...plan, nextAuthorizationRevision: "" },
		] as readonly AgentConfigurationWritePlanV1[];
		const adapter = openTransaction();
		for (const malformed of malformedPlans) {
			await expect(adapter.commit(malformed)).rejects.toEqual(
				expect.objectContaining({
					name: "AgentConfigurationStoreError",
					code: "unavailable",
				}),
			);
		}
		expect(await snapshot()).toMatchObject({
			currentRevision: 7,
			managementRevision: 11,
			configurationCount: 1,
			idempotencyCount: 0,
			outboxCount: 0,
			auditCount: 0,
		});
	});

	it("commits the bounded access fragment and replays without duplicate effects", async () => {
		await clearDatabase();
		await seed();
		const plan = await captureAccessPlan();
		const adapter = openTransaction();
		await expect(adapter.commit(plan)).resolves.toEqual({
			outcome: "committed",
			result: plan.result,
		});
		await expect(adapter.commit(plan)).resolves.toEqual({
			outcome: "replayed",
			result: plan.result,
		});
		const [owners, availability, effects] = await Promise.all([
			adminClient`
				select owner_id from platform.agent_owners
				where agent_id = 'agent_01' order by owner_id
			`,
			adminClient`
				select target_type, target_id from platform.agent_availability
				where agent_id = 'agent_01' order by target_type, target_id
			`,
			adminClient`
				select
					(select result from platform.idempotency_records limit 1) as result,
					(select payload from platform.outbox_items limit 1) as payload,
					(select details from platform.audit_events limit 1) as details
			`,
		]);
		expect(owners.map(({ owner_id }) => owner_id)).toEqual([
			"owner_01",
			"owner_02",
		]);
		expect(availability).toEqual([
			expect.objectContaining({
				target_type: "organization",
				target_id: "org_platform",
			}),
		]);
		expect(effects[0]).toMatchObject({
			result: plan.result,
			payload: plan.outboxIntent?.payload,
			details: { changedFields: plan.auditEvent.changedFields },
		});
		expect(await snapshot()).toMatchObject({
			currentRevision: 8,
			managementRevision: 12,
			configurationCount: 2,
			idempotencyCount: 1,
			outboxCount: 1,
			auditCount: 1,
		});
	});

	it.each([
		{ coOwnerIds: ["owner_02"] },
		{ availability: [{ kind: "user" as const, userId: "owner_02" }] },
	])("preserves runtime only for availability changes: %j", async (changes) => {
		const revision = changes.coOwnerIds ? 8 : 7;
		const expectedConfiguration = {
			...agentConfigurationConformanceRecordV1,
			revision,
		};
		await clearDatabase();
		await seed();
		const configuration = useCase(openTransaction(), true, "authorization_10");
		const command = {
			schemaVersion: 2 as const,
			agentId: "agent_01",
			idempotencyKey: "access-only",
			requestId: "request_access",
			traceId: "trace_access",
			changes: {
				...changes,
				environment: [{ name: "LOG_LEVEL", value: "info" }],
			},
		};
		const result = await configuration.update(command, actor);
		expect(result).toMatchObject({ revision });
		await expect(configuration.update(command, actor)).resolves.toEqual(result);
		expect(await snapshot()).toMatchObject({
			configuration: expectedConfiguration,
			currentRevision: revision,
			configurationCount: changes.coOwnerIds ? 2 : 1,
			managementRevision: 12,
			authorizationRevision: "authorization_10",
			idempotencyCount: 1,
			outboxCount: changes.coOwnerIds ? 1 : 0,
			auditCount: 1,
		});
		const query = new PostgresAgentConfigurationQueryV1({ databaseUrl });
		adapters.push(query);
		await expect(
			query.readAuthority({
				agentId: "agent_01",
				actorId: "owner_01",
				organizationIds: [],
				isAdministrator: false,
			}),
		).resolves.toMatchObject({
			outcome: "found",
			configuration: expectedConfiguration,
			management: {
				revision: 12,
				ownerIds: changes.coOwnerIds ? ["owner_01", "owner_02"] : ["owner_01"],
				availability: changes.availability ?? [],
			},
		});
	});

	it("serializes competing authorization, configuration, and Owner updates", async () => {
		await clearDatabase();
		await seed();
		const first = openTransaction();
		const second = openTransaction();
		let readCount = 0;
		let releaseReads: (() => void) | undefined;
		const bothRead = new Promise<void>((resolve) => {
			releaseReads = resolve;
		});
		const barrier = (adapter: PostgresAgentConfigurationTransactionV1) => ({
			async read(
				input: Parameters<AgentConfigurationTransactionPortV1["read"]>[0],
			) {
				const result = await adapter.read(input);
				readCount += 1;
				if (readCount === 2) releaseReads?.();
				await bothRead;
				return result;
			},
			commit: adapter.commit.bind(adapter),
		});
		const configurationUpdate = useCase(
			barrier(first),
			false,
			"authorization_10",
		).update(
			{
				schemaVersion: 2,
				agentId: "agent_01",
				idempotencyKey: "configuration-concurrent",
				requestId: "request_configuration",
				traceId: "trace_configuration",
				changes: { environment: [{ name: "LOG_LEVEL", value: "debug" }] },
			},
			actor,
		);
		const ownerUpdate = useCase(
			barrier(second),
			true,
			"authorization_11",
		).update(
			{
				schemaVersion: 2,
				agentId: "agent_01",
				idempotencyKey: "owner-concurrent",
				requestId: "request_owner",
				traceId: "trace_owner",
				changes: { coOwnerIds: ["owner_02"] },
			},
			actor,
		);
		const outcomes = await Promise.allSettled([
			configurationUpdate,
			ownerUpdate,
		]);
		expect(
			outcomes.filter(({ status }) => status === "fulfilled"),
		).toHaveLength(1);
		expect(outcomes.filter(({ status }) => status === "rejected")).toEqual([
			expect.objectContaining({
				status: "rejected",
				reason: expect.objectContaining({ code: "stale_revision" }),
			}),
		]);
		const stored = await snapshot();
		expect(stored).toMatchObject({
			currentRevision: 8,
			authorizationRevision:
				outcomes[0]?.status === "fulfilled"
					? "authorization_10"
					: "authorization_11",
			configurationCount: 2,
			idempotencyCount: 1,
			outboxCount: 1,
			auditCount: 1,
		});
	});

	it.each(["Owner removal", "availability shrink"] as const)(
		"rejects a pending runtime write after concurrent %s",
		async (change) => {
			const removesOwner = change === "Owner removal";
			await clearDatabase();
			await seed();
			await adminClient`insert into platform.agent_owners (agent_id, owner_id, created_at) values ('agent_01', 'owner_02', ${occurredAt})`;
			const availability = removesOwner
				? []
				: [{ kind: "user" as const, userId: "owner_02" }];
			if (!removesOwner)
				await adminClient`insert into platform.agent_availability (agent_id,target_type,target_id) values ('agent_01','user','owner_02')`;
			const state = {
				...accessState,
				ownerIds: ["owner_01", "owner_02"],
				availability,
			};
			const currentAdmissions = (actorId: string) =>
				new FakeAgentConfigurationAdmissionsV1({
					...agentConfigurationConformanceAdmissionsV1,
					authorizations: [
						{
							agentId: "agent_01",
							actorId,
							authorizationRevision: "authorization_9",
							accessAuthority: {
								...accessAuthority,
								state,
								actorContext: {
									...accessAuthority.actorContext,
									userId: actorId,
								},
							},
						},
					],
				});
			const pendingAdapter = openTransaction();
			let captured: (() => void) | undefined;
			const prepared = new Promise<void>((resolve) => {
				captured = resolve;
			});
			let release: (() => void) | undefined;
			const continueCommit = new Promise<void>((resolve) => {
				release = resolve;
			});
			const pending = createAgentConfigurationUseCaseV1({
				...dependencies(pendingAdapter),
				authorizationAdmission: currentAdmissions("owner_02"),
				transaction: {
					read: pendingAdapter.read.bind(pendingAdapter),
					async commit(plan, attachments) {
						captured?.();
						await continueCommit;
						return pendingAdapter.commit(plan, attachments);
					},
				},
			}).update(
				{
					schemaVersion: 2,
					agentId: "agent_01",
					idempotencyKey: "removed-owner-runtime",
					requestId: "pending-runtime",
					traceId: "pending-runtime",
					changes: { environment: [{ name: "LOG_LEVEL", value: "debug" }] },
				},
				{ ...actor, actorId: "owner_02" },
			);
			const outcome = Promise.allSettled([pending]);
			await prepared;
			try {
				const removalAdapter = openTransaction();
				await createAgentConfigurationUseCaseV1({
					...dependencies(removalAdapter),
					authorizationAdmission: currentAdmissions("owner_01"),
				}).update(
					{
						schemaVersion: 2,
						agentId: "agent_01",
						idempotencyKey: "remove-owner",
						requestId: "remove-owner",
						traceId: "remove-owner",
						changes: removesOwner ? { coOwnerIds: [] } : { availability: [] },
					},
					actor,
				);
			} finally {
				release?.();
			}
			expect(await outcome).toEqual([
				expect.objectContaining({
					status: "rejected",
					reason: expect.objectContaining({ code: "stale_revision" }),
				}),
			]);
			expect(await snapshot()).toMatchObject({
				configuration: {
					...agentConfigurationConformanceRecordV1,
					revision: removesOwner ? 8 : 7,
				},
				currentRevision: removesOwner ? 8 : 7,
				configurationCount: removesOwner ? 2 : 1,
				managementRevision: 12,
				authorizationRevision: "authorization_9",
				idempotencyCount: 1,
				outboxCount: removesOwner ? 1 : 0,
				auditCount: 1,
			});
			expect(
				await adminClient`select count(*) from platform.secret_records`,
			).toMatchObject([{ count: "0" }]);
		},
	);

	it("rejects a runtime mutation disguised as an availability-only plan", async () => {
		await clearDatabase();
		await seed();
		const plan = await captureAccessPlan("authorization_9", false);
		await expect(
			openTransaction().commit({
				...plan,
				configuration: {
					...plan.configuration,
					environment: [{ name: "LOG_LEVEL", value: "debug" }],
				},
			}),
		).rejects.toMatchObject({ name: "AgentConfigurationStoreError" });
		expect(await snapshot()).toMatchObject({
			configuration: agentConfigurationConformanceRecordV1,
			currentRevision: 7,
			configurationCount: 1,
			managementRevision: 11,
			idempotencyCount: 0,
			outboxCount: 0,
			auditCount: 0,
		});
	});

	it("uses one lock order for management and access-configuration commits", async () => {
		await clearDatabase();
		await seed();
		const plan = await captureAccessPlan();
		const blocker = postgres(databaseUrl, { max: 1 });
		let releaseBlocker: (() => void) | undefined;
		const blockerReleased = new Promise<void>((resolve) => {
			releaseBlocker = resolve;
		});
		let markBlockerLocked: (() => void) | undefined;
		const blockerLocked = new Promise<void>((resolve) => {
			markBlockerLocked = resolve;
		});
		const blockerTask = Promise.resolve(
			blocker.begin(async (transaction) => {
				await transaction`select pg_advisory_lock(287)`;
				markBlockerLocked?.();
				await blockerReleased;
				await transaction`select pg_advisory_unlock(287)`;
			}),
		);
		await blockerLocked;
		await adminClient.unsafe(`
			create function platform.pause_agent_management_update()
			returns trigger language plpgsql as $$
			begin
				perform pg_advisory_xact_lock(287);
				return new;
			end
			$$
		`);
		await adminClient.unsafe(`
			create trigger pause_agent_management_update
			before update on platform.agent_applications
			for each row execute function platform.pause_agent_management_update()
		`);
		const managementAdapter = new PostgresAgentManagementTransactionV1({
			databaseUrl,
		});
		const configurationAdapter = openTransaction();
		adapters.push(managementAdapter);
		const management = createAgentManagementV1(managementAdapter);
		let managementCommit: Promise<unknown> | undefined;
		let configurationCommit: Promise<unknown> | undefined;
		try {
			managementCommit = management.executeManagementCommand(
				{
					schemaVersion: 1,
					command: "stop_agent",
					agentId: "agent_01",
					expectedRevision: 11,
					idempotencyKey: "management-lock-order",
					requestId: "request_management_lock_order",
					traceId: "trace_management_lock_order",
				},
				accessAuthority.actorContext,
			);
			await waitForBlockedQuery(["update", "agent_applications"]);
			configurationCommit = configurationAdapter.commit(plan);
			await waitForBlockedQuery(["select"]);
			releaseBlocker?.();
			const [managementResult, configurationResult] = await Promise.all([
				managementCommit,
				configurationCommit,
			]);
			expect([
				(managementResult as { outcome: string }).outcome,
				(configurationResult as { outcome: string }).outcome,
			]).toEqual(expect.arrayContaining(["accepted", "stale"]));
		} finally {
			releaseBlocker?.();
			await Promise.allSettled([
				blockerTask,
				...(managementCommit ? [managementCommit] : []),
				...(configurationCommit ? [configurationCommit] : []),
			]);
			await adminClient.unsafe(
				"drop trigger if exists pause_agent_management_update on platform.agent_applications",
			);
			await adminClient.unsafe(
				"drop function if exists platform.pause_agent_management_update()",
			);
			await blocker.end();
		}
	});

	it("returns the same result for concurrent same-key commits", async () => {
		await clearDatabase();
		await seed();
		const first = openTransaction();
		const second = openTransaction();
		let readCount = 0;
		let releaseReads: (() => void) | undefined;
		const bothRead = new Promise<void>((resolve) => {
			releaseReads = resolve;
		});
		const barrier = (adapter: PostgresAgentConfigurationTransactionV1) => ({
			async read(
				input: Parameters<AgentConfigurationTransactionPortV1["read"]>[0],
			) {
				const result = await adapter.read(input);
				readCount += 1;
				if (readCount === 2) releaseReads?.();
				await bothRead;
				return result;
			},
			commit: adapter.commit.bind(adapter),
		});
		const command = {
			schemaVersion: 2 as const,
			agentId: "agent_01",
			idempotencyKey: "same-key-concurrent",
			requestId: "request_same_key",
			traceId: "trace_same_key",
			changes: { environment: [{ name: "LOG_LEVEL", value: "debug" }] },
		};
		const results = await Promise.all([
			useCase(barrier(first)).update(command, actor),
			useCase(barrier(second)).update(command, actor),
		]);
		expect(results[0]).toEqual(results[1]);
		expect(await snapshot()).toMatchObject({
			currentRevision: 8,
			configurationCount: 2,
			idempotencyCount: 1,
			outboxCount: 1,
			auditCount: 1,
		});
	});

	it("rejects stale base, access, and authorization predicates without effects", async () => {
		const plan = await captureAccessPlan();
		for (const stale of ["base", "access", "authorization"] as const) {
			await clearDatabase();
			await seed();
			if (stale === "base") {
				const revision = {
					...structuredClone(agentConfigurationConformanceRecordV1),
					revision: 8,
				};
				await adminClient`
					insert into platform.agent_configuration_revisions
						(agent_id, revision, source_reference, created_at, configuration)
					values ('agent_01', 8, 'template_01', ${occurredAt},
						${adminClient.json(revision as never)})
				`;
				await adminClient`
					update platform.agents set current_configuration_revision = 8
					where id = 'agent_01'
				`;
			} else if (stale === "access") {
				await adminClient`
					update platform.agent_applications set management_revision = 12
					where agent_id = 'agent_01'
				`;
			} else {
				await adminClient`
					update platform.agents set authorization_revision = 'authorization_10'
					where id = 'agent_01'
				`;
			}
			await expect(openTransaction().commit(plan)).resolves.toEqual({
				outcome: "stale",
			});
			const [counts] = await adminClient`
				select
					(select count(*) from platform.idempotency_records) as idempotency_count,
					(select count(*) from platform.outbox_items) as outbox_count,
					(select count(*) from platform.audit_events) as audit_count
			`;
			expect(Number(counts?.idempotency_count)).toBe(0);
			expect(Number(counts?.outbox_count)).toBe(0);
			expect(Number(counts?.audit_count)).toBe(0);
		}
	});

	it("scopes replay by Agent, actor, key, and digest", async () => {
		await clearDatabase();
		await seed();
		await seed("agent_02");
		const adapter = openTransaction();
		const command = {
			schemaVersion: 2 as const,
			agentId: "agent_01",
			idempotencyKey: "scope-key",
			requestId: "request_scope",
			traceId: "trace_scope",
			changes: { environment: [{ name: "LOG_LEVEL", value: "debug" }] },
		};
		const result = await useCase(adapter).update(command, actor);
		const [record] = await adminClient`
			select request_digest from platform.idempotency_records
			where scope_id = 'agent_01' and actor_id = 'owner_01'
		`;
		const digest = String(record?.request_digest);
		await expect(
			adapter.read({
				schemaVersion: 1,
				agentId: "agent_01",
				actorId: "owner_01",
				idempotencyKey: "scope-key",
				requestDigest: digest,
			}),
		).resolves.toEqual({ outcome: "replayed", result });
		await expect(
			adapter.read({
				schemaVersion: 1,
				agentId: "agent_01",
				actorId: "owner_01",
				idempotencyKey: "scope-key",
				requestDigest: "f".repeat(64),
			}),
		).resolves.toEqual({ outcome: "idempotency_conflict" });
		for (const [agentId, actorId, key] of [
			["agent_02", "owner_01", "scope-key"],
			["agent_01", "owner_02", "scope-key"],
			["agent_01", "owner_01", "other-key"],
		] as const) {
			await expect(
				adapter.read({
					schemaVersion: 1,
					agentId,
					actorId,
					idempotencyKey: key,
					requestDigest: digest,
				}),
			).resolves.toMatchObject({ outcome: "ready" });
		}
		expect((await snapshot()).idempotencyCount).toBe(1);
	});
});

async function runtimeExpectation(query: PostgresAgentConfigurationQueryV1) {
	const authority = await query.readAuthority({
		agentId: "agent_01",
		actorId: "owner_01",
		organizationIds: [],
		isAdministrator: false,
	});
	if (authority.outcome !== "found")
		throw new Error("Expected fixture Owner authority");
	return {
		configurationRevision: authority.configuration.revision,
		management: authority.management,
	};
}

async function runtimePresentationFixture(record?: AgentConfigurationRecordV2) {
	await clearDatabase();
	const deployment = {
		...workloadDesiredFixture(1, "agent_01", "internal-only"),
		configRevision: 7,
	};
	const configuration = record ?? {
		...agentConfigurationConformanceRecordV1,
		source: {
			kind: "custom" as const,
			imageDigest: deployment.imageDigest,
			admissionRevision: "verified-image",
			interactionMode: "platform-adapter" as const,
			connectionEnabled: true,
		},
		modelConfiguration: null,
	};
	await seed("agent_01", configuration);
	const query = new PostgresAgentConfigurationQueryV1({ databaseUrl });
	adapters.push(query);
	const input = {
		expected: await runtimeExpectation(query),
		agentId: "agent_01",
		actorId: "owner_01",
		organizationIds: [],
		isAdministrator: false,
	};
	const version = {
		configuration,
		deployment,
	} as unknown as import("@agent-infra/platform-core").WorkloadVersionV1;
	const state = {
		schemaVersion: 1,
		agentId: "agent_01",
		sourceConfigurationRevision: 7,
		sourceLifecycleRevision: 1,
		revision: 1,
		fence: 1,
		phase: "ready",
		candidate: version,
		verified: version,
		verifiedRevision: 1,
		identity: { uid: "observed-uid", generation: 1 },
		rollback: false,
		failureCode: null,
		attempts: 0,
		capabilities: { conversation: true, connection: false },
	} satisfies WorkloadReconciliationStateV1;
	const persist = async (value: unknown) => {
		await adminClient`insert into platform.workload_reconciliations (agent_id, revision, state, next_attempt_at) values ('agent_01', 1, ${adminClient.json(value as postgres.JSONValue)}, now()) on conflict (agent_id) do update set state = excluded.state`;
	};
	return { query, input, configuration, deployment, version, state, persist };
}

async function seedActiveCoOwnerSecrets() {
	const records = await createSecretRecordFixtureResolver().resolve({
		schemaVersion: 1,
		expected: [
			{ name: "BOT_TOKEN", secretId: "secret_bot_token" },
			{ name: "model:model_primary", secretId: "secret_model_primary" },
		].map((reference) => ({
			schemaVersion: 1,
			...reference,
			ownerType: "agent-owner",
			ownerId: "owner_02",
			agentId: "agent_01",
			secretVersion: 1,
			configurationRevision: 7,
			occurredAt: occurredAt.toISOString(),
		})),
	});
	if (!Array.isArray(records))
		throw new Error("Expected fixture Secret records");
	for (const value of records) {
		const pending = validatePlatformSecretRecordV1(value);
		const name = immutableSecretNameV1({
			schemaVersion: 1,
			agentId: pending.agentId,
			secretId: pending.secretId,
			secretVersion: pending.secretVersion,
			configRevision: pending.configRevision,
			ownerType: pending.ownerType,
			ownerId: pending.ownerId,
			name: pending.name,
			wrappingKeyVersion: pending.crypto.wrappingKeyVersion,
			lifecycleState: "active",
			failureRetryable: null,
			encryptedRecord: pending,
		});
		const record = validatePlatformSecretRecordV1({
			...pending,
			lifecycleState: "active",
			kubernetesSecretRef: {
				schemaVersion: 1,
				ownerType: pending.ownerType,
				ownerId: pending.ownerId,
				agentId: pending.agentId,
				secretId: pending.secretId,
				secretVersion: pending.secretVersion,
				configRevision: pending.configRevision,
				algorithmVersion: pending.crypto.algorithmVersion,
				wrappingAlgorithmVersion: pending.crypto.wrappingAlgorithmVersion,
				wrappingKeyVersion: pending.crypto.wrappingKeyVersion,
				name,
			},
			activationFence: {
				schemaVersion: 1,
				agentId: pending.agentId,
				secretId: pending.secretId,
				secretVersion: pending.secretVersion,
				configRevision: pending.configRevision,
				kubernetesSecretName: name,
				workloadUid: "observed-uid",
				workloadGeneration: 1,
				fence: 1,
			},
		});
		await adminClient`insert into platform.secret_records
			(agent_id,secret_id,secret_version,configuration_revision,owner_type,owner_id,name,lifecycle_state,dek_fingerprint,wrapping_key_version,record,created_at,updated_at)
			values (${record.agentId},${record.secretId},${record.secretVersion},${record.configRevision},${record.ownerType},${record.ownerId},${record.name},${record.lifecycleState},${record.crypto.dekFingerprint},${record.crypto.wrappingKeyVersion},${adminClient.json(record)},now(),now())`;
	}
}

describe("PostgreSQL Agent configuration query", () => {
	it.each(["availability", "owners", "owners+availability"] as const)(
		"gates the old runtime with active coOwner env/model Secrets after %s changes",
		async (change) => {
			const record: AgentConfigurationRecordV2 = {
				...agentConfigurationConformanceRecordV1,
				source: {
					...agentConfigurationConformanceRecordV1.source,
					imageDigest: `sha256:${"1".repeat(64)}`,
				},
				secrets: [
					{
						name: "BOT_TOKEN",
						secretId: "secret_bot_token",
						isSet: true,
						version: 1,
					},
				],
			};
			const { query, input, state, persist } =
				await runtimePresentationFixture(record);
			await adminClient`insert into platform.agent_owners (agent_id,owner_id,created_at) values ('agent_01','owner_02',${occurredAt})`;
			await seedActiveCoOwnerSecrets();
			await persist(state);
			const store = openPostgresWorkloadReconciliationStoreV1({
				databaseUrl,
				retryDelayMs: 0,
				monitorDelayMs: 0,
			});
			adapters.push(store);
			const observeCurrent = async () =>
				store.runNext("test-worker", async (current) => {
					expect(
						current.secrets?.bindings.map(({ record: secret }) => {
							const decoded = validatePlatformSecretRecordV1(secret);
							return {
								name: decoded.name,
								ownerId: decoded.ownerId,
								lifecycleState: decoded.lifecycleState,
							};
						}),
					).toEqual([
						{
							name: "BOT_TOKEN",
							ownerId: "owner_02",
							lifecycleState: "active",
						},
						{
							name: "model:model_primary",
							ownerId: "owner_02",
							lifecycleState: "active",
						},
					]);
					if (!current.state) throw new Error("Expected a verified runtime");
					return current.state;
				});
			await observeCurrent();
			await expect(
				query.readRuntimePresentation({
					...input,
					expected: await runtimeExpectation(query),
				}),
			).resolves.toMatchObject({ capabilities: state.capabilities });
			const admission = new FakeAgentConfigurationAdmissionsV1({
				...agentConfigurationConformanceAdmissionsV1,
				authorizations: [
					{
						agentId: "agent_01",
						actorId: "owner_01",
						authorizationRevision: "authorization_9",
						accessAuthority: {
							...accessAuthority,
							state: { ...accessState, ownerIds: ["owner_01", "owner_02"] },
						},
					},
				],
			});
			const removesOwner = change !== "availability";
			await createAgentConfigurationUseCaseV1(
				{
					...dependencies(openTransaction()),
					authorizationAdmission: admission,
				},
				{ now: () => new Date(occurredAt) },
			).update(
				{
					schemaVersion: 2,
					agentId: "agent_01",
					idempotencyKey: "active-secret-access",
					requestId: "active-secret-access",
					traceId: "active-secret-access",
					changes: {
						...(removesOwner ? { coOwnerIds: [] } : {}),
						...(change !== "owners"
							? {
									availability: [{ kind: "user" as const, userId: "owner_02" }],
								}
							: {}),
					},
				},
				actor,
			);
			if (removesOwner) {
				const step = vi.fn();
				await expect(
					store.runNext("test-worker", async () => {
						step();
						throw new Error("Removed Secret owner reached reconciliation");
					}),
				).rejects.toThrow("Workload reconciliation persistence failed");
				expect(step).not.toHaveBeenCalled();
			} else {
				await observeCurrent();
			}
			// Refresh management and configuration expectations: the remaining Owner
			// must not see persisted ready state as current after Secret ownership changed.
			await expect(
				query.readRuntimePresentation({
					...input,
					expected: await runtimeExpectation(query),
				}),
			).resolves.toMatchObject({
				capabilities: removesOwner ? null : state.capabilities,
			});
			expect(await snapshot()).toMatchObject({
				currentRevision: removesOwner ? 8 : 7,
				configurationCount: removesOwner ? 2 : 1,
				outboxCount: removesOwner ? 1 : 0,
			});
			expect(
				await adminClient`select state from platform.workload_reconciliations where agent_id='agent_01'`,
			).toMatchObject([
				{ state: { phase: "ready", sourceConfigurationRevision: 7 } },
			]);
			expect(
				await adminClient`select name,owner_id,lifecycle_state from platform.secret_records order by name`,
			).toEqual([
				{ name: "BOT_TOKEN", owner_id: "owner_02", lifecycle_state: "active" },
				{
					name: "model:model_primary",
					owner_id: "owner_02",
					lifecycle_state: "active",
				},
			]);
			expect(
				await adminClient`select action from platform.audit_events where action like 'agent.%'`,
			).toMatchObject([{ action: "agent.access.updated" }]);
		},
	);

	it("presents only current subject-scoped verified runtime capabilities and never invents an interaction URL", async () => {
		const { query, input, configuration, deployment, version, state, persist } =
			await runtimePresentationFixture();
		const withoutRuntime = {
			outcome: "found",
			sourceReference: deployment.imageDigest,
			capabilities: null,
			interactionUrl: null,
		};
		await expect(query.readRuntimePresentation(input)).resolves.toEqual(
			withoutRuntime,
		);
		await persist(state);
		await expect(query.readRuntimePresentation(input)).resolves.toEqual({
			...withoutRuntime,
			capabilities: state.capabilities,
		});
		await expect(
			query.readRuntimePresentation({ ...input, actorId: "unrelated" }),
		).resolves.toEqual({ outcome: "unavailable" });
		const { capabilities: _capabilities, ...noCapabilities } = state;
		for (const invalid of [
			noCapabilities,
			{ ...state, phase: "promoting" },
			{ ...state, fence: 2 },
			{ ...state, sourceLifecycleRevision: 2 },
			{ ...state, sourceConfigurationRevision: 8 },
			{ ...state, verifiedRevision: null },
			{ ...state, identity: null },
			{
				...state,
				candidate: {
					...version,
					deployment: {
						...deployment,
						route: { ...deployment.route, exposure: "self-managed" },
					},
				},
			},
			{
				...state,
				candidate: {
					...version,
					configuration: { ...configuration, revision: 99 },
				},
			},
		]) {
			await persist(invalid);
			await expect(query.readRuntimePresentation(input)).resolves.toEqual(
				withoutRuntime,
			);
		}
		await persist(state);
		await adminClient`update platform.agent_applications set status = 'stopped', service_availability = null, desired_state = 'stopped' where agent_id = 'agent_01'`;
		await expect(query.readRuntimePresentation(input)).resolves.toEqual({
			outcome: "stale",
		});
		input.expected = await runtimeExpectation(query);
		await expect(query.readRuntimePresentation(input)).resolves.toEqual(
			withoutRuntime,
		);
		await adminClient`update platform.agent_applications set status = 'available', service_availability = 'ready', desired_state = 'running' where agent_id = 'agent_01'`;
		await adminClient`insert into platform.agent_availability (agent_id, target_type, target_id) values ('agent_01', 'user', 'viewer')`;
		input.expected = await runtimeExpectation(query);
		await expect(
			query.readRuntimePresentation({ ...input, actorId: "viewer" }),
		).resolves.toEqual({ ...withoutRuntime, capabilities: state.capabilities });
		await adminClient`delete from platform.agent_availability where agent_id = 'agent_01'`;
		await expect(
			query.readRuntimePresentation({ ...input, actorId: "viewer" }),
		).resolves.toEqual({ outcome: "unavailable" });
	});

	it("rejects a newer configuration and runtime instead of mixing them into an earlier projection", async () => {
		const { query, input, configuration, state, persist } =
			await runtimePresentationFixture();
		await persist(state);
		const upstream = await query.read({ ...input, intent: "discover" });
		expect(upstream).toMatchObject({
			outcome: "found",
			configuration: { revision: 7 },
		});
		await expect(query.readRuntimePresentation(input)).resolves.toMatchObject({
			outcome: "found",
			capabilities: state.capabilities,
		});
		const nextDeployment = {
			...workloadDesiredFixture(2, "agent_01", "internal-only"),
			configRevision: 8,
			fence: 1,
		};
		const nextDigest = nextDeployment.imageDigest;
		const nextConfiguration = {
			...configuration,
			revision: 8,
			source: { ...configuration.source, imageDigest: nextDigest },
		};
		const nextVersion = {
			configuration: nextConfiguration,
			deployment: nextDeployment,
		};
		const nextState = {
			...state,
			revision: 2,
			sourceConfigurationRevision: 8,
			verifiedRevision: 2,
			candidate: nextVersion,
			verified: nextVersion,
			capabilities: {
				conversation: true,
				modelSelection: true,
				connection: true,
			},
		};
		await adminClient.begin(async (transaction) => {
			await transaction`insert into platform.agent_configuration_revisions (agent_id, revision, source_reference, created_at, configuration) values ('agent_01', 8, ${nextDigest}, ${occurredAt}, ${transaction.json(nextConfiguration as postgres.JSONValue)})`;
			await transaction`update platform.agents set current_configuration_revision = 8 where id = 'agent_01'`;
			await transaction`update platform.workload_reconciliations set revision = 2, state = ${transaction.json(nextState as postgres.JSONValue)} where agent_id = 'agent_01'`;
		});
		await expect(query.readRuntimePresentation(input)).resolves.toEqual({
			outcome: "stale",
		});
		input.expected = await runtimeExpectation(query);
		await expect(query.readRuntimePresentation(input)).resolves.toEqual({
			outcome: "found",
			sourceReference: nextDigest,
			capabilities: nextState.capabilities,
			interactionUrl: null,
		});
	});

	it("rejects same-revision management changes and hides revoked access before reporting staleness", async () => {
		const { query, input, state, persist } = await runtimePresentationFixture();
		await persist(state);
		await adminClient`insert into platform.agent_availability (agent_id, target_type, target_id) values ('agent_01', 'user', 'viewer')`;
		input.expected = await runtimeExpectation(query);
		const viewer = { ...input, actorId: "viewer" };
		await expect(query.readRuntimePresentation(viewer)).resolves.toMatchObject({
			outcome: "found",
			capabilities: state.capabilities,
		});
		await adminClient`update platform.agent_applications set service_availability = 'updating' where agent_id = 'agent_01'`;
		const current = await runtimeExpectation(query);
		expect(current.configurationRevision).toBe(
			input.expected.configurationRevision,
		);
		expect(current.management.revision).toBe(
			input.expected.management.revision,
		);
		await expect(query.readRuntimePresentation(viewer)).resolves.toEqual({
			outcome: "stale",
		});
		await expect(
			query.readRuntimePresentation({ ...input, expected: current }),
		).resolves.toEqual({
			outcome: "found",
			sourceReference: state.verified.configuration.source.imageDigest,
			capabilities: null,
			interactionUrl: null,
		});
		await adminClient`delete from platform.agent_availability where agent_id = 'agent_01'`;
		await expect(query.readRuntimePresentation(viewer)).resolves.toEqual({
			outcome: "unavailable",
		});
	});

	it("returns current admission authority only to an Owner, including historical configurations", async () => {
		await clearDatabase();
		await seed();
		const legacy = {
			...agentConfigurationConformanceRecordV1,
			schemaVersion: 1,
			actions: [],
			actionSetRevision: "old-policy",
		};
		await adminClient`update platform.agent_configuration_revisions set configuration = ${adminClient.json(legacy as unknown as postgres.JSONValue)} where agent_id = 'agent_01'`;
		const query = new PostgresAgentConfigurationQueryV1({ databaseUrl });
		adapters.push(query);
		const input = {
			agentId: "agent_01",
			actorId: "owner_01",
			organizationIds: [],
			isAdministrator: false,
		};
		await expect(query.readAuthority(input)).resolves.toMatchObject({
			outcome: "found",
			configuration: agentConfigurationConformanceRecordV1,
			management: { agentId: "agent_01", ownerIds: ["owner_01"] },
			authorizationRevision: "authorization_9",
		});
		for (const changes of [
			{ actorId: "administrator", isAdministrator: true },
			{ actorId: "user_03", organizationIds: ["org_platform"] },
			{ agentId: "agent_missing" },
		]) {
			await expect(
				query.readAuthority({ ...input, ...changes }),
			).resolves.toEqual({ outcome: "unavailable" });
		}
		await adminClient`delete from platform.agent_owners where agent_id = 'agent_01' and owner_id = 'owner_01'`;
		await expect(
			query.readAuthority({ ...input, isAdministrator: true }),
		).resolves.toEqual({ outcome: "unavailable" });
		await expect(
			query.readAuthority({ ...input, organizationIds: [""] }),
		).rejects.toThrow(AgentConfigurationStoreError);
	});

	it("returns one redacted domain projection and hides missing or forbidden Agents", async () => {
		await clearDatabase();
		await seed();
		await adminClient`
			insert into platform.agent_availability (agent_id, target_type, target_id)
			values ('agent_01', 'organization', 'org_platform')
		`;
		const query = new PostgresAgentConfigurationQueryV1({ databaseUrl });
		adapters.push(query);
		const found = await query.read({
			agentId: "agent_01",
			actorId: "member_01",
			organizationIds: ["org_platform"],
			isAdministrator: false,
			intent: "discover",
		});
		expect(found).toMatchObject({
			outcome: "found",
			configuration: {
				agentId: "agent_01",
				revision: 7,
				source: { kind: "standard", templateId: "template_01" },
				ownerIds: ["owner_01"],
				defaultModelOptionId: "model_primary",
				secrets: [],
			},
		});
		expect(JSON.stringify(found)).not.toMatch(
			/secret_model_primary|sha256:|image_policy_7|endpoint_01|binding_01/,
		);
		const forbidden = await query.read({
			agentId: "agent_01",
			actorId: "outsider",
			organizationIds: [],
			isAdministrator: false,
			intent: "discover",
		});
		const missing = await query.read({
			agentId: "agent_missing",
			actorId: "outsider",
			organizationIds: [],
			isAdministrator: false,
			intent: "discover",
		});
		expect(forbidden).toEqual({ outcome: "unavailable" });
		expect(missing).toEqual(forbidden);
	});

	it("fails closed on legacy NULL and malicious configuration, authorization, or replay records", async () => {
		await clearDatabase();
		await seed();
		const transaction = openTransaction();
		await adminClient`
			update platform.agent_configuration_revisions
			set configuration = null where agent_id = 'agent_01' and revision = 7
		`;
		await expect(
			transaction.read({
				schemaVersion: 1,
				agentId: "agent_01",
				actorId: "owner_01",
				idempotencyKey: "legacy-key",
				requestDigest: "0".repeat(64),
			}),
		).resolves.toEqual({ outcome: "missing" });

		await clearDatabase();
		await seed();
		await adminClient`
			update platform.agents set authorization_revision = null
			where id = 'agent_01'
		`;
		await expect(
			transaction.read({
				schemaVersion: 1,
				agentId: "agent_01",
				actorId: "owner_01",
				idempotencyKey: "legacy-authorization-key",
				requestDigest: "0".repeat(64),
			}),
		).rejects.toEqual(expect.any(AgentConfigurationStoreError));

		await clearDatabase();
		await seed();
		await adminClient`
			update platform.agent_configuration_revisions
			set configuration = configuration || '{"plaintext":"database-secret"}'::jsonb
			where agent_id = 'agent_01' and revision = 7
		`;
		await expect(
			transaction.read({
				schemaVersion: 1,
				agentId: "agent_01",
				actorId: "owner_01",
				idempotencyKey: "malicious-key",
				requestDigest: "0".repeat(64),
			}),
		).rejects.toEqual(expect.any(AgentConfigurationStoreError));
		const query = new PostgresAgentConfigurationQueryV1({ databaseUrl });
		adapters.push(query);
		await expect(
			query.read({
				agentId: "agent_01",
				actorId: "owner_01",
				organizationIds: [],
				isAdministrator: false,
				intent: "manage",
			}),
		).rejects.toMatchObject({
			name: "AgentConfigurationStoreError",
			message: "Agent configuration persistence unavailable",
		});

		await clearDatabase();
		await seed();
		await adminClient`
			update platform.agent_configuration_revisions
			set source_reference = 'template_tampered'
			where agent_id = 'agent_01' and revision = 7
		`;
		await expect(
			transaction.read({
				schemaVersion: 1,
				agentId: "agent_01",
				actorId: "owner_01",
				idempotencyKey: "tampered-source-key",
				requestDigest: "0".repeat(64),
			}),
		).rejects.toEqual(expect.any(AgentConfigurationStoreError));

		await clearDatabase();
		await seed();
		const digest = "a".repeat(64);
		await adminClient`
			insert into platform.idempotency_records
				(id, scope_type, scope_id, actor_id, command_type, idempotency_key,
				 request_digest, status, result, created_at, updated_at)
			values ('malicious_replay', 'agent', 'agent_01', 'owner_01',
				'agent.configuration.update.v1', 'malicious-replay-key', ${digest},
				'completed', ${adminClient.json({
					schemaVersion: 1,
					agentId: "agent_01",
					revision: 8,
					changedFields: ["environment"],
					plaintext: "database-secret",
				})}, ${occurredAt}, ${occurredAt})
		`;
		await expect(
			transaction.read({
				schemaVersion: 1,
				agentId: "agent_01",
				actorId: "owner_01",
				idempotencyKey: "malicious-replay-key",
				requestDigest: digest,
			}),
		).rejects.toMatchObject({
			name: "AgentConfigurationStoreError",
			message: "Agent configuration persistence unavailable",
		});

		await adminClient`
			insert into platform.idempotency_records
				(id, scope_type, scope_id, actor_id, command_type, idempotency_key,
				 request_digest, status, result, created_at, updated_at)
			values ('cross_agent_replay', 'agent', 'agent_01', 'owner_01',
				'agent.configuration.update.v1', 'cross-agent-replay-key', ${digest},
				'completed', ${adminClient.json({
					schemaVersion: 1,
					agentId: "agent_02",
					revision: 8,
					changedFields: ["environment"],
				})}, ${occurredAt}, ${occurredAt})
		`;
		await expect(
			transaction.read({
				schemaVersion: 1,
				agentId: "agent_01",
				actorId: "owner_01",
				idempotencyKey: "cross-agent-replay-key",
				requestDigest: digest,
			}),
		).rejects.toMatchObject({
			name: "AgentConfigurationStoreError",
			message: "Agent configuration persistence unavailable",
		});

		await clearDatabase();
		await seed();
		await adminClient`
			update platform.agent_owners set owner_id = ${"a".repeat(1025)}
			where agent_id = 'agent_01'
		`;
		const boundedQuery = new PostgresAgentConfigurationQueryV1({ databaseUrl });
		adapters.push(boundedQuery);
		await expect(
			boundedQuery.read({
				agentId: "agent_01",
				actorId: "owner_01",
				organizationIds: [],
				isAdministrator: true,
				intent: "manage",
			}),
		).rejects.toMatchObject({ name: "AgentConfigurationStoreError" });
	});

	it("binds decoded configuration identity to the selected Agent row", async () => {
		await clearDatabase();
		await seed();
		const transaction = openTransaction();
		const query = new PostgresAgentConfigurationQueryV1({ databaseUrl });
		adapters.push(query);
		await adminClient`
			alter table platform.agent_configuration_revisions
			drop constraint agent_configuration_identity_matches
		`;
		try {
			await adminClient`
				update platform.agent_configuration_revisions
				set configuration = jsonb_set(
					configuration, '{agentId}', '"agent_other"'::jsonb
				)
				where agent_id = 'agent_01' and revision = 7
			`;
			await expect(
				transaction.read({
					schemaVersion: 1,
					agentId: "agent_01",
					actorId: "owner_01",
					idempotencyKey: "mismatched-identity",
					requestDigest: "0".repeat(64),
				}),
			).rejects.toMatchObject({ name: "AgentConfigurationStoreError" });
			await expect(
				query.read({
					agentId: "agent_01",
					actorId: "owner_01",
					organizationIds: [],
					isAdministrator: true,
					intent: "manage",
				}),
			).rejects.toMatchObject({ name: "AgentConfigurationStoreError" });
		} finally {
			await clearDatabase();
			await adminClient.unsafe(`
				alter table platform.agent_configuration_revisions
				add constraint agent_configuration_identity_matches check (
					configuration is null or (
						jsonb_typeof(configuration) = 'object'
						and configuration @> jsonb_build_object(
							'schemaVersion', 1,
							'agentId', agent_id,
							'revision', revision
						)
					)
				)
			`);
		}
	});

	it("sanitizes PostgreSQL failures", async () => {
		const transaction = new PostgresAgentConfigurationTransactionV1({
			databaseUrl:
				"postgres://platform_user:database-secret@127.0.0.1:1/platform",
		});
		let failure: unknown;
		try {
			await transaction.read({
				schemaVersion: 1,
				agentId: "agent_01",
				actorId: "owner_01",
				idempotencyKey: "failure-key",
				requestDigest: "0".repeat(64),
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({
			name: "AgentConfigurationStoreError",
			code: "unavailable",
			message: "Agent configuration persistence unavailable",
		});
		expect(String(failure)).not.toMatch(
			/database-secret|127\.0\.0\.1|select|sql/i,
		);
		await transaction.close().catch(() => {});
	});
});

async function captureAccessPlan(
	nextAuthorizationRevision = "authorization_9",
	runtimeChange = true,
): Promise<AgentConfigurationWritePlanV1> {
	let captured: AgentConfigurationWritePlanV1 | undefined;
	const transaction: AgentConfigurationTransactionPortV1 = {
		async read() {
			return {
				outcome: "ready",
				record: {
					schemaVersion: 1,
					configuration: structuredClone(agentConfigurationConformanceRecordV1),
					authorizationRevision: "authorization_9",
				},
			};
		},
		async commit(plan) {
			captured = structuredClone(plan);
			return { outcome: "stale" };
		},
	};
	await expect(
		useCase(transaction, true, nextAuthorizationRevision).update(
			{
				schemaVersion: 2,
				agentId: "agent_01",
				idempotencyKey: "access-plan",
				requestId: "request_access",
				traceId: "trace_access",
				changes: {
					...(runtimeChange ? { coOwnerIds: ["owner_02"] } : {}),
					availability: [
						{ kind: "organization", organizationId: "org_platform" },
					],
					...(runtimeChange
						? { environment: [{ name: "LOG_LEVEL", value: "debug" }] }
						: {}),
				},
			},
			actor,
		),
	).rejects.toMatchObject({ code: "stale_revision" });
	if (!captured) throw new Error("Expected a captured configuration plan");
	return captured;
}

async function armFailure(
	point: string,
	table: string,
	operation: "delete" | "insert" | "update",
	deferred: boolean,
) {
	const functionName = `platform.agent_configuration_fail_${point}`;
	const triggerName = `agent_configuration_fail_${point}`;
	await adminClient.unsafe(`
		create function ${functionName}() returns trigger language plpgsql as $$
		begin
			raise exception 'injected Agent configuration failure';
		end
		$$
	`);
	await adminClient.unsafe(
		deferred
			? `create constraint trigger ${triggerName} after ${operation} on ${table}
				deferrable initially deferred for each row execute function ${functionName}()`
			: `create trigger ${triggerName} before ${operation} on ${table}
				for each row execute function ${functionName}()`,
	);
}

async function disarmFailure(point: string, table: string) {
	await adminClient.unsafe(
		`drop trigger if exists agent_configuration_fail_${point} on ${table}`,
	);
	await adminClient.unsafe(
		`drop function if exists platform.agent_configuration_fail_${point}()`,
	);
}
