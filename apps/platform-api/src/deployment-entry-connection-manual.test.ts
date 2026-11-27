import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { connectionSystemAccessFingerprintV1 } from "@agent-infra/contracts/connection-consumer-profile";
import { migratePlatformDatabase } from "@agent-infra/platform-store";
import postgres from "postgres";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.ts";

// #4199 C2: the API production entry opens the §13.5.1 exception route only for
// an approved, bound, live exception record and a complete DB-resolved
// Principal set. Real deployment entry, deployment assembly and PostgreSQL.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });
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
	createPostgresOidcBrowserDeployment: () => ({
		browserAuth: { handleRequest: async () => null },
		identity: {
			resolve: async () => null,
			hydrateUsers: async () => new Map(),
		},
	}),
	createProductionSingleAgentTemplateReleaseAppV1: () => undefined,
}));

const publicOrigin = "https://platform.example.test";
const systemAccess = {
	schemaVersion: 1 as const,
	publicOrigin: "https://connection.example.test",
	mcpPath: "/mcp",
	audience: "https://connection.example.test/mcp",
	egressProfile: { ref: "fixture-egress", revision: "r1" },
	issuer: "https://connection.example.test/",
	oauthCallbackUrl: `${publicOrigin}/api/connection-installations/callback`,
};
const approval = {
	schemaVersion: 1,
	configFingerprint: connectionSystemAccessFingerprintV1(systemAccess),
	egressEnforced: true,
	source: { ref: "user-authorized-2026-11-18T08:37Z", revision: "1" },
};
const exceptionApproval = {
	schemaVersion: 1,
	kind: "consistency-exception-v1",
	policy: { ref: "consistency-exception-v1", revision: "1" },
	notAfter: "2099-01-01T00:00:00Z",
	maximumPinnedPrincipals: 2,
	verificationWindowHours: 24,
	connectionRelease: "agora-connector-734dafc9",
	systemAccessFingerprint: approval.configFingerprint,
	approvalSource: approval.source,
};
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

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let directory: string;
let sequence = 0;
/** A callback-only Bearer token; it must never surface in logs or assembly input. */
const callbackToken = `callback-${randomBytes(16).toString("hex")}`;

beforeAll(async () => {
	database = await startPostgresTestDatabase("api-entry-manual-route");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 1, onnotice: () => {} });
	await sql`insert into platform.agents(id,authorization_revision) values ('agent-a','agent-r1')`;
	await sql`insert into platform.relay_key_subjects(purpose,subject_id,last_version,current_version) values ('personal','bob',1,1)`;
	await sql`insert into platform.relay_key_versions(purpose,subject_id,key_version,key_id,ciphertext) values ('personal','bob',1,'fixture-key-bob',${sql.json({ purpose: "personal", subjectId: "bob", keyId: "fixture-key-bob", keyVersion: 1 })})`;
	await sql`insert into platform.conversations(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision,host_session_ref) values ('conversation-b','agent-a','bob','web','active',1,'agent-r1','host-b')`;
	await sql`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,authorization_revision,created_at,runtime_submit_protocol,original_operation_digest,original_submit_host_session_ref,execution_source,relay_key_purpose,relay_key_subject_id,relay_key_id,relay_key_version,delivery_fence) values ('execution-b','conversation-b','agent-a','bob','web','turn-b','processing',1,'agent-r1',now(),'v4',${"a".repeat(43)},'host-b','web','personal','bob','fixture-key-bob',1,3)`;
});

afterAll(async () => {
	await sql?.end();
	await database?.stop();
});

