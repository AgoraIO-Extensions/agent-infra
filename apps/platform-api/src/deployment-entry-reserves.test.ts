import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sessionSandboxReserveDigestV1 } from "@agent-infra/platform-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mountedFile = vi.hoisted(() => ({
	path: undefined as string | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return {
		...actual,
		readFile: (file: string, options: "utf8") => {
			if (file !== "/app/deployment/session-reserves.json")
				return actual.readFile(file, options);
			if (mountedFile.path) return actual.readFile(mountedFile.path, options);
			return Promise.reject(
				Object.assign(new Error("missing"), { code: "ENOENT" }),
			);
		},
	};
});
vi.mock("@agent-infra/identity", async (original) => ({
	...(await original<typeof import("@agent-infra/identity")>()),
	createLdapIdentityDirectory: () => ({ currentByUserId: async () => null }),
}));
vi.mock("@agent-infra/platform-store", async (original) => ({
	...(await original<typeof import("@agent-infra/platform-store")>()),
	PostgresPlatformUserDisablesV1: class {
		async isPlatformDisabled() {
			return false;
		}
	},
}));
vi.mock("./index.js", async () => ({
	createProductionPlatformApiAssemblyInputV1: (await import("./deployment.js"))
		.createProductionPlatformApiAssemblyInputV1,
	createPostgresLdapBrowserDeployment: () => ({
		browserAuth: { handleRequest: async () => null },
		identity: {
			resolve: async () => null,
			hydrateUsers: async () => new Map(),
		},
	}),
	createProductionSingleAgentTemplateReleaseAppV1: () => undefined,
}));

const sourceSha = "a".repeat(40);
const resources = {
	cpuMillis: 1000,
	memoryBytes: 2_147_483_648,
	storageBytes: 20_000_000_000,
};
function policy(enabled = true) {
	return {
		schemaVersion: 1,
		enabled,
		revision: 3,
		namespace: "api-reserve-test",
		totalBudget: resources,
		resourceCosts: enabled
			? [{ resourceConfigurationHash: "b".repeat(64), resources }]
			: [],
		maximumReserves: enabled ? 1 : 0,
		maximumConcurrentCreates: enabled ? 1 : 0,
		ttlMs: 60_000,
		cooldownMs: 1000,
		failureBackoffMs: 1000,
		profiles: enabled
			? [
					{
						agentId: "approved-agent",
						templateId: "codex",
						imageDigest: `sha256:${"c".repeat(64)}`,
						resourceConfigurationHash: "b".repeat(64),
						resources,
						storageConfigurationVersion: "storage-1",
						networkPolicyVersion: "network-1",
						signingConfigurationVersion: "signing-1",
						transportConfigurationVersion: "transport-1",
						connectionConfigurationVersion: "connection-1",
						minimum: 1,
						maximum: 1,
					},
				]
			: [],
	};
}

const publicKey = generateKeyPairSync("rsa", {
	modulusLength: 3072,
}).publicKey.export({ format: "der", type: "spki" });
const encryptionKeys = {
	schemaVersion: 1,
	activeWrappingKeyVersion: "key_01",
	keys: [
		{
			schemaVersion: 1,
			keyVersion: "key_01",
			wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
			publicKeySpkiDerBase64: publicKey.toString("base64"),
			publicKeyFingerprint: createHash("sha256")
				.update(publicKey)
				.digest("hex"),
			rsaModulusBits: 3072,
			status: "active",
		},
	],
};
let directory: string;
beforeEach(async () => {
	vi.resetModules();
	directory = await mkdtemp(join(tmpdir(), "api-reserve-entry-"));
	mountedFile.path = undefined;
	vi.stubEnv("PLATFORM_API_SESSION_RESERVES_FILE", undefined);
	vi.stubEnv("PLATFORM_API_NATIVE_METADATA_WORKER_ORIGIN", undefined);
	vi.stubEnv("PLATFORM_API_FILE_DEPLOYMENT_CONFIGURATION_FILE", undefined);
	vi.stubEnv(
		"PLATFORM_DATABASE_URL",
		"postgresql://fixture:fixture@127.0.0.1:1/platform",
	);
	const proxy = join(directory, "proxy-token");
	await writeFile(proxy, "fixture-proxy-sentinel");
	vi.stubEnv("PLATFORM_API_PROXY_TOKEN_FILE", proxy);
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(directory, { recursive: true, force: true });
});

async function load(modulePolicy?: unknown) {
	const configuration = join(directory, "configuration.mjs");
	await writeFile(
		configuration,
		`
export const ldap = { verifyCurrentStatus: async () => "active" };
export const organizationIds = async () => [];
export const directorySearch = async () => [];
export const publicOrigin = "https://platform.example.test";
export const apiInput = {
  taskAdmissionPolicy: {maximumWaitingTasksPerAgent: 2, waitingTimeoutMs: 60000},
  loadAuthorityContext: async () => ({schemaVersion: 1, users: [], organizationIds: []}),
  imageRepository: "registry.example.test/agent",
  registry: {endpoint: "https://registry.example.test", imageReferencePrefix: "registry.example.test", admissionPolicyRef: "fixture", policy: {authorize: async () => ({status: "rejected"})}},
  templates: [], modelCatalog: {revision: "fixture", load: async () => ({})},
  channelPolicy: {revision: "fixture", bindings: []}, encryptionKeys: ${JSON.stringify(encryptionKeys)},
  resourceProfile: {profileId: "small", displayName: "Small", estimatedResources: {cpuMillicores: 1000, memoryMiB: 2048, storageGiB: 20}},
  ${modulePolicy === undefined ? "" : `sessionSandboxReserves: ${JSON.stringify(modulePolicy)},`}
};
`,
	);
	vi.stubEnv(
		"PLATFORM_API_CONFIGURATION_MODULE",
		pathToFileURL(configuration).href,
	);
	return import("./deployment-entry.js");
}

