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
	it.each([
		"http://model.invalid/v1",
		"http://localhost/v1",
		"http://127.1/v1",
	])(
		"rejects cleartext nonliteral loopback startup endpoint %s",
		(endpoint) => {
			expect(() =>
				readCodexPilotConfiguration(
					environment({
						modelOptions: configuration.modelOptions.map((option) => ({
							...option,
							endpoint,
						})),
					}),
				),
			).toThrow("RUNTIME_CONFIGURATION_INVALID");
		},
	);
	it.each(["https://model.invalid/v1", "http://[::1]:8080/v1"])(
		"accepts approved startup transport %s",
		(endpoint) => {
			expect(
				readCodexPilotConfiguration(
					environment({
						modelOptions: configuration.modelOptions.map((option) => ({
							...option,
							endpoint,
						})),
					}),
				).modelOptions[0]?.endpoint,
			).toBe(endpoint);
		},
	);

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

	it.each([
		undefined,
		"",
		"e",
		"x".repeat(15),
		"x".repeat(8193),
		"synthetic\ncredential",
		"synthetic credential",
	])(
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

	it("binds distinct options independently when they share a credential reference", () => {
		const alternate = {
			...configuration.modelOptions[0],
			modelOptionId: "option-alternate",
			endpoint: "https://alternate.invalid/v1",
			model: "synthetic-alternate",
			reasoningLevels: ["low"],
		};
		expect(
			readCodexPilotConfiguration(
				environment({
					modelOptions: [...configuration.modelOptions, alternate],
				}),
			),
		).toEqual({
			configVersion: configuration.configVersion,
			defaultModelOptionId: "option-default",
			defaultReasoningLevel: "medium",
			modelOptions: [
				{
					modelOptionId: "option-default",
					endpoint: "http://127.0.0.1:8080/v1",
					model: "synthetic-default",
					reasoningLevels: ["medium", "high"],
					credential: "synthetic-active-credential",
				},
				{
					modelOptionId: "option-alternate",
					endpoint: "https://alternate.invalid/v1",
					model: "synthetic-alternate",
					reasoningLevels: ["low"],
					credential: "synthetic-active-credential",
				},
			],
		});
	});

	it.each([undefined, "", "synthetic invalid credential"])(
		"rejects missing or invalid shared credential values",
		(credential) => {
			expect(() =>
				readCodexPilotConfiguration({
					...environment({
						modelOptions: [
							...configuration.modelOptions,
							{
								...configuration.modelOptions[0],
								modelOptionId: "option-alternate",
							},
						],
					}),
					AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_DEFAULT: credential,
				}),
			).toThrow(/^RUNTIME_CONFIGURATION_INVALID$/);
		},
	);

	it("validates every endpoint even when options share a credential reference", () => {
		expect(() =>
			readCodexPilotConfiguration(
				environment({
					modelOptions: [
						...configuration.modelOptions,
						{
							...configuration.modelOptions[0],
							modelOptionId: "option-alternate",
							endpoint: "http://unapproved.invalid/v1",
						},
					],
				}),
			),
		).toThrow(/^RUNTIME_CONFIGURATION_INVALID$/);
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
