import { AgentProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { describe, expect, it } from "vitest";

import {
	buildAgentConfigurationRequest,
	configurationDraftFromAgent,
} from "./agent-configuration-draft.js";

const agent = AgentProjectionV1Schema.parse({
	schemaVersion: 1,
	agentId: "agent-configuration-1",
	name: "Configuration assistant",
	description: "Helps the release team",
	source: { kind: "standard", templateId: "codex" },
	managementStatus: "available",
	serviceAvailability: "ready",
	configuration: {
		owners: [
			{
				userId: "user-owner-1",
				displayName: "Owner",
				roles: ["employee"],
			},
		],
		availability: [
			{ kind: "user", userId: "user-reader-1" },
			{ kind: "organization", organizationId: "organization-1" },
		],
		modelOptions: [
			{
				optionId: "model-option-1",
				displayName: "GPT 5",
				modelId: "gpt-5",
				reasoningLevels: ["medium", "high"],
			},
		],
		defaultModelOptionId: "model-option-1",
		defaultReasoningLevel: "medium",
		actions: [
			{
				providerId: "github",
				actionId: "issues.read",
				actionVersion: "3",
			},
		],
		environment: [{ name: "LOG_LEVEL", value: "info" }],
		channels: [{ kind: "web", status: "available" }],
		secrets: [{ name: "MODEL_API_KEY", isSet: true, version: 4 }],
	},
	capabilities: {
		modelSelection: true,
		attachments: false,
		resultFiles: false,
		connection: true,
		supplementaryInstruction: false,
	},
	interactionUrl: null,
});

describe("Agent configuration draft", () => {
	it("initializes editable values without reconstructing Secrets or credentials", () => {
		const draft = configurationDraftFromAgent(agent);

		expect(draft).toMatchObject({
			coOwnerIds: "user-owner-1",
			userAvailabilityIds: "user-reader-1",
			organizationAvailabilityIds: "organization-1",
			actions: [
				{
					providerId: "github",
					actionId: "issues.read",
					actionVersion: "3",
				},
			],
			models: [],
			secrets: [],
		});
		expect(JSON.stringify(draft)).not.toContain("MODEL_API_KEY");
	});

	it("serializes only explicit Secret and credential replacements", () => {
		const draft = configurationDraftFromAgent(agent);
		const request = buildAgentConfigurationRequest({
			...draft,
			replaceModels: true,
			models: [
				{
					optionId: "model-option-2",
					endpointId: "endpoint-primary",
					modelId: "gpt-5.2",
					reasoningLevels: "medium\nhigh",
					credentialValue: "new-credential",
				},
			],
			defaultModelOptionId: "model-option-2",
			defaultReasoningLevel: "high",
			secrets: [{ name: "MODEL_API_KEY", value: "new-secret" }],
		});

		expect(request).toEqual({
			schemaVersion: 1,
			coOwnerIds: ["user-owner-1"],
			availability: [
				{ kind: "user", userId: "user-reader-1" },
				{ kind: "organization", organizationId: "organization-1" },
			],
			actions: [
				{
					providerId: "github",
					actionId: "issues.read",
					actionVersion: "3",
				},
			],
			modelConfiguration: {
				options: [
					{
						optionId: "model-option-2",
						endpointId: "endpoint-primary",
						modelId: "gpt-5.2",
						reasoningLevels: ["medium", "high"],
						credentialValue: "new-credential",
					},
				],
				defaultOptionId: "model-option-2",
				defaultReasoningLevel: "high",
			},
			secrets: [{ name: "MODEL_API_KEY", value: "new-secret" }],
		});
	});
});
