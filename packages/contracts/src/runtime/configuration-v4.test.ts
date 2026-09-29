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

it("accepts HTTPS and literal loopback HTTP model endpoints", () => {
	for (const endpoint of [
		"https://relay.example.test/v1",
		"HTTPS://relay.example.test/v1",
		"http://127.0.0.1:8080/v1",
		"http://[::1]:8080/v1",
	]) {
		expect(
			RuntimeModelConfigurationV4Schema.safeParse({
				...configuration,
				modelOptions: [{ ...configuration.modelOptions[0], endpoint }],
			}).success,
		).toBe(true);
	}
});

it("rejects unsafe model endpoint schemes and authorities", () => {
	for (const endpoint of [
		"file:///tmp/model",
		"javascript:alert(1)",
		"http://localhost:8080/v1",
		"HTTP://127.0.0.1:8080/v1",
		"http://127.1:8080/v1",
		"http://127.0.0.1.evil.test/v1",
		"http://169.254.169.254/v1",
		"https://169.254.169.254/v1",
		"https://10.0.0.1/v1",
		"https://8.8.8.8/v1",
		"https://2852039166/v1",
		"https://0xa9fea9fe/v1",
		"https://0251.0376.0251.0376/v1",
		"https://[::ffff:169.254.169.254]/v1",
		"https://[fd00::1]/v1",
		"https://[fe80::1]/v1",
		"https://./v1",
		"https://foo..bar/v1",
		"https://-relay.example.test/v1",
		"https://relay-.example.test/v1",
		"https://relay_example.test/v1",
		"https://localhost/v1",
		"https://sub.localhost./v1",
		"https://user:synthetic-credential@relay.example.test/v1",
		"https://relay.example.test/v1?key=synthetic-credential",
		"https://relay.example.test/v1#fragment",
		"https://relay.example.test\\other/v1",
	]) {
		expect(
			RuntimeModelConfigurationV4Schema.safeParse({
				...configuration,
				modelOptions: [{ ...configuration.modelOptions[0], endpoint }],
			}).success,
		).toBe(false);
	}
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

it("rejects duplicate options and defaults absent from the allowed set", () => {
	const option = configuration.modelOptions[0];
	for (const changed of [
		{ ...configuration, modelOptions: [option, option] },
		{
			...configuration,
			modelOptions: [{ ...option, reasoningLevels: ["high", "high"] }],
		},
		{ ...configuration, defaultModelOptionId: "unknown" },
		{ ...configuration, defaultReasoningLevel: "low" },
	]) {
		expect(RuntimeModelConfigurationV4Schema.safeParse(changed).success).toBe(
			false,
		);
	}
});
