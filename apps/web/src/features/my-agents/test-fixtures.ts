import { AgentApplicationProjectionV2Schema } from "@agent-infra/contracts/pilot";

export const pendingApplication = AgentApplicationProjectionV2Schema.parse({
	schemaVersion: 2,
	applicationId: "application:tenant/01?draft#one%",
	agentId: null,
	name: "Release assistant request",
	description: "Helps the release team",
	source: { kind: "standard", templateId: "codex" },
	status: "pending_approval",
	resourceProfile: {
		profileId: "small",
		displayName: "Small",
		estimatedResources: {
			cpuMillicores: 250,
			memoryMiB: 512,
			storageGiB: 1,
		},
	},
	configuration: {
		owners: [
			{
				userId: "user-applicant-1",
				displayName: "Applicant",
				roles: ["employee"],
			},
		],
		availability: [],
		modelOptions: [],
		defaultModelOptionId: null,
		defaultReasoningLevel: null,

		environment: [],
		channels: [],
		secrets: [],
	},
	submittedAt: "2026-09-03T08:00:00Z",
	decision: null,
});

export const creatingApplication = AgentApplicationProjectionV2Schema.parse({
	...pendingApplication,
	applicationId: "application-pilot-2",
	agentId: "agent-pilot-2",
	name: "Created release assistant",
	status: "creating",
});
