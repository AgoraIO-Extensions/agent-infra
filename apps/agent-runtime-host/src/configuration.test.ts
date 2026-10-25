import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
	readCodexIsolationMode,
	readCodexPilotConfiguration,
	readRuntimeFileExchangeOptions,
	readRuntimeModelConfigurationV3,
	readRuntimeModelConfigurationV4,
} from "./configuration.js";

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

describe("Runtime deployment configuration", () => {
	it("defaults Codex isolation to Landlock and accepts the Worker-owned container mode", () => {
		expect(readCodexIsolationMode({})).toBe("landlock");
		const serviceToken = "synthetic-service-token";
		const scope = "agent-a";
		const attestation = createHmac("sha256", serviceToken)
			.update(`agent-infra-container-boundary-v1\0${scope}`)
			.digest("base64url");
		expect(
			readCodexIsolationMode(
				{
					AGENT_INFRA_RUNTIME_ISOLATION_MODE: "container-boundary",
					AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_ENABLED: "worker-v1",
					AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_SCOPE: scope,
					AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_ATTESTATION: attestation,
				},
				serviceToken,
			),
		).toBe("container-boundary");
		expect(() =>
			readCodexIsolationMode(
				{
					AGENT_INFRA_RUNTIME_ISOLATION_MODE: "container-boundary",
				},
				serviceToken,
			),
		).toThrow("RUNTIME_CONFIGURATION_INVALID");
		expect(() =>
			readCodexIsolationMode({ AGENT_INFRA_RUNTIME_ISOLATION_MODE: "unsafe" }),
		).toThrow("RUNTIME_CONFIGURATION_INVALID");
	});
	it("consumes Responses V3 through the Codex startup reader", () => {
		const env = environment({
			schemaVersion: 3,
			modelOptions: configuration.modelOptions.map((option) => ({
				...option,
				protocol: "openai-responses-v1",
				authentication: "bearer",
			})),
		});
		expect(readCodexPilotConfiguration(env).modelOptions[0]).toMatchObject({
			protocol: "openai-responses-v1",
			credential: "synthetic-active-credential",
		});
		expect(() => readRuntimeModelConfigurationV3(env, "claude")).toThrow(
			"RUNTIME_CONFIGURATION_INVALID",
		);
	});
	it("accepts Claude V3 only for the fixed Claude Driver and ignores personal credentials", () => {
		const env = environment({
			schemaVersion: 3,
			modelOptions: configuration.modelOptions.map((option) => ({
				...option,
				protocol: "anthropic-messages-v1",
				authentication: "api-key",
			})),
		});
		const resolved = readRuntimeModelConfigurationV3(
			{ ...env, ANTHROPIC_API_KEY: "synthetic-personal-credential" },
			"claude",
		);
		expect(resolved.schemaVersion).toBe(3);
		expect(resolved.modelOptions[0]).toMatchObject({
			authentication: "api-key",
			credential: "synthetic-active-credential",
		});
		expect(() => readRuntimeModelConfigurationV3(env, "codex")).toThrow(
			"RUNTIME_CONFIGURATION_INVALID",
		);
		expect(() =>
			readRuntimeModelConfigurationV3(environment(), "claude"),
		).toThrow("RUNTIME_CONFIGURATION_INVALID");
	});
	it("accepts credential-free Messages V4 configuration for Claude", () => {
		const env = {
			AGENT_INFRA_RUNTIME_MODEL_CONFIG: JSON.stringify({
				schemaVersion: 4,
				configVersion: "configuration-1",
				defaultModelOptionId: "option-default",
				defaultReasoningLevel: "medium",
				modelOptions: [
					{
						modelOptionId: "option-default",
						protocol: "anthropic-messages-v1",
						authentication: "api-key",
						endpoint: "https://model.invalid/v1",
						model: "claude-opus-5",
						reasoningLevels: ["medium"],
					},
				],
			}),
		};
		expect(
			readRuntimeModelConfigurationV4(env, "claude").modelOptions[0],
		).toMatchObject({
			model: "claude-opus-5",
			authentication: "api-key",
		});
	});
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
			schemaVersion: 2,
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
			schemaVersion: 2,
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

describe("Runtime file exchange configuration", () => {
	const token = "s".repeat(48);
	const valid = {
		AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN: "http://platform-api:3000",
		AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN: token,
	};

	it("stays disabled when neither value is provided and needs both when enabled", () => {
		expect(readRuntimeFileExchangeOptions({})).toBeUndefined();
		expect(readRuntimeFileExchangeOptions(valid)).toEqual({
			origin: "http://platform-api:3000",
			serviceToken: token,
		});
		expect(() =>
			readRuntimeFileExchangeOptions({
				AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN:
					valid.AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN,
			}),
		).toThrow("RUNTIME_CONFIGURATION_INVALID");
		expect(() =>
			readRuntimeFileExchangeOptions({
				AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN: token,
			}),
		).toThrow("RUNTIME_CONFIGURATION_INVALID");
	});

	it.each([
		"http://platform-api:3000/",
		"http://platform-api:3000/path",
		"http://user@platform-api:3000",
		"http://platform-api:3000?query=1",
		"http://platform-api:3000#fragment",
		"http://127.0.0.1:3000",
		"ftp://platform-api:3000",
	])("rejects an inexact file exchange origin %s", (origin) => {
		expect(() =>
			readRuntimeFileExchangeOptions({
				...valid,
				AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN: origin,
			}),
		).toThrow("RUNTIME_CONFIGURATION_INVALID");
	});

	it("accepts an unchanged HTTPS origin and rejects a short or non-printable token", () => {
		expect(
			readRuntimeFileExchangeOptions({
				AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN: "https://api.example.test",
				AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN: token,
			})?.origin,
		).toBe("https://api.example.test");
		for (const invalid of ["short", `${token}\n`, `${token} extra`]) {
			const error = (() => {
				try {
					readRuntimeFileExchangeOptions({
						...valid,
						AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN: invalid,
					});
				} catch (caught) {
					return caught;
				}
			})();
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe("RUNTIME_CONFIGURATION_INVALID");
			expect((error as Error).message).not.toContain(token);
		}
	});
});
