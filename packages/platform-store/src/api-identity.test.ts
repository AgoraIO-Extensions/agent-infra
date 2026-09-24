import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type ApiIdentityAuditInputV1,
	PostgresApiIdentityStoreV1,
} from "./api-identity.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

vi.setConfig({ testTimeout: 30_000 });

const userAudit: ApiIdentityAuditInputV1 = {
	traceId: "trace_api_identity",
	requestId: "request_api_identity",
	actor: { kind: "user", id: "user_owner" },
	action: "api.application.created",
};

describe("PostgreSQL API identity store", () => {
	let databaseUrl = "";
	let adminClient: ReturnType<typeof postgres>;
	let testDatabase: PostgresTestDatabase | undefined;
	let store: PostgresApiIdentityStoreV1;

	beforeAll(async () => {
		testDatabase = await startPostgresTestDatabase("platform-api-identity");
		databaseUrl = testDatabase.databaseUrl;
		await migratePlatformDatabase({ databaseUrl });
		adminClient = postgres(databaseUrl, { max: 1 });
		store = new PostgresApiIdentityStoreV1({ databaseUrl });
	});

	afterAll(async () => {
		await store?.close();
		await adminClient?.end();
		await testDatabase?.stop();
	});

	it("isolates credential principals, enforces delivery revocation, and audits writes", async () => {
		await adminClient`truncate platform.audit_events, platform.api_credential_delivery_grants,
			platform.platform_api_credentials, platform.platform_applications cascade`;
		await store.createApplication({
			applicationId: "application_identity",
			name: "Identity test application",
			responsibleUserId: "user_owner",
			authorizationRevision: "application_revision_1",
			audit: userAudit,
		});
		const userCredential = await store.issueCredential({
			principal: { kind: "user", id: "application_identity" },
			credential: "user-secret-value",
			scopes: ["agent:read"],
			expiresAt: null,
			audit: {
				...userAudit,
				action: "api.credential.issued",
			},
		});
		await expect(
			store.issueCredential({
				principal: { kind: "application", id: "application_identity" },
				credential: "application-secret-value",
				recipient: { kind: "user", id: "user_recipient" },
				scopes: ["agent:read"],
				expiresAt: null,
				audit: {
					...userAudit,
					action: "api.credential.issued",
				},
			}),
		).rejects.toThrow("Credential delivery is not authorized");
		await store.grantCredentialDelivery({
			applicationId: "application_identity",
			principal: { kind: "user", id: "user_recipient" },
			authorizationRevision: "application_revision_1",
			audit: {
				...userAudit,
				action: "api.credential.delivery.granted",
			},
		});
		await adminClient`update platform.platform_applications
			set authorization_revision = 'application_revision_2'
			where id = 'application_identity'`;
		expect(
			await store.hasCredentialDelivery({
				applicationId: "application_identity",
				principal: { kind: "user", id: "user_recipient" },
			}),
		).toBe(false);
		await expect(
			store.issueCredential({
				principal: { kind: "application", id: "application_identity" },
				credential: "stale-delivery-secret",
				recipient: { kind: "user", id: "user_recipient" },
				scopes: ["agent:read"],
				expiresAt: null,
				audit: { ...userAudit, action: "api.credential.issued" },
			}),
		).rejects.toThrow("Credential delivery is not authorized");
		await store.grantCredentialDelivery({
			applicationId: "application_identity",
			principal: { kind: "user", id: "user_recipient" },
			authorizationRevision: "application_revision_2",
			audit: { ...userAudit, action: "api.credential.delivery.granted" },
		});
		const applicationCredential = await store.issueCredential({
			principal: { kind: "application", id: "application_identity" },
			credential: "application-secret-value",
			recipient: { kind: "user", id: "user_recipient" },
			scopes: ["agent:read"],
			expiresAt: null,
			audit: {
				...userAudit,
				action: "api.credential.issued",
			},
		});

		const applicationCredentials = await store.listCredentials({
			applicationId: "application_identity",
		});
		expect(applicationCredentials).toHaveLength(1);
		expect(applicationCredentials[0]).toEqual(applicationCredential.metadata);
		expect(JSON.stringify(applicationCredentials)).not.toContain(
			"application-secret-value",
		);
		expect(
			JSON.stringify(
				await store.getCredentialMetadata(applicationCredential.credentialId),
			),
		).not.toContain("application-secret-value");
		expect(
			await store.revokeCredentialDelivery({
				applicationId: "application_identity",
				principal: { kind: "user", id: "user_recipient" },
				audit: {
					...userAudit,
					action: "api.credential.delivery.revoked",
				},
			}),
		).toBe(true);
		expect(
			await store.hasCredentialDelivery({
				applicationId: "application_identity",
				principal: { kind: "user", id: "user_recipient" },
			}),
		).toBe(false);
		expect(
			await store.revokeCredential(
				applicationCredential.credentialId,
				new Date("2026-09-24T00:00:00.000Z"),
				{ ...userAudit, action: "api.credential.revoked" },
			),
		).toBe(true);

		const audits = await adminClient`
			select action
			from platform.audit_events
			order by occurred_at desc, id desc
			limit 20
		`;
		expect(audits.map(({ action }) => action)).toEqual([
			"api.credential.revoked",
			"api.credential.delivery.revoked",
			"api.credential.issued",
			"api.credential.delivery.granted",
			"api.credential.delivery.granted",
			"api.credential.issued",
			"api.application.created",
		]);
		expect(userCredential.metadata).not.toHaveProperty("credential");
	});

	it("advances the Agent authorization revision with a new grant", async () => {
		await adminClient`truncate platform.audit_events, platform.agent_principal_grants,
			platform.agents cascade`;
		await adminClient`
			insert into platform.agents (id, authorization_revision)
			values ('agent_grant_revision', 'authorization_revision_1')
		`;
		await adminClient`
			insert into platform.agent_principal_grants
				(agent_id, principal_type, principal_id, grant_type, authorization_revision)
			values ('agent_grant_revision', 'application', 'existing-app', 'use',
				'authorization_revision_1')
		`;
		await store.grantAgent({
			agentId: "agent_grant_revision",
			principal: { kind: "application", id: "new-app" },
			grantType: "manage",
			authorizationRevision: "authorization_revision_2",
			audit: {
				...userAudit,
				action: "api.agent.grant.granted",
			},
		});
		const [agent] = await adminClient`
			select authorization_revision
			from platform.agents where id = 'agent_grant_revision'
		`;
		const grants = await adminClient`
			select principal_id, authorization_revision
			from platform.agent_principal_grants
			where agent_id = 'agent_grant_revision'
			order by principal_id
		`;
		expect(agent?.authorization_revision).toBe("authorization_revision_2");
		expect(grants).toEqual([
			{
				principal_id: "existing-app",
				authorization_revision: "authorization_revision_2",
			},
			{
				principal_id: "new-app",
				authorization_revision: "authorization_revision_2",
			},
		]);
	});
});
