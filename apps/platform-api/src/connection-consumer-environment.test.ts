import { connectionConsumerProfileFingerprintV1 } from "@agent-infra/contracts/connection-consumer-profile";
import { describe, expect, it } from "vitest";

import { readConnectionConsumerEnvironmentConfigurationV1 } from "./connection-consumer-environment.js";
import { createConnectionCapability } from "./connection-consumer-profile.js";

const profile = {
	schemaVersion: 1 as const,
	publicOrigin: "https://connection.example.test",
	mcpPath: "/mcp",
	consumerId: "agent-a",
	audience: "https://connection.example.test/mcp",
	egressProfile: { ref: "connection-egress", revision: "r1" },
};

function fingerprint(value: typeof profile) {
	return connectionConsumerProfileFingerprintV1(value);
}

const connectionCapability = (input: unknown, approval: unknown) =>
	createConnectionCapability(input, approval, "/connection/connections");

const environment = {
	AGENT_INFRA_CONNECTION_PROFILE: JSON.stringify(profile),
	AGENT_INFRA_CONNECTION_CONFIG_VERSION: `1-${fingerprint(profile)}`,
	AGENT_INFRA_CONNECTION_CONFIG_FINGERPRINT: fingerprint(profile),
	AGENT_INFRA_CONNECTION_APPROVAL_SOURCE_REF: "connection-deployment",
	AGENT_INFRA_CONNECTION_APPROVAL_SOURCE_REVISION: "r1",
	AGENT_INFRA_CONNECTION_WEB_PATH: "/connection/connections",
};

describe("Connection Consumer environment configuration", () => {
	it("reads the projected profile and approval for the server capability", () => {
		const configuration =
			readConnectionConsumerEnvironmentConfigurationV1(environment);
		expect(configuration).toBeDefined();
		expect(
			connectionCapability(configuration?.profile, configuration?.approval),
		).toMatchObject({ status: "available" });
	});

	it("keeps partial or changed environment input unavailable", () => {
		const configuration = readConnectionConsumerEnvironmentConfigurationV1({
			...environment,
			AGENT_INFRA_CONNECTION_CONFIG_VERSION: `1-${"0".repeat(64)}`,
			AGENT_INFRA_CONNECTION_CONFIG_FINGERPRINT: "0".repeat(64),
		});
		expect(
			connectionCapability(configuration?.profile, configuration?.approval),
		).toMatchObject({ status: "unavailable" });

		expect(
			readConnectionConsumerEnvironmentConfigurationV1({
				AGENT_INFRA_CONNECTION_PROFILE:
					environment.AGENT_INFRA_CONNECTION_PROFILE,
				AGENT_INFRA_CONNECTION_CONFIG_FINGERPRINT:
					environment.AGENT_INFRA_CONNECTION_CONFIG_FINGERPRINT,
				AGENT_INFRA_CONNECTION_APPROVAL_SOURCE_REF:
					environment.AGENT_INFRA_CONNECTION_APPROVAL_SOURCE_REF,
				AGENT_INFRA_CONNECTION_APPROVAL_SOURCE_REVISION:
					environment.AGENT_INFRA_CONNECTION_APPROVAL_SOURCE_REVISION,
			}),
		).toEqual({
			profile: undefined,
			approval: {
				schemaVersion: 1,
				configFingerprint:
					environment.AGENT_INFRA_CONNECTION_CONFIG_FINGERPRINT,
				egressEnforced: true,
				source: {
					ref: environment.AGENT_INFRA_CONNECTION_APPROVAL_SOURCE_REF,
					revision: environment.AGENT_INFRA_CONNECTION_APPROVAL_SOURCE_REVISION,
				},
			},
			configVersion: undefined,
			webPath: undefined,
		});
	});

	it("does not create a configuration when no Connection env is present", () => {
		expect(
			readConnectionConsumerEnvironmentConfigurationV1({}),
		).toBeUndefined();
		expect(
			readConnectionConsumerEnvironmentConfigurationV1({
				AGENT_INFRA_CONNECTION_PROFILE: "",
				AGENT_INFRA_CONNECTION_CONFIG_VERSION: "",
				AGENT_INFRA_CONNECTION_CONFIG_FINGERPRINT: "",
				AGENT_INFRA_CONNECTION_APPROVAL_SOURCE_REF: "",
				AGENT_INFRA_CONNECTION_APPROVAL_SOURCE_REVISION: "",
			}),
		).toBeUndefined();
	});
});
