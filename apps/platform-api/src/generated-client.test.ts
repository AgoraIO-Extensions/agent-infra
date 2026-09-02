import { describe, expect, it, vi } from "vitest";

import { createPlatformApp } from "./app.js";

const generatedClient = await import(
	new URL("../../web/src/pilot/generated/client/index.ts", import.meta.url).href
);
const generatedSdk = await import(
	new URL("../../web/src/pilot/generated/index.ts", import.meta.url).href
);
const { createClient } = generatedClient;
const {
	commandAgentLifecycle,
	createAgentApplication,
	decideAgentApplication,
	getAgent,
	getAgentApplication,
	getCurrentSession,
	listAgentApplications,
	listAgents,
	listPendingAgentApplications,
	listPlatformAudit,
	updateAgentApplication,
	updateAgentConfiguration,
	withdrawAgentApplication,
} = generatedSdk;

const identity = {
	schemaVersion: 1 as const,
	userId: "user-1",
	displayName: "Ada",
	accountStatus: "active" as const,
	organizationIds: ["org-1"],
	roles: ["employee" as const, "system_admin" as const],
	authorizationRevision: "authorization-1",
};
const management = {
	schemaVersion: 1 as const,
	applicationId: "application-1",
	agentId: "agent-1",
	applicantId: "user-1",
	status: "available" as const,
	revision: 3,
	approvalRevision: 2,
	decisionReason: null,
	serviceAvailability: "ready" as const,
	desiredState: "running" as const,
	workloadRevision: 1,
	fence: 1,
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
	submittedAt: new Date("2026-09-01T00:00:00.000Z"),
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
	secrets: [],
};
const applicationProjection = {
	schemaVersion: 1 as const,
	applicationId: "application-1",
	agentId: "agent-1",
	name: applicationRecord.name,
	description: applicationRecord.description,
	source: { kind: "standard" as const, templateId: "template-1" },
	status: management.status,
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
	submittedAt: applicationRecord.submittedAt.toISOString(),
	decision: null,
};
const agentProjection = {
	schemaVersion: 1 as const,
	agentId: "agent-1",
	name: agentRecord.name,
	description: agentRecord.description,
	source: { kind: "standard" as const, templateId: "template-1" },
	managementStatus: management.status,
	serviceAvailability: management.serviceAvailability,
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
const applicationBody = {
	schemaVersion: 1 as const,
	name: applicationRecord.name,
	description: applicationRecord.description,
	source: { kind: "standard" as const, templateId: "template-1" },
	coOwnerIds: [],
	availability: management.availability,
	actions: [],
	environment: [],
	secrets: [],
};

function testApp() {
	const resolve = vi.fn().mockResolvedValue(identity);
	const identityAdapter = {
		resolve,
		hydrateUsers: vi.fn().mockResolvedValue([]),
	};
	const updateConfiguration = vi.fn().mockResolvedValue({
		schemaVersion: 1,
		agentId: "agent-1",
		revision: 4,
		changedFields: ["environment"],
	});
	const query = {
		listApplications: vi
			.fn()
			.mockResolvedValue({ items: [applicationRecord], nextAfterId: null }),
		getApplication: vi.fn().mockResolvedValue(applicationRecord),
		listAgents: vi
			.fn()
			.mockResolvedValue({ items: [agentRecord], nextAfterId: null }),
		getAgent: vi.fn().mockResolvedValue(agentRecord),
	};
	const app = createPlatformApp({
		management: {
			identity: identityAdapter,
			foundation: { submit: vi.fn().mockResolvedValue({}) },
			revision: { revise: vi.fn().mockResolvedValue({}) },
			management: {
				executeManagementCommand: vi.fn().mockResolvedValue({
					outcome: "accepted",
					result: {},
					writePlan: {},
				}),
			},
			configuration: { update: updateConfiguration },
			configurationQuery: {
				read: vi.fn().mockResolvedValue({ outcome: "unavailable" }),
			},
			query,
			allocateApplicationIds: vi.fn().mockResolvedValue({
				applicationId: "application-1",
				agentId: "agent-1",
			}),
			prepareSecretReplacements: vi.fn().mockResolvedValue({ secrets: [] }),
			readApplicationProjection: vi
				.fn()
				.mockResolvedValue(applicationProjection),
			readAgentProjection: vi.fn().mockResolvedValue(agentProjection),
		},
		configuration: {
			identity: identityAdapter,
			configuration: { update: updateConfiguration },
			readAgentProjection: vi.fn().mockResolvedValue(agentProjection),
			prepareSecretReplacements: vi.fn().mockResolvedValue({
				secrets: [],
				modelCredentialOptionIds: [],
			}),
		},
		sessionAudit: {
			identity: identityAdapter,
			audit: {
				listAudit: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
			},
		},
	});
	return { app, resolve };
}

describe("generated Pilot browser client", () => {
	it("consumes every #288 management operation through the Hono Adapter", async () => {
		const { app, resolve } = testApp();
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async (input: string | URL | Request, init?: RequestInit) =>
				app.fetch(input instanceof Request ? input : new Request(input, init)),
		});
		const idempotency = { "Idempotency-Key": "generated-client-1" };
		const results = await Promise.all([
			getCurrentSession({ client }),
			listAgentApplications({ client }),
			createAgentApplication({
				client,
				body: applicationBody,
				headers: idempotency,
			}),
			getAgentApplication({
				client,
				path: { applicationId: "application-1" },
			}),
			updateAgentApplication({
				client,
				path: { applicationId: "application-1" },
				body: (({ secrets: _secrets, ...body }) => body)(applicationBody),
				headers: idempotency,
			}),
			withdrawAgentApplication({
				client,
				path: { applicationId: "application-1" },
				headers: idempotency,
			}),
			listPendingAgentApplications({ client }),
			decideAgentApplication({
				client,
				path: { applicationId: "application-1" },
				body: { schemaVersion: 1, decision: "approve" },
				headers: idempotency,
			}),
			listAgents({ client }),
			getAgent({ client, path: { agentId: "agent-1" } }),
			updateAgentConfiguration({
				client,
				path: { agentId: "agent-1" },
				body: { schemaVersion: 1, environment: [] },
				headers: idempotency,
			}),
			commandAgentLifecycle({
				client,
				path: { agentId: "agent-1" },
				body: { schemaVersion: 1, command: "stop" },
				headers: idempotency,
			}),
			listPlatformAudit({ client }),
		]);

		expect(results.map(({ response }) => response?.status)).toEqual([
			200, 200, 201, 200, 200, 200, 200, 200, 200, 200, 200, 202, 200,
		]);
		expect(results.every(({ error }) => error === undefined)).toBe(true);
		expect(resolve).toHaveBeenCalledTimes(results.length);
	});
});
