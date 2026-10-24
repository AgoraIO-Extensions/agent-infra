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
	defaultRelayKey: "agent-relay-key-value",
	models: [
		{
			optionId: "model-primary",
			endpointId: "endpoint-primary",
			modelId: "gpt-5",
			reasoningLevels: "medium\nhigh",
		},
	],
	defaultModelOptionId: "model-primary",
	defaultReasoningLevel: "medium",
} satisfies AgentApplicationFormDraft;

describe("Agent application draft", () => {
	it("serializes a multi-service source without treating its YAML as an image", () => {
		const draft = {
			...standardCreateDraft,
			sourceKind: "custom-multi-service" as const,
			manifest: "schemaVersion: 1\nentryServiceName: api\nresources: []",
			imageReference: "",
			configureModels: false,
			models: [],
			defaultModelOptionId: "",
			defaultReasoningLevel: "",
		};
		expect(buildAgentApplicationRequest("create", draft)).toEqual(
			expect.objectContaining({
				source: {
					kind: "custom",
					interactionMode: "self-managed",
					identityResponsibility: "self-managed",
					manifest: draft.manifest,
				},
			}),
		);
	});

	it("requires inline YAML for a multi-service draft", () => {
		const errors = validateAgentApplicationDraft(
			{
				...standardCreateDraft,
				sourceKind: "custom-multi-service",
				manifest: "",
			},
			{
				modelConfigurationVisible: false,
				staleModel: false,
				staleModelIndexes: [],
				staleTemplate: false,
				standardChoicesBlocked: false,
			},
		);
		expect(errors.manifest).toBe("请上传或粘贴多服务 YAML。");
	});

	it("serializes a standard application into its generated writable create body", () => {
		expect(buildAgentApplicationRequest("create", standardCreateDraft)).toEqual(
			{
				schemaVersion: 2,
				defaultRelayKey: "agent-relay-key-value",
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
					{ ...standardCreateDraft.models[0], optionId: "duplicate-model" },
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

	it("keeps a missing model error when only the endpoint is selected", () => {
		const errors = validateAgentApplicationDraft(
			{
				...standardCreateDraft,
				models: [
					{
						...standardCreateDraft.models[0],
						optionId: "",
						modelId: "",
						reasoningLevels: "",
					},
				],
			},
			{
				modelConfigurationVisible: true,
				requiresReplacementCredential: true,
				staleModel: true,
				staleModelIndexes: [0],
				staleTemplate: false,
				standardChoicesBlocked: false,
			},
		);

		expect(errors["model.0.modelId"]).toBe("请选择模型。");
	});

	it("requires one default Relay Key instead of per-model credentials", () => {
		const draft = { ...standardCreateDraft, defaultRelayKey: "" };
		const context = {
			modelConfigurationVisible: true,
			requiresDefaultRelayKey: true,
			staleModel: false,
			staleModelIndexes: [],
			staleTemplate: false,
			standardChoicesBlocked: false,
			defaultModelReasoningLevels: ["medium", "high"],
		};

		expect(validateAgentApplicationDraft(draft, context).defaultRelayKey).toBe(
			"请输入 Agent 默认 Relay Key。",
		);
		expect(
			validateAgentApplicationDraft(
				{
					...draft,
					defaultRelayKey: "agent-relay-key-value",
				},
				context,
			).defaultRelayKey,
		).toBeUndefined();
	});

	it("requires a current template readiness revision when the gate is enabled", () => {
		const errors = validateAgentApplicationDraft(
			{ ...standardCreateDraft, templateRevision: "" },
			{
				modelConfigurationVisible: false,
				requiresTemplateReadiness: true,
				staleModel: false,
				staleTemplate: false,
				standardChoicesBlocked: false,
			},
		);
		expect(errors.templateId).toBe("模板验证状态已过期，请刷新后重试。");
	});

	// #3328 N10-2-01：所选模板不可申请时字段错误沿用就绪原因，部署整体的问题仍优先；未选模板时提示选择；
	// 修改申请不能更换模板时的说明优先于其余模板错误。
	it("explains a blocked template with its readiness reason instead of a generic deployment error", () => {
		const blocked = {
			modelConfigurationVisible: false,
			requiresTemplateReadiness: true,
			staleModel: false,
			staleTemplate: false,
			standardChoicesBlocked: true,
			templateUnavailableMessage: "模板已更新，请刷新后确认。",
		};
		expect(
			validateAgentApplicationDraft(standardCreateDraft, blocked).templateId,
		).toBe("模板已更新，请刷新后确认。");
		expect(
			validateAgentApplicationDraft(
				{ ...standardCreateDraft, templateId: "", templateRevision: "" },
				{ ...blocked, templateUnavailableMessage: undefined },
			).templateId,
		).toBe("请选择标准模板。");
		expect(
			validateAgentApplicationDraft(standardCreateDraft, {
				...blocked,
				configurationMessage: "部署选项已过期，请重新加载后再提交。",
			}).templateId,
		).toBe("部署选项已过期，请重新加载后再提交。");
		// 部署整体有问题（过期、不可用或没有标准模板）时改选模板也无法提交，未选模板同样说明部署，
		// 不引导选择（同 #3291 N9-2-01「部署没有标准模板」的字段错误）。
		expect(
			validateAgentApplicationDraft(
				{ ...standardCreateDraft, templateId: "", templateRevision: "" },
				{
					...blocked,
					templateUnavailableMessage: undefined,
					configurationMessage:
						"当前部署没有可用的标准模板或模型选项，请联系管理员配置后重试。",
				},
			).templateId,
		).toBe("当前部署没有可用的标准模板或模型选项，请联系管理员配置后重试。");
		expect(
			validateAgentApplicationDraft(standardCreateDraft, {
				...blocked,
				staleTemplate: true,
				configurationMessage:
					"当前申请包含已移除的部署选项，请重新加载并重新选择。",
				lockedTemplateMessage:
					"该模板已从当前部署移除。已有申请不能更换模板，请新建申请。",
			}).templateId,
		).toBe("该模板已从当前部署移除。已有申请不能更换模板，请新建申请。");
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

	describe("updating an application whose models the default Relay Key manages (#2421)", () => {
		const replacement = {
			defaultRelayKey: "agent-relay-key-value",
			expectedConfigurationRevision: 7,
			expectedKeyVersion: 2,
			modelConfiguration: {
				options: [
					{
						optionId: "endpoint-primary:gpt-5",
						endpointId: "endpoint-primary",
						modelId: "gpt-5",
						reasoningLevels: ["high"],
					},
				],
				defaultOptionId: "endpoint-primary:gpt-5",
				defaultReasoningLevel: "high",
			},
		};

		it("carries the Key, the checked versions and the model set chosen from the Key's candidates", () => {
			const body = buildAgentApplicationRequest(
				"update",
				{ ...standardCreateDraft, configureModels: false },
				replacement,
			);
			expect(body).toMatchObject({
				schemaVersion: 2,
				defaultRelayKey: "agent-relay-key-value",
				expectedConfigurationRevision: 7,
				expectedKeyVersion: 2,
				modelConfiguration: replacement.modelConfiguration,
			});
		});

		it("never mixes catalog rows into a replacement and keeps a null Key version", () => {
			const body = buildAgentApplicationRequest(
				"update",
				// 即使草稿里还留着逐行模型，也以候选选择为准。
				{ ...standardCreateDraft, configureModels: true },
				{ ...replacement, expectedKeyVersion: null },
			);
			expect(body).toMatchObject({
				expectedKeyVersion: null,
				modelConfiguration: replacement.modelConfiguration,
			});
		});

		it("sends no Key or versions without a replacement", () => {
			const body = buildAgentApplicationRequest("update", {
				...standardCreateDraft,
				configureModels: false,
			});
			expect(body).not.toHaveProperty("defaultRelayKey");
			expect(body).not.toHaveProperty("expectedConfigurationRevision");
			expect(body).not.toHaveProperty("expectedKeyVersion");
			expect(body).not.toHaveProperty("modelConfiguration");
		});
	});
});
