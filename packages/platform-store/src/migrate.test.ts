import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { createAgentManagementV1 } from "@agent-infra/platform-core";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { getTableConfig } from "drizzle-orm/pg-core";
import postgres from "postgres";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";

import { agentConfigurationConformanceRecordV1 } from "../../platform-core/src/agent-configuration.conformance.ts";
import {
	migratePlatformDatabase,
	platformDatabaseUrlFromEnvironment,
} from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";
import {
	platformInfrastructureTables,
	platformStatusValues,
} from "./schema.ts";

type PostgresClient = ReturnType<typeof postgres>;
const migrations = readMigrationFiles({
	migrationsFolder: resolve(
		import.meta.dirname,
		"../../../migrations/platform",
	),
});
const eventSourceMigrationIndex = 9;
const eventPersistenceTimeMigrationIndex = 10;
const builtStore: typeof import("./index.ts") = await import(
	new URL("../dist/index.mjs", import.meta.url).href
);

let databaseUrl = "";
let testDatabase: PostgresTestDatabase | undefined;

async function expectConstraintFailure(
	operation: PromiseLike<unknown>,
	constraint: string,
): Promise<void> {
	try {
		await operation;
		expect.fail(`Expected ${constraint} to reject the write`);
	} catch (error) {
		expect(error).toMatchObject({ constraint_name: constraint });
	}
}

async function readPlatformCatalog(client: PostgresClient) {
	const columns = await client`
		select table_name, column_name, ordinal_position, data_type, udt_schema,
			udt_name, is_nullable, column_default
		from information_schema.columns
		where table_schema = 'platform'
		order by table_name, ordinal_position
	`;
	const checks = await client`
		select t.relname as table_name, c.conname as constraint_name,
			pg_get_constraintdef(c.oid, true) as definition
		from pg_constraint c
		join pg_class t on t.oid = c.conrelid
		join pg_namespace n on n.oid = t.relnamespace
		where n.nspname = 'platform' and c.contype = 'c'
		order by t.relname, c.conname
	`;
	const indexes = await client`
		select tablename, indexname, indexdef
		from pg_indexes
		where schemaname = 'platform'
		order by tablename, indexname
	`;
	const enums = await client`
		select t.typname, e.enumlabel, e.enumsortorder
		from pg_type t
		join pg_enum e on e.enumtypid = t.oid
		join pg_namespace n on n.oid = t.typnamespace
		where n.nspname = 'platform'
		order by t.typname, e.enumsortorder
	`;
	return {
		columns: [...columns],
		checks: [...checks],
		indexes: [...indexes],
		enums: [...enums],
	};
}

async function applyLegacyPlatformMigrations(client: PostgresClient) {
	for (const migration of migrations.slice(0, eventSourceMigrationIndex)) {
		for (const statement of migration.sql) await client.unsafe(statement);
	}
}

beforeAll(async () => {
	testDatabase = await startPostgresTestDatabase("platform-store-migrations");
	databaseUrl = testDatabase.databaseUrl;
}, 120_000);

afterAll(async () => testDatabase?.stop());

