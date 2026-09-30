import {
	AgentApplicationProjectionV2Schema,
	AgentProjectionV2Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import { ModelConfigurationErrorV1 } from "@agent-infra/model-catalog";
import {
	type AgentDefaultRelayKeyAttachmentV1,
	ApiIdentityError,
	type ApplicationFoundationUseCaseV1,
} from "@agent-infra/platform-core";
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
	const prepareApiCreation = vi.fn<
		ApplicationFoundationUseCaseV1["prepareApiCreation"]
	>(async (_query, _actor, prepare) => ({
		outcome: "prepared",
		prepared: await prepare(),
	}));
	const prepareWebCreation = vi.fn<
		ApplicationFoundationUseCaseV1["prepareWebCreation"]
	>(async (_query, _actor, prepare) => ({
		outcome: "prepared",
		prepared: await prepare(),
	}));
	const prepareSecretReplacements = vi.fn().mockResolvedValue({ secrets: [] });
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
	const admitAgentDefaultModels = vi.fn().mockResolvedValue({
		catalogRevision: "catalog-1",
		runtime: {},
	});
	const encryptAgentDefaultRelayKey = vi.fn().mockReturnValue({});
	const currentAgentDefaultRelayKey = vi.fn().mockResolvedValue({
		schemaVersion: 1,
		isSet: true,
		keyVersion: 1,
	});
	const replaceAgentDefaultRelayKey = vi.fn().mockResolvedValue({
		schemaVersion: 1,
		isSet: true,
		keyVersion: 2,
	});
	const recordAgentDefaultRelayKeyRejection = vi
		.fn()
		.mockResolvedValue(undefined);

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
		foundation: {
			prepareApiCreation,
			prepareWebCreation,
			submit,
		},
		revision: { revise: vi.fn().mockResolvedValue({}) },
		management: { executeManagementCommand },
		apiIdentity: apiIdentity as never,
		agentDefaultRelayKeyEncryptor: {
			encrypt: encryptAgentDefaultRelayKey,
		},
		agentDefaultRelayKey: {
			current: currentAgentDefaultRelayKey,
			replace: replaceAgentDefaultRelayKey,
			recordRejected: recordAgentDefaultRelayKeyRejection,
		},
		admitAgentDefaultModels,
		configuration: { upgradeCustomImage: vi.fn().mockResolvedValue({}) },
		query: { listApplications, getApplication, listAgents, getAgent },
		allocateApplicationIds,
		prepareSecretReplacements,
		readApplicationProjection,
		readAgentProjection,
	});

	return {
		app,
		submit,
		prepareApiCreation,
		prepareWebCreation,
		prepareSecretReplacements,
		executeManagementCommand,
		listAgents,
		getAgent,
		apiIdentity,
		apiContext,
		admitAgentDefaultModels,
		encryptAgentDefaultRelayKey,
		currentAgentDefaultRelayKey,
		replaceAgentDefaultRelayKey,
		recordAgentDefaultRelayKeyRejection,
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
const directCreationBody = {
	...applicationBody,
	schemaVersion: 3,
	agentDefaultRelayKey: "candidate-relay-key",
	modelSelection: {
		catalogRevision: "catalog-1",
		options: [
			{
				optionId: "option-1",
				endpointId: "relay-1",
				modelId: "model-1",
				reasoningLevels: ["medium"],
			},
		],
		defaultOptionId: "option-1",
		defaultReasoningLevel: "medium",
	},
};

describe("V2 management routes", () => {
	it("reads and replaces an Agent default Key without returning its value", async () => {
		const { app, currentAgentDefaultRelayKey, replaceAgentDefaultRelayKey } =
			createApp();
		const read = await app.request("/api/v2/agents/agent-1/default-relay-key");
		expect(read.status).toBe(200);
		expect(await read.json()).toEqual({
			schemaVersion: 1,
			isSet: true,
			keyVersion: 1,
		});
		expect(currentAgentDefaultRelayKey).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "user-1" }),
			"agent-1",
			expect.any(String),
			expect.any(String),
		);
		const write = await app.request(
			"/api/v2/agents/agent-1/default-relay-key",
			{
				method: "PUT",
				headers,
				body: JSON.stringify({
					schemaVersion: 1,
					expectedVersion: 1,
					keyValue: "replacement-relay-key",
					modelSelection: directCreationBody.modelSelection,
				}),
			},
		);
		expect(write.status).toBe(200);
		expect(await write.json()).toEqual({
			schemaVersion: 1,
			isSet: true,
			keyVersion: 2,
		});
		expect(replaceAgentDefaultRelayKey).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "user-1" }),
			"agent-1",
			expect.objectContaining({
				expectedVersion: 1,
				keyValue: "replacement-relay-key",
				modelSelection: directCreationBody.modelSelection,
			}),
			expect.any(String),
			expect.any(String),
		);
	});

	it("passes user API credential authority to the default Key boundary", async () => {
		const {
			app,
			apiContext,
			currentAgentDefaultRelayKey,
			replaceAgentDefaultRelayKey,
		} = createApp();
		Object.assign(apiContext, {
			principal: { kind: "user", id: "user-1" },
			ownerId: "user-1",
			authorizationRevision: "user-revision-1",
			credential: {
				...apiContext.credential,
				principal: { kind: "user", id: "user-1" },
			},
		});
		const authority = {
			userId: "user-1",
			principal: { kind: "user", id: "user-1" },
			credential: expect.objectContaining({ credentialId: "credential-api" }),
			identityRevision: "user-revision-1",
		};
		const read = await app.request("/api/v2/agents/agent-1/default-relay-key", {
			headers: { Authorization: "Bearer user-token" },
		});
		expect(read.status).toBe(200);
		expect(currentAgentDefaultRelayKey).toHaveBeenCalledWith(
			expect.objectContaining(authority),
			"agent-1",
			expect.any(String),
			expect.any(String),
		);
		const write = await app.request(
			"/api/v2/agents/agent-1/default-relay-key",
			{
				method: "PUT",
				headers: { ...headers, Authorization: "Bearer user-token" },
				body: JSON.stringify({
					schemaVersion: 1,
					expectedVersion: 1,
					keyValue: "replacement-relay-key",
					modelSelection: directCreationBody.modelSelection,
				}),
			},
		);
		expect(write.status).toBe(200);
		expect(replaceAgentDefaultRelayKey).toHaveBeenCalledWith(
			expect.objectContaining(authority),
			"agent-1",
			expect.any(Object),
			expect.any(String),
			expect.any(String),
		);
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

	it("lists all Agents only for a current browser administrator", async () => {
		const administrator = createApp({ administrator: true });
		const response = await administrator.app.request(
			"/api/v2/admin/agents?limit=10",
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			items: [{ schemaVersion: 2, agentId: "agent-1" }],
			nextCursor: null,
		});
		expect(administrator.listAgents).toHaveBeenCalledWith(
			{ kind: "administrator" },
			{ limit: 10 },
		);
		for (const [request, status] of [
			[new Request("http://localhost/api/v2/admin/agents"), 403],
			[
				new Request("http://localhost/api/v2/admin/agents", {
					headers: { Authorization: "Bearer application-token" },
				}),
				401,
			],
		] as const) {
			const candidate = createApp();
			const denied = await candidate.app.request(request);
			expect(denied.status).toBe(status);
			expect(candidate.listAgents).not.toHaveBeenCalled();
		}
	});

	it("submits V3 application input with a default Key and projects V2 output", async () => {
		const { app, submit } = createApp();
		const response = await app.request(
			"/api/v2/agent-applications/default-key",
			{
				method: "POST",
				headers,
				body: JSON.stringify(directCreationBody),
			},
		);

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
			expect.objectContaining({
				admitModels: expect.any(Function),
				encrypt: expect.any(Function),
			}),
		);
	});

	it("preserves V2 custom-Agent application creation", async () => {
		const { app, submit } = createApp();
		const response = await app.request("/api/v2/agent-applications", {
			method: "POST",
			headers,
			body: JSON.stringify({
				...applicationBody,
				source: {
					kind: "custom",
					imageReference: "registry.example/agent:1",
					interactionMode: "platform-adapter",
				},
			}),
		});
		expect(response.status).toBe(201);
		expect(submit).toHaveBeenCalledWith(
			expect.objectContaining({ applicationId: "application-1" }),
			expect.objectContaining({ userId: "user-1" }),
			undefined,
			undefined,
		);
	});

	it("rejects legacy per-model creation for a new standard Agent", async () => {
		const { app, submit, prepareWebCreation } = createApp();
		const response = await app.request("/api/v2/agent-applications", {
			method: "POST",
			headers,
			body: JSON.stringify({
				...applicationBody,
				modelConfiguration: {
					options: [
						{
							optionId: "model_primary",
							endpointId: "relay-1",
							modelId: "model-1",
							reasoningLevels: ["low"],
							credentialValue: "legacy-per-model-key",
						},
					],
					defaultOptionId: "model_primary",
					defaultReasoningLevel: "low",
				},
			}),
		});
		expect(response.status).toBe(400);
		expect(prepareWebCreation).not.toHaveBeenCalled();
		expect(submit).not.toHaveBeenCalled();
	});

	it("returns a saved default-Key application before secret preparation", async () => {
		const {
			app,
			submit,
			prepareWebCreation,
			prepareSecretReplacements,
			admitAgentDefaultModels,
			encryptAgentDefaultRelayKey,
		} = createApp();
		prepareWebCreation.mockImplementation(async (query) => ({
			outcome: "replayed" as const,
			result: {
				schemaVersion: 1 as const,
				applicationId: query.applicationId,
				agentId: query.agentId,
				configurationRevision: 1 as const,
				status: "pending_approval" as const,
			},
		}));
		prepareSecretReplacements.mockRejectedValue(
			new Error("preparation is unavailable"),
		);
		const response = await app.request(
			"/api/v2/agent-applications/default-key",
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					...directCreationBody,
					secrets: [{ name: "BOT_TOKEN", value: "candidate-secret" }],
				}),
			},
		);
		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			schemaVersion: 2,
			applicationId: "application-1",
		});
		expect(prepareSecretReplacements).not.toHaveBeenCalled();
		expect(submit).not.toHaveBeenCalled();
		expect(admitAgentDefaultModels).not.toHaveBeenCalled();
		expect(encryptAgentDefaultRelayKey).not.toHaveBeenCalled();
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

	it("returns a saved direct creation before mutable preparation", async () => {
		const {
			app,
			submit,
			prepareApiCreation,
			prepareSecretReplacements,
			admitAgentDefaultModels,
			encryptAgentDefaultRelayKey,
		} = createApp();
		prepareApiCreation.mockImplementation(async (query) => ({
			outcome: "replayed" as const,
			result: {
				schemaVersion: 1 as const,
				applicationId: query.applicationId,
				agentId: query.agentId,
				configurationRevision: 1 as const,
				status: "creating" as const,
			},
		}));
		prepareSecretReplacements.mockRejectedValue(
			new Error("preparation is unavailable"),
		);
		const response = await app.request("/api/v2/agents", {
			method: "POST",
			headers: { ...headers, Authorization: "Bearer application-token" },
			body: JSON.stringify(directCreationBody),
		});
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({
			schemaVersion: 2,
			applicationId: expect.any(String),
			agentId: expect.any(String),
			status: "creating",
		});
		expect(prepareSecretReplacements).not.toHaveBeenCalled();
		expect(submit).not.toHaveBeenCalled();
		expect(admitAgentDefaultModels).not.toHaveBeenCalled();
		expect(encryptAgentDefaultRelayKey).not.toHaveBeenCalled();
	});

	it("supports API direct creation and lifecycle with current credential authority", async () => {
		const {
			app,
			apiIdentity,
			submit,
			executeManagementCommand,
			admitAgentDefaultModels,
			encryptAgentDefaultRelayKey,
		} = createApp();
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
			body: JSON.stringify(directCreationBody),
		});
		expect(create.status).toBe(201);
		expect(apiIdentity.authorizeCredentialScope).toHaveBeenCalledWith(
			expect.objectContaining({
				principal: { kind: "application", id: "application-api" },
				identityRevision: "application-revision-1",
			}),
			["agent:create"],
			expect.anything(),
		);
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
			expect.objectContaining({
				admitModels: expect.any(Function),
				encrypt: expect.any(Function),
			}),
		);
		const attachment = submit.mock
			.calls[0]?.[3] as AgentDefaultRelayKeyAttachmentV1;
		const admissionInput = {
			agentId: "agent-1",
			requestId: "request-1",
			traceId: "trace-1",
			source: {
				kind: "standard" as const,
				templateId: "template-1",
				imageDigest: `sha256:${"a".repeat(64)}`,
				admissionRevision: "admission-1",
				connectionEnabled: false,
				allowedEnvironmentKeys: [],
				allowedSecretKeys: [],
				platformManagedKeys: [],
			},
		};
		await attachment.admitModels(admissionInput);
		expect(admitAgentDefaultModels).toHaveBeenCalledWith({
			...admissionInput,
			requested: directCreationBody.modelSelection,
			candidateRelayKey: directCreationBody.agentDefaultRelayKey,
		});
		const binding = {
			purpose: "agent-default" as const,
			subjectId: "agent-1",
			keyId: "key-1",
			keyVersion: 1 as const,
		};
		attachment.encrypt(binding);
		expect(encryptAgentDefaultRelayKey).toHaveBeenCalledWith({
			...binding,
			plaintext: directCreationBody.agentDefaultRelayKey,
		});

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

	it.each([
		{ ...directCreationBody, agentDefaultRelayKey: undefined },
		{ ...directCreationBody, modelSelection: undefined },
		{ ...directCreationBody, schemaVersion: 2 },
		{
			...directCreationBody,
			source: { kind: "custom", imageReference: "image-1" },
		},
	])("rejects invalid V3 direct creation input", async (body) => {
		const { app, submit } = createApp();
		const response = await app.request("/api/v2/agents", {
			method: "POST",
			headers: { ...headers, Authorization: "Bearer application-token" },
			body: JSON.stringify(body),
		});
		expect(response.status).toBe(400);
		expect(submit).not.toHaveBeenCalled();
	});

	it.each([
		{ retryable: false, status: 409 },
		{ retryable: true, status: 503 },
	])(
		"maps model admission failure to $status",
		async ({ retryable, status }) => {
			const { app, submit, admitAgentDefaultModels } = createApp();
			admitAgentDefaultModels.mockRejectedValueOnce(
				new ModelConfigurationErrorV1(retryable),
			);
			submit.mockImplementation(
				async (
					_command: unknown,
					_actor: unknown,
					_attachment: unknown,
					agentDefaultRelayKey: AgentDefaultRelayKeyAttachmentV1,
				) =>
					agentDefaultRelayKey.admitModels({
						agentId: "agent-1",
						requestId: "request-1",
						traceId: "trace-1",
						source: {
							kind: "standard",
							templateId: "template-1",
							imageDigest: `sha256:${"a".repeat(64)}`,
							admissionRevision: "admission-1",
							connectionEnabled: false,
							allowedEnvironmentKeys: [],
							allowedSecretKeys: [],
							platformManagedKeys: [],
						},
					}),
			);
			const response = await app.request("/api/v2/agents", {
				method: "POST",
				headers: { ...headers, Authorization: "Bearer application-token" },
				body: JSON.stringify(directCreationBody),
			});
			expect(response.status).toBe(status);
		},
	);

	it.each(["retry_creation", "disable", "upgrade_custom_image"] as const)(
		"audits V2 API lifecycle rejection for %s",
		async (command) => {
			const { app, apiIdentity, executeManagementCommand } = createApp();
			const response = await app.request("/api/v2/agents/agent-1/lifecycle", {
				method: "POST",
				headers: { ...headers, Authorization: "Bearer application-token" },
				body: JSON.stringify({
					schemaVersion: 1,
					command,
					...(command === "upgrade_custom_image"
						? { imageReference: "registry.example/agent:v2" }
						: {}),
				}),
			});
			expect(response.status).toBe(403);
			expect(apiIdentity.recordAccessRejection).toHaveBeenCalledOnce();
			expect(executeManagementCommand).not.toHaveBeenCalled();
		},
	);

	it("passes browser start to Core and returns its transition decision", async () => {
		const { app, getAgent, executeManagementCommand } = createApp();
		executeManagementCommand.mockResolvedValueOnce({
			outcome: "conflict",
			reason: "invalid_transition",
			writePlan: null,
		});
		getAgent.mockResolvedValue({
			...agentRecord,
			management: { ...management, status: "available" },
		});
		const request = () =>
			app.request("/api/v2/agents/agent-1/lifecycle", {
				method: "POST",
				headers,
				body: JSON.stringify({ schemaVersion: 1, command: "start" }),
			});

		const conflict = await request();
		expect(conflict.status).toBe(409);
		expect(executeManagementCommand).toHaveBeenCalledWith(
			expect.objectContaining({ command: "start_agent" }),
			expect.objectContaining({ userId: "user-1" }),
		);

		getAgent.mockResolvedValue({
			...agentRecord,
			management: { ...management, status: "stopped" },
		});
		const accepted = await request();
		expect(accepted.status).toBe(202);
		expect(executeManagementCommand).toHaveBeenCalledWith(
			expect.objectContaining({ command: "start_agent" }),
			expect.objectContaining({ userId: "user-1" }),
		);
	});
});
