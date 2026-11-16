import {
	connectionConsumerProfileFingerprintV1,
	connectionSystemAccessFingerprintV1,
	resolveApprovedConnectionSystemAccessV1,
} from "@agent-infra/contracts/connection-consumer-profile";
import { describe, expect, it } from "vitest";

import {
	readConnectionConsumerEnvironmentConfigurationV1,
	readConnectionSystemAccessEnvironmentConfigurationV1,
} from "./connection-consumer-environment.js";
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

describe("one-time Connection system access environment (#4157)", () => {
	const system = {
		schemaVersion: 1 as const,
		publicOrigin: "https://connection.example.test",
		mcpPath: "/mcp",
		audience: "connection-api",
		egressProfile: { ref: "egress", revision: "r1" },
		issuer: "https://connection.example.test/",
		oauthCallbackUrl: "https://platform.example.test/callback",
	};
	const fingerprint = connectionSystemAccessFingerprintV1(system);
	const approval = {
		schemaVersion: 1,
		configFingerprint: fingerprint,
		egressEnforced: true,
		source: { ref: "platform-deployment", revision: "r1" },
	};
	const absent = Symbol("absent");
	const environment = (value: unknown = approval) => ({
		AGENT_INFRA_CONNECTION_SYSTEM_ACCESS: JSON.stringify(system),
		...(value === absent
			? {}
			: {
					AGENT_INFRA_CONNECTION_SYSTEM_ACCESS_APPROVAL: JSON.stringify(value),
				}),
		// The version names whatever fingerprint the approval states.
		AGENT_INFRA_CONNECTION_CONFIG_VERSION: `1-${(value as { configFingerprint?: string } | undefined)?.configFingerprint ?? fingerprint}`,
		AGENT_INFRA_CONNECTION_WEB_PATH: "/connection/connections",
	});
	const resolve = (value: NodeJS.ProcessEnv) => {
		const read = readConnectionSystemAccessEnvironmentConfigurationV1(value);
		return resolveApprovedConnectionSystemAccessV1(
			read?.system,
			read?.approval,
		);
	};

	it("passes the explicit fingerprint-bound approval through unchanged", () => {
		expect(
			readConnectionSystemAccessEnvironmentConfigurationV1(environment()),
		).toEqual({
			system,
			approval,
			configVersion: `1-${fingerprint}`,
			webPath: "/connection/connections",
		});
		expect(resolve(environment())).toMatchObject({
			status: "available",
			configFingerprint: fingerprint,
			source: approval.source,
		});
		expect(readConnectionSystemAccessEnvironmentConfigurationV1({})).toBe(
			undefined,
		);
	});

	it.each([
		["absent", absent, "missing"],
		[
			"egress not attested",
			{ ...approval, egressEnforced: undefined },
			"unapproved",
		],
		["egress false", { ...approval, egressEnforced: false }, "unapproved"],
		["egress a string", { ...approval, egressEnforced: "true" }, "unapproved"],
		[
			"fingerprint of other fields",
			{ ...approval, configFingerprint: "a".repeat(64) },
			"invalid",
		],
	] as const)(
		"keeps Connection unavailable when the approval is %s",
		(_label, value, reason) => {
			// Without an approval the fields themselves are closed (reported as missing).
			expect(resolve(environment(value))).toEqual({
				status: "unavailable",
				schemaVersion: 1,
				reason,
			});
		},
	);

	it("does not infer an approval from fingerprint and source metadata alone", () => {
		const result = resolve({
			...environment(absent),
			AGENT_INFRA_CONNECTION_CONFIG_FINGERPRINT: fingerprint,
			AGENT_INFRA_CONNECTION_APPROVAL_SOURCE_REF: "platform-deployment",
			AGENT_INFRA_CONNECTION_APPROVAL_SOURCE_REVISION: "r1",
		});
		expect(result).toMatchObject({ status: "unavailable" });
	});

	it("closes on a version mismatch, a disagreeing fingerprint or a legacy Consumer profile beside it", () => {
		for (const extra of [
			{ AGENT_INFRA_CONNECTION_CONFIG_VERSION: "1-other" },
			{ AGENT_INFRA_CONNECTION_CONFIG_FINGERPRINT: "b".repeat(64) },
			{ AGENT_INFRA_CONNECTION_PROFILE: JSON.stringify({ consumerId: "x" }) },
		]) {
			const value = { ...environment(), ...extra };
			expect(
				readConnectionSystemAccessEnvironmentConfigurationV1(value)?.system,
			).toBeNull();
			expect(resolve(value)).toMatchObject({ status: "unavailable" });
		}
	});
});
