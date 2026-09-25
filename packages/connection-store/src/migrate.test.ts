import { randomUUID } from "node:crypto";
import {
	ActionCallIdempotencyConflict,
	type ActionCallRecord,
	type ActionCallRequest,
	actionCallNamespaceKey,
	actionRequestDigest,
	authorizeActionCall,
	type ConnectionAuditEvent,
	consumerActorSentinel,
	type DispatchRecord,
	type EffectRecord,
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
	createAuditEventStore,
	createConnectionAuthorityRepository,
} from "./repository.js";

let testDatabase: PostgresTestDatabase | undefined;
let client: ReturnType<typeof postgres> | undefined;

function stateAudit(
	call: ActionCallRecord,
	phase: string,
): ConnectionAuditEvent {
	return {
		id: randomUUID(),
		traceId: call.traceId,
		principalId: call.principalId,
		consumerInstanceId: call.consumerInstanceId,
		actorId: call.actorId === consumerActorSentinel ? undefined : call.actorId,
		action: `mcp.${phase}`,
		targetType: "action_call",
		targetId: call.id,
		outcome: "succeeded",
		metadata: { phase },
	};
}

beforeAll(async () => {
	testDatabase = await startPostgresTestDatabase("connection-store-migrations");
	client = postgres(testDatabase.databaseUrl);
}, 120_000);

