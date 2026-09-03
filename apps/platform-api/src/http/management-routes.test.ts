import { createHash } from "node:crypto";

import {
	AgentApplicationProjectionV1Schema,
	AgentProjectionV1Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { HttpProtocolError } from "./common.js";
import { registerManagementRoutes } from "./management-routes.js";

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
	secrets: [{ name: "MODEL_API_KEY", isSet: true, version: 1 }],
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
	options: { administrator?: boolean; missing?: boolean } = {},
) {
	const app = new Hono();
	const submit = vi.fn().mockResolvedValue({
		schemaVersion: 1,
		applicationId: "application-1",
		agentId: "agent-1",
		configurationRevision: 1,
		status: "pending_approval",
	});
	const revise = vi.fn().mockResolvedValue({
		schemaVersion: 1,
		applicationId: "application-1",
		agentId: "agent-1",
		status: "pending_approval",
		managementRevision: 4,
		configurationRevision: 2,
	});
	const executeManagementCommand = vi.fn().mockResolvedValue({
		outcome: "accepted",
		result: {
			schemaVersion: 1,
			applicationId: "application-1",
			agentId: "agent-1",
			status: "withdrawn",
			revision: 4,
		},
		writePlan: {},
	});
	const updateConfiguration = vi.fn().mockResolvedValue({
		schemaVersion: 1,
		agentId: "agent-1",
		revision: 4,
		changedFields: ["source"],
	});
	const upgradeCustomImage = vi.fn().mockResolvedValue({
		schemaVersion: 1,
		agentId: "agent-1",
		revision: 4,
		changedFields: ["source"],
	});
	const listApplications = vi.fn().mockResolvedValue({
		items: [applicationRecord],
		nextAfterId: null,
	});
	const getApplication = vi
		.fn()
		.mockResolvedValue(options.missing ? undefined : applicationRecord);
	const listAgents = vi
		.fn()
		.mockResolvedValue({ items: [agentRecord], nextAfterId: null });
	const getAgent = vi
		.fn()
		.mockResolvedValue(options.missing ? undefined : agentRecord);
	const readApplicationProjection = vi
		.fn()
		.mockResolvedValue(applicationProjection);
	const readAgentProjection = vi.fn().mockResolvedValue(agentProjection);
	const prepareSecretReplacements = vi.fn().mockResolvedValue({
		secrets: [
			{
				name: "MODEL_API_KEY",
				replace: true as const,
				value: "never-return-this",
			},
		],
		modelConfiguration: undefined,
		attachment: { resolve: vi.fn() },
	});
	const allocateApplicationIds = vi
		.fn()
		.mockResolvedValue({ applicationId: "application-1", agentId: "agent-1" });

	registerManagementRoutes(app, {
		identity: {
			resolve: vi.fn().mockResolvedValue({
				...identity,
				roles: options.administrator
					? (["employee", "system_admin"] as const)
					: identity.roles,
			}),
			hydrateUsers: vi.fn().mockResolvedValue([]),
		},
		foundation: { submit },
		revision: { revise },
		management: { executeManagementCommand },
		configuration: { upgradeCustomImage },
		query: { listApplications, getApplication, listAgents, getAgent },
		allocateApplicationIds,
		prepareSecretReplacements,
		readApplicationProjection,
		readAgentProjection,
	});
	return {
		app,
		submit,
		revise,
		executeManagementCommand,
		updateConfiguration,
		upgradeCustomImage,
		listApplications,
		getApplication,
		listAgents,
		getAgent,
		readApplicationProjection,
		readAgentProjection,
		prepareSecretReplacements,
		allocateApplicationIds,
	};
}

const headers = {
	"content-type": "application/json",
	"Idempotency-Key": "Command.Aa-01",
	"x-request-id": "caller-request-must-be-ignored",
	"x-trace-id": "caller-trace-must-be-ignored",
};
const applicationBody = {
	schemaVersion: 1,
	name: "Release assistant",
	description: "Helps the release team",
	source: { kind: "standard", templateId: "template-1" },
	coOwnerIds: [],
	availability: [{ kind: "organization", organizationId: "org-1" }],
	actions: [],
	environment: [],
	secrets: [{ name: "MODEL_API_KEY", value: "never-return-this" }],
};

