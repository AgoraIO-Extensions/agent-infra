import { resolve } from "node:path";

import { readMigrationFiles } from "drizzle-orm/migrator";
import { getTableConfig } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { platformDatabaseUrlFromEnvironment } from "./migrate.ts";
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
	for (const migration of migrations.slice(0, -2)) {
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
				.flatMap((table) =>
					getTableConfig(table).indexes.map((index) => index.config.name),
				)
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
			expect(forbiddenObjects).toEqual([]);

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

			const sourceMigration = migrations.at(-2);
			if (!sourceMigration) throw new Error("Expected source migration");
			for (const statement of sourceMigration.sql) {
				await upgradeClient.unsafe(statement);
			}
			const persistenceMigration = migrations.at(-1);
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
			const sourceMigration = migrations.at(-2);
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
