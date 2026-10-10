import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ConnectionApplicationService } from "@agent-infra/connection-core";
import { githubConnectionCatalog } from "@agent-infra/openconnector-adapter";
import {
	staticSpacesConnectionCatalog,
	staticSpacesPilot,
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
(url ? it : it.skip)(
	"supervised admission rejects wrong identities, expiry and durable closure without retiring routes",
	async () => {
		if (!url) return;
		await migrateConnectionDatabase(
			url,
			resolve(import.meta.dirname, "../../../migrations/connection"),
		);
		const sql = postgres(url, { max: 1 });
		const repo = new PostgresConnectionRepository(url, Buffer.alloc(32, 41));
		const releaseId = staticSpacesConnectionCatalog.providerReleaseId;
		try {
			await repo.publishProviderCatalog(staticSpacesConnectionCatalog);
			await sql
				.begin(async (tx) => {
					await tx`INSERT INTO connection_principals (id,display_name,email) VALUES (${staticSpacesPilot.principalId},'Pilot test',${`${randomUUID()}@example.invalid`}) ON CONFLICT DO NOTHING`;
					// Transaction-only clock fixture: rolled back, never changes the catalog or production activation.
					const profile = {
						...staticSpacesConnectionCatalog.deploymentProfile,
						supervisedPilot: {
							...staticSpacesPilot,
							startsAt: new Date(Date.now() - 1000).toISOString(),
							expiresAt: new Date(Date.now() + 60000).toISOString(),
						},
					};
					await tx`UPDATE connection_provider_releases SET deployment_profile=${tx.json(profile)} WHERE id=${releaseId}`;
					const allowed = async (
						principal: string,
						consumer: string,
						external = "841",
					) => {
						const [row] =
							await tx`SELECT connection_supervised_provider_allowed(${releaseId},${principal},${consumer},${external}) AS allowed`;
						return row?.allowed;
					};
					expect(
						await allowed(
							staticSpacesPilot.principalId,
							staticSpacesPilot.consumerId,
						),
					).toBe(true);
					expect(await allowed("other", staticSpacesPilot.consumerId)).toBe(
						false,
					);
					expect(
						await allowed(staticSpacesPilot.principalId, "consumer-other"),
					).toBe(false);
					expect(
						await allowed(
							staticSpacesPilot.principalId,
							staticSpacesPilot.consumerId,
							"17",
						),
					).toBe(false);
					await tx`SELECT connection_close_supervised_provider(${releaseId},${staticSpacesPilot.principalId},'TEST_UNKNOWN')`;
					expect(
						await allowed(
							staticSpacesPilot.principalId,
							staticSpacesPilot.consumerId,
						),
					).toBe(false);
					const [state] =
						await tx`SELECT status FROM connection_provider_releases WHERE id=${releaseId}`;
					expect(state?.status).toBe("PUBLISHED");
					throw new Error("ROLLBACK_TEST_FIXTURE");
				})
				.catch((error) => {
					if (error.message !== "ROLLBACK_TEST_FIXTURE") throw error;
				});
			await sql
				.begin(async (tx) => {
					const expired = {
						...staticSpacesConnectionCatalog.deploymentProfile,
						supervisedPilot: {
							...staticSpacesPilot,
							startsAt: "2020-01-01T00:00:00Z",
							expiresAt: "2020-01-02T00:00:00Z",
						},
					};
					await tx`UPDATE connection_provider_releases SET deployment_profile=${tx.json(expired)} WHERE id=${releaseId}`;
					const [row] =
						await tx`SELECT connection_supervised_provider_allowed(${releaseId},${staticSpacesPilot.principalId},${staticSpacesPilot.consumerId}) AS allowed`;
					expect(row?.allowed).toBe(false);
					throw new Error("ROLLBACK_TEST_FIXTURE");
				})
				.catch((error) => {
					if (error.message !== "ROLLBACK_TEST_FIXTURE") throw error;
				});
		} finally {
			await repo.close();
			await sql.end();
		}
	},
);
(url ? it : it.skip)(
	"ordinary credential, discovery, Consent and dispatch paths enforce pilot admission and credential revocation stays closed",
	async () => {
		if (!url) return;
		await migrateConnectionDatabase(
			url,
			resolve(import.meta.dirname, "../../../migrations/connection"),
		);
		const sql = postgres(url, { max: 1 });
		const repo = new PostgresConnectionRepository(url, Buffer.alloc(32, 42));
		const suffix = randomUUID();
		const principalId = `test-pilot-${suffix}`;
		const consumerId = `test-codex-${suffix}`;
		const catalog = {
			...staticSpacesConnectionCatalog,
			providerReleaseId: `test-supervised-${suffix}`,
			deploymentProfile: {
				...staticSpacesConnectionCatalog.deploymentProfile,
				supervisedPilot: {
					...staticSpacesPilot,
					principalId,
					consumerId,
					startsAt: new Date(Date.now() - 1000).toISOString(),
					expiresAt: new Date(Date.now() + 60000).toISOString(),
				},
			},
			actions: staticSpacesConnectionCatalog.actions.map((action) => ({
				...action,
				id: `${action.name}@test-${suffix}`,
			})),
		};
		const instanceId = `pilot-device-${suffix}`;
		try {
			await repo.publishProviderCatalog(catalog);
			await sql`INSERT INTO connection_principals(id,display_name,email) VALUES(${principalId},'Pilot',${`${suffix}@example.invalid`}) ON CONFLICT DO NOTHING`;
			await expect(
				repo.publishConsumerDeclaration({
					providerReleaseId: catalog.providerReleaseId,
					consumer: { id: `wrong-${suffix}`, name: "Wrong" },
					actionVersionIds: catalog.actions.map((a) => a.id),
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await repo.publishConsumerDeclaration({
				providerReleaseId: catalog.providerReleaseId,
				consumer: { id: consumerId, name: "Pilot Codex" },
				actionVersionIds: catalog.actions.map((a) => a.id),
			});
			await sql`INSERT INTO connection_consumer_instances(id,consumer_id,kind,auth_subject,status,principal_id) VALUES(${instanceId},${consumerId},'DEVICE',${instanceId},'ACTIVE',${principalId})`;
			const credential = {
				accessToken: "test-only-pilot-credential",
				displayName: "Pilot",
				externalAccount: "841",
				grantedScopes: ["static-spaces.personal-api-token"],
				principalId,
				providerId: "static-spaces",
				providerReleaseId: catalog.providerReleaseId,
			};
			await expect(
				repo.storeProviderCredential({ ...credential, principalId: "wrong" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			const accessRequestId = await seedApprovedConnectPermit(sql, {
				principalId,
				providerReleaseId: catalog.providerReleaseId,
				scopes: credential.grantedScopes,
			});
			await expect(
				repo.validatePersonalConnectRequest({
					principalId: "wrong",
					providerId: "static-spaces",
					requestId: accessRequestId,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await sql`INSERT INTO connection_consumers (id,display_name,status) VALUES ('wrong','Wrong consumer','ACTIVE') ON CONFLICT DO NOTHING`;
			const connection = await repo.storeProviderCredential({
				...credential,
				accessRequestId,
			});
			await expect(
				repo.createCurrentConsumerAuthorizationPreview({
					principalId,
					consumerId: "wrong",
					connectionId: connection.connectionId,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			const preview = await repo.createCurrentConsumerAuthorizationPreview({
				principalId,
				consumerId,
				connectionId: connection.connectionId,
			});
			await repo.confirmCurrentConsumerAuthorization({
				principalId,
				previewId: preview.previewId,
				confirmationToken: preview.confirmationToken,
				idempotencyKey: suffix,
			});
			const [context] = await repo.resolveDirectIdentities({
				principalId,
				consumerId,
				instanceId,
			});
			if (!context) throw new Error("Missing test context");
			expect((await repo.listAuthorizedActions(context)).length).toBe(7);
			await expect(
				repo.listAuthorizedActions({ ...context, consumerId: "wrong" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			const service = new ConnectionApplicationService(repo, {
				execute: async () => ({ id: "841" }),
			});
			await service.executeDirectActionForIdentity(
				context,
				"static-spaces.get_current_user",
				{},
			);
			// Another Provider must survive a still-ACTIVE Grant whose pilot closes.
			await repo.publishProviderCatalog(githubConnectionCatalog);
			const githubAction = githubConnectionCatalog.actions.find(
				(action) => action.name === "github.get_current_user",
			);
			if (!githubAction) throw new Error("Missing GitHub fixture Action");
			await repo.publishConsumerDeclaration({
				providerReleaseId: githubConnectionCatalog.providerReleaseId,
				consumer: { id: consumerId, name: "Pilot Codex" },
				actionVersionIds: [githubAction.id],
			});
			const githubPermit = await seedApprovedConnectPermit(sql, {
				principalId,
				providerReleaseId: githubConnectionCatalog.providerReleaseId,
				scopes: githubAction.requiredScopes,
			});
			const githubConnection = await repo.storeProviderCredential({
				accessRequestId: githubPermit,
				accessToken: "test-only-github-credential",
				displayName: "GitHub fixture",
				externalAccount: suffix,
				grantedScopes: githubAction.requiredScopes,
				principalId,
				providerId: "github",
				providerReleaseId: githubConnectionCatalog.providerReleaseId,
			});
			const githubPreview =
				await repo.createCurrentConsumerAuthorizationPreview({
					principalId,
					consumerId,
					connectionId: githubConnection.connectionId,
				});
			await repo.confirmCurrentConsumerAuthorization({
				principalId,
				previewId: githubPreview.previewId,
				confirmationToken: githubPreview.confirmationToken,
				idempotencyKey: `github-${suffix}`,
			});
			// Authorize a real persisted dispatch without sending any upstream request.
			const call = await repo.createCall({
				invocation: context,
				action: "static-spaces.publish_space",
				argsHash: suffix,
				actionVersionId:
					catalog.actions.find((a) => a.effect === "WRITE")?.id ?? "",
				input: {
					kind: "shared",
					slug: "connection-test",
					overwrite: false,
					files: [],
				},
				idempotencyKey: `dispatch-${suffix}`,
			});
			await expect(
				sql.begin(async (tx) => {
					const expired = {
						...catalog.deploymentProfile,
						supervisedPilot: {
							...catalog.deploymentProfile.supervisedPilot,
							startsAt: "2020-01-01T00:00:00Z",
							expiresAt: "2020-01-02T00:00:00Z",
						},
					};
					await tx`UPDATE connection_provider_releases SET deployment_profile=${tx.json(expired)} WHERE id=${catalog.providerReleaseId}`;
					await tx`UPDATE connection_dispatches SET status='SUBMISSION_STARTED' WHERE effect_id IN (SELECT id FROM connection_effects WHERE call_id=${call.call.callId})`;
				}),
			).rejects.toMatchObject({ code: "23514" });
			const failedRead = await repo.createCall({
				invocation: context,
				action: "static-spaces.get_current_user",
				argsHash: suffix,
				input: {},
			});
			const uncertain = await repo.createCall({
				invocation: context,
				action: "static-spaces.publish_space",
				argsHash: suffix,
				input: {
					kind: "shared",
					slug: "connection-test",
					overwrite: false,
					files: [],
				},
				idempotencyKey: `unknown-${suffix}`,
			});
			await repo.startDispatch({
				callId: uncertain.call.callId,
				action: "static-spaces.publish_space",
				invocation: context,
			});
			await repo.setCallResult({
				callId: uncertain.call.callId,
				status: "UNCERTAIN",
			});
			await repo.setCallResult({
				callId: failedRead.call.callId,
				status: "FAILED",
			});
			const identity = { principalId, consumerId, instanceId };
			expect(await service.listDirectActionsForIdentity(identity)).toEqual([
				expect.objectContaining({ name: "github.get_current_user" }),
			]);
			await expect(
				service.executeDirectActionForIdentity(
					identity,
					"github.get_current_user",
					{},
				),
			).resolves.toMatchObject({ status: "SUCCEEDED" });
			await expect(repo.listAuthorizedActions(context)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			await expect(
				repo.resolveDirectIdentities({ ...identity, principalId: "wrong" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				repo.resolveDirectIdentities({ ...identity, consumerId: "wrong" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				repo.resolveDirectIdentities({ ...identity, instanceId: "wrong" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await repo.revokeGrant({ principalId, grantId: context.grantId });
			const [revoked] =
				await sql`SELECT status FROM connection_grants WHERE id=${context.grantId}`;
			expect(revoked?.status).toBe("REVOKED");
			await repo.pauseCredentialForReauthorization(context);
			expect(
				await repo.isProviderAdmissionOpen({
					providerReleaseId: catalog.providerReleaseId,
					principalId,
					consumerId,
				}),
			).toBe(false);
			await expect(
				sql`UPDATE connection_dispatches SET status='SUBMISSION_STARTED' WHERE effect_id IN (SELECT id FROM connection_effects WHERE call_id=${call.call.callId})`,
			).rejects.toMatchObject({ code: "23514" });
			const closures =
				await sql`SELECT detail->>'reason' AS reason FROM connection_audit_records WHERE event='SUPERVISED_PILOT_CLOSED' AND detail->>'providerReleaseId'=${catalog.providerReleaseId}`;
			expect(closures.map((row) => row.reason)).toEqual(
				expect.arrayContaining(["UNCERTAIN", "FAILED", "CREDENTIAL_REVOKED"]),
			);
			await expect(
				repo.startDispatch({
					callId: call.call.callId,
					action: "static-spaces.publish_space",
					invocation: context,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(
				(await repo.getOverview(principalId)).actions.some((a) =>
					catalog.actions.some((member) => member.id === a.id),
				),
			).toBe(false);
			await expect(
				repo.validatePersonalReconnect({
					principalId,
					connectionId: connection.connectionId,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		} finally {
			// Leave the shared test reconciliation queue free of this fixture only.
			await sql`DELETE FROM connection_reconciliation_jobs job USING connection_calls call WHERE job.call_id=call.id AND call.principal_id=${principalId}`;
			await repo.close();
			await sql.end();
		}
	},
);
