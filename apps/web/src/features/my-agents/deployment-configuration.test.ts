import { describe, expect, it } from "vitest";

import {
	applicationTemplateChoices,
	type DeploymentConfigurationState,
	projectDeploymentConfiguration,
	unavailableDeploymentConfiguration,
} from "./deployment-configuration.js";
import { deploymentConfiguration } from "./test-fixtures.js";

describe("applicationTemplateChoices", () => {
	// #3291 N9-2-01：部署没有登记标准模板时，就绪列表仍列出四个首发模板，显示名按 PRD §4，不外露模板 ID。
	it("names the four fallback standard templates without exposing their IDs", () => {
		const choices = applicationTemplateChoices({
			...deploymentConfiguration,
			templates: [],
		});
		expect(
			choices.map(({ templateId, displayName }) => [templateId, displayName]),
		).toEqual([
			["codex", "Codex"],
			["claude", "Claude"],
			["opencode", "OpenCode"],
			["pi", "Pi"],
		]);
		expect(
			choices.every(({ readiness }) => readiness?.state === "unregistered"),
		).toBe(true);
		expect(
			applicationTemplateChoices(unavailableDeploymentConfiguration).map(
				({ displayName }) => displayName,
			),
		).toEqual(["Codex", "Claude", "OpenCode", "Pi"]);
	});

	it("keeps the deployment's registered templates as they are", () => {
		expect(applicationTemplateChoices(deploymentConfiguration)).toBe(
			deploymentConfiguration.templates,
		);
	});
});

describe("projectDeploymentConfiguration", () => {
	it("drops cached ready data when the current read fails", () => {
		const state: DeploymentConfigurationState = {
			kind: "ready",
			configuration: deploymentConfiguration,
		};
		const result = projectDeploymentConfiguration(
			state,
			Object.assign(new Error("temporarily unavailable"), { retryable: true }),
			true,
		);

		expect(result.configuration.status).toBe("unavailable");
		expect(result.configuration.modelCatalog.endpoints).toEqual([]);
		expect(result.retryable).toBe(true);
	});

	it("keeps successful projections and their retry classification", () => {
		const state: DeploymentConfigurationState = {
			kind: "ready",
			configuration: deploymentConfiguration,
		};

		expect(projectDeploymentConfiguration(state, undefined, false)).toEqual({
			configuration: deploymentConfiguration,
			retryable: true,
		});
	});

	it("does not invent retryability for an unavailable projection", () => {
		const state: DeploymentConfigurationState = {
			kind: "ready",
			configuration: {
				...deploymentConfiguration,
				status: "unavailable",
				modelCatalog: {
					...deploymentConfiguration.modelCatalog,
					status: "unavailable",
				},
			},
		};

		expect(projectDeploymentConfiguration(state, undefined, false)).toEqual({
			configuration: state.configuration,
			retryable: false,
		});
	});
});
