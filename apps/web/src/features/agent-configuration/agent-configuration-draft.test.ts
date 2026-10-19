import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { describe, expect, it } from "vitest";

import {
	agentConfigurationDraftChanged,
	buildAgentConfigurationRequest,
	configurationDraftFromAgent,
	configurationKeyError,
} from "./agent-configuration-draft.js";

const agent = AgentProjectionV2Schema.parse({
	schemaVersion: 2,
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

			models: [],
			// 环境变量是普通值，以当前配置为初值（O-10）。
			environment: [{ name: "LOG_LEVEL", value: "info" }],
		});
		// Secret 不进入草稿：替换走只写弹窗的独立请求（NI-02、NI-71）。
		expect(draft).not.toHaveProperty("secrets");
		expect(JSON.stringify(draft)).not.toContain("MODEL_API_KEY");
	});

	it("serializes only explicit keyless model replacements and never Secrets", () => {
		const draft = configurationDraftFromAgent(agent);
		const request = buildAgentConfigurationRequest(
			{
				...draft,
				replaceModels: true,
				models: [
					{
						optionId: "model-option-2",
						endpointId: "endpoint-primary",
						modelId: "gpt-5.2",
						reasoningLevels: "medium\nhigh",
					},
				],
				defaultModelOptionId: "model-option-2",
				defaultReasoningLevel: "high",
			},
			agent,
		);

		expect(request).toEqual({
			schemaVersion: 2,
			coOwnerIds: ["user-owner-1"],
			availability: [
				{ kind: "user", userId: "user-reader-1" },
				{ kind: "organization", organizationId: "organization-1" },
			],

			modelConfiguration: {
				options: [
					{
						optionId: "model-option-2",
						endpointId: "endpoint-primary",
						modelId: "gpt-5.2",
						reasoningLevels: ["medium", "high"],
					},
				],
				defaultOptionId: "model-option-2",
				defaultReasoningLevel: "high",
			},
		});
	});

	it("sends the complete environment table only when it changed (O-10)", () => {
		const draft = configurationDraftFromAgent(agent);
		expect(buildAgentConfigurationRequest(draft, agent)).not.toHaveProperty(
			"environment",
		);
		expect(
			buildAgentConfigurationRequest(
				{ ...draft, environment: [{ name: " LOG_LEVEL ", value: "debug" }] },
				agent,
			).environment,
		).toEqual([{ name: "LOG_LEVEL", value: "debug" }]);
		expect(
			buildAgentConfigurationRequest({ ...draft, environment: [] }, agent)
				.environment,
		).toEqual([]);
		expect(
			buildAgentConfigurationRequest(
				{
					...draft,
					environment: [
						{ name: "LOG_LEVEL", value: "info" },
						{ name: "WORKSPACE", value: "platform" },
					],
				},
				agent,
			).environment,
		).toEqual([
			{ name: "LOG_LEVEL", value: "info" },
			{ name: "WORKSPACE", value: "platform" },
		]);
	});

	it("validates environment and Secret names like the server", () => {
		expect(configurationKeyError("", { kind: "environment" })).toBe(
			"请输入环境变量名。",
		);
		expect(configurationKeyError("AGENT_INFRA_TOKEN", { kind: "secret" })).toBe(
			"Secret 名称不能以 AGENT_INFRA_ 开头。",
		);
		expect(configurationKeyError("1BAD", { kind: "environment" })).toBe(
			"环境变量名只能包含字母、数字和下划线，且不能以数字开头。",
		);
		expect(
			configurationKeyError("OTHER", {
				kind: "environment",
				allowedNames: ["LOG_LEVEL"],
			}),
		).toBe("当前模板不允许这个环境变量名。");
		// Secret 名称以拉丁字母开头：与前面的中文之间有一个空格。
		expect(configurationKeyError(" ", { kind: "secret" })).toBe(
			"请输入 Secret 名称。",
		);
		expect(
			configurationKeyError("OTHER", {
				kind: "secret",
				allowedNames: ["MODEL_API_KEY"],
			}),
		).toBe("当前模板不允许这个 Secret 名称。");
		expect(
			configurationKeyError("LOG_LEVEL", {
				kind: "environment",
				allowedNames: ["LOG_LEVEL"],
			}),
		).toBeUndefined();
	});

	it("preserves an explicit empty channel replacement", () => {
		const request = buildAgentConfigurationRequest(
			{
				...configurationDraftFromAgent(agent),
				channels: [],
			},
			agent,
		);

		expect(request.channels).toEqual([]);
	});

	describe("change detection (#2560)", () => {
		const baseline = () => configurationDraftFromAgent(agent);

		it("treats the loaded configuration as unchanged", () => {
			expect(agentConfigurationDraftChanged(agent, baseline())).toBe(false);
		});

		it("compares Owners and availability as sets, like the server", () => {
			expect(
				agentConfigurationDraftChanged(agent, {
					...baseline(),
					coOwnerIds: " user-owner-1 \n",
					userAvailabilityIds: "user-reader-1",
				}),
			).toBe(false);
			expect(
				agentConfigurationDraftChanged(agent, {
					...baseline(),
					coOwnerIds: "user-owner-1\nuser-owner-2",
				}),
			).toBe(true);
			expect(
				agentConfigurationDraftChanged(agent, {
					...baseline(),
					coOwnerIds: "user-owner-2",
				}),
			).toBe(true);
			expect(
				agentConfigurationDraftChanged(agent, {
					...baseline(),
					userAvailabilityIds: "user-reader-1\nuser-reader-2",
				}),
			).toBe(true);
			expect(
				agentConfigurationDraftChanged(agent, {
					...baseline(),
					organizationAvailabilityIds: "",
				}),
			).toBe(true);
		});

		it("does not care about the order of several Owners or readers", () => {
			const crowded = {
				...agent,
				configuration: {
					...agent.configuration,
					owners: [
						...agent.configuration.owners,
						{
							userId: "user-owner-2",
							displayName: "Second",
							roles: ["employee"],
						},
					],
					availability: [
						{ kind: "user", userId: "user-reader-1" },
						{ kind: "user", userId: "user-reader-2" },
						{ kind: "organization", organizationId: "organization-1" },
					],
				},
			} as typeof agent;
			expect(
				agentConfigurationDraftChanged(crowded, {
					...configurationDraftFromAgent(crowded),
					coOwnerIds: "user-owner-2\nuser-owner-1",
					userAvailabilityIds: "user-reader-2, user-reader-1",
				}),
			).toBe(false);
		});

		it("treats repeated IDs like the server does: as one member of the set", () => {
			expect(
				agentConfigurationDraftChanged(agent, {
					...baseline(),
					coOwnerIds: "user-owner-1\nuser-owner-1",
					userAvailabilityIds: "user-reader-1, user-reader-1",
					organizationAvailabilityIds: "organization-1\norganization-1",
				}),
			).toBe(false);
		});

		it("counts environment and channel changes as changes", () => {
			expect(
				agentConfigurationDraftChanged(agent, {
					...baseline(),
					environment: [{ name: "LOG_LEVEL", value: "debug" }],
				}),
			).toBe(true);
			// 环境变量顺序不同不算改动：服务端按名称排序后整表比较。
			expect(
				agentConfigurationDraftChanged(agent, {
					...baseline(),
					environment: [{ name: "LOG_LEVEL", value: "info" }],
				}),
			).toBe(false);
			expect(
				agentConfigurationDraftChanged(agent, {
					...baseline(),
					channels: [],
				}),
			).toBe(true);
		});

		it("ignores a model replacement that selects what is already configured", () => {
			const same = {
				...baseline(),
				replaceModels: true,
				models: [
					{
						endpointId: "relay",
						modelId: "gpt-5",
						optionId: "model-option-1",
						reasoningLevels: "high,medium",
					},
				],
				defaultModelOptionId: "model-option-1",
				defaultReasoningLevel: "medium",
			};
			expect(agentConfigurationDraftChanged(agent, same)).toBe(false);
			expect(
				agentConfigurationDraftChanged(agent, {
					...same,
					defaultReasoningLevel: "high",
				}),
			).toBe(true);
			expect(
				agentConfigurationDraftChanged(agent, {
					...same,
					defaultModelOptionId: "model-option-2",
				}),
			).toBe(true);
			expect(
				agentConfigurationDraftChanged(agent, {
					...same,
					models: [{ ...same.models[0], reasoningLevels: "medium" }],
				} as never),
			).toBe(true);
			expect(
				agentConfigurationDraftChanged(agent, {
					...same,
					models: [
						...same.models,
						{
							endpointId: "relay",
							modelId: "gpt-5-mini",
							optionId: "model-option-2",
							reasoningLevels: "medium",
						},
					],
				}),
			).toBe(true);
		});
	});
});