describe("Platform PostgreSQL migration foundation", () => {
	it("accepts only the dedicated Platform database setting", () => {
		expect(
			platformDatabaseUrlFromEnvironment({
				PLATFORM_DATABASE_URL: databaseUrl,
			}),
		).toBe(databaseUrl);
		expect(() =>
			platformDatabaseUrlFromEnvironment({
				CONNECTION_DATABASE_URL: databaseUrl,
			}),
		).toThrow("PLATFORM_DATABASE_URL is required");
		expect(() =>
			platformDatabaseUrlFromEnvironment({
				PLATFORM_DATABASE_URL: "https://db",
			}),
		).toThrow("PLATFORM_DATABASE_URL must be a PostgreSQL URL");
	});

	it("upgrades the main 0023 history to application targets without rewriting it", async () => {
		const database = await startPostgresTestDatabase(
			"migration-0023-application-targets",
		);
		const client = postgres(database.databaseUrl, { max: 1 });
		try {
			await client.unsafe(`CREATE SCHEMA platform_migrations;
					CREATE TABLE platform_migrations.history
					(id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
			for (const migration of migrations.slice(0, 24)) {
				for (const statement of migration.sql) await client.unsafe(statement);
				await client`insert into platform_migrations.history (hash, created_at)
						values (${migration.hash}, ${migration.folderMillis})`;
			}
			const before = await client`
					select id, hash, created_at
					from platform_migrations.history
					order by id
				`;
			expect(before).toHaveLength(24);
			expect(
				(
					await client`
							select table_name from information_schema.tables
							where table_schema = 'platform' and table_name = 'browser_sessions'
						`
				).map((row) => row.table_name),
			).toEqual(["browser_sessions"]);

			await builtStore.migratePlatformDatabase({
				databaseUrl: database.databaseUrl,
			});

			const catalog = await readPlatformCatalog(client);
			expect(
				catalog.columns
					.filter((column) =>
						[
							"browser_sessions",
							"agent_principal_grants",
							"platform_applications",
						].includes(column.table_name),
					)
					.map((column) => column.table_name),
			).toEqual(
				expect.arrayContaining([
					"browser_sessions",
					"agent_principal_grants",
					"platform_applications",
				]),
			);
			const after = await client`
					select id, hash, created_at
					from platform_migrations.history
					order by id
				`;
			expect(after).toHaveLength(migrations.length);
			expect(after.slice(0, before.length)).toEqual(before);

			await builtStore.migratePlatformDatabase({
				databaseUrl: database.databaseUrl,
			});
			expect(
				await client`
						select id, hash, created_at
						from platform_migrations.history
						order by id
					`,
			).toEqual(after);
		} finally {
			await client.end();
			await database.stop();
		}
	}, 120_000);

	it("retains an approved Agent and its durable retry history from 0020 through 0024", async () => {
		const database = await startPostgresTestDatabase(
			"migration-0020-retained-agent",
		);
		const client = postgres(database.databaseUrl, { max: 1 });
		try {
			await client.unsafe(`CREATE SCHEMA platform_migrations;
				CREATE TABLE platform_migrations.history
				(id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
			for (const migration of migrations.slice(0, 21)) {
				for (const statement of migration.sql) await client.unsafe(statement);
				await client`insert into platform_migrations.history (hash, created_at)
					values (${migration.hash}, ${migration.folderMillis})`;
			}
			await client`insert into platform.agents (id)
				values ('retained_agent')`;
			await client`insert into platform.agent_applications
				(id, agent_id, applicant_id, name, description, trace_id,
					request_id, submitted_at)
				values ('retained_application', 'retained_agent', 'retained_owner',
					'Retained Agent', 'Existing application', 'retained_trace',
					'retained_request', now())`;
			await client`insert into platform.agent_owners
				(agent_id, owner_id, created_at)
				values ('retained_agent', 'retained_owner', now())`;
			await client`insert into platform.agent_configuration_revisions
				(agent_id, revision, source_reference, configuration, created_at)
				values ('retained_agent', 1, 'retained_source',
					${client.json({
						...agentConfigurationConformanceRecordV1,
						agentId: "retained_agent",
						revision: 1,
					} as postgres.JSONValue)},
					now())`;
			await client`insert into platform.audit_events
				(id, trace_id, request_id, agent_id, actor_type, actor_id,
					action, target_type, target_id, outcome)
				values ('retained_audit', 'retained_trace', 'retained_request',
					'retained_agent', 'user', 'retained_owner', 'agent.created',
					'agent', 'retained_agent', 'succeeded')`;
			const approvalCommand = {
				schemaVersion: 1 as const,
				command: "approve_application" as const,
				applicationId: "retained_application",
				expectedRevision: 0,
				idempotencyKey: "retained-approval",
				traceId: "retained_approval_trace",
				requestId: "retained_approval_request",
			};
			const administrator = {
				schemaVersion: 1 as const,
				userId: "retained_administrator",
				accountStatus: "active" as const,
				organizationIds: [],
				isAdministrator: true,
			};
			const transaction = new builtStore.PostgresAgentManagementTransactionV1({
				databaseUrl: database.databaseUrl,
			});
			let approvalResult: unknown;
			try {
				const decision = await createAgentManagementV1(
					transaction,
				).executeManagementCommand(approvalCommand, administrator);
				expect(decision.outcome).toBe("accepted");
				if (decision.outcome !== "accepted")
					throw new Error("Expected the legacy Web approval to be accepted");
				approvalResult = decision.result;
			} finally {
				await transaction.close();
			}

			const readRetained = async () => ({
				agents: await client`select id, current_configuration_revision
					from platform.agents where id = 'retained_agent'`,
				applications: await client`select id, agent_id, applicant_id, status,
					management_revision, approval_revision, desired_state, workload_revision,
					fence, submitted_at
					from platform.agent_applications where id = 'retained_application'`,
				owners: await client`select agent_id, owner_id, created_at
					from platform.agent_owners where agent_id = 'retained_agent'`,
				configurations:
					await client`select agent_id, revision, source_reference,
						configuration, created_at from platform.agent_configuration_revisions
					where agent_id = 'retained_agent'`,
				audits: await client`select * from platform.audit_events
					where agent_id = 'retained_agent' order by id`,
				managementHistory:
					await client`select * from platform.agent_management_history
					where agent_id = 'retained_agent' order by revision`,
				idempotency: await client`select * from platform.idempotency_records
					where scope_id = 'retained_application' order by id`,
				outbox: await client`select * from platform.outbox_items
					where scope_id = 'retained_agent' order by id`,
			});
			const before = await readRetained();
			expect(before.applications[0]).toMatchObject({
				status: "creating",
				management_revision: "1",
				approval_revision: "1",
			});
			expect(before.managementHistory).toHaveLength(1);
			expect(before.idempotency).toHaveLength(1);
			expect(before.outbox).toHaveLength(1);
			expect(before.audits).toHaveLength(2);
			const query = new builtStore.PostgresAgentManagementQueryV1({
				databaseUrl: database.databaseUrl,
			});
			let visibleBefore: Awaited<ReturnType<typeof query.getApplication>>;
			try {
				visibleBefore = await query.getApplication(
					{ kind: "applicant", applicantId: "retained_owner" },
					"retained_application",
				);
			} finally {
				await query.close();
			}
			expect(visibleBefore).toBeDefined();
			const previousHistory = await client`
				select id, hash, created_at from platform_migrations.history order by id`;
			expect(previousHistory).toHaveLength(21);

			await builtStore.migratePlatformDatabase({
				databaseUrl: database.databaseUrl,
			});
			const upgradedHistory = await client`
				select id, hash, created_at from platform_migrations.history order by id`;
			expect(upgradedHistory.slice(0, previousHistory.length)).toEqual(
				previousHistory,
			);
			expect(upgradedHistory).toHaveLength(migrations.length);
			expect(await readRetained()).toEqual(before);
			const upgradedQuery = new builtStore.PostgresAgentManagementQueryV1({
				databaseUrl: database.databaseUrl,
			});
			try {
				expect(
					await upgradedQuery.getApplication(
						{ kind: "applicant", applicantId: "retained_owner" },
						"retained_application",
					),
				).toEqual(visibleBefore);
				expect(
					await upgradedQuery.getApplication(
						{ kind: "applicant", applicantId: "other_user" },
						"retained_application",
					),
				).toBeUndefined();
			} finally {
				await upgradedQuery.close();
			}
			const upgradedTransaction =
				new builtStore.PostgresAgentManagementTransactionV1({
					databaseUrl: database.databaseUrl,
				});
			try {
				await expect(
					createAgentManagementV1(upgradedTransaction).executeManagementCommand(
						approvalCommand,
						administrator,
					),
				).resolves.toEqual({
					outcome: "replayed",
					result: approvalResult,
					writePlan: null,
				});
				expect(await readRetained()).toEqual(before);
			} finally {
				await upgradedTransaction.close();
			}
			expect(
				await client`select principal_type, principal_id, grant_type,
					authorization_revision from platform.agent_principal_grants
					where agent_id = 'retained_agent' order by grant_type`,
			).toEqual(
				["manage", "use"].map((grant_type) => ({
					principal_type: "user",
					principal_id: "retained_owner",
					grant_type,
					authorization_revision: "legacy:retained_agent",
				})),
			);
			expect(
				await client`select id from platform.platform_applications`,
			).toEqual([]);

			await builtStore.migratePlatformDatabase({
				databaseUrl: database.databaseUrl,
			});
			expect(
				await client`select id, hash, created_at
				from platform_migrations.history order by id`,
			).toEqual(upgradedHistory);
			expect(await readRetained()).toEqual(before);
		} finally {
			await client.end();
			await database.stop();
		}
	}, 120_000);

	it("preserves an applied 0024 creating/null row without approving or scheduling it", async () => {
		const database = await startPostgresTestDatabase(
			"migration-0024-creating-null",
		);
		const client = postgres(database.databaseUrl, { max: 1 });
		const workload = builtStore.openPostgresWorkloadReconciliationStoreV1({
			databaseUrl: database.databaseUrl,
		});
		try {
			await builtStore.migratePlatformDatabase({
				databaseUrl: database.databaseUrl,
			});
			await client`insert into platform.agents (id)
				values ('historical_creating')`;
			await client`insert into platform.agent_applications
				(id, agent_id, applicant_id, name, description, trace_id, request_id,
					submitted_at, status, management_revision, approval_revision,
					desired_state, workload_revision, fence)
				values ('historical_application', 'historical_creating',
					'historical_owner', 'Historical Agent', 'Controlled historical state',
					'historical_trace', 'historical_request', now(), 'creating', 1,
					null, 'running', 1, 1)`;
			await client`insert into platform.agent_owners (agent_id, owner_id, created_at)
				values ('historical_creating', 'historical_owner', now())`;
			const readState = () => client`
				select status, management_revision, approval_revision, desired_state,
					workload_revision, fence from platform.agent_applications
				where id = 'historical_application'`;
			const before = await readState();
			const history = await client`
				select id, hash, created_at from platform_migrations.history order by id`;
			await builtStore.migratePlatformDatabase({
				databaseUrl: database.databaseUrl,
			});
			expect(await readState()).toEqual(before);
			expect(before[0]?.approval_revision).toBeNull();
			expect(
				await client`select id, hash, created_at
					from platform_migrations.history order by id`,
			).toEqual(history);
			await expect(
				workload.runNext("historical-worker", async () => {
					throw new Error("Historical row must not be scheduled");
				}),
			).resolves.toBe("idle");
			expect(await readState()).toEqual(before);
			expect(
				await client`select revision from platform.agent_management_history
					where agent_id = 'historical_creating'`,
			).toEqual([]);
			expect(
				await client`select id from platform.audit_events
					where agent_id = 'historical_creating'`,
			).toEqual([]);
			expect(
				await client`select id from platform.outbox_items
					where scope_id = 'historical_creating'`,
			).toEqual([]);
		} finally {
			await workload.close();
			await client.end();
			await database.stop();
		}
	}, 120_000);

	it.each(["file-authority", "configuration-v2", "task-integrity"] as const)(
		"upgrades the existing %s migration history without losing either schema",
		async (history) => {
			const database = await startPostgresTestDatabase("migration-branches");
			const client = postgres(database.databaseUrl, { max: 1 });
			try {
				await client.unsafe(`CREATE SCHEMA platform_migrations;
					CREATE TABLE platform_migrations.history
					(id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
				const legacy =
					history === "file-authority"
						? migrations.slice(0, 14)
						: history === "configuration-v2"
							? migrations.slice(0, 15)
							: migrations.slice(0, 20);
				for (const migration of legacy) {
					for (const statement of migration.sql) await client.unsafe(statement);
					await client`insert into platform_migrations.history (hash, created_at)
						values (${migration.hash}, ${migration.folderMillis})`;
				}
				const previousHistory =
					await client`select * from platform_migrations.history order by id`;
				await builtStore.migratePlatformDatabase({
					databaseUrl: database.databaseUrl,
				});
				const upgraded = await readPlatformCatalog(client);
				expect(
					upgraded.columns.filter((column) => column.table_name === "files"),
				).not.toHaveLength(0);
				expect(
					upgraded.checks.find(
						(check) =>
							check.constraint_name === "agent_configuration_identity_matches",
					)?.definition,
				).toContain("'2'::jsonb");
				const upgradedHistory =
					await client`select * from platform_migrations.history order by id`;
				expect(upgradedHistory.slice(0, previousHistory.length)).toEqual(
					previousHistory,
				);
				expect(upgradedHistory).toHaveLength(migrations.length);
				await builtStore.migratePlatformDatabase({
					databaseUrl: database.databaseUrl,
				});
				expect(await readPlatformCatalog(client)).toEqual(upgraded);
				expect(
					await client`select * from platform_migrations.history order by id`,
				).toEqual(upgradedHistory);
			} finally {
				await client.end();
				await database.stop();
			}
		},
		120_000,
	);

	it("applies, replays, and enforces the authored infrastructure schema", async () => {
		await Promise.all([
			builtStore.migratePlatformDatabase({ databaseUrl }),
			builtStore.migratePlatformDatabase({ databaseUrl }),
		]);
		const client = postgres(databaseUrl, { max: 1 });
		try {
			const serverVersion = await client`show server_version`;
			expect(String(serverVersion[0]?.server_version ?? "")).toMatch(/^16\./);

			const migrationHistory = await client`
					select id, hash, created_at
					from platform_migrations.history
					order by id
				`;
			expect(migrationHistory).toHaveLength(migrations.length);

			const migratedColumns = await client`
					select table_name, array_agg(column_name order by ordinal_position) as columns
					from information_schema.columns
					where table_schema = 'platform'
					group by table_name
					order by table_name
				`;
			const actualTables = Object.fromEntries(
				migratedColumns.map((row) => [row.table_name, row.columns]),
			);
			const authoredTables = Object.fromEntries(
				platformInfrastructureTables.map((table) => {
					const config = getTableConfig(table);
					return [config.name, config.columns.map((column) => column.name)];
				}),
			);
			expect(actualTables).toEqual(authoredTables);

			const authoredChecks = platformInfrastructureTables
				.flatMap((table) =>
					getTableConfig(table).checks.map((check) => check.name),
				)
				.toSorted();
			expect(authoredChecks).not.toContain("agent_application_initial_status");
			const migratedChecks = await client`
					select c.conname as constraint_name
					from pg_constraint c
					join pg_class t on t.oid = c.conrelid
					join pg_namespace n on n.oid = t.relnamespace
					where n.nspname = 'platform' and c.contype = 'c'
					order by c.conname
				`;
			expect(migratedChecks.map((row) => row.constraint_name)).toEqual(
				authoredChecks,
			);

			const authoredIndexes = platformInfrastructureTables
				.flatMap((table) => {
					const config = getTableConfig(table);
					return [
						...config.indexes.map((index) => index.config.name),
						...config.uniqueConstraints.map((constraint) => constraint.name),
					];
				})
				.toSorted();
			const migratedIndexes = await client`
					select indexes.indexname
					from pg_indexes indexes
					join pg_class index_class on index_class.relname = indexes.indexname
					join pg_namespace namespace on namespace.oid = index_class.relnamespace
					join pg_index metadata on metadata.indexrelid = index_class.oid
					where indexes.schemaname = 'platform'
						and namespace.nspname = 'platform'
						and not metadata.indisprimary
					order by indexes.indexname
				`;
			expect(migratedIndexes.map((row) => row.indexname)).toEqual(
				authoredIndexes,
			);

			const authoredForeignKeys = platformInfrastructureTables
				.flatMap((table) =>
					getTableConfig(table).foreignKeys.map((foreignKey) =>
						foreignKey.getName(),
					),
				)
				.toSorted();
			const migratedForeignKeys = await client`
					select c.conname as constraint_name
					from pg_constraint c
					join pg_class t on t.oid = c.conrelid
					join pg_namespace n on n.oid = t.relnamespace
					where n.nspname = 'platform' and c.contype = 'f'
					order by c.conname
				`;
			expect(migratedForeignKeys.map((row) => row.constraint_name)).toEqual(
				authoredForeignKeys,
			);

			const migratedEnumValues = await client`
					select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as values
					from pg_type t
					join pg_enum e on e.enumtypid = t.oid
					join pg_namespace n on n.oid = t.typnamespace
					where n.nspname = 'platform'
					group by t.typname
					order by t.typname
				`;
			expect(
				Object.fromEntries(
					migratedEnumValues.map((row) => [row.typname, row.values]),
				),
			).toEqual({
				agent_availability_target_type: [
					...platformStatusValues.agentAvailabilityTargetType,
				],
				agent_desired_state: [...platformStatusValues.agentDesiredState],
				agent_failure_code: [...platformStatusValues.agentFailureCode],
				agent_management_operation: [
					...platformStatusValues.agentManagementOperation,
				],
				agent_management_status: [
					...platformStatusValues.agentManagementStatus,
				],
				agent_management_subject_type: [
					...platformStatusValues.agentManagementSubjectType,
				],
				agent_service_availability: [
					...platformStatusValues.agentServiceAvailability,
				],
				audit_outcome: [...platformStatusValues.auditOutcome],
				conversation_execution_status: [
					...platformStatusValues.conversationExecutionStatus,
				],
				conversation_message_status: [
					...platformStatusValues.conversationMessageStatus,
				],
				conversation_status: [...platformStatusValues.conversationStatus],
				conversation_stop_status: [
					...platformStatusValues.conversationStopStatus,
				],
				idempotency_status: [...platformStatusValues.idempotencyStatus],
				outbox_status: [...platformStatusValues.outboxStatus],
				secret_key_rotation_state: [
					...platformStatusValues.secretKeyRotationState,
				],
			});

			const catalogBeforeReplay = await readPlatformCatalog(client);
			await builtStore.migratePlatformDatabase({ databaseUrl });
			const catalogAfterReplay = await readPlatformCatalog(client);
			expect(catalogAfterReplay).toEqual(catalogBeforeReplay);
			const replayedHistory = await client`
					select id, hash, created_at
					from platform_migrations.history
					order by id
				`;
			expect(replayedHistory).toEqual(migrationHistory);

			const connectionObjects = await client`
					select table_schema, table_name
					from information_schema.tables
					where table_schema like 'connection%'
				`;
			expect(connectionObjects).toEqual([]);

			const auditColumns = actualTables.audit_events as string[];
			expect(auditColumns).toEqual([
				"id",
				"trace_id",
				"actor_type",
				"actor_id",
				"action",
				"target_type",
				"target_id",
				"outcome",
				"occurred_at",
				"request_id",
				"agent_id",
				"details",
			]);

			const forbiddenObjects = await client`
					select table_name as object_name
					from information_schema.tables
					where table_schema = 'platform'
					and table_name ~ '(connection|kubernetes|credential)'
					union all
				select table_name || '.' || column_name
				from information_schema.columns
				where table_schema = 'platform'
					and column_name ~ '(connection|kubernetes|credential|message_body)'
				`;
			// Platform-owned WeCom transport leases and channel ciphertext are not Connection Provider credentials.
			expect(forbiddenObjects.map((row) => row.object_name).sort()).toEqual([
				"api_credential_delivery_grants",
				"platform_api_credentials",
				"platform_api_credentials.credential_hash",
				"wecom_connections",
				"wecom_receipts.connection_bot_id",
				"wecom_receipts.connection_fence",
				"wecom_setup_sessions.encrypted_credential",
			]);

			await expectConstraintFailure(
				client`
						insert into platform.outbox_items
							(id, scope_type, scope_id, operation, payload, delivery_fence, trace_id)
						values
							('', 'agent', 'agent_01', 'reconcile', '{}', 0, 'trace_01')
					`,
				"outbox_id_non_empty",
			);
			await expectConstraintFailure(
				client`
						insert into platform.outbox_items
							(id, scope_type, scope_id, operation, payload, delivery_fence, trace_id)
						values
							('outbox_01', 'agent', 'agent_01', 'reconcile', '{}', -1, 'trace_01')
					`,
				"outbox_delivery_fence_non_negative",
			);
			await expectConstraintFailure(
				client`
						insert into platform.outbox_items
							(id, scope_type, scope_id, operation, payload, trace_id, request_id)
						values
							('outbox empty request', 'agent', 'agent_01', 'reconcile', '{}', 'trace_01', '')
					`,
				"outbox_request_id_non_empty",
			);
			await expectConstraintFailure(
				client`
						insert into platform.audit_events
							(id, trace_id, request_id, agent_id, actor_type, actor_id,
								action, target_type, target_id, outcome)
						values
							('audit empty request', 'trace_01', '', 'agent_01', 'user',
								'user_01', 'application.submit', 'agent_application',
								'application_01', 'succeeded')
					`,
				"audit_request_id_non_empty",
			);
			await expectConstraintFailure(
				client`
						insert into platform.audit_events
							(id, trace_id, request_id, agent_id, actor_type, actor_id,
								action, target_type, target_id, outcome)
						values
							('audit empty agent', 'trace_01', 'request_01', '', 'user',
								'user_01', 'application.submit', 'agent_application',
								'application_01', 'succeeded')
					`,
				"audit_agent_id_non_empty",
			);
			await expectConstraintFailure(
				client`
						insert into platform.idempotency_records
							(id, scope_type, scope_id, actor_id, command_type, idempotency_key, request_digest)
						values
							('idem_01', 'agent', 'agent_01', 'user_01', 'create', 'invalid key', ${"a".repeat(64)})
					`,
				"idempotency_key_format",
			);

			await client`
					insert into platform.agents
						(id, current_configuration_revision)
					values
						('agent revision constraints', 1)
				`;
			await expectConstraintFailure(
				client`
						insert into platform.agent_applications
							(id, agent_id, applicant_id, name, description, trace_id,
								request_id, submitted_at)
						values
							('application empty request', 'agent revision constraints',
								'user_01', 'Agent', 'Description', 'trace_01', '', now())
					`,
				"agent_application_request_id_non_empty",
			);
			await expectConstraintFailure(
				client`
						insert into platform.agent_configuration_revisions
							(agent_id, revision, source_reference, created_at)
						values
							('agent revision constraints', 0, 'source opaque', now())
					`,
				"agent_configuration_revision_number_safe",
			);
			await client`
					insert into platform.agent_configuration_revisions
						(agent_id, revision, source_reference, created_at)
					values
						('agent revision constraints', 1, 'source opaque', now())
				`;
			await expectConstraintFailure(
				client`
						insert into platform.agent_configuration_revisions
							(agent_id, revision, source_reference, created_at)
						values
							('agent revision constraints', 1, 'source duplicate', now())
					`,
				"agent_configuration_revisions_agent_id_revision_pk",
			);
			await expectConstraintFailure(
				client`
						insert into platform.agent_applications
							(id, agent_id, applicant_id, name, description, status,
								trace_id, request_id, submitted_at)
						values
							('application invalid state', 'agent revision constraints',
								'user_01', 'Agent', 'Description', 'available',
								'trace_01', 'request_01', now())
				`,
				"agent_application_management_state_valid",
			);
			await expectConstraintFailure(
				client`
						insert into platform.agent_configuration_revisions
							(agent_id, revision, source_reference, configuration, created_at)
						values
							('agent revision constraints', 2, 'source canonical',
								${client.json({
									schemaVersion: 1,
									agentId: "other_agent",
									revision: 2,
								})}, now())
				`,
				"agent_configuration_identity_matches",
			);

			const maximumRevision = Number.MAX_SAFE_INTEGER;
			await client`
					insert into platform.agents
						(id, current_configuration_revision, authorization_revision)
					values ('agent maximum revision', ${maximumRevision}, 'authorization_1')
			`;
			await client`
					insert into platform.agent_applications
						(id, agent_id, applicant_id, name, description, status,
							management_revision, approval_revision, service_availability,
							desired_state, workload_revision, fence, trace_id, request_id,
							submitted_at)
					values
						('application maximum revision', 'agent maximum revision',
							'user_01', 'Agent', 'Description', 'available',
							${maximumRevision}, ${maximumRevision}, 'ready', 'running',
							${maximumRevision}, ${maximumRevision}, 'trace_01', 'request_01',
							now())
			`;
			await client`
					insert into platform.agent_configuration_revisions
						(agent_id, revision, source_reference, configuration, created_at)
					values
						('agent maximum revision', ${maximumRevision}, 'source canonical',
							${client.json({
								schemaVersion: 1,
								agentId: "agent maximum revision",
								revision: maximumRevision,
							})}, now())
			`;
			for (const [statement, constraint] of [
				[
					"update platform.agents set current_configuration_revision = 9007199254740992 where id = 'agent maximum revision'",
					"agent_configuration_revision_safe",
				],
				[
					"update platform.agent_applications set management_revision = 9007199254740992 where id = 'application maximum revision'",
					"agent_application_management_revision_safe",
				],
				[
					"update platform.agent_applications set approval_revision = 9007199254740992 where id = 'application maximum revision'",
					"agent_application_approval_revision_safe",
				],
				[
					"update platform.agent_applications set workload_revision = 9007199254740992 where id = 'application maximum revision'",
					"agent_application_workload_revision_safe",
				],
				[
					"update platform.agent_applications set fence = 9007199254740992 where id = 'application maximum revision'",
					"agent_application_fence_safe",
				],
				[
					"insert into platform.agent_configuration_revisions (agent_id, revision, source_reference, created_at) values ('agent maximum revision', 9007199254740992, 'source overflow', now())",
					"agent_configuration_revision_number_safe",
				],
				[
					"insert into platform.agent_management_history (agent_id, revision, application_id, subject_type, subject_id, operation, from_status, to_status, occurred_at) values ('agent maximum revision', 9007199254740992, 'application maximum revision', 'agent', 'agent maximum revision', 'stop_agent', 'available', 'stopped', now())",
					"agent_management_history_revision_safe",
				],
			] as const) {
				await expectConstraintFailure(client.unsafe(statement), constraint);
			}

			await client`
					insert into platform.persisted_events
						(event_id, stream_id, sequence, stream_cursor, event_type, payload, trace_id)
					values
						('event_01', 'stream_01', 0, 0, 'started', '{}', 'trace_01')
				`;
			await expectConstraintFailure(
				client`
						insert into platform.persisted_events
							(event_id, stream_id, sequence, stream_cursor, event_type, payload, trace_id)
						values
							('event_02', 'stream_01', 1, 0, 'progress', '{}', 'trace_01')
					`,
				"persisted_event_stream_cursor_unique",
			);
		} finally {
			await client.end();
		}
	}, 120_000);

	it("requires an explicit supported task authorization boundary version", async () => {
		await builtStore.migratePlatformDatabase({ databaseUrl });
		const client = postgres(databaseUrl, { max: 1 });
		try {
			await client`
				insert into platform.conversations
					(id, agent_id, actor_id, channel_id, status, session_generation,
					 authorization_revision)
				values ('boundary-conversation', 'agent-a', 'actor-a', 'web', 'ready', 1,
					'authorization-1')
			`;
			await client`
				insert into platform.conversation_executions
					(execution_id, conversation_id, agent_id, actor_id, channel_id,
					 turn_id, status, session_generation, authorization_revision, created_at)
				values ('boundary-execution', 'boundary-conversation', 'agent-a', 'actor-a',
					'web', 'boundary-turn', 'completed', 1, 'authorization-1', now())
			`;
			await client`
				insert into platform.task_authorization_records (id, execution_id, boundary)
				values ('boundary-authorization', 'boundary-execution',
					${client.json({ schemaVersion: 1 })})
			`;
			for (const boundary of [
				{},
				{ schemaVersion: null },
				{ schemaVersion: 2 },
				{ schemaVersion: "1" },
				"1",
				1,
				true,
				[],
				[{ schemaVersion: 1 }],
			]) {
				await expectConstraintFailure(
					client`
						update platform.task_authorization_records set boundary = ${client.json(boundary)}
						where id = 'boundary-authorization'
					`,
					"task_authorization_boundary_version",
				);
			}
			await expectConstraintFailure(
				client`
					update platform.task_authorization_records set boundary = 'null'::jsonb
					where id = 'boundary-authorization'
				`,
				"task_authorization_boundary_version",
			);
			expect(
				await client`
				select boundary from platform.task_authorization_records
				where id = 'boundary-authorization'
			`,
			).toEqual([{ boundary: { schemaVersion: 1 } }]);
		} finally {
			await client.end();
		}
	});

	it("keeps task controls and generation tombstones bound to the original execution", async () => {
		await builtStore.migratePlatformDatabase({ databaseUrl });
		const client = postgres(databaseUrl, { max: 1 });
		try {
			for (const suffix of ["a", "b"]) {
				await client`
					insert into platform.conversations
						(id, agent_id, actor_id, channel_id, status, session_generation,
						 authorization_revision)
					values (${`integrity-conversation-${suffix}`}, ${`agent-${suffix}`},
						${`actor-${suffix}`}, 'web', 'ready', 1, 'authorization-1')
				`;
				await client`
					insert into platform.conversation_executions
						(execution_id, conversation_id, agent_id, actor_id, channel_id,
						 turn_id, status, session_generation, authorization_revision, created_at)
					values (${`integrity-execution-${suffix}`},
						${`integrity-conversation-${suffix}`}, ${`agent-${suffix}`},
						${`actor-${suffix}`}, 'web', ${`turn-${suffix}`}, 'completed', 1,
						'authorization-1', now())
				`;
				await client`
					insert into platform.task_authorization_records (id, execution_id, boundary)
					values (${`integrity-authorization-${suffix}`},
						${`integrity-execution-${suffix}`}, ${client.json({ schemaVersion: 1 })})
				`;
				await client`
					insert into platform.task_control_records
						(id, execution_id, authorization_record_id, reason)
					values (${`integrity-control-${suffix}`}, ${`integrity-execution-${suffix}`},
						${`integrity-authorization-${suffix}`}, 'generation_isolation')
				`;
			}
			const originalControls = await client`
				select id, execution_id, authorization_record_id
				from platform.task_control_records
				where id in ('integrity-control-a', 'integrity-control-b') order by id
			`;
			expect(originalControls).toHaveLength(2);
			await expectConstraintFailure(
				client`
					update platform.task_control_records
					set authorization_record_id = 'integrity-authorization-b'
					where id = 'integrity-control-a'
				`,
				"task_control_authorization_execution_fk",
			);
			expect(
				await client`
					select id, execution_id, authorization_record_id
					from platform.task_control_records
					where id in ('integrity-control-a', 'integrity-control-b') order by id
				`,
			).toEqual(originalControls);

			await client`
				insert into platform.conversation_generation_tombstones
					(operation_id, conversation_id, session_generation, execution_id, item_id,
					 control_record_id, control_source_id, original_principal, host_session_ref,
					 failure_code)
				values ('integrity-isolation-a', 'integrity-conversation-a', 1,
					'integrity-execution-a', 'integrity-outbox-a', 'integrity-control-a',
					'integrity-source-a', ${client.json({ kind: "user", id: "actor-a" })},
					'integrity-host-a', 'RUNTIME_SESSION_RECOVERY_FAILED')
			`;
			const originalTombstone = await client`
				select * from platform.conversation_generation_tombstones
				where operation_id = 'integrity-isolation-a'
			`;
			expect(originalTombstone).toHaveLength(1);
			await expectConstraintFailure(
				client`
					update platform.conversation_generation_tombstones
					set control_record_id = 'integrity-control-b'
					where operation_id = 'integrity-isolation-a'
				`,
				"conversation_generation_control_execution_fk",
			);
			await expectConstraintFailure(
				client`
					update platform.conversation_generation_tombstones
					set conversation_id = 'integrity-conversation-b'
					where operation_id = 'integrity-isolation-a'
				`,
				"conversation_generation_execution_binding_fk",
			);
			await expectConstraintFailure(
				client`
					update platform.conversation_generation_tombstones
					set session_generation = 2
					where operation_id = 'integrity-isolation-a'
				`,
				"conversation_generation_execution_binding_fk",
			);
			expect(
				await client`
					select * from platform.conversation_generation_tombstones
					where operation_id = 'integrity-isolation-a'
				`,
			).toEqual(originalTombstone);
		} finally {
			await client.end();
		}
	});

	it("upgrades legacy events with source binding and persistence time", async () => {
		const upgradeDatabase = await startPostgresTestDatabase(
			"conversation-event-source-upgrade",
		);
		const upgradeClient = postgres(upgradeDatabase.databaseUrl, { max: 1 });
		try {
			await applyLegacyPlatformMigrations(upgradeClient);
			await upgradeClient`
				insert into platform.conversations
					(id, agent_id, actor_id, channel_id, status, session_generation,
					 authorization_revision)
				values
					('conversation_upgrade', 'agent_upgrade', 'actor_upgrade', 'web',
					 'active', 1, 'authorization_upgrade')
			`;
			await upgradeClient`
				insert into platform.conversation_executions
					(execution_id, conversation_id, agent_id, actor_id, channel_id, turn_id,
					 status, session_generation, authorization_revision, created_at)
				values
					('execution_upgrade', 'conversation_upgrade', 'agent_upgrade',
					 'actor_upgrade', 'web', 'turn_upgrade', 'completed', 1,
					 'authorization_upgrade', '2026-09-04T00:00:00.000Z'),
					('execution_decoy', 'conversation_upgrade', 'agent_decoy', 'actor_decoy',
					 'web', 'turn_decoy', 'completed', 1, 'authorization_decoy',
					 '2026-09-04T00:00:00.000Z')
			`;
			await upgradeClient`
				insert into platform.conversation_events
					(event_id, conversation_id, execution_id, adapter_event_key, sequence,
					 conversation_cursor, event_type, event_payload, event_digest,
					 runtime_cursor, occurred_at)
				values
					('event_upgrade', 'conversation_upgrade', 'execution_upgrade',
					 'adapter_upgrade', 1, 1, 'text.delta',
					 ${upgradeClient.json({ type: "text.delta", text: "legacy" })},
					 ${"0".repeat(64)}, 'runtime_upgrade',
					 '2026-09-04T00:00:00.000Z')
			`;
			await upgradeClient`
				insert into platform.conversation_audit_events
					(id, conversation_id, execution_id, agent_id, actor_id, action,
					 trace_id, request_id, occurred_at, details)
				values
					('audit_command_upgrade', 'conversation_upgrade', 'execution_upgrade',
						 'agent_upgrade', 'actor_upgrade', 'conversation.message.accepted',
						 'trace_upgrade', 'request_upgrade',
						 '2026-09-04T00:00:00.000Z', null),
					('audit_command_upgrade_duplicate', 'conversation_upgrade',
						 'execution_upgrade', 'agent_upgrade', 'actor_upgrade',
						 'conversation.message.accepted', 'trace_upgrade', 'request_upgrade',
						 '2026-09-04T00:00:00.000Z', null),
					('audit_command_decoy', 'conversation_upgrade', 'execution_decoy',
					 'agent_decoy', 'actor_decoy', 'conversation.message.accepted',
					 'trace_upgrade', 'request_upgrade',
					 '2026-09-04T00:00:00.000Z', null),
					('audit_fallback_upgrade', 'conversation_upgrade', null,
					 'agent_upgrade', 'actor_upgrade',
					 'conversation.model_selection.fell_back', 'trace_upgrade',
					 'request_upgrade', '2026-09-04T00:00:00.000Z',
					 ${upgradeClient.json({
							previousModelOptionId: "model_removed",
							previousReasoningLevel: "high",
							modelConfigurationRevision: 2,
							modelOptionId: "model_primary",
							reasoningLevel: "medium",
						})})
			`;

			const sourceMigration = migrations[eventSourceMigrationIndex];
			if (!sourceMigration) throw new Error("Expected source migration");
			for (const statement of sourceMigration.sql) {
				await upgradeClient.unsafe(statement);
			}
			const persistenceMigration =
				migrations[eventPersistenceTimeMigrationIndex];
			if (!persistenceMigration) {
				throw new Error("Expected event persistence-time migration");
			}
			for (const statement of persistenceMigration.sql) {
				await upgradeClient.unsafe(statement);
			}

			expect(
				await upgradeClient`
					select source, runtime_cursor, persisted_at > occurred_at as persisted_later
					from platform.conversation_events
					where event_id = 'event_upgrade'
				`,
			).toEqual([
				{
					source: "runtime",
					runtime_cursor: "runtime_upgrade",
					persisted_later: true,
				},
			]);
			expect(
				await upgradeClient`
					select execution_id, agent_id, actor_id
					from platform.conversation_audit_events
					where id = 'audit_fallback_upgrade'
				`,
			).toEqual([
				{
					execution_id: "execution_upgrade",
					agent_id: "agent_upgrade",
					actor_id: "actor_upgrade",
				},
			]);
		} finally {
			await upgradeClient.end();
			await upgradeDatabase.stop();
		}
	}, 120_000);

	it("rolls back 0009 when a legacy fallback audit has no unique binding", async () => {
		const upgradeDatabase = await startPostgresTestDatabase(
			"conversation-event-source-upgrade-rejection",
		);
		const upgradeClient = postgres(upgradeDatabase.databaseUrl, { max: 1 });
		try {
			await applyLegacyPlatformMigrations(upgradeClient);
			await upgradeClient`
				insert into platform.conversations
					(id, agent_id, actor_id, channel_id, status, session_generation,
					 authorization_revision)
				values
					('conversation_unbound', 'agent_unbound', 'actor_unbound', 'web',
					 'ready', 1, 'authorization_unbound')
			`;
			await upgradeClient`
				insert into platform.conversation_executions
					(execution_id, conversation_id, agent_id, actor_id, channel_id, turn_id,
					 status, session_generation, authorization_revision, created_at)
				values
					('execution_unbound_a', 'conversation_unbound', 'agent_unbound',
						 'actor_unbound', 'web', 'turn_unbound_a', 'completed', 1,
						 'authorization_unbound', '2026-09-04T00:00:00.000Z'),
					('execution_unbound_b', 'conversation_unbound', 'agent_unbound',
						 'actor_unbound', 'web', 'turn_unbound_b', 'completed', 1,
						 'authorization_unbound', '2026-09-04T00:00:00.000Z')
			`;
			await upgradeClient`
				insert into platform.conversation_audit_events
					(id, conversation_id, execution_id, agent_id, actor_id, action,
					 trace_id, request_id, occurred_at, details)
				values
					('audit_command_unbound_a', 'conversation_unbound',
						 'execution_unbound_a', 'agent_unbound', 'actor_unbound',
						 'conversation.message.accepted', 'trace_unbound', 'request_unbound',
						 '2026-09-04T00:00:00.000Z', null),
					('audit_command_unbound_b', 'conversation_unbound',
						 'execution_unbound_b', 'agent_unbound', 'actor_unbound',
						 'conversation.message.accepted', 'trace_unbound', 'request_unbound',
						 '2026-09-04T00:00:00.000Z', null),
					('audit_fallback_unbound', 'conversation_unbound', null,
					 'agent_unbound', 'actor_unbound',
					 'conversation.model_selection.fell_back', 'trace_unbound',
					 'request_unbound', '2026-09-04T00:00:00.000Z',
					 ${upgradeClient.json({
							previousModelOptionId: "model_removed",
							previousReasoningLevel: "high",
							modelConfigurationRevision: 2,
							modelOptionId: "model_primary",
							reasoningLevel: "medium",
						})})
			`;
			const sourceMigration = migrations[eventSourceMigrationIndex];
			if (!sourceMigration) throw new Error("Expected source migration");
			await expect(
				upgradeClient.begin(async (transaction) => {
					for (const statement of sourceMigration.sql) {
						await transaction.unsafe(statement);
					}
				}),
			).rejects.toThrow("cannot uniquely bind 1 legacy model fallback audit");
			expect(
				await upgradeClient`
					select count(*)::int as count from information_schema.columns
					where table_schema = 'platform'
						and table_name = 'conversation_events' and column_name = 'source'
				`,
			).toEqual([{ count: 0 }]);
			expect(
				await upgradeClient`
					select execution_id from platform.conversation_audit_events
					where id = 'audit_fallback_unbound'
				`,
			).toEqual([{ execution_id: null }]);
		} finally {
			await upgradeClient.end();
			await upgradeDatabase.stop();
		}
	}, 120_000);
});

const retained = JSON.parse(
	await readFile(
		new URL("../test/fixtures/task28-source-checkpoint.json", import.meta.url),
		"utf8",
	),
) as {
	sourceTail: {
		idx: number;
		when: number;
		tag: string;
		sqlSHA256: string;
	}[];
};

// These SQL files are the immutable frozen migration source, not a deployment
// export. Publication into a temporary journal is confined to this test DB.
describe("approved Platform migration gaps", () => {
	let client: PostgresClient;
	let folder: string;
	let published29Folder: string;
	let journal: {
		entries: {
			idx: number;
			when: number;
			tag: string;
			version: string;
			breakpoints: boolean;
		}[];
	};
	const history = () =>
		client`select id, hash, created_at from platform_migrations.history order by id`;
	const records = async () => ({
		disables: [
			...(await client`select to_jsonb(t)::text as record from platform.platform_user_disables t order by user_id`),
		],
		conversations: [
			...(await client`select to_jsonb(t)::text as record from platform.conversations t order by id`),
		],
		executions: [
			...(await client`select to_jsonb(t)::text as record from platform.conversation_executions t order by execution_id`),
		],
		events: [
			...(await client`select to_jsonb(t)::text as record from platform.conversation_events t order by event_id`),
		],
		idempotency: [
			...(await client`select to_jsonb(t)::text as record from platform.idempotency_records t order by id`),
		],
	});

	async function publish(indices: number[]) {
		for (const source of retained.sourceTail.filter((row) =>
			indices.includes(row.idx),
		)) {
			const sql = await readFile(
				new URL(`../test/fixtures/${source.tag}.sql`, import.meta.url),
				"utf8",
			);
			expect(createHash("sha256").update(sql).digest("hex")).toBe(
				source.sqlSHA256,
			);
			await writeFile(resolve(folder, `${source.tag}.sql`), sql);
			journal.entries.push({
				idx: source.idx,
				when: source.when,
				tag: source.tag,
				version: "7",
				breakpoints: true,
			});
		}
		journal.entries.sort((a, b) => a.idx - b.idx);
		await writeFile(
			resolve(folder, "meta/_journal.json"),
			JSON.stringify(journal),
		);
	}

	async function seedConversation() {
		await client`insert into platform.conversations
			(id, agent_id, actor_id, channel_id, status, session_generation,
				host_session_ref, authorization_revision, last_conversation_cursor)
			values ('gap-conversation', 'gap-agent', 'gap-actor', 'web', 'ready', 3,
				'original-gap-session', 'gap-revision', 1)`;
		await client`insert into platform.conversation_executions
			(execution_id, conversation_id, agent_id, actor_id, channel_id,
				turn_id, status, session_generation, delivery_fence, authorization_revision,
				last_event_sequence, last_runtime_cursor, created_at)
			values ('gap-execution', 'gap-conversation', 'gap-agent', 'gap-actor',
				'web', 'gap-turn', 'completed', 3, 5, 'gap-revision', 1,
				'original-gap-runtime-cursor', now())`;
		await client`insert into platform.conversation_events
			(event_id, conversation_id, execution_id, adapter_event_key, sequence,
				conversation_cursor, event_type, event_payload, event_digest,
				source, runtime_cursor, occurred_at, persisted_at)
			values ('gap-event', 'gap-conversation', 'gap-execution', 'gap-adapter-event',
				1, 1, 'text.delta', '{"type":"text.delta","text":"controlled-gap-event"}'::jsonb,
				${"b".repeat(64)}, 'runtime', 'original-gap-runtime-cursor',
				'2026-09-30T00:00:00.123456Z', '2026-09-30T00:00:00.234567Z')`;
		await client`insert into platform.idempotency_records
			(id, scope_type, scope_id, actor_id, command_type, idempotency_key,
				request_digest, status, result)
			values ('gap-retry', 'conversation', 'gap-conversation', 'gap-actor',
				'message', 'gap-key', ${"a".repeat(64)}, 'completed',
				'{"executionId":"gap-execution"}'::jsonb)`;
	}

	beforeEach(async () => {
		client = postgres(databaseUrl, { max: 1 });
		// This file's isolated test database is never the retained acceptance PG.
		await client`drop schema if exists platform cascade`;
		await client`drop schema if exists platform_migrations cascade`;
		folder = await mkdtemp(resolve(tmpdir(), "agent-infra-approved-gap-"));
		await cp(
			resolve(import.meta.dirname, "../../../migrations/platform"),
			folder,
			{
				recursive: true,
			},
		);
		journal = JSON.parse(
			await readFile(resolve(folder, "meta/_journal.json"), "utf8"),
		);
		// Preserve this suite's actual29 publication scenario after default adds30.
		journal.entries = journal.entries.filter((row) => row.idx <= 29);
		await writeFile(
			resolve(folder, "meta/_journal.json"),
			JSON.stringify(journal),
		);
		published29Folder = await mkdtemp(
			resolve(tmpdir(), "agent-infra-published29-"),
		);
		await cp(folder, published29Folder, { recursive: true });
		expect(journal.entries.at(-1)?.idx).toBe(29);
		await builtStore.migratePlatformDatabase({
			databaseUrl,
			migrationsFolder: published29Folder,
		});
		await client`insert into platform.platform_user_disables (user_id, disabled_at)
			values ('gap-disabled', '2026-09-30T01:00:00Z')`;
		await seedConversation();
	});

	afterEach(async () => {
		await client?.end();
		if (folder) await rm(folder, { recursive: true, force: true });
		if (published29Folder)
			await rm(published29Folder, { recursive: true, force: true });
	});

	it("executes published original25/27 below actual29 once and preserves all existing records", async () => {
		const before = await history();
		const data = await records();
		await publish([25, 27]);
		await builtStore.migratePlatformDatabase({
			databaseUrl,
			migrationsFolder: folder,
		});
		const after = await history();
		expect(after.slice(0, before.length)).toEqual(before);
		expect(after.slice(before.length)).toEqual(
			retained.sourceTail
				.filter((row) => [25, 27].includes(row.idx))
				.map((row) =>
					expect.objectContaining({
						hash: row.sqlSHA256,
						created_at: String(row.when),
					}),
				),
		);
		expect(
			await client`select to_regclass('platform.relay_key_versions') as relation`,
		).toEqual([{ relation: "platform.relay_key_versions" }]);
		expect(
			await client`select column_name from information_schema.columns
			where table_schema='platform' and table_name='platform_api_credentials'
				and column_name='recipient_user_id'`,
		).toHaveLength(1);
		expect(await records()).toEqual(data);
		await builtStore.migratePlatformDatabase({
			databaseUrl,
			migrationsFolder: folder,
		});
		expect(await history()).toEqual(after);
		expect(await records()).toEqual(data);
	});

	it("serializes two migration runners on the same database", async () => {
		await publish([25, 27]);
		const before = await history();
		const data = await records();
		await Promise.all([
			builtStore.migratePlatformDatabase({
				databaseUrl,
				migrationsFolder: folder,
			}),
			builtStore.migratePlatformDatabase({
				databaseUrl,
				migrationsFolder: folder,
			}),
		]);
		expect(await history()).toHaveLength(before.length + 2);
		expect(await records()).toEqual(data);
	});

	it("recognizes previously executed historical identities without publishing absent SQL", async () => {
		const before = await history();
		const data = await records();
		await builtStore.migratePlatformDatabase({
			databaseUrl,
			migrationsFolder: published29Folder,
		});
		expect(await history()).toEqual(before);
		expect(await records()).toEqual(data);
		expect(
			await client`select to_regclass('platform.relay_key_versions') as relation`,
		).toEqual([{ relation: null }]);
		await publish([25, 27]);
		await builtStore.migratePlatformDatabase({
			databaseUrl,
			migrationsFolder: folder,
		});
		const applied = await history();
		await builtStore.migratePlatformDatabase({
			databaseUrl,
			migrationsFolder: published29Folder,
		});
		expect(await history()).toEqual(applied);
		expect(await records()).toEqual(data);
	});

	it.each(["unknown", "changed", "duplicate", "early_hole"] as const)(
		"rejects %s history before any missing DDL runs",
		async (fault) => {
			await publish([25]);
			if (fault === "unknown") {
				await client`insert into platform_migrations.history (hash, created_at)
					values (${"f".repeat(64)}, 1790792430788)`;
			} else if (fault === "changed") {
				await client`update platform_migrations.history set hash=${"f".repeat(64)}
					where created_at=${migrations[24]?.folderMillis ?? 0}`;
			} else if (fault === "duplicate") {
				await client`insert into platform_migrations.history (hash, created_at)
					select hash, created_at from platform_migrations.history order by id desc limit 1`;
			} else {
				await client`delete from platform_migrations.history
					where created_at=${migrations[20]?.folderMillis ?? 0}`;
			}
			const before = await history();
			const catalog = await readPlatformCatalog(client);
			const data = await records();
			await expect(
				builtStore.migratePlatformDatabase({
					databaseUrl,
					migrationsFolder: folder,
				}),
			).rejects.toThrow("Platform migration failed");
			expect(await history()).toEqual(before);
			expect(await readPlatformCatalog(client)).toEqual(catalog);
			expect(await records()).toEqual(data);
		},
	);

	it.each(["hash", "when"] as const)(
		"rejects changed historical source %s",
		async (fault) => {
			await publish([25]);
			if (fault === "hash") {
				await writeFile(
					resolve(folder, "0025_credential_delivery_approval.sql"),
					"select 'private-migration-sentinel';",
				);
			} else {
				const entry = journal.entries.find((row) => row.idx === 25);
				if (!entry) throw new Error("Missing controlled source");
				entry.when = 1790792430788;
				await writeFile(
					resolve(folder, "meta/_journal.json"),
					JSON.stringify(journal),
				);
			}
			const before = await history();
			const catalog = await readPlatformCatalog(client);
			const data = await records();
			await expect(
				builtStore.migratePlatformDatabase({
					databaseUrl,
					migrationsFolder: folder,
				}),
			).rejects.toThrow("Platform migration failed");
			expect(await history()).toEqual(before);
			expect(await readPlatformCatalog(client)).toEqual(catalog);
			expect(await records()).toEqual(data);
		},
	);

	it("rolls back all missing DDL when original26 conflicts with actual29", async () => {
		await publish([25, 26]);
		const before = await history();
		const catalog = await readPlatformCatalog(client);
		const data = await records();
		await expect(
			builtStore.migratePlatformDatabase({
				databaseUrl,
				migrationsFolder: folder,
			}),
		).rejects.toThrow("Platform migration failed");
		expect(await history()).toEqual(before);
		expect(await readPlatformCatalog(client)).toEqual(catalog);
		expect(await records()).toEqual(data);
	});

	it.each(["sql", "history"] as const)(
		"rolls back a %s failure after earlier missing DDL",
		async (fault) => {
			await publish([25]);
			if (fault === "sql") {
				journal.entries.push({
					idx: 30,
					when: 1790792430788,
					tag: "0030_controlled_failure",
					version: "7",
					breakpoints: true,
				});
				await writeFile(
					resolve(folder, "0030_controlled_failure.sql"),
					"select 1 / 0;",
				);
				await writeFile(
					resolve(folder, "meta/_journal.json"),
					JSON.stringify(journal),
				);
			} else {
				await client.unsafe(`create function platform_migrations.reject_gap_history()
				returns trigger language plpgsql as $$ begin
				if NEW.created_at = 1790724094107 then
					raise exception 'private-migration-sentinel'; end if; return NEW; end $$;
				create trigger reject_gap_history before insert on platform_migrations.history
				for each row execute function platform_migrations.reject_gap_history()`);
			}
			const before = await history();
			const catalog = await readPlatformCatalog(client);
			const data = await records();
			await expect(
				builtStore.migratePlatformDatabase({
					databaseUrl,
					migrationsFolder: folder,
				}),
			).rejects.toThrow(/^Platform migration failed$/);
			expect(await history()).toEqual(before);
			expect(await readPlatformCatalog(client)).toEqual(catalog);
			expect(await records()).toEqual(data);
		},
	);

	it("upgrades an actually executed original Task28 source and preserves its history", async () => {
		await client`drop schema platform cascade`;
		await client`drop schema platform_migrations cascade`;
		journal.entries = journal.entries.filter((row) => row.idx < 29);
		await publish([25, 26, 27, 28]);
		await builtStore.migratePlatformDatabase({
			databaseUrl,
			migrationsFolder: folder,
		});
		await client`insert into platform.platform_user_disables (user_id, disabled_by)
			values ('gap-legacy-disabled', 'gap-legacy-admin')`;
		await seedConversation();
		const before = await history();
		const data = await records();
		expect(before).toHaveLength(29);
		await builtStore.migratePlatformDatabase({
			databaseUrl,
			migrationsFolder: published29Folder,
		});
		const after = await history();
		expect(after.slice(0, before.length)).toEqual(before);
		expect(after).toHaveLength(30);
		expect(await records()).toEqual(data);
		await builtStore.migratePlatformDatabase({
			databaseUrl,
			migrationsFolder: published29Folder,
		});
		expect(await history()).toEqual(after);
		expect(await records()).toEqual(data);
	});
});

describe("published Relay authority migration", () => {
	let client: PostgresClient;
	let folder: string;
	let journal: {
		entries: {
			idx: number;
			when: number;
			tag: string;
			version: string;
			breakpoints: boolean;
		}[];
	};
	const sourceFolder = resolve(
		import.meta.dirname,
		"../../../migrations/platform",
	);
	const compiledFolder = resolve(import.meta.dirname, "../dist/migrations");
	const relayWhen = 1790844089732;
	const history = () =>
		client`select id, hash, created_at from platform_migrations.history order by id`;

	async function writeJournal() {
		journal.entries.sort((a, b) => a.idx - b.idx);
		await writeFile(
			resolve(folder, "meta/_journal.json"),
			JSON.stringify(journal),
		);
	}

	// Original SQL is really executed by the production consumer. No manual
	// history or synthetic post-state DDL establishes a historical checkpoint.
	async function prepareHistory(kind: "current29" | "original27" | "task28") {
		journal.entries = journal.entries.filter((row) =>
			kind === "current29" ? row.idx <= 29 : row.idx <= 24,
		);
		if (kind !== "current29") {
			for (const source of retained.sourceTail.filter(
				(row) => row.idx <= (kind === "original27" ? 27 : 28),
			)) {
				const sql = await readFile(
					new URL(`../test/fixtures/${source.tag}.sql`, import.meta.url),
				);
				expect(createHash("sha256").update(sql).digest("hex")).toBe(
					source.sqlSHA256,
				);
				await writeFile(resolve(folder, `${source.tag}.sql`), sql);
				journal.entries.push({
					idx: source.idx,
					when: source.when,
					tag: source.tag,
					version: "7",
					breakpoints: true,
				});
			}
		}
		await writeJournal();
		await builtStore.migratePlatformDatabase({
			databaseUrl,
			migrationsFolder: folder,
		});
	}

	async function seedOriginalRecords(hasTask28: boolean) {
		await client`insert into platform.relay_key_subjects
			(purpose, subject_id, last_version, current_version, updated_at)
			values ('personal', 'relay-migration-user', 2, 2, '2026-09-30T00:00:00.123456Z')`;
		for (const version of [1, 2]) {
			const keyId = `relay-migration-key-${version}`;
			await client`insert into platform.relay_key_versions
				(purpose, subject_id, key_version, key_id, ciphertext, created_at)
				values ('personal', 'relay-migration-user', ${version}, ${keyId},
					${client.json({ purpose: "personal", subjectId: "relay-migration-user", keyVersion: version, keyId, encryptedPayload: `controlled-ciphertext-${version}` })},
					'2026-09-30T00:00:00.234567Z')`;
		}
		await client`insert into platform.conversations
			(id, agent_id, actor_id, channel_id, status, session_generation, authorization_revision)
			values ('relay-migration-conversation', 'relay-migration-agent', 'relay-migration-user', 'web', 'ready', 3, 'original-relay-revision')`;
		await client`insert into platform.conversation_executions
			(execution_id, conversation_id, agent_id, actor_id, channel_id,
				turn_id, status, session_generation, delivery_fence, authorization_revision, created_at)
			values ('relay-migration-execution', 'relay-migration-conversation', 'relay-migration-agent',
				'relay-migration-user', 'web', 'relay-migration-turn', 'completed', 3, 7,
				'original-relay-revision', '2026-09-30T00:00:00.345678Z')`;
		if (hasTask28) {
			await client`update platform.conversation_executions set
				execution_source = 'web', relay_key_purpose = 'personal',
				relay_key_subject_id = 'relay-migration-user', relay_key_id = 'relay-migration-key-1', relay_key_version = 1
				where execution_id = 'relay-migration-execution'`;
		}
	}

	async function records(includeExecutionDeltaFields = true) {
		const project = async (
			table: string,
			order: string,
			keys: readonly string[],
		) => {
			const rows = await client.unsafe(
				`select to_jsonb(t)::text as record from ${table} t order by ${order}`,
			);
			return rows.map(({ record }) => {
				const value = JSON.parse(record) as Record<string, unknown>;
				return JSON.stringify(
					Object.fromEntries(
						keys.filter((key) => key in value).map((key) => [key, value[key]]),
					),
				);
			});
		};
		return {
			subjects: await project(
				"platform.relay_key_subjects",
				"purpose, subject_id",
				[
					"purpose",
					"subject_id",
					"last_version",
					"current_version",
					"updated_at",
				],
			),
			versions: await project(
				"platform.relay_key_versions",
				"purpose, subject_id, key_version",
				[
					"purpose",
					"subject_id",
					"key_version",
					"key_id",
					"ciphertext",
					"created_at",
				],
			),
			conversations: await project("platform.conversations", "id", [
				"id",
				"agent_id",
				"actor_id",
				"channel_id",
				"status",
				"session_generation",
				"authorization_revision",
			]),
			executions: await project(
				"platform.conversation_executions",
				"execution_id",
				[
					"execution_id",
					"conversation_id",
					"agent_id",
					"actor_id",
					"channel_id",
					"turn_id",
					"status",
					"session_generation",
					"delivery_fence",
					"authorization_revision",
					"created_at",
					...(includeExecutionDeltaFields
						? [
								"execution_source",
								"relay_key_purpose",
								"relay_key_subject_id",
								"relay_key_id",
								"relay_key_version",
							]
						: []),
				],
			),
		};
	}

	function schemaDelta(
		before: Awaited<ReturnType<typeof relayCatalog>>,
		after: Awaited<ReturnType<typeof relayCatalog>>,
	) {
		const byKey = (
			rows: readonly Record<string, unknown>[],
			keys: readonly string[],
		) =>
			new Map(
				rows.map((row) => [
					keys.map((key) => String(row[key])).join(":"),
					JSON.stringify(row),
				]),
			);
		const changed = (
			rowsBefore: readonly Record<string, unknown>[],
			rowsAfter: readonly Record<string, unknown>[],
			keys: readonly string[],
		) => {
			const previous = byKey(rowsBefore, keys);
			return rowsAfter
				.filter(
					(row) =>
						previous.get(keys.map((key) => String(row[key])).join(":")) !==
						JSON.stringify(row),
				)
				.map((row) => keys.map((key) => String(row[key])).join(":"))
				.sort();
		};
		return {
			columns: changed(before.catalog.columns, after.catalog.columns, [
				"table_name",
				"column_name",
			]),
			checks: changed(before.catalog.checks, after.catalog.checks, [
				"table_name",
				"constraint_name",
			]),
			indexes: changed(before.catalog.indexes, after.catalog.indexes, [
				"tablename",
				"indexname",
			]),
			enums: changed(before.catalog.enums, after.catalog.enums, [
				"typname",
				"enumlabel",
			]),
		};
	}

	async function relayCatalog() {
		return {
			catalog: await readPlatformCatalog(client),
			relations: [
				...(await client`select oid, relname, relkind, relpersistence, relrowsecurity, relforcerowsecurity
				from pg_class where oid in (to_regclass('platform.relay_key_subjects'), to_regclass('platform.relay_key_versions')) order by relname`),
			],
			constraints: [
				...(await client`select t.relname, c.conname, c.convalidated, c.condeferrable, c.condeferred,
				pg_get_constraintdef(c.oid, true) as definition
				from pg_constraint c join pg_class t on t.oid = c.conrelid
				where c.conrelid in (to_regclass('platform.relay_key_subjects'), to_regclass('platform.relay_key_versions'))
					or c.confrelid in (to_regclass('platform.relay_key_subjects'), to_regclass('platform.relay_key_versions'))
				order by t.relname, c.conname`),
			],
		};
	}

	beforeEach(async () => {
		client = postgres(databaseUrl, { max: 1 });
		await client`drop schema if exists platform cascade`;
		await client`drop schema if exists platform_migrations cascade`;
		folder = await mkdtemp(resolve(tmpdir(), "agent-infra-relay-migration-"));
		await cp(sourceFolder, folder, { recursive: true });
		journal = JSON.parse(
			await readFile(resolve(folder, "meta/_journal.json"), "utf8"),
		);
	});

	afterEach(async () => {
		await client?.end();
		if (folder) await rm(folder, { recursive: true, force: true });
	});

	it("publishes the same new authority and immutable history in source and compiled artifacts", async () => {
		expect(journal.entries.map((row) => row.idx)).toEqual([
			...Array.from({ length: 25 }, (_, idx) => idx),
			29,
			30,
			31,
			32,
			33,
			34,
			35,
			36,
		]);
		expect(journal.entries.at(-1)).toMatchObject({
			idx: 36,
			tag: "0036_browser_session_principal",
		});
		const sourceJournal = await readFile(
			resolve(sourceFolder, "meta/_journal.json"),
		);
		expect(
			await readFile(resolve(compiledFolder, "meta/_journal.json")),
		).toEqual(sourceJournal);
		for (const entry of journal.entries) {
			expect(
				await readFile(resolve(compiledFolder, `${entry.tag}.sql`)),
			).toEqual(await readFile(resolve(sourceFolder, `${entry.tag}.sql`)));
		}
		expect(
			await readFile(resolve(compiledFolder, "meta/0030_snapshot.json")),
		).toEqual(await readFile(resolve(sourceFolder, "meta/0030_snapshot.json")));
		await migratePlatformDatabase({ databaseUrl });
		const before = await history();
		const catalog = await relayCatalog();
		await builtStore.migratePlatformDatabase({ databaseUrl });
		expect(await history()).toEqual(before);
		expect(await relayCatalog()).toEqual(catalog);
		expect(catalog.relations.map((row) => row.relname)).toEqual([
			"relay_key_subjects",
			"relay_key_versions",
		]);
		expect(before).toHaveLength(migrations.length);
	});

	it("upgrades actual29 without Relay, then repeats with no history or catalog drift", async () => {
		await prepareHistory("current29");
		const before = await history();
		expect(
			await client`select to_regclass('platform.relay_key_versions') as relation`,
		).toEqual([{ relation: null }]);
		await builtStore.migratePlatformDatabase({ databaseUrl });
		const after = await history();
		expect(after.slice(0, before.length)).toEqual(before);
		expect(after.slice(before.length)).toEqual(
			migrations
				.filter((migration) => migration.folderMillis >= relayWhen)
				.map((migration) =>
					expect.objectContaining({
						created_at: String(migration.folderMillis),
						hash: migration.hash,
					}),
				),
		);
		const catalog = await relayCatalog();
		await seedOriginalRecords(false);
		const data = await records();
		await builtStore.migratePlatformDatabase({ databaseUrl });
		expect(await history()).toEqual(after);
		expect(await relayCatalog()).toEqual(catalog);
		expect(await records()).toEqual(data);
	});

	it.each(["original27", "task28"] as const)(
		"keeps actually executed %s SQL/history, ciphertext, current pointer and original Execution reference",
		async (kind) => {
			await prepareHistory(kind);
			const originalHistory = await history();
			expect(originalHistory).toHaveLength(kind === "original27" ? 28 : 29);
			await seedOriginalRecords(kind === "task28");
			const data = await records(kind !== "original27");
			// First consume only the already-published29 compatibility migration.
			journal = JSON.parse(
				await readFile(resolve(sourceFolder, "meta/_journal.json"), "utf8"),
			);
			journal.entries = journal.entries.filter((row) => row.idx <= 29);
			await writeJournal();
			await builtStore.migratePlatformDatabase({
				databaseUrl,
				migrationsFolder: folder,
			});
			const before = await history();
			expect(before.slice(0, originalHistory.length)).toEqual(originalHistory);
			expect(await records(kind !== "original27")).toEqual(data);
			const catalog = await relayCatalog();
			await builtStore.migratePlatformDatabase({ databaseUrl });
			const after = await history();
			expect(after.slice(0, before.length)).toEqual(before);
				expect(after).toHaveLength(before.length + 7);
			expect(after.slice(before.length)).toEqual(
				migrations
					.filter((migration) => migration.folderMillis >= relayWhen)
					.map((migration) =>
						expect.objectContaining({
							created_at: String(migration.folderMillis),
							hash: migration.hash,
						}),
					),
			);
			const afterCatalog = await relayCatalog();
			expect(schemaDelta(catalog, afterCatalog)).toEqual({
				columns:
					kind === "original27"
						? [
								"browser_sessions:principal",
								"conversation_executions:execution_source",
								"conversation_executions:original_operation_digest",
								"conversation_executions:original_submit_host_session_ref",
								"conversation_executions:principal_type",
								"conversation_executions:relay_key_id",
								"conversation_executions:relay_key_purpose",
								"conversation_executions:relay_key_subject_id",
								"conversation_executions:relay_key_version",
								"conversation_executions:runtime_submit_protocol",
								"conversation_executions:task_wait_deadline",
								"conversation_executions:task_wait_order",
								"conversations:principal_type",
							]
						: [
								"browser_sessions:principal",
								"conversation_executions:principal_type",
								"conversations:principal_type",
							],
				checks:
					kind === "original27"
						? [
								"conversation_events:conversation_event_source_binding",
								"conversation_executions:conversation_execution_key_binding",
								"conversation_executions:conversation_execution_original_digest_binding",
								"conversation_executions:conversation_execution_principal_type_valid",
								"conversation_executions:conversation_execution_task_wait_binding",
								"conversation_generation_tombstones:conversation_generation_tombstone_principal_valid",
								"conversations:conversation_principal_type_valid",
							]
						: [
								"conversation_executions:conversation_execution_original_digest_binding",
								"conversation_executions:conversation_execution_principal_type_valid",
								"conversation_executions:conversation_execution_task_wait_binding",
								"conversation_generation_tombstones:conversation_generation_tombstone_principal_valid",
								"conversations:conversation_principal_type_valid",
							],
				indexes:
					kind === "original27"
						? [
								"conversation_executions:conversation_execution_agent_wait_idx",
								"conversation_executions:conversation_execution_task_wait_order_unique",
								"conversations:conversation_principal_binding_unique",
							]
						: ["conversations:conversation_principal_binding_unique"],
				enums:
					kind === "original27"
						? ["conversation_execution_status:waiting"]
						: [],
			});
			expect(await records(kind !== "original27")).toEqual(data);
			await builtStore.migratePlatformDatabase({ databaseUrl });
			expect(await history()).toEqual(after);
			expect(await relayCatalog()).toEqual(afterCatalog);
			expect(await records(kind !== "original27")).toEqual(data);
		},
	);

	it("serializes concurrent default source and compiled consumers into one Relay publication", async () => {
		await prepareHistory("current29");
		const before = await history();
		await Promise.all([
			migratePlatformDatabase({ databaseUrl }),
			builtStore.migratePlatformDatabase({ databaseUrl }),
		]);
		const after = await history();
		expect(after.slice(0, before.length)).toEqual(before);
		expect(after).toHaveLength(before.length + 7);
		const catalog = await relayCatalog();
		await builtStore.migratePlatformDatabase({ databaseUrl });
		expect(await history()).toEqual(after);
		expect(await relayCatalog()).toEqual(catalog);
	});

	it.each(["original27", "task28"] as const)(
		"rejects lost Relay tables after actual %s history instead of recreating authority",
		async (kind) => {
			await prepareHistory(kind);
			await seedOriginalRecords(kind === "task28");
			await client`drop table platform.relay_key_versions cascade`;
			await client`drop table platform.relay_key_subjects cascade`;
			const before = await history();
			const catalog = await relayCatalog();
			const execution =
				await client`select to_jsonb(t)::text as record from platform.conversation_executions t`;
			await expect(
				builtStore.migratePlatformDatabase({ databaseUrl }),
			).rejects.toThrow(/^Platform migration failed$/);
			expect(await history()).toEqual(before);
			expect(await relayCatalog()).toEqual(catalog);
			expect(
				await client`select to_jsonb(t)::text as record from platform.conversation_executions t`,
			).toEqual(execution);
			expect(
				await client`select to_regclass('platform.relay_key_subjects') as subjects, to_regclass('platform.relay_key_versions') as versions`,
			).toEqual([{ subjects: null, versions: null }]);
			expect(
				await client`select id from platform_migrations.history where created_at = ${relayWhen}`,
			).toHaveLength(0);
		},
	);

	it.each([
		"partial",
		"unregistered",
		"wrong-column",
		"missing-check",
		"missing-index",
		"unvalidated-fk",
	] as const)(
		"rejects %s authority without changing history, catalog or original rows",
		async (fault) => {
			await prepareHistory(fault === "partial" ? "current29" : "original27");
			if (fault === "partial") {
				await client`create table platform.relay_key_subjects (purpose text, subject_id text)`;
			} else {
				await seedOriginalRecords(false);
				if (fault === "unregistered") {
					await client`delete from platform_migrations.history where created_at = 1790738152673`;
				} else if (fault === "wrong-column") {
					await client`alter table platform.relay_key_subjects alter column last_version set default 1`;
				} else if (fault === "missing-check") {
					await client`alter table platform.relay_key_versions drop constraint relay_key_version_ciphertext_binding`;
				} else if (fault === "missing-index") {
					await client`drop index platform.relay_key_version_key_id_unique`;
				} else {
					await client`alter table platform.relay_key_versions drop constraint relay_key_version_subject_fk`;
					await client`alter table platform.relay_key_versions add constraint relay_key_version_subject_fk
						foreign key (purpose, subject_id) references platform.relay_key_subjects (purpose, subject_id) not valid`;
				}
			}
			const before = await history();
			const catalog = await relayCatalog();
			const data = fault === "partial" ? null : await records();
			await expect(
				builtStore.migratePlatformDatabase({ databaseUrl }),
			).rejects.toThrow(/^Platform migration failed$/);
			expect(await history()).toEqual(before);
			expect(await relayCatalog()).toEqual(catalog);
			if (data) expect(await records()).toEqual(data);
		},
	);

	it.each(["unknown", "changed", "duplicate"] as const)(
		"rejects %s history before creating Relay authority",
		async (fault) => {
			await prepareHistory("current29");
			if (fault === "unknown") {
				await client`insert into platform_migrations.history (hash, created_at) values (${"f".repeat(64)}, ${relayWhen - 1})`;
			} else if (fault === "changed") {
				await client`update platform_migrations.history set hash = ${"f".repeat(64)} where created_at = ${migrations[24]?.folderMillis ?? 0}`;
			} else {
				await client`insert into platform_migrations.history (hash, created_at)
					select hash, created_at from platform_migrations.history order by id desc limit 1`;
			}
			const before = await history();
			const catalog = await relayCatalog();
			await expect(
				builtStore.migratePlatformDatabase({ databaseUrl }),
			).rejects.toThrow(/^Platform migration failed$/);
			expect(await history()).toEqual(before);
			expect(await relayCatalog()).toEqual(catalog);
		},
	);

	it.each(["immediate-history", "deferred-history", "later-sql"] as const)(
		"rolls back both new Relay tables and history on %s failure",
		async (fault) => {
			await prepareHistory("current29");
			if (fault === "later-sql") {
				journal = JSON.parse(
					await readFile(resolve(sourceFolder, "meta/_journal.json"), "utf8"),
				);
				journal.entries.push({
					idx: 31,
					when: relayWhen + 1,
					tag: "0031_controlled_failure",
					version: "7",
					breakpoints: true,
				});
				await writeFile(
					resolve(folder, "0031_controlled_failure.sql"),
					"select 1 / 0;",
				);
				await writeJournal();
			} else {
				await client.unsafe(`create function platform_migrations.reject_relay_history() returns trigger
					language plpgsql as $$ begin if NEW.created_at = ${relayWhen} then
						raise exception 'controlled-relay-history-failure'; end if; return NEW; end $$`);
				await client.unsafe(
					fault === "deferred-history"
						? "create constraint trigger reject_relay_history after insert on platform_migrations.history deferrable initially deferred for each row execute function platform_migrations.reject_relay_history()"
						: "create trigger reject_relay_history before insert on platform_migrations.history for each row execute function platform_migrations.reject_relay_history()",
				);
			}
			const before = await history();
			const catalog = await relayCatalog();
			await expect(
				builtStore.migratePlatformDatabase({
					databaseUrl,
					...(fault === "later-sql" ? { migrationsFolder: folder } : {}),
				}),
			).rejects.toThrow(/^Platform migration failed$/);
			expect(await history()).toEqual(before);
			expect(await relayCatalog()).toEqual(catalog);
		},
	);
});
