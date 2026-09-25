import { describe, expect, it } from "vitest";

import {
	type AgentApplicationFormDraft,
	buildAgentApplicationRequest,
	validateAgentApplicationDraft,
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
				schemaVersion: 2,
				name: "Release assistant",
				description: "Helps the release team",
				source: { kind: "standard", templateId: "codex" },
				coOwnerIds: ["owner-2", "owner-3"],
				availability: [
					{ kind: "user", userId: "user-available" },
					{ kind: "organization", organizationId: "organization-available" },
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
			schemaVersion: 2,
			name: "Release assistant",
			description: "Helps the release team",
			source: { kind: "standard", templateId: "codex" },
			coOwnerIds: ["owner-2", "owner-3"],
			availability: [
				{ kind: "user", userId: "user-available" },
				{ kind: "organization", organizationId: "organization-available" },
			],

			environment: [{ name: "LOG_LEVEL", value: "debug" }],
		});
	});

	it("uses the projected source when serializing an update", () => {
		expect(
			buildAgentApplicationRequest("update", {
				...standardCreateDraft,
				source: { kind: "standard", templateId: "codex" },
				templateId: "changed-template",
				configureModels: false,
				secrets: [],
			}),
		).toEqual(
			expect.objectContaining({
				source: { kind: "standard", templateId: "codex" },
			}),
		);
	});

	it("marks only duplicated model options on their model fields", () => {
		const errors = validateAgentApplicationDraft(
			{
				...standardCreateDraft,
				models: [
					standardCreateDraft.models[0],
					{ ...standardCreateDraft.models[0], credentialValue: "" },
				],
			},
			{
				modelConfigurationVisible: true,
				requiresReplacementCredential: false,
				staleModel: false,
				staleModelIndexes: [],
				staleTemplate: false,
				standardChoicesBlocked: false,
				defaultModelReasoningLevels: ["medium", "high"],
			},
		);

		expect(errors["model.0.modelId"]).toBe("模型选项不能重复。");
		expect(errors["model.1.modelId"]).toBe("模型选项不能重复。");
	});

	it("rejects duplicate endpoint and model pairs with different option IDs", () => {
		const errors = validateAgentApplicationDraft(
			{
				...standardCreateDraft,
				models: [
					standardCreateDraft.models[0],
					{
						...standardCreateDraft.models[0],
						optionId: "legacy-model",
						credentialValue: "",
					},
				],
			},
			{
				modelConfigurationVisible: true,
				requiresReplacementCredential: false,
				staleModel: false,
				staleModelIndexes: [],
				staleTemplate: false,
				standardChoicesBlocked: false,
				defaultModelReasoningLevels: ["medium", "high"],
			},
		);

		expect(errors["model.0.modelId"]).toBe("模型选项不能重复。");
		expect(errors["model.1.modelId"]).toBe("模型选项不能重复。");
	});

	it("requires credentials for model options not persisted on update", () => {
		const draft = {
			...standardCreateDraft,
			models: [{ ...standardCreateDraft.models[0], credentialValue: "" }],
		};
		const context = {
			modelConfigurationVisible: true,
			persistedModelOptionIds: ["persisted-option"],
			requiresReplacementCredential: false,
			staleModel: false,
			staleModelIndexes: [],
			staleTemplate: false,
			standardChoicesBlocked: false,
			defaultModelReasoningLevels: ["medium", "high"],
		};

		expect(
			validateAgentApplicationDraft(draft, context)["model.0.credentialValue"],
		).toBe("请输入模型凭证。");
		expect(
			validateAgentApplicationDraft(
				{
					...draft,
					models: [{ ...draft.models[0], optionId: "persisted-option" }],
				},
				context,
			)["model.0.credentialValue"],
		).toBeUndefined();
	});

	it("marks only repeated environment and Secret names", () => {
		const errors = validateAgentApplicationDraft(
			{
				...standardCreateDraft,
				environment: [
					{ name: "LOG_LEVEL", value: "debug" },
					{ name: "LOG_LEVEL", value: "info" },
					{ name: "PORT", value: "8080" },
				],
				secrets: [
					{ name: "MODEL_API_KEY", value: "one" },
					{ name: "OTHER_SECRET", value: "two" },
					{ name: "MODEL_API_KEY", value: "three" },
				],
			},
			{
				modelConfigurationVisible: false,
				requiresReplacementCredential: false,
				staleModel: false,
				staleModelIndexes: [],
				staleTemplate: false,
				standardChoicesBlocked: false,
			},
		);

		expect(errors["environment.0.name"]).toBe("名称不能重复。");
		expect(errors["environment.1.name"]).toBe("名称不能重复。");
		expect(errors["environment.2.name"]).toBeUndefined();
		expect(errors["secret.0.name"]).toBe("名称不能重复。");
		expect(errors["secret.1.name"]).toBeUndefined();
		expect(errors["secret.2.name"]).toBe("名称不能重复。");
	});

	it("rejects environment and Secret names outside the selected template", () => {
		const errors = validateAgentApplicationDraft(
			{
				...standardCreateDraft,
				environment: [{ name: "REMOVED_ENV", value: "debug" }],
				secrets: [{ name: "REMOVED_SECRET", value: "never-echo" }],
			},
			{
				allowedEnvironmentKeys: ["LOG_LEVEL"],
				allowedSecretKeys: ["MODEL_API_KEY"],
				modelConfigurationVisible: false,
				requiresReplacementCredential: false,
				staleModel: false,
				staleModelIndexes: [],
				staleTemplate: false,
				standardChoicesBlocked: false,
			},
		);

		expect(errors["environment.0.name"]).toBe(
			"该名称已不再允许使用，请重新选择。",
		);
		expect(errors["secret.0.name"]).toBe("该名称已不再允许使用，请重新选择。");
	});

	it("rejects whitespace-only environment and Secret values", () => {
		const errors = validateAgentApplicationDraft(
			{
				...standardCreateDraft,
				environment: [{ name: "LOG_LEVEL", value: "  \n" }],
				secrets: [{ name: "MODEL_API_KEY", value: " \t" }],
			},
			{
				modelConfigurationVisible: false,
				requiresReplacementCredential: false,
				staleModel: false,
				staleModelIndexes: [],
				staleTemplate: false,
				standardChoicesBlocked: false,
			},
		);

		expect(errors["environment.0.value"]).toBe("请输入值。");
		expect(errors["secret.0.value"]).toBe("请输入值。");
	});

	it("keeps a valid model row clear when another row is stale", () => {
		const errors = validateAgentApplicationDraft(
			{
				...standardCreateDraft,
				models: [
					standardCreateDraft.models[0],
					{
						...standardCreateDraft.models[0],
						optionId: "stale",
						modelId: "gone",
					},
				],
				defaultModelOptionId: "model-primary",
			},
			{
				modelConfigurationVisible: true,
				requiresReplacementCredential: false,
				staleModel: true,
				staleModelIndexes: [1],
				staleTemplate: false,
				standardChoicesBlocked: false,
				defaultModelReasoningLevels: ["medium", "high"],
			},
		);

		expect(errors["model.0.modelId"]).toBeUndefined();
		expect(errors["model.1.modelId"]).toBe("模型选项已移除，请重新选择。");
	});
});
