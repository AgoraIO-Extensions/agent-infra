import { expect, it } from "vitest";
import { RuntimeModelConfigurationV3Schema } from "./configuration.js";

const configuration = {
	schemaVersion: 3,
	configVersion: "configuration-1",
	defaultModelOptionId: "claude-a",
	defaultReasoningLevel: "high",
	modelOptions: [
		{
			modelOptionId: "claude-a",
			protocol: "anthropic-messages-v1",
			authentication: "api-key",
			endpoint: "https://models.example.test/team-a",
			model: "claude-opus-5",
			reasoningLevels: ["high"],
			credentialEnvironmentVariable: "AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_A",
		},
	],
};

it("preserves a Claude option's explicit protocol and authentication in configuration V3", () => {
	expect(RuntimeModelConfigurationV3Schema.parse(configuration)).toEqual(
		configuration,
	);
	const { authentication: _authentication, ...missingAuthentication } =
		configuration.modelOptions[0]!;
	expect(
		RuntimeModelConfigurationV3Schema.safeParse({
			...configuration,
			modelOptions: [missingAuthentication],
		}).success,
	).toBe(false);
	expect(
		RuntimeModelConfigurationV3Schema.safeParse({
			...configuration,
			schemaVersion: 2,
		}).success,
	).toBe(false);
});