beforeEach(async () => {
	vi.resetModules();
	directory = await mkdtemp(join(tmpdir(), "api-manual-entry-"));
	await sql`delete from platform.connection_installation_authorizations`;
	for (const name of [
		"PLATFORM_API_SESSION_RESERVES_FILE",
		"PLATFORM_API_NATIVE_METADATA_WORKER_ORIGIN",
		"PLATFORM_API_CONNECTION_CALLBACK_HOST_CA_FILE",
		"PLATFORM_API_FILE_DEPLOYMENT_CONFIGURATION_FILE",
		"AGENT_INFRA_CONNECTION_PROFILE",
		"AGENT_INFRA_CONNECTION_EXCEPTION_APPROVAL",
		"AGENT_INFRA_CONNECTION_MANUAL_CLIENT_NAME",
	])
		vi.stubEnv(name, undefined);
	vi.stubEnv("PLATFORM_DATABASE_URL", database.databaseUrl);
	const proxy = join(directory, "proxy-token");
	await writeFile(proxy, "s".repeat(43));
	vi.stubEnv("PLATFORM_API_PROXY_TOKEN_FILE", proxy);
	const callback = join(directory, "callback.auth");
	await writeFile(callback, callbackToken, { mode: 0o600 });
	vi.stubEnv("PLATFORM_API_CONNECTION_CALLBACK_AUTH_FILE", callback);
	// The one-time system access exactly as Helm projects it to the API.
	vi.stubEnv(
		"AGENT_INFRA_CONNECTION_SYSTEM_ACCESS",
		JSON.stringify(systemAccess),
	);
	vi.stubEnv(
		"AGENT_INFRA_CONNECTION_SYSTEM_ACCESS_APPROVAL",
		JSON.stringify(approval),
	);
	vi.stubEnv(
		"AGENT_INFRA_CONNECTION_CONFIG_VERSION",
		`1-${approval.configFingerprint}`,
	);
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(directory, { recursive: true, force: true });
});

async function load(exports = "") {
	const configuration = join(directory, `configuration-${++sequence}.mjs`);
	await writeFile(
		configuration,
		`
export const oidc = {issuer:"https://issuer.example.test",clientId:"platform",clientSecret:"fixture",allowEmailLink:true};
export const directorySnapshot = {endpoint:"https://directory.example.test",token:"x".repeat(32),organizationIdForDepartment:()=>"org"};
export const directorySearch = async () => [];
export const publicOrigin = ${JSON.stringify(publicOrigin)};
export const apiInput = {
  taskAdmissionPolicy: {maximumWaitingTasksPerAgent: 2, waitingTimeoutMs: 60000},
  loadAuthorityContext: async () => ({schemaVersion: 1, users: [], organizationIds: []}),
  imageRepository: "registry.example.test/agent",
  registry: {endpoint: "https://registry.example.test", imageReferencePrefix: "registry.example.test", admissionPolicyRef: "fixture", policy: {authorize: async () => ({status: "rejected"})}},
  templates: [], modelCatalog: {revision: "fixture", load: async () => ({})},
  channelPolicy: {revision: "fixture", bindings: []}, encryptionKeys: ${JSON.stringify(encryptionKeys)},
  resourceProfile: {profileId: "small", displayName: "Small", estimatedResources: {cpuMillicores: 1000, memoryMiB: 2048, storageGiB: 20}},
};
${exports}
`,
	);
	vi.stubEnv(
		"PLATFORM_API_CONFIGURATION_MODULE",
		pathToFileURL(configuration).href,
	);
	return import("./deployment-entry.js");
}

function logs() {
	return [
		...vi.mocked(console.warn).mock.calls,
		...vi.mocked(console.info).mock.calls,
	]
		.flat()
		.filter(
			(value): value is string =>
				typeof value === "string" && value.includes("CONNECTION_MANUAL"),
		)
		.map((value) => JSON.parse(value));
}

