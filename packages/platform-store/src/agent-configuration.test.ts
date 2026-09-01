import type {
	AgentConfigurationAccessAuthorityV1,
	AgentConfigurationTransactionPortV1,
	AgentConfigurationUseCaseDependenciesV1,
	AgentConfigurationWritePlanV1,
	AgentManagementStateV1,
} from "@agent-infra/platform-core";
import {
	createAgentConfigurationUseCaseV1,
	createAgentManagementV1,
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

import {
	agentConfigurationConformanceAdmissionsV1,
	agentConfigurationConformanceRecordV1,
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
		actionAdmission: admission,
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

async function seed(agentId = "agent_01") {
	const configuration = {
		...structuredClone(agentConfigurationConformanceRecordV1),
		agentId,
	};
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
		values (${agentId}, 7, 'template_01', ${occurredAt},
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
	agentConfigurationUseCaseConformance(async () => {
		await clearDatabase();
		await seed();
		const adapter = openTransaction();
		let lastPlan: AgentConfigurationWritePlanV1 | null = null;
		let failNextCommitAsStale = false;
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
				const decision = await adapter.commit(plan);
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

	it("rolls back every write and the deferred commit boundary", async () => {
		const plan = await captureAccessPlan("authorization_10");
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
	});

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
						...plan.outboxIntent.payload,
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
			payload: plan.outboxIntent.payload,
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
				schemaVersion: 1,
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
				schemaVersion: 1,
				agentId: "agent_01",
				idempotencyKey: "owner-concurrent",
				requestId: "request_owner",
				traceId: "trace_owner",
				changes: { ownerIds: ["owner_01", "owner_02"] },
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
			schemaVersion: 1 as const,
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
			schemaVersion: 1 as const,
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

describe("PostgreSQL Agent configuration query", () => {
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
				schemaVersion: 1,
				agentId: "agent_01",
				idempotencyKey: "access-plan",
				requestId: "request_access",
				traceId: "trace_access",
				changes: {
					ownerIds: ["owner_01", "owner_02"],
					availability: [
						{ kind: "organization", organizationId: "org_platform" },
					],
					environment: [{ name: "LOG_LEVEL", value: "debug" }],
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
