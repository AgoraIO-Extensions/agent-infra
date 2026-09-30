import {
	AgentApplicationProjectionV2Schema,
	AgentProjectionV2Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
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
	options: {
		administrator?: boolean;
		identityFailure?: boolean;
		identityValue?: unknown;
		queryFailure?: boolean;
		projectionFailure?: boolean;
	} = {},
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
	const listAgents = options.queryFailure
		? vi.fn().mockRejectedValue(new Error("private query detail"))
		: vi.fn().mockResolvedValue({ items: [agentRecord], nextAfterId: null });
	const getAgent = vi.fn().mockResolvedValue(agentRecord);
	const readApplicationProjection = vi
		.fn()
		.mockResolvedValue(applicationProjection);
	const readAgentProjection = options.projectionFailure
		? vi.fn().mockRejectedValue(new Error("private projection detail"))
		: vi.fn().mockResolvedValue(agentProjection);
	const allocateApplicationIds = vi
		.fn()
		.mockResolvedValue({ applicationId: "application-1", agentId: "agent-1" });

	const resolve = options.identityFailure
		? vi.fn().mockRejectedValue(new Error("private identity detail"))
		: vi.fn().mockResolvedValue(
				options.identityValue === undefined
					? {
							...identity,
							roles: options.administrator
								? (["employee", "system_admin"] as const)
								: identity.roles,
						}
					: options.identityValue,
			);

	registerV2ManagementRoutes(app, {
		identity: {
			resolve,
			hydrateUsers: vi.fn().mockResolvedValue([]),
		},
		foundation: { submit },
		revision: { revise: vi.fn().mockResolvedValue({}) },
		management: { executeManagementCommand },
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
		resolve,
		readAgentProjection,
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
	it("reads the administrator page through Core without expanding the ordinary list scope", async () => {
		const { app, listAgents, submit, executeManagementCommand } = createApp({
			administrator: true,
		});
		listAgents.mockResolvedValueOnce({
			items: [agentRecord],
			nextAfterId: "agent-1",
		});
		const response = await app.request(
			"/api/v2/admin/agents?limit=1&cursor=agent-0",
		);
		expect(response.status).toBe(200);
		expect(listAgents).toHaveBeenCalledWith(
			{ kind: "administrator" },
			{ limit: 1, afterId: "agent-0" },
		);
		const page = (await response.json()) as {
			items: unknown[];
			nextCursor: string;
		};
		expect(page.nextCursor).toBe("agent-1");
		expect(AgentProjectionV2Schema.parse(page.items[0])).toMatchObject({
			agentId: "agent-1",
			configuration: { owners: configuration.owners },
		});
		expect(page.items[0]).not.toHaveProperty("applicant");
		expect(submit).not.toHaveBeenCalled();
		expect(executeManagementCommand).not.toHaveBeenCalled();

		expect((await app.request("/api/v2/agents")).status).toBe(200);
		expect(listAgents).toHaveBeenLastCalledWith(
			{ kind: "user", userId: identity.userId, organizationIds: ["org-1"] },
			{ limit: 50 },
		);
	});

	it("rejects employees and disabled or absent current identities before querying", async () => {
		for (const [identityValue, status, code] of [
			[identity, 403, "RESOURCE_UNAVAILABLE"],
			[
				{ ...identity, roles: ["system_admin"], accountStatus: "disabled" },
				403,
				"AUTHORIZATION_REVOKED",
			],
			[null, 401, "AUTHENTICATION_REQUIRED"],
		] as const) {
			const { app, listAgents } = createApp({ identityValue });
			const response = await app.request("/api/v2/admin/agents", {
				headers: { "x-user-id": "admin", "x-role": "system_admin" },
			});
			expect(response.status).toBe(status);
			expect(PilotProtocolErrorV1Schema.parse(await response.json()).code).toBe(
				code,
			);
			expect(listAgents).not.toHaveBeenCalled();
		}
	});

	it("rejects API credentials even alongside a resolved administrator browser identity", async () => {
		const { app, listAgents, resolve } = createApp({ administrator: true });
		const response = await app.request("/api/v2/admin/agents", {
			headers: {
				Authorization: "Bearer fixture-api-credential",
				Cookie: "fixture-browser-session=admin",
			},
		});
		expect(response.status).toBe(401);
		expect(PilotProtocolErrorV1Schema.parse(await response.json()).code).toBe(
			"AUTHENTICATION_REQUIRED",
		);
		expect(resolve).not.toHaveBeenCalled();
		expect(listAgents).not.toHaveBeenCalled();
	});

	it("rechecks the current administrator role and rejects caller-selected identities or scopes", async () => {
		const { app, listAgents, resolve } = createApp({ administrator: true });
		for (const query of [
			"scope=administrator",
			"userId=admin",
			"role=system_admin",
		]) {
			expect((await app.request(`/api/v2/admin/agents?${query}`)).status).toBe(
				400,
			);
		}
		expect(listAgents).not.toHaveBeenCalled();
		expect((await app.request("/api/v2/admin/agents")).status).toBe(200);
		resolve.mockResolvedValueOnce(identity);
		expect((await app.request("/api/v2/admin/agents")).status).toBe(403);
		expect(listAgents).toHaveBeenCalledTimes(1);
	});

	it("fails closed for administrator read dependencies without exposing private details", async () => {
		for (const failure of [
			{ identityFailure: true },
			{ queryFailure: true },
			{ projectionFailure: true },
		]) {
			const { app } = createApp({ administrator: true, ...failure });
			const response = await app.request("/api/v2/admin/agents");
			expect(response.status).toBe(503);
			const error = PilotProtocolErrorV1Schema.parse(await response.json());
			expect(error.code).toBe("DEPENDENCY_UNAVAILABLE");
			expect(JSON.stringify(error)).not.toContain("private");
		}
	});

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
});
