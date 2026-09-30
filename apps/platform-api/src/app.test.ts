import { PilotProtocolErrorV1Schema } from "@agent-infra/contracts/pilot";
import { ApiIdentityError } from "@agent-infra/platform-core";
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
			headers: {
				"content-type": "application/json",
				"Idempotency-Key": "create-native-application",
			},
			body: JSON.stringify({ schemaVersion: 1, name: "Native application" }),
		});
		expect(application.status).toBe(201);
		expect(createApplication).toHaveBeenCalledOnce();

		const delivery = await app.request(
			"/api/v1/applications/application-1/credential-delivery",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					schemaVersion: 1,
					principal: { kind: "user", id: "admin-1" },
					scopes: ["agent:read"],
					expiresAt: null,
				}),
			},
		);
		expect(delivery.status).toBe(204);
		expect(grantCredentialDelivery).toHaveBeenCalledWith(
			expect.objectContaining({
				applicationId: "application-1",
				principal: { kind: "user", id: "admin-1" },
				scopes: ["agent:read"],
				expiresAt: null,
				actor: expect.objectContaining({
					identityRevision: "owner-revision-1",
				}),
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

	it("keeps API principal reads and lifecycle on the formal assembled V2 routes", async () => {
		const browserResolve = vi.fn().mockResolvedValue({
			schemaVersion: 1,
			userId: "owner-1",
			displayName: "Owner",
			accountStatus: "active",
			organizationIds: ["org-1"],
			roles: ["employee"],
			authorizationRevision: "browser-revision-1",
		});
		const apiContext = {
			schemaVersion: 1 as const,
			principal: { kind: "application" as const, id: "application-1" },
			accountStatus: "active" as const,
			organizationIds: ["org-1"],
			authorizationRevision: "application-revision-1",
			ownerId: "owner-1",
			credential: {
				schemaVersion: 1 as const,
				credentialId: "credential-1",
				principal: { kind: "application" as const, id: "application-1" },
				scopes: ["agent:read", "agent:manage", "agent:create"] as const,
				expiresAt: null,
				revokedAt: null,
				createdAt: new Date("2026-09-30T00:00:00Z"),
			},
		};
		const resolveApiCredential = vi.fn().mockResolvedValue(apiContext);
		const resolveAgentQueryGrantType = vi.fn().mockResolvedValue("use");
		const getAgent = vi.fn().mockResolvedValue({
			schemaVersion: 1,
			agentId: "agent-1",
			applicationId: "application-1",
			name: "Agent",
			description: "Agent",
			sourceReference: "template-1",
			management: {
				schemaVersion: 1,
				applicationId: "application-1",
				agentId: "agent-1",
				applicantId: "owner-1",
				status: "stopped",
				revision: 2,
				approvalRevision: null,
				decisionReason: null,
				serviceAvailability: null,
				desiredState: "stopped",
				workloadRevision: 0,
				fence: 0,
				ownerIds: ["owner-1"],
				availability: [],
				failureCode: null,
			},
		});
		const readAgentProjection = vi.fn().mockResolvedValue({
			schemaVersion: 1,
			agentId: "agent-1",
			name: "Agent",
			description: "Agent",
			source: { kind: "standard", templateId: "template-1" },
			managementStatus: "stopped",
			serviceAvailability: null,
			configuration: {
				owners: [
					{ userId: "owner-1", displayName: "Owner", roles: ["employee"] },
				],
				availability: [],
				modelOptions: [],
				defaultModelOptionId: null,
				defaultReasoningLevel: null,
				actions: [],
				environment: [],
				channels: [],
				secrets: [],
			},
			capabilities: {
				modelSelection: false,
				attachments: false,
				resultFiles: false,
				connection: false,
				supplementaryInstruction: false,
			},
			interactionUrl: null,
		});
		const executeManagementCommand = vi.fn().mockResolvedValue({
			outcome: "accepted",
			result: {},
			writePlan: {},
		});
		const recordAccessRejection = vi.fn().mockResolvedValue(undefined);
		const app = createPlatformApp({
			management: {
				identity: {
					resolve: browserResolve,
					resolveApiCredential,
					hydrateUsers: vi.fn().mockResolvedValue([]),
				},
				apiIdentity: {
					resolveAgentQueryGrantType,
					authorizeCredentialScope: vi.fn().mockResolvedValue(undefined),
					recordAccessRejection,
				},
				foundation: { submit: vi.fn() },
				revision: { revise: vi.fn() },
				management: { executeManagementCommand },
				configuration: { upgradeCustomImage: vi.fn() },
				query: {
					listApplications: vi.fn(),
					getApplication: vi.fn(),
					listAgents: vi.fn(),
					getAgent,
				},
				allocateApplicationIds: vi.fn(),
				prepareSecretReplacements: vi.fn(),
				readApplicationProjection: vi.fn(),
				readAgentProjection,
			},
			configuration: {},
			conversation: {},
			sessionAudit: {},
		} as never);

		const read = await app.request("/api/v2/agents/agent-1", {
			headers: {
				Authorization: "Bearer api-token",
				Cookie: "session=owner",
			},
		});
		expect(read.status).toBe(200);
		expect(browserResolve).not.toHaveBeenCalled();
		expect(
			((await read.json()) as { schemaVersion: number }).schemaVersion,
		).toBe(2);
		expect(getAgent).toHaveBeenCalledWith(
			{
				kind: "principal",
				principal: { kind: "application", id: "application-1" },
				grantType: "use",
			},
			"agent-1",
		);

		resolveAgentQueryGrantType.mockRejectedValueOnce(
			new ApiIdentityError("not_authorized"),
		);
		const missingScope = await app.request("/api/v2/agents/agent-1", {
			headers: { Authorization: "Bearer api-token" },
		});
		expect(missingScope.status).toBe(403);

		resolveApiCredential.mockResolvedValueOnce({
			...apiContext,
			credential: { ...apiContext.credential, revokedAt: new Date() },
		});
		const revoked = await app.request("/api/v2/agents/agent-1", {
			headers: { Authorization: "Bearer revoked-token" },
		});
		expect(revoked.status).toBe(403);

		resolveApiCredential.mockResolvedValueOnce({
			...apiContext,
			credential: {
				...apiContext.credential,
				expiresAt: new Date(Date.now() - 1),
			},
		});
		const expired = await app.request("/api/v2/agents/agent-1", {
			headers: { Authorization: "Bearer expired-token" },
		});
		expect(expired.status).toBe(403);

		const lifecycle = await app.request("/api/v2/agents/agent-1/lifecycle", {
			method: "POST",
			headers: {
				Authorization: "Bearer api-token",
				"content-type": "application/json",
				"Idempotency-Key": "Api.Stop-01",
			},
			body: JSON.stringify({ schemaVersion: 1, command: "stop" }),
		});
		expect(lifecycle.status).toBe(202);
		expect(executeManagementCommand).toHaveBeenCalledWith(
			expect.objectContaining({ command: "stop_agent" }),
			expect.objectContaining({
				apiAuthority: {
					credentialId: "credential-1",
					identityRevision: "application-revision-1",
				},
			}),
		);

		getAgent.mockResolvedValueOnce(undefined);
		const crossSubject = await app.request("/api/v2/agents/other-agent", {
			headers: { Authorization: "Bearer api-token" },
		});
		expect(crossSubject.status).toBe(404);
		expect(recordAccessRejection).toHaveBeenCalled();
	});
});
