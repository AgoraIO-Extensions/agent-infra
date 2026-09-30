import { describe, expect, it, vi } from "vitest";
import type { ApiIdentityAuditInputV1 } from "./api-identity.js";
import {
	type ApiIdentityApplicationV1,
	ApiIdentityError,
	type ApiIdentityStorePortV1,
	createApiIdentityManagementV1,
} from "./api-identity-management.js";

const application: ApiIdentityApplicationV1 = {
	id: "application-1",
	name: "Application",
	responsibleUserId: "owner-1",
	status: "active",
	authorizationRevision: "application-revision-1",
};

const audit: ApiIdentityAuditInputV1 = {
	traceId: "trace-1",
	requestId: "request-1",
	actor: { kind: "user", id: "owner-1" },
	action: "api.credential.delivery.granted",
};

function storeFixture(overrides: Partial<ApiIdentityStorePortV1> = {}) {
	const store: ApiIdentityStorePortV1 = {
		writeAudit: vi.fn(),
		createApplication: vi.fn().mockResolvedValue(application.id),
		getApplication: vi.fn().mockResolvedValue(application),
		listApplications: vi.fn().mockResolvedValue([]),
		issueCredential: vi.fn().mockResolvedValue({
			credentialId: "credential-1",
			metadata: {
				schemaVersion: 1,
				credentialId: "credential-1",
				principal: { kind: "application", id: application.id },
				scopes: ["agent:read"],
				expiresAt: null,
				revokedAt: null,
				createdAt: new Date("2026-09-25T00:00:00Z"),
			},
		}),
		listCredentials: vi.fn().mockResolvedValue([]),
		getCredentialMetadata: vi.fn().mockImplementation(async (credentialId) => ({
			schemaVersion: 1,
			credentialId,
			principal: { kind: "application", id: "application-caller" },
			scopes: ["agent:create", "agent:manage", "agent:use", "agent:read"],
			expiresAt: null,
			revokedAt: null,
			createdAt: new Date("2026-09-25T00:00:00Z"),
		})),
		grantCredentialDelivery: vi.fn(),
		hasCredentialDelivery: vi.fn().mockResolvedValue(true),
		revokeCredentialDelivery: vi.fn().mockResolvedValue(true),
		revokeCredential: vi.fn().mockResolvedValue(true),
		grantAgent: vi.fn().mockResolvedValue(true),
		revokeAgentGrant: vi.fn().mockResolvedValue(true),
		...overrides,
	};
	return store;
}

function actor(
	principal: { kind: "user" | "application"; id: string } = {
		kind: "user",
		id: "owner-1",
	},
) {
	return {
		schemaVersion: 1 as const,
		userId: principal.kind === "user" ? principal.id : "owner-1",
		accountStatus: "active" as const,
		principal,
		isAdministrator: false,
		credential: {
			credentialId: "credential-actor",
			principal,
			scopes: [
				"agent:create",
				"agent:manage",
				"agent:use",
				"agent:read",
			] as const,
			expiresAt: null,
			revokedAt: null,
		},
	};
}

function management(store: ApiIdentityStorePortV1) {
	return createApiIdentityManagementV1({
		store,
		directory: {
			resolveUser: async (userId) => ({
				userId,
				accountStatus: "active",
			}),
		},
		agentAccess: { canManage: async () => true },
		idFactory: () => "authorization-revision-2",
	});
}

