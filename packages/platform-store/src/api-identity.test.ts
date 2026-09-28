import { createApiIdentityManagementV1 } from "@agent-infra/platform-core";
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

	it("rejects a duplicate credential hash across principals, including revoked rows", async () => {
		await adminClient`truncate platform.audit_events,
			platform.api_credential_delivery_grants, platform.platform_api_credentials,
			platform.platform_applications cascade`;
		const first = await store.issueCredential({
			principal: { kind: "user", id: "user_one" },
			credential: "duplicate-credential-fixture",
			scopes: ["agent:read"],
			expiresAt: null,
			audit: { ...userAudit, action: "api.credential.issued" },
		});
		await store.revokeCredential(first.credentialId);
		await expect(
			adminClient`insert into platform.platform_api_credentials
				(id, principal_type, principal_id, credential_hash, scopes)
				select 'duplicate-other-principal', 'user', 'user_two', credential_hash, '["agent:read"]'::jsonb
				from platform.platform_api_credentials where id = ${first.credentialId}`,
		).rejects.toMatchObject({
			code: "23505",
			constraint_name: "platform_api_credential_hash_unique",
		});
		const [row] = await adminClient<[{ total: number }]>`
			select count(*)::int as total from platform.platform_api_credentials`;
		expect(row?.total).toBe(1);
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
			actor: {
				schemaVersion: 1,
				userId: "user_owner",
				accountStatus: "active",
				isAdministrator: true,
			},
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
				'authorization_revision_1')
		`;
		const request = {
			actor: {
				schemaVersion: 1 as const,
				userId: "user_owner",
				accountStatus: "active" as const,
				isAdministrator: true,
			},
			agentId: "agent_revoke_revision",
			principal: { kind: "application" as const, id: "revoked-app" },
			grantType: "manage" as const,
		};
		await expect(
			store.revokeAgentGrant({
				...request,
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
		await expect(store.revokeAgentGrant(request)).resolves.toBe(false);
		const [unchanged] = await adminClient`
			select authorization_revision from platform.agents
			where id = 'agent_revoke_revision'
		`;
		expect(unchanged?.authorization_revision).toBe(
			agent?.authorization_revision,
		);
	});

	it("rejects grant writes after the actor's manage grant is revoked", async () => {
		await adminClient`truncate platform.audit_events, platform.agent_principal_grants,
			platform.agents cascade`;
		await adminClient`insert into platform.agents (id, authorization_revision)
			values ('agent_grant_race', 'revision_1')`;
		await adminClient`insert into platform.agent_principal_grants
			(agent_id, principal_type, principal_id, grant_type, authorization_revision)
			values ('agent_grant_race', 'user', 'actor_race', 'manage', 'revision_1'),
				('agent_grant_race', 'user', 'target_race', 'use', 'revision_1')`;
		const actor = {
			schemaVersion: 1 as const,
			userId: "actor_race",
			accountStatus: "active" as const,
			principal: { kind: "user" as const, id: "actor_race" },
			isAdministrator: false,
			credential: {
				principal: { kind: "user" as const, id: "actor_race" },
				scopes: ["agent:manage" as const],
				expiresAt: null,
				revokedAt: null,
			},
		};
		const management = createApiIdentityManagementV1({
			store,
			directory: {
				resolveUser: async (userId) => ({
					userId,
					accountStatus: "active",
				}),
			},
			agentAccess: {
				async canManage() {
					await adminClient`update platform.agent_principal_grants
						set revoked_at = now()
						where agent_id = 'agent_grant_race' and principal_id = 'actor_race'`;
					return true;
				},
			},
			idFactory: () => "revision_2",
		});
		const audit = {
			...userAudit,
			actor: { kind: "user" as const, id: "actor_race" },
		};
		await expect(
			management.grantAgent({
				actor,
				agentId: "agent_grant_race",
				principal: { kind: "user", id: "recipient_race" },
				grantType: "use",
				audit: { ...audit, action: "api.agent.grant.granted" },
			}),
		).rejects.toMatchObject({ code: "resource_unavailable" });
		await adminClient`update platform.agent_principal_grants
			set revoked_at = null
			where agent_id = 'agent_grant_race' and principal_id = 'actor_race'`;
		await expect(
			management.revokeAgentGrant({
				actor,
				agentId: "agent_grant_race",
				principal: { kind: "user", id: "target_race" },
				grantType: "use",
				audit: { ...audit, action: "api.agent.grant.revoked" },
			}),
		).rejects.toMatchObject({ code: "resource_unavailable" });
		const [agent] = await adminClient`
			select authorization_revision from platform.agents where id = 'agent_grant_race'`;
		const grants = await adminClient`
			select principal_id, revoked_at from platform.agent_principal_grants
			where agent_id = 'agent_grant_race' and principal_id in ('recipient_race', 'target_race')`;
		expect(agent?.authorization_revision).toBe("revision_1");
		expect(grants).toEqual([{ principal_id: "target_race", revoked_at: null }]);
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
