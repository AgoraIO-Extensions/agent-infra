import {
	AgentApplicationProjectionV2Schema,
	AgentProjectionV2Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import { ApiIdentityError } from "@agent-infra/platform-core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { registerV2ManagementRoutes } from "./v2-management-routes.js";

const identity = {
	schemaVersion: 1 as const,
	userId: "user-1",
	displayName: "Ada",
	accountStatus: "active" as const,
	organizationIds: ["org-1"],
	roles: ["employee" as const],
	authorizationRevision: "authorization-1",
};

const management = {
	schemaVersion: 1 as const,
	applicationId: "application-1",
	agentId: "agent-1",
	applicantId: "user-1",
	status: "pending_approval" as const,
	revision: 3,
	approvalRevision: null,
	decisionReason: null,
	serviceAvailability: null,
	desiredState: "running" as const,
	workloadRevision: 0,
	fence: 0,
	ownerIds: ["user-1"],
	availability: [{ kind: "organization" as const, organizationId: "org-1" }],
	failureCode: null,
};

const configuration = {
	owners: [
		{ userId: "user-1", displayName: "Ada", roles: ["employee" as const] },
	],
	availability: management.availability,
	modelOptions: [],
	defaultModelOptionId: null,
	defaultReasoningLevel: null,
	actions: [],
	environment: [],
	channels: [{ kind: "web" as const, status: "available" as const }],
	secrets: [],
};

const applicationRecord = {
	schemaVersion: 1 as const,
	applicationId: "application-1",
	agentId: "agent-1",
	applicantId: "user-1",
	name: "Release assistant",
	description: "Helps the release team",
	sourceReference: "template-1",
	management,
	submittedAt: new Date("2026-09-01T00:00:00Z"),
	decision: null,
};

const agentRecord = {
	schemaVersion: 1 as const,
	agentId: "agent-1",
	applicationId: "application-1",
	name: "Release assistant",
	description: "Helps the release team",
	sourceReference: "template-1",
	management,
};

const applicationProjection = {
	schemaVersion: 1 as const,
	applicationId: "application-1",
	agentId: "agent-1",
	name: "Release assistant",
	description: "Helps the release team",
	source: { kind: "standard" as const, templateId: "template-1" },
	status: "pending_approval" as const,
	resourceProfile: {
		profileId: "standard-medium",
		displayName: "Standard medium",
		estimatedResources: {
			cpuMillicores: 2000,
			memoryMiB: 4096,
			storageGiB: 20,
		},
	},
	configuration,
	submittedAt: "2026-09-01T00:00:00.000Z",
	decision: null,
};

const agentProjection = {
	schemaVersion: 1 as const,
	agentId: "agent-1",
	name: "Release assistant",
	description: "Helps the release team",
	source: { kind: "standard" as const, templateId: "template-1" },
	managementStatus: "available" as const,
	serviceAvailability: "ready" as const,
	configuration,
	capabilities: {
		modelSelection: false,
		attachments: false,
		resultFiles: false,
		connection: false,
		supplementaryInstruction: false,
	},
	interactionUrl: null,
};

function createApp(
	options: { administrator?: boolean; identityFailure?: boolean } = {},
) {
	const app = new Hono();
	const submit = vi.fn().mockResolvedValue({});
	const executeManagementCommand = vi.fn().mockResolvedValue({
		outcome: "accepted",
		result: {},
		writePlan: {},
	});
	const listApplications = vi.fn().mockResolvedValue({
		items: [applicationRecord],
		nextAfterId: null,
	});
	const getApplication = vi.fn().mockResolvedValue(applicationRecord);
	const listAgents = vi
		.fn()
		.mockResolvedValue({ items: [agentRecord], nextAfterId: null });
	const getAgent = vi.fn().mockResolvedValue(agentRecord);
	const readApplicationProjection = vi
		.fn()
		.mockResolvedValue(applicationProjection);
	const readAgentProjection = vi.fn().mockResolvedValue(agentProjection);
	const allocateApplicationIds = vi
		.fn()
		.mockResolvedValue({ applicationId: "application-1", agentId: "agent-1" });
	const apiIdentity = {
		authorizeCredentialScope: vi.fn().mockResolvedValue(undefined),
		resolveAgentQueryGrantType: vi.fn().mockResolvedValue("use"),
		recordAccessRejection: vi.fn().mockResolvedValue(undefined),
	};
	const apiContext = {
		schemaVersion: 1 as const,
		principal: { kind: "application" as const, id: "application-api" },
		accountStatus: "active" as const,
		organizationIds: ["org-1"],
		authorizationRevision: "application-revision-1",
		ownerId: "user-1",
		credential: {
			schemaVersion: 1 as const,
			credentialId: "credential-api",
			principal: { kind: "application" as const, id: "application-api" },
			scopes: ["agent:create", "agent:manage", "agent:read"] as const,
			expiresAt: null,
			revokedAt: null,
			createdAt: new Date("2026-09-01T00:00:00Z"),
		},
	};

	registerV2ManagementRoutes(app, {
		identity: {
			resolve: options.identityFailure
				? vi.fn().mockRejectedValue(new Error("private identity detail"))
				: vi.fn().mockResolvedValue({
						...identity,
						roles: options.administrator
							? (["employee", "system_admin"] as const)
							: identity.roles,
					}),
			hydrateUsers: vi.fn().mockResolvedValue([]),
			resolveApiCredential: vi.fn().mockResolvedValue(apiContext),
		},
		foundation: { submit },
		revision: { revise: vi.fn().mockResolvedValue({}) },
		management: { executeManagementCommand },
		apiIdentity: apiIdentity as never,
		configuration: { upgradeCustomImage: vi.fn().mockResolvedValue({}) },
		query: { listApplications, getApplication, listAgents, getAgent },
		allocateApplicationIds,
		prepareSecretReplacements: vi.fn().mockResolvedValue({ secrets: [] }),
		readApplicationProjection,
		readAgentProjection,
	});

	return {
		app,
		submit,
		executeManagementCommand,
		listAgents,
		getAgent,
		apiIdentity,
		apiContext,
	};
}

const headers = {
	"content-type": "application/json",
	"Idempotency-Key": "Command.Aa-01",
};

const applicationBody = {
	schemaVersion: 2,
	name: "Release assistant",
	description: "Helps the release team",
	source: { kind: "standard", templateId: "template-1" },
	coOwnerIds: [],
	availability: [{ kind: "organization", organizationId: "org-1" }],
	environment: [],
	secrets: [],
};

describe("V2 management routes", () => {
	it("uses owner scope and returns an action-free V2 agent projection", async () => {
		const { app, listAgents } = createApp();
		const response = await app.request("/api/v2/agents?scope=owner&limit=10");

		expect(response.status).toBe(200);
		expect(listAgents).toHaveBeenCalledWith(
			{ kind: "owner", ownerId: "user-1" },
			{ limit: 10 },
		);
		const body = (await response.json()) as { items: unknown[] };
		const projection = AgentProjectionV2Schema.parse(body.items[0]);
		expect(projection.schemaVersion).toBe(2);
		expect(projection.configuration).not.toHaveProperty("actions");
	});

	it("submits V2 application input to the real Core seam and projects V2 output", async () => {
		const { app, submit } = createApp();
		const response = await app.request("/api/v2/agent-applications", {
			method: "POST",
			headers,
			body: JSON.stringify(applicationBody),
		});

		expect(response.status).toBe(201);
		const projection = AgentApplicationProjectionV2Schema.parse(
			await response.json(),
		);
		expect(projection.schemaVersion).toBe(2);
		expect(projection.configuration).not.toHaveProperty("actions");
		expect(submit).toHaveBeenCalledWith(
			expect.objectContaining({
				schemaVersion: 2,
				applicationId: "application-1",
			}),
			expect.objectContaining({ userId: "user-1" }),
			undefined,
		);
	});

	it("runs administrator approval through the management command and rejects invalid scope", async () => {
		const { app, executeManagementCommand, listAgents } = createApp({
			administrator: true,
		});
		const decision = await app.request(
			"/api/v2/admin/agent-applications/application-1/decision",
			{
				method: "POST",
				headers,
				body: JSON.stringify({ schemaVersion: 1, decision: "approve" }),
			},
		);
		expect(decision.status).toBe(200);
		expect(executeManagementCommand).toHaveBeenCalledWith(
			expect.objectContaining({ command: "approve_application" }),
			expect.objectContaining({ isAdministrator: true }),
		);

		const invalid = await app.request("/api/v2/agents?scope=administrator");
		expect(invalid.status).toBe(400);
		expect(listAgents).toHaveBeenCalledTimes(0);
	});

	it("fails closed when identity resolution is unavailable", async () => {
		const { app } = createApp({ identityFailure: true });
		const unavailable = await app.request("/api/v2/agents");
		expect(unavailable.status).toBe(503);
		const error = PilotProtocolErrorV1Schema.parse(await unavailable.json());
		expect(error.code).toBe("DEPENDENCY_UNAVAILABLE");
		expect(JSON.stringify(error)).not.toContain("private identity detail");
	});

	it("reads through the API principal and never falls back to the browser cookie", async () => {
		const { app, listAgents, apiIdentity } = createApp();
		const response = await app.request("/api/v2/agents/agent-1", {
			headers: {
				Authorization: "Bearer application-token",
				Cookie: "session=browser-owner",
			},
		});

		expect(response.status).toBe(200);
		expect(listAgents).not.toHaveBeenCalled();
		expect(
			((await response.json()) as { schemaVersion: number }).schemaVersion,
		).toBe(2);
		expect(apiIdentity.resolveAgentQueryGrantType).toHaveBeenCalledOnce();

		apiIdentity.resolveAgentQueryGrantType.mockRejectedValueOnce(
			new ApiIdentityError("not_authorized"),
		);
		const missingScope = await app.request("/api/v2/agents/agent-1", {
			headers: { Authorization: "Bearer application-token" },
		});
		expect(missingScope.status).toBe(403);
	});

	it("supports API direct creation and lifecycle with current credential authority", async () => {
		const { app, submit, executeManagementCommand } = createApp();
		submit.mockImplementation(
			async (request: { applicationId: string; agentId: string }) => ({
				applicationId: request.applicationId,
				agentId: request.agentId,
				status: "creating" as const,
			}),
		);
		const create = await app.request("/api/v2/agents", {
			method: "POST",
			headers: {
				...headers,
				Authorization: "Bearer application-token",
			},
			body: JSON.stringify(applicationBody),
		});
		expect(create.status).toBe(201);
		expect(
			((await create.json()) as { schemaVersion: number }).schemaVersion,
		).toBe(2);
		expect(submit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				principal: { kind: "application", id: "application-api" },
				creationMode: "api",
				apiAuthority: {
					credentialId: "credential-api",
					identityRevision: "application-revision-1",
				},
			}),
			undefined,
		);

		const lifecycle = await app.request("/api/v2/agents/agent-1/lifecycle", {
			method: "POST",
			headers: {
				...headers,
				Authorization: "Bearer application-token",
			},
			body: JSON.stringify({ schemaVersion: 1, command: "stop" }),
		});
		expect(lifecycle.status).toBe(202);
		expect(executeManagementCommand).toHaveBeenLastCalledWith(
			expect.objectContaining({ command: "stop_agent" }),
			expect.objectContaining({
				principal: { kind: "application", id: "application-api" },
				apiAuthority: {
					credentialId: "credential-api",
					identityRevision: "application-revision-1",
				},
			}),
		);
	});
});
