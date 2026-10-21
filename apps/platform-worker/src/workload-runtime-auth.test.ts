import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import { workloadDesiredFixture } from "./kubernetes.fixture.js";
import {
	resolveWorkloadFileExchangeOriginV1,
	validateWorkloadRuntimeAuthV1,
	workloadRuntimeAuthEnvironmentV1,
} from "./workload-runtime-auth.js";

const keys = generateKeyPairSync("ed25519");
const runtimeAuth = {
	workerId: "worker-a",
	grantKeyId: "grant-a",
	grantPublicKey: keys.publicKey
		.export({ format: "pem", type: "spki" })
		.toString(),
	grantIssuer: "platform-worker",
	serviceTokenSecret: { name: "runtime-transport", key: "token" },
};

it("injects the exact file exchange origin and the Secret-backed service token", () => {
	const desired = workloadDesiredFixture(2, "custom-agent", "internal-only");
	const env = workloadRuntimeAuthEnvironmentV1(
		{ ...runtimeAuth, fileExchangeOrigin: "http://platform-api:3000" },
		desired,
	);
	expect(
		env.find(
			(entry) => entry.name === "AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN",
		),
	).toEqual({
		name: "AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN",
		value: "http://platform-api:3000",
	});
	expect(
		env.find(
			(entry) =>
				entry.name === "AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN",
		),
	).toEqual({
		name: "AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN",
		valueFrom: {
			secretKeyRef: {
				name: "runtime-transport",
				key: "token",
				optional: false,
			},
		},
	});
	// The deployment token never becomes a Pod env literal.
	expect(JSON.stringify(env)).not.toMatch(/Bearer|secret-token/);
});

it("leaves file exchange disabled without an origin", () => {
	const env = workloadRuntimeAuthEnvironmentV1(
		runtimeAuth,
		workloadDesiredFixture(2, "custom-agent", "internal-only"),
	);
	expect(
		env.some((entry) =>
			entry.name.startsWith("AGENT_INFRA_RUNTIME_FILE_EXCHANGE_"),
		),
	).toBe(false);
});

it("resolves the origin from the module or the environment, rejecting duplication and half configuration", () => {
	expect(
		resolveWorkloadFileExchangeOriginV1({
			configured: "http://platform-api:3000",
			hasRuntimeAuth: true,
		}),
	).toBe("http://platform-api:3000");
	expect(
		resolveWorkloadFileExchangeOriginV1({
			environment: "http://platform-api:3000",
			hasRuntimeAuth: true,
		}),
	).toBe("http://platform-api:3000");
	expect(
		resolveWorkloadFileExchangeOriginV1({
			environment: "",
			hasRuntimeAuth: true,
		}),
	).toBeUndefined();
	expect(() =>
		resolveWorkloadFileExchangeOriginV1({
			configured: "http://platform-api:3000",
			environment: "http://other-api:3000",
			hasRuntimeAuth: true,
		}),
	).toThrow("PLATFORM_WORKER_FILE_EXCHANGE_DUPLICATE");
	expect(() =>
		resolveWorkloadFileExchangeOriginV1({
			environment: "http://platform-api:3000",
			hasRuntimeAuth: false,
		}),
	).toThrow("PLATFORM_WORKER_FILE_EXCHANGE_CONFIGURATION_INVALID");
	for (const environment of [
		"platform-api:3000",
		"http://platform-api:3000/",
		"http://platform-api:3000/path",
		"http://user@platform-api:3000",
		"http://127.0.0.1:3000",
		"ftp://platform-api:3000",
	]) {
		expect(() =>
			resolveWorkloadFileExchangeOriginV1({
				environment,
				hasRuntimeAuth: true,
			}),
		).toThrow("PLATFORM_WORKER_FILE_EXCHANGE_CONFIGURATION_INVALID");
	}
});

it("accepts only an exact HTTP(S) origin in deployment Runtime auth", () => {
	validateWorkloadRuntimeAuthV1({
		...runtimeAuth,
		fileExchangeOrigin: "http://platform-api:3000",
	});
	validateWorkloadRuntimeAuthV1({
		...runtimeAuth,
		fileExchangeOrigin: "https://api.example.test",
	});
	for (const origin of [
		"http://platform-api:3000/",
		"http://platform-api:3000/files",
		"http://platform-api:3000?x=1",
		"http://platform-api:3000#x",
		"http://user:pass@platform-api:3000",
		"http://127.0.0.1:3000",
		"ftp://platform-api:3000",
	]) {
		expect(() =>
			validateWorkloadRuntimeAuthV1({
				...runtimeAuth,
				fileExchangeOrigin: origin,
			}),
		).toThrow();
	}
});
