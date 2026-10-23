import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import { workloadDesiredFixture } from "./kubernetes.fixture.js";
import {
	fileExchangeOriginPortV1,
	resolveWorkloadFileExchangeEgressV1,
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

it("derives the file exchange egress port from the exact origin (#3289)", () => {
	expect(fileExchangeOriginPortV1("http://platform-api:3000")).toBe(3000);
	expect(fileExchangeOriginPortV1("http://platform-api")).toBe(80);
	expect(fileExchangeOriginPortV1("https://files.example.test")).toBe(443);
	expect(
		resolveWorkloadFileExchangeEgressV1({
			origin: "https://files.example.test",
			environment: JSON.stringify({ ip: "198.51.100.7" }),
		}),
	).toEqual([{ destination: { ip: "198.51.100.7" }, port: 443 }]);
	const selector = {
		namespace: "agent-infra",
		podLabels: { "app.kubernetes.io/component": "platform-api" },
	};
	expect(
		resolveWorkloadFileExchangeEgressV1({
			origin: "http://platform-api:3000",
			configured: [{ destination: selector, port: 3000 }],
		}),
	).toEqual([{ destination: selector, port: 3000 }]);
	// 未配置文件交换时没有这条规则。
	expect(resolveWorkloadFileExchangeEgressV1({})).toBeUndefined();
	expect(resolveWorkloadFileExchangeEgressV1({ environment: "" })).toBe(
		undefined,
	);
});

it.each([
	["an origin without egress", { origin: "http://platform-api:3000" }],
	[
		"an egress without origin",
		{ environment: JSON.stringify({ ip: "198.51.100.7" }) },
	],
	[
		"a configured egress without origin",
		{ configured: [{ destination: { ip: "198.51.100.7" }, port: 3000 }] },
	],
	[
		"a configured port other than the origin port",
		{
			origin: "http://platform-api:3000",
			configured: [{ destination: { ip: "198.51.100.7" }, port: 3001 }],
		},
	],
	[
		"two configured destinations",
		{
			origin: "http://platform-api:3000",
			configured: [
				{ destination: { ip: "198.51.100.7" }, port: 3000 },
				{ destination: { ip: "198.51.100.8" }, port: 3000 },
			],
		},
	],
	[
		"a CIDR destination",
		{
			origin: "http://platform-api:3000",
			environment: JSON.stringify({ cidr: "198.51.0.0/16" }),
		},
	],
	[
		"an empty Pod selector",
		{
			origin: "http://platform-api:3000",
			environment: JSON.stringify({ namespace: "agent-infra", podLabels: {} }),
		},
	],
	[
		"a destination with an extra port",
		{
			origin: "http://platform-api:3000",
			environment: JSON.stringify({ ip: "198.51.100.7", port: 9000 }),
		},
	],
	[
		"malformed JSON",
		{ origin: "http://platform-api:3000", environment: "{ip:" },
	],
	[
		"an invalid origin",
		{
			origin: "http://platform-api:3000/api",
			environment: JSON.stringify({ ip: "198.51.100.7" }),
		},
	],
] as const)(
	"rejects %s as a configuration error (#3289 AC-2)",
	(_name, input) => {
		expect(() =>
			resolveWorkloadFileExchangeEgressV1(
				input as Parameters<typeof resolveWorkloadFileExchangeEgressV1>[0],
			),
		).toThrow("PLATFORM_WORKER_FILE_EXCHANGE_CONFIGURATION_INVALID");
	},
);

it("rejects a file exchange egress from both the module and the environment", () => {
	expect(() =>
		resolveWorkloadFileExchangeEgressV1({
			origin: "http://platform-api:3000",
			configured: [{ destination: { ip: "198.51.100.7" }, port: 3000 }],
			environment: JSON.stringify({ ip: "198.51.100.7" }),
		}),
	).toThrow("PLATFORM_WORKER_FILE_EXCHANGE_DUPLICATE");
});
