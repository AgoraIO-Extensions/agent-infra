import {
	type ActionCallRecord,
	type ActionCallRequest,
	actionCallNamespaceKey,
	actionRequestDigest,
	authorizeActionCall,
	consumerActorSentinel,
	reserveActionCall,
} from "@agent-infra/connection-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConnectionDatabase } from "./database.js";
import { migrateConnectionDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";
import {
	createCatalogReader,
	createConnectionAuthorityRepository,
} from "./repository.js";

let testDatabase: PostgresTestDatabase | undefined;
let client: ReturnType<typeof postgres> | undefined;

beforeAll(async () => {
	testDatabase = await startPostgresTestDatabase("connection-store-migrations");
	client = postgres(testDatabase.databaseUrl);
}, 120_000);

afterAll(async () => {
	await client?.end();
	await testDatabase?.stop();
});

describe("Connection PostgreSQL migration", () => {
	it("creates the authority schema from zero and is idempotent", async () => {
		const database = testDatabase;
		const databaseClient = client;
		if (!database || !databaseClient)
			throw new Error("PostgreSQL test database was not initialized");
		await migrateConnectionDatabase(database.databaseUrl);
		await migrateConnectionDatabase(database.databaseUrl);

		const tables = await databaseClient`
			select table_name
			from information_schema.tables
			where table_schema = 'connection'
			order by table_name
		`;
		expect(tables.map((row) => row.table_name)).toEqual([
			"access_tokens",
			"action_calls",
			"action_versions",
			"actors",
			"audit_events",
			"authorization_codes",
			"browser_sessions",
			"connections",
			"consumer_instances",
			"consumers",
			"credential_versions",
			"dispatches",
			"dpop_replay",
			"effects",
			"grant_actions",
			"grants",
			"principals",
			"providers",
			"refresh_tokens",
		]);

		const [grantIndex] = await databaseClient`
			select indexdef
			from pg_indexes
			where schemaname = 'connection' and indexname = 'grants_current_binding_unique'
		`;
		expect(grantIndex?.indexdef).toContain(
			"WHERE ((status)::text = 'active'::text)",
		);

		const [history] = await databaseClient`
			select count(*)::int as count
			from connection_migrations.history
		`;
		expect(history?.count).toBe(1);
	});

	it("resolves only the server-side grant binding and keeps calls idempotent", async () => {
		const database = testDatabase;
		const databaseClient = client;
		if (!database || !databaseClient)
			throw new Error("PostgreSQL test database was not initialized");
		await databaseClient`insert into connection.principals (id, issuer, uid) values ('principal-a', 'ldap', 'alice'), ('principal-b', 'ldap', 'bob')`;
		await databaseClient`insert into connection.consumers (id, name) values ('consumer-a', 'Consumer A')`;
		await databaseClient`insert into connection.consumer_instances (id, consumer_id, principal_id, installation_key) values
			('instance-a', 'consumer-a', 'principal-a', 'install-a'), ('instance-b', 'consumer-a', 'principal-b', 'install-b')`;
		await databaseClient`insert into connection.actors (id, consumer_instance_id) values ('actor-a', 'instance-a'), ('actor-b', 'instance-b')`;
		await databaseClient`insert into connection.providers (id, name) values ('provider-a', 'Provider A')`;
		await databaseClient`insert into connection.action_versions (id, provider_id, action_id, version, effect, input_schema, output_schema, required_scopes)
			values ('action-a-v1', 'provider-a', 'action-a', 'v1', 'read', '{}', '{}', '["action:read"]')`;
		await databaseClient`insert into connection.connections (id, provider_id, external_account_id) values ('connection-a', 'provider-a', 'account-a')`;
		await databaseClient`insert into connection.credential_versions (id, connection_id, version, ciphertext) values ('credential-a-v1', 'connection-a', 1, 'ciphertext')`;
		await databaseClient`update connection.connections set current_credential_version_id = 'credential-a-v1' where id = 'connection-a'`;
		await databaseClient`insert into connection.grants (id, principal_id, consumer_id, consumer_instance_id, actor_id, connection_id, credential_version_id, principal_recovery_generation)
			values ('grant-a', 'principal-a', 'consumer-a', 'instance-a', 'actor-a', 'connection-a', 'credential-a-v1', 1)`;
		await databaseClient`insert into connection.grant_actions (grant_id, action_version_id) values ('grant-a', 'action-a-v1')`;
		await databaseClient`insert into connection.grants (id, principal_id, consumer_id, consumer_instance_id, actor_id, connection_id, credential_version_id, principal_recovery_generation)
			values ('grant-consumer', 'principal-a', 'consumer-a', 'instance-a', ${consumerActorSentinel}, 'connection-a', 'credential-a-v1', 1)`;
		await databaseClient`insert into connection.grant_actions (grant_id, action_version_id) values ('grant-consumer', 'action-a-v1')`;

		const handle = createConnectionDatabase(database.databaseUrl);
		try {
			const repository = createConnectionAuthorityRepository(handle.db);
			const catalog = createCatalogReader(handle.db);
			expect(
				await catalog.list({
					principalId: "principal-a",
					consumerId: "consumer-a",
					consumerInstanceId: "instance-a",
					actorId: "actor-a",
					audience: "connection-mcp",
					scopes: [],
					recoveryGeneration: 1,
					tokenId: "token-a",
				}),
			).toEqual([]);
			expect(
				await catalog.list({
					principalId: "principal-a",
					consumerId: "consumer-a",
					consumerInstanceId: "instance-a",
					actorId: "actor-a",
					audience: "connection-mcp",
					scopes: ["action:read"],
					recoveryGeneration: 1,
					tokenId: "token-a",
				}),
			).toHaveLength(1);
			const request: ActionCallRequest = {
				requestId: "request-store-1",
				idempotencyKey: "store-key-1",
				principalId: "principal-a",
				consumerId: "consumer-a",
				consumerInstanceId: "instance-a",
				actorId: "actor-a",
				grantId: "grant-a",
				connectionId: "connection-a",
				actionVersionId: "action-a-v1",
				arguments: { repositoryId: 7 },
			};
			const resolved = await authorizeActionCall(repository, request, 1);
			expect(resolved.id).toBe("grant-a");
			await expect(
				authorizeActionCall(
					repository,
					{
						...request,
						principalId: "principal-b",
						actorId: "actor-b",
						consumerInstanceId: "instance-b",
					},
					1,
				),
			).rejects.toThrow("Connection authorization denied");
			await expect(
				authorizeActionCall(
					repository,
					{ ...request, consumerInstanceId: "instance-b" },
					1,
				),
			).rejects.toThrow("Connection authorization denied");

			const namespaceKey = actionCallNamespaceKey(request);
			const record: ActionCallRecord = {
				id: "call-store-1",
				requestId: request.requestId,
				callId: "call-ref-store-1",
				idempotencyKey: request.idempotencyKey,
				namespaceKey,
				principalId: request.principalId,
				consumerId: request.consumerId,
				consumerInstanceId: request.consumerInstanceId,
				actorId: "actor-a",
				grantId: request.grantId,
				connectionId: request.connectionId,
				credentialVersionId: "credential-a-v1",
				actionVersionId: request.actionVersionId,
				requestDigest: actionRequestDigest(request),
				status: "created",
			};
			expect(
				(await reserveActionCall(repository, record, request, resolved)).id,
			).toBe(record.id);
			expect(
				(
					await reserveActionCall(
						repository,
						{ ...record, id: "call-store-replay" },
						request,
						resolved,
					)
				).id,
			).toBe(record.id);

			const consumerRequest: ActionCallRequest = {
				...request,
				requestId: "request-store-consumer",
				idempotencyKey: "store-key-consumer",
				actorId: null,
				grantId: "grant-consumer",
			};
			const consumerGrant = await authorizeActionCall(
				repository,
				consumerRequest,
				1,
			);
			expect(consumerGrant.id).toBe("grant-consumer");
			const consumerRecord: ActionCallRecord = {
				...record,
				id: "call-store-consumer",
				requestId: consumerRequest.requestId,
				callId: "call-ref-store-consumer",
				idempotencyKey: consumerRequest.idempotencyKey,
				namespaceKey: actionCallNamespaceKey(consumerRequest),
				actorId: consumerActorSentinel,
				grantId: consumerRequest.grantId,
				requestDigest: actionRequestDigest(consumerRequest),
			};
			expect(
				(
					await reserveActionCall(
						repository,
						consumerRecord,
						consumerRequest,
						consumerGrant,
					)
				).id,
			).toBe(consumerRecord.id);
		} finally {
			await handle.close();
		}
	});
});
