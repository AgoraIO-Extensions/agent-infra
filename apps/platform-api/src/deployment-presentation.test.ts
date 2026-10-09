import { describe, expect, it, vi } from "vitest";

import { createDeploymentPresentation } from "./deployment-presentation.js";

const identity = {
	schemaVersion: 1 as const,
	userId: "user_01",
	displayName: "Employee",
	accountStatus: "active" as const,
	organizationIds: ["org_01"],
	roles: ["employee" as const],
	authorizationRevision: "authrev_01",
};

const configuration = {
	agentId: "agent_01",
	revision: 1,
	source: {
		kind: "custom" as const,
		interactionMode: "self-managed" as const,
		identityResponsibility: "platform-managed" as const,
		connectionEnabled: false,
	},
	ownerIds: ["user_01"],
	availability: [],
	modelOptions: [],
	defaultModelOptionId: null,
	defaultReasoningLevel: null,
	environment: [],
	channelKinds: [],
	secrets: [],
};

const management = {
	schemaVersion: 1 as const,
	applicationId: "application_01",
	agentId: "agent_01",
	applicantId: "user_01",
	status: "available" as const,
	revision: 1,
	approvalRevision: 1,
	decisionReason: null,
	serviceAvailability: "ready" as const,
	desiredState: "running" as const,
	workloadRevision: 1,
	fence: 1,
	ownerIds: ["user_01"],
	availability: [],
	failureCode: null,
};

describe("deployment presentation platform identity route", () => {
	it("uses only a resolver-provided canonical HTTPS origin", async () => {
		const request = new Request("https://platform.test/agents/agent_01");
		const present = createDeploymentPresentation({
			identityScope: {
				currentRequest: () => request,
				currentIdentity: async () => identity,
			} as never,
			configurationQuery: {
				readRuntimePresentation: vi.fn().mockResolvedValue({
					outcome: "found",
					sourceReference: "sha256:custom",
					capabilities: {},
					interactionUrl: null,
				}),
			},
			resourceProfile: {
				profileId: "profile_01",
				displayName: "Small",
				estimatedResources: {
					cpuMillicores: 100,
					memoryMiB: 128,
					storageGiB: 1,
				},
			},
			imageRepository: "registry.example.test/agents",
			resolveCustomAgentInteractionUrl: async () =>
				"https://agent.example.test",
		});
		const result = await present({
			agentId: "agent_01",
			configuration,
			management,
		});
		expect(result.interactionUrl).toBe("https://agent.example.test");

		const unsafe = createDeploymentPresentation({
			identityScope: {
				currentRequest: () => request,
				currentIdentity: async () => identity,
			} as never,
			configurationQuery: {
				readRuntimePresentation: vi.fn().mockResolvedValue({
					outcome: "found",
					sourceReference: "sha256:custom",
					capabilities: {},
					interactionUrl: null,
				}),
			},
			resourceProfile: {
				profileId: "profile_01",
				displayName: "Small",
				estimatedResources: {
					cpuMillicores: 100,
					memoryMiB: 128,
					storageGiB: 1,
				},
			},
			imageRepository: "registry.example.test/agents",
			resolveCustomAgentInteractionUrl: async () => "http://agent.example.test",
		});
		expect(
			(await unsafe({ agentId: "agent_01", configuration, management }))
				.interactionUrl,
		).toBeNull();
	});
});