async function reserveFile(value: unknown, explicit = true) {
	const file = join(directory, "session-reserves.json");
	await writeFile(
		file,
		typeof value === "string" ? value : JSON.stringify(value),
		{ mode: 0o600 },
	);
	if (explicit) vi.stubEnv("PLATFORM_API_SESSION_RESERVES_FILE", file);
	else mountedFile.path = file;
	return file;
}

it.each([true, false])(
	"loads mounted reserve enabled=%s through the real API assembly",
	async (enabled) => {
		const configuration = policy(enabled);
		const input = { ...configuration, sourceSha };
		await reserveFile(input, false);
		const entry = await load();
		expect(
			entry.createPlatformApiAssemblyInput().sessionSandboxReserves,
		).toEqual(configuration);
		expect(entry.readPlatformSessionReserveDeploymentV1()).toEqual({
			source: "file",
			sourceSha,
			configurationHash: sessionSandboxReserveDigestV1(input),
			configuration,
		});
		expect(
			JSON.stringify(entry.readPlatformSessionReserveDeploymentV1()),
		).not.toContain("fixture-proxy-sentinel");
	},
);

it("accepts an explicit file and equal module config with different key order", async () => {
	const configuration = policy();
	await reserveFile({ ...configuration, sourceSha });
	const entry = await load(
		Object.fromEntries(Object.entries(configuration).reverse()),
	);
	expect(entry.createPlatformApiAssemblyInput().sessionSandboxReserves).toEqual(
		configuration,
	);
	const first = entry.readPlatformSessionReserveDeploymentV1();
	if (!first.configuration) throw new Error("Expected reserve configuration");
	Object.assign(first.configuration, { revision: 999 });
	expect(
		entry.readPlatformSessionReserveDeploymentV1().configuration?.revision,
	).toBe(3);
	expect(
		entry.createPlatformApiAssemblyInput().sessionSandboxReserves?.revision,
	).toBe(3);
});

it.each([undefined, false, true])(
	"keeps module-only reserve behavior (%s)",
	async (enabled) => {
		const configuration = enabled === undefined ? undefined : policy(enabled);
		const entry = await load(configuration);
		expect(
			entry.createPlatformApiAssemblyInput().sessionSandboxReserves,
		).toEqual(configuration);
		expect(entry.readPlatformSessionReserveDeploymentV1()).toEqual({
			source: "module",
			sourceSha: null,
			configurationHash: null,
			configuration: configuration ?? null,
		});
	},
);

it("rejects a conflicting module config even with a valid mounted file", async () => {
	await reserveFile({ ...policy(), sourceSha });
	await expect(load({ ...policy(), revision: 2 })).rejects.toThrow(
		"SESSION_RESERVE_DEPLOYMENT_CONFIGURATION_CONFLICT",
	);
});

it("fails closed when an explicitly selected file is absent", async () => {
	vi.stubEnv(
		"PLATFORM_API_SESSION_RESERVES_FILE",
		join(directory, "missing.json"),
	);
	await expect(load(policy())).rejects.toThrow(
		"SESSION_RESERVE_DEPLOYMENT_CONFIGURATION_MISSING",
	);
});

it("does not fall back to the module when the selected file cannot be read", async () => {
	vi.stubEnv("PLATFORM_API_SESSION_RESERVES_FILE", directory);
	await expect(load(policy())).rejects.toThrow(
		"SESSION_RESERVE_DEPLOYMENT_CONFIGURATION_INVALID",
	);
});

it("validates module policy even when a valid file is mounted", async () => {
	await reserveFile({ ...policy(), sourceSha });
	await expect(load({ ...policy(), token: "private-value" })).rejects.toThrow(
		/^SESSION_RESERVE_DEPLOYMENT_CONFIGURATION_INVALID$/,
	);
});

it("strips source metadata from an equal module policy before Core use", async () => {
	const input = { ...policy(), sourceSha };
	await reserveFile(input);
	const entry = await load(input);
	expect(entry.createPlatformApiAssemblyInput().sessionSandboxReserves).toEqual(
		policy(),
	);
});

it.each([
	["empty-path", ""],
	["relative-path", "relative.json"],
])("rejects explicit %s", async (_name, file) => {
	vi.stubEnv("PLATFORM_API_SESSION_RESERVES_FILE", file);
	await expect(load()).rejects.toThrow(
		"SESSION_RESERVE_DEPLOYMENT_CONFIGURATION_INVALID",
	);
});

it.each([
	["malformed-json", "{private-value"],
	["null", null],
	["array", []],
	["bad-policy", { ...policy(), maximumReserves: -1 }],
	["non-string-namespace", { ...policy(), namespace: 123 }],
	[
		"non-string-agent",
		{
			...policy(),
			profiles: [
				{ ...policy().profiles[0], agentId: { credential: "private-value" } },
			],
		},
	],
	["source-metadata", { ...policy(), sourceSha: "credential-sentinel" }],
	["unknown-field", { ...policy(), credential: "private-value" }],
	[
		"unknown-profile-field",
		{
			...policy(),
			profiles: [{ ...policy().profiles[0], profileDigest: "private-value" }],
		},
	],
	[
		"unknown-cost-field",
		{
			...policy(),
			resourceCosts: [{ ...policy().resourceCosts[0], token: "private-value" }],
		},
	],
])(
	"rejects %s before API assembly without exposing input",
	async (_name, input) => {
		await reserveFile(input);
		await expect(load()).rejects.toThrow(
			/^SESSION_RESERVE_DEPLOYMENT_CONFIGURATION_INVALID$/,
		);
	},
);
