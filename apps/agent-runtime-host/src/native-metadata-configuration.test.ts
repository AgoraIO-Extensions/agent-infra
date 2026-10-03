import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readRuntimeNativeMetadataConfigurationV1 } from "./configuration.js";

const publicKey = generateKeyPairSync("ed25519").publicKey;
const configuration = {
	schemaVersion: 1,
	workerId: "worker-a",
	issuer: "metadata-worker",
	keyVersion: "metadata-key-a",
	publicKeyDerBase64: publicKey
		.export({ format: "der", type: "spki" })
		.toString("base64"),
	maxActiveReads: 8,
	workerOrigin: "https://worker.example.test:3052/",
};
function environment(
	overrides: Record<string, unknown> = {},
): NodeJS.ProcessEnv {
	return {
		AGENT_INFRA_RUNTIME_AGENT_ID: "agent-a",
		AGENT_INFRA_RUNTIME_NATIVE_METADATA_CONFIG: JSON.stringify({
			...configuration,
			...overrides,
		}),
		AGENT_INFRA_RUNTIME_METADATA_WORKER_TOKEN: "synthetic-worker-to-host-token",
		AGENT_INFRA_RUNTIME_METADATA_HOST_TOKEN: "synthetic-host-to-worker-token",
		AGENT_INFRA_RUNTIME_SERVICE_TOKEN: "synthetic-business-runtime-token",
	};
}

describe("Host private metadata deployment configuration", () => {
	it("resolves the fixed Worker origin, dedicated public key and separate transport directions", () => {
		const env = environment();
		expect(readRuntimeNativeMetadataConfigurationV1(env)).toEqual({
			workerId: configuration.workerId,
			issuer: configuration.issuer,
			keyVersion: configuration.keyVersion,
			publicKeyDerBase64: configuration.publicKeyDerBase64,
			maxActiveReads: configuration.maxActiveReads,
			workerOrigin: "https://worker.example.test:3052",
			agentId: "agent-a",
			serviceToken: env.AGENT_INFRA_RUNTIME_METADATA_WORKER_TOKEN,
			callbackToken: env.AGENT_INFRA_RUNTIME_METADATA_HOST_TOKEN,
		});
		expect(readRuntimeNativeMetadataConfigurationV1({})).toBeUndefined();
	});

	it.each([
		{ schemaVersion: 2 },
		{ workerId: "worker with spaces" },
		{ issuer: undefined },
		{ maxActiveReads: 0 },
		{ maxActiveReads: 1.5 },
		{ publicKeyDerBase64: "AA" },
		{ publicKeyDerBase64: `${configuration.publicKeyDerBase64}\n` },
		{ privateKey: "private-configuration-canary" },
		{ workerOrigin: "https://worker.example.test/internal" },
		{
			workerOrigin:
				"https://user:private-configuration-canary@worker.example.test",
		},
		{
			workerOrigin:
				"https://worker.example.test/?token=private-configuration-canary",
		},
		{ workerOrigin: "https://worker.example.test/#fragment" },
	])("fails closed on a malformed or widened configuration", (overrides) => {
		expect(() =>
			readRuntimeNativeMetadataConfigurationV1(environment(overrides)),
		).toThrow(/^RUNTIME_CONFIGURATION_INVALID$/);
	});

	it.each(["", "null", "[]", "private-configuration-canary"])(
		"rejects supplied invalid JSON without exposing it",
		(raw) => {
			expect(() =>
				readRuntimeNativeMetadataConfigurationV1({
					...environment(),
					AGENT_INFRA_RUNTIME_NATIVE_METADATA_CONFIG: raw,
				}),
			).toThrow(/^RUNTIME_CONFIGURATION_INVALID$/);
		},
	);

	it.each([
		[
			"AGENT_INFRA_RUNTIME_METADATA_WORKER_TOKEN",
			"AGENT_INFRA_RUNTIME_METADATA_HOST_TOKEN",
		],
		[
			"AGENT_INFRA_RUNTIME_METADATA_WORKER_TOKEN",
			"AGENT_INFRA_RUNTIME_SERVICE_TOKEN",
		],
		[
			"AGENT_INFRA_RUNTIME_METADATA_HOST_TOKEN",
			"AGENT_INFRA_RUNTIME_SERVICE_TOKEN",
		],
	])("rejects credential reuse between %s and %s", (target, source) => {
		const env = environment();
		env[target] = env[source];
		expect(() => readRuntimeNativeMetadataConfigurationV1(env)).toThrow(
			/^RUNTIME_CONFIGURATION_INVALID$/,
		);
	});

	it.each([
		["AGENT_INFRA_RUNTIME_AGENT_ID", undefined],
		["AGENT_INFRA_RUNTIME_METADATA_WORKER_TOKEN", undefined],
		["AGENT_INFRA_RUNTIME_METADATA_HOST_TOKEN", ""],
		["AGENT_INFRA_RUNTIME_METADATA_HOST_TOKEN", "private token canary"],
		["AGENT_INFRA_RUNTIME_METADATA_WORKER_TOKEN", "private\ntoken-canary"],
	])("does not recover invalid %s from ambient credentials", (name, value) => {
		const env = {
			...environment(),
			OPENAI_API_KEY: "synthetic-ambient-credential",
		};
		expect(() =>
			readRuntimeNativeMetadataConfigurationV1({
				...env,
				[name as string]: value,
			}),
		).toThrow(/^RUNTIME_CONFIGURATION_INVALID$/);
	});
});
