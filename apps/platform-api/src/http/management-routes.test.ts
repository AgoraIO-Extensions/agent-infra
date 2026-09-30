import { createHash } from "node:crypto";

import {
	AgentApplicationProjectionV1Schema,
	AgentProjectionV1Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	ApiIdentityError,
	ApplicationFoundationError,
} from "@agent-infra/platform-core";
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
	options: { administrator?: boolean; missing?: boolean; api?: boolean } = {},
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
	const readApiCreationReplay = vi.fn().mockResolvedValue(null);
	const allocateApplicationIds = vi
		.fn()
		.mockResolvedValue({ applicationId: "application-1", agentId: "agent-1" });
	const apiIdentity = options.api
		? {
				schemaVersion: 1 as const,
				principal: { kind: "application" as const, id: "application-caller" },
				accountStatus: "active" as const,
				organizationIds: ["org-1"],
				authorizationRevision: "authorization-api-1",
				ownerId: "user-1",
				credential: {
					schemaVersion: 1 as const,
					credentialId: "credential-1",
					principal: {
						kind: "application" as const,
						id: "application-caller",
					},
					scopes: ["agent:read", "agent:manage"] as const,
					expiresAt: null,
					revokedAt: null,
					createdAt: new Date("2026-09-01T00:00:00Z"),
				},
			}
		: undefined;
	const resolveApiCredential = options.api
		? vi.fn().mockResolvedValue(apiIdentity)
		: undefined;
	const resolveBrowser = vi.fn().mockResolvedValue({
		...identity,
		roles: options.administrator
			? (["employee", "system_admin"] as const)
			: identity.roles,
	});
	const resolveAgentQueryGrantType = vi.fn().mockResolvedValue("any");
	const authorizeCredentialScope = vi.fn().mockResolvedValue(undefined);
	const recordAccessRejection = vi.fn().mockResolvedValue(undefined);
	const listUserCredentials = vi.fn();
	const listApiApplications = vi.fn();
	const createApiApplication = vi.fn();
	const listApplicationCredentials = vi.fn();

	registerManagementRoutes(app, {
		identity: {
			resolve: resolveBrowser,
			hydrateUsers: vi.fn().mockResolvedValue([]),
			...(resolveApiCredential ? { resolveApiCredential } : {}),
		},
		...(apiIdentity
			? {
					apiIdentity: {
						authorizeCredentialScope,
						resolveAgentQueryGrantType,
						listUserCredentials,
						issueUserCredential: vi.fn(),
						revokeUserCredential: vi.fn(),
						listApplications: listApiApplications,
						createApplication: createApiApplication,
						listApplicationCredentials,
						issueApplicationCredential: vi.fn(),
						revokeApplicationCredential: vi.fn(),
						grantCredentialDelivery: vi.fn(),
						revokeCredentialDelivery: vi.fn(),
						grantAgent: vi.fn(),
						revokeAgentGrant: vi.fn(),
						recordAccessRejection,
					},
				}
			: {}),
		foundation: {
			readApiCreationReplay,
			submit,
		},
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
		readApiCreationReplay,
		allocateApplicationIds,
		apiIdentity,
		resolveApiCredential,
		resolveBrowser,
		listUserCredentials,
		listApiApplications,
		createApiApplication,
		listApplicationCredentials,
		resolveAgentQueryGrantType,
		authorizeCredentialScope,
		recordAccessRejection,
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
	it.each([
		["GET", "/api/v1/api-credentials"],
		["POST", "/api/v1/api-credentials"],
		["DELETE", "/api/v1/api-credentials/credential-1"],
		["GET", "/api/v1/applications"],
		["POST", "/api/v1/applications"],
		["POST", "/api/v1/applications/application-1/credential-delivery"],
		["DELETE", "/api/v1/applications/application-1/credential-delivery"],
		["GET", "/api/v1/applications/application-1/credentials"],
		["POST", "/api/v1/applications/application-1/credentials"],
		["DELETE", "/api/v1/applications/application-1/credentials/credential-1"],
	])(
		"rejects Authorization with a browser session on %s %s",
		async (method, path) => {
			const { app, resolveBrowser } = createApp({ api: true });
			for (const authorization of ["", "Bearer invalid"]) {
				const response = await app.request(path, {
					method,
					headers: { Authorization: authorization, Cookie: "session=valid" },
				});
				expect(response.status).toBe(401);
			}
			expect(resolveBrowser).not.toHaveBeenCalled();
		},
	);

	it("rejects malformed Authorization without falling back to the browser identity", async () => {
		const input = createApp({ api: true });
		input.resolveApiCredential?.mockResolvedValue(null);
		for (const authorization of ["", "bearer invalid", "Bearer invalid"]) {
			const response = await input.app.request("/api/v1/agents/agent-1", {
				headers: { Authorization: authorization },
			});
			expect(response.status).toBe(401);
		}
		expect(input.getAgent).not.toHaveBeenCalled();
	});

	it("pages credential and application lists by stable IDs", async () => {
		const {
			app,
			listUserCredentials,
			listApiApplications,
			listApplicationCredentials,
		} = createApp({ api: true });
		const credential = {
			schemaVersion: 1 as const,
			principal: { kind: "user" as const, id: "user-1" },
			scopes: ["agent:read" as const],
			expiresAt: null,
			revokedAt: null,
			createdAt: new Date("2026-09-01T00:00:00Z"),
		};
		listUserCredentials.mockResolvedValue(
			["credential-3", "credential-1", "credential-2"].map((credentialId) => ({
				...credential,
				credentialId,
			})),
		);
		listApplicationCredentials.mockResolvedValue(
			["application-credential-3", "application-credential-1"].map(
				(credentialId) => ({
					...credential,
					credentialId,
					principal: { kind: "application", id: "application-1" },
				}),
			),
		);
		listApiApplications.mockResolvedValue(
			["application-3", "application-1", "application-2"].map((id) => ({
				id,
				name: id,
				responsibleUserId: "user-1",
				status: "active",
				authorizationRevision: "revision-1",
			})),
		);
		for (const [path, firstId, secondId] of [
			["/api/v1/api-credentials", "credential-1", "credential-2"],
			["/api/v1/applications", "application-1", "application-2"],
			[
				"/api/v1/applications/application-1/credentials",
				"application-credential-1",
				"application-credential-3",
			],
		] as const) {
			const first = await app.request(`${path}?limit=1`);
			expect(first.status).toBe(200);
			if (path === "/api/v1/api-credentials") {
				expect(listUserCredentials).toHaveBeenCalledWith(expect.anything(), {
					limit: 1,
				});
			} else if (path === "/api/v1/applications") {
				expect(listApiApplications).toHaveBeenCalledWith(expect.anything(), {
					limit: 1,
				});
			} else {
				expect(listApplicationCredentials).toHaveBeenCalledWith(
					expect.anything(),
					"application-1",
					{ limit: 1 },
				);
			}
			const firstPage = (await first.json()) as {
				items: Array<{ credentialId?: string; applicationId?: string }>;
				nextCursor: string | null;
			};
			expect(
				firstPage.items.map((item) => item.credentialId ?? item.applicationId),
			).toEqual([firstId]);
			expect(firstPage.nextCursor).toBe(firstId);
			const second = await app.request(`${path}?limit=1&cursor=${firstId}`);
			expect(second.status).toBe(200);
			if (path === "/api/v1/api-credentials") {
				expect(listUserCredentials).toHaveBeenLastCalledWith(
					expect.anything(),
					{ limit: 1, afterId: firstId },
				);
			} else if (path === "/api/v1/applications") {
				expect(listApiApplications).toHaveBeenLastCalledWith(
					expect.anything(),
					{ limit: 1, afterId: firstId },
				);
			} else {
				expect(listApplicationCredentials).toHaveBeenLastCalledWith(
					expect.anything(),
					"application-1",
					{ limit: 1, afterId: firstId },
				);
			}
			const secondPage = (await second.json()) as typeof firstPage;
			expect(
				secondPage.items.map((item) => item.credentialId ?? item.applicationId),
			).toEqual([secondId]);
			if (path.includes("application-1/credentials")) {
				expect(secondPage.nextCursor).toBeNull();
			} else {
				expect(secondPage.nextCursor).toBe(secondId);
				const last = await app.request(`${path}?limit=1&cursor=${secondId}`);
				const lastPage = (await last.json()) as typeof firstPage;
				expect(lastPage.items).toHaveLength(1);
				expect(lastPage.nextCursor).toBeNull();
			}
		}
		expect((await app.request("/api/v1/api-credentials?limit=0")).status).toBe(
			400,
		);
	});

	it("requires an idempotency key and rejects conflicting application retries", async () => {
		const { app, createApiApplication } = createApp({ api: true });
		const body = JSON.stringify({ schemaVersion: 1, name: "Automation" });
		const request = (idempotencyKey?: string) =>
			app.request("/api/v1/applications", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
				},
				body,
			});
		expect((await request()).status).toBe(400);
		expect(createApiApplication).not.toHaveBeenCalled();
		createApiApplication.mockResolvedValue({
			id: "application-stable",
			name: "Automation",
			responsibleUserId: "user-1",
			status: "active",
			authorizationRevision: "revision-1",
		});
		const response = await request("application-command-1");
		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			applicationId: "application-stable",
		});
		expect(createApiApplication).toHaveBeenCalledWith(
			expect.objectContaining({
				idempotencyKey: "application-command-1",
				rawRequestDigest: createHash("sha256").update(body).digest("hex"),
			}),
		);
		createApiApplication.mockRejectedValueOnce(
			new ApiIdentityError("idempotency_conflict"),
		);
		const conflict = await request("application-command-1");
		expect(conflict.status).toBe(409);
		expect(PilotProtocolErrorV1Schema.parse(await conflict.json()).code).toBe(
			"INVALID_REQUEST",
		);
	});

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
				schemaVersion: 2,
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

	it("returns a saved direct creation before mutable preparation", async () => {
		const direct = createApp({ api: true });
		direct.readApiCreationReplay.mockImplementation(async (query) => ({
			schemaVersion: 1,
			applicationId: query.applicationId,
			agentId: query.agentId,
			configurationRevision: 1,
			status: "creating",
		}));
		direct.prepareSecretReplacements.mockRejectedValue(
			new Error("preparation is unavailable"),
		);
		const response = await direct.app.request("/api/v1/agents", {
			method: "POST",
			headers: { ...headers, Authorization: "Bearer secret" },
			body: JSON.stringify({
				schemaVersion: 2,
				name: "Direct agent",
				description: "Created through the API",
				source: { kind: "standard", templateId: "template-1" },
				coOwnerIds: [],
				availability: [],
				environment: [],
				secrets: [],
			}),
		});
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({
			schemaVersion: 1,
			applicationId: expect.any(String),
			agentId: expect.any(String),
			status: "creating",
		});
		expect(direct.prepareSecretReplacements).not.toHaveBeenCalled();
		expect(direct.submit).not.toHaveBeenCalled();
	});

	it("recovers a concurrent direct creation after preparation fails", async () => {
		const direct = createApp({ api: true });
		direct.readApiCreationReplay
			.mockResolvedValueOnce(null)
			.mockImplementation(async (query) => ({
				schemaVersion: 1,
				applicationId: query.applicationId,
				agentId: query.agentId,
				configurationRevision: 1,
				status: "creating",
			}));
		direct.prepareSecretReplacements.mockRejectedValue(
			new Error("preparation is unavailable"),
		);
		const response = await direct.app.request("/api/v1/agents", {
			method: "POST",
			headers: { ...headers, Authorization: "Bearer secret" },
			body: JSON.stringify({
				schemaVersion: 2,
				name: "Direct agent",
				description: "Created through the API",
				source: { kind: "standard", templateId: "template-1" },
				coOwnerIds: [],
				availability: [],
				environment: [],
				secrets: [{ name: "TOKEN", value: "test-secret" }],
			}),
		});
		expect(response.status).toBe(201);
		expect(direct.readApiCreationReplay).toHaveBeenCalledTimes(2);
		expect(direct.prepareSecretReplacements).toHaveBeenCalledOnce();
		expect(direct.submit).not.toHaveBeenCalled();
	});

	it("accepts direct creation only through an active scoped API principal", async () => {
		const direct = createApp();
		direct.submit.mockImplementation(async (command) => ({
			schemaVersion: 1,
			applicationId: command.applicationId,
			agentId: command.agentId,
			configurationRevision: 1,
			status: "creating",
		}));
		const apiIdentity = {
			schemaVersion: 1,
			principal: { kind: "application", id: "application-caller" },
			accountStatus: "active",
			organizationIds: ["org-1"],
			authorizationRevision: "authorization-api-1",
			ownerId: "user-1",
			credential: {
				schemaVersion: 1,
				credentialId: "credential-1",
				principal: { kind: "application", id: "application-caller" },
				scopes: ["agent:create"],
				expiresAt: null,
				revokedAt: null,
				createdAt: new Date("2026-09-01T00:00:00Z"),
			},
		};
		// Re-register the route with the API identity boundary for this request.
		const apiApp = new Hono();
		const prepareSecretReplacements = vi.fn().mockResolvedValue({
			secrets: [],
			modelConfiguration: undefined,
		});
		const resolveApiCredential = vi.fn().mockResolvedValue(apiIdentity);
		const authorizeCredentialScope = vi.fn(
			async (actor: { credential?: { scopes: readonly string[] } }) => {
				if (!actor.credential?.scopes.includes("agent:create"))
					throw new ApiIdentityError("not_authorized");
			},
		);
		registerManagementRoutes(apiApp, {
			identity: {
				resolve: vi.fn(),
				hydrateUsers: vi.fn().mockResolvedValue([]),
				resolveApiCredential,
			},
			apiIdentity: {
				authorizeCredentialScope,
				resolveAgentQueryGrantType: vi.fn(),
				listUserCredentials: vi.fn(),
				issueUserCredential: vi.fn(),
				revokeUserCredential: vi.fn(),
				listApplications: vi.fn(),
				createApplication: vi.fn(),
				listApplicationCredentials: vi.fn(),
				issueApplicationCredential: vi.fn(),
				revokeApplicationCredential: vi.fn(),
				grantCredentialDelivery: vi.fn(),
				revokeCredentialDelivery: vi.fn(),
				grantAgent: vi.fn(),
				revokeAgentGrant: vi.fn(),
				recordAccessRejection: vi.fn(),
			},
			foundation: {
				readApiCreationReplay: direct.readApiCreationReplay,
				submit: direct.submit,
			},
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
			prepareSecretReplacements,
			readApplicationProjection: vi.fn(),
			readAgentProjection: vi.fn(),
		});
		const response = await apiApp.request("/api/v1/agents", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				Authorization: "Bearer secret",
				"Idempotency-Key": "Direct.Aa-01",
			},
			body: JSON.stringify({
				schemaVersion: 2,
				name: "Direct agent",
				description: "Created through the API",
				source: { kind: "standard", templateId: "template-1" },
				coOwnerIds: [],
				availability: [],
				environment: [],
				secrets: [],
			}),
		});
		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({ status: "creating" });
		expect(direct.submit).toHaveBeenCalledWith(
			expect.objectContaining({ schemaVersion: 2 }),
			expect.objectContaining({
				userId: "user-1",
				principal: { kind: "application", id: "application-caller" },
				creationMode: "api",
				apiAuthority: {
					credentialId: "credential-1",
					identityRevision: "authorization-api-1",
				},
			}),
			undefined,
		);

		const attachment = { resolve: vi.fn() };
		prepareSecretReplacements.mockResolvedValue({
			secrets: [{ name: "BOT_TOKEN", replace: true }],
			modelConfiguration: undefined,
			attachment,
		});
		const withSecret = await apiApp.request("/api/v1/agents", {
			method: "POST",
			headers: {
				...headers,
				Authorization: "Bearer secret",
				"Idempotency-Key": "Direct.Aa-02",
			},
			body: JSON.stringify({
				schemaVersion: 2,
				name: "Direct agent with secret",
				description: "Created through the API",
				source: { kind: "standard", templateId: "template-1" },
				coOwnerIds: [],
				availability: [],
				environment: [],
				secrets: [{ name: "BOT_TOKEN", value: "secret-value" }],
			}),
		});
		expect(withSecret.status).toBe(201);
		expect(direct.submit).toHaveBeenLastCalledWith(
			expect.objectContaining({
				secrets: [{ name: "BOT_TOKEN", replace: true }],
			}),
			expect.objectContaining({ creationMode: "api" }),
			attachment,
		);
		expect(resolveApiCredential).toHaveBeenCalledTimes(4);
		expect(authorizeCredentialScope).toHaveBeenCalledTimes(4);
		const rejectedBody = JSON.stringify({
			schemaVersion: 2,
			name: "Changed identity during preparation",
			description: "Must not be created",
			source: { kind: "standard", templateId: "template-1" },
			coOwnerIds: [],
			availability: [],
			environment: [],
			secrets: [],
		});

		resolveApiCredential
			.mockResolvedValueOnce(apiIdentity)
			.mockResolvedValueOnce({
				...apiIdentity,
				credential: { ...apiIdentity.credential, revokedAt: new Date() },
			});
		const revokedDuringPreparation = await apiApp.request("/api/v1/agents", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				Authorization: "Bearer secret",
				"Idempotency-Key": "Direct.Aa-03",
			},
			body: rejectedBody,
		});
		expect(revokedDuringPreparation.status).toBe(403);
		expect(direct.submit).toHaveBeenCalledTimes(2);

		resolveApiCredential
			.mockResolvedValueOnce(apiIdentity)
			.mockResolvedValueOnce({
				...apiIdentity,
				credential: { ...apiIdentity.credential, scopes: ["agent:read"] },
			});
		const narrowedDuringPreparation = await apiApp.request("/api/v1/agents", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				Authorization: "Bearer secret",
				"Idempotency-Key": "Direct.Aa-04",
			},
			body: rejectedBody,
		});
		expect(narrowedDuringPreparation.status).toBe(403);
		expect(direct.submit).toHaveBeenCalledTimes(2);

		resolveApiCredential
			.mockResolvedValueOnce(apiIdentity)
			.mockResolvedValueOnce({ ...apiIdentity, ownerId: "new-owner" });
		const ownerChangedDuringPreparation = await apiApp.request(
			"/api/v1/agents",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					Authorization: "Bearer secret",
					"Idempotency-Key": "Direct.Aa-05",
				},
				body: rejectedBody,
			},
		);
		expect(ownerChangedDuringPreparation.status).toBe(403);
		expect(direct.submit).toHaveBeenCalledTimes(2);

		direct.submit.mockRejectedValueOnce(
			new ApplicationFoundationError("idempotency_conflict"),
		);
		const conflict = await apiApp.request("/api/v1/agents", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				Authorization: "Bearer secret",
				"Idempotency-Key": "Direct.Aa-06",
			},
			body: rejectedBody,
		});
		expect(conflict.status).toBe(409);

		direct.submit.mockImplementationOnce(async (command) => ({
			schemaVersion: 1,
			applicationId: command.applicationId,
			agentId: command.agentId,
			configurationRevision: 1,
			status: "pending_approval",
		}));
		const inconsistent = await apiApp.request("/api/v1/agents", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				Authorization: "Bearer secret",
				"Idempotency-Key": "Direct.Aa-07",
			},
			body: rejectedBody,
		});
		expect(inconsistent.status).toBe(503);
	});

	it("does not return an application credential to its responsible user", async () => {
		const app = new Hono();
		const issueCredential = vi.fn().mockResolvedValue({
			credentialId: "credential-issued",
			metadata: {
				schemaVersion: 1,
				credentialId: "credential-issued",
				principal: { kind: "application", id: "application-1" },
				scopes: ["agent:read"],
				expiresAt: null,
				revokedAt: null,
				createdAt: new Date("2026-09-01T00:00:00Z"),
			},
		});
		const grantCredentialDelivery = vi.fn().mockResolvedValue(undefined);
		const revokeCredentialDelivery = vi.fn().mockResolvedValue(true);
		const issueApplicationCredential = vi
			.fn()
			.mockRejectedValueOnce(new ApiIdentityError("resource_unavailable"))
			.mockImplementation((_actor, _applicationId, value) =>
				issueCredential(value),
			);
		const listCredentials = vi.fn().mockResolvedValue([
			{
				schemaVersion: 1,
				credentialId: "credential-1",
				principal: { kind: "application", id: "application-1" },
				scopes: ["agent:read"],
				expiresAt: null,
				revokedAt: null,
				createdAt: new Date("2026-09-01T00:00:00Z"),
			},
		]);
		const resolve = vi.fn().mockResolvedValue(identity);
		const resolveUser = vi.fn().mockResolvedValue({
			schemaVersion: 1,
			userId: "user-1",
			accountStatus: "active",
			organizationIds: [],
			authorizationRevision: "user-revision-1",
		});
		registerManagementRoutes(app, {
			identity: {
				resolve,
				hydrateUsers: vi.fn().mockResolvedValue([]),
				resolveUser,
			},
			apiIdentity: {
				authorizeCredentialScope: vi.fn(),
				resolveAgentQueryGrantType: vi.fn(),
				listUserCredentials: vi.fn(),
				issueUserCredential: vi.fn(),
				revokeUserCredential: vi.fn(),
				listApplications: vi.fn(),
				createApplication: vi.fn(),
				listApplicationCredentials: vi.fn().mockImplementation(() =>
					listCredentials({
						principal: { kind: "application", id: "application-1" },
					}),
				),
				issueApplicationCredential,
				revokeApplicationCredential: vi.fn(),
				grantCredentialDelivery: vi
					.fn()
					.mockImplementation((value) => grantCredentialDelivery(value)),
				revokeCredentialDelivery: vi
					.fn()
					.mockImplementation((value) => revokeCredentialDelivery(value)),
				grantAgent: vi.fn(),
				revokeAgentGrant: vi.fn(),
				recordAccessRejection: vi.fn(),
			},
			foundation: {
				readApiCreationReplay: vi.fn().mockResolvedValue(null),
				submit: vi.fn(),
			},
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
		});
		const metadataResponse = await app.request(
			"/api/v1/applications/application-1/credentials",
		);
		expect(metadataResponse.status).toBe(200);
		expect(await metadataResponse.json()).toMatchObject({
			items: [{ credentialId: "credential-1", scopes: ["agent:read"] }],
		});
		expect(listCredentials).toHaveBeenCalledWith({
			principal: { kind: "application", id: "application-1" },
		});
		const deliveryBody = JSON.stringify({
			schemaVersion: 1,
			principal: { kind: "user", id: "user-1" },
			scopes: ["agent:read"],
			expiresAt: null,
		});
		const grantedAsOwner = await app.request(
			"/api/v1/applications/application-1/credential-delivery",
			{ method: "POST", headers, body: deliveryBody },
		);
		expect(grantedAsOwner.status).toBe(204);
		expect(grantCredentialDelivery).toHaveBeenCalled();

		resolve.mockResolvedValue({
			...identity,
			roles: ["employee", "system_admin"],
		});
		const granted = await app.request(
			"/api/v1/applications/application-1/credential-delivery",
			{ method: "POST", headers, body: deliveryBody },
		);
		expect(granted.status).toBe(204);
		expect(grantCredentialDelivery).toHaveBeenCalledWith(
			expect.objectContaining({
				applicationId: "application-1",
				principal: { kind: "user", id: "user-1" },
				scopes: ["agent:read"],
				expiresAt: null,
			}),
		);
		const revoked = await app.request(
			"/api/v1/applications/application-1/credential-delivery",
			{
				method: "DELETE",
				headers,
				body: JSON.stringify({ kind: "user", id: "user-1" }),
			},
		);
		expect(revoked.status).toBe(204);
		expect(revokeCredentialDelivery).toHaveBeenCalledOnce();
		resolveUser.mockResolvedValue({
			schemaVersion: 1,
			userId: "user-1",
			accountStatus: "disabled",
			organizationIds: [],
			authorizationRevision: "user-revision-2",
		});
		const disabledGrant = await app.request(
			"/api/v1/applications/application-1/credential-delivery",
			{ method: "POST", headers, body: deliveryBody },
		);
		expect(disabledGrant.status).toBe(204);
		expect(grantCredentialDelivery).toHaveBeenCalledTimes(3);
		resolve.mockResolvedValue(identity);

		const response = await app.request(
			"/api/v1/applications/application-1/credentials",
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					schemaVersion: 1,
					scopes: ["agent:read"],
					expiresAt: null,
					recipient: { kind: "user", id: "user-2" },
				}),
			},
		);

		expect(response.status).toBe(404);
		expect(issueApplicationCredential).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "user-1" }),
			"application-1",
			expect.objectContaining({ recipient: { kind: "user", id: "user-2" } }),
		);
		expect(issueCredential).not.toHaveBeenCalled();

		resolve.mockResolvedValue({
			...identity,
			userId: "user-2",
			displayName: "Recipient",
		});
		const recipientResponse = await app.request(
			"/api/v1/applications/application-1/credentials",
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					schemaVersion: 1,
					scopes: ["agent:read"],
					expiresAt: null,
				}),
			},
		);
		expect(recipientResponse.status).toBe(201);
		expect(await recipientResponse.json()).toMatchObject({
			metadata: { principal: { kind: "application", id: "application-1" } },
			credential: expect.any(String),
		});
		expect(issueCredential).toHaveBeenCalledOnce();
	});

	it("grants and revokes an application principal through the owner boundary", async () => {
		const app = new Hono();
		const grantAgent = vi.fn().mockResolvedValue("authorization-revision-2");
		const revokeAgentGrant = vi.fn().mockResolvedValue(true);
		const getAgent = vi.fn().mockResolvedValue(agentRecord);
		registerManagementRoutes(app, {
			identity: {
				resolve: vi.fn().mockResolvedValue(identity),
				hydrateUsers: vi.fn().mockResolvedValue([]),
			},
			apiIdentity: {
				authorizeCredentialScope: vi.fn(),
				resolveAgentQueryGrantType: vi.fn(),
				listUserCredentials: vi.fn(),
				issueUserCredential: vi.fn(),
				revokeUserCredential: vi.fn(),
				listApplications: vi.fn(),
				createApplication: vi.fn(),
				listApplicationCredentials: vi.fn(),
				issueApplicationCredential: vi.fn(),
				revokeApplicationCredential: vi.fn(),
				grantCredentialDelivery: vi.fn(),
				revokeCredentialDelivery: vi.fn(),
				grantAgent,
				revokeAgentGrant,
				recordAccessRejection: vi.fn(),
			},
			foundation: {
				readApiCreationReplay: vi.fn().mockResolvedValue(null),
				submit: vi.fn(),
			},
			revision: { revise: vi.fn() },
			management: { executeManagementCommand: vi.fn() },
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
			readAgentProjection: vi.fn(),
		});
		const body = JSON.stringify({
			schemaVersion: 1,
			principal: { kind: "application", id: "application-caller" },
			grantType: "use",
		});
		const granted = await app.request("/api/v1/agents/agent-1/grants", {
			method: "POST",
			headers,
			body,
		});
		expect(granted.status).toBe(200);
		expect(await granted.json()).toMatchObject({
			agentId: "agent-1",
			principal: { kind: "application", id: "application-caller" },
			grantType: "use",
			revokedAt: null,
		});
		expect(grantAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-1",
				principal: { kind: "application", id: "application-caller" },
				grantType: "use",
			}),
		);

		const revoked = await app.request("/api/v1/agents/agent-1/grants", {
			method: "DELETE",
			headers,
			body,
		});
		expect(revoked.status).toBe(204);
		expect(revokeAgentGrant).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-1",
				principal: { kind: "application", id: "application-caller" },
				grantType: "use",
			}),
		);
	});

	it("submits a credential-free application without preparing an attachment", async () => {
		const { app, submit, prepareSecretReplacements } = createApp();
		const response = await app.request("/api/v1/agent-applications", {
			method: "POST",
			headers,
			body: JSON.stringify({ ...applicationBody, secrets: [] }),
		});

		expect(response.status).toBe(201);
		expect(prepareSecretReplacements).not.toHaveBeenCalled();
		expect(submit).toHaveBeenCalledWith(
			expect.objectContaining({ secrets: [] }),
			expect.anything(),
			undefined,
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

	it("audits API agent resource refusals", async () => {
		const missing = createApp({ missing: true, api: true });
		const apiHeaders = { Authorization: "Bearer secret" };

		const detail = await missing.app.request("/api/v1/agents/unknown", {
			headers: apiHeaders,
		});
		expect(detail.status).toBe(404);
		expect(missing.recordAccessRejection).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				targetId: "unknown",
				reason: "resource_unavailable",
			}),
		);

		missing.recordAccessRejection.mockClear();
		const lifecycle = await missing.app.request(
			"/api/v1/agents/unknown/lifecycle",
			{
				method: "POST",
				headers: {
					...apiHeaders,
					"content-type": "application/json",
					"Idempotency-Key": "api-missing-agent",
				},
				body: JSON.stringify({ schemaVersion: 1, command: "restart" }),
			},
		);
		expect(lifecycle.status).toBe(404);
		expect(missing.recordAccessRejection).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				targetId: "unknown",
				reason: "resource_unavailable",
			}),
		);
	});

	it("starts a stopped Agent through the supported restart transition", async () => {
		const input = createApp({ api: true });
		input.getAgent.mockResolvedValue({
			...agentRecord,
			management: { ...management, status: "stopped" },
		});
		const response = await input.app.request(
			"/api/v1/agents/agent-1/lifecycle",
			{
				method: "POST",
				headers: { ...headers, Authorization: "Bearer secret" },
				body: JSON.stringify({ schemaVersion: 1, command: "start" }),
			},
		);
		expect(response.status).toBe(202);
		expect(input.executeManagementCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "start_agent",
				expectedRevision: management.revision,
			}),
			expect.objectContaining({
				principal: { kind: "application", id: "application-caller" },
				apiAuthority: {
					credentialId: "credential-1",
					identityRevision: "authorization-api-1",
				},
			}),
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