describe("management routes", () => {
	it("submits a validated application once and returns an authoritative projection", async () => {
		const {
			app,
			submit,
			readApplicationProjection,
			prepareSecretReplacements,
			allocateApplicationIds,
		} = createApp();
		const rawBody = JSON.stringify(applicationBody);
		const response = await app.request("/api/v1/agent-applications", {
			method: "POST",
			headers,
			body: rawBody,
		});

		expect(response.status).toBe(201);
		const json = await response.json();
		expect(AgentApplicationProjectionV1Schema.parse(json)).toEqual(
			applicationProjection,
		);
		expect(JSON.stringify(json)).not.toContain("never-return-this");
		expect(submit).toHaveBeenCalledOnce();
		expect(submit).toHaveBeenCalledWith(
			expect.objectContaining({
				schemaVersion: 1,
				applicationId: "application-1",
				agentId: "agent-1",
				idempotencyKey: "Command.Aa-01",
				requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
				traceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
				name: applicationBody.name,
				description: applicationBody.description,
				coOwnerIds: [],
				availability: applicationBody.availability,
				source: applicationBody.source,
				environment: [],
				secrets: [{ name: "MODEL_API_KEY", replace: true }],
				actions: [],
				channels: [],
			}),
			{
				schemaVersion: 1,
				userId: "user-1",
				rawRequestDigest: createHash("sha256").update(rawBody).digest("hex"),
			},
			expect.objectContaining({ resolve: expect.any(Function) }),
		);
		expect(submit.mock.calls[0]?.[0]).not.toEqual(
			expect.objectContaining({ requestId: headers["x-request-id"] }),
		);
		expect(JSON.stringify(submit.mock.calls[0])).not.toContain(
			"never-return-this",
		);
		expect(readApplicationProjection.mock.calls[0]?.[0]).not.toEqual(
			expect.objectContaining({ traceId: headers["x-trace-id"] }),
		);
		expect(prepareSecretReplacements).toHaveBeenCalledWith({
			applicationId: "application-1",
			agentId: "agent-1",
			secrets: applicationBody.secrets,
			modelConfiguration: undefined,
			identity,
			requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			traceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
		expect(allocateApplicationIds).toHaveBeenCalledWith({
			identity,
			idempotencyKey: "Command.Aa-01",
		});
		expect(readApplicationProjection).toHaveBeenCalledWith(
			expect.objectContaining({ application: applicationRecord, identity }),
		);
	});

	it("uses server-derived scopes for application and Agent reads", async () => {
		const user = createApp();
		const admin = createApp({ administrator: true });

		for (const [app, path, schema] of [
			[
				user.app,
				"/api/v1/agent-applications?limit=10",
				AgentApplicationProjectionV1Schema,
			],
			[
				user.app,
				"/api/v1/agent-applications/application-1",
				AgentApplicationProjectionV1Schema,
			],
			[user.app, "/api/v1/agents?cursor=agent-0", AgentProjectionV1Schema],
			[user.app, "/api/v1/agents/agent-1", AgentProjectionV1Schema],
			[
				admin.app,
				"/api/v1/admin/agent-applications",
				AgentApplicationProjectionV1Schema,
			],
		] as const) {
			const response = await app.request(path);
			expect(response.status).toBe(200);
			const body = (await response.json()) as Record<string, unknown>;
			const item = Array.isArray(body.items) ? body.items[0] : body;
			expect(schema.safeParse(item).success).toBe(true);
		}

		expect(user.listApplications).toHaveBeenCalledWith(
			{ kind: "applicant", applicantId: "user-1" },
			{ limit: 10 },
		);
		expect(user.listAgents).toHaveBeenCalledWith(
			{ kind: "user", userId: "user-1", organizationIds: ["org-1"] },
			{ limit: 50, afterId: "agent-0" },
		);
		expect(admin.listApplications).toHaveBeenCalledWith(
			{ kind: "administrator" },
			{ limit: 50 },
		);
	});

	it("preserves omitted application fields and routes mutations through Core once", async () => {
		const applicant = createApp();
		const admin = createApp({ administrator: true });

		const { secrets: _secrets, ...updateBody } = applicationBody;
		const calls = [
			applicant.app.request("/api/v1/agent-applications/application-1", {
				method: "PUT",
				headers,
				body: JSON.stringify(updateBody),
			}),
			applicant.app.request(
				"/api/v1/agent-applications/application-1/withdraw",
				{
					method: "POST",
					headers,
				},
			),
			admin.app.request(
				"/api/v1/admin/agent-applications/application-1/decision",
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						schemaVersion: 1,
						decision: "reject",
						reason: "Policy",
					}),
				},
			),
		];
		for (const command of ["stop", "restart", "retry_creation"] as const) {
			calls.push(
				applicant.app.request("/api/v1/agents/agent-1/lifecycle", {
					method: "POST",
					headers,
					body: JSON.stringify({ schemaVersion: 1, command }),
				}),
			);
		}
		calls.push(
			admin.app.request("/api/v1/agents/agent-1/lifecycle", {
				method: "POST",
				headers,
				body: JSON.stringify({ schemaVersion: 1, command: "disable" }),
			}),
		);
		const responses = await Promise.all(calls);
		expect(responses.map(({ status }) => status)).toEqual([
			200, 200, 200, 202, 202, 202, 202,
		]);
		expect(applicant.revise).toHaveBeenCalledOnce();
		const [revisionCommand] = applicant.revise.mock.calls[0] as [
			Record<string, unknown>,
		];
		expect(revisionCommand).not.toHaveProperty("secrets");
		expect(revisionCommand).not.toHaveProperty("channels");
		expect(applicant.prepareSecretReplacements).not.toHaveBeenCalled();
		expect(applicant.executeManagementCommand).toHaveBeenCalledTimes(4);
		expect(admin.executeManagementCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "reject_application",
				expectedRevision: 3,
				reason: "Policy",
			}),
			expect.objectContaining({ userId: "user-1", isAdministrator: true }),
		);
		expect(admin.getAgent).toHaveBeenCalledWith(
			{ kind: "administrator" },
			"agent-1",
		);
	});

	it("makes missing and forbidden resources indistinguishable and rejects caller selectors", async () => {
		const missing = createApp({ missing: true });
		const ordinary = createApp();
		for (const response of [
			await missing.app.request("/api/v1/agent-applications/unknown"),
			await missing.app.request("/api/v1/agents/unknown"),
			await ordinary.app.request("/api/v1/agents?userId=other"),
		]) {
			expect([400, 404]).toContain(response.status);
			expect(
				PilotProtocolErrorV1Schema.safeParse(await response.json()).success,
			).toBe(true);
		}
		const forbidden = await ordinary.app.request(
			"/api/v1/admin/agent-applications",
		);
		expect(forbidden.status).toBe(403);
		expect(
			PilotProtocolErrorV1Schema.safeParse(await forbidden.json()).success,
		).toBe(true);
		const secretAttack = await missing.app.request(
			"/api/v1/agent-applications/application-1",
			{
				method: "PUT",
				headers,
				body: JSON.stringify(applicationBody),
			},
		);
		expect(secretAttack.status).toBe(404);
		expect(missing.prepareSecretReplacements).not.toHaveBeenCalled();
		expect((await missing.app.request("/api/v1/agents/unknown")).status).toBe(
			(await missing.app.request("/api/v1/agents/not-owned")).status,
		);
	});

	it("upgrades a custom image through the configuration use case", async () => {
		const upgraded = createApp();
		upgraded.readAgentProjection.mockResolvedValue({
			...agentProjection,
			source: {
				kind: "custom",
				imageReference: "registry.example/agent:v2",
				interactionMode: "self-managed",
				identityResponsibility: "platform-managed",
			},
		});
		const rawBody = JSON.stringify({
			schemaVersion: 1,
			command: "upgrade_custom_image",
			imageReference: "registry.example/agent:v2",
		});

		const response = await upgraded.app.request(
			"/api/v1/agents/agent-1/lifecycle",
			{ method: "POST", headers, body: rawBody },
		);

		expect(response.status).toBe(202);
		expect(upgraded.upgradeCustomImage).toHaveBeenCalledWith(
			{
				schemaVersion: 1,
				agentId: "agent-1",
				imageReference: "registry.example/agent:v2",
				idempotencyKey: "Command.Aa-01",
				requestId: expect.any(String),
				traceId: expect.any(String),
			},
			{
				schemaVersion: 1,
				actorId: "user-1",
				rawRequestDigest: createHash("sha256").update(rawBody).digest("hex"),
			},
		);
		expect(upgraded.updateConfiguration).not.toHaveBeenCalled();
	});

	it("uses administrator scope after an administrator image upgrade", async () => {
		const upgraded = createApp({ administrator: true });
		const response = await upgraded.app.request(
			"/api/v1/agents/agent-1/lifecycle",
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					schemaVersion: 1,
					command: "upgrade_custom_image",
					imageReference: "registry.example/agent:v2",
				}),
			},
		);

		expect(response.status).toBe(202);
		expect(upgraded.getAgent).toHaveBeenCalledWith(
			{ kind: "administrator" },
			"agent-1",
		);
	});

	it("maps management query failures to dependency unavailable", async () => {
		for (const [method, path] of [
			["listApplications", "/api/v1/agent-applications"],
			["getApplication", "/api/v1/agent-applications/application-1"],
			["listAgents", "/api/v1/agents"],
			["getAgent", "/api/v1/agents/agent-1"],
		] as const) {
			const failed = createApp();
			failed[method].mockRejectedValue(new Error("private database failure"));

			const response = await failed.app.request(path);
			const body = await response.json();

			expect(response.status).toBe(503);
			expect(PilotProtocolErrorV1Schema.parse(body)).toMatchObject({
				code: "DEPENDENCY_UNAVAILABLE",
				retryable: true,
			});
			expect(JSON.stringify(body)).not.toContain("private database failure");
		}
	});

	it("fails closed when an authoritative projection is malformed", async () => {
		const closed = createApp();
		closed.readAgentProjection.mockResolvedValue({ agentId: "agent-1" });

		expect((await closed.app.request("/api/v1/agents/agent-1")).status).toBe(
			503,
		);
	});

	it("redacts Secret preparation failures and never calls Core", async () => {
		const failed = createApp();
		failed.prepareSecretReplacements.mockRejectedValue(
			new Error("never-return-this internal encryption detail"),
		);
		const response = await failed.app.request("/api/v1/agent-applications", {
			method: "POST",
			headers,
			body: JSON.stringify(applicationBody),
		});

		expect(response.status).toBe(503);
		expect(JSON.stringify(await response.json())).not.toContain(
			"never-return-this",
		);
		expect(failed.submit).not.toHaveBeenCalled();

		const malformed = createApp();
		malformed.prepareSecretReplacements.mockResolvedValue({
			secrets: [{ name: "MODEL_API_KEY", replace: false }],
		} as never);
		const malformedResponse = await malformed.app.request(
			"/api/v1/agent-applications",
			{
				method: "POST",
				headers,
				body: JSON.stringify(applicationBody),
			},
		);

		expect(malformedResponse.status).toBe(503);
		expect(malformed.submit).not.toHaveBeenCalled();

		const missingAttachment = createApp();
		missingAttachment.prepareSecretReplacements.mockResolvedValue({
			secrets: [{ name: "MODEL_API_KEY", replace: true }],
		} as never);
		const missingAttachmentResponse = await missingAttachment.app.request(
			"/api/v1/agent-applications",
			{
				method: "POST",
				headers,
				body: JSON.stringify(applicationBody),
			},
		);
		expect(missingAttachmentResponse.status).toBe(503);
		expect(missingAttachment.submit).not.toHaveBeenCalled();

		const allocator = createApp();
		allocator.allocateApplicationIds.mockRejectedValue(
			new HttpProtocolError("FORBIDDEN", "allocator-trace"),
		);
		const allocatorResponse = await allocator.app.request(
			"/api/v1/agent-applications",
			{
				method: "POST",
				headers,
				body: JSON.stringify(applicationBody),
			},
		);

		expect(allocatorResponse.status).toBe(503);
		const allocatorBody = await allocatorResponse.json();
		expect(allocatorBody).toMatchObject({
			code: "DEPENDENCY_UNAVAILABLE",
			retryable: true,
		});
		expect(JSON.stringify(allocatorBody)).not.toContain("allocator-trace");
		expect(allocator.submit).not.toHaveBeenCalled();
	});
});