afterAll(async () => {
	await client?.end();
	await testDatabase?.stop();
}, 120_000);

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
			"action_calls",
			"action_versions",
			"actors",
			"audit_events",
			"connections",
			"consumer_instances",
			"consumers",
			"credential_versions",
			"current_grant_actions",
			"dispatches",
			"effects",
			"grant_actions",
			"grants",
			"principals",
			"provider_releases",
			"providers",
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
		expect(history?.count).toBe(5);
	});

	it("resolves only the server-side grant binding and keeps calls idempotent", async () => {
		const database = testDatabase;
		const databaseClient = client;
		if (!database || !databaseClient)
			throw new Error("PostgreSQL test database was not initialized");
		await databaseClient`insert into connection.principals (id, issuer, uid) values ('principal-a', 'ldap', 'alice'), ('principal-b', 'ldap', 'bob')`;
		await databaseClient`insert into connection.consumers (id, name, actor_required) values
			('consumer-a', 'Consumer A', true), ('consumer-b', 'Consumer B', true), ('consumer-consumer', 'Consumer without Actors', false)`;
		await databaseClient`insert into connection.consumer_instances (id, consumer_id, principal_id, installation_key) values
			('instance-a', 'consumer-a', 'principal-a', 'install-a'),
			('instance-b', 'consumer-a', 'principal-b', 'install-b'),
			('instance-other-consumer', 'consumer-b', 'principal-a', 'install-other-consumer'),
			('instance-consumer', 'consumer-consumer', 'principal-a', 'install-consumer')`;
		await databaseClient`insert into connection.actors (id, consumer_instance_id) values ('actor-a', 'instance-a'), ('actor-b', 'instance-b'), ('actor-other-consumer', 'instance-other-consumer')`;
		await expect(
			databaseClient`insert into connection.actors (id, consumer_instance_id) values ('actor-consumer', 'instance-consumer')`,
		).rejects.toThrow();
		await databaseClient`insert into connection.providers (id, name) values ('provider-a', 'Provider A')`;
		await databaseClient`insert into connection.provider_releases (id, provider_id, version)
			values ('release-a-v1', 'provider-a', 'v1')`;
		await databaseClient`insert into connection.action_versions (id, provider_id, provider_release_id, action_id, version, effect, input_schema, output_schema, required_scopes, status)
			values ('action-a-v1', 'provider-a', 'release-a-v1', 'action-a', 'v1', 'read', '{}', '{}', '["action:read"]', 'published')`;
		await databaseClient`insert into connection.action_versions (id, provider_id, provider_release_id, action_id, version, effect, input_schema, output_schema, required_scopes, status)
			values ('action-write-v1', 'provider-a', 'release-a-v1', 'action-write', 'v1', 'write', '{}', '{}', '["action:write"]', 'published')`;
		await databaseClient`insert into connection.connections (id, provider_id, external_account_id) values ('connection-a', 'provider-a', 'account-a')`;
		await databaseClient`insert into connection.credential_versions (id, connection_id, version, ciphertext) values ('credential-a-v1', 'connection-a', 1, 'ciphertext')`;
		await databaseClient`update connection.connections set current_credential_version_id = 'credential-a-v1' where id = 'connection-a'`;
		await databaseClient`insert into connection.connections (id, provider_id, external_account_id) values ('connection-bob', 'provider-a', 'account-bob')`;
		await databaseClient`insert into connection.credential_versions (id, connection_id, version, ciphertext) values ('credential-bob-v1', 'connection-bob', 1, 'ciphertext-bob')`;
		await databaseClient`update connection.connections set current_credential_version_id = 'credential-bob-v1' where id = 'connection-bob'`;
		await expect(
			databaseClient`update connection.connections set current_credential_version_id = 'credential-bob-v1' where id = 'connection-a'`,
		).rejects.toThrow();
		// Give seeded Grants a clear start time across host and PostgreSQL clocks.
		await expect(
			databaseClient`insert into connection.grants (id, principal_id, consumer_id, consumer_instance_id, actor_id, connection_id, credential_version_id, approved_action_version_ids, principal_recovery_generation, consumer_instance_recovery_generation, created_at, expires_at)
				values ('grant-future-instance', 'principal-b', 'consumer-a', 'instance-b', 'actor-b', 'connection-bob', 'credential-bob-v1', ARRAY['action-a-v1'], 1, 2, now() - interval '1 minute', now() + interval '1 hour')`,
		).rejects.toThrow("Grant recovery generation is not current");
		await databaseClient`insert into connection.grants (id, principal_id, consumer_id, consumer_instance_id, actor_id, connection_id, credential_version_id, approved_action_version_ids, principal_recovery_generation, consumer_instance_recovery_generation, created_at, expires_at)
			values ('grant-a', 'principal-a', 'consumer-a', 'instance-a', 'actor-a', 'connection-a', 'credential-a-v1', ARRAY['action-a-v1', 'action-write-v1'], 1, 1, now() - interval '1 minute', now() + interval '1 hour')`;
		await expect(
			databaseClient`insert into connection.grants (id, principal_id, consumer_id, consumer_instance_id, actor_id, connection_id, credential_version_id, approved_action_version_ids, principal_recovery_generation, consumer_instance_recovery_generation, created_at, expires_at)
			values ('grant-invalid-sentinel', 'principal-a', 'consumer-a', 'instance-a', ${consumerActorSentinel}, 'connection-a', 'credential-a-v1', ARRAY['action-a-v1'], 1, 1, now() - interval '1 minute', now() + interval '1 hour')`,
		).rejects.toThrow();
		await databaseClient`insert into connection.grants (id, principal_id, consumer_id, consumer_instance_id, actor_id, connection_id, credential_version_id, approved_action_version_ids, principal_recovery_generation, consumer_instance_recovery_generation, created_at, expires_at)
			values ('grant-consumer', 'principal-a', 'consumer-consumer', 'instance-consumer', ${consumerActorSentinel}, 'connection-a', 'credential-a-v1', ARRAY['action-a-v1'], 1, 1, now() - interval '1 minute', now() + interval '1 hour')`;
		await databaseClient`insert into connection.grants (id, principal_id, consumer_id, consumer_instance_id, actor_id, connection_id, credential_version_id, approved_action_version_ids, principal_recovery_generation, consumer_instance_recovery_generation, created_at, expires_at)
			values ('grant-expired', 'principal-b', 'consumer-a', 'instance-b', 'actor-b', 'connection-a', 'credential-a-v1', ARRAY['action-write-v1'], 1, 1, now() - interval '2 hours', now() - interval '1 hour')`;
		await databaseClient`insert into connection.grants (id, principal_id, consumer_id, consumer_instance_id, actor_id, connection_id, credential_version_id, approved_action_version_ids, principal_recovery_generation, consumer_instance_recovery_generation, created_at, expires_at)
			values ('grant-bob', 'principal-b', 'consumer-a', 'instance-b', 'actor-b', 'connection-bob', 'credential-bob-v1', ARRAY['action-a-v1'], 1, 1, now() - interval '1 minute', now() + interval '1 hour')`;
		await databaseClient`insert into connection.grants (id, principal_id, consumer_id, consumer_instance_id, actor_id, connection_id, credential_version_id, approved_action_version_ids, principal_recovery_generation, consumer_instance_recovery_generation, created_at, expires_at)
			values ('grant-other-consumer', 'principal-a', 'consumer-b', 'instance-other-consumer', 'actor-other-consumer', 'connection-a', 'credential-a-v1', ARRAY['action-a-v1'], 1, 1, now() - interval '1 minute', now() + interval '1 hour')`;

		const handle = createConnectionDatabase(database.databaseUrl);
		try {
			const repository = createConnectionAuthorityRepository(handle.db);
			const audit = createAuditEventStore(handle.db);
			const [release] =
				await databaseClient`select status from connection.provider_releases where id = 'release-a-v1'`;
			expect(release?.status).toBe("disabled");
			await expect(
				databaseClient`update connection.provider_releases set version = 'v2' where id = 'release-a-v1'`,
			).rejects.toThrow();
			await expect(
				databaseClient`update connection.action_versions set effect = 'write' where id = 'action-a-v1'`,
			).rejects.toThrow();
			await expect(
				databaseClient`update connection.action_versions set input_schema = '{"type":"object"}' where id = 'action-a-v1'`,
			).rejects.toThrow();
			await databaseClient`update connection.provider_releases set status = 'active' where id = 'release-a-v1'`;
			await expect(
				databaseClient`update connection.grants set approved_action_version_ids = ARRAY['action-a-v1', 'action-write-v1'] where id = 'grant-consumer'`,
			).rejects.toThrow();
			await expect(
				databaseClient`update connection.grants set revision = revision + 1 where id = 'grant-consumer'`,
			).rejects.toThrow();
			await expect(
				databaseClient`update connection.grants set consumer_instance_recovery_generation = 2 where id = 'grant-consumer'`,
			).rejects.toThrow();
			await expect(
				databaseClient`update connection.grants set expires_at = expires_at + interval '1 hour' where id = 'grant-consumer'`,
			).rejects.toThrow();
			await expect(
				databaseClient`update connection.consumers set actor_required = true where id = 'consumer-consumer'`,
			).rejects.toThrow();
			await expect(
				databaseClient`insert into connection.grant_actions (grant_id, action_version_id) values ('grant-consumer', 'action-write-v1')`,
			).rejects.toThrow();
			await expect(
				databaseClient`delete from connection.grant_actions where grant_id = 'grant-consumer'`,
			).rejects.toThrow();
			await expect(
				databaseClient`delete from connection.current_grant_actions where grant_id = 'grant-consumer'`,
			).rejects.toThrow();
			await audit.insert({
				id: "audit-store-1",
				traceId: "trace-store-1",
				principalId: "principal-a",
				consumerInstanceId: "instance-a",
				actorId: "actor-a",
				action: "mcp.request",
				targetType: "action_version",
				targetId: "action-a-v1",
				outcome: "succeeded",
				metadata: { requestId: "request-store-audit" },
			});
			const [auditRow] = await databaseClient`
				select trace_id, principal_id, consumer_instance_id, actor_id, action, target_id, outcome, metadata
				from connection.audit_events
				where id = 'audit-store-1'
			`;
			expect(auditRow).toMatchObject({
				trace_id: "trace-store-1",
				principal_id: "principal-a",
				consumer_instance_id: "instance-a",
				actor_id: "actor-a",
				action: "mcp.request",
				target_id: "action-a-v1",
				outcome: "succeeded",
				metadata: { requestId: "request-store-audit" },
			});
			const request: ActionCallRequest = {
				requestId: "request-store-1",
				idempotencyKey: "store-key-1",
				principalId: "principal-a",
				consumerId: "consumer-a",
				consumerInstanceId: "instance-a",
				actorId: "actor-a",
				actionVersionId: "action-a-v1",
				arguments: { repositoryId: 7 },
			};
			const resolved = await authorizeActionCall(repository, request, 1);
			expect(resolved.id).toBe("grant-a");
			const bobRequest = {
				...request,
				principalId: "principal-b",
				actorId: "actor-b",
				consumerInstanceId: "instance-b",
			};
			expect((await authorizeActionCall(repository, bobRequest, 1)).id).toBe(
				"grant-bob",
			);
			expect(
				(
					await authorizeActionCall(
						repository,
						{
							...request,
							consumerId: "consumer-b",
							consumerInstanceId: "instance-other-consumer",
							actorId: "actor-other-consumer",
						},
						1,
					)
				).id,
			).toBe("grant-other-consumer");
			await expect(
				authorizeActionCall(
					repository,
					{ ...bobRequest, actionVersionId: "action-write-v1" },
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
			for (const crossBinding of [
				{ consumerId: "consumer-b" },
				{ actorId: "actor-b" },
				{ actorId: "actor-other-consumer" },
				{ principalId: "principal-b" },
			]) {
				await expect(
					authorizeActionCall(repository, { ...request, ...crossBinding }, 1),
				).rejects.toThrow("Connection authorization denied");
			}
			for (const selector of [
				{ connectionId: "connection-bob" },
				{ credentialVersionId: "credential-bob-v1" },
				{ grantId: "grant-bob" },
				{ revision: 1 },
			]) {
				await expect(
					authorizeActionCall(repository, { ...request, ...selector }, 1),
				).rejects.toThrow("Connection authorization denied");
			}

			const namespaceKey = actionCallNamespaceKey(request);
			const record: ActionCallRecord = {
				id: "call-store-1",
				requestId: request.requestId,
				traceId: "trace-store-1",
				callId: "call-ref-store-1",
				idempotencyKey: request.idempotencyKey,
				namespaceKey,
				principalId: request.principalId,
				consumerId: request.consumerId,
				consumerInstanceId: request.consumerInstanceId,
				actorId: "actor-a",
				grantId: resolved.id,
				connectionId: resolved.connectionId,
				credentialVersionId: "credential-a-v1",
				actionVersionId: request.actionVersionId,
				requestDigest: actionRequestDigest({
					...request,
					connectionId: resolved.connectionId,
				}),
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
			const sameKeyRecord = {
				...record,
				id: "call-store-same-key",
				callId: "call-ref-store-same-key",
			};
			await expect(
				repository.insert(
					sameKeyRecord,
					stateAudit(sameKeyRecord, "same-key"),
					resolved,
				),
			).rejects.toBeInstanceOf(ActionCallIdempotencyConflict);
			await expect(
				repository.insert(
					{
						...record,
						requestId: "request-store-duplicate-id",
						callId: "call-ref-store-duplicate-id",
						idempotencyKey: "store-key-duplicate-id",
					},
					stateAudit(record, "duplicate-id"),
					resolved,
				),
			).rejects.not.toBeInstanceOf(ActionCallIdempotencyConflict);

			const consumerRequest: ActionCallRequest = {
				...request,
				requestId: "request-store-consumer",
				idempotencyKey: "store-key-consumer",
				consumerId: "consumer-consumer",
				consumerInstanceId: "instance-consumer",
				actorId: null,
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
				traceId: "trace-consumer",
				callId: "call-ref-store-consumer",
				idempotencyKey: consumerRequest.idempotencyKey,
				namespaceKey: actionCallNamespaceKey(consumerRequest),
				consumerId: consumerRequest.consumerId,
				consumerInstanceId: consumerRequest.consumerInstanceId,
				actorId: consumerActorSentinel,
				grantId: consumerGrant.id,
				requestDigest: actionRequestDigest({
					...consumerRequest,
					connectionId: consumerGrant.connectionId,
				}),
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

			const executionCall: ActionCallRecord = {
				...record,
				id: "call-store-execution",
				requestId: "request-store-execution",
				traceId: "trace-store-execution",
				callId: "call-ref-store-execution",
				idempotencyKey: "store-key-execution",
				namespaceKey: actionCallNamespaceKey(request),
				actionVersionId: "action-write-v1",
				requestDigest: actionRequestDigest({
					...request,
					connectionId: resolved.connectionId,
					actionVersionId: "action-write-v1",
				}),
			};
			const dispatch: DispatchRecord = {
				id: "dispatch-store-execution",
				actionCallId: executionCall.id,
				status: "pending",
				attemptCount: 0,
				leaseOwner: null,
				leaseExpiresAt: null,
			};
			const effect: EffectRecord = {
				id: "effect-store-execution",
				actionCallId: executionCall.id,
				status: "planned",
				providerRequestKey: "provider-request-store-execution",
				result: null,
			};
			const writeWithoutEffect = {
				...executionCall,
				id: "call-store-write-without-effect",
				requestId: "request-store-write-without-effect",
				callId: "call-ref-store-write-without-effect",
				idempotencyKey: "store-key-write-without-effect",
			};
			await expect(
				repository.reserveExecution({
					grant: resolved,
					actionCall: writeWithoutEffect,
					dispatch: {
						...dispatch,
						id: "dispatch-store-write-without-effect",
						actionCallId: writeWithoutEffect.id,
					},
					audit: stateAudit(writeWithoutEffect, "reserved"),
				}),
			).rejects.toThrow("Connection authorization denied");
			const readWithEffect = {
				...record,
				id: "call-store-read-with-effect",
				requestId: "request-store-read-with-effect",
				callId: "call-ref-store-read-with-effect",
				idempotencyKey: "store-key-read-with-effect",
			};
			await expect(
				repository.reserveExecution({
					grant: resolved,
					actionCall: readWithEffect,
					dispatch: {
						...dispatch,
						id: "dispatch-store-read-with-effect",
						actionCallId: readWithEffect.id,
					},
					effect: {
						...effect,
						id: "effect-store-read-with-effect",
						actionCallId: readWithEffect.id,
					},
					audit: stateAudit(readWithEffect, "reserved"),
				}),
			).rejects.toThrow("Connection authorization denied");
			expect(
				await databaseClient`select id from connection.action_calls where id in ('call-store-write-without-effect', 'call-store-read-with-effect')`,
			).toHaveLength(0);
			await repository.reserveExecution({
				grant: resolved,
				actionCall: executionCall,
				dispatch,
				effect,
				audit: stateAudit(executionCall, "reserved"),
			});
			expect(
				(
					await databaseClient`
					select a.status as action_status, d.status as dispatch_status, e.status as effect_status
					from connection.action_calls a
					join connection.dispatches d on d.action_call_id = a.id
					join connection.effects e on e.action_call_id = a.id
					where a.id = 'call-store-execution'
				`
				)[0],
			).toMatchObject({
				action_status: "created",
				dispatch_status: "pending",
				effect_status: "planned",
			});
			const auditRejectedCall = {
				...executionCall,
				id: "call-store-audit-rejected",
				requestId: "request-store-audit-rejected",
				callId: "call-ref-store-audit-rejected",
				idempotencyKey: "store-key-audit-rejected",
			};
			await expect(
				repository.reserveExecution({
					grant: resolved,
					actionCall: auditRejectedCall,
					dispatch: {
						...dispatch,
						id: "dispatch-store-cross-call",
						actionCallId: record.id,
					},
					effect: {
						...effect,
						id: "effect-store-cross-call",
						actionCallId: auditRejectedCall.id,
					},
					audit: stateAudit(auditRejectedCall, "reserved"),
				}),
			).rejects.toThrow("Execution binding mismatch");
			await expect(
				repository.reserveExecution({
					grant: resolved,
					actionCall: auditRejectedCall,
					dispatch: {
						...dispatch,
						id: "dispatch-store-cross-effect",
						actionCallId: auditRejectedCall.id,
					},
					effect: {
						...effect,
						id: "effect-store-cross-effect",
						actionCallId: record.id,
					},
					audit: stateAudit(auditRejectedCall, "reserved"),
				}),
			).rejects.toThrow("Execution binding mismatch");
			await expect(
				repository.reserveExecution({
					grant: resolved,
					actionCall: auditRejectedCall,
					dispatch: {
						...dispatch,
						id: "dispatch-store-audit-rejected",
						actionCallId: auditRejectedCall.id,
					},
					effect: {
						...effect,
						id: "effect-store-audit-rejected",
						actionCallId: auditRejectedCall.id,
					},
					audit: {
						...stateAudit(auditRejectedCall, "reserved"),
						id: "audit-store-1",
					},
				}),
			).rejects.toThrow();
			expect(
				await databaseClient`select id from connection.action_calls where id = 'call-store-audit-rejected'`,
			).toHaveLength(0);
			const { disabledClaim } = await databaseClient.begin(async (tx) => {
				await tx`update connection.provider_releases set status = 'disabled' where id = 'release-a-v1'`;
				const disabledClaim = repository.claimCurrentDispatchState({
					actionCallId: executionCall.id,
					dispatchId: dispatch.id,
					effectId: effect.id,
					grantRevision: resolved.revision,
					principalRecoveryGeneration: 1,
					leaseOwner: "lease-store-disabled-release",
					leaseExpiresAt: Date.now() + 60_000,
					audit: stateAudit(executionCall, "claimed"),
				});
				expect(
					await Promise.race([
						disabledClaim.then(() => "finished"),
						new Promise<string>((resolve) =>
							setTimeout(() => resolve("waiting"), 50),
						),
					]),
				).toBe("waiting");
				return { disabledClaim };
			});
			expect(await disabledClaim).toBe(false);
			await expect(authorizeActionCall(repository, request, 1)).rejects.toThrow(
				"Connection authorization denied",
			);
			await databaseClient`update connection.provider_releases set status = 'active' where id = 'release-a-v1'`;
			expect(
				await repository.claimCurrentDispatchState({
					actionCallId: executionCall.id,
					dispatchId: dispatch.id,
					effectId: effect.id,
					grantRevision: resolved.revision,
					principalRecoveryGeneration: 1,
					leaseOwner: "lease-store-execution",
					leaseExpiresAt: Date.now() + 60_000,
					audit: stateAudit(executionCall, "claimed"),
				}),
			).toBe(true);
			expect(
				(
					await databaseClient`
					select a.status as action_status, d.status as dispatch_status, e.status as effect_status
					from connection.action_calls a
					join connection.dispatches d on d.action_call_id = a.id
					join connection.effects e on e.action_call_id = a.id
					where a.id = 'call-store-execution'
				`
				)[0],
			).toMatchObject({
				action_status: "submission_started",
				dispatch_status: "claimed",
				effect_status: "submitted",
			});
			await expect(
				repository.recordProviderOutcome({
					actionCallId: executionCall.id,
					dispatchId: dispatch.id,
					effectId: effect.id,
					outcome: { kind: "succeeded", result: { ok: true } },
					audit: {
						...stateAudit(executionCall, "outcome"),
						id: "audit-store-1",
					},
				}),
			).rejects.toThrow();
			expect(
				(
					await databaseClient`select status from connection.action_calls where id = 'call-store-execution'`
				)[0]?.status,
			).toBe("submission_started");
			await expect(
				repository.recordProviderOutcome({
					actionCallId: executionCall.id,
					dispatchId: dispatch.id,
					effectId: effect.id,
					outcome: { kind: "succeeded", result: { ok: true } },
					audit: {
						...stateAudit(executionCall, "outcome"),
						principalId: "principal-b",
					},
				}),
			).rejects.toThrow();
			await expect(
				repository.recordProviderOutcome({
					actionCallId: executionCall.id,
					dispatchId: dispatch.id,
					outcome: { kind: "succeeded", result: { ok: true } },
					audit: stateAudit(executionCall, "outcome"),
				}),
			).rejects.toThrow("Effect binding mismatch");
			expect(
				(
					await databaseClient`select status from connection.action_calls where id = 'call-store-execution'`
				)[0]?.status,
			).toBe("submission_started");
			expect(
				await repository.recordProviderOutcome({
					actionCallId: executionCall.id,
					dispatchId: dispatch.id,
					effectId: effect.id,
					outcome: { kind: "succeeded", result: { ok: true } },
					audit: stateAudit(executionCall, "outcome"),
				}),
			).toBe(true);
			const pendingCall: ActionCallRecord = {
				...executionCall,
				id: "call-store-pending",
				requestId: "request-store-pending",
				callId: "call-ref-store-pending",
				idempotencyKey: "store-key-pending",
			};
			const pendingDispatch: DispatchRecord = {
				...dispatch,
				id: "dispatch-store-pending",
				actionCallId: pendingCall.id,
			};
			const pendingEffect: EffectRecord = {
				...effect,
				id: "effect-store-pending",
				actionCallId: pendingCall.id,
			};
			await repository.reserveExecution({
				grant: resolved,
				actionCall: pendingCall,
				dispatch: pendingDispatch,
				effect: pendingEffect,
				audit: stateAudit(pendingCall, "reserved"),
			});
			expect(
				await repository.claimCurrentDispatchState({
					actionCallId: pendingCall.id,
					dispatchId: pendingDispatch.id,
					effectId: pendingEffect.id,
					grantRevision: resolved.revision,
					principalRecoveryGeneration: 1,
					leaseOwner: "lease-store-pending",
					leaseExpiresAt: Date.now() + 60_000,
					audit: stateAudit(pendingCall, "claimed"),
				}),
			).toBe(true);
			expect(
				await repository.recordProviderOutcome({
					actionCallId: pendingCall.id,
					dispatchId: pendingDispatch.id,
					effectId: pendingEffect.id,
					outcome: { kind: "unknown" },
					audit: stateAudit(pendingCall, "unknown"),
				}),
			).toBe(true);
			await expect(
				repository.recordProviderOutcome({
					actionCallId: pendingCall.id,
					dispatchId: pendingDispatch.id,
					effectId: pendingEffect.id,
					outcome: { kind: "unknown" },
					audit: stateAudit(pendingCall, "unknown-again"),
				}),
			).rejects.toThrow();
			expect(
				await repository.recordProviderOutcome({
					actionCallId: pendingCall.id,
					dispatchId: pendingDispatch.id,
					effectId: pendingEffect.id,
					outcome: { kind: "succeeded", result: { recovered: true } },
					audit: stateAudit(pendingCall, "recovered"),
				}),
			).toBe(true);
			expect(
				(
					await databaseClient`
						select a.status as action_status, d.status as dispatch_status, e.status as effect_status
						from connection.action_calls a
						join connection.dispatches d on d.action_call_id = a.id
						join connection.effects e on e.action_call_id = a.id
						where a.id = 'call-store-pending'
					`
				)[0],
			).toMatchObject({
				action_status: "provider_succeeded",
				dispatch_status: "completed",
				effect_status: "succeeded",
			});
			await expect(
				databaseClient`update connection.action_calls set status = 'created' where id = 'call-store-execution'`,
			).rejects.toThrow();
			await expect(
				databaseClient`update connection.dispatches set status = 'pending' where id = 'dispatch-store-execution'`,
			).rejects.toThrow();
			await expect(
				databaseClient`update connection.effects set status = 'planned' where id = 'effect-store-execution'`,
			).rejects.toThrow();
			await expect(
				databaseClient`update connection.action_calls set trace_id = 'other-trace' where id = 'call-store-execution'`,
			).rejects.toThrow();
			await expect(
				databaseClient`update connection.audit_events set principal_id = 'principal-b' where target_id = 'call-store-execution'`,
			).rejects.toThrow();

			const revokedCall: ActionCallRecord = {
				...executionCall,
				id: "call-store-revoked",
				requestId: "request-store-revoked",
				callId: "call-ref-store-revoked",
				idempotencyKey: "store-key-revoked",
			};
			const revokedDispatch: DispatchRecord = {
				...dispatch,
				id: "dispatch-store-revoked",
				actionCallId: revokedCall.id,
			};
			const revokedEffect: EffectRecord = {
				...effect,
				id: "effect-store-revoked",
				actionCallId: revokedCall.id,
			};
			await repository.reserveExecution({
				grant: resolved,
				actionCall: revokedCall,
				dispatch: revokedDispatch,
				effect: revokedEffect,
				audit: stateAudit(revokedCall, "reserved"),
			});
			const lateRequest = {
				...request,
				requestId: "request-store-late",
				idempotencyKey: "store-key-late",
			};
			const lateCall: ActionCallRecord = {
				...record,
				id: "call-store-late",
				requestId: lateRequest.requestId,
				callId: "call-ref-store-late",
				idempotencyKey: lateRequest.idempotencyKey,
			};
			const { claim, reservation } = await databaseClient.begin(async (tx) => {
				await tx`update connection.grants set status = 'revoked', revision = revision + 1 where id = 'grant-a'`;
				const reservation = reserveActionCall(
					repository,
					lateCall,
					lateRequest,
					resolved,
				).then(
					() => "accepted",
					() => "denied",
				);
				const claim = repository.claimCurrentDispatchState({
					actionCallId: revokedCall.id,
					dispatchId: revokedDispatch.id,
					effectId: revokedEffect.id,
					grantRevision: resolved.revision,
					principalRecoveryGeneration: 1,
					leaseOwner: "lease-store-revoked",
					leaseExpiresAt: Date.now() + 60_000,
					audit: stateAudit(revokedCall, "claimed"),
				});
				expect(
					await Promise.race([
						claim.then(() => "finished"),
						new Promise<string>((resolve) =>
							setTimeout(() => resolve("waiting"), 50),
						),
					]),
				).toBe("waiting");
				expect(
					await Promise.race([
						reservation,
						new Promise<string>((resolve) =>
							setTimeout(() => resolve("waiting"), 50),
						),
					]),
				).toBe("waiting");
				return { claim, reservation };
			});
			expect(await claim).toBe(false);
			expect(await reservation).toBe("denied");
			expect(
				await databaseClient`select id from connection.action_calls where id = 'call-store-late'`,
			).toHaveLength(0);
			expect(
				await repository.failPendingDispatch(
					revokedDispatch.id,
					stateAudit(revokedCall, "denied"),
				),
			).toBe(true);
			expect(
				await repository.transition(
					revokedCall.id,
					"created",
					"provider_failed",
					stateAudit(revokedCall, "denied"),
				),
			).toBe(true);
			expect(
				(
					await databaseClient`
				select a.status as action_status, d.status as dispatch_status, e.status as effect_status
				from connection.action_calls a
				join connection.dispatches d on d.action_call_id = a.id
				join connection.effects e on e.action_call_id = a.id
				where a.id = 'call-store-revoked'
			`
				)[0],
			).toMatchObject({
				action_status: "provider_failed",
				dispatch_status: "failed",
				effect_status: "planned",
			});

			await databaseClient`insert into connection.connections (id, provider_id, external_account_id) values ('connection-b', 'provider-a', 'account-b')`;
			await databaseClient`insert into connection.credential_versions (id, connection_id, version, ciphertext) values ('credential-b-v1', 'connection-b', 1, 'ciphertext-b')`;
			await databaseClient`update connection.connections set current_credential_version_id = 'credential-b-v1' where id = 'connection-b'`;
			await databaseClient`insert into connection.grants (id, principal_id, consumer_id, consumer_instance_id, actor_id, connection_id, credential_version_id, approved_action_version_ids, principal_recovery_generation, consumer_instance_recovery_generation, created_at, expires_at)
				values ('grant-a2', 'principal-a', 'consumer-a', 'instance-a', 'actor-a', 'connection-a', 'credential-a-v1', ARRAY['action-a-v1'], 1, 1, now() - interval '1 minute', now() + interval '1 hour')`;
			await expect(
				databaseClient`insert into connection.grants (id, principal_id, consumer_id, consumer_instance_id, actor_id, connection_id, credential_version_id, approved_action_version_ids, principal_recovery_generation, consumer_instance_recovery_generation, created_at, expires_at)
				values ('grant-b', 'principal-a', 'consumer-a', 'instance-a', 'actor-a', 'connection-b', 'credential-b-v1', ARRAY['action-a-v1'], 1, 1, now() - interval '1 minute', now() + interval '1 hour')`,
			).rejects.toThrow();
			expect((await authorizeActionCall(repository, request, 1)).id).toBe(
				"grant-a2",
			);
			await databaseClient`update connection.grants set status = 'revoked', revision = revision + 1 where id = 'grant-a2'`;
			await databaseClient`insert into connection.grants (id, principal_id, consumer_id, consumer_instance_id, actor_id, connection_id, credential_version_id, approved_action_version_ids, principal_recovery_generation, consumer_instance_recovery_generation, created_at, expires_at)
				values ('grant-b', 'principal-a', 'consumer-a', 'instance-a', 'actor-a', 'connection-b', 'credential-b-v1', ARRAY['action-a-v1'], 1, 1, now() - interval '1 minute', now() + interval '1 hour')`;
			expect((await authorizeActionCall(repository, request, 1)).id).toBe(
				"grant-b",
			);
			const callerSelectedRequest = {
				...request,
				connectionId: "connection-a",
			};
			await expect(
				authorizeActionCall(repository, callerSelectedRequest, 1),
			).rejects.toThrow("Connection authorization denied");
			const { nextGrant } = await databaseClient.begin(async (tx) => {
				await tx`update connection.grants set status = 'revoked', revision = revision + 1 where id = 'grant-b'`;
				const nextGrant = databaseClient`insert into connection.grants (id, principal_id, consumer_id, consumer_instance_id, actor_id, connection_id, credential_version_id, approved_action_version_ids, principal_recovery_generation, consumer_instance_recovery_generation, created_at, expires_at)
					values ('grant-c', 'principal-a', 'consumer-a', 'instance-a', 'actor-a', 'connection-a', 'credential-a-v1', ARRAY['action-a-v1'], 1, 1, now() - interval '1 minute', now() + interval '1 hour')`;
				expect(
					await Promise.race([
						nextGrant.then(() => "finished"),
						new Promise<string>((resolve) =>
							setTimeout(() => resolve("waiting"), 50),
						),
					]),
				).toBe("waiting");
				return { nextGrant };
			});
			await nextGrant;
			expect((await authorizeActionCall(repository, request, 1)).id).toBe(
				"grant-c",
			);
			await databaseClient`update connection.consumer_instances set recovery_generation = 2 where id = 'instance-a'`;
			await expect(authorizeActionCall(repository, request, 1)).rejects.toThrow(
				"Connection authorization denied",
			);
			await databaseClient`update connection.grants set status = 'revoked', revision = revision + 1 where id = 'grant-c'`;
			await databaseClient`insert into connection.grants (id, principal_id, consumer_id, consumer_instance_id, actor_id, connection_id, credential_version_id, approved_action_version_ids, principal_recovery_generation, consumer_instance_recovery_generation, created_at, expires_at)
				values ('grant-d', 'principal-a', 'consumer-a', 'instance-a', 'actor-a', 'connection-a', 'credential-a-v1', ARRAY['action-a-v1'], 1, 2, now() - interval '1 minute', now() + interval '1 hour')`;
			expect((await authorizeActionCall(repository, request, 1)).id).toBe(
				"grant-d",
			);
			await databaseClient`update connection.principals set recovery_generation = 2 where id = 'principal-a'`;
			await expect(authorizeActionCall(repository, request, 1)).rejects.toThrow(
				"Connection authorization denied",
			);
		} finally {
			await handle.close();
		}
	});
});
