import { describe, expect, it } from "vitest";

import { readCodexPilotConfiguration } from "./configuration.js";

const configuration = {
	schemaVersion: 2,
	configVersion: "synthetic-active-1",
	defaultModelOptionId: "option-default",
	defaultReasoningLevel: "medium",
	modelOptions: [
		{
			modelOptionId: "option-default",
			endpoint: "http://127.0.0.1:8080/v1",
			model: "synthetic-default",
			reasoningLevels: ["medium", "high"],
			credentialEnvironmentVariable:
				"AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_DEFAULT",
		},
	],
};

function environment(overrides: Record<string, unknown> = {}) {
	return {
		AGENT_INFRA_RUNTIME_MODEL_CONFIG: JSON.stringify({
			...configuration,
			...overrides,
		}),
		AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_DEFAULT: "synthetic-active-credential",
	};
}

describe("Codex Pilot deployment configuration", () => {
	it("consumes the injected active configuration without ambient login values", () => {
		expect(
			readCodexPilotConfiguration({
				...environment(),
				OPENAI_API_KEY: "synthetic-personal-credential",
				OPENAI_BASE_URL: "https://personal.invalid/v1",
			}),
		).toEqual({
			configVersion: configuration.configVersion,
			defaultModelOptionId: configuration.defaultModelOptionId,
			defaultReasoningLevel: configuration.defaultReasoningLevel,
			modelOptions: [
				{
					modelOptionId: "option-default",
					endpoint: "http://127.0.0.1:8080/v1",
					model: "synthetic-default",
					reasoningLevels: ["medium", "high"],
					credential: "synthetic-active-credential",
				},
			],
		});
	});

	it.each([
		{ schemaVersion: 1 },
		{ defaultModelOptionId: "missing" },
		{ defaultReasoningLevel: "unmapped" },
		{ modelOptions: [] },
		{
			modelOptions: [
				...configuration.modelOptions,
				...configuration.modelOptions,
			],
		},
		{ executable: "/synthetic/codex" },
		{ configVersion: undefined },
	])("rejects invalid deployment values with a fixed error", (overrides) => {
		expect(() => readCodexPilotConfiguration(environment(overrides))).toThrow(
			"RUNTIME_CONFIGURATION_INVALID",
		);
	});

	it.each([undefined, "", "synthetic\ncredential", "synthetic credential"])(
		"rejects unusable credential input without personal-login fallback",
		(credential) => {
			expect(() =>
				readCodexPilotConfiguration({
					...environment(),
					AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_DEFAULT: credential,
					OPENAI_API_KEY: "synthetic-personal-credential",
				}),
			).toThrow("RUNTIME_CONFIGURATION_INVALID");
		},
	);

	it.each([
		"AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL",
		"OPENAI_API_KEY",
		"AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_lower",
		"AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_BAD-DASH",
	])("rejects an unreserved credential environment reference", (name) => {
		expect(() =>
			readCodexPilotConfiguration(
				environment({
					modelOptions: [
						{
							...configuration.modelOptions[0],
							credentialEnvironmentVariable: name,
						},
					],
				}),
			),
		).toThrow("RUNTIME_CONFIGURATION_INVALID");
	});

	it.each([
		"https://user:synthetic-password@model.invalid/v1",
		"https://model.invalid/v1?api_key=synthetic",
		"https://model.invalid/v1#synthetic",
		"file:///synthetic",
		" https://model.invalid/v1",
		"https:\\model.invalid/v1",
	])("rejects an unsafe per-option endpoint", (endpoint) => {
		expect(() =>
			readCodexPilotConfiguration(
				environment({
					modelOptions: [{ ...configuration.modelOptions[0], endpoint }],
				}),
			),
		).toThrow("RUNTIME_CONFIGURATION_INVALID");
	});

	it("keeps duplicate real models independently bound by option identity", () => {
		const alternate = {
			...configuration.modelOptions[0],
			modelOptionId: "option-alternate",
			endpoint: "https://alternate.invalid/v1",
			credentialEnvironmentVariable:
				"AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_ALTERNATE",
		};
		expect(
			readCodexPilotConfiguration({
				...environment({
					modelOptions: [...configuration.modelOptions, alternate],
				}),
				AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_ALTERNATE:
					"synthetic-alternate-credential",
			}),
		).toMatchObject({
			modelOptions: [
				{ modelOptionId: "option-default", model: "synthetic-default" },
				{
					modelOptionId: "option-alternate",
					model: "synthetic-default",
					credential: "synthetic-alternate-credential",
				},
			],
		});
	});

	it("rejects missing or malformed configuration without echoing input", () => {
		for (const input of [undefined, "synthetic-private-input", "null"]) {
			expect(() =>
				readCodexPilotConfiguration({
					...environment(),
					AGENT_INFRA_RUNTIME_MODEL_CONFIG: input,
				}),
			).toThrow(/^RUNTIME_CONFIGURATION_INVALID$/);
		}
	});
});
