import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { githubConnectionCatalog } from "@agent-infra/openconnector-adapter";
import postgres from "postgres";
import { expect, it } from "vitest";
import { migrateConnectionDatabase } from "./migrations";
import { PostgresConnectionRepository } from "./repository";
import { assertIsolatedTestDatabaseUrl } from "./test-database";

const url = process.env.CONNECTION_TEST_DATABASE_URL;
assertIsolatedTestDatabaseUrl(url, process.env.DATABASE_URL);
const integration = url ? it : it.skip;

integration(
	"deprecation preserves execution, blocks admissions and requires dependency-free retirement",
	async () => {
		if (!url) return;
		await migrateConnectionDatabase(
			url,
			resolve(import.meta.dirname, "../../../migrations/connection"),
		);
		const sql = postgres(url);
		const repository = new PostgresConnectionRepository(
			url,
			Buffer.alloc(32, 19),
		);
		const suffix = randomUUID();
		const actor = `lifecycle-admin-${suffix}`;
		const provider = `lifecycle-${suffix}`;
		const source = `${provider}-v1`;
		const target = `${provider}-v2`;
		const account = `account-${suffix}`;
		const consumer = `consumer-${suffix}`;
		const instance = `instance-${suffix}`;
		const grant = `grant-${suffix}`;
		const credential = `credential-${suffix}`;
		const call = `call-${suffix}`;
		const existingRoutes = (
			await sql`SELECT id FROM connection_provider_releases`
		).map((row) => String(row.id));
		const catalog = (id: string) => ({
			...githubConnectionCatalog,
			provider,
			providerReleaseId: id,
			actions: [
				{
					...githubConnectionCatalog.actions[0]!,
					id: `${id}.read@v1`,
					name: `${provider}.read`,
				},
			],
		});
		try {
			await repository.publishProviderCatalog(catalog(source));
			await repository.publishProviderCatalog(catalog(target));
			await sql`INSERT INTO connection_principals (id, display_name) VALUES (${actor}, 'Lifecycle test')`;
			await sql`INSERT INTO connection_principal_roles (principal_id, role, status, grant_source)
      VALUES (${actor}, 'CONNECTION_ADMIN', 'ACTIVE', 'BOOTSTRAP')`;
			await expect(
				repository.getProviderReleaseLifecycle("unknown-principal", source),
			).rejects.toThrow();
			await expect(
				repository.changeProviderReleaseLifecycle({
					actorPrincipalId: actor,
					releaseId: target,
					expectedRevision: "1",
					operation: "deprecate",
					successorReleaseId: source,
					reason: "test",
				}),
			).rejects.toThrow();
			await sql`INSERT INTO connection_accounts (id, owner_principal_id, provider_id, provider_release_id, external_account, display_name, status)
      VALUES (${account}, ${actor}, ${provider}, ${source}, 'test-account', 'Test', 'ACTIVE')`;
			await sql`INSERT INTO connection_consumers (id, display_name, status) VALUES (${consumer}, 'Test', 'ACTIVE')`;
			await sql`INSERT INTO connection_consumer_instances (id, consumer_id, kind, auth_subject, status)
      VALUES (${instance}, ${consumer}, 'DEVICE', ${instance}, 'ACTIVE')`;
			await sql`INSERT INTO connection_grants (id, principal_id, consumer_id, provider_id, connection_id, status)
      VALUES (${grant}, ${actor}, ${consumer}, ${provider}, ${account}, 'ACTIVE')`;
			await sql`INSERT INTO connection_credential_versions (id, connection_id, ciphertext, nonce, tag, status)
      VALUES (${credential}, ${account}, 'fixture', 'fixture', 'fixture', 'ACTIVE')`;
			await sql`INSERT INTO connection_consumer_action_declarations (id, consumer_id, provider_release_id, revision, digest, status)
      VALUES (${consumer}, ${consumer}, ${source}, 1, 'fixture', 'PUBLISHED')`;
			await expect(
				repository.assertProviderRuntimeCoverage(existingRoutes),
			).rejects.toThrow();
			const adoption = await repository.assertProviderRuntimeCoverage([
				...existingRoutes,
				target,
			]);
			expect(
				adoption.legacyUnregistered.find((item) => item.releaseId === source),
			).toMatchObject({
				accounts: 1,
				grants: 1,
				declarations: 1,
				unfinishedCalls: 0,
			});
			expect(
				(
					await sql`SELECT runtime_registered FROM connection_provider_releases WHERE id = ${source}`
				)[0]?.runtime_registered,
			).toBe(false);
			await repository.assertProviderRuntimeCoverage([
				...existingRoutes,
				source,
				target,
			]);
			expect(
				(
					await sql`SELECT runtime_registered FROM connection_provider_releases WHERE id = ${source}`
				)[0]?.runtime_registered,
			).toBe(true);
			await expect(
				repository.assertProviderRuntimeCoverage([...existingRoutes, target]),
			).rejects.toThrow();
			await repository.changeProviderReleaseLifecycle({
				actorPrincipalId: actor,
				releaseId: source,
				expectedRevision: "1",
				operation: "deprecate",
				successorReleaseId: target,
				reason: "Upgrade available",
			});
			const report = await repository.getProviderReleaseLifecycle(
				actor,
				source,
			);
			expect(report.dependencies).toEqual({
				accounts: 1,
				grants: 1,
				declarations: 1,
				unfinishedCalls: 0,
			});
			expect(report.successorReleaseId).toBe(target);
			await expect(
				repository.publishProviderCatalog(catalog(source)),
			).rejects.toThrow();
			await expect(
				repository.assertProviderRuntimeCoverage([...existingRoutes, target]),
			).rejects.toThrow();
			await expect(sql`INSERT INTO connection_accounts (id, owner_principal_id, provider_id, provider_release_id, external_account, display_name, status)
      VALUES (${`${account}-new`}, ${actor}, ${provider}, ${source}, 'new', 'New', 'ACTIVE')`).rejects.toThrow();
			await expect(sql`INSERT INTO connection_grants (id, principal_id, consumer_id, provider_id, connection_id, status)
      VALUES (${`${grant}-new`}, ${actor}, ${consumer}, ${provider}, ${account}, 'ACTIVE')`).rejects.toThrow();
			// Existing authorization may still submit a call on the deprecated release.
			await sql`INSERT INTO connection_calls (id, principal_id, consumer_id, instance_id, grant_id, connection_id,
      credential_version_id, action_version_id, request_hash, status)
      VALUES (${call}, ${actor}, ${consumer}, ${instance}, ${grant}, ${account}, ${credential}, ${`${source}.read@v1`}, 'fixture', 'AUTHORIZED')`;
			await sql`UPDATE connection_accounts SET status = 'DISCONNECTED' WHERE id = ${account}`;
			await sql`UPDATE connection_grants SET status = 'REVOKED' WHERE id = ${grant}`;
			await sql`UPDATE connection_consumer_action_declarations SET status = 'REVOKED' WHERE id = ${consumer}`;
			expect(
				(await repository.getProviderReleaseLifecycle(actor, source))
					.dependencies.unfinishedCalls,
			).toBe(1);
			await expect(
				repository.changeProviderReleaseLifecycle({
					actorPrincipalId: actor,
					releaseId: source,
					expectedRevision: report.revision,
					operation: "retire",
					reason: "Finished migration",
				}),
			).rejects.toThrow();
			await sql`UPDATE connection_calls SET status = 'SUCCEEDED' WHERE id = ${call}`;
			await sql`INSERT INTO connection_effects (id, call_id, status) VALUES (${call}, ${call}, 'PREPARED')`;
			await sql`INSERT INTO connection_dispatches (id, effect_id, status) VALUES (${call}, ${call}, 'PENDING')`;
			await expect(
				repository.changeProviderReleaseLifecycle({
					actorPrincipalId: actor,
					releaseId: source,
					expectedRevision: report.revision,
					operation: "retire",
					reason: "Finished migration",
				}),
			).rejects.toThrow();
			await sql`UPDATE connection_effects SET status = 'SUCCEEDED' WHERE id = ${call}`;
			await expect(
				repository.changeProviderReleaseLifecycle({
					actorPrincipalId: actor,
					releaseId: source,
					expectedRevision: report.revision,
					operation: "retire",
					reason: "Finished migration",
				}),
			).rejects.toThrow();
			await sql`UPDATE connection_dispatches SET status = 'FAILED' WHERE id = ${call}`;
			let signalLocked: () => void = () => {};
			let unlock: () => void = () => {};
			const locked = new Promise<void>((resolve) => {
				signalLocked = resolve;
			});
			const proceed = new Promise<void>((resolve) => {
				unlock = resolve;
			});
			const racingCall = `${call}-racing`;
			const insert = sql.begin(async (tx) => {
				await tx`SELECT id FROM connection_provider_releases WHERE id = ${source} FOR SHARE`;
				signalLocked();
				await proceed;
				await tx`INSERT INTO connection_calls (id, principal_id, consumer_id, instance_id, grant_id, connection_id,
        credential_version_id, action_version_id, request_hash, status)
        VALUES (${racingCall}, ${actor}, ${consumer}, ${instance}, ${grant}, ${account}, ${credential}, ${`${source}.read@v1`}, 'fixture', 'AUTHORIZED')`;
			});
			await locked;
			const concurrentRetirement = expect(
				repository.changeProviderReleaseLifecycle({
					actorPrincipalId: actor,
					releaseId: source,
					expectedRevision: report.revision,
					operation: "retire",
					reason: "Race",
				}),
			).rejects.toThrow();
			unlock();
			await insert;
			await concurrentRetirement;
			await sql`UPDATE connection_calls SET status = 'SUCCEEDED' WHERE id = ${racingCall}`;
			await repository.changeProviderReleaseLifecycle({
				actorPrincipalId: actor,
				releaseId: source,
				expectedRevision: report.revision,
				operation: "retire",
				reason: "Finished migration",
			});
			expect(
				(await repository.getProviderReleaseLifecycle(actor, source)).status,
			).toBe("DISABLED");
			await expect(sql`INSERT INTO connection_calls (id, principal_id, consumer_id, instance_id, grant_id, connection_id,
      credential_version_id, action_version_id, request_hash, status)
      VALUES (${`${call}-retired`}, ${actor}, ${consumer}, ${instance}, ${grant}, ${account}, ${credential}, ${`${source}.read@v1`}, 'fixture', 'AUTHORIZED')`).rejects.toThrow();
			await repository.assertProviderRuntimeCoverage([
				...existingRoutes,
				target,
			]);
			expect(
				(await sql`SELECT id FROM connection_calls WHERE id = ${call}`).length,
			).toBe(1);
			expect(
				(
					await sql`SELECT event FROM connection_audit_records WHERE principal_id = ${actor}
      AND event = 'PROVIDER_RELEASE_RETIRED'`
				).length,
			).toBe(1);
		} finally {
			await sql`UPDATE connection_calls SET status = 'FAILED' WHERE id = ${call} AND status = 'AUTHORIZED'`;
			await sql`UPDATE connection_accounts SET status = 'DISCONNECTED' WHERE id = ${account}`;
			await sql`UPDATE connection_grants SET status = 'REVOKED' WHERE id = ${grant} AND status = 'ACTIVE'`;
			await sql`UPDATE connection_consumer_action_declarations SET status = 'REVOKED' WHERE id = ${consumer}`;
			await sql`UPDATE connection_provider_releases SET runtime_registered = false WHERE provider = ${provider}`;
			await repository.close();
			await sql.end();
		}
	},
	30_000,
);
