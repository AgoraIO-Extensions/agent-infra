import { expect, it } from "vitest";

import { agentConfigurationConformanceRecordV1 } from "../../platform-core/src/agent-configuration.conformance.ts";
import { decodeAgentConfigurationRecord } from "./agent-configuration-record.ts";

const runtime = {
	schemaVersion: 4,
	configVersion: "keyless-v4",
	defaultModelOptionId: "model_primary",
	defaultReasoningLevel: "low",
	modelOptions: [
		{
			modelOptionId: "model_primary",
			endpoint: "https://relay.example/v1",
			model: "gpt-5",
			reasoningLevels: ["low"],
			protocol: "openai-responses-v1",
			authentication: "bearer",
		},
	],
};

const keylessConfiguration = {
	...agentConfigurationConformanceRecordV1,
	modelConfiguration: null,
	modelCatalogRevision: "catalog_1",
	runtimeModelConfigurationV4: runtime,
};

it("decodes a keyless V4 standard-template configuration", () => {
	expect(decodeAgentConfigurationRecord(keylessConfiguration)).toMatchObject(
		keylessConfiguration,
	);
});

it("rejects old credentials or invalid V4 content in keyless records", () => {
	for (const invalid of [
		{
			...keylessConfiguration,
			modelConfiguration:
				agentConfigurationConformanceRecordV1.modelConfiguration,
		},
		{ ...keylessConfiguration, modelCatalogRevision: undefined },
		{
			...keylessConfiguration,
			runtimeModelConfigurationV4: {
				...runtime,
				modelOptions: [{ ...runtime.modelOptions[0], credential: "forbidden" }],
			},
		},
		{
			...keylessConfiguration,
			runtimeModelConfigurationV4: {
				...runtime,
				modelOptions: [
					{ ...runtime.modelOptions[0], endpoint: "http://unapproved.example" },
				],
			},
		},
		{
			...keylessConfiguration,
			runtimeModelConfigurationV4: {
				...runtime,
				defaultModelOptionId: "missing",
			},
		},
	]) {
		expect(() => decodeAgentConfigurationRecord(invalid)).toThrow();
	}
});
