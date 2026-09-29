import { PilotProtocolErrorV1Schema } from "@agent-infra/contracts/pilot";
import { describe, expect, it, vi } from "vitest";

import { createPlatformApp, createPlatformHealthApp } from "./app";

describe("platform API health", () => {
	it("reports the service as ready", async () => {
		const response = await createPlatformHealthApp().request("/healthz");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			service: "platform-api",
			status: "ok",
		});
	});

	it("serializes unexpected failures without private details", async () => {
		const app = createPlatformHealthApp();
		app.get("/failure", () => {
			throw new Error("private failure");
		});

		const response = await app.request("/failure");

		expect(response.status).toBe(500);
		const body = await response.json();
		expect(PilotProtocolErrorV1Schema.parse(body)).toMatchObject({
			code: "INTERNAL_ERROR",
			retryable: true,
		});
		expect(JSON.stringify(body)).not.toContain("private failure");
	});
});

describe("platform API production assembly routes", () => {
	it("mounts identity management while retiring the old Agent URIs", async () => {
		const identity = {
			schemaVersion: 1 as const,
			userId: "owner-1",
			displayName: "Owner",
			accountStatus: "active" as const,
			organizationIds: ["org-1"],
			roles: ["employee"] as const,
			authorizationRevision: "owner-revision-1",
		};
		const resolve = vi.fn().mockResolvedValue(identity);
		const issueUserCredential = vi.fn().mockResolvedValue({
			metadata: {
				schemaVersion: 1,
				credentialId: "credential-owner-1",
				principal: { kind: "user", id: "owner-1" },
				scopes: ["agent:create"],
				expiresAt: null,
				revokedAt: null,
				createdAt: new Date("2026-09-30T00:00:00Z"),
			},
		});
		const createApplication = vi.fn().mockResolvedValue({
			id: "application-1",
			name: "Native application",
			responsibleUserId: "owner-1",
			status: "active",
			authorizationRevision: "application-revision-1",
		});
		const grantCredentialDelivery = vi.fn().mockResolvedValue(undefined);
		const apiIdentity = {
			listUserCredentials: vi.fn().mockResolvedValue([]),
			issueUserCredential,
			revokeUserCredential: vi.fn(),
			listApplications: vi.fn().mockResolvedValue([]),
			createApplication,
			listApplicationCredentials: vi.fn().mockResolvedValue([]),
			issueApplicationCredential: vi.fn(),
			revokeApplicationCredential: vi.fn(),
			grantCredentialDelivery,
			revokeCredentialDelivery: vi.fn(),
			authorizeCredentialScope: vi.fn(),
			resolveAgentQueryGrantType: vi.fn(),
			grantAgent: vi.fn(),
			revokeAgentGrant: vi.fn(),
			recordAccessRejection: vi.fn(),
		};
		const management = {
			identity: { resolve, hydrateUsers: vi.fn().mockResolvedValue([]) },
			apiIdentity,
			foundation: { submit: vi.fn() },
			revision: { revise: vi.fn() },
			management: { executeManagementCommand: vi.fn() },
			configuration: { upgradeCustomImage: vi.fn() },
			query: {
				listApplications: vi.fn(),
				getApplication: vi.fn(),
				listAgents: vi.fn(),
				getAgent: vi.fn(),
			},
			allocateApplicationIds: vi.fn(),
			prepareSecretReplacements: vi.fn(),
			readApplicationProjection: vi.fn(),
			readAgentProjection: vi.fn(),
		};
		const app = createPlatformApp({
			management,
			configuration: {},
			conversation: {},
			sessionAudit: {},
		} as never);

		const ownerCredential = await app.request("/api/v1/api-credentials", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				schemaVersion: 1,
				scopes: ["agent:create"],
				expiresAt: null,
			}),
		});
		expect(ownerCredential.status).toBe(201);
		expect(issueUserCredential).toHaveBeenCalledOnce();

		const application = await app.request("/api/v1/applications", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ schemaVersion: 1, name: "Native application" }),
		});
		expect(application.status).toBe(201);
		expect(createApplication).toHaveBeenCalledOnce();

		const delivery = await app.request(
			"/api/v1/applications/application-1/credential-delivery",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ kind: "user", id: "admin-1" }),
			},
		);
		expect(delivery.status).toBe(204);
		expect(grantCredentialDelivery).toHaveBeenCalledWith(
			expect.objectContaining({
				applicationId: "application-1",
				principal: { kind: "user", id: "admin-1" },
			}),
		);

		resolve.mockResolvedValueOnce(null);
		const withoutSession = await app.request("/api/v1/applications");
		expect(withoutSession.status).toBe(401);
		expect(await withoutSession.json()).toMatchObject({
			code: "AUTHENTICATION_REQUIRED",
		});

		const retiredAgent = await app.request("/api/v1/agents");
		expect(retiredAgent.status).toBe(400);
		expect(await retiredAgent.json()).toMatchObject({
			code: "INVALID_REQUEST",
			message: "This Agent management API version is retired. Use /api/v2.",
		});
	});
});
