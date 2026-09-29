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

	async function waitForBlockedQuery(
		includes: readonly string[],
	): Promise<void> {
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const rows = await adminClient<{ query: string }[]>`
				select query from pg_stat_activity
				where datname = current_database() and wait_event_type = 'Lock'
			`;
			if (
				rows.some(({ query }) =>
					includes.every((fragment) => query.toLowerCase().includes(fragment)),
				)
			)
				return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(
			`Timed out waiting for blocked query: ${includes.join(", ")}`,
		);
	}

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

	it("does not report a superseded Agent grant as current authority", async () => {
		await adminClient`truncate platform.agent_principal_grants, platform.agents cascade`;
		await adminClient`
			insert into platform.agents (id, authorization_revision)
			values ('agent_grant_read', 'revision_1')
		`;
		await adminClient`
			insert into platform.agent_principal_grants
				(agent_id, principal_type, principal_id, grant_type, authorization_revision)
			values ('agent_grant_read', 'user', 'user_reader', 'use', 'revision_1')
		`;
		const input = {
			agentId: "agent_grant_read",
			principal: { kind: "user" as const, id: "user_reader" },
			grantType: "use" as const,
		};
		await expect(store.hasAgentGrant(input)).resolves.toBe(true);
		await adminClient`
			update platform.agents set authorization_revision = 'revision_2'
			where id = 'agent_grant_read'
		`;
		await expect(store.hasAgentGrant(input)).resolves.toBe(false);
	});

	it("bounds credential and application list reads at the PostgreSQL cursor", async () => {
		await adminClient`truncate platform.platform_api_credentials,
			platform.platform_applications cascade`;
		await adminClient`
			insert into platform.platform_applications
				(id, name, responsible_user_id, authorization_revision)
			values
				('app_a', 'A', 'user_owner', 'revision_1'),
				('app_b', 'B', 'user_owner', 'revision_1'),
				('app_c', 'C', 'user_owner', 'revision_1'),
				('app_other', 'Other', 'other_user', 'revision_1')
		`;
		await adminClient`
			insert into platform.platform_api_credentials
				(id, principal_type, principal_id, credential_hash, scopes)
			values
				('credential_a', 'user', 'user_owner', repeat('a', 64), '["agent:read"]'::jsonb),
				('credential_b', 'user', 'user_owner', repeat('b', 64), '["agent:read"]'::jsonb),
				('credential_c', 'user', 'user_owner', repeat('c', 64), '["agent:read"]'::jsonb),
				('credential_other', 'user', 'other_user', repeat('d', 64), '["agent:read"]'::jsonb)
		`;
		const principal = { kind: "user" as const, id: "user_owner" };
		expect(
			(await store.listCredentials({ principal, page: { limit: 1 } })).map(
				(item) => item.credentialId,
			),
		).toEqual(["credential_a", "credential_b"]);
		expect(
			(
				await store.listCredentials({
					principal,
					page: { limit: 1, afterId: "credential_a" },
				})
			).map((item) => item.credentialId),
		).toEqual(["credential_b", "credential_c"]);
		expect(
			(await store.listApplications("user_owner", { limit: 1 })).map(
				(item) => item.id,
			),
		).toEqual(["app_a", "app_b"]);
		expect(
			(
				await store.listApplications("user_owner", {
					limit: 1,
					afterId: "app_a",
				})
			).map((item) => item.id),
		).toEqual(["app_b", "app_c"]);
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

	it("rejects grant writes after application disablement, grant or credential revocation", async () => {
		await adminClient`truncate platform.audit_events, platform.agent_principal_grants,
			platform.platform_api_credentials, platform.agents cascade`;
		await adminClient`
			insert into platform.agents (id, authorization_revision)
			values ('agent_grant_race', 'revision_1')
		`;
		await adminClient`
			insert into platform.platform_applications
				(id, name, responsible_user_id, authorization_revision)
			values ('manager-app', 'Manager', 'user_owner', 'revision_1')
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
		await adminClient`
			update platform.platform_applications set status = 'disabled'
			where id = 'manager-app'
		`;
		await expect(grant("revision_disabled")).resolves.toBe(false);
		await expect(
			store.revokeAgentGrant({
				actor,
				agentId: "agent_grant_race",
				principal: { kind: "application", id: "recipient-app" },
				grantType: "use",
			}),
		).resolves.toBe(false);
		const [disabledWrite] = await adminClient`
			select agents.authorization_revision, grants.revoked_at
			from platform.agents
			join platform.agent_principal_grants grants
				on grants.agent_id = agents.id and grants.principal_id = 'recipient-app'
			where agents.id = 'agent_grant_race'
		`;
		expect(disabledWrite).toEqual({
			authorization_revision: "revision_2",
			revoked_at: null,
		});
		await adminClient`
			update platform.platform_applications set status = 'active'
			where id = 'manager-app'
		`;
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

	it.each(["grant", "revoke"] as const)(
		"serializes %s authority against an application disablement",
		async (operation) => {
			await adminClient`truncate platform.audit_events,
				platform.agent_principal_grants, platform.platform_api_credentials,
				platform.platform_applications, platform.agents cascade`;
			await adminClient`
				insert into platform.agents (id, authorization_revision)
				values ('agent_grant_lock', 'revision_lock_1')
			`;
			await adminClient`
				insert into platform.platform_applications
					(id, name, responsible_user_id, status, authorization_revision)
				values ('manager-lock-app', 'Manager', 'user_owner', 'active', 'app-lock-1')
			`;
			await adminClient`
				insert into platform.platform_api_credentials
					(id, principal_type, principal_id, credential_hash, scopes)
				values ('credential_lock', 'application', 'manager-lock-app',
					repeat('e', 64), '["agent:manage"]'::jsonb)
			`;
			await adminClient`
				insert into platform.agent_principal_grants
					(agent_id, principal_type, principal_id, grant_type, authorization_revision)
				values ('agent_grant_lock', 'application', 'manager-lock-app', 'manage',
					'revision_lock_1')
			`;
			if (operation === "revoke") {
				await adminClient`
					insert into platform.agent_principal_grants
						(agent_id, principal_type, principal_id, grant_type, authorization_revision)
					values ('agent_grant_lock', 'application', 'recipient-lock-app', 'use',
						'revision_lock_1')
				`;
			}
			const principal = {
				kind: "application" as const,
				id: "manager-lock-app",
			};
			const actor = {
				schemaVersion: 1 as const,
				userId: "user_owner",
				accountStatus: "active" as const,
				principal,
				isAdministrator: false,
				credential: {
					credentialId: "credential_lock",
					principal,
					scopes: ["agent:manage"] as const,
					expiresAt: null,
					revokedAt: null,
				},
			};
			const blocker = postgres(databaseUrl, { max: 1 });
			let release: (() => void) | undefined;
			let markLocked: (() => void) | undefined;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const locked = new Promise<void>((resolve) => {
				markLocked = resolve;
			});
			const disable = blocker.begin(async (transaction) => {
				await transaction`
					update platform.platform_applications set status = 'disabled'
					where id = 'manager-lock-app'
				`;
				markLocked?.();
				await held;
			});
			let pending: Promise<boolean> | undefined;
			try {
				await locked;
				pending =
					operation === "grant"
						? store.grantAgent({
								actor,
								agentId: "agent_grant_lock",
								principal: { kind: "application", id: "recipient-lock-app" },
								grantType: "use",
								authorizationRevision: "revision_lock_2",
							})
						: store.revokeAgentGrant({
								actor,
								agentId: "agent_grant_lock",
								principal: { kind: "application", id: "recipient-lock-app" },
								grantType: "use",
							});
				await waitForBlockedQuery(["platform_applications"]);
				release?.();
				await disable;
				expect(await pending).toBe(false);
				const [agent] = await adminClient`
					select authorization_revision from platform.agents
					where id = 'agent_grant_lock'
				`;
				expect(agent?.authorization_revision).toBe("revision_lock_1");
				const [grant] = await adminClient`
					select authorization_revision, revoked_at
					from platform.agent_principal_grants
					where agent_id = 'agent_grant_lock'
						and principal_id = 'recipient-lock-app'
				`;
				if (operation === "grant") expect(grant).toBeUndefined();
				else
					expect(grant).toMatchObject({
						authorization_revision: "revision_lock_1",
						revoked_at: null,
					});
			} finally {
				release?.();
				await disable.catch(() => undefined);
				await pending?.catch(() => undefined);
				await blocker.end();
			}
		},
	);

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
			order by action
		`;
		expect(audits).toEqual([
			{ action: "api.application.created", outcome: "succeeded" },
			{ action: "api.credential.delivery.granted", outcome: "rejected" },
			{ action: "api.credential.delivery.revoked", outcome: "rejected" },
			{ action: "api.credential.issued", outcome: "rejected" },
		]);
		const credentials = await store.listCredentials({
			applicationId: "application_transport_boundary",
		});
		expect(credentials).toHaveLength(0);
	});
});
