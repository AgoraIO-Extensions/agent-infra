import { describe, expect, it } from "vitest";

import {
	type AgentApplicationFormDraft,
	buildAgentApplicationRequest,
} from "./agent-application-draft.js";

const standardCreateDraft = {
	name: "Release assistant",
	description: "Helps the release team",
	sourceKind: "standard",
	templateId: "codex",
	imageReference: "",
	identityResponsibility: "platform-managed",
	coOwnerIds: "owner-2\nowner-3",
	userAvailabilityIds: "user-available",
	organizationAvailabilityIds: "organization-available",
	actions: [
		{
			providerId: "github",
			actionId: "issues.read",
			actionVersion: "v3",
		},
	],
	environment: [{ name: "LOG_LEVEL", value: "debug" }],
	secrets: [{ name: "MODEL_API_KEY", value: "never-echo" }],
	configureModels: false,
	models: [
		{
			optionId: "model-primary",
			endpointId: "endpoint-primary",
			modelId: "gpt-5",
			reasoningLevels: "medium\nhigh",
			credentialValue: "never-echo-model",
		},
	],
	defaultModelOptionId: "model-primary",
	defaultReasoningLevel: "medium",
} satisfies AgentApplicationFormDraft;

describe("Agent application draft", () => {
	it("serializes a standard application into its generated writable create body", () => {
		expect(buildAgentApplicationRequest("create", standardCreateDraft)).toEqual(
			{
				schemaVersion: 1,
				name: "Release assistant",
				description: "Helps the release team",
				source: { kind: "standard", templateId: "codex" },
				coOwnerIds: ["owner-2", "owner-3"],
				availability: [
					{ kind: "user", userId: "user-available" },
					{ kind: "organization", organizationId: "organization-available" },
				],
				actions: [
					{
						providerId: "github",
						actionId: "issues.read",
						actionVersion: "v3",
					},
				],
				environment: [{ name: "LOG_LEVEL", value: "debug" }],
				secrets: [{ name: "MODEL_API_KEY", value: "never-echo" }],
				modelConfiguration: {
					options: [
						{
							optionId: "model-primary",
							endpointId: "endpoint-primary",
							modelId: "gpt-5",
							reasoningLevels: ["medium", "high"],
							credentialValue: "never-echo-model",
						},
					],
					defaultOptionId: "model-primary",
					defaultReasoningLevel: "medium",
				},
			},
		);
	});

	it("omits unentered Secret and model replacements from an update body", () => {
		const {
			models: _models,
			secrets: _secrets,
			...updateDraft
		} = standardCreateDraft;
		expect(
			buildAgentApplicationRequest("update", {
				...updateDraft,
				configureModels: false,
				models: [],
				secrets: [],
			}),
		).toEqual({
			schemaVersion: 1,
			name: "Release assistant",
			description: "Helps the release team",
			source: { kind: "standard", templateId: "codex" },
			coOwnerIds: ["owner-2", "owner-3"],
			availability: [
				{ kind: "user", userId: "user-available" },
				{ kind: "organization", organizationId: "organization-available" },
			],
			actions: [
				{
					providerId: "github",
					actionId: "issues.read",
					actionVersion: "v3",
				},
			],
			environment: [{ name: "LOG_LEVEL", value: "debug" }],
		});
	});
});
