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

const administratorActor = {
	schemaVersion: 1 as const,
	userId: "user_owner",
	accountStatus: "active" as const,
	isAdministrator: true,
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
			store.grantCredentialDelivery({
				applicationId: "application_identity",
				principal: { kind: "user", id: "user_recipient" },
				authorizationRevision: "application_revision_1",
				audit: {
					...userAudit,
					action: "api.credential.delivery.granted",
				},
			}),
		).rejects.toThrow("Application delivery authorization is stale");
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
			insert into platform.agent_owners (agent_id, owner_id, created_at)
			values ('agent_grant_revision', 'user_owner', now())
		`;
		await adminClient`
			insert into platform.agent_principal_grants
				(agent_id, principal_type, principal_id, grant_type, authorization_revision)
			values
				('agent_grant_revision', 'application', 'existing-app', 'use',
					'authorization_revision_1'),
				('agent_grant_revision', 'application', 'stale-app', 'use',
					'authorization_revision_0')
		`;
		await store.grantAgent({
			actor: { ...administratorActor, isAdministrator: false },
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
			{
				principal_id: "stale-app",
				authorization_revision: "authorization_revision_0",
			},
		]);
	});

	it("advances the Agent authorization revision when revoking a grant", async () => {
		await adminClient`truncate platform.audit_events, platform.agent_principal_grants,
			platform.agents cascade`;
		await adminClient`
			insert into platform.agents (id, authorization_revision)
			values ('agent_revoke_revision', 'authorization_revision_1')
		`;
		await adminClient`
			insert into platform.agent_principal_grants
				(agent_id, principal_type, principal_id, grant_type, authorization_revision)
			values
				('agent_revoke_revision', 'application', 'revoked-app', 'manage',
				'authorization_revision_1'),
				('agent_revoke_revision', 'application', 'remaining-app', 'use',
				'authorization_revision_1'),
				('agent_revoke_revision', 'application', 'stale-app', 'use',
				'authorization_revision_0')
		`;
		await expect(
			store.revokeAgentGrant({
				actor: administratorActor,
				agentId: "agent_revoke_revision",
				principal: { kind: "application", id: "revoked-app" },
				grantType: "manage",
				audit: { ...userAudit, action: "api.agent.grant.revoked" },
			}),
		).resolves.toBe(true);
		const [agent] = await adminClient`
			select authorization_revision from platform.agents
			where id = 'agent_revoke_revision'
		`;
		expect(agent?.authorization_revision).not.toBe("authorization_revision_1");
		const grants = await adminClient`
			select principal_id, authorization_revision, revoked_at
			from platform.agent_principal_grants
			where agent_id = 'agent_revoke_revision'
			order by principal_id
		`;
		expect(grants[0]).toMatchObject({
			principal_id: "remaining-app",
			authorization_revision: agent?.authorization_revision,
			revoked_at: null,
		});
		expect(grants[1]).toMatchObject({
			principal_id: "revoked-app",
			authorization_revision: "authorization_revision_1",
			revoked_at: expect.any(Date),
		});
		expect(grants[2]).toMatchObject({
			principal_id: "stale-app",
			authorization_revision: "authorization_revision_0",
			revoked_at: null,
		});
		await expect(
			store.revokeAgentGrant({
				actor: administratorActor,
				agentId: "agent_revoke_revision",
				principal: { kind: "application", id: "revoked-app" },
				grantType: "manage",
			}),
		).resolves.toBe(false);
		const [unchanged] = await adminClient`
			select authorization_revision from platform.agents
			where id = 'agent_revoke_revision'
		`;
		expect(unchanged?.authorization_revision).toBe(
			agent?.authorization_revision,
		);
	});

	it("rejects grant writes after caller grant or credential revocation", async () => {
		await adminClient`truncate platform.audit_events, platform.agent_principal_grants,
			platform.platform_api_credentials, platform.agents cascade`;
		await adminClient`
			insert into platform.agents (id, authorization_revision)
			values ('agent_grant_race', 'revision_1')
		`;
		await adminClient`
			insert into platform.platform_api_credentials
				(id, principal_type, principal_id, credential_hash, scopes)
			values ('credential_manager', 'application', 'manager-app',
				repeat('a', 64), '["agent:manage"]'::jsonb)
		`;
		await adminClient`
			insert into platform.agent_principal_grants
				(agent_id, principal_type, principal_id, grant_type, authorization_revision)
			values ('agent_grant_race', 'application', 'manager-app', 'manage',
				'revision_1')
		`;
		const principal = { kind: "application" as const, id: "manager-app" };
		const actor = {
			schemaVersion: 1 as const,
			userId: "user_owner",
			accountStatus: "active" as const,
			principal,
			isAdministrator: false,
			credential: {
				credentialId: "credential_manager",
				principal,
				scopes: ["agent:manage"] as const,
				expiresAt: null,
				revokedAt: null,
			},
		};
		const grant = (authorizationRevision: string) =>
			store.grantAgent({
				actor,
				agentId: "agent_grant_race",
				principal: { kind: "application", id: "recipient-app" },
				grantType: "use",
				authorizationRevision,
			});
		await expect(grant("revision_2")).resolves.toBe(true);
		await expect(
			store.revokeAgentGrant({
				actor: administratorActor,
				agentId: "agent_grant_race",
				principal,
				grantType: "manage",
			}),
		).resolves.toBe(true);
		await expect(grant("revision_denied")).resolves.toBe(false);
		await expect(
			store.grantAgent({
				actor: administratorActor,
				agentId: "agent_grant_race",
				principal,
				grantType: "manage",
				authorizationRevision: "revision_3",
			}),
		).resolves.toBe(true);
		await expect(store.revokeCredential("credential_manager")).resolves.toBe(
			true,
		);
		await expect(grant("revision_denied_again")).resolves.toBe(false);
		await expect(
			store.revokeAgentGrant({
				actor,
				agentId: "agent_grant_race",
				principal: { kind: "application", id: "recipient-app" },
				grantType: "use",
			}),
		).resolves.toBe(false);
		const [agent] = await adminClient`
			select authorization_revision from platform.agents
			where id = 'agent_grant_race'
		`;
		expect(agent?.authorization_revision).toBe("revision_3");
	});

	it("rejects application credential transport at the Store boundary", async () => {
		await adminClient`truncate platform.audit_events,
			platform.api_credential_delivery_grants, platform.platform_api_credentials,
			platform.platform_applications cascade`;
		await store.createApplication({
			applicationId: "application_transport_boundary",
			name: "Transport boundary test application",
			responsibleUserId: "user_owner",
			authorizationRevision: "application_revision_1",
			audit: userAudit,
		});
		const issueAudit = {
			...userAudit,
			action: "api.credential.issued" as const,
		};
		await expect(
			store.issueCredential({
				principal: {
					kind: "application",
					id: "application_transport_boundary",
				},
				credential: "application-secret-value",
				scopes: ["agent:read"],
				expiresAt: null,
				audit: issueAudit,
			}),
		).rejects.toThrow("Application credential transport is unavailable");
		await expect(
			store.grantCredentialDelivery({
				applicationId: "application_transport_boundary",
				principal: { kind: "application", id: "recipient-application" },
				authorizationRevision: "application_revision_1",
				audit: { ...userAudit, action: "api.credential.delivery.granted" },
			}),
		).rejects.toThrow("Application credential transport is unavailable");
		await expect(
			store.revokeCredentialDelivery({
				applicationId: "application_transport_boundary",
				principal: { kind: "application", id: "recipient-application" },
				audit: { ...userAudit, action: "api.credential.delivery.revoked" },
			}),
		).rejects.toThrow("Application credential transport is unavailable");
		const audits = await adminClient`
			select action, outcome
			from platform.audit_events
			order by occurred_at, id
		`;
		expect(audits).toEqual([
			{ action: "api.application.created", outcome: "succeeded" },
			{ action: "api.credential.issued", outcome: "rejected" },
			{ action: "api.credential.delivery.granted", outcome: "rejected" },
			{ action: "api.credential.delivery.revoked", outcome: "rejected" },
		]);
		const credentials = await store.listCredentials({
			applicationId: "application_transport_boundary",
		});
		expect(credentials).toHaveLength(0);
	});
});
