import { expect, it } from "vitest";
import { RuntimeModelConfigurationV4Schema } from "./configuration-v4.js";

const configuration = {
	schemaVersion: 4,
	configVersion: "configuration-4",
	defaultModelOptionId: "claude-a",
	defaultReasoningLevel: "high",
	modelOptions: [
		{
			modelOptionId: "claude-a",
			protocol: "anthropic-messages-v1",
			authentication: "api-key",
			endpoint: "https://relay.example.test/v1",
			model: "claude-opus-5",
			reasoningLevels: ["high"],
		},
	],
} as const;

it("accepts a Key-free V4 configuration", () => {
	expect(RuntimeModelConfigurationV4Schema.parse(configuration)).toEqual(
		configuration,
	);
});

it("rejects old Pod credentials and Key references from V4 options", () => {
	const option = configuration.modelOptions[0];
	expect(
		RuntimeModelConfigurationV4Schema.safeParse({
			...configuration,
			modelOptions: [
				{
					...option,
					credentialEnvironmentVariable:
						"AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_A",
				},
			],
		}).success,
	).toBe(false);
	expect(
		RuntimeModelConfigurationV4Schema.safeParse({
			...configuration,
			modelOptions: [{ ...option, keyId: "key-1" }],
		}).success,
	).toBe(false);
	expect(
		RuntimeModelConfigurationV4Schema.safeParse({
			...configuration,
			schemaVersion: 3,
		}).success,
	).toBe(false);
});
