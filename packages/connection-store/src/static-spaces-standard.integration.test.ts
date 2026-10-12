import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ConnectionApplicationService } from "@agent-infra/connection-core";
import {
	staticSpacesConnectionCatalog as fullCatalog,
	staticSpacesV6ConnectionCatalog as standardCatalog,
} from "@agent-infra/openconnector-adapter/providers/static-spaces";
import postgres from "postgres";
import { expect, it } from "vitest";
import { seedApprovedConnectPermit } from "./approved-connect-fixture";
import { migrateConnectionDatabase } from "./migrations";
import { PostgresConnectionRepository } from "./repository";
import { assertIsolatedTestDatabaseUrl } from "./test-database";

const url = process.env.CONNECTION_TEST_DATABASE_URL;
assertIsolatedTestDatabaseUrl(url, process.env.DATABASE_URL);
if (process.env.CI && !url)
	throw new Error("CONNECTION_TEST_DATABASE_URL is required in CI");
for (const catalog of [standardCatalog, fullCatalog])
	(url ? it : it.skip)(
		`${catalog.providerReleaseId} serializes submissions and preserves per-Connection freeze across grants and credentials`,
		async () => {
			if (!url) return;
			const admin = postgres(url, { max: 1 });
			const databaseName = `connection_standard_test_${randomUUID().replaceAll("-", "")}`;
			const testUrl = new URL(url);
			testUrl.pathname = `/${databaseName}`;
			let created = false;
			let repo: PostgresConnectionRepository | undefined;
			let sql: ReturnType<typeof postgres> | undefined;
			try {
				await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
				created = true;
				await migrateConnectionDatabase(
					testUrl.href,
					resolve(import.meta.dirname, "../../../migrations/connection"),
				);
				sql = postgres(testUrl.href, { max: 4 });
				repo = new PostgresConnectionRepository(
					testUrl.href,
					Buffer.alloc(32, 42),
				);
				const db = sql;
				const store = repo;
				await store.publishProviderCatalog(catalog);
				const setup = async (label: string) => {
					const principalId = randomUUID();
					const consumerId = `consumer-${label}-${randomUUID()}`;
					const instanceId = `instance-${randomUUID()}`;
					await db`INSERT INTO connection_principals(id,display_name,email) VALUES(${principalId},${label},${`${principalId}@example.invalid`})`;
					await store.publishConsumerDeclaration({
						providerReleaseId: catalog.providerReleaseId,
						consumer: { id: consumerId, name: label },
						actionVersionIds: catalog.actions.map((a) => a.id),
					});
					await db`INSERT INTO connection_consumer_instances(id,consumer_id,kind,auth_subject,status,principal_id) VALUES(${instanceId},${consumerId},'DEVICE',${instanceId},'ACTIVE',${principalId})`;
					const credential = {
						accessToken: "test-only-personal-token",
						displayName: label,
						externalAccount: label === "first" ? "951" : "952",
						grantedScopes: ["static-spaces.personal-api-token"],
						principalId,
						providerId: "static-spaces",
						providerReleaseId: catalog.providerReleaseId,
					};
					const permit = await seedApprovedConnectPermit(db, {
						principalId,
						providerReleaseId: catalog.providerReleaseId,
						scopes: credential.grantedScopes,
					});
					const connection = await store.storeProviderCredential({
						...credential,
						accessRequestId: permit,
					});
					const authorize = async (
						consumer = consumerId,
						instance = instanceId,
					) => {
						const preview =
							await store.createCurrentConsumerAuthorizationPreview({
								principalId,
								consumerId: consumer,
								connectionId: connection.connectionId,
							});
						await store.confirmCurrentConsumerAuthorization({
							principalId,
							previewId: preview.previewId,
							confirmationToken: preview.confirmationToken,
							idempotencyKey: randomUUID(),
						});
						const [context] = await store.resolveDirectIdentities({
							principalId,
							consumerId: consumer,
							instanceId: instance,
						});
						if (!context) throw new Error("Missing normal context");
						return context;
					};
					return {
						principalId,
						consumerId,
						instanceId,
						credential,
						connection,
						authorize,
						context: await authorize(),
					};
				};
				const first = await setup("first");
				const other = await setup("other");
				expect(first.context.providerReleaseId).toBe(catalog.providerReleaseId);
				await expect(
					store.listAuthorizedActions({
						...first.context,
						principalId: other.principalId,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				const action = "static-spaces.publish_space";
				const make = (context: typeof first.context, key = randomUUID()) =>
					store.createCall({
						invocation: context,
						action,
						argsHash: key,
						idempotencyKey: key,
						input: {
							kind: "user",
							files: [
								{ relative_path: "normal/doc.md", content: "normal content" },
							],
						},
					});
				const a = await make(first.context);
				const b = await make(first.context);
				// Two separate transactions compete; exactly one may cross the submission boundary.
				const attempts = await Promise.allSettled(
					[a, b].map((c) =>
						store.startDispatch({
							callId: c.call.callId,
							action,
							invocation: first.context,
						}),
					),
				);
				expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(
					1,
				);
				const winner = attempts[0]?.status === "fulfilled" ? a : b;
				const loser = winner === a ? b : a;
				await store.setCallResult({
					callId: winner.call.callId,
					status: "UNCERTAIN",
				});
				await expect(make(first.context)).rejects.toMatchObject({
					code: "FORBIDDEN",
				});
				await expect(
					store.startDispatch({
						callId: loser.call.callId,
						action,
						invocation: first.context,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				// Provider stays published and another real subject's Connection is unaffected.
				expect(
					await store.isProviderAdmissionOpen({
						providerReleaseId: catalog.providerReleaseId,
					}),
				).toBe(true);
				const independent = await make(other.context);
				await store.startDispatch({
					callId: independent.call.callId,
					action,
					invocation: other.context,
				});
				await store.setCallResult({
					callId: independent.call.callId,
					status: "SUCCEEDED",
					result: {},
				});
				const service = new ConnectionApplicationService(store, {
					execute: async () => ({ id: "951" }),
				});
				await expect(
					service.executeDirectActionForIdentity(
						first,
						"static-spaces.get_current_user",
						{},
					),
				).resolves.toMatchObject({ status: "SUCCEEDED" });
				// Replacing the Grant and credential cannot erase the durable unknown history.
				await store.revokeGrant({
					principalId: first.principalId,
					grantId: first.context.grantId,
				});
				const newContext = await first.authorize();
				await expect(make(newContext)).rejects.toMatchObject({
					code: "FORBIDDEN",
				});
				const permit = await seedApprovedConnectPermit(db, {
					principalId: first.principalId,
					providerReleaseId: catalog.providerReleaseId,
					scopes: first.credential.grantedScopes,
				});
				const replacement = await store.storeProviderCredential({
					...first.credential,
					accessRequestId: permit,
				});
				expect(replacement.connectionId).toBe(first.connection.connectionId);
				const replacementContext = await first.authorize();
				await expect(make(replacementContext)).rejects.toMatchObject({
					code: "FORBIDDEN",
				});
				const secondConsumer = `consumer-second-${randomUUID()}`;
				const secondInstance = `instance-second-${randomUUID()}`;
				await store.publishConsumerDeclaration({
					providerReleaseId: catalog.providerReleaseId,
					consumer: { id: secondConsumer, name: "second client" },
					actionVersionIds: catalog.actions.map((a) => a.id),
				});
				await db`INSERT INTO connection_consumer_instances(id,consumer_id,kind,auth_subject,status,principal_id) VALUES(${secondInstance},${secondConsumer},'TOKEN',${secondInstance},'ACTIVE',${first.principalId})`;
				const secondContext = await first.authorize(
					secondConsumer,
					secondInstance,
				);
				await expect(make(secondContext)).rejects.toMatchObject({
					code: "FORBIDDEN",
				});
				await store.disconnectConnection({
					principalId: first.principalId,
					connectionId: first.connection.connectionId,
				});
				const reconnect = await store.storeProviderCredential({
					...first.credential,
					expectedConnectionId: first.connection.connectionId,
				});
				expect(reconnect.connectionId).toBe(first.connection.connectionId);
				const reconnectedContext = await first.authorize();
				await expect(make(reconnectedContext)).rejects.toMatchObject({
					code: "FORBIDDEN",
				});
				// Future immutable release is a test fixture, not a new production catalog.
				const { standardApproval: _approval, ...deploymentProfile } =
					catalog.deploymentProfile;
				const future = {
					...catalog,
					providerReleaseId: "static-spaces-connection-v7-test-only",
					deploymentProfile,
					executorDigest: "sha256:" + "7".repeat(64),
					actions: catalog.actions.map((a) => ({
						...a,
						id: `${a.name}@v7-test-only`,
					})),
				};
				await store.publishProviderCatalog(future);
				await store.publishConsumerDeclaration({
					providerReleaseId: future.providerReleaseId,
					consumer: { id: first.consumerId, name: "first" },
					actionVersionIds: future.actions.map((a) => a.id),
				});
				const upgradePermit = await seedApprovedConnectPermit(db, {
					principalId: first.principalId,
					providerReleaseId: future.providerReleaseId,
					scopes: first.credential.grantedScopes,
				});
				const upgraded = await store.storeProviderCredential({
					...first.credential,
					providerReleaseId: future.providerReleaseId,
					accessRequestId: upgradePermit,
				});
				expect(upgraded.connectionId).toBe(first.connection.connectionId);
				const upgradedContext = await first.authorize();
				await expect(make(upgradedContext)).rejects.toMatchObject({
					code: "FORBIDDEN",
				});
				await store.pauseCredentialForReauthorization(upgradedContext);
				expect(
					await store.isProviderAdmissionOpen({
						providerReleaseId: catalog.providerReleaseId,
					}),
				).toBe(true);
				expect(await store.listAuthorizedActions(other.context)).toHaveLength(
					catalog.actions.length,
				);
				const unknown =
					await db`SELECT status FROM connection_effects WHERE call_id=${winner.call.callId}`;
				expect(unknown[0]?.status).toBe("UNCERTAIN");
			} finally {
				await repo?.close();
				await sql?.end();
				try {
					if (created)
						await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
				} finally {
					await admin.end();
				}
			}
		},
		30000,
	);
