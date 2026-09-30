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
	identityRevision: "user_revision_1",
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
		store = new PostgresApiIdentityStoreV1({
			databaseUrl,
			resolveUser: async (userId) => ({
				schemaVersion: 1,
				userId,
				accountStatus: "active",
				organizationIds: [],
				authorizationRevision: "user_revision_1",
			}),
		});
	});

	afterAll(async () => {
		await store?.close();
		await adminClient?.end();
		await testDatabase?.stop();
	});

	it("commits application creation once across concurrent retries", async () => {
		await adminClient`truncate platform.audit_events, platform.idempotency_records,
			platform.platform_applications cascade`;
		const input = {
			name: "Idempotent application",
			responsibleUserId: "user_owner",
			authorizationRevision: "application_revision_1",
			idempotencyKey: "application-create-1",
			requestDigest: "a".repeat(64),
			audit: userAudit,
		};
		const results = await Promise.all([
			store.createApplication({
				actor: administratorActor,
				...input,
				applicationId: "application_idem_a",
			}),
			store.createApplication({
				actor: administratorActor,
				...input,
				applicationId: "application_idem_b",
			}),
		]);
		expect(results[0]).toBe(results[1]);
		const applications = await adminClient<{ id: string }[]>`
			select id from platform.platform_applications
			where id in ('application_idem_a', 'application_idem_b')
		`;
		expect(applications).toEqual([{ id: results[0] }]);
		const audits = await adminClient<{ target_id: string }[]>`
			select target_id from platform.audit_events
			where action = 'api.application.created'
		`;
		expect(audits).toEqual([{ target_id: results[0] }]);
		await expect(
			store.createApplication({
				actor: administratorActor,
				...input,
				applicationId: "application_idem_conflict",
				requestDigest: "b".repeat(64),
			}),
		).rejects.toMatchObject({ code: "idempotency_conflict" });
		await expect(
			store.createApplication({
				...input,
				applicationId: "application_idem_other",
				responsibleUserId: "user_other",
				actor: { ...administratorActor, userId: "user_other" },
				audit: {
					...userAudit,
					actor: { kind: "user", id: "user_other" },
				},
			}),
		).resolves.toBe("application_idem_other");
	});

	it.each([
		"disabled",
		"missing",
		"stale revision",
		"wrong user",
		"Platform disabled",
	])(
		"rejects browser-sensitive creation and credential writes under a %s current user",
		async (change) => {
			await adminClient`truncate platform.audit_events, platform.idempotency_records, platform.platform_user_disables, platform.platform_api_credentials, platform.platform_applications cascade`;
			await store.createApplication({
				actor: administratorActor,
				applicationId: "application_current_actor",
				name: "Current actor",
				responsibleUserId: "user_owner",
				authorizationRevision: "app-current-1",
				audit: userAudit,
			});
			const userCredential = await store.issueCredential({
				actor: administratorActor,
				principal: { kind: "user", id: "user_owner" },
				credential: "current-actor-user-secret",
				scopes: ["agent:read"],
				expiresAt: null,
				audit: { ...userAudit, action: "api.credential.issued" },
			});
			await adminClient`insert into platform.platform_api_credentials (id, principal_type, principal_id, credential_hash, scopes) values ('credential_current_actor_app', 'application', 'application_current_actor', repeat('f', 64), '["agent:read"]'::jsonb)`;
			const guardedStore = new PostgresApiIdentityStoreV1({
				databaseUrl,
				resolveUser: async (userId) =>
					change === "missing"
						? null
						: {
								schemaVersion: 1,
								userId: change === "wrong user" ? "other-user" : userId,
								accountStatus: change === "disabled" ? "disabled" : "active",
								organizationIds: [],
								authorizationRevision:
									change === "stale revision"
										? "new-revision"
										: "user_revision_1",
							},
			});
			if (change === "Platform disabled")
				await adminClient`insert into platform.platform_user_disables (user_id, disabled_by) values ('user_owner', 'administrator')`;
			try {
				await expect(
					guardedStore.createApplication({
						actor: administratorActor,
						applicationId: "application_stale_actor",
						name: "Stale actor",
						responsibleUserId: "user_owner",
						authorizationRevision: "app-stale-1",
						idempotencyKey: "stale-application",
						requestDigest: "a".repeat(64),
						audit: userAudit,
					}),
				).rejects.toMatchObject({ code: "not_authorized" });
				await expect(
					guardedStore.issueCredential({
						actor: administratorActor,
						principal: { kind: "user", id: "user_owner" },
						credential: "stale-actor-user-secret",
						scopes: ["agent:read"],
						expiresAt: null,
						audit: { ...userAudit, action: "api.credential.issued" },
					}),
				).rejects.toMatchObject({ code: "not_authorized" });
				for (const [credentialId, principal] of [
					[
						userCredential.credentialId,
						{ kind: "user" as const, id: "user_owner" },
					],
					[
						"credential_current_actor_app",
						{ kind: "application" as const, id: "application_current_actor" },
					],
				] as const) {
					expect(
						await guardedStore.revokeCredential({
							actor: administratorActor,
							principal,
							credentialId,
							revokedAt: new Date(),
							audit: { ...userAudit, action: "api.credential.revoked" },
						}),
					).toBe(false);
				}
				expect(
					await adminClient`select id from platform.platform_applications`,
				).toEqual([{ id: "application_current_actor" }]);
				expect(
					await adminClient`select id from platform.idempotency_records`,
				).toEqual([]);
				expect(
					await adminClient`select id from platform.platform_api_credentials where revoked_at is not null`,
				).toEqual([]);
				const [count] =
					await adminClient`select count(*)::int count from platform.audit_events`;
				expect(count?.count).toBe(2);
				await adminClient`insert into platform.agents (id, authorization_revision)
					values ('stale_browser_agent', 'agent-revision-1')`;
				await adminClient`insert into platform.agent_principal_grants
					(agent_id, principal_type, principal_id, grant_type, authorization_revision)
					values ('stale_browser_agent', 'user', 'user_target', 'use', 'agent-revision-1')`;
				const grantInput = {
					actor: administratorActor,
					agentId: "stale_browser_agent",
					principal: { kind: "user" as const, id: "user_target" },
					grantType: "use" as const,
				};
				await expect(
					guardedStore.grantAgent({
						...grantInput,
						authorizationRevision: "agent-revision-2",
					}),
				).resolves.toBe(false);
				await expect(guardedStore.revokeAgentGrant(grantInput)).resolves.toBe(
					false,
				);
				const [grant] =
					await adminClient`select revoked_at, authorization_revision
					from platform.agent_principal_grants where agent_id = 'stale_browser_agent'`;
				expect(grant).toEqual({
					revoked_at: null,
					authorization_revision: "agent-revision-1",
				});
			} finally {
				await guardedStore.close();
				await adminClient`delete from platform.agent_principal_grants where agent_id = 'stale_browser_agent'`;
				await adminClient`delete from platform.agents where id = 'stale_browser_agent'`;
				await adminClient`delete from platform.platform_user_disables where user_id = 'user_owner'`;
			}
		},
	);

	it.each(["application creation", "application credential issuance"])(
		"serializes %s with concurrent Platform disable",
		async (operation) => {
			const userId = "fcb6b7da-c082-4575-a190-191ebefb5d50";
			const actor = { ...administratorActor, userId };
			await adminClient`truncate platform.audit_events, platform.idempotency_records, platform.platform_user_disables, platform.ldap_identity_ids, platform.platform_applications cascade`;
			await adminClient`insert into platform.ldap_identity_ids (issuer, uid, user_id) values ('fixture', 'current-browser', ${userId})`;
			const issuing = operation === "application credential issuance";
			if (issuing) {
				await store.createApplication({
					actor: administratorActor,
					applicationId: "application_issue_disable_race",
					name: "Issue disable race",
					responsibleUserId: "user_owner",
					authorizationRevision: "app-1",
					audit: userAudit,
				});
				await store.grantCredentialDelivery({
					actor: administratorActor,
					applicationId: "application_issue_disable_race",
					principal: { kind: "user", id: userId },
					scopes: ["agent:read"],
					expiresAt: null,
					authorizationRevision: "app-1",
					audit: { ...userAudit, action: "api.credential.delivery.granted" },
				});
			}
			const disabler = postgres(databaseUrl, { max: 1 });
			let release: (() => void) | undefined;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			let markLocked: (() => void) | undefined;
			const locked = new Promise<void>((resolve) => {
				markLocked = resolve;
			});
			const disable = Promise.resolve(
				disabler.begin(async (transaction) => {
					await transaction`select user_id from platform.ldap_identity_ids where user_id = ${userId} for update`;
					await transaction`insert into platform.platform_user_disables (user_id, disabled_by) values (${userId}, 'administrator')`;
					markLocked?.();
					await held;
				}),
			);
			let pending: Promise<unknown> | undefined;
			try {
				await locked;
				pending = issuing
					? store.issueCredential({
							actor,
							principal: {
								kind: "application",
								id: "application_issue_disable_race",
							},
							recipient: { kind: "user", id: userId },
							credential: "disable-race-credential",
							scopes: ["agent:read"],
							expiresAt: null,
							audit: {
								...userAudit,
								actor: { kind: "user", id: userId },
								action: "api.credential.issued",
							},
						})
					: store.createApplication({
							actor,
							applicationId: "application_disable_race",
							name: "Disable race",
							responsibleUserId: userId,
							authorizationRevision: "app-1",
							audit: { ...userAudit, actor: { kind: "user", id: userId } },
						});
				await waitForBlockedQuery(["ldap_identity_ids"]);
				release?.();
				await disable;
				await expect(pending).rejects.toMatchObject({
					code: issuing ? "resource_unavailable" : "not_authorized",
				});
				expect(
					await adminClient`select id from platform.platform_applications`,
				).toEqual(issuing ? [{ id: "application_issue_disable_race" }] : []);
				const [audits] =
					await adminClient`select count(*)::int count from platform.audit_events`;
				expect(audits?.count).toBe(issuing ? 2 : 0);
				expect(
					await adminClient`select id from platform.platform_api_credentials where credential_hash = repeat('0', 64) or recipient_user_id = ${userId}`,
				).toEqual([]);
			} finally {
				release?.();
				await disable.catch(() => undefined);
				await pending?.catch(() => undefined);
				await disabler.end();
				await adminClient`delete from platform.platform_user_disables where user_id = ${userId}`;
				await adminClient`delete from platform.ldap_identity_ids where user_id = ${userId}`;
			}
		},
	);

	it.each(["grant", "revoke"] as const)(
		"serializes a browser %s with concurrent Platform disablement",
		async (operation) => {
			const userId = "93f3c8f2-3c73-4332-99a7-d3abc8f8ddc6";
			await adminClient`truncate platform.audit_events, platform.agent_principal_grants,
				platform.agent_owners, platform.platform_user_disables,
				platform.ldap_identity_ids, platform.agents cascade`;
			await adminClient`insert into platform.agents (id, authorization_revision)
				values ('browser_grant_agent', 'agent-revision-1')`;
			await adminClient`insert into platform.agent_owners (agent_id, owner_id, created_at)
				values ('browser_grant_agent', ${userId}, now())`;
			await adminClient`insert into platform.ldap_identity_ids (issuer, uid, user_id)
				values ('fixture', 'browser-grant-owner', ${userId})`;
			await adminClient`insert into platform.agent_principal_grants
				(agent_id, principal_type, principal_id, grant_type, authorization_revision)
				values ('browser_grant_agent', 'user', 'user_target', 'use', 'agent-revision-1')`;
			const disabler = postgres(databaseUrl, { max: 1 });
			let release: (() => void) | undefined;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			let markLocked: (() => void) | undefined;
			const locked = new Promise<void>((resolve) => {
				markLocked = resolve;
			});
			const disable = Promise.resolve(
				disabler.begin(async (transaction) => {
					await transaction`select user_id from platform.ldap_identity_ids where user_id = ${userId} for update`;
					await transaction`insert into platform.platform_user_disables (user_id, disabled_by)
					values (${userId}, 'administrator')`;
					markLocked?.();
					await held;
				}),
			);
			let pending: Promise<boolean> | undefined;
			try {
				await locked;
				const input = {
					actor: { ...administratorActor, userId, isAdministrator: false },
					agentId: "browser_grant_agent",
					principal: { kind: "user" as const, id: "user_target" },
					grantType: "use" as const,
					audit: {
						...userAudit,
						action:
							operation === "grant"
								? ("api.agent.grant.granted" as const)
								: ("api.agent.grant.revoked" as const),
					},
				};
				pending =
					operation === "grant"
						? store.grantAgent({
								...input,
								authorizationRevision: "agent-revision-2",
							})
						: store.revokeAgentGrant(input);
				await waitForBlockedQuery(["ldap_identity_ids"]);
				release?.();
				await disable;
				await expect(pending).resolves.toBe(false);
				const [agent] =
					await adminClient`select authorization_revision from platform.agents
					where id = 'browser_grant_agent'`;
				expect(agent?.authorization_revision).toBe("agent-revision-1");
				const [grant] =
					await adminClient`select revoked_at, authorization_revision
					from platform.agent_principal_grants where agent_id = 'browser_grant_agent'`;
				expect(grant).toEqual({
					revoked_at: null,
					authorization_revision: "agent-revision-1",
				});
				expect(await adminClient`select id from platform.audit_events`).toEqual(
					[],
				);
			} finally {
				release?.();
				await disable.catch(() => undefined);
				await pending?.catch(() => undefined);
				await disabler.end();
				await adminClient`delete from platform.platform_user_disables where user_id = ${userId}`;
				await adminClient`delete from platform.ldap_identity_ids where user_id = ${userId}`;
			}
		},
	);

	it("rechecks credential subject and current application responsibility before revocation", async () => {
		await adminClient`truncate platform.audit_events, platform.platform_api_credentials, platform.platform_applications cascade`;
		await store.createApplication({
			actor: administratorActor,
			applicationId: "application_revoke_owner",
			name: "Revoke owner",
			responsibleUserId: "user_owner",
			authorizationRevision: "app-revoke-1",
			audit: userAudit,
		});
		await adminClient`insert into platform.platform_api_credentials (id, principal_type, principal_id, credential_hash, scopes) values ('credential_revoke_owner', 'application', 'application_revoke_owner', repeat('f', 64), '["agent:read"]'::jsonb)`;
		const revoke = (
			principalId: string,
			actor = { ...administratorActor, isAdministrator: false },
		) =>
			store.revokeCredential({
				actor,
				credentialId: "credential_revoke_owner",
				principal: { kind: "application", id: principalId },
				revokedAt: new Date(),
				audit: { ...userAudit, action: "api.credential.revoked" },
			});
		await adminClient`update platform.platform_applications set responsible_user_id = 'other-owner' where id = 'application_revoke_owner'`;
		expect(await revoke("application_revoke_owner")).toBe(false);
		expect(await revoke("other-application", administratorActor)).toBe(false);
		expect(
			(await store.getCredentialMetadata("credential_revoke_owner"))?.revokedAt,
		).toBeNull();
		expect(await revoke("application_revoke_owner", administratorActor)).toBe(
			true,
		);
	});

	it("isolates credential principals, enforces delivery revocation, and audits writes", async () => {
		await adminClient`truncate platform.audit_events, platform.api_credential_delivery_grants,
			platform.platform_api_credentials, platform.platform_applications cascade`;
		await store.createApplication({
			actor: administratorActor,
			applicationId: "application_identity",
			name: "Identity test application",
			responsibleUserId: "user_owner",
			authorizationRevision: "application_revision_1",
			audit: userAudit,
		});
		const userCredential = await store.issueCredential({
			principal: { kind: "user", id: "application_identity" },
			actor: { ...administratorActor, userId: "application_identity" },
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
				actor: {
					...administratorActor,
					userId: "user_recipient",
					isAdministrator: false,
				},
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
		).rejects.toMatchObject({ code: "resource_unavailable" });
		await store.grantCredentialDelivery({
			actor: administratorActor,
			applicationId: "application_identity",
			principal: { kind: "user", id: "user_recipient" },
			scopes: ["agent:read"],
			expiresAt: null,
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
				actor: administratorActor,
				applicationId: "application_identity",
				principal: { kind: "user", id: "user_recipient" },
				scopes: ["agent:read"],
				expiresAt: null,
				authorizationRevision: "application_revision_1",
				audit: {
					...userAudit,
					action: "api.credential.delivery.granted",
				},
			}),
		).rejects.toThrow("Application delivery authorization is stale");
		await expect(
			store.issueCredential({
				actor: {
					...administratorActor,
					userId: "user_recipient",
					isAdministrator: false,
				},
				principal: { kind: "application", id: "application_identity" },
				credential: "stale-delivery-secret",
				recipient: { kind: "user", id: "user_recipient" },
				scopes: ["agent:read"],
				expiresAt: null,
				audit: { ...userAudit, action: "api.credential.issued" },
			}),
		).rejects.toMatchObject({ code: "resource_unavailable" });
		await store.grantCredentialDelivery({
			actor: administratorActor,
			applicationId: "application_identity",
			principal: { kind: "user", id: "user_recipient" },
			scopes: ["agent:read"],
			expiresAt: null,
			authorizationRevision: "application_revision_2",
			audit: { ...userAudit, action: "api.credential.delivery.granted" },
		});
		const disabledRecipientStore = new PostgresApiIdentityStoreV1({
			databaseUrl,
			resolveUser: async (userId) => ({
				schemaVersion: 1,
				userId,
				accountStatus: "disabled",
				organizationIds: [],
				authorizationRevision: "user_revision_2",
			}),
		});
		try {
			await expect(
				disabledRecipientStore.issueCredential({
					actor: {
						...administratorActor,
						userId: "user_recipient",
						isAdministrator: false,
					},
					principal: { kind: "application", id: "application_identity" },
					credential: "disabled-recipient-secret",
					recipient: { kind: "user", id: "user_recipient" },
					scopes: ["agent:read"],
					expiresAt: null,
					audit: { ...userAudit, action: "api.credential.issued" },
				}),
			).rejects.toMatchObject({ code: "resource_unavailable" });
			await expect(
				disabledRecipientStore.grantCredentialDelivery({
					actor: administratorActor,
					applicationId: "application_identity",
					principal: { kind: "user", id: "user_recipient" },
					scopes: ["agent:manage"],
					expiresAt: null,
					authorizationRevision: "application_revision_2",
					audit: { ...userAudit, action: "api.credential.delivery.granted" },
				}),
			).rejects.toThrow("Application delivery authorization is stale");
		} finally {
			await disabledRecipientStore.close();
		}
		await expect(
			store.issueCredential({
				actor: {
					...administratorActor,
					userId: "user_recipient",
					isAdministrator: false,
				},
				principal: { kind: "application", id: "application_identity" },
				credential: "unapproved-scope-secret",
				recipient: { kind: "user", id: "user_recipient" },
				scopes: ["agent:manage"],
				expiresAt: null,
				audit: { ...userAudit, action: "api.credential.issued" },
			}),
		).rejects.toMatchObject({ code: "resource_unavailable" });
		const applicationCredential = await store.issueCredential({
			actor: {
				...administratorActor,
				userId: "user_recipient",
				isAdministrator: false,
			},
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
		expect(
			await store.hasCredentialDelivery({
				applicationId: "application_identity",
				principal: { kind: "user", id: "user_recipient" },
			}),
		).toBe(false);
		await expect(
			store.issueCredential({
				actor: {
					...administratorActor,
					userId: "user_recipient",
					isAdministrator: false,
				},
				principal: { kind: "application", id: "application_identity" },
				credential: "second-claim-secret",
				recipient: { kind: "user", id: "user_recipient" },
				scopes: ["agent:read"],
				expiresAt: null,
				audit: { ...userAudit, action: "api.credential.issued" },
			}),
		).rejects.toMatchObject({ code: "resource_unavailable" });

		const applicationCredentials = await store.listCredentials({
			applicationId: "application_identity",
		});
		expect(
			await store.resolveApplicationCredential("application-secret-value"),
		).toMatchObject({ accountStatus: "active" });
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
				actor: administratorActor,
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
			await store.resolveCredential("application-secret-value"),
		).toMatchObject({
			credentialId: applicationCredential.credentialId,
			revokedAt: expect.any(Date),
		});
		expect(
			await store.resolveApplicationCredential("application-secret-value"),
		).toMatchObject({ accountStatus: "disabled" });

		const audits = await adminClient`
			select action
			from platform.audit_events
			order by occurred_at desc, id desc
			limit 20
		`;
		expect(audits.map(({ action }) => action)).toEqual([
			"api.credential.delivery.revoked",
			"api.credential.issued",
			"api.credential.delivery.granted",
			"api.credential.delivery.granted",
			"api.credential.issued",
			"api.application.created",
		]);
		expect(userCredential.metadata).not.toHaveProperty("credential");
	});

	it("rechecks the responsible user before delivery grant changes", async () => {
		await adminClient`truncate platform.audit_events, platform.api_credential_delivery_grants,
			platform.platform_api_credentials, platform.platform_applications cascade`;
		await store.createApplication({
			actor: administratorActor,
			applicationId: "application_owner_change",
			name: "Owner change application",
			responsibleUserId: "user_owner",
			authorizationRevision: "application_revision_1",
			audit: userAudit,
		});
		const owner = { ...administratorActor, isAdministrator: false };
		await adminClient`update platform.platform_applications
			set responsible_user_id = 'user_other'
			where id = 'application_owner_change'`;
		await expect(
			store.grantCredentialDelivery({
				actor: owner,
				applicationId: "application_owner_change",
				principal: { kind: "user", id: "user_recipient" },
				scopes: ["agent:manage"],
				expiresAt: null,
				authorizationRevision: "application_revision_1",
				audit: { ...userAudit, action: "api.credential.delivery.granted" },
			}),
		).rejects.toThrow("Application delivery authorization is stale");
		expect(
			await store.hasCredentialDelivery({
				applicationId: "application_owner_change",
				principal: { kind: "user", id: "user_recipient" },
			}),
		).toBe(false);
		await store.grantCredentialDelivery({
			actor: administratorActor,
			applicationId: "application_owner_change",
			principal: { kind: "user", id: "user_recipient" },
			scopes: ["agent:read"],
			expiresAt: null,
			authorizationRevision: "application_revision_1",
			audit: { ...userAudit, action: "api.credential.delivery.granted" },
		});
		expect(
			await store.revokeCredentialDelivery({
				actor: owner,
				applicationId: "application_owner_change",
				principal: { kind: "user", id: "user_recipient" },
				audit: { ...userAudit, action: "api.credential.delivery.revoked" },
			}),
		).toBe(false);
		expect(
			await store.hasCredentialDelivery({
				applicationId: "application_owner_change",
				principal: { kind: "user", id: "user_recipient" },
			}),
		).toBe(true);
	});

	it("revokes issued recipient credentials when replacing a delivery grant", async () => {
		await adminClient`truncate platform.audit_events, platform.api_credential_delivery_grants,
			platform.platform_api_credentials, platform.platform_applications cascade`;
		await store.createApplication({
			actor: administratorActor,
			applicationId: "application_regrant",
			name: "Regrant application",
			responsibleUserId: "user_owner",
			authorizationRevision: "application_revision_1",
			audit: userAudit,
		});
		const delivery = {
			actor: administratorActor,
			applicationId: "application_regrant",
			principal: { kind: "user" as const, id: "user_recipient" },
			expiresAt: null,
			authorizationRevision: "application_revision_1",
			audit: {
				...userAudit,
				action: "api.credential.delivery.granted" as const,
			},
		};
		await store.grantCredentialDelivery({
			...delivery,
			scopes: ["agent:read", "agent:manage"],
		});
		await store.issueCredential({
			actor: {
				...administratorActor,
				userId: delivery.principal.id,
				isAdministrator: false,
			},
			principal: { kind: "application", id: "application_regrant" },
			recipient: delivery.principal,
			credential: "old-regrant-secret",
			scopes: ["agent:read", "agent:manage"],
			expiresAt: null,
			audit: { ...userAudit, action: "api.credential.issued" },
		});
		await store.grantCredentialDelivery({
			...delivery,
			scopes: ["agent:read"],
		});
		expect(
			await store.resolveApplicationCredential("old-regrant-secret"),
		).toMatchObject({ accountStatus: "disabled" });
		await expect(
			store.issueCredential({
				actor: {
					...administratorActor,
					userId: delivery.principal.id,
					isAdministrator: false,
				},
				principal: { kind: "application", id: "application_regrant" },
				recipient: delivery.principal,
				credential: "over-scoped-regrant-secret",
				scopes: ["agent:read", "agent:manage"],
				expiresAt: null,
				audit: { ...userAudit, action: "api.credential.issued" },
			}),
		).rejects.toMatchObject({ code: "resource_unavailable" });
		await store.issueCredential({
			actor: {
				...administratorActor,
				userId: delivery.principal.id,
				isAdministrator: false,
			},
			principal: { kind: "application", id: "application_regrant" },
			recipient: delivery.principal,
			credential: "new-regrant-secret",
			scopes: ["agent:read"],
			expiresAt: null,
			audit: { ...userAudit, action: "api.credential.issued" },
		});
		expect(
			await store.resolveApplicationCredential("new-regrant-secret"),
		).toMatchObject({ accountStatus: "active" });
	});

	it("locks the delivery grant before persisting an application credential", async () => {
		await adminClient`truncate platform.audit_events, platform.api_credential_delivery_grants,
			platform.platform_api_credentials, platform.platform_applications cascade`;
		await store.createApplication({
			actor: administratorActor,
			applicationId: "application_delivery_lock",
			name: "Delivery lock application",
			responsibleUserId: "user_owner",
			authorizationRevision: "application_revision_1",
			audit: userAudit,
		});
		await store.grantCredentialDelivery({
			actor: administratorActor,
			applicationId: "application_delivery_lock",
			principal: { kind: "user", id: "user_recipient" },
			scopes: ["agent:read"],
			expiresAt: null,
			authorizationRevision: "application_revision_1",
			audit: { ...userAudit, action: "api.credential.delivery.granted" },
		});
		const blocker = postgres(databaseUrl, { max: 1 });
		let release: (() => void) | undefined;
		let markLocked: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const locked = new Promise<void>((resolve) => {
			markLocked = resolve;
		});
		const revoke = blocker.begin(async (transaction) => {
			await transaction`
				select application_id from platform.api_credential_delivery_grants
				where application_id = 'application_delivery_lock' for update
			`;
			markLocked?.();
			await held;
			await transaction`
				update platform.api_credential_delivery_grants set revoked_at = now()
				where application_id = 'application_delivery_lock'
			`;
		});
		let issue: Promise<unknown> | undefined;
		try {
			await locked;
			issue = store.issueCredential({
				actor: {
					...administratorActor,
					userId: "user_recipient",
					isAdministrator: false,
				},
				principal: { kind: "application", id: "application_delivery_lock" },
				recipient: { kind: "user", id: "user_recipient" },
				credential: "concurrent-delivery-secret",
				scopes: ["agent:read"],
				expiresAt: null,
				audit: { ...userAudit, action: "api.credential.issued" },
			});
			await waitForBlockedQuery(["api_credential_delivery_grants"]);
			release?.();
			await revoke;
			await expect(issue).rejects.toMatchObject({
				code: "resource_unavailable",
			});
			expect(
				await store.listCredentials({
					applicationId: "application_delivery_lock",
				}),
			).toEqual([]);
		} finally {
			release?.();
			await Promise.allSettled([revoke, ...(issue ? [issue] : [])]);
			await blocker.end();
		}
	});

	it("advances the Agent authorization revision with a new grant", async () => {
		await adminClient`truncate platform.audit_events, platform.agent_principal_grants,
			platform.agents cascade`;
		await adminClient`
			insert into platform.agents (id, authorization_revision)
			values ('agent_grant_revision', 'authorization_revision_1')
		`;
		await adminClient`
			insert into platform.platform_applications
				(id, name, responsible_user_id, authorization_revision)
			values ('new-app', 'New app', 'user_owner', 'application_revision_1')
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

	it("rejects old manage grants at a null Agent revision without blocking owner or administrator initialization", async () => {
		await adminClient`truncate platform.audit_events, platform.agent_principal_grants,
			platform.platform_api_credentials, platform.agents cascade`;
		await adminClient`
			insert into platform.agents (id, authorization_revision)
			values ('agent_null_grant', null), ('agent_null_admin', null)
		`;
		await adminClient`
			insert into platform.platform_api_credentials
				(id, principal_type, principal_id, credential_hash, scopes)
			values ('credential_null_manager', 'user', 'user_null_manager',
				repeat('a', 64), '["agent:manage"]'::jsonb)
		`;
		await adminClient`
			insert into platform.agent_principal_grants
				(agent_id, principal_type, principal_id, grant_type, authorization_revision)
			values ('agent_null_grant', 'user', 'user_null_manager', 'manage',
				'old_revision'),
				('agent_null_grant', 'user', 'user_target', 'use', 'old_revision')
		`;
		const principal = { kind: "user" as const, id: "user_null_manager" };
		const actor = {
			schemaVersion: 1 as const,
			userId: principal.id,
			accountStatus: "active" as const,
			principal,
			identityRevision: "directory_revision_1",
			isAdministrator: false,
			credential: {
				credentialId: "credential_null_manager",
				principal,
				scopes: ["agent:manage"] as const,
				expiresAt: null,
				revokedAt: null,
			},
		};
		const currentStore = new PostgresApiIdentityStoreV1({
			databaseUrl,
			resolveUser: async (userId) => ({
				schemaVersion: 1,
				userId,
				accountStatus: "active",
				organizationIds: [],
				authorizationRevision: "directory_revision_1",
			}),
		});
		try {
			await expect(
				currentStore.grantAgent({
					actor,
					agentId: "agent_null_grant",
					principal: { kind: "user", id: "user_new_target" },
					grantType: "use",
					authorizationRevision: "new_revision",
				}),
			).resolves.toBe(false);
			await expect(
				currentStore.revokeAgentGrant({
					actor,
					agentId: "agent_null_grant",
					principal: { kind: "user", id: "user_target" },
					grantType: "use",
				}),
			).resolves.toBe(false);
			const [agent] = await adminClient`
				select authorization_revision from platform.agents
				where id = 'agent_null_grant'
			`;
			const grants = await adminClient`
				select principal_id, authorization_revision, revoked_at
				from platform.agent_principal_grants
				where agent_id = 'agent_null_grant' order by principal_id
			`;
			expect(agent?.authorization_revision).toBeNull();
			expect(grants).toEqual([
				{
					principal_id: "user_null_manager",
					authorization_revision: "old_revision",
					revoked_at: null,
				},
				{
					principal_id: "user_target",
					authorization_revision: "old_revision",
					revoked_at: null,
				},
			]);
			await adminClient`
				insert into platform.agent_owners (agent_id, owner_id, created_at)
				values ('agent_null_grant', 'user_owner', now())
			`;
			await expect(
				store.grantAgent({
					actor: { ...administratorActor, isAdministrator: false },
					agentId: "agent_null_grant",
					principal: { kind: "user", id: "user_owner_target" },
					grantType: "use",
					authorizationRevision: "owner_revision",
				}),
			).resolves.toBe(true);
			await expect(
				store.grantAgent({
					actor: administratorActor,
					agentId: "agent_null_admin",
					principal: { kind: "user", id: "user_admin_target" },
					grantType: "use",
					authorizationRevision: "admin_revision",
				}),
			).resolves.toBe(true);
			const initialized = await adminClient`
				select id, authorization_revision from platform.agents
				where id in ('agent_null_grant', 'agent_null_admin') order by id
			`;
			expect(initialized).toEqual([
				{ id: "agent_null_admin", authorization_revision: "admin_revision" },
				{ id: "agent_null_grant", authorization_revision: "owner_revision" },
			]);
		} finally {
			await currentStore.close();
		}
	});

	it("rechecks a user API actor's current directory revision before grant writes", async () => {
		await adminClient`truncate platform.audit_events, platform.agent_principal_grants,
			platform.platform_api_credentials, platform.agents cascade`;
		await adminClient`
			insert into platform.agents (id, authorization_revision)
			values ('agent_user_grant', 'agent_revision_1')
		`;
		await adminClient`
			insert into platform.platform_api_credentials
				(id, principal_type, principal_id, credential_hash, scopes)
			values ('credential_user_grant', 'user', 'user_manager',
				repeat('a', 64), '["agent:manage"]'::jsonb)
		`;
		await adminClient`
			insert into platform.agent_principal_grants
				(agent_id, principal_type, principal_id, grant_type, authorization_revision)
			values ('agent_user_grant', 'user', 'user_manager', 'manage',
				'agent_revision_1')
		`;
		const principal = { kind: "user" as const, id: "user_manager" };
		const actor = {
			schemaVersion: 1 as const,
			userId: "user_manager",
			accountStatus: "active" as const,
			principal,
			identityRevision: "directory_revision_1",
			isAdministrator: false,
			credential: {
				credentialId: "credential_user_grant",
				principal,
				scopes: ["agent:manage"] as const,
				expiresAt: null,
				revokedAt: null,
			},
		};
		let accountStatus: "active" | "disabled" = "active";
		let directoryRevision = "directory_revision_1";
		const userStore = new PostgresApiIdentityStoreV1({
			databaseUrl,
			resolveUser: async (userId) => ({
				schemaVersion: 1,
				userId,
				accountStatus,
				organizationIds: [],
				authorizationRevision: directoryRevision,
			}),
		});
		const grant = (authorizationRevision: string) =>
			userStore.grantAgent({
				actor,
				agentId: "agent_user_grant",
				principal: { kind: "user", id: "user_recipient" },
				grantType: "use",
				authorizationRevision,
			});
		try {
			await expect(grant("agent_revision_2")).resolves.toBe(true);
			accountStatus = "disabled";
			await expect(grant("agent_revision_3")).resolves.toBe(false);
			await expect(
				userStore.revokeAgentGrant({
					actor,
					agentId: "agent_user_grant",
					principal: { kind: "user", id: "user_recipient" },
					grantType: "use",
				}),
			).resolves.toBe(false);
			accountStatus = "active";
			directoryRevision = "directory_revision_2";
			await expect(grant("agent_revision_4")).resolves.toBe(false);
			const [agent] = await adminClient`
				select authorization_revision from platform.agents
				where id = 'agent_user_grant'
			`;
			const [recipient] = await adminClient`
				select authorization_revision, revoked_at
				from platform.agent_principal_grants
				where agent_id = 'agent_user_grant' and principal_id = 'user_recipient'
			`;
			expect(agent?.authorization_revision).toBe("agent_revision_2");
			expect(recipient).toEqual({
				authorization_revision: "agent_revision_2",
				revoked_at: null,
			});
		} finally {
			await userStore.close();
		}
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
			values ('recipient-app', 'Recipient', 'user_owner', 'application_revision_1')
		`;
		await adminClient`
			insert into platform.platform_applications
				(id, name, responsible_user_id, authorization_revision)
			values ('manager-app', 'Manager', 'user_owner', 'revision_1')
		`;
		await adminClient`
			insert into platform.platform_api_credentials
				(id, principal_type, principal_id, credential_hash, scopes, recipient_user_id)
			values ('credential_manager', 'application', 'manager-app',
				repeat('a', 64), '["agent:manage"]'::jsonb, 'user_recipient')
		`;
		await adminClient`
			insert into platform.api_credential_delivery_grants
				(application_id, principal_type, principal_id, authorization_revision)
			values ('manager-app', 'user', 'user_recipient', 'revision_1')
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
			identityRevision: "revision_1",
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
		await adminClient`
			update platform.platform_applications
			set authorization_revision = 'application_revision_2'
			where id = 'manager-app'
		`;
		await expect(grant("revision_stale_app")).resolves.toBe(false);
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
		await expect(
			store.revokeCredential({
				actor: administratorActor,
				principal: { kind: "application", id: "manager-app" },
				credentialId: "credential_manager",
				revokedAt: new Date(),
				audit: { ...userAudit, action: "api.credential.revoked" },
			}),
		).resolves.toBe(true);
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

	it("serializes application grant writes with delivery revocation", async () => {
		await adminClient`truncate platform.audit_events,
			platform.agent_principal_grants, platform.api_credential_delivery_grants,
			platform.platform_api_credentials, platform.platform_applications,
			platform.agents cascade`;
		await adminClient`
			insert into platform.agents (id, authorization_revision)
			values ('agent_delivery_race', 'agent_revision_1')
		`;
		await adminClient`
			insert into platform.platform_applications
				(id, name, responsible_user_id, authorization_revision)
			values ('delivery-race-app', 'Delivery race', 'user_owner', 'app_revision_1')
		`;
		await adminClient`
			insert into platform.api_credential_delivery_grants
				(application_id, principal_type, principal_id, authorization_revision)
			values ('delivery-race-app', 'user', 'user_recipient', 'app_revision_1')
		`;
		await adminClient`
			insert into platform.platform_api_credentials
				(id, principal_type, principal_id, credential_hash, scopes, recipient_user_id)
			values ('credential_delivery_race', 'application', 'delivery-race-app',
				repeat('d', 64), '["agent:manage"]'::jsonb, 'user_recipient')
		`;
		await adminClient`
			insert into platform.agent_principal_grants
				(agent_id, principal_type, principal_id, grant_type, authorization_revision)
			values ('agent_delivery_race', 'application', 'delivery-race-app',
				'manage', 'agent_revision_1')
		`;
		const principal = { kind: "application" as const, id: "delivery-race-app" };
		const actor = {
			schemaVersion: 1 as const,
			userId: "user_owner",
			accountStatus: "active" as const,
			principal,
			identityRevision: "app_revision_1",
			isAdministrator: false,
			credential: {
				credentialId: "credential_delivery_race",
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
		const revoke = blocker.begin(async (transaction) => {
			await transaction`
				update platform.api_credential_delivery_grants set revoked_at = now()
				where application_id = 'delivery-race-app'
					and principal_id = 'user_recipient'
			`;
			markLocked?.();
			await held;
		});
		let pending: Promise<boolean> | undefined;
		try {
			await locked;
			pending = store.grantAgent({
				actor,
				agentId: "agent_delivery_race",
				principal: { kind: "user", id: "user_other" },
				grantType: "use",
				authorizationRevision: "agent_revision_2",
			});
			await waitForBlockedQuery(["api_credential_delivery_grants"]);
			release?.();
			await revoke;
			expect(await pending).toBe(false);
			expect(
				await adminClient`
					select principal_id from platform.agent_principal_grants
					where agent_id = 'agent_delivery_race' and principal_id = 'user_other'
				`,
			).toEqual([]);
		} finally {
			release?.();
			await revoke.catch(() => undefined);
			await pending?.catch(() => undefined);
			await blocker.end();
		}
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
					(id, principal_type, principal_id, credential_hash, scopes, recipient_user_id)
				values ('credential_lock', 'application', 'manager-lock-app',
					repeat('e', 64), '["agent:manage"]'::jsonb, 'user_recipient')
			`;
			await adminClient`
				insert into platform.api_credential_delivery_grants
					(application_id, principal_type, principal_id, authorization_revision)
				values ('manager-lock-app', 'user', 'user_recipient', 'app-lock-1')
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
				identityRevision: "app-lock-1",
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

	it("serializes an application recipient disablement against grant", async () => {
		await adminClient`truncate platform.audit_events,
			platform.agent_principal_grants, platform.platform_api_credentials,
			platform.platform_applications, platform.agents cascade`;
		await adminClient`
			insert into platform.agents (id, authorization_revision)
			values ('agent_recipient_lock', 'revision_recipient_1')
		`;
		await adminClient`
			insert into platform.platform_applications
				(id, name, responsible_user_id, status, authorization_revision)
			values
				('manager-recipient-lock', 'Manager', 'user_owner', 'active', 'manager-app-1'),
				('recipient-recipient-lock', 'Recipient', 'user_owner', 'active', 'recipient-app-1')
		`;
		await adminClient`
			insert into platform.platform_api_credentials
				(id, principal_type, principal_id, credential_hash, scopes, recipient_user_id)
			values ('credential_recipient_lock', 'application', 'manager-recipient-lock',
				repeat('f', 64), '["agent:manage"]'::jsonb, 'user_recipient')
		`;
		await adminClient`
			insert into platform.api_credential_delivery_grants
				(application_id, principal_type, principal_id, authorization_revision)
			values ('manager-recipient-lock', 'user', 'user_recipient', 'manager-app-1')
		`;
		await adminClient`
			insert into platform.agent_principal_grants
				(agent_id, principal_type, principal_id, grant_type, authorization_revision)
			values ('agent_recipient_lock', 'application', 'manager-recipient-lock',
				'manage', 'revision_recipient_1')
		`;
		const principal = {
			kind: "application" as const,
			id: "manager-recipient-lock",
		};
		const actor = {
			schemaVersion: 1 as const,
			userId: "user_owner",
			accountStatus: "active" as const,
			principal,
			identityRevision: "manager-app-1",
			isAdministrator: false,
			credential: {
				credentialId: "credential_recipient_lock",
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
				where id = 'recipient-recipient-lock'
			`;
			markLocked?.();
			await held;
		});
		let pending: Promise<boolean> | undefined;
		try {
			await locked;
			pending = store.grantAgent({
				actor,
				agentId: "agent_recipient_lock",
				principal: { kind: "application", id: "recipient-recipient-lock" },
				grantType: "use",
				authorizationRevision: "revision_recipient_2",
			});
			await waitForBlockedQuery(["platform_applications"]);
			release?.();
			await disable;
			expect(await pending).toBe(false);
			const [agent] = await adminClient`
				select authorization_revision from platform.agents
				where id = 'agent_recipient_lock'
			`;
			expect(agent?.authorization_revision).toBe("revision_recipient_1");
			expect(
				await adminClient`
					select principal_id from platform.agent_principal_grants
					where agent_id = 'agent_recipient_lock'
						and principal_id = 'recipient-recipient-lock'
				`,
			).toEqual([]);
		} finally {
			release?.();
			await disable.catch(() => undefined);
			await pending?.catch(() => undefined);
			await blocker.end();
		}
	});

	it("rejects grant writes after an application's responsible user changes", async () => {
		await adminClient`truncate platform.audit_events,
			platform.agent_principal_grants, platform.platform_api_credentials,
			platform.platform_applications, platform.agents cascade`;
		await adminClient`
			insert into platform.agents (id, authorization_revision)
			values ('agent_owner_change', 'revision_owner_1')
		`;
		await adminClient`
			insert into platform.platform_applications
				(id, name, responsible_user_id, status, authorization_revision)
			values ('manager-owner-change', 'Manager', 'user_before', 'active', 'app-owner-1')
		`;
		await adminClient`
			insert into platform.platform_api_credentials
				(id, principal_type, principal_id, credential_hash, scopes, recipient_user_id)
			values ('credential-owner-change', 'application', 'manager-owner-change',
				repeat('b', 64), '["agent:manage"]'::jsonb, 'user_recipient')
		`;
		await adminClient`
			insert into platform.api_credential_delivery_grants
				(application_id, principal_type, principal_id, authorization_revision)
			values ('manager-owner-change', 'user', 'user_recipient', 'app-owner-1')
		`;
		await adminClient`
			insert into platform.agent_principal_grants
				(agent_id, principal_type, principal_id, grant_type, authorization_revision)
			values ('agent_owner_change', 'application', 'manager-owner-change',
				'manage', 'revision_owner_1')
		`;
		await adminClient`
			update platform.platform_applications
			set responsible_user_id = 'user_after'
			where id = 'manager-owner-change'
		`;
		const principal = {
			kind: "application" as const,
			id: "manager-owner-change",
		};
		const actor = {
			schemaVersion: 1 as const,
			userId: "user_before",
			accountStatus: "active" as const,
			principal,
			identityRevision: "app-owner-1",
			isAdministrator: false,
			credential: {
				credentialId: "credential-owner-change",
				principal,
				scopes: ["agent:manage"] as const,
				expiresAt: null,
				revokedAt: null,
			},
		};
		expect(
			await store.grantAgent({
				actor,
				agentId: "agent_owner_change",
				principal: { kind: "application", id: "recipient-owner-change" },
				grantType: "use",
				authorizationRevision: "revision_owner_2",
			}),
		).toBe(false);
		expect(
			await adminClient`
				select authorization_revision from platform.agents
				where id = 'agent_owner_change'
			`,
		).toEqual([{ authorization_revision: "revision_owner_1" }]);
	});

	it("rejects application credential transport at the Store boundary", async () => {
		await adminClient`truncate platform.audit_events,
			platform.api_credential_delivery_grants, platform.platform_api_credentials,
			platform.platform_applications cascade`;
		await store.createApplication({
			actor: administratorActor,
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
				actor: administratorActor,
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
				actor: administratorActor,
				applicationId: "application_transport_boundary",
				principal: { kind: "application", id: "recipient-application" },
				scopes: ["agent:read"],
				expiresAt: null,
				authorizationRevision: "application_revision_1",
				audit: { ...userAudit, action: "api.credential.delivery.granted" },
			}),
		).rejects.toThrow("Application credential transport is unavailable");
		await expect(
			store.revokeCredentialDelivery({
				actor: administratorActor,
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