describe("API production entry for the §13.5.1 exception route (#4199 C2)", () => {
	it("opens the manual route and its callback for a projected approval record", async () => {
		vi.stubEnv(
			"AGENT_INFRA_CONNECTION_EXCEPTION_APPROVAL",
			JSON.stringify(exceptionApproval),
		);
		const entry = await load();
		const input = entry.createPlatformApiAssemblyInput();
		expect(input.connectionInstallation).toEqual({
			publicOrigin,
			manualInstallation: {
				systemAccess,
				approval,
				clientName: "Agent Infra",
				dynamic: {
					schemaVersion: 1,
					principalMapping: exceptionApproval,
					readbackContract: { ref: "connection-ep-1060-read", revision: "1" },
					publicationContract: {
						ref: "connection-mcp-publication",
						revision: "1",
					},
				},
				confirmedPrincipals: [],
			},
		});
		expect(typeof input.connectionInstallationCallback?.forward).toBe(
			"function",
		);
		const atProxy = new Request(
			`${publicOrigin}/api/connection-installations/callback`,
			{
				headers: { "x-platform-proxy-token": "s".repeat(43) },
			},
		);
		expect(
			input.connectionInstallationCallback?.isTrustedProxyRequest?.(atProxy),
		).toBe(true);
		expect(
			input.connectionInstallationCallback?.isTrustedProxyRequest?.(
				new Request(atProxy.url),
			),
		).toBe(false);
		expect(logs()).toEqual([
			{
				service: "platform-api",
				code: "CONNECTION_MANUAL_INSTALLATION_ENABLED",
				receipt: expect.objectContaining({
					principalMapping: "consistency-exception-v1",
					policy: exceptionApproval.policy,
					connectionRelease: "agora-connector-734dafc9",
					systemAccessFingerprint: approval.configFingerprint,
					clientName: "Agent Infra",
				}),
			},
		]);
		const text = JSON.stringify([input, logs()]);
		expect(text).not.toContain(callbackToken);
		expect(text).not.toContain("s".repeat(43));
	});

	it("takes the record and client name from the deployment module", async () => {
		const entry = await load(`
export const connectionConsistencyExceptionApproval = ${JSON.stringify(exceptionApproval)};
export const connectionManualInstallationClientName = "Agent Infra Pilot";`);
		expect(
			entry.createPlatformApiAssemblyInput().connectionInstallation
				?.manualInstallation?.clientName,
		).toBe("Agent Infra Pilot");
	});

	it.each([
		["no approval record", undefined, "exception_approval_missing"],
		["an unreadable record", "{", "exception_approval_invalid"],
		[
			"a record that fails the schema",
			JSON.stringify({ ...exceptionApproval, maximumPinnedPrincipals: 0 }),
			"exception_approval_invalid",
		],
		[
			"a passed notAfter",
			JSON.stringify({
				...exceptionApproval,
				notAfter: "2026-01-01T00:00:00Z",
			}),
			"exception_expired",
		],
		[
			"another system access fingerprint",
			JSON.stringify({
				...exceptionApproval,
				systemAccessFingerprint: "0".repeat(64),
			}),
			"system_access_fingerprint_mismatch",
		],
		[
			"no Connection release",
			JSON.stringify({ ...exceptionApproval, connectionRelease: undefined }),
			"connection_release_missing",
		],
	] as const)(
		"keeps the route dormant for %s",
		async (_name, record, reason) => {
			if (record !== undefined)
				vi.stubEnv("AGENT_INFRA_CONNECTION_EXCEPTION_APPROVAL", record);
			const entry = await load();
			const input = entry.createPlatformApiAssemblyInput();
			expect(input.connectionInstallation).toBeUndefined();
			expect(input.connectionInstallationCallback).toBeUndefined();
			expect(logs()).toEqual(
				record === undefined
					? []
					: [
							{
								service: "platform-api",
								code: "CONNECTION_MANUAL_INSTALLATION_DORMANT",
								reason,
							},
						],
			);
		},
	);

	it("keeps the route dormant when the system access approval is not projected", async () => {
		vi.stubEnv("AGENT_INFRA_CONNECTION_SYSTEM_ACCESS_APPROVAL", undefined);
		vi.stubEnv(
			"AGENT_INFRA_CONNECTION_EXCEPTION_APPROVAL",
			JSON.stringify(exceptionApproval),
		);
		const entry = await load();
		expect(
			entry.createPlatformApiAssemblyInput().connectionInstallation,
		).toBeUndefined();
		expect(logs()).toEqual([
			{
				service: "platform-api",
				code: "CONNECTION_MANUAL_INSTALLATION_DORMANT",
				reason: "system_access_unavailable",
			},
		]);
	});

	// Cross-user and cross-Agent: any user's standard installation on any Agent
	// leaves a Principal the Platform cannot name, so nobody gets the route.
	it("keeps the route dormant while any standard installation is confirmed", async () => {
		await sql`insert into platform.connection_installation_authorizations
			(id, execution_id, user_id, confirmation_revision, binding, identity_revision,
			 agent_authorization_revision, status, expires_at)
			values ('standard-bob', 'execution-b', 'bob', 'confirmation-r1',
				${sql.json({ principal: { kind: "user", id: "bob" }, reference: { executionId: "execution-b" } })},
				'identity-r1', 'agent-r1', 'confirmed', clock_timestamp() + interval '1 hour')`;
		vi.stubEnv(
			"AGENT_INFRA_CONNECTION_EXCEPTION_APPROVAL",
			JSON.stringify(exceptionApproval),
		);
		const entry = await load();
		expect(
			entry.createPlatformApiAssemblyInput().connectionInstallation,
		).toBeUndefined();
		expect(logs()).toEqual([
			{
				service: "platform-api",
				code: "CONNECTION_MANUAL_INSTALLATION_DORMANT",
				reason: "confirmed_principals_unresolvable",
			},
		]);
	});

	it("never takes the manual policy from the module's apiInput", async () => {
		const entry = await load(`
apiInput.connectionInstallation = { publicOrigin, manualInstallation: { systemAccess: {}, approval: {}, clientName: "forged", dynamic: {}, confirmedPrincipals: [] } };`);
		expect(
			entry.createPlatformApiAssemblyInput().connectionInstallation,
		).toBeUndefined();
	});

	// #4327 MUST 1 (Spec §13.5.6): the route opens only with a protected callback
	// delivery to the original Host. Without one a confirmed installation would
	// wait forever for a callback that is never forwarded.
	it.each<[string, () => Promise<string | undefined>]>([
		["no callback-auth file", async () => undefined],
		[
			"a missing callback-auth file",
			async () => join(directory, "absent.auth"),
		],
		[
			"a callback-auth file readable by others",
			async () => {
				const path = join(directory, "open.auth");
				await writeFile(path, callbackToken, { mode: 0o644 });
				return path;
			},
		],
		[
			"a callback-auth file with a short token",
			async () => {
				const path = join(directory, "short.auth");
				await writeFile(path, "short", { mode: 0o600 });
				return path;
			},
		],
		[
			"a symlinked callback-auth file",
			async () => {
				const path = join(directory, "linked.auth");
				await symlink(join(directory, "callback.auth"), path);
				return path;
			},
		],
		["a relative callback-auth path", async () => "callback.auth"],
	])(
		"keeps the route and its callback dormant with %s",
		async (_name, authFile) => {
			vi.stubEnv(
				"PLATFORM_API_CONNECTION_CALLBACK_AUTH_FILE",
				await authFile(),
			);
			vi.stubEnv(
				"AGENT_INFRA_CONNECTION_EXCEPTION_APPROVAL",
				JSON.stringify(exceptionApproval),
			);
			const entry = await load();
			const input = entry.createPlatformApiAssemblyInput();
			expect(input.connectionInstallation).toBeUndefined();
			expect(input.connectionInstallationCallback).toBeUndefined();
			expect(logs()).toEqual([
				{
					service: "platform-api",
					code: "CONNECTION_MANUAL_INSTALLATION_DORMANT",
					reason: "callback_delivery_unavailable",
				},
			]);
			expect(JSON.stringify([input, logs()])).not.toContain(callbackToken);
		},
	);

	it("keeps the manual route dormant if the projected Host CA cannot be read", async () => {
		vi.stubEnv(
			"PLATFORM_API_CONNECTION_CALLBACK_HOST_CA_FILE",
			join(directory, "missing-ca.crt"),
		);
		vi.stubEnv(
			"AGENT_INFRA_CONNECTION_EXCEPTION_APPROVAL",
			JSON.stringify(exceptionApproval),
		);
		const input = (await load()).createPlatformApiAssemblyInput();
		expect(input.connectionInstallation).toBeUndefined();
		expect(input.connectionInstallationCallback).toBeUndefined();
		expect(logs()).toContainEqual(
			expect.objectContaining({ reason: "callback_delivery_unavailable" }),
		);
	});

	it("opens the route with the deployment module's callback forwarder and no callback-auth file", async () => {
		vi.stubEnv("PLATFORM_API_CONNECTION_CALLBACK_AUTH_FILE", undefined);
		vi.stubEnv(
			"AGENT_INFRA_CONNECTION_EXCEPTION_APPROVAL",
			JSON.stringify(exceptionApproval),
		);
		const entry = await load(`
export const connectionInstallationCallback = {
  forward: async ({ target }) => { globalThis.__manualCallbackForwarded = target.authorizationId; },
};`);
		const input = entry.createPlatformApiAssemblyInput();
		expect(input.connectionInstallation?.manualInstallation).toBeDefined();
		await input.connectionInstallationCallback?.forward?.({
			target: { authorizationId: "authorization-a" },
		} as never);
		expect(
			(globalThis as { __manualCallbackForwarded?: string })
				.__manualCallbackForwarded,
		).toBe("authorization-a");
		expect(logs()).toEqual([
			expect.objectContaining({
				code: "CONNECTION_MANUAL_INSTALLATION_ENABLED",
			}),
		]);
	});

	// #4327 round 2 MUST 1: the configuration module is imported at runtime, so
	// its forwarder counts only with a callable `forward`. A malformed one is
	// never used: the protected callback-auth file is the fallback, and without
	// it the route and its callback stay dormant.
	const malformedForwarders = [
		["an object without forward", "{}"],
		["a non-function forward", `{ forward: "forward" }`],
		["a null forward", "{ forward: null }"],
		["a non-object forwarder", `"forwarder"`],
	] as const;
	it.each(malformedForwarders)(
		"keeps the route and its callback dormant for a module forwarder with %s and no callback-auth file",
		async (_name, forwarder) => {
			vi.stubEnv("PLATFORM_API_CONNECTION_CALLBACK_AUTH_FILE", undefined);
			vi.stubEnv(
				"AGENT_INFRA_CONNECTION_EXCEPTION_APPROVAL",
				JSON.stringify(exceptionApproval),
			);
			const entry = await load(
				`export const connectionInstallationCallback = ${forwarder};`,
			);
			const input = entry.createPlatformApiAssemblyInput();
			expect(input.connectionInstallation).toBeUndefined();
			expect(input.connectionInstallationCallback).toBeUndefined();
			expect(logs()).toEqual([
				{
					service: "platform-api",
					code: "CONNECTION_MANUAL_INSTALLATION_DORMANT",
					reason: "callback_delivery_unavailable",
				},
			]);
		},
	);

	it.each(malformedForwarders)(
		"uses the protected callback-auth file instead of a module forwarder with %s",
		async (_name, forwarder) => {
			vi.stubEnv(
				"AGENT_INFRA_CONNECTION_EXCEPTION_APPROVAL",
				JSON.stringify(exceptionApproval),
			);
			const entry = await load(
				`export const connectionInstallationCallback = ${forwarder};`,
			);
			const input = entry.createPlatformApiAssemblyInput();
			expect(input.connectionInstallation?.manualInstallation).toBeDefined();
			const selected = input.connectionInstallationCallback as unknown;
			expect(typeof (selected as { forward?: unknown })?.forward).toBe(
				"function",
			);
			expect(JSON.stringify([input, logs()])).not.toContain(callbackToken);
		},
	);
});