describe("API identity management authorization", () => {
	it("returns the application committed for an idempotent request", async () => {
		const store = storeFixture();
		const useCase = management(store);
		const submitted = await useCase.createApplication({
			actor: actor(),
			applicationId: "application-attempt",
			name: "Application",
			authorizationRevision: "revision-attempt",
			idempotencyKey: "application-command-1",
			rawRequestDigest: "a".repeat(64),
			audit: { ...audit, action: "api.application.created" },
		});
		expect(submitted).toEqual(application);
		expect(store.createApplication).toHaveBeenCalledWith(
			expect.objectContaining({
				idempotencyKey: "application-command-1",
				requestDigest: "a".repeat(64),
			}),
		);
		expect(store.getApplication).toHaveBeenCalledWith(application.id);
	});

	it("checks API scopes in Core and resolves query visibility", async () => {
		const useCase = management(storeFixture());
		const apiActor = actor({ kind: "application", id: "application-caller" });
		await expect(
			useCase.authorizeCredentialScope(apiActor, ["agent:manage"]),
		).resolves.toBeUndefined();
		expect(await useCase.resolveAgentQueryGrantType(apiActor)).toBe("any");
		expect(
			await useCase.resolveAgentQueryGrantType({
				...apiActor,
				credential: { ...apiActor.credential, scopes: ["agent:read"] },
			}),
		).toBe("use");
		await expect(
			useCase.authorizeCredentialScope(
				{
					...apiActor,
					credential: {
						credentialId: "credential-actor",
						principal: apiActor.principal,
						scopes: ["agent:read"],
						expiresAt: null,
						revokedAt: null,
					},
				},
				["agent:manage"],
			),
		).rejects.toMatchObject({ code: "not_authorized" });
		await expect(
			useCase.authorizeCredentialScope(
				{
					...apiActor,
					credential: {
						...apiActor.credential,
						scopes: ["agent:read"],
					},
				},
				["agent:read", "agent:manage"],
			),
		).rejects.toMatchObject({ code: "not_authorized" });
		await expect(
			useCase.authorizeCredentialScope(
				{
					...apiActor,
					credential: {
						...apiActor.credential,
						principal: { kind: "application", id: "another-application" },
					},
				},
				["agent:manage"],
			),
		).rejects.toMatchObject({ code: "not_authorized" });
		await expect(
			useCase.resolveAgentQueryGrantType({
				...apiActor,
				credential: undefined,
			}),
		).rejects.toMatchObject({ code: "not_authorized" });
	});

	it("classifies inactive credentials before missing scopes", async () => {
		const store = storeFixture();
		const useCase = management(store);
		const apiActor = actor({ kind: "application", id: "application-caller" });
		const applicationAudit = {
			...audit,
			actor: { kind: "application" as const, id: "application-caller" },
		};
		await expect(
			useCase.authorizeCredentialScope(
				{
					...apiActor,
					credential: {
						...apiActor.credential,
						scopes: ["agent:read"],
						expiresAt: new Date("2020-01-01T00:00:00Z"),
					},
				},
				["agent:create"],
				{
					audit: applicationAudit,
					targetId: "agents",
					reason: "missing_scope",
				},
			),
		).rejects.toMatchObject({ code: "not_authorized" });
		expect(store.writeAudit).toHaveBeenLastCalledWith(
			expect.objectContaining({
				action: "api.access.rejected",
				reason: "invalid_credential",
			}),
		);
	});

	it("rejects expired or revoked actor credentials before management calls", async () => {
		const store = storeFixture();
		const useCase = management(store);
		const apiActor = actor({ kind: "application", id: "application-caller" });
		for (const stale of [
			{ revokedAt: new Date("2026-09-25T00:00:00Z") },
			{ expiresAt: new Date("2020-01-01T00:00:00Z") },
		]) {
			const staleActor = {
				...apiActor,
				credential: { ...apiActor.credential, ...stale },
			};
			await expect(
				useCase.authorizeCredentialScope(staleActor, ["agent:manage"]),
			).rejects.toMatchObject({ code: "not_authorized" });
			await expect(
				useCase.resolveAgentQueryGrantType(staleActor),
			).rejects.toMatchObject({ code: "not_authorized" });
			await expect(
				useCase.grantAgent({
					actor: staleActor,
					agentId: "agent-1",
					principal: { kind: "user", id: "recipient-1" },
					grantType: "use",
					audit: {
						...audit,
						actor: apiActor.principal,
						action: "api.agent.grant.granted",
					},
				}),
			).rejects.toMatchObject({ code: "not_authorized" });
		}
		expect(store.grantAgent).not.toHaveBeenCalled();
	});

	it("rereads credential state before authorizing a scope", async () => {
		for (const stale of [
			{ revokedAt: new Date("2026-09-30T00:00:00Z") },
			{ expiresAt: new Date("2020-01-01T00:00:00Z") },
		]) {
			const current = {
				schemaVersion: 1 as const,
				credentialId: "credential-actor",
				principal: { kind: "application" as const, id: "application-caller" },
				scopes: ["agent:manage"] as const,
				expiresAt: null,
				revokedAt: null,
				createdAt: new Date("2026-09-25T00:00:00Z"),
				...stale,
			};
			const store = storeFixture({
				getCredentialMetadata: vi.fn().mockResolvedValue(current),
			});
			const useCase = management(store);
			await expect(
				useCase.authorizeCredentialScope(
					actor({ kind: "application", id: "application-caller" }),
					["agent:manage"],
				),
			).rejects.toMatchObject({ code: "not_authorized" });
			expect(store.getCredentialMetadata).toHaveBeenCalledWith(
				"credential-actor",
			);
		}
	});

	it("audits rejected scope and query authorization in the same API audit port", async () => {
		const store = storeFixture();
		const useCase = management(store);
		const applicationAudit = {
			...audit,
			actor: { kind: "application" as const, id: "application-caller" },
		};
		await expect(
			useCase.authorizeCredentialScope(
				{
					...actor({ kind: "application", id: "application-caller" }),
					credential: {
						...actor({ kind: "application", id: "application-caller" })
							.credential,
						scopes: ["agent:read"],
					},
				},
				["agent:create"],
				{
					audit: applicationAudit,
					targetId: "agents",
					reason: "missing_scope",
				},
			),
		).rejects.toMatchObject({ code: "not_authorized" });
		expect(store.writeAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "api.access.rejected",
				targetId: "agents",
				outcome: "rejected",
				reason: "missing_scope",
				requiredScopes: ["agent:create"],
			}),
		);
		await useCase.recordAccessRejection?.(actor(), {
			audit,
			targetId: "agent-1",
			reason: "operation_forbidden",
		});
		expect(store.writeAudit).toHaveBeenLastCalledWith(
			expect.objectContaining({
				action: "api.access.rejected",
				targetId: "agent-1",
				reason: "operation_forbidden",
			}),
		);
	});

	it("rejects disabled or missing recipients before granting delivery", async () => {
		const store = storeFixture();
		const resolveUser = vi
			.fn()
			.mockResolvedValueOnce({
				userId: "recipient-1",
				accountStatus: "disabled",
			})
			.mockResolvedValueOnce(null);
		const useCase = createApiIdentityManagementV1({
			store,
			directory: { resolveUser },
			agentAccess: { canManage: async () => true },
			idFactory: () => "revision",
		});

		for (const recipient of ["recipient-1", "missing-user"]) {
			await expect(
				useCase.grantCredentialDelivery({
					actor: actor(),
					applicationId: application.id,
					principal: { kind: "user", id: recipient },
					scopes: ["agent:read"],
					expiresAt: null,
					audit,
				}),
			).rejects.toMatchObject({ code: "resource_unavailable" });
		}
		expect(store.grantCredentialDelivery).not.toHaveBeenCalled();
		expect(store.writeAudit).toHaveBeenCalledTimes(2);
		expect(store.writeAudit).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				actor: { kind: "user", id: "owner-1" },
				recipient: { kind: "user", id: "recipient-1" },
				outcome: "rejected",
			}),
		);
	});

	it("does not let the responsible user self-authorize credential delivery", async () => {
		const store = storeFixture();
		const useCase = management(store);
		await expect(
			useCase.grantCredentialDelivery({
				actor: actor(),
				applicationId: application.id,
				principal: { kind: "user", id: "owner-1" },
				scopes: ["agent:read"],
				expiresAt: null,
				audit,
			}),
		).rejects.toMatchObject({ code: "not_authorized" });
		expect(store.grantCredentialDelivery).not.toHaveBeenCalled();
	});

	it("rechecks delivery authorization and audits a rejected issue", async () => {
		const store = storeFixture({
			hasCredentialDelivery: vi.fn().mockResolvedValue(false),
		});
		const useCase = management(store);
		await expect(
			useCase.issueApplicationCredential(actor(), application.id, {
				credential: "secret-value",
				recipient: { kind: "user", id: "owner-1" },
				scopes: ["agent:read"],
				expiresAt: null,
				audit: { ...audit, action: "api.credential.issued" },
			}),
		).rejects.toMatchObject({ code: "resource_unavailable" });
		expect(store.issueCredential).not.toHaveBeenCalled();
		expect(store.writeAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "api.credential.issued",
				recipient: { kind: "user", id: "owner-1" },
				outcome: "rejected",
				targetId: application.id,
			}),
		);
	});

	it("lets an authorized recipient issue and receive its own application credential", async () => {
		const store = storeFixture({
			hasCredentialDelivery: vi.fn().mockResolvedValue(true),
		});
		const useCase = management(store);
		const recipient = actor({ kind: "user", id: "recipient-1" });
		const result = await useCase.issueApplicationCredential(
			recipient,
			application.id,
			{
				credential: "recipient-secret",
				recipient: { kind: "user", id: "recipient-1" },
				scopes: ["agent:read"],
				expiresAt: null,
				audit: {
					...audit,
					actor: { kind: "user", id: "recipient-1" },
					action: "api.credential.issued",
				},
			},
		);
		expect(result.credentialId).toBe("credential-1");
		expect(store.issueCredential).toHaveBeenCalledWith(
			expect.objectContaining({
				principal: { kind: "application", id: application.id },
				recipient: { kind: "user", id: "recipient-1" },
			}),
		);
	});

	it("rejects other-user issuance even for a responsible user or administrator", async () => {
		const store = storeFixture();
		const useCase = management(store);
		for (const caller of [actor(), { ...actor(), isAdministrator: true }]) {
			await expect(
				useCase.issueApplicationCredential(caller, application.id, {
					credential: "undeliverable-secret",
					recipient: { kind: "user", id: "recipient-1" },
					scopes: ["agent:read"],
					expiresAt: null,
					audit: { ...audit, action: "api.credential.issued" },
				}),
			).rejects.toMatchObject({ code: "resource_unavailable" });
		}
		expect(store.issueCredential).not.toHaveBeenCalled();
		expect(store.writeAudit).toHaveBeenCalledTimes(2);
		expect(store.writeAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "rejected",
				recipient: { kind: "user", id: "recipient-1" },
			}),
		);
	});

	it("rejects application recipients until a trusted transport exists", async () => {
		const store = storeFixture();
		const useCase = management(store);
		await expect(
			useCase.issueApplicationCredential(actor(), application.id, {
				credential: "application-secret",
				recipient: { kind: "application", id: application.id },
				scopes: ["agent:read"],
				expiresAt: null,
				audit: { ...audit, action: "api.credential.issued" },
			}),
		).rejects.toMatchObject({ code: "resource_unavailable" });
		expect(store.issueCredential).not.toHaveBeenCalled();
		expect(store.writeAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				recipient: { kind: "application", id: application.id },
				outcome: "rejected",
				targetId: application.id,
			}),
		);
	});

	it("audits rejected delivery grant and revoke attempts", async () => {
		const store = storeFixture({
			revokeCredentialDelivery: vi.fn().mockResolvedValue(false),
		});
		const useCase = management(store);
		await expect(
			useCase.grantCredentialDelivery({
				actor: actor(),
				applicationId: application.id,
				principal: { kind: "user", id: "owner-1" },
				scopes: ["agent:read"],
				expiresAt: null,
				audit,
			}),
		).rejects.toMatchObject({ code: "not_authorized" });
		await expect(
			useCase.revokeCredentialDelivery({
				actor: actor(),
				applicationId: application.id,
				principal: { kind: "user", id: "recipient-1" },
				audit: { ...audit, action: "api.credential.delivery.revoked" },
			}),
		).rejects.toMatchObject({ code: "resource_unavailable" });
		expect(store.writeAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "api.credential.delivery.revoked",
				recipient: { kind: "user", id: "recipient-1" },
				outcome: "rejected",
				targetId: application.id,
			}),
		);
	});

	it("binds application actors to grant audits and validates recipients", async () => {
		const store = storeFixture();
		const useCase = management(store);
		const grantAudit: ApiIdentityAuditInputV1 = {
			traceId: "trace-2",
			requestId: "request-2",
			actor: { kind: "application", id: "application-caller" },
			action: "api.agent.grant.granted",
		};
		await useCase.grantAgent({
			actor: actor({ kind: "application", id: "application-caller" }),
			agentId: "agent-1",
			principal: { kind: "user", id: "recipient-1" },
			grantType: "use",
			audit: grantAudit,
		});
		expect(store.grantAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				principal: { kind: "user", id: "recipient-1" },
				audit: expect.objectContaining({
					actor: { kind: "application", id: "application-caller" },
					grantType: "use",
				}),
			}),
		);
	});

	it("audits a grant rejected by the Store's current-authority check", async () => {
		const store = storeFixture({
			grantAgent: vi.fn().mockResolvedValue(false),
		});
		await expect(
			management(store).grantAgent({
				actor: actor({ kind: "application", id: "application-caller" }),
				agentId: "agent-1",
				principal: { kind: "user", id: "recipient-1" },
				grantType: "use",
				audit: {
					...audit,
					actor: { kind: "application", id: "application-caller" },
					action: "api.agent.grant.granted",
				},
			}),
		).rejects.toMatchObject({ code: "resource_unavailable" });
		expect(store.writeAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "api.agent.grant.granted",
				outcome: "rejected",
				targetId: "agent-1",
				recipient: { kind: "user", id: "recipient-1" },
			}),
		);
	});

	it("audits rejected Agent grant authorization attempts", async () => {
		const store = storeFixture();
		const useCase = management(store);
		const restrictedActor = {
			...actor(),
			credential: {
				...actor().credential,
				scopes: ["agent:read"] as const,
			},
		};
		await expect(
			useCase.grantAgent({
				actor: restrictedActor,
				agentId: "agent-1",
				principal: { kind: "user", id: "recipient-1" },
				grantType: "use",
				audit: {
					...audit,
					action: "api.agent.grant.granted",
				},
			}),
		).rejects.toMatchObject({ code: "not_authorized" });
		expect(store.writeAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "api.agent.grant.granted",
				recipient: { kind: "user", id: "recipient-1" },
				grantType: "use",
				outcome: "rejected",
				targetId: "agent-1",
			}),
		);
		expect(store.grantAgent).not.toHaveBeenCalled();
	});

	it("fails closed for a disabled actor", async () => {
		const useCase = management(storeFixture());
		await expect(
			useCase.listUserCredentials({ ...actor(), accountStatus: "disabled" }),
		).rejects.toBeInstanceOf(ApiIdentityError);
	});
});
